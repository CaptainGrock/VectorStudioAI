// LLM orchestration: Ollama -> OpenAI-compatible -> local rule-based fallback.
// Never writes code; only returns Scene Graph JSON or JSON Patch.

import { defaultScene, effectiveTiming } from './sceneGraph.js'
import { parseMarkdownTable, parseDelimitedTable, delimitedTableSpans, gluedProsePrefix, widePeriodColumns, periodUnit, tableToLayerData, summarizeForLLM, isNumericColumn, cleanNumber } from './datasets.js'
import { countryCoords, project } from './geo.js'

// Optional per-point coloring for table charts: "green for positive, red for
// negative" colors by sign when values span zero; "by category" / "color"
// colors by a grouping column and builds a legend. Returns { pointColors,
// legend } or null when the prompt asks for no coloring.
function colorizeTable(p, table, layerData) {
  if (!/green|red|colou?r|by categor/.test(p)) return null
  const min = Math.min(...layerData.values), max = Math.max(...layerData.values)
  if (/positive|negative/.test(p) && min < 0 && max > 0) {
    return {
      pointColors: layerData.values.map((v) => (v >= 0 ? '#3ddc84' : '#ff6b6b')),
      legend: [{ label: 'Positive', color: '#3ddc84' }, { label: 'Negative', color: '#ff6b6b' }],
    }
  }
  const groupCol = table.columns.find((c) => c !== layerData.labelCol && c !== layerData.valueCol && /categor|region|group|segment|type/.test(c.toLowerCase()) && !isNumericColumn(table.rows, c))
    || table.columns.find((c) => c !== layerData.labelCol && c !== layerData.valueCol && !isNumericColumn(table.rows, c))
  if (!groupCol) return null
  const palette = ['#3ddc84', '#4da3ff', '#ffcf40', '#b388ff', '#ff9f43', '#ff6b6b', '#4dd0e1']
  const groups = [...new Set(table.rows.map((r) => String(r[groupCol] ?? '')))]
  const colorOf = Object.fromEntries(groups.map((g, i) => [g, palette[i % palette.length]]))
  return {
    pointColors: table.rows.map((r) => colorOf[String(r[groupCol] ?? '')]),
    legend: groups.map((g) => ({ label: `${groupCol}: ${g}`, color: colorOf[g] })),
  }
}

let counter = 10
const nid = (p) => `${p}_${counter++}_${Date.now().toString(36)}`

function parseNumbers(prompt) {
  const nums = [...prompt.matchAll(/(\$)?(\d+(?:\.\d+)?)\s*k\b/gi)].map(m => Number(m[2]) * 1000)
  const plain = [...prompt.matchAll(/(?<!\S)(\d{2,7})(?!\S)/g)].map(m => Number(m[1]))
  return nums.length ? nums : plain
}

// Explicit chart-type words, checked in priority order (pie beats bar when a
// prompt mentions both). Returns a layer type or null.
const CHART_TYPE_WORDS = [
  [/donut|doughnut|pie/, 'pie_chart'],
  [/area/, 'area_chart'],
  [/scatter/, 'scatter_chart'],
  [/histogram/, 'histogram'],
  [/waterfall/, 'waterfall'],
  [/funnel/, 'funnel_chart'],
  [/radar|spider/, 'radar_chart'],
  [/surface|terrain|\b3d\b/, 'surface_plot'],
  [/\bline\b/, 'line_chart'],
  [/\bbar\b/, 'bar_chart'],
]
export function chartTypeFromPrompt(p) {
  for (const [re, t] of CHART_TYPE_WORDS) if (re.test(p)) return t
  return null
}

export function wantsChart(prompt) {
  const p = prompt.toLowerCase()
  return p.includes('chart') || p.includes('graph') || p.includes('plot') || p.includes('data set') || p.includes('dataset')
    || p.includes('sales') || p.includes('bar') || p.includes('growing') || p.includes('line')
    || p.includes('stack')
    || chartTypeFromPrompt(p) != null
}

export function wantsMap(prompt) {
  const nt = stripTableLines(prompt).toLowerCase()
  if (/\bmap\b|bubble|geograph|choropleth|\bglobe\b/.test(nt)) return true
  // "by country" alone is a grouping, not a map — only a map when no
  // explicit chart type (pie, bar, …) was requested.
  if (/\bcountr(y|ies)\b/.test(nt) && !chartTypeFromPrompt(nt)) return true
  return false
}

const MAP_PALETTE = ['#4da3ff', '#3ddc84', '#ffcf40', '#b388ff', '#ff9f43', '#ff6b6b', '#4dd0e1', '#ff7eb6']

// One bubble per country: size = total metric, color = biggest category.
// Coordinates are projected to the 1280x720 canvas at build time.
export function buildMapLayer(p, table, base = defaultScene, maxBubbles = 60) {
  const countryCol = table.columns.find((c) => /country/i.test(c))
  if (!countryCol) return null
  const numeric = table.columns.filter((c) => isNumericColumn(table.rows, c))
  if (!numeric.length) return null
  const lower = (s) => String(s).toLowerCase()
  // Priority order matters: check each metric name across ALL columns before
  // falling through, so 'Quantity Sold' never shadows 'Total Revenue'.
  const METRIC_PREF = ['net revenue', 'total revenue', 'revenue', 'sales', 'profit', 'quantity', 'amount', 'value']
  const valueCol =
    METRIC_PREF.map((want) => numeric.find((c) => lower(c).includes(want))).find(Boolean) ||
    numeric[numeric.length - 1]
  const categoryCol =
    table.columns.find((c) => c !== countryCol && /categor/i.test(c)) ||
    table.columns.find((c) => c !== countryCol && c !== valueCol && !isNumericColumn(table.rows, c))
  const agg = new Map()
  for (const r of table.rows) {
    const country = String(r[countryCol] ?? '').trim()
    if (!country) continue
    const v = cleanNumber(r[valueCol]) ?? 0
    let e = agg.get(country)
    if (!e) { e = { value: 0, cats: {} }; agg.set(country, e) }
    e.value += v
    if (categoryCol) {
      const cat = String(r[categoryCol] ?? '').trim() || 'Other'
      e.cats[cat] = (e.cats[cat] || 0) + v
    }
  }
  const cats = [...new Set([...agg.values()].flatMap((e) => Object.keys(e.cats)))]
  const colorOf = Object.fromEntries(cats.map((c, i) => [c, MAP_PALETTE[i % MAP_PALETTE.length]]))
  const bubbles = []
  const skipped = []
  for (const [country, e] of [...agg.entries()].sort((a, b) => b[1].value - a[1].value)) {
    const ll = countryCoords(country)
    if (!ll) { skipped.push(country); continue }
    if (bubbles.length >= maxBubbles) break
    const topCat = Object.entries(e.cats).sort((a, b) => b[1] - a[1])[0]?.[0] || null
    const { x, y } = project(ll[0], ll[1])
    bubbles.push({ country, x, y, value: Math.round(e.value * 100) / 100, category: topCat, color: topCat ? colorOf[topCat] : '#4da3ff' })
  }
  if (!bubbles.length) return null
  return {
    id: nid('layer'), name: `${valueCol} by country`, type: 'map_bubbles',
    ...titleFlags(p),
    startFrame: 0, endFrame: base.durationInFrames,
    data: { metric: valueCol, bubbles, legend: cats.map((c) => ({ label: c, color: colorOf[c] })), maxValue: bubbles[0].value, skipped: skipped.length, source: table.name, ...parseSpeed(p) },
    keyframes: [
      { frame: 0, properties: { opacity: 0, scale: 1 } },
      { frame: 20, properties: { opacity: 1, scale: 1 } },
    ],
  }
}

export function findPromptTable(prompt, datasets = []) {
  const inline = parseMarkdownTable(prompt)
  if (inline) return { id: 'pasted', name: 'pasted table', ...inline }
  // Raw comma/semicolon pastes (no markdown pipes) are tables too —
  // without this the chart silently falls back to number-scraping.
  const csv = parseDelimitedTable(prompt)
  if (csv) return { id: 'pasted', name: 'pasted table', ...csv }
  return datasets[0] || null
}

// Prose-only view of a prompt: drops markdown table lines AND pasted
// raw-CSV lines, so data values never read as user intent (mentions,
// grouping, shapes, lineage all consume this).
export function stripTableLines(p) {
  const lines = String(p || '').split('\n')
  const inSpan = new Set()
  const starts = new Set()
  for (const s of delimitedTableSpans(String(p || ''))) {
    starts.add(s.start)
    for (let i = s.start; i <= s.end; i++) inSpan.add(i)
  }
  const out = []
  lines.forEach((l, i) => {
    if (/^\s*\|/.test(l)) return
    if (!inSpan.has(i)) { out.push(l); return }
    // Span header glued to prose ("top 2 vessels: State,..."): keep the
    // prose so intent words survive, drop only the table itself.
    if (starts.has(i)) {
      const pre = gluedProsePrefix(l)
      if (pre) out.push(pre)
    }
  })
  return out.join('\n')
}

