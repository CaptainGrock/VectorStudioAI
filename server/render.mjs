// One-click MP4 export: writes the current scene (or sequence) to disk,
// generates a render entry pinned to its fps/duration, and runs the
// Remotion CLI locally. Single job at a time; poll status, download file.
// No dependencies — plain node:child_process.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Bin lives at the package root (dist/ only holds its modules) — probe both.
const CLI_CANDIDATES = [
  path.join(ROOT, 'node_modules', '@remotion', 'cli', 'remotion-cli.js'),
  path.join(ROOT, 'node_modules', '@remotion', 'cli', 'dist', 'remotion-cli.js'),
]
const CLI = CLI_CANDIDATES.find((p) => { try { return fs.existsSync(p) } catch { return false } }) || ''

let job = null

function entrySource() {
  return `import { registerRoot } from 'remotion'
import React from 'react'
import { Composition } from 'remotion'
import { SceneComposition } from './src/remotion/SceneComposition.jsx'
import sceneData from './scene.json'
const RenderRoot = () => (
  <Composition id="vectorstudio" component={SceneComposition}
    durationInFrames={sceneData.durationInFrames || 300} fps={sceneData.fps || 30}
    width={Math.min(3840, Math.max(160, sceneData.width || 1280))} height={Math.min(3840, Math.max(160, sceneData.height || 720))} defaultProps={{ scene: sceneData }} />
)
registerRoot(RenderRoot)
`
}

function entrySourceSeq(total, fps, w, h) {
  return `import { registerRoot } from 'remotion'
import React from 'react'
import { Composition } from 'remotion'
import { SequenceComposition } from './src/remotion/SequenceComposition.jsx'
import sequenceData from './sequence.json'
const RenderRoot = () => (
  <Composition id="vectorstudio-seq" component={SequenceComposition}
    durationInFrames={${total}} fps={${fps}}
    width={${w}} height={${h}} defaultProps={{ sequence: sequenceData }} />
)
registerRoot(RenderRoot)
`
}

export function startRender(body) {
  if (job && job.status === 'running') return { ok: false, error: 'A render is already running — wait for it to finish.' }
  if (!CLI) return { ok: false, error: 'Remotion CLI not found in node_modules — run `npm install` in the app folder.' }
  const seq = body?.sequence
  if (seq && Array.isArray(seq.items)) return startSequenceRender(seq)
  return startSceneRender(body?.scene || body)
}

function launchRender({ compId, logLines, label }) {
  const id = `r_${Date.now().toString(36)}`
  const outAbs = path.join(ROOT, 'out.mp4')
  try { if (fs.existsSync(outAbs)) fs.rmSync(outAbs) } catch { /* ignore */ }
  job = { id, status: 'running', error: '', log: [], outAbs, startedAt: Date.now() }
  const push = (line) => {
    job.log.push(line)
    if (job.log.length > 200) job.log.shift()
  }
  for (const l of logLines) push(l)
  let child
  try {
    child = spawn(process.execPath, [CLI, 'render', '.vs-render-entry.jsx', compId, 'out.mp4', '--overwrite'], {
      cwd: ROOT,
      env: { ...process.env, CI: '1' },
    })
  } catch (e) {
    job.status = 'error'
    job.error = `Could not launch renderer: ${e.message}`
    return { ok: true, id }
  }
  child.stdout.on('data', (d) => String(d).split('\n').forEach((l) => { if (l.trim()) push(l.trim().slice(0, 300)) }))
  child.stderr.on('data', (d) => String(d).split('\n').forEach((l) => { if (l.trim()) push(l.trim().slice(0, 300)) }))
  child.on('error', (e) => {
    if (job.id !== id) return
    job.status = 'error'
    job.error = `Could not launch renderer: ${e.message}`
  })
  child.on('close', (code) => {
    if (job.id !== id) return
    if (code === 0 && fs.existsSync(outAbs)) {
      job.status = 'done'
      push(`done → out.mp4 (${label})`)
    } else {
      job.status = 'error'
      const tail = job.log.slice(-3).join(' | ')
      job.error = `Renderer exited (${code}). ${tail || 'No output captured.'} First render also downloads a headless browser — a network or browser failure shows up above.`
    }
  })
  return { ok: true, id }
}

