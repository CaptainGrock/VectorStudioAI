// What this machine can actually run — adapted from JobKing's server/hardware.js.
// A local model is chosen by what fits: the GPU's VRAM decides how large a
// quant is comfortable, system memory decides CPU fallback, free disk decides
// whether a download can land. Probes degrade to "unknown" rather than guesses.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const PROBE_TIMEOUT_MS = 8000;
let cache = { at: 0, value: null };

function run(command, args, { timeout = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(command, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        resolve(err && !stdout ? "" : String(stdout || ""));
      });
    } catch {
      resolve("");
      return;
    }
    child.on("error", () => resolve(""));
  });
}

const round1 = (value) => Math.round(value * 10) / 10;

export function parseNvidiaSmi(text = "") {
  const gpus = [];
  for (const line of String(text).split(/\r?\n/)) {
    const parts = line.split(",").map((piece) => piece.trim());
    if (parts.length < 2) continue;
    const name = parts[0];
    const mib = Number(parts[1]);
    if (!name || !Number.isFinite(mib) || mib <= 0) continue;
    gpus.push({ name, vramGB: round1((mib * 1048576) / 1073741824), vendor: /nvidia|geforce|quadro|tesla|rtx/i.test(name) ? "nvidia" : "", source: "nvidia-smi" });
  }
  return gpus;
}

export function parseVideoMemoryRegistry(text = "") {
  const match = String(text).match(/qwMemorySize\s+REG_QWORD\s+0x([0-9a-fA-F]+)/);
  if (!match) return null;
  const bytes = BigInt(`0x${match[1]}`);
  const gb = Number(bytes) / 1073741824;
  return Number.isFinite(gb) && gb > 0 ? round1(gb) : null;
}

export function parseVideoControllerNames(text = "") {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9]/.test(line) && !/^(Name|AdapterRAM|----)/i.test(line) && line.length > 3)
    .filter((line) => !/microsoft basic|remote|virtual|parsec|meta|swiftshader|llvmpipe/i.test(line));
}

function vendorFor(name = "") {
  if (/nvidia|geforce|quadro|tesla|rtx/i.test(name)) return "nvidia";
  if (/amd|radeon|ati /i.test(name)) return "amd";
  if (/intel|arc/i.test(name)) return "intel";
  if (/apple/i.test(name)) return "apple";
  return "";
}

async function detectGpu() {
  const smiPaths = ["nvidia-smi", "nvidia-smi.exe"];
  if (process.platform === "win32") {
    smiPaths.push(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "nvidia-smi.exe"));
    smiPaths.push(path.join(process.env.ProgramFiles || "C:\\Program Files", "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"));
  }
  for (const exe of smiPaths) {
    const out = await run(exe, ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"]);
    const gpus = parseNvidiaSmi(out);
    if (gpus.length) {
      const driver = String(out).split(",")[2]?.trim() || "";
      return gpus.map((gpu) => ({ ...gpu, driver }));
    }
  }
  if (process.platform === "darwin") {
    const out = await run("system_profiler", ["SPDisplaysDataType", "-json"]);
    try {
      const parsed = JSON.parse(out);
      const list = parsed?.SPDisplaysDataType || [];
      return list.map((entry) => ({
        name: entry.sppci_model || entry._name || "Apple GPU",
        vramGB: null,
        unified: /apple/i.test(entry.sppci_model || "") || /Apple/i.test(entry.sppci_vendor || ""),
        vendor: vendorFor(entry.sppci_model || ""),
        source: "system_profiler",
      }));
    } catch {
      return [];
    }
  }
  if (process.platform === "win32") {
    const names = parseVideoControllerNames(
      await run("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"])
    );
    const vram = parseVideoMemoryRegistry(
      await run("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0000", "/v", "HardwareInformation.qwMemorySize"])
    );
    return names.map((name, index) => ({
      name,
      vramGB: index === 0 ? vram : null,
      vendor: vendorFor(name),
      source: vram ? "registry" : "name only",
    }));
  }
  const out = await run("lspci", []);
  const found = [];
  for (const line of String(out).split(/\r?\n/)) {
    if (!/VGA compatible controller|3D controller/i.test(line)) continue;
    const name = line.split(":").slice(2).join(":").trim();
    if (!name) continue;
    found.push({ name, vramGB: null, vendor: vendorFor(name), source: "lspci" });
  }
  return found;
}

export function diskFreeGB(target) {
  const candidate = String(target || "").trim() || os.homedir();
  let probe = path.resolve(candidate);
  while (probe && !fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const stats = fs.statfsSync(probe);
    return round1((Number(stats.bsize) * Number(stats.bavail)) / 1073741824);
  } catch {
    return null;
  }
}

export async function hardwareProfile({ force = false, target = "" } = {}) {
  if (!force && cache.value && Date.now() - cache.at < 120000) {
    return target ? { ...cache.value, disk: { target, freeGB: diskFreeGB(target) } } : cache.value;
  }
  const gpus = await detectGpu();
  const totalRamGB = round1(os.totalmem() / 1073741824);
  const unified = gpus.length > 0 && (gpus[0].unified || /apple/i.test(gpus[0].vendor));
  const vramGB = gpus.reduce((best, gpu) => (gpu.vramGB && gpu.vramGB > best ? gpu.vramGB : best), 0) || null;
  const cpu = os.cpus()?.[0]?.model || os.arch();
  const value = {
    platform: process.platform,
    arch: os.arch(),
    cpu,
    threads: os.cpus()?.length || 0,
    ramGB: totalRamGB,
    unifiedMemory: Boolean(unified),
    vramGB: unified ? null : vramGB,
    gpus,
    probedAt: new Date().toISOString(),
    notes: [],
  };
  if (!gpus.length) value.notes.push("No video card could be read on this machine. Models will run on the CPU.");
  else if (!unified && !vramGB) value.notes.push(`Found ${gpus[0].name}, but its video memory size could not be read.`);
  if (unified) value.notes.push("This machine shares one pool of memory between the CPU and GPU.");
  value.disk = target ? { target, freeGB: diskFreeGB(target) } : null;
  cache = { at: Date.now(), value };
  return value;
}

export function memoryBudgetGB(profile = {}) {
  if (profile.unifiedMemory) return round1((Number(profile.ramGB) || 0) * 0.7);
  if (profile.vramGB) return round1(Math.max(1, Number(profile.vramGB) - 1));
  return round1((Number(profile.ramGB) || 0) * 0.6);
}

export function budgetBasis(profile = {}) {
  if (profile.unifiedMemory) return "shared memory";
  if (profile.vramGB) return "video memory";
  return "system memory (CPU)";
}

export function describeBudget(profile = {}, budgetGB = 0) {
  const gpu = profile.gpus?.[0]?.name || "";
  if (profile.unifiedMemory) return `${gpu ? `${gpu} · ` : ""}shared memory — about ${budgetGB} GB is usable for a model`;
  if (profile.vramGB) return `${gpu} · ${budgetGB} GB of video memory`;
  return `${String(profile.cpu || "This CPU").slice(0, 60)} · ${budgetGB} GB of system memory to work in`;
}
