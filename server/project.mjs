// Full-fidelity project auto-save: localStorage caps at ~5MB and strips
// audio/image bytes on quota, which is why restarts came back with blank
// slides. The local server has no such cap, so the client POSTs the whole
// project here (debounced) and reloads it on startup.
import fs from "node:fs";
import path from "node:path";

export function projectPath(root) {
  return path.join(root, "data", "project.json");
}

export function loadProject(root) {
  try {
    const p = projectPath(root);
    if (!fs.existsSync(p)) return { ok: true, empty: true, project: null };
    const raw = fs.readFileSync(p, "utf8");
    if (!raw.trim()) return { ok: true, empty: true, project: null };
    const project = JSON.parse(raw);
    if (!project || typeof project !== "object") return { ok: false, error: "Saved project is corrupt." };
    return { ok: true, empty: false, project };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export function saveProject(root, body) {
  try {
    if (!body || typeof body !== "object") return { ok: false, error: "Nothing to save." };
    let conversations = Array.isArray(body.conversations) ? body.conversations.slice(0, 40) : [];
    const sequence = body.sequence && typeof body.sequence === "object" ? body.sequence : { items: [], music: null };
    const scene = body.scene && typeof body.scene === "object" ? body.scene : null;
    // Basic shape check — the client validates scenes; here we just refuse junk.
    for (const c of conversations) {
      if (!c || !c.id || !c.scene || !Array.isArray(c.scene.layers)) {
        return { ok: false, error: "That project has a slide without layers." };
      }
    }
    // Never clobber slides with an empty push: deleting history leaves the
    // sequence (which holds its own scene snapshots) non-empty, so the
    // client's empty-shell guard passes and an empty conversations array
    // used to wipe the disk copy — then restarts had nothing to restore
    // (backgrounds/voiceovers "lost"). Preserve the disk slides instead;
    // clearing everything is already a client-side no-push.
    let preserved = 0;
    if (!conversations.length) {
      try {
        const prev = loadProject(root);
        const prevConvos = prev.project && Array.isArray(prev.project.conversations) ? prev.project.conversations : [];
        if (prevConvos.length) { conversations = prevConvos; preserved = prevConvos.length; }
      } catch { /* fall through with the empty list */ }
    }
    // Attached registries (images/audio/datasets) are memory-only in the
    // browser — without them here, every restart empties the inventory
    // and orphans imageName re-links. They ride the same caps as the store.
    const asArray = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
    const project = {
      version: 1,
      updatedAt: new Date().toISOString(),
      activeConvoId: typeof body.activeConvoId === "string" ? body.activeConvoId : null,
      conversations,
      sequence: { items: Array.isArray(sequence.items) ? sequence.items.slice(0, 40) : [], music: sequence.music || null },
      scene,
      images: asArray(body.images, 10),
      audios: asArray(body.audios, 10),
      datasets: asArray(body.datasets, 5),
    };
    const p = projectPath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(project));
    fs.renameSync(tmp, p);
    return { ok: true, updatedAt: project.updatedAt, slides: conversations.length, ...(preserved ? { preserved } : {}) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
