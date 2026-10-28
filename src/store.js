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
      return { scene: next, past: [...s.past, s.scene].slice(-50), future: [], log: [...s.log, `Applied ${patch.length} patch op(s).`] }
    } catch (e) {
      return { log: [...s.log, `Patch failed: ${e.message}`] }
    }
  }),

  moveKeyframe: (id, ki, frame) => set((s) => ({
    scene: { ...s.scene, layers: s.scene.layers.map(l => (l.id === id ? { ...l, keyframes: l.keyframes.map((kk, j) => (j === ki ? { ...kk, frame } : kk)) } : l)) },
  })),
  commitKeyframes: (id, ki, frame) => set((s) => {
    const layers = s.scene.layers.map(l => (l.id === id ? { ...l, keyframes: l.keyframes.map((kk, j) => (j === ki ? { ...kk, frame } : kk)) } : l))
    return { scene: fitDurationOut({ ...s.scene, layers }), past: [...s.past, s.scene].slice(-50), future: [] }
  }),

  updateSceneField: (field, value) => set((s) => ({
    scene: { ...s.scene, [field]: value },
    past: [...s.past, s.scene].slice(-50),
    future: [],
  })),

  updateLayer: (id, fn) => set((s) => {
    const layers = s.scene.layers.map(l => (l.id === id ? fn(l) : l))
    return { scene: fitDurationOut({ ...s.scene, layers }), past: [...s.past, s.scene].slice(-50), future: [] }
  }),

  addLayer: (layer) => set((s) => {
    try {
      const clean = validateScene(normalizeScene({ ...s.scene, layers: [...s.scene.layers, layer] }))
      try { localStorage.setItem(LAST_KEY, JSON.stringify(clean)) } catch { /* ignore */ }
      return { scene: fitDurationOut(clean), past: [...s.past, s.scene].slice(-50), future: [], selectedLayerId: layer.id, log: [...s.log, `Added layer: ${layer.name}`] }
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
  selectedLayerId: null,

  selectLayer: (id) => set({ selectedLayerId: id || null }),

  // Empty string is a valid rename (blank title); only null/undefined
  // (a cancelled prompt) is a no-op.
  renameLayer: (id, name) => set((s) => {
    if (name === null || name === undefined) return s
    const clean = String(name).trim().slice(0, 80)
    const layers = s.scene.layers.map((l) => (l.id === id ? { ...l, name: clean } : l))
    return { scene: { ...s.scene, layers }, past: [...s.past, s.scene].slice(-50), future: [] }
  }),

  deleteLayer: (id) => set((s) => {
    if (!s.scene.layers.some((l) => l.id === id)) return s
    const layers = s.scene.layers.filter((l) => l.id !== id)
    return {
      scene: { ...s.scene, layers },
      past: [...s.past, s.scene].slice(-50),
      future: [],
      selectedLayerId: s.selectedLayerId === id ? null : s.selectedLayerId,
      log: [...s.log, 'Layer deleted.'],
    }
  }),

  addConversation: (prompt, scene) => set((s) => {
    const item = {
      id: `c_${Date.now().toString(36)}`,
      title: convoTitle(prompt),
      prompt,
      scene,
      createdAt: new Date().toISOString(),
      layerCount: scene.layers.length,
    }
    const conversations = [item, ...s.conversations].slice(0, MAX_CONVOS)
    persistConvos(conversations)
    return { conversations, log: [...s.log, `Saved to history: ${item.title}`] }
  }),

  loadConversation: (id) => set((s) => {
    const c = s.conversations.find((x) => x.id === id)
    if (!c) return { log: [...s.log, 'That history item is gone.'] }
    try {
      const valid = validateScene(normalizeScene(c.scene))
      try { localStorage.setItem(LAST_KEY, JSON.stringify(valid)) } catch { /* ignore */ }
      return { scene: valid, sceneRev: s.sceneRev + 1, past: [...s.past, s.scene].slice(-50), future: [], selectedLayerId: null, log: [...s.log, `Loaded: ${c.title}`] }
    } catch (e) {
      return { log: [...s.log, `Could not load history item: ${e.message}`] }
    }
  }),

  deleteConversation: (id) => set((s) => {
    const conversations = s.conversations.filter((x) => x.id !== id)
    persistConvos(conversations)
    return { conversations }
  }),

  renameConversation: (id, title) => set((s) => {
    const conversations = s.conversations.map((x) => (x.id === id ? { ...x, title: String(title).trim().slice(0, 80) || x.title } : x))
    persistConvos(conversations)
    return { conversations }
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
    return { scene: { ...s.scene, layers }, past: [...s.past, s.scene].slice(-50), future: [] }
  }),

  deleteKeyframe: (id, ki) => set((s) => {
    const layer = s.scene.layers.find((l) => l.id === id)
    if (!layer) return s
    if (layer.keyframes.length <= 1) return { log: [...s.log, 'A layer needs at least one keyframe.'] }
    const layers = s.scene.layers.map((l) => (l.id === id ? { ...l, keyframes: l.keyframes.filter((_, j) => j !== ki) } : l))
    return { scene: { ...s.scene, layers }, past: [...s.past, s.scene].slice(-50), future: [] }
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

  setPrompt: (prompt) => set({ prompt }),
  setEditPrompt: (editPrompt) => set({ editPrompt }),
  pushLog: (msg) => set((s) => ({ log: [...s.log, msg] })),
}))
