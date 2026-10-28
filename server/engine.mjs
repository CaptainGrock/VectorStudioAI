// Getting llama-server onto the machine and keeping it serving the chosen GGUF.
// Adapted from JobKing's server/llamaengine.js + the runner in server/llm.js:
// same release lookup (newest bNNNN build, never "latest"), same flavour
// matching (CUDA/Vulkan/CPU with driver guard), same tar-first extraction,
// same spawn flags (--jinja, full GPU offload).
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listDownloads, startDownload } from "./models.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASES_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases";
const RELEASE_TTL_MS = 60 * 60 * 1000;
const SERVER_NAMES = process.platform === "win32" ? ["llama-server.exe"] : ["llama-server"];

export const LLAMA_PORT = Number(process.env.VS_LLAMA_PORT) || 8123;
export const CTX_SIZE = 8192;

let releaseCache = { at: 0, tag: "", assets: [], error: "" };
let install = { active: false, state: "idle", optionId: "", label: "", tag: "", dir: "", step: "", error: "", result: null, startedAt: "", finishedAt: "" };
export const runner = { child: null, model: "", modelPath: "", startedAt: "", lastError: "", logPath: "", logTail: "" };
const idleInstall = () => ({ active: false, state: "idle", optionId: "", label: "", tag: "", dir: "", step: "", error: "", result: null, startedAt: "", finishedAt: "" });
export function engineInstallState() {
  return { ...install };
}

export async function latestRelease({ force = false } = {}) {
  if (!force && releaseCache.assets.length && Date.now() - releaseCache.at < RELEASE_TTL_MS) return releaseCache;
  const entry = { at: Date.now(), tag: "", assets: [], error: "" };
  try {
    const res = await fetch(`${RELEASES_API}?per_page=10`, { headers: { "user-agent": "vectorstudio-local-setup" }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) entry.error = `GitHub answered HTTP ${res.status}.`;
    else {
      const releases = await res.json();
      const build = (Array.isArray(releases) ? releases : []).find((item) => /^b\d+$/.test(String(item.tag_name || "")));
      if (!build) entry.error = "No llama.cpp build release was found.";
      else {
        entry.tag = build.tag_name;
        entry.assets = (build.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }));
      }
    }
  } catch (err) {
    entry.error = err?.name === "TimeoutError" ? "GitHub did not answer in time." : "No connection to GitHub.";
  }
  releaseCache = entry;
  return entry;
}

export function engineFlavours({ platform = process.platform, arch = process.arch } = {}) {
  const bits = arch === "arm64" ? "arm64" : "x64";
  if (platform === "win32") {
    return [
      { id: "cuda", label: "GPU build (CUDA 13)", note: "Runs the model on your NVIDIA card, with the CUDA runtime it needs.", build: `bin-win-cuda-13.4-${bits}.zip`, lib: `cudart-llama-bin-win-cuda-13.4-x64.zip`, minDriver: 580 },
      { id: "cuda", label: "GPU build (CUDA 12)", note: "Runs the model on your NVIDIA card. Use this if the newer build will not start.", build: `bin-win-cuda-12.4-${bits}.zip`, lib: "cudart-llama-bin-win-cuda-12.4-x64.zip", minDriver: 0 },
      { id: "vulkan", label: "GPU build (Vulkan)", note: "Uses your graphics card through Vulkan. Works with most AMD and Intel drivers.", build: `bin-win-vulkan-${bits}.zip` },
      { id: "cpu", label: "Processor-only build", note: "Always works and is a small download. Slower than a graphics card.", build: `bin-win-cpu-${bits}.zip` },
    ];
  }
  if (platform === "darwin") {
    return [{ id: "cpu", label: "Metal build (Apple GPU)", note: "Runs on the Apple GPU through Metal.", build: `bin-macos-${arch === "arm64" ? "arm64" : "x64"}.tar.gz` }];
  }
  return [
    ...(bits === "x64" ? [{ id: "cuda", label: "GPU build (CUDA 12)", note: "Runs the model on your NVIDIA card, with the CUDA runtime it needs.", build: "bin-ubuntu-cuda-12.8-x64.tar.gz", lib: "cudart-llama-bin-ubuntu-cuda-12.8-x64.tar.gz", minDriver: 0 }] : []),
    { id: "cpu", label: "Processor-only build", note: "Always works. Slower than a graphics card.", build: `bin-ubuntu-${bits}.tar.gz` },
  ];
}
const findAsset = (assets, suffix, prefix = "llama-") => assets.find((a) => a.name.startsWith(prefix) && a.name.endsWith(suffix)) || null;
const mbOf = (assets) => Math.round(assets.reduce((s, a) => s + (a.size || 0), 0) / 1e6);

