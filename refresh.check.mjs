import { buildTableChartLayer, buildStackedLayer, refreshLayerData, resolveRefreshTable } from './src/llm.js'

let fail = 0
const ok = (cond, msg) => { console.log(cond ? `PASS ${msg}` : `FAIL ${msg}`); if (!cond) fail++ }
const table = (rows) => ({ id: 'ds_test', name: 'sales.csv', columns: ['state', 'vessel', 'scoops'], rows })

const t1 = table([
  { state: 'AL', vessel: 'Cup', scoops: '10' },
  { state: 'AK', vessel: 'Cup', scoops: '20' },
  { state: 'AZ', vessel: 'Cone', scoops: '30' },
])

// 1. Flat build stamps lineage
const layer = buildTableChartLayer('bar chart count by vessel', t1)
ok(layer && layer.data.buildPrompt && layer.data.buildPrompt.includes('vessel'), 'flat build stamps buildPrompt')
ok(layer.data.datasetId === 'ds_test' && layer.data.source === 'sales.csv', 'flat build stamps dataset id + source')
ok(layer.data.aggregatedBy === 'vessel' && layer.data.valueCol === 'Count', `grouped by vessel (labels=${layer.data.labels})`)

// 2. Refresh on new rows updates values, keeps style + keyframes
layer.keyframes = [{ frame: 0, properties: { opacity: 0 } }, { frame: 40, properties: { opacity: 1 } }]
layer.data.reveal = 24; layer.data.stagger = 8
layer.data.pointColors = layer.data.labels.map((lb) => (lb === 'Cup' ? '#ff0000' : '#00ff00'))
const t2 = table([
  { state: 'AL', vessel: 'Cup', scoops: '10' },
  { state: 'AK', vessel: 'Cup', scoops: '20' },
  { state: 'AZ', vessel: 'Cone', scoops: '30' },
  { state: 'AR', vessel: 'Cup', scoops: '40' },
  { state: 'CA', vessel: 'Sundae', scoops: '50' },
])
const fresh = refreshLayerData(layer, t2)
ok(fresh && fresh.values[fresh.labels.indexOf('Cup')] === 3, `Cup count 2→3 (got ${fresh && fresh.values})`)
ok(fresh.labels.includes('Sundae'), 'new category appears')
ok(fresh.reveal === 24 && fresh.stagger === 8, 'timing preserved')
ok(fresh.pointColors[fresh.labels.indexOf('Cup')] === '#ff0000', 'Cup keeps its manual color by label')
ok(fresh.source === 'sales.csv' && fresh.buildPrompt === layer.data.buildPrompt, 'lineage carried forward')

// 3. Identical data rebuilds identical (caller reports "already current")
const same = refreshLayerData({ data: { ...layer.data, ...fresh, labels: fresh.labels, values: fresh.values } }, t2)
ok(same && JSON.stringify([same.labels, same.values]) === JSON.stringify([fresh.labels, fresh.values]), 'same-table refresh is stable')

// 4. Stacked path
const sl = buildStackedLayer('stacked by vessel with count by state', table([
  { state: 'AL', vessel: 'Cup', scoops: '1' },
  { state: 'AL', vessel: 'Cone', scoops: '2' },
  { state: 'AK', vessel: 'Cup', scoops: '3' },
]))
ok(sl && sl.data.buildPrompt && sl.data.series?.length > 0, `stacked stamps lineage (${sl && sl.data.series?.length} series)`)
const sf = sl && refreshLayerData(sl, table([
  { state: 'AL', vessel: 'Cup', scoops: '1' },
  { state: 'AL', vessel: 'Cup', scoops: '9' },
]))
const cupSeries = sf && sf.series.find((s) => s.label === 'Cup')
ok(sf && sf.labels.includes('AL') && cupSeries && cupSeries.values[sf.labels.indexOf('AL')] === 2, `stacked refresh regroups new rows (AL/Cup=${cupSeries && cupSeries.values[sf.labels.indexOf('AL')]})`)

// 5. Resolver: id first, then name, then null; no buildPrompt → null
ok(resolveRefreshTable(layer, [{ id: 'ds_x', name: 'other.csv', columns: [], rows: [] }, t1]) === undefined
  || resolveRefreshTable(layer, [t1])?.id === 'ds_test', 'resolves by dataset id')
ok(resolveRefreshTable({ data: { source: 'sales.csv' } }, [{ ...t1, id: 'ds_new' }])?.id === 'ds_new', 'resolves by source name')
ok(resolveRefreshTable(layer, []) === null, 'null when dataset gone')
ok(refreshLayerData({ data: { labels: ['a'], values: [1] } }, t1) === null, 'no buildPrompt → no refresh')

process.exit(fail ? 1 : 0)
