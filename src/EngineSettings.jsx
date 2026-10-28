import React, { useCallback, useEffect, useState } from 'react'

// Managed local engine, JobKing-style: the models already on this machine
// (app folder + bounded drive scan), a catalog that only recommends what fits
// this video card, resumable downloads, and llama-server start/stop — all
// through the same-origin /api backend (see server/index.mjs).
const VERDICT = {
  great: { label: 'Fits great', color: '#3ddc84' },
  tight: { label: 'Tight fit', color: '#ffcf40' },
  cpu: { label: 'CPU only', color: '#4da3ff' },
  huge: { label: "Won't fit", color: '#ff6b6b' },
  unknown: { label: 'Unknown fit', color: '#888' },
}
const GB = (n) => (n == null ? '?' : `${n} GB`)

export default function EngineSettings({ pushLog }) {
  const [engine, setEngine] = useState(null)
  const [catalog, setCatalog] = useState(null)
  const [scan, setScan] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [engineOpts, setEngineOpts] = useState(null)

  const get = useCallback(async (p) => {
    const r = await fetch(p)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }, [])
  const post = useCallback(async (p, body = {}) => {
    const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
    return data
  }, [])

  const reload = useCallback(async () => {
    try {
      const [e, c] = await Promise.all([get('/api/engine'), get('/api/catalog').catch(() => null)])
      setEngine(e)
      if (c) setCatalog(c)
      setError('')
    } catch (err) {
      setError('Backend not reachable. It starts with start.bat (node server/index.mjs).')
    }
  }, [get])

  useEffect(() => {
    reload()
    const t = setInterval(async () => {
      try {
        const e = await get('/api/engine')
        setEngine(e)
        const d = await get('/api/downloads')
        if (d.downloads?.some((x) => x.state === 'running')) setCatalog((c) => c ? { ...c, _tick: Date.now() } : c)
      } catch { /* backend down: stay quiet between reloads */ }
    }, 3000)
    return () => clearInterval(t)
  }, [reload, get])

  const [downloads, setDownloads] = useState([])
  useEffect(() => {
    get('/api/downloads').then((d) => setDownloads(d.downloads || [])).catch(() => {})
  }, [get, catalog?._tick])

  async function run(label, fn) {
    setBusy(label)
    setError('')
    try {
      const out = await fn()
      await reload()
      return out
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const running = Boolean(engine?.running?.running)
  const activeModel = engine?.running?.model || engine?.loaded?.[0] || ''

  return (
    <div>
      {error && <div style={{ fontSize: 12, color: '#ff8080', marginBottom: 8 }}>{error}</div>}
      {/* engine strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#101828', borderRadius: 8, padding: '8px 10px' }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: running ? '#3ddc84' : '#ff5252', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{running ? `Engine running · ${activeModel}` : 'No engine running'}</div>
          <div style={{ fontSize: 11, opacity: 0.6 }}>{engine?.binary ? engine.binary : 'llama-server not found yet'} · {engine?.llamaPort ? `port ${engine.llamaPort}` : ''}</div>
        </div>
        {running
          ? <button disabled={!!busy} onClick={() => run('stop', () => post('/api/engine/stop'))}>Stop</button>
          : <button disabled={!!busy || !engine?.binary} title={engine?.binary ? '' : 'Install the engine below first'} onClick={() => run('start', () => startWithBest())}>Start</button>}
      </div>

      {/* models on this machine */}
      <div style={{ marginTop: 10, fontSize: 12, fontWeight: 600 }}>Models on this machine</div>
      {(engine?.models?.onDisk?.length || scan?.found?.length) ? (
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {[...(engine?.models?.onDisk || []), ...(scan?.found || []).filter((s) => !(engine?.models?.onDisk || []).some((o) => o.path === s.path))].map((m) => (
            <div key={m.path} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, background: '#111a2c', borderRadius: 6, padding: '6px 8px' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.path}>{m.fileName}{m.quant ? ` · ${m.quant}` : ''} · {GB(m.sizeGB)}</span>
              <button disabled={!!busy} onClick={() => run('use', async () => {
                await post('/api/engine/start', { modelPath: m.path })
                pushLog?.(`Engine up with ${m.fileName}`)
              })}>Use</button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>No .gguf files in the app folder yet.</div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
        <button disabled={!!busy} onClick={() => run('scan', async () => {
          await post('/api/models/scan', {})
          for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 2000))
            const s = await get('/api/models/scan')
            setScan(s)
            if (!s.active) break
          }
          const s = await get('/api/models/scan')
          setScan(s)
          pushLog?.(s.found.length ? `Scan found ${s.found.length} model file(s).` : 'Scan found no model files.')
        })}>Search my drives</button>
        {scan?.active && <span style={{ fontSize: 12, opacity: 0.7 }}>Scanning… {scan.visited} files checked, {scan.found.length} models</span>}
      </div>

      {/* engine binary */}
      {!engine?.binary && (
        <div style={{ marginTop: 10, background: '#1a1408', borderRadius: 8, padding: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>No llama-server found — nothing can run a model yet</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button disabled={!!busy} onClick={() => run('engine-opts', async () => {
              const o = await post('/api/engine/options', {})
              setEngineOpts(o)
              if (o.error) throw new Error(o.error)
            })}>Check what fits</button>
          </div>
          {engineOpts?.options?.map((o) => (
            <div key={o.id + o.tag} style={{ fontSize: 12, marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ flex: 1 }}>{o.recommended ? '★ ' : ''}{o.label} · {o.totalMB} MB — {o.note}</span>
              <button disabled={!!busy} onClick={() => run('engine-install', async () => {
                await post('/api/engine/install', { optionId: o.id })
                for (let i = 0; i < 120; i++) {
                  await new Promise((r) => setTimeout(r, 3000))
                  const e = await get('/api/engine')
                  setEngine(e)
                  if (!e.install?.active) {
                    if (e.install?.state === 'error') throw new Error(e.install.error)
                    break
                  }
                }
                pushLog?.('Engine installed.')
              })}>Download engine</button>
            </div>
          ))}
          {engine?.install?.active && <div style={{ fontSize: 12, marginTop: 6 }}>{engine.install.step}</div>}
        </div>
      )}

      {/* catalog */}
      <div style={{ marginTop: 10, fontSize: 12, fontWeight: 600 }}>Worth downloading for this video card</div>
      {catalog ? (
        <>
          <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>{catalog.summary}</div>
          <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {catalog.options.map((o) => {
              const v = VERDICT[o.verdict] || VERDICT.unknown
              const dl = downloads.find((d) => d.file === (o.file || '').split('/').pop() && (d.state === 'running' || d.state === 'done' || d.state === 'error' || d.state === 'cancelled'))
              return (
                <div key={o.id} style={{ fontSize: 12, background: '#111a2c', borderRadius: 6, padding: '6px 8px', borderLeft: `3px solid ${v.color}` }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ flex: 1 }}>{o.recommended ? '★ ' : ''}<strong>{o.label}</strong> · {GB(o.sizeGB)} download · needs ~{GB(o.requiredGB)}</span>
                    <span style={{ color: v.color, fontSize: 11 }}>{v.label}</span>
                  </div>
                  <div style={{ opacity: 0.65, fontSize: 11, marginTop: 2 }}>{o.why}</div>
                  {o.blocked ? (
                    <div style={{ color: '#ff8080', fontSize: 11, marginTop: 2 }}>{o.blocked}</div>
                  ) : (
                    <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
                      <button disabled={!!busy || o.verdict === 'huge' || o.diskOk === false} title={o.verdict === 'huge' ? 'Too big for this machine' : o.diskOk === false ? 'Not enough free disk' : `Downloads ${o.file}`}
                        onClick={() => run('download', () => post('/api/downloads', { id: o.id }))}>
                        {dl?.state === 'error' || dl?.state === 'cancelled' ? 'Resume' : `Download · ${GB(o.sizeGB)}`}
                      </button>
                      {dl?.state === 'running' && (
                        <span style={{ fontSize: 11, opacity: 0.8 }}>{dl.pct ?? '?'}%{dl.mbps ? ` · ${dl.mbps} MB/s` : ''}</span>
                      )}
                      {dl?.state === 'done' && (
                        <button disabled={!!busy} onClick={() => run('use-dl', async () => {
                          const m = await get('/api/models')
                          const hit = m.onDisk.find((x) => x.fileName === dl.file)
                          if (!hit) throw new Error('Downloaded, but the file is not in the model folder.')
                          await post('/api/engine/start', { modelPath: hit.path })
                          pushLog?.(`Engine up with ${hit.fileName}`)
                        })}>Use</button>
                      )}
                      {dl?.state === 'error' && <span style={{ fontSize: 11, color: '#ff8080' }}>{dl.error}</span>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      ) : (
        <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>Catalog loads with the backend.</div>
      )}
    </div>
  )

  async function startWithBest() {
    const m = await get('/api/models')
    const target = m.onDisk[0]?.path || m.scanned?.[0]?.path || engine?.lastModel || ''
    if (!target) throw new Error('No model file. Download one below or run Search my drives.')
    await post('/api/engine/start', { modelPath: target })
    pushLog?.(`Engine up with ${target.split(/[\\/]/).pop()}`)
  }
}
