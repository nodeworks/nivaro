import { EDIT_LIMITS, type ListKey, newId, upsertItemChecked } from '../edits'
import type { Annotation, Blur, Point, Rect, VideoEdits, Zoom } from '../types'
import type { Selection } from './timeline/Lanes'

// The editor's drawing tools, kept pure. Rects and points are frame
// fractions (0–1), the same space the render uses.

export type Tool = 'callout' | 'arrow' | 'box' | 'ripple' | 'zoom' | 'blur'
const DEFAULT_MS = 3000
const RIPPLE_MS = 900
/** A ripple already within this of a click stands for it. */
const SAME_CLICK_MS = 300
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const r3 = (n: number) => Math.round(n * 1000) / 1000

/** The rectangle a drag from `a` to `b` spans, in either direction; never
 *  narrower than 0.02 a side, and inside the frame. */
export function rectFromPoints(a: Point, b: Point): Rect {
  const x = clamp(Math.min(a.x, b.x), 0, 0.98)
  const y = clamp(Math.min(a.y, b.y), 0, 0.98)
  const w = Math.max(0.02, Math.abs(a.x - b.x))
  const h = Math.max(0.02, Math.abs(a.y - b.y))
  return { x: r3(x), y: r3(y), w: r3(Math.min(w, 1 - x)), h: r3(Math.min(h, 1 - y)) }
}

/** A zoom's square (in frame fractions, so it keeps the frame's shape):
 *  the longer side, at least the smallest zoom the server keeps (0.25, 4×),
 *  anchored at the top-left corner and moved back inside the frame. The
 *  server's normalizeEdits leaves the result exactly as it is. */
export function squareRect(r: Rect): Rect {
  const side = r3(clamp(Math.max(r.w, r.h), EDIT_LIMITS.zoomMinSide, 1))
  const inside = (v: number) => Math.min(r3(clamp(v, 0, 1 - side)), 1 - side)
  return { x: inside(r.x), y: inside(r.y), w: side, h: side }
}

/** Default shapes for a click (no drag), centred on it. */
const CLICK_SIZE: Record<Tool, { w: number; h: number }> = {
  callout: { w: 0.22, h: 0.08 },
  box: { w: 0.24, h: 0.14 },
  ripple: { w: 0.05, h: 0.05 },
  blur: { w: 0.2, h: 0.1 },
  zoom: { w: 0.4, h: 0.4 },
  arrow: { w: 0.02, h: 0.02 }
}
export function clickRect(tool: Tool, p: Point): Rect {
  const { w, h } = CLICK_SIZE[tool]
  const r = {
    x: r3(clamp(p.x - w / 2, 0, 1 - w)),
    y: r3(clamp(p.y - h / 2, 0, 1 - h)),
    w,
    h
  }
  return tool === 'zoom' ? squareRect(r) : r
}

/** A clicked arrow points AT the click; its tail sits a little way off
 *  toward the middle of the frame (up and left from the middle itself). */
export function arrowTailFor(tip: Point): Point {
  const dx = 0.5 - tip.x
  const dy = 0.5 - tip.y
  const len = Math.hypot(dx, dy)
  const [ux, uy] = len < 0.05 ? [-Math.SQRT1_2, -Math.SQRT1_2] : [dx / len, dy / len]
  return { x: r3(clamp(tip.x + ux * 0.14, 0, 0.98)), y: r3(clamp(tip.y + uy * 0.14, 0, 0.98)) }
}

/** A new item for a tool, starting at the playhead: 3 seconds long (a
 *  ripple 0.9 s), cut short by the end of the recording. */
export function newItemFor(
  tool: Tool,
  rect: Rect,
  srcMs: number,
  sourceMs: number,
  arrowTo?: Point
): { key: ListKey; item: Annotation | Zoom | Blur } {
  const start = Math.round(clamp(srcMs, 0, Math.max(0, sourceMs - EDIT_LIMITS.minItemMs)))
  const end = Math.round(Math.min(sourceMs, start + DEFAULT_MS))
  if (tool === 'zoom')
    return {
      key: 'zooms',
      item: { id: newId(), start_ms: start, end_ms: end, rect: squareRect(rect), ease_ms: 400 }
    }
  if (tool === 'blur')
    return { key: 'blurs', item: { id: newId(), start_ms: start, end_ms: end, rect, strength: 12 } }
  return {
    key: 'annotations',
    item: {
      id: newId(),
      type: tool,
      start_ms: start,
      end_ms: tool === 'ripple' ? Math.min(sourceMs, start + RIPPLE_MS) : end,
      rect,
      to: tool === 'arrow' ? (arrowTo ?? { x: rect.x + rect.w, y: rect.y + rect.h }) : null,
      text: tool === 'callout' ? 'Click here' : '',
      tone: 'accent'
    }
  }
}

/**
 * One ripple per recorded click: 0.9 s, a 0.05-wide square centred on the
 * click. A click that already has a ripple starting within 0.3 s of it is
 * skipped, so adding them twice adds nothing. `clicks` is null when the
 * recorder didn't capture clicks and [] when none were made; both give [].
 * With `sourceMs`, ripples stop at the end of the recording and any left
 * shorter than 0.2 s are dropped.
 */
