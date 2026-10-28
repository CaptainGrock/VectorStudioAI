// Open-font catalog (all Google Fonts: SIL OFL / Apache licensed) with a
// live-preview picker. 1001fonts.com has no public API and mixes licenses,
// so the picker pulls from Google Fonts — every family below is open-licensed
// and renders its preview in the actual typeface once loaded.
export const OPEN_FONTS = [
  { name: 'Inter', cats: ['sans', 'ui'] },
  { name: 'Roboto', cats: ['sans'] },
  { name: 'Open Sans', cats: ['sans'] },
  { name: 'Lato', cats: ['sans'] },
  { name: 'Montserrat', cats: ['sans', 'display'] },
  { name: 'Oswald', cats: ['sans', 'condensed'] },
  { name: 'Raleway', cats: ['sans'] },
  { name: 'Poppins', cats: ['sans', 'geometric'] },
  { name: 'Nunito', cats: ['sans', 'rounded'] },
  { name: 'Work Sans', cats: ['sans'] },
  { name: 'Archivo', cats: ['sans', 'grotesque'] },
  { name: 'Bebas Neue', cats: ['sans', 'display', 'condensed'] },
  { name: 'Anton', cats: ['sans', 'display'] },
  { name: 'Titan One', cats: ['display'] },
  { name: 'Lilita One', cats: ['display'] },
  { name: 'Bungee', cats: ['display'] },
  { name: 'Righteous', cats: ['display'] },
  { name: 'Russo One', cats: ['display'] },
  { name: 'Orbitron', cats: ['display', 'tech'] },
  { name: 'Chakra Petch', cats: ['tech'] },
  { name: 'Playfair Display', cats: ['serif', 'editorial'] },
  { name: 'Merriweather', cats: ['serif'] },
  { name: 'Lora', cats: ['serif'] },
  { name: 'PT Serif', cats: ['serif'] },
  { name: 'DM Serif Display', cats: ['serif', 'display'] },
  { name: 'Space Grotesk', cats: ['sans', 'tech'] },
  { name: 'IBM Plex Sans', cats: ['sans'] },
  { name: 'IBM Plex Mono', cats: ['mono'] },
  { name: 'JetBrains Mono', cats: ['mono'] },
  { name: 'Roboto Mono', cats: ['mono'] },
  { name: 'Lobster', cats: ['script'] },
  { name: 'Pacifico', cats: ['script'] },
  { name: 'Dancing Script', cats: ['script'] },
  { name: 'Caveat', cats: ['script', 'hand'] },
  { name: 'Shadows Into Light', cats: ['hand'] },
  { name: 'Permanent Marker', cats: ['hand'] },
  { name: 'Bangers', cats: ['display', 'comic'] },
  { name: 'Luckiest Guy', cats: ['display', 'comic'] },
  { name: 'Abril Fatface', cats: ['display', 'serif'] },
  { name: 'Cinzel', cats: ['serif', 'display'] },
  { name: 'Source Sans 3', cats: ['sans', 'ui'] },
  { name: 'Noto Sans', cats: ['sans', 'ui'] },
  { name: 'Fira Sans', cats: ['sans'] },
  { name: 'Ubuntu', cats: ['sans'] },
  { name: 'Cabin', cats: ['sans'] },
  { name: 'Karla', cats: ['sans'] },
  { name: 'Manrope', cats: ['sans'] },
  { name: 'Outfit', cats: ['sans', 'geometric'] },
  { name: 'Plus Jakarta Sans', cats: ['sans'] },
  { name: 'Public Sans', cats: ['sans', 'ui'] },
  { name: 'Sora', cats: ['sans', 'tech'] },
  { name: 'Lexend', cats: ['sans'] },
  { name: 'Epilogue', cats: ['sans'] },
  { name: 'Jost', cats: ['sans', 'geometric'] },
  { name: 'Rubik', cats: ['sans', 'rounded'] },
  { name: 'Barlow', cats: ['sans'] },
  { name: 'Barlow Condensed', cats: ['sans', 'condensed'] },
  { name: 'Exo', cats: ['sans', 'tech'] },
  { name: 'Exo 2', cats: ['sans', 'tech'] },
  { name: 'Rajdhani', cats: ['sans', 'tech'] },
  { name: 'Saira', cats: ['sans', 'tech'] },
  { name: 'Cuprum', cats: ['sans'] },
  { name: 'Overpass', cats: ['sans'] },
  { name: 'Hind', cats: ['sans'] },
  { name: 'Mukta', cats: ['sans'] },
  { name: 'PT Sans', cats: ['sans'] },
  { name: 'Arimo', cats: ['sans'] },
  { name: 'DM Sans', cats: ['sans'] },
  { name: 'Hanken Grotesk', cats: ['sans'] },
  { name: 'Mulish', cats: ['sans', 'rounded'] },
  { name: 'Heebo', cats: ['sans'] },
  { name: 'Asap', cats: ['sans'] },
  { name: 'Assistant', cats: ['sans'] },
  { name: 'Varela Round', cats: ['sans', 'rounded'] },
  { name: 'Quicksand', cats: ['sans', 'rounded'] },
  { name: 'Comfortaa', cats: ['sans', 'rounded'] },
  { name: 'Fredoka', cats: ['sans', 'rounded', 'display'] },
  { name: 'Baloo 2', cats: ['sans', 'rounded', 'display'] },
  { name: 'Libre Franklin', cats: ['sans'] },
  { name: 'Cairo', cats: ['sans'] },
  { name: 'Tajawal', cats: ['sans'] },
  { name: 'Almarai', cats: ['sans'] },
  { name: 'Kanit', cats: ['sans', 'tech'] },
  { name: 'Prompt', cats: ['sans'] },
  { name: 'Source Serif 4', cats: ['serif'] },
  { name: 'Noto Serif', cats: ['serif'] },
  { name: 'Libre Baskerville', cats: ['serif'] },
  { name: 'Cormorant Garamond', cats: ['serif', 'editorial'] },
  { name: 'EB Garamond', cats: ['serif', 'editorial'] },
  { name: 'Crimson Pro', cats: ['serif'] },
  { name: 'Spectral', cats: ['serif'] },
  { name: 'Zilla Slab', cats: ['serif', 'slab'] },
  { name: 'Roboto Slab', cats: ['serif', 'slab'] },
  { name: 'Arvo', cats: ['serif', 'slab'] },
  { name: 'Bitter', cats: ['serif', 'slab'] },
  { name: 'Vollkorn', cats: ['serif'] },
  { name: 'Alegreya', cats: ['serif'] },
  { name: 'Bodoni Moda', cats: ['serif', 'editorial'] },
  { name: 'Yeseva One', cats: ['serif', 'display'] },
  { name: 'Fraunces', cats: ['serif', 'display'] },
  { name: 'Instrument Serif', cats: ['serif', 'editorial'] },
  { name: 'Newsreader', cats: ['serif'] },
  { name: 'Gelasio', cats: ['serif'] },
  { name: 'Literata', cats: ['serif'] },
  { name: 'Bree Serif', cats: ['serif', 'slab'] },
  { name: 'Averia Serif Libre', cats: ['serif'] },
  { name: 'Italiana', cats: ['serif', 'display'] },
  { name: 'Marcellus', cats: ['serif', 'display'] },
  { name: 'Cinzel Decorative', cats: ['serif', 'display'] },
  { name: 'Amiri', cats: ['serif'] },
  { name: 'Fira Code', cats: ['mono'] },
  { name: 'Inconsolata', cats: ['mono'] },
  { name: 'Source Code Pro', cats: ['mono'] },
  { name: 'Space Mono', cats: ['mono'] },
  { name: 'DM Mono', cats: ['mono'] },
  { name: 'Overpass Mono', cats: ['mono'] },
  { name: 'Cutive Mono', cats: ['mono'] },
  { name: 'Anonymous Pro', cats: ['mono'] },
  { name: 'Ubuntu Mono', cats: ['mono'] },
  { name: 'Cousine', cats: ['mono'] },
  { name: 'Courier Prime', cats: ['mono'] },
  { name: 'Major Mono Display', cats: ['mono', 'display'] },
  { name: 'Satisfy', cats: ['script'] },
  { name: 'Great Vibes', cats: ['script'] },
  { name: 'Allura', cats: ['script'] },
  { name: 'Alex Brush', cats: ['script'] },
  { name: 'Parisienne', cats: ['script'] },
  { name: 'Sacramento', cats: ['script'] },
  { name: 'Yellowtail', cats: ['script'] },
  { name: 'Cookie', cats: ['script'] },
  { name: 'Courgette', cats: ['script'] },
  { name: 'Kaushan Script', cats: ['script'] },
  { name: 'Kalam', cats: ['hand'] },
  { name: 'Patrick Hand', cats: ['hand'] },
  { name: 'Indie Flower', cats: ['hand'] },
  { name: 'Gochi Hand', cats: ['hand'] },
  { name: 'Rock Salt', cats: ['hand'] },
  { name: 'Homemade Apple', cats: ['hand'] },
  { name: 'Covered By Your Grace', cats: ['hand'] },
  { name: 'Just Another Hand', cats: ['hand'] },
  { name: 'Reenie Beanie', cats: ['hand'] },
  { name: 'Gloria Hallelujah', cats: ['hand'] },
  { name: 'Architects Daughter', cats: ['hand'] },
  { name: 'Handlee', cats: ['hand'] },
  { name: 'Itim', cats: ['hand'] },
  { name: 'Mali', cats: ['hand'] },
  { name: 'Alfa Slab One', cats: ['display', 'slab'] },
  { name: 'Special Elite', cats: ['display'] },
  { name: 'Audiowide', cats: ['display', 'tech'] },
  { name: 'Michroma', cats: ['display', 'tech'] },
  { name: 'Zen Dots', cats: ['display', 'tech'] },
  { name: 'Monoton', cats: ['display'] },
  { name: 'Press Start 2P', cats: ['display', 'tech'] },
  { name: 'Silkscreen', cats: ['display', 'tech'] },
  { name: 'VT323', cats: ['display', 'mono'] },
  { name: 'Fascinate', cats: ['display'] },
  { name: 'Creepster', cats: ['display'] },
  { name: 'Chewy', cats: ['display', 'rounded'] },
  { name: 'Rubik Mono One', cats: ['display', 'mono'] },
  { name: 'Changa', cats: ['display'] },
]

