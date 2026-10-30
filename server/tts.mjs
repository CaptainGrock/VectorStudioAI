// BreezeTTS-2 local integration: model-folder scan, VRAM-fit estimate, and
// speech synthesis through the official `infer.py` CLI when it is installed.
// Voices (reference audio + transcript) live in the browser (localStorage);
// the backend only needs them at synth time, passed in the request body.
//
// Model weights are BreezeBlue Research + Non-Commercial licensed —
// self-hosted use is fine, commercial use needs a separate license.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { spawnSync, spawn } from "node:child_process";
import { loadSettings } from "./models.mjs";

const WIN_DEFAULT = "C:\\Stable\\ComfyUI\\models\\breezetts2";

export function defaultTtsDir(root) {
  try {
    if (fs.existsSync(WIN_DEFAULT)) return WIN_DEFAULT;
  } catch { /* ignore */ }
  try {
    const s = loadSettings().ttsDir;
    if (s) return s;
  } catch { /* ignore */ }
  return path.join(root, "models", "breezetts2");
}

// A checkpoint is a directory holding config.json + weight files, or a
// single merged weight file (ComfyUI mirror style).
export function ttsModels(dir) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        const inner = fs.readdirSync(full);
        const hasCfg = inner.includes("config.json");
        const weights = inner.filter((n) => /\.(safetensors|bin|pt)$/i.test(n));
        if (hasCfg && weights.length) {
          let bytes = 0;
          for (const w of weights) {
            try { bytes += fs.statSync(path.join(full, w)).size; } catch { /* skip */ }
          }
          out.push({ name: e.name, path: full, kind: "checkpoint", layout: scanCheckpoint(full).layout, sizeGB: Math.round((bytes / 1073741824) * 100) / 100 });
        }
      } else if (/\.(safetensors|gguf|pt|bin)$/i.test(e.name)) {
        const st = fs.statSync(full);
        if (st.size > 50 * 1024 * 1024) {
          out.push({ name: e.name, path: full, kind: "weights", sizeGB: Math.round((st.size / 1073741824) * 100) / 100 });
        }
      }
    } catch { /* skip unreadable */ }
  }
  return out;
}

// VRAM guidance straight from the official README: ~7.7 GiB eager
// (12 GB recommended), ~14.4 GiB with --fast-all (24 GB recommended).
export function ttsFit(budgetGB) {
  const b = Number(budgetGB) || 0;
  if (!b) return { verdict: "unknown", note: "Video-card memory unknown — eager inference needs ~8 GB VRAM." };
  if (b >= 24) return { verdict: "great", note: `~${b} GB headroom — fits great, even with --fast-all (~14 GB).` };
  if (b >= 12) return { verdict: "great", note: `~${b} GB headroom — fits great in eager mode (~8 GB).` };
  if (b >= 8) return { verdict: "tight", note: `~${b} GB headroom — tight fit: eager mode (~8 GB) may work, close other GPU apps first.` };
  return { verdict: "cpu", note: `~${b} GB headroom — too small for the 3B model on GPU; CPU inference works but is slow.` };
}

