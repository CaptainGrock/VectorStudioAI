// VectorStudio local-engine API: hardware profile, GGUF scan, fit-aware
// catalog, resumable downloads, llama-server install/start, chat forward.
// No dependencies — plain node:http. Vite proxies /api here.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { startRender, renderStatus, renderFile } from "./render.mjs";
import { hardwareProfile, memoryBudgetGB, budgetBasis, describeBudget } from "./hardware.mjs";
import {
  loadSettings, saveSettings, defaultModelDir, localModels,
  scanState, startModelScan, cancelModelScan,
  modelOptions, startDownload, listDownloads, cancelDownload, forgetDownload,
} from "./models.mjs";
import {
  ROOT, LLAMA_PORT, engineOptions, findExistingRunner, engineInstallState,
  startEngineInstall, runnerStatus, startRunner, stopRunner, loadedModels, engineChat,
} from "./engine.mjs";

const PORT = Number(process.env.VS_PORT) || 3120;

const send = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};
const readBody = (req) => new Promise((resolve) => {
  let chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try {
      resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
    } catch {
      resolve({});
    }
  });
  req.on("error", () => resolve({}));
});

async function catalogWithBudget() {
  const profile = await hardwareProfile({ target: defaultModelDir(ROOT) });
  const budgetGB = memoryBudgetGB(profile);
  const online = true;
  let options = [];
  let error = "";
  try {
    options = await modelOptions({ budgetGB, ctxSize: 8192, ramGB: profile.ramGB, diskFreeGB: profile.disk?.freeGB ?? null, online });
  } catch (err) {
    error = err?.message || String(err);
  }
  return { profile, budgetGB, basis: budgetBasis(profile), summary: describeBudget(profile, budgetGB), options, error };
}

