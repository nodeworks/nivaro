import type {
  Annotation,
  Blur,
  Caption,
  Chapter,
  Point,
  Rect,
  Speed,
  VideoEdits,
  Zoom
} from './types'

// Client twin of api/src/services/help-video-edits.ts (time mapping and
// EDIT_LIMITS) plus the editor's pure operations. The server's normalizeEdits
// is the source of truth; upsertItem applies its per-item rules (rect clamps,
// zoom squares, eases, strengths, text, minimum length, zoom overlap, list
// caps and sort order) so what the editor shows is what gets stored. Three
// things are left to the server on save, and can still change the copy:
// clamping times to the recording's length (the editor places items inside
// it), turning a blank chapter title into "Chapter", and dropping a caption
// whose text is blank.

export const ALLOWED_SPEEDS: Speed[] = [1, 1.5, 2, 4]
/** Same values as the server's EDIT_LIMITS — keep them in step. */
export const EDIT_LIMITS = {
  annotations: 200,
  zooms: 50,
  blurs: 50,
  chapters: 100,
  captions: 1000,
  text: 500,
  chapterTitle: 120,
  minKeptMs: 1000,
  minItemMs: 200,
  minSegmentMs: 100,
  /** Smallest zoom rect side (fraction of the frame): at most 4x magnification. */
  zoomMinSide: 0.25
} as const
export const MIN_KEPT_MS = EDIT_LIMITS.minKeptMs
const MIN_SEGMENT_MS = EDIT_LIMITS.minSegmentMs
export type ListKey = 'chapters' | 'annotations' | 'zooms' | 'blurs' | 'captions'

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export function newId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}
export function editedDuration(e: VideoEdits): number {
  return Math.round(e.segments.reduce((t, s) => t + (s.end_ms - s.start_ms) / s.speed, 0))
}
export function keptMs(e: VideoEdits): number {
  return e.segments.reduce((t, s) => t + (s.end_ms - s.start_ms), 0)
}
export function sourceToEdited(e: VideoEdits, ms: number): number | null {
  let acc = 0
  for (const s of e.segments) {
    if (ms >= s.start_ms && ms < s.end_ms) return Math.round(acc + (ms - s.start_ms) / s.speed)
    acc += (s.end_ms - s.start_ms) / s.speed
  }
  return null
}
export function editedToSource(e: VideoEdits, ms: number): number {
  let acc = 0
  for (const s of e.segments) {
    const len = (s.end_ms - s.start_ms) / s.speed
    if (ms < acc + len) return Math.round(s.start_ms + (ms - acc) * s.speed)
    acc += len
  }
  return e.segments.length ? e.segments[e.segments.length - 1].end_ms : 0
}
export function isHiddenByCuts(e: VideoEdits, start: number, end: number): boolean {
  return !e.segments.some((s) => start < s.end_ms && end > s.start_ms)
}
export function segmentIndexAt(e: VideoEdits, srcMs: number): number {
  return e.segments.findIndex((s) => srcMs >= s.start_ms && srcMs < s.end_ms)
}
export function splitAt(e: VideoEdits, srcMs: number): VideoEdits {
  const i = segmentIndexAt(e, srcMs)
  if (i < 0) return e
  const s = e.segments[i]
  if (srcMs - s.start_ms < MIN_SEGMENT_MS || s.end_ms - srcMs < MIN_SEGMENT_MS) return e
  const segments = [...e.segments]
  segments.splice(i, 1, { ...s, end_ms: Math.round(srcMs) }, { ...s, start_ms: Math.round(srcMs) })
  return { ...e, segments }
}
export function removeSegment(
  e: VideoEdits,
  index: number
): { edits: VideoEdits; refused?: string } {
  const s = e.segments[index]
  if (!s) return { edits: e }
  if (keptMs(e) - (s.end_ms - s.start_ms) < MIN_KEPT_MS) {
    return { edits: e, refused: 'Keep at least one second of the recording' }
  }
  return { edits: { ...e, segments: e.segments.filter((_, i) => i !== index) } }
}
export function setSpeed(e: VideoEdits, index: number, speed: Speed): VideoEdits {
  return { ...e, segments: e.segments.map((s, i) => (i === index ? { ...s, speed } : s)) }
}
export function trimSegment(
  e: VideoEdits,
  index: number,
  patch: { start_ms?: number; end_ms?: number },
  sourceMs: number
): VideoEdits {
  const s = e.segments[index]
  if (!s) return e
  const prevEnd = index > 0 ? e.segments[index - 1].end_ms : 0
  const nextStart = index < e.segments.length - 1 ? e.segments[index + 1].start_ms : sourceMs
  let start = patch.start_ms ?? s.start_ms
  let end = patch.end_ms ?? s.end_ms
  start = Math.round(Math.max(prevEnd, Math.min(start, end - MIN_SEGMENT_MS)))
  end = Math.round(Math.min(nextStart, Math.max(end, start + MIN_SEGMENT_MS)))
  return {
    ...e,
    segments: e.segments.map((x, i) => (i === index ? { ...x, start_ms: start, end_ms: end } : x))
  }
}

type Item<K extends ListKey> = VideoEdits[K][number]

