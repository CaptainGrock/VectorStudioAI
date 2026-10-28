import React, { useMemo, useState } from 'react'
import { Player } from '@remotion/player'
import { SceneComposition } from './remotion/SceneComposition.jsx'
import { useStudio } from './store.js'
import { generateScene, editScene, getLastSource, tableFromLayer, describeTable, resolveEditTable, diagnoseNoPatch, refreshLayerData, resolveRefreshTable } from './llm.js'
import { validateScene, normalizeScene, lerpKeyframes, effectiveTiming } from './sceneGraph.js'
import { FONT_CHOICES } from './llm.js'
import { OPEN_FONTS, SYSTEM_FONTS_LIST, ensureFonts, ensureCustomFonts, restoreCustomFonts, fetchGoogleFont, fetchCustomFontFromUrl, registerCustomFont, cleanFamily, fontStack, probeFontCdn, fontCdnStatus } from './fonts.js'
import { parseAttachedFile, parseCSV, parseMarkdownTable, parseDelimitedTable } from './datasets.js'
import { isImageFile, processImageFile } from './images.js'
import EngineSettings from './EngineSettings.jsx'
import LlmSettings from './LlmSettings.jsx'
import TtsSettings, { loadTts } from './TtsSettings.jsx'
import { loadSettings } from './llmSettings.js'

function Playhead({ getFrame, duration }) {
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
  return (
    <div style={{ position: 'absolute', top: -2, bottom: -2, left: `${Math.min(100, (frame / Math.max(1, duration)) * 100)}%`, width: 2, background: '#ff5252', pointerEvents: 'none', zIndex: 2 }} />
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
    />
  )
}

