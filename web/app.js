"use strict";
const $ = id => document.getElementById(id);
const uid = () => crypto.randomUUID().replaceAll("-", "");
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const rounded = value => Math.round(value * 1000) / 1000;
const empty = () => ({id: uid(), name: "Untitled score video", media: [], clips: [], resolution: "1080", verseNames: {"1":"Verse 1"}});
let project = empty();
const historyLimit = 75;
const undoStack = [];
const redoStack = [];
let lastEdit = JSON.stringify(project);
let draggingClip = false;
let timingSystem = null;
let cueMode = false;
let selected = null;
let cursor = 0;
let playing = false;
let playbackStart = 0;
let activeVisual = null;
let activeVideo = null;
let startedAt = 0;
let scale = 28;
let saveTimer;
let pendingSave = Promise.resolve();
let dirty = false;
const audio = new Map();
const left = 80;
const end = () => Math.max(0, ...project.clips.map(clip => clip.start + clip.duration));
const mediaUrl = file => `/media/${project.id}/${file}`;
const verseOf = clip => clip.verse || 1;
const verseName = number => project.verseNames?.[number] || `Verse ${number}`;
const scoreClips = () => project.clips.filter(clip => clip.kind === "image" && clip.score);
const verseNumbers = () => [...new Set(scoreClips().map(verseOf))].sort((a,b) => a-b);
const queuedSystems = () => project.systemQueue ?? [];
const clipEnd = clip => rounded(clip.start+clip.duration);
const selectedClip = () => project.clips.find(clip => clip.id === selected);
const timeText = time => `${String(Math.floor(time / 60)).padStart(2, "0")}:${(time % 60).toFixed(2).padStart(5, "0")}`;

function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
}

async function request(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `Request failed (${response.status}).`);
    }
    return response.json();
}
function post(url, data) {
    return request(url, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(data)});
}
function status(text) { $("status").textContent = text; }
function updateHistoryButtons() {
    $("undo").disabled = draggingClip || !undoStack.length;
    $("redo").disabled = draggingClip || !redoStack.length;
}
function changed() {
    const next = JSON.stringify(project);
    if (next === lastEdit) return;
    undoStack.push(lastEdit);
    if (undoStack.length > historyLimit) undoStack.shift();
    redoStack.length = 0;
    lastEdit = next;
    updateHistoryButtons();
    queueSave();
}
function stepHistory(from, to) {
    if (draggingClip || !from.length) return;
    timingSystem = null;
    cueMode = false;
    pause();
    audio.clear();
    activeVideo = null;
    activeVisual = null;
    to.push(lastEdit);
    lastEdit = from.pop();
    project = JSON.parse(lastEdit);
    if (!selectedClip()) selected = null;
    $("name").value = project.name;
    $("resolution").value = project.resolution;
    updateHistoryButtons();
    seek(cursor);
    render();
    queueSave();
}
function queueSave() {
    dirty = true;
    status("Unsaved changes");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save().catch(error => status(error.message)), 450);
}
function save() {
    clearTimeout(saveTimer);
    const snapshot = structuredClone(project);
    dirty = false;
    pendingSave = pendingSave.catch(() => {}).then(async () => {
        try {
            await post(`/project/${snapshot.id}`, snapshot);
            if (!dirty && project.id === snapshot.id) status("Saved");
        } catch (error) {
            if (project.id === snapshot.id) dirty = true;
            throw error;
        }
    });
    return pendingSave;
}
async function listProjects() {
    const list = await request("/projects");
    $("projects").replaceChildren(new Option("Open project", ""));
    for (const item of list) $("projects").append(new Option(item.name, item.id));
}
function reset(state) {
    timingSystem = null;
    cueMode = false;
    pause();
    audio.clear();
    project = state;
    undoStack.length = 0;
    redoStack.length = 0;
    lastEdit = JSON.stringify(project);
    updateHistoryButtons();
    $("download").hidden = true;
    $("progress").textContent = "";
    selected = null;
    cursor = 0;
    dirty = false;
    $("name").value = state.name;
    $("resolution").value = state.resolution;
    activeVisual = null;
    render();
}
window.addEventListener("beforeunload", event => {
    if (dirty) event.preventDefault();
});

