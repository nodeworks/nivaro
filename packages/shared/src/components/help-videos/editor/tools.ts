import { EDIT_LIMITS, type ListKey, newId, textDurationMs, upsertItemChecked } from '../edits'
import type { Annotation, Blur, Point, RecordedClick, Rect, VideoEdits, Zoom } from '../types'
import type { Selection } from './timeline/Lanes'

// The editor's drawing tools, kept pure. Rects and points are frame
// fractions (0–1), the same space the render uses.

export type Tool =
  | 'callout'
  | 'step'
  | 'arrow'
  | 'box'
  | 'spotlight'
  | 'ripple'
  | 'zoom'
  | 'blur'
  | 'crop'
/** The tools that draw a timed item (everything but the crop). */
export type ItemTool = Exclude<Tool, 'crop'>
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
const CLICK_SIZE: Record<ItemTool, { w: number; h: number }> = {
  callout: { w: 0.22, h: 0.08 },
  step: { w: 0.22, h: 0.08 },
  spotlight: { w: 0.3, h: 0.2 },
  box: { w: 0.24, h: 0.14 },
  ripple: { w: 0.05, h: 0.05 },
  blur: { w: 0.2, h: 0.1 },
  zoom: { w: 0.4, h: 0.4 },
  arrow: { w: 0.02, h: 0.02 }
}
export function clickRect(tool: ItemTool, p: Point): Rect {
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
 *  ripple 0.9 s; a callout or step as long as its text needs, see
 *  textDurationMs), cut short by the end of the recording. A callout or step
 *  keeps following its text's length while it is typed (markAutoLength). */
export function newItemFor(
  tool: ItemTool,
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
  const text = tool === 'callout' ? 'Click here' : ''
  const byText = tool === 'callout' || tool === 'step'
  const item: Annotation = {
    id: newId(),
    type: tool,
    start_ms: start,
    end_ms:
      tool === 'ripple'
        ? Math.min(sourceMs, start + RIPPLE_MS)
        : byText
          ? Math.round(Math.min(sourceMs, start + textDurationMs(text)))
          : end,
    rect,
    to: tool === 'arrow' ? (arrowTo ?? { x: rect.x + rect.w, y: rect.y + rect.h }) : null,
    text,
    tone: 'accent'
  }
  if (byText) markAutoLength(item)
  return { key: 'annotations', item }
}

// Length from text (#1554). A callout, step or caption made in this editor
// session follows its text's reading time (textDurationMs) while it is typed,
// until the author sets its length by hand: the length it was last given here
// is remembered, and once the item's length is anything else (a timeline
// drag, a typed end time, undo) it stops for good. Items from earlier
// sessions never change length on their own.
const autoLength = new Map<string, number>()
export function markAutoLength(item: { id: string; start_ms: number; end_ms: number }): void {
  autoLength.set(item.id, item.end_ms - item.start_ms)
}
export function isAutoLength(item: { id: string; start_ms: number; end_ms: number }): boolean {
  return autoLength.get(item.id) === item.end_ms - item.start_ms
}
/** The item with new text; still following its text, also the length that
 *  text needs (never past `maxEnd`). */