export async function engineOptions({ hardware = {}, online = true } = {}) {
  const release = online ? await latestRelease() : { tag: "", assets: [], error: "" };
  const flavours = engineFlavours({ platform: hardware.platform || process.platform, arch: hardware.arch || process.arch });
  const assets = release.assets;
  const vendor = hardware.gpus?.[0]?.vendor || "";
  const driverMajor = Number(String(hardware.gpus?.[0]?.driver || "").split(".")[0]) || 0;
  const options = [];
  for (const flavour of flavours) {
    if (flavour.id === "cuda" && vendor !== "nvidia") continue;
    if (flavour.id === "vulkan" && vendor !== "amd" && vendor !== "intel") continue;
    if (flavour.minDriver && driverMajor && driverMajor < flavour.minDriver) continue;
    const build = findAsset(assets, flavour.build);
    const lib = flavour.lib ? findAsset(assets, flavour.lib, "cudart-llama-") : null;
    const wanted = [build, lib].filter(Boolean);
    if (!wanted.length || !wanted.every((a) => a.url)) continue;
    options.push({ id: flavour.id, label: flavour.label, note: flavour.note, tag: release.tag, totalMB: mbOf(wanted), files: wanted.map((a) => a.name), assets: wanted });
  }
  const want = vendor === "nvidia" ? "cuda" : vendor ? "vulkan" : "cpu";
  const chosen = options.findIndex((o) => o.id === want);
  return { tag: release.tag, error: release.error, options: options.map((o, i) => ({ ...o, recommended: i === (chosen >= 0 ? chosen : 0) })), dir: path.join(ROOT, "llama.cpp", release.tag || "engine") };
}

export function findExistingRunner({ runnerPath = "" } = {}) {
  const candidates = [];
  const add = (c) => {
    if (!c) return;
    const full = path.resolve(String(c));
    if (!candidates.some((e) => e.toLowerCase() === full.toLowerCase())) candidates.push(full);
  };
  add(runnerPath);
  for (const name of SERVER_NAMES) {
    add(path.join(ROOT, "llama.cpp", name));
    add(path.join(ROOT, name));
  }
  try {
    const base = path.join(ROOT, "llama.cpp");
    if (fs.existsSync(base)) {
      for (const entry of fs.readdirSync(base, { withFileTypes: true }).filter((i) => i.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
        for (const name of SERVER_NAMES) add(path.join(base, entry.name, name));
      }
    }
  } catch { /* unreadable */ }
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home) {
    add(path.join(home, "llama.cpp", SERVER_NAMES[0]));
    add(path.join(home, ".local", "bin", SERVER_NAMES[0]));
    add(path.join(home, "AppData", "Local", "Programs", "llama.cpp", SERVER_NAMES[0]));
  }
  if (process.platform === "win32") {
    add(path.join("C:\\Stable\\LMRunner", "llama.cpp", "llama-server.exe"));
    add(path.join("C:\\llama.cpp", "llama-server.exe"));
    add(path.join("C:\\pinokio\\bin\\miniforge", "llama-server.exe"));
  }
  return candidates.find((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  }) || "";
}

export function locateServer(dir, depth = 0) {
  if (!dir || depth > 4) return "";
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && SERVER_NAMES.includes(entry.name)) return full;
    if (entry.isDirectory()) {
      const found = locateServer(full, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

function runCmd(command, args, { timeout = 300000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: `${command} took longer than ${Math.round(timeout / 1000)}s.` });
    }, timeout);
    child.stdout?.on("data", (c) => (output += c));
    child.stderr?.on("data", (c) => (output += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, error: code === 0 ? "" : output.trim().slice(-400) || `exit code ${code}` });
    });
  });
}

