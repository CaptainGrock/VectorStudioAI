import React, { useCallback, useEffect, useState } from 'react'

const KEY = 'vectorstudio.tts.v1'
const FIT_COLOR = { great: '#3ddc84', tight: '#ffcf40', cpu: 'var(--vs-accent)', unknown: '#888' }
const DEFAULT_DIR_WIN = 'C:\\Stable\\ComfyUI\\models\\breezetts2'
// Suggested checkpoints: the official repo first, then the ComfyUI mirror.
const SUGGESTED = ['BreezeBlue/Breeze-TTS-2', 'drbaph/Breeze-TTS-2-comfyui']

export function loadTts() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { modelPath: '', voices: [{ id: 'v_default', name: 'Narrator', refText: '', refAudio: '' }], instruction: '' }
    const s = JSON.parse(raw)
    if (!Array.isArray(s.voices) || !s.voices.length) s.voices = [{ id: 'v_default', name: 'Narrator', refText: '', refAudio: '' }]
    return { modelPath: '', instruction: '', ...s }
  } catch {
    return { modelPath: '', voices: [{ id: 'v_default', name: 'Narrator', refText: '', refAudio: '' }], instruction: '' }
  }
}
export function saveTts(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* quota/private mode */ }
}

const shortPy = (exe) => { const s = String(exe || '').split(/[\\/]/).pop() || 'that Python'; return s.length > 28 ? `…${s.slice(-27)}` : s }
const DEP_LABELS = { torch: 'torch', transformers: 'transformers', qwen_tts: 'qwen-tts', soundfile: 'soundfile' }
// breeze_infer alone isn't enough (it imports without torch) — the engine
// is ready only when the runtime + all four packages resolve.
const engineMissing = (p) => {
  if (!p || !p.exe) return []
  const out = []
  if (!p.hasBreeze) out.push('breeze_infer')
  if (p.deps) for (const [k, label] of Object.entries(DEP_LABELS)) if (!p.deps[k]) out.push(label)
  return out
}
const engineReady = (p) => !!p?.exe && !engineMissing(p).length

