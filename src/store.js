import { create } from 'zustand'
import { applyPatch, validateScene, normalizeScene } from './sceneGraph.js'

const LAST_KEY = 'vectorstudio.lastScene'
const CONV_KEY = 'vectorstudio.convos.v1'
const MAX_CONVOS = 20

function loadConvos() {
  try {
    const raw = localStorage.getItem(CONV_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((c) => c && c.id && c.scene).slice(0, MAX_CONVOS) : []
  } catch {
    return []
  }
}
function persistConvos(list) {
  try { localStorage.setItem(CONV_KEY, JSON.stringify(list)) } catch { /* quota/private mode */ }
}
const SEQ_KEY = 'vectorstudio.sequence.v1'
const ACTIVE_KEY = 'vectorstudio.activeConvo.v1'
const SEQ_PERSIST_MAX = 4 * 1024 * 1024 // scenes carry data: URLs — skip disk when huge
const TRASH_KEY = 'vectorstudio.trash.v1'
const MAX_TRASH = 10

// Safety net for lost slides: every deleted history entry and every
// history snapshot replaced by the autosync lands here (newest first),
// so an overwrite or accidental delete is one Restore click away.
function loadTrash() {
  try {
    const arr = JSON.parse(localStorage.getItem(TRASH_KEY) || '[]')
    return Array.isArray(arr) ? arr.filter((c) => c && c.id && c.scene).slice(0, MAX_TRASH) : []
  } catch {
    return []
  }
}
function persistTrash(list) {
  try {
    localStorage.setItem(TRASH_KEY, JSON.stringify(list))
  } catch {
    // Quota (scenes carry image data-URLs): keep the newest half, retry once.
    try { localStorage.setItem(TRASH_KEY, JSON.stringify(list.slice(0, Math.max(1, Math.floor(MAX_TRASH / 2))))) } catch { /* give up */ }
  }
}
function stashTrashItem(list, item) {
  if (!item || !item.scene) return list
  try {
    if (list.length && JSON.stringify(list[0].scene) === JSON.stringify(item.scene)) return list // no dup spam
  } catch { /* fall through and stash */ }
  return [{ ...item, trashedAt: new Date().toISOString() }, ...list].slice(0, MAX_TRASH)
}

function loadActiveConvo(convos) {
  try {
    const id = localStorage.getItem(ACTIVE_KEY)
    return id && convos.some((c) => c.id === id) ? id : null
  } catch {
    return null
  }
}
function loadSequence() {
  const empty = { items: [], music: null }
  try {
    const raw = localStorage.getItem(SEQ_KEY)
    if (!raw) return empty
    const s = JSON.parse(raw)
    if (!s || !Array.isArray(s.items)) return empty
    const items = s.items.filter((x) => x && x.id && x.scene).slice(0, 40)
    return { items, music: s.music && s.music.assetUrl ? s.music : null }
  } catch {
    return empty
  }
}
function persistSequence(sequence) {
  try {
    const raw = JSON.stringify(sequence)
    if (raw.length > SEQ_PERSIST_MAX) return // keep in memory only
    localStorage.setItem(SEQ_KEY, raw)
  } catch { /* quota/private mode — session keeps it */ }
}

// Every scene mutation must survive a browser close / server restart.
// setScene/addLayer persisted; the rest did not — text tweaks, renames,
// keyframe moves and patch edits silently vanished on reload. Central
// helper: best-effort disk write, session always keeps the full scene.
function persistScene(scene) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify(scene)) } catch { /* quota/private mode */ }
}