let loaded = new Set()

const CUSTOM_KEY = 'vectorstudio.fonts.custom.v1'

/** Bare family name out of a full stack, an LLM value, or a plain name. */
export function cleanFamily(name) {
  if (!name) return ''
  return String(name).split(',')[0].replace(/['"]/g, '').trim().replace(/\s+/g, ' ')
}

// System fonts (Arial, Helvetica, …) render locally and must never enter a
// Google Fonts URL: one unknown family 400s the whole combined request and
// knocks out every other font with it. GOOD gates the URL to catalog +
// previously verified names only (verified customs persist across restarts).
const GOOD = new Set(OPEN_FONTS.map((f) => f.name))
// Families that must load from the Fontsource mirror (jsDelivr) instead of
// Google Fonts — e.g. googleapis is blocked by a firewall/ad-blocker while
// jsDelivr still works. Persisted per family (accepts the old plain-name
// format too).
const FONTSRC = {}
try {
  const saved = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]')
  if (Array.isArray(saved)) saved.forEach((e) => {
    const n = typeof e === 'string' ? e : e?.name
    const c = cleanFamily(n)
    if (!c) return
    GOOD.add(c)
    if (typeof e === 'object' && e?.src === 'fontsource') FONTSRC[c] = 'fontsource'
  })
} catch { /* no DOM (tests) or private mode */ }
function persistCustoms() {
  try {
    const customs = [...GOOD]
      .filter((n) => !OPEN_FONTS.some((f) => f.name === n))
      .map((n) => (FONTSRC[n] === 'fontsource' ? { name: n, src: 'fontsource' } : n))
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(customs))
  } catch { /* ignore */ }
}
const fontSlug = (name) => cleanFamily(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
/** Canonical casing for a family we already know (catalog or previously
 *  verified). The CSS API is case-sensitive and @font-face declares the
 *  canonical name, so storing "poppins" when the face is "Poppins"
 *  silently matches nothing — this is what made applied fonts not show. */
export function canonicalFontName(input) {
  const c = cleanFamily(input)
  if (!c) return ''
  const low = c.toLowerCase()
  const hit = OPEN_FONTS.find((f) => f.name.toLowerCase() === low)
  if (hit) return hit.name
  for (const g of GOOD) { if (g.toLowerCase() === low) return g }
  return ''
}
async function fetchCssText(url, ms = 8000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { signal: ctl.signal })
    if (!r.ok) return null
    return await r.text()
  } catch { return null } finally { clearTimeout(t) }
}
function parseDeclaredFamily(cssText) {
  const m = /font-family:\s*['"]([^'"]+)['"]/.exec(cssText || '')
  return m ? cleanFamily(m[1]) : ''
}
// Warm the browser's font cache best-effort so the first paint after
// "applied" already uses the face instead of flashing a fallback.
function warmFont(name) {
  try {
    if (document && document.fonts && document.fonts.load) {
      document.fonts.load(`400 32px "${name}"`).catch(() => {})
      document.fonts.load(`800 32px "${name}"`).catch(() => {})
    }
  } catch { /* best-effort */ }
}
// Session CDN probe: 'google' | 'mirror' | 'offline' | null (unknown yet).
// The picker probes once on open — if both CDNs are unreachable we hide the
// webfont UI entirely ("remove it") instead of showing loaders that can
// only fail; if only the mirror answers, loads go straight there instead of
// waiting on a doomed Google attempt first.
let cdnPref = null
let probePromise = null
async function tryFetch(url, ms = 6000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { signal: ctl.signal })
    const text = r.ok ? await r.text() : ''
    return r.ok && /@font-face/.test(text)
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}
export function fontCdnStatus() {
  return cdnPref
}
export function probeFontCdn() {
  if (probePromise) return probePromise
  probePromise = (async () => {
    const google = 'https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap'
    const mirror = 'https://cdn.jsdelivr.net/npm/@fontsource/inter/index.css'
    if (await tryFetch(google)) cdnPref = 'google'
    else if (await tryFetch(mirror)) cdnPref = 'mirror'
    else cdnPref = 'offline'
    return cdnPref
  })()
  return probePromise
}
/** True when this family must load from the Fontsource mirror. Used by the
 *  headless-render font gate as well as the preview loader. */
