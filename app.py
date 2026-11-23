import argparse
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
from uuid import uuid4

import fitz
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("SCORECUT_DATA", Path.home() / "Scorecut Projects"))
JOBS = {}
FFMPEG = shutil.which("ffmpeg")
if not FFMPEG:
    import imageio_ffmpeg
    FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
CREATION = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def run(*args):
    result = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *map(str, args)],
                            capture_output=True, creationflags=CREATION)
    if result.returncode:
        raise ValueError(result.stderr.decode(errors="replace").strip()[-1400:])


def asset(project, name):
    if not re.fullmatch(r"[a-f0-9]{32}(?:-\d+)?\.[a-z0-9]{1,8}", name):
        raise ValueError("Invalid media reference")
    return project / "media" / name


def font(size):
    for path in (Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/georgia.ttf",
                 Path("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf")):
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default(size=size)


def still(project, clip, size, path):
    width, height = size
    image = Image.new("RGB", size, clip.get("background", "#151822"))
    if clip["kind"] == "image":
        with Image.open(asset(project, clip["file"])) as source:
            source = ImageOps.exif_transpose(source).convert("RGBA")
            crop = clip.get("crop", [0, 0, 100, 100])
            x, y, w, h = crop
            source = source.crop((round(x * source.width / 100), round(y * source.height / 100),
                                  round((x+w) * source.width / 100), round((y+h) * source.height / 100)))
            source = ImageOps.contain(source, size, Image.Resampling.LANCZOS)
            image.paste(source, ((width-source.width)//2, (height-source.height)//2), source)
    if clip["kind"] == "title":
        draw = ImageDraw.Draw(image)
        lines = []
        typeface = font(round(width * clip.get("fontSize", 5)/100))
        for paragraph in clip.get("text", "").split("\n"):
            line = ""
            for word in paragraph.split():
                candidate = (line + " " + word).strip()
                if line and draw.textlength(candidate, font=typeface) > width * .85:
                    lines.append(line)
                    line = word
                else:
                    line = candidate
            lines.append(line)
        draw.multiline_text((width//2, height//2), "\n".join(lines), anchor="mm",
                            align="center", font=typeface, fill=clip.get("color", "#f7e8cd"),
                            spacing=height//60)
    image.save(path)


def export(project, state, job_id):
    job = JOBS[job_id]
    work = project / job_id
    try:
        work.mkdir()
        size = (int(state["resolution"])*16//9, int(state["resolution"]))
        if size[1] not in (720, 1080, 1440, 2160):
            raise ValueError("Unsupported resolution")
        clips = state["clips"]
        length = max((round((c["start"]+c["duration"])*30) for c in clips), default=0)
        if length < 1:
            raise ValueError("Add a clip before exporting.")
        visuals = [c for c in clips if c["kind"] != "audio"]
        boundaries = sorted({0, length, *(round(t*30) for c in visuals
                             for t in (c["start"], c["start"]+c["duration"]))})
        segments = []
        for index, (start, end) in enumerate(zip(boundaries, boundaries[1:])):
            job["message"] = f"Rendering segment {index+1} of {len(boundaries)-1}"
            clip = next((c for c in reversed(visuals)
                         if round(c["start"]*30) <= start < round((c["start"]+c["duration"])*30)),
                        {"kind": "blank"})
            segment = work / f"{index}.mp4"
            if clip["kind"] == "video":
                src = ["-ss", clip.get("offset", 0)+(start/30-clip["start"]),
                       "-i", asset(project, clip["file"])]
                filters = (f"scale={size[0]}:{size[1]}:force_original_aspect_ratio=decrease,"
                           f"pad={size[0]}:{size[1]}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,"
                           "tpad=stop_mode=clone:stop_duration=1")
            else:
                picture = work / "still.png"
                still(project, clip, size, picture)
                src = ["-loop", "1", "-framerate", 30, "-i", picture]
                filters = "setsar=1"
            if clip["kind"] == "video":
                src[1] = max(0, src[1])
            run(*src, "-vf", filters, "-frames:v", end-start, "-an", "-c:v", "libx264",
                "-threads", 4, "-preset", "veryfast", "-crf", 18, "-pix_fmt", "yuv420p", segment)
            segments.append(f"file '{segment.name}'")
        listing = work / "segments.txt"
        listing.write_text("\n".join(segments), encoding="utf-8")
        job["message"] = "Mixing audio and writing MP4"
        audio = [c for c in clips if c["kind"] == "audio" and not c.get("mute")]
        inputs = []
        filters = []
        for index, clip in enumerate(audio, 1):
            inputs.extend(["-ss", clip.get("offset", 0), "-i", asset(project, clip["file"])])
            duration = clip["duration"]
            fade_in = min(duration, clip.get("fadeIn", 0))
            fade_out = min(duration, clip.get("fadeOut", 0))
            chain = f"[{index}:a]atrim=duration={duration},asetpts=PTS-STARTPTS,volume={clip.get('volume',1)}"
            if fade_in:
                chain += f",afade=t=in:d={fade_in}"
            if fade_out:
                chain += f",afade=t=out:st={duration-fade_out}:d={fade_out}"
            chain += f",adelay={round(clip['start']*1000)}:all=1[a{index}]"
            filters.append(chain)
        mix = []
        if audio:
            filters.append("".join(f"[a{i}]" for i in range(1, len(audio)+1)) +
                           f"amix=inputs={len(audio)}:normalize=0,alimiter=limit=0.98,apad[aout]")
            mix = ["-filter_complex", ";".join(filters), "-map", "[aout]", "-c:a", "aac", "-b:a", "256k"]
        output = work / "Scorecut.mp4"
        run("-f", "concat", "-safe", 0, "-i", listing, *inputs, "-map", "0:v", *mix,
            "-t", length/30, "-c:v", "copy", "-movflags", "+faststart", output)
        for path in work.iterdir():
            if path != output:
                path.unlink()
        job.update(status="done", message="MP4 ready", url=f"/output/{project.name}/{job_id}")
    except Exception as error:
        shutil.rmtree(work, ignore_errors=True)
        job.update(status="error", message=str(error))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, message, *args):
        if sys.stderr is not None:
            super().log_message(message, *args)

    def send_bytes(self, content, content_type, code=200):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, data, code=200):
        self.send_bytes(json.dumps(data).encode(), "application/json", code)

    def stream(self, path, download=False):
        if not path.is_file():
            self.send_error(404)
            return
        size = path.stat().st_size
        match = re.fullmatch(r"bytes=(\d+)-(\d*)", self.headers.get("Range", ""))
        start = int(match[1]) if match else 0
        end = min(int(match[2]), size-1) if match and match[2] else size-1
        if start > end:
            self.send_error(416)
            return
        self.send_response(206 if match else 200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end-start+1))
        if match:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download:
            self.send_header("Content-Disposition", 'attachment; filename="Scorecut.mp4"')
        self.end_headers()
        with path.open("rb") as file:
            file.seek(start)
            remaining = end-start+1
            while remaining:
                block = file.read(min(1024*1024, remaining))
                if not block:
                    break
                self.wfile.write(block)
                remaining -= len(block)

    def parts(self):
        return unquote(urlsplit(self.path).path).strip("/").split("/")

    def project(self, key):
        if not re.fullmatch(r"[a-f0-9]{32}", key):
            raise ValueError("Invalid project reference")
        return DATA / key

    def do_GET(self):
        try:
            self.get_route()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except ValueError as error:
            self.send_json({"error": str(error)}, 400)

    def get_route(self):
        parts = self.parts()
        route = parts[0]
        if route in ("", "app.js", "style.css", "scorecut.png", "scorecut.ico"):
            self.stream(ROOT / "web" / (route or "index.html"))
        elif route == "health":
            self.send_json({"app":"Scorecut"})
        elif route == "projects":
            projects = []
            for path in DATA.glob("*/project.json"):
                try:
                    state = json.loads(path.read_text(encoding="utf-8"))
                    projects.append({"id": path.parent.name, "name": state["name"],
                                     "updated": path.stat().st_mtime})
                except (OSError, ValueError, KeyError):
                    continue
            self.send_json(sorted(projects, key=lambda item: item["updated"], reverse=True))
        elif route == "project" and len(parts) == 2:
            self.stream(self.project(parts[1]) / "project.json")
        elif route == "media" and len(parts) == 3:
            self.stream(asset(self.project(parts[1]), parts[2]))
        elif route == "job" and len(parts) == 2:
            self.send_json(JOBS.get(parts[1], {"status":"error", "message":"Export session expired."}))
        elif route == "output" and len(parts) == 3 and re.fullmatch(r"[a-f0-9]{32}", parts[2]):
            self.stream(self.project(parts[1]) / parts[2] / "Scorecut.mp4", download=True)
        else:
            self.send_error(404)

    def read_json(self):
        return json.loads(self.rfile.read(int(self.headers["Content-Length"])))

    def do_POST(self):
        try:
            host = self.headers.get("Host")
            if host != f"127.0.0.1:{self.server.server_port}" or self.headers.get("Origin") not in (None, f"http://{host}"):
                self.send_error(403)
                return
            self.post_route()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            self.send_json({"error": str(error)}, 400)

    def post_route(self):
        route, key = self.parts()
        project = self.project(key)
        if route == "project":
            state = self.read_json()
            project.mkdir(parents=True, exist_ok=True)
            temp = project / f"{uuid4().hex}.tmp"
            temp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
            temp.replace(project / "project.json")
            self.send_json({"saved": True})
        elif route == "upload":
            name = unquote(self.headers["X-Filename"])
            suffix = Path(name).suffix.lower()
            kinds = {".pdf":"pdf", ".png":"image", ".jpg":"image", ".jpeg":"image", ".webp":"image",
                     ".wav":"audio", ".mp3":"audio", ".m4a":"audio", ".ogg":"audio", ".flac":"audio",
                     ".mp4":"video", ".mov":"video", ".webm":"video"}
            kind = kinds.get(suffix)
            if not kind:
                raise ValueError(f"Unsupported file type {suffix}")
            (project / "media").mkdir(parents=True, exist_ok=True)
            token = uuid4().hex
            path = asset(project, token + suffix)
            created = [path]
            try:
                with path.open("wb") as output:
                    remaining = int(self.headers["Content-Length"])
                    while remaining:
                        block = self.rfile.read(min(remaining, 1024*1024))
                        if not block:
                            raise ValueError("Import was interrupted.")
                        output.write(block)
                        remaining -= len(block)
                if kind == "pdf":
                    items = []
                    with fitz.open(path) as document:
                        for index, page in enumerate(document, 1):
                            image_path = asset(project, f"{token}-{index}.png")
                            created.append(image_path)
                            scale = 3200 / max(page.rect.width, page.rect.height)
                            page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).save(image_path)
                            items.append({"kind":"image", "score":True, "file":image_path.name,
                                          "name":f"{Path(name).stem} · Page {index}"})
                    self.send_json(items)
                else:
                    items = [{"kind":kind, "file":path.name, "name":name}]
                    if kind == "video":
                        soundtrack = asset(project, f"{token}-1.m4a")
                        probe = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)],
                                               capture_output=True, creationflags=CREATION)
                        if b"Audio:" in probe.stderr:
                            created.append(soundtrack)
                            run("-i", path, "-map", "0:a:0", "-vn", "-c:a", "aac",
                                "-b:a", "256k", soundtrack)
                            items.append({"kind":"audio", "file":soundtrack.name,
                                          "name":f"{Path(name).stem} · Soundtrack", "soundtrack":True})
                    self.send_json(items)
            except Exception:
                for item in created:
                    item.unlink(missing_ok=True)
                raise
        elif route == "export":
            state = self.read_json()
            job_id = uuid4().hex
            JOBS[job_id] = {"status":"running", "message":"Preparing export"}
            threading.Thread(target=export, args=(project, state, job_id), daemon=True).start()
            self.send_json({"job":job_id})
        else:
            self.send_error(404)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--desktop", action="store_true")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)
    if args.desktop and not args.port:
        args.port = 47631
    address = f"http://127.0.0.1:{args.port}"
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError:
        if not args.desktop:
            raise
        from urllib.request import urlopen
        with urlopen(address + "/health", timeout=2) as response:
            if json.load(response).get("app") != "Scorecut":
                raise RuntimeError("Scorecut's local port is already in use.")
        server = None
    if server:
        address = f"http://127.0.0.1:{server.server_port}"
        print(address, flush=True)
    if args.desktop:
        candidates = [Path(os.environ.get(key, "C:/")) / "Microsoft/Edge/Application/msedge.exe"
                      for key in ("ProgramFiles(x86)", "ProgramFiles", "LocalAppData")]
        edge = next((str(path) for path in candidates if path.is_file()), None)
        if edge:
            subprocess.Popen([edge, f"--app={address}"], creationflags=CREATION)
        else:
            import webbrowser
            webbrowser.open(address)
    if server:
        server.serve_forever()
