// One command to run everything: the local-engine backend + Vite.
// Cross-platform (Pinokio + standalone): spawns node server/index.mjs,
// waits for /api/health, then execs vite with the same --port/--host args.
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const hostArg = args.indexOf("--host");
const port = portArg >= 0 ? args[portArg + 1] : "5173";
const host = hostArg >= 0 ? args[hostArg + 1] : "127.0.0.1";

const backend = spawn(process.execPath, ["server/index.mjs"], {
  env: { ...process.env, VS_PORT: process.env.VS_PORT || "3120" },
  stdio: "inherit",
  windowsHide: false,
});

async function waitForBackend(tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch("http://127.0.0.1:3120/api/health", { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const up = await waitForBackend();
if (!up) {
  console.error("[dev-all] backend did not answer on :3120 — continuing anyway; the engine panel will show offline.");
}

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", String(port), "--host", String(host)], {
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    vite.kill(sig);
    backend.kill(sig);
    process.exit(0);
  });
}
vite.on("exit", (code) => {
  backend.kill();
  process.exit(code ?? 0);
});
backend.on("exit", (code) => {
  if (code !== 0 && code !== null) console.error(`[dev-all] backend exited with code ${code}`);
});