function addClip(item, start, commit = true) {
    const lane = item.kind === "audio" ? nextAudioLane() : 0;
    const clip = {...item, id:uid(), lane, start:rounded(start), duration:item.duration || 5,
                  offset:0, volume:1, fadeIn:0, fadeOut:0, crop:[0,0,100,100]};
    project.clips.push(clip);
    selected = clip.id;
    if (commit) {
        changed();
        render();
    }
    return clip;
}
function nextAudioLane() {
    const lanes = project.clips.filter(clip => clip.kind === "audio").map(clip => clip.lane);
    return lanes.length ? Math.max(...lanes) + 1 : 1;
}
function visualEnd() {
    return Math.max(0, ...project.clips.filter(clip => clip.kind !== "audio").map(clip => clip.start + clip.duration));
}
function durationOf(item) {
    return new Promise((resolve, reject) => {
        const tag = element(item.kind);
        tag.preload = "metadata";
        tag.onloadedmetadata = () => {
            const duration = tag.duration;
            tag.removeAttribute("src");
            tag.load();
            if (Number.isFinite(duration) && duration > 0) resolve(duration);
            else reject(new Error(`Could not read duration for ${item.name}.`));
        };
        tag.onerror = () => reject(new Error(`Could not play ${item.name}. Try WAV, MP3, or H.264 MP4.`));
        tag.src = mediaUrl(item.file);
    });
}
async function importFiles(files) {
    $("import").disabled = true;
    $("new").disabled = true;
    $("projects").disabled = true;
    const failures = [];
    try {
        for (const file of files) {
            status(`Importing ${file.name}`);
            try {
                const items = await request(`/upload/${project.id}`, {
                    method:"POST", headers:{"X-Filename":encodeURIComponent(file.name)}, body:file
                });
                for (const item of items) {
                    if (item.kind === "audio" || item.kind === "video") {
                        item.sourceDuration = await durationOf(item);
                        item.duration = item.sourceDuration;
                    }
                }
                const pictureStart = visualEnd();
                for (const item of items) {
                    project.media.push(item);
                    const start = item.soundtrack ? pictureStart : item.kind === "audio" ? 0 : visualEnd();
                    addClip(item, start, false);
                }
                changed();
                render();
            } catch (error) { failures.push(error.message); }
        }
        if (dirty) await save();
    } finally {
        $("import").disabled = false;
        $("new").disabled = false;
        $("projects").disabled = false;
    }
    if (failures.length) alert(failures.join("\n"));
}
function renderMedia() {
    const list = $("media");
    list.replaceChildren();
    if (!project.media.length) list.append(element("p", "hint", "PDF, images, recordings, and video"));
    if (queuedSystems().length) {
        list.append(element("h3","queue-heading",`Unplaced systems (${queuedSystems().length})`));
        for (const item of queuedSystems()) {
            list.append(element("div","queued-system",item.name));
        }
    }
    for (const item of project.media) {
        const button = element("button", "asset");
        button.title = "Add another instance at the playhead";
        if (item.kind === "image") {
            const image = element("img");
            image.src = mediaUrl(item.file);
            image.alt = "";
            image.loading = "lazy";
            button.append(image);
        } else button.append(element("span", "", item.kind === "audio" ? "♫" : "▶"));
        button.append(element("span", "", item.name));
        button.onclick = () => addClip(item, cursor);
        list.append(button);
    }
}
function renderTimeline() {
    const lanes = $("lanes");
    lanes.replaceChildren();
    const total = Math.max(12, end()+3, ($("scroller").clientWidth-left)/scale);
    lanes.style.width = `${left+total*scale}px`;
    const ruler = element("div", "ruler");
    ruler.onpointerdown = event => {
        const rect = ruler.getBoundingClientRect();
        seek((event.clientX-rect.left-left)/scale);
    };
    ruler.append(element("span", "lane-label", "Time"));
    const interval = Math.ceil(56/scale);
    for (let tick = 0; tick <= total; tick += interval) {
        const marker = element("span", "tick", timeText(tick).slice(0,5));
        marker.style.left = `${left+tick*scale}px`;
        ruler.append(marker);
    }
    lanes.append(ruler);
    if (verseNumbers().length) {
        const verseRow = element("div", "lane verses");
        verseRow.append(element("span", "lane-label", "Verses"));
        for (const number of verseNumbers()) {
            const clips = scoreClips().filter(clip => verseOf(clip) === number).sort((a,b) => a.start-b.start);
            const first = clips[0];
            const finish = Math.max(...clips.map(clipEnd));
            const marker = element("button", `verse-marker${selectedClip()?.score && verseOf(selectedClip()) === number ? " current" : ""}`, verseName(number));
            marker.style.left = `${left+first.start*scale}px`;
            marker.style.width = `${Math.max(36,(finish-first.start)*scale)}px`;
            marker.title = `${verseName(number)} · ${timeText(first.start)}–${timeText(finish)}`;
            marker.onclick = () => selectAt(first);
            verseRow.append(marker);
        }
        lanes.append(verseRow);
    }
    const tracks = [...new Set([0, 1, ...project.clips.map(clip => clip.lane)])].sort((a,b) => a-b);
    for (const lane of tracks) {
        const row = element("div", "lane");
        row.append(element("span", "lane-label", lane ? `Audio ${lane}` : "Picture"));
        for (const clip of project.clips.filter(item => item.lane === lane)) {
            const node = element("button", `clip ${clip.kind}${clip.id === selected ? " selected" : ""}`, clip.name);
            node.style.left = `${left+clip.start*scale}px`;
            node.style.width = `${Math.max(6, clip.duration*scale)}px`;
            node.title = `${clip.name} · ${timeText(clip.start)}`;
            node.onpointerdown = event => dragClip(event, clip, node);
            node.onclick = event => {
                if (event.detail === 0) selectAt(clip);
            };
            row.append(node);
        }
        lanes.append(row);
    }
    const head = element("div", "head");
    head.id = "head";
    lanes.append(head);
    updateClock();
}
function selectAt(clip) {
    selected = clip.id;
    seek(clip.start);
    renderTimeline();
    renderInspector();
}
function dragClip(event, clip, node) {
    if (event.button !== 0) return;
    event.preventDefault();
    pause();
    selected = clip.id;
    node.parentElement.parentElement.querySelector(".selected")?.classList.remove("selected");
    node.classList.add("selected");
    const startX = event.clientX;
    const oldStart = clip.start;
    node.setPointerCapture(event.pointerId);
    draggingClip = true;
    updateHistoryButtons();
    node.onpointermove = move => {
        if (Math.abs(move.clientX-startX) < 3 && clip.start === oldStart) return;
        clip.start = rounded(Math.max(0, oldStart+(move.clientX-startX)/scale));
        node.style.left = `${left+clip.start*scale}px`;
        seek(clip.start);
    };
    node.onlostpointercapture = () => {
        draggingClip = false;
        if (clip.start !== oldStart) changed();
        updateHistoryButtons();
        selectAt(clip);
    };
}
function field(label, value, commit, attributes = {}) {
    const group = element("label", "", label);
    const input = element(attributes.multiline ? "textarea" : "input");
    if (!attributes.multiline) input.type = attributes.type || "number";
    if (input.type === "number") input.step = attributes.step || ".01";
    if (attributes.min !== undefined) input.min = attributes.min;
    if (attributes.max !== undefined) input.max = attributes.max;
    if (input.type === "checkbox") {
        input.checked = value;
        group.classList.add("check");
    } else input.value = value;
    input.onchange = () => {
        const next = input.type === "number" ? input.valueAsNumber :
                     input.type === "checkbox" ? input.checked : input.value;
        if (typeof next !== "number" || Number.isFinite(next)) commit(next);
        changed();
        activeVisual = null;
        renderTimeline();
        renderInspector();
        preview();
    };
    group.append(input);
    return group;
}
function pair(...fields) {
    const group = element("div","pair");
    group.append(...fields);
    return group;
}
function renderInspector() {
    const root = $("inspector");
    const clip = selectedClip();
    $("split").disabled = !clip;
    const hasQueue = queuedSystems().length > 0;
    $("cut").disabled = !hasQueue && !timingSystem && !clip?.score && clip?.kind !== "title";
    $("cutLabel").textContent = hasQueue ? "Place next system " : cueMode ? "End last system " : "Next system ";
    $("timing").disabled = !cueMode && !hasQueue && !timingSystem && !clip?.score;
    $("timing").textContent = cueMode || timingSystem ? "Stop timing" : "Time systems";
    $("timing").setAttribute("aria-pressed", Boolean(cueMode || timingSystem));
    $("queueExisting").disabled = !project.clips.some(isSystemClip);
    $("remove").disabled = !clip;
    $("repeat").disabled = !scoreClips().length;
    if (!clip) {
        root.textContent = "Select a clip on the timeline.";
        return;
    }
    const props = element("div", "props");
    root.replaceChildren(props);
    const maxDuration = () => clip.sourceDuration ? clip.sourceDuration-clip.offset : Infinity;
    props.append(element("strong", "", clip.name),pair(
        field("Start (s)", clip.start, value => clip.start = rounded(Math.max(0,value)), {min:0}),
        field("Length (s)", rounded(clip.duration), value => clip.duration = rounded(clamp(value,.04,maxDuration())), {min:.04})
    ));
    if (clip.sourceDuration) {
        props.append(field("Trim from source (s)", rounded(clip.offset), value => {
            clip.offset = rounded(clamp(value, 0, Math.max(0, clip.sourceDuration-.04)));
            clip.duration = Math.min(clip.duration, maxDuration());
        }, {min:0}));
    }
    if (clip.kind === "audio") {
        props.append(pair(field("Volume (%)", Math.round(clip.volume*100), value => clip.volume = clamp(value,0,100)/100, {min:0,max:100}),
            field("Track", clip.lane, value => clip.lane = clamp(Math.round(value),1,99), {min:1,max:99,step:1})),
            pair(field("Fade in (s)", clip.fadeIn, value => clip.fadeIn = clamp(value,0,clip.duration), {min:0}),
                 field("Fade out (s)", clip.fadeOut, value => clip.fadeOut = clamp(value,0,clip.duration), {min:0})),
            field("Mute", Boolean(clip.mute), value => clip.mute = value, {type:"checkbox"}));
    }
    if (clip.kind === "title") {
        props.append(field("Card text",clip.text,value => clip.text = value,{multiline:true}),
            field("Text size (% of frame)",clip.fontSize,value => clip.fontSize = clamp(value,1,20),{min:1,max:20}),
            pair(field("Text",clip.color,value => clip.color = value,{type:"color"}),
                 field("Background",clip.background,value => clip.background = value,{type:"color"})));
    }
    if (clip.kind === "image") {
        const crop = element("button", "accent", "Crop image…");
        crop.onclick = () => openCrop(clip);
        const systems = element("button", "accent", "Split into systems…");
        systems.onclick = () => {
            openCrop(clip);
            findSystems();
        };
        const duplicate = element("button", "", "Duplicate as next clip");
        duplicate.onclick = () => {
            pause();
            for (const item of project.clips) {
                if (item.kind !== "audio" && item.start >= clipEnd(clip)) {
                    item.start = rounded(item.start+clip.duration);
                }
            }
            const copy = {...structuredClone(clip), id:uid(), start:clipEnd(clip)};
            project.clips.push(copy);
            changed();
            render();
            selectAt(copy);
        };
        props.append(systems, crop, duplicate, field("Include in verses", Boolean(clip.score),
            value => clip.score = value, {type:"checkbox"}));
        if (clip.score) {
            const number = verseOf(clip);
            props.append(field("Verse name", verseName(number), value => {
                project.verseNames ??= {};
                project.verseNames[number] = value.trim().slice(0,50) || `Verse ${number}`;
            }, {type:"text"}));
        }
    }
}
function updateClock() {
    $("clock").textContent = timeText(cursor);
    $("seek").max = Math.max(.01,end());
    $("seek").value = cursor;
    if ($("head")) $("head").style.left = `${left+cursor*scale}px`;
}
function fitFrame() {
    const stage = $("stage");
    const width = Math.min(stage.clientWidth,stage.clientHeight*16/9);
    $("frame").style.width = `${width}px`;
    if (activeVisual) {
        const clip = project.clips.find(item => item.id === activeVisual);
        const image = $("frame").querySelector("img");
        if (image?.naturalWidth && clip?.crop) fitImage(image,clip.crop);
    }
}
function fitImage(image, [x,y,w,h]) {
    const frame = $("frame");
    const factor = Math.min(frame.clientWidth/(image.naturalWidth*w/100),
                            frame.clientHeight/(image.naturalHeight*h/100));
    const width = image.naturalWidth*factor;
    const height = image.naturalHeight*factor;
    Object.assign(image.style,{width:`${width}px`,height:`${height}px`,
        left:`${(frame.clientWidth-width*w/100)/2-width*x/100}px`,
        top:`${(frame.clientHeight-height*h/100)/2-height*y/100}px`,
        clipPath:`inset(${y}% ${100-x-w}% ${100-y-h}% ${x}%)`});
}
new ResizeObserver(fitFrame).observe($("stage"));