// Candidate interpreters: PATH pythons plus the usual ComfyUI spots — the
// portable build (python_embeded) and common venv layouts. ComfyUI's env
// already has torch, so it's the best place to pip-install breeze_infer.
function candidatePythons() {
  const cands = [];
  // Previously discovered interpreters (from the drive search below).
  try {
    const extra = loadSettings().ttsPyExtra;
    if (Array.isArray(extra)) for (const a of extra) if (Array.isArray(a) && a.length && a.every((x) => typeof x === "string" && x)) cands.push(a);
  } catch { /* ignore */ }
  if (process.platform === "win32") {
    cands.push(["python"], ["py", "-3"], ["python3"]);
    const roots = [process.env.COMFYUI_DIR, "C:/Stable/ComfyUI", "C:/ComfyUI", path.join(os.homedir(), "ComfyUI")].filter(Boolean);
    for (const root of roots) {
      cands.push(
        [path.join(root, "python_embeded", "python.exe")],
        [path.join(root, "venv", "Scripts", "python.exe")],
        [path.join(root, ".venv", "Scripts", "python.exe")],
      );
    }
  } else {
    cands.push(["python3"], ["python"]);
  }
  const seen = new Set();
  return cands.filter((py) => {
    const key = py.join(" ").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// PYTHONPATH carrying the code library: with it, `import breeze_infer`
// resolves even when the interpreter never had it pip-installed.
function pyEnvWithLib(libPath) {
  if (!libPath) return process.env;
  const sep = process.platform === "win32" ? ";" : ":";
  return { ...process.env, PYTHONPATH: libPath + (process.env.PYTHONPATH ? sep + process.env.PYTHONPATH : "") };
}

// One interpreter launch reports the runtime, every third-party package
// infer.py needs, and whether PyTorch can actually see CUDA —
// breeze_infer alone imports fine without torch, and torch imports fine
// without a GPU, so neither ever means "ready to synthesize" by itself.
const CHECK_SRC = "import importlib.util,json\nmods=['breeze_infer','torch','transformers','qwen_tts','soundfile']\nout={'mods':{m:importlib.util.find_spec(m) is not None for m in mods},'accel':{m:importlib.util.find_spec(m) is not None for m in ['triton','flash_attn']}}\ntry:\n import torch\n out['torch_ver']=torch.__version__\n out['cuda_build']=torch.version.cuda\n try:\n  out['cuda_available']=bool(torch.cuda.is_available())\n  out['devices']=[torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())] if out['cuda_available'] else []\n  out['memGB']=round(torch.cuda.get_device_properties(0).total_memory/1073741824,1) if out['cuda_available'] and torch.cuda.device_count() else 0\n except Exception as e:\n  out['cuda_available']=False;out['devices']=[];out['cuda_error']=str(e)[:200]\nexcept Exception as e:\n out['torch_ver']='';out['cuda_build']='';out['cuda_available']=False;out['devices']=[];out['torch_error']=str(e)[:200]\nprint(json.dumps(out))";
// Probe cache: tab polling hits /api/tts every few seconds, and each probe
// spawns a Python + imports torch — without caching every reload takes
// ages and the UI looks dead. 30 s TTL, cleared whenever an installer
// job finishes (pip/clone change the answers).
const pyProbeCache = new Map();
export function clearProbeCache() { pyProbeCache.clear(); }
function probePython(arr, env, importTimeout) {
  const cacheKey = `${arr.join(" ")}||${env.PYTHONPATH || ""}`;
  const cached = pyProbeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 30000) return cached.rec;
  try {
    const r = spawnSync(arr[0], [...arr.slice(1), "--version"], { timeout: 15000 });
    if (r.status !== 0) return null;
    const ver = String(r.stdout || r.stderr || "").trim();
    let info = {};
    try {
      const r2 = spawnSync(arr[0], [...arr.slice(1), "-c", CHECK_SRC], { timeout: importTimeout, env });
      if (r2.status === 0) info = JSON.parse(String(r2.stdout || "{}"));
    } catch { /* import check failed */ }
    const mods = info.mods || {};
    const rec = {
      argv: arr, exe: arr.join(" "), ver,
      hasBreeze: !!mods.breeze_infer,
      deps: { torch: !!mods.torch, transformers: !!mods.transformers, qwen_tts: !!mods.qwen_tts, soundfile: !!mods.soundfile },
      accel: { triton: !!(info.accel || {}).triton, flash: !!(info.accel || {}).flash },
      cuda: {
        available: !!info.cuda_available,
        devices: Array.isArray(info.devices) ? info.devices : [],
        memGB: Number(info.memGB) || 0,
        torchVer: info.torch_ver || "",
        cudaBuild: info.cuda_build || "",
        error: info.cuda_error || "",
        torchError: info.torch_error || "",
      },
    };
    pyProbeCache.set(cacheKey, { at: Date.now(), rec });
    if (pyProbeCache.size > 40) pyProbeCache.delete(pyProbeCache.keys().next().value);
    return rec;
  } catch { return null; }
}

function hasBreezeInfer(py, timeout = 60000, env = process.env) {
  try {
    const r = spawnSync(py[0], [...py.slice(1), "-c", "import breeze_infer"], { timeout, env });
    return r.status === 0;
  } catch {
    return false;
  }
}

// Full dropdown list (quick import checks) + the effective interpreter:
// the user's saved pick wins, otherwise the first one that imports the
// runtime, otherwise the first one that launches at all.
export function ttsPythonStatus(root, savedPy, libPath) {
  const env = pyEnvWithLib(libPath);
  // A fully working interpreter (runtime + packages + visible CUDA) is
  // suggested so the user can one-click away from a half-working pick.
  const fullyReady = (x) => x.hasBreeze && x.deps && Object.values(x.deps).every(Boolean) && x.cuda?.available;
  const list = [];
  const withSuggested = (selected) => ({ list, selected, suggested: list.find((x) => fullyReady(x) && x.exe !== selected.exe) || null });
  for (const c of candidatePythons()) {
    const rec = probePython(c, env, 20000);
    if (rec) list.push({ exe: rec.exe, argv: rec.argv, ver: rec.ver, hasBreeze: rec.hasBreeze, deps: rec.deps, cuda: rec.cuda });
  }
  if (Array.isArray(savedPy) && savedPy.length) {
    const hit = list.find((x) => x.exe === savedPy.join(" "));
    if (hit) return withSuggested(hit);
    const rec = probePython(savedPy, env, 60000);
    if (rec) { list.push({ exe: rec.exe, argv: rec.argv, ver: rec.ver, hasBreeze: rec.hasBreeze, deps: rec.deps, cuda: rec.cuda }); return withSuggested(list[list.length - 1]); }
    return withSuggested({ exe: savedPy.join(" "), argv: savedPy, ver: "", hasBreeze: false, cuda: null, broken: true });
  }
  const selected = list.find((x) => x.hasBreeze) || list[0] || { exe: "", argv: [], ver: "", hasBreeze: false, cuda: null };
  return withSuggested(selected);
}

// ---- Drive search for ComfyUI / venv Pythons ----
// Bounded BFS (60 s, depth 6): finds python_embeded + venv interpreters
// wherever ComfyUI actually lives (Pinokio installs, D:\, …) without
// walking the whole disk. Matches only ComfyUI/venv-shaped paths.
export function scanForPythons(roots) {
  if (process.platform !== "win32") return { ok: false, error: "Drive search is Windows-only — paste the Python path above instead." };
  const SKIP = new Set(["windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information", "perflogs", "node_modules", ".git", "dist", "temp", "tmp", "__pycache__"]);
  const found = [];
  const seen = new Set();
  const deadline = Date.now() + 60000;
  const q = [];
  for (const r of roots || []) {
    try { const d = String(r).trim(); if (d && fs.statSync(d).isDirectory()) q.push({ dir: d, depth: 0 }); } catch { /* skip */ }
  }
  const pushExe = (full, hint) => {
    const key = full.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (found.length < 40) found.push({ argv: [full], hint });
  };
  let entries = 0;
  while (q.length && Date.now() < deadline && found.length < 40 && entries < 200000) {
    const { dir, depth } = q.shift();
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      if (Date.now() >= deadline || found.length >= 40) break;
      const name = e.name.toLowerCase();
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(name) || depth >= 6) continue;
        entries++;
        if (/comfy|stable|pinokio|python|venv|env|conda|ai|apps|tools/.test(name)) q.unshift({ dir: full, depth: depth + 1 });
        else q.push({ dir: full, depth: depth + 1 });
      } else if (name === "python.exe") {
        entries++;
        const low = full.toLowerCase();
        if (low.includes("comfyui")) pushExe(full, "ComfyUI");
        else if (low.includes("python_embeded") || /(^|[\\/])(venv|\.venv|envs)([\\/]|$)/.test(low)) pushExe(full, "venv");
      }
    }
  }
  return { ok: true, found, truncated: Date.now() >= deadline || found.length >= 40 };
}

