import React from 'react'
import { AbsoluteFill, interpolate, useCurrentFrame, useRemotionEnvironment, delayRender, continueRender } from 'remotion'
import { lerpKeyframes, effectiveTiming } from '../sceneGraph.js'
import { webFontFamilies, fontCssUrl, addMirrorLinks, cleanFamily, customFontFaces, injectCustomFont, fontStack } from '../fonts.js'
import { MAP_W, MAP_H, project } from '../geo.js'

// Headless renders use a fresh browser profile with no cached webfonts, and
// the App-side loader never runs there — without this, every MP4 falls back
// to a default font (wrong metrics also shift centered text). During renders
// only, inject the scene's font CSS and hold each frame until the faces are
// ready (15s safety cap, then render with fallbacks). Player unaffected.
function FontGate({ scene }) {
  const env = useRemotionEnvironment()
  const fams = React.useMemo(() => webFontFamilies(scene?.layers), [scene])
  // Custom embedded fonts (1001Fonts / uploads) ride on the layers as data:
  // URLs — injected as @font-face below, never via a Google css2 request.
  const customs = React.useMemo(() => customFontFaces(scene?.layers), [scene])
  const key = `${fams.join('|')}~${customs.map((c) => c.name).join('|')}`
  const [handle] = React.useState(() => (env.isRendering && (fams.length || customs.length) ? delayRender('webfonts') : null))
  const doneRef = React.useRef(false)
  const finish = (h) => { if (!doneRef.current) { doneRef.current = true; try { continueRender(h) } catch { /* already continued */ } } }
  React.useEffect(() => {
    if (!env.isRendering || handle === null) return undefined
    let cancelled = false
    try {
      // The headless render runs in a fresh browser profile: no localStorage,
      // so the preview's per-family mirror routing doesn't survive. Inject
      // BOTH CDNs for every family instead — whichever answers wins, and a
      // family blocked on googleapis still resolves via the mirror.
      if (fams.length) {
        let link = document.getElementById('vs-render-fonts')
        if (!link) {
          link = document.createElement('link')
          link.id = 'vs-render-fonts'
          link.rel = 'stylesheet'
          document.head.appendChild(link)
        }
        link.href = fontCssUrl(fams)
      }
      for (const f of fams) {
        const slug = cleanFamily(f).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        if (slug) addMirrorLinks(f, `vs-render-font-${slug}`)
      }
    } catch { finish(handle); return undefined }
    for (const c of customs) injectCustomFont(c.name, c.url)
    const loads = [
      ...fams.map((f) => (
        document.fonts.load(`400 32px "${f}"`).then(() => document.fonts.load(`800 32px "${f}"`)).catch(() => {})
      )),
      ...customs.map((c) => (
        document.fonts.load(`400 32px "${c.name}"`).then(() => document.fonts.load(`800 32px "${c.name}"`)).catch(() => {})
      )),
    ]
    Promise.all(loads).then(() => document.fonts.ready.catch(() => {}))
      .then(() => { if (!cancelled) finish(handle) })
    const t = setTimeout(() => { if (!cancelled) finish(handle) }, 15000)
    return () => { cancelled = true; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.isRendering, handle, key])
  return null
}

// Stacked bars share the bar_chart type: data.series (one entry per stack
// segment) replaces data.values. Whole bars stagger in like grouped bars;
// segments within a bar are proportional slices of the grown height.
function StackedBars({ layer, frame, horizontal }) {
  const { labels = [], series = [], legend = [] } = layer.data || {}
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (Number(s.values?.[i]) || 0), 0))
  const max = Math.max(1, ...totals)
  const t = effectiveTiming(layer)
  const autoLegend = legend.length ? legend : series.map((s) => ({ label: s.label, color: s.color }))
  if (horizontal) {
    return (
      <div style={{ width: 1280, height: 720, padding: 48, display: 'flex', flexDirection: 'column' }}>
        {showT(layer) && <div style={{ fontSize: 34, fontWeight: 700, marginBottom: 16, ...titleFont(layer) }}>{layer.name}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0, justifyContent: 'center' }}>
          {labels.map((lb, i) => {
            const e = pointEOA(frame, t, i)
            const total = totals[i]
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 200, textAlign: 'right', fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lb ?? `G${i + 1}`}</div>
                <div style={{ flex: 1, height: 30, background: 'rgba(255,255,255,0.07)', borderRadius: 8, display: 'flex', overflow: 'hidden' }}>
                  {series.map((s, si) => {
                    const v = Number(s.values?.[i]) || 0
                    return v > 0 ? <div key={si} title={`${s.label}: ${fmtNum(v * e)}`} style={{ width: `${Math.max(0, (v / max) * 100 * e)}%`, height: '100%', background: s.color || CHART_PALETTE[si % CHART_PALETTE.length] }} /> : null
                  })}
                </div>
                <div style={{ width: 90, fontSize: 15, opacity: 0.85 }}>{fmtNum(total * e)}</div>
              </div>
            )
          })}
        </div>
        {showL(layer) && <Legend items={autoLegend} />}
      </div>
    )
  }
  const small = labels.length > 8
  return (
    <div style={{ width: 1280, height: 720, padding: 48, display: 'flex', flexDirection: 'column' }}>
      {showT(layer) && <div style={{ fontSize: 34, fontWeight: 700, marginBottom: 16, ...titleFont(layer) }}>{layer.name}</div>}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flex: 1, minHeight: 0 }}>{
        labels.map((lb, i) => {
          const e = pointEOA(frame, t, i)
          return (
            <div key={i} style={{ textAlign: 'center', flex: '1 1 0', minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              <div style={{ width: '100%', maxWidth: 110, margin: '0 auto', height: `min(100%, ${Math.max(0, (totals[i] / max) * 100 * e)}%)`, borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column-reverse' }}>
                {[...series].reverse().map((s, ri) => {
                  const si = series.length - 1 - ri
                  const v = Number(s.values?.[i]) || 0
                  return v > 0 ? <div key={si} title={`${s.label}: ${fmtNum(v)}`} style={{ height: `${(v / Math.max(1e-9, totals[i])) * 100}%`, background: s.color || CHART_PALETTE[si % CHART_PALETTE.length] }} /> : null
                })}
              </div>
              <div style={{ marginTop: 8, fontSize: small ? 12 : 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lb ?? `G${i + 1}`}</div>
              {!small && <div style={{ fontSize: 16, opacity: 0.8 }}>{fmtNum(totals[i] * e)}</div>}
            </div>
          )
        })}
      </div>
      {showL(layer) && <Legend items={autoLegend} />}
    </div>
  )
}
function BarChart({ layer, frame }) {
  const { labels = [], values = [], pointColors = [], legend = [], series = [] } = layer.data || {}
  if (series.length) return <StackedBars layer={layer} frame={frame} horizontal={layer.orientation === 'horizontal'} />
  const max = Math.max(1, ...values)
  const bT = effectiveTiming(layer)
  const small = values.length > 8
  if (layer.orientation === 'horizontal') {
    const hT = effectiveTiming(layer)
    return (
      <div style={{ width: 1280, height: 720, padding: 48, display: 'flex', flexDirection: 'column' }}>
        {showT(layer) && <div style={{ fontSize: 34, fontWeight: 700, marginBottom: 16, ...titleFont(layer) }}>{layer.name}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0, justifyContent: 'center' }}>
          {values.map((v, i) => {
            const e = pointEOA(frame, hT, i)
            const pct = Math.max(0, (v / max) * 100 * e)
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 200, textAlign: 'right', fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{labels[i] ?? `M${i + 1}`}</div>
                <div style={{ flex: 1, height: 30, background: 'rgba(255,255,255,0.07)', borderRadius: 8 }}>
                  <div style={{ width: `${Math.max(v > 0 ? 2 : 0, pct)}%`, height: '100%', background: pointColors[i] || 'linear-gradient(90deg,#4da3ff,#1e56c8)', borderRadius: 8 }} />
                </div>
                <div style={{ width: 90, fontSize: 15, opacity: 0.85 }}>{fmtNum(v * e)}</div>
              </div>
            )
          })}
        </div>
        {showL(layer) && <Legend items={legend} />}
      </div>
    )
  }
  // Full-canvas placement: the chart owns the whole 1280x720 frame so data
  // is big by default instead of floating in a corner. Each bar grows on
  // its own staggered clock (like the horizontal orientation), so the
  // Stagger slider separates bars instead of just slowing a shared wipe.
  return (
    <div style={{ width: 1280, height: 720, padding: 48, display: 'flex', flexDirection: 'column' }}>
      {showT(layer) && <div style={{ fontSize: 34, fontWeight: 700, marginBottom: 16, ...titleFont(layer) }}>{layer.name}</div>}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flex: 1, minHeight: 0 }}>{
        values.map((v, i) => {
          const e = pointEOA(frame, bT, i)
          return (
          <div key={i} style={{ textAlign: 'center', flex: '1 1 0', minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
            <div style={{
              width: '100%', maxWidth: 110, margin: '0 auto', height: `min(100%, ${Math.max(2, (v / max) * 100 * e)}%)`,
              background: pointColors[i] || 'linear-gradient(180deg,#4da3ff,#1e56c8)', borderRadius: 10,
              transition: 'none',
            }} />
            <div style={{ marginTop: 8, fontSize: small ? 12 : 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{labels[i] ?? `M${i + 1}`}</div>
            {!small && <div style={{ fontSize: 16, opacity: 0.8 }}>${Math.round(v * e).toLocaleString()}</div>}
          </div>
          )
        })}
      </div>
      {showL(layer) && <Legend items={legend} />}
    </div>
  )
}

function Legend({ items }) {
  if (!items?.length) return null
  return (
    <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 14, flexWrap: 'wrap' }}>
      {items.map((it, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: it.color, display: 'inline-block' }} />{it.label}
        </span>
      ))}
    </div>
  )
}