// Data-directive parsing: lets prompts regroup, re-measure and re-shape a
// table ("group by vessel, count the states", "ignore the scoops column",
// "average of revenue by region", "top 10", "y-axis should be vessel").
// Column names match fuzzily (substrings, plurals, underscores), so
// "vessel", "vessel type" and "preferred_vessel" all resolve the same way.
const COL_STOP = new Set(['the', 'a', 'an', 'column', 'columns', 'col', 'cols', 'data', 'info', 'information', 'field', 'fields', 'metric', 'metrics', 'series', 'values', 'value', 'numbers', 'number', 'by', 'per', 'of', 'for', 'and', 'or', 'with', 'as', 'is', 'are', 'be', 'should', 'axis', 'axes', 'x', 'y'])
function colTokens(c) {
  return String(c || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
}
function stemTok(w) {
  return String(w || '').replace(/(ies)$/, 'y').replace(/(es|s)$/, '')
}
// Best-match a free-text phrase to a table column. Tight mode only accepts
// an exact hit or every phrase word inside one column's tokens (used for
// "ignore X", so "sum by states" never excludes the state column).
function matchColumn(table, phrase, tight = false) {
  const words = String(phrase || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !COL_STOP.has(w))
  if (!words.length) return null
  const cols = table.columns.map((c) => ({ c, toks: colTokens(c) }))
  const joined = words.join(' ')
  const exact = cols.find((x) => x.toks.join(' ') === joined)
  if (exact) return exact.c
  const strong = cols.find((x) => words.every((w) => x.toks.some((t) => t === w || stemTok(t) === stemTok(w))))
  if (strong) return strong.c
  if (tight) return null
  const loose = cols.find((x) => {
    const flat = x.toks.join('')
    return words.some((w) => w.length >= 3 && (flat.includes(w) || flat.includes(stemTok(w))))
  })
  if (loose) return loose.c
  return null
}
// "ignore the scoops column" / "excluding year" / "without the code" —
// columns to drop from metric/label candidacy.
function parseExclusions(p, table) {
  const out = new Set()
  const re = /(?:ignor(?:e|ing)|exclud(?:e|ing)|without|drop(?:ping)?|skip(?:ping)?|leave out|(?:do not|don't) use|\bno\b)\s+(?:the\s+)?([^.,;\n]+)/gi
  let m
  while ((m = re.exec(p)) !== null) {
    for (const chunk of m[1].split(/\s+and\s+|,/)) {
      const hit = matchColumn(table, chunk, true)
      if (hit) out.add(hit)
    }
  }
  return out
}
// Explicit axis/group asks: "y-axis vessel", "y-axis should be vessel",
// "labels are region", "grouped by flavor". Wins over a bare "by X".
function parseAxisHint(p, table) {
  const m = p.match(/(?:y[-\s]?axis|x[-\s]?axis|labels?|categories|groups?|grouped?)\s+(?:(?:should\s+be|are|is|=|:|by|as)\s+)?([^.,;\n()]+)/i)
  if (!m) return null
  return matchColumn(table, groupHead(m[1])) || null
}
// "group by vessel and count the states": the group target is the head —
// cut the aggregation tail before matching a column, or "states" outscores
// "vessel" via stemming.
function groupHead(phrase) {
  const cut = String(phrase || '').split(/\b(?:and|then|,)\s+(?:count|sum|total|averag|mean|top|per)\b/i)[0]
  return (cut || phrase).trim()
}
function parseMetric(p, usableNumeric) {
  const sumM = p.match(/(?:sum|total|add(?:ing)? up|sum up)(?:\s+of)?\s+(?:the\s+)?([a-z][a-z0-9_ ]*?)(?=\s+by\s+|\s+per\s+|[^a-z0-9_ ]|$)/i)
  const avgM = p.match(/(?:average|avg|mean)(?:\s+of)?\s+(?:the\s+)?([a-z][a-z0-9_ ]*?)(?=\s+by\s+|\s+per\s+|$)/i)
  const agg = avgM ? 'mean' : 'sum'
  const want = (avgM?.[1] || sumM?.[1] || '').trim()
  if (want) {
    const hit = (usableNumeric || []).find((c) => matchColumn({ columns: [c] }, want, true) === c)
      || (usableNumeric || []).find((c) => matchColumn({ columns: [c] }, want) === c)
    if (hit) return { valueCol: hit, agg }
  }
  return { valueCol: null, agg }
}
function wantsCount(p) {
  return /\b(count|counts|counting|how many|number of|frequency|frequencies|distribution)\b/.test(p)
}
// A chart layer embeds its source table (columns + rows), so revisions keep
// working after a reload or when the dataset was pasted into the prompt and
// never attached as a file. Rebuilds a { columns, rows } table for reuse.
export function tableFromLayer(layer) {
  const d = layer?.data || {}
  if (!Array.isArray(d.columns) || !Array.isArray(d.rows) || !d.rows.length) return null
  const rows = d.rows.map((vals) => {
    const r = {}
    d.columns.forEach((c, i) => { r[c] = Array.isArray(vals) ? (vals[i] ?? '') : '' })
    return r
  })
  // The embed caps rows (localStorage quota for saved history), but the
  // original count travels with it — so the app can say "51 rows, first
  // 500 in scene" and prompt a re-attach instead of silently regrouping
  // on a partial copy.
  const rowCount = Number(d.rowCount) || rows.length
  return { id: 'scene', name: d.source || layer?.name || 'embedded data', columns: d.columns, rows, rowCount, truncated: rowCount > rows.length }
}

// Which table would a revise actually regroup on? Shared by the patch
// engine and the UI, so the "re-attach" warning fires exactly when the
// data ops below ran on a truncated embedded copy.
export function resolveEditTable(scene, datasets, prompt) {
  const p = String(prompt || '').toLowerCase()
  const inlineTable = parseMarkdownTable(prompt)
  const namedDataset = (datasets || []).find((d) => {
    const nm = String(d.name || '').toLowerCase()
    const base = nm.replace(/\.[a-z0-9]+$/, '')
    return (nm && nm.length >= 3 && p.includes(nm)) || (base && base.length >= 3 && p.includes(base))
  })
  const keywordRef = /other|different|second|attached|reference|sheet|dataset|data set|\bcsv\b|\bxlsx?\b/.test(p)
  // No attached/pasted table? Fall back to the one the layer already
  // embeds, so "group by vessel and count the states" still regroups after
  // a reload or when the data was pasted into the original prompt.
  const sceneTable = (scene.layers || []).map(tableFromLayer).find(Boolean) || null
  const table = inlineTable ? { id: 'pasted', name: 'pasted table', ...inlineTable }
    : namedDataset || ((datasets || []).length === 1 ? datasets[0] : (keywordRef && (datasets || []).length ? datasets[datasets.length - 1] : null))
      || sceneTable
  if (!table) return { table: null, truncated: false, tableSwitch: false }
  return {
    table,
    // Pasted + attached tables are full originals; only the embedded
    // fallback can be a partial copy.
    truncated: !inlineTable && !namedDataset && !(datasets || []).includes(table) && !!table.truncated,
    tableSwitch: !!inlineTable || !!namedDataset || (keywordRef && !!(datasets || []).length),
  }
}

// The candidate after "by ..." ("sum by states"), head-split from any
// aggregation tail so "states" can't outscore the real target.
const GROUP_PHRASE_RE = /\bby\s+([a-z][a-z &]*?)(?:\s+reference|\s+sheet|\s+data|\s+for\s|\s+based|\s+from\s|,|\s+total|\s+amount|$)/;
export function groupCandidate(p) {
  const m = String(p || '').toLowerCase().match(GROUP_PHRASE_RE);
  return groupHead(m?.[1] || '');
}

// When a revise yields no patch, say exactly why instead of the generic
// capabilities list: no visible table, an unmatched column (with the real
// column list), or an already-applied grouping.
export function diagnoseNoPatch(scene, datasets, prompt) {
  const p = String(prompt || '');
  const low = p.toLowerCase();
  // "keep stationary / don't rise / connect the lines": line + area points
  // already hold their final positions (the wipe reveals them, dots pop in
  // sequence) — nothing to patch, so confirm instead of guessing.
  const stillIntent = /stationar|stay (in place|put|still)|don't (move|rise|animate|float)|static position|keep .*still|stop .*ris|fix .*in place|connect the lines?|join the dots?/.test(low);
  const axisAskD = /\by-axis\b|\bx-axis\b/.test(low)
  const tickCharts = (scene.layers || []).some((l) => l.type === 'line_chart' || l.type === 'area_chart' || l.type === 'scatter_chart')
  if (axisAskD && !parseAxisFormat(p).yFormat && tickCharts) {
    return `Y-axis ticks are on by default — tell me the units and I'll format every division, e.g. “y-axis in $M millions”, “thousands”, or “percent”. (Words like “total amount” alone describe the data, not the axis — that's why nothing changed.)`
  }
  if (stillIntent && (scene.layers || []).some((l) => l.type === 'line_chart' || l.type === 'area_chart')) {
    return `Already stationary — line and area points hold their final positions while the wipe reveals them left-to-right (dots pop in sequence with Stagger). Two alternatives: say “connect the dots” and the dots pop first while each segment draws between them; say “wipe reveal” to go back. To change pacing instead, try “slower reveal” or “all at once”.`;
  }
  const dataIntent = /\bgroup(?:s|ed|ing)?\b|\bcount\b|how many|\baverag|\bmean\b|\bsum\b|\btop\s+\d|\bbottom\s+\d|\bfilter\b|\bcolumn\b|\bfield\b|\bheader\b|\bdataset\b|\bexcluding\b|\bignor\w+|\bstack(?:ed)?\b|\bunstack\b|\bclustered\b/.test(low);
  const { table } = resolveEditTable(scene, datasets, p);
  if (!table) {
    if (!dataIntent) return null;
    return `“${p.trim().slice(0, 80)}” needs the dataset, but I can't see one — nothing is attached and this scene doesn't carry its table (older generations didn't save it). Re-attach the CSV/XLSX, or paste the table into Generate and regenerate; then ask again and I'll group it right away.`;
  }
  const cand = groupCandidate(p);
  if (cand && !matchColumn(table, cand)) {
    return `I couldn't match “${cand}” to a column. This table has: ${table.columns.join(', ')}. Try “group by <one of these>” — e.g. “group by ${table.columns[0]}”.`;
  }
  if (cand) {
    const col = matchColumn(table, cand);
    const done = (scene.layers || []).find((l) => l.data?.aggregatedBy === col);
    if (done) return `Already grouped by “${col}” (${(done.data.labels || []).length} groups). Ask to count, average, filter values, or take the top N instead.`;
  }
  return null;
}

// Plain-language schema for the revision chat: what can be plotted, with
// example values so a follow-up ask is easy to phrase.
export function describeTable(table) {
  if (!table || !Array.isArray(table.columns)) return ''
  const rows = table.rows || []
  const fmt = (v) => Math.round(v * 100) / 100
  const lines = table.columns.map((c) => {
    if (isNumericColumn(rows, c)) {
      const vals = rows.map((r) => cleanNumber(r[c])).filter((v) => v !== null)
      const min = Math.min(...vals), max = Math.max(...vals)
      return `• ${c} — numeric (${fmt(min)}–${fmt(max)})`
    }
    const distinct = [...new Set(rows.map((r) => String(r[c] ?? '').trim()).filter(Boolean))]
    const ex = distinct.slice(0, 3).join(', ') + (distinct.length > 3 ? ', …' : '')
    return `• ${c} — ${distinct.length} value${distinct.length === 1 ? '' : 's'}${ex ? ` (${ex})` : ''}`
  })
  return lines.join('\n')
}

// Value mentions: every actual categorical cell value appearing in the
// prompt (longest first), with its column. Used both for row filtering and
// to detect regroup intent in revise.
export function findValueMentions(p, table) {
  const low = String(p || '').toLowerCase()
  const catCols = table.columns.filter((c) => !isNumericColumn(table.rows, c))
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const out = []
  for (const c of catCols) {
    const distinct = [...new Set(table.rows.map((r) => String(r[c] ?? '').trim()).filter((v) => v.length >= 2))]
    distinct.sort((a, b) => b.length - a.length)
    for (const v of distinct) {
      // Whole-value match: (^|\W)value(\W|$) so a state code like "AL"
      // never fires inside "verticAL", and "Cup" not inside "Cupcakes".
      if (new RegExp(`(^|\\W)${esc(v.toLowerCase())}(\\W|$)`, 'i').test(low)) out.push({ col: c, value: v })
    }
  }
  return out
}
function parseSort(p) {
  const top = p.match(/\btop\s+(\d+)/i)
  if (top) return { dir: 'desc', n: Math.max(1, Math.min(100, Number(top[1]))), explicit: true }
  const bottom = p.match(/\bbottom\s+(\d+)/i)
  if (bottom) return { dir: 'asc', n: Math.max(1, Math.min(100, Number(bottom[1]))), explicit: true }
  const m = p.match(/\b(largest|highest|biggest|greatest|smallest|lowest|least)\b/)
  if (m) return { dir: /largest|highest|biggest|greatest/.test(m[1].toLowerCase()) ? 'desc' : 'asc', n: null, explicit: true }
  const s = p.match(/\bsort(?:ed|ing)?(?:\s+by\s+value)?\s+(desc(?:ending)?|asc(?:ending)?)/i)
  if (s) return { dir: s[1].startsWith('desc') ? 'desc' : 'asc', n: null, explicit: true }
  if (/\balphabetical/.test(p)) return { dir: null, n: null, explicit: true, alpha: true }
  return { dir: 'desc', n: null, explicit: false }
}
// Shared row filter for the flat and stacked builders: include/exclude by
// actual cell values ("only Cup and Waffle Cone", "excluding Texas").
// Returns { rows, filterName, mentions, empty } — empty means the filter
// matched nothing, so callers bail instead of plotting blindly.
export function filterRowsByMentions(p, table) {
  let rows = table.rows
  let filterName = null
  // Mention matching ignores pasted table lines (markdown or raw CSV):
  // values coming from the data itself are not user intent ("chart of
  // revenue" must not filter to the first table value).
  const pnt = stripTableLines(p)
  const mentions = findValueMentions(pnt, table)
  if (mentions.length) {
    const before = (i, re) => re.test(pnt.slice(Math.max(0, i - 28), i))
    const inc = new Map(), exc = new Map()
    for (const m of mentions) {
      const at = pnt.indexOf(m.value.toLowerCase())
      const isExc = before(at, /exclud(?:e|ing)|except|without|not|\bno\b|remove|drop|skip|ignor(?:e|ing)|leave out|other than|besides|but not/i)
      const bucket = isExc ? exc : inc
      if (!bucket.has(m.col)) bucket.set(m.col, new Set())
      bucket.get(m.col).add(m.value)
    }
    if (exc.size) {
      rows = rows.filter((r) => ![...exc.entries()].some(([c, vals]) => vals.has(String(r[c] ?? '').trim())))
      const names = [...exc.values()].flatMap((s) => [...s]).slice(0, 3)
      filterName = `excluding ${names.join(', ')}${[...exc.values()].flatMap((s) => [...s]).length > 3 ? ', …' : ''}`
    } else if (inc.size) {
      const explicit = /only|just|filter(?:ed|ing)?|show|keep|for|from|with|limit|restrict|focus|\band\b|,|\bor\b|\bvs\b|versus|compare|between/.test(pnt)
      if (explicit || [...inc.values()].reduce((n, s) => n + s.size, 0) === 1) {
        rows = rows.filter((r) => [...inc.entries()].every(([c, vals]) => vals.has(String(r[c] ?? '').trim())))
        const names = [...inc.values()].flatMap((s) => [...s]).slice(0, 3)
        filterName = `${names.join(', ')}${[...inc.values()].flatMap((s) => [...s]).length > 3 ? ', …' : ''}`
      } else {
        // Bare single mention (legacy "Germany sales" parity): first hit wins.
        const m0 = mentions[0]
        rows = rows.filter((r) => String(r[m0.col] ?? '').trim() === m0.value)
        filterName = m0.value
      }
    }
    if (!rows.length) return { rows, filterName, mentions, empty: true }
  }
  return { rows, filterName, mentions, empty: false }
}

// When the prompt groups by country ("pie by country"), collapse table rows
// to one label per country (top 24 by value) instead of one per raw row.
// Prose-only prompt for rebuilds: pasted-table lines would bloat history and
// go stale, so refresh replays just the words that shaped the mapping.
export function prosePrompt(p) {
  return stripTableLines(p).split('\n').join(' ').replace(/\s+/g, ' ').trim().slice(0, 400)
}
// Lineage stamp shared by the chart builders: which session dataset this
// layer came from (by id) and the prose that shaped it, so a replaced file
// can rebuild the same mapping on new rows without the LLM.
function lineage(p, table) {
  return {
    source: table.name,
    buildPrompt: prosePrompt(p),
    ...(table.id && table.id !== 'scene' ? { datasetId: table.id } : {}),
  }
}
// Wide time-series tables (one label column plus period columns like
// Jan_hL…Sep_hL): a line ask plots one series per row over the periods —
// never one point per row off a summary column. Totals/YTD rank the
// series but never enter the axis. Caps at 12 series (top by total,
// fewer with an explicit "top N").
const MAX_LINE_SERIES = 12
function wideSeriesData(p, table, rows, excluded) {
  const t = chartTypeFromPrompt(p)
  if (t && t !== 'line_chart') return null
  if (parseAxisHint(p, table)) return null
  const { labelCol, periods } = widePeriodColumns(table, excluded)
  if (!labelCol || periods.length < 2 || !rows.length) return null
  const { valueCol: namedMetric } = parseMetric(p, [])
  if (namedMetric) return null
  if (wantsCount(p) || wantsStacked(p) || wantsUnstacked(p)) return null
  const gm = stripTableLines(p).match(/\bby\s+([a-z][a-z &]*?)(?:\s+reference|\s+sheet|\s+data|\s+for\s|\s+based|\s+from|,|\s+total|\s+amount|$)/)
  if (gm && matchColumn(table, groupHead(gm[1]))) return null
  const sort = parseSort(p)
  const unit = periodUnit(periods)
  const all = rows.map((r, i) => ({
    label: String(r[labelCol] ?? '').trim() || `Row ${i + 1}`,
    values: periods.map((c) => cleanNumber(r[c]) ?? 0),
  }))
  all.sort((a, b) => b.values.reduce((x, y) => x + y, 0) - a.values.reduce((x, y) => x + y, 0))
  const kept = all.slice(0, Math.max(1, sort.n ?? MAX_LINE_SERIES))
  const series = kept.map((s, si) => ({
    label: s.label,
    values: s.values.map((v) => Math.round(v * 100) / 100),
    color: STACK_PALETTE[si % STACK_PALETTE.length],
  }))
  return {
    labelCol, valueCol: unit || 'value', labels: periods, series,
    legend: series.map((s) => ({ label: s.label, color: s.color })),
    aggregatedBy: labelCol, aggregation: 'series',
    ...(all.length > kept.length ? { seriesTruncated: all.length - kept.length } : {}),
    rowCount: rows.length,
    rows: table.rows.slice(0, 500).map((r) => table.columns.map((c) => String(r[c] ?? ''))),
    columns: table.columns,
  }
}

export function tableChartData(p, table) {
  let base = tableToLayerData(table)
  // No numeric column (pure categorical table): counting rows per group is
  // still well-defined, so build a minimal base instead of giving up.
  if (!base) {
    if (!table || !Array.isArray(table.columns)) return null
    base = {
      labelCol: table.columns[0], valueCol: null, labels: [], values: [],
      rowCount: table.rows.length,
      rows: table.rows.slice(0, 500).map((r) => table.columns.map((c) => String(r[c] ?? ''))),
      columns: table.columns,
    }
  }
  const round2 = (v) => Math.round(v * 100) / 100
  // Row filter: match the prompt against actual column values, not keywords
  // ("sales from Germany", "only Cup and Waffle Cone", "excluding Texas").
  // Works on any categorical column — not just Country.
  const countryCol = table.columns.find((c) => /country/i.test(c))
  const filtered = filterRowsByMentions(p, table)
  if (filtered.empty) return null
  const { rows, filterName, mentions } = filtered
  // Usable numerics: drop excluded columns and constant columns (a year
  // column holding one value can never be a metric). Judged on the full
  // table — filtering to one row must not disqualify the metric.
  const excluded = parseExclusions(p, table)
  const usableNumeric = table.columns.filter((c) => !excluded.has(c) && isNumericColumn(table.rows, c)
    && new Set(table.rows.map((r) => String(r[c] ?? '').trim())).size > 1)
  // Group-by: an explicit axis hint ("y-axis vessel") wins, then "by X",
  // then the legacy category default. Collapse rows to one label per group.
  let groupCol = parseAxisHint(p, table)
  if (groupCol && (groupCol === countryCol || excluded.has(groupCol))) groupCol = null
  if (!groupCol) {
    const gm = p.match(/\bby\s+([a-z][a-z &]*?)(?:\s+reference|\s+sheet|\s+data|\s+for\s|\s+based|\s+from\s|,|\s+total|\s+amount|$)/)
    if (gm) groupCol = matchColumn(table, groupHead(gm[1])) || null
  }
  if (!groupCol) {
    // Bare column mention ("top 2 vessels", "vessel counts"): a distinctive
    // categorical column token named outright in the prose (not the pasted
    // table) reads as a grouping ask.
    const pNoTable = stripTableLines(p)
    groupCol = table.columns.filter((c) => c !== countryCol && !excluded.has(c) && !isNumericColumn(rows, c)).find((c) =>
      colTokens(c).some((t) => t.length >= 5 && new RegExp(`\\b${t}s?\\b`).test(pNoTable))
    ) || null
  }
  if (!groupCol && mentions.length >= 2 && !parseMarkdownTable(p) && !parseDelimitedTable(p)) {
    // Value-implied grouping ("only Cup and Waffle Cone"): several named
    // values from one column read as "group by that column". Skipped when
    // the table is pasted inline (every value trivially matches its column).
    const byCol = new Map()
    for (const m of mentions) byCol.set(m.col, (byCol.get(m.col) || 0) + 1)
    const top = [...byCol.entries()].sort((a, b) => b[1] - a[1])[0]
    if (top && top[1] >= 2 && !excluded.has(top[0])) groupCol = top[0]
  }
  if (!groupCol && /\bcategor/.test(p)) groupCol = table.columns.find((c) => /categor/i.test(c)) || null
  if (groupCol && excluded.has(groupCol)) groupCol = null
  // Wide time-series (label + period columns) with no explicit grouping:
  // one series per row over the periods, not one point per row.
  if (!groupCol) {
    const wide = wideSeriesData(p, table, rows, excluded)
    if (wide) return filterName ? { ...wide, filteredBy: filterName } : wide
  }
  // Metric: an explicitly named one ("sum of revenue", "average of
  // scoops") wins; otherwise the default metric unless it was excluded.
  const { valueCol: namedMetric, agg } = parseMetric(p, usableNumeric)
  let valueCol = namedMetric
    || (usableNumeric.includes(base.valueCol) ? base.valueCol : null)
    || usableNumeric.find((c) => /total|revenue|sales|profit|quantity|amount|value|price|cost/.test(c.toLowerCase()))
    || usableNumeric[0]
    || null
  if (valueCol && valueCol === groupCol) {
    valueCol = usableNumeric.find((c) => c !== groupCol) || null
  }
  // No plottable metric: count rows per group ("x-axis count of states");
  // an explicit count ask wins even when a metric exists.
  const doCount = !!groupCol && (!valueCol || (wantsCount(p) && !namedMetric))
  const cval = !excluded.has(base.valueCol) ? base.valueCol : (usableNumeric[0] || base.valueCol)
  const sort = parseSort(p)
  const sortEntries = (entries) => {
    const out = [...entries]
    if (sort.alpha) out.sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    else if (sort.dir === 'asc') out.sort((a, b) => a[1] - b[1])
    else out.sort((a, b) => b[1] - a[1])
    return out
  }
  if (groupCol && groupCol !== countryCol) {
    const acc = new Map()
    for (const r of rows) {
      const k = String(r[groupCol] ?? '').trim() || 'Unknown'
      if (doCount) { acc.set(k, (acc.get(k) || 0) + 1); continue }
      const v = cleanNumber(r[valueCol]) ?? 0
      const e = acc.get(k) || { sum: 0, n: 0 }
      e.sum += v; e.n += 1; acc.set(k, e)
    }
    let entries = doCount ? [...acc.entries()]
      : [...acc.entries()].map(([k, e]) => [k, agg === 'mean' ? e.sum / Math.max(1, e.n) : e.sum])
    entries = sortEntries(entries).slice(0, sort.n ?? 60)
    if (!entries.length) return null
    return {
      ...base, labels: entries.map((e) => e[0]), values: entries.map((e) => round2(e[1])),
      aggregatedBy: groupCol, aggregation: doCount ? 'count' : agg,
      ...(doCount ? { valueCol: 'Count' } : { valueCol }),
      ...(filterName ? { filteredBy: filterName } : {}), rowCount: entries.length,
    }
  }
  if (countryCol && /countr(y|ies)/.test(p)) {
    const sums = new Map()
    for (const r of rows) {
      const k = String(r[countryCol] ?? '').trim() || 'Unknown'
      sums.set(k, (sums.get(k) || 0) + (cleanNumber(r[cval]) ?? 0))
    }
    const entries = sortEntries([...sums.entries()]).slice(0, sort.n ?? 24)
    if (!entries.length) return null
    return { ...base, labels: entries.map((e) => e[0]), values: entries.map((e) => round2(e[1])), aggregatedBy: countryCol, ...(filterName ? { filteredBy: filterName } : {}), rowCount: entries.length }
  }
  // Ungrouped rows: a dropped default metric (or top-N / sort ask) rebuilds
  // the per-row series instead of plotting the excluded column.
  const labelCol = !excluded.has(base.labelCol) ? base.labelCol
    : table.columns.find((c) => c !== valueCol && !isNumericColumn(rows, c)) || base.labelCol
  if (rows.length !== table.rows.length || (valueCol && valueCol !== base.valueCol) || sort.explicit || excluded.has(base.labelCol)) {
    if (!valueCol && !doCount) {
      // Filtered but nothing plottable (every metric excluded): no honest
      // chart — let the caller fall back instead of plotting blindly.
      if (rows.length !== table.rows.length) return null
      return base
    }
    let idx = rows.map((_, i) => i)
    const labels = rows.map((r) => String(r[labelCol] ?? ''))
    const values = rows.map((r) => cleanNumber(r[valueCol || base.valueCol]) ?? 0)
    if (sort.explicit) {
      if (sort.alpha) idx.sort((a, b) => labels[a].localeCompare(labels[b]))
      else idx.sort((a, b) => (sort.dir === 'asc' ? values[a] - values[b] : values[b] - values[a]))
    }
    const capped = (sort.n != null ? idx.slice(0, sort.n) : idx).slice(0, 200)
    return {
      ...base, labelCol, valueCol: valueCol || base.valueCol,
      labels: capped.map((i) => labels[i]), values: capped.map((i) => values[i]),
      ...(sort.n != null ? { topN: sort.n } : {}),
      ...(filterName ? { filteredBy: filterName } : {}), rowCount: rows.length,
    }
  }
  return base
}

// "without title" / "no legend" (and "show the legend" to re-enable).
export function titleFlags(p) {
  const flags = {}
  if (/(no|without|hide|remove|off)\b[^.]{0,24}\btitle\b/.test(p)) flags.showTitle = false
  if (/(no|without|hide|remove|off)\b[^.]{0,24}\blegend\b/.test(p)) flags.showLegend = false
  if (/\bshow\b[^.]{0,24}\btitle\b/.test(p)) flags.showTitle = true
  if (/\bshow\b[^.]{0,24}\blegend\b/.test(p)) flags.showLegend = true
  return flags
}

// Pacing words: "fast/quick" vs "slow/gradual", "all at once" vs staggered.
// Returns { reveal?, stagger? } to spread into layer data.
export function parseSpeed(p) {
  const out = {}
  if (/\bfast\b|\bquick\b|snappy|\bbrisk\b|\brapid\b/.test(p)) { out.reveal = 24; out.stagger = 1 }
  else if (/\bslow\b|gradual|leisurely|dramatic|cinematic/.test(p)) { out.reveal = 90; out.stagger = 6 }
  if (/all at once|simultaneous(ly)?|all together/.test(p)) out.stagger = 0
  else if (/one by one|sequential(ly)?|stagger(ed)?/.test(p) && out.stagger == null) out.stagger = 8
  return out
}

// Line draw style: "connect the dots", "dots pop first then connect",
// "no wipe/slide reveal" → dots pop in sequence and each segment draws
// between two popped dots. Stored as data.drawMode; the wipe is default.
function parseDrawMode(p) {
  const s = String(p || '').toLowerCase()
  const t = chartTypeFromPrompt(p)
  if (t && t !== 'line_chart') return {}
  const connect = /connect( the| those| these)? (dots|points|them|lines?)|\bconnect the dots\b|(dots?|points?).{0,40}then.{0,20}connect|connect.{0,20}(dots?|points?|lines?)|(dots?|points?) first|draw the line between|no (wipe|slide|sweep)/.test(s)
  // Dots-then-connect only reads when dots pop in sequence: default a
  // gentle stagger unless the prompt paces otherwise (parseSpeed spreads
  // after this, so "all at once" / explicit stagger words still win).
  return connect ? { drawMode: 'connect', stagger: 4 } : {}
}

// Axis display units: "y-axis in $M millions", "thousands", "percent".
// Stored as data.yFormat; line/area/scatter tick labels honor it.
export function parseAxisFormat(p) {
  const s = String(p || '').toLowerCase()
  if (/\$m\b|millions?\b/.test(s)) return { yFormat: '$M' }
  if (/\$k\b|thousands?\b/.test(s)) return { yFormat: '$k' }
  if (/\bpercent\b|%/.test(s)) return { yFormat: '%' }
  return {}
}
export function buildTableChartLayer(p, table, base = defaultScene) {
  const layerData = tableChartData(p, table)
  if (!layerData || (!layerData.labels.length && !layerData.values.length && !layerData.series?.length)) return null
  // Multi-series time data always draws lines (the renderer that supports it).
  const type = layerData.series?.length ? 'line_chart'
    : chartTypeFromPrompt(p) || (p.includes('bar') ? 'bar_chart' : p.includes('line') ? 'line_chart' : layerData.labels.length > 8 ? 'line_chart' : 'bar_chart')
  const orientation = /horizontal/.test(p) && (type === 'bar_chart' || type === 'histogram') ? 'horizontal' : (/vertical/.test(p) ? 'vertical' : undefined)
  const variant = type === 'pie_chart' && /donut|doughnut/.test(p) ? 'donut' : undefined
  const uniform = !/positive|negative|by categor|per categor|each categor/.test(p)
    ? parseTargetedColor(p, ['bars?', 'chart', 'graph', 'line', 'columns?', 'data'])
    : null
  return {
    id: nid('layer'), name: `${layerData.valueCol}${layerData.filteredBy ? ` (${layerData.filteredBy})` : ''} by ${layerData.aggregatedBy || layerData.labelCol}`, type,
    ...(orientation ? { orientation } : {}),
    ...titleFlags(p),
    startFrame: 0, endFrame: base.durationInFrames,        data: { ...layerData, ...lineage(p, table), ...parseDrawMode(p), ...parseSpeed(p), ...parseAxisFormat(p), ...(variant ? { variant } : {}), ...(uniform ? { pointColors: layerData.values.map(() => uniform), legend: [] } : (!layerData.aggregatedBy ? (colorizeTable(p, table, layerData) || {}) : {})) },
        keyframes: [
          { frame: 0, properties: { scale: 1, opacity: 0 } },
          { frame: 40, properties: { scale: 1, opacity: 1 }, easing: 'easeOutExpo' },
        ],
  }
}

// Stacked bars: one bar per group, split into per-category segments.
// "stacked bar", "stack by topping", "stacked by region" all trigger it;
// "unstack" / "clustered" asks for plain grouped bars again.
export function wantsStacked(p) {
  return /\bstack(?:ed|s|ing)?\b/.test(String(p || '').toLowerCase())
}
export function wantsUnstacked(p) {
  return /\bunstack(?:ed|ing|s)?\b|\bclustered\b/.test(String(p || '').toLowerCase())
}

const STACK_PALETTE = ['#4da3ff', '#3ddc84', '#ffcf40', '#b388ff', '#ff9f43', '#ff6b6b', '#4dd0e1', '#ff7eb6']
const MAX_STACK_GROUPS = 12, MAX_STACK_SERIES = 7

// Two-dimensional grouping: labels = primary groups, series = the split.
// ("sales by vessel stacked by topping", "count by region split by cup
// vs cone"). Same metric/count/exclusion/sort machinery as the flat path.
export function buildStackedData(p, table, opts = {}) {
  const { rows, filterName, mentions, empty } = filterRowsByMentions(p, table)
  if (empty) return null
  const round2 = (v) => Math.round(v * 100) / 100
  const excluded = parseExclusions(p, table)
  const countryCol = table.columns.find((c) => /country/i.test(c))
  const catCols = (extraOK) => table.columns.filter((c) => c !== countryCol && !excluded.has(c) && !isNumericColumn(rows, c))
  // Primary groups: axis hint > "by X" > bare mention > value-implied >
  // category default > country fallback.
  // A stack clause ("stacked by topping", "stack it by region", "stack
  // the bars by quarter") always names the SPLIT — never the groups.
  const STACK_CLAUSE = '(?:stack(?:ed|s|ing)?|split)(?:\\s+(?:it|them|these|those|the\\s+\\w+(?:\\s+\\w+)?|bars?|columns?))?\\s+(?:by|per|on|with|across|into)'
  // The placeholder keeps "by Y" visible to the group parser: without it
  // a greedy strip eats "stacked by X with count by Y" whole, the group
  // falls back to a bare mention, and the axes transpose (X becomes the
  // groups even though it was named as the split).
  const stripStack = (s) => String(s).replace(new RegExp(`${STACK_CLAUSE}\\s+[^.,;]+`, 'gi'), ' STACKED ')
  let groupCol = parseAxisHint(p, table)
  if (groupCol && (groupCol === countryCol || excluded.has(groupCol))) groupCol = null
  if (!groupCol) {
    const gm = stripStack(p).match(/\bby\s+([a-z][a-z &]*?)(?:\s+reference|\s+sheet|\s+data|\s+for\s|\s+based|\s+from\s|,|\s+total|\s+amount|$)/)
    if (gm) groupCol = matchColumn(table, groupHead(gm[1])) || null
  }
  if (!groupCol) {      // Match against prose with stack clauses (and tables) stripped, so a
      // "stacked by topping" split never doubles as the group axis.
      const pNoTable = stripStack(stripTableLines(p))
    groupCol = catCols().find((c) =>
      colTokens(c).some((t) => t.length >= 5 && new RegExp(`\\b${t}s?\\b`).test(pNoTable))
    ) || null
  }
  if (!groupCol && mentions.length >= 2 && !parseMarkdownTable(p) && !parseDelimitedTable(p)) {
    const byCol = new Map()
    for (const m of mentions) byCol.set(m.col, (byCol.get(m.col) || 0) + 1)
    const top = [...byCol.entries()].sort((a, b) => b[1] - a[1])[0]
    if (top && top[1] >= 2 && !excluded.has(top[0])) groupCol = top[0]
  }
  if (!groupCol && /\bcategor/.test(p)) groupCol = table.columns.find((c) => /categor/i.test(c)) || null
  if (!groupCol && countryCol && /countr(y|ies)/.test(p)) groupCol = countryCol
  // Caller-supplied default (the revise path passes the layer's existing
  // grouping) fills in only when the prose named no group of its own.
  if (!groupCol && opts.groupCol && table.columns.includes(opts.groupCol) && !excluded.has(opts.groupCol)) groupCol = opts.groupCol
  if (groupCol && excluded.has(groupCol)) return null
  // The split: explicit "stacked/split by X" wins, else the best other
  // categorical column (a few distinct values reads as a series).
  let stackCol = null
  const sm = p.match(new RegExp(`${STACK_CLAUSE}\\s+([^.,;\\n()]+)`, 'i'))
  // The split capture is greedy ("vessel with count by state") — clip it
  // at continuation words so only the column name reaches the matcher.
  if (sm) stackCol = matchColumn(table, sm[1].split(/\s+(?:with|and|while|for|by|per|versus|vs\.?|counts?|show\w*|over|across|split|group\w*)\b/i)[0]) || null
  if (!stackCol || stackCol === groupCol || excluded.has(stackCol)) {
    const cands = catCols().filter((c) => c !== groupCol)
    stackCol = cands.find((c) => {
      const n = new Set(rows.map((r) => String(r[c] ?? '').trim()).filter(Boolean)).size
      return n >= 2 && n <= MAX_STACK_SERIES
    }) || cands[0] || null
  }
  // Only the split was named: group by the richest other column (most
  // distinct values), so "stack the bars by quarter" still builds.
  if (!groupCol && stackCol) {
    groupCol = catCols().filter((c) => c !== stackCol)
      .map((c) => [c, new Set(rows.map((r) => String(r[c] ?? '').trim()).filter(Boolean)).size])
      .filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0]?.[0] || null
  }
  if (!groupCol || excluded.has(groupCol)) return null
  if (!stackCol || stackCol === groupCol) return null
  // Explicit preservation (plain regroups on an existing stack keep their
  // split instead of re-deriving — and possibly swapping — it).
  if (opts.stackCol && table.columns.includes(opts.stackCol) && opts.stackCol !== groupCol && !excluded.has(opts.stackCol)) stackCol = opts.stackCol
  // Metric: same rules as the flat path (named metric > default > count).
  const usableNumeric = table.columns.filter((c) => !excluded.has(c) && isNumericColumn(table.rows, c)
    && new Set(table.rows.map((r) => String(r[c] ?? '').trim())).size > 1)
  const { valueCol: namedMetric, agg } = parseMetric(p, usableNumeric)
  let valueCol = namedMetric
    || (usableNumeric.includes(tableToLayerData(table)?.valueCol) ? tableToLayerData(table).valueCol : null)
    || usableNumeric.find((c) => /total|revenue|sales|profit|quantity|amount|value|price|cost/.test(c.toLowerCase()))
    || usableNumeric[0]
    || null
  if (valueCol && (valueCol === groupCol || valueCol === stackCol)) {
    valueCol = usableNumeric.find((c) => c !== groupCol && c !== stackCol) || null
  }
  const doCount = !valueCol || (wantsCount(p) && !namedMetric)
  // Matrix: groups x stacks, sorted by group total, capped for readability.
  const groups = new Map()
  for (const r of rows) {
    const g = String(r[groupCol] ?? '').trim() || 'Unknown'
    const s = String(r[stackCol] ?? '').trim() || 'Other'
    if (!groups.has(g)) groups.set(g, new Map())
    const cell = groups.get(g)
    if (doCount) { cell.set(s, (cell.get(s) || 0) + 1); continue }
    const e = cell.get(s) || { sum: 0, n: 0 }
    e.sum += cleanNumber(r[valueCol]) ?? 0; e.n += 1; cell.set(s, e)
  }
  const totals = [...groups.entries()].map(([g, cell]) => {
    let t = 0
    for (const v of cell.values()) t += doCount ? v : v.sum
    return [g, t]
  })
  const sort = parseSort(p)
  totals.sort((a, b) => sort.dir === 'asc' ? a[1] - b[1] : b[1] - a[1])
  const groupOrder = totals.slice(0, sort.n ?? MAX_STACK_GROUPS).map((e) => e[0])
  if (!groupOrder.length) return null
  const stackTotals = new Map()
  for (const g of groupOrder) {
    for (const [s, v] of groups.get(g).entries()) {
      stackTotals.set(s, (stackTotals.get(s) || 0) + (doCount ? v : (agg === 'mean' ? v.sum / Math.max(1, v.n) : v.sum)))
    }
  }
  const stackOrder = [...stackTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_STACK_SERIES).map((e) => e[0])
  if (!stackOrder.length) return null
  const series = stackOrder.map((s, si) => ({
    label: s,
    values: groupOrder.map((g) => {
      const v = groups.get(g).get(s)
      if (v == null) return 0
      return round2(doCount ? v : (agg === 'mean' ? v.sum / Math.max(1, v.n) : v.sum))
    }),
    color: STACK_PALETTE[si % STACK_PALETTE.length],
  }))
  return {
    labels: groupOrder,
    series,
    legend: series.map((s) => ({ label: s.label, color: s.color })),
    aggregatedBy: groupCol, stackBy: stackCol,
    aggregation: doCount ? 'count' : agg,
    valueCol: doCount ? 'Count' : valueCol,
    ...(filterName ? { filteredBy: filterName } : {}),
    rowCount: table.rows.length,
    rows: table.rows.slice(0, 500).map((r) => table.columns.map((c) => String(r[c] ?? ''))),
    columns: table.columns,
  }
}

// Which session table can rebuild this layer? Id first (survives renames),
// source name second, and nothing when only the stale embed remains.
export function resolveRefreshTable(layer, datasets) {
  const d = layer?.data || {}
  const list = datasets || []
  return list.find((t) => d.datasetId && t.id === d.datasetId)
    || list.find((t) => d.source && t.name === d.source)
    || null
}
// Rebuild a chart layer's data from a (possibly replaced) table using the
// stored build prose — same heuristics as generation, so grouping, metric,
// filters, top-N and stacking come out the same way on new rows. Styling
// (per-point colors realigned by label, reveal/stagger/variant) and all
// keyframes survive; returns null when the layer was never builder-made or
// the rebuild produces nothing plottable.
export function refreshLayerData(layer, table) {
  const d = layer?.data || {}
  const bp = typeof d.buildPrompt === 'string' && d.buildPrompt.trim() ? d.buildPrompt : null
  if (!bp || !table || !Array.isArray(table.columns)) return null
  // Only stacked bars (stackBy set) rebuild through the stacked path —
  // line-chart series also ride on data.series and rebuild flat.
  const stacked = !!d.stackBy && Array.isArray(d.series) && d.series.length > 0
  const fresh = stacked
    ? buildStackedData(bp, table, { groupCol: d.aggregatedBy, stackCol: d.stackBy })
    : tableChartData(bp, table)
  if (!fresh || !Array.isArray(fresh.labels) || !fresh.labels.length) return null
  const colorByLabel = new Map()
  ;(d.labels || []).forEach((lb, i) => { if (d.pointColors?.[i]) colorByLabel.set(String(lb), d.pointColors[i]) })
  const pointColors = fresh.labels.map((lb) => colorByLabel.get(String(lb)))
  const legendByLabel = new Map((d.legend || []).map((it) => [String(it.label), it.color]))
  const series = fresh.series?.map((s) => {
    const old = (d.series || []).find((o) => o.label === s.label)
    return old?.color ? { ...s, color: old.color } : s
  })
  return {
    ...fresh,
    ...(series ? { series } : {}),
    ...(pointColors.some(Boolean) ? { pointColors } : {}),
    legend: Array.isArray(d.legend) && d.legend.length === 0
      ? []
      : (fresh.legend || []).map((it) => (legendByLabel.has(String(it.label))
        ? { label: it.label, color: legendByLabel.get(String(it.label)) } : it)),
    ...(d.reveal !== undefined ? { reveal: d.reveal } : {}),
    ...(d.stagger !== undefined ? { stagger: d.stagger } : {}),
    ...(d.drawMode ? { drawMode: d.drawMode } : {}),
    ...(d.variant !== undefined ? { variant: d.variant } : {}),
    ...lineage(bp, table),
  }
}

// Full layer twin of buildTableChartLayer for the stacked shape: type stays
// bar_chart, data carries series instead of values.
export function buildStackedLayer(p, table, base = defaultScene, opts = {}) {
  const stacked = buildStackedData(p, table, opts)
  if (!stacked || !stacked.labels.length) return null
  const orientation = /horizontal/.test(p) ? 'horizontal' : (/vertical/.test(p) ? 'vertical' : undefined)
  return {
    id: nid('layer'), name: `${stacked.valueCol} by ${stacked.aggregatedBy} (stacked: ${stacked.stackBy})`, type: 'bar_chart',
    ...(orientation ? { orientation } : {}),
    ...titleFlags(p),
    startFrame: 0, endFrame: base.durationInFrames,
    data: { ...stacked, ...lineage(p, table), ...parseSpeed(p) },
    keyframes: [
      { frame: 0, properties: { scale: 1, opacity: 0 } },
      { frame: 40, properties: { scale: 1, opacity: 1 }, easing: 'easeOutExpo' },
    ],
  }
}

// Engine/LLM scenes often come back generic ("Layer 1") or with chart layers
// that carry no data. Repair before render: fill missing chart data from the
// prompt's table and append a chart layer when the prompt asks for one.
// Returns { scene, repaired } — repaired lists what was fixed for the log.
const DATA_CHART_TYPES = ['bar_chart', 'line_chart', 'pie_chart', 'area_chart', 'scatter_chart', 'histogram', 'waterfall', 'funnel_chart', 'radar_chart', 'surface_plot']
export function isDataChart(t) { return DATA_CHART_TYPES.includes(t) }

export function repairEngineScene(scene, prompt, datasets = [], images = []) {
  const repaired = []
  if (!scene || !Array.isArray(scene.layers)) return { scene, repaired }
  const p = prompt.toLowerCase()
  const out = { ...scene, layers: scene.layers.map((l) => ({ ...l })) }
  const table = findPromptTable(prompt, datasets)
  // A layer is only usable when every plotted number is finite: an LLM
  // that hand-transcribes a table can emit numeric strings (fine — the
  // renderers coerce) but also blanks/words, which poison Math.max into
  // NaN and blank the whole chart. Non-finite data rebuilds from the table.
  const finiteArr = (a) => Array.isArray(a) && a.length > 0
    && a.every((v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)))
  const usable = (l) => Array.isArray(l?.data?.labels) && l.data.labels.length > 0
    && ((Array.isArray(l?.data?.values) && l.data.values.length === l.data.labels.length && finiteArr(l.data.values))
      || (Array.isArray(l?.data?.series) && l.data.series.length > 0
        && l.data.series.every((s) => Array.isArray(s.values) && s.values.length === l.data.labels.length && finiteArr(s.values))))
  if (table) {
    const layerData = tableChartData(p, table)
    if (layerData) {
      for (const l of out.layers) {
        if (isDataChart(l.type) && !usable(l)) {
          l.data = { ...layerData, ...lineage(p, table), ...(colorizeTable(p, table, layerData) || {}) }
          if (!l.name || /^layer\s*\d+$/i.test(l.name)) l.name = `${layerData.valueCol}${layerData.filteredBy ? ` (${layerData.filteredBy})` : ''} by ${layerData.aggregatedBy || layerData.labelCol}`
          repaired.push(`filled ${l.name} with ${layerData.labels.length} rows`)
        }
      }
      if (wantsChart(prompt) && !out.layers.some((l) => isDataChart(l.type) && usable(l))) {
        const built = wantsStacked(p)
          ? (buildStackedLayer(p, table, out) || buildTableChartLayer(p, table, out))
          : buildTableChartLayer(p, table, out)
        if (built) {
          out.layers.push(built)
          repaired.push(`added ${built.name} (${built.type})`)
        }
      }
    }
  }
  if (wantsMap(prompt)) {
    const table = findPromptTable(prompt, datasets)
    if (table && !out.layers.some((l) => l.type === 'map_bubbles' && Array.isArray(l.data?.bubbles) && l.data.bubbles.length)) {
      const built = buildMapLayer(p, table, out)
      if (built) {
        out.layers.push(built)
        repaired.push(`added ${built.name} (${built.data.bubbles.length} countries)`)
      }
    }
  }
  // Engine image layers carry an imageName (dataURLs are too big for model
  // context). Resolve to the attached file the user actually uploaded.
  for (const l of out.layers) {
    if ((l.type === 'image_layer' || l.type === 'image') && !l.assetUrl) {
      const nm = String(l.imageName || l.name || '').toLowerCase()
      const hit = (images || []).find((m) => String(m.name || '').toLowerCase() === nm)
        || (images || []).find((m) => nm && String(m.name || '').toLowerCase().replace(/\.[a-z0-9]+$/, '') === nm)
        || (images || [])[0]
      if (hit?.dataUrl) {
        l.type = 'image_layer'
        l.assetUrl = hit.dataUrl
        l.data = { ...(l.data || {}), imageName: hit.name, width: Number(l.data?.width) || 480 }
        repaired.push(`linked image ${hit.name}`)
      }
    }
  }
  return { scene: out, repaired }
}

const BG_COLORS = { black: '#000000', white: '#ffffff', dark: '#10141d', navy: '#0a1931', blue: '#1e3a8a', red: '#7f1d1d', green: '#14532d', purple: '#4c1d95', gray: '#1f2937', grey: '#1f2937' }
export const FONT_CHOICES = ['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Impact', 'Comic Sans MS', 'Trebuchet MS']
export function parseBackground(prompt) {
  const hex = prompt.match(/#[0-9a-fA-F]{6}\b/)
  if (hex) return hex[0]
  let m = prompt.match(/background(?:\s+(?:is|to|color))?\s*:?\s*(black|white|dark|navy|blue|red|green|purple|gr[ae]y)/i)
    || prompt.match(/\b(black|white|dark|navy|blue|red|green|purple|gr[ae]y)\s+background\b/i)
  return m ? BG_COLORS[m[1].toLowerCase()] : null
}
export function parseFontFamily(prompt) {
  const m = prompt.match(new RegExp(`\\bin\\s+(${FONT_CHOICES.map((f) => f.replace(/ /g, '\\s+')).join('|')}|monospace|serif|sans-serif)\\b`, 'i'))
  if (!m) return null
  const lower = m[1].toLowerCase()
  if (lower === 'monospace') return 'Courier New'
  if (lower === 'serif') return 'Georgia'
  if (lower === 'sans-serif') return 'Arial'
  return FONT_CHOICES.find((f) => f.toLowerCase() === lower) || m[1]
}

// Explicit single colors ("red title", "paint the bars blue", "#ff0000 chart").
// Vivid variants (not the dark background palette) so text/charts read on video.
const COLOR_WORDS = {
  red: '#ff6b6b', green: '#3ddc84', blue: '#4da3ff', yellow: '#ffcf40',
  orange: '#ff9f43', pink: '#ff7eb6', purple: '#b388ff', cyan: '#4dd0e1',
  teal: '#2dd4bf', lime: '#a3e635', magenta: '#e879f9', indigo: '#818cf8',
  white: '#ffffff', black: '#111111', gray: '#9aa3b2', grey: '#9aa3b2',
}
const COLOR_RE = '#[0-9a-fA-F]{6}\\b|red|green|blue|yellow|orange|pink|purple|cyan|teal|lime|magenta|indigo|white|black|gr[ae]y'
export function parseColorWord(prompt) {
  const hex = prompt.match(/#[0-9a-fA-F]{6}\b/)
  if (hex) return hex[0]
  const m = prompt.match(/\b(red|green|blue|yellow|orange|pink|purple|cyan|teal|lime|magenta|indigo|white|black|gr[ae]y)\b/i)
  return m ? COLOR_WORDS[m[1].toLowerCase()] : null
}
// Color tied to a layer noun ("red title", "title in blue", "make the bars
// green") — avoids painting layers from stray color mentions in data tables.
export function parseTargetedColor(prompt, nouns) {
  const n = nouns.join('|')
  const tied = new RegExp(`(?:make|paint|colou?r|set|change|turn|dye)[^.]{0,40}?\\b(${COLOR_RE})\\b|\\b(${COLOR_RE})\\s+(?:${n})\\b|(?:${n})[^.]{0,30}?\\b(${COLOR_RE})\\b`, 'i')
  const m = prompt.match(tied)
  if (!m) return null
  const word = (m[1] || m[2] || m[3] || '').toLowerCase()
  if (/^#/.test(word)) return word
  return COLOR_WORDS[word] || null
}

// Attached images: matched by filename so prompts can place them by name
// ("add the logo", "logo slides in from the left", "use photo as background").
export function matchImages(prompt, images = []) {
  const p = String(prompt).toLowerCase()
  return (images || []).filter((img) => {
    const full = String(img.name || '').toLowerCase()
    const base = full.replace(/\.[a-z0-9]+$/, '')
    const cands = [full, base, base.replace(/[-_]+/g, ' ')]
    return cands.some((c) => c && c.length >= 2 && p.includes(c))
  })
}

function imageAnchor(img, pos, width) {
  const w = width, h = Math.round((width * (img.height || 1)) / Math.max(1, img.width || 1))
  const m = 60
  switch (pos) {
    case 'top-left': return { x: m, y: m, w, h }
    case 'top-right': return { x: 1280 - w - m, y: m, w, h }
    case 'bottom-left': return { x: m, y: 720 - h - m, w, h }
    case 'bottom-right': return { x: 1280 - w - m, y: 720 - h - m, w, h }
    default: return { x: Math.round((1280 - w) / 2), y: Math.round((720 - h) / 2) - 40, w, h }
  }
}

export function buildImageLayer(prompt, img, base = defaultScene) {
  const q = String(prompt).toLowerCase()
  const size = /\bsmall\b|tiny/.test(q) ? 320 : /\blarge\b|\bbig\b|\bhuge\b|full/.test(q) ? 760 : 480
  const pos = /top[- ]?left|upper[- ]?left/.test(q) ? 'top-left'
    : /top[- ]?right|upper[- ]?right/.test(q) ? 'top-right'
    : /bottom[- ]?left|lower[- ]?left/.test(q) ? 'bottom-left'
    : /bottom[- ]?right|lower[- ]?right/.test(q) ? 'bottom-right' : 'center'
  const a = imageAnchor(img, pos, Math.min(1100, size))
  const dir = /from (the )?left|slide.*left|enter.*left/.test(q) ? 'left'
    : /from (the )?right|slide.*right|enter.*right/.test(q) ? 'right'
    : /from (the )?top|slide.*top|\bdrop\b/.test(q) ? 'top'
    : /from (the )?bottom|slide.*bottom|\brise\b/.test(q) ? 'bottom' : null
  const zoom = /zoom/.test(q)
  const start = 30, end = Math.min(75, base.durationInFrames)
  let keyframes
  if (dir) {
    const from = dir === 'left' ? { x: -a.w - 40, y: a.y } : dir === 'right' ? { x: 1280 + 40, y: a.y }
      : dir === 'top' ? { x: a.x, y: -a.h - 40 } : { x: a.x, y: 720 + 40 }
    keyframes = [
      { frame: start, properties: { ...from, scale: 1, opacity: 1 } },
      { frame: end, properties: { x: a.x, y: a.y, scale: 1, opacity: 1 }, easing: 'easeInOutCubic' },
    ]
  } else if (zoom) {
    keyframes = [
      { frame: start, properties: { x: a.x, y: a.y, scale: 0, opacity: 1 } },
      { frame: end, properties: { x: a.x, y: a.y, scale: 1, opacity: 1 }, easing: 'easeInOutCubic' },
    ]
  } else {
    keyframes = [
      { frame: start, properties: { x: a.x, y: a.y, scale: 0.92, opacity: 0 } },
      { frame: Math.min(start + 30, end), properties: { x: a.x, y: a.y, scale: 1, opacity: 1 }, easing: 'easeOutExpo' },
    ]
  }
  return {
    id: nid('layer'), name: String(img.name || 'Image'), type: 'image_layer',
    assetUrl: img.dataUrl, startFrame: 0, endFrame: base.durationInFrames,
    data: { imageName: img.name, width: a.w },
    keyframes,
  }
}

export function ruleBasedScene(prompt, base = defaultScene, datasets = [], images = []) {
  const p = prompt.toLowerCase()
  const layers = []
  // title (quoted "X as a title" wins over a bare keyword match)
  const promptNoTable = stripTableLines(prompt)
  const titleMatch = prompt.match(/['"]([^'"]{1,80})['"]\s+as a (title|heading)/i) || prompt.match(/title\s+['"]([^'"]+)['"]/i) || prompt.match(/start with[^.]*?['"]([^'"]+)['"]/i)
  if ((p.includes('title') && !/(no|without|hide|remove)\b[^.]{0,16}\btitle\b/.test(p)) || titleMatch || p.includes('q3 review')) {
    const text = titleMatch ? titleMatch[1] : 'Q3 Review'
    const fontFamily = parseFontFamily(prompt)
    const titleColor = !/positive|negative|by categor|per categor|each categor/.test(p)
      ? parseTargetedColor(prompt, ['title', 'text', 'heading', 'font', 'caption', 'label'])
      : null
    const sizeWord = p.match(/\bhuge\b/) ? 120 : p.match(/\bbig\b|\blarge\b/) ? 96 : p.match(/\bsmall\b/) ? 48 : p.match(/\btiny\b/) ? 36 : null
    layers.push({
      id: nid('layer'), name: `${text} Title`, type: 'text', text,
      ...(fontFamily ? { fontFamily } : {}),
      ...(titleColor ? { color: titleColor } : {}),
      ...(sizeWord ? { fontSize: sizeWord } : {}),
      startFrame: 0, endFrame: 120,
      keyframes: [
        { frame: 0, properties: { opacity: 0, scale: 0.8 } },
        { frame: 30, properties: { opacity: 1, scale: 1 }, easing: 'easeOutExpo' },
        { frame: 100, properties: { opacity: 1, scale: 1 } },
        { frame: 120, properties: { opacity: 0, scale: 1 } },
      ],
    })
  }
  // bubble map (takes over from charts when the prompt asks for a map)
  let mapBuilt = null
  if (wantsMap(prompt)) {
    const table = findPromptTable(prompt, datasets)
    mapBuilt = table ? buildMapLayer(p, table, base) : null
    if (mapBuilt) {
      layers.push(mapBuilt)
    } else if (!table) {
      layers.push({
        id: nid('layer'), name: 'Map needs data', type: 'text', text: 'Attach a CSV with a Country column to build the map',
        startFrame: 0, endFrame: base.durationInFrames,
        keyframes: [
          { frame: 0, properties: { opacity: 0 } },
          { frame: 30, properties: { opacity: 1 } },
        ],
      })
    }
  }
  // chart from pasted table or attached files
  if (wantsChart(prompt) && !mapBuilt) {
    const table = findPromptTable(prompt, datasets)
    const built = table
      ? (wantsStacked(p) ? (buildStackedLayer(p, table, base) || buildTableChartLayer(p, table, base)) : buildTableChartLayer(p, table, base))
      : null
    if (built) {
      layers.push(built)
    } else if (!table) {
    let values = parseNumbers(prompt)
    if (!values.length) values = [120, 180, 250]
    if (values.length < 2) values = [values[0] * 0.4, values[0] * 0.7, values[0]]
    const labels = values.map((_, i) => `M${i + 1}`)
    if (/jul|aug|sep|2022|2023|q3/i.test(prompt)) {
      const l = ['July', 'Aug', 'Sep'].slice(0, values.length)
      while (l.length < values.length) l.push(`M${l.length + 1}`)
      labels.splice(0, labels.length, ...l)
    }
    const type = chartTypeFromPrompt(p) || (p.includes('line') ? 'line_chart' : 'bar_chart')
    const orientationFb = /horizontal/.test(p) && (type === 'bar_chart' || type === 'histogram') ? 'horizontal' : (/vertical/.test(p) ? 'vertical' : undefined)
    const variantFb = type === 'pie_chart' && /donut|doughnut/.test(p) ? 'donut' : undefined
    const uniformFb = !/positive|negative|by categor|per categor|each categor/.test(p)
      ? parseTargetedColor(p, ['bars?', 'chart', 'graph', 'line', 'columns?', 'data'])
      : null
    layers.push({
      id: nid('layer'), name: 'Data Chart', type,
      ...(orientationFb ? { orientation: orientationFb } : {}),
      ...titleFlags(p),
      startFrame: 0, endFrame: base.durationInFrames,
      data: { labels, values, ...parseSpeed(p), ...(variantFb ? { variant: variantFb } : {}), ...(uniformFb ? { pointColors: values.map(() => uniformFb) } : {}) },
      keyframes: [
        { frame: 0, properties: { scale: 1, opacity: 0 } },
        { frame: 30, properties: { scale: 1, opacity: 1 }, easing: 'easeOutExpo' },
      ],
    })
  }
  }
  // vector shapes
  // Shape keywords are matched outside pasted tables, so a product named
  // "Power Bank" inside the data does not summon a bank icon.
  const nt = promptNoTable.toLowerCase()
  const shapeFor = /\bbank\b/.test(nt) ? '/assets/bank.svg' : /\barrow\b/.test(nt) ? '/assets/arrow.svg' : /\bperson\b|\bpeople\b|\bcharacter\b/.test(nt) ? '/assets/person.svg' : null
  if (shapeFor) {
    const slide = nt.includes('slide') || nt.includes('from the left') || nt.includes('from left')
    const zoom = nt.includes('zoom')
    layers.push({
      id: nid('layer'), name: shapeFor.includes('bank') ? 'Bank Icon' : 'Vector Shape', type: 'vector_shape',
      assetUrl: shapeFor, startFrame: 30, endFrame: base.durationInFrames,
      keyframes: slide
        ? [
            { frame: 30, properties: { x: -200, y: 450, scale: 1, opacity: 1 } },
            { frame: 75, properties: { x: 500, y: 450, scale: 1.2, opacity: 1 }, easing: 'easeInOutCubic' },
          ]
        : zoom
        ? [
            { frame: 30, properties: { x: 640, y: 400, scale: 0, opacity: 1 } },
            { frame: 60, properties: { x: 640, y: 400, scale: 1.5, opacity: 1 }, easing: 'easeInOutCubic' },
          ]
        : [
            { frame: 30, properties: { x: 640, y: 400, scale: 0.5, opacity: 1 } },
            { frame: 60, properties: { x: 640, y: 400, scale: 1.2, opacity: 1 }, easing: 'easeInOutCubic' },
          ],
    })
  }
  // sprite walkthrough
  if (nt.includes('walk') || nt.includes('character') || nt.includes('sprite')) {
    layers.push({
      id: nid('layer'), name: 'Walking Character', type: 'sprite',
      startFrame: 0, endFrame: base.durationInFrames,
      data: { emoji: '🚶', fromX: -100, toX: 1200, y: 560 },
      keyframes: [
        { frame: 0, properties: { x: -100, y: 560, scale: 1, opacity: 1 } },
        { frame: base.durationInFrames, properties: { x: 1200, y: 560, scale: 1, opacity: 1 } },
      ],
    })
  }
  // attached images placed by name ("add the logo", "logo slides in from left")
  for (const img of matchImages(promptNoTable, images)) {
    if (!img?.dataUrl) continue
    if (layers.some((l) => l.type === 'image_layer' && l.data?.imageName === img.name)) continue
    layers.push(buildImageLayer(prompt, img, base))
  }
  if (!layers.length) {
    layers.push({
      id: nid('layer'), name: 'Prompt Text', type: 'text', text: prompt.slice(0, 60) || 'Untitled',
      startFrame: 0, endFrame: base.durationInFrames,
      keyframes: [
        { frame: 0, properties: { opacity: 0, y: 360 } },
        { frame: 30, properties: { opacity: 1, y: 300 }, easing: 'easeOutExpo' },
      ],
    })
  }
  const background = parseBackground(prompt) || base.background || '#10141d'
  const bgImg = /background/.test(p) ? matchImages(promptNoTable, images)[0] : null
  const bgOpPct = /background(?: image)?[^.]{0,30}?(\d{1,3})\s*%/.test(p) ? Number(p.match(/background(?: image)?[^.]{0,30}?(\d{1,3})\s*%/)[1]) : null
  const bgOp = bgImg?.dataUrl
    ? (bgOpPct != null ? Math.min(100, bgOpPct) / 100 : (/dim|faded?|washed|subtle|translucent|ghost|faint/.test(p) ? 0.35 : undefined))
    : undefined
  return { ...base, background, ...(bgImg?.dataUrl ? { backgroundImage: bgImg.dataUrl } : {}), ...(bgOp !== undefined ? { backgroundImageOpacity: bgOp } : {}), layers }
}

export function ruleBasedPatch(scene, prompt, datasets = [], images = []) {
  const p = prompt.toLowerCase()
  const patch = []
  const frameNums = [...prompt.matchAll(/frame\s+(\d+)/gi)].map(m => Number(m[1]))
  const targetFrame = frameNums.length ? frameNums[frameNums.length - 1] : null
  scene.layers.forEach((l, li) => {
    const isBank = /bank/i.test(l.name) || (l.assetUrl || '').includes('bank')
    const isTitle = l.type === 'text'
    if ((p.includes('bank') && isBank) || (!p.includes('bank') && (p.includes('slower') || p.includes('finish') || targetFrame))) {
      if (targetFrame != null && l.keyframes.length > 1) {
        patch.push({ op: 'replace', path: `/layers/${li}/keyframes/${l.keyframes.length - 1}/frame`, value: targetFrame })
        if (p.includes('slower') && l.keyframes.length > 1) {
          const mid = Math.round(targetFrame * 0.6)
          if (l.keyframes.length > 2) patch.push({ op: 'replace', path: `/layers/${li}/keyframes/1/frame`, value: mid })
        }
      }
    }
    if (isTitle && (p.includes('fade out') || p.includes('fade'))) {
      if (!l.keyframes.some(k => k.properties.opacity === 0 && k.frame > 30)) {
        patch.push({ op: 'add', path: `/layers/${li}/keyframes/${l.keyframes.length}`, value: { frame: 90, properties: { opacity: 0 } } })
      }
    }
  })
  // "don't zoom" / "no zoom" / "static" → pin scale to 1 so values animate
  // from 0 while the layer itself stays put (100% from the start).
  const noZoom = /(n't|not|never|without|stop|remove|disable)\b[^.]{0,40}\bzoom|\bno[ -]?zoom\b|\bstatic\b/i.test(prompt)
  if (noZoom) {
    const typeWords = {  bar_chart: ['bar', 'chart', 'graph', 'horizontal', 'vertical', 'stacked', 'stack', 'unstack', 'clustered'], line_chart: ['line', 'chart', 'graph'], pie_chart: ['pie', 'donut', 'chart'], area_chart: ['area', 'chart'], scatter_chart: ['scatter', 'chart'], histogram: ['histogram', 'chart'], waterfall: ['waterfall', 'chart'], funnel_chart: ['funnel', 'chart'], radar_chart: ['radar', 'spider', 'chart'], surface_plot: ['surface', '3d', 'chart'], map_bubbles: ['map', 'bubble', 'country', 'chart'], text: ['title', 'text'], vector_shape: ['icon', 'shape', 'bank', 'arrow', 'person'], sprite: ['character', 'sprite', 'walk'] }
    const mentioned = new Set()
    for (const [type, words] of Object.entries(typeWords)) {
      if (words.some((w) => new RegExp(`\\b${w}\\b`).test(p))) mentioned.add(type)
    }
    scene.layers.forEach((l, li) => {
      const named = l.name && p.includes(String(l.name).toLowerCase())
      const targeted = mentioned.size ? mentioned.has(l.type) : true
      if (!(named || targeted)) return
      l.keyframes.forEach((k, ki) => {
        if (k.properties && k.properties.scale !== undefined && k.properties.scale !== 1) {
          patch.push({ op: 'replace', path: `/layers/${li}/keyframes/${ki}/properties/scale`, value: 1 })
        }
      })
    })
  }
  // Staged per-point entrances: "each data point zoom in from blank",
  // "bars one by one", "staggered", "pop in", "cascade". Charts already
  // stagger points internally, so this stretches the reveal across more
  // frames and (for zoom/pop/bounce) starts the whole layer small.
  const pointEntrance =
    /(each|every|per)\b[^.]{0,40}\b(points?|bars?|slices?|bubbles?|columns?|items?|values?)|one by one|one-by-one|sequential(ly)?|stagger(ed)?|\bpop in\b|\bbounce|cascade|zoom in from|animate[^.]{0,40}from blank/.test(p)
  if (pointEntrance) {
    const dur = targetFrame || 120
    // An explicit no-zoom/static wins over the zoom part — stagger remains.
    const zoom = !noZoom && /zoom|pop|bounce|grow|scale/.test(p)
    scene.layers.forEach((l, li) => {
      if (!isDataChart(l.type) && l.type !== 'map_bubbles') return
      // A named layer narrows the target; otherwise all data-viz layers get
      // the entrance (the request can only mean the charts anyway).
      const namedHit = scene.layers.some((o) => o.name && p.includes(String(o.name).toLowerCase()))
      const named = l.name && p.includes(String(l.name).toLowerCase())
      if (namedHit && !named) return
      const start = l.keyframes[0]?.frame ?? 0
      const end = dur > start ? dur : start + 120
      patch.push({ op: 'replace', path: `/layers/${li}/keyframes/0`, value: { frame: start, properties: { opacity: 0, ...(zoom ? { scale: 0.6 } : { scale: 1 }) } } })
      patch.push({
        op: l.keyframes.length > 1 ? 'replace' : 'add',
        path: `/layers/${li}/keyframes/1`,
        value: { frame: end, properties: { opacity: 1, scale: 1 }, easing: zoom ? 'easeOutBack' : 'easeOutExpo' },
      })
      // The keyframe stretch above fades the whole layer, but per-point
      // separation comes from data.stagger — without it bars grow together
      // and a "stagger" request visibly does nothing. Wipe charts
      // (line/area/radar) are excluded: their stagger stretches the draw,
      // so a blind value would slow the wipe instead of separating points.
      const POINT_TYPES = ['bar_chart', 'pie_chart', 'scatter_chart', 'histogram', 'waterfall', 'funnel_chart', 'surface_plot', 'map_bubbles']
      if (POINT_TYPES.includes(l.type)) {
        patch.push({ op: 'replace', path: `/layers/${li}/data/stagger`, value: 8 })
        if (l.type === 'bar_chart' && l.data?.reveal == null) {
          // Bars default to growing over the whole span, which drowns any
          // stagger — size each bar's reveal so they cascade one by one.
          const nPts = l.data?.series?.[0]?.values?.length || l.data?.values?.length || l.data?.labels?.length || 1
          const span = Math.max(1, end - start)
          patch.push({ op: 'replace', path: `/layers/${li}/data/reveal`, value: Math.max(12, Math.min(60, Math.round(span / Math.max(1, nPts)))) })
        }
      }
    })
  }
  // Line draw style: "connect the dots", "dots pop first then connect",
  // "no wipe/slide reveal" → dots-first draw mode; "wipe/sweep reveal"
  // restores the left-to-right wipe. Targets line charts (named or all).
  const connectAsk = /connect( the| those| these)? (dots|points|them|lines?)|\bconnect the dots\b|(dots?|points?).{0,40}then.{0,20}connect|connect.{0,20}(dots?|points?|lines?)|(dots?|points?) first|draw the line between/.test(p)
    || (/no (wipe|slide|sweep)/.test(p) && /line|chart|graph/.test(p))
  const wipeAsk = /\bwipe\b|\bsweep\b|slide reveal|sweep reveal/.test(p)
  if (connectAsk || wipeAsk) {
    const namedHit = scene.layers.some((o) => o.name && p.includes(String(o.name).toLowerCase()))
    scene.layers.forEach((l, li) => {
      if (l.type !== 'line_chart') return
      const named = l.name && p.includes(String(l.name).toLowerCase())
      if (namedHit && !named) return
      if (connectAsk && l.data?.drawMode !== 'connect') {
        patch.push({ op: 'replace', path: `/layers/${li}/data/drawMode`, value: 'connect' })
        // Dots-then-connect needs sequential pops: default a gentle
        // stagger unless the layer already paces itself.
        if (l.data?.stagger == null) patch.push({ op: 'replace', path: `/layers/${li}/data/stagger`, value: 4 })
      } else if (!connectAsk && wipeAsk && l.data?.drawMode) {
        patch.push({ op: 'remove', path: `/layers/${li}/data/drawMode` })
      }
    })
  }
  // Motion feel: "ease in / accelerate / slow start" → easeInCubic (slow
  // start, fast arrival); "ease out / gentle landing / decelerate / slow
  // finish" → easeOutCubic (fast start, gentle landing); "regular / steady
  // / linear" → linear. Sets every arrival keyframe on the targeted layer
  // (or all layers when no layer is named).
  const outFeel = /ease.?out|decelerat|gentle|soft landing|slow finish|slow down (at|into|for)|fast start|accelerat[^.]{0,30}\bout\b/.test(p)
  const inFeel = /ease.?in\b|slow start|speed up|accelerat|fast arrival|arrive fast|quicker (at|into|arrival)/.test(p)
  const regularFeel = /regular|steady|constant speed|\blinear\b|even speed|no acceleration/.test(p)
  const wantEase = outFeel ? 'easeOutCubic' : inFeel ? 'easeInCubic' : regularFeel ? 'linear' : null
  if (wantEase) {
    const namedHit = scene.layers.some((o) => o.name && p.includes(String(o.name).toLowerCase()))
    scene.layers.forEach((l, li) => {
      const named = l.name && p.includes(String(l.name).toLowerCase())
      if (namedHit && !named) return
      l.keyframes.forEach((k, ki) => {
        if (ki === 0) return
        if (k.easing !== wantEase) patch.push({ op: 'replace', path: `/layers/${li}/keyframes/${ki}/easing`, value: wantEase })
      })
    })
  }
  // background color: "make the background navy" / "black background"
  const bg = parseBackground(prompt)
  if (bg && /background/.test(p)) {
    patch.push({ op: 'replace', path: '/background', value: bg })
  }
  // layer color: "make the title red" / "paint the bars blue" / sign coloring
  const signColor = /positive|negative/.test(p) && /green|red|colou?r/.test(p)
  const layerColor = !signColor && !/background/.test(p)
    ? parseTargetedColor(prompt, ['title', 'text', 'heading', 'font', 'caption', 'label', 'bars?', 'chart', 'graph', 'line', 'columns?', 'data'])
    : null
  if (signColor || layerColor) {
    const wantsText = /title|text|heading|font|caption|label/.test(p)
    const wantsChart = /bars?|chart|graph|line|columns?|data|pie|donut|area|scatter|histogram|waterfall|funnel|radar|spider|surface|map|bubble/.test(p)
    scene.layers.forEach((l, li) => {
      const named = l.name && p.includes(String(l.name).toLowerCase())
      const targeted = named || (l.type === 'text' && (wantsText || !wantsChart)) || ((isDataChart(l.type) || l.type === 'map_bubbles') && (wantsChart || !wantsText))
      if (!targeted) return
      if (l.type === 'text' && layerColor) {
        patch.push({ op: 'replace', path: `/layers/${li}/color`, value: layerColor })
      } else if ((isDataChart(l.type) || l.type === 'map_bubbles') && Array.isArray(l.data?.values) && l.data.values.length) {
        if (signColor && Math.min(...l.data.values) < 0 && Math.max(...l.data.values) > 0) {
          patch.push({ op: 'replace', path: `/layers/${li}/data/pointColors`, value: l.data.values.map((v) => (v >= 0 ? '#3ddc84' : '#ff6b6b')) })
          patch.push({ op: 'replace', path: `/layers/${li}/data/legend`, value: [{ label: 'Positive', color: '#3ddc84' }, { label: 'Negative', color: '#ff6b6b' }] })
        } else if (layerColor) {
          patch.push({ op: 'replace', path: `/layers/${li}/data/pointColors`, value: l.data.values.map(() => layerColor) })
          patch.push({ op: 'replace', path: `/layers/${li}/data/legend`, value: [] })
        }
      }
    })
  }
  // text font / size: "make the title font Arial" / "bigger text"
  const wantFont = parseFontFamily(prompt)
  const bigger = /\bbigger\b|\blarger\b|increase.{0,20}(font|text|size)/.test(p)
  const smaller = /\bsmaller\b|decrease.{0,20}(font|text|size)|shrink/.test(p)
  if (wantFont || bigger || smaller) {
    const hasTextCtx = /title|text|heading|font|caption/.test(p)
    scene.layers.forEach((l, li) => {
      if (l.type !== 'text') return
      const named = l.text && p.includes(l.text.toLowerCase())
      if (!named && !hasTextCtx && !wantFont) return
      if (wantFont) patch.push({ op: 'replace', path: `/layers/${li}/fontFamily`, value: wantFont })
      if (bigger || smaller) {
        const cur = Number(l.fontSize) || 84
        const next = Math.min(200, Math.max(12, cur + (bigger ? 24 : -24)))
        patch.push({ op: 'replace', path: `/layers/${li}/fontSize`, value: next })
      }
    })
  }
  // titles & legends: "hide the title" / "remove legend" / "show the legend"
  const noTitle = /(no|without|hide|remove|off)\b[^.]{0,24}\btitle\b/.test(p)
  const showTitle = /\bshow\b[^.]{0,24}\btitle\b/.test(p) && !noTitle
  const noLegend = /(no|without|hide|remove|off)\b[^.]{0,24}\blegend\b/.test(p)
  const showLegend = /\bshow\b[^.]{0,24}\blegend\b/.test(p) && !noLegend
  if (noTitle || showTitle || noLegend || showLegend) {
    scene.layers.forEach((l, li) => {
      if (!isDataChart(l.type) && l.type !== 'map_bubbles') return
      const named = l.name && p.includes(String(l.name).toLowerCase())
      if (!named && !/(title|legend|chart|graph|map|bars?|pie|histogram)/.test(p)) return
      if (noTitle) patch.push({ op: 'replace', path: `/layers/${li}/showTitle`, value: false })
      if (showTitle) patch.push({ op: 'replace', path: `/layers/${li}/showTitle`, value: true })
      if (noLegend) patch.push({ op: 'replace', path: `/layers/${li}/showLegend`, value: false })
      if (showLegend) patch.push({ op: 'replace', path: `/layers/${li}/showLegend`, value: true })
    })
  }
  // Animation speed: "faster/quicker", "slower", "over 3 seconds",
  // "in 90 frames", "all at once" (stagger 0), "more/less stagger".
  const secsAsked = (() => { const m = p.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/); return m ? Number(m[1]) : null })()
  const framesAsked = (() => { const m = p.match(/(\d+)\s*frames?\b/); return m ? Number(m[1]) : null })()
  const faster = /\bfaster\b|\bquicker\b|speed up|hurry/.test(p)
  const slower = /\bslower\b|slow down|more gradual|drag out/.test(p)
  const atOnce = /all at once|simultaneous(ly)?|all together/.test(p)
  const moreStag = /more stagger|staggered more/.test(p)
  const lessStag = /less stagger|tighter stagger/.test(p)
  if (secsAsked != null || framesAsked != null || faster || slower || atOnce || moreStag || lessStag) {
    scene.layers.forEach((l, li) => {
      if ((!isDataChart(l.type) && l.type !== 'map_bubbles') || !l.data) return
      const named = l.name && p.includes(String(l.name).toLowerCase())
      const namedHit = scene.layers.some((o) => o.name && p.includes(String(o.name).toLowerCase()))
      if (namedHit && !named) return
      if (!named && !/(reveal|animat|stagger|speed|faster|slower|chart|graph|bar|line|pie|scatter|histogram|waterfall|funnel|radar|surface|map|bubble|point|data|bars|second|frame|once|simultaneous|together)/.test(p)) return
      const t = effectiveTiming(l)
      let reveal = t.dur, stagger = t.stagger
      if (secsAsked != null) reveal = Math.round(secsAsked * (scene.fps || 30))
      else if (framesAsked != null) reveal = framesAsked
      else if (faster) { reveal = Math.max(8, Math.round(reveal / 2)); stagger = Math.max(0, stagger / 2) }
      else if (slower) { reveal = Math.min(600, reveal * 2); stagger = Math.min(60, stagger * 2 || 2) }
      if (atOnce) stagger = 0
      else if (moreStag) stagger = Math.min(60, (stagger || 2) * 2)
      else if (lessStag) stagger = Math.max(0, stagger / 2)
      patch.push({ op: 'replace', path: `/layers/${li}/data/reveal`, value: Math.max(4, Math.min(600, Math.round(reveal))) })
      patch.push({ op: 'replace', path: `/layers/${li}/data/stagger`, value: Math.max(0, Math.min(60, Math.round(stagger * 2) / 2)) })
    })
  }
  // Text/image entrances: "slide in from the left", "enter from the top",
  // "title from off screen". Start keyframe goes off-canvas, end rests.
  const enterDir = /from (the )?left|slide[^.]{0,20}left|enter[^.]{0,20}left/.test(p) ? 'left'
    : /from (the )?right|slide[^.]{0,20}right|enter[^.]{0,20}right/.test(p) ? 'right'
    : /from (the )?(top|above)|slide[^.]{0,20}top|enter[^.]{0,20}top|drop in|drop from/.test(p) ? 'top'
    : /from (the )?bottom|slide[^.]{0,20}bottom|enter[^.]{0,20}bottom|rise from|rise up/.test(p) ? 'bottom' : null
  if (enterDir) {
    const off = enterDir === 'left' ? { x: -1400 } : enterDir === 'right' ? { x: 1400 } : enterDir === 'top' ? { y: -900 } : { y: 900 }
    const textCtx = /title|text|heading|caption|label/.test(p)
    const imgCtx = /image|picture|photo|logo|icon|character|sprite|bank|arrow|person/.test(p)
    scene.layers.forEach((l, li) => {
      if (!['text', 'image_layer', 'vector_shape', 'sprite'].includes(l.type)) return
      const named = (l.name && p.includes(String(l.name).toLowerCase())) || (l.text && p.includes(String(l.text).toLowerCase()))
      const targeted = named || (textCtx === imgCtx ? true : (l.type === 'text' ? textCtx : imgCtx))
      if (!targeted) return
      const last = l.keyframes[l.keyframes.length - 1]
      const rest = { x: last.properties.x ?? 0, y: last.properties.y ?? 0, scale: last.properties.scale ?? 1, opacity: last.properties.opacity ?? 1 }
      const from = { x: off.x ?? rest.x, y: off.y ?? rest.y }
      patch.push({ op: 'replace', path: `/layers/${li}/keyframes/0`, value: { frame: l.keyframes[0].frame, properties: { ...from, scale: rest.scale, opacity: 0 } } })
      const end = l.keyframes.length > 1 ? l.keyframes[l.keyframes.length - 1].frame : Math.min(l.keyframes[0].frame + 45, l.endFrame)
      patch.push({ op: l.keyframes.length > 1 ? 'replace' : 'add', path: `/layers/${li}/keyframes/${l.keyframes.length > 1 ? l.keyframes.length - 1 : 1}`, value: { frame: end, properties: { ...rest, opacity: 1 }, easing: 'easeOutExpo' } })
    })
  }
  // Background image opacity: "background image 50%", "dim the background".
  if (/background/.test(p)) {
    const pct = (() => { const m = p.match(/background(?: image)?[^.]{0,30}?(\d{1,3})\s*%/); return m ? Math.min(100, Number(m[1])) : null })()
    if (pct != null) patch.push({ op: 'replace', path: '/backgroundImageOpacity', value: pct / 100 })
    else if (/dim|faded?|wash|subtle|translucent|ghost|faint/.test(p)) patch.push({ op: 'replace', path: '/backgroundImageOpacity', value: 0.35 })
    else if (/full|solid|opaque|vivid/.test(p) && /background/.test(p)) patch.push({ op: 'replace', path: '/backgroundImageOpacity', value: 1 })
  }
  // orientation: "make the bars horizontal" / "vertical chart"
  const wantOrient = /horizontal/.test(p) ? 'horizontal' : /vertical/.test(p) ? 'vertical' : null
  if (wantOrient) {
    scene.layers.forEach((l, li) => {
      if (!isDataChart(l.type)) return
      const named = l.name && p.includes(String(l.name).toLowerCase())
      if (!named && !/bars?|chart|graph|histogram|columns?|data|bars/.test(p)) return
      patch.push({ op: 'replace', path: `/layers/${li}/orientation`, value: wantOrient })
    })
  }
  // Axis display: "y-axis in $M millions", "ticks in percent". Units
  // become data.yFormat on the targeted tick chart(s) — never a rebuild.
  // Pure axis asks opt out of regrouping below: in "y-axis total amount"
  // the word "total" names the hoped-for label, not a metric, so without
  // this carve-out the chart pointlessly regroups (and gains points).
  // Anything paired with an explicit data ask still regroups as usual.
  const axisAsk = /\by-axis\b|\bx-axis\b/.test(p)
  const axisFmt = parseAxisFormat(p).yFormat
  const axisOnlyAsk = axisAsk && !/group\s+(by|per)|count\s+by|how many|top\s+\d+|bottom\s+\d+|\bsort\b|filter|average|avg|mean|\bsum\b|stack|unstack|pie|donut|bars?|lines?|scatter|histogram|waterfall|funnel|radar|surface|maps?|bubbles?|recolor|colou?r|\btitle\b|\blegend\b|\breveal\b|\bstagger\b|faster|slower|\borient\b|horizontal|vertical|\bby\s+(?!\$)[a-z0-9]/.test(p)
  if (axisAsk && axisFmt) {
    const namedHitAx = scene.layers.some((o) => o.name && p.includes(String(o.name).toLowerCase()))
    scene.layers.forEach((l, li) => {
      if (!isDataChart(l.type)) return
      const named = l.name && p.includes(String(l.name).toLowerCase())
      if (namedHitAx && !named) return
      if (!named && l.type !== 'line_chart' && l.type !== 'area_chart' && l.type !== 'scatter_chart') return
      patch.push({ op: 'replace', path: `/layers/${li}/data/yFormat`, value: axisFmt })
    })
  }
  // Chart-type + dataset switches: "change it to a vertical bar chart",
  // "make it a pie chart", "plot the other dataset instead". The targeted
  // data layer(s) are rebuilt from the referenced table so type, labels
  // and values move together; keyframes (timing) are left untouched.
  const wantType = chartTypeFromPrompt(p)
  const ntNoTable = String(prompt).split('\n').filter((l) => !/^\s*\|/.test(l)).join('\n').toLowerCase()
  const wantMapSwitch = /\bmap\b|bubble|geograph|choropleth|\bglobe\b/.test(ntNoTable)
  const { table: editTable, tableSwitch } = resolveEditTable(scene, datasets, prompt)
  // Regroup intent: axis/group/count/aggregate/top-N/ignore-column asks
  // rebuild the layer data even when the chart type stays the same.
  const regroupIntent = !!editTable && (/\bgroup(?:ed|ing)?\s+(?:by|per)\b|\bcount\b|how many/.test(p) || !!parseAxisHint(p, editTable)
    || !!matchColumn(editTable, (p.match(/\bby\s+([a-z][a-z &]*?)(?:\s+reference|\s+sheet|\s+data|\s+for\s|\s+based|\s+from\s|,|\s+total|\s+amount|$)/)?.[1] || ''))
    || /average|avg|mean|\bsum\b|total|count|how many|number of|top\s+\d+|bottom\s+\d+|largest|smallest|highest|lowest|biggest|sort(?:ed|ing)?\b|alphabetical|ignor(?:e|ing)|exclud(?:e|ing)|without|drop(?:ping)?|skip(?:ping)?/.test(p)
    || wantsStacked(ntNoTable) || wantsUnstacked(ntNoTable)
    || findValueMentions(ntNoTable, editTable).length > 0)
    && !axisOnlyAsk
  const autoName = (n) => !n || !String(n).trim() || /^(layer\s*\d+|data chart|untitled)$/i.test(String(n).trim())
  if ((wantType || wantMapSwitch || tableSwitch || regroupIntent) && editTable) {
    const namedHit = scene.layers.some((o) => o.name && p.includes(String(o.name).toLowerCase()))
    scene.layers.forEach((l, li) => {
      const isData = isDataChart(l.type) || l.type === 'map_bubbles'
      if (!isData) return
      const named = l.name && p.includes(String(l.name).toLowerCase())
      if (namedHit && !named) return
      // Data chart -> bubble map (or map rebuilt from a new table).
      if (wantMapSwitch && (isDataChart(l.type) || (l.type === 'map_bubbles' && (tableSwitch || regroupIntent)))) {
        const built = buildMapLayer(p, editTable, scene)
        if (!built) return
        if (l.type !== 'map_bubbles') patch.push({ op: 'replace', path: `/layers/${li}/type`, value: 'map_bubbles' })
        patch.push({ op: 'replace', path: `/layers/${li}/data`, value: built.data })
        if ('orientation' in l) patch.push({ op: 'remove', path: `/layers/${li}/orientation` })
        if (autoName(l.name)) patch.push({ op: 'replace', path: `/layers/${li}/name`, value: built.name })
        return
      }
      const targetType = wantType || ((tableSwitch || regroupIntent) && !wantMapSwitch ? l.type : null)
      if (!targetType || l.type === 'map_bubbles') {
        // Map -> chart needs the table; bubbles can't become bars.
        if (l.type === 'map_bubbles' && targetType && targetType !== 'map_bubbles') {
          const built = buildTableChartLayer(p, editTable, scene)
          if (!built) return
          patch.push({ op: 'replace', path: `/layers/${li}/type`, value: targetType })
          patch.push({ op: 'replace', path: `/layers/${li}/data`, value: built.data })
          if ('orientation' in l) patch.push({ op: 'remove', path: `/layers/${li}/orientation` })
          if (autoName(l.name)) patch.push({ op: 'replace', path: `/layers/${li}/name`, value: built.name })
        }
        return
      }
      const stackAsk = wantsStacked(ntNoTable) && !wantsUnstacked(ntNoTable) && !wantMapSwitch
      const unstackAsk = wantsUnstacked(ntNoTable) && !wantMapSwitch
      const hasSeries = Array.isArray(l.data?.series) && l.data.series.length > 0
      // Stacked bars: rebuild with the two-dimensional shape when asked, or
      // keep an existing stack on plain regroups (a "top 5" shouldn't
      // flatten it). Only an explicit unstack ask goes back to flat bars.
      const wantStackedShape = (stackAsk || (hasSeries && !unstackAsk)) && targetType === 'bar_chart'
      if (targetType === l.type && !tableSwitch && !regroupIntent && !stackAsk && !unstackAsk) return
      let built = null
      if (wantStackedShape) {
        const stackP = stackAsk ? p : `${p} stacked by ${l.data?.stackBy || ''}`
        // Stacked from flat: keep the layer's existing grouping unless the
        // prompt names a new one (it usually only names the split).
        const keepAxes = stackAsk
          ? { groupCol: l.data?.aggregatedBy }
          : { groupCol: l.data?.aggregatedBy, stackCol: l.data?.stackBy }
        // No flat fallback here: a failed stack must ask for clarification,
        // not silently produce an unstacked chart nobody requested.
        built = buildStackedLayer(stackP, editTable, scene, keepAxes)
      } else {
        built = buildTableChartLayer(p, editTable, scene)
      }
      if (!built) return
      const data = { ...built.data }
      if (data.reveal === undefined && l.data?.reveal !== undefined) data.reveal = l.data.reveal
      if (data.stagger === undefined && l.data?.stagger !== undefined) data.stagger = l.data.stagger
      // Skip a data replace when the rebuild is identical (already grouped).
      const cur = l.data || {}
      const sameLabels = Array.isArray(cur.labels) && Array.isArray(data.labels)
        && cur.labels.length === data.labels.length
        && cur.labels.every((x, i) => String(x) === String(data.labels[i]))
      const sameFlat = sameLabels && Array.isArray(cur.values) && Array.isArray(data.values)
        && cur.values.length === data.values.length
        && cur.values.every((x, i) => Number(x) === Number(data.values[i]))
      const sameStacked = sameLabels && Array.isArray(cur.series) && Array.isArray(data.series)
        && cur.series.length === data.series.length
        && cur.series.every((s, i) => s.label === data.series[i].label
          && Array.isArray(s.values) && s.values.length === data.series[i].values.length
          && s.values.every((v, j) => Number(v) === Number(data.series[i].values[j])))
      const sameData = (sameFlat || sameStacked)
        && (cur.aggregatedBy || null) === (data.aggregatedBy || null)
        && (cur.stackBy || null) === (data.stackBy || null)
      if (targetType !== l.type) patch.push({ op: 'replace', path: `/layers/${li}/type`, value: targetType })
      if (!sameData) {
        patch.push({ op: 'replace', path: `/layers/${li}/data`, value: data })
        if (autoName(l.name)) patch.push({ op: 'replace', path: `/layers/${li}/name`, value: built.name })
      }
      if (/horizontal|vertical/.test(p)) {
        if (built.orientation) patch.push({ op: 'replace', path: `/layers/${li}/orientation`, value: built.orientation })
        else if ('orientation' in l) patch.push({ op: 'remove', path: `/layers/${li}/orientation` })
      } else if (targetType !== l.type && targetType !== 'bar_chart' && targetType !== 'histogram') {
        if ('orientation' in l) patch.push({ op: 'remove', path: `/layers/${li}/orientation` })
      }
      if (targetType === 'pie_chart') {
        if (/donut|doughnut/.test(p)) patch.push({ op: 'replace', path: `/layers/${li}/data/variant`, value: 'donut' })
        else if (l.data?.variant) patch.push({ op: 'remove', path: `/layers/${li}/data/variant` })
      }
      if (built.showTitle !== undefined) patch.push({ op: 'replace', path: `/layers/${li}/showTitle`, value: built.showTitle })
      if (built.showLegend !== undefined) patch.push({ op: 'replace', path: `/layers/${li}/showLegend`, value: built.showLegend })
    })
  }
  // Type-only conversion when no table is available: same labels/values,
  // new renderer (e.g. "change the line chart to a pie").
  if (wantType && !editTable) {
    const namedHit = scene.layers.some((o) => o.name && p.includes(String(o.name).toLowerCase()))
    scene.layers.forEach((l, li) => {
      if (!isDataChart(l.type) || l.type === wantType) return
      const named = l.name && p.includes(String(l.name).toLowerCase())
      if (namedHit && !named) return
      patch.push({ op: 'replace', path: `/layers/${li}/type`, value: wantType })
      if (!isDataChart(wantType) || (wantType !== 'bar_chart' && wantType !== 'histogram')) {
        if ('orientation' in l) patch.push({ op: 'remove', path: `/layers/${li}/orientation` })
      }
    })
  }
  // attached image by name: "add the logo" / "use X as background" / "remove background image"
  for (const img of matchImages(prompt, images)) {
    if (!img?.dataUrl) continue
    if (/background/.test(p) && !/slide|zoom|fade|left|right|\btop\b|bottom|center|\badd\b|show/.test(p)) {
      patch.push({ op: 'replace', path: '/backgroundImage', value: img.dataUrl })
    } else if (!scene.layers.some((l) => l.type === 'image_layer' && (l.data?.imageName === img.name || l.assetUrl === img.dataUrl))) {
      patch.push({ op: 'add', path: `/layers/${scene.layers.length}`, value: buildImageLayer(prompt, img, scene) })
    }
  }
  if (/remove|clear|delete/.test(p) && /background image|background/.test(p) && !matchImages(prompt, images).length) {
    patch.push({ op: 'remove', path: '/backgroundImage' })
  }
  // fallback: retime last layer's last keyframe if nothing matched but a frame was given
  if (!patch.length && targetFrame != null && scene.layers.length) {
    const li = scene.layers.length - 1
    const ki = scene.layers[li].keyframes.length - 1
    patch.push({ op: 'replace', path: `/layers/${li}/keyframes/${ki}/frame`, value: targetFrame })
  }
  return patch
}

async function tryOllama(prompt, system, model = 'llama3.1', ollamaUrl = 'http://127.0.0.1:11434') {
  const base = String(ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '')
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: false, format: 'json', messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
  })
  if (!res.ok) throw new Error(`ollama ${res.status}`)
  const data = await res.json()
  return JSON.parse(data.message.content)
}

let lastSource = 'offline rules'
export function getLastSource() { return lastSource }

async function tryEngine(messages) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  })
  if (!res.ok) throw new Error(`engine ${res.status}`)
  const data = await res.json()
  if (!data.ok) throw new Error(data.error || 'engine failed')
  return JSON.parse(data.text)
}