function align(media, time, tolerance = .22) {
    if (media.readyState && Math.abs(media.currentTime-time) > tolerance) media.currentTime = time;
    if (playing && media.paused) media.play().catch(() => {});
    if (!playing && !media.paused) media.pause();
}
function preview() {
    const held = project.clips.find(clip => clip.id === timingSystem);
    const visual = held ?? project.clips.findLast(clip => clip.kind !== "audio" &&
        cursor >= clip.start && cursor < clip.start + clip.duration);
    if ((visual?.id ?? null) !== activeVisual || (!visual && $("frame").firstChild)) {
        activeVisual = visual?.id ?? null;
        activeVideo?.pause();
        activeVideo = null;
        $("frame").replaceChildren();
        $("frame").style.background = visual ? "#151822" : "#0d0f15";
        if (visual?.kind === "image") {
            const image = element("img");
            image.onload = () => fitImage(image,visual.crop);
            image.alt = visual.name;
            image.src = mediaUrl(visual.file);
            $("frame").append(image);
        }
        if (visual?.kind === "title") {
            const card = element("div", "card", visual.text);
            Object.assign(card.style,{color:visual.color,background:visual.background,
                fontSize:`${visual.fontSize}cqw`});
            $("frame").append(card);
        }
        if (visual?.kind === "video") {
            activeVideo = element("video");
            activeVideo.muted = true;
            activeVideo.src = mediaUrl(visual.file);
            activeVideo.onloadedmetadata = () => preview();
            $("frame").append(activeVideo);
        }
    }
    $("placeholder").hidden = Boolean(project.clips.length);
    $("previewLabel").textContent = cueMode ? (queuedSystems().length ? "Press C to place next system" : "Press C to end last system") :
        held ? "Timing · Press C for next system" :
        visual?.score ? verseName(verseOf(visual)) + " · 16:9" : "16:9";
    if (activeVideo) align(activeVideo, Math.max(0, cursor-visual.start+visual.offset), playing ? .22 : .015);
    for (const [id,tag] of audio) {
        if (!project.clips.some(clip => clip.id === id)) {
            tag.pause();
            audio.delete(id);
        }
    }
    for (const clip of project.clips.filter(item => item.kind === "audio")) {
        const elapsed = cursor-clip.start;
        let tag = audio.get(clip.id);
        if (elapsed < 0 || elapsed >= clip.duration || clip.mute) {
            tag?.pause();
            continue;
        }
        if (!tag && playing) {
            tag = new Audio(mediaUrl(clip.file));
            tag.onloadedmetadata = () => preview();
            audio.set(clip.id,tag);
        }
        if (tag) {
            tag.volume = clamp(clip.volume*Math.min(1,clip.fadeIn ? elapsed/clip.fadeIn : 1,
                clip.fadeOut ? (clip.duration-elapsed)/clip.fadeOut : 1),0,1);
            align(tag, elapsed+clip.offset);
        }
    }
}
function seek(position) {
    if (timingSystem || cueMode) {
        timingSystem = null;
        cueMode = false;
        renderInspector();
    }
    cursor = clamp(position,0,end());
    if (playing) {
        playbackStart = cursor;
        startedAt = performance.now();
    }
    updateClock();
    preview();
}
function tick() {
    if (!playing) return;
    cursor = Math.min(end(), playbackStart+(performance.now()-startedAt)/1000);
    if (cursor >= end()) pause();
    updateClock();
    preview();
    if (playing) requestAnimationFrame(tick);
}
function pause() {
    playing = false;
    for (const tag of audio.values()) tag.pause();
    activeVideo?.pause();
    $("play").textContent = "▶";
    $("play").ariaLabel = "Play";
}
function togglePlayback() {
    if (playing) { pause(); return; }
    if (!end()) return;
    if (cursor >= end()) seek(0);
    playing = true;
    playbackStart = cursor;
    startedAt = performance.now();
    $("play").textContent = "Ⅱ";
    $("play").ariaLabel = "Pause";
    $("play").blur();
    tick();
}
function render() {
    renderMedia();
    renderTimeline();
    renderInspector();
    preview();
}
function split() {
    const clip = selectedClip();
    if (!clip) return;
    const delta = rounded(cursor-clip.start);
    if (delta < .04 || clip.duration-delta < .04) {
        status("Place the playhead inside the selected clip.");
        return;
    }
    const tail = {...structuredClone(clip),id:uid(),start:rounded(clip.start+delta),
        duration:rounded(clip.duration-delta)};
    if (clip.sourceDuration) tail.offset = rounded(clip.offset+delta);
    if (clip.kind === "audio") { tail.fadeIn = 0; clip.fadeOut = 0; }
    clip.duration = delta;
    project.clips.splice(project.clips.indexOf(clip)+1,0,tail);
    selected = tail.id;
    changed();
    render();
}
function toggleSystemTiming() {
    if (timingSystem || cueMode) {
        timingSystem = null;
        cueMode = false;
        renderInspector();
        preview();
        return;
    }
    if (queuedSystems().length) {
        if (!playing && cursor >= end()) seek(0);
        cueMode = true;
        renderInspector();
        if (!playing) togglePlayback();
        preview();
        return;
    }
    const clip = selectedClip();
    if (!clip?.score) return;
    if (!playing) seek(clip.start);
    timingSystem = clip.id;
    renderInspector();
    preview();
    if (!playing) togglePlayback();
}
function playbackPosition() {
    return playing ? Math.min(end(),playbackStart+(performance.now()-startedAt)/1000) : cursor;
}
function placeNextSystem() {
    const livePosition = playbackPosition();
    const cut = Math.floor(livePosition*1000)/1000;
    const previous = project.clips.find(clip => clip.id === timingSystem);
    const next = queuedSystems()[0];
    if (previous && cut-previous.start < .04) return;
    if (previous) previous.duration = rounded(cut-previous.start);
    if (next) {
        const {queueOrder, ...system} = project.systemQueue.shift();
        const clip = {...system,id:uid(),lane:0,start:cut,duration:Math.max(.04,rounded(end()-cut))};
        project.clips.push(clip);
        selected = clip.id;
        timingSystem = clip.id;
        cueMode = true;
    } else {
        timingSystem = null;
        cueMode = false;
    }
    cursor = livePosition;
    changed();
    render();
}
function setNextCut() {
    if (cueMode || queuedSystems().length) {
        placeNextSystem();
        return;
    }
    const clip = timingSystem
        ? project.clips.find(item => item.id === timingSystem)
        : selectedClip();
    if (!clip || !["image","title"].includes(clip.kind)) return;
    const livePosition = playbackPosition();
    const cut = Math.floor(livePosition*1000)/1000;
    const length = rounded(cut-clip.start);
    if (length < .04) {
        status("Move the playhead after the start of the selected clip.");
        return;
    }
    const following = project.clips.filter(item => item !== clip && item.kind !== "audio" &&
        item.start >= clipEnd(clip)).sort((a,b) => a.start-b.start);
    const next = following[0];
    clip.duration = length;
    if (next) {
        const shift = rounded(cut-next.start);
        for (const item of following) item.start = rounded(item.start+shift);
    }
    selected = next?.id ?? clip.id;
    if (timingSystem) timingSystem = next?.score ? next.id : null;
    cursor = livePosition;
    changed();
    render();
}
function openVerse() {
    pause();
    const numbers = verseNumbers();
    if (!numbers.length) return;
    $("verseSource").replaceChildren(...numbers.map(number => new Option(verseName(number),number)));
    if (selectedClip()?.score) $("verseSource").value = verseOf(selectedClip());
    $("verseName").value = `Verse ${Math.max(...numbers)+1}`;
    $("verseUseEnd").click();
    $("verseError").textContent = "";
    $("verseDialog").showModal();
}
$("verseUseEnd").onclick = () => {
    $("verseStart").value = Math.max(0,...scoreClips().map(clipEnd));
};
$("verseUsePlayhead").onclick = () => { $("verseStart").value = rounded(cursor); };
$("verseForm").onsubmit = event => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    const start = rounded($("verseStart").valueAsNumber);
    const number = Math.max(...verseNumbers())+1;
    const pages = scoreClips().filter(clip => verseOf(clip) === Number($("verseSource").value))
        .sort((a,b) => a.start-b.start);
    const base = pages[0].start;
    const span = rounded(Math.max(...pages.map(clipEnd))-base);
    const picture = project.clips.filter(clip => clip.kind !== "audio");
    const straddling = picture.find(clip => clip.start < start && clipEnd(clip) > start);
    if (straddling && !straddling.score) {
        $("verseError").textContent = "Choose a start outside the title or video clip at that point.";
        return;
    }
    if (straddling && start-straddling.start < .04) {
        $("verseError").textContent = "Choose a start at least 0.04 seconds into the current score clip.";
        return;
    }
    const copies = pages.map(clip => ({...structuredClone(clip), id:uid(), verse:number,
        start:rounded(start+clip.start-base)}));
    if (straddling) straddling.duration = rounded(start-straddling.start);
    for (const clip of picture) {
        if (clip.start >= start) clip.start = rounded(clip.start+span);
    }
    project.verseNames ??= {};
    project.verseNames[number] = $("verseName").value.trim() || `Verse ${number}`;
    project.clips.push(...copies);
    $("verseDialog").close();
    changed();
    selected = copies[0].id;
    seek(start);
    render();
};

