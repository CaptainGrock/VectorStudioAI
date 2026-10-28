# VectorStudio AI (standalone)

Prompt-to-video vector infographic studio. Describe an animation in plain text, get a deterministic JSON Scene Graph, preview it frame-accurately, refine it with directional edits, polish keyframes on a timeline, and render a local MP4.

No Pinokio required. Just Node.js + this folder + `start.bat`.

## Quick start (Windows)

1. Install Node.js 20 LTS from https://nodejs.org/ (includes npm).
2. Double-click **`start.bat`**.
   - First run installs dependencies automatically.
   - It starts the server at `http://127.0.0.1:5173/` and opens your browser.
3. To stop: close the terminal window (Ctrl+C).

Manual equivalent:

```bat
npm install
npm run dev -- --port 5173 --host 127.0.0.1
```

## How to use

1. **Generate** — type e.g. `Create infographic. Title 'Q3 Review'. Bar chart sales 10k to 50k. Bank icon slides in from left.` Click Generate. Timeline populates, video previews instantly. **Attach data:** click Attach CSV/XLSX to add a spreadsheet as chart data (stays attached for follow-up prompts), or paste a markdown table straight into the prompt — both map label/value columns automatically (e.g. Total Revenue by Product Name). Line charts wipe-reveal left-to-right; bar charts grow.
2. **Directional edit** — type e.g. `Make the bank zoom in slower, finish at frame 90`. Applies a JSON Patch to the scene, player updates.
3. **Polish** — drag the yellow keyframe diamonds on the timeline to retime.
4. **Export MP4** — click Export JSON (saves `scene.json`), then in a terminal here run:

```bat
npm run render
```

This builds `out.mp4` (1280x720) via Remotion.

## Optional AI backends

- **Local models (Ollama picker):** the green/red dot shows whether Ollama is reachable. The dropdown lists every model already on your system — pick one. **Download a model** types any Ollama name (`llama3.1`, `qwen2.5:7b`, `gemma3:4b`…) and Pull streams download progress; the pulled model becomes selected automatically.
- **Cloud:** collapsible OpenAI-compatible base URL + model + key, used only if Ollama is unreachable and a key is set. Key stays in this browser's localStorage.
- **Advanced: system prompts:** collapsible textareas expose the fixed generation and directional-edit instructions — tweak the wording to shape LLM output, Reset restores defaults.
- **Neither:** with no Ollama and no key, the built-in rule-based generator handles charts, titles, bank/arrow/person shapes, walk cycles, fades, and retimes offline.

## Files

```
start.bat            <- double-click launcher (backend + studio)
package.json         <- npm scripts (dev / dev:vite / server / render)
scripts/dev-all.mjs  <- launches backend then Vite, one window
server/              <- local-engine backend: hardware.mjs, models.mjs, engine.mjs, index.mjs
models/              <- your GGUF files land here (created on first download)
llama.cpp/           <- downloaded llama-server builds live here
vite.config.js       <- dev server on 127.0.0.1, proxies /api to the backend
index.html / src/    <- React NLE: App.jsx, EngineSettings.jsx, store.js, sceneGraph.js, llm.js
src/remotion/        <- SceneComposition.jsx, Root.jsx, index.js (Remotion entry)
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

## Troubleshooting

- `npm` not recognized → install Node.js 20 LTS and reopen the terminal.
- Port 5173 busy → run `npm run dev -- --port 5174 --host 127.0.0.1` and open that URL.
- Blank node_modules issues → delete `node_modules`, double-click `start.bat` again.
