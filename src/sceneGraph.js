import { z } from 'zod'

export const KeyframeSchema = z.object({
  frame: z.number().int().min(0),
  properties: z.object({
    x: z.number().optional(),
    y: z.number().optional(),
    scale: z.number().optional(),
    opacity: z.number().min(0).max(1).optional(),
    rotation: z.number().optional(),
  }).passthrough(),
  easing: z.string().optional(),
})

export const LayerSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['bar_chart', 'line_chart', 'map_bubbles', 'pie_chart', 'area_chart', 'scatter_chart', 'histogram', 'waterfall', 'funnel_chart', 'radar_chart', 'surface_plot', 'text', 'vector_shape', 'sprite', 'image_layer']),
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().min(0),
  data: z.any().optional(),
  text: z.string().optional(),
  assetUrl: z.string().optional(),
  fontFamily: z.string().optional(),
  fontUrl: z.string().optional(),
  fontSize: z.number().optional(),
  color: z.string().optional(),
  orientation: z.string().optional(),
  showTitle: z.boolean().optional(),
  showLegend: z.boolean().optional(),
  keyframes: z.array(KeyframeSchema).min(1),
})

export const SceneGraphSchema = z.object({
  fps: z.number().int().min(1).max(120).default(30),
  durationInFrames: z.number().int().min(1).max(3600).default(300),
  width: z.number().int().default(1280),
  height: z.number().int().default(720),
  background: z.string().default('#10141d'),
  backgroundImage: z.string().optional(),
  backgroundImageOpacity: z.number().min(0).max(1).optional(),
  layers: z.array(LayerSchema),
})

export const defaultScene = {
  fps: 30,
  durationInFrames: 300,
  width: 1280,
  height: 720,
  background: '#10141d',
  layers: [
    {
      id: 'layer_01',
      name: 'Q3 Review Title',
      type: 'text',
      text: 'Q3 Review',
      startFrame: 0,
      endFrame: 120,
      keyframes: [
        { frame: 0, properties: { opacity: 0, scale: 0.8 } },
        { frame: 30, properties: { opacity: 1, scale: 1 }, easing: 'easeOutExpo' },
        { frame: 100, properties: { opacity: 1, scale: 1 } },
        { frame: 120, properties: { opacity: 0, scale: 1 } },
      ],
    },
    {
      id: 'layer_02',
      name: 'Q3 Revenue Chart',
      type: 'bar_chart',
      startFrame: 0,
      endFrame: 300,
      data: { labels: ['July', 'Aug', 'Sep'], values: [120, 180, 250] },
      keyframes: [
        { frame: 0, properties: { scale: 0, opacity: 0 } },
        { frame: 30, properties: { scale: 1, opacity: 1 }, easing: 'easeOutExpo' },
      ],
    },
    {
      id: 'layer_03',
      name: 'Bank Icon',
      type: 'vector_shape',
      assetUrl: '/assets/bank.svg',
      startFrame: 30,
      endFrame: 300,
      keyframes: [
        { frame: 30, properties: { x: 100, y: 500, scale: 0.5, opacity: 1 } },
        { frame: 60, properties: { x: 500, y: 500, scale: 1.5, opacity: 1 }, easing: 'easeInOutCubic' },
      ],
    },
  ],
}

export function validateScene(scene) {
  return SceneGraphSchema.parse(scene)
}

const TYPE_ALIASES = {
  barchart: 'bar_chart', bar: 'bar_chart', bars: 'bar_chart',
  linechart: 'line_chart', line: 'line_chart', lines: 'line_chart', chart: 'bar_chart',
  text: 'text', title: 'text', heading: 'text', label: 'text',
  vector: 'vector_shape', vectorshape: 'vector_shape', svg: 'vector_shape', shape: 'vector_shape', icon: 'vector_shape',
  sprite: 'sprite', character: 'sprite', walk: 'sprite', person: 'vector_shape',
  map: 'map_bubbles', bubble: 'map_bubbles', bubbles: 'map_bubbles', bubblemap: 'map_bubbles', geomap: 'map_bubbles',
  pie: 'pie_chart', donut: 'pie_chart', doughnut: 'pie_chart', area: 'area_chart',
  scatter: 'scatter_chart', scatterplot: 'scatter_chart', histogram: 'histogram',
  waterfall: 'waterfall', funnel: 'funnel_chart', radar: 'radar_chart', spider: 'radar_chart',
  surface: 'surface_plot',
  image: 'image_layer', image_layer: 'image_layer', picture: 'image_layer', photo: 'image_layer',
}
const num = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// Chart numbers must be finite: an LLM hand-transcribing a table can emit
// blanks or words inside values/series, which poison Math.max into NaN and
// blank the whole chart (the classic "NaN and no real data"). Coerce here
// — every generation passes through normalize — so renderers stay simple.
const finiteNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
function sanitizeLayerData(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return d
  const out = { ...d }
  if (Array.isArray(d.labels)) out.labels = d.labels.map((l) => String(l ?? ''))
  if (Array.isArray(d.values)) out.values = d.values.map(finiteNum)
  if (Array.isArray(d.series)) {
    out.series = d.series.map((s) => (s && typeof s === 'object'
      ? { ...s, label: String(s.label ?? ''), values: Array.isArray(s.values) ? s.values.map(finiteNum) : [] }
      : s))
  }
  if (Array.isArray(d.pointColors)) out.pointColors = d.pointColors.map((c) => String(c ?? ''))
  return out
}

