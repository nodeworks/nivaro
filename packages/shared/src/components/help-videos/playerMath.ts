import {
  cropOf,
  editedDuration,
  outroMs,
  segmentIndexAt,
  sourceToEdited,
  zoomInView,
  zoomRectAt
} from './edits'
import type { Rect, VideoEdits } from './types'

// The live player's arithmetic, kept pure so it can be tested in node.

export function fitFrame(
  cw: number,
  ch: number,
  vw: number,
  vh: number
): { left: number; top: number; width: number; height: number } {
  if (!cw || !ch || !vw || !vh) return { left: 0, top: 0, width: cw, height: ch }
  const scale = Math.min(cw / vw, ch / vh)
  const width = vw * scale
  const height = vh * scale
  return { left: (cw - width) / 2, top: (ch - height) / 2, width, height }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)
/** The rendered file's size for a recording: the server's outputSize
 *  (api/src/services/help-video-render-plan.ts), fit within 1920x1080, even sides. */
export function renderSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, 1920 / width, 1080 / height)
  return { width: even(width * scale), height: even(height * scale) }
}

/** The render's sizes for a recording and crop (the server's renderSizes):
 *  `work` is the frame blurs and annotations are drawn on, `out` the finished
 *  file (the cropped picture, cards, banners). Without a crop both are
 *  renderSize. */
export function renderSizes(
  width: number,
  height: number,
  crop: Rect | null | undefined
): { work: { width: number; height: number }; out: { width: number; height: number } } {
  if (!crop) {
    const o = renderSize(width, height)
    return { work: o, out: o }
  }
  const scale = Math.min(1, 1920 / (crop.w * width), 1080 / (crop.h * height))
  const work = { width: even(width * scale), height: even(height * scale) }
  // the server's pixelRect sides
  const w = Math.min(even(crop.w * work.width), work.width)
  const h = Math.min(even(crop.h * work.height), work.height)
  return { work, out: { width: w, height: h } }
}

/** ffmpeg's boxblur (radius r) looks about as soft as a CSS blur of r / 1.7. */
const BOX_TO_CSS_BLUR = 1.7
/** The CSS blur radius (frame pixels) that looks like the render's blur box.
 *  Same radius rule as the render plan: the box is at least 4×4 output
 *  pixels and the radius is at most a quarter of its smaller side, minus 1. */
export function liveBlurPx(
  strength: number,
  rect: { w: number; h: number },
  canvas: { width: number; height: number },
  frameWidth: number
): number {
  const w = Math.max(4, even(rect.w * canvas.width))
  const h = Math.max(4, even(rect.h * canvas.height))
  const r = Math.max(1, Math.min(strength, Math.floor(Math.min(w, h) / 4) - 1))
  const k = canvas.width ? frameWidth / canvas.width : 1
  return (r * k) / BOX_TO_CSS_BLUR
}

/** Zoom inside the (cropped) picture as CSS: transform-origin 0 0,
 *  translate(tx·100%, ty·100%) scale(z). Same maths as the render's crop:
 *  offset = clamp(0.5 − centre·z, 1 − z, 0). Zoom rects are mapped into the
 *  crop first (zoomInView), as the render does; a moving zoom's area at this
 *  moment comes from its stops (zoomRectAt, #1539). */
export function zoomAt(e: VideoEdits, srcMs: number): { z: number; tx: number; ty: number } {
  for (const zm of e.zooms) {
    if (srcMs < zm.start_ms || srcMs > zm.end_ms) continue
    const p =
      zm.ease_ms > 0
        ? clamp(
            Math.min((srcMs - zm.start_ms) / zm.ease_ms, (zm.end_ms - srcMs) / zm.ease_ms),
            0,
            1
          )
        : 1
    const v = zoomInView(e, zoomRectAt(zm, srcMs))
    const z = 1 + (v.mag - 1) * p
    const cx = 0.5 + (v.cx - 0.5) * p
    const cy = 0.5 + (v.cy - 0.5) * p
    return { z, tx: clamp(0.5 - cx * z, 1 - z, 0), ty: clamp(0.5 - cy * z, 1 - z, 0) }
  }
  return { z: 1, tx: 0, ty: 0 }
}

/** What the viewer sees at a moment: crop, then zoom. A point at fraction p
 *  of the whole recorded frame shows at fraction (p·sx + ox, p·sy + oy) of
 *  the picture; `z` is the uniform scale the whole frame is drawn at, in
 *  units of the picture (a frame without a crop or zoom: z 1, offsets 0). */
export interface View {
  z: number
  sx: number
  sy: number
  ox: number
  oy: number
}
export function viewAt(e: VideoEdits, srcMs: number): View {
  const c = cropOf(e)
  const { z, tx, ty } = zoomAt(e, srcMs)
  return { z, sx: z / c.w, sy: z / c.h, ox: tx - (c.x * z) / c.w, oy: ty - (c.y * z) / c.h }
}
export const NO_VIEW: View = { z: 1, sx: 1, sy: 1, ox: 0, oy: 0 }

const LOOKAHEAD_MS = 40 // jump a frame early so the cut part never flashes

export function liveStep(
  e: VideoEdits,
  srcMs: number
):
  | { action: 'play'; rate: number }
  | { action: 'seek'; toMs: number; rate: number }
  | { action: 'end' } {
  const i = segmentIndexAt(e, srcMs)
  if (i >= 0) {
    const s = e.segments[i]
    if (s.end_ms - srcMs > LOOKAHEAD_MS) return { action: 'play', rate: s.speed }
    const next = e.segments[i + 1]
    return next ? { action: 'seek', toMs: next.start_ms, rate: next.speed } : { action: 'end' }
  }
  const next = e.segments.find((s) => s.start_ms > srcMs)
  return next ? { action: 'seek', toMs: next.start_ms, rate: next.speed } : { action: 'end' }
}

export function resolveDurationMs(videoDuration: number, fallbackMs: number | null): number {
  return Number.isFinite(videoDuration) && videoDuration > 0
    ? Math.round(videoDuration * 1000)
    : Math.max(0, fallbackMs ?? 0)
}

export function bucketIndex(editedMs: number, totalMs: number): number {
  if (!totalMs) return 0
  return clamp(Math.floor((editedMs / totalMs) * 20), 0, 19)
}

export function activeAt<T extends { start_ms: number; end_ms: number }>(
  items: T[],
  srcMs: number
): T[] {
  return items.filter((x) => srcMs >= x.start_ms && srcMs <= x.end_ms)
}

/**
 * Where in the playing FILE a source moment sits. The source file runs on
 * recording time; a rendered file runs on edited time (intro card, cuts and
 * speed changes already applied), so a chapter's source moment has to be
 * mapped first. A moment that was cut out lands on the next kept frame.
 */
export function fileMsForSource(
  e: VideoEdits | null | undefined,
  rendered: boolean,
  srcMs: number
): number {
  if (!rendered || !e) return srcMs
  const exact = sourceToEdited(e, srcMs)
  if (exact !== null) return exact
  const next = e.segments.find((s) => s.start_ms >= srcMs)
  if (next) return sourceToEdited(e, next.start_ms) ?? srcMs
  return editedDuration(e) - outroMs(e)
}