// ---- BreezeTTS-2 code library (breeze_infer runtime + infer.py) ----
// The official repo (breezeblue-ai/breeze-tts) is the supported source —
// the ComfyUI node packs reimplement the runtime for graphs and usually
// ship no infer.py, so they can be pointed at but not executed directly.
export const LIB_REPO = "https://github.com/breezeblue-ai/breeze-tts";
export function defaultAppLibDir(root) { return path.join(root, "tts", "breeze-tts"); }

export function scanLibDir(dir) {
  try {
    if (!dir || !fs.statSync(dir).isDirectory()) return null;
  } catch { return null; }
  const hasRuntime = fs.existsSync(path.join(dir, "breeze_infer", "__init__.py")) || fs.existsSync(path.join(dir, "breeze_infer.py"));
  const hasInfer = fs.existsSync(path.join(dir, "infer.py"));
  const hasReqs = fs.existsSync(path.join(dir, "requirements.txt"));
  return { path: dir, hasRuntime, hasInfer, hasReqs, ok: hasRuntime && hasInfer };
}

// Saved folder first, then the user's ComfyUI nodes (handy if they cloned
// the official repo there), then the app's own subfolder.
export function findLib(root) {
  const cands = [];
  try { const s = loadSettings().ttsLibDir; if (s) cands.push(s); } catch { /* ignore */ }
  if (process.platform === "win32") {
    cands.push(
      "C:/Stable/ComfyUI/custom_nodes/comfyui-breeze-tts-2",
      "C:/Stable/ComfyUI/custom_nodes/ComfyUI-Breeze-TTS-2",
      "C:/ComfyUI/custom_nodes/comfyui-breeze-tts-2",
    );
  }
  cands.push(defaultAppLibDir(root));
  let partial = null;
  for (const c of cands) {
    const hit = scanLibDir(c);
    if (!hit) continue;
    if (hit.ok) return { ...hit, source: "found" };
    if (!partial) partial = { ...hit, source: "partial" };
  }
  return partial || { path: "", hasRuntime: false, hasInfer: false, hasReqs: false, ok: false, source: "none" };
}

// One background job at a time (clone or pip install), polled via /api/tts.
const libJob = { active: false, kind: "", log: [], error: "", done: false, startedAt: 0 };
let libChild = null;
export function libJobState() {
  // A percent parsed off the tail (pip's “13% |██” bar, git's
  // “Receiving objects: 45%”) drives a determinate progress bar.
  let pct = null;
  for (let i = libJob.log.length - 1; i >= 0; i--) {
    const m = /(\d{1,3})\s*%/.exec(libJob.log[i]);
    if (m) { pct = Math.min(99, Number(m[1])); break; }
  }
  return { ...libJob, log: libJob.log.slice(-12), elapsedSec: libJob.startedAt ? Math.round((Date.now() - libJob.startedAt) / 1000) : 0, pct };
}
export function cancelLibJob() {
  if (!libJob.active) return { ok: false, error: "No job running." };
  try { libChild?.kill(); } catch { /* ignore */ }
  libChild = null;
  libJob.active = false;
  libJob.error = "Cancelled.";
  clearProbeCache();
  return { ok: true };
}
function jobLog(msg) {
  // Split on CR as well as LF: pip and git repaint one progress line
  // with carriage returns, otherwise nothing visibly moves for minutes.
  const stamp = new Date().toLocaleTimeString();
  for (const line of String(msg).split(/[\r\n]+/)) {
    const clean = line.trim().slice(0, 220);
    if (clean) libJob.log.push(`[${stamp}] ${clean}`);
  }
  if (libJob.log.length > 60) libJob.log = libJob.log.slice(-60);
}
function runJob(kind, cmd, args, opts, doneCheck) {
  if (libJob.active) return { ok: true, already: true };
  Object.assign(libJob, { active: true, kind, log: [], error: "", done: false, startedAt: Date.now() });
  jobLog(`$ ${cmd} ${args.join(" ")}`);
  let child;
  try {
    child = spawn(cmd, args, opts);
  } catch (e) {
    libJob.active = false;
    libJob.error = e?.message || String(e);
    return { ok: false, error: libJob.error };
  }
  child.stdout?.on("data", (c) => jobLog(String(c).trim()));
  child.stderr?.on("data", (c) => jobLog(String(c).trim()));
  const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 1800000);
  libChild = child;
  child.on("error", (e) => { clearTimeout(timer); libChild = null; libJob.active = false; libJob.error = e?.message || "Could not launch the installer."; clearProbeCache(); });
  child.on("close", (code) => {
    clearTimeout(timer);
    libChild = null;
    libJob.active = false;
    clearProbeCache(); // pip/clone change what the probes report
    const bad = doneCheck ? doneCheck() : null;
    if (code === 0 && !bad) { libJob.done = true; jobLog("Done."); }
    else libJob.error = bad || `Exited with code ${code}. ${libJob.log.slice(-2).join(" ")}`;
  });
  return { ok: true, started: true };
}