function LineChart({ layer, frame }) {
  const { labels = [], values = [], pointColors = [], legend = [], series = [] } = layer.data || {}
  // Multi-series time data (one line per row over period labels); otherwise
  // the classic single line. Every value coerces through Number — a stray
  // non-numeric would otherwise poison Math.max into NaN and blank the chart.
  const multi = series.length > 0 && series.every((s) => Array.isArray(s.values))
  const nums = multi ? series.flatMap((s) => s.values.map((v) => Number(v) || 0)) : values.map((v) => Number(v) || 0)
  const max = Math.max(1, ...nums)
  const lT = effectiveTiming(layer)
  const progress = masterP(frame, lT)
  const n = multi ? labels.length : values.length
  const X = (i) => (i / Math.max(1, n - 1)) * 900 + 60
  const Y = (v) => 320 - ((Number(v) || 0) / max) * 260
  // Draws left-to-right: values grow in place while a wipe reveals the line.
  // Points hold their final positions (stationary) — the wipe reveals them
  // left-to-right and dots pop in sequence, instead of rising from the base.
  const lines = multi
    ? series.map((s, si) => ({ pts: s.values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' '), color: s.color || CHART_PALETTE[si % CHART_PALETTE.length] }))
    : [{ pts: values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' '), color: '#4da3ff' }]
  const autoLegend = legend.length ? legend : multi ? series.map((s, i) => ({ label: s.label, color: s.color || CHART_PALETTE[i % CHART_PALETTE.length] })) : legend
  // Draw mode: 'connect' pops the dots first, then draws each segment
  // between two popped dots (dash draw keyed to the later dot's pop,
  // with a small lead so dots visibly precede their segment).
  // Default is the left-to-right wipe revealing the whole line at once.
  const connect = layer.data?.drawMode === 'connect'
  const segE = (a, b) => { const m = Math.min(a, b); return m <= 0 ? 0 : Math.min(1, (m - 0.15) / 0.85) }
  const step = Math.max(1, Math.ceil(labels.length / 10))
  return (
    <div style={{ width: 1280, height: 720, padding: 48, display: 'flex', flexDirection: 'column' }}>
      {showT(layer) && <div style={{ fontSize: 34, fontWeight: 700, marginBottom: 16, ...titleFont(layer) }}>{layer.name}</div>}
      <div style={connect ? { flex: 1, minHeight: 0 } : { clipPath: `inset(0 ${(1 - progress) * 100}% 0 0)`, flex: 1, minHeight: 0 }}>
        <svg viewBox="0 0 1020 380" width="100%" height="100%" preserveAspectRatio="none" style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 12, display: 'block' }}>
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line x1={60} y1={320 - f * 260} x2={1000} y2={320 - f * 260} stroke="rgba(255,255,255,0.12)" />
              <text x={54} y={324 - f * 260} textAnchor="end" fill="#fff" fontSize={13} opacity={0.6}>{fmtAxis(max * f, layer.data?.yFormat, max)}</text>
            </g>
          ))}
          <line x1={60} y1={320} x2={1000} y2={320} stroke="rgba(255,255,255,0.35)" strokeWidth={2} />
          {lines.map((L, si) => {
            const vals = multi ? series[si].values : values
            return (
              <g key={si}>
                {!connect && <polyline points={L.pts} fill="none" stroke={L.color} strokeWidth={6} strokeLinejoin="round" />}
                {connect && vals.slice(0, -1).map((v, i) => {
                  const e = segE(pointEOA(frame, lT, i), pointEOA(frame, lT, i + 1))
                  const x1 = X(i), y1 = Y(v), x2 = X(i + 1), y2 = Y(vals[i + 1])
                  const len = Math.hypot(x2 - x1, y2 - y1) || 1
                  return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={L.color} strokeWidth={6} strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - e)} />
                })}
                {vals.map((v, i) => (
                  <circle key={`d${i}`} cx={X(i)} cy={Y(v)} r={n > 12 ? 6 : 10} fill={multi ? L.color : (pointColors[i] || '#4da3ff')} opacity={pointEOA(frame, lT, i)} />
                ))}
              </g>
            )
          })}
        </svg>
      </div>
      {showL(layer) && <Legend items={autoLegend} />}
      {!!labels.length && (
        <div style={{ display: 'flex', marginTop: 6, fontSize: 13, opacity: 0.8 }}>
          {labels.map((lb, i) => (i % step === 0 || i === labels.length - 1 ? (
            <div key={i} style={{ flex: '1 1 0', textAlign: i === 0 ? 'left' : 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(lb).slice(0, 14)}</div>
          ) : <div key={i} style={{ flex: '1 1 0' }} />))}
        </div>
      )}
    </div>
  )
}