// LLMs rarely return the schema verbatim: camelCase types, numeric strings,
// missing ids or empty keyframes. Normalize first so validation judges the
// intent, not the formatting — anything still invalid is reported, not
// silently dropped (a dropped scene is what "generated but nothing shows" was).
export function normalizeScene(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Scene is not an object.')
  const src = raw.scene && typeof raw.scene === 'object' ? raw.scene : raw
  const fps = Math.min(120, Math.max(1, Math.round(num(src.fps, 30))))
  const durationInFrames = Math.min(3600, Math.max(1, Math.round(num(src.durationInFrames, 300))))
  const width = Math.round(num(src.width, 1280)) || 1280
  const height = Math.round(num(src.height, 720)) || 720
  const layers = (Array.isArray(src.layers) ? src.layers : []).map((l, i) => {
    const o = l && typeof l === 'object' ? l : {}
    const typeKey = String(o.type || '').toLowerCase().replace(/[\s_-]+/g, '')
    const startFrame = Math.max(0, Math.round(num(o.startFrame, 0)))
    const endFrame = Math.max(startFrame + 1, Math.round(num(o.endFrame, durationInFrames)))
    let keyframes = Array.isArray(o.keyframes) ? o.keyframes : []
    keyframes = keyframes.map((k) => {
      const ko = k && typeof k === 'object' ? k : {}
      const props = ko.properties && typeof ko.properties === 'object' ? ko.properties : {}
      const clean = {}
      for (const key of ['x', 'y', 'scale', 'opacity', 'rotation', 'fontSize']) {
        if (props[key] !== undefined && props[key] !== null && props[key] !== '') {
          const n = Number(props[key])
          if (Number.isFinite(n)) clean[key] = key === 'opacity' ? Math.min(1, Math.max(0, n)) : n
        }
      }
      return { frame: Math.max(0, Math.round(num(ko.frame, startFrame))), properties: clean, ...(ko.easing ? { easing: String(ko.easing) } : {}) }
    })
    if (!keyframes.length) {
      keyframes = [
        { frame: startFrame, properties: { opacity: 0 } },
        { frame: Math.min(startFrame + 30, endFrame), properties: { opacity: 1 } },
      ]
    }
    return {
      id: String(o.id || `layer_${i + 1}`),
      // A deliberately blanked name ('') must survive: it means "no title".
      // Only fall back when the name is actually missing.
      name: o.name === undefined || o.name === null ? String(o.text || `Layer ${i + 1}`) : String(o.name).slice(0, 80),
      type: TYPE_ALIASES[typeKey] || o.type,
      startFrame,
      endFrame,
      ...(o.data !== undefined ? { data: sanitizeLayerData(o.data) } : {}),
      ...(o.text !== undefined ? { text: String(o.text) } : {}),
      ...(o.assetUrl ? { assetUrl: String(o.assetUrl) } : {}),
      ...(o.fontFamily ? { fontFamily: String(o.fontFamily) } : {}),
      // Custom embedded fonts (1001Fonts / uploads) travel on the layer as
      // a data: URL so preview and MP4 export resolve the identical file.
      ...(typeof o.fontUrl === 'string' && o.fontUrl.startsWith('data:') && o.fontUrl.length <= 12000000 ? { fontUrl: o.fontUrl } : {}),
      ...(o.fontSize !== undefined && Number.isFinite(Number(o.fontSize)) ? { fontSize: Number(o.fontSize) } : {}),
      ...(o.color ? { color: String(o.color) } : {}),
      ...(o.orientation ? { orientation: String(o.orientation) } : {}),
      ...(o.showTitle === false ? { showTitle: false } : {}),
      ...(o.showLegend === false ? { showLegend: false } : {}),
      keyframes,
    }
  })
  const background = typeof src.background === 'string' && src.background.trim() ? src.background.trim() : '#10141d'
  const backgroundImage = typeof src.backgroundImage === 'string' && src.backgroundImage ? src.backgroundImage : undefined
  const bgOp = Number(src.backgroundImageOpacity)
  return { fps, durationInFrames, width, height, background, ...(backgroundImage ? { backgroundImage } : {}), ...(Number.isFinite(bgOp) ? { backgroundImageOpacity: Math.min(1, Math.max(0, bgOp)) } : {}), layers }
}