export function isMirrorFont(name) {
  return FONTSRC[cleanFamily(name)] === 'fontsource'
}
/** Fontsource mirror stylesheets (400/700/800) served from jsDelivr — every
 *  Google Font is republished there as an npm package, so this works when
 *  fonts.googleapis.com itself is blocked but the mirror isn't. */
/** Mirror stylesheets for one family (400/700/800). Exported for the
 *  headless-render font gate, which tries both CDNs for every family. */
export function addMirrorLinks(f, idBase) {
  try {
    const slug = fontSlug(f)
    if (!slug) return
    for (const w of ['400', '700', '800']) {
      const id = `${idBase}-${w}`
      if (document.getElementById(id)) continue
      const link = document.createElement('link')
      link.id = id
      link.rel = 'stylesheet'
      link.href = w === '400'
        ? `https://cdn.jsdelivr.net/npm/@fontsource/${slug}@latest/index.css`
        : `https://cdn.jsdelivr.net/npm/@fontsource/${slug}@latest/${w}.css`
      link.onerror = () => link.remove()
      document.head.appendChild(link)
    }
  } catch { /* ignore */ }
}

/** Offline-safe system stacks — render instantly with no network, so
 *  picking one always visibly changes the text even when Google Fonts
 *  is unreachable. Shown in their own picker section. */
