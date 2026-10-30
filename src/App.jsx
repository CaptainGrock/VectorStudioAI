import React, { useMemo, useState } from 'react'
import { Player } from '@remotion/player'
import { SceneComposition } from './remotion/SceneComposition.jsx'
import { SequenceComposition } from './remotion/SequenceComposition.jsx'
import { useStudio, seqLayout, seqCanvas, clipDuration, emptyScene } from './store.js'
import { generateScene, editScene, getLastSource, tableFromLayer, describeTable, resolveEditTable, diagnoseNoPatch, refreshLayerData, resolveRefreshTable } from './llm.js'
import { validateScene, normalizeScene, lerpKeyframes, backfillKeyframeProps, effectiveTiming } from './sceneGraph.js'
import { FONT_CHOICES } from './llm.js'
import { OPEN_FONTS, SYSTEM_FONTS_LIST, ensureFonts, ensureCustomFonts, restoreCustomFonts, fetchGoogleFont, fetchCustomFontFromUrl, registerCustomFont, cleanFamily, fontStack, probeFontCdn, fontCdnStatus } from './fonts.js'
import { parseAttachedFile, parseCSV, parseMarkdownTable, parseDelimitedTable } from './datasets.js'
import { isImageFile, processImageFile } from './images.js'
import { SHAPE_GROUPS, SHAPE_KINDS, shapeKind, shapeParts } from './shapes.js'
import EngineSettings from './EngineSettings.jsx'
import LlmSettings from './LlmSettings.jsx'
import TtsSettings, { loadTts } from './TtsSettings.jsx'
import { loadSettings } from './llmSettings.js'

function Playhead({ getFrame, duration, onGrabDown, onGrabMove, onGrabUp }) {
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    let raf = 0
    let last = -1
    const tick = () => {
      const f = Math.round(getFrame?.() ?? 0)
      if (f !== last) { last = f; setFrame(f) }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [getFrame])
  const pct = Math.min(100, (frame / Math.max(1, duration)) * 100)
  return (
    <>
      <div style={{ position: 'absolute', top: -2, bottom: -2, left: `${pct}%`, width: 2, background: '#ff5252', pointerEvents: 'none', zIndex: 2 }} />
      {/* Invisible grab strip riding the playhead ABOVE the keyframe diamonds:
        grabbing the red line always scrubs, even when a diamond sits exactly
        under it (that overlap used to retime the keyframe instead, which read
        as "the playhead is stuck"). To retime a diamond at the playhead,
        click elsewhere on the lane first, then drag the diamond. */}
      {onGrabDown && (
        <div onPointerDown={(e) => { e.stopPropagation(); onGrabDown(e) }}
          onPointerMove={(e) => onGrabMove?.(e)}
          onPointerUp={(e) => onGrabUp?.(e)}
          onPointerCancel={() => onGrabUp?.()}
          onLostPointerCapture={() => onGrabUp?.()}
          title="Drag to scrub the playhead — to retime a keyframe, move the playhead away first, then drag its yellow diamond"
          style={{ position: 'absolute', top: -6, bottom: -6, left: `calc(${pct}% - 12px)`, width: 24, cursor: 'ew-resize', zIndex: 4, touchAction: 'none' }} />
      )}
    </>
  )
}

function KeyframeDiamond({ frame, duration, onScrub, onCommit }) {
  const ref = React.useRef(null)
  const dragging = React.useRef(false)
  const frameFromX = (clientX) => {
    const bar = ref.current?.parentElement?.getBoundingClientRect()
    if (!bar || !bar.width) return frame
    return Math.round(Math.min(1, Math.max(0, (clientX - bar.left) / bar.width)) * duration)
  }
  return (
    <div ref={ref} title={`frame ${frame} (drag)`}
      style={{
        position: 'absolute', top: 4, width: 12, height: 26, cursor: 'ew-resize', touchAction: 'none',
        left: `calc(${(frame / duration) * 100}% - 6px)`,
        background: '#ffcf40', clipPath: 'polygon(50% 0,100% 50%,50% 100%,0 50%)',
      }}
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId) }}
      onPointerMove={(e) => { if (dragging.current) onScrub(frameFromX(e.clientX)) }}
      onPointerUp={(e) => { if (dragging.current) { dragging.current = false; onCommit(frameFromX(e.clientX)) } }}
      onPointerCancel={() => { dragging.current = false }}
      onLostPointerCapture={() => { dragging.current = false }}
    />
  )
}

// Persistent storage-health chip: silent while every save lands, loud
// (amber/red) the moment auto-save degrades or fails — so a quota wall
// warns DURING the session, never as a surprise after a refresh.
function SaveHealth() {
  const health = useStudio(s => s.saveHealth)
  if (!health || (health.ok && !health.degraded)) return null
  const failing = !health.ok
  return (
    <span title={`${health.detail || 'Auto-save trouble.'} Back up via Export → JSON.`}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700,
        color: failing ? '#ff9090' : '#ffd166', whiteSpace: 'nowrap',
        border: `1px solid ${failing ? '#6e2a33' : '#6e5a1e'}`, borderRadius: 7,
        padding: '3px 10px', background: failing ? '#2a1418' : '#2a2114', flexShrink: 0,
      }}>
      {failing ? '⚠ Auto-save FAILING' : '⚠ Auto-save degraded'}
    </span>
  )
}

function StatusBar({ status, busy }) {
  const color = status.kind === 'error' ? '#ff8080' : status.kind === 'done' ? '#3ddc84' : '#9fb3d8'
  return (
    <>
      <style>{`@keyframes vs-spin { to { transform: rotate(360deg); } }`}</style>
      <span title={status.text} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, minWidth: 0, maxWidth: 340, overflow: 'hidden', whiteSpace: 'nowrap' }}>
        {busy && <span style={{ width: 11, height: 11, borderRadius: '50%', border: '2px solid var(--vs-accent)', borderTopColor: 'transparent', display: 'inline-block', flexShrink: 0, animation: 'vs-spin 0.8s linear infinite' }} />}
        <span style={{ color, overflow: 'hidden', textOverflow: 'ellipsis' }}>{status.text}</span>
      </span>
    </>
  )
}

function ChartColors({ layer }) {
  const updateLayer = useStudio(s => s.updateLayer)
  const d = layer.data || {}
  // Stacked bars color per series segment, not per bar — one swatch each.
  if (Array.isArray(d.series) && d.series.length) {
    const setSeriesColor = (label, color) => updateLayer(layer.id, (o) => {
      const series = (o.data?.series || []).map((s) => (s.label === label ? { ...s, color } : s))
      const legend = (o.data?.legend || []).map((it) => (it.label === label ? { ...it, color } : it))
      return { ...o, data: { ...o.data, series, legend } }
    })
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 4 }}>Stack segment colors</div>
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {d.series.map((s, i) => (
            <label key={i} style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : 'var(--vs-accent)'} onChange={(e) => setSeriesColor(s.label, e.target.value)} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
            </label>
          ))}
        </div>
      </div>
    )
  }
  const isMap = layer.type === 'map_bubbles'
  const values = d.values || []
  const mapBubbles = d.bubbles || []
  const uniform = isMap
    ? (mapBubbles.length && mapBubbles.every((b) => b.color === mapBubbles[0].color) ? mapBubbles[0].color : 'var(--vs-accent)')
    : (d.pointColors?.length === values.length && d.pointColors.every((c) => c === d.pointColors[0]) ? d.pointColors[0] : 'var(--vs-accent)')
  const setSingle = (color) => updateLayer(layer.id, (o) => (isMap
    ? { ...o, data: { ...o.data, bubbles: (o.data.bubbles || []).map((b) => ({ ...b, color })), legend: [] } }
    : { ...o, data: { ...o.data, pointColors: (o.data.values || []).map(() => color), legend: [] } }))
  const setGroupColor = (legendItem, color) => updateLayer(layer.id, (o) => {
    if (o.data?.bubbles) {
      const bubbles = o.data.bubbles.map((b) => (b.category === legendItem.label ? { ...b, color } : b))
      const legend = (o.data.legend || []).map((it) => (it.label === legendItem.label ? { ...it, color } : it))
      return { ...o, data: { ...o.data, bubbles, legend } }
    }
    const dd = o.data || {}
    const cols = dd.columns || []
    const groupCol = String(legendItem.label).includes(': ') ? String(legendItem.label).split(': ')[0] : null
    const colIdx = groupCol ? cols.indexOf(groupCol) : -1
    const groupVal = groupCol ? String(legendItem.label).slice(groupCol.length + 2) : null
    const pointColors = (dd.values || []).map((_, i) => {
      const rowVal = colIdx >= 0 && Array.isArray(dd.rows?.[i]) ? String(dd.rows[i][colIdx]) : null
      if (rowVal !== null && rowVal === groupVal) return color
      return dd.pointColors?.[i] || 'var(--vs-accent)'
    })
    const legend = (dd.legend || []).map((it) => (it.label === legendItem.label ? { ...it, color } : it))
    return { ...o, data: { ...dd, pointColors, legend } }
  })
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 4 }}>Colors</div>
      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Single color <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(uniform) ? uniform : 'var(--vs-accent)'} onChange={(e) => setSingle(e.target.value)} title="Paint every bar/point one color (clears groups)" /></label>
      {!!d.legend?.length && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {d.legend.map((it, i) => (
            <label key={i} style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(it.color) ? it.color : 'var(--vs-accent)'} onChange={(e) => setGroupColor(it, e.target.value)} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function FontPicker({ layer }) {
  const updateLayer = useStudio(s => s.updateLayer)
  const [q, setQ] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const [custom, setCustom] = React.useState('')
  const [customMsg, setCustomMsg] = React.useState(null)
  const [customBusy, setCustomBusy] = React.useState(false)
  const [fontUrl, setFontUrl] = React.useState('')
  const [fontBusy, setFontBusy] = React.useState(false)
  const [fontMsg, setFontMsg] = React.useState(null)
  const fileRef = React.useRef(null)
  // Webfont availability: null = probing, false = both CDNs unreachable
  // (Google UI hidden, System fonts only), otherwise 'google'/'mirror'.
  const [web, setWeb] = React.useState(fontCdnStatus())
  React.useEffect(() => {
    if (open && web === null) probeFontCdn().then((r) => setWeb(r === 'offline' ? false : r))
  }, [open, web])
  const current = cleanFamily(layer.fontFamily) || 'Inter'
  const ql = q.toLowerCase()
  const hits = OPEN_FONTS.filter((f) => !q || f.name.toLowerCase().includes(ql) || f.cats.some((c) => c.includes(ql))).slice(0, 200)
  const sysHits = SYSTEM_FONTS_LIST.filter((f) => !q || f.name.toLowerCase().includes(ql))
  const [hover, setHover] = React.useState(null)
  // Load stylesheets for what's actually shown — capped so the request
  // stays small and can't fail as a batch. Re-runs on every search so
  // newly listed families render in their real face, not a fallback.
  React.useEffect(() => {
    if (open) ensureFonts([current, ...hits.slice(0, 24).map((h) => h.name)])
  }, [open, q])
  const previewFor = (name, stack) => ({
    onMouseEnter: (e) => {
      ensureFonts([name])
      const r = e.currentTarget.getBoundingClientRect()
      // Park the card left of the font list (clear of the right rail),
      // vertically pinned near the hovered row.
      setHover({ name, stack, x: Math.max(8, r.left - 292), y: Math.max(8, Math.min(window.innerHeight - 170, r.top - 40)) })
    },
    onMouseLeave: () => setHover(null),
  })
  const applyFont = (name) => { updateLayer(layer.id, (o) => ({ ...o, fontFamily: cleanFamily(name) || 'Inter' })); setOpen(false); setHover(null) }
  async function loadCustom(explicit) {
    const name = String(explicit ?? custom).trim()
    if (!name || customBusy) return
    setCustomBusy(true)
    setCustomMsg(null)
    const r = await fetchGoogleFont(name)
    setCustomBusy(false)
    if (r.ok) {
      updateLayer(layer.id, (o) => ({ ...o, fontFamily: cleanFamily(r.name) || r.name }))
      setCustom('')
      setCustomMsg({ ok: true, text: `Loaded “${r.name}” — applied.` })
      setWeb(fontCdnStatus() || true)
    } else {
      setCustomMsg({ ok: false, text: r.error })
    }
  }
  // 1001Fonts / own files: the backend downloads the page URL server-side
  // (no browser CORS) and the font travels on the layer as a data: URL.
  async function loadFontUrl() {
    const u = fontUrl.trim()
    if (!u || fontBusy) return
    setFontBusy(true)
    setFontMsg(null)
    const r = await fetchCustomFontFromUrl(u)
    setFontBusy(false)
    if (r.ok) {
      updateLayer(layer.id, (o) => ({ ...o, fontFamily: cleanFamily(r.name) || r.name, fontUrl: r.dataUrl }))
      setFontUrl('')
      setFontMsg({ ok: true, text: `Loaded “${r.name}” — applied.` })
    } else {
      setFontMsg({ ok: false, text: r.error })
    }
  }
  function onFontFile(e) {
    const f = (e.target.files || [])[0]
    e.target.value = ''
    if (!f) return
    if (f.size > 8 * 1024 * 1024) { setFontMsg({ ok: false, text: 'That file is over 8 MB — pick a smaller cut.' }); return }
    const rd = new FileReader()
    rd.onload = () => {
      const dataUrl = String(rd.result || '')
      const fam = cleanFamily(f.name.replace(/\.(ttf|otf|woff2?|ttc)$/i, '')) || 'Custom Font'
      if (!registerCustomFont(fam, dataUrl)) { setFontMsg({ ok: false, text: 'The browser refused that file — is it a valid font?' }); return }
      updateLayer(layer.id, (o) => ({ ...o, fontFamily: fam, fontUrl: dataUrl }))
      setFontMsg({ ok: true, text: `Loaded “${fam}” — applied.` })
    }
    rd.onerror = () => setFontMsg({ ok: false, text: 'Could not read that file.' })
    rd.readAsDataURL(f)
  }
  return (
    <div style={{ fontSize: 11 }}>
      <div style={{ opacity: 0.65, marginBottom: 4 }}>Font — {web === false ? 'web fonts unreachable, System only' : `${OPEN_FONTS.length} built-in, or load any Google Font below${web === 'mirror' ? ' (via mirror)' : ''}`}</div>
      <button onClick={() => { setOpen(!open); ensureFonts([current]) }} style={{ width: '100%', textAlign: 'left', background: 'var(--vs-inset)', color: 'var(--vs-bright)', border: '1px solid var(--vs-border)', borderRadius: 6, padding: '5px 8px', cursor: 'pointer' }} title="Open fonts are all open-licensed (Google Fonts)">
        <span style={{ fontFamily: fontStack(current), fontSize: 14 }}>{current || 'Inter'}</span>
        <span style={{ opacity: 0.6 }}> {open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 4, background: 'var(--vs-inset)', border: '1px solid var(--vs-border)', borderRadius: 6, padding: 6 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: script, mono, display…" style={{ width: '100%', marginBottom: 6, background: 'var(--vs-deep)', color: 'var(--vs-bright)', border: '1px solid var(--vs-border)', borderRadius: 4, padding: '4px 6px' }} />
          <div style={{ maxHeight: 190, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {!!sysHits.length && <div style={{ fontSize: 10, opacity: 0.55, marginTop: 2 }}>System — always available, works offline</div>}
            {sysHits.map((f) => (
              <button key={`sys-${f.name}`} onClick={() => applyFont(f.name)} {...previewFor(f.name, f.stack)} title="System font — no download needed" style={{ textAlign: 'left', background: f.name === current ? 'var(--vs-sel)' : 'transparent', color: 'var(--vs-bright)', border: 'none', borderRadius: 4, padding: '5px 6px', cursor: 'pointer' }}>
                <span style={{ fontFamily: f.stack, fontSize: 15 }}>{f.name}</span>
                <div style={{ fontFamily: f.stack, fontSize: 11, opacity: 0.7 }}>Ag Sales 123</div>
              </button>
            ))}
            {web === false && <div style={{ fontSize: 11, opacity: 0.7, padding: 4 }}>No connection to Google Fonts or its mirror — System fonts below work fully offline.</div>}
            {web !== false && !!sysHits.length && !!hits.length && <div style={{ fontSize: 10, opacity: 0.55, marginTop: 4 }}>Google Fonts — open-licensed, needs internet once</div>}
            {web !== false && hits.map((f) => (
              <button key={f.name} onClick={() => applyFont(f.name)} {...previewFor(f.name, fontStack(f.name))} title={f.cats.join(', ')} style={{ textAlign: 'left', background: f.name === current ? 'var(--vs-sel)' : 'transparent', color: 'var(--vs-bright)', border: 'none', borderRadius: 4, padding: '5px 6px', cursor: 'pointer' }}>
                <span style={{ fontFamily: fontStack(f.name), fontSize: 15 }}>{f.name}</span>
                <span style={{ opacity: 0.55, fontSize: 10 }}> · {f.cats.join(' ')}</span>
                <div style={{ fontFamily: fontStack(f.name), fontSize: 11, opacity: 0.7 }}>Ag Sales 123</div>
              </button>
            ))}
            {!hits.length && (q.trim() ? (
              <div style={{ opacity: 0.6, padding: 4 }}>No built-in match for “{q.trim()}”.{web !== false && (<> <button onClick={() => loadCustom(q)} disabled={customBusy} title="Verify + download this exact name from Google Fonts and apply it">{customBusy ? 'Loading…' : `Load “${q.trim()}”`}</button></>)}</div>
            ) : (
              <div style={{ opacity: 0.6, padding: 4 }}>{web === false ? 'System fonts above work fully offline.' : 'Type to search, or load any name below.'}</div>
            ))}
          </div>
          {web === null && <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>Checking web fonts…</div>}
          {web !== false && (
          <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
            <input value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') loadCustom() }} placeholder="Any Google Font name…" title="Loads any open-licensed Google Font on demand (needs internet once)" style={{ flex: 1, background: 'var(--vs-deep)', color: 'var(--vs-bright)', border: '1px solid var(--vs-border)', borderRadius: 4, padding: '4px 6px' }} />
            <button onClick={() => loadCustom()} disabled={customBusy || !custom.trim()} title="Verify + download this Google Font, preview it, and apply">{customBusy ? '…' : 'Load'}</button>
          </div>
          )}
          {customMsg && <div style={{ fontSize: 11, marginTop: 4, color: customMsg.ok ? '#3ddc84' : '#ff8080' }}>{customMsg.text}</div>}
          <div style={{ marginTop: 6, borderTop: '1px solid var(--vs-border)', paddingTop: 6 }}>
            <div style={{ fontSize: 10, opacity: 0.55, marginBottom: 4 }}>1001Fonts / your own file — paste a font page URL or upload a file</div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input value={fontUrl} onChange={(e) => setFontUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') loadFontUrl() }} placeholder="https://www.1001fonts.com/…" title="Paste a 1001Fonts font URL — the app downloads and applies it" style={{ flex: 1, minWidth: 0, background: 'var(--vs-deep)', color: 'var(--vs-bright)', border: '1px solid var(--vs-border)', borderRadius: 4, padding: '4px 6px' }} />
              <button onClick={loadFontUrl} disabled={fontBusy || !fontUrl.trim()} title="Download this font and apply it">{fontBusy ? '…' : 'Fetch'}</button>
              <button onClick={() => fileRef.current?.click()} title="Upload a .ttf/.otf/.woff/.woff2 from your computer">Upload</button>
            </div>
            <input ref={fileRef} type="file" accept=".ttf,.otf,.woff,.woff2,.ttc" style={{ display: 'none' }} onChange={onFontFile} />
            {fontMsg && <div style={{ fontSize: 11, marginTop: 4, color: fontMsg.ok ? '#3ddc84' : '#ff8080' }}>{fontMsg.text}</div>}
          </div>
        </div>
      )}
      {open && hover && (
        <div style={{ position: 'fixed', left: hover.x, top: hover.y, width: 280, background: 'var(--vs-pop)', border: '1px solid var(--vs-accent)', borderRadius: 8, padding: 12, zIndex: 9999, pointerEvents: 'none', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{hover.name}</div>
          <div style={{ fontFamily: hover.stack, fontSize: 30, lineHeight: 1.2 }}>Ag Sales 123</div>
          <div style={{ fontFamily: hover.stack, fontSize: 15, opacity: 0.85, marginTop: 6 }}>ABCDEFGHIJKLM abcdefghijklm 1234567890</div>
        </div>
      )}
    </div>
  )
}

function aspectName(w, h) {
  const r = w / Math.max(1, h)
  if (Math.abs(r - 16 / 9) < 0.02) return '16:9'
  if (Math.abs(r - 9 / 16) < 0.02) return '9:16'
  if (Math.abs(r - 1) < 0.02) return '1:1'
  if (Math.abs(r - 4 / 3) < 0.02) return '4:3'
  if (Math.abs(r - 3 / 4) < 0.02) return '3:4'
  return `${r.toFixed(2)}:1`
}
const CANVAS_PRESETS = [
  { label: 'Landscape 16:9', w: 1280, h: 720 },
  { label: 'Vertical 9:16', w: 720, h: 1280 },
  { label: 'Square 1:1', w: 1080, h: 1080 },
]
function CanvasSize() {
  const scene = useStudio(s => s.scene)
  const updateSceneField = useStudio(s => s.updateSceneField)
  const W = scene.width || 1280, H = scene.height || 720
  const clampDim = (n) => Math.min(3840, Math.max(160, Math.round(n)))
  const setDim = (field, n) => { if (Number.isFinite(n)) updateSceneField(field, clampDim(n)) }
  const row = (label, field, value, min, max) => (
    <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>{label}
      <input type="number" value={Math.round(value)} min={160} max={3840} step={8} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setDim(field, n) }} style={{ width: 64, background: 'var(--vs-deep)', color: 'var(--vs-bright)', border: '1px solid var(--vs-border)', borderRadius: 4, padding: '2px 6px' }} />
      <input type="range" min={min} max={max} step={8} value={Math.min(max, Math.max(min, value))} onChange={(e) => setDim(field, Number(e.target.value))} style={{ flex: 1 }} title={`Canvas ${label} — live in preview, export matches`} />
    </label>
  )
  return (
    <div style={{ marginTop: 8, background: 'var(--vs-inset)', border: '1px solid var(--vs-border)', borderRadius: 6, padding: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, opacity: 0.65 }}>Canvas size — {W}×{H} ({aspectName(W, H)})</div>
      {row('W', 'width', W, 320, 1920)}
      {row('H', 'height', H, 320, 1920)}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {CANVAS_PRESETS.map((p) => (
          <button key={p.label} onClick={() => { setDim('width', p.w); setDim('height', p.h) }} title={`Set canvas to ${p.w}×${p.h}`} style={{ fontSize: 11, background: W === p.w && H === p.h ? 'var(--vs-sel)' : undefined }}>{p.label}</button>
        ))}
      </div>
      <div style={{ fontSize: 10, opacity: 0.55 }}>Layers live on a 1280×720 stage scaled to fit — preview and MP4 export match these dims.</div>
    </div>
  )
}

function Section({ title, defaultOpen, children }) {
  const [open, setOpen] = React.useState(!!defaultOpen)
  return (
    <div style={{ marginTop: 8, background: 'var(--vs-inset)', border: '1px solid var(--vs-border)', borderRadius: 6 }}>
      <button onClick={() => setOpen((o) => !o)} title={open ? `Collapse ${title}` : `Expand ${title}`} style={{ width: '100%', background: 'none', border: 'none', color: 'var(--vs-bright)', cursor: 'pointer', padding: '6px 8px', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>{open ? '▾' : '▸'} {title}</button>
      {open && <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>}
    </div>
  )
}

function TextStyle({ layer }) {
  const updateLayer = useStudio(s => s.updateLayer)
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, opacity: 0.65 }} title="The layer name (above) is just a label — this is what shows on the video">Text <span style={{ opacity: 0.7 }}>(layer name stays separate — rename it above)</span></div>
      <textarea value={layer.text || ''} onChange={(e) => updateLayer(layer.id, (o) => ({ ...o, text: e.target.value }))} placeholder="Text shown on the video — Enter for a new line" rows={2} style={{ width: '100%', background: 'var(--vs-deep)', color: 'var(--vs-text)', border: '1px solid var(--vs-border)', borderRadius: 6, padding: 6, resize: 'vertical' }} />
    </div>
  )
}

function ShowToggles({ layer }) {
  const updateLayer = useStudio(s => s.updateLayer)
  const box = (label, field, title) => (
    <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }} title={title}>
      <input type="checkbox" checked={layer[field] !== false} onChange={(e) => updateLayer(layer.id, (o) => ({ ...o, [field]: e.target.checked }))} /> {label}
    </label>
  )
  return (
    <div style={{ marginTop: 8, display: 'flex', gap: 12 }}>
      {box('Show title', 'showTitle', 'Uncheck to hide the title but keep the layer name on the track')}
      {box('Show legend', 'showLegend', 'Uncheck to hide the legend')}
    </div>
  )
}

function DataRefresh({ layer }) {
  const datasets = useStudio(s => s.datasets)
  const updateLayer = useStudio(s => s.updateLayer)
  const setStatus = useStudio(s => s.setStatus)
  const pushLog = useStudio(s => s.pushLog)
  const d = layer.data || {}
  if (!d.buildPrompt) return null
  const table = resolveRefreshTable(layer, datasets)
  if (!table) {
    if (!d.source) return null
    return <div style={{ marginTop: 8, fontSize: 11, opacity: 0.6 }}>Data: “{d.source}” isn't attached — re-attach it in Stage 1 to enable refresh.</div>
  }
  const doRefresh = () => {
    const fresh = refreshLayerData(layer, table)
    if (!fresh) { setStatus(`Refresh failed — “${table.name}” doesn't regroup the same way.`, 'error'); return }
    const sig = (x) => JSON.stringify([x.labels, x.values, x.series?.map((s) => [s.label, s.values])])
    const changed = sig(fresh) !== sig(d)
    updateLayer(layer.id, (o) => ({ ...o, data: { ...o.data, ...fresh } }))
    pushLog(changed ? `Refreshed ${layer.name} from ${table.name} (${table.rows.length} rows → ${fresh.labels.length} points).` : `${layer.name} already up to date.`)
    setStatus(changed
      ? `Refreshed “${layer.name}” from ${table.name} (${table.rows.length} rows → ${fresh.labels.length} points). Keyframes + styling kept.`
      : `“${layer.name}” is already up to date with ${table.name}.`, changed ? 'done' : 'info')
  }
  return (
    <div style={{ marginTop: 8, fontSize: 11 }}>
      <div style={{ opacity: 0.65, marginBottom: 4 }}>Data — linked to “{table.name}” ({table.rows.length} rows)</div>
      <button onClick={doRefresh} title="Rebuild this chart from the current dataset using its original grouping — keyframes, timing and colors are kept">↻ Refresh data</button>
    </div>
  )
}

function AnimTiming({ layer, fps }) {
  const updateLayer = useStudio(s => s.updateLayer)
  const t = effectiveTiming(layer)
  const d = layer.data || {}
  const n = d.values?.length || d.series?.[0]?.values?.length || d.bubbles?.length || 1
  const wipe = ['line_chart', 'area_chart', 'radar_chart'].includes(layer.type)
  const secs = (f) => `${f}f (${(f / Math.max(1, fps || 30)).toFixed(1)}s)`
  const set = (patch) => updateLayer(layer.id, (o) => ({ ...o, data: { ...o.data, ...patch } }))
  const auto = (v, fb) => (v ?? `Auto (${fb})`)
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, opacity: 0.65 }}>Animation timing — {n} point{n === 1 ? '' : 's'} · total {secs(Math.round(t.total))}{wipe ? ' · stagger pops markers + stretches draw' : ''}</div>
      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Reveal {typeof d.reveal === 'number' ? `${d.reveal}f` : auto(undefined, `${t.dur}f`)}
        <input type="range" min={4} max={240} step={1} value={typeof d.reveal === 'number' ? d.reveal : t.dur} onChange={(e) => set({ reveal: Number(e.target.value) })} style={{ flex: 1 }} title="How long each point takes to grow (frames)" />
      </label>
      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Stagger {typeof d.stagger === 'number' ? `${d.stagger}f` : auto(undefined, `${t.stagger}f`)}
        <input type="range" min={0} max={60} step={0.5} value={typeof d.stagger === 'number' ? d.stagger : t.stagger} onChange={(e) => set({ stagger: Number(e.target.value) })} style={{ flex: 1 }} title="Delay between consecutive points (frames, 0 = all at once)" />
      </label>
      {(typeof d.reveal === 'number' || typeof d.stagger === 'number') && (
        <button onClick={() => updateLayer(layer.id, (o) => { const dd = { ...o.data }; delete dd.reveal; delete dd.stagger; return { ...o, data: dd } })} title="Back to built-in pacing">Reset to Auto</button>
      )}
    </div>
  )
}