function StatusBar({ status, busy }) {
  const color = status.kind === 'error' ? '#ff8080' : status.kind === 'done' ? '#3ddc84' : '#9fb3d8'
  return (
    <>
      <style>{`@keyframes vs-spin { to { transform: rotate(360deg); } }`}</style>
      <span title={status.text} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, minWidth: 0, maxWidth: 340, overflow: 'hidden', whiteSpace: 'nowrap' }}>
        {busy && <span style={{ width: 11, height: 11, borderRadius: '50%', border: '2px solid #4da3ff', borderTopColor: 'transparent', display: 'inline-block', flexShrink: 0, animation: 'vs-spin 0.8s linear infinite' }} />}
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
              <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : '#4da3ff'} onChange={(e) => setSeriesColor(s.label, e.target.value)} />
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
    ? (mapBubbles.length && mapBubbles.every((b) => b.color === mapBubbles[0].color) ? mapBubbles[0].color : '#4da3ff')
    : (d.pointColors?.length === values.length && d.pointColors.every((c) => c === d.pointColors[0]) ? d.pointColors[0] : '#4da3ff')
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
      return dd.pointColors?.[i] || '#4da3ff'
    })
    const legend = (dd.legend || []).map((it) => (it.label === legendItem.label ? { ...it, color } : it))
    return { ...o, data: { ...dd, pointColors, legend } }
  })
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 4 }}>Colors</div>
      <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Single color <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(uniform) ? uniform : '#4da3ff'} onChange={(e) => setSingle(e.target.value)} title="Paint every bar/point one color (clears groups)" /></label>
      {!!d.legend?.length && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {d.legend.map((it, i) => (
            <label key={i} style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(it.color) ? it.color : '#4da3ff'} onChange={(e) => setGroupColor(it, e.target.value)} />
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
      <button onClick={() => { setOpen(!open); ensureFonts([current]) }} style={{ width: '100%', textAlign: 'left', background: '#101828', color: '#fff', border: '1px solid #2a3a5c', borderRadius: 6, padding: '5px 8px', cursor: 'pointer' }} title="Open fonts are all open-licensed (Google Fonts)">
        <span style={{ fontFamily: fontStack(current), fontSize: 14 }}>{current || 'Inter'}</span>
        <span style={{ opacity: 0.6 }}> {open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div style={{ marginTop: 4, background: '#101828', border: '1px solid #2a3a5c', borderRadius: 6, padding: 6 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: script, mono, display…" style={{ width: '100%', marginBottom: 6, background: '#0b0e14', color: '#fff', border: '1px solid #2a3a5c', borderRadius: 4, padding: '4px 6px' }} />
          <div style={{ maxHeight: 190, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {!!sysHits.length && <div style={{ fontSize: 10, opacity: 0.55, marginTop: 2 }}>System — always available, works offline</div>}
            {sysHits.map((f) => (
              <button key={`sys-${f.name}`} onClick={() => applyFont(f.name)} {...previewFor(f.name, f.stack)} title="System font — no download needed" style={{ textAlign: 'left', background: f.name === current ? '#1d3a6e' : 'transparent', color: '#fff', border: 'none', borderRadius: 4, padding: '5px 6px', cursor: 'pointer' }}>
                <span style={{ fontFamily: f.stack, fontSize: 15 }}>{f.name}</span>
                <div style={{ fontFamily: f.stack, fontSize: 11, opacity: 0.7 }}>Ag Sales 123</div>
              </button>
            ))}
            {web === false && <div style={{ fontSize: 11, opacity: 0.7, padding: 4 }}>No connection to Google Fonts or its mirror — System fonts below work fully offline.</div>}
            {web !== false && !!sysHits.length && !!hits.length && <div style={{ fontSize: 10, opacity: 0.55, marginTop: 4 }}>Google Fonts — open-licensed, needs internet once</div>}
            {web !== false && hits.map((f) => (
              <button key={f.name} onClick={() => applyFont(f.name)} {...previewFor(f.name, fontStack(f.name))} title={f.cats.join(', ')} style={{ textAlign: 'left', background: f.name === current ? '#1d3a6e' : 'transparent', color: '#fff', border: 'none', borderRadius: 4, padding: '5px 6px', cursor: 'pointer' }}>
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
            <input value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') loadCustom() }} placeholder="Any Google Font name…" title="Loads any open-licensed Google Font on demand (needs internet once)" style={{ flex: 1, background: '#0b0e14', color: '#fff', border: '1px solid #2a3a5c', borderRadius: 4, padding: '4px 6px' }} />
            <button onClick={() => loadCustom()} disabled={customBusy || !custom.trim()} title="Verify + download this Google Font, preview it, and apply">{customBusy ? '…' : 'Load'}</button>
          </div>
          )}
          {customMsg && <div style={{ fontSize: 11, marginTop: 4, color: customMsg.ok ? '#3ddc84' : '#ff8080' }}>{customMsg.text}</div>}
          <div style={{ marginTop: 6, borderTop: '1px solid #2a3a5c', paddingTop: 6 }}>
            <div style={{ fontSize: 10, opacity: 0.55, marginBottom: 4 }}>1001Fonts / your own file — paste a font page URL or upload a file</div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input value={fontUrl} onChange={(e) => setFontUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') loadFontUrl() }} placeholder="https://www.1001fonts.com/…" title="Paste a 1001Fonts font URL — the app downloads and applies it" style={{ flex: 1, minWidth: 0, background: '#0b0e14', color: '#fff', border: '1px solid #2a3a5c', borderRadius: 4, padding: '4px 6px' }} />
              <button onClick={loadFontUrl} disabled={fontBusy || !fontUrl.trim()} title="Download this font and apply it">{fontBusy ? '…' : 'Fetch'}</button>
              <button onClick={() => fileRef.current?.click()} title="Upload a .ttf/.otf/.woff/.woff2 from your computer">Upload</button>
            </div>
            <input ref={fileRef} type="file" accept=".ttf,.otf,.woff,.woff2,.ttc" style={{ display: 'none' }} onChange={onFontFile} />
            {fontMsg && <div style={{ fontSize: 11, marginTop: 4, color: fontMsg.ok ? '#3ddc84' : '#ff8080' }}>{fontMsg.text}</div>}
          </div>
        </div>
      )}
      {open && hover && (
        <div style={{ position: 'fixed', left: hover.x, top: hover.y, width: 280, background: '#0d1322', border: '1px solid #4da3ff', borderRadius: 8, padding: 12, zIndex: 9999, pointerEvents: 'none', boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}>
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
      <input type="number" value={Math.round(value)} min={160} max={3840} step={8} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setDim(field, n) }} style={{ width: 64, background: '#0b0e14', color: '#fff', border: '1px solid #2a3a5c', borderRadius: 4, padding: '2px 6px' }} />
      <input type="range" min={min} max={max} step={8} value={Math.min(max, Math.max(min, value))} onChange={(e) => setDim(field, Number(e.target.value))} style={{ flex: 1 }} title={`Canvas ${label} — live in preview, export matches`} />
    </label>
  )
  return (
    <div style={{ marginTop: 8, background: '#101828', border: '1px solid #2a3a5c', borderRadius: 6, padding: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, opacity: 0.65 }}>Canvas size — {W}×{H} ({aspectName(W, H)})</div>
      {row('W', 'width', W, 320, 1920)}
      {row('H', 'height', H, 320, 1920)}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {CANVAS_PRESETS.map((p) => (
          <button key={p.label} onClick={() => { setDim('width', p.w); setDim('height', p.h) }} title={`Set canvas to ${p.w}×${p.h}`} style={{ fontSize: 11, background: W === p.w && H === p.h ? '#1d3a6e' : undefined }}>{p.label}</button>
        ))}
      </div>
      <div style={{ fontSize: 10, opacity: 0.55 }}>Layers live on a 1280×720 stage scaled to fit — preview and MP4 export match these dims.</div>
    </div>
  )
}

function Section({ title, defaultOpen, children }) {
  const [open, setOpen] = React.useState(!!defaultOpen)
  return (
    <div style={{ marginTop: 8, background: '#101828', border: '1px solid #2a3a5c', borderRadius: 6 }}>
      <button onClick={() => setOpen((o) => !o)} title={open ? `Collapse ${title}` : `Expand ${title}`} style={{ width: '100%', background: 'none', border: 'none', color: '#fff', cursor: 'pointer', padding: '6px 8px', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>{open ? '▾' : '▸'} {title}</button>
      {open && <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>}
    </div>
  )
}

function TextStyle({ layer }) {
  const updateLayer = useStudio(s => s.updateLayer)
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, opacity: 0.65 }} title="The layer name (above) is just a label — this is what shows on the video">Text <span style={{ opacity: 0.7 }}>(layer name stays separate — rename it above)</span></div>
      <textarea value={layer.text || ''} onChange={(e) => updateLayer(layer.id, (o) => ({ ...o, text: e.target.value }))} placeholder="Text shown on the video — Enter for a new line" rows={2} style={{ width: '100%', background: '#0b0e14', color: '#e8edf5', border: '1px solid #2a3a5c', borderRadius: 6, padding: 6, resize: 'vertical' }} />
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
          <textarea value={layer.data?.text || ''} onChange={(e) => setData({ text: e.target.value })} placeholder="Type what the voice should say…" rows={3} style={{ width: '100%', background: '#0b0e14', color: '#e8edf5', border: '1px solid #2a3a5c', borderRadius: 6, padding: 6, resize: 'vertical' }} />
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
            <div style={{ background: '#101828', borderRadius: 6, padding: 6 }}>
              <style>{`@keyframes vs-slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }`}</style>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1 }}>🎙 Synthesizing… {synthJob.elapsedSec || 0}s elapsed</span>
                <button onClick={onCancelSynth} title="Stop this synthesis run">Cancel</button>
              </div>
              <div style={{ height: 8, background: '#1a2233', borderRadius: 4, overflow: 'hidden', marginTop: 4 }}>
                <div style={{ height: '100%', width: '40%', background: '#4da3ff', animation: 'vs-slide 1.2s linear infinite' }} />
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
            <input type="number" min={0} step={0.5} value={Math.round(offSec * 10) / 10} onChange={(e) => setOffSec(Number(e.target.value))} style={{ width: 64 }} title="Seconds into the source file where this track starts" />
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
      <div style={{ fontSize: 11, opacity: 0.55 }}>Start/stop are the track bounds — volume keyframes fade or duck between them.</div>
    </div>
  )
}

function LayerInspector({ layer, getFrame, onJump, onClose, onPreview, clearPreview, fps }) {
  const updateLayer = useStudio(s => s.updateLayer)
  const deleteKeyframe = useStudio(s => s.deleteKeyframe)
  const setStatus = useStudio(s => s.setStatus)
  const [frame, setFrame] = React.useState(() => Math.round(getFrame?.() ?? 0))
  // Follow the Player playhead so "Set keyframe at frame N" always targets
  // where you actually are. Uncommitted slider values travel with the frame —
  // scrubbing never discards them, Set/Revert does.
  React.useEffect(() => {
    let raf = 0
    let last = Math.round(getFrame?.() ?? 0)
    const tick = () => {
      const f = Math.round(getFrame?.() ?? 0)
      if (f !== last) {
        last = f
        setFrame(f)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [getFrame])
  const cur = lerpKeyframes(layer.keyframes, frame)
  // Live values: every slider/number move re-renders the Player instantly
  // (via onPreview) so you see the transform before committing a keyframe.
  const [live, setLive] = React.useState(null)
  React.useEffect(() => { setLive(null); clearPreview?.() }, [layer.id])
  const v = live || { x: cur.x ?? 0, y: cur.y ?? 0, scale: cur.scale ?? 1, opacity: cur.opacity ?? 1, fontSize: cur.fontSize ?? layer.fontSize ?? 84, volume: cur.volume ?? layer.data?.volume ?? 1 }
  const push = (patch) => {
    const next = { ...v, ...patch }
    setLive(next)
    onPreview?.({ x: next.x, y: next.y, scale: next.scale, opacity: next.opacity, fontSize: next.fontSize, volume: next.volume })
  }
  const dropPreview = () => { setLive(null); clearPreview?.() }
  const kfAt = layer.keyframes.find((k) => k.frame === frame)
  const [easePick, setEasePick] = React.useState(null)
  React.useEffect(() => { setEasePick(null) }, [layer.id, frame])
  const easeOpt = easePick ?? easeToOpt(kfAt?.easing)
  function apply() {
    const ease = EASE_OPTS.find((o) => o.id === easeOpt)?.ease || 'linear'
    const isAudio = layer.type === 'audio_tts' || layer.type === 'audio_music'
    const props = isAudio
      ? { volume: v.volume ?? 1 }
      : { x: v.x, y: v.y, scale: v.scale, opacity: v.opacity, ...(layer.type === 'text' ? { fontSize: Math.round(v.fontSize) } : {}) }
    const existed = !!kfAt
    // One history entry: properties and motion feel land together.
    updateLayer(layer.id, (o) => {
      const kf = o.keyframes.map((k) => ({ ...k, properties: { ...k.properties } }))
      const ki = kf.findIndex((k) => k.frame === frame)
      if (ki >= 0) kf[ki] = { ...kf[ki], properties: { ...kf[ki].properties, ...props }, easing: ease }
      else kf.push({ frame, properties: props, easing: ease })
      kf.sort((a, b) => a.frame - b.frame)
      return { ...o, keyframes: kf }
    })
    setEasePick(null)
    clearPreview?.()
    setLive(null)
    setStatus(`${existed ? 'Updated' : 'Set'} keyframe on ${layer.name} at frame ${frame} (${easeOpt.toUpperCase()}).`, 'done')
  }
  const hasKf = layer.keyframes.some((k) => k.frame === frame)
  const hasChart = !!(layer.data?.values || layer.data?.series || layer.data?.bubbles)
  const hasFonts = layer.type === 'text' || hasChart
  const isAudio = layer.type === 'audio_tts' || layer.type === 'audio_music'
  const field = (label, key, step, min, max, fmt = (x) => Math.round(x * 100) / 100) => (
    <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}> {label}
      <input type="number" step={step} value={fmt(v[key])} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) push({ [key]: Math.min(max, Math.max(min, key === 'opacity' ? n / 100 : n)) }) }} style={{ width: 56 }} />
      <input type="range" min={key === 'opacity' ? 0 : min} max={key === 'opacity' ? 100 : max} step={key === 'opacity' ? 1 : step} value={key === 'opacity' ? Math.round(v.opacity * 100) : Math.min(max, Math.max(min, v[key]))} onChange={(e) => push({ [key]: key === 'opacity' ? Number(e.target.value) / 100 : Number(e.target.value) })} style={{ flex: 1 }} title={`Slide ${label} — live in preview`} />
    </label>
  )
  return (
    <div style={{ position: 'absolute', top: 12, right: 12, width: 264, maxHeight: 'calc(100% - 24px)', overflowY: 'auto', background: '#0d1322', border: '1px solid #2a3a5c', borderRadius: 10, padding: 12, zIndex: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <input value={layer.name} onChange={(e) => updateLayer(layer.id, (o) => ({ ...o, name: e.target.value }))} style={{ fontSize: 13, fontWeight: 700, flex: 1, background: '#101828', border: '1px solid #2a3a5c', borderRadius: 4, padding: '2px 6px', minWidth: 0, color: '#fff' }} title="Layer title — this is the label shown on the video" />
        <span style={{ flex: 1 }} />
        <button onClick={onClose} title="Deselect">✕</button>
      </div>
      <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 8 }}>{layer.type} · frame <strong>{frame}</strong> <button onClick={() => setFrame(Math.round(getFrame?.() ?? 0))} title="Read current playhead frame">↻</button>{live && <span style={{ color: '#ffcf40' }}> · previewing — Set keyframe to keep</span>}</div>
      {!isAudio && (<Section title="Transform" defaultOpen>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {field('X', 'x', 1, -1500, 1500)}{field('Y', 'y', 1, -1000, 1000)}{field('Scale', 'scale', 0.05, 0, 3)}{field('Opacity %', 'opacity', 1, 0, 1, () => Math.round(v.opacity * 100))}
          {layer.type === 'text' && (
            <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Size {Math.round(v.fontSize ?? 84)}
              <input type="range" min={12} max={200} step={1} value={Math.min(200, Math.max(12, v.fontSize ?? 84))} onChange={(e) => push({ fontSize: Math.min(200, Math.max(12, Number(e.target.value))) })} style={{ flex: 1 }} title="Font size — live in preview, Set keyframe to animate it" />
            </label>
          )}
        </div>
      </Section>)}
      {isAudio && <AudioSection layer={layer} v={v} push={push} fps={fps} />}
      {layer.type === 'text' && <TextStyle layer={layer} />}
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
          {layer.type === 'text' && (
            <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Color
              <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(layer.color || '') ? layer.color : '#ffffff'} onChange={(e) => { updateLayer(layer.id, (o) => ({ ...o, color: e.target.value })); push({}) }} />
            </label>
          )}
        </Section>
      )}
      <Section title="Motion" defaultOpen={false}>
        <div style={{ fontSize: 11, opacity: 0.65 }}>Motion feel into frame {frame}</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {EASE_OPTS.map((o) => (
            <button key={o.id} onClick={() => setEasePick(o.id)} title={o.tip} style={{ flex: 1, background: easeOpt === o.id ? '#1d3a6e' : undefined, border: easeOpt === o.id ? '1px solid #4da3ff' : undefined }}>{o.short}</button>
          ))}
        </div>
        {hasChart && <AnimTiming layer={layer} fps={fps} />}
      </Section>
      {live && <button onClick={dropPreview} style={{ marginTop: 6, width: '100%' }} title="Discard uncommitted slider moves">Revert preview</button>}
      <button onClick={apply} style={{ marginTop: 8, width: '100%' }}>{hasKf ? `Update keyframe at frame ${frame}` : `Set keyframe at frame ${frame}`}</button>
      <div style={{ fontSize: 11, opacity: 0.65, margin: '8px 0 4px' }}>Keyframes — click a frame to jump, ✕ to delete</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {layer.keyframes.map((k, ki) => (
          <span key={ki} style={{ fontSize: 11, background: k.frame === frame ? '#4da3ff' : '#1a2233', color: k.frame === frame ? '#fff' : undefined, borderRadius: 4, padding: '2px 4px', display: 'flex', gap: 4, alignItems: 'center' }}>
            <button onClick={() => { setFrame(k.frame); onJump?.(k.frame) }} title="Jump playhead here" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>{k.frame}</button>
            <button onClick={() => deleteKeyframe(layer.id, ki)} title="Delete keyframe" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>✕</button>
          </span>
        ))}
      </div>
    </div>
  )
}