export const SYSTEM_FONTS_LIST = [
  { name: 'Arial', stack: 'Arial, Helvetica, sans-serif' },
  { name: 'Helvetica', stack: 'Helvetica, Arial, sans-serif' },
  { name: 'Georgia', stack: 'Georgia, serif' },
  { name: 'Times New Roman', stack: '"Times New Roman", Times, serif' },
  { name: 'Courier New', stack: '"Courier New", Courier, monospace' },
  { name: 'Verdana', stack: 'Verdana, Geneva, sans-serif' },
  { name: 'Trebuchet MS', stack: '"Trebuchet MS", Verdana, sans-serif' },
  { name: 'Impact', stack: 'Impact, Haettenschweiler, sans-serif' },
  { name: 'Comic Sans MS', stack: '"Comic Sans MS", cursive' },
]
const SYSTEM_NAMES = new Set(SYSTEM_FONTS_LIST.map((f) => f.name.toLowerCase()))

/** Inject one Google Fonts stylesheet per family (once each). Per-family
 *  links replace the old single combined URL: a 200-family request could
 *  exceed URL limits and fail as a whole (killing every preview), and one
 *  bad family 400d the entire batch. Now a failure only affects that one
 *  family — its link is removed and it stays retryable. */
export function ensureFonts(families) {
  try {
    for (const raw of families || []) {
      const f = cleanFamily(raw)
      if (!f || !GOOD.has(f) || loaded.has(f) || SYSTEM_NAMES.has(f.toLowerCase())) continue
      loaded.add(f)
      const id = `vs-font-${f.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
      if (document.getElementById(id)) continue
      const link = document.createElement('link')
      link.id = id
      link.rel = 'stylesheet'
      const idBase = id
      // Known-mirror families — or a session where Google already failed
      // its probe — go straight to jsDelivr.
      if (FONTSRC[f] === 'fontsource' || cdnPref === 'mirror') { addMirrorLinks(f, idBase); continue }
      link.href = `https://fonts.googleapis.com/css2?family=${f.replace(/ /g, '+')}:wght@400;700;800&display=swap`
      // Automatic failover: if Google Fonts is blocked, switch this family
      // to the mirror (persisted, so reloads go straight there) and load
      // it now — the preview recovers without the user doing anything.
      link.onerror = () => {
        loaded.delete(f); link.remove()
        FONTSRC[f] = 'fontsource'
        persistCustoms()
        addMirrorLinks(f, idBase)
      }
      document.head.appendChild(link)
    }
  } catch { /* offline: previews fall back to system fonts */ }
}