const EASE_OPTS = [
  { id: 'regular', short: 'REGULAR', ease: 'linear', tip: 'Steady speed — no acceleration into the keyframe' },
  { id: 'in', short: 'IN', ease: 'easeInCubic', tip: 'Slow start, accelerates into the keyframe' },
  { id: 'out', short: 'OUT', ease: 'easeOutCubic', tip: 'Fast start, gentle landing at the keyframe' },
]
function easeToOpt(easing) {
  if (!easing || easing === 'linear') return 'regular'
  if (easing === 'easeInCubic') return 'in'
  return 'out'
}

// Seconds of audio in a data: URL (browser decodes the header only).
function wavSeconds(dataUrl) {
  return new Promise((resolve, reject) => {
    const el = new Audio()
    el.preload = 'metadata'
    el.onloadedmetadata = () => (Number.isFinite(el.duration) ? resolve(el.duration) : reject(new Error('no duration')))
    el.onerror = () => reject(new Error('unreadable audio'))
    el.src = dataUrl
  })
}

function AudioSection({ layer, v, push, fps }) {
  const updateLayer = useStudio(s => s.updateLayer)
  const updateSceneField = useStudio(s => s.updateSceneField)
  const setStatus = useStudio(s => s.setStatus)
  const audios = useStudio(s => s.audios)
  const fpsSafe = fps || 30
  const isTts = layer.type === 'audio_tts'
  // Source length (when the file exposes metadata) drives the Play-from
  // range: a 3-minute song under a 4-second clip gets a real selector.
  const [audioDur, setAudioDur] = React.useState(null)
  React.useEffect(() => {
    setAudioDur(null)
    if (!layer.assetUrl) return undefined
    let live = true
    const el = new Audio()
    el.preload = 'metadata'
    el.onloadedmetadata = () => { if (live && Number.isFinite(el.duration) && el.duration > 0) setAudioDur(el.duration) }
    el.onerror = () => {}
    el.src = layer.assetUrl
    return () => { live = false; el.removeAttribute('src'); try { el.load() } catch {} }
  }, [layer.assetUrl])
  const clipLen = Math.max(0.5, (layer.endFrame - layer.startFrame) / fpsSafe)
  const offFrames = Math.max(0, Math.round(Number(layer.data?.offsetFrames) || 0))
  const offSec = offFrames / fpsSafe
  const maxOff = audioDur != null ? Math.max(0, audioDur - clipLen) : null
  const setOffSec = (s) => {      const clamped = Math.min(maxOff ?? (Number(s) || 0), Math.max(0, Number(s) || 0))
    updateLayer(layer.id, (o) => ({ ...o, data: { ...o.data, offsetFrames: Math.round(clamped * fpsSafe) } }))
  }
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  // Background synthesis job: { running, id, elapsedSec, logTail } or { error }.
  const [synthJob, setSynthJob] = React.useState(null)
  const ttsCfg = loadTts()
  const voice = (ttsCfg.voices || []).find((x) => x.name === layer.data?.voice) || ttsCfg.voices[0]
  const setData = (patch) => updateLayer(layer.id, (o) => ({ ...o, data: { ...o.data, ...patch } }))
  const volPct = Math.round((v.volume ?? 1) * 100)
  const setVol = (pct) => push({ volume: Math.min(2, Math.max(0, Number(pct) / 100)) })
  async function onSynth() {
    const text = String(layer.data?.text || '').trim()
    if (!text) { setStatus('Type the narration text first.', 'error'); return }
    if (synthJob?.running) return
    setSynthJob({ running: true, id: null, elapsedSec: 0, logTail: ['Starting…'] })
    setStatus('Synthesizing speech… (first run loads the 3B model — allow minutes)')
    try {
      const r = await fetch('/api/tts/synth', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, refAudioDataUrl: voice?.refAudio || '', refText: voice?.refText || '', instruction: ttsCfg.instruction || '', modelPath: ttsCfg.modelPath || '', seed: layer.data?.seed ?? 42 }),
      })
      if (r.status === 404) throw new Error('local server is outdated — restart start.bat so it picks up TTS support, then try again.')
      const out = await r.json().catch(() => ({}))
      if (!r.ok || !out.ok || !out.id) throw new Error(out.error || `HTTP ${r.status}`)
      for (let i = 0; i < 300; i++) {
        await new Promise((res) => setTimeout(res, 2000))
        const p = await fetch(`/api/tts/synth/${out.id}`).then((x) => x.json())
        if (p.state === 'done') {
          updateLayer(layer.id, (o) => ({ ...o, assetUrl: p.dataUrl }))
          // TTS (never music) grows the timeline: a 250-frame narration
          // over a 200-frame scene extends the scene to the new max.
          let note = ''
          if (isTts && p.dataUrl) {
            try {
              const durSec = await wavSeconds(p.dataUrl)
              const need = Math.min(3600, Math.max(1, Math.ceil(durSec * fpsSafe)))
              if (need > layer.endFrame) {
                updateLayer(layer.id, (o) => ({ ...o, endFrame: need }))
                const sceneDur = useStudio.getState().scene.durationInFrames
                if (need > sceneDur) updateSceneField('durationInFrames', need)
                note = ` Timeline extended to ${need}f to fit the ${durSec.toFixed(1)}s narration.`
              }
            } catch { /* keep the audio even if measuring failed */ }
          }
          setStatus(`Narration ready (${Math.round((p.bytes || 0) / 1024)} KB) — press play to hear it with the video.${note}`, 'done')
          setSynthJob(null)
          return
        }
        if (p.state === 'error' || p.ok === false) throw new Error(p.error || 'synthesis failed')
        setSynthJob({ running: true, id: out.id, elapsedSec: p.elapsedSec || 0, logTail: p.logTail || [] })
        if (i === 299) throw new Error('synthesis timed out after ~10 minutes — try shorter text')
      }
    } catch (e) { setSynthJob({ error: e.message }); setStatus(`TTS failed: ${e.message}`, 'error') }
  }
  async function onCancelSynth() {
    if (synthJob?.id) await fetch(`/api/tts/synth/${synthJob.id}/cancel`, { method: 'POST' }).catch(() => {})
    setSynthJob(null)
    setStatus('Synthesis cancelled.', 'info')
  }
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, opacity: 0.65 }}>{isTts ? 'Narration track' : 'Music track'} — {layer.assetUrl ? 'audio ready ✓' : isTts ? 'no audio yet — generate it below' : 'no file picked yet'}</div>
      {isTts && (
        <>
          <div style={{ fontSize: 11, opacity: 0.65 }}>Script — sent to the voice model</div>
          <textarea value={layer.data?.text || ''} onChange={(e) => setData({ text: e.target.value })} placeholder="Type what the voice should say…" rows={3} style={{ width: '100%', background: 'var(--vs-deep)', color: 'var(--vs-text)', border: '1px solid var(--vs-border)', borderRadius: 6, padding: 6, resize: 'vertical' }} />
          <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Voice
            <select value={layer.data?.voice || voice?.name || ''} onChange={(e) => setData({ voice: e.target.value })} style={{ flex: 1, minWidth: 0 }} title="Voices + reference clips live in ⚙ → Text-to-Speech">
              {(ttsCfg.voices || []).map((vv) => <option key={vv.id} value={vv.name}>{vv.name}{vv.refAudio ? '' : ' (generic)'}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Seed
            <input type="number" value={layer.data?.seed ?? 42} onChange={(e) => { const n = Math.round(Number(e.target.value)); if (Number.isFinite(n)) setData({ seed: n }) }} style={{ width: 72 }} title="Same text + same seed = the same take. Change it (or roll the dice) for a different read" />
            <button onClick={() => setData({ seed: Math.floor(Math.random() * 100000) })} title="Random seed for a different take">🎲</button>
          </label>
          <button onClick={onSynth} disabled={!!synthJob?.running} title="Synthesize with the local BreezeTTS-2 checkpoint">🎙 Generate speech</button>
          {synthJob?.running && (
            <div style={{ background: 'var(--vs-inset)', borderRadius: 6, padding: 6 }}>
              <style>{`@keyframes vs-slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }`}</style>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1 }}>🎙 Synthesizing… {synthJob.elapsedSec || 0}s elapsed</span>
                <button onClick={onCancelSynth} title="Stop this synthesis run">Cancel</button>
              </div>
              <div style={{ height: 8, background: 'var(--vs-track)', borderRadius: 4, overflow: 'hidden', marginTop: 4 }}>
                <div style={{ height: '100%', width: '40%', background: 'var(--vs-accent)', animation: 'vs-slide 1.2s linear infinite' }} />
              </div>
              {!!synthJob.logTail?.length && (
                <div style={{ marginTop: 4, opacity: 0.7, maxHeight: 90, overflowY: 'auto' }}>
                  {synthJob.logTail.map((l, i) => <div key={i}>{l}</div>)}
                </div>
              )}
            </div>
          )}
          {synthJob?.error && <div style={{ fontSize: 11, color: '#ff8080' }}>{synthJob.error}</div>}
          <div style={{ fontSize: 11, opacity: 0.55 }}>Voices + reference clips live in ⚙ → Text-to-Speech.</div>
        </>
      )}
      {!!layer.assetUrl && (
        <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Play from {fmt(offSec)}{audioDur != null && ` of ${fmt(audioDur)}`}
          {maxOff != null && maxOff > 0 ? (
            <input type="range" min={0} max={Math.round(maxOff * 10) / 10} step={0.1} value={Math.min(maxOff, offSec)} onChange={(e) => setOffSec(Number(e.target.value))} style={{ flex: 1 }} title="Where in the source file this track starts — the track plays its full length from there" />
          ) : (
            <input type="number" min={0} step={0.5} value={Math.round(offSec * 10) / 10} disabled title="Locked at 0 — the source exactly fills this track, so there is nothing further in to start from" style={{ width: 64, opacity: 0.5 }} />
          )}
        </label>
      )}
      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>File
        <select value={audios.find((a) => a.dataUrl === layer.assetUrl)?.id || ''} onChange={(e) => { const a = audios.find((x) => x.id === e.target.value); updateLayer(layer.id, (o) => ({ ...o, assetUrl: a ? a.dataUrl : '' })) }} style={{ flex: 1, minWidth: 0 }} title="Use an attached audio file instead of generated speech">
          <option value="">{isTts ? 'Generated audio (or pick a file)…' : 'Pick attached audio…'}</option>
          {audios.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Volume {volPct}%
        <input type="number" min={0} max={200} step={1} value={volPct} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setVol(n) }} style={{ width: 56 }} />
        <input type="range" min={0} max={200} step={1} value={Math.min(200, Math.max(0, volPct))} onChange={(e) => setVol(Number(e.target.value))} style={{ flex: 1 }} title="Volume — Set keyframe to fade or duck it" />
      </label>
      <div style={{ display: 'flex', gap: 6 }}>
        <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>Start
          <input type="number" value={layer.startFrame} onChange={(e) => updateLayer(layer.id, (o) => ({ ...o, startFrame: Math.max(0, Math.round(Number(e.target.value) || 0)) }))} style={{ width: 60 }} title="First frame the audio plays" />
        </label>
        <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>Stop
          <input type="number" value={layer.endFrame} onChange={(e) => updateLayer(layer.id, (o) => ({ ...o, endFrame: Math.max(0, Math.round(Number(e.target.value) || 0)) }))} style={{ width: 60 }} title="Last frame the audio plays" />
        </label>
      </div>
      <div style={{ fontSize: 11, opacity: 0.55 }}>Start delays the whole track (audio plays from Play-from at Start) — Stop ends it. Drag the track's edge bars on the timeline, or type frames here. Volume keyframes fade or duck between them.</div>
    </div>
  )
}

