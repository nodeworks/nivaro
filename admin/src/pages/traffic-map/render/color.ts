// #2279 — CSS colours (the --tm-* tokens) as RGBA floats for WebGL. The tokens are whatever the
// theme sets (hex, rgb(), rgba(), and anything else the browser understands), so a parse the
// renderer cannot do by hand goes through a 2D canvas, which normalises any CSS colour.

/** Straight (not premultiplied) red, green, blue, alpha in 0..1. */
export type RGBA = [number, number, number, number]

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

/** Hex (#rgb, #rgba, #rrggbb, #rrggbbaa) and rgb()/rgba() with commas or spaces; else null. */
export function parseCssColor(input: string): RGBA | null {
  const s = input.trim().toLowerCase()
  if (s === 'transparent') return [0, 0, 0, 0]
  if (s.startsWith('#')) {
    const h = s.slice(1)
    if (!/^[0-9a-f]+$/.test(h)) return null
    const n = (i: number, len: number) => parseInt(h.slice(i, i + len), 16)
    if (h.length === 3 || h.length === 4) {
      const v = [...h].map((c) => parseInt(c + c, 16) / 255)
      return [v[0], v[1], v[2], h.length === 4 ? v[3] : 1]
    }
    if (h.length === 6 || h.length === 8)
      return [n(0, 2) / 255, n(2, 2) / 255, n(4, 2) / 255, h.length === 8 ? n(6, 2) / 255 : 1]
    return null
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(s)
  if (!m) return null
  const parts = m[1]
    .split(/[\s,/]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length < 3) return null
  const ch = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p))
  const rgb = parts.slice(0, 3).map(ch)
  if (rgb.some((v) => !Number.isFinite(v))) return null
  const a =
    parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : +parts[3]
  return [
    clamp01(rgb[0] / 255),
    clamp01(rgb[1] / 255),
    clamp01(rgb[2] / 255),
    clamp01(Number.isFinite(a) ? a : 1)
  ]
}

/**
 * A cached parser for any CSS colour: by hand first, then the browser's own normalisation
 * (a 2D canvas fillStyle), then one painted pixel. Unknown colours read as opaque black.
 */
export function makeColorParser(): (css: string) => RGBA {
  const cache = new Map<string, RGBA>()
  let ctx: CanvasRenderingContext2D | null | undefined
  const canvasCtx = () => {
    if (ctx !== undefined) return ctx
    try {
      const c = document.createElement('canvas')
      c.width = 1
      c.height = 1
      ctx = c.getContext('2d', { willReadFrequently: true })
    } catch {
      ctx = null
    }
    return ctx
  }
  return (css: string) => {
    const hit = cache.get(css)
    if (hit) return hit
    let out = parseCssColor(css)
    if (!out) {
      const c = canvasCtx()
      if (c) {
        try {
          c.fillStyle = '#000000'
          c.fillStyle = css
          const norm = String(c.fillStyle)
          out = parseCssColor(norm)
          if (!out) {
            c.clearRect(0, 0, 1, 1)
            c.fillRect(0, 0, 1, 1)
            const d = c.getImageData(0, 0, 1, 1).data
            out = d[3] ? [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255] : [0, 0, 0, 0]
          }
        } catch {
          out = null
        }
      }
    }
    const v = out ?? [0, 0, 0, 1]
    if (cache.size < 500) cache.set(css, v)
    return v
  }
}