export function startLibInstall(root) {
  const dest = defaultAppLibDir(root);
  if (scanLibDir(dest)?.ok) return { ok: true, already: true, path: dest };
  const git = spawnSync("git", ["--version"], { timeout: 15000 });
  if (git.status !== 0) return { ok: false, error: "git is not installed — install it (https://git-scm.com/downloads) or paste your existing BreezeTTS-2 folder above." };
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* ignore */ }
  try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* fresh clone */ }
  return runJob("clone", "git", ["clone", "--depth", "1", LIB_REPO, dest], { timeout: 1800000 }, () =>
    scanLibDir(dest)?.ok ? null : "Clone finished but breeze_infer/infer.py are missing — the repo layout may have changed.");
}

export function startDepsInstall(root, py) {
  const lib = findLib(root);
  if (!lib.path || !lib.hasReqs) return { ok: false, error: "No BreezeTTS-2 folder with requirements.txt — install the code first." };
  if (!py || !py.length) return { ok: false, error: "No Python found — install Python 3.10+ first." };
  return runJob("deps", py[0], [...py.slice(1), "-m", "pip", "install", "-r", path.join(lib.path, "requirements.txt")], { cwd: lib.path, timeout: 1800000 }, () =>
    hasBreezeInfer(py, 60000, pyEnvWithLib(lib.path)) ? null : "pip finished but breeze_infer still won't import — see the log above.");
}

// CUDA-enabled torch for a Python whose torch can't see the GPU. Unpinned
// (latest CUDA build) — the requirements pin is CPU-agnostic and pip
// resolves it from PyPI as a CPU wheel on some setups.
export function startCudaTorchInstall(root, py) {
  if (!py || !py.length) return { ok: false, error: "No Python found — install Python 3.10+ first." };
  return runJob("cuda-torch", py[0], [...py.slice(1), "-m", "pip", "install", "--upgrade", "torch", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cu128"], { timeout: 1800000 }, () => {
    try {
      const r = spawnSync(py[0], [...py.slice(1), "-c", "import torch;raise SystemExit(0 if torch.cuda.is_available() else 1)"], { timeout: 120000 });
      return r.status === 0 ? null : "pip finished but torch still can't see CUDA — update your NVIDIA driver (https://www.nvidia.com/drivers) and retry.";
    } catch { return "could not verify torch CUDA support — see the log above."; }
  });
}

function dataUrlToFile(dataUrl, dest) {
  const m = /^data:audio\/(\w+);base64,(.+)$/.exec(String(dataUrl || ""));
  if (!m) throw new Error("Reference audio must be a WAV/MP3 data URL.");
  fs.writeFileSync(dest, Buffer.from(m[2], "base64"));
}

// The single interpreter for a synth run: the user's saved pick, or the
// first candidate that imports the runtime. The check runs with the
// library on PYTHONPATH — the same environment synthesis will use — so a
// pip-less ComfyUI python with the folder on the path counts as ready.
export function pickPython(libPath, savedPy) {
  const env = pyEnvWithLib(libPath);
  if (Array.isArray(savedPy) && savedPy.length) {
    const rec = probePython(savedPy, env, 60000);
    if (!rec) return { py: null, exe: savedPy.join(" "), ver: "", hasBreeze: false, deps: {}, cuda: null, broken: true };
    return { py: rec.argv, exe: rec.exe, ver: rec.ver, hasBreeze: rec.hasBreeze, deps: rec.deps, cuda: rec.cuda };
  }
  const tried = [];
  let fallback = null;
  for (const c of candidatePythons()) {
    const rec = probePython(c, env, 60000);
    if (!rec) continue;
    tried.push(rec.exe);
    if (rec.hasBreeze) return { py: rec.argv, exe: rec.exe, ver: rec.ver, hasBreeze: true, deps: rec.deps, cuda: rec.cuda, tried };
    if (!fallback) fallback = rec;
  }
  if (fallback) return { py: fallback.argv, exe: fallback.exe, ver: fallback.ver, hasBreeze: false, deps: fallback.deps, cuda: fallback.cuda, tried };
  return { py: null, exe: "", ver: "", hasBreeze: false, deps: {}, cuda: null, tried };
}