let cropDraft;
let croppedClip;
const fullCrop = () => [0,0,100,100];
const cropLabels = ["Left","Top","Width","Height"];
const cropInputs = [];
function drawCrop() {
    const [x,y,w,h] = cropDraft;
    Object.assign($("cropBox").style, {left:x+"%", top:y+"%", width:w+"%", height:h+"%"});
    $("cropShade").style.clipPath = `polygon(evenodd, 0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%, ${x}% ${y}%, ${x+w}% ${y}%, ${x+w}% ${y+h}%, ${x}% ${y+h}%, ${x}% ${y}%)`;
    cropInputs.forEach((input,index) => { input.value = rounded(cropDraft[index]); });
}
function sizeCropImage() {
    const stage = $("cropStage");
    const image = $("cropImage");
    if (!image.naturalWidth || !stage.clientWidth) return;
    const widthScale = (stage.clientWidth-32)/image.naturalWidth;
    const fitScale = Math.min(widthScale,(stage.clientHeight-32)/image.naturalHeight);
    const zoom = $("cropZoom").value;
    const factor = zoom === "width" ? widthScale : fitScale*(Number(zoom) || 1);
    $("cropSurface").style.width = image.naturalWidth*factor+"px";
    $("cropSurface").style.height = image.naturalHeight*factor+"px";
}
$("cropImage").onload = () => {
    sizeCropImage();
    if (pendingSystems) findSystems();
};
new ResizeObserver(sizeCropImage).observe($("cropStage"));
function centerCrop() {
    const stage = $("cropStage");
    const surface = $("cropSurface");
    const [x,y,w,h] = cropDraft;
    stage.scrollLeft = surface.offsetLeft+surface.clientWidth*(x+w/2)/100-stage.clientWidth/2;
    stage.scrollTop = surface.offsetTop+surface.clientHeight*(y+h/2)/100-stage.clientHeight/2;
}
$("cropZoom").onchange = () => {
    sizeCropImage();
    centerCrop();
};
for (const [index,label] of cropLabels.entries()) {
    const wrapper = element("label","",label+" (%)");
    const input = element("input");
    input.type = "number";
    input.min = index < 2 ? "0" : "1";
    input.max = "100";
    input.step = ".1";
    input.onchange = () => {
        const value = input.valueAsNumber;
        if (Number.isFinite(value)) {
            if (index < 2) {
                cropDraft[index] = clamp(value,0,99);
                cropDraft[index+2] = Math.min(cropDraft[index+2],100-cropDraft[index]);
            } else cropDraft[index] = clamp(value,1,100-cropDraft[index-2]);
        }
        drawCrop();
    };
    cropInputs.push(input);
    wrapper.append(input);
    $("cropNumbers").append(wrapper);
}
function openCrop(clip) {
    pause();
    croppedClip = clip;
    cropDraft = [...(clip.crop || fullCrop())];
    $("cropName").textContent = clip.name;
    $("cropAll").checked = false;
    setSystemMode(false);
    $("cropApply").disabled = false;
    $("cropZoom").value = "fit";
    $("cropStatus").textContent = "";
    $("cropStage").scrollLeft = 0;
    $("cropStage").scrollTop = 0;
    $("cropImage").src = mediaUrl(clip.file);
    $("cropDialog").showModal();
    sizeCropImage();
    drawCrop();
}
const cropSurface = $("cropSurface");
cropSurface.onpointerdown = event => {
    if (event.button !== 0 || systemCuts !== null) return;
    event.preventDefault();
    const rect = cropSurface.getBoundingClientRect();
    const point = (pointer, axis) => axis === "x"
        ? clamp((pointer.clientX-rect.left)/rect.width*100,0,100)
        : clamp((pointer.clientY-rect.top)/rect.height*100,0,100);
    const startX = point(event,"x");
    const startY = point(event,"y");
    const [x,y,w,h] = cropDraft;
    const edge = event.shiftKey ? "" : event.target.dataset.edge;
    const moving = event.target === $("cropBox") && !event.shiftKey && (w < 100 || h < 100);
    cropSurface.setPointerCapture(event.pointerId);
    cropSurface.onpointermove = move => {
        const nx = point(move,"x");
        const ny = point(move,"y");
        if (edge) {
            const left = edge.includes("w") ? Math.min(nx,x+w-1) : x;
            const top = edge.includes("n") ? Math.min(ny,y+h-1) : y;
            const right = edge.includes("e") ? Math.max(nx,x+1) : x+w;
            const bottom = edge.includes("s") ? Math.max(ny,y+1) : y+h;
            cropDraft = [left,top,right-left,bottom-top];
        } else if (moving) {
            cropDraft = [clamp(x+nx-startX,0,100-w),clamp(y+ny-startY,0,100-h),w,h];
        } else {
            const left = Math.min(nx,startX,99);
            const top = Math.min(ny,startY,99);
            cropDraft = [left,top,Math.max(1,Math.abs(nx-startX)),Math.max(1,Math.abs(ny-startY))];
        }
        drawCrop();
    };
    cropSurface.onlostpointercapture = () => { cropSurface.onpointermove = null; };
};
function readCropPixels() {
    const source = $("cropImage");
    if (!source.naturalWidth) {
        $("cropStatus").textContent = "Waiting for page to load.";
        return;
    }
    const canvas = element("canvas");
    const factor = Math.min(1, 1000/Math.max(source.naturalWidth,source.naturalHeight));
    const width = canvas.width = Math.max(1,Math.round(source.naturalWidth*factor));
    const height = canvas.height = Math.max(1,Math.round(source.naturalHeight*factor));
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0,0,width,height);
    context.drawImage(source,0,0,width,height);
    const pixels = context.getImageData(0,0,width,height).data;
    return {width,height,pixels};
}
$("cropAuto").onclick = () => {
    const image = readCropPixels();
    if (!image) return;
    const {width,height,pixels} = image;
    const rows = new Uint16Array(height);
    const columns = new Uint16Array(width);
    for (let y = 0, index = 0; y < height; y++) {
        for (let x = 0; x < width; x++, index += 4) {
            if (Math.min(pixels[index],pixels[index+1],pixels[index+2]) < 205) {
                rows[y]++;
                columns[x]++;
            }
        }
    }
    const bound = (counts, threshold) => {
        const first = counts.findIndex(count => count >= threshold);
        const last = counts.findLastIndex(count => count >= threshold);
        const padding = Math.max(2,Math.round(counts.length*.02));
        return [first, Math.max(0,first-padding), Math.min(counts.length,last+1+padding)];
    };
    const [foundX,left,right] = bound(columns,Math.max(2,Math.round(height*.004)));
    const [foundY,top,bottom] = bound(rows,Math.max(2,Math.round(width*.004)));
    if (foundX < 0 || foundY < 0) {
        $("cropStatus").textContent = "No clear printed area found. Draw a crop by hand.";
        return;
    }
    cropDraft = [left/width*100,top/height*100,
        Math.min(100-left/width*100, Math.max(1,(right-left)/width*100)),
        Math.min(100-top/height*100, Math.max(1,(bottom-top)/height*100))];
    drawCrop();
    centerCrop();
    $("cropStatus").textContent = "Suggested crop ready to adjust.";
};
$("cropReset").onclick = () => {
    cropDraft = fullCrop();
    $("cropStatus").textContent = "";
    drawCrop();
};
let systemCuts = null;
let pendingSystems = false;