function fmtVal(v) {
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  return `${Math.round(v).toLocaleString()}`
}
// fmtNum was referenced by BarChart/Scatter/Pie/Waterfall/Funnel but never
// defined — that ReferenceError crashed the whole Player (warning triangle).
// Axis tick formatting: units requested via prompts ("y-axis in $M") live in
// data.yFormat. $M/$k divide only when the data actually needs it (max at
// least a million/thousand), so values already expressed in millions still
// read correctly ("$34.5M" either way).
function fmtAxis(v, fmt, max) {
  const r1 = (x) => { const r = Math.round(x * 10) / 10; return Number.isInteger(r) ? String(r) : String(r) }
  if (fmt === '$M') { const d = Math.abs(max) >= 1e6 ? v / 1e6 : v; return `$${r1(d)}M` }
  if (fmt === '$k') { const d = Math.abs(max) >= 1e3 ? v / 1e3 : v; return `$${r1(d)}k` }
  if (fmt === 'k') { const d = Math.abs(max) >= 1e3 ? v / 1e3 : v; return `${r1(d)}k` }
  if (fmt === '%') return `${r1(v)}%`
  return fmtVal(v)
}
const fmtNum = fmtVal

function MapBubbles({ layer, frame }) {
  const { bubbles = [], legend = [], metric = '' } = layer.data || {}
  const max = Math.max(1, ...bubbles.map((b) => b.value))
  const mT = effectiveTiming(layer)
  const ordered = [...bubbles].sort((a, b) => b.value - a.value)
  const lons = []
  for (let lo = -180; lo <= 180; lo += 20) lons.push(lo)
  const lats = []
  for (let la = -60; la <= 80; la += 20) lats.push(la)
  const gridTop = project(82, 0).y, gridBottom = project(-62, 0).y
  const gridLeft = project(0, -180).x, gridRight = project(0, 180).x
  return (
    <div style={{ width: MAP_W, height: MAP_H, padding: 48, display: 'flex', flexDirection: 'column' }}>
      {showT(layer) && <div style={{ fontSize: 34, fontWeight: 700, ...titleFont(layer) }}>{layer.name}</div>}
      {!!metric && showT(layer) && <div style={{ fontSize: 16, opacity: 0.7, marginBottom: 8 }}>Bubble size = {metric} · color = biggest category per country</div>}
      <div style={{ flex: 1, minHeight: 0 }}>
        <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, display: 'block' }}>
          {lons.map((lo) => { const x = project(0, lo).x; return (<line key={`lo${lo}`} x1={x} y1={gridTop} x2={x} y2={gridBottom} stroke="rgba(255,255,255,0.12)" strokeWidth={lo === 0 ? 2 : 1} />) })}
          {lats.map((la) => { const y = project(la, 0).y; return (<line key={`la${la}`} x1={gridLeft} y1={y} x2={gridRight} y2={y} stroke="rgba(255,255,255,0.12)" strokeWidth={la === 0 ? 2 : 1} />) })}
          {ordered.map((b, i) => {
            const e = pointEOA(frame, mT, i)
            const r = 5 + Math.sqrt(Math.max(0, b.value) / max) * 60
            const pulse = 1 + 0.03 * Math.sin(frame * 0.08 + i * 1.7)
            return (
              <g key={i} opacity={e} transform={`translate(${b.x} ${b.y}) scale(${(e * pulse).toFixed(3)})`}>
                <circle r={r.toFixed(1)} fill={b.color || '#4da3ff'} opacity={0.85} stroke="#fff" strokeOpacity={0.4} strokeWidth={2} />
                {i < 8 && <text y={-r - 10} textAnchor="middle" fill="#fff" fontSize={15} fontWeight={700}>{b.country}</text>}
                {i < 8 && <text y={-r + 10} textAnchor="middle" fill="#fff" fontSize={13} opacity={0.9}>{fmtVal(b.value)}</text>}
              </g>
            )
          })}
        </svg>
      </div>
      {showL(layer) && <Legend items={legend} />}
    </div>
  )
}