export function synthStatus({ modelPath, libPath, savedPy } = {}) {
  const pick = pickPython(libPath, savedPy);
  if (!pick.py) {
    if (pick.broken) return { ok: false, error: `That Python won't launch (${pick.exe}) — pick another in Settings → Text-to-Speech.` };
    return { ok: false, error: "No Python found — install Python 3.10+ (https://www.python.org/downloads/)." };
  }
  if (!pick.hasBreeze) {
    return { ok: false, error: `The code is installed, but ${pick.exe} can't import it yet — hit “Install dependencies” in Settings → Text-to-Speech (it targets this exact Python), then retry.` };
  }
  const missing = Object.entries({ torch: "torch", transformers: "transformers", qwen_tts: "qwen-tts", soundfile: "soundfile" })
    .filter(([k]) => !(pick.deps || {})[k]).map(([, label]) => label);
  if (missing.length) {
    return { ok: false, error: `${pick.exe} is missing: ${missing.join(", ")} — hit “Install dependencies” in Settings → Text-to-Speech (it targets this exact Python), then retry.` };
  }
  // The official runner is CUDA-only (its runtime raises without it).
  if (!pick.cuda?.available) {
    const devs = (pick.cuda?.devices || []).join(", ");
    if (devs) return { ok: false, error: `${pick.exe} can't see your GPU (${devs}) — PyTorch has no CUDA here. Hit “Install CUDA torch” in Settings → Text-to-Speech, then retry.` };
    return { ok: false, error: `No NVIDIA GPU is visible to ${pick.exe || "Python"} — BreezeTTS-2's runner needs CUDA (12 GB+ VRAM recommended). If you do have an NVIDIA card, update its driver and hit “Install CUDA torch”, then retry.` };
  }
  return { ok: true, py: pick.py, memGB: Number(pick.cuda?.memGB) || 0, accel: pick.accel || { triton: false, flash: false } };
}

