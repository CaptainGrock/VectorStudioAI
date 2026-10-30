// Resident TTS worker: keeps the 3B Breeze model loaded across syntheses
// (like the ComfyUI node does) so repeat runs skip the ~20-40 s cold load
// and CUDA graphs are captured once per session instead of per run.
//
// Smart VRAM behavior, as requested:
// - Before loading, free VRAM is checked with nvidia-smi. Under the need
//   (~9 GB stock, ~15 GB with CUDA graphs) the worker stays DOWN and the
//   one-shot cold run is used instead — so a ComfyUI model already on the
//   card (or any small GPU) never gets pushed into an OOM.
// - After IDLE_MS without a request the worker exits and frees VRAM.
// - Any worker failure falls back to the cold path, never a dead end.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";

const STOCK_NEED_GB = 9;
const FAST_NEED_GB = 15;

let worker = null; // { child, key, ready, pending: Map, idleTimer, lastUsedAt, vramGB }
let idleMs = 10 * 60 * 1000;

function workerKey({ py, ckpt, attn, fast }) {
  return JSON.stringify({ py, ckpt, attn, fast: !!fast });
}

function vramFreeGB() {
  const cmd = process.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi";
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(cmd, ["--query-gpu=memory.free", "--format=csv,noheader,nounits"],
        { timeout: 10000, windowsHide: true }, (err, stdout) => {
          if (err || !stdout) return resolve(null);
          let best = 0;
          for (const line of String(stdout).split(/[\r\n]+/)) {
            const mib = Number(line.trim());
            if (Number.isFinite(mib) && mib > best) best = mib;
          }
          resolve(best > 0 ? best / 1024 : null);
        });
    } catch {
      resolve(null);
    }
    child?.on?.("error", () => resolve(null));
  });
}

export function workerState() {
  if (!worker) return { resident: false };
  return {
    resident: true,
    ready: !!worker.ready,
    busy: worker.pending.size > 0,
    lastUsedAt: worker.lastUsedAt || null,
    idleInSec: worker.ready ? Math.max(0, Math.round((idleMs - (Date.now() - (worker.lastUsedAt || Date.now()))) / 1000)) : null,
    vramNeedGB: worker.needGB,
  };
}

export function setWorkerIdleMs(ms) {
  if (Number.isFinite(Number(ms)) && Number(ms) > 0) idleMs = Number(ms);
}

function killWorker(reason) {
  if (!worker) return;
  const w = worker;
  worker = null;
  try { clearTimeout(w.idleTimer); } catch { /* ignore */ }
  w.pending.forEach((p) => { try { p.resolve({ ok: false, error: reason || "TTS worker stopped." }); } catch { /* ignore */ } });
  w.pending.clear();
  try { w.child.kill(); } catch { /* ignore */ }
  try { w.onLog?.(`TTS worker unloaded (${reason || "idle"} — VRAM released).\n`); } catch { /* ignore */ }
}

function armIdle(w) {
  try { clearTimeout(w.idleTimer); } catch { /* ignore */ }
  w.idleTimer = setTimeout(() => killWorker("idle timeout"), idleMs);
  try { w.idleTimer.unref?.(); } catch { /* ignore */ }
}

