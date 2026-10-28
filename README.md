# VectorStudio AI (standalone)

Prompt-to-video vector infographic studio. Describe an animation in plain text, get a deterministic JSON Scene Graph, preview it frame-accurately, refine it with directional edits, polish keyframes on a timeline, add narration and music, and render a local MP4.

No Pinokio required. Just Node.js + this folder + `start.bat`.

## Examples

- [Example 1](examples/example.mp4)
- [Example 2](examples/example2.mp4)

## Quick start (Windows)

1. Install Node.js 20 LTS from https://nodejs.org/ (includes npm).
2. Double-click **`start.bat`**.
   - First run installs dependencies automatically.
   - It starts the server at `http://127.0.0.1:5173/` and opens your browser.
3. To stop: close the terminal window (Ctrl+C).

Manual equivalent:

```bat
npm install
npm run dev -- --port 5174 --host 127.0.0.1
```

## Workflow

Left rail:

1. **1 · Generate** — type a prompt like `Create infographic. Title 'Q3 Review'. Bar chart sales 10k to 50k.` Click **Generate scene**. Stages 2 + 3 start collapsed; finishing a generate pops Stage 2 open.
   - Attach a spreadsheet with **Attach CSV/XLSX**, load a bundled sample dataset, or paste a Markdown table straight into the prompt. Tables are parsed locally; later prompts can regroup them (`group by vessel`, `count`, `top 10`, `only Cup and Waffle Cone`, `ignore <column>`).
   - Charts carry their table lineage, so **Refresh data** rebuilds a chart from the current dataset while keeping keyframes, timing, and colors.
2. **2 · Revise chart** — conversational JSON-Patch edits (`Make the bars vertical`, `stack by topping`, `show top 10 only`, `add y-axis labels`). A revision thread keeps the conversation history.
3. **3 · Assets** — background image, attached images, attached audio, and narration/music tracks.

Right rail inspector:

- Transform (X/Y/scale/opacity), Text content, Fonts, Motion (Regular/In/Out easing), keyframes, and audio controls.
- Drag titles, images, and shapes directly on the video; dropping saves a keyframe.
- Timeline: zoom/fit, Trim, collapse/expand tracks, forgiving edge snapping, Home/End playhead jumps, Ctrl+Z / Ctrl+Y undo-redo.

## Charts, pacing, and export

Supported chart types include bar/line/pie/area/scatter/histogram/waterfall/funnel/radar/map bubbles, plus stacked bars (`bar_chart` with `data.series`) and line `drawMode: "connect"` (“connect the dots”: points pop first, then segments draw).

Pacing uses `reveal` and `stagger` per chart; every chart renderer honors both.

Fonts:

- System fonts built in, plus Google Fonts search and custom font URLs.
- Font choice, size, and color apply in the live preview and are embedded/resolved for MP4 export.

Top bar:

- Single **Export ▾** menu:
  - **Export MP4** renders the current scene on the local server (`/api/render`) and downloads `vectorstudio.mp4`. First render may download a headless browser and take several minutes. Export resolution follows the scene’s width/height.
  - **Export JSON** downloads the re-importable `scene.json`.

## Voice narration with BreezeTTS-2

Local voice cloning/narration runs through the official BreezeTTS-2 `infer.py` CLI when installed. Voices live in the browser; heavy model files stay on disk and are never committed.

> License note: BreezeTTS-2 weights are BreezeBlue Research + Non-Commercial licensed — fine for personal work, not for paid client output.

### Requirements

- Windows PC with an **NVIDIA GPU** recommended. The bundled voice runner is CUDA-only; CPU-only PyTorch cannot run it.
- A Python interpreter whose PyTorch has CUDA support. Your ComfyUI Python is usually the best candidate.
- About **15 GB** free for the official checkpoint.
- SoX is optional and only matters for some non-WAV reference-audio formats.

### Setup: Settings → Text-to-Speech

1. **Model folder**
   - Defaults to `C:\Stable\ComfyUI\models\breezetts2` when it exists, otherwise an app-local `models/breezetts2` folder.
   - Use **Use folder** after choosing where checkpoints live.

2. **Python**
   - Pick the interpreter that will run the voice model.
   - Use **Search for ComfyUI Python** to find ComfyUI/venv interpreters, or paste a full interpreter path such as `C:\Stable\ComfyUI\python_embeded\python.exe`.
   - If the app suggests a fully ready Python, one click switches to it.
   - If the selected Python has CPU-only torch, either pick a CUDA Python or use **Install CUDA torch into …** (several GB).

3. **BreezeTTS-2 code**
   - Point at a full `breeze-tts` folder containing both `breeze_infer` and `infer.py`.
   - Or use **Install into app**, which clones the official repo into the app-local `tts/breeze-tts` folder. This folder is git-ignored as a runtime artifact.

4. **Checkpoint**
   - `infer.py` needs the official checkpoint layout, not the ComfyUI mirror layout.
   - Official layout means a folder with `config.json` plus sharded weights such as `model-00001-of-00004.safetensors`.
   - A single merged ComfyUI-style weights file is detected as a mirror and will not load.
   - Use **Download** for `BreezeBlue/Breeze-TTS-2` with progress and resume-style skipping of files already present.

5. **Dependencies**
   - If the readiness check names missing packages, use **Install dependencies into …**. It targets the selected Python only.

6. **Voices**
   - Add one or more speakers.
   - Reference clips are optional; the default generic voice works without one.
   - Clips should be short clean speech, up to 8 MB, with an exact transcript.