/**
 * Load any Google Font by exact family name (verified first). The catalog
 * above is a curated starter set; the whole Google Fonts library (~1500
 * families, all open-licensed) is reachable through the same CSS API — this
 * checks the name really exists before applying it, so a typo can't leave
 * the picker in a broken state. Needs internet on first use.
 */
export async function fetchGoogleFont(name) {
  const clean = cleanFamily(name)
  if (!clean) return { ok: false, error: 'Type a font name first.' }
  // Known family (any casing — "poppins" finds "Poppins"): apply the
  // canonical name directly instead of re-verifying over the network.
  const known = canonicalFontName(clean)
  if (known) {
    GOOD.add(known)
    persistCustoms()
    ensureFonts([known])
    warmFont(known)
    return { ok: true, name: known }
  }
  // Unknown name: ask the Fontsource mirror, whose CSS declares the true
  // `font-family: '...'` — that yields canonical casing for any of the
  // ~1500 Google families without guessing capitalization.
  const mirrorCss = `https://cdn.jsdelivr.net/npm/@fontsource/${fontSlug(clean)}/index.css`
  const mirrorText = cdnPref === 'offline' ? null : await fetchCssText(mirrorCss, 8000)
  const declared = mirrorText && /@font-face/.test(mirrorText) ? parseDeclaredFamily(mirrorText) : ''
  if (declared) {
    if (cdnPref !== 'mirror') cdnPref = 'mirror'
    FONTSRC[declared] = 'fontsource'
    GOOD.add(declared)
    persistCustoms()
    ensureFonts([declared])
    warmFont(declared)
    return { ok: true, name: declared }
  }
  // Mirror has no such package — try Google with the input as typed (it
  // 400s on wrong names, which tryFetch treats as a miss, not a hit).
  const css = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(clean).replace(/%20/g, '+')}:wght@400;700;800&display=swap`
  if (cdnPref !== 'offline' && await tryFetch(css, 8000)) {
    GOOD.add(clean)
    persistCustoms()
    ensureFonts([clean])
    warmFont(clean)
    return { ok: true, name: clean }
  }
  // Both silent: distinguish "wrong name" (Google answered) from "no
  // connection" with one cheap status-only request.
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 6000)
    const probe = await fetch(css, { method: 'GET', signal: ctl.signal }).catch(() => null)
    clearTimeout(t)
    if (probe && probe.status === 400) {
      return { ok: false, error: `"${clean}" isn't on Google Fonts — check the spelling.` }
    }
    if (probe && probe.ok) {
      // Reachable after all (transient blip) — accept and let the per-link
      // failover sort out which CDN serves the stylesheet.
      cdnPref = 'google'
      GOOD.add(clean)
      persistCustoms()
      ensureFonts([clean])
      return { ok: true, name: clean }
    }
  } catch { /* unreachable */ }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { ok: false, error: 'You look offline — reconnect and retry, or pick a System font below (works offline).' }
  }
  return { ok: false, error: 'Could not reach Google Fonts or its mirror — check connection/VPN/ad-blocker, or pick a System font below (works offline).' }
}