function startSceneRender(scene) {
  if (!scene || !Array.isArray(scene.layers) || !scene.layers.length) {
    return { ok: false, error: 'Nothing to render — generate a scene first.' }
  }
  const id = `r_${Date.now().toString(36)}`
  try {
    fs.writeFileSync(path.join(ROOT, 'scene.json'), JSON.stringify(scene))
    fs.writeFileSync(path.join(ROOT, '.vs-render-entry.jsx'), entrySource())
  } catch (e) {
    return { ok: false, error: `Could not write scene files: ${e.message}` }
  }
  const rw = Math.min(3840, Math.max(160, Math.round(Number(scene.width) || 1280)))
  const rh = Math.min(3840, Math.max(160, Math.round(Number(scene.height) || 720)))
  const lines = [`render started (job ${id}) at ${rw}x${rh}`]
  // Export audit: what the render actually received, per layer — so a
  // missing title/legend/font in the MP4 can be traced to the data (or
  // ruled out, pointing at loading/scale instead).
  const seenFonts = []
  for (const l of scene.layers) {
    const d = l.data || {}
    const pts = Array.isArray(d.labels) ? d.labels.length : (Array.isArray(d.bubbles) ? d.bubbles.length : 0)
    const ser = Array.isArray(d.series) ? d.series.length : 0
    const leg = Array.isArray(d.legend) ? d.legend.length : ser
    lines.push(`layer "${l.name}" (${l.type}): ${pts} pts${ser ? `, ${ser} series` : ''}, title ${l.showTitle === false ? 'off' : 'on'}, legend ${l.showLegend === false ? 'off' : leg + ' items'}`)
    const fam = String(l.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim()
    if (fam && !seenFonts.includes(fam)) seenFonts.push(fam + (l.fontUrl ? ' (custom embedded)' : ''))
  }
  if (seenFonts.length) lines.push(`webfonts attempted: ${seenFonts.join(', ')} (Google Fonts + mirror) `)
  return launchRender({ compId: 'vectorstudio', logLines: lines, label: 'scene' })
}

function startSequenceRender(seq) {
  const items = (seq.items || []).filter((x) => x && x.scene)
  if (!items.length) return { ok: false, error: 'Nothing to render — add clips to the sequence first.' }
  let t = 0
  const clips = items.map((item) => {
    const dur = Number(item.scene?.durationInFrames) || 0
    const ts = Math.max(0, Math.round(Number(item.trimStart) || 0))
    const te = Math.max(0, Math.round(Number(item.trimEnd) || 0))
    const d = Math.max(1, dur - ts - te)
    const start = t
    t += d + Math.max(0, Math.round(Number(item.gapAfter) || 0))
    return { item, start, dur: d }
  })
  const total = t
  const first = items[0].scene || {}
  const fps = Math.min(120, Math.max(1, Math.round(Number(first.fps) || 30)))
  const rw = Math.min(3840, Math.max(160, Math.round(Number(first.width) || 1280)))
  const rh = Math.min(3840, Math.max(160, Math.round(Number(first.height) || 720)))
  try {
    fs.writeFileSync(path.join(ROOT, 'sequence.json'), JSON.stringify(seq))
    fs.writeFileSync(path.join(ROOT, '.vs-render-entry.jsx'), entrySourceSeq(total, fps, rw, rh))
  } catch (e) {
    return { ok: false, error: `Could not write sequence files: ${e.message}` }
  }
  const lines = [`sequence render started at ${rw}x${rh}, ${fps}fps — ${items.length} clips, ${total}f`]
  for (const c of clips) {
    const nLayers = (c.item.scene.layers || []).length
    const hasTTS = (c.item.scene.layers || []).some((l) => l.type === 'audio_tts' && l.assetUrl)
    lines.push(`clip "${c.item.name}": ${c.dur}f from ${c.start}f, ${nLayers} layers${hasTTS ? ', narration' : ''}`)
  }
  if (seq.music?.assetUrl) lines.push(`sequence bed: ${(seq.music.name || 'music')} (${(seq.music.keyframes || []).length} volume keyframes)`)
  return launchRender({ compId: 'vectorstudio-seq', logLines: lines, label: 'sequence' })
}

export function renderStatus(id) {
  if (!job || job.id !== id) return { ok: false, error: 'Unknown render job.' }
  return { ok: true, status: job.status, error: job.error, logTail: job.log.slice(-2).join(' | ').slice(0, 220) }
}

export function renderFile(id) {
  if (!job || job.id !== id || job.status !== 'done') return null
  try {
    if (fs.existsSync(job.outAbs)) return job.outAbs
  } catch { /* ignore */ }
  return null
}
