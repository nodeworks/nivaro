import type { Blur, Chapter, Speed, VideoEdits, Zoom } from './types'

// Client twin of api/src/services/help-video-edits.ts (time mapping and
// EDIT_LIMITS) plus the editor's pure operations. The server normalizes
// whatever the editor sends; these keep the editor's working copy identical
// to what that normalization would produce, so a save never moves anything.

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

/** The server's per-item rules that the editor can break by dragging or
 *  typing: zoom rects are squares of side ≥ zoomMinSide inside the frame with
 *  an ease of at most half their length, blur strength is 2–40, and text and
 *  chapter titles are cut to their limits. */
function normalizeItem<K extends ListKey>(key: K, item: Item<K>): Item<K> {
  if (key === 'zooms') {
    const z = item as Zoom
    const side = clamp(Math.max(z.rect.w, z.rect.h), EDIT_LIMITS.zoomMinSide, 1)
    const half = Math.floor((z.end_ms - z.start_ms) / 2)
    return {
      ...z,
      rect: { x: clamp(z.rect.x, 0, 1 - side), y: clamp(z.rect.y, 0, 1 - side), w: side, h: side },
      ease_ms: Math.round(clamp(z.ease_ms, 0, Math.max(0, half)))
    } as Item<K>
  }
  if (key === 'blurs') {
    const b = item as Blur
    return { ...b, strength: Math.round(clamp(b.strength, 2, 40)) } as Item<K>
  }
  if (key === 'chapters') {
    const c = item as Chapter
    return { ...c, title: c.title.slice(0, EDIT_LIMITS.chapterTitle) } as Item<K>
  }
  const t = item as { text: string }
  return { ...item, text: t.text.slice(0, EDIT_LIMITS.text) } as Item<K>
}

/** Add or replace an item by id. A NEW item past the server's list cap is
 *  refused (the edits come back unchanged), since the server would drop it. */
export function upsertItem<K extends ListKey>(e: VideoEdits, key: K, item: Item<K>): VideoEdits {
  const list = e[key] as Array<{ id: string }>
  const next = normalizeItem(key, item)
  const i = list.findIndex((x) => x.id === item.id)
  if (i < 0 && list.length >= EDIT_LIMITS[key]) return e
  const out = i < 0 ? [...list, next] : list.map((x, j) => (j === i ? next : x))
  return { ...e, [key]: out } as VideoEdits
}
export function removeItem(e: VideoEdits, key: ListKey, id: string): VideoEdits {
  return {
    ...e,
    [key]: (e[key] as Array<{ id: string }>).filter((x) => x.id !== id)
  } as VideoEdits
}
