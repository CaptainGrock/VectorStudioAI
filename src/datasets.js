// Reference datasets: attach a CSV/XLSX file or paste a markdown table.
// Parsed into { columns, rows } and embedded in chart layer data, so exports
// stay self-contained. The LLM path gets a compact summary instead.

export function cleanNumber(v) {
  if (typeof v === 'number') return v
  const s = String(v ?? '').replace(/[$,\s]/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  return Number(s)
}

export function isNumericColumn(rows, col) {
  let hits = 0, checked = 0
  for (const r of rows) {
    const v = r[col]
    if (v === '' || v == null) continue
    checked++
    if (cleanNumber(v) !== null) hits++
  }
  return checked > 0 && hits / checked >= 0.8
}

/** Split one CSV line, honouring quotes. */
function splitCSVLine(line) {
  const out = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }
        else inQ = false
      } else cur += c
    } else if (c === '"') inQ = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

export function parseCSV(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) return null
  const columns = splitCSVLine(lines[0])
  if (columns.length < 2) return null
  const rows = []
  for (const line of lines.slice(1)) {
    const cells = splitCSVLine(line)
    if (!cells.some((c) => c !== '')) continue
    const row = {}
    columns.forEach((c, i) => { row[c] = cells[i] ?? '' })
    rows.push(row)
  }
  return rows.length ? { columns, rows } : null
}

/** Parse the first markdown table found in text. */
export function parseMarkdownTable(text) {
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length - 2; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) continue
    if (!/^\s*\|[\s|:|-]+\|\s*$/.test(lines[i + 1])) continue
    const columns = lines[i].split('|').slice(1, -1).map((s) => s.trim())
    if (columns.length < 2 || columns.some((c) => !c)) continue
    const rows = []
    for (let j = i + 2; j < lines.length; j++) {
      if (!/^\s*\|.*\|\s*$/.test(lines[j])) break
      const cells = lines[j].split('|').slice(1, -1).map((s) => s.trim())
      if (!cells.some((c) => c !== '')) continue
      const row = {}
      columns.forEach((c, k) => { row[c] = cells[k] ?? '' })
      rows.push(row)
    }
    if (rows.length) return { columns, rows }
  }
  return null
}

export async function parseXLSX(file) {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) return null
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' })
  if (!aoa.length || aoa.length < 2) return null
  const columns = aoa[0].map((c) => String(c).trim())
  if (columns.length < 2 || columns.some((c) => !c)) return null
  const rows = []
  for (const line of aoa.slice(1)) {
    if (!line.some((c) => String(c).trim() !== '')) continue
    const row = {}
    columns.forEach((c, k) => {
      const v = line[k]
      row[c] = v == null ? '' : String(v).trim()
    })
    rows.push(row)
  }
  return rows.length ? { columns, rows } : null
}

export async function parseAttachedFile(file) {
  const name = file.name || 'dataset'
  const lower = name.toLowerCase()
  let table = null
  if (lower.endsWith('.csv')) table = parseCSV(await file.text())
  else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) table = await parseXLSX(file)
  else throw new Error(`Unsupported file: ${name} (use .csv or .xlsx)`)
  if (!table) throw new Error(`No table found in ${name}`)
  return { id: `ds_${Date.now().toString(36)}`, name, ...table }
}

/** Pick label + value columns: first text-ish column, best numeric column. */
export function pickXY(table) {
  const { columns, rows } = table
  const numeric = columns.filter((c) => isNumericColumn(rows, c))
  if (!numeric.length) return null
  const lower = (s) => s.toLowerCase()
  const valueCol =
    numeric.find((c) => /total|revenue|sales|amount|value/.test(lower(c))) ||
    numeric[numeric.length - 1]
  const labelCol =
    columns.find((c) => c !== valueCol && !isNumericColumn(rows, c)) ||
    columns.find((c) => c !== valueCol) ||
    columns[0]
  const labels = rows.map((r) => String(r[labelCol] ?? ''))
  const values = rows.map((r) => cleanNumber(r[valueCol]) ?? 0)
  return { labelCol, valueCol, labels, values }
}

const MAX_EMBED_ROWS = 500

export function tableToLayerData(table, maxRows = MAX_EMBED_ROWS) {
  const picked = pickXY(table)
  if (!picked) return null
  return {
    ...picked,
    rowCount: table.rows.length,
    rows: table.rows.slice(0, maxRows).map((r) => table.columns.map((c) => String(r[c] ?? ''))),
    columns: table.columns,
  }
}

/** Compact context for the LLM: columns, row count, first rows. */
export function summarizeForLLM(table, maxRows = 12) {
  const picked = pickXY(table)
  const head = table.rows.slice(0, maxRows)
    .map((r) => '| ' + table.columns.map((c) => String(r[c] ?? '')).join(' | ') + ' |')
    .join('\n')
  // Groupable (categorical) columns with distinct counts, so the model can
  // regroup ("count by vessel") instead of plotting every raw row.
  const groupable = table.columns
    .filter((c) => !isNumericColumn(table.rows, c))
    .slice(0, 10)
    .map((c) => {
      const distinct = [...new Set(table.rows.map((r) => String(r[c] ?? '').trim()).filter(Boolean))]
      return `${c} (${distinct.length}${distinct.length <= 8 ? ': ' + distinct.join(', ') : ''})`
    })
  return [
    `DATASET "${table.name}" (${table.rows.length} rows):`,
    '| ' + table.columns.join(' | ') + ' |',
    '| ' + table.columns.map(() => '---').join(' | ') + ' |',
    head,
    picked ? `Suggested mapping: labels=${picked.labelCol}, values=${picked.valueCol}.` : 'No clear numeric column.',
    groupable.length ? `Groupable: ${groupable.join(' · ')}. You can group ("group by X"), aggregate ("count/sum/average"), limit ("top N"), or drop a column ("ignore Z").` : '',
  ].filter(Boolean).join('\n')
}