function LayerInspector({ layer, getFrame, onJump, onClose, onPreview, clearPreview, fps }) {
  const updateLayer = useStudio(s => s.updateLayer)
  const deleteKeyframe = useStudio(s => s.deleteKeyframe)
  const setStatus = useStudio(s => s.setStatus)
  const [frame, setFrame] = React.useState(() => Math.round(getFrame?.() ?? 0))
  // Follow the Player playhead. Slider moves auto-save to the frame where
  // they were made (no Set button): a pending edit is flushed to the old
  // frame before the playhead moves on, so scrubbing never loses work.
  const [live, setLive] = React.useState(null)
  const [savedAt, setSavedAt] = React.useState(null)
  const liveRef = React.useRef(null)
  const frameRef = React.useRef(frame)
  const timerRef = React.useRef(0)
  const easeRef = React.useRef(null)
  const [easePick, setEasePick] = React.useState(null)
  React.useEffect(() => { easeRef.current = easePick }, [easePick])
  React.useEffect(() => { frameRef.current = frame }, [frame])
  const commitLive = React.useCallback((nextVals, atFrame, easeId) => {
    const ease = EASE_OPTS.find((o) => o.id === (easeId ?? easeRef.current))?.ease || layer.keyframes.find((k) => k.frame === atFrame)?.easing || 'linear'
    const isAudio = layer.type === 'audio_tts' || layer.type === 'audio_music'
    const props = isAudio
      ? { volume: nextVals.volume ?? 1 }
      : { x: nextVals.x, y: nextVals.y, scale: nextVals.scale, opacity: nextVals.opacity, ...(layer.type === 'text' ? { fontSize: Math.round(nextVals.fontSize) } : {}) }
    const existed = layer.keyframes.some((k) => k.frame === atFrame)
    updateLayer(layer.id, (o) => {
      const kf = o.keyframes.map((k) => ({ ...k, properties: { ...k.properties } }))
      const ki = kf.findIndex((k) => k.frame === atFrame)
      if (ki >= 0) kf[ki] = { ...kf[ki], properties: { ...kf[ki].properties, ...props }, easing: ease }
      else kf.push({ frame: atFrame, properties: props, easing: ease })
      kf.sort((a, b) => a.frame - b.frame)
      return { ...o, keyframes: backfillKeyframeProps(kf, o.fontSize) }
    })
    setSavedAt(atFrame)
    setStatus(`${existed ? 'Updated' : 'Set'} keyframe on ${layer.name} at frame ${atFrame} — auto-saved.`, 'done')
  }, [layer.id, layer.keyframes, layer.type, layer.name, updateLayer, setStatus])
  const flushPending = React.useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = 0 }
    if (liveRef.current) {
      const { vals, atFrame } = liveRef.current
      liveRef.current = null
      setLive(null)
      clearPreview?.()
      commitLive(vals, atFrame, easeRef.current)
    }
  }, [clearPreview, commitLive])
  React.useEffect(() => {
    let raf = 0
    let last = Math.round(getFrame?.() ?? 0)
    const tick = () => {
      const f = Math.round(getFrame?.() ?? 0)
      if (f !== last) {
        // Playhead moved with an unsaved edit: pin it to the frame where
        // the edit happened before following the playhead.
        if (liveRef.current) {
          const { vals, atFrame } = liveRef.current
          liveRef.current = null
          if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = 0 }
          setLive(null)
          clearPreview?.()
          commitLive(vals, atFrame, easeRef.current)
        }
        last = f
        setFrame(f)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); if (timerRef.current) clearTimeout(timerRef.current) }
  }, [getFrame, commitLive, clearPreview])
  React.useEffect(() => { setLive(null); liveRef.current = null; setEasePick(null); easeRef.current = null; setSavedAt(null); clearPreview?.() }, [layer.id])
  const cur = lerpKeyframes(layer.keyframes, frame)
  const v = live || { x: cur.x ?? 0, y: cur.y ?? 0, scale: cur.scale ?? 1, opacity: cur.opacity ?? 1, fontSize: cur.fontSize ?? layer.fontSize ?? 84, volume: cur.volume ?? layer.data?.volume ?? 1 }
  const push = (patch) => {
    const next = { ...v, ...patch }
    setLive(next)
    liveRef.current = { vals: next, atFrame: frameRef.current }
    onPreview?.({ x: next.x, y: next.y, scale: next.scale, opacity: next.opacity, fontSize: next.fontSize, volume: next.volume })
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = 0
      if (!liveRef.current) return
      const { vals, atFrame } = liveRef.current
      liveRef.current = null
      setLive(null)
      clearPreview?.()
      commitLive(vals, atFrame, easeRef.current)
    }, 700)
  }
  const dropPreview = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = 0 }
    liveRef.current = null
    setLive(null); clearPreview?.()
  }
  const kfAt = layer.keyframes.find((k) => k.frame === frame)
  React.useEffect(() => { setEasePick(null); easeRef.current = null }, [layer.id, frame])
  const easeOpt = easePick ?? easeToOpt(kfAt?.easing)
  const hasKf = layer.keyframes.some((k) => k.frame === frame)
  const hasChart = !!(layer.data?.values || layer.data?.series || layer.data?.bubbles)
  const hasFonts = layer.type === 'text' || layer.type === 'shape' || hasChart
  const isAudio = layer.type === 'audio_tts' || layer.type === 'audio_music'
  const field = (label, key, step, min, max, fmt = (x) => Math.round(x * 100) / 100) => (
    <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}> {label}
      <input type="number" step={step} value={fmt(v[key])} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) push({ [key]: Math.min(max, Math.max(min, key === 'opacity' ? n / 100 : n)) }) }} style={{ width: 56 }} />
      <input type="range" min={key === 'opacity' ? 0 : min} max={key === 'opacity' ? 100 : max} step={key === 'opacity' ? 1 : step} value={key === 'opacity' ? Math.round(v.opacity * 100) : Math.min(max, Math.max(min, v[key]))} onChange={(e) => push({ [key]: key === 'opacity' ? Number(e.target.value) / 100 : Number(e.target.value) })} style={{ flex: 1, minWidth: 0 }} title={`Slide ${label} — auto-saves`} />
    </label>
  )
  return (
    <div style={{ position: 'absolute', top: 12, right: 12, width: 264, maxHeight: 'calc(100% - 24px)', overflowY: 'auto', background: 'var(--vs-pop)', border: '1px solid var(--vs-border)', borderRadius: 10, padding: 12, zIndex: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <input value={layer.name} onChange={(e) => updateLayer(layer.id, (o) => ({ ...o, name: e.target.value }))} style={{ fontSize: 13, fontWeight: 700, flex: 1, background: 'var(--vs-inset)', border: '1px solid var(--vs-border)', borderRadius: 4, padding: '2px 6px', minWidth: 0, color: 'var(--vs-bright)' }} title="Layer title — this is the label shown on the video" />
        <span style={{ flex: 1 }} />
        <button onClick={onClose} title="Deselect">✕</button>
      </div>
      <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 8 }}>{layer.type} · frame <strong>{frame}</strong> <button onClick={() => setFrame(Math.round(getFrame?.() ?? 0))} title="Read current playhead frame">↻</button>{live ? <span style={{ color: '#ffcf40' }}> · editing… auto-saving…</span> : savedAt !== null ? <span style={{ color: '#3ddc84' }}> · ✓ auto-saved at {savedAt}</span> : <span> · edits auto-save here</span>}</div>
      {!isAudio && (<Section title="Transform" defaultOpen>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {field('X', 'x', 1, -1500, 1500)}{field('Y', 'y', 1, -1000, 1000)}{field('Scale', 'scale', 0.05, 0, 3)}{field('Opacity %', 'opacity', 1, 0, 1, () => Math.round(v.opacity * 100))}
          {layer.type === 'text' && (
            <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Size {Math.round(v.fontSize ?? 84)}
              <input type="range" min={12} max={200} step={1} value={Math.min(200, Math.max(12, v.fontSize ?? 84))} onChange={(e) => push({ fontSize: Math.min(200, Math.max(12, Number(e.target.value))) })} style={{ flex: 1, minWidth: 0 }} title="Font size — auto-saves, move playhead to animate it" />
            </label>
          )}
        </div>
      </Section>)}
      {isAudio && <AudioSection layer={layer} v={v} push={push} fps={fps} />}
      {['text', 'shape'].includes(layer.type) && <TextStyle layer={layer} />}
      {layer.type === 'shape' && <ShapeSection layer={layer} />}
      {hasChart && <ShowToggles layer={layer} />}
      {hasChart && <ChartColors layer={layer} />}
      <DataRefresh layer={layer} />
      {hasFonts && (
        <Section title="Fonts" defaultOpen={false}>
          {layer.type === 'text' ? <FontPicker layer={layer} /> : (
            <>
              <div style={{ fontSize: 11, opacity: 0.65 }}>Title font</div>
              <FontPicker layer={layer} />
            </>
          )}
          {['text', 'shape'].includes(layer.type) && (
            <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>{layer.type === 'shape' ? 'Label color' : 'Color'}
              <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(layer.color || '') ? layer.color : '#ffffff'} onChange={(e) => { updateLayer(layer.id, (o) => ({ ...o, color: e.target.value })); push({}) }} />
            </label>
          )}
        </Section>
      )}
      <Section title="Motion" defaultOpen={false}>
        <div style={{ fontSize: 11, opacity: 0.65 }}>Motion feel into frame {frame}</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {EASE_OPTS.map((o) => (
            <button key={o.id} onClick={() => { setEasePick(o.id); easeRef.current = o.id; push({}) }} title={`${o.tip} — auto-saves`} style={{ flex: 1, background: easeOpt === o.id ? 'var(--vs-sel)' : undefined, border: easeOpt === o.id ? '1px solid var(--vs-accent)' : undefined }}>{o.short}</button>
          ))}
        </div>
        {hasChart && <AnimTiming layer={layer} fps={fps} />}
      </Section>
      {live && <button onClick={dropPreview} style={{ marginTop: 6, width: '100%' }} title="Discard the pending edit before it auto-saves">Cancel pending edit</button>}
      <div style={{ marginTop: 8, fontSize: 11, opacity: 0.6, textAlign: 'center' }}>Keyframes save automatically at frame {frame} — move the playhead to animate elsewhere.</div>
      <div style={{ fontSize: 11, opacity: 0.65, margin: '8px 0 4px' }}>Keyframes — click a frame to jump, ✕ to delete</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {layer.keyframes.map((k, ki) => (
          <span key={ki} style={{ fontSize: 11, background: k.frame === frame ? 'var(--vs-accent)' : 'var(--vs-track)', color: k.frame === frame ? '#fff' : undefined, borderRadius: 4, padding: '2px 4px', display: 'flex', gap: 4, alignItems: 'center' }}>
            <button onClick={() => { setFrame(k.frame); onJump?.(k.frame) }} title="Jump playhead here" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>{k.frame}</button>
            <button onClick={() => deleteKeyframe(layer.id, ki)} title="Delete keyframe" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>✕</button>
          </span>
        ))}
      </div>
    </div>
  )
}