export async function extractArchive(archive, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const zip = /\.zip$/i.test(archive);
  const flags = zip ? ["-xf"] : ["-xzf"];
  const first = await runCmd("tar", [...flags, archive, "-C", dir]);
  if (first.ok) return { ok: true };
  if (/cannot connect to|resolve failed/i.test(first.error)) {
    const local = await runCmd("tar", [...flags, archive, "-C", dir, "--force-local"]);
    if (local.ok) return { ok: true };
    return { ok: false, error: local.error };
  }
  if (zip) {
    const fallback = await runCmd("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`]);
    if (fallback.ok) return { ok: true };
    return { ok: false, error: fallback.error || first.error };
  }
  return { ok: false, error: first.error };
}

async function waitForDownload(id, { timeoutMs = 60 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = listDownloads().find((i) => i.id === id);
    if (!entry) return { ok: false, error: "The download disappeared." };
    if (entry.state === "done") return { ok: true, path: entry.path };
    if (entry.state === "error" || entry.state === "cancelled") return { ok: false, error: entry.error || "The download was cancelled." };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, error: "The download did not finish in an hour." };
}

export function startEngineInstall({ option, dir, onBinary }) {
  if (install.active) return { ok: false, error: "An engine download is already running." };
  if (!option?.assets?.length) return { ok: false, error: "No build matched this machine." };
  const target = dir || path.join(ROOT, "llama.cpp", option.tag || "engine");
  install = { ...idleInstall(), active: true, state: "downloading", optionId: option.id, label: option.label, tag: option.tag, dir: target, step: `Downloading ${option.assets.length} file(s)…`, startedAt: new Date().toISOString() };
  (async () => {
    try {
      const files = [];
      for (const asset of option.assets) {
        install.step = `Downloading ${asset.name} (${Math.round((asset.size || 0) / 1e6)} MB)…`;
        const started = startDownload({ url: asset.url, file: path.basename(asset.name), dir: path.join(target, "downloads"), sizeBytes: asset.size, label: asset.name, kind: "engine" });
        if (!started.ok) throw new Error(started.error);
        if (started.done) {
          files.push(started.path);
          continue;
        }
        const finished = await waitForDownload(started.id);
        if (!finished.ok) throw new Error(finished.error);
        files.push(finished.path);
      }
      install.state = "extracting";
      for (const file of files) {
        install.step = `Unpacking ${path.basename(file)}…`;
        const result = await extractArchive(file, target);
        if (!result.ok) throw new Error(`Could not unpack ${path.basename(file)}: ${result.error}`);
      }
      const server = locateServer(target);
      if (!server) throw new Error("The download unpacked, but no llama-server was found inside it.");
      onBinary?.(server);
      install.state = "done";
      install.step = "";
      install.result = { path: server, dir: target };
    } catch (err) {
      install.state = "error";
      install.error = err?.message || String(err);
      install.step = "";
    } finally {
      install.active = false;
      install.finishedAt = new Date().toISOString();
    }
  })();
  return { ok: true, state: engineInstallState() };
}

// ---------- runner ----------
function apiBase() {
  return `http://127.0.0.1:${LLAMA_PORT}/v1`;
}
async function waitReady(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiBase()}/models`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return { ok: true };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err?.message || String(err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, error: lastError || "llama-server did not answer." };
}
export function runnerStatus() {
  return { running: Boolean(runner.child && !runner.child.killed), pid: runner.child?.pid || null, model: runner.model, modelPath: runner.modelPath, startedAt: runner.startedAt, lastError: runner.lastError, logTail: runner.logTail };
}
export function stopRunner() {
  const child = runner.child;
  runner.child = null;
  runner.model = "";
  runner.modelPath = "";
  if (!child) return { ok: true, stopped: false };
  try {
    if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill();
  } catch { /* already gone */ }
  return { ok: true, stopped: true };
}
export async function startRunner({ exe, modelPath, ctxSize = CTX_SIZE } = {}) {
  if (!exe) return { ok: false, error: "No llama-server binary. Install the engine first." };
  if (!modelPath) return { ok: false, error: "Pick a model file first." };
  try {
    if (!fs.statSync(modelPath).isFile()) return { ok: false, error: `That model file is not there: ${modelPath}` };
  } catch {
    return { ok: false, error: `That model file is not there: ${modelPath}` };
  }
  stopRunner();
  runner.lastError = "";
  runner.logTail = "";
  const args = ["--model", modelPath, "--host", "127.0.0.1", "--port", String(LLAMA_PORT), "--ctx-size", String(ctxSize || CTX_SIZE), "--n-gpu-layers", "999", "--jinja"];
  let child;
  try {
    child = spawn(exe, args, { cwd: path.dirname(exe), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  runner.child = child;
  runner.model = path.basename(modelPath);
  runner.modelPath = modelPath;
  runner.startedAt = new Date().toISOString();
  let output = "";
  const collect = (chunk) => {
    output += String(chunk);
    if (output.length > 6000) output = output.slice(-6000);
    runner.logTail = output.slice(-1500);
    if (/error|failed|invalid/i.test(String(chunk))) runner.lastError = String(chunk).trim().slice(-300);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (err) => {
    runner.lastError = err.message;
    runner.logTail = (runner.logTail + "\n" + err.message).slice(-1500);
  });
  const ready = await waitReady();
  if (!ready.ok) {
    const tail = runner.logTail || runner.lastError;
    stopRunner();
    return { ok: false, error: `llama-server did not answer: ${ready.error}`, logTail: tail };
  }
  return { ok: true, model: runner.model, path: modelPath };
}
export async function loadedModels() {
  try {
    const res = await fetch(`${apiBase()}/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || data.models || []).map((m) => m.id || m.model || m.path).filter(Boolean);
  } catch {
    return [];
  }
}
/** Chat via the managed engine. Tries JSON schema mode, falls back to plain. */
export async function engineChat({ messages, timeoutMs = 300000 } = {}) {
  const payload = (extra) => ({
    model: runner.model || "model",
    messages,
    temperature: 0.3,
    max_tokens: 4000,
    stream: false,
    ...extra,
  });
  const post = async (body) => {
    const res = await fetch(`${apiBase()}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const err = new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
  let data;
  try {
    data = await post(payload({ response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema: { type: "object" } } }, chat_template_kwargs: { enable_thinking: false } }));
  } catch (err) {
    if (err?.status >= 400 && err?.status < 500) data = await post(payload());
    else throw err;
  }
  const choice = data.choices?.[0];
  return { text: String(choice?.message?.content ?? choice?.text ?? "").replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim(), usage: data.usage || null, model: runner.model };
}