// System stacks render locally — never worth a webfont fetch, and asking
// document.fonts for them is harmless but wasted work.
const SYSTEM_FONTS = new Set(['arial', 'helvetica', 'georgia', 'times new roman', 'courier new', 'verdana', 'impact', 'trebuchet ms', 'comic sans ms', 'serif', 'sans-serif', 'monospace', 'system-ui', 'inherit'])

/** Webfont families actually used by scene layers (bare names, no system
 *  fonts). De-duplicated case-insensitively: css2 family names are exact,
 *  and one bad entry 400s the whole combined request. */
export function webFontFamilies(layers) {
  const seen = new Set()
  const out = []
  for (const l of layers || []) {
    const f = cleanFamily(l.fontFamily)
    if (!f || SYSTEM_FONTS.has(f.toLowerCase())) continue
    // Custom embedded fonts ride along as @font-face data URLs — a
    // non-Google family in a css2 request 400s the whole batch.
    if (l.fontUrl || fileFonts.has(f)) continue
    const k = f.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(f)
  }
  return out
}

/** Google Fonts CSS URL for an arbitrary family list (no catalog gate — the
 *  render path trusts scene values that were verified when picked). */
export function fontCssUrl(families) {
  const list = [...new Set((families || []).map(cleanFamily).filter(Boolean))]
  if (!list.length) return ''
  return `https://fonts.googleapis.com/css2?${list.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;700;800`).join('&')}&display=swap`
}

/** CSS font-family value for a catalog name. */
export function fontStack(name) {
  if (!name || /^inter/i.test(name)) return 'Inter, system-ui, sans-serif'
  return `'${name}', system-ui, sans-serif`
}

// ---- Custom (non-Google) fonts: 1001Fonts URLs and user font files. ----
// A custom font travels WITH the layer as a data: URL (layer.fontUrl), so
// preview, history, saved scenes and the headless MP4 export all resolve
// the same file with no extra download step at render time.
const CUSTOM_FILES_KEY = 'vectorstudio.fonts.files.v1'
const fileFonts = new Map()
try {
  const saved = JSON.parse(localStorage.getItem(CUSTOM_FILES_KEY) || '[]')
  if (Array.isArray(saved)) for (const e of saved) {
    const n = cleanFamily(e?.name)
    if (n && typeof e?.dataUrl === 'string' && e.dataUrl.startsWith('data:')) fileFonts.set(n, e.dataUrl)
  }
} catch { /* ignore */ }
function persistFileFonts() {
  try {
    localStorage.setItem(CUSTOM_FILES_KEY, JSON.stringify([...fileFonts.entries()].map(([name, dataUrl]) => ({ name, dataUrl })).slice(-12)))
  } catch { /* quota: layers still carry their own fontUrl */ }
}
const customStyleId = (name) => `vs-customfont-${cleanFamily(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
/** Inject (or refresh) the @font-face for one custom family. Same helper
 *  in the preview page and the headless render — both paths stay in sync. */
export function injectCustomFont(name, dataUrl) {
  const fam = cleanFamily(name)
  if (!fam || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return false
  try {
    const id = customStyleId(fam)
    let el = document.getElementById(id)
    if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el) }
    el.textContent = `@font-face{font-family:'${fam.replace(/'/g, "\\'")}';src:url(${dataUrl});font-weight:400 800;font-style:normal;font-display:swap;}`
    return true
  } catch { return false }
}
/** Remember a custom font (persisted library + injected now). */
export function registerCustomFont(name, dataUrl) {
  const fam = cleanFamily(name)
  if (!fam || !injectCustomFont(fam, dataUrl)) return false
  fileFonts.set(fam, dataUrl)
  persistFileFonts()
  return true
}
/** data: URL for a custom family from the persisted library. */
export function customFontUrl(name) {
  return fileFonts.get(cleanFamily(name)) || ''
}
/** Inject @font-face rules for every custom-font layer in a scene. */
export function ensureCustomFonts(layers) {
  try {
    for (const l of layers || []) {
      const fam = cleanFamily(l?.fontFamily)
      const url = l?.fontUrl || fileFonts.get(fam)
      if (fam && url) injectCustomFont(fam, url)
    }
  } catch { /* ignore */ }
}
/** Re-inject the persisted custom library (call once on boot). */
export function restoreCustomFonts() {
  try { for (const [name, url] of fileFonts) injectCustomFont(name, url) } catch { /* ignore */ }
}
/** Layers carrying their own font file (rendered via @font-face, never via
 *  a Google css2 request). */
export function customFontFaces(layers) {
  const out = []
  const seen = new Set()
  for (const l of layers || []) {
    const fam = cleanFamily(l?.fontFamily)
    const url = l?.fontUrl || fileFonts.get(fam)
    if (!fam || !url || seen.has(fam.toLowerCase())) continue
    seen.add(fam.toLowerCase())
    out.push({ name: fam, url })
  }
  return out
}
/** Fetch a 1001Fonts page (or direct font-file) URL via the backend, which
 *  downloads/extracts server-side (no browser CORS) and returns a data URL. */
export async function fetchCustomFontFromUrl(url) {
  const u = String(url || '').trim()
  if (!u) return { ok: false, error: 'Paste a 1001Fonts URL first.' }
  let res
  try {
    res = await fetch('/api/fetchfont', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u }) })
  } catch { return { ok: false, error: 'Backend unreachable — restart the app and retry.' } }
  let body = {}
  try { body = await res.json() } catch { /* fall through */ }
  if (!res.ok || !body.ok) {
    const err = body.error || `Font fetch failed (HTTP ${res.status}).`
    // The backend only answers /api/fetchfont after a restart that picks up
    // the font endpoint — without it every fetch 404s as "Unknown route.".
    if (/unknown route/i.test(err)) {
      return { ok: false, error: 'App backend is out of date — stop the app completely and run start.bat again, then retry the font fetch.' }
    }
    return { ok: false, error: err }
  }
  if (!registerCustomFont(body.name, body.dataUrl)) return { ok: false, error: 'Downloaded the font but the browser refused it — try the file upload instead.' }
  warmFont(body.name)
  return { ok: true, name: body.name, dataUrl: body.dataUrl }
}