const DATA_VIZ = ['bar_chart', 'line_chart', 'map_bubbles', 'pie_chart', 'area_chart', 'scatter_chart', 'histogram', 'waterfall', 'funnel_chart', 'radar_chart', 'surface_plot']
const CHART_PALETTE = ['#4da3ff', '#3ddc84', '#ffcf40', '#b388ff', '#ff9f43', '#ff6b6b', '#4dd0e1', '#ff7eb6']
// A blanked-out name collapses the title block entirely (no empty gap),
// so erasing a chart title gives a clean chart instead of dead space.
const showT = (layer) => layer.showTitle !== false && String(layer.name || '').trim() !== ''
const showL = (layer) => layer.showLegend !== false
// Chart titles follow the layer's picked font (charts share the picker).
const titleFont = (layer) => ({ fontFamily: fontStack(cleanFamily(layer.fontFamily) || 'Inter') })
const eoa = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t))
function segProgress(frame, start, delay, dur = 24) {
  return interpolate(frame, [start + delay, start + delay + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
}
// Shared animation clock: every chart derives per-point timing from
// effectiveTiming(layer), so the inspector's Reveal/Stagger sliders
// (data.reveal / data.stagger) work uniformly. Unset = per-chart defaults.
function pointEOA(frame, t, i) { return eoa(segProgress(frame, t.k0, i * t.stagger, t.dur)) }
function masterP(frame, t) {
  return interpolate(frame, [t.k0, t.k0 + t.total], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
}
function shade(hex, f) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '')
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const c = (v) => Math.min(255, Math.max(0, Math.round(v * f)))
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`
}
function ChartShell({ layer, legend, children, sub }) {
  return (
    <div style={{ width: 1280, height: 720, padding: 48, display: 'flex', flexDirection: 'column' }}>
      {showT(layer) && <div style={{ fontSize: 34, fontWeight: 700, ...titleFont(layer) }}>{layer.name}</div>}
      {showT(layer) && (sub ? <div style={{ fontSize: 16, opacity: 0.7, marginBottom: 8 }}>{sub}</div> : <div style={{ height: 8 }} />)}
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
      {showL(layer) && <Legend items={legend} />}
    </div>
  )
}
function PieChart({ layer, frame }) {
  const { labels = [], values = [], pointColors = [], legend = [] } = layer.data || {}
  const donut = /donut|doughnut/i.test(`${layer.data?.variant || ''} ${layer.name || ''}`)
  const total = values.reduce((a, b) => a + (Number(b) || 0), 0) || 1
  const pT = effectiveTiming(layer)
  const cx = 540, cy = 310, R = 220, r0 = donut ? 112 : 0
  let acc = 0
  const autoLegend = legend.length ? legend : labels.map((lb, i) => ({ label: String(lb), color: pointColors[i] || CHART_PALETTE[i % CHART_PALETTE.length] }))
  return (
    <ChartShell layer={layer} legend={autoLegend}>
      <svg viewBox="0 0 1280 560" width="100%" height="100%" style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, display: 'block' }}>
        {values.map((v, i) => {
          const a0 = (acc / total) * Math.PI * 2 - Math.PI / 2
          acc += Number(v) || 0
          const a1 = (acc / total) * Math.PI * 2 - Math.PI / 2
          const e = pointEOA(frame, pT, i)
          const large = a1 - a0 > Math.PI ? 1 : 0
          const P = (r, a) => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`
          const d = r0 <= 0
            ? `M ${cx} ${cy} L ${P(R, a0)} A ${R} ${R} 0 ${large} 1 ${P(R, a1)} Z`
            : `M ${P(r0, a0)} L ${P(R, a0)} A ${R} ${R} 0 ${large} 1 ${P(R, a1)} L ${P(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${P(r0, a0)} Z`
          const mid = (a0 + a1) / 2
          const pct = ((Number(v) || 0) / total) * 100
          return (
            <g key={i} opacity={e} transform={`translate(${cx} ${cy}) scale(${e.toFixed(3)}) translate(${-cx} ${-cy})`}>
              <path d={d} fill={pointColors[i] || CHART_PALETTE[i % CHART_PALETTE.length]} stroke="#10141d" strokeWidth={3} />
              {pct >= 7 && <text x={cx + (R + 36) * Math.cos(mid)} y={cy + (R + 36) * Math.sin(mid)} textAnchor="middle" fill="#fff" fontSize={17} fontWeight={700}>{pct.toFixed(0)}%</text>}
            </g>
          )
        })}
        {donut && <text x={cx} y={cy - 6} textAnchor="middle" fill="#fff" fontSize={22} fontWeight={800}>{fmtNum(total)}</text>}
        {donut && <text x={cx} y={cy + 20} textAnchor="middle" fill="#fff" fontSize={14} opacity={0.7}>total</text>}
      </svg>
    </ChartShell>
  )
}
function AreaChart({ layer, frame }) {
  const { labels = [], values = [], pointColors = [], legend = [] } = layer.data || {}
  const max = Math.max(1, ...values.map((v) => Number(v) || 0))
  const aT = effectiveTiming(layer)
  const progress = masterP(frame, aT)
  const n = values.length
  const X = (i) => (i / Math.max(1, n - 1)) * 900 + 60
  // Same stationary contract as the line chart: the wipe reveals, values
  // don't travel.
  const Y = (v) => 320 - ((Number(v) || 0) / max) * 260
  const line = values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')
  const area = n ? `M ${X(0).toFixed(1)} 360 ` + values.map((v, i) => `L ${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ') + ` L ${X(n - 1).toFixed(1)} 360 Z` : ''
  const col = pointColors[0] || '#4da3ff'
  const step = Math.max(1, Math.ceil(labels.length / 10))
  return (
    <ChartShell layer={layer} legend={legend}>
      <div style={{ clipPath: `inset(0 ${(1 - progress) * 100}% 0 0)`, height: '100%' }}>
        <svg viewBox="0 0 1020 380" width="100%" height="100%" preserveAspectRatio="none" style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 12, display: 'block' }}>
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line x1={60} y1={320 - f * 260} x2={1000} y2={320 - f * 260} stroke="rgba(255,255,255,0.12)" />
              <text x={54} y={324 - f * 260} textAnchor="end" fill="#fff" fontSize={13} opacity={0.6}>{fmtAxis(max * f, layer.data?.yFormat, max)}</text>
            </g>
          ))}
          <line x1={60} y1={320} x2={1000} y2={320} stroke="rgba(255,255,255,0.35)" strokeWidth={2} />
          {area && <path d={area} fill={col} opacity={0.35} />}
          {line && <polyline points={line} fill="none" stroke={col} strokeWidth={6} strokeLinejoin="round" />}
          {values.length <= 12 && values.map((v, i) => (
            <circle key={i} cx={X(i)} cy={Y(v)} r={10} fill={pointColors[i] || col} opacity={pointEOA(frame, aT, i)} />
          ))}
        </svg>
      </div>
      {!!labels.length && (
        <div style={{ display: 'flex', marginTop: 6, fontSize: 13, opacity: 0.8 }}>
          {labels.map((lb, i) => (i % step === 0 || i === labels.length - 1 ? (
            <div key={i} style={{ flex: '1 1 0', textAlign: i === 0 ? 'left' : 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(lb).slice(0, 14)}</div>
          ) : <div key={i} style={{ flex: '1 1 0' }} />))}
        </div>
      )}
    </ChartShell>
  )
}
function ScatterChart({ layer, frame }) {
  const { labels = [], values = [], pointColors = [], legend = [] } = layer.data || {}
  const nums = values.map((v) => Number(v) || 0)
  const max = Math.max(1, ...nums)
  const sT = effectiveTiming(layer)
  const n = nums.length
  const X = (i) => 80 + (i / Math.max(1, n - 1)) * 980
  const Y = (v) => 460 - (v / max) * 400
  return (
    <ChartShell layer={layer} legend={legend}>
      <svg viewBox="0 0 1140 520" width="100%" height="100%" style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, display: 'block' }}>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={60} y1={460 - f * 400} x2={1100} y2={460 - f * 400} stroke="rgba(255,255,255,0.12)" />
            <text x={52} y={464 - f * 400} textAnchor="end" fill="#fff" fontSize={13} opacity={0.6}>{fmtAxis(max * f, layer.data?.yFormat, max)}</text>
          </g>
        ))}
        <line x1={60} y1={460} x2={1100} y2={460} stroke="rgba(255,255,255,0.35)" strokeWidth={2} />
        {nums.map((v, i) => {
          const e = pointEOA(frame, sT, i)
          return (
            <g key={i} opacity={e} transform={`translate(${X(i).toFixed(1)} ${Y(v).toFixed(1)}) scale(${e.toFixed(3)})`}>
              <circle r={n > 20 ? 7 : 11} fill={pointColors[i] || CHART_PALETTE[i % CHART_PALETTE.length]} opacity={0.9} stroke="#fff" strokeOpacity={0.4} strokeWidth={2} />
              {n <= 10 && <text y={-18} textAnchor="middle" fill="#fff" fontSize={13}>{fmtNum(v)}</text>}
            </g>
          )
        })}
      </svg>
    </ChartShell>
  )
}
function Histogram({ layer, frame }) {
  const { labels = [], values = [], pointColors = [], legend = [] } = layer.data || {}
  const nums = values.map((v) => Number(v) || 0)
  const max = Math.max(1, ...nums)
  const hT = effectiveTiming(layer)
  const n = nums.length
  const bw = 1040 / Math.max(1, n)
  const step = Math.max(1, Math.ceil(labels.length / 12))
  return (
    <ChartShell layer={layer} legend={legend}>
      <svg viewBox="0 0 1140 500" width="100%" height="100%" style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, display: 'block' }}>
        <line x1={50} y1={440} x2={1090} y2={440} stroke="rgba(255,255,255,0.35)" strokeWidth={2} />
        {nums.map((v, i) => {
          const e = pointEOA(frame, hT, i)
          const h = Math.max(2, (v / max) * 380 * e)
          return (
            <g key={i} opacity={Math.min(1, e + 0.2)}>
              <rect x={(60 + i * bw + 1).toFixed(1)} y={(440 - h).toFixed(1)} width={Math.max(1, bw - 2).toFixed(1)} height={h.toFixed(1)} fill={pointColors[i] || '#4da3ff'} rx={2} />
              {(i % step === 0 || i === n - 1) && labels[i] != null && (
                <text x={60 + i * bw + bw / 2} y={462} textAnchor="middle" fill="#fff" fontSize={12} opacity={0.7}>{String(labels[i]).slice(0, 10)}</text>
              )}
            </g>
          )
        })}
      </svg>
    </ChartShell>
  )
}
function WaterfallChart({ layer, frame }) {
  const { labels = [], values = [], pointColors = [], legend = [] } = layer.data || {}
  const nums = values.map((v) => Number(v) || 0)
  const cums = [0]
  for (const v of nums) cums.push(cums[cums.length - 1] + v)
  const mn = Math.min(...cums), mx = Math.max(...cums)
  const span = Math.max(1, mx - mn)
  const wT = effectiveTiming(layer)
  const n = nums.length
  const bw = 1040 / Math.max(1, n)
  const Y = (v) => 40 + ((mx - v) / span) * 400
  return (
    <ChartShell layer={layer} legend={legend}>
      <svg viewBox="0 0 1140 500" width="100%" height="100%" style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, display: 'block' }}>
        <line x1={50} y1={Y(0)} x2={1090} y2={Y(0)} stroke="rgba(255,255,255,0.25)" strokeDasharray="6 5" />
        {nums.map((v, i) => {
          const e = pointEOA(frame, wT, i)
          const y1 = Y(cums[i]), y2 = Y(cums[i + 1])
          const top = Math.min(y1, y2), h = Math.max(2, Math.abs(y2 - y1) * e)
          const col = pointColors[i] || (v >= 0 ? '#3ddc84' : '#ff6b6b')
          return (
            <g key={i} opacity={Math.min(1, e + 0.2)}>
              {i < n - 0 && i + 1 < n && (
                <line x1={60 + i * bw + bw - 4} y1={y2} x2={60 + (i + 1) * bw + 4} y2={y2} stroke="rgba(255,255,255,0.4)" strokeDasharray="5 4" />
              )}
              <rect x={(60 + i * bw + 4).toFixed(1)} y={(v >= 0 ? top + (Math.abs(y2 - y1) * (1 - e)) : top).toFixed(1)} width={Math.max(1, bw - 8).toFixed(1)} height={h.toFixed(1)} fill={col} rx={4} />
              <text x={60 + i * bw + bw / 2} y={(top - 10).toFixed(1)} textAnchor="middle" fill="#fff" fontSize={13} fontWeight={700}>{v >= 0 ? '+' : ''}{fmtNum(v)}</text>
              {labels[i] != null && <text x={60 + i * bw + bw / 2} y={472} textAnchor="middle" fill="#fff" fontSize={12} opacity={0.7}>{String(labels[i]).slice(0, 12)}</text>}
            </g>
          )
        })}
      </svg>
    </ChartShell>
  )
}
function FunnelChart({ layer, frame }) {
  const { labels = [], values = [], pointColors = [], legend = [] } = layer.data || {}
  const nums = values.map((v) => Number(v) || 0)
  const max = Math.max(1, ...nums)
  const fT = effectiveTiming(layer)
  const n = nums.length
  const plotW = 880, x0 = (1280 - plotW) / 2, top = 130, stageH = 430 / Math.max(1, n)
  const W = (v) => Math.max(8, (v / max) * plotW)
  return (
    <ChartShell layer={layer} legend={legend}>
      <svg viewBox="0 0 1280 560" width="100%" height="100%" style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, display: 'block' }}>
        {nums.map((v, i) => {
          const e = pointEOA(frame, fT, i)
          const w = W(v) * e, wNext = (i + 1 < n ? W(nums[i + 1]) : W(v)) * e
          const y0 = top + i * stageH, y1 = y0 + stageH - 6
          const cx = 640
          return (
            <g key={i} opacity={Math.min(1, e + 0.25)}>
              <polygon points={`${cx - w / 2},${y0} ${cx + w / 2},${y0} ${cx + wNext / 2},${y1} ${cx - wNext / 2},${y1}`} fill={pointColors[i] || CHART_PALETTE[i % CHART_PALETTE.length]} opacity={0.92} />
              {w * e > 150 && (
                <text x={cx} y={(y0 + y1) / 2 - 2} textAnchor="middle" fill="#10141d" fontSize={16} fontWeight={800}>{String(labels[i] ?? `Stage ${i + 1}`).slice(0, 22)}</text>
              )}
              {w * e > 150 && (
                <text x={cx} y={(y0 + y1) / 2 + 20} textAnchor="middle" fill="#10141d" fontSize={14} fontWeight={700}>{fmtNum(v)}</text>
              )}
            </g>
          )
        })}
      </svg>
    </ChartShell>
  )
}
function RadarChart({ layer, frame }) {
  const { labels = [], values = [], pointColors = [], legend = [] } = layer.data || {}
  const nums = values.map((v) => Number(v) || 0)
  const max = Math.max(1, ...nums)
  const rT = effectiveTiming(layer)
  const progress = masterP(frame, rT)
  const e = eoa(progress)
  const n = nums.length
  const cx = 560, cy = 300, R = 200
  const P = (i, r) => {
    const a = (i / Math.max(1, n)) * Math.PI * 2 - Math.PI / 2
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`
  }
  const ring = (f) => Array.from({ length: n }, (_, i) => P(i, R * f)).join(' ')
  const col = pointColors[0] || '#4da3ff'
  return (
    <ChartShell layer={layer} legend={legend}>
      <svg viewBox="0 0 1280 560" width="100%" height="100%" style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, display: 'block' }}>
        {[0.33, 0.66, 1].map((f) => (
          <polygon key={f} points={ring(f)} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={1.5} />
        ))}
        {nums.map((_, i) => (
          <line key={i} x1={cx} y1={cy} x2={P(i, R).split(',')[0]} y2={P(i, R).split(',')[1]} stroke="rgba(255,255,255,0.18)" />
        ))}
        <g opacity={e} transform={`translate(${cx} ${cy}) scale(${e.toFixed(3)}) translate(${-cx} ${-cy})`}>
          <polygon points={nums.map((v, i) => P(i, (v / max) * R)).join(' ')} fill={col} opacity={0.35} stroke={col} strokeWidth={3} strokeLinejoin="round" />
          {nums.map((v, i) => {
            const [px, py] = P(i, (v / max) * R).split(',')
            return <circle key={i} cx={px} cy={py} r={7} fill={pointColors[i] || col} stroke="#fff" strokeWidth={2} opacity={pointEOA(frame, rT, i)} />
          })}
        </g>
        {labels.map((lb, i) => {
          const [px, py] = P(i, R + 30).split(',')
          return <text key={i} x={px} y={py} textAnchor="middle" fill="#fff" fontSize={14} opacity={0.85}>{String(lb).slice(0, 14)}</text>
        })}
      </svg>
    </ChartShell>
  )
}
function SurfacePlot({ layer, frame }) {
  const { labels = [], values = [], pointColors = [], legend = [] } = layer.data || {}
  const nums = values.map((v) => Number(v) || 0)
  const max = Math.max(1, ...nums)
  const sfT = effectiveTiming(layer)
  const n = nums.length
  const step = 980 / Math.max(1, n)
  const colW = Math.min(90, step * 0.62)
  const baseY = 470, maxH = 300, dx = 30, dy = -24
  return (
    <ChartShell layer={layer} legend={legend}>
      <svg viewBox="0 0 1280 560" width="100%" height="100%" style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, display: 'block' }}>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={120} y1={baseY - f * maxH} x2={1180} y2={baseY - f * maxH} stroke="rgba(255,255,255,0.1)" />
        ))}
        {nums.map((v, i) => {
          const e = pointEOA(frame, sfT, i)
          const h = Math.max(2, (v / max) * maxH * e)
          const x = 150 + i * step + (step - colW) / 2
          const y = baseY - h
          const col = pointColors[i] || '#4da3ff'
          return (
            <g key={i} opacity={Math.min(1, e + 0.25)}>
              <polygon points={`${x + colW},${y} ${x + colW + dx},${y + dy} ${x + colW + dx},${baseY + dy} ${x + colW},${baseY}`} fill={shade(col, 0.6)} />
              <polygon points={`${x},${y} ${x + dx},${y + dy} ${x + dx + colW},${y + dy} ${x + colW},${y}`} fill={shade(col, 1.3)} />
              <rect x={x.toFixed(1)} y={y.toFixed(1)} width={colW.toFixed(1)} height={h.toFixed(1)} fill={col} opacity={0.95} />
            </g>
          )
        })}
        <polyline points={nums.map((v, i) => {
          const e = pointEOA(frame, sfT, i)
          const h = Math.max(2, (v / max) * maxH * e)
          const x = 150 + i * step + (step - colW) / 2
          return `${(x + colW / 2 + dx / 2).toFixed(1)},${(baseY - h + dy / 2).toFixed(1)}`
        }).join(' ')} fill="none" stroke="#fff" strokeOpacity={0.45} strokeWidth={2.5} />
      </svg>
    </ChartShell>
  )
}
function ChartFor({ layer, frame }) {
  switch (layer.type) {
    case 'line_chart': return <LineChart layer={layer} frame={frame} />
    case 'map_bubbles': return <MapBubbles layer={layer} frame={frame} />
    case 'pie_chart': return <PieChart layer={layer} frame={frame} />
    case 'area_chart': return <AreaChart layer={layer} frame={frame} />
    case 'scatter_chart': return <ScatterChart layer={layer} frame={frame} />
    case 'histogram': return <Histogram layer={layer} frame={frame} />
    case 'waterfall': return <WaterfallChart layer={layer} frame={frame} />
    case 'funnel_chart': return <FunnelChart layer={layer} frame={frame} />
    case 'radar_chart': return <RadarChart layer={layer} frame={frame} />
    case 'surface_plot': return <SurfacePlot layer={layer} frame={frame} />
    default: return <BarChart layer={layer} frame={frame} />
  }
}
const DRAGGABLE = ['text', 'image_layer', 'sprite', 'vector_shape']
function LayerView({ layer, frame, onSelect, selected, preview, onDragPreview, onDragCommit }) {
  // Hooks must run before the out-of-range early return below, or
  // scrubbing past a layer boundary changes the hook count and crashes React.
  const supRef = React.useRef(false)
  const dragRef = React.useRef(null)
  const [isDrag, setIsDrag] = React.useState(false)
  if (frame < layer.startFrame || frame > layer.endFrame) return null
  // Uncommitted slider moves (preview) override keyframes so the canvas
  // follows the inspector in real time. Preview is transient, never saved.
  const props = preview && preview.id === layer.id
    ? { ...lerpKeyframes(layer.keyframes, frame), ...preview.props }
    : lerpKeyframes(layer.keyframes, frame)
  // Direct manipulation: drag a positional layer to move it. Deltas are
  // divided by the Player's render scale (measured off the canvas root),
  // so dragging works at any preview size. Moves stream through the same
  // transient preview as the sliders; release commits a real keyframe.
  // Charts are full-canvas, but now that x/y apply to them they drag like
  // any positional layer — deltas stream through the same live preview.
  const canDrag = (DRAGGABLE.includes(layer.type) || DATA_VIZ.includes(layer.type)) && onDragPreview && onDragCommit
  // The post-drag click must ALWAYS stop here: a suppressed (post-drag)
  // click that bubbles reaches the canvas root, which reads it as
  // "deselect" and closes the inspector on every drop.
  const handleClick = onSelect ? (e) => { e.stopPropagation(); if (supRef.current) { supRef.current = false; return } onSelect(layer.id) } : undefined
  function dragStart(e) {
    if (!canDrag || (e.button !== undefined && e.button !== 0)) return
    onSelect?.(layer.id)
    const root = e.currentTarget.closest('[data-vs-canvas]')
    const rect = root?.getBoundingClientRect()
    const scale = rect && rect.width ? rect.width / 1280 : 1
    dragRef.current = { x0: e.clientX, y0: e.clientY, bx: props.x ?? 0, by: props.y ?? 0, scale: scale || 1, moved: false }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    e.preventDefault()
  }
  function dragMove(e) {
    const d = dragRef.current
    if (!d) return
    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 3) return
    if (!d.moved) { d.moved = true; setIsDrag(true) }
    onDragPreview(layer.id, { x: d.bx + (e.clientX - d.x0) / d.scale, y: d.by + (e.clientY - d.y0) / d.scale })
  }
  function dragEnd(e) {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    setIsDrag(false)
    if (d.moved) {
      supRef.current = true
      onDragCommit(layer.id, { x: d.bx + (e.clientX - d.x0) / d.scale, y: d.by + (e.clientY - d.y0) / d.scale })
    }
  }
  const clickProps = handleClick ? { onClick: handleClick } : {}
  const dragProps = canDrag ? { onPointerDown: dragStart, onPointerMove: dragMove, onPointerUp: dragEnd, onPointerCancel: dragEnd } : {}
  const selectOutline = selected ? '3px dashed #4da3ff' : undefined
  const grabCursor = canDrag ? (isDrag ? 'grabbing' : 'grab') : (onSelect ? 'pointer' : undefined)
  const style = {
    position: 'absolute', left: 0, top: 0,
    transform: `translate(${props.x ?? 0}px, ${props.y ?? 0}px) scale(${props.scale ?? 1}) rotate(${props.rotation ?? 0}deg)`,
    opacity: props.opacity ?? 1,
    transformOrigin: 'center',
  }
  // Data-viz layers are full-canvas by design, but x/y still apply — e.g.
  // a scaled-down chart can be parked in a corner and keyframed across
  // the frame. Translate comes first so X/Y are exact screen pixels even
  // when the chart is scaled. Image layers are positional the same way.
  if (layer.type === 'image_layer') {
    return (
      <div style={{ ...style, outline: selectOutline, cursor: grabCursor }} {...clickProps} {...dragProps}>
        <img src={layer.assetUrl} alt={layer.name} style={{ width: layer.data?.width || 480, maxWidth: 1200, height: 'auto', display: 'block', borderRadius: 6 }} onError={(e) => { e.currentTarget.style.display = 'none' }} />
      </div>
    )
  }
  if (DATA_VIZ.includes(layer.type)) {
    const chartStyle = {
      position: 'absolute', left: 0, top: 0, width: 1280, height: 720,
      transform: `translate(${props.x ?? 0}px, ${props.y ?? 0}px) scale(${props.scale ?? 1}) rotate(${props.rotation ?? 0}deg)`,
      opacity: props.opacity ?? 1,
      transformOrigin: 'center',
    }
    return <div style={{ ...chartStyle, outline: selectOutline, cursor: grabCursor }} {...clickProps} {...dragProps}>{<ChartFor layer={layer} frame={frame} />}</div>
  }
  if (layer.type === 'text') {
    return (
      <div style={{ ...style, width: '100%', textAlign: 'center', top: 120, outline: selectOutline, cursor: grabCursor }} {...clickProps} {...dragProps}>
        {/* Shrink-fit + wrap-anywhere: the box hugs the text and long titles
          wrap (even unbroken strings) instead of overflowing a narrow
          canvas. pre-wrap honors Enter line breaks from the content box. */}
        <div style={{ display: 'inline-block', maxWidth: '100%', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', fontSize: Math.round(props.fontSize ?? layer.fontSize ?? 84), fontWeight: 800, letterSpacing: 1, lineHeight: 1.15, fontFamily: fontStack(cleanFamily(layer.fontFamily) || 'Inter'), color: layer.color || '#fff' }}>{layer.text || layer.name}</div>
      </div>
    )
  }
  if (layer.type === 'vector_shape') {
    return (
      <div style={{ ...style, outline: selectOutline, cursor: grabCursor }} {...clickProps} {...dragProps}>
        <img src={layer.assetUrl} alt={layer.name} style={{ width: 220, height: 220 }} onError={(e) => { e.currentTarget.style.display = 'none' }} />
        <div style={{ textAlign: 'center', fontSize: 20 }}>{layer.name}</div>
      </div>
    )
  }
  if (layer.type === 'sprite') {
    const walk = Math.sin(frame * 0.5) * 12
    return (
      <div style={{ ...style, transform: `${style.transform} translateY(${walk}px)`, outline: selectOutline, cursor: grabCursor }} {...clickProps} {...dragProps}>
        <div style={{ fontSize: 120 }}>{layer.data?.emoji || '🚶'}</div>
        <div style={{ textAlign: 'center', fontSize: 18 }}>{layer.name}</div>
      </div>
    )
  }
  return (
    <div style={{ ...style, outline: selectOutline, cursor: grabCursor }} {...clickProps} {...dragProps}>
      <div style={{ fontSize: 24 }}>{layer.name}</div>
    </div>
  )
}

export function SceneComposition({ scene, selectedId, onSelect, preview, onDragPreview, onDragCommit }) {
  const frame = useCurrentFrame()
  const pv = preview && preview.id ? preview : null
  // The internal stage is always 1280×720 (every chart/text coordinate is
  // authored in that space); it uniform-fit scales onto any canvas size so
  // layers never distort. Drag deltas are measured off the scaled box, so
  // they stay correct at any canvas size or Player zoom.
  const W = scene?.width || 1280, H = scene?.height || 720
  const s = Math.min(W / 1280, H / 720)
  return (
    <AbsoluteFill style={{ backgroundColor: scene?.background || '#10141d' }} onClick={() => onSelect?.(null)}>
      <FontGate scene={scene} />
      {!!scene?.backgroundImage && <img src={scene.backgroundImage} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: scene.backgroundImageOpacity ?? 1 }} />}
      {/* Explicit base text color: the preview inherits near-white from the
        app page CSS, which the headless export bundle doesn't include —
        without this, titles/labels/legends fall back to browser-default
        dark text and vanish on the dark stage in the MP4. */}
      <div data-vs-canvas style={{ position: 'absolute', left: (W - 1280 * s) / 2, top: (H - 720 * s) / 2, width: 1280, height: 720, transform: `scale(${s})`, transformOrigin: 'top left', color: '#e6e9f0' }}>
        {(scene?.layers || []).map((l) => (
          <LayerView key={l.id} layer={l} frame={frame} selected={l.id === selectedId} onSelect={onSelect} preview={pv} onDragPreview={onDragPreview} onDragCommit={onDragCommit} />
        ))}
      </div>
      <div style={{ position: 'absolute', bottom: 12, right: 16, fontSize: 16, opacity: 0.6, color: '#e6e9f0' }}>frame {frame} / {scene?.durationInFrames}</div>
    </AbsoluteFill>
  )
}