function setSystemMode(enabled) {
    pendingSystems = false;
    if (!enabled) systemCuts = null;
    for (const id of ["systemOptions","systemGuides"]) $(id).hidden = !enabled;
    for (const id of ["cropBox","cropShade","cropNumbers","cropAuto","cropReset"]) $(id).hidden = enabled;
    $("cropAll").closest("label").hidden = enabled;
    $("cropApply").textContent = enabled ? "Prepare systems" : "Apply crop";
    $("cropStatus").textContent = "";
}
function blankGaps(image, crop) {
    const {width,height,pixels} = image;
    const [x,y,w,h] = crop;
    const left = Math.floor(x*width/100);
    const right = Math.ceil((x+w)*width/100);
    const top = Math.floor(y*height/100);
    const bottom = Math.ceil((y+h)*height/100);
    const quiet = [];
    for (let row = top; row < bottom; row++) {
        let ink = 0;
        for (let column = left; column < right; column++) {
            const index = (row*width+column)*4;
            if (Math.min(pixels[index],pixels[index+1],pixels[index+2]) < 185) ink++;
        }
        quiet.push(ink < Math.max(2,(right-left)*.004));
    }
    const first = quiet.indexOf(false);
    const last = quiet.lastIndexOf(false);
    const gaps = [];
    for (let row = first+1; row < last; row++) {
        if (!quiet[row]) continue;
        const start = row;
        while (row+1 < last && quiet[row+1]) row++;
        const length = row-start+1;
        if (length >= Math.max(8,height*.018)) {
            gaps.push(rounded((top+(start+row+1)/2)*100/height));
        }
    }
    return gaps;
}
function findSystems() {
    const image = readCropPixels();
    pendingSystems = !image;
    if (!image) return;
    systemCuts = blankGaps(image,cropDraft);
    setSystemMode(true);
    renderSystemGuides();
}
function renderSystemGuides() {
    const canvas = $("systemGuides");
    const controls = $("systemCuts");
    canvas.replaceChildren();
    controls.replaceChildren();
    for (const [index,cut] of systemCuts.entries()) {
        const guide = element("div","system-guide",`System ${index+2} ↓`);
        guide.style.top = cut+"%";
        guide.onclick = event => event.stopPropagation();
        guide.onpointerdown = event => {
            if (event.button !== 0) return;
            event.preventDefault();
            const rect = cropSurface.getBoundingClientRect();
            const low = (systemCuts[index-1] ?? cropDraft[1])+1;
            const high = (systemCuts[index+1] ?? (cropDraft[1]+cropDraft[3]))-1;
            if (low > high) return;
            guide.setPointerCapture(event.pointerId);
            guide.onpointermove = move => {
                systemCuts[index] = rounded(clamp((move.clientY-rect.top)*100/rect.height,low,high));
                guide.style.top = systemCuts[index]+"%";
                input.value = systemCuts[index];
            };
            guide.onlostpointercapture = () => { guide.onpointermove = null; };
        };
        canvas.append(guide);
        const label = element("label","",`Boundary ${index+1} (%)`);
        const input = element("input");
        input.type = "number";
        input.step = ".1";
        input.value = cut;
        input.onchange = () => {
            const minimum = (systemCuts[index-1] ?? cropDraft[1])+1;
            const maximum = (systemCuts[index+1] ?? (cropDraft[1]+cropDraft[3]))-1;
            if (Number.isFinite(input.valueAsNumber) && minimum <= maximum) {
                systemCuts[index] = rounded(clamp(input.valueAsNumber,minimum,maximum));
            }
            renderSystemGuides();
        };
        const remove = element("button","","Remove");
        remove.type = "button";
        remove.onclick = () => { systemCuts.splice(index,1); renderSystemGuides(); };
        label.append(input,remove);
        controls.append(label);
    }
    $("cropStatus").textContent = systemCuts.length
        ? `${systemCuts.length+1} proposed systems. Drag boundaries to adjust, or click to add one.`
        : "No system boundaries found. Add one by hand.";
    $("cropApply").disabled = !systemCuts.length;
}
$("systemGuides").onclick = event => {
    const rect = cropSurface.getBoundingClientRect();
    const cut = rounded(100*(event.clientY-rect.top)/rect.height);
    addSystemCut(cut);
};
function addSystemCut(cut) {
    const bounds = [cropDraft[1],...systemCuts,cropDraft[1]+cropDraft[3]];
    if (cut <= bounds[0]+1 || cut >= bounds.at(-1)-1 || bounds.some(value => Math.abs(value-cut)<1)) return;
    systemCuts.push(cut);
    systemCuts.sort((a,b) => a-b);
    renderSystemGuides();
}
$("systemsAuto").onclick = findSystems;
$("exitSystems").onclick = () => {
    setSystemMode(false);
    $("cropApply").disabled = false;
};
$("addSystemCut").onclick = () => {
    const bounds = [cropDraft[1],...systemCuts,cropDraft[1]+cropDraft[3]];
    let index = 0;
    for (let i = 1; i < bounds.length-1; i++) {
        if (bounds[i+1]-bounds[i] > bounds[index+1]-bounds[index]) index = i;
    }
    addSystemCut(rounded((bounds[index]+bounds[index+1])/2));
};
function applySystems() {
    if (!systemCuts.length) return;
    const [x,y,width,height] = cropDraft;
    const image = readCropPixels();
    const bounds = [y,...systemCuts,y+height];
    const systems = bounds.slice(0,-1).map((top,index) => ({
        kind:"image",file:croppedClip.file,score:true,verse:verseOf(croppedClip),system:true,
        queueOrder:croppedClip.start,
        name:`${croppedClip.name} · System ${index+1}`,
        crop:trimBand(image,[x,top,width,bounds[index+1]-top])
    }));
    project.clips = project.clips.filter(clip => clip !== croppedClip);
    enqueueSystems(systems);
}
function enqueueSystems(systems) {
    project.systemQueue = [...queuedSystems(),...systems].sort((a,b) => a.queueOrder-b.queueOrder);
    selected = null;
    timingSystem = null;
    cueMode = false;
    if ($("cropDialog").open) $("cropDialog").close();
    activeVisual = null;
    changed();
    seek(cursor);
    render();
    status("Systems ready. Press C to place the first one.");
}
function isSystemClip(clip) {
    return clip.kind === "image" && clip.score && (clip.system || / · System \d+$/.test(clip.name));
}
$("queueExisting").onclick = () => {
    const clips = project.clips.filter(isSystemClip);
    if (!clips.length) return;
    pause();
    project.clips = project.clips.filter(clip => !isSystemClip(clip));
    enqueueSystems(clips.map(clip => ({
        kind:"image",file:clip.file,score:true,verse:verseOf(clip),system:true,
        queueOrder:clip.start,name:clip.name,crop:clip.crop
    })));
};

