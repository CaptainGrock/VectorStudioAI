// LLM settings: Ollama picker + downloader config, cloud fallback, and
// user-tweakable system prompts (Advanced). Persisted to localStorage.

export const DEFAULT_SYSTEM_GENERATE =
  'Return ONLY a JSON Scene Graph: {fps,durationInFrames,width,height,layers:[{id,name,type(bar_chart|line_chart|map_bubbles|text|vector_shape|sprite|image_layer),startFrame,endFrame,data?,text?,assetUrl?,keyframes:[{frame,properties:{x?,y?,scale?,opacity?,rotation?},easing?}]}]}. A chart layer MUST carry its data inline, e.g. {"type":"line_chart","name":"Total Revenue by Product","data":{"labels":["A","B"],"values":[10,20]},"keyframes":[{"frame":0,"properties":{"opacity":0}},{"frame":40,"properties":{"opacity":1}}]}. Never return placeholder layers ("Layer 1") — every layer needs a real name, real data, and at least 2 keyframes.  Chart data may include pointColors[] (per-point hex) and legend[{label,color}] — use them when the prompt asks for coloring by category or sign. Scene takes a background hex. Text layers take color hex, fontFamily (any Google Font name — Inter, Roboto, Montserrat, Oswald, Playfair Display, Lobster, JetBrains Mono, …) and fontSize (12-200). A map_bubbles layer shows one bubble per country: data {metric, bubbles:[{country,x,y,value,category,color}], legend} in 1280x720 coordinates — build it when the prompt asks for a map, countries, or bubbles. Reference attached images with {"type":"image_layer","imageName":"<exact name>"} plus x/y keyframes (positional, 1280x720); scene takes backgroundImage for a backdrop. Bar/histogram take orientation horizontal|vertical; pie takes data.variant donut; stacked bars keep type bar_chart with data.series (array of {label, values[], color}, one entry per stack segment) instead of data.values — legend names the series; layers take showTitle/showLegend false to hide the title or legend. Chart/map data takes reveal (frames per point) and stagger (frames between points) to pace the animation; a line chart with data.drawMode "connect" pops its dots first, then draws each segment between them ("connect the dots") instead of the default wipe; scene takes backgroundImageOpacity 0-1 for the backdrop. Keyframe easing is linear (Regular/steady), easeInCubic (In: slow start, fast arrival) or easeOutCubic (Out: fast start, gentle landing).'

export const DEFAULT_SYSTEM_EDIT =
  'Return ONLY a JSON Patch array: [{op:replace|add|remove, path:/layers/N/... , value?}]. Type/data switches are in scope: to change chart type, replace /layers/N/type (bar_chart|line_chart|pie_chart|area_chart|scatter_chart|histogram|waterfall|funnel_chart|radar_chart|surface_plot) and keep or rebuild its /layers/N/data from the dataset summary; orientation horizontal|vertical re-orients bars. Regrouping is in scope too: rebuild /layers/N/data to group by a column (labels = group names), count/average/sum a metric, take the top N, filter rows by value ("only Cup and Waffle Cone", "excluding Texas"), or honour "ignore <column>". Stacked bars keep type bar_chart with data.series (array of {label, values[], color}) instead of data.values — to stack, rebuild data with labels + series grouped by one column and split by another ("stack by topping"); to unstack, rebuild with plain labels/values. To remove a zoom / keep a layer static at 100%, set every keyframe scale to 1 (replace /layers/N/keyframes/K/properties/scale with 1) instead of deleting keyframes. To recolor, replace /layers/N/color (text) or /layers/N/data/pointColors (chart, full hex array) and clear /layers/N/data/legend; /background recolors the scene. Pacing: /layers/N/data/reveal and /data/stagger set per-point timing; a line chart with /layers/N/data/drawMode "connect" pops dots first then draws segments ("connect the dots") — remove drawMode for the wipe; /backgroundImageOpacity (0-1) sets backdrop opacity; text/image entrances set keyframes/0 off-canvas (x ±1400, y ±900, opacity 0) ending at rest. Motion feel: /layers/N/keyframes/K/easing is linear (Regular/steady), easeInCubic (In: slow start, fast arrival) or easeOutCubic (Out: fast start, gentle landing).'

const KEY = 'vectorstudio.llm.v1'

export const PROMPT_V = 9

export const DEFAULT_SETTINGS = {
  promptV: PROMPT_V,
  ollamaUrl: 'http://127.0.0.1:11434',
  model: 'llama3.1',
  cloudBaseUrl: 'https://api.openai.com/v1',
  cloudModel: 'gpt-4o-mini',
  apiKey: '',
  systemGenerate: DEFAULT_SYSTEM_GENERATE,
  systemEdit: DEFAULT_SYSTEM_EDIT,
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const saved = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
    // Prompt upgrades: a saved v1 prompt predates the chart-data contract,
    // so it would keep producing placeholder layers. Migrate it forward.
    if (saved.promptV !== PROMPT_V) {
      saved.systemGenerate = DEFAULT_SYSTEM_GENERATE
      saved.systemEdit = DEFAULT_SYSTEM_EDIT
      saved.promptV = PROMPT_V
      try { localStorage.setItem(KEY, JSON.stringify(saved)) } catch { /* ignore */ }
    }
    return saved
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch { /* private mode etc. */ }
}

export function resetPrompts() {
  const s = loadSettings()
  const next = { ...s, systemGenerate: DEFAULT_SYSTEM_GENERATE, systemEdit: DEFAULT_SYSTEM_EDIT }
  saveSettings(next)
  return next
}