// Async (event-loop friendly): writes ref + output wavs to temp, spawns
// `python infer.py <ckpt> --ref-audio … --ref-text … --text … --output` and
// resolves { ok, dataUrl } or { ok:false, error } when it exits.
export function synthTts({ text, refAudioDataUrl, refText, instruction, modelPath, libDir, appRoot, savedPy, seed, timeoutMs = 600000, onLog, __child, fast = "auto", attn = "auto" } = {}) {
  const lib = (libDir && scanLibDir(libDir)?.ok) ? libDir : (appRoot ? findLib(appRoot).path : "");
  const libOk = lib && scanLibDir(lib)?.ok;
  if (!libOk) return Promise.resolve({ ok: false, error: "BreezeTTS-2 code folder not set — open Settings → Text-to-Speech and Install it or point it at your nodes folder." });
  const st = synthStatus({ modelPath, libPath: lib, savedPy });
  if (!st.ok) return Promise.resolve(st);
  const py = st.py;
  const t = String(text || "").trim().slice(0, 2000);
  if (!t) return Promise.resolve({ ok: false, error: "Nothing to speak — type the narration text first." });
  const seedNum = Number.isFinite(Number(seed)) ? Math.round(Number(seed)) : 42;
  let ckpt = String(modelPath || "");
  if (!ckpt) return Promise.resolve({ ok: false, error: "Pick a BreezeTTS-2 checkpoint folder first." });
  try {
    if (fs.statSync(ckpt).isFile()) ckpt = path.dirname(ckpt);
  } catch {
    return Promise.resolve({ ok: false, error: "That checkpoint path is gone — rescan the TTS folder." });
  }
  // Official infer.py loads via transformers from_pretrained, which needs
  // the standard layout (model.safetensors or sharded model-*.safetensors
  // + config.json). ComfyUI mirrors ship one renamed weights file instead
  // — detect that early with a useful message rather than a stack trace.
  const layout = scanCheckpoint(ckpt);
  if (layout.layout !== "official") {
    const hint = layout.layout === "mirror"
      ? "That folder is the ComfyUI mirror layout (a single renamed weights file) — infer.py can't load it."
      : "That folder doesn't look like a BreezeTTS-2 checkpoint (no model.safetensors / sharded weights + config.json).";
    return Promise.resolve({ ok: false, error: `${hint} Download the official checkpoint from Settings → Text-to-Speech, or pick a full repo clone.` });
  }
  // infer.py comes from the code library (official repo clone), falling
  // back to the checkpoint dir for all-in-one layouts.
  const inferPy = fs.existsSync(path.join(lib, "infer.py")) ? path.join(lib, "infer.py")
    : fs.existsSync(path.join(ckpt, "infer.py")) ? path.join(ckpt, "infer.py") : "";
  if (!inferPy) {
    return Promise.resolve({ ok: false, error: "No infer.py in the code folder or checkpoint — reinstall the code from Settings → Text-to-Speech." });
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vstts-"));
  return new Promise((resolve) => {
    let done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      resolve(out);
    };
    let refWav;
    try {
      const outWav = path.join(tmp, "out.wav");
      const attnArg = fast === "off" ? "eager" : String(attn || "auto");
      const baseArgs = [inferPy, ckpt, "--text", t, "--output", outWav, "--seed", String(seedNum), "--attn", attnArg];
      if (refAudioDataUrl) {
        refWav = path.join(tmp, "ref.wav");
        dataUrlToFile(refAudioDataUrl, refWav);
        baseArgs.push("--ref-audio", refWav);
        if (String(refText || "").trim()) baseArgs.push("--ref-text", String(refText).trim());
      }
      if (String(instruction || "").trim()) baseArgs.push("--instruction", String(instruction).trim(), "--cfg-scale", "4");
      const sep = process.platform === "win32" ? ";" : ":";
      // Speed policy (measured, same weights/math either way): every run
      // uses SDPA/flash attention over eager (~10-15% faster decode).
      // CUDA graphs (--fast-all) only pay off on long voiceovers: each
      // fresh process spends 40-95 s capturing graphs, so short clips get
      // SLOWER with them on. Auto therefore never enables graphs; Fastest
      // is the explicit opt-in for 60 s+ narrations, with a one-shot
      // fallback to stock when the card runs out of memory mid-run.
      const memGB = Number(st.memGB) || 0;
      const hasTriton = !!(st.accel || {}).triton;
      let wantFast = fast === "on";
      if (wantFast && !hasTriton) {
        return Promise.resolve({ ok: false, error: `${py.join(" ")} has no triton — CUDA graphs can't compile without it. Run “${py[0]} -m pip install triton-windows” (Windows) or pick Standard speed instead.` });
      }
      // Config echo: the box under generation shows exactly what this run
      // costs, so a slow run is self-diagnosing (instruction ON doubles
      // tokens; a reference clip adds prefill; the wrong Python loses CUDA).
      try {
        const shortPy = String((py[0] || 'python').split(/[\\/]/).pop() || 'python');
        const instrOn = String(instruction || '').trim().length > 0;
        onLog?.(`Engine: --attn ${attnArg} (same math, faster kernels), CUDA-graph fast path ${wantFast ? `ON${memGB ? ` — ${memGB} GB VRAM` : ''}` : 'off'}, Python ${shortPy}${memGB ? ` (${memGB} GB VRAM)` : ''}.\n`);
        onLog?.(`Job: ${t.length} chars, seed ${seedNum}, voice ${refAudioDataUrl ? 'cloned from reference clip' : 'generic (no reference clip)'}, instruction ${instrOn ? 'ON (~2x tokens: every step runs guided + unguided — empty the Voice-direction box for max speed)' : 'off'}.\n`);
      } catch { /* ignore */ }
      const run = (fastAttempt) => {
        const args = fastAttempt ? [...baseArgs, "--fast-all"] : baseArgs;
        const child = spawn(py[0], [...py.slice(1), ...args], {
          cwd: ckpt,
          env: { ...process.env, PYTHONPATH: lib + (process.env.PYTHONPATH ? sep + process.env.PYTHONPATH : "") },
        });
        try { __child?.(child); } catch { /* no listener */ }
        let logged = "";
        const emit = (c) => { const s = c.toString(); logged += s; try { onLog?.(s); } catch { /* ignore */ } };
        child.stdout?.on("data", emit);
        child.stderr?.on("data", emit);
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* ignore */ }
          finish({ ok: false, error: "TTS timed out after 10 minutes — try shorter text." });
        }, timeoutMs);
        child.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: e?.message || "Could not launch Python." }); });
        child.on("close", (code) => {
          clearTimeout(timer);
          const tail = logged.slice(-3000).trim().split("\n").slice(-4).join(" ");
          if (code !== 0 || !fs.existsSync(outWav)) {
            // A missing third-party package is the classic first-run failure —
            // name it and the fix instead of dumping the traceback.
            const modMiss = /No module named ['"]([\w.]+)['"]/.exec(logged);
            if (modMiss) {
              const pretty = { qwen_tts: "qwen-tts" }[modMiss[1]] || modMiss[1];
              finish({ ok: false, error: `${py.join(" ")} is missing the '${pretty}' package — open Settings → Text-to-Speech and hit “Install dependencies” (it targets this exact Python), then retry.` });
              return;
            }
            if (/fast streaming requires a CUDA device/i.test(logged)) {
              finish({ ok: false, error: `That Python's PyTorch has no CUDA — the runner needs an NVIDIA GPU. Open Settings → Text-to-Speech and hit “Install CUDA torch” (or pick a Python that already has it), then retry.` });
              return;
            }
            if (fastAttempt && /out of memory/i.test(logged)) {
              try { onLog?.(`CUDA-graph fast path ran out of memory — retrying stock (slower, fits anywhere).\n`); } catch { /* ignore */ }
              run(false);
              return;
            }
            finish({ ok: false, error: `BreezeTTS-2 failed (exit ${code}). ${tail || "See the server console."}` });
            return;
          }
          try {
            const buf = fs.readFileSync(outWav);
            if (buf.length > 25 * 1024 * 1024) { finish({ ok: false, error: "That narration is over 25 MB — split the text and synthesize in parts." }); return; }
            finish({ ok: true, dataUrl: `data:audio/wav;base64,${buf.toString("base64")}`, bytes: buf.length });
          } catch (e) { finish({ ok: false, error: e?.message || String(e) }); }
        });
      };
      run(wantFast);
    } catch (err) { finish({ ok: false, error: err?.message || String(err) }); }
  });
}

