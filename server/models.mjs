// "Do I already have a model?" + "what fits this video card?" + honest downloads.
// Adapted from JobKing's server/modelscan.js, modelcatalog.js, modeldownload.js:
// same bounded disk walk, same quant-preference + fit-verdict logic, same
// resumable .part downloads. Curated for short structured-JSON scene output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { diskFreeGB } from "./hardware.mjs";

// ---------- settings (tiny JSON file, no DB) ----------
const SETTINGS_PATH = new URL("./settings.json", import.meta.url);
export function loadSettings() {
  try {
    return { modelDir: "", lastModel: "", runnerPath: "", ...JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) };
  } catch {
    return { modelDir: "", lastModel: "", runnerPath: "" };
  }
}
export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  } catch { /* read-only dir: settings just don't persist */ }
  return next;
}
export function defaultModelDir(root) {
  return loadSettings().modelDir || path.join(root, "models");
}

// ---------- disk scan ----------
const MAX_DEPTH = 6;
const MAX_ENTRIES = 250000;
const MAX_FOUND = 200;
const MIN_SIZE = 80 * 1024 * 1024;
const DEFAULT_BUDGET_MS = 90000;
const SKIP_DIRS = new Set(
  ["windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information",
    "recovery", "perflogs", "node_modules", ".git", ".vscode", "temp", "tmp", "dist", "appdata"].map((n) => n.toLowerCase())
);

let scan = { active: false, startedAt: "", finishedAt: "", visited: 0, found: [], roots: [], cancelled: false, budgetMs: DEFAULT_BUDGET_MS, timedOut: false, error: "" };
export function scanState() {
  return { ...scan, found: scan.found.map((f) => ({ ...f })) };
}
export function cancelModelScan() {
  if (scan.active) scan.cancelled = true;
  return scanState();
}
export function scanRoots({ modelDir = "", extra = [], drives = true } = {}) {
  const roots = [];
  const add = (candidate) => {
    const full = String(candidate || "").trim();
    if (!full) return;
    if (roots.some((r) => full.toLowerCase() === r.toLowerCase())) return;
    try {
      if (fs.existsSync(full)) roots.push(path.resolve(full));
    } catch { /* unreadable: skip */ }
  };
  add(modelDir);
  const home = os.homedir();
  for (const name of ["Downloads", "Documents", "Desktop", "models", "Models"]) add(path.join(home, name));
  for (const name of [".cache/lm-studio/models", ".lmstudio/models", ".cache/huggingface/hub", ".cache/llama.cpp", "AppData/Local/Ollama"]) {
    add(path.join(home, ...name.split("/")));
  }
  for (const r of extra) add(r);
  if (process.platform === "win32" && drives) {
    for (const letter of ["c", "d", "e", "f", "g", "h"]) {
      try {
        const root = `${letter.toUpperCase()}:\\`;
        if (fs.existsSync(root)) roots.push(root);
      } catch { /* missing drive */ }
    }
  } else {
    add("/models");
    add("/opt/models");
  }
  return roots;
}
const skipped = (name) => {
  const lower = name.toLowerCase();
  if (SKIP_DIRS.has(lower)) return true;
  return name.startsWith("$") || lower.startsWith(".");
};
function record(filePath, size) {
  if (scan.found.length >= MAX_FOUND) return;
  if (scan.found.some((e) => e.path === filePath)) return;
  const quant = (path.basename(filePath).match(/(Q\d[_A-Z0-9]*|IQ\d[_A-Z0-9]*|F16|FP16|BF16)/i) || [])[1] || "";
  let modifiedAt = "";
  try {
    modifiedAt = fs.statSync(filePath).mtime.toISOString();
  } catch { /* vanished */ }
  scan.found.push({ path: filePath, fileName: path.basename(filePath), dir: path.dirname(filePath), sizeGB: Math.round((size / 1073741824) * 100) / 100, quant: quant.toUpperCase(), modifiedAt });
}
async function walk(dir, depth, deadline) {
  if (scan.cancelled || Date.now() > deadline || scan.visited > MAX_ENTRIES) return;
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return; // permission denied etc: skip
  }
  for (const entry of entries) {
    if (scan.cancelled || Date.now() > deadline || scan.visited > MAX_ENTRIES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth >= MAX_DEPTH || skipped(entry.name)) continue;
      await walk(full, depth + 1, deadline);
      continue;
    }
    if (!entry.isFile()) continue;
    scan.visited += 1;
    if (!/\.gguf$/i.test(entry.name)) continue;
    try {
      const stat = await fs.promises.stat(full);
      if (stat.size >= MIN_SIZE) record(full, stat.size);
    } catch { /* vanished mid-scan */ }
  }
}
export function startModelScan({ modelDir = "", budgetMs = DEFAULT_BUDGET_MS, extraRoots = [], drives = true } = {}) {
  if (scan.active) return { ok: true, started: false, state: scanState() };
  const roots = scanRoots({ modelDir, extra: extraRoots, drives });
  const deadline = Date.now() + Math.max(5000, Number(budgetMs) || DEFAULT_BUDGET_MS);
  scan = { ...scan, active: true, startedAt: new Date().toISOString(), finishedAt: "", visited: 0, found: [], roots, cancelled: false, budgetMs: Number(budgetMs) || DEFAULT_BUDGET_MS, timedOut: false, error: "" };
  (async () => {
    try {
      for (const root of roots) {
        if (scan.cancelled || Date.now() > deadline) break;
        await walk(root, 0, deadline);
      }
      scan.timedOut = !scan.cancelled && Date.now() > deadline;
    } catch (err) {
      scan.error = err?.message || String(err);
    } finally {
      scan.active = false;
      scan.finishedAt = new Date().toISOString();
      scan.found.sort((a, b) => b.sizeGB - a.sizeGB);
    }
  })();
  return { ok: true, started: true, state: scanState() };
}
/** GGUFs already inside the app's own model folder. */
export function localModels(modelDir) {
  const out = [];
  try {
    if (!fs.existsSync(modelDir)) return out;
    for (const name of fs.readdirSync(modelDir)) {
      if (!/\.gguf$/i.test(name)) continue;
      const full = path.join(modelDir, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile() || stat.size < MIN_SIZE) continue;
        const quant = (name.match(/(Q\d[_A-Z0-9]*|IQ\d[_A-Z0-9]*|F16|FP16|BF16)/i) || [])[1] || "";
        out.push({ path: full, fileName: name, dir: modelDir, sizeGB: Math.round((stat.size / 1073741824) * 100) / 100, quant: quant.toUpperCase(), launchable: true });
      } catch { /* skip */ }
    }
  } catch { /* unreadable */ }
  return out.sort((a, b) => b.sizeGB - a.sizeGB);
}