function trimBand(image, box) {
    if (!image) return box;
    const {width,height,pixels} = image;
    const [x,y,w,h] = box;
    const left = Math.floor(x*width/100);
    const right = Math.min(width,Math.ceil((x+w)*width/100));
    const top = Math.floor(y*height/100);
    const bottom = Math.min(height,Math.ceil((y+h)*height/100));
    let minX = right, maxX = left, minY = bottom, maxY = top;
    for (let row = top; row < bottom; row++) {
        for (let column = left; column < right; column++) {
            const i = (row*width+column)*4;
            if (Math.min(pixels[i],pixels[i+1],pixels[i+2]) >= 185) continue;
            minX = Math.min(minX,column);
            maxX = Math.max(maxX,column);
            minY = Math.min(minY,row);
            maxY = Math.max(maxY,row);
        }
    }
    if (maxX <= minX || maxY <= minY) return box;
    const x1 = Math.max(x,minX/width*100-1);
    const y1 = Math.max(y,minY/height*100-1);
    const x2 = Math.min(x+w,(maxX+1)/width*100+1);
    const y2 = Math.min(y+h,(maxY+1)/height*100+1);
    return [x1,y1,x2-x1,y2-y1].map(rounded);
}
$("cropApply").onclick = () => {
    if (systemCuts !== null) {
        applySystems();
        return;
    }
    for (const clip of project.clips) {
        if (clip === croppedClip || ($("cropAll").checked && clip.kind === "image" && clip.file === croppedClip.file)) {
            clip.crop = cropDraft.map(rounded);
        }
    }
    $("cropDialog").close();
    activeVisual = null;
    changed();
    render();
};
function remove() {
    if (!selectedClip()) return;
    timingSystem = null;
    cueMode = false;
    pause();
    project.clips = project.clips.filter(clip => clip.id !== selected);
    selected = null;
    activeVisual = null;
    changed();
    seek(cursor);
    render();
}
$("undo").onclick = () => stepHistory(undoStack,redoStack);
$("redo").onclick = () => stepHistory(redoStack,undoStack);
$("name").onchange = () => {
    project.name = $("name").value.trim() || "Untitled score video";
    changed();
};
$("save").onclick = async () => { await save(); await listProjects(); };
$("new").onclick = async () => { if (dirty) await save(); else await pendingSave; reset(empty()); await listProjects(); };
$("projects").onchange = async () => {
    const id = $("projects").value;
    if (!id) return;
    if (dirty) await save(); else await pendingSave;
    reset(await request(`/project/${id}`));
    status("Opened");
};
$("import").onclick = () => $("files").click();
$("files").onchange = () => {
    const files = Array.from($("files").files);
    $("files").value = "";
    importFiles(files).catch(error => status(error.message));
};
$("title").onclick = () => addClip({kind:"title",name:"Title card",text:"Your title",
    color:"#f7e8cd",background:"#252035",fontSize:5,duration:4},cursor);