export default function TtsSettings() {
  const [tts, setTts] = useState(loadTts)
  const [server, setServer] = useState(null)
  const [dirInput, setDirInput] = useState('')
  const [libInput, setLibInput] = useState('')
  const [pyInput, setPyInput] = useState('')
  const [ckptRepo, setCkptRepo] = useState('BreezeBlue/Breeze-TTS-2')
  const [note, setNote] = useState('')
  const [scanRoot, setScanRoot] = useState('C:\\, D:\\')
  const [scanNote, setScanNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [q, setQ] = useState('breeze tts')
  const [results, setResults] = useState(null)
  const [files, setFiles] = useState(null) // {repo, list:[{name,size}]}
  const [downloads, setDownloads] = useState([])
  const fileRef = React.useRef(null)
  const [voiceForUpload, setVoiceForUpload] = useState(null)

  const persist = (next) => { setTts(next); saveTts(next) }

  const reload = useCallback(async () => {
    setNote('')
    try {
      const r = await fetch('/api/tts')
      if (r.status === 404) {
        // Old backend without TTS routes: confirm it's alive before blaming it.
        const h = await fetch('/api/health').then((x) => x.json()).catch(() => null)
        throw new Error(h?.ok ? 'outdated' : 'unreachable')
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setServer(data)
      setDirInput((cur) => cur || data.dir || '')
      setLibInput((cur) => cur || data.lib?.path || '')
      // Keep the saved model if it still exists; otherwise prefer the first checkpoint.
      setTts((cur) => {
        const stillThere = cur.modelPath && (data.models || []).some((m) => m.path === cur.modelPath)
        const firstCkpt = (data.models || []).find((m) => m.kind === 'checkpoint') || (data.models || [])[0]
        const next = { ...cur, modelPath: stillThere ? cur.modelPath : (firstCkpt?.path || '') }
        saveTts(next)
        return next
      })
      setError('')
    } catch (e) {
      setError(e.message === 'outdated'
        ? 'Local server is outdated — restart start.bat so it picks up TTS support.'
        : 'Backend not reachable. TTS needs start.bat running (node server/index.mjs).')
    }
  }, [])

  useEffect(() => { reload() }, [reload])
  // While a clone/pip/checkpoint job runs, follow its progress.
  useEffect(() => {
    if (!server?.libJob?.active && !server?.ckptJob?.active) return undefined
    const t = setInterval(reload, 2500)
    return () => clearInterval(t)
  }, [server?.libJob?.active, server?.ckptJob?.active, reload])
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const d = await fetch('/api/downloads').then((r) => r.json())
        setDownloads(d.downloads || [])
      } catch { /* quiet */ }
    }, 3000)
    return () => clearInterval(t)
  }, [])

  async function saveDir() {
    const dir = dirInput.trim()
    if (!dir) return
    setBusy('dir'); setError('')
    try {
      const r = await fetch('/api/tts/dir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setServer((s) => ({ ...s, dir: data.dir, models: data.models }))
    } catch (e) { setError(e.message) }
    setBusy('')
  }

  async function saveLib() {
    const dir = libInput.trim()
    if (!dir) return
    setBusy('lib'); setError('')
    try {
      const r = await fetch('/api/tts/lib', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      reload()
    } catch (e) { setError(e.message) }
    setBusy('')
  }

  async function installLib() {
    setError(''); setBusy('lib')
    try {
      const r = await fetch('/api/tts/install', { method: 'POST' })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      reload()
    } catch (e) { setError(e.message) }
    setBusy('')
  }

  async function cancelJob() {
    try {
      await fetch('/api/tts/job/cancel', { method: 'POST' })
      reload()
    } catch (e) { setError(e.message) }
  }

  async function savePy(argv) {
    const list = Array.isArray(argv) ? argv : null
    const custom = !list ? pyInput.trim() : ''
    const final = list || (custom ? [custom] : null)
    if (!final) return
    setBusy('py'); setError('')
    try {
      const r = await fetch('/api/tts/py', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ argv: final }) })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setPyInput('')
      reload()
    } catch (e) { setError(e.message) }
    setBusy('')
  }

  async function savePyInput() { savePy(null) }

  async function scanPythons() {
    setError(''); setScanNote('')
    const roots = scanRoot.split(',').map((s) => s.trim()).filter(Boolean)
    if (!roots.length) { setError('Type a drive or folder to search first.'); return }
    setBusy('scan')
    try {
      const r = await fetch('/api/tts/pythons/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roots }) })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setScanNote(data.found?.length
        ? `Found ${data.found.length}: ${data.found.map((f) => `${f.argv[0].split(/[\\/]/).pop()} (${f.hint})`).join(', ')} — added to the dropdown above.`
        : `No ComfyUI/venv Python found under ${roots.join(', ')}${data.truncated ? ' (search capped — try a narrower folder)' : ''}.`)
      reload()
    } catch (e) { setError(e.message) }
    setBusy('')
  }

  async function installCudaTorch() {
    setError(''); setBusy('cuda')
    try {
      const r = await fetch('/api/tts/cuda-torch', { method: 'POST' })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      if (data.already) setNote('That Python already sees CUDA — reopen this tab to refresh.')
      reload()
    } catch (e) { setError(e.message) }
    setBusy('')
  }

  async function installDeps() {
    setError(''); setBusy('deps')
    try {
      const r = await fetch('/api/tts/deps', { method: 'POST' })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      if (data.already) setNote('That Python already has everything — reopen this tab to refresh the checkmarks.')
      reload()
    } catch (e) { setError(e.message) }
    setBusy('')
  }

  async function downloadCheckpoint() {
    const repo = ckptRepo.trim()
    if (!repo) return
    setError(''); setBusy('ckpt')
    try {
      const r = await fetch('/api/tts/checkpoint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo }) })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      reload()
    } catch (e) { setError(e.message) }
    setBusy('')
  }

  async function searchHf() {
    setBusy('search'); setError(''); setResults(null)
    try {
      const r = await fetch(`https://huggingface.co/api/models?search=${encodeURIComponent(q.trim() || 'breeze tts')}&limit=12`)
      if (!r.ok) throw new Error(`HF search failed (HTTP ${r.status})`)
      setResults(await r.json())
    } catch (e) { setError(`${e.message} — check connection/VPN, or point the folder at your ComfyUI models instead.`) }
    setBusy('')
  }

  async function showFiles(repo) {
    setBusy(`files-${repo}`); setError(''); setFiles(null)
    try {
      const r = await fetch(`https://huggingface.co/api/models/${repo}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      const list = (data.siblings || [])
        .filter((s) => /\.(safetensors|bin|pt|gguf|json)$/i.test(s.rfilename))
        .map((s) => ({ name: s.rfilename }))
      setFiles({ repo, list })
    } catch (e) { setError(`Could not list ${repo}: ${e.message}`) }
    setBusy('')
  }

  async function downloadFile(repo, name) {
    setError('')
    try {
      const r = await fetch('/api/tts/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `https://huggingface.co/${repo}/resolve/main/${name}`, file: name.split('/').pop() }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      const d = await fetch('/api/downloads').then((x) => x.json())
      setDownloads(d.downloads || [])
    } catch (e) { setError(e.message) }
  }

  function onRefFile(e) {
    const f = (e.target.files || [])[0]
    e.target.value = ''
    if (!f || !voiceForUpload) return
    if (f.size > 8 * 1024 * 1024) { setError('Reference clips over 8 MB are too big — trim to ~10–20 s of clean speech.'); return }
    const rd = new FileReader()
    rd.onload = () => {
      const dataUrl = String(rd.result || '')
      persist({ ...tts, voices: tts.voices.map((v) => (v.id === voiceForUpload ? { ...v, refAudio: dataUrl } : v)) })
      setVoiceForUpload(null)
    }
    rd.onerror = () => setError('Could not read that audio file.')
    rd.readAsDataURL(f)
  }

  const fit = server?.fit
  const runningDl = downloads.filter((d) => d.state === 'running')

  return (
    <div>
      {error && <div style={{ fontSize: 12, color: '#ff8080', marginBottom: 8 }}>{error}</div>}
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
        Local voice cloning (BreezeTTS-2, 3B). Weights are non-commercial licensed — fine for personal work, not for paid client output.
      </div>

      <div style={{ fontSize: 12, fontWeight: 600 }}>Model folder</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <input value={dirInput} onChange={(e) => setDirInput(e.target.value)} placeholder={DEFAULT_DIR_WIN}
          title="Folder holding your BreezeTTS-2 checkpoint (e.g. your ComfyUI breezetts2 folder)" style={{ flex: 1 }} />
        <button disabled={busy === 'dir'} onClick={saveDir}>{busy === 'dir' ? '…' : 'Use folder'}</button>
      </div>
      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Defaults to {DEFAULT_DIR_WIN} when it exists, else a models/breezetts2 folder in the app.</div>

      {fit && (
        <div style={{ marginTop: 8, fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: FIT_COLOR[fit.verdict] || '#888', flexShrink: 0 }} />
          <span>{fit.note} <span style={{ opacity: 0.6 }}>(~7.7 GB eager / ~14 GB fast)</span></span>
        </div>
      )}
      <div style={{ fontSize: 12, fontWeight: 600, marginTop: 10 }}>Python — which interpreter runs the voice</div>
      {(server?.pythons?.length) ? (
        <select value={server.python?.exe || ''} onChange={(e) => { const hit = (server.pythons || []).find((x) => x.exe === e.target.value); if (hit) savePy(hit.argv) }} style={{ width: '100%', marginTop: 4 }} title="Saved — synthesis, checks and dependency installs all use this one">
          {(server.pythons || []).map((p) => <option key={p.exe} value={p.exe}>{engineReady(p) ? '✓ ' : ''}{p.exe}{p.ver ? ` (${p.ver})` : ''}</option>)}
          {server.python?.exe && !(server.pythons || []).some((p) => p.exe === server.python.exe) && <option value={server.python.exe}>{server.python.exe} (saved)</option>}
        </select>
      ) : (
        <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>No Python detected — install Python 3.10+ or paste its path below.</div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <input value={pyInput} onChange={(e) => setPyInput(e.target.value)} placeholder="C:\Stable\ComfyUI\python_embeded\python.exe" title="Full path to another Python (e.g. your ComfyUI env)" style={{ flex: 1 }} />
        <button disabled={busy === 'py'} onClick={savePyInput}>{busy === 'py' ? '…' : 'Use Python'}</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
        <input value={scanRoot} onChange={(e) => setScanRoot(e.target.value)} title="Drives/folders to search, comma-separated" style={{ flex: 1 }} />
        <button disabled={busy === 'scan'} onClick={scanPythons} title="Search for ComfyUI / venv Pythons and add them to the dropdown">{busy === 'scan' ? 'Searching…' : '🔍 Search for ComfyUI Python'}</button>
      </div>
      {scanNote && <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>{scanNote}</div>}
      {server?.python?.exe && (
        <div style={{ marginTop: 6, fontSize: 12 }}>
          {server.python.cuda?.available ? (
            <span style={{ color: '#3ddc84' }}>✓ GPU: {(server.python.cuda.devices || []).join(', ') || 'CUDA device'} (torch {server.python.cuda.torchVer || '?'})</span>
          ) : server.python.deps?.torch ? (
            <>
              <div style={{ color: '#ffcf40' }}>⚠ {shortPy(server.python.exe)} {server.python.cuda?.torchVer ? `can't see a GPU (torch ${server.python.cuda.torchVer})` : `has torch but it won't import${server.python.cuda?.torchError ? `: ${server.python.cuda.torchError}` : ''}`} — the voice runner is CUDA-only.</div>
              <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>If this machine has an NVIDIA card, install the CUDA torch build into this Python (several GB). No NVIDIA GPU → the official runner can't run here.</div>
              <button disabled={busy === 'cuda' || !!server?.libJob?.active} onClick={installCudaTorch} style={{ marginTop: 4 }}>{busy === 'cuda' ? 'Starting…' : server?.libJob?.active ? 'Working…' : `⬇ Install CUDA torch into ${shortPy(server.python.exe)}`}</button>
            </>
          ) : (
            <div style={{ opacity: 0.65 }}>GPU status unknown until torch is installed (see below).</div>
          )}
        </div>
      )}
      <div style={{ fontSize: 12, fontWeight: 600, marginTop: 10 }}>BreezeTTS-2 code</div>
      {server?.lib?.ok ? (
        <div style={{ marginTop: 4, fontSize: 12, color: '#3ddc84' }}>✓ Installed correctly — {server.lib.path}</div>
      ) : (
        <>
          <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>Point at a full breeze-tts folder (breeze_infer + infer.py), e.g. your ComfyUI nodes folder if it has them — or install a fresh copy into the app.</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <input value={libInput} onChange={(e) => setLibInput(e.target.value)} placeholder="C:\Stable\ComfyUI\custom_nodes\comfyui-breeze-tts-2" title="Folder holding breeze_infer + infer.py" style={{ flex: 1 }} />
            <button disabled={busy === 'lib'} onClick={saveLib}>{busy === 'lib' ? '…' : 'Use folder'}</button>
          </div>
          <button disabled={busy === 'lib' || !!server?.libJob?.active} onClick={installLib} title={`Clone the official repo into ${server?.appLibDir || 'the app subfolder'}`} style={{ marginTop: 6 }}>
            {busy === 'lib' ? 'Starting…' : server?.libJob?.active ? 'Working…' : `⬇ Install into app (${server?.appLibDir || 'tts/breeze-tts'})`}
          </button>
        </>
      )}
      {!!server?.libJob && (server.libJob.active || server.libJob.error || server.libJob.done) && (
        <div style={{ marginTop: 6, background: 'var(--vs-inset)', borderRadius: 6, padding: 6, fontSize: 11 }}>
          <style>{`@keyframes vs-slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }`}</style>
          {server.libJob.active && (
            <>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span style={{ opacity: 0.8, flex: 1 }}>Working… ({server.libJob.kind}) · {server.libJob.elapsedSec || 0}s</span><button onClick={cancelJob} title="Stop this install job">Cancel</button></div>
              {server.libJob.pct != null ? (
                <>
                  <div style={{ height: 8, background: 'var(--vs-track)', borderRadius: 4, overflow: 'hidden', marginTop: 4 }}>
                    <div style={{ height: '100%', width: `${server.libJob.pct}%`, background: 'var(--vs-accent)', transition: 'width .5s' }} />
                  </div>
                  <div style={{ opacity: 0.6, marginTop: 2 }}>{server.libJob.pct}%</div>
                </>
              ) : (
                <div style={{ height: 8, background: 'var(--vs-track)', borderRadius: 4, overflow: 'hidden', marginTop: 4 }}>
                  <div style={{ height: '100%', width: '40%', background: 'var(--vs-accent)', animation: 'vs-slide 1.2s linear infinite' }} />
                </div>
              )}
            </>
          )}
          {server.libJob.log.map((l, i) => <div key={i} style={{ opacity: 0.7, whiteSpace: 'pre-wrap' }}>{l}</div>)}
          {server.libJob.error && <div style={{ color: '#ff8080' }}>{server.libJob.error}</div>}
          {server.libJob.done && !server.libJob.error && <div style={{ color: '#3ddc84' }}>Installed — rescanning…</div>}
        </div>
      )}
      {server?.lib?.ok && !!engineMissing(server.python).length && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>Code is here but {shortPy(server.python?.exe)} still needs: {engineMissing(server.python).join(', ')}.</div>
          <button disabled={busy === 'deps' || !!server?.libJob?.active} onClick={installDeps} title={`Runs pip install -r requirements.txt with ${server.python?.exe || 'the selected Python'}`}>{busy === 'deps' ? 'Starting…' : server?.libJob?.active ? 'Working…' : `⬇ Install dependencies into ${shortPy(server.python?.exe)}`}</button>
        </div>
      )}
      {server?.pySuggested && server.pySuggested.exe !== server.python?.exe && (
        <div style={{ marginTop: 6, background: 'var(--vs-inset)', borderRadius: 8, padding: 8 }}>
          <div style={{ fontSize: 12 }}>✨ <strong>{shortPy(server.pySuggested.exe)}</strong> looks fully ready (code + packages + GPU). One click switches to it:</div>
          <button onClick={() => savePy(server.pySuggested.argv)} style={{ marginTop: 4 }}>Use {shortPy(server.pySuggested.exe)} instead</button>
        </div>
      )}
      {server?.lib?.ok && engineReady(server.python) && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#3ddc84' }}>✓ Voice engine ready ({server.python.exe}). Generic voice works now; add a reference clip per speaker for cloning.</div>
      )}
      {note && <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>{note}</div>}

      <div style={{ fontSize: 12, fontWeight: 600, marginTop: 10 }}>Checkpoint</div>
      <div style={{ fontSize: 12, fontWeight: 600, marginTop: 10 }}>Official checkpoint — the layout the voice engine loads</div>
      <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>ComfyUI mirror folders can't be loaded by infer.py. This downloads the official sharded layout (~15 GB) into the model folder above, skipping files you already have.</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <input value={ckptRepo} onChange={(e) => setCkptRepo(e.target.value)} placeholder="BreezeBlue/Breeze-TTS-2" title="Hugging Face repo id (owner/name)" style={{ flex: 1 }} />
        <button disabled={busy === 'ckpt' || !!server?.ckptJob?.active} onClick={downloadCheckpoint}>{busy === 'ckpt' ? 'Starting…' : server?.ckptJob?.active ? 'Downloading…' : '⬇ Download'}</button>
      </div>
      {!!server?.ckptJob && (server.ckptJob.active || server.ckptJob.error || server.ckptJob.done) && (
        <div style={{ marginTop: 6, background: 'var(--vs-inset)', borderRadius: 6, padding: 6, fontSize: 11 }}>
          {server.ckptJob.active && (
            <>
              <div style={{ opacity: 0.8 }}>{server.ckptJob.file ? `${server.ckptJob.idx + 1}/${server.ckptJob.files.length} · ${server.ckptJob.file}` : 'Starting…'}</div>
              <div style={{ height: 8, background: 'var(--vs-track)', borderRadius: 4, overflow: 'hidden', marginTop: 4 }}>
                <div style={{ height: '100%', width: `${server.ckptJob.pct ?? 0}%`, background: 'var(--vs-accent)', transition: 'width .5s' }} />
              </div>
              <div style={{ opacity: 0.6, marginTop: 2 }}>{server.ckptJob.pct ?? 0}% overall</div>
            </>
          )}
          {server.ckptJob.log.map((l, i) => <div key={i} style={{ opacity: 0.7 }}>{l}</div>)}
          {server.ckptJob.error && <div style={{ color: '#ff8080' }}>{server.ckptJob.error}</div>}
          {server.ckptJob.done && !server.ckptJob.error && <div style={{ color: '#3ddc84' }}>Checkpoint ready — pick it in the Checkpoint dropdown above.</div>}
        </div>
      )}
      {(server?.models?.length) ? (
        <select value={tts.modelPath} onChange={(e) => persist({ ...tts, modelPath: e.target.value })} style={{ width: '100%', marginTop: 4 }}>
          {!tts.modelPath && <option value="">Pick a checkpoint…</option>}
          {server.models.map((m) => <option key={m.path} value={m.path}>{m.name} · {m.sizeGB} GB{m.kind === 'checkpoint' ? ' · repo clone' : ''}{m.layout === 'official' ? ' · official ✓' : m.layout === 'mirror' ? " · mirror (won't load)" : ''}</option>)}
        </select>
      ) : (
        <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>No checkpoints in that folder yet — clone the repo below or download the weights.</div>
      )}

      <div style={{ fontSize: 12, fontWeight: 600, marginTop: 10 }}>Find a model</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') searchHf() }} placeholder="breeze tts" style={{ flex: 1 }} />
        <button disabled={busy === 'search'} onClick={searchHf}>{busy === 'search' ? '…' : 'Search HF'}</button>
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
        {SUGGESTED.map((repo) => (
          <button key={repo} onClick={() => showFiles(repo)} title={`List downloadable files in ${repo}`} style={{ fontSize: 11 }}>
            {busy === `files-${repo}` ? '…' : repo}
          </button>
        ))}
      </div>
      {!!results?.length && (
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 150, overflowY: 'auto' }}>
          {results.map((m) => (
            <div key={m.id} style={{ fontSize: 12, background: 'var(--vs-card)', borderRadius: 6, padding: '6px 8px', display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${m.id} · ♥ ${m.likes ?? 0}`}>{m.id}</span>
              <button onClick={() => showFiles(m.id)} style={{ fontSize: 11 }}>Files</button>
            </div>
          ))}
        </div>
      )}
      {files && (
        <div style={{ marginTop: 4, background: 'var(--vs-inset)', borderRadius: 6, padding: 6 }}>
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>{files.repo} — downloads land in the folder above</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 170, overflowY: 'auto' }}>
            {files.list.length ? files.list.map((f) => (
              <div key={f.name} style={{ fontSize: 11, display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>{f.name}</span>
                <button onClick={() => downloadFile(files.repo, f.name)} title="Download into the TTS folder">Download</button>
              </div>
            )) : <div style={{ fontSize: 11, opacity: 0.6 }}>No weight files listed — clone it with git instead: <code>git clone https://huggingface.co/{files.repo}</code></div>}
          </div>
        </div>
      )}
      {!!runningDl.length && (
        <div style={{ marginTop: 6, fontSize: 11, opacity: 0.8 }}>
          {runningDl.map((d) => <div key={d.id}>↓ {d.file} · {d.pct ?? '?'}%{d.mbps ? ` · ${d.mbps} MB/s` : ''}</div>)}
        </div>
      )}

      <div style={{ fontSize: 12, fontWeight: 600, marginTop: 10 }}>Voices — reference audio per speaker</div>
      <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>Clean 10–20 s clip + its exact transcript. Synthesis clones this voice; no clip = generic voice from the instruction alone.</div>
      <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {tts.voices.map((v, i) => (
          <div key={v.id} style={{ background: 'var(--vs-card)', borderRadius: 6, padding: '6px 8px' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input value={v.name} onChange={(e) => persist({ ...tts, voices: tts.voices.map((x) => (x.id === v.id ? { ...x, name: e.target.value } : x)) })}
                title="Speaker name" style={{ flex: 1, fontSize: 12 }} placeholder={`Speaker ${i + 1}`} />
              {tts.voices.length > 1 && (
                <button onClick={() => persist({ ...tts, voices: tts.voices.filter((x) => x.id !== v.id) })} title="Remove this speaker">✕</button>
              )}
            </div>
            <input value={v.refText} onChange={(e) => persist({ ...tts, voices: tts.voices.map((x) => (x.id === v.id ? { ...x, refText: e.target.value } : x)) })}
              placeholder="Exact transcript of the reference clip…" title="Word-for-word transcript of what's said in the clip" style={{ width: '100%', marginTop: 4, fontSize: 11 }} />
            <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
              <button onClick={() => { setVoiceForUpload(v.id); fileRef.current?.click() }} title="Upload a short clean WAV/MP3 sample of this speaker">
                {v.refAudio ? '↻ Replace clip' : '＋ Reference clip'}
              </button>
              {v.refAudio && <span style={{ fontSize: 11, color: '#3ddc84' }}>clip attached</span>}
              {v.refAudio && <button onClick={() => persist({ ...tts, voices: tts.voices.map((x) => (x.id === v.id ? { ...x, refAudio: '' } : x)) })} title="Drop the clip">✕</button>}
            </div>
          </div>
        ))}
      </div>
      <button style={{ marginTop: 6 }} onClick={() => persist({ ...tts, voices: [...tts.voices, { id: `v_${Date.now().toString(36)}`, name: `Speaker ${tts.voices.length + 1}`, refText: '', refAudio: '' }] })}>
        ＋ Add speaker
      </button>
      <input ref={fileRef} type="file" accept=".wav,.mp3,.ogg,.m4a,audio/*" style={{ display: 'none' }} onChange={onRefFile} />

      <label style={{ fontSize: 12, display: 'block', marginTop: 10 }}>Voice direction (optional — no clip needed)</label>
      <input value={tts.instruction} onChange={(e) => persist({ ...tts, instruction: e.target.value })}
        placeholder="e.g. Speak slowly with a calm, serious tone" title="Style instruction sent with --instruction (uses --cfg-scale 4)" style={{ width: '100%', marginTop: 4 }} />
    </div>
  )
}
