import React, { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, loadSettings, saveSettings, resetPrompts } from './llmSettings.js'

// JobKing-style flow, adapted to Ollama: pick an installed local model,
// or pull (auto-download) one by name with live progress. No page reload;
// settings persist to localStorage and feed generateScene/editScene.
export default function LlmSettings({ value, onChange }) {
  const [models, setModels] = useState([])
  const [online, setOnline] = useState(null) // null=unknown, true/false
  const [refreshing, setRefreshing] = useState(false)
  const [dlName, setDlName] = useState('qwen2.5:7b')
  const [dlState, setDlState] = useState(null) // {status, done, total}
  const [dlError, setDlError] = useState('')
  const [showCloud, setShowCloud] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const abortRef = useRef(null)

  const set = (patch) => {
    const next = { ...value, ...patch }
    saveSettings(next)
    onChange(next)
  }

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const base = (value.ollamaUrl || DEFAULT_SETTINGS.ollamaUrl).replace(/\/$/, '')
      const res = await fetch(`${base}/api/tags`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const names = (data.models || []).map((m) => m.name).filter(Boolean)
      setModels(names)
      setOnline(true)
      if (names.length && !names.includes(value.model)) set({ model: names[0] })
    } catch {
      setModels([])
      setOnline(false)
    }
    setRefreshing(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.ollamaUrl, value.model])

  useEffect(() => { refresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function download() {
    const name = dlName.trim()
    if (!name) return
    if (abortRef.current) abortRef.current.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setDlError('')
    setDlState({ status: 'starting…', done: 0, total: 0 })
    try {
      const base = (value.ollamaUrl || DEFAULT_SETTINGS.ollamaUrl).replace(/\/$/, '')
      const res = await fetch(`${base}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, stream: true }),
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        buf += dec.decode(chunk, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const ev = JSON.parse(line)
            if (ev.error) throw new Error(ev.error)
            setDlState({ status: ev.status || '', done: ev.completed || 0, total: ev.total || 0 })
          } catch (e) {
            if (e.message && !e.message.startsWith('Unexpected token')) throw e
          }
        }
      }
      setDlState({ status: 'done', done: 1, total: 1 })
      set({ model: name })
      refresh()
    } catch (e) {
      if (e.name === 'AbortError') setDlState({ status: 'cancelled', done: 0, total: 0 })
      else { setDlError(e.message); setDlState(null) }
    } finally {
      abortRef.current = null
    }
  }

  const pct = dlState && dlState.total ? Math.round((dlState.done / dlState.total) * 100) : null

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span title={online === false ? 'Ollama not reachable' : 'Ollama status'}
          style={{ width: 10, height: 10, borderRadius: '50%', background: online === null ? '#666' : online ? '#3ddc84' : '#ff5252', flexShrink: 0 }} />
        <span style={{ fontSize: 12, opacity: 0.75 }}>
          {online === null ? 'Checking Ollama…' : online ? `Ollama · ${models.length} model${models.length === 1 ? '' : 's'}` : 'Ollama offline — offline rules will be used'}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={refresh} disabled={refreshing}>{refreshing ? '…' : 'Refresh'}</button>
      </div>

      <label style={{ fontSize: 12, display: 'block', marginTop: 8 }}>Local model</label>
      {models.length ? (
        <select value={value.model} onChange={(e) => set({ model: e.target.value })} style={{ width: '100%', marginTop: 4 }}>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
          {!models.includes(value.model) && <option value={value.model}>{value.model} (not installed)</option>}
        </select>
      ) : (
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>No local models found. Download one below.</div>
      )}

      <label style={{ fontSize: 12, display: 'block', marginTop: 8 }}>Download a model (Ollama pull)</label>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <input value={dlName} onChange={(e) => setDlName(e.target.value)} placeholder="llama3.1 / qwen2.5:7b / gemma3:4b" style={{ flex: 1 }} />
        <button onClick={download} disabled={dlState && pct === null && dlState.status !== 'done' && dlState.status !== 'cancelled'}>
          {dlState && pct !== null ? `${pct}%` : 'Pull'}
        </button>
        {abortRef.current && <button onClick={() => abortRef.current.abort()}>Cancel</button>}
      </div>
      {dlState && (
        <div style={{ marginTop: 6 }}>
          <div style={{ height: 8, background: '#1a2233', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: pct !== null ? `${pct}%` : '30%', background: '#4da3ff', transition: 'width .3s', opacity: pct !== null ? 1 : 0.5 }} />
          </div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{dlState.status}{pct !== null ? ` · ${pct}%` : ''}</div>
        </div>
      )}
      {dlError && <div style={{ fontSize: 12, color: '#ff8080', marginTop: 4 }}>{dlError}</div>}

      <div style={{ marginTop: 10 }}>
        <button onClick={() => setShowCloud(!showCloud)} style={{ fontSize: 12 }}>{showCloud ? '▾' : '▸'} Cloud model (OpenAI-compatible)</button>
        {showCloud && (
          <div style={{ marginTop: 6 }}>
            <input value={value.cloudBaseUrl} onChange={(e) => set({ cloudBaseUrl: e.target.value })} placeholder="https://api.openai.com/v1" style={{ width: '100%', marginBottom: 6 }} />
            <input value={value.cloudModel} onChange={(e) => set({ cloudModel: e.target.value })} placeholder="gpt-4o-mini" style={{ width: '100%', marginBottom: 6 }} />
            <input value={value.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder="API key (optional, stays in this browser)" style={{ width: '100%' }} type="password" />
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>Used only if Ollama is unreachable and a key is set.</div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 8 }}>
        <button onClick={() => setShowAdvanced(!showAdvanced)} style={{ fontSize: 12 }}>{showAdvanced ? '▾' : '▸'} Advanced: system prompts</button>
        {showAdvanced && (
          <div style={{ marginTop: 6 }}>
            <label style={{ fontSize: 12 }}>Scene-generation prompt</label>
            <textarea value={value.systemGenerate} onChange={(e) => set({ systemGenerate: e.target.value })} rows={5} style={{ width: '100%', marginTop: 4, fontSize: 12, fontFamily: 'monospace' }} />
            <label style={{ fontSize: 12, display: 'block', marginTop: 6 }}>Directional-edit prompt</label>
            <textarea value={value.systemEdit} onChange={(e) => set({ systemEdit: e.target.value })} rows={3} style={{ width: '100%', marginTop: 4, fontSize: 12, fontFamily: 'monospace' }} />
            <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
              <button onClick={() => onChange(resetPrompts())}>Reset to defaults</button>
              <span style={{ fontSize: 12, opacity: 0.6 }}>Tweak wording if the LLM output needs shaping.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
