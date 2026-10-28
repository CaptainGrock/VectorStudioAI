import { buildStackedData, buildStackedLayer, ruleBasedPatch, wantsStacked, wantsUnstacked, repairEngineScene } from './src/llm.js'

const ice = {
  id: 'ds_ice', name: 'ice_cream.csv',
  columns: ['state', 'preferred_vessel', 'favorite_topping', 'avg_scoops_per_capita'],
  rows: [
    { state: 'Alabama', preferred_vessel: 'Waffle Cone', favorite_topping: 'Hot Fudge', avg_scoops_per_capita: '28.4' },
    { state: 'Alaska', preferred_vessel: 'Sugar Cone', favorite_topping: 'Hot Fudge', avg_scoops_per_capita: '31.2' },
    { state: 'Arizona', preferred_vessel: 'Cup', favorite_topping: 'Caramel Drizzle', avg_scoops_per_capita: '26.8' },
    { state: 'California', preferred_vessel: 'Cup', favorite_topping: 'Fresh Berries', avg_scoops_per_capita: '34.5' },
    { state: 'Texas', preferred_vessel: 'Waffle Cone', favorite_topping: 'Pecans', avg_scoops_per_capita: '30.9' },
    { state: 'New Jersey', preferred_vessel: 'Sundae', favorite_topping: 'Rainbow Sprinkles', avg_scoops_per_capita: '31.9' },
  ],
}
const mk = (data) => ({
  fps: 30, durationInFrames: 300, width: 1280, height: 720, background: '#10141d',
  layers: [{ id: 'l1', name: 'Data Chart', type: 'bar_chart', startFrame: 0, endFrame: 300, data, keyframes: [{ frame: 0, properties: { opacity: 0 } }, { frame: 40, properties: { opacity: 1 } }] }],
})
let fail = 0
const check = (name, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', name, extra); if (!cond) fail++ }

check('wantsStacked', wantsStacked('convert to a stacked bar chart') && !wantsStacked('make the bars vertical'))
check('wantsUnstacked', wantsUnstacked('unstack the bars') && wantsUnstacked('clustered bars') && !wantsUnstacked('stacked by region'))

// 1. Build stacked: vessel groups x topping split, counts
const s1 = buildStackedData('stacked bar chart of vessels stacked by topping', ice)
check('stacked build', !!s1 && s1.aggregatedBy === 'preferred_vessel' && s1.stackBy === 'favorite_topping' && s1.series.length >= 2,
  JSON.stringify(s1 && { labels: s1.labels, series: s1.series.map((s) => s.label) }))
const sumsOk = s1 && s1.labels.every((_, i) => s1.series.reduce((a, s) => a + s.values[i], 0) === s1.series.reduce((a, s) => a + s.values[i], 0))
check('stacked values finite', !!s1 && s1.series.every((s) => s.values.every((v) => Number.isFinite(v))), JSON.stringify(s1?.series.map((s) => s.values)))

// 2. Full layer
const l1 = buildStackedLayer('stacked bar chart by vessel', ice)
check('stacked layer', !!l1 && l1.type === 'bar_chart' && Array.isArray(l1.data.series) && l1.data.series.length > 0, l1?.name)

// 3. Revise flat -> stacked
const flat = mk({ labels: ['Waffle Cone', 'Cup', 'Sugar Cone', 'Sundae'], values: [2, 2, 1, 1], aggregatedBy: 'preferred_vessel', columns: ice.columns, rows: ice.rows.map((r) => ice.columns.map((c) => String(r[c]))), rowCount: 6 })
const p3 = ruleBasedPatch(flat, 'convert it to a stacked bar chart stacked by topping', [ice], [])
const d3 = p3.find((o) => o.path === '/layers/0/data')
check('revise flat->stacked', !!d3 && Array.isArray(d3.value.series) && d3.value.stackBy === 'favorite_topping', JSON.stringify(p3.map((o) => o.path)))

// 4. Revise stacked -> unstacked
const stacked = mk({ labels: l1.data.labels, series: l1.data.series, legend: l1.data.legend, aggregatedBy: 'preferred_vessel', stackBy: 'favorite_topping', columns: ice.columns, rows: ice.rows.map((r) => ice.columns.map((c) => String(r[c]))), rowCount: 6 })
const p4 = ruleBasedPatch(stacked, 'unstack the bars', [ice], [])
const d4 = p4.find((o) => o.path === '/layers/0/data')
check('revise unstack', !!d4 && Array.isArray(d4.value.values) && !d4.value.series, JSON.stringify(p4.map((o) => o.path)))

// 5. Plain regroup keeps the stack
const p5 = ruleBasedPatch(stacked, 'show top 3 only', [ice], [])
const d5 = p5.find((o) => o.path === '/layers/0/data')
check('regroup keeps stack', !!d5 && Array.isArray(d5.value.series), JSON.stringify(p5.map((o) => o.path)))

// 6. Repair leaves a good stacked layer alone
const { scene: fixed, repaired } = repairEngineScene(stacked, 'stacked bar chart', [ice], [])
check('repair keeps series', Array.isArray(fixed.layers[0].data.series) && repaired.length === 0, JSON.stringify(repaired))

// 7. Single-category table -> stacked impossible -> null (flat fallback covers)
const one = { id: 'o', name: 'one.csv', columns: ['vessel', 'sales'], rows: [{ vessel: 'Cup', sales: '10' }, { vessel: 'Cone', sales: '5' }] }
check('single-cat null', buildStackedData('stacked bar', one) === null)

process.exit(fail ? 1 : 0)
