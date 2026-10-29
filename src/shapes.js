// Parametric vector shapes: geometry in pixel space (no viewBox scaling
// tricks), so stroke widths and label font sizes are exact canvas pixels.
// The renderer applies fill/stroke; this module only describes geometry.

export const SHAPE_GROUPS = [
  { id: 'basic', label: 'Basic' },
  { id: 'flow', label: 'Flowchart' },
  { id: 'arrows', label: 'Arrows & highlights' },
]

export const SHAPE_KINDS = [
  { id: 'rect', label: 'Rectangle / Square', group: 'basic', defW: 420, defH: 260 },
  { id: 'roundrect', label: 'Rounded rectangle', group: 'basic', defW: 420, defH: 260 },
  { id: 'ellipse', label: 'Ellipse / Circle', group: 'basic', defW: 380, defH: 260 },
  { id: 'triangle', label: 'Triangle', group: 'basic', defW: 360, defH: 300 },
  { id: 'diamond', label: 'Diamond', group: 'basic', defW: 360, defH: 300 },
  { id: 'pentagon', label: 'Pentagon', group: 'basic', defW: 320, defH: 300 },
  { id: 'hexagon', label: 'Hexagon', group: 'basic', defW: 380, defH: 300 },
  { id: 'parallelogram', label: 'Parallelogram', group: 'basic', defW: 420, defH: 260 },
  { id: 'trapezoid', label: 'Trapezoid', group: 'basic', defW: 420, defH: 260 },
  { id: 'star', label: 'Star', group: 'basic', defW: 300, defH: 300 },
  { id: 'process', label: 'Process', group: 'flow', defW: 420, defH: 240 },
  { id: 'terminator', label: 'Terminator', group: 'flow', defW: 420, defH: 200 },
  { id: 'decision', label: 'Decision', group: 'flow', defW: 360, defH: 300 },
  { id: 'document', label: 'Document', group: 'flow', defW: 400, defH: 280 },
  { id: 'data', label: 'Data I/O', group: 'flow', defW: 420, defH: 240 },
  { id: 'arrow-right', label: 'Arrow →', group: 'arrows', defW: 440, defH: 240 },
  { id: 'arrow-left', label: 'Arrow ←', group: 'arrows', defW: 440, defH: 240 },
  { id: 'arrow-up', label: 'Arrow ↑', group: 'arrows', defW: 240, defH: 420 },
  { id: 'arrow-down', label: 'Arrow ↓', group: 'arrows', defW: 240, defH: 420 },
  { id: 'chevron', label: 'Chevron', group: 'arrows', defW: 360, defH: 240 },
  { id: 'callout', label: 'Callout', group: 'arrows', defW: 440, defH: 300 },
  { id: 'ring', label: 'Highlight ring', group: 'arrows', defW: 300, defH: 300 },
]

export const SHAPE_IDS = new Set(SHAPE_KINDS.map((k) => k.id))
export const shapeKind = (id) => SHAPE_KINDS.find((k) => k.id === id) || SHAPE_KINDS[0]

function poly(points) {
  return { el: 'polygon', points: points.map((p) => `${r1(p[0])},${r1(p[1])}`).join(' ') }
}
const r1 = (n) => Math.round(n * 10) / 10

function ngon(cx, cy, rx, ry, n, rotDeg = -90) {
  const pts = []
  for (let i = 0; i < n; i++) {
    const a = ((rotDeg + (360 / n) * i) * Math.PI) / 180
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])
  }
  return pts
}

// Geometry only (no paint): the renderer applies fill / stroke / width.
// Returns an array of element descriptors: {el, ...attrs}.
export function shapeParts(kind, w, h, r) {
  const W = Math.max(20, Number(w) || 300)
  const H = Math.max(20, Number(h) || 200)
  const cx = W / 2, cy = H / 2
  switch (kind) {
    case 'roundrect': {
      const rx = r ?? Math.min(W, H) * 0.18
      return [{ el: 'rect', x: 0, y: 0, width: W, height: H, rx }]
    }
    case 'ellipse':
      return [{ el: 'ellipse', cx, cy, rx: W / 2, ry: H / 2 }]
    case 'triangle':
      return [poly([[cx, 0], [W, H], [0, H]])]
    case 'diamond':
    case 'decision':
      return [poly([[cx, 0], [W, cy], [cx, H], [0, cy]])]
    case 'pentagon':
      return [poly(ngon(cx, cy, W / 2, H / 2, 5))]
    case 'hexagon':
      return [poly(ngon(cx, cy, W / 2, H / 2, 6, 0))]
    case 'parallelogram':
    case 'data': {
      const s = W * 0.22
      return [poly([[s, 0], [W, 0], [W - s, H], [0, H]])]
    }
    case 'trapezoid': {
      const t = W * 0.2
      return [poly([[t, 0], [W - t, 0], [W, H], [0, H]])]
    }
    case 'star': {
      const pts = []
      const R = Math.min(W, H) / 2
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 === 0 ? R : R * 0.45
        const a = (-90 + i * 36) * (Math.PI / 180)
        pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)])
      }
      return [poly(pts)]
    }
    case 'terminator':
      return [{ el: 'rect', x: 0, y: 0, width: W, height: H, rx: H / 2 }]
    case 'document':
      return [{
        el: 'path',
        d: `M0 0 H${r1(W)} V${r1(H * 0.78)} `
          + `C${r1(W * 0.82)} ${r1(H * 0.92)} ${r1(W * 0.68)} ${r1(H * 0.68)} ${r1(W * 0.5)} ${r1(H * 0.8)} `
          + `C${r1(W * 0.34)} ${r1(H * 0.92)} ${r1(W * 0.2)} ${r1(H * 0.7)} 0 ${r1(H * 0.8)} Z`,
      }]
    case 'arrow-right':
      return [poly([[0, H * 0.3], [W * 0.62, H * 0.3], [W * 0.62, 0], [W, cy], [W * 0.62, H], [W * 0.62, H * 0.7], [0, H * 0.7]])]
    case 'arrow-left':
      return [{ ...poly([[0, H * 0.3], [W * 0.62, H * 0.3], [W * 0.62, 0], [W, cy], [W * 0.62, H], [W * 0.62, H * 0.7], [0, H * 0.7]]), transform: `translate(${r1(W)} 0) scale(-1 1)` }]
    case 'arrow-up':
      return [poly([[W * 0.3, H], [W * 0.3, H * 0.62], [0, H * 0.62], [cx, 0], [W, H * 0.62], [W * 0.7, H * 0.62], [W * 0.7, H]])]
    case 'arrow-down':
      return [poly([[W * 0.3, 0], [W * 0.3, H * 0.38], [0, H * 0.38], [cx, H], [W, H * 0.38], [W * 0.7, H * 0.38], [W * 0.7, 0]])]
    case 'chevron':
      return [poly([[0, 0], [W * 0.55, 0], [W, cy], [W * 0.55, H], [0, H], [W * 0.45, cy]])]
    case 'callout': {
      const rx = r ?? Math.min(W, H) * 0.08
      const bh = H * 0.76
      return [
        { el: 'rect', x: 0, y: 0, width: W, height: bh, rx },
        poly([[W * 0.18, bh - 1], [W * 0.38, bh - 1], [W * 0.2, H]]),
      ]
    }
    case 'ring':
      return [{ el: 'ellipse', cx, cy, rx: W / 2, ry: H / 2 }]
    case 'process':
    case 'rect':
    default:
      return [{ el: 'rect', x: 0, y: 0, width: W, height: H }]
  }
}