$("home").onclick = () => seek(0);
$("play").onclick = togglePlayback;
$("seek").oninput = () => seek(Number($("seek").value));
$("zoom").oninput = () => { scale = Number($("zoom").value); renderTimeline(); };
$("remove").onclick = remove;
$("split").onclick = split;
$("cut").onclick = setNextCut;
$("timing").onclick = toggleSystemTiming;
$("repeat").onclick = openVerse;
$("beginImport").onclick = () => $("files").click();
$("export").onclick = () => {
    pause();
    $("exportDialog").showModal();
};
$("resolution").onchange = () => { project.resolution = $("resolution").value; changed(); };
$("render").onclick = async () => {
    if (!end()) { $("progress").textContent = "Add a clip before exporting."; return; }
    $("render").disabled = true;
    $("download").hidden = true;
    $("progress").textContent = "Preparing export";
    try {
        await save();
        const {job} = await post(`/export/${project.id}`, project);
        for (;;) {
            const info = await request(`/job/${job}`);
            $("progress").textContent = info.message;
            if (info.status === "error") break;
            if (info.status === "done") {
                $("download").href = info.url;
                $("download").hidden = false;
                break;
            }
            await new Promise(resolve => setTimeout(resolve,750));
        }
    } catch (error) { $("progress").textContent = error.message; }
    finally { $("render").disabled = false; }
};
document.addEventListener("keydown", event => {
    if (document.querySelector("dialog[open]") || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === "z" || key === "y")) {
        event.preventDefault();
        if (key === "y" || event.shiftKey) $("redo").click();
        else $("undo").click();
        return;
    }
    if (event.code === "Space" && event.target.tagName !== "BUTTON") {
        event.preventDefault();
        togglePlayback();
    }
    if (event.key === "Delete") remove();
    if (key === "c" && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey) setNextCut();
});
updateHistoryButtons();
render();
listProjects().catch(error => status(error.message));