export async function generateScene(prompt, opts = {}) {
  const system = opts.systemGenerate || 'Return ONLY a JSON Scene Graph: {fps,durationInFrames,width,height,layers:[{id,name,type(bar_chart|line_chart|map_bubbles|pie_chart|area_chart|scatter_chart|histogram|waterfall|funnel_chart|radar_chart|surface_plot|text|vector_shape|sprite|image_layer),startFrame,endFrame,data?,text?,assetUrl?,keyframes:[{frame,properties:{x?,y?,scale?,opacity?,rotation?},easing?}]}]}. Image layers use imageName (positional x/y); charts/maps are full-canvas. orientation horizontal|vertical for bar/histogram; pie takes data.variant donut; stacked bars keep type bar_chart with data.series (array of {label, values[], color}) instead of data.values; a line chart with data.drawMode "connect" pops dots first then draws segments instead of the wipe; showTitle/showLegend false hides the title/legend.'
  // Attached datasets travel with the prompt: the LLM gets a compact summary,
  // the offline rules get the full tables.
  const datasets = opts.datasets || []
  const context = datasets.map((d) => summarizeForLLM(d)).join('\n\n')
  let fullPrompt = context ? `${prompt}\n\n${context}\n\nUse the dataset above for the chart (labels + values). Put the parsed labels/values arrays in the layer data.` : prompt
  // Managed local engine first (llama-server via the backend), then Ollama,
  // then cloud, then the offline rules.
  // Any model reply is repaired against the prompt's table before it goes on:
  // generic layers get real chart data, and a missing chart gets built.
  const withRepair = (scene) => {
    const { scene: fixed, repaired } = repairEngineScene(scene, prompt, datasets, opts.images || [])
    if (repaired.length && opts.onRepair) opts.onRepair(repaired)
    return fixed
  }
  const stage = opts.onStage || (() => {})
  stage('Contacting local engine…')
  try { lastSource = 'managed engine'; return withRepair(await tryEngine([{ role: 'system', content: system }, { role: 'user', content: fullPrompt }])) } catch { /* fall through */ }
  if (opts.provider === 'ollama' || (!opts.apiKey && !opts.provider)) {
    stage('Local engine unavailable — trying Ollama…')
    try { lastSource = 'Ollama'; return withRepair(await tryOllama(fullPrompt, system, opts.model || 'llama3.1', opts.ollamaUrl)) } catch { lastSource = 'offline rules'; /* fall through */ }
  }
  if (opts.apiKey) {
    const base = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ model: opts.cloudModel || opts.model || 'gpt-4o-mini', response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: fullPrompt }] }),
    })
    if (res.ok) {
      stage('Reading cloud reply…')
      const data = await res.json()
      lastSource = 'cloud model'
      return withRepair(JSON.parse(data.choices[0].message.content))
    }
  }
  stage('No model reachable — building from offline rules…')
  lastSource = 'offline rules'
  const imgCtx = (opts.images || []).map((m) => `IMAGE "${m.name}" (${m.width}x${m.height})`).join('\n')
  if (imgCtx) fullPrompt = `${fullPrompt}\n\n${imgCtx}\nReference an attached image with an image_layer using its exact imageName, positioned with x/y keyframes on the 1280x720 canvas — bytes are linked automatically.`
  return ruleBasedScene(prompt, undefined, datasets, opts.images || [])
}

