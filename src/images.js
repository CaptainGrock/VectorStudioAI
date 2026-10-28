// Attached images: downscaled dataURLs so scenes stay self-contained
// (export/history/localStorage) without blowing quotas. PNG keeps alpha,
// so transparent PNGs composite over the scene or background image.
const MAX_DIM = 1280
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']

export function isImageFile(name) {
  const n = String(name || '').toLowerCase()
  return IMAGE_EXTS.some((ext) => n.endsWith(ext))
}

export async function processImageFile(file) {
  const buf = await file.arrayBuffer()
  const blob = new Blob([buf], { type: file.type || 'image/png' })
  let bmp = null
  try { bmp = await createImageBitmap(blob) } catch { bmp = null }
  if (!bmp) {
    // SVG or undecodable: embed the original and let the browser render it.
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(r.result)
      r.onerror = rej
      r.readAsDataURL(file)
    })
    return { id: `img_${Date.now().toString(36)}`, name: file.name || 'image', dataUrl, width: 800, height: 600 }
  }
  const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h)
  if (typeof bmp.close === 'function') bmp.close()
  const n = String(file.name || '').toLowerCase()
  const keepAlpha = n.endsWith('.png') || n.endsWith('.webp') || n.endsWith('.gif') || String(file.type || '').includes('png')
  const dataUrl = canvas.toDataURL(keepAlpha ? 'image/png' : 'image/jpeg', 0.85)
  return { id: `img_${Date.now().toString(36)}`, name: file.name || 'image', dataUrl, width: w, height: h }
}