// ---------- fit-aware catalog ----------
const HF_API = "https://huggingface.co/api/models";
const TREE_TTL_MS = 6 * 60 * 60 * 1000;
const treeCache = new Map();
const PREFERRED_QUANTS = ["Q4_K_M", "Q4_K_S", "IQ4_XS", "Q4_0", "Q5_K_M", "Q5_K_S", "Q3_K_M"];

export const CATALOG = [
  { id: "qwen2.5-3b", label: "Qwen2.5 3B Instruct", paramsB: 3, score: 78, repo: "bartowski/Qwen2.5-3B-Instruct-GGUF", license: "Apache-2.0", approxGB: 1.93, why: "Small enough for a 6 GB card or a CPU-only laptop, still steady with short JSON." },
  { id: "llama-3.2-3b", label: "Llama 3.2 3B Instruct", paramsB: 3, score: 74, repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", license: "Llama Community License", approxGB: 2.02, why: "The other good tiny option for quick scene drafts." },
  { id: "mistral-7b", label: "Mistral 7B Instruct v0.3", paramsB: 7, score: 84, repo: "bartowski/mistral-7b-instruct-v0.3-GGUF", license: "Apache-2.0", approxGB: 4.37, why: "Comfortable on an 8 GB card with room for a long scene." },
  { id: "qwen2.5-7b", label: "Qwen2.5 7B Instruct", paramsB: 7, score: 90, repo: "bartowski/Qwen2.5-7B-Instruct-GGUF", license: "Apache-2.0", approxGB: 4.68, why: "Best all-rounder: strong JSON discipline at a size an 8 GB card handles." },
  { id: "llama-3.1-8b", label: "Llama 3.1 8B Instruct", paramsB: 8, score: 86, repo: "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF", license: "Llama Community License", approxGB: 4.92, why: "Very steady at following long instructions." },
  { id: "gemma-2-9b", label: "Gemma 2 9B Instruct", paramsB: 9, score: 85, repo: "bartowski/gemma-2-9b-it-GGUF", license: "Gemma Terms of Use", approxGB: 5.76, why: "Wants a 10 GB card to stay comfortable." },
  { id: "qwen2.5-7b-reasoning", label: "DeepSeek-R1 Distill Qwen 7B", paramsB: 7, score: 75, repo: "unsloth/DeepSeek-R1-Distill-Qwen-7B-GGUF", license: "MIT", approxGB: 4.68, why: "Thinks before answering. Slower — only worth it for tricky edits." },
  { id: "mistral-nemo-12b", label: "Mistral Nemo 12B Instruct", paramsB: 12, score: 88, repo: "bartowski/Mistral-Nemo-Instruct-2407-GGUF", license: "Apache-2.0", approxGB: 7.07, why: "A step up in judgement on a 12 GB card." },
  { id: "qwen2.5-14b", label: "Qwen2.5 14B Instruct", paramsB: 14, score: 92, repo: "bartowski/Qwen2.5-14B-Instruct-GGUF", license: "Apache-2.0", approxGB: 8.99, why: "Strongest model that fits a 12 GB card." },
  { id: "phi-4-14b", label: "Phi-4 14B", paramsB: 14, score: 87, repo: "bartowski/phi-4-GGUF", license: "MIT", approxGB: 9.05, why: "Sharp reasoning for its size." },
  { id: "qwen2.5-32b", label: "Qwen2.5 32B Instruct", paramsB: 32, score: 94, repo: "bartowski/Qwen2.5-32B-Instruct-GGUF", license: "Apache-2.0", approxGB: 19.8, why: "Best local quality, for a 24 GB card. Slow to load." },
];

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

export function estimateRequiredGB(sizeGB, paramsB = 7, ctxSize = 8192) {
  const weights = Number(sizeGB) || 0;
  const context = (Math.max(2048, Number(ctxSize) || 8192) / 8192) * (0.35 + (Number(paramsB) || 7) * 0.02);
  return round1(weights * 1.03 + context + 0.5);
}
export function fitVerdict(requiredGB, budgetGB, ramGB = 0) {
  if (!requiredGB) return "unknown";
  if (!budgetGB) return ramGB && requiredGB <= ramGB * 0.6 ? "cpu" : "unknown";
  if (requiredGB <= budgetGB * 0.92) return "great";
  if (requiredGB <= budgetGB * 1.05) return "tight";
  if (ramGB && requiredGB <= Number(ramGB) * 0.6) return "cpu";
  return "huge";
}
export function pickQuantFile(files = []) {
  const usable = files.filter((f) => f?.type === "file" && /\.gguf$/i.test(f.path || "") && !/-\d{5}-of-\d{5}\.gguf$/i.test(f.path));
  for (const quant of PREFERRED_QUANTS) {
    const matches = usable.filter((f) => new RegExp(`[-_]${quant}([-_.]|$)`, "i").test(f.path));
    if (!matches.length) continue;
    const exact = matches.filter((f) => new RegExp(`[-_]${quant}\\.gguf$`, "i").test(f.path));
    const pool = exact.length ? exact : matches;
    const chosen = [...pool].sort((a, b) => a.path.length - b.path.length || (b.size || 0) - (a.size || 0))[0];
    return { ...chosen, quant };
  }
  return null;
}
function hfHeaders() {
  const h = { "user-agent": "vectorstudio-local-setup" };
  if (process.env.HF_TOKEN) h.authorization = `Bearer ${process.env.HF_TOKEN}`;
  return h;
}
export async function repoFiles(repo, { force = false } = {}) {
  const cached = treeCache.get(repo);
  if (!force && cached && Date.now() - cached.at < TREE_TTL_MS) return cached;
  const entry = { at: Date.now(), files: [], error: "" };
  try {
    const res = await fetch(`${HF_API}/${repo}/tree/main`, { headers: hfHeaders(), signal: AbortSignal.timeout(20000) });
    if (res.status === 401 || res.status === 403) entry.error = "That model needs its licence accepted on Hugging Face first.";
    else if (res.status === 404) entry.error = "That model repository is no longer published.";
    else if (!res.ok) entry.error = `Hugging Face answered HTTP ${res.status}.`;
    else {
      const body = await res.json();
      entry.files = Array.isArray(body) ? body : [];
    }
  } catch (err) {
    entry.error = err?.name === "TimeoutError" ? "Hugging Face did not answer in time." : "No connection to Hugging Face.";
  }
  treeCache.set(repo, entry);
  return entry;
}
export async function modelOptions({ budgetGB = 0, ctxSize = 8192, ramGB = 0, diskFreeGB: diskFree = null, online = true } = {}) {
  const options = [];
  for (const entry of CATALOG) {
    const listing = online ? await repoFiles(entry.repo) : { files: [], error: "", at: 0 };
    const picked = listing.files.length ? pickQuantFile(listing.files) : null;
    const bytes = picked?.size || Math.round(entry.approxGB * 1e9);
    const sizeGB = round2(bytes / 1e9);
    const requiredGB = estimateRequiredGB(sizeGB, entry.paramsB, ctxSize);
    const verdict = fitVerdict(requiredGB, budgetGB, ramGB);
    options.push({
      id: entry.id, label: entry.label, paramsB: entry.paramsB, score: entry.score, repo: entry.repo,
      page: `https://huggingface.co/${entry.repo}`, license: entry.license, why: entry.why,
      sizeGB, bytes, requiredGB, verdict,
      file: picked?.path || "",
      url: picked ? `https://huggingface.co/${entry.repo}/resolve/main/${picked.path.split("/").map(encodeURIComponent).join("/")}` : "",
      sizeKnown: Boolean(picked && picked.size),
      blocked: !picked ? listing.error || "The file list for this model could not be read." : "",
      diskOk: diskFree == null || !picked ? null : diskFree > sizeGB * 1.1,
    });
  }
  const fits = options.filter((o) => o.verdict === "great" && !o.blocked);
  const recommended = [...fits].sort((a, b) => b.score - a.score || a.requiredGB - b.requiredGB)[0]?.id || "";
  return options.map((o) => ({ ...o, recommended: o.id === recommended })).sort((a, b) => a.requiredGB - b.requiredGB);
}

// ---------- resumable downloads ----------
const downloads = new Map();
let sequence = 0;
const KEEP_FINISHED = 12;
function publicView(e) {
  return { id: e.id, label: e.label, kind: e.kind, file: e.file, path: e.path, dir: e.dir, state: e.state, received: e.received, total: e.total, pct: e.total ? Math.min(100, Math.round((e.received / e.total) * 100)) : null, mbps: e.mbps, etaMs: e.etaMs, startedAt: e.startedAt, finishedAt: e.finishedAt, error: e.error, resumable: e.state === "cancelled" || e.state === "error" };
}
export function listDownloads() {
  return [...downloads.values()].map(publicView);
}
function prune() {
  const finished = [...downloads.values()].filter((e) => e.state !== "running").sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
  for (const e of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) downloads.delete(e.id);
}
export function startDownload({ url, file, dir, sizeBytes = 0, label = "", kind = "model" } = {}) {
  const target = String(dir || "").trim();
  const name = path.basename(String(file || "").trim());
  const address = String(url || "");
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(address);
  if (!/^https:\/\//i.test(address) && !loopback) return { ok: false, error: "That download address is not a secure URL." };
  if (!name) return { ok: false, error: "That download has no file name." };
  if (!target) return { ok: false, error: "Choose a folder to download into." };
  const finalPath = path.join(target, name);
  const partPath = `${finalPath}.part`;
  const expected = Number(sizeBytes) || 0;
  try {
    if (fs.existsSync(finalPath) && (!expected || fs.statSync(finalPath).size === expected)) {
      return { ok: true, done: true, path: finalPath, file: name, message: "That file is already downloaded." };
    }
  } catch { /* fall through */ }
  const running = [...downloads.values()].find((e) => e.state === "running" && e.path === finalPath);
  if (running) return { ok: true, id: running.id, file: name, alreadyRunning: true };
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    return { ok: false, error: `That folder could not be created: ${err.message}` };
  }
  const id = `dl_${Date.now().toString(36)}_${(sequence += 1)}`;
  const controller = new AbortController();
  const entry = { id, label: label || name, kind, file: name, dir: target, path: finalPath, partPath, url: address, expected, state: "running", received: 0, total: expected, mbps: null, etaMs: null, startedAt: new Date().toISOString(), finishedAt: "", error: "", controller, samples: [] };
  downloads.set(id, entry);
  prune();
  transfer(entry).catch((err) => {
    entry.state = "error";
    entry.error = err?.message || String(err);
    entry.finishedAt = new Date().toISOString();
  });
  return { ok: true, id, file: name, path: finalPath };
}
function stoppedEarly(entry) {
  return new Error(`The download stopped after ${round1(entry.received / 1e9)} GB of ${round1(entry.total / 1e9)} GB. Press Download again to resume.`);
}
async function transfer(entry) {
  let startAt = 0;
  try {
    if (fs.existsSync(entry.partPath)) startAt = fs.statSync(entry.partPath).size;
  } catch {
    startAt = 0;
  }
  if (entry.total && startAt > entry.total) startAt = 0;
  if (!startAt && entry.expected) entry.total = entry.expected;
  const headers = { "user-agent": "vectorstudio-local-setup" };
  if (startAt > 0) headers.range = `bytes=${startAt}-`;
  if (process.env.HF_TOKEN && /huggingface\.co/i.test(entry.url)) headers.authorization = `Bearer ${process.env.HF_TOKEN}`;
  const res = await fetch(entry.url, { headers, signal: entry.controller.signal });
  if (!res.ok && res.status !== 206) {
    throw new Error(res.status === 401 || res.status === 403
      ? "The host refused the download (HTTP 401/403). A gated model needs its licence accepted on Hugging Face."
      : `The download failed with HTTP ${res.status}.`);
  }
  const resumed = res.status === 206;
  if (!resumed && startAt > 0) {
    fs.rmSync(entry.partPath, { force: true });
    startAt = 0;
  }
  const length = Number(res.headers.get("content-length")) || 0;
  entry.total = length ? startAt + length : entry.expected || startAt;
  entry.received = startAt;
  const out = fs.createWriteStream(entry.partPath, { flags: resumed && startAt > 0 ? "a" : "w" });
  const body = Readable.fromWeb(res.body);
  const startedAt = Date.now();
  let lastUpdate = 0;
  body.on("data", (chunk) => {
    entry.received += chunk.length;
    const now = Date.now();
    entry.samples.push({ at: now, bytes: entry.received });
    if (entry.samples.length > 40) entry.samples.shift();
    if (now - lastUpdate < 400) return;
    lastUpdate = now;
    const oldest = entry.samples[0];
    const seconds = Math.max(0.2, (now - oldest.at) / 1000);
    const mbps = ((entry.received - oldest.bytes) / 1048576) / seconds;
    entry.mbps = mbps > 0 ? round1(mbps) : null;
    entry.etaMs = mbps > 0 && entry.total ? Math.max(0, Math.round(((entry.total - entry.received) / 1048576 / mbps) * 1000)) : null;
  });
  try {
    await new Promise((resolve, reject) => {
      body.pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
      body.on("error", reject);
      entry.controller.signal.addEventListener("abort", () => {
        body.destroy();
        out.destroy();
        reject(Object.assign(new Error("Cancelled"), { cancelled: true }));
      });
    });
  } catch (err) {
    if (err?.cancelled) {
      entry.state = "cancelled";
      entry.finishedAt = new Date().toISOString();
      entry.mbps = null;
      entry.etaMs = null;
      return;
    }
    if (entry.received > 0 && entry.total && entry.received < entry.total) throw stoppedEarly(entry);
    throw err;
  }
  if (entry.total && entry.received < entry.total) throw stoppedEarly(entry);
  fs.renameSync(entry.partPath, entry.path);
  entry.state = "done";
  entry.finishedAt = new Date().toISOString();
  entry.mbps = null;
  entry.etaMs = 0;
  entry.total = entry.received;
  entry.elapsedMs = Date.now() - startedAt;
}
export function cancelDownload(id) {
  const entry = downloads.get(String(id));
  if (!entry) return { ok: false, error: "That download is not running." };
  if (entry.state !== "running") return { ok: false, error: "That download already stopped." };
  entry.controller.abort();
  return { ok: true };
}
export function forgetDownload(id) {
  const entry = downloads.get(String(id));
  if (!entry) return { ok: false, error: "Unknown download." };
  if (entry.state === "running") return cancelDownload(id);
  downloads.delete(entry.id);
  return { ok: true };
}
export function resetDownloads() {
  for (const e of downloads.values()) if (e.state === "running") e.controller.abort();
  downloads.clear();
}