export function withTypedText<T extends { id: string; start_ms: number; end_ms: number }>(
  item: T,
  text: string,
  maxEnd: number
): T & { text: string } {
  if (!isAutoLength(item)) {
    autoLength.delete(item.id)
    return { ...item, text }
  }
  const end = Math.round(Math.min(maxEnd, item.start_ms + textDurationMs(text)))
  if (end - item.start_ms < EDIT_LIMITS.minItemMs) return { ...item, text }
  autoLength.set(item.id, end - item.start_ms)
  return { ...item, text, end_ms: end }
}
/** Seconds a text needs when the item is shorter than that (else null). */
export function shortForText(item: {
  start_ms: number
  end_ms: number
  text: string
}): number | null {
  if (!item.text.trim()) return null
  const need = textDurationMs(item.text)
  return item.end_ms - item.start_ms < need ? need : null
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
  clicks: RecordedClick[] | null,
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
 * The recorded click a ripple stands for: one within SAME_CLICK_MS of its
 * start whose point lies on (or right next to) the ripple. Null when none,
 * or the ripple is not one.
 */
export function clickForRipple(
  a: Pick<Annotation, 'type' | 'start_ms' | 'rect'>,
  clicks: RecordedClick[] | null | undefined
): RecordedClick | null {
  if (a.type !== 'ripple' || !clicks?.length) return null
  const cx = a.rect.x + a.rect.w / 2
  const cy = a.rect.y + a.rect.h / 2
  let best: { c: RecordedClick; d: number } | null = null
  for (const c of clicks) {
    if (Math.abs(c.t_ms - a.start_ms) > SAME_CLICK_MS) continue
    const d = Math.hypot(c.x - cx, c.y - cy)
    if (d > 0.06) continue
    if (!best || d < best.d) best = { c, d }
  }
  return best?.c ?? null
}

/** "Approve (button)": what a labelled click hit, or null without a label. */
export function clickTargetText(c: RecordedClick | null): string | null {
  if (!c?.label) return null
  return c.role ? `${c.label} (${c.role})` : c.label
}

/**
 * Type-along captioning: a caption starts at the playhead and runs as long as
 * its text needs (textDurationMs), or until the next caption or the end of
 * the recording. Every caption showing
 * at the playhead ends there (they can overlap). Refused (edits unchanged,
 * with the reason) when that would leave any of them shorter than 0.2 s.
 */
export function typeAlongCaptionChecked(
  edits: VideoEdits,
  srcMs: number,
  text: string,
  sourceMs?: number
): { edits: VideoEdits; refused?: string } {
  const at = Math.round(srcMs)
  let e = edits
  // Every caption showing at the playhead ends there (they can overlap).
  const open = edits.captions.filter((c) => at > c.start_ms && at < c.end_ms)
  if (open.some((c) => at - c.start_ms < EDIT_LIMITS.minItemMs))
    return {
      edits,
      refused: 'Let the caption before this one show for at least 0.2 seconds first'
    }
  for (const c of open) {
    const closed = upsertItemChecked(e, 'captions', { ...c, end_ms: at })
    if (closed.refused) return { edits, refused: closed.refused }
    e = closed.edits
  }
  const next = Math.min(
    ...e.captions.filter((c) => c.start_ms >= at).map((c) => c.start_ms),
    Number.POSITIVE_INFINITY
  )
  const last = sourceMs ?? Number.POSITIVE_INFINITY
  const end = Math.min(at + textDurationMs(text), next, last)
  if (end - at < EDIT_LIMITS.minItemMs)
    return {
      edits,
      refused:
        next <= last
          ? 'The next caption starts too soon after the playhead to fit another one'
          : 'The recording ends too soon after the playhead to fit a caption'
    }
  const caption = { id: newId(), start_ms: at, end_ms: end, text }
  const added = upsertItemChecked(e, 'captions', caption)
  if (added.refused) return { edits, refused: added.refused }
  markAutoLength(caption)
  return added
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
 *  picture (that zoom left out), so the zoom's area can be seen and placed;
 *  with the crop tool up, the whole recorded frame (no crop, no zoom), so a
 *  new crop can be drawn over all of it. */
export function editsForPreview(
  edits: VideoEdits,
  selection: Selection,
  tool?: Tool | null
): VideoEdits {
  if (tool === 'crop') {
    const { crop: _drop, ...rest } = edits
    return { ...rest, zooms: [] } as VideoEdits
  }
  if (selection?.lane !== 'zooms') return edits
  const id = selection.id
  return edits.zooms.some((z) => z.id === id)
    ? { ...edits, zooms: edits.zooms.filter((z) => z.id !== id) }
    : edits
}