export function clicksToRipples(
  clicks: Array<{ t_ms: number; x: number; y: number }> | null,
  existing: Annotation[],
  sourceMs?: number
): Annotation[] {
  if (!clicks?.length) return []
  const starts = existing.filter((a) => a.type === 'ripple').map((a) => a.start_ms)
  const out: Annotation[] = []
  for (const c of [...clicks].sort((a, b) => a.t_ms - b.t_ms)) {
    const start = Math.round(c.t_ms)
    if (starts.some((s) => Math.abs(s - start) <= SAME_CLICK_MS)) continue
    const end = Math.min(sourceMs ?? Number.POSITIVE_INFINITY, start + RIPPLE_MS)
    if (end - start < EDIT_LIMITS.minItemMs) continue
    starts.push(start)
    out.push({
      id: newId(),
      type: 'ripple',
      start_ms: start,
      end_ms: end,
      rect: {
        x: r3(clamp(c.x - 0.025, 0, 0.95)),
        y: r3(clamp(c.y - 0.025, 0, 0.95)),
        w: 0.05,
        h: 0.05
      },
      to: null,
      text: '',
      tone: 'accent'
    })
  }
  return out
}

/**
 * Type-along captioning: a caption starts at the playhead and runs 3 s, or
 * until the next caption or the end of the recording. The caption showing
 * at the playhead ends there. Refused (edits unchanged, with the reason)
 * when that would leave either one shorter than 0.2 s.
 */
export function typeAlongCaptionChecked(
  edits: VideoEdits,
  srcMs: number,
  text: string,
  sourceMs?: number
): { edits: VideoEdits; refused?: string } {
  const at = Math.round(srcMs)
  let e = edits
  const open = edits.captions.find((c) => at > c.start_ms && at < c.end_ms)
  if (open) {
    if (at - open.start_ms < EDIT_LIMITS.minItemMs)
      return {
        edits,
        refused: 'Let the caption before this one show for at least 0.2 seconds first'
      }
    const closed = upsertItemChecked(e, 'captions', { ...open, end_ms: at })
    if (closed.refused) return { edits, refused: closed.refused }
    e = closed.edits
  }
  const next = Math.min(
    ...e.captions.filter((c) => c.start_ms >= at).map((c) => c.start_ms),
    Number.POSITIVE_INFINITY
  )
  const last = sourceMs ?? Number.POSITIVE_INFINITY
  const end = Math.min(at + DEFAULT_MS, next, last)
  if (end - at < EDIT_LIMITS.minItemMs)
    return {
      edits,
      refused:
        next <= last
          ? 'The next caption starts too soon after the playhead to fit another one'
          : 'The recording ends too soon after the playhead to fit a caption'
    }
  const added = upsertItemChecked(e, 'captions', { id: newId(), start_ms: at, end_ms: end, text })
  return added.refused ? { edits, refused: added.refused } : added
}

/** typeAlongCaptionChecked without the reason: refused returns `edits`. */
export function typeAlongCaption(edits: VideoEdits, srcMs: number, text: string): VideoEdits {
  return typeAlongCaptionChecked(edits, srcMs, text).edits
}

export type ReshapeMode = 'move' | 'resize' | 'tail' | 'tip'
const inside = (v: number, size: number) => Math.min(r3(clamp(v, 0, 1 - size)), 1 - size)
const clamp01 = (v: number) => r3(clamp(v, 0, 1))

/**
 * A shape moved or stretched by (dx, dy) frame fractions, kept inside the
 * frame: `move` the whole shape (an arrow keeps its shape), `resize` from
 * the bottom-right corner (never below 0.02 a side; a zoom stays square and
 * at least the smallest zoom), or one end of an arrow (`tail`, `tip`).
 */
export function reshapeItem<T extends { rect: Rect; to?: Point | null }>(
  item: T,
  lane: 'annotations' | 'zooms' | 'blurs',
  mode: ReshapeMode,
  dx: number,
  dy: number
): T {
  const r = item.rect
  const to = item.to ?? null
  if (mode === 'tip')
    return to ? { ...item, to: { x: clamp01(to.x + dx), y: clamp01(to.y + dy) } } : item
  if (mode === 'tail' || (mode === 'move' && !to)) {
    return { ...item, rect: { ...r, x: inside(r.x + dx, r.w), y: inside(r.y + dy, r.h) } }
  }
  if (mode === 'move' && to) {
    // Both ends move together, only as far as the nearer edge allows.
    const mx = clamp(dx, Math.max(-r.x, -to.x), Math.min(1 - r.w - r.x, 1 - to.x))
    const my = clamp(dy, Math.max(-r.y, -to.y), Math.min(1 - r.h - r.y, 1 - to.y))
    return {
      ...item,
      rect: { ...r, x: inside(r.x + mx, r.w), y: inside(r.y + my, r.h) },
      to: { x: clamp01(to.x + mx), y: clamp01(to.y + my) }
    }
  }
  if (lane === 'zooms') {
    // One side for both: whichever way the corner moved further.
    const d = Math.abs(dx) >= Math.abs(dy) ? dx : dy
    return { ...item, rect: squareRect({ ...r, w: r.w + d, h: r.h + d }) }
  }
  return {
    ...item,
    rect: {
      ...r,
      w: r3(clamp(r.w + dx, 0.02, 1 - r.x)),
      h: r3(clamp(r.h + dy, 0.02, 1 - r.y))
    }
  }
}

/** What the preview plays: while a zoom is selected it shows the whole
 *  picture (that zoom left out), so the zoom's area can be seen and placed. */
export function editsForPreview(edits: VideoEdits, selection: Selection): VideoEdits {
  if (selection?.lane !== 'zooms') return edits
  const id = selection.id
  return edits.zooms.some((z) => z.id === id)
    ? { ...edits, zooms: edits.zooms.filter((z) => z.id !== id) }
    : edits
}