export async function editScene(scene, prompt, opts = {}) {
  let system = opts.systemEdit ||  'Return ONLY a JSON Patch array: [{op:replace|add|remove, path:/layers/N/... , value?}]. orientation horizontal|vertical re-orients bars; showTitle/showLegend false hides the title/legend; an image_layer value with imageName adds an attached image; /backgroundImage sets the scene backdrop and /backgroundImageOpacity (0-1) its opacity. Pacing: /layers/N/data/reveal and /data/stagger set per-point timing; text/image entrances set keyframes/0 off-canvas (x ±1400, y ±900, opacity 0) ending at rest.'
  // Type/data switches stay in scope even for user-tweaked Advanced prompts
  // (appended at runtime so saved custom prompts are never overwritten).
  if (!system.includes('Type/data switches')) {
    system += ' Line draw style: set /layers/N/data/drawMode to "connect" and a line chart pops its dots first, then draws each segment between them ("connect the dots"); remove drawMode for the default left-to-right wipe. Type/data switches are in scope: to change chart type, replace /layers/N/type (bar_chart|line_chart|pie_chart|area_chart|scatter_chart|histogram|waterfall|funnel_chart|radar_chart|surface_plot) and keep or rebuild its /layers/N/data from the dataset summary; orientation horizontal|vertical re-orients bars. Regrouping is in scope too: rebuild /layers/N/data to group by a column (labels = group names), count/average/sum a metric, take the top N, filter rows by value ("only Cup and Waffle Cone", "excluding Texas"), or honour "ignore <column>". Stacked bars keep type bar_chart with data.series (array of {label, values[], color}, one entry per stack segment) instead of data.values; to stack, rebuild data with labels + series grouped by one column and split by another; to unstack, rebuild with plain labels/values.'
  }
  // Like generation, the edit model gets the attached datasets as a compact
  // summary so "use the other dataset" resolves to real labels/values.
  const editDatasets = opts.datasets || []
  const editContext = editDatasets.map((d) => summarizeForLLM(d)).join('\n\n')
  const editPromptFull = editContext
    ? `${prompt}\n\n${editContext}\n\nIf the request names a dataset, use that dataset's labels/values for the rebuilt layer data.`
    : prompt
  const full = `${system}\nCurrent scene:\n${JSON.stringify(scene)}\nEdit request: ${editPromptFull}`
  const stage = opts.onStage || (() => {})
  stage('Contacting local engine…')
  try {
    const out = await tryEngine([{ role: 'system', content: system }, { role: 'user', content: full }])
    if (Array.isArray(out)) return out
    if (out.patch) return out.patch
  } catch { /* fall through */ }
  if (opts.provider === 'ollama' || (!opts.apiKey && !opts.provider)) {
    stage('Local engine unavailable — trying Ollama…')
    try {
      const out = await tryOllama(full, system, opts.model || 'llama3.1', opts.ollamaUrl)
      if (Array.isArray(out)) return out
      if (out.patch) return out.patch
    } catch { /* fallback */ }
  }
  if (opts.apiKey) {
    try {
      const base = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({ model: opts.cloudModel || opts.model || 'gpt-4o-mini', response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: full }] }),
      })
      if (res.ok) {
        const data = await res.json()
        const parsed = JSON.parse(data.choices[0].message.content)
        if (Array.isArray(parsed)) return parsed
        if (parsed.patch) return parsed.patch
      }
    } catch { /* fallback */ }
  }
  stage('No model reachable — editing with offline rules…')
  return ruleBasedPatch(scene, prompt, opts.datasets || [], opts.images || [])
}