// Fire-and-forget progress wrapper so the UI can poll: reuse the shared
// download machinery in models.mjs via dynamic import (avoids a cycle).
export async function startTtsDownload({ url, file, dir, sizeBytes }) {
  const { startDownload } = await import("./models.mjs");
  return startDownload({ url, file, dir, sizeBytes: sizeBytes || 0, label: file, kind: "tts" });
}

// ---- Checkpoint layout: official (transformers-loadable) vs mirrors ----
export function scanCheckpoint(dir) {
  let names = [];
  try {
    if (!dir || !fs.statSync(dir).isDirectory()) return { path: dir || "", layout: "missing", weightFiles: [] };
    names = fs.readdirSync(dir);
  } catch { return { path: dir || "", layout: "missing", weightFiles: [] }; }
  const has = (n) => names.includes(n);
  const shards = names.filter((n) => /^model-\d+-of-\d+\.safetensors$/i.test(n));
  const anyWeights = names.filter((n) => /\.safetensors$/i.test(n));
  const official = has("config.json") && (has("model.safetensors") || (has("model.safetensors.index.json") && shards.length > 0));
  return {
    path: dir,
    layout: official ? "official" : anyWeights.length ? "mirror" : "other",
    weightFiles: anyWeights,
    hasAudioTokenizer: names.includes("audio_tokenizer"),
  };
}