// ---- /api/fetchfont helpers (no dependencies: plain node:http) ----
function dlBuffer(target, { timeoutMs = 25000, maxBytes = 20 * 1024 * 1024, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const doGet = (u, left) => {
      let parsed
      try { parsed = new URL(u) } catch { reject(new Error("Not a valid URL.")); return }
      const mod = parsed.protocol === "https:" ? https : http
      const req = mod.get(parsed.toString(), {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) VectorStudio/1.0", Accept: "*/*" },
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && left > 0) {
          res.resume()
          doGet(new URL(res.headers.location, parsed).toString(), left - 1)
          return
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`Download failed (HTTP ${res.statusCode}).`)); return }
        const chunks = []
        let size = 0
        res.on("data", (c) => {
          size += c.length
          if (size > maxBytes) { req.destroy(); reject(new Error("That download is over 20 MB — pick a smaller font file.")) }
          else chunks.push(c)
        })
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }))
        res.on("error", reject)
      })
      req.on("error", reject)
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("Timed out while downloading the font.")) })
    }
    doGet(target, redirects)
  })
}
function sniffFont(buf) {
  if (!buf || buf.length < 4) return null
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return "zip"
  const tag = buf.toString("ascii", 0, 4)
  if (tag === "wOF2") return "woff2"
  if (tag === "wOFF") return "woff"
  if (tag === "OTTO") return "otf"
  if (tag === "true" || tag === "typ1") return "ttf"
  if (buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00) return "ttf"
  return null
}
const FONT_MIME = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", ttc: "font/collection" }
function cleanFontName(raw) {
  let s = String(raw || "")
  try { s = decodeURIComponent(s) } catch { /* keep raw */ }
  return s.replace(/\.(ttf|otf|woff2?|ttc)$/i, "").replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Custom Font"
}
function nameFromTitle(html) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html || "")
  if (!m) return ""
  const t = m[1].split("|")[0].split("\u2014")[0].trim().replace(/\s*(free\s+)?(font\s*)?(download|demo|trial)\s*$/i, "").trim()
  return cleanFontName(t)
}
function fontDataUrl(buf, ext) {
  if (!buf || buf.length > 8 * 1024 * 1024) throw new Error("That font file is over 8 MB — use a smaller cut.")
  return `data:${FONT_MIME[ext] || "font/ttf"};base64,${buf.toString("base64")}`
}
function extractZipTo(buf, dest) {
  const zipPath = path.join(dest, "font.zip")
  fs.writeFileSync(zipPath, buf)
  let r = spawnSync("tar", ["-xf", zipPath, "-C", dest], { timeout: 30000 })
  if (r.status === 0) return true
  if (process.platform === "win32") {
    // Older Windows without tar: PowerShell ships Expand-Archive instead.
    r = spawnSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}' -Force`], { timeout: 60000 })
    return r.status === 0
  }
  return false
}
function findFontsDeep(dir, depth = 0) {
  let out = []
  if (depth > 4) return out
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out = out.concat(findFontsDeep(p, depth + 1))
    else if (/\.(ttf|otf|woff2?)$/i.test(e.name)) out.push(p)
  }
  return out
}
function fontFromZip(buf, fallbackName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vsfont-"))
  try {
    const outDir = path.join(tmp, "out")
    fs.mkdirSync(outDir)
    if (!extractZipTo(buf, outDir)) throw new Error("Could not unpack that zip — download the .ttf/.otf from the page and use Upload instead.")
    const found = findFontsDeep(outDir)
    if (!found.length) throw new Error("That zip holds no font file — download the .ttf/.otf and use Upload instead.")
    const rank = { ".ttf": 0, ".otf": 1, ".woff2": 2, ".woff": 3 }
    found.sort((a, b) => (rank[path.extname(a).toLowerCase()] ?? 9) - (rank[path.extname(b).toLowerCase()] ?? 9))
    const best = found[0]
    const ext = path.extname(best).toLowerCase().slice(1)
    return { buf: fs.readFileSync(best), ext, name: cleanFontName(path.basename(best)) || fallbackName }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
async function fetchCustomFont(pageUrl) {
  const first = await dlBuffer(pageUrl.toString())
  const ctype = String(first.headers["content-type"] || "")
  const looksFile = /\.(ttf|otf|woff2?|ttc)(\?|#|$)/i.test(pageUrl.pathname)
  const kind = sniffFont(first.buf)
  if (kind === "zip") {
    const f = fontFromZip(first.buf, cleanFontName(pageUrl.pathname.split("/").pop()))
    return { name: f.name, dataUrl: fontDataUrl(f.buf, f.ext), format: f.ext, bytes: f.buf.length }
  }
  if (kind && kind !== "zip" && (looksFile || /^font\//.test(ctype) || /octet-stream/.test(ctype))) {
    return { name: cleanFontName(pageUrl.pathname.split("/").pop()), dataUrl: fontDataUrl(first.buf, kind), format: kind, bytes: first.buf.length }
  }
  // HTML page (e.g. a 1001Fonts detail page): hunt its download links.
  // 1001Fonts gates some downloads behind JS (onclick / data attrs / forms),
  // so collect hrefs (double- AND single-quoted), data-href/data-url, form
  // actions, and inline JS download-ish URL strings — not just plain hrefs.
  const html = first.buf.toString("utf8").slice(0, 600000)
  const pageName = nameFromTitle(html)
  const hrefs = []
  const pushHref = (h) => { if (hrefs.length < 400 && typeof h === "string" && h) hrefs.push(h) }
  let m
  const reDq = /href\s*=\s*"([^"]+)"/gi
  while ((m = reDq.exec(html))) pushHref(m[1])
  const reSq = /href\s*=\s*'([^']+)'/gi
  while ((m = reSq.exec(html))) pushHref(m[1])
  const reData = /data-(?:href|url|download-url)\s*=\s*["']([^"']+)["']/gi
  while ((m = reData.exec(html))) pushHref(m[1])
  const reForm = /<form[^>]+action\s*=\s*["']([^"']+)["']/gi
  while ((m = reForm.exec(html))) pushHref(m[1])
  // Inline JS: "/download/...", "...zip", fetch('/...') etc.
  const reJs = /["']((?:\/|https?:\/\/)[^"']*(?:\.zip|\.ttf|\.otf|\.woff2?|download)[^"']*)["']/gi
  while ((m = reJs.exec(html))) pushHref(m[1])
  const cands = []
  const seen = new Set()
  for (const h of hrefs) {
    if (/^(javascript:|mailto:|#|data:)/i.test(h)) continue
    const low = h.toLowerCase()
    if (!(/\.(zip|ttf|otf|woff2?|ttc)(\?|#|$)/.test(low) || low.includes("download"))) continue
    let abs
    try { abs = new URL(h, pageUrl).toString() } catch { continue }
    if (!/^https?:/.test(abs) || seen.has(abs)) continue
    seen.add(abs)
    cands.push(abs)
    if (cands.length >= 10) break
  }
  for (const u of cands) {
    let dl
    try { dl = await dlBuffer(u) } catch { continue }
    const k = sniffFont(dl.buf)
    if (!k) continue
    if (k === "zip") {
      try {
        const f = fontFromZip(dl.buf, pageName)
        return { name: f.name && f.name !== "Custom Font" ? f.name : pageName || f.name, dataUrl: fontDataUrl(f.buf, f.ext), format: f.ext, bytes: f.buf.length }
      } catch { continue }
    }
    const ext = /\.(ttf|otf|woff2?|ttc)(\?|#|$)/i.test(u) ? u.match(/\.(ttf|otf|woff2?|ttc)/i)[1].toLowerCase() : k
    return { name: pageName || cleanFontName(u.split("/").pop()), dataUrl: fontDataUrl(dl.buf, ext), format: ext, bytes: dl.buf.length }
  }
  // Fallback: many 1001Fonts faces (Rubik Vinyl included) are also Google
  // Fonts. If the page's download flow defeated the scraper, try Google's
  // css2 API for the page title before giving up.
  if (pageName) {
    const tried = new Set()
    for (const fam of [pageName, pageName.replace(/\s+Font$/i, "")]) {
      const key = fam.toLowerCase()
      if (!fam || tried.has(key)) continue
      tried.add(key)
      try {
        const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam)}:wght@400;700&display=swap`
        const css = await dlBuffer(cssUrl)
        const cssText = css.buf.toString("utf8")
        const woff = /url\((https:[^)]+\.woff2)\)/.exec(cssText)?.[1]
        if (!woff) continue
        const fontDl = await dlBuffer(woff)
        const ext = sniffFont(fontDl.buf) || "woff2"
        if (!fontDl.buf.length) continue
        return { name: fam, dataUrl: fontDataUrl(fontDl.buf, ext), format: ext, bytes: fontDl.buf.length }
      } catch { /* try next candidate */ }
    }
  }
  throw new Error("No downloadable font found on that page — open it in a browser, download the .ttf/.otf, and use Upload instead.")
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : {};
    const settings = loadSettings();
    const modelDir = settings.modelDir || defaultModelDir(ROOT);

    if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true, render: true });

    if (req.method === "GET" && url.pathname === "/api/hardware") {
      const profile = await hardwareProfile({ target: modelDir });
      const budgetGB = memoryBudgetGB(profile);
      return send(res, 200, { profile, budgetGB, basis: budgetBasis(profile), summary: describeBudget(profile, budgetGB) });
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      const onDisk = localModels(modelDir);
      const loaded = await loadedModels();
      const running = runnerStatus();
      return send(res, 200, { modelDir, onDisk, scanned: scanState().found, loaded, running, activeModel: running.model || loaded[0] || "" });
    }
    if (req.method === "POST" && url.pathname === "/api/models/scan") {
      return send(res, 200, startModelScan({ modelDir, extraRoots: [], drives: body.drives !== false }));
    }
    if (req.method === "GET" && url.pathname === "/api/models/scan") return send(res, 200, scanState());
    if (req.method === "POST" && url.pathname === "/api/models/scan/cancel") return send(res, 200, cancelModelScan());

    if (req.method === "GET" && url.pathname === "/api/catalog") {
      return send(res, 200, await catalogWithBudget());
    }
    if (req.method === "GET" && url.pathname === "/api/downloads") return send(res, 200, { downloads: listDownloads(), dir: modelDir });
    if (req.method === "POST" && url.pathname === "/api/downloads") {
      const cat = await catalogWithBudget();
      const option = cat.options.find((o) => o.id === body.id);
      if (!option) return send(res, 400, { ok: false, error: "Unknown model." });
      if (option.blocked) return send(res, 400, { ok: false, error: option.blocked });
      if (option.diskOk === false) return send(res, 400, { ok: false, error: `Not enough free space for the ${option.sizeGB} GB download.` });
      return send(res, 200, startDownload({ url: option.url, file: option.file, dir: modelDir, sizeBytes: option.bytes, label: option.label, kind: "model" }));
    }
    const cancelMatch = url.pathname.match(/^\/api\/downloads\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) return send(res, 200, cancelDownload(cancelMatch[1]));
    const forgetMatch = url.pathname.match(/^\/api\/downloads\/([^/]+)\/forget$/);
    if (req.method === "POST" && forgetMatch) return send(res, 200, forgetDownload(forgetMatch[1]));

    if (req.method === "GET" && url.pathname === "/api/engine") {
      const st = loadSettings();
      const binary = findExistingRunner({ runnerPath: st.runnerPath });
      const running = runnerStatus();
      return send(res, 200, { binary, install: engineInstallState(), running, loaded: await loadedModels(), llamaPort: LLAMA_PORT, modelDir, lastModel: st.lastModel || "" });
    }
    if (req.method === "POST" && url.pathname === "/api/engine/options") {
      const profile = await hardwareProfile();
      return send(res, 200, await engineOptions({ hardware: profile, online: body.online !== false }));
    }
    if (req.method === "POST" && url.pathname === "/api/engine/install") {
      const profile = await hardwareProfile();
      const opts = await engineOptions({ hardware: profile, online: true });
      const option = opts.options.find((o) => o.id === (body.optionId || opts.options.find((x) => x.recommended)?.id));
      if (!option) return send(res, 400, { ok: false, error: "No engine build matched this machine." });
      const started = startEngineInstall({ option, dir: opts.dir, onBinary: (server) => saveSettings({ runnerPath: server }) });
      return send(res, started.ok ? 200 : 400, started);
    }
    if (req.method === "POST" && url.pathname === "/api/engine/start") {
      const st = loadSettings();
      const exe = findExistingRunner({ runnerPath: st.runnerPath }) || body.exe || "";
      const target = body.modelPath || st.lastModel || "";
      const result = await startRunner({ exe, modelPath: target });
      if (result.ok) saveSettings({ lastModel: target, runnerPath: exe });
      return send(res, result.ok ? 200 : 400, result);
    }
    if (req.method === "POST" && url.pathname === "/api/engine/stop") return send(res, 200, stopRunner());
    if (req.method === "POST" && url.pathname === "/api/settings") {
      return send(res, 200, { ok: true, settings: saveSettings(body) });
    }
    if (req.method === "POST" && url.pathname === "/api/render") {
      return send(res, 200, startRender(body.scene));
    }
    const renderStatusMatch = url.pathname.match(/^\/api\/render\/([^/]+)$/);
    if (req.method === "GET" && renderStatusMatch) return send(res, 200, renderStatus(renderStatusMatch[1]));
    const renderFileMatch = url.pathname.match(/^\/api\/render\/([^/]+)\/file$/);
    if (req.method === "GET" && renderFileMatch) {
      const f = renderFile(renderFileMatch[1]);
      if (!f) return send(res, 404, { ok: false, error: "MP4 not ready." });
      const stat = fs.statSync(f);
      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": stat.size,
        "content-disposition": 'attachment; filename="vectorstudio.mp4"',
      });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const running = runnerStatus();
      if (!running.running) return send(res, 409, { ok: false, error: "No model is running. Start the engine first." });
      try {
        const out = await engineChat({ messages: body.messages || [] });
        return send(res, 200, { ok: true, ...out });
      } catch (err) {
        return send(res, 502, { ok: false, error: err?.message || String(err) });
      }
    }
    // Custom font fetch: paste a 1001Fonts page URL (or a direct .ttf/.otf/
    // .woff/.woff2 link) and the server downloads/extracts it — browsers
    // can't scrape those pages (CORS), the backend can. Returns a data:
    // URL the client stores on the layer, so preview and MP4 export agree.
    if (url.pathname === "/api/fetchfont" || url.pathname === "/api/fetchfont/") {
      if (req.method !== "POST") return send(res, 405, { ok: false, error: "Use POST for /api/fetchfont." })

      try {
        const raw = String(body.url || "").trim()
        if (!raw) return send(res, 400, { ok: false, error: "Paste a font URL first." })
        let pageUrl
        try { pageUrl = new URL(raw) } catch { return send(res, 400, { ok: false, error: "That is not a valid URL." }) }
        if (!/^https?:$/.test(pageUrl.protocol)) return send(res, 400, { ok: false, error: "Only http(s) URLs are supported." })
        const out = await fetchCustomFont(pageUrl)
        return send(res, 200, { ok: true, ...out })
      } catch (err) {
        return send(res, 502, { ok: false, error: err?.message || "Font fetch failed." })
      }
    }
    return send(res, 404, { ok: false, error: "Unknown route." });
  } catch (err) {
    return send(res, 500, { ok: false, error: err?.message || String(err) });
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`[vs-engine] listening on http://127.0.0.1:${PORT}`);
  // Autostart the last model, like a studio that remembers its setup.
  try {
    const st = loadSettings();
    const exe = findExistingRunner({ runnerPath: st.runnerPath });
    if (st.lastModel && exe) {
      console.log(`[vs-engine] autostarting ${st.lastModel}`);
      const result = await startRunner({ exe, modelPath: st.lastModel });
      console.log(result.ok ? `[vs-engine] engine up with ${result.model}` : `[vs-engine] autostart failed: ${result.error}`);
    } else {
      console.log("[vs-engine] no previous model to autostart (pick one in the app's LLM panel)");
    }
  } catch (err) {
    console.log(`[vs-engine] autostart failed: ${err?.message || err}`);
  }
});