function ShapeSection({ layer }) {
  const updateLayer = useStudio(s => s.updateLayer)
  const d = layer.data || {}
  const kind = shapeKind(d.kind)
  const set = (patch) => updateLayer(layer.id, (o) => ({ ...o, data: { ...o.data, ...patch } }))
  const setFontSize = (n) => updateLayer(layer.id, (o) => ({ ...o, fontSize: Math.min(160, Math.max(12, Math.round(n))) }))
  const slider = (label, value, min, max, onChange, title) => (
    <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>{label} {Math.round(value)}
      <input type="range" min={min} max={max} step={1} value={Math.min(max, Math.max(min, value))} onChange={(e) => onChange(Number(e.target.value))} style={{ flex: 1 }} title={title} />
    </label>
  )
  return (
    <Section title="Shape" defaultOpen>
      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Kind
        <select value={kind.id} onChange={(e) => {
          const nk = shapeKind(e.target.value)
          set({ kind: nk.id, ...(nk.id === 'ring' && (d.strokeWidth ?? 4) < 8 ? { strokeWidth: 14 } : {}) })
        }} style={{ flex: 1, minWidth: 0 }} title="Shape geometry — label, paint, and keyframes are kept">
          {SHAPE_GROUPS.map((g) => (
            <optgroup key={g.id} label={g.label}>
              {SHAPE_KINDS.filter((k) => k.group === g.id).map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      {slider('Width', d.w || kind.defW, 40, 1200, (n) => set({ w: n }), 'Shape width in canvas pixels')}
      {slider('Height', d.h || kind.defH, 40, 900, (n) => set({ h: n }), 'Shape height in canvas pixels')}
      {slider('Label size', layer.fontSize ?? 48, 12, 160, setFontSize, 'Centered label text size')}
      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Fill
        <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(d.fill || '') ? d.fill : 'var(--vs-sel)'} onChange={(e) => set({ fill: e.target.value })} title={kind.id === 'ring' ? 'Ring is outline-only — fill is ignored' : 'Shape fill color'} />
        {kind.id === 'ring' && <span style={{ opacity: 0.55 }}>(ring ignores fill)</span>}
      </label>
      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Outline
        <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(d.stroke || '') ? d.stroke : 'var(--vs-accent)'} onChange={(e) => set({ stroke: e.target.value })} title="Shape outline color" />
      </label>
      {slider('Outline width', d.strokeWidth ?? 4, 0, 40, (n) => set({ strokeWidth: n }), 'Outline thickness in pixels (0 = none)')}
      {(kind.id === 'roundrect' || kind.id === 'callout') && slider('Corner radius', d.cornerRadius ?? Math.min(d.w || kind.defW, d.h || kind.defH) * (kind.id === 'callout' ? 0.08 : 0.18), 0, 200, (n) => set({ cornerRadius: n }), 'Rounded corner radius')}
    </Section>
  )
}

// Rotating header quips — one picked per session, next to the Donate button.
const HEADER_QUIPS = [
  "Save these animations from staring at an empty server.",
  "Even pixels need a roof over their heads.",
  "Don't let my hard work become a sad desktop icon.",
  "Be the hero who stops a developer from crying.",
  "My keyboard is crying. Spare a dollar for tissues?",
  "Support local code. It promises not to bite.",
  "Fuel my caffeine addiction so these slides keep moving.",
  "Help keep the internet colorful and slightly less boring.",
  "A coffee today keeps the 404 errors away.",
  "Pay now so you don't have to watch me cry later.",
  "Free animations cost money. Math is hard. Help.",
  "Your wallet is lighter, but your karma is glowing.",
  "Trade your spare change for legendary internet karma.",
  "Because free stuff usually costs someone their sanity.",
  "Invest in my procrastination. It's practically a charity.",
  "Donate now and feel like a modern-day Renaissance patron.",
  "Keep the animations free. Keep the creator fed.",
  "Drop a coin in the digital tip jar.",
  "Good slides. Zero cost. Voluntary appreciation welcome here.",
  'Help me keep the "free" in free platform.',
  "Sponsor a slide. Change a developer's afternoon.",
  "Your wallet won't feel it, but my server bill will.",
  "If you don't donate, the hamster powering this server quits.",
  "Donate today to prevent me from selling consulting insurance.",
  "Fund this platform before my cat forces me to.",
  "Even digital geniuses needs to eat sometimes.",
  "Pay it forward before the algorithm finds me.",
  "Because asking for money awkwardly builds character.",
]
function AssetsStage({ onAddImage, onAddTts, onAddMusic, onAddShape, simple }) {
  const scene = useStudio(s => s.scene)
  const updateSceneField = useStudio(s => s.updateSceneField)
  const images = useStudio(s => s.images)
  const attachImage = useStudio(s => s.attachImage)
  const removeImage = useStudio(s => s.removeImage)
  const audios = useStudio(s => s.audios)
  const attachAudio = useStudio(s => s.attachAudio)
  const removeAudio = useStudio(s => s.removeAudio)
  const setStatus = useStudio(s => s.setStatus)
  const bgFileRef = React.useRef(null)
  const imgFileRef = React.useRef(null)
  const audioFileRef = React.useRef(null)
  const [audioChoice, setAudioChoice] = React.useState('')
  const bg = /^#[0-9a-fA-F]{6}$/.test(scene.background || '') ? scene.background : '#10141d'
  async function onBgUpload(e) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      const img = await processImageFile(f)
      attachImage(img)
      updateSceneField('backgroundImage', img.dataUrl)
      setStatus(`Background set to ${img.name}.`, 'done')
    } catch { setStatus('Could not read that image file.', 'error') }
  }
  async function onImgUpload(e) {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    for (const f of files) {
      try { attachImage(await processImageFile(f)) }
      catch { setStatus(`Could not read ${f.name} — try PNG, JPG, GIF, WebP or SVG.`, 'error') }
    }
  }
  async function onAudioUpload(e) {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    for (const f of files) {
      if (f.size > 25 * 1024 * 1024) { setStatus(`${f.name} is over 25 MB — trim it first.`, 'error'); continue }
      const rd = new FileReader()
      await new Promise((res) => { rd.onload = res; rd.onerror = res; rd.readAsDataURL(f) })
      if (typeof rd.result === 'string' && rd.result.startsWith('data:audio')) {
        attachAudio({ id: `aud_${Date.now().toString(36)}`, name: f.name, dataUrl: rd.result })
      } else setStatus(`${f.name} is not an audio file — try WAV, MP3 or OGG.`, 'error')
    }
  }
  const box = { background: 'var(--vs-inset)', border: '1px solid var(--vs-border)', borderRadius: 6, padding: 6, display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }
  return (
    <div>
      <div style={box}>
        <div style={{ fontSize: 11, opacity: 0.65 }}>Background</div>
        <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Color
          <input type="color" value={bg} onChange={(e) => updateSceneField('background', e.target.value)} title="Video background color" />
        </label>
        {!simple && (
        <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Image
          <select value={images.find((m) => m.dataUrl === scene.backgroundImage)?.name || ''} onChange={(e) => { const m = images.find((x) => x.name === e.target.value); updateSceneField('backgroundImage', m ? m.dataUrl : '') }} title="Background image (transparent PNGs work too)" style={{ flex: 1, minWidth: 0 }}>
            <option value="">None</option>
            {images.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
          </select>
          <button onClick={() => bgFileRef.current?.click()} title="Upload a new background image (stored with the scene)">＋ Upload</button>
          <input ref={bgFileRef} type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.svg" style={{ display: 'none' }} onChange={onBgUpload} />
        </label>
        )}
        {!!scene.backgroundImage && (
          <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }} title="Background image opacity">Opacity {Math.round((scene.backgroundImageOpacity ?? 1) * 100)}%
            <input type="range" min={5} max={100} step={1} value={Math.round((scene.backgroundImageOpacity ?? 1) * 100)} onChange={(e) => updateSceneField('backgroundImageOpacity', Number(e.target.value) / 100)} style={{ flex: 1 }} />
          </label>
        )}
      </div>
      {!simple && (
      <div style={box}>
        <div style={{ fontSize: 11, opacity: 0.65 }}>Images — reference by name in prompts, or add as layers</div>
        {images.map((m) => (
          <div key={m.id} style={{ fontSize: 12, display: 'flex', gap: 6, background: 'var(--vs-deep)', borderRadius: 6, padding: '4px 8px', alignItems: 'center' }}>
            <img src={m.dataUrl} alt="" style={{ width: 28, height: 28, objectFit: 'cover', borderRadius: 4 }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${m.width}x${m.height}`}>{m.name}</span>
            <button onClick={() => onAddImage(m)} title="Add as a layer you can move, scale, fade and keyframe">Layer</button>
            <button onClick={() => removeImage(m.id)} title="Remove from assets">✕</button>
          </div>
        ))}
        {!images.length && <div style={{ fontSize: 11, opacity: 0.6 }}>No images yet.</div>}
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => imgFileRef.current?.click()} title="Attach PNG/JPG (transparency kept)">Attach images</button>
          <input ref={imgFileRef} type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.svg" multiple style={{ display: 'none' }} onChange={onImgUpload} />
        </div>
      </div>
      )}
      {!simple && (
      <div style={box}>
        <div style={{ fontSize: 11, opacity: 0.65 }}>Shapes — click to add, then style the label, paint, and keyframes on the right</div>
        {SHAPE_GROUPS.map((g) => (
          <div key={g.id} style={{ marginTop: 4 }}>
            <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 2 }}>{g.label}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {SHAPE_KINDS.filter((k) => k.group === g.id).map((k) => (
                <button key={k.id} onClick={() => onAddShape(k.id)} title={`Add ${k.label} — resizable, labeled, keyframable`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '4px 6px', minWidth: 58, background: 'var(--vs-deep)', color: 'var(--vs-text)', border: '1px solid var(--vs-border)', borderRadius: 6, cursor: 'pointer' }}>
                  <svg width={46} height={30} viewBox="0 0 46 30" style={{ display: 'block', background: 'var(--vs-stage)', borderRadius: 4 }}>
                    {shapeParts(k.id, 46, 30).map((p, i) => {
                      const { el: Tag, ...attrs } = p
                      return <Tag key={i} {...attrs} fill={k.id === 'ring' ? 'none' : 'var(--vs-sel)'} stroke="var(--vs-accent)" strokeWidth={3} strokeLinejoin="round" />
                    })}
                  </svg>
                  <span style={{ fontSize: 9, opacity: 0.8 }}>{k.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      )}
      {!simple && (
      <div style={box}>
        <div style={{ fontSize: 11, opacity: 0.65 }}>Audio — narration (TTS) & music tracks</div>
        {audios.map((a) => (
          <div key={a.id} style={{ fontSize: 12, display: 'flex', gap: 6, background: 'var(--vs-deep)', borderRadius: 6, padding: '4px 8px', alignItems: 'center' }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.name}>🎵 {a.name}</span>
            <button onClick={() => onAddMusic(a.id)} title="Add as a music track">Music</button>
            <button onClick={() => removeAudio(a.id)} title="Remove from assets">✕</button>
          </div>
        ))}
        {!audios.length && <div style={{ fontSize: 11, opacity: 0.6 }}>No audio yet — attach music, or add a narration track and generate it.</div>}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button onClick={() => audioFileRef.current?.click()} title="Attach WAV/MP3/OGG (kept with the session)">Attach audio</button>
          <input ref={audioFileRef} type="file" accept=".wav,.mp3,.ogg,.m4a,audio/*" multiple style={{ display: 'none' }} onChange={onAudioUpload} />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <select value={audioChoice} onChange={(e) => setAudioChoice(e.target.value)} title="Attached audio for the new track" style={{ flex: 1, minWidth: 0 }}>
            <option value="">Track audio…</option>
            {audios.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button onClick={() => onAddTts(audioChoice || undefined)} title="Add a narration track — type the script on the right, pick a voice, Generate speech">＋ TTS</button>
          <button onClick={() => onAddMusic(audioChoice || undefined)} title="Add the selected attached audio as a music track">＋ Music</button>
        </div>
      </div>
      )}
    </div>
  )
}

function summarizePatch(patch, layers) {
  const named = (i) => layers?.[Number(i)]?.name || `layer ${i}`
  const bits = (patch || []).slice(0, 4).map((op) => {
    const m = String(op.path || '').match(/^\/layers\/(\d+)\/(.+)$/)
    if (!m) return `${op.op} ${op.path}`
    const rest = m[2]
    if (rest === 'type') return `“${named(m[1])}” → ${op.value}`
    if (rest === 'data') return `“${named(m[1])}” data rebuilt`
    if (rest === 'orientation') return `“${named(m[1])}” orientation → ${op.value}`
    if (rest.startsWith('data/')) return `“${named(m[1])}” ${rest.slice(5)} updated`
    if (rest.startsWith('keyframes')) return `“${named(m[1])}” timing updated`
    return `“${named(m[1])}” ${rest} updated`
  })
  return bits.join('; ') + (patch.length > 4 ? ` (+${patch.length - 4} more)` : '')
}

// ---- Sequencer ----
// Multi-slide playlist assembled from history conversations. Items hold
// scene snapshots (history edits never corrupt the reel); the rail derives
// every start from the clips before it, so reorder/delete/close-gap ripple.
function SeqMusicLane({ getFrame, onJump, fps }) {
  const sequence = useStudio(s => s.sequence)
  const setSeqMusic = useStudio(s => s.setSeqMusic)
  const audios = useStudio(s => s.audios)
  const attachAudio = useStudio(s => s.attachAudio)
  const setStatus = useStudio(s => s.setStatus)
  const seqFileRef = React.useRef(null)
  async function onSeqAttach(e) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      const rd = new FileReader()
      await new Promise((res, rej) => { rd.onload = res; rd.onerror = rej; rd.readAsDataURL(f) })
      if (typeof rd.result !== 'string' || !rd.result.startsWith('data:audio')) { setStatus(`${f.name} is not an audio file — try WAV, MP3 or OGG.`, 'error'); return }
      const a = { id: `aud_${Date.now().toString(36)}`, name: f.name, dataUrl: rd.result }
      attachAudio(a)
      setSeqMusic({ assetUrl: a.dataUrl, name: a.name, offsetFrames: 0, keyframes: [{ frame: 0, properties: { volume: 0.8 } }] })
    } catch (err) { setStatus(`Attach failed: ${err.message}`, 'error') }
  }
  const music = sequence.music
  const kfs = [...(music?.keyframes || [])].sort((a, b) => a.frame - b.frame)
  const atPlayhead = () => Math.round(getFrame?.() ?? 0)
  const upsertVol = (frame, vol) => {
    const next = [...kfs]
    const ki = next.findIndex((k) => k.frame === frame)
    if (ki >= 0) next[ki] = { ...next[ki], properties: { ...next[ki].properties, volume: vol } }
    else next.push({ frame, properties: { volume: vol } })
    next.sort((a, b) => a.frame - b.frame)
    setSeqMusic({ ...music, keyframes: next })
  }
  const curVol = (() => {
    if (!kfs.length) return 0.8
    const f = atPlayheadSync()
    let v = Number(kfs[0].properties?.volume ?? 0.8)
    for (const k of kfs) if (k.frame <= f) v = Number(k.properties?.volume ?? v)
    return v
  })()
  function atPlayheadSync() { try { return Math.round(getFrame?.() ?? 0) } catch { return 0 } }
  if (!music) {
    return (
      <div style={{ fontSize: 11, opacity: 0.65, display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
        <span>🎵 Sequence bed — one music lane across the whole reel (clips keep their own tracks too; everything mixes).</span>
        <select value="" onChange={(e) => { const a = audios.find((x) => x.id === e.target.value); if (a) setSeqMusic({ assetUrl: a.dataUrl, name: a.name, offsetFrames: 0, keyframes: [{ frame: 0, properties: { volume: 0.8 } }] }) }} style={{ flex: 1, minWidth: 0 }} title="Pick attached audio as the sequence-wide bed">
          <option value="">Pick attached audio…</option>
          {audios.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button onClick={() => seqFileRef.current?.click()} title="Attach a fresh WAV/MP3/OGG and use it as the bed">Attach…</button>
        <input ref={seqFileRef} type="file" accept=".wav,.mp3,.ogg,.m4a,audio/*" style={{ display: 'none' }} onChange={onSeqAttach} />
      </div>
    )
  }
  return (
    <div style={{ marginTop: 6, background: 'var(--vs-panel)', borderRadius: 6, padding: '6px 8px' }}>
      <div style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }} title={music.name || 'Sequence bed'}>🎵 {music.name || 'Sequence bed'}</span>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }} title="Volume at the playhead — Set writes a volume keyframe there">Vol {Math.round(curVol * 100)}%
          <input type="range" min={0} max={200} step={1} value={Math.round(curVol * 100)} onChange={(e) => upsertVol(atPlayhead(), Number(e.target.value) / 100)} style={{ width: 110 }} />
        </label>
        <button onClick={() => upsertVol(atPlayhead(), curVol)} title="Write a volume keyframe at the playhead">Set @ {atPlayhead()}f</button>
        <button onClick={() => { const f = atPlayhead(); const v = curVol; upsertVol(0, 0); upsertVol(Math.min(f + 30, 3600), v) }} title="Fade in from silence to the current level over 30 frames">Fade in</button>
        <button onClick={() => { const f = atPlayhead(); upsertVol(f, curVol); upsertVol(f + 30, 0) }} title="Fade out to silence over 30 frames from here">Fade out</button>
        <button onClick={() => setSeqMusic(null)} title="Remove the sequence bed">✕</button>
      </div>
      {!!kfs.length && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
          {kfs.map((k, ki) => (
            <span key={ki} style={{ fontSize: 11, background: 'var(--vs-track)', borderRadius: 4, padding: '2px 4px', display: 'flex', gap: 4, alignItems: 'center' }}>
              <button onClick={() => onJump?.(k.frame)} title="Jump playhead here" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>{k.frame}f · {Math.round(Number(k.properties?.volume ?? 0) * 100)}%</button>
              <button onClick={() => setSeqMusic({ ...music, keyframes: kfs.filter((_, j) => j !== ki) })} title="Delete volume keyframe" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>✕</button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- Clip thumbnails (data-driven mini-preview) ----
// Real frame snapshots would need a Remotion context per card (a Player
// each — far too heavy) plus async font/audio loading. Instead this draws
// a static summary from the scene graph: background, titles, mini bars in
// the chart's real colors, shape glyphs in their real paint, and badges
// for audio/image layers. Cheap, offline, and enough to tell clips apart
// at rail/history size.
const THUMB_PALETTE = ['var(--vs-accent)', '#3ddc84', '#ffcf40', '#ff6b6b', '#b388ff', '#4dd0e1', '#ff9e40', '#f06292']
function ClipThumb({ scene, width = 132 }) {
  const h = Math.round((width * 9) / 16)
  const layers = scene?.layers || []
  const texts = layers.filter((l) => l.type === 'text')
  const title = texts[0]?.text || texts[0]?.name || ''
  const subtitle = texts[1]?.text || ''
  const chart = layers.find((l) => Array.isArray(l.data?.values) && l.data.values.length)
    || layers.find((l) => Array.isArray(l.data?.series?.[0]?.values))
  const series = chart?.data?.series?.[0]?.values || chart?.data?.values || []
  const max = Math.max(1e-9, ...series.slice(0, 12).map((v) => Number(v) || 0))
  const barColor = (i) => chart?.data?.pointColors?.[i]
    || chart?.data?.series?.[0]?.color
    || (chart?.data?.series?.[1] ? THUMB_PALETTE[i % THUMB_PALETTE.length] : 'var(--vs-accent)')
  const legend = (chart?.data?.legend || []).slice(0, 3)
  const shapes = layers.filter((l) => l.type === 'shape').slice(0, 4)
  const hasAudio = layers.some((l) => l.type === 'audio_tts' || l.type === 'audio_music')
  const hasImage = layers.some((l) => l.type === 'image_layer')
  return (
    <div style={{ width, height: h, borderRadius: 6, overflow: 'hidden', position: 'relative', flexShrink: 0, background: scene?.background || '#10141d', border: '1px solid var(--vs-border)' }}>
      {!!scene?.backgroundImage && <img src={scene.backgroundImage} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: scene.backgroundImageOpacity ?? 1 }} />}
      {!!title && (
        <div style={{ position: 'absolute', top: '6%', left: 0, right: 0, textAlign: 'center', fontSize: Math.max(8, Math.round(width / 16)), fontWeight: 800, color: 'var(--vs-bright)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 6px' }}>{String(title).slice(0, 40)}</div>
      )}
      {!!subtitle && !series.length && (
        <div style={{ position: 'absolute', top: '30%', left: 0, right: 0, textAlign: 'center', fontSize: Math.max(7, Math.round(width / 22)), color: '#c9d4e8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 6px' }}>{String(subtitle).slice(0, 48)}</div>
      )}
      {!!legend.length && (
        <div style={{ position: 'absolute', top: '6%', left: 4, display: 'flex', flexDirection: 'column', gap: 1 }}>
          {legend.map((g, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 6, color: 'var(--vs-text)' }}><span style={{ width: 5, height: 5, borderRadius: 2, background: g.color || THUMB_PALETTE[i % THUMB_PALETTE.length], display: 'inline-block' }} />{String(g.label || '').slice(0, 10)}</span>
          ))}
        </div>
      )}
      {!!series.length && (['line_chart', 'area_chart', 'scatter_chart'].includes(chart?.type) ? (
        <div style={{ position: 'absolute', left: '8%', right: '8%', bottom: '10%', height: '46%' }}>
          <svg viewBox="0 0 100 40" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
            <polyline points={series.slice(0, 12).map((v, i, a) => `${a.length === 1 ? 50 : (i / (a.length - 1)) * 100},${40 - Math.max(4, ((Number(v) || 0) / max) * 36)}`).join(' ')} fill="none" stroke={barColor(0)} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
            {series.slice(0, 12).map((v, i, a) => (
              <circle key={i} cx={a.length === 1 ? 50 : (i / (a.length - 1)) * 100} cy={40 - Math.max(4, ((Number(v) || 0) / max) * 36)} r={3.2} fill={barColor(i)} />
            ))}
          </svg>
        </div>
      ) : (
        <div style={{ position: 'absolute', left: '8%', right: '8%', bottom: '10%', height: '46%', display: 'flex', alignItems: 'flex-end', gap: 2 }}>
          {series.slice(0, 12).map((v, i) => (
            <div key={i} style={{ flex: 1, height: `${Math.max(6, ((Number(v) || 0) / max) * 100)}%`, background: barColor(i), borderRadius: 2, minWidth: 2 }} />
          ))}
        </div>
      ))}
      {!!shapes.length && !series.length && (
        <div style={{ position: 'absolute', inset: 0, top: title ? '22%' : 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
          {shapes.map((s, i) => (
            <svg key={i} width={Math.round(width / 6)} height={Math.round(width / 8)} viewBox="0 0 46 30" style={{ background: 'var(--vs-stage)', borderRadius: 3 }}>
              {shapeParts(s.data?.kind || 'rect', 46, 30).map((p, j) => {
                const { el: Tag, ...attrs } = p
                return <Tag key={j} {...attrs} fill={s.data?.fill || 'var(--vs-sel)'} stroke={s.data?.stroke || 'var(--vs-accent)'} strokeWidth={4} strokeLinejoin="round" />
              })}
            </svg>
          ))}
        </div>
      )}
      {(hasAudio || hasImage) && (
        <div style={{ position: 'absolute', bottom: 2, right: 3, fontSize: 8, opacity: 0.9 }}>{hasAudio ? '🎵' : ''}{hasImage ? '🖼' : ''}</div>
      )}
      {!title && !series.length && !shapes.length && layers.length > 0 && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, opacity: 0.6 }}>{layers.length} layer{layers.length === 1 ? '' : 's'}</div>
      )}
    </div>
  )
}

// Grabbable sequence playhead: a wide invisible strip centered on the red
// line, so grabbing the playhead never hits a clip block underneath.
// Positioned in PIXELS via frameToX (same layout as the ruler blocks and
// cards), so zoom changes re-seat it instantly — the old % positioning
// drifted whenever CARD_MIN/GAP_MIN clamps kicked in at low zoom.
function SeqPlayhead({ getFrame, duration, onScrub, frameToX }) {
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    let raf = 0
    let last = -1
    const tick = () => {
      const f = Math.round(getFrame?.() ?? 0)
      if (f !== last) { last = f; setFrame(f) }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [getFrame])
  const clamped = Math.min(Math.max(0, frame), Math.max(1, duration))
  const left = Math.max(0, Math.round(typeof frameToX === 'function' ? frameToX(clamped) : 0))
  return (
    <>
      <div style={{ position: 'absolute', top: 0, bottom: 0, left, width: 2, background: '#ff5252', pointerEvents: 'none', zIndex: 3 }} />
      <div onPointerDown={(e) => { e.stopPropagation(); onScrub?.(true); try { e.currentTarget.setPointerCapture(e.pointerId) } catch {} }}
        onPointerMove={(e) => { if (e.buttons) onScrub?.(e) }}
        onPointerUp={() => onScrub?.(false)}
        onPointerCancel={() => onScrub?.(false)}
        onLostPointerCapture={() => onScrub?.(false)}
        title="Drag the red line to scrub (wide grab strip — top/bottom handles included)" style={{ position: 'absolute', top: -12, bottom: -12, left: Math.max(0, left - 40), width: 80, cursor: 'ew-resize', zIndex: 5, touchAction: 'none', background: 'rgba(255,82,82,0.14)', border: '1px solid rgba(255,82,82,0.6)', borderRadius: 6 }}>
          <span style={{ position: 'absolute', top: -1, left: '50%', transform: 'translateX(-50%)', width: 26, height: 10, background: '#ff5252', borderRadius: '0 0 6px 6px' }} />
          <span style={{ position: 'absolute', bottom: -1, left: '50%', transform: 'translateX(-50%)', width: 26, height: 10, background: '#ff5252', borderRadius: '6px 6px 0 0' }} />
        </div>
    </>
  )
}

function SequencerPanel({ getFrame, onJump, onExportSeq, rendering, playerRef }) {
  const sequence = useStudio(s => s.sequence)
  const conversations = useStudio(s => s.conversations)
  const addSeqItem = useStudio(s => s.addSeqItem)
  const removeSeqItem = useStudio(s => s.removeSeqItem)
  const moveSeqItem = useStudio(s => s.moveSeqItem)
  const moveSeqItemTo = useStudio(s => s.moveSeqItemTo)
  const updateSeqItem = useStudio(s => s.updateSeqItem)
  const clearSequence = useStudio(s => s.clearSequence)
  const seqSelectedId = useStudio(s => s.seqSelectedId)
  const setSeqSelectedId = useStudio(s => s.setSeqSelectedId)
  const setSeqStopAt = useStudio(s => s.setSeqStopAt)
  const setSeqMode = useStudio(s => s.setSeqMode)
  const setStatus = useStudio(s => s.setStatus)
  const { clips, total } = React.useMemo(() => seqLayout(sequence), [sequence])
  const canvas = seqCanvas(sequence)
  const [dragId, setDragId] = React.useState(null)
  const [dropIdx, setDropIdx] = React.useState(null)
  const secs = (f) => `${f}f (${(f / Math.max(1, canvas.fps)).toFixed(1)}s)`
  function jumpIntoClip(item) {
    const st = useStudio.getState()
    try {
      st.setScene(validateScene(normalizeScene(item.scene)))
    } catch (e) { st.setStatus(`Could not open clip: ${e.message}`, 'error'); return }
    // Detach from History: this is a sequence clip, not a history slide —
    // without this the 800ms autosync would write the clip (and its edits)
    // into whichever history entry was active, destroying that slide.
    st.setActiveConvo(null)
    st.selectLayer(null)
    st.setSeqMode(false)
    st.setEditingSeqId(item.id)
    st.setStatus(`Editing sequence clip “${item.name}” — save it as a new version when done.`, 'info')
    onJump?.(0)
  }
  // "Continue from" duplicate: fork the clip into a renamed history copy
  // placed right after itself, so the user edits a differently-named slide
  // while the original stays intact in both reel and history.
  function duplicateVariation(item, index) {
    const st = useStudio.getState()
    let scene = null
    try { scene = validateScene(normalizeScene(item.scene)) } catch (e) { st.setStatus(`Could not duplicate clip: ${e.message}`, 'error'); return }
    const name = window.prompt('Duplicate as:', `${item.name} (copy)`)
    if (name === null) return
    const convo = st.addConversation(name.trim() || `${item.name} (copy)`, scene)
    st.addSeqItem(convo, index + 1)
    st.setStatus(`Duplicated as “${convo.title}” right after the original — edit the copy freely.`, 'done')
  }
  function onRailDrop(e) {
    e.preventDefault()
    const st = useStudio.getState()
    const at = dropIdx == null ? st.sequence.items.length : dropIdx
    const seqId = e.dataTransfer.getData('text/vs-seq')
    if (seqId) {
      if (seqId !== dragId) moveSeqItem(seqId, at)
    } else {
      const convoId = e.dataTransfer.getData('text/vs-convo')
      const c = st.conversations.find((x) => x.id === convoId)
      if (c) addSeqItem(c, at)
    }
    setDragId(null); setDropIdx(null)
  }
  // Horizontal reorder: press-and-hold the grip, drag left/right, release
  // to drop — with a live vertical insertion line. Pointer-based (not
  // native HTML5 drag), so it works the same on every card size.
  const railRef = React.useRef(null)
  const rulerRef = React.useRef(null)
  const [grab, setGrab] = React.useState(null) // {id, over} — over is a post-removal index
  const grabRef = React.useRef(null) // sync copy of the dragged id (no stale closures)
  // Drop target measured against the REMAINING cards (dragged one excluded),
  // so dropping clip #1 past clip #2's midpoint lands at the end — the old
  // pre-removal math mapped that drop back onto the original slot.
  function railIndexFromEvent(e, excludeId) {
    const el = railRef.current
    const rest = el ? [...el.querySelectorAll('[data-seq-card]')].filter((c) => c.dataset.seqId !== (excludeId || grabRef.current)) : []
    for (let i = 0; i < rest.length; i++) {
      const r = rest[i].getBoundingClientRect()
      if (e.clientX < r.left + r.width / 2) return i
    }
    return rest.length
  }
  const dragIdx = grab ? clips.findIndex(({ item }) => item.id === grab.id) : -1
  const restLen = dragIdx >= 0 ? clips.length - 1 : clips.length
  // Post-removal position of card i (the dragged card keeps no slot).
  const lineFor = (i) => grab && dragIdx >= 0 && (i > dragIdx ? i - 1 : i) === grab.over
  // Shared px-per-frame scale for ruler + cards, so the two stay aligned.
  // The reel auto-fits its full width on every clip change (zoom out =
  // shrink-to-fit, zoom in scrolls horizontally). Manual zoom sticks
  // until the clip list changes again.
  const [seqZoom, setSeqZoom] = React.useState(1)
  const [seqAutoFit, setSeqAutoFit] = React.useState(true)
  const BASE_PPF = 2.2
  const SEQ_ZOOM_MIN = 0.05
  const ppf = BASE_PPF * seqZoom
  function seqFitZoom() {
    try {
      const wrap = railRef.current?.parentElement
      const avail = (wrap?.clientWidth || 900) - 8
      const need = Math.max(1, total * BASE_PPF)
      return Math.max(SEQ_ZOOM_MIN, Math.round(Math.min(1, avail / need) * 100) / 100)
    } catch { return 1 }
  }
  React.useEffect(() => {
    if (!seqAutoFit) return
    setSeqZoom(seqFitZoom())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, clips.length])
  // Shared pixel layout: ruler segments and cards derive from the same
  // per-clip widths, so the two stay pixel-aligned at every zoom (the old
  // code sized the ruler in % of the viewport and the rail in px, so they
  // diverged the moment anything scrolled). Card minimums are included in
  // the offsets, so over-long reels still line up when min-widths kick in.
  const CARD_MIN = 48
  const GAP_MIN = 26
  const railLayout = React.useMemo(() => {
    let x = 0
    const rows = clips.map(({ item, start, dur }) => {
      const px = Math.max(CARD_MIN, Math.round(dur * ppf))
      const gapPx = Math.max(GAP_MIN, Math.round(Number(item.gapAfter || 0) * ppf))
      const row = { item, start, dur, px, gapPx, x }
      x += px + 4 + gapPx + 4 // card + flex gaps on both sides
      return row
    })
    return { rows, railW: Math.max(1, Math.round(x + 60)) } // + drop zone
  }, [clips, ppf])
  const railW = railLayout.railW
  // Pixel-exact frame <-> x mapping, derived from the SAME railLayout as
  // the ruler blocks and cards (min-widths, gaps and flex spacing
  // included). Both directions re-derive from `ppf`, so zoom changes
  // re-calibrate the playhead and scrubbing instantly on the next render —
  // the old proportional (% of rail width) math drifted into the wrong
  // clip / blank space whenever CARD_MIN/GAP_MIN clamps kicked in.
  const frameToX = React.useCallback((f) => {
    const rows = railLayout.rows
    if (!rows.length || !total) return 0
    const ff = Math.min(Math.max(0, Math.round(Number(f) || 0)), total)
    for (const row of rows) {
      const gap = Math.max(0, Math.round(Number(row.item.gapAfter) || 0))
      if (ff < row.start + row.dur) {
        const t = row.dur > 0 ? (ff - row.start) / row.dur : 0
        return row.x + t * row.px
      }
      if (gap > 0 && ff < row.start + row.dur + gap) {
        const gapW = 4 + row.gapPx + 4
        return row.x + row.px + ((ff - row.start - row.dur) / gap) * gapW
      }
      if (gap <= 0 && ff < row.start + row.dur) return row.x + row.px
    }
    const last = rows[rows.length - 1]
    const lastGap = Math.max(0, Math.round(Number(last.item.gapAfter) || 0))
    return last.x + last.px + (lastGap > 0 ? 4 + last.gapPx + 4 : 0)
  }, [railLayout, total])
  const xToFrame = React.useCallback((dx) => {
    const rows = railLayout.rows
    if (!rows.length || !total) return 0
    if (dx <= 0) return 0
    for (const row of rows) {
      const gap = Math.max(0, Math.round(Number(row.item.gapAfter) || 0))
      const cardEnd = row.x + row.px
      if (dx < cardEnd) {
        const t = row.px > 0 ? (dx - row.x) / row.px : 0
        return Math.round(row.start + Math.min(Math.max(0, t), 1) * row.dur)
      }
      const gapEnd = cardEnd + 4 + row.gapPx + 4
      if (dx < gapEnd) {
        // Visual-only padding around a zero gap snaps to the boundary;
        // a real gap interpolates across its full visual span.
        if (gap <= 0) return Math.min(total, row.start + row.dur)
        const t = (dx - cardEnd) / Math.max(1, gapEnd - cardEnd)
        return Math.round(row.start + row.dur + Math.min(Math.max(0, t), 1) * gap)
      }
    }
    return total
  }, [railLayout, total])
  const seqFrameAtX = (clientX, bar) => {
    if (!bar || !total) return 0
    return xToFrame(clientX - bar.left)
  }
  const seqScrub = React.useRef(false)
  const clipAtFrame = (f) => clips.find(({ start, dur }) => f >= start && f < start + dur)?.item || null
  const scrubTo = (arg) => {
    // Called with true/false from the playhead grabber, or a pointer
    // event from ruler drags: resolve the frame from the ruler element.
    // NOTE: the ruler is a sibling of the card rail, not a child — so it
    // needs its own ref (querying inside railRef always missed and made
    // every playhead/ruler drag a silent no-op).
    if (arg === true || arg === false) { seqScrub.current = arg; return }
    const ruler = rulerRef.current
    if (!ruler) return
    const f = seqFrameAtX(arg.clientX, ruler.getBoundingClientRect())
    const hit = clipAtFrame(f)
    if (hit) setSeqSelectedId(hit.id)
    onJump?.(f)
  }
  const rulerDown = (e) => {
    seqScrub.current = true
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    const ruler = rulerRef.current
    const bar = ruler?.getBoundingClientRect()
    const f = bar ? seqFrameAtX(e.clientX, bar) : 0
    // Clicking / grabbing the timeline also selects the clip under the
    // cursor, so the card below highlights and the preview follows.
    // Manual control disarms clip-only playback (see playClipOnly).
    const hit = clipAtFrame(f)
    if (hit) setSeqSelectedId(hit.id)
    useStudio.getState().setSeqStopAt(null)
    onJump?.(f)
  }
  const rulerMove = (e) => { if (seqScrub.current && e.buttons) scrubTo(e) }
  const rulerUp = () => { seqScrub.current = false }
  // Press-to-seek: selecting + seeking on press (not release) means a press
  // that slides off the card can never swallow the *next* click. Card-body
  // drags do nothing (reorder starts on the ⋮⋮ grip), so nothing is lost.
  // Global play/pause for the reel, reflecting live player state.
  const [playing, setPlaying] = React.useState(false)
  React.useEffect(() => {
    const t = setInterval(() => {
      try { setPlaying(!!playerRef?.current?.isPlaying?.()) } catch { /* ignore */ }
    }, 400)
    return () => clearInterval(t)
  }, [playerRef])
  // Clip-only playback: card ▶ plays just that clip, then auto-pauses at
  // its end (reel ▶ and Space play through). A 100ms watcher enforces the
  // stop; every manual seek disarms it, so taking control never fights you.
  React.useEffect(() => {
    const t = setInterval(() => {
      try {
        const st = useStudio.getState()
        const stop = st.seqStopAt
        if (stop == null) return
        const p = playerRef?.current
        if (!p || !p.isPlaying?.()) return
        if (Math.round(p.getCurrentFrame?.() ?? 0) >= stop) {
          st.setSeqStopAt(null)
          p.pause?.()
          p.seekTo?.(stop)
        }
      } catch { /* player not mounted yet */ }
    }, 100)
    return () => clearInterval(t)
  }, [playerRef])
  function playClipOnly(item, start, dur) {
    setSeqSelectedId(item.id)
    setSeqStopAt(start + Math.max(1, Math.round(dur)) - 1)
    onJump?.(start)
    setStatus(`Playing “${item.name}” only — reel ▶ plays the whole sequence.`, 'info')
    const p = playerRef?.current
    if (!p) return
    // Seek-then-play: the seek moves off any parked-at-end position, so
    // unlike a bare play() this can't no-op. The delay lets the seek land.
    setTimeout(() => { try { if (!p.isPlaying?.()) p.play?.() } catch {} }, 80)
  }
  const togglePlay = () => {
    try {
      const p = playerRef?.current
      if (!p) return
      if (p.isPlaying?.()) { p.pause(); return }
      useStudio.getState().setSeqStopAt(null)
      // Restart when parked on the last frame — Remotion's play() is a
      // no-op there, which read as "the play button doesn't work".
      const cur = Math.round(p.getCurrentFrame?.() ?? 0)
      if (cur >= total - 1 && total > 1) { p.seekTo?.(0); setTimeout(() => { try { p.play?.() } catch {} }, 60) }
      else p.play?.()
      setStatus(`Playing full sequence — ${clips.length} clip${clips.length === 1 ? '' : 's'}, ${secs(total)}.`, 'info')
    } catch { /* player not mounted yet */ }
  }
  return (
    <div style={{ borderTop: '1px solid var(--vs-line)', padding: 12, overflowX: 'hidden', overflowY: 'auto', minHeight: 150, maxHeight: 420, background: 'var(--vs-rail)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, opacity: 0.9, display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={togglePlay} disabled={!clips.length} title={playing ? 'Pause the sequence (Space)' : 'Play the whole sequence (Space)'} style={{ fontSize: 14, padding: '2px 10px', fontWeight: 700 }}>{playing ? '⏸' : '▶'}</button>
        <span>Sequence · {clips.length} clip{clips.length === 1 ? '' : 's'} · {secs(total)}</span>
        <span style={{ fontWeight: 400, opacity: 0.55 }}>{canvas.width}×{canvas.height} · first clip sets the canvas</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontWeight: 400, display: 'flex', gap: 4, alignItems: 'center' }} title="Timeline zoom — zooming in scrolls horizontally">
          <button onClick={() => { setSeqAutoFit(false); setSeqZoom((z) => Math.max(SEQ_ZOOM_MIN, Math.round((z - 0.25) * 100) / 100)) }} disabled={seqZoom <= SEQ_ZOOM_MIN} title="Zoom out">−</button>
          <span style={{ fontSize: 11, minWidth: 44, textAlign: 'center' }}>{Math.round(seqZoom * 100)}%</span>
          <button onClick={() => { setSeqAutoFit(false); setSeqZoom((z) => Math.min(6, Math.round((z + 0.25) * 100) / 100)) }} title="Zoom in">+</button>
          <button onClick={() => { setSeqAutoFit(true); setSeqZoom(seqFitZoom()) }} title="Fit the whole reel">Fit</button>
        </span>
        <button onClick={() => setSeqMode(false)} title="Back to the single-scene editor">Scene editor</button>
        <button onClick={() => { if (window.confirm('Clear the whole sequence? (History is kept.)')) clearSequence() }} disabled={!clips.length} title="Remove all clips — history is kept">Clear</button>
      </div>
      {clips.length ? (
        <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
          <div ref={railRef} style={{ width: Math.max(railW, 300), minWidth: '100%' }}>
          <div data-seq-ruler ref={rulerRef} style={{ position: 'relative', height: 40, background: 'var(--vs-ruler)', borderRadius: 6, cursor: 'ew-resize', touchAction: 'none', marginBottom: 8, overflow: 'hidden' }} title="Click or drag to scrub the sequence (edges snap; grab the red line to scrub)"
            onPointerDown={rulerDown} onPointerMove={rulerMove} onPointerUp={rulerUp} onPointerCancel={rulerUp} onLostPointerCapture={rulerUp}>
            {railLayout.rows.map(({ item, start, dur, px, x }, i) => (
              <div key={item.id} style={{ position: 'absolute', top: 5, bottom: 5, left: x, width: Math.max(2, px), background: seqSelectedId === item.id ? '#2f5da8' : 'var(--vs-block)', border: seqSelectedId === item.id ? '1px solid var(--vs-accent)' : '1px solid var(--vs-block-bd)', borderRadius: 4, overflow: 'hidden', pointerEvents: 'none' }}>
                <span style={{ fontSize: 10, padding: '0 4px', whiteSpace: 'nowrap', color: 'var(--vs-text)' }}>{i + 1} · {item.name} · {secs(dur)}</span>
              </div>
            ))}
            <SeqPlayhead getFrame={getFrame} duration={Math.max(1, total)} onScrub={scrubTo} frameToX={frameToX} />
          </div>
          <div onDragOver={(e) => e.preventDefault()} onDrop={onRailDrop} style={{ display: 'flex', alignItems: 'stretch', gap: 4 }} title="Drag the ⋮⋮ grip left/right to reorder · Delete key removes the selected clip">
          {railLayout.rows.map(({ item, start, dur, px, gapPx }, i) => (
            <React.Fragment key={item.id}>
              {grab && item.id !== grab.id && lineFor(i) && (
                <div style={{ width: 4, background: 'var(--vs-accent)', borderRadius: 2, flexShrink: 0 }} />
              )}
              <div data-seq-card data-seq-id={item.id} onPointerDown={() => { setSeqSelectedId(item.id); setSeqStopAt(null); onJump?.(start) }} onContextMenu={(e) => { e.preventDefault(); jumpIntoClip(item) }} title="Click to select + seek · right-click to edit" style={{ width: px, flexShrink: 0, background: seqSelectedId === item.id ? 'var(--vs-sel)' : 'var(--vs-card)', border: seqSelectedId === item.id ? '1px solid var(--vs-accent)' : '1px solid var(--vs-border)', borderRadius: 8, padding: 6, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4, opacity: grab && grab.id === item.id ? 0.45 : 1, overflow: 'hidden' }}>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); grabRef.current = item.id; setGrab({ id: item.id, over: railIndexFromEvent(e, item.id) }) }}
                    onPointerMove={(e) => { if (grabRef.current === item.id) setGrab({ id: item.id, over: railIndexFromEvent(e, item.id) }) }}
                    onPointerUp={(e) => { e.stopPropagation(); const id = grabRef.current; grabRef.current = null; setGrab(null); if (id === item.id) moveSeqItemTo(item.id, railIndexFromEvent(e, item.id)) }}
                    onPointerCancel={() => { grabRef.current = null; setGrab(null) }}
                    title="Drag left/right to reorder" style={{ cursor: 'grab', color: '#8a93a8', fontSize: 13, padding: '0 2px', touchAction: 'none' }}>⋮⋮</span>
                  <span style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}><span style={{ opacity: 0.55, fontWeight: 400 }}>{i + 1} · </span>{item.name}</span>
                  <button onClick={(e) => { e.stopPropagation(); removeSeqItem(item.id) }} title="Remove from sequence (history kept)" style={{ background: '#2a1418', border: '1px solid #6e2a33', color: '#ff9a9a', cursor: 'pointer', padding: '0 5px', borderRadius: 6, fontSize: 12, lineHeight: 1.4 }}>✕</button>
                </div>
                <ClipThumb scene={item.scene} width={Math.min(200, Math.max(32, px - 16))} />
                <div style={{ fontSize: 11, opacity: 0.65 }}>{secs(dur)} · starts {secs(start)}</div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button onClick={(e) => { e.stopPropagation(); playClipOnly(item, start, dur) }} title="Play this clip only (auto-pauses at its end) — reel ▶ plays everything">▶</button>
                  <button onClick={(e) => { e.stopPropagation(); jumpIntoClip(item) }} title="Edit this clip (loads it into the scene editor)">✎</button>
                  <button onClick={(e) => { e.stopPropagation(); duplicateVariation(item, i) }} title="Duplicate this clip into a renamed copy right after itself">⧉</button>
                </div>
              </div>
              <div style={{ width: gapPx, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {Math.round(Number(item.gapAfter) || 0) > 0 ? (
                  <button onClick={() => updateSeqItem(item.id, { gapAfter: 0 })} title={`Close the ${Math.round(Number(item.gapAfter) || 0)}f gap — later clips pull in`} style={{ fontSize: 11, border: '1px dashed var(--vs-accent)', borderRadius: 6, padding: '4px 6px', background: 'none', color: 'var(--vs-accent)', cursor: 'pointer' }}>⇥ {Math.round(Number(item.gapAfter) || 0)}f</button>
                ) : (
                  <button onClick={() => updateSeqItem(item.id, { gapAfter: 30 })} title="Add a 30-frame gap after this clip" style={{ fontSize: 11, opacity: 0.5, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>+gap</button>
                )}
              </div>
            </React.Fragment>
          ))}
            {grab && dragIdx >= 0 && grab.over === restLen && (
              <div style={{ width: 4, background: 'var(--vs-accent)', borderRadius: 2, flexShrink: 0 }} />
            )}
            <div onDragOver={(e) => { e.preventDefault(); setDropIdx(clips.length) }} style={{ minWidth: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.5, fontSize: 11 }}>drop →</div>
          </div>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12, opacity: 0.65, padding: '8px 0' }}>Empty reel — drag history items here, or press ＋Seq on any history conversation. The sequence preview above plays clips back-to-back.</div>
      )}
      <SeqMusicLane getFrame={getFrame} onJump={onJump} fps={canvas.fps} />
      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>▶ on a card plays that clip only · reel ▶ (or Space) plays everything · right-click a clip to edit it · Delete removes the selected clip · gap badges ⇥ close the gap.</div>
    </div>
  )
}

function Timeline({ scene, getFrame, selectedId, onSelectTrack, onAddText, onSeek }) {
  const scrubbing = React.useRef(false)
  // Fit-to-page time scale: every track shares one scale pinned to the
  // longest content (scene duration, layer ends, keyframes), so extending
  // one track shortens the others proportionally instead of scrolling.
  // Zoom only introduces scrolling once you zoom past 100%.
  const [zoom, setZoom] = React.useState(1)
  const timeMax = Math.max(1, scene.durationInFrames,
    ...scene.layers.map((l) => l.endFrame ?? 0),
    ...scene.layers.flatMap((l) => (l.keyframes || []).map((k) => k.frame ?? 0)))
  const frameFromX = (clientX, bar) => {
    if (!bar || !bar.width) return null
    // Forgiving edges: the first/last 8px snap to 0/timeMax, so the very
    // start/end are clickable even with a keyframe diamond sitting on them.
    if (clientX <= bar.left + 8) return 0
    if (clientX >= bar.right - 8) return timeMax
    return Math.round(Math.min(1, Math.max(0, (clientX - bar.left) / bar.width)) * timeMax)
  }
  const frameFromEvent = (e) => frameFromX(e.clientX, e.currentTarget.getBoundingClientRect())
  const seekFrame = (f) => { if (Number.isFinite(f)) onSeek?.(f) }
  // The playhead grab strip is 24px wide, so resolve against its parent
  // (the lane) — never against the strip itself.
  const frameFromGrab = (e) => frameFromX(e.clientX, e.currentTarget.parentElement?.getBoundingClientRect())
  const grabDown = (e) => { scrubbing.current = true; try { e.currentTarget.setPointerCapture(e.pointerId) } catch {} ; seekFrame(frameFromGrab(e)) }
  const grabMove = (e) => { if (scrubbing.current && e.buttons) seekFrame(frameFromGrab(e)) }
  const grabEnd = () => { scrubbing.current = false }
  const [menu, setMenu] = React.useState(null)
  const addLayer = useStudio(s => s.addLayer)
  const renameLayer = useStudio(s => s.renameLayer)
  const deleteLayer = useStudio(s => s.deleteLayer)
  const updateLayer = useStudio(s => s.updateLayer)
  const moveKeyframe = useStudio(s => s.moveKeyframe)
  const commitKeyframes = useStudio(s => s.commitKeyframes)
  const trimLayer = useStudio(s => s.trimLayer)
  const commitLayerTrim = useStudio(s => s.commitLayerTrim)
  const trimStartLayer = useStudio(s => s.trimStartLayer)
  const commitStartTrim = useStudio(s => s.commitStartTrim)
  // Edge-trim drags: snapshot the lane geometry + scale at grab time so
  // the frame mapping stays stable even as the trimmed edge moves timeMax.
  const trimRef = React.useRef(null)
  const trimFrameAt = (clientX) => {
    const t = trimRef.current
    if (!t || !t.rect?.width) return null
    const ratio = Math.min(1, Math.max(0, (clientX - t.rect.left) / t.rect.width))
    const raw = Math.round(ratio * t.timeMax)
    if (t.edge === 'start') return Math.max(0, Math.min(t.endFrame - 1, raw))
    return Math.min(t.timeMax, Math.max(t.startFrame + 1, raw))
  }
  const setScene = useStudio(s => s.setScene)
  const setStatus = useStudio(s => s.setStatus)
  // Snap the scene length to the longest layer. Stray keyframes past the
  // end are pulled in (deduped) so the dead tail truly closes — one history
  // entry, fully undoable. Growing stays automatic (see fitDurationOut).
  function trimToContent() {
    if (!scene.layers.length) return
    const maxEnd = Math.max(1, ...scene.layers.map((l) => Math.max(0, Math.round(Number(l.endFrame) || 0))))
    let pulled = 0
    const layers = scene.layers.map((l) => {
      const seen = new Set()
      const keyframes = []
      for (const k of (l.keyframes || [])) {
        const f = Math.min(Math.max(0, Math.round(Number(k.frame) || 0)), maxEnd)
        if (f !== k.frame) pulled++
        if (seen.has(f)) continue
        seen.add(f)
        keyframes.push(f === k.frame ? k : { ...k, frame: f })
      }
      return { ...l, keyframes: keyframes.length ? keyframes : [{ frame: 0, properties: {} }] }
    })
    setScene({ ...scene, durationInFrames: maxEnd, layers })
    setStatus(pulled
      ? `Trimmed scene to ${maxEnd}f; ${pulled} stray keyframe${pulled === 1 ? '' : 's'} pulled in.`
      : `Trimmed scene to ${maxEnd}f.`, 'done')
  }
  const [collapsed, setCollapsed] = React.useState(() => new Set())
  const toggleTrack = (id) => setCollapsed((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return (
    <div style={{ borderTop: '1px solid var(--vs-line)', padding: 12, overflowX: 'auto', overflowY: 'auto', minHeight: 96, maxHeight: 360, background: 'var(--vs-rail)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, opacity: 0.8, display: 'flex', alignItems: 'center', gap: 8 }}>Timeline · {scene.layers.length} track{scene.layers.length === 1 ? '' : 's'} · {scene.durationInFrames} frames<span style={{ flex: 1 }} /><div style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 400 }} title="Timeline zoom — 100% fits the whole scene, zooming in scrolls"><button onClick={() => setZoom((z) => Math.max(1, Math.round((z - 0.25) * 100) / 100))} disabled={zoom <= 1} title="Zoom out">−</button><span style={{ fontSize: 11, minWidth: 38, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.25) * 100) / 100))} title="Zoom in">+</button><button onClick={() => setZoom(1)} disabled={zoom === 1} title="Fit the whole scene">Fit</button><button onClick={trimToContent} disabled={!scene.layers.length} title="Snap scene length to the longest layer (stray keyframes pulled in too)">Trim</button></div>{scene.layers.length > 1 && (<><button onClick={() => setCollapsed(new Set(scene.layers.map((l) => l.id)))} title="Collapse all tracks">Collapse all</button><button onClick={() => setCollapsed(new Set())} title="Expand all tracks">Expand all</button></>)}</div>
      {!scene.layers.length && (
        <div style={{ fontSize: 13, opacity: 0.65, padding: '8px 0' }}>No tracks yet — generate a scene and its layers, clips and keyframe diamonds will appear here.</div>
      )}
      {scene.layers.map((l, li) => (
        <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: collapsed.has(l.id) ? 4 : 10 }}>
          <div onClick={() => onSelectTrack?.(l.id)} title="Select layer — right-click to rename / delete" onContextMenu={(e) => { e.preventDefault(); setMenu({ id: l.id, x: e.clientX, y: e.clientY }) }} style={{ width: 180, fontSize: 13, cursor: 'pointer', color: 'var(--vs-bright)', background: selectedId === l.id ? 'var(--vs-sel)' : 'var(--vs-card)', border: selectedId === l.id ? '1px solid var(--vs-accent)' : '1px solid var(--vs-border)', borderRadius: 4, padding: '3px 6px', display: 'flex', alignItems: 'center', gap: 4 }}><button onClick={(e) => { e.stopPropagation(); toggleTrack(l.id) }} title={collapsed.has(l.id) ? 'Expand track' : 'Collapse track'} style={{ background: 'none', border: 'none', color: '#9fb3d8', cursor: 'pointer', padding: 0, fontSize: 12 }}>{collapsed.has(l.id) ? '▸' : '▾'}</button><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(l.name || '').trim() ? l.name : <i style={{ opacity: 0.6 }}>Untitled</i>} <span style={{ color: '#9fb3d8' }}>({l.type === 'audio_tts' ? 'voice' : l.type === 'audio_music' ? 'music' : l.type})</span></span></div>
          {!collapsed.has(l.id) && (<>
          <div style={{ position: 'relative', flex: zoom === 1 ? 1 : 'none', width: zoom === 1 ? undefined : `${Math.round(zoom * 100)}%`, height: 34, background: 'var(--vs-ruler)', borderRadius: 6, cursor: 'ew-resize', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' }} title="Click or drag to scrub the playhead (edges snap; Home/End jump to start/end)"
            onPointerDown={(e) => { scrubbing.current = true; try { e.currentTarget.setPointerCapture(e.pointerId) } catch {} ; seekFrame(frameFromEvent(e)) }}
            onPointerMove={(e) => { if (scrubbing.current && e.buttons) seekFrame(frameFromEvent(e)) }}
            onPointerUp={() => { scrubbing.current = false }}
            onPointerCancel={() => { scrubbing.current = false }}
            onLostPointerCapture={() => { scrubbing.current = false }}>
            <Playhead getFrame={getFrame} duration={timeMax} onGrabDown={grabDown} onGrabMove={grabMove} onGrabUp={grabEnd} />
            <div style={{
              position: 'absolute', top: 4, bottom: 4,
              left: `${(l.startFrame / timeMax) * 100}%`,
              width: `${Math.max(2, ((l.endFrame - l.startFrame) / timeMax) * 100)}%`,
              background: 'var(--vs-block)', borderRadius: 4, border: '1px solid var(--vs-block-bd)',
            }}>
              <div title={`Drag to set when “${l.name || 'layer'}” starts (now ${l.startFrame}f${l.type === 'audio_tts' || l.type === 'audio_music' ? ' — audio plays from here' : ''})`}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  scrubbing.current = false
                  try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
                  const lane = e.currentTarget.parentElement?.parentElement
                  trimRef.current = { id: l.id, edge: 'start', rect: lane?.getBoundingClientRect(), timeMax, endFrame: l.endFrame }
                  const f = trimFrameAt(e.clientX)
                  if (Number.isFinite(f)) trimStartLayer(l.id, f)
                }}
                onPointerMove={(e) => {
                  const t = trimRef.current
                  if (t && t.id === l.id && t.edge === 'start' && e.buttons) {
                    const f = trimFrameAt(e.clientX)
                    if (Number.isFinite(f)) trimStartLayer(l.id, f)
                  }
                }}
                onPointerUp={(e) => {
                  const t = trimRef.current
                  if (t && t.id === l.id && t.edge === 'start') {
                    const f = trimFrameAt(e.clientX)
                    trimRef.current = null
                    commitStartTrim(l.id, Number.isFinite(f) ? f : l.startFrame)
                  }
                }}
                onPointerCancel={() => { trimRef.current = null }}
                style={{ position: 'absolute', top: -3, bottom: -3, left: -7, width: 16, cursor: 'ew-resize', touchAction: 'none', display: 'flex', alignItems: 'stretch', justifyContent: 'flex-start', zIndex: 3 }}>
                <div style={{ width: 5, borderRadius: 3, background: 'var(--vs-accent)', opacity: 0.9 }} />
              </div>
              <div title={`Drag to trim “${l.name || 'layer'}” length (ends ${l.endFrame}f)`}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  scrubbing.current = false
                  try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
                  const lane = e.currentTarget.parentElement?.parentElement
                  trimRef.current = { id: l.id, edge: 'end', rect: lane?.getBoundingClientRect(), timeMax, startFrame: l.startFrame }
                  const f = trimFrameAt(e.clientX)
                  if (Number.isFinite(f)) trimLayer(l.id, f)
                }}
                onPointerMove={(e) => {
                  const t = trimRef.current
                  if (t && t.id === l.id && t.edge === 'end' && e.buttons) {
                    const f = trimFrameAt(e.clientX)
                    if (Number.isFinite(f)) trimLayer(l.id, f)
                  }
                }}
                onPointerUp={(e) => {
                  const t = trimRef.current
                  if (t && t.id === l.id && t.edge === 'end') {
                    const f = trimFrameAt(e.clientX)
                    trimRef.current = null
                    commitLayerTrim(l.id, Number.isFinite(f) ? f : l.endFrame)
                  }
                }}
                onPointerCancel={() => { trimRef.current = null }}
                style={{ position: 'absolute', top: -3, bottom: -3, right: -7, width: 16, cursor: 'ew-resize', touchAction: 'none', display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end', zIndex: 3 }}>
                <div style={{ width: 5, borderRadius: 3, background: 'var(--vs-accent)', opacity: 0.9 }} />
              </div>
            </div>
            {timeMax > scene.durationInFrames && (
              <div title={`Scene end — ${scene.durationInFrames}f`} style={{ position: 'absolute', top: 0, bottom: 0, left: `${(scene.durationInFrames / timeMax) * 100}%`, borderLeft: '2px dashed #8a93a8', pointerEvents: 'none' }} />
            )}
            {l.keyframes.map((k, ki) => (
              <KeyframeDiamond key={ki} frame={k.frame} duration={timeMax}
                onScrub={(frame) => moveKeyframe(l.id, ki, frame)}
                onCommit={(frame) => commitKeyframes(l.id, ki, frame)}
              />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <input type="number" value={l.startFrame} style={{ width: 64 }} onChange={(e) => updateLayer(l.id, (o) => ({ ...o, startFrame: Math.max(0, Math.round(Number(e.target.value) || 0)) }))} />
            <input type="number" value={l.endFrame} style={{ width: 64 }} onChange={(e) => updateLayer(l.id, (o) => ({ ...o, endFrame: Math.max(0, Math.round(Number(e.target.value) || 0)) }))} />
          </div>
          </>)}
        </div>
      ))}
      <div style={{ fontSize: 12, opacity: 0.6 }}>Red line is the playhead — click or drag any track to scrub it. Drag yellow diamonds to retime keyframes. Drag a track's edge bars to set its start/end — dragging audio's left edge delays when it starts. Drag titles, images and shapes right on the video to move them (drop saves a keyframe).</div>
      {menu && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }}>
          <div style={{ position: 'fixed', left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 140), background: 'var(--vs-menu)', border: '1px solid var(--vs-border)', borderRadius: 8, padding: 4, minWidth: 170, boxShadow: '0 8px 24px rgba(0,0,0,0.65)' }} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => { const l = scene.layers.find((x) => x.id === menu.id); const name = window.prompt('Rename layer (empty = blank title)', l?.name || ''); if (name !== null) renameLayer(menu.id, name.trim()); setMenu(null) }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', cursor: 'pointer', color: 'var(--vs-bright)', fontSize: 13 }}>✏️ Rename layer</button>
            <button onClick={() => { const l = scene.layers.find((x) => x.id === menu.id); if (l) { const copy = JSON.parse(JSON.stringify(l)); copy.id = `layer_copy_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`; copy.name = `${l.name || 'Layer'} copy`; addLayer(copy); setStatus(`Duplicated “${l.name}” with its keyframes.`, 'done') } setMenu(null) }} title="Copy this layer with all its keyframes — the copy selects so you can move it" style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', cursor: 'pointer', color: 'var(--vs-bright)', fontSize: 13 }}>⧉ Duplicate layer</button>
            {onAddText && <button onClick={() => { onAddText(); setMenu(null) }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', cursor: 'pointer', color: 'var(--vs-bright)', fontSize: 13 }}>＋ Insert text layer</button>}
            <button onClick={() => { if (window.confirm(`Delete layer "${scene.layers.find((x) => x.id === menu.id)?.name}"?`)) deleteLayer(menu.id); setMenu(null) }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', cursor: 'pointer', color: '#ffb3b3', fontSize: 13 }}>🗑 Delete layer</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function App() {
  const { scene, sceneRev, setScene, patchScene, undo, redo, prompt, setPrompt, editPrompt, setEditPrompt, log, pushLog } = useStudio()
  const conversations = useStudio(s => s.conversations)
  const addConversation = useStudio(s => s.addConversation)
  const addSeqItem = useStudio(s => s.addSeqItem)
  const sequence = useStudio(s => s.sequence)
  const seqMode = useStudio(s => s.seqMode)
  const setSeqMode = useStudio(s => s.setSeqMode)
  const editingSeqId = useStudio(s => s.editingSeqId)
  const setEditingSeqId = useStudio(s => s.setEditingSeqId)
  const updateSeqItem = useStudio(s => s.updateSeqItem)
  const seqLay = React.useMemo(() => seqLayout(sequence), [sequence])
  const seqCan = React.useMemo(() => seqCanvas(sequence), [sequence])
  const editingSeqItem = editingSeqId ? sequence.items.find((x) => x.id === editingSeqId) || null : null
  const activeConvoId = useStudio(s => s.activeConvoId)
  const loadConversation = useStudio(s => s.loadConversation)
  const deleteConversation = useStudio(s => s.deleteConversation)
  const renameConversation = useStudio(s => s.renameConversation)
  const trash = useStudio(s => s.trash)
  const restoreTrash = useStudio(s => s.restoreTrash)
  const emptyTrash = useStudio(s => s.emptyTrash)
  const [trashOpen, setTrashOpen] = React.useState(false)
  const selectedLayerId = useStudio(s => s.selectedLayerId)
  const selectLayer = useStudio(s => s.selectLayer)
  const updateLayer = useStudio(s => s.updateLayer)
  const addLayer = useStudio(s => s.addLayer)
  const setStatus = useStudio(s => s.setStatus)
  const status = useStudio(s => s.status)
  const datasets = useStudio(s => s.datasets)
  const attachDataset = useStudio(s => s.attachDataset)
  const removeDataset = useStudio(s => s.removeDataset)
  const replaceDataset = useStudio(s => s.replaceDataset)
  const replaceFileRef = React.useRef(null)
  const [replaceId, setReplaceId] = useState(null)
  async function onReplaceFile(e) {
    const f = (e.target.files || [])[0]
    e.target.value = ''
    const id = replaceId
    setReplaceId(null)
    if (!f || !id) return
    try {
      const table = await parseAttachedFile(f)
      const st = useStudio.getState()
      const before = st.datasets.find((x) => x.id === id)
      replaceDataset(id, table)
      const linked = useStudio.getState().scene.layers.filter((l) => l.data?.datasetId === id || (l.data?.source && before && l.data.source === before.name))
      setStatus(`Replaced dataset with ${table.name} (${table.rows.length} rows).${linked.length ? ` ${linked.length} linked layer${linked.length === 1 ? '' : 's'} — select a chart and hit ↻ Refresh data.` : ' No layers are linked to it.'}`, 'done')
    } catch (err) { setStatus(`Replace failed: ${err.message}`, 'error') }
  }
  const images = useStudio(s => s.images)
  const attachImage = useStudio(s => s.attachImage)
  const [busy, setBusy] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState('models')
  const [exportOpen, setExportOpen] = useState(false)
  const [ctxMenu, setCtxMenu] = useState(null)
  const pastLen = useStudio(s => s.past.length)
  const futureLen = useStudio(s => s.future.length)
  // Collapsible Generate stage + conversational revision thread. Generating
  // (or loading history) collapses stage 1 so the revision chat gets room;
  // every revision and its outcome lands in the thread, and a miss becomes
  // a clarifying question instead of a dead-end error.
  const [genCollapsed, setGenCollapsed] = useState(conversations.length > 0)
  // Stages 2 + 3 start collapsed to save room; a finished Generate pops
  // Stage 2 open, Stage 3 stays manual.
  const [revCollapsed, setRevCollapsed] = useState(true)
  const [assetsCollapsed, setAssetsCollapsed] = useState(true)
  const [activityCollapsed, setActivityCollapsed] = useState(true)
  const [histCollapsed, setHistCollapsed] = useState(false)
  // Simple trims the UI to the essentials; Power unlocks sequencing,
  // media assets, JSON export and TTS. Persisted — default Simple.
  const [mode, setMode] = useState(() => { try { return localStorage.getItem('vectorstudio.mode.v1') || 'simple' } catch { return 'simple' } })
  const isSimple = mode !== 'power'
  // One quip per session, picked on first mount.
  const [quip] = useState(() => HEADER_QUIPS[Math.floor(Math.random() * HEADER_QUIPS.length)])
  function toggleMode() {
    const next = isSimple ? 'power' : 'simple'
    setMode(next)
    try { localStorage.setItem('vectorstudio.mode.v1', next) } catch { /* ignore */ }
    if (next === 'simple') setSeqMode(false)
    setStatus(next === 'simple' ? 'Simple Mode — essentials only.' : 'Power Mode — sequencing, media, JSON export and TTS unlocked.', 'done')
  }
  const [revThread, setRevThread] = useState([])
  const threadBoxRef = React.useRef(null)
  const pushRev = React.useCallback((role, text) => {
    setRevThread((t) => [...t.slice(-29), { role, text }])
  }, [])
  React.useEffect(() => {
    const el = threadBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [revThread])
  const [llm, setLlm] = useState(loadSettings)
  // Slide preview: watch a history conversation big without touching the
  // current scene — Back restores the work underneath.
  const [previewConvo, setPreviewConvo] = useState(null)
  const previewConvoRef = React.useRef(null)
  React.useEffect(() => { previewConvoRef.current = previewConvo }, [previewConvo])
  function previewConvoScene(c) {
    // The single-slide preview owns the center player — in Sequence mode
    // that player belongs to the reel, so previewing a slide would leave
    // the rail seeking/playing a player it can't see (seeks clamp to the
    // slide length, the ruler playhead parks partway, play appears dead).
    // The History buttons are hidden in seq mode; this is belt-and-braces.
    if (useStudio.getState().seqMode) { setStatus('Exit Sequence mode (top bar) to preview single slides.', 'info'); return }
    if (!c?.scene) { setStatus('That history item has no scene to preview.', 'error'); return }
    try { setPreviewConvo({ id: c.id, title: c.title, scene: validateScene(normalizeScene(c.scene)) }) }
    catch (e) { setStatus(`Could not preview: ${e.message}`, 'error') }
  }
  const playerRef = React.useRef(null)
  // Auto-play previews: the Player's autoPlay can be blocked when a clip
  // carries audio, so explicitly press play shortly after a slide preview
  // (or the sequence reel) mounts. Honors the Settings toggle.
  React.useEffect(() => {
    if (llm.autoplayPreviews === false) return
    if (!previewConvo && !seqMode) return
    const t = setTimeout(() => { try { const p = playerRef.current; if (p && !p.isPlaying?.()) p.play?.() } catch {} }, 350)
    return () => clearTimeout(t)
  }, [previewConvo?.id, seqMode, llm.autoplayPreviews])
  // Keep the active history entry's snapshot current (debounced): without
  // this, entries go stale the moment you edit, and Duplicate/Load resurrect
  // the stale copy — the "everything vanished" bug.
  React.useEffect(() => {
    if (!useStudio.getState().activeConvoId) return
    const t = setTimeout(() => { useStudio.getState().syncActiveConvo() }, 800)
    return () => clearTimeout(t)
  }, [scene])
  // Refresh/close insurance: flush the pending autosync synchronously on
  // pagehide so the trailing ~800ms of edits survive a reload. Plus a
  // one-time storage-footprint check — TTS audio + images can fill the
  // ~5MB localStorage budget, and a full budget used to fail silently.
  React.useEffect(() => {
    const flush = () => { try { useStudio.getState().flushSync() } catch {} }
    window.addEventListener('pagehide', flush)
    try { useStudio.getState().probeStorageHealth() } catch {}
    return () => window.removeEventListener('pagehide', flush)
  }, [])
  // Server auto-save: the full project (media bytes included — no 5MB
  // cap) is POSTed to /api/project debounced, and the saved copy is
  // pulled back on startup so restarts restore full slides instead of
  // the media-stripped localStorage versions. Failures are silent —
  // localStorage remains the fallback when the server isn't running.
  const serverRestored = React.useRef(false)
  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/project', { signal: AbortSignal.timeout(8000) })
        if (!r.ok || cancelled) return
        const body = await r.json()
        if (cancelled || !body?.ok || body.empty || !body.project) return
        const srv = body.project
        const srvCount = Array.isArray(srv.conversations) ? srv.conversations.length : 0
        if (!srvCount) return
        const st = useStudio.getState()
        const localCount = st.conversations.length
        let localBytes = 0
        try { localBytes = JSON.stringify(st.conversations).length } catch { localBytes = 0 }
        let srvBytes = 0
        try { srvBytes = JSON.stringify(srv.conversations).length } catch { srvBytes = 0 }
        const degraded = !!st.saveHealth?.degraded
        // Restore when the server clearly has more: empty local history,
        // a degraded (media-stripped) local save, or a substantially
        // larger server copy. Otherwise the live session wins.
        if (localCount === 0 || degraded || srvBytes > localBytes * 1.1) {
          st.hydrateProject(srv)
          setStatus(`Restored ${srvCount} slide${srvCount === 1 ? '' : 's'} from auto-save (media intact).`, 'done')
        }
      } catch { /* server offline — localStorage stands in */ }
      serverRestored.current = true
    })()
    return () => { cancelled = true }
  }, [])
  // Debounced push of the full project after any history/sequence/scene
  // change (2s idle). Skips until the startup restore has run once, so a
  // fresh boot never overwrites the good server copy with an empty shell.
  const projPush = React.useRef(null)
  React.useEffect(() => {
    if (!serverRestored.current) return
    clearTimeout(projPush.current)
    projPush.current = setTimeout(() => {
      try {
        const st = useStudio.getState()
        fetch('/api/project', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversations: st.conversations, sequence: st.sequence, scene: st.scene, activeConvoId: st.activeConvoId }),
          signal: AbortSignal.timeout(30000),
        }).catch(() => {})
      } catch { /* offline — next change retries */ }
    }, 2000)
    return () => clearTimeout(projPush.current)
  }, [conversations, sequence, scene, activeConvoId])
  const fileRef = React.useRef(null)
  const importJsonRef = React.useRef(null)
  // Space plays/pauses the preview whenever focus isn't in an editable
  // control or a button (so typing spaces and button activation keep working).
  React.useEffect(() => {
    function onKey(e) {
      const mod = e.ctrlKey || e.metaKey
      // Ctrl/Cmd-Z undo, Ctrl/Cmd-Shift-Z or Ctrl-Y redo — but never steal
      // native undo while typing in a field.
      if (mod && !showSettings && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
        const t = e.target
        const tag = t?.tagName
        if (t?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        e.preventDefault()
        const st = useStudio.getState()
        if (e.key.toLowerCase() === 'z' && !e.shiftKey) st.undo()
        else st.redo()
        return
      }
      // Delete/Backspace removes the selected sequence clip in Sequence
      // mode — never while typing, and never touches history.
      if ((e.key === 'Delete' || e.key === 'Backspace') && !showSettings) {
        const t = e.target
        const tag = t?.tagName
        if (t?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        const st = useStudio.getState()
        if (st.seqMode && st.seqSelectedId) {
          e.preventDefault()
          st.removeSeqItem(st.seqSelectedId)
          return
        }
      }
      // Home/End jump the playhead to the start/end of whatever is showing:
      // slide preview, sequence reel, or scene — same field guard as
      // undo/redo so text editing keeps native behavior.
      if ((e.key === 'Home' || e.key === 'End') && !showSettings) {
        const t = e.target
        const tag = t?.tagName
        if (t?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        e.preventDefault()
        try {
          if (e.key === 'Home') playerRef.current?.seekTo?.(0)
          else {
            const st = useStudio.getState()
            // End lands on the last content frame (not the exclusive
            // duration): seeking to exactly `total` sits past the end and
            // the Player clamps back toward the middle.
            let end = 0
            const pv = previewConvoRef.current?.scene?.durationInFrames
            if (pv != null) end = Math.max(0, Math.round(Number(pv) || 0) - 1)
            else if (st.seqMode) {
              const lay = seqLayout(st.sequence)
              const last = lay.clips[lay.clips.length - 1]
              end = last ? Math.max(0, last.start + last.dur - 1) : 0
            } else end = Math.max(0, Math.round(Number(st.scene.durationInFrames) || 1) - 1)
            playerRef.current?.seekTo?.(end)
          }
        } catch { /* player not mounted yet */ }
        return
      }
      const isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar'
      if (!isSpace || showSettings) return
      const t = e.target
      const tag = t?.tagName
      if (t?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      // Space is global play/pause — even on a focused button (clicking any
      // UI leaves focus behind, which used to swallow the shortcut and
      // re-trigger the button instead).
      if (tag === 'BUTTON') t?.blur?.()
      e.preventDefault()
      try {
        const p = playerRef.current
        if (!p) return
        if (p.isPlaying?.()) { p.pause(); return }
        const st = useStudio.getState()
        // Sequence reel parked at the end: a bare play() no-ops, so
        // restart from the top (and disarm any clip-only stop).
        if (st.seqMode && !previewConvoRef.current) {
          const lay = seqLayout(st.sequence)
          const cur = Math.round(p.getCurrentFrame?.() ?? 0)
          if (lay.total > 1 && cur >= lay.total - 1) { p.seekTo?.(0); st.setSeqStopAt(null) }
        }
        p.play?.()
      } catch { /* player not mounted yet */ }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showSettings])
  const getFrame = React.useCallback(() => playerRef.current?.getCurrentFrame?.() ?? 0, [])
  // Fonts used anywhere in the scene must be downloadable before first
  // paint: opening a history item or restarting never opens the picker, so
  // ensure them here (no-op once loaded; unknown names are safely skipped).
  React.useEffect(() => {
    ensureFonts((scene.layers || []).map((l) => l.fontFamily))
    ensureCustomFonts(scene.layers)
  }, [scene])
  React.useEffect(() => { restoreCustomFonts() }, [])

  const llmOpts = { apiKey: llm.apiKey || undefined, model: llm.model, cloudModel: llm.cloudModel, ollamaUrl: llm.ollamaUrl, systemGenerate: llm.systemGenerate, systemEdit: llm.systemEdit, datasets, images, onStage: (text) => setStatus(text, 'info') }

  const SAMPLE_FILES = ['complex_global_sales_data_1000.csv']
  async function onLoadSample(name) {
    if (!name) return
    try {
      const res = await fetch(`samples/${encodeURIComponent(name)}`)
      if (!res.ok) throw new Error(`sample not found (HTTP ${res.status})`)
      const table = parseCSV(await res.text())
      if (!table) throw new Error('no table parsed')
      attachDataset({ id: `ds_${Date.now().toString(36)}`, name, ...table })
      setStatus(`Sample loaded: ${name} (${table.rows.length} rows). Describe the video, then Generate.`, 'done')
    } catch (e) { setStatus(`Sample failed: ${e.message}`, 'error') }
  }

  async function onAttach(e) {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    for (const f of files) {
      try {
        if (isImageFile(f.name)) attachImage(await processImageFile(f))
        else attachDataset(await parseAttachedFile(f))
      } catch (err) { pushLog(`Attach failed: ${err.message}`) }
    }
  }

  const handleSelect = React.useCallback((id) => { setPreview(null); selectLayer(id) }, [selectLayer])
  const jumpTo = React.useCallback((f) => playerRef.current?.seekTo?.(f), [])
  const selectedLayer = scene.layers.find((l) => l.id === selectedLayerId) || null
  // Uncommitted slider moves: overlaid on the scene so the Player re-renders
  // live. Cleared on select, commit, or revert — never saved to history.
  const [preview, setPreview] = useState(null)
  const onPreview = React.useCallback((id, props) => setPreview({ id, props }), [])
  const clearPreview = React.useCallback(() => setPreview(null), [])
  // Canvas drags commit here: the drop point becomes an x/y keyframe at the
  // playhead frame (one history entry, so drags undo cleanly). An existing
  // keyframe at that frame keeps its motion feel; a new one starts Regular.
  const commitDrag = React.useCallback((id, props) => {
    const f = Math.round(playerRef.current?.getCurrentFrame?.() ?? 0)
    const layer = useStudio.getState().scene.layers.find((l) => l.id === id)
    if (!layer) return
    updateLayer(id, (o) => {
      const kf = o.keyframes.map((k) => ({ ...k, properties: { ...k.properties } }))
      const ki = kf.findIndex((k) => k.frame === f)
      const p = { x: Math.round(props.x), y: Math.round(props.y) }
      if (ki >= 0) kf[ki] = { ...kf[ki], properties: { ...kf[ki].properties, ...p }, easing: kf[ki].easing || 'linear' }
      else {
        // A drop is a full pose, not just a position: seed the new keyframe
        // with the interpolated state at this frame (what you see is what
        // gets recorded) so opacity/scale can't go missing and break fades.
        const base = o.keyframes.length ? lerpKeyframes(o.keyframes, f) : {}
        const full = { ...base, ...p }
        if (full.opacity === undefined) full.opacity = 1
        if (full.scale === undefined) full.scale = 1
        kf.push({ frame: f, properties: full, easing: 'linear' })
      }
      kf.sort((a, b) => a.frame - b.frame)
      return { ...o, keyframes: backfillKeyframeProps(kf, o.fontSize) }
    })
    setPreview(null)
    setStatus(`Moved “${layer.name}” to (${Math.round(props.x)}, ${Math.round(props.y)}) at frame ${f} — keyframe saved.`, 'done')
  }, [updateLayer, setStatus])
  const inputProps = useMemo(() => ({ scene, selectedId: selectedLayerId, onSelect: handleSelect, preview, onDragPreview: onPreview, onDragCommit: commitDrag }), [scene, selectedLayerId, handleSelect, preview, onPreview, commitDrag])

  async function onGenerate() {
    setBusy(true)
    setStatus('Starting generation…')
    try {
      const usedPrompt = prompt || 'Q3 Review title, bar chart July 120 Aug 180 Sep 250, bank slides in from left'
      // A pasted table becomes a session asset: the layer embed caps rows
      // (saved-history quota), but the session keeps the full original so
      // regroups stay exact until reload.
      let genDatasets = datasets
      const pasted = parseMarkdownTable(usedPrompt) || parseDelimitedTable(usedPrompt)
      if (pasted && !datasets.some((d) => d.rows.length === pasted.rows.length && d.columns.join('|') === pasted.columns.join('|'))) {
        const full = { id: `ds_${Date.now().toString(36)}`, name: 'pasted table', ...pasted }
        attachDataset(full)
        genDatasets = [...datasets, full]
      }
      const next = await generateScene(usedPrompt, { ...llmOpts, datasets: genDatasets })
      setStatus('Validating scene…')
      const received = Array.isArray(next?.layers) ? next.layers.map((l) => l?.type || '?').join(', ') : 'no layers array'
      pushLog(`Received from ${getLastSource()}: ${received}`)
      let valid
      try {
        valid = validateScene(normalizeScene(next))
      } catch (e) {
        throw new Error(`Scene failed validation (${e.message}). The raw reply is in History — try again or simplify the prompt.`)
      }
      if (!valid.layers.length) throw new Error(`The ${getLastSource()} returned an empty scene (0 layers). Try again, simplify the prompt, or tweak the instructions in Advanced settings.`)
      // Canvas size is a Stage-1 setting: keep it across regenerations unless
      // the model explicitly set non-default dims (e.g. asked for vertical).
      const dimsTouched = (valid.width && valid.width !== 1280) || (valid.height && valid.height !== 720)
      setScene(dimsTouched ? valid : { ...valid, width: scene.width || 1280, height: scene.height || 720 })
      const _genItem = addConversation(usedPrompt, valid)
      useStudio.getState().setActiveConvo(_genItem.id)
      const n = valid.layers.length
      setStatus(`Done — ${n} layer${n === 1 ? '' : 's'} via ${getLastSource()}. Preview updated.`, 'done')
      pushLog(`Generated ${n} layer(s) via ${getLastSource()}.`)
      setGenCollapsed(true)
      pushRev('assistant', `Created ${n} layer${n === 1 ? '' : 's'} via ${getLastSource()}. Describe revisions below — e.g. "convert it to a pie chart" or "use the other dataset".`)
      setRevCollapsed(false)
    } catch (e) { setStatus(`Generate failed: ${e.message}`, 'error'); pushLog(`Generate failed: ${e.message}`); pushRev('assistant', `Generate failed: ${e.message}`) }
    setBusy(false)
  }

  // Blank slide: reset to an empty canvas (canvas dims kept), undoable via
  // the scene past, and checkpointed into History so it can't be lost.
  function onNewSlide() {
    const blank = { ...emptyScene, width: scene.width || 1280, height: scene.height || 720, fps: scene.fps || 30, layers: [] }
    setScene(blank)
    selectLayer(null); clearPreview?.(); jumpTo(0)
    const _blankItem = useStudio.getState().addConversation('Blank slide', blank)
    useStudio.getState().setActiveConvo(_blankItem.id)
    setStatus('New blank slide started — saved to History.', 'done')
    pushRev('assistant', 'Started a blank slide — saved to History. Add text, shapes or media, or describe a chart in Generate.')
  }
  function onAddText() {
    const dur = scene.durationInFrames
    // Visible from frame 0 (opacity 1): a fade-from-nothing default meant new
    // text looked missing whenever the playhead sat at the start.
    addLayer({
      id: `layer_text_${Date.now().toString(36)}`, name: 'New Title', type: 'text', text: 'New Title',
      fontSize: 84, color: '#ffffff', startFrame: 0, endFrame: dur,
      keyframes: [
        { frame: 0, properties: { opacity: 1, scale: 0.96 } },
        { frame: Math.min(24, dur), properties: { opacity: 1, scale: 1 }, easing: 'easeOutExpo' },
        { frame: dur, properties: { opacity: 1, scale: 1 } },
      ],
    })
    setPreview(null)
    jumpTo(0)
    setStatus('Text layer added at frame 0 — click it in the preview to style it.', 'done')
  }

  // Narration + music live on audio tracks: volume rides keyframes (fade
  // in/out, ducking), start/stop are the layer bounds on the timeline, and
  // the TTS text + voice live on the layer's data for regeneration.
  function onAddAudioLayer(kind, audioId) {
    const dur = scene.durationInFrames
    const a = useStudio.getState().audios.find((x) => x.id === audioId)
    const isTts = kind === 'audio_tts'
    const vol = isTts ? 1 : 0.8
    addLayer({
      id: `layer_${kind}_${Date.now().toString(36)}`,
      name: a ? a.name.replace(/\.[a-z0-9]+$/i, '') : (isTts ? 'Narration' : 'Music'),
      type: kind,
      ...(a?.dataUrl ? { assetUrl: a.dataUrl } : {}),
      data: isTts ? { text: '', voice: loadTts().voices[0]?.name || 'Narrator' } : { volume: vol },
      startFrame: 0, endFrame: dur,
      keyframes: [
        { frame: 0, properties: { volume: vol } },
        { frame: dur, properties: { volume: vol } },
      ],
    })
    setPreview(null)
    jumpTo(0)
    setStatus(isTts ? 'Narration track added — select it, type the script, pick a voice, then Generate speech.' : 'Music track added — pick an attached file on the right, volume rides keyframes.', 'done')
  }

  function onAddImage(imgOverride) {
    const img = imgOverride || images[images.length - 1]
    if (!img) { setStatus('Attach an image first in Stage 3 · Assets, then add it as a layer.', 'error'); return }
    const dur = scene.durationInFrames
    const w = Math.min(760, img.width || 480)
    const h = Math.round((w * (img.height || 1)) / Math.max(1, img.width || 1))
    const x = Math.round((1280 - w) / 2), y = Math.round((720 - h) / 2) - 40
    addLayer({
      id: `layer_img_${Date.now().toString(36)}`, name: img.name, type: 'image_layer',
      assetUrl: img.dataUrl, startFrame: 0, endFrame: dur,
      data: { imageName: img.name, width: w },
      keyframes: [
        { frame: 0, properties: { x, y, scale: 0.92, opacity: 0 } },
        { frame: Math.min(24, dur), properties: { x, y, scale: 1, opacity: 1 }, easing: 'easeOutExpo' },
      ],
    })
    setPreview(null)
    jumpTo(0)
    setStatus(`Image layer “${img.name}” added — X/Y sliders move it, “Enter from” flies it in from off-screen.`, 'done')
  }

  // Parametric shapes: kind + geometry live in data, paint in
  // data.fill/stroke, the centered label in text/fontSize/fontFamily/color
  // — everything animates through the standard keyframe engine.
  function onAddShape(kindId) {
    const kind = shapeKind(kindId)
    const dur = scene.durationInFrames
    const w = kind.defW, h = kind.defH
    const x = Math.round((1280 - w) / 2), y = Math.round((720 - h) / 2)
    addLayer({
      id: `layer_shape_${Date.now().toString(36)}`, name: `${kind.label} Shape`, type: 'shape',
      text: '', fontSize: 48,
      data: { kind: kind.id, w, h, fill: 'var(--vs-sel)', stroke: 'var(--vs-accent)', strokeWidth: kind.id === 'ring' ? 14 : 4 },
      startFrame: 0, endFrame: dur,
      keyframes: [
        { frame: 0, properties: { x, y, scale: 0.85, opacity: 0 } },
        { frame: Math.min(24, dur), properties: { x, y, scale: 1, opacity: 1 }, easing: 'easeOutExpo' },
      ],
    })
    setPreview(null)
    jumpTo(0)
    setStatus(`${kind.label} added — select it in the preview to change kind, size, colors, and label.`, 'done')
  }

  // A question about the data itself ("what columns are there?") gets an
  // answer straight from the attached/embedded table — no render needed.
  function answerSchema() {
    const tables = datasets.length ? datasets : scene.layers.map(tableFromLayer).filter(Boolean)
    if (!tables.length) {
      pushRev('assistant', 'No data yet — attach a CSV/XLSX (Attach files) or paste a table into the Generate box first.')
      setStatus('No data to describe yet.', 'error')
      return
    }
    for (const t of tables) {
      const total = t.rowCount ?? t.rows.length
      const caveat = t.truncated ? ` (scene holds the first ${t.rows.length} — re-attach the file for full-precision regroups)` : ''
      pushRev('assistant', `"${t.name}" — ${total} row${total === 1 ? '' : 's'}${caveat}:\n${describeTable(t)}\nTry: "group by <column> and count", "only <value>", or "top 10 by <column>".`)
    }
    setStatus(`Described ${tables.length} table${tables.length === 1 ? '' : 's'}.`, 'done')
  }

  async function onEdit() {
    if (!editPrompt.trim()) { setStatus('Describe the change first — e.g. "convert it to a pie chart".', 'error'); return }
    if (/what\s+(are|is|are\s+the)|\bwhich\b.*\b(column|field|header|data|metric)|\blist\b.*\b(column|field|header|data)|\b(columns?|fields?|headers?)\b.*\?|what (data|columns|fields)|show me the (data|columns|fields)|describe.*\bdata\b|what can i (plot|chart|show|group)/i.test(editPrompt)) {
      pushRev('user', editPrompt)
      answerSchema()
      return
    }
    setBusy(true)
    setStatus('Starting revision…')
    pushRev('user', editPrompt)
    try {
      const beforeLayers = scene.layers
      const patch = await editScene(scene, editPrompt, llmOpts)
      // If the regroup ran on a truncated embedded copy (reload with no
      // re-attach), say so and prompt the re-attach — counts may be off.
      const { truncated: editTruncated } = resolveEditTable(scene, datasets, editPrompt)
      const truncNote = editTruncated && patch?.some((o) => String(o.path || '').includes('/data'))
        ? ` Note: regrouped from the first ${scene.layers.map(tableFromLayer).find((t) => t && t.truncated)?.rows.length} rows kept in the saved scene — re-attach the file for exact counts.` : ''
      if (patch?.length) { setStatus('Applying revision…'); patchScene(patch); setStatus(`Done — applied ${patch.length} change${patch.length === 1 ? '' : 's'}. Preview updated.`, 'done'); pushLog(`Edit patch: ${JSON.stringify(patch).slice(0, 220)}`); pushRev('assistant', `Applied ${patch.length} change${patch.length === 1 ? '' : 's'}: ${summarizePatch(patch, beforeLayers)}. Preview updated.${truncNote}`) }
      else { setStatus('No change matched — I asked for details below instead of guessing.', 'error'); pushLog('No patch produced; asked for clarification.'); pushRev('assistant', diagnoseNoPatch(scene, datasets, editPrompt) || 'I couldn\u2019t match that to a change, so I\u2019d rather ask than guess and get it wrong. I can: switch chart type (bar / line / pie / area / scatter / histogram / waterfall / funnel / radar / map), re-orient bars (horizontal / vertical), group by a column, stack bars by a second column ("stack by topping"), count / average / sum a metric, take the top N, filter to values ("only Cup and Waffle Cone"), ignore a column, connect the dots on a line ("connect the dots") or restore its wipe, swap in an attached or pasted dataset, recolor, retime, or move/restyle titles. Reply with specifics — e.g. "group by vessel and count the states".') }
    } catch (e) { setStatus(`Edit failed: ${e.message}`, 'error'); pushLog(`Edit failed: ${e.message}`); pushRev('assistant', `That revision failed: ${e.message}`) }
    setBusy(false)
  }

  function onExport() {
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'scene.json'
    a.click()
    pushLog('Exported scene.json. Export MP4 renders video straight from the current scene.')
  }

  function blobToDataUrl(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(r.result)
      r.onerror = () => rej(new Error('could not read file bytes'))
      r.readAsDataURL(blob)
    })
  }
  async function fetchAsDataUrl(url, timeoutMs = 20000) {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const r = await fetch(url, { signal: ctl.signal })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const b = await r.blob()
      if (b.size > 20 * 1024 * 1024) throw new Error('over 20 MB — kept as a link')
      const d = await blobToDataUrl(b)
      if (typeof d !== 'string' || !d.startsWith('data:')) throw new Error('unreadable bytes')
      return d
    } finally { clearTimeout(t) }
  }
  // Smart JSON import: validates BEFORE touching live state (a bad file
  // changes nothing), then resolves every media reference it can —
  // embedded data: URLs work as-is, http(s) URLs are fetched + embedded
  // so the slide is self-contained (kept as a link + warned on failure),
  // image_layers re-link against currently-attached files by imageName,
  // and dead refs (local paths, expired blob: URLs, empties from a
  // degraded auto-save) are cleared with a per-layer re-attach list.
  // The result checkpoints into History as its own entry — current work
  // is never overwritten, and the import itself is one click from Trash.
  async function onImportFile(file) {
    if (!file) return
    setBusy(true)
    setStatus(`Reading “${file.name}”…`)
    try {
      const text = await file.text()
      let parsed = null
      try { parsed = JSON.parse(text) } catch { throw new Error(`“${file.name}” is not valid JSON.`) }
      const raw = parsed && parsed.scene && typeof parsed.scene === 'object' && !Array.isArray(parsed.scene) ? parsed.scene : parsed
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.layers)) {
        throw new Error(`“${file.name}” doesn't look like a VectorStudio slide (no layers array). Export JSON from a slide to get the right shape.`) }
      let scene = null
      try { scene = validateScene(normalizeScene(raw)) }
      catch (e) { throw new Error(`Import failed validation: ${e.message}`) }
      const registry = useStudio.getState().images || []
      const byName = new Map(registry.map((m) => [String(m.name || '').toLowerCase(), m]))
      const fetched = new Map() // remote URL -> embedded dataUrl (bg + layers often share)
      let embedded = 0, linked = 0, relinked = 0
      const missing = []
      async function resolveRef(url, layerLabel, kind) {
        if (!url) return { url: '', missing: true }
        if (url.startsWith('data:')) { embedded++; return { url } }
        if (/^https?:\/\//i.test(url)) {
          if (fetched.has(url)) { linked++; return { url: fetched.get(url) } }
          try {
            const d = await fetchAsDataUrl(url)
            fetched.set(url, d)
            linked++
            return { url: d }
          } catch (e) {
            missing.push(`${layerLabel}: remote ${kind} unreachable (${e.message}) — kept as a link, needs network`) 
            return { url, remote: true }
          }
        }
        return { url, missing: true } // blob: (dead session URL) or local path — unreadable here
      }
      for (const l of scene.layers) {
        const label = `“${l.name || l.type}” (${l.type === 'audio_tts' ? 'voice' : l.type === 'audio_music' ? 'music' : l.type === 'image_layer' ? 'image' : l.type})`
        const needsMedia = l.type === 'audio_tts' || l.type === 'audio_music' || l.type === 'image_layer' || l.type === 'sprite' || l.type === 'vector_shape'
        if (!needsMedia || l.assetUrl) {
          if (needsMedia && l.assetUrl) {
            const r = await resolveRef(l.assetUrl, label, 'file')
            l.assetUrl = r.url
            if (r.missing) missing.push(`${label}: file “${l.assetUrl}” not readable here — re-attach it`)
          }
          continue
        }
        // No usable bytes: try the attached-files registry by imageName…
        const hit = l.data?.imageName && byName.get(String(l.data.imageName).toLowerCase())
        if (hit?.dataUrl) { l.assetUrl = hit.dataUrl; relinked++; continue }
        // …then leave it empty with a targeted next step.
        if (l.type === 'audio_tts') {
          const chars = String(l.data?.text || '').length
          missing.push(`${label}: no audio${chars ? ` — script kept (${chars} chars), select the track and Generate speech` : ' — type the script, then Generate speech'}`)
        } else if (l.type === 'audio_music') {
          missing.push(`${label}: no audio file — pick one in the inspector's File box`)
        } else {
          missing.push(`${label}: image not attached — re-attach “${l.data?.imageName || l.name}” in Stage 3`)
        }
      }
      if (scene.backgroundImage) {
        const r = await resolveRef(scene.backgroundImage, 'Background', 'image')
        scene.backgroundImage = r.url
        if (r.missing) missing.push('Background image not readable here — re-pick it in Stage 3')
      }
      const title = `Imported: ${String(file.name).replace(/\.json$/i, '')}`.slice(0, 80)
      const item = useStudio.getState().addConversation(title, scene)
      useStudio.getState().setActiveConvo(item.id)
      setScene(scene)
      selectLayer(null); clearPreview?.(); jumpTo(0)
      const bits = [`${scene.layers.length} layer${scene.layers.length === 1 ? '' : 's'}`]
      if (linked) bits.push(`${linked} remote file${linked === 1 ? '' : 's'} embedded`)
      if (relinked) bits.push(`${relinked} re-linked from attached files`)
      if (!missing.length) {
        setStatus(`Imported “${title}” — ${bits.join(', ')}. Saved to History.`, 'done')
        pushLog(`Imported “${title}” (${bits.join(', ')}).`)
      } else {
        setStatus(`Imported “${title}” with ${missing.length} file${missing.length === 1 ? '' : 's'} to re-attach — see Activity Log.`, 'done')
        pushLog(`Imported “${title}” (${bits.join(', ')}) — needs attention:`)
        missing.forEach((m) => pushLog(`· ${m}`))
      }
    } catch (e) { setStatus(`Import failed: ${e.message}`, 'error'); pushLog(`Import failed: ${e.message}`) }
    setBusy(false)
  }

  // One-click MP4: the local server writes scene.json and runs the Remotion
  // CLI, we poll until done, then the finished file downloads. First render
  // also fetches a headless browser, so it can take several minutes.
  const [rendering, setRendering] = useState(false)
  async function onExportMp4() {
    if (rendering) return
    // Sequence mode exports the whole reel; scene mode exports the scene.
    const seqSt = useStudio.getState()
    const exportingSeq = seqSt.seqMode && seqSt.sequence.items.length > 0
    if (!exportingSeq && !scene.layers.length) { setStatus('Nothing to render — generate a scene first.', 'error'); return }
    setRendering(true)
    setBusy(true)
    try {
      setStatus(exportingSeq ? 'Starting sequence MP4 render on the local server…' : 'Starting MP4 render on the local server…')
      try {
        const h = await fetch('/api/health').then((r) => r.json()).catch(() => null)
        if (!h?.ok) throw new Error('local server unreachable — is start.bat running?')
        if (!h.render) throw new Error('local server is outdated — restart start.bat to pick up MP4 export')
      } catch (e) {
        if (/outdated|unreachable/.test(e.message)) throw e
        throw new Error('local server unreachable — is start.bat running?')
      }
      let res
      try {
        const payload = exportingSeq ? { sequence: useStudio.getState().sequence } : { scene }
        res = await fetch('/api/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      } catch (e) { throw new Error('local server unreachable — is start.bat running?') }
      const started = await res.json()
      if (!res.ok || !started.ok) throw new Error(started.error || 'render failed to start')
      for (let i = 0; i < 240; i++) {
        await new Promise((r) => setTimeout(r, 2500))
        const p = await fetch(`/api/render/${started.id}`).then((r) => r.json())
        if (p.status === 'done') break
        if (p.status === 'error' || p.ok === false) throw new Error(p.error || 'render failed')
        setStatus(`Rendering MP4… ${p.logTail || 'working'}`, 'info')
        if (i === 239) throw new Error('render timed out after ~10 minutes — check the server log')
      }
      setStatus('MP4 ready — downloading vectorstudio.mp4.', 'done')
      pushLog('Exported vectorstudio.mp4.')
      const a = document.createElement('a')
      a.href = `/api/render/${started.id}/file`
      a.download = 'vectorstudio.mp4'
      a.click()
    } catch (e) { setStatus(`MP4 export failed: ${e.message}`, 'error'); pushLog(`MP4 export failed: ${e.message}`) }
    setBusy(false)
    setRendering(false)
  }

  const theme = llm.theme === 'light' ? 'light' : 'dark'
  function setTheme(next) {
    setLlm((prev) => {
      const merged = { ...prev, theme: next }
      try { localStorage.setItem('vectorstudio.llm.v1', JSON.stringify(merged)) } catch { /* ignore */ }
      return merged
    })
  }
  return (
    <div className="vs-app" data-theme={theme} style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--vs-line)', display: 'flex', gap: 10, alignItems: 'center' }}>
        <strong>VectorStudio AI</strong>
        <StatusBar status={status} busy={busy} />
        <SaveHealth />
        <span style={{ flex: 1 }} />
        <span title={quip} style={{ fontSize: 12, fontStyle: 'italic', opacity: 0.75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 420 }}>{quip}</span>
        <a href="https://www.paypal.com/ncp/payment/29EH6KL5B37UU" target="_blank" rel="noreferrer" title="Support VectorStudio AI — opens PayPal in a new tab" style={{ background: '#b5651d', color: '#fff', borderRadius: 7, padding: '4px 12px', fontSize: 12.5, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>Donate Today</a>
        <span style={{ flex: 1 }} />
        <button onClick={toggleMode} title={isSimple ? 'Switch to Power Mode — unlock sequencing, media assets, JSON export and TTS' : 'Switch to Simple Mode — essentials only'} style={isSimple ? undefined : { fontWeight: 700, background: '#6d3fd1', border: '1px solid #6d3fd1', color: '#fff' }}>{isSimple ? 'Simple Mode' : 'Power Mode'}</button>
        {!isSimple && <button onClick={() => { if (!seqMode) { setPreviewConvo(null); selectLayer(null); clearPreview?.() } setSeqMode(!seqMode) }} title={seqMode ? 'Back to the single-scene editor' : 'Sequence mode: chain history clips into one reel'} style={seqMode ? { fontWeight: 700, background: 'var(--vs-accent-solid)', border: '1px solid var(--vs-accent-solid)', color: '#fff' } : undefined}>🎬 Sequence</button>}
        <button onClick={undo} disabled={!pastLen || seqMode} title="Undo (Ctrl+Z)" style={{ fontSize: 15, padding: '2px 8px' }}>↶</button>
        <button onClick={redo} disabled={!futureLen || seqMode} title="Redo (Ctrl+Y / Ctrl+Shift+Z)" style={{ fontSize: 15, padding: '2px 8px' }}>↷</button>
        <div style={{ position: 'relative' }}>
          <button onClick={() => setExportOpen((o) => !o)} disabled={rendering || busy} title="File — export video/JSON, import a JSON backup" style={{ fontWeight: 700 }}>File ▾</button>
          {exportOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={() => setExportOpen(false)} />
              <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', background: 'var(--vs-pop)', border: '1px solid var(--vs-border)', borderRadius: 8, padding: 4, minWidth: 190, zIndex: 61, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                <button onClick={() => { setExportOpen(false); onExportMp4() }} disabled={rendering || busy} title={seqMode ? 'Render the whole sequence reel to one MP4 on the local server, then download it' : 'Render the current scene to MP4 on the local server, then download it (first render fetches a headless browser and takes a few minutes)'} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', cursor: 'pointer', color: 'var(--vs-text)' }}>{rendering ? 'Rendering MP4…' : seqMode ? '🎬 Export sequence MP4' : '🎬 Export MP4'}</button>
                {!isSimple && <button onClick={() => { setExportOpen(false); onExport() }} title="Download scene.json (re-importable project file)" style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', cursor: 'pointer', color: 'var(--vs-text)' }}>📄 Export JSON</button>}
                {!isSimple && <button onClick={() => { setExportOpen(false); importJsonRef.current?.click() }} title="Load a scene.json backup — validates first, embeds what it can, lists files to re-attach" style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', cursor: 'pointer', color: 'var(--vs-text)' }}>📥 Import JSON</button>}
              </div>
            </>
          )}
        </div>
        <button onClick={() => { setSettingsTab('models'); setShowSettings(true) }} title="Settings — models, text-to-speech, engine" style={{ fontSize: 15, padding: '2px 8px' }}>⚙</button>
        <input ref={importJsonRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImportFile(f) }} />
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: 340, borderRight: '1px solid var(--vs-line)', padding: 12, overflowY: 'auto', background: 'var(--vs-rail)' }}>
          <button onClick={onNewSlide} style={{ width: '100%', marginBottom: 8, borderStyle: 'dashed', fontWeight: 700 }} title="Start a blank slide — saved to History so you can't lose it">＋ New Slide</button>
          <button onClick={() => setGenCollapsed((c) => !c)} title={genCollapsed ? 'Expand the Generate section' : 'Collapse to give the revision chat more room'} style={{ width: '100%', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, background: genCollapsed ? '#4a2e8a' : '#6d3fd1', border: '1px solid #7c5cd6', borderLeft: genCollapsed ? '1px solid #7c5cd6' : '3px solid #ffd166', borderRadius: 8, padding: '9px 10px', cursor: 'pointer', fontWeight: 700, fontSize: 13, color: '#fff' }}><span style={{ background: 'var(--vs-accent-solid)', color: '#fff', borderRadius: 6, padding: '1px 7px', fontSize: 11 }}>1</span><span style={{ flex: 1, textAlign: 'left' }}>Generate</span><span style={{ fontSize: 11, fontWeight: 400, opacity: 0.7 }}>{genCollapsed ? `${scene.layers.length} layer${scene.layers.length === 1 ? '' : 's'} · expand ▸` : '▾'}</span></button>
          {genCollapsed && (<div style={{ fontSize: 11, opacity: 0.6, margin: '4px 2px 6px' }}>{scene.layers.length} layer{scene.layers.length === 1 ? '' : 's'} ready — expand to start over, or revise below.</div>)}
          {!genCollapsed && (<>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} style={{ width: '100%', background: 'var(--vs-deep)', color: 'var(--vs-text)', border: '1px solid var(--vs-border)', borderRadius: 6, padding: 8 }} placeholder="Create infographic: title 'Q3 Review', bar chart 10k to 50k, bank slides in from left" />
          <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <button disabled={busy} onClick={() => fileRef.current?.click()} title="Attach CSV/XLSX data or PNG/JPG images (transparent PNGs supported)">Attach files</button>
            <select defaultValue="" title="Load a bundled sample dataset" onChange={(e) => { onLoadSample(e.target.value); e.target.value = '' }} style={{ maxWidth: 140 }}>
              <option value="" disabled>Sample data…</option>
              {SAMPLE_FILES.map((f) => <option key={f} value={f}>{f.replace(/_/g, ' ').replace(/\.csv$/, '')}</option>)}
            </select>
            <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,.png,.jpg,.jpeg,.webp,.gif,.svg" multiple style={{ display: 'none' }} onChange={onAttach} />
            <input ref={replaceFileRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={onReplaceFile} />
            <span style={{ fontSize: 11, opacity: 0.6 }}>or paste a table into the prompt</span>
          </div>
          {datasets.map((d) => (
            <div key={d.id} style={{ fontSize: 12, display: 'flex', gap: 6, marginTop: 4, background: 'var(--vs-inset)', borderRadius: 6, padding: '4px 8px', alignItems: 'center' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.columns.join(', ')}>📎 {d.name} · {d.rows.length} rows</span>
              <button onClick={() => { setReplaceId(d.id); replaceFileRef.current?.click() }} title="Upload a new file into this slot — charts built from it can then refresh via ↻ Refresh data">Replace</button>
              <button onClick={() => removeDataset(d.id)}>✕</button>
            </div>
          ))}
          <button disabled={busy} onClick={onGenerate} style={{ marginTop: 8, width: '100%' }}>{busy ? 'Working…' : 'Generate scene'}</button>
          <CanvasSize />
          </>)}
          <button onClick={onAddText} style={{ marginTop: 6, width: '100%' }} title="Add an animatable text layer (font, size, color, keyframes)">＋ Add text layer</button>
          <button onClick={() => setRevCollapsed((c) => !c)} title={revCollapsed ? 'Expand the Revise section' : 'Collapse the Revise section'} style={{ width: '100%', marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, background: revCollapsed ? '#4a2e8a' : '#6d3fd1', border: '1px solid #7c5cd6', borderLeft: revCollapsed ? '1px solid #7c5cd6' : '3px solid #ffd166', borderRadius: 8, padding: '9px 10px', cursor: 'pointer', fontWeight: 700, fontSize: 13, color: '#fff' }}><span style={{ background: 'var(--vs-accent-solid)', color: '#fff', borderRadius: 6, padding: '1px 7px', fontSize: 11 }}>2</span><span style={{ flex: 1, textAlign: 'left' }}>Revise chart</span><span style={{ fontSize: 11, fontWeight: 400, opacity: 0.7 }}>{revCollapsed ? (revThread.length ? `${revThread.length} msgs · expand ▸` : 'expand ▸') : '▾'}</span></button>
          {revCollapsed && (<div style={{ fontSize: 11, opacity: 0.6, margin: '4px 2px 6px' }}>{revThread.length ? `${revThread.length} message${revThread.length === 1 ? '' : 's'} in the revision chat — expand to continue.` : 'Generate first — then revise here.'}</div>)}
          {!revCollapsed && (<>
          <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} rows={3} style={{ width: '100%', background: 'var(--vs-deep)', color: 'var(--vs-text)', border: '1px solid var(--vs-border)', borderRadius: 6, padding: 8 }} placeholder="Describe the change conversationally — I'll ask if I need details…" />
          <button disabled={busy} onClick={onEdit} style={{ marginTop: 8, width: '100%' }}>Revise chart</button>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 11, opacity: 0.6 }}>Try:</span>
            {['Convert to a pie chart', 'Count by category', 'Show top 10 only', 'Make the bars vertical'].map((s) => (
              <button key={s} onClick={() => setEditPrompt(s)} title="Fill the edit box with this example" style={{ fontSize: 11 }}>{s}</button>
            ))}
          </div>
          {revThread.length > 0 && (
            <div ref={threadBoxRef} style={{ marginTop: 8, maxHeight: 240, overflowY: 'auto', background: 'var(--vs-panel)', borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {revThread.map((m, i) => (
                <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', background: m.role === 'user' ? 'var(--vs-sel)' : 'var(--vs-card)', border: '1px solid var(--vs-border)', borderRadius: 8, padding: '6px 8px', maxWidth: '95%', fontSize: 12, whiteSpace: 'pre-wrap' }}>{m.text}</div>
              ))}
            </div>
          )}

          </>)}
          <button onClick={() => setAssetsCollapsed((c) => !c)} title={assetsCollapsed ? 'Expand the Assets section' : 'Collapse the Assets section'} style={{ width: '100%', marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, background: assetsCollapsed ? '#4a2e8a' : '#6d3fd1', border: '1px solid #7c5cd6', borderLeft: assetsCollapsed ? '1px solid #7c5cd6' : '3px solid #ffd166', borderRadius: 8, padding: '9px 10px', cursor: 'pointer', fontWeight: 700, fontSize: 13, color: '#fff' }}><span style={{ background: 'var(--vs-accent-solid)', color: '#fff', borderRadius: 6, padding: '1px 7px', fontSize: 11 }}>3</span><span style={{ flex: 1, textAlign: 'left' }}>Assets</span><span style={{ fontSize: 11, fontWeight: 400, opacity: 0.7 }}>{assetsCollapsed ? 'expand ▸' : '▾'}</span></button>
          {assetsCollapsed && (<div style={{ fontSize: 11, opacity: 0.6, margin: '4px 2px 6px' }}>Backgrounds, images & audio — expand to manage.</div>)}
          {!assetsCollapsed && <AssetsStage simple={isSimple} onAddImage={(m) => onAddImage(m)} onAddTts={(id) => onAddAudioLayer('audio_tts', id)} onAddMusic={(id) => onAddAudioLayer('audio_music', id)} onAddShape={(id) => onAddShape(id)} />}
          <button onClick={() => setHistCollapsed((c) => !c)} title={histCollapsed ? 'Expand the History section' : 'Collapse the History section'} style={{ width: '100%', marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, background: histCollapsed ? '#4a2e8a' : '#6d3fd1', border: '1px solid #7c5cd6', borderLeft: histCollapsed ? '1px solid #7c5cd6' : '3px solid #ffd166', borderRadius: 8, padding: '9px 10px', cursor: 'pointer', fontWeight: 700, fontSize: 13, color: '#fff' }}><span style={{ flex: 1, textAlign: 'left' }}>History</span><span style={{ fontSize: 11, fontWeight: 400, opacity: 0.7 }}>{histCollapsed ? 'expand ▸' : '▾'}</span></button>
          {!histCollapsed && (<>
          <div style={{ fontSize: 11, opacity: 0.55, margin: '6px 2px 4px' }}>⧉ duplicates a version to tweak · right-click to rename/delete.</div>
          {conversations.length ? (
            <div style={{ fontSize: 12, maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {conversations.map((c) => (
                <div key={c.id} draggable onDragStart={(e) => { e.dataTransfer.setData('text/vs-convo', c.id); e.dataTransfer.effectAllowed = 'copy' }} style={{ background: 'var(--vs-panel)', borderRadius: 6, padding: '6px 8px', cursor: 'context-menu', display: 'flex', gap: 8, alignItems: 'center' }} title="Right-click for rename / delete · drag into the sequence rail" onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ id: c.id, x: e.clientX, y: e.clientY }) }}>
                  <div title="Mini preview — click ▶ to watch this slide big"><ClipThumb scene={c.scene} width={104} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button onClick={() => { loadConversation(c.id); setStatus(`Loaded: ${c.title}`, 'done'); setGenCollapsed(true); setRevCollapsed(false); pushLog(`Loaded: ${c.title}`) }} title={c.prompt} style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', color: 'var(--vs-accent)', cursor: 'pointer', padding: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</button>
                      <button onClick={() => { const st = useStudio.getState(); const srcScene = c.id === st.activeConvoId ? st.scene : c.scene; const item = st.addConversation(c.prompt, JSON.parse(JSON.stringify(srcScene))); st.renameConversation(item.id, `${c.title} (copy)`.slice(0, 80)); setStatus(`Duplicated “${c.title}” — tweak away, the original is kept.`, 'done') }} title="Duplicate — tweak/rename a new version, the original is kept" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>⧉</button>
                      {!isSimple && <button onClick={() => addSeqItem(c)} title="Append to the sequence reel" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#3ddc84' }}>＋Seq</button>}
                      <button onClick={() => { if (window.confirm(`Delete “${c.title}” from History? (A copy is kept in Trash.)`)) deleteConversation(c.id) }} title="Delete conversation (kept in Trash)" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>
                    </div>
                    <div style={{ opacity: 0.55, fontSize: 11 }}>{new Date(c.createdAt).toLocaleString()} · {c.layerCount} layer{c.layerCount === 1 ? '' : 's'}</div>
                    {!seqMode && (<button onClick={() => { previewConvoScene(c) }} title="Watch this slide in the big preview (your current work is kept — press Back to return)" style={{ fontSize: 11, marginTop: 2 }}>▶ Preview slide</button>)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, opacity: 0.6 }}>No saved generations yet — each Generate lands here.</div>
          )}
          {!!trash.length && (
          <div style={{ marginTop: 4 }}>
            <button onClick={() => setTrashOpen((v) => !v)} title="Deleted and overwritten slides — Restore brings them back to History" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '8px 2px 2px', fontSize: 12, opacity: 0.75, width: '100%', textAlign: 'left' }}>{trashOpen ? '▾' : '▸'} 🗑 Trash ({trash.length})</button>
            {trashOpen && (
            <div style={{ fontSize: 12, maxHeight: 160, overflowY: 'auto', background: 'var(--vs-panel)', padding: 8, borderRadius: 6, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {trash.map((t) => (
                <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${t.title} · trashed ${t.trashedAt ? new Date(t.trashedAt).toLocaleString() : ''}`}>{t.title} <span style={{ opacity: 0.55 }}>· {t.layerCount} layer{t.layerCount === 1 ? '' : 's'}</span></span>
                  <button onClick={() => { restoreTrash(t.id); setStatus(`Restored “${t.title}” to History.`, 'done') }} title="Bring this slide back to History">Restore</button>
                </div>
              ))}
              <button onClick={() => { if (window.confirm('Permanently empty the Trash? This cannot be undone.')) emptyTrash() }} title="Permanently delete everything in Trash" style={{ alignSelf: 'flex-start', fontSize: 11, opacity: 0.7 }}>Empty trash</button>
            </div>
            )}
          </div>
          )}
          <button onClick={() => setActivityCollapsed((c) => !c)} title={activityCollapsed ? 'Expand the Activity Log' : 'Collapse the Activity Log'} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '8px 2px 2px', fontSize: 12, opacity: 0.75, width: '100%', textAlign: 'left' }}>{activityCollapsed ? '▸' : '▾'} Activity Log</button>
          {!activityCollapsed && (
          <div style={{ fontSize: 12, maxHeight: 120, overflowY: 'auto', background: 'var(--vs-panel)', padding: 8, borderRadius: 6, marginTop: 4 }}>
            {log.slice(-8).map((m, i) => <div key={i}>· {m}</div>)}
          </div>
          )}
          </>)}
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--vs-stage)', minWidth: 0, position: 'relative' }}>
          {previewConvo ? (
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
              <div style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', background: 'var(--vs-pop)', border: '1px solid var(--vs-border)', borderRadius: 8, padding: '6px 10px' }}>
                <span>▶ Previewing <strong>“{previewConvo.title}”</strong> — your work is kept underneath.</span>
                <button onClick={() => setPreviewConvo(null)} title="Back to your current scene">← Back to my scene</button>
              </div>
              <Player key={`preview-${previewConvo.id}`} ref={playerRef} component={SceneComposition} inputProps={{ scene: previewConvo.scene }} durationInFrames={previewConvo.scene.durationInFrames} fps={previewConvo.scene.fps} compositionWidth={previewConvo.scene.width || 1280} compositionHeight={previewConvo.scene.height || 720} controls autoPlay={llm.autoplayPreviews !== false} clickToPlay={false} loop style={{ width: '100%', maxWidth: (previewConvo.scene.width || 1280) >= (previewConvo.scene.height || 720) ? 900 : 460 }} />
            </div>
          ) : seqMode ? (
            <Player key={`seq-${seqLay.total}-${seqLay.clips.length}-${seqCan.width}x${seqCan.height}`} ref={playerRef} component={SequenceComposition} inputProps={{ sequence }} durationInFrames={Math.max(1, seqLay.total)} fps={seqCan.fps} compositionWidth={seqCan.width} compositionHeight={seqCan.height} controls autoPlay={llm.autoplayPreviews !== false && seqLay.clips.length > 0} clickToPlay={false} loop style={{ width: '100%', maxWidth: seqCan.width >= seqCan.height ? 900 : 460 }} />
          ) : (
            <Player key={`${sceneRev}-${scene.width || 1280}x${scene.height || 720}`} ref={playerRef} component={SceneComposition} inputProps={inputProps} durationInFrames={scene.durationInFrames} fps={scene.fps} compositionWidth={scene.width || 1280} compositionHeight={scene.height || 720} controls autoPlay={false} clickToPlay={false} loop style={{ width: '100%', maxWidth: (scene.width || 1280) >= (scene.height || 720) ? 900 : 460 }} />
          )}
          {!scene.layers.length && !scene.backgroundImage && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
              <div style={{ fontSize: 15, opacity: 0.75, background: 'rgba(10,14,24,0.8)', padding: '12px 20px', borderRadius: 8, border: '1px dashed var(--vs-block-bd)' }}>No scene yet — describe your video on the left, then Generate.</div>
            </div>
          )}
          {!scene.layers.length && !!scene.backgroundImage && (
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 12, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
              <div style={{ fontSize: 13, opacity: 0.9, background: 'rgba(10,14,24,0.8)', padding: '8px 14px', borderRadius: 8, border: '1px dashed var(--vs-block-bd)' }}>Backdrop set — add text, shapes or media to build your slide.</div>
            </div>
          )}
          {selectedLayer && !seqMode && <LayerInspector key={selectedLayer.id} layer={selectedLayer} getFrame={getFrame} onJump={jumpTo} onClose={() => { clearPreview(); selectLayer(null) }} onPreview={(props) => onPreview(selectedLayer.id, props)} clearPreview={clearPreview} fps={scene.fps} />}
        </div>
      </div>
      {editingSeqItem && !seqMode && (
        <div style={{ borderTop: '1px solid var(--vs-accent)', background: 'var(--vs-sel)', padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <span>✎ Editing sequence clip <strong>“{editingSeqItem.name}”</strong> — saving forks a new history version (the original is kept).</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => {
            const name = window.prompt('Duplicate this clip as:', `${editingSeqItem.name} (copy)`)
            if (name === null) return
            const st = useStudio.getState()
            st.updateSeqItem(editingSeqItem.id, { name: name.trim() || editingSeqItem.name })
            st.setStatus(`Clip renamed to “${name.trim() || editingSeqItem.name}”.`, 'done')
          }} title="Rename this sequence clip">Rename</button>
          <button onClick={() => {
            const st = useStudio.getState()
            let valid = null
            try { valid = validateScene(normalizeScene(st.scene)) } catch (e) { st.setStatus(`Cannot save version: ${e.message}`, 'error'); return }
            const convo = st.addConversation(`Sequence version: ${editingSeqItem.name}`, valid)
            st.updateSeqItem(editingSeqItem.id, { convoId: convo.id, name: convo.title, scene: valid })
            st.setEditingSeqId(null)
            st.setStatus(`Saved “${convo.title}” — sequence updated, original kept.`, 'done')
          }} title="Fork the edited clip into a new history conversation and point the sequence at it">Save as new version</button>
          <button onClick={() => { setEditingSeqId(null); setStatus('Edit discarded — sequence unchanged.', 'info') }} title="Drop the edit, keep the sequence as it was">Discard</button>
        </div>
      )}
      {seqMode
        ? <SequencerPanel getFrame={getFrame} onJump={jumpTo} onExportSeq={onExportMp4} rendering={rendering} playerRef={playerRef} />
        : <Timeline scene={scene} getFrame={getFrame} selectedId={selectedLayerId} onSelectTrack={handleSelect} onAddText={onAddText} onSeek={jumpTo} />}
      {ctxMenu && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }}>
          <div style={{ position: 'fixed', left: Math.min(ctxMenu.x, window.innerWidth - 170), top: Math.min(ctxMenu.y, window.innerHeight - 110), background: 'var(--vs-pop)', border: '1px solid var(--vs-border)', borderRadius: 8, padding: 4, minWidth: 150, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => { const c = conversations.find(x => x.id === ctxMenu.id); const name = window.prompt('Rename conversation', c?.title || ''); if (name && name.trim()) renameConversation(ctxMenu.id, name.trim()); setCtxMenu(null) }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', cursor: 'pointer', color: 'var(--vs-text)' }}>✏️ Rename</button>
            <button onClick={() => { const c = conversations.find(x => x.id === ctxMenu.id); if (window.confirm(`Delete “${c?.title || 'this slide'}” from History? (A copy is kept in Trash.)`)) deleteConversation(ctxMenu.id); setCtxMenu(null) }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', cursor: 'pointer', color: '#ff9090' }}>🗑 Delete</button>
          </div>
        </div>
      )}
      {showSettings && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={() => setShowSettings(false)}>
          <div style={{ background: 'var(--vs-deep)', border: '1px solid var(--vs-border)', borderRadius: 10, maxWidth: 640, width: '100%', maxHeight: '88vh', overflowY: 'auto', padding: 16 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 8 }}>
              <strong>Settings</strong>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 12, opacity: 0.75 }} title="Switch the whole workspace between dark and light">Appearance:</span>
              <button onClick={() => setTheme('dark')} title="Dark theme" style={theme === 'dark' ? { background: 'var(--vs-accent-solid)', border: '1px solid var(--vs-accent-solid)', color: '#fff', fontWeight: 700 } : undefined}>Dark</button>
              <button onClick={() => setTheme('light')} title="Light theme" style={theme === 'light' ? { background: 'var(--vs-accent-solid)', border: '1px solid var(--vs-accent-solid)', color: '#fff', fontWeight: 700 } : undefined}>Light</button>
              <button onClick={() => setShowSettings(false)}>✕ Close</button>
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
              {(isSimple ? [['models', '🧠 Models'], ['engine', '🖥 Engine']] : [['models', '🧠 Models'], ['tts', '🎙 Text-to-Speech'], ['engine', '🖥 Engine']]).map(([id, label]) => (
                <button key={id} onClick={() => setSettingsTab(id)} title={`${label} settings`} style={settingsTab === id ? { flex: 1, fontWeight: 700, background: 'var(--vs-accent-solid)', border: '1px solid var(--vs-accent-solid)', color: '#fff' } : { flex: 1 }}>{label}</button>
              ))}
            </div>
            {settingsTab === 'models' && <LlmSettings value={llm} onChange={setLlm} />}
            {(settingsTab === 'tts' && !isSimple) && <TtsSettings />}
            {settingsTab === 'engine' && <EngineSettings pushLog={pushLog} />}
          </div>
        </div>
      )}
    </div>
  )
}
