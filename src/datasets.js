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

/** Split one pasted line on commas (or semicolons for German-style CSV). */
function splitDelimited(line) {
  const comma = splitCSVLine(line)
  const semi = String(line).split(';').map((s) => s.trim())
  return semi.length > comma.length ? semi : comma
}

// A pasted table's header sometimes glues prompt prose onto its first cell
// ("create line chart with this data: State,Jan_hL,..."). When the text
// before the last colon looks like prose (contains a space), the real
// header starts after it.
function stripProsePrefix(cells) {
  if (!cells.length) return cells
  const first = String(cells[0] ?? '')
  const at = first.lastIndexOf(':')
  if (at < 0 || !/ /.test(first.slice(0, at))) return cells
  const head = first.slice(at + 1).trim()
  return head ? [head, ...cells.slice(1)] : cells
}

function delimitedCellsNumeric(cells) {
  let hits = 0, checked = 0
  for (const v of cells) {
    const t = String(v ?? '').trim()
    if (!t) continue
    checked++
    if (cleanNumber(t) !== null) hits++
  }
  return checked > 0 && hits / checked >= 0.8
}

/** Prose glued onto a span's header line ("create line chart with this
 *  data: State,Jan_hL,..." → "create line chart with this data:").
 *  Kept as prose when table lines are stripped, so intent words on the
 *  table line ("top 2 vessels:", "by vessel:") still match. */
export function gluedProsePrefix(line) {
  const cells = splitDelimited(line)
  const stripped = stripProsePrefix(cells)
  if (!stripped.length || stripped[0] === cells[0]) return ''
  const first = String(cells[0] ?? '')
  return first.slice(0, first.lastIndexOf(':') + 1).trim()
}

/** Raw line spans (inclusive) of pasted raw-CSV tables: runs of 3+ lines
 *  sharing a cell count, with a text header and at least one numeric
 *  column. Used to parse the paste AND to hide data lines from the
 *  prose-matching heuristics (mentions, grouping, lineage). */
export function delimitedTableSpans(text) {
  const lines = String(text).split(/\r?\n/)
  const spans = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue }
    const width = splitDelimited(lines[i]).length
    if (width < 2) { i++; continue }
    const run = [i]
    let j = i + 1
    while (j < lines.length && lines[j].trim() && splitDelimited(lines[j]).length === width) { run.push(j); j++ }
    if (run.length >= 3) {
      const columns = stripProsePrefix(splitDelimited(lines[run[0]]))
      const dataRows = run.slice(1).map((k) => splitDelimited(lines[k]))
      const hasTextHeader = columns.some((c) => { const t = String(c).trim(); return t !== '' && Number.isNaN(Number(t)) })
      const numericCol = columns.some((_, ci) => delimitedCellsNumeric(dataRows.map((r) => r[ci])))
      if (hasTextHeader && numericCol) spans.push({ start: run[0], end: run[run.length - 1] })
      i = j
    } else i++
  }
  return spans
}

/** Parse the richest pasted raw-CSV table in free text (or null). Only
 *  markdown tables were recognized before, so a comma-pasted dataset was
 *  silently ignored and the chart fell back to number-scraping the prose. */
export function parseDelimitedTable(text) {
  const lines = String(text).split(/\r?\n/)
  const spans = delimitedTableSpans(text)
  if (!spans.length) return null
  spans.sort((a, b) => (b.end - b.start) - (a.end - a.start))
  const s = spans[0]
  const columns = stripProsePrefix(splitDelimited(lines[s.start]))
  const rows = []
  for (let k = s.start + 1; k <= s.end; k++) {
    const cells = splitDelimited(lines[k])
    const row = {}
    columns.forEach((c, ci) => { row[c] = cells[ci] ?? '' })
    rows.push(row)
  }
  return rows.length ? { columns, rows } : null
}

const MONTH_TOKENS = new Set(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december'])
const PERIOD_WORDS = new Set(['month', 'week', 'quarter', 'year', 'day'])
function periodToken(t) {
  return MONTH_TOKENS.has(t) || PERIOD_WORDS.has(t) || /^q[1-4]$/.test(t) || /^(19|20)\d{2}$/.test(t)
}
function colWordTokens(c) {
  return String(c || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}
const SUMMARY_COL_RE = /total|sum|^ttm$|ytd|cagr|average|^avg|mean|grand/i

/** Wide time-series layout: one label column plus period columns
 *  (Jan_hL…Sep_hL, quarters, years). Returns the label column and the
 *  period columns in table order, excluding row-summary columns
 *  (YTD/total) and any user-excluded columns. */
export function widePeriodColumns(table, excluded = new Set()) {
  if (!table || !Array.isArray(table.columns)) return { labelCol: null, periods: [] }
  const textCols = table.columns.filter((c) => !excluded.has(c) && !isNumericColumn(table.rows, c))
  if (!textCols.length) return { labelCol: null, periods: [] }
  const periods = table.columns.filter((c) => {
    if (excluded.has(c)) return false
    if (!isNumericColumn(table.rows, c)) return false
    const toks = colWordTokens(c)
    if (!toks.some(periodToken)) return false
    // A summary column never enters the axis — unless it IS a period
    // ("January average" keeps its month token; YTD_Total_hL does not).
    if (SUMMARY_COL_RE.test(c) && !toks.some(periodToken)) return false
    return true
  })
  if (periods.length < 2) return { labelCol: null, periods: [] }
  return { labelCol: textCols[0], periods }
}

/** Shared unit across period columns ("Jan_hL" → "hL"), or ''. */
export function periodUnit(periods) {
  const stripped = (periods || []).map((c) => {
    const toks = colWordTokens(c)
    const pt = toks.find(periodToken)
    if (!pt) return String(c).trim()
    return String(c).replace(new RegExp(`^${pt}[_\\s-]*|[_\\s-]*${pt}$`, 'i'), '').trim()
  })
  const first = stripped[0] || ''
  return first && stripped.every((s) => s === first) ? first : ''
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
  const wide = widePeriodColumns(table)
  const summaryCols = wide.periods.length
    ? table.columns.filter((c) => c !== wide.labelCol && !wide.periods.includes(c))
    : []
  return [
    `DATASET "${table.name}" (${table.rows.length} rows):`,
    '| ' + table.columns.join(' | ') + ' |',
    '| ' + table.columns.map(() => '---').join(' | ') + ' |',
    head,
    picked ? `Suggested mapping: labels=${picked.labelCol}, values=${picked.valueCol}.` : 'No clear numeric column.',
    wide.periods.length ? `Wide time series: ${wide.periods.join(', ')} are time periods (one line per ${wide.labelCol}); ${summaryCols.join(', ') || 'no other columns'} are row summaries — plot series over the periods, never the summaries as points.` : '',
    groupable.length ? `Groupable: ${groupable.join(' · ')}. You can group ("group by X"), aggregate ("count/sum/average"), limit ("top N"), or drop a column ("ignore Z").` : '',
  ].filter(Boolean).join('\n')
}