// ---- Background synth jobs: start, poll, cancel ----
const synthJobs = new Map();
function pruneSynthJobs() {
  while (synthJobs.size > 10) {
    const oldest = [...synthJobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    synthJobs.delete(oldest.id);
  }
}
export function startSynthJob(args) {
  // Fast sync validation so the UI gets a plain error for trivial mistakes.
  const t = String(args?.text || "").trim();
  if (!t) return { ok: false, error: "Nothing to speak — type the narration text first." };
  const id = `tts_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const job = { id, active: true, startedAt: Date.now(), log: [], error: "", done: false, dataUrl: "", bytes: 0, child: null };
  // Console spam (missing-SoX notice, triton/glog warnings) would drown
  // the progress view — collapse the known-benign lines to one note.
  const BENIGN = [/proceed here/i, /^\s*- - -.*- - -\s*$/, /path variables/i, /triton/i, /flop_counter/i, /^[WI]\d{4} /, /operable program or batch file/i];
  let soxNoted = false;
  const pushLog = (s) => {
    for (const line of String(s).split(/\r?\n/)) {
      const clean = line.trim().slice(0, 220);
      if (!clean) continue;
      if (/sox/i.test(clean)) {
        if (!soxNoted) { soxNoted = true; job.log.push("Note: SoX not found (optional — only affects some reference-audio formats)."); }
        continue;
      }
      if (BENIGN.some((re) => re.test(clean))) continue;
      job.log.push(clean);
    }
    if (job.log.length > 40) job.log = job.log.slice(-40);
  };
  synthJobs.set(id, job);
  pruneSynthJobs();
  pushLog("Starting BreezeTTS-2 (first run loads the 3B model — allow minutes)…");
  synthTts({
    ...args,
    onLog: pushLog,
    __child: (c) => { job.child = c; },
  }).then((out) => {
    job.active = false;
    if (out.ok) { job.done = true; job.dataUrl = out.dataUrl; job.bytes = out.bytes || 0; pushLog(`Done — ${Math.round(job.bytes / 1024)} KB of narration.`); }
    else { job.error = out.error; pushLog(`Failed: ${out.error}`); }
    job.child = null;
  });
  return { ok: true, id };
}
export function synthJobState(id) {
  const j = synthJobs.get(String(id));
  if (!j) return { ok: false, error: "Unknown synthesis job." };
  return {
    ok: true, id: j.id, state: j.done ? "done" : j.error ? "error" : "running",
    elapsedSec: Math.round((Date.now() - j.startedAt) / 1000),
    logTail: j.log.slice(-8), error: j.error || undefined,
    ...(j.done ? { dataUrl: j.dataUrl, bytes: j.bytes } : {}),
  };
}
export function cancelSynthJob(id) {
  const j = synthJobs.get(String(id));
  if (!j || !j.active) return { ok: false, error: "That job isn't running." };
  try { j.child?.kill(); } catch { /* ignore */ }
  j.active = false;
  j.error = "Cancelled.";
  j.child = null;
  return { ok: true };
}

// ---- Official checkpoint download (proper subpaths, skipped if present) ----
const ckptJob = { active: false, repo: "", dest: "", files: [], idx: 0, file: "", received: 0, fileSize: 0, doneBytes: 0, totalBytes: 0, error: "", done: false, log: [] };
export function ckptJobState() {
  return {
    ...ckptJob,
    log: ckptJob.log.slice(-8),
    pct: ckptJob.totalBytes > 0 ? Math.min(99, Math.round(((ckptJob.doneBytes + ckptJob.received) / ckptJob.totalBytes) * 100)) : null,
  };
}
function ckptLog(msg) {
  ckptJob.log.push(String(msg).slice(0, 200));
  if (ckptJob.log.length > 40) ckptJob.log = ckptJob.log.slice(-40);
}
function hfGet(target, headers = {}) {
  return new Promise((resolve, reject) => {
    const doGet = (u, left) => {
      let req;
      try {
        req = https.get(u, { headers: { "User-Agent": "VectorStudio/1.0", ...headers } }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && left > 0) {
            res.resume();
            doGet(new URL(res.headers.location, u).toString(), left - 1);
            return;
          }
          resolve(res);
        });
      } catch (e) { reject(e); return; }
      req.on("error", reject);
      req.setTimeout(30000, () => { req.destroy(new Error("Timed out reaching Hugging Face.")); });
    };
    doGet(target, 5);
  });
}
function readJson(res) {
  return new Promise((resolve, reject) => {
    if (res.statusCode !== 200) { res.resume(); reject(new Error(`Hugging Face answered HTTP ${res.statusCode}.`)); return; }
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(new Error("Could not parse the Hugging Face reply.")); }
    });
    res.on("error", reject);
  });
}
export async function startCheckpointDownload(root, repo) {
  const id = String(repo || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(id)) return { ok: false, error: "Use owner/name, e.g. BreezeBlue/Breeze-TTS-2." };
  if (ckptJob.active) return { ok: true, already: true };
  let meta;
  try {
    const res = await hfGet(`https://huggingface.co/api/models/${id}`);
    meta = await readJson(res);
  } catch (e) { return { ok: false, error: e?.message || String(e) }; }
  const files = (meta.siblings || [])
    .map((s) => s.rfilename)
    .filter((n) => /\.(safetensors|json)$/i.test(n) && !/^assets\//i.test(n) && !/\.md$/i.test(n));
  if (!files.length) return { ok: false, error: "No downloadable weights found in that repo." };
  const short = id.split("/")[1];
  const ttsDir = (() => { try { return loadSettings().ttsDir; } catch { return null; } })() || defaultTtsDir(root);
  const dest = path.join(ttsDir, short);
  Object.assign(ckptJob, { active: true, repo: id, dest, files, idx: 0, file: "", received: 0, fileSize: 0, doneBytes: 0, totalBytes: 0, error: "", done: false, log: [] });
  ckptLog(`Downloading ${files.length} files → ${dest}`);
  runCheckpointQueue().catch((e) => { ckptJob.active = false; ckptJob.error = e?.message || String(e); });
  return { ok: true, started: true };
}
async function runCheckpointQueue() {
  while (ckptJob.idx < ckptJob.files.length) {
    const rel = ckptJob.files[ckptJob.idx];
    const dest = path.join(ckptJob.dest, rel);
    ckptJob.file = rel;
    ckptJob.received = 0;
    ckptJob.fileSize = 0;
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* ignore */ }
    // Skip finished files so a retry resumes where it stopped.
    let skip = false;
    try { skip = fs.statSync(dest).size > 1024; } catch { /* missing */ }
    if (skip) {
      try { ckptJob.doneBytes += fs.statSync(dest).size; } catch { /* ignore */ }
      ckptLog(`✓ ${rel} (already here)`);
      ckptJob.idx++;
      continue;
    }
    // Fresh download per file into a staging temp, then copied into place:
    // no half-written files in the library, no in-place rename quirks, and
    // finished files are skipped so a retry resumes at the next file.
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "vsckpt-"));
    try {
      const staging = path.join(stagingDir, "file.bin");
      const res = await hfGet(`https://huggingface.co/${ckptJob.repo}/resolve/main/${rel}`);
      if (res.statusCode !== 200) { res.resume(); throw new Error(`HTTP ${res.statusCode} for ${rel}`); }
      const total = Number(res.headers["content-length"] || 0);
      ckptJob.fileSize = total;
      ckptJob.totalBytes += total;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(staging);
        ckptJob.received = 0;
        res.on("data", (c) => { ckptJob.received += c.length; });
        out.on("finish", resolve); // flushed to disk, not just handed over
        out.on("error", (e) => { try { res.destroy(); } catch { /* ignore */ } reject(e); });
        res.on("error", reject);
        res.pipe(out);
      });
      const got = (() => { try { return fs.statSync(staging).size; } catch { return -1; } })();
      if (total > 0 && got !== total) throw new Error(`incomplete download for ${rel} (got ${got} of ${total} bytes) — just retry`);
      if (got <= 0) throw new Error(`empty download for ${rel} — just retry`);
      try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* ignore */ }
      try { fs.copyFileSync(staging, dest); }
      catch (e) { throw new Error(`Could not save ${rel}: ${e.message} (destination ${dest})`); }
    } finally {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    try { fs.rmSync(`${dest}.part`); } catch { /* stale partial from older builds */ }
    try { ckptJob.doneBytes += fs.statSync(dest).size; } catch { /* ignore */ }
    ckptLog(`✓ ${rel}`);
    ckptJob.idx++;
  }
  ckptJob.active = false;
  ckptJob.done = true;
  ckptJob.file = "";
  ckptLog("Checkpoint complete — pick it in the Checkpoint dropdown above.");
}