function AssetsStage({ onAddImage, onAddTts, onAddMusic }) {
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
  const box = { background: '#101828', border: '1px solid #2a3a5c', borderRadius: 6, padding: 6, display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }
  return (
    <div>
      <div style={box}>
        <div style={{ fontSize: 11, opacity: 0.65 }}>Background</div>
        <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Color
          <input type="color" value={bg} onChange={(e) => updateSceneField('background', e.target.value)} title="Video background color" />
        </label>
        <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>Image
          <select value={images.find((m) => m.dataUrl === scene.backgroundImage)?.name || ''} onChange={(e) => { const m = images.find((x) => x.name === e.target.value); updateSceneField('backgroundImage', m ? m.dataUrl : '') }} title="Background image (transparent PNGs work too)" style={{ flex: 1, minWidth: 0 }}>
            <option value="">None</option>
            {images.map((m) => <option key={m.id} value={m.name}>{m.name}</option>)}
          </select>
          <button onClick={() => bgFileRef.current?.click()} title="Upload a new background image (stored with the scene)">＋ Upload</button>
          <input ref={bgFileRef} type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.svg" style={{ display: 'none' }} onChange={onBgUpload} />
        </label>
        {!!scene.backgroundImage && (
          <label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }} title="Background image opacity">Opacity {Math.round((scene.backgroundImageOpacity ?? 1) * 100)}%
            <input type="range" min={5} max={100} step={1} value={Math.round((scene.backgroundImageOpacity ?? 1) * 100)} onChange={(e) => updateSceneField('backgroundImageOpacity', Number(e.target.value) / 100)} style={{ flex: 1 }} />
          </label>
        )}
      </div>
      <div style={box}>
        <div style={{ fontSize: 11, opacity: 0.65 }}>Images — reference by name in prompts, or add as layers</div>
        {images.map((m) => (
          <div key={m.id} style={{ fontSize: 12, display: 'flex', gap: 6, background: '#0b0e14', borderRadius: 6, padding: '4px 8px', alignItems: 'center' }}>
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
      <div style={box}>
        <div style={{ fontSize: 11, opacity: 0.65 }}>Audio — narration (TTS) & music tracks</div>
        {audios.map((a) => (
          <div key={a.id} style={{ fontSize: 12, display: 'flex', gap: 6, background: '#0b0e14', borderRadius: 6, padding: '4px 8px', alignItems: 'center' }}>
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
  const frameFromEvent = (e) => {
    const bar = e.currentTarget.getBoundingClientRect()
    if (!bar || !bar.width) return 0
    // Forgiving edges: the first/last 8px snap to 0/timeMax, so the very
    // start/end are clickable even with a keyframe diamond sitting on them.
    if (e.clientX <= bar.left + 8) return 0
    if (e.clientX >= bar.right - 8) return timeMax
    return Math.round(Math.min(1, Math.max(0, (e.clientX - bar.left) / bar.width)) * timeMax)
  }
  const [menu, setMenu] = React.useState(null)
  const renameLayer = useStudio(s => s.renameLayer)
  const deleteLayer = useStudio(s => s.deleteLayer)
  const updateLayer = useStudio(s => s.updateLayer)
  const moveKeyframe = useStudio(s => s.moveKeyframe)
  const commitKeyframes = useStudio(s => s.commitKeyframes)
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
    <div style={{ borderTop: '1px solid #222a3a', padding: 12, overflowX: 'auto', overflowY: 'auto', minHeight: 96, maxHeight: 360, background: '#0a0e18' }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, opacity: 0.8, display: 'flex', alignItems: 'center', gap: 8 }}>Timeline · {scene.layers.length} track{scene.layers.length === 1 ? '' : 's'} · {scene.durationInFrames} frames<span style={{ flex: 1 }} /><div style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 400 }} title="Timeline zoom — 100% fits the whole scene, zooming in scrolls"><button onClick={() => setZoom((z) => Math.max(1, Math.round((z - 0.25) * 100) / 100))} disabled={zoom <= 1} title="Zoom out">−</button><span style={{ fontSize: 11, minWidth: 38, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.25) * 100) / 100))} title="Zoom in">+</button><button onClick={() => setZoom(1)} disabled={zoom === 1} title="Fit the whole scene">Fit</button><button onClick={trimToContent} disabled={!scene.layers.length} title="Snap scene length to the longest layer (stray keyframes pulled in too)">Trim</button></div>{scene.layers.length > 1 && (<><button onClick={() => setCollapsed(new Set(scene.layers.map((l) => l.id)))} title="Collapse all tracks">Collapse all</button><button onClick={() => setCollapsed(new Set())} title="Expand all tracks">Expand all</button></>)}<span style={{ fontWeight: 400, opacity: 0.55 }} title="Backgrounds, images and audio live in Stage 3 · Assets (left rail)">BG + media → Stage 3</span></div>
      {!scene.layers.length && (
        <div style={{ fontSize: 13, opacity: 0.65, padding: '8px 0' }}>No tracks yet — generate a scene and its layers, clips and keyframe diamonds will appear here.</div>
      )}
      {scene.layers.map((l, li) => (
        <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: collapsed.has(l.id) ? 4 : 10 }}>
          <div onClick={() => onSelectTrack?.(l.id)} title="Select layer — right-click to rename / delete" onContextMenu={(e) => { e.preventDefault(); setMenu({ id: l.id, x: e.clientX, y: e.clientY }) }} style={{ width: 180, fontSize: 13, cursor: 'pointer', color: '#fff', background: selectedId === l.id ? '#1d3a6e' : '#141b2c', border: selectedId === l.id ? '1px solid #4da3ff' : '1px solid #2a3a5c', borderRadius: 4, padding: '3px 6px', display: 'flex', alignItems: 'center', gap: 4 }}><button onClick={(e) => { e.stopPropagation(); toggleTrack(l.id) }} title={collapsed.has(l.id) ? 'Expand track' : 'Collapse track'} style={{ background: 'none', border: 'none', color: '#9fb3d8', cursor: 'pointer', padding: 0, fontSize: 12 }}>{collapsed.has(l.id) ? '▸' : '▾'}</button><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(l.name || '').trim() ? l.name : <i style={{ opacity: 0.6 }}>Untitled</i>} <span style={{ color: '#9fb3d8' }}>({l.type === 'audio_tts' ? 'voice' : l.type === 'audio_music' ? 'music' : l.type})</span></span></div>
          {!collapsed.has(l.id) && (<>
          <div style={{ position: 'relative', flex: zoom === 1 ? 1 : 'none', width: zoom === 1 ? undefined : `${Math.round(zoom * 100)}%`, height: 34, background: '#151b29', borderRadius: 6, cursor: 'ew-resize', touchAction: 'none' }} title="Click or drag to scrub the playhead (edges snap; Home/End jump to start/end)"
            onPointerDown={(e) => { scrubbing.current = true; e.currentTarget.setPointerCapture(e.pointerId); onSeek?.(frameFromEvent(e)) }}
            onPointerMove={(e) => { if (scrubbing.current) onSeek?.(frameFromEvent(e)) }}
            onPointerUp={() => { scrubbing.current = false }}
            onPointerCancel={() => { scrubbing.current = false }}>
            <Playhead getFrame={getFrame} duration={timeMax} />
            <div style={{
              position: 'absolute', top: 4, bottom: 4,
              left: `${(l.startFrame / timeMax) * 100}%`,
              width: `${Math.max(2, ((l.endFrame - l.startFrame) / timeMax) * 100)}%`,
              background: '#24406e', borderRadius: 4, border: '1px solid #3b62a8',
            }} />
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
      <div style={{ fontSize: 12, opacity: 0.6 }}>Red line is the playhead — click or drag any track to scrub it. Drag yellow diamonds to retime keyframes. Drag titles, images and shapes right on the video to move them (drop saves a keyframe).</div>
      {menu && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }}>
          <div style={{ position: 'fixed', left: Math.min(menu.x, window.innerWidth - 180), top: Math.min(menu.y, window.innerHeight - 140), background: '#161d30', border: '1px solid #4a5a80', borderRadius: 8, padding: 4, minWidth: 170, boxShadow: '0 8px 24px rgba(0,0,0,0.65)' }} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => { const l = scene.layers.find((x) => x.id === menu.id); const name = window.prompt('Rename layer (empty = blank title)', l?.name || ''); if (name !== null) renameLayer(menu.id, name.trim()); setMenu(null) }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', cursor: 'pointer', color: '#ffffff', fontSize: 13 }}>✏️ Rename layer</button>
            {onAddText && <button onClick={() => { onAddText(); setMenu(null) }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', cursor: 'pointer', color: '#ffffff', fontSize: 13 }}>＋ Insert text layer</button>}
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
  const loadConversation = useStudio(s => s.loadConversation)
  const deleteConversation = useStudio(s => s.deleteConversation)
  const renameConversation = useStudio(s => s.renameConversation)
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
  const playerRef = React.useRef(null)
  const fileRef = React.useRef(null)
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
      // Home/End jump the playhead to the scene start/end — same field
      // guard as undo/redo so text editing keeps native behavior.
      if ((e.key === 'Home' || e.key === 'End') && !showSettings) {
        const t = e.target
        const tag = t?.tagName
        if (t?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        e.preventDefault()
        try {
          if (e.key === 'Home') playerRef.current?.seekTo?.(0)
          else playerRef.current?.seekTo?.(useStudio.getState().scene.durationInFrames)
        } catch { /* player not mounted yet */ }
        return
      }
      if (e.code !== 'Space' || showSettings) return
      const t = e.target
      const tag = t?.tagName
      if (t?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return
      e.preventDefault()
      try {
        if (playerRef.current?.isPlaying?.()) playerRef.current.pause()
        else playerRef.current?.play?.()
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
      else kf.push({ frame: f, properties: p, easing: 'linear' })
      kf.sort((a, b) => a.frame - b.frame)
      return { ...o, keyframes: kf }
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
      addConversation(usedPrompt, valid)
      const n = valid.layers.length
      setStatus(`Done — ${n} layer${n === 1 ? '' : 's'} via ${getLastSource()}. Preview updated.`, 'done')
      pushLog(`Generated ${n} layer(s) via ${getLastSource()}.`)
      setGenCollapsed(true)
      pushRev('assistant', `Created ${n} layer${n === 1 ? '' : 's'} via ${getLastSource()}. Describe revisions below — e.g. "convert it to a pie chart" or "use the other dataset".`)
      setRevCollapsed(false)
    } catch (e) { setStatus(`Generate failed: ${e.message}`, 'error'); pushLog(`Generate failed: ${e.message}`); pushRev('assistant', `Generate failed: ${e.message}`) }
    setBusy(false)
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

  // One-click MP4: the local server writes scene.json and runs the Remotion
  // CLI, we poll until done, then the finished file downloads. First render
  // also fetches a headless browser, so it can take several minutes.
  const [rendering, setRendering] = useState(false)
  async function onExportMp4() {
    if (rendering) return
    if (!scene.layers.length) { setStatus('Nothing to render — generate a scene first.', 'error'); return }
    setRendering(true)
    setBusy(true)
    try {
      setStatus('Starting MP4 render on the local server…')
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
        res = await fetch('/api/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scene }) })
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #222a3a', display: 'flex', gap: 10, alignItems: 'center' }}>
        <strong>VectorStudio AI</strong>
        <StatusBar status={status} busy={busy} />
        <span style={{ flex: 1 }} />
        <button onClick={undo} disabled={!pastLen} title="Undo (Ctrl+Z)" style={{ fontSize: 15, padding: '2px 8px' }}>↶</button>
        <button onClick={redo} disabled={!futureLen} title="Redo (Ctrl+Y / Ctrl+Shift+Z)" style={{ fontSize: 15, padding: '2px 8px' }}>↷</button>
        <div style={{ position: 'relative' }}>
          <button onClick={() => setExportOpen((o) => !o)} disabled={rendering || busy} title="Download the video or the scene file" style={{ fontWeight: 700 }}>Export ▾</button>
          {exportOpen && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={() => setExportOpen(false)} />
              <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', background: '#0d1322', border: '1px solid #2a3a5c', borderRadius: 8, padding: 4, minWidth: 190, zIndex: 61, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                <button onClick={() => { setExportOpen(false); onExportMp4() }} disabled={rendering || busy} title="Render the current scene to MP4 on the local server, then download it (first render fetches a headless browser and takes a few minutes)" style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', cursor: 'pointer', color: '#dbe4f3' }}>{rendering ? 'Rendering MP4…' : '🎬 Export MP4'}</button>
                <button onClick={() => { setExportOpen(false); onExport() }} title="Download scene.json (re-importable project file)" style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', cursor: 'pointer', color: '#dbe4f3' }}>📄 Export JSON</button>
              </div>
            </>
          )}
        </div>
        <button onClick={() => { setSettingsTab('models'); setShowSettings(true) }} title="Settings — models, text-to-speech, engine" style={{ fontSize: 15, padding: '2px 8px' }}>⚙</button>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: 340, borderRight: '1px solid #222a3a', padding: 12, overflowY: 'auto' }}>
          <h3 style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}><button onClick={() => setGenCollapsed((c) => !c)} title={genCollapsed ? 'Expand the Generate section' : 'Collapse to give the revision chat more room'} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>{genCollapsed ? '▸' : '▾'}</button><span>1 · Generate</span></h3>
          {genCollapsed && (<div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>{scene.layers.length} layer{scene.layers.length === 1 ? '' : 's'} ready — expand to start over, or revise below.</div>)}
          {!genCollapsed && (<>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} style={{ width: '100%', background: '#0b0e14', color: '#e8edf5', border: '1px solid #2a3a5c', borderRadius: 6, padding: 8 }} placeholder="Create infographic: title 'Q3 Review', bar chart 10k to 50k, bank slides in from left" />
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
            <div key={d.id} style={{ fontSize: 12, display: 'flex', gap: 6, marginTop: 4, background: '#101828', borderRadius: 6, padding: '4px 8px', alignItems: 'center' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.columns.join(', ')}>📎 {d.name} · {d.rows.length} rows</span>
              <button onClick={() => { setReplaceId(d.id); replaceFileRef.current?.click() }} title="Upload a new file into this slot — charts built from it can then refresh via ↻ Refresh data">Replace</button>
              <button onClick={() => removeDataset(d.id)}>✕</button>
            </div>
          ))}
          <button disabled={busy} onClick={onGenerate} style={{ marginTop: 8, width: '100%' }}>{busy ? 'Working…' : 'Generate scene'}</button>
          <CanvasSize />
          </>)}
          <button onClick={onAddText} style={{ marginTop: 6, width: '100%' }} title="Add an animatable text layer (font, size, color, keyframes)">＋ Add text layer</button>
          <h3 style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 6 }}><button onClick={() => setRevCollapsed((c) => !c)} title={revCollapsed ? 'Expand the Revise section' : 'Collapse the Revise section'} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>{revCollapsed ? '▸' : '▾'}</button><span>2 · Revise chart</span></h3>
          {revCollapsed && (<div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>{revThread.length ? `${revThread.length} message${revThread.length === 1 ? '' : 's'} in the revision chat — expand to continue.` : 'Generate first — then revise here.'}</div>)}
          {!revCollapsed && (<>
          <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} rows={3} style={{ width: '100%', background: '#0b0e14', color: '#e8edf5', border: '1px solid #2a3a5c', borderRadius: 6, padding: 8 }} placeholder="Describe the change conversationally — I'll ask if I need details…" />
          <button disabled={busy} onClick={onEdit} style={{ marginTop: 8, width: '100%' }}>Revise chart</button>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 11, opacity: 0.6 }}>Try:</span>
            {['Convert to a pie chart', 'Count by category', 'Show top 10 only', 'Make the bars vertical'].map((s) => (
              <button key={s} onClick={() => setEditPrompt(s)} title="Fill the edit box with this example" style={{ fontSize: 11 }}>{s}</button>
            ))}
          </div>
          {revThread.length > 0 && (
            <div ref={threadBoxRef} style={{ marginTop: 8, maxHeight: 240, overflowY: 'auto', background: '#0e1420', borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {revThread.map((m, i) => (
                <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', background: m.role === 'user' ? '#1d3a6e' : '#141b2c', border: '1px solid #2a3a5c', borderRadius: 8, padding: '6px 8px', maxWidth: '95%', fontSize: 12, whiteSpace: 'pre-wrap' }}>{m.text}</div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>No model? Offline rules handle charts, titles, shapes, colors, fonts and retimes.</div>
          </>)}
          <h3 style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 6 }}><button onClick={() => setAssetsCollapsed((c) => !c)} title={assetsCollapsed ? 'Expand the Assets section' : 'Collapse the Assets section'} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>{assetsCollapsed ? '▸' : '▾'}</button><span>3 · Assets</span></h3>
          {assetsCollapsed && (<div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>Backgrounds, images & audio — expand to manage.</div>)}
          {!assetsCollapsed && <AssetsStage onAddImage={(m) => onAddImage(m)} onAddTts={(id) => onAddAudioLayer('audio_tts', id)} onAddMusic={(id) => onAddAudioLayer('audio_music', id)} />}
          <h4>History</h4>
          <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 4 }}>Right-click a conversation to rename or delete.</div>
          {conversations.length ? (
            <div style={{ fontSize: 12, maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {conversations.map((c) => (
                <div key={c.id} style={{ background: '#0e1420', borderRadius: 6, padding: '6px 8px', cursor: 'context-menu' }} title="Right-click for rename / delete" onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ id: c.id, x: e.clientX, y: e.clientY }) }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button onClick={() => { loadConversation(c.id); setStatus(`Loaded: ${c.title}`, 'done'); setGenCollapsed(true); setRevCollapsed(false); pushRev('assistant', `Loaded “${c.title}”. Ask for revisions in section 2 below.`) }} title={c.prompt} style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', color: '#9fc3ff', cursor: 'pointer', padding: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</button>
                    <button onClick={() => deleteConversation(c.id)} title="Delete conversation" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>
                  </div>
                  <div style={{ opacity: 0.55, fontSize: 11 }}>{new Date(c.createdAt).toLocaleString()} · {c.layerCount} layer{c.layerCount === 1 ? '' : 's'}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, opacity: 0.6 }}>No saved generations yet — each Generate lands here.</div>
          )}
          <h4>Activity</h4>
          <div style={{ fontSize: 12, maxHeight: 120, overflowY: 'auto', background: '#0e1420', padding: 8, borderRadius: 6 }}>
            {log.slice(-8).map((m, i) => <div key={i}>· {m}</div>)}
          </div>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#05070c', minWidth: 0, position: 'relative' }}>
          <Player key={`${sceneRev}-${scene.width || 1280}x${scene.height || 720}`} ref={playerRef} component={SceneComposition} inputProps={inputProps} durationInFrames={scene.durationInFrames} fps={scene.fps} compositionWidth={scene.width || 1280} compositionHeight={scene.height || 720} controls autoPlay={false} clickToPlay={false} loop style={{ width: '100%', maxWidth: (scene.width || 1280) >= (scene.height || 720) ? 900 : 460 }} />
          {!scene.layers.length && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
              <div style={{ fontSize: 15, opacity: 0.75, background: 'rgba(10,14,24,0.8)', padding: '12px 20px', borderRadius: 8, border: '1px dashed #3b62a8' }}>No scene yet — describe your video on the left, then Generate.</div>
            </div>
          )}
          {selectedLayer && <LayerInspector key={selectedLayer.id} layer={selectedLayer} getFrame={getFrame} onJump={jumpTo} onClose={() => { clearPreview(); selectLayer(null) }} onPreview={(props) => onPreview(selectedLayer.id, props)} clearPreview={clearPreview} fps={scene.fps} />}
        </div>
      </div>
      <Timeline scene={scene} getFrame={getFrame} selectedId={selectedLayerId} onSelectTrack={handleSelect} onAddText={onAddText} onSeek={jumpTo} />
      {ctxMenu && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }}>
          <div style={{ position: 'fixed', left: Math.min(ctxMenu.x, window.innerWidth - 170), top: Math.min(ctxMenu.y, window.innerHeight - 110), background: '#0d1322', border: '1px solid #2a3a5c', borderRadius: 8, padding: 4, minWidth: 150, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => { const c = conversations.find(x => x.id === ctxMenu.id); const name = window.prompt('Rename conversation', c?.title || ''); if (name && name.trim()) renameConversation(ctxMenu.id, name.trim()); setCtxMenu(null) }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', cursor: 'pointer', color: '#dbe4f3' }}>✏️ Rename</button>
            <button onClick={() => { deleteConversation(ctxMenu.id); setCtxMenu(null) }} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '8px 10px', cursor: 'pointer', color: '#ff9090' }}>🗑 Delete</button>
          </div>
        </div>
      )}
      {showSettings && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={() => setShowSettings(false)}>
          <div style={{ background: '#0b0e14', border: '1px solid #2a3a5c', borderRadius: 10, maxWidth: 640, width: '100%', maxHeight: '88vh', overflowY: 'auto', padding: 16 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
              <strong>Settings</strong>
              <span style={{ flex: 1 }} />
              <button onClick={() => setShowSettings(false)}>✕ Close</button>
            </div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
              {[['models', '🧠 Models'], ['tts', '🎙 Text-to-Speech'], ['engine', '🖥 Engine']].map(([id, label]) => (
                <button key={id} onClick={() => setSettingsTab(id)} title={`${label} settings`} style={{ flex: 1, background: settingsTab === id ? '#1d3a6e' : undefined, border: settingsTab === id ? '1px solid #4da3ff' : undefined }}>{label}</button>
              ))}
            </div>
            {settingsTab === 'models' && <LlmSettings value={llm} onChange={setLlm} />}
            {settingsTab === 'tts' && <TtsSettings />}
            {settingsTab === 'engine' && <EngineSettings pushLog={pushLog} />}
          </div>
        </div>
      )}
    </div>
  )
}