### Generate narration

1. Open Stage 3 → Assets.
2. Add a **TTS** track.
3. On the right rail, type the script, choose voice, optionally set seed/instruction.
4. Click **Generate speech**.
   - Same text + same seed + same voice gives the same take.
   - Use the dice button for a random seed/take.
   - Long synthesis jobs show elapsed time/log output and can be cancelled.
   - TTS can extend the timeline when narration is longer than the current scene.
5. Music tracks support attached files, play-from offsets for long source files, volume sliders, and volume keyframes for fades/ducking.

### BreezeTTS troubleshooting

- `local server is outdated — restart start.bat`: the backend started without TTS support; restart it.
- `torch 2.x+cpu` / `can't see a GPU`: that interpreter has CPU-only torch. Use a CUDA Python or install CUDA torch.
- `fast streaming requires a CUDA device`: same cause — no CUDA-visible GPU for that Python.
- Missing `qwen-tts` / another package: use **Install dependencies into …** for the selected Python.
- ComfyUI mirror folder error: download/open the official checkpoint layout instead.
- `SoX ... not recognized`: benign unless an MP3/M4A reference clip fails; install SoX only then.
- Over-25 MB narration: split the script and synthesize in parts.
- Synthesis timeout after ~10 minutes: use shorter text.

## Optional AI backends

- **Local models (Ollama picker):** the green/red dot shows whether Ollama is reachable. The dropdown lists models already on your system. **Download a model** types any Ollama name (`llama3.1`, `qwen2.5:7b`, `gemma3:4b`…) and Pull streams download progress; the pulled model becomes selected automatically.
- **Cloud:** collapsible OpenAI-compatible base URL + model + key, used only if Ollama is unreachable and a key is set. Key stays in this browser's localStorage.
- **Advanced: system prompts:** collapsible textareas expose the fixed generation and directional-edit instructions — tweak the wording to shape LLM output, Reset restores defaults.
- **Neither:** with no Ollama and no key, the built-in rule-based generator handles charts, titles, bank/arrow/person shapes, walk cycles, fades, and retimes offline.

## Files

```text
start.bat            <- double-click launcher (backend + studio)
package.json         <- npm scripts (dev / dev:vite / server / render)
scripts/dev-all.mjs  <- launches backend then Vite, one window
server/              <- local-engine backend: hardware.mjs, models.mjs, engine.mjs, index.mjs
server/tts.mjs       <- BreezeTTS-2 backend: Python scan, installs, checkpoint, synthesis
server/settings.json <- local backend settings (git-ignored; never commit secrets)
src/TtsSettings.jsx  <- Settings → Text-to-Speech tab
src/                 <- React NLE: App.jsx, LlmSettings.jsx, EngineSettings.jsx, store.js, sceneGraph.js, llm.js
src/remotion/        <- SceneComposition.jsx, Root.jsx, index.js (Remotion entry)
tts/                 <- installed breeze-tts repo lives here (git-ignored runtime artifact)
models/              <- your GGUF files land here (created on first download)
llama.cpp/           <- downloaded llama-server builds live here
vite.config.js       <- dev server on 127.0.0.1, proxies /api to the backend
index.html / src/    <- React NLE: App.jsx, EngineSettings.jsx, store.js, sceneGraph.js, llm.js
public/assets/       <- bank.svg, arrow.svg, person.svg
scene.json           <- default render props for `npm run render`
```

## Local engine (same technique as JobKing)

The **Local engine** panel at the top of the left sidebar is a slim port of
JobKing's Settings → ModelSetup flow, adapted from its
`server/hardware.js`, `modelscan.js`, `modelcatalog.js`, `modeldownload.js`
and `llamaengine.js`:

- **Status strip** — green = a model is serving, red = not. Start picks your
  newest on-disk model (or the last one used); Stop unloads it.
- **Models on this machine** — every `.gguf` in `models/` plus a bounded
  **Search my drives** walk (model folder, Downloads, Documents, LM Studio /
  Hugging Face caches, whole drives up to a depth/time budget). Press **Use**
  on any file to serve it.
- **Worth downloading for this video card** — your VRAM is probed
  (`nvidia-smi`, Windows registry fallback), a 1 GB headroom budget is set,
  and each curated Hugging Face quant is badged Fits great / Tight / CPU only
  / Won't fit, with the best comfortable fit starred as recommended. Downloads
  are resumable (`.part` files), pre-checked for free disk space, with live
  MB/s progress. Press **Use** when one finishes.
- **Engine binary** — if no `llama-server` is found anywhere, it offers the
  matching official llama.cpp build for your GPU (CUDA 13 / CUDA 12 / Vulkan /
  CPU, with a driver-version guard) and unpacks it into `llama.cpp/`.

Generation order is now: managed engine → Ollama → cloud key → offline rules.
Settings persist in `server/settings.json`, so the backend autostarts your last
model on next launch.

## Privacy and secrets

- `server/settings.json`, `.env` files, model folders, `llama.cpp/`, and `tts/` are ignored by git.
- Cloud keys stay in browser localStorage; do not paste API keys, tokens, or private paths into issues, logs, or committed docs.
- Before pushing, this repo is checked for obvious committed secrets and the `origin` remote is expected to contain no embedded credentials.

## Troubleshooting

- `npm` not recognized → install Node.js 20 LTS and reopen the terminal.
- Port 5173 busy → run `npm run dev -- --port 5174 --host 127.0.0.1` and open that URL.
- Blank node_modules issues → delete `node_modules`, double-click `start.bat` again.