// Per-chart animation defaults: [staggerFrames, revealFrames]. Reveal is how
// long each point takes to grow; stagger is the delay between consecutive
// points. data.reveal / data.stagger override these per layer.
// bar_chart default reveal is null = follow the keyframe span.
export const TIMING_DEFAULTS = {
  bar_chart: [3, null], line_chart: [0, 60], map_bubbles: [2, 24],
  pie_chart: [5, 22], area_chart: [0, 60], scatter_chart: [2, 16],
  histogram: [1.5, 18], waterfall: [4, 20], funnel_chart: [5, 22],
  radar_chart: [0, 50], surface_plot: [3, 22],
}

export function effectiveTiming(layer) {
  const d = layer.data || {}
  const n = d.values?.length || d.series?.[0]?.values?.length || d.labels?.length || d.bubbles?.length || 1
  const k0 = layer.keyframes[0]?.frame ?? 0
  const k1 = layer.keyframes[1]?.frame ?? (k0 + 30)
  const span = Math.max(1, k1 - k0)
  const [defStagger, defDur] = TIMING_DEFAULTS[layer.type] || [3, 22]
  const rawR = Number(d.reveal), rawS = Number(d.stagger)
  const dur = Number.isFinite(rawR) ? Math.max(4, Math.min(600, rawR))
    : (defDur == null ? span : defDur)
  const stagger = Number.isFinite(rawS) ? Math.max(0, Math.min(60, rawS)) : defStagger
  return { k0, dur, stagger, total: dur + stagger * Math.max(0, n - 1) }
}

// Minimal JSON-patch apply: supports add/replace/remove with /layers/N/... paths
export function applyPatch(scene, patch) {
  const next = JSON.parse(JSON.stringify(scene))
  for (const op of patch) {
    const parts = op.path.split('/').filter(Boolean).map(p => (/^\d+$/.test(p) ? Number(p) : p))
    let target = next
    for (let i = 0; i < parts.length - 1; i++) {
      target = target[parts[i]]
      if (target === undefined) throw new Error(`Bad patch path: ${op.path}`)
    }
    const last = parts[parts.length - 1]
    if (op.op === 'replace' || op.op === 'add') {
      if (Array.isArray(target) && typeof last === 'number' && op.op === 'add') target.splice(last, 0, op.value)
      else target[last] = op.value
    } else if (op.op === 'remove') {
      if (Array.isArray(target)) target.splice(last, 1)
      else delete target[last]
    } else {
      throw new Error(`Unsupported op ${op.op}`)
    }
  }
  return SceneGraphSchema.parse(next)
}

export function lerpKeyframes(keyframes, frame) {
  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame)
  if (frame <= sorted[0].frame) return sorted[0].properties
  if (frame >= sorted[sorted.length - 1].frame) return sorted[sorted.length - 1].properties
  let a = sorted[0], b = sorted[sorted.length - 1]
  for (let i = 0; i < sorted.length - 1; i++) {
    if (frame >= sorted[i].frame && frame <= sorted[i + 1].frame) { a = sorted[i]; b = sorted[i + 1]; break }
  }
  const span = Math.max(1, b.frame - a.frame)
  let t = (frame - a.frame) / span
  const easing = b.easing || 'linear'
  if (easing === 'easeOutExpo') t = t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)
  else if (easing === 'easeInOutCubic') t = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  else if (easing === 'easeOutCubic') t = 1 - Math.pow(1 - t, 3)
  else if (easing === 'easeInCubic') t = t * t * t
  else if (easing === 'easeOutBack') { const c = 1.70158; t = 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2) }
  const keys = new Set([...Object.keys(a.properties), ...Object.keys(b.properties)])
  const out = {}
  for (const k of keys) {
    const av = a.properties[k] ?? b.properties[k] ?? (k === 'opacity' || k === 'scale' ? 1 : 0)
    const bv = b.properties[k] ?? av
    out[k] = av + (bv - av) * t
  }
  return out
}