// Clip timing: trims cut head/tail, gapAfter is trailing silence before
// the next clip. Positions ripple automatically since every start is
// derived — deleting or closing a gap pulls the rest of the rail in.
export function clipDuration(item) {
  const dur = Number(item?.scene?.durationInFrames) || 0
  const ts = Math.max(0, Math.round(Number(item?.trimStart) || 0))
  const te = Math.max(0, Math.round(Number(item?.trimEnd) || 0))
  return Math.max(1, dur - ts - te)
}
export function seqLayout(sequence) {
  const items = sequence?.items || []
  let t = 0
  const clips = items.map((item) => {
    const dur = clipDuration(item)
    const start = t
    t += dur + Math.max(0, Math.round(Number(item.gapAfter) || 0))
    return { item, start, dur }
  })
  return { clips, total: t }
}
// One canvas for the whole sequence: first clip wins, the rest are
// uniform-fit scaled inside it (same rule as narrow/portrait scenes).
export function seqCanvas(sequence) {
  const first = sequence?.items?.[0]?.scene
  return {
    fps: Math.min(120, Math.max(1, Math.round(Number(first?.fps) || 30))),
    width: Math.round(Number(first?.width) || 1280) || 1280,
    height: Math.round(Number(first?.height) || 720) || 720,
  }
}

function convoTitle(prompt) {
  const first = String(prompt || '').split('\n').find((l) => l.trim() && !/^\s*\|/.test(l)) || ''
  const oneLine = first.replace(/\s+/g, ' ').trim()
  return oneLine ? oneLine.slice(0, 70) : 'Untitled scene'
}

export const emptyScene = {
  fps: 30,
  durationInFrames: 300,
  width: 1280,
  height: 720,
  background: '#10141d',
  layers: [],
}

function initialScene() {
  // No default video: start empty, unless a previous session left a scene.
  try {
    const raw = localStorage.getItem(LAST_KEY)
    if (raw) return validateScene(JSON.parse(raw))
  } catch { /* corrupt or missing: start empty */ }
  return { ...emptyScene }
}

// Scene length follows content outward only: if an edit pushes a layer (or
// a committed keyframe) past the scene end, the scene grows to include it
// so work is never silently cut from preview/export. Shrinking is always
// explicit via the timeline Trim button.
function fitDurationOut(scene) {
  const maxEnd = Math.max(0,
    ...scene.layers.map((l) => Number(l.endFrame) || 0),
    ...scene.layers.flatMap((l) => (l.keyframes || []).map((k) => Number(k.frame) || 0)))
  if (maxEnd > scene.durationInFrames) {
    return { ...scene, durationInFrames: Math.min(3600, Math.max(1, Math.round(maxEnd))) }
  }
  return scene
}