async function ensureWorker({ py, lib, ckpt, attn, fast, onLog, timeoutMs = 600000 }) {
  const key = workerKey({ py: py.join(" "), ckpt, attn, fast });
  if (worker && worker.key !== key) killWorker("settings changed");
  if (worker && worker.ready) {
    worker.lastUsedAt = Date.now();
    armIdle(worker);
    return { ok: true };
  }
  if (worker && !worker.ready) {
    // A load is already in flight — piggyback on it.
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: "Timed out waiting for the TTS worker to load." }), timeoutMs);
      worker.waiters.push((r) => { clearTimeout(t); resolve(r); });
    });
  }
  const needGB = fast ? FAST_NEED_GB : STOCK_NEED_GB;
  const freeGB = await vramFreeGB();
  if (freeGB !== null && freeGB < needGB) {
    return {
      ok: false, fallback: true,
      error: `Only ${freeGB.toFixed(1)} GB VRAM free (need ~${needGB} GB resident) — using the one-shot run instead so nothing else gets pushed out. Free VRAM or shorten idle apps to go resident.`,
    };
  }
  const workerPy = path.join(lib, "worker.py");
  if (!fs.existsSync(workerPy)) return { ok: false, fallback: true, error: "No worker.py in the code folder." };
  const args = [...py.slice(1), workerPy, ckpt, "--attn", attn || "sdpa"];
  if (fast) args.push("--fast-all");
  const sep = process.platform === "win32" ? ";" : ":";
  const w = {
    key, ready: false, pending: new Map(), waiters: [],
    lastUsedAt: Date.now(), needGB, onLog, idleTimer: null, buf: "",
  };
  try {
    onLog?.(`Loading the resident TTS worker (~${needGB} GB VRAM, one-time)…\n`);
  } catch { /* ignore */ }
  let child;
  try {
    child = spawn(py[0], args, {
      cwd: ckpt,
      env: { ...process.env, PYTHONPATH: lib + (process.env.PYTHONPATH ? sep + process.env.PYTHONPATH : "") },
    });
  } catch (e) {
    return { ok: false, fallback: true, error: e?.message || "Could not launch the TTS worker." };
  }
  w.child = child;
  worker = w;
  try { child.stdin?.on?.("error", () => {}); } catch { /* ignore */ }
  child.stdout?.on("data", (c) => {
    w.buf += c.toString();
    let i;
    while ((i = w.buf.indexOf("\n")) >= 0) {
      const line = w.buf.slice(0, i).trim();
      w.buf = w.buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg?.ready) {
        w.ready = true;
        w.lastUsedAt = Date.now();
        armIdle(w);
        try { onLog?.(`TTS worker resident — repeat runs skip the model load.\n`); } catch { /* ignore */ }
        w.waiters.splice(0).forEach((fn) => { try { fn({ ok: true }); } catch { /* ignore */ } });
        continue;
      }
      if (msg && msg.id && w.pending.has(msg.id)) {
        const p = w.pending.get(msg.id);
        w.pending.delete(msg.id);
        w.lastUsedAt = Date.now();
        armIdle(w);
        try {
          p.resolve(msg.ok
            ? { ok: true, outPath: p.outPath, seconds: msg.seconds }
            : { ok: false, error: msg.error || "Worker synthesis failed." });
        } catch { /* ignore */ }
      }
    }
  });
  child.stderr?.on("data", (c) => { try { onLog?.(c.toString()); } catch { /* ignore */ } });
  child.on("error", () => {
    const was = worker === w ? "TTS worker would not launch — one-shot run instead." : "TTS worker error.";
    if (worker === w) worker = null;
    w.waiters.splice(0).forEach((fn) => { try { fn({ ok: false, fallback: true, error: was }); } catch { /* ignore */ } });
    w.pending.forEach((p) => { try { p.resolve({ ok: false, fallback: true, error: was }); } catch { /* ignore */ } });
    w.pending.clear();
  });
  child.on("close", (code) => {
    if (worker !== w) return;
    worker = null;
    const msg = `TTS worker exited (code ${code}) — one-shot run instead.`;
    try { onLog?.(`${msg}\n`); } catch { /* ignore */ }
    w.waiters.splice(0).forEach((fn) => { try { fn({ ok: false, fallback: true, error: msg }); } catch { /* ignore */ } });
    w.pending.forEach((p) => { try { p.resolve({ ok: false, fallback: true, error: msg }); } catch { /* ignore */ } });
    w.pending.clear();
  });
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, fallback: true, error: "Timed out waiting for the TTS worker to load — one-shot run instead." }), timeoutMs);
    w.waiters.push((r) => { clearTimeout(t); resolve(r); });
  });
}

// One synthesis through the resident worker. Resolves {ok, outPath} or
// {ok:false, error, fallback?} — fallback:true means "retry me cold".
export async function synthViaWorker(opts) {
  const { onLog, timeoutMs = 600000, tmp, refAudioDataUrl } = opts;
  const ens = await ensureWorker(opts);
  if (!ens.ok || !worker) return ens;
  const w = worker;
  // Cancelling kills the resident worker (documented in the log) — the
  // next synthesis respawns it. Correctness over VRAM frugality on Cancel.
  try { opts.__child?.(w.child); } catch { /* ignore */ }
  const id = `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  let refPath = "";
  try {
    const outPath = path.join(tmp, "out.wav");
    const req = {
      id,
      text: opts.text,
      seed: opts.seed ?? 42,
      out: outPath,
      cfg: opts.instruction ? 4 : 1,
      instruction: opts.instruction || null,
    };
    if (refAudioDataUrl) {
      refPath = path.join(tmp, "ref.wav");
      const m = /^data:audio\/(\w+);base64,(.+)$/.exec(String(refAudioDataUrl));
      if (!m) return { ok: false, error: "That reference clip is not usable audio." };
      fs.writeFileSync(refPath, Buffer.from(m[2], "base64"));
      req.ref_audio = refPath;
      req.ref_text = String(opts.refText || "").trim() || undefined;
      if (!req.ref_text) return { ok: false, error: "Voice cloning needs the clip's exact transcript — paste it under the voice." };
    }
    const done = new Promise((resolve) => {
      const t = setTimeout(() => {
        w.pending.delete(id);
        resolve({ ok: false, error: "TTS worker timed out — try shorter text." });
      }, timeoutMs);
      try { t.unref?.(); } catch { /* ignore */ }
      w.pending.set(id, { resolve: (r) => { clearTimeout(t); resolve(r); }, outPath });
    });
    try {
      w.child.stdin.write(JSON.stringify(req) + "\n");
    } catch (e) {
      w.pending.delete(id);
      return { ok: false, fallback: true, error: e?.message || "Could not talk to the TTS worker." };
    }
    w.lastUsedAt = Date.now();
    armIdle(w);
    return await done;
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export function shutdownWorker() {
  killWorker("server stopping");
}
