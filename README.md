# Scorecut

Scorecut is a local editor for turning sheet music and a recording into an MP4. Import a PDF, split pages into systems, cue each system during playback, and add title cards or mix audio tracks on the same timeline.

## Run on Windows

Download or clone the repository, extract it if needed, and run **Install-Scorecut.cmd**. Setup installs Python 3.12 and the required packages if needed. Open Scorecut from the Start menu.

## Work on the app

With Python 3.12 installed, run:

```sh
python -m pip install -r requirements.txt
python app.py
```

Open the local address printed in the terminal. The interface is in `web/`. The Python entry point serves the editor, imports PDFs and media, and renders exports with FFmpeg.

## Contribute

Bug reports, suggestions, and pull requests are welcome. For a bug, include your Windows version, the steps to reproduce it, and what you expected to happen. Use sample media that you have permission to share.