export const useStudio = create((set, get) => ({
  scene: initialScene(),
  sceneRev: 0,
  past: [],
  future: [],
  status: { text: 'Ready. Describe your video on the left, then Generate.', kind: 'idle' },
  prompt: '',
  editPrompt: '',
  log: ['Loaded default Q3 Review scene.'],

  setStatus: (text, kind = 'info') => set({ status: { text, kind } }),

  setScene: (scene) => set((s) => {
    try {
      const valid = validateScene(normalizeScene(scene))
      try { localStorage.setItem(LAST_KEY, JSON.stringify(valid)) } catch { /* private mode */ }
      // sceneRev remounts the Player so the new preview loads from frame 0.
      return { scene: valid, sceneRev: s.sceneRev + 1, past: [...s.past, s.scene].slice(-50), future: [], log: [...s.log, 'Scene updated.'] }
    } catch (e) {
      return { log: [...s.log, `Invalid scene: ${e.message}`] }
    }
  }),

  patchScene: (patch) => set((s) => {
    try {
      const next = applyPatch(s.scene, patch)
      persistScene(next)
      return { scene: next, past: [...s.past, s.scene].slice(-50), future: [], log: [...s.log, `Applied ${patch.length} patch op(s).`] }
    } catch (e) {
      return { log: [...s.log, `Patch failed: ${e.message}`] }
    }
  }),

  moveKeyframe: (id, ki, frame) => set((s) => {
    const scene = { ...s.scene, layers: s.scene.layers.map(l => (l.id === id ? { ...l, keyframes: l.keyframes.map((kk, j) => (j === ki ? { ...kk, frame } : kk)) } : l)) }
    persistScene(scene)
    return { scene }
  }),
  commitKeyframes: (id, ki, frame) => set((s) => {
    const layers = s.scene.layers.map(l => (l.id === id ? { ...l, keyframes: l.keyframes.map((kk, j) => (j === ki ? { ...kk, frame } : kk)) } : l))
    const scene = fitDurationOut({ ...s.scene, layers })
    persistScene(scene)
    return { scene, past: [...s.past, s.scene].slice(-50), future: [] }
  }),

  // Right-edge trim of a layer's endFrame. trimLayer is the live drag
  // (no undo spam — same pattern as moveKeyframe); commitLayerTrim writes
  // the final value with one undo entry and grows the scene if the new
  // end runs past it. Shrinking the scene itself stays explicit via Trim.
  trimLayer: (id, endFrame) => set((s) => {
    const scene = { ...s.scene, layers: s.scene.layers.map(l => (l.id === id ? { ...l, endFrame } : l)) }
    persistScene(scene)
    return { scene }
  }),
  commitLayerTrim: (id, endFrame) => set((s) => {
    const layers = s.scene.layers.map(l => (l.id === id ? { ...l, endFrame } : l))
    const scene = fitDurationOut({ ...s.scene, layers })
    persistScene(scene)
    return { scene, past: [...s.past, s.scene].slice(-50), future: [] }
  }),

  // Left-edge trim of a layer's startFrame — same live/commit split.
  // Dragging an audio layer's left edge in delays its start (TTS/music
  // only mount while the playhead is inside [startFrame, endFrame]).
  trimStartLayer: (id, startFrame) => set((s) => {
    const scene = { ...s.scene, layers: s.scene.layers.map(l => (l.id === id ? { ...l, startFrame } : l)) }
    persistScene(scene)
    return { scene }
  }),
  commitStartTrim: (id, startFrame) => set((s) => {
    const scene = { ...s.scene, layers: s.scene.layers.map(l => (l.id === id ? { ...l, startFrame } : l)) }
    persistScene(scene)
    return { scene, past: [...s.past, s.scene].slice(-50), future: [] }
  }),

  updateSceneField: (field, value) => set((s) => {
    const scene = { ...s.scene, [field]: value }
    persistScene(scene)
    return { scene, past: [...s.past, s.scene].slice(-50), future: [] }
  }),

  updateLayer: (id, fn) => set((s) => {
    const layers = s.scene.layers.map(l => (l.id === id ? fn(l) : l))
    const scene = fitDurationOut({ ...s.scene, layers })
    persistScene(scene)
    return { scene, past: [...s.past, s.scene].slice(-50), future: [] }
  }),

  addLayer: (layer) => set((s) => {
    try {
      const clean = validateScene(normalizeScene({ ...s.scene, layers: [...s.scene.layers, layer] }))
      const scene = fitDurationOut(clean)
      persistScene(scene)
      // Manual slides never went through Generate, so they never landed in
      // History — a title slide built from +Add text vanished from the rail.
      // First layer in an empty scene seeds a default history checkpoint so
      // the work is never losable; later adds ride LAST_KEY persistence.
      // With active-entry syncing in place, a tracked slide needs no extra
      // seed — the seed is only for untracked work.
      const wasEmpty = s.scene.layers.length === 0
      if (!wasEmpty || s.activeConvoId) {
        return { scene, past: [...s.past, s.scene].slice(-50), future: [], selectedLayerId: layer.id, log: [...s.log, `Added layer: ${layer.name}`] }
      }
      const item = {
        id: `c_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
        title: convoTitle(`Manual slide — ${layer.name || 'title animation'}`),
        prompt: `Manual slide — ${layer.name || 'title animation'}`,
        scene,
        createdAt: new Date().toISOString(),
        layerCount: scene.layers.length,
      }
      const conversations = [item, ...s.conversations].slice(0, MAX_CONVOS)
      persistConvos(conversations)
      return { scene, conversations, past: [...s.past, s.scene].slice(-50), future: [], selectedLayerId: layer.id, log: [...s.log, `Added layer: ${layer.name}`, `Saved to history: ${item.title}`] }
    } catch (e) {
      return { log: [...s.log, `Could not add layer: ${e.message}`] }
    }
  }),

  undo: () => set((s) => {
    if (!s.past.length) return s
    const prev = s.past[s.past.length - 1]
    return { scene: prev, past: s.past.slice(0, -1), future: [s.scene, ...s.future], log: [...s.log, 'Undo.'] }
  }),

  redo: () => set((s) => {
    if (!s.future.length) return s
    const [next, ...rest] = s.future
    return { scene: next, past: [...s.past, s.scene], future: rest, log: [...s.log, 'Redo.'] }
  }),

  conversations: loadConvos(),
  // The entry the live scene belongs to: its snapshot is kept current by
  // syncActiveConvo (debounced from App), so Duplicate/Load never resurrect
  // a stale copy. Survives restarts via ACTIVE_KEY.
  activeConvoId: loadActiveConvo(loadConvos()),
  setActiveConvo: (id) => set(() => {
    try {
      if (id) localStorage.setItem(ACTIVE_KEY, id)
      else localStorage.removeItem(ACTIVE_KEY)
    } catch { /* ignore */ }
    return { activeConvoId: id || null }
  }),
  // Writes the live scene into the active history entry (no undo entry,
  // no log spam — this is bookkeeping, not an edit). The replaced snapshot
  // is stashed in Trash first, so a mis-targeted sync never destroys work.
  syncActiveConvo: () => set((s) => {
    if (!s.activeConvoId) return s
    const cur = s.conversations.find((c) => c.id === s.activeConvoId)
    if (!cur) return s
    let same = false
    try { same = JSON.stringify(cur.scene) === JSON.stringify(s.scene) } catch { same = false }
    if (same) return s
    const trash = stashTrashItem(s.trash || [], cur)
    persistTrash(trash)
    const conversations = s.conversations.map((c) => (c.id === s.activeConvoId ? { ...c, scene: s.scene, layerCount: s.scene.layers.length } : c))
    persistConvos(conversations)
    return { conversations, trash }
  }),
  trash: loadTrash(),
  restoreTrash: (id) => set((s) => {
    const item = (s.trash || []).find((x) => x.id === id)
    if (!item) return s
    const takeId = s.conversations.some((x) => x.id === item.id)
      ? `c_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}` : item.id
    const restored = { id: takeId, title: item.title, prompt: item.prompt, scene: item.scene, createdAt: item.createdAt || new Date().toISOString(), layerCount: item.layerCount }
    const conversations = [restored, ...s.conversations].slice(0, MAX_CONVOS)
    persistConvos(conversations)
    const trash = (s.trash || []).filter((x) => x.id !== id)
    persistTrash(trash)
    return { conversations, trash, log: [...s.log, `Restored from trash: ${restored.title}`] }
  }),
  emptyTrash: () => set((s) => { persistTrash([]); return { trash: [] } }),
  selectedLayerId: null,

  selectLayer: (id) => set({ selectedLayerId: id || null }),

  // Empty string is a valid rename (blank title); only null/undefined
  // (a cancelled prompt) is a no-op.
  renameLayer: (id, name) => set((s) => {
    if (name === null || name === undefined) return s
    const clean = String(name).trim().slice(0, 80)
    const layers = s.scene.layers.map((l) => (l.id === id ? { ...l, name: clean } : l))
    const scene = { ...s.scene, layers }
    persistScene(scene)
    return { scene, past: [...s.past, s.scene].slice(-50), future: [] }
  }),

  deleteLayer: (id) => set((s) => {
    if (!s.scene.layers.some((l) => l.id === id)) return s
    const layers = s.scene.layers.filter((l) => l.id !== id)
    const scene = { ...s.scene, layers }
    persistScene(scene)
    return {
      scene,
      past: [...s.past, s.scene].slice(-50),
      future: [],
      selectedLayerId: s.selectedLayerId === id ? null : s.selectedLayerId,
      log: [...s.log, 'Layer deleted.'],
    }
  }),

  // Returns the new item (callers fork sequence clips from it).
  addConversation: (prompt, scene) => {
    const item = {
      id: `c_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      title: convoTitle(prompt),
      prompt,
      scene,
      createdAt: new Date().toISOString(),
      layerCount: scene.layers.length,
    }
    set((s) => {
      const conversations = [item, ...s.conversations].slice(0, MAX_CONVOS)
      persistConvos(conversations)
      return { conversations, log: [...s.log, `Saved to history: ${item.title}`] }
    })
    return item
  },

  loadConversation: (id) => set((s) => {
    const c = s.conversations.find((x) => x.id === id)
    if (!c) return { log: [...s.log, 'That history item is gone.'] }
    try {
      const valid = validateScene(normalizeScene(c.scene))
      try { localStorage.setItem(LAST_KEY, JSON.stringify(valid)) } catch { /* ignore */ }
      try { localStorage.setItem(ACTIVE_KEY, id) } catch { /* ignore */ }
      return { scene: valid, sceneRev: s.sceneRev + 1, past: [...s.past, s.scene].slice(-50), future: [], selectedLayerId: null, activeConvoId: id, log: [...s.log, `Loaded: ${c.title}`] }
    } catch (e) {
      return { log: [...s.log, `Could not load history item: ${e.message}`] }
    }
  }),

  deleteConversation: (id) => set((s) => {
    const gone = s.conversations.find((x) => x.id === id)
    const conversations = s.conversations.filter((x) => x.id !== id)
    persistConvos(conversations)
    let trash = s.trash || []
    if (gone) { trash = stashTrashItem(trash, gone); persistTrash(trash) }
    if (s.activeConvoId !== id) return { conversations, trash }
    try { localStorage.removeItem(ACTIVE_KEY) } catch { /* ignore */ }
    return { conversations, trash, activeConvoId: null }
  }),

  renameConversation: (id, title) => set((s) => {
    const conversations = s.conversations.map((x) => (x.id === id ? { ...x, title: String(title).trim().slice(0, 80) || x.title } : x))
    persistConvos(conversations)
    return { conversations }
  }),

  // ---- Sequence (multi-slide playlist) ----
  // Items hold a validated scene snapshot, so deleting or renaming a
  // history conversation never breaks the sequence. convoId is only a
  // back-link for display. Scenes can carry data: URLs (images, audio,
  // fonts), so disk persistence is best-effort under quota.
  seqMode: false,
  setSeqMode: (on) => set({ seqMode: !!on }),
  sequence: loadSequence(),
  editingSeqId: null,
  setEditingSeqId: (id) => set({ editingSeqId: id || null }),
  seqSelectedId: null,
  setSeqSelectedId: (id) => set({ seqSelectedId: id || null }),
  addSeqItem: (convo, atIndex) => set((s) => {
    if (!convo?.scene) return { log: [...s.log, 'That history item has no scene to sequence.'] }
    let scene = null
    try { scene = validateScene(normalizeScene(convo.scene)) } catch (e) { return { log: [...s.log, `Could not sequence “${convo.title}”: ${e.message}`] } }
    const item = {
      id: `q_${Date.now().toString(36)}`,
      convoId: convo.id || null,
      name: convo.title || 'Untitled clip',
      scene,
      trimStart: 0, trimEnd: 0, gapAfter: 0,
    }
    const items = [...s.sequence.items]
    const at = atIndex == null ? items.length : Math.min(Math.max(0, atIndex), items.length)
    items.splice(at, 0, item)
    const sequence = { ...s.sequence, items }
    persistSequence(sequence)
    return { sequence, seqSelectedId: item.id, log: [...s.log, `Sequenced: ${item.name}`] }
  }),
  removeSeqItem: (id) => set((s) => {
    const sequence = { ...s.sequence, items: s.sequence.items.filter((x) => x.id !== id) }
    persistSequence(sequence)
    return { sequence, seqSelectedId: s.seqSelectedId === id ? null : s.seqSelectedId, editingSeqId: s.editingSeqId === id ? null : s.editingSeqId }
  }),
  moveSeqItem: (id, toIndex) => set((s) => {
    const items = [...s.sequence.items]
    const from = items.findIndex((x) => x.id === id)
    if (from < 0) return s
    const [item] = items.splice(from, 1)
    // toIndex is pre-removal (0..n, n = drop past the end): adjust for the
    // removal first, THEN clamp to the post-removal range. Clamping first
    // collapsed a forward drop to the end back onto the origin (e.g. clip
    // #1 -> end of a 2-clip reel silently no-opped).
    let to = Math.round(Number(toIndex))
    if (!Number.isFinite(to)) to = items.length
    if (from < to) to -= 1
    to = Math.min(Math.max(0, to), items.length)
    items.splice(to, 0, item)
    const sequence = { ...s.sequence, items }
    persistSequence(sequence)
    return { sequence }
  }),
  // Post-removal coords: `to` is the index in the array AFTER the dragged
  // item is out (what the rail insertion line shows). No adjustment needed.
  moveSeqItemTo: (id, to) => set((s) => {
    const items = [...s.sequence.items]
    const from = items.findIndex((x) => x.id === id)
    if (from < 0) return s
    const [item] = items.splice(from, 1)
    items.splice(Math.min(Math.max(0, to), items.length), 0, item)
    const sequence = { ...s.sequence, items }
    persistSequence(sequence)
    return { sequence }
  }),
  updateSeqItem: (id, patch) => set((s) => {
    const items = s.sequence.items.map((x) => (x.id === id ? { ...x, ...patch } : x))
    const sequence = { ...s.sequence, items }
    persistSequence(sequence)
    return { sequence }
  }),
  clearSequence: () => set((s) => {
    const sequence = { ...s.sequence, items: [], music: null }
    persistSequence(sequence)
    return { sequence, seqSelectedId: null, editingSeqId: null }
  }),
  setSeqMusic: (music) => set((s) => {
    const sequence = { ...s.sequence, music }
    persistSequence(sequence)
    return { sequence }
  }),

  upsertKeyframe: (id, frame, props) => set((s) => {
    const layers = s.scene.layers.map((l) => {
      if (l.id !== id) return l
      const ki = l.keyframes.findIndex((k) => k.frame === frame)
      const keyframes = ki >= 0
        ? l.keyframes.map((k, j) => (j === ki ? { ...k, properties: { ...k.properties, ...props } } : k))
        : [...l.keyframes, { frame, properties: props }].sort((a, b) => a.frame - b.frame)
      return { ...l, keyframes }
    })
    const scene = { ...s.scene, layers }
    persistScene(scene)
    return { scene, past: [...s.past, s.scene].slice(-50), future: [] }
  }),

  deleteKeyframe: (id, ki) => set((s) => {
    const layer = s.scene.layers.find((l) => l.id === id)
    if (!layer) return s
    if (layer.keyframes.length <= 1) return { log: [...s.log, 'A layer needs at least one keyframe.'] }
    const layers = s.scene.layers.map((l) => (l.id === id ? { ...l, keyframes: l.keyframes.filter((_, j) => j !== ki) } : l))
    const scene = { ...s.scene, layers }
    persistScene(scene)
    return { scene, past: [...s.past, s.scene].slice(-50), future: [] }
  }),

  datasets: [],
  attachDataset: (table) => set((s) => ({ datasets: [...s.datasets, table].slice(-5), log: [...s.log, `Attached ${table.name}: ${table.rows.length} rows.`] })),
  // Data updates keep the slot (id) so linked layers can refresh: only the
  // name/columns/rows change. Lineage is by id, so renames are safe.
  replaceDataset: (id, table) => set((s) => ({
    datasets: s.datasets.map((d) => (d.id === id ? { ...table, id } : d)),
    log: [...s.log, `Replaced dataset with ${table.name}: ${table.rows.length} rows.`],
  })),
  removeDataset: (id) => set((s) => ({ datasets: s.datasets.filter((d) => d.id !== id) })),

  images: [],
  attachImage: (img) => set((s) => ({ images: [...s.images, img].slice(-10), log: [...s.log, `Attached image ${img.name} (${img.width}x${img.height}).`] })),
  removeImage: (id) => set((s) => ({ images: s.images.filter((m) => m.id !== id) })),

  // Session audio assets (TTS wav/mp3, background music). Stored as data:
  // URLs so preview and MP4 export resolve the identical bytes.
  audios: [],
  attachAudio: (a) => set((s) => ({ audios: [...s.audios, a].slice(-10), log: [...s.log, `Attached audio ${a.name}.`] })),
  removeAudio: (id) => set((s) => ({ audios: s.audios.filter((a) => a.id !== id) })),

  setPrompt: (prompt) => set({ prompt }),
  setEditPrompt: (editPrompt) => set({ editPrompt }),
  pushLog: (msg) => set((s) => ({ log: [...s.log, msg] })),
}))