/** The server's rect(): sides at least 0.01 and at most 1, inside the frame. */
function clampRect(r: Rect): Rect {
  const w = clamp(r.w, 0.01, 1)
  const h = clamp(r.h, 0.01, 1)
  return { x: clamp(r.x, 0, 1 - w), y: clamp(r.y, 0, 1 - h), w, h }
}
const clampPoint = (p: Point): Point => ({ x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) })
const span = (s: { start_ms: number; end_ms: number }) => ({
  start_ms: Math.round(Math.max(0, s.start_ms)),
  end_ms: Math.round(Math.max(0, s.end_ms))
})

/** One item as normalizeEdits would store it (all but the source-length
 *  clamp, which the editor applies when it places an item). Chapter titles
 *  are cut to their limit but not trimmed, so typing a space still works;
 *  the server turns a blank title into "Chapter" when it saves. */
function normalizeItem<K extends ListKey>(key: K, item: Item<K>): Item<K> {
  if (key === 'chapters') {
    const c = item as Chapter
    return {
      ...c,
      at_ms: Math.round(Math.max(0, c.at_ms)),
      title: c.title.slice(0, EDIT_LIMITS.chapterTitle)
    } as Item<K>
  }
  if (key === 'zooms') {
    const z = item as Zoom
    const s = span(z)
    const r = clampRect(z.rect)
    const side = clamp(Math.max(r.w, r.h), EDIT_LIMITS.zoomMinSide, 1)
    const half = Math.floor((s.end_ms - s.start_ms) / 2)
    return {
      ...z,
      ...s,
      rect: { x: clamp(r.x, 0, 1 - side), y: clamp(r.y, 0, 1 - side), w: side, h: side },
      ease_ms: Math.round(clamp(z.ease_ms, 0, Math.max(0, half)))
    } as Item<K>
  }
  if (key === 'blurs') {
    const b = item as Blur
    return {
      ...b,
      ...span(b),
      rect: clampRect(b.rect),
      strength: Math.round(clamp(b.strength, 2, 40))
    } as Item<K>
  }
  if (key === 'annotations') {
    const a = item as Annotation
    const arrow = a.type === 'arrow'
    return {
      ...a,
      ...span(a),
      rect: clampRect(a.rect),
      to: arrow ? clampPoint(a.to ?? { x: 0.5, y: 0.5 }) : null,
      // only callouts and boxes carry text; the server stores '' for the rest
      text: a.type === 'callout' || a.type === 'box' ? a.text.slice(0, EDIT_LIMITS.text) : ''
    } as Item<K>
  }
  const c = item as Caption
  return { ...c, ...span(c), text: c.text.slice(0, EDIT_LIMITS.text) } as Item<K>
}

const startOf = (x: { start_ms?: number; at_ms?: number }) => x.start_ms ?? x.at_ms ?? 0
/** The lists the server stores sorted by start (annotations and blurs keep
 *  their order). */
const SORTED: ListKey[] = ['chapters', 'zooms', 'captions']

/** Add or replace an item by id, normalized the way the server's
 *  normalizeEdits would store it. Refused (edits unchanged, with the reason)
 *  when the server would drop the item: shorter than 0.2 seconds, a zoom
 *  overlapping another zoom, or a new item past the list cap. */
export function upsertItemChecked<K extends ListKey>(
  e: VideoEdits,
  key: K,
  item: Item<K>
): { edits: VideoEdits; refused?: string } {
  const list = e[key] as Array<{ id: string }>
  const next = normalizeItem(key, item)
  if (key !== 'chapters') {
    const s = next as { start_ms: number; end_ms: number }
    if (s.end_ms - s.start_ms < EDIT_LIMITS.minItemMs) {
      return { edits: e, refused: 'Make it at least 0.2 seconds long' }
    }
  }
  if (key === 'zooms') {
    const z = next as Zoom
    const clash = e.zooms.some(
      (o) => o.id !== z.id && z.start_ms < o.end_ms && z.end_ms > o.start_ms
    )
    if (clash) return { edits: e, refused: 'Zooms can’t overlap. Move it clear of the other zoom.' }
  }
  const i = list.findIndex((x) => x.id === item.id)
  if (i < 0 && list.length >= EDIT_LIMITS[key]) {
    return { edits: e, refused: `There can be at most ${EDIT_LIMITS[key]} of these` }
  }
  const out = i < 0 ? [...list, next] : list.map((x, j) => (j === i ? next : x))
  if (SORTED.includes(key)) {
    out.sort((a, b) => startOf(a as { start_ms?: number }) - startOf(b as { start_ms?: number }))
  }
  return { edits: { ...e, [key]: out } as VideoEdits }
}

/** upsertItemChecked without the reason: refused changes return `e` itself. */
export function upsertItem<K extends ListKey>(e: VideoEdits, key: K, item: Item<K>): VideoEdits {
  return upsertItemChecked(e, key, item).edits
}
export function removeItem(e: VideoEdits, key: ListKey, id: string): VideoEdits {
  return {
    ...e,
    [key]: (e[key] as Array<{ id: string }>).filter((x) => x.id !== id)
  } as VideoEdits
}
