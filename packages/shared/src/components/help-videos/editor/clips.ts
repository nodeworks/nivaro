import { editedDuration, itemsOf, sourceToEdited } from '../edits'
import { CLIP_LIMITS, type ClipDto, type VideoEdits } from '../types'
import { type SelectedItem, type Selection, selectedItems } from './selection'

// Short clips and GIFs (#1562): the editor's side of choosing a range. Every
// range is EDITED time (what viewers see), which is what the server cuts.

export type ClipRange = { start_ms: number; end_ms: number }

export const clipClock = (ms: number) => {
  const s = Math.max(0, ms) / 1000
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`
}

/** A range held to the video and the clip length cap: it starts where asked
 *  (never before 0) and runs to `end`, the video's end or the cap, whichever
 *  comes first. Null when nothing of it is left. */
export function clampClipRange(r: ClipRange, totalMs: number): ClipRange | null {
  const start = Math.max(0, Math.round(r.start_ms))
  const end = Math.min(Math.round(r.end_ms), Math.round(totalMs), start + CLIP_LIMITS.maxMs)
  if (end - start < CLIP_LIMITS.minMs) return null
  return { start_ms: start, end_ms: end }
}

/** The chapter as a clip: from its start to the next chapter viewers see (or
 *  the end), capped. Null for a chapter inside a cut. */
export function clipRangeForChapter(edits: VideoEdits, chapterId: string): ClipRange | null {
  const c = edits.chapters.find((x) => x.id === chapterId)
  if (!c) return null
  const start = sourceToEdited(edits, c.at_ms)
  if (start === null) return null
  const starts = edits.chapters
    .map((x) => sourceToEdited(edits, x.at_ms))
    .filter((ms): ms is number => ms !== null && ms > start)
  const end = starts.length ? Math.min(...starts) : editedDuration(edits)
  return clampClipRange({ start_ms: start, end_ms: end }, editedDuration(edits))
}

/** The selection as a clip: a piece at its speed, a timed item's span, or a
 *  chapter. Null when nothing useful is selected or it is cut out. */
export function clipRangeForSelection(edits: VideoEdits, selection: Selection): ClipRange | null {
  if (!selection) return null
  const total = editedDuration(edits)
  if (selection.lane === 'cuts') {
    const s = edits.segments[selection.index]
    if (!s) return null
    const start = sourceToEdited(edits, s.start_ms)
    if (start === null) return null
    return clampClipRange(
      { start_ms: start, end_ms: start + (s.end_ms - s.start_ms) / s.speed },
      total
    )
  }
  // Several items (#1543): from the first one's start to the last one's end.
  const ranges = selectedItems(selection)
    .map((item) => itemRange(edits, item))
    .filter((r): r is ClipRange => r !== null)
  if (!ranges.length) return null
  return clampClipRange(
    {
      start_ms: Math.min(...ranges.map((r) => r.start_ms)),
      end_ms: Math.max(...ranges.map((r) => r.end_ms))
    },
    total
  )
}

/** One item's span in edited time: a chapter's clip, a held frame's hold, or
 *  the first and last kept moment of a timed item. */
function itemRange(edits: VideoEdits, sel: SelectedItem): ClipRange | null {
  if (sel.lane === 'chapters') return clipRangeForChapter(edits, sel.id)
  if (sel.lane === 'holds') {
    const h = itemsOf(edits, 'holds').find((x) => x.id === sel.id)
    if (!h) return null
    const start = sourceToEdited(edits, h.at_ms)
    return start === null ? null : { start_ms: start, end_ms: start + h.hold_ms }
  }
  const item = (
    itemsOf(edits, sel.lane) as Array<{ id: string; start_ms: number; end_ms: number }>
  ).find((x) => x.id === sel.id)
  if (!item) return null
  // Edited time of the first and last kept moment of the item.
  const start = firstKept(edits, item.start_ms, item.end_ms)
  const end = lastKept(edits, item.start_ms, item.end_ms)
  if (start === null || end === null) return null
  return { start_ms: start, end_ms: end }
}

function firstKept(e: VideoEdits, a: number, b: number): number | null {
  for (const s of e.segments) {
    if (s.end_ms <= a || s.start_ms >= b) continue
    return sourceToEdited(e, Math.max(a, s.start_ms))
  }
  return null
}
function lastKept(e: VideoEdits, a: number, b: number): number | null {
  for (let i = e.segments.length - 1; i >= 0; i--) {
    const s = e.segments[i]
    if (s.end_ms <= a || s.start_ms >= b) continue
    const end = Math.min(b, s.end_ms)
    // The end of a piece is not inside it (sourceToEdited would say "cut"):
    // measure from the piece's start, at its speed.
    const from = sourceToEdited(e, s.start_ms)
    return from === null ? null : Math.round(from + (end - s.start_ms) / s.speed)
  }
  return null
}

/** Ten seconds around the playhead (edited time), held to the video. */
export function clipRangeAround(
  editedMs: number,
  totalMs: number,
  lengthMs = 10_000
): ClipRange | null {
  const start = Math.max(0, Math.round(editedMs) - Math.round(lengthMs / 2))
  return clampClipRange({ start_ms: start, end_ms: start + lengthMs }, totalMs)
}

/** What a clip is called when the author gives no label: the chapter it
 *  starts in, else its times. */
export function defaultClipLabel(edits: VideoEdits, r: ClipRange): string {
  let chapter: { title: string; at: number } | null = null
  for (const c of edits.chapters) {
    const at = sourceToEdited(edits, c.at_ms)
    if (at !== null && at <= r.start_ms + 1 && (!chapter || at > chapter.at)) {
      chapter = { title: c.title, at }
    }
  }
  const title = chapter?.title.trim()
  return title || `${clipClock(r.start_ms)}–${clipClock(r.end_ms)}`
}

export function formatBytes(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return ''
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** One line under a clip's name: its kind, length and size or state. */
export function clipMeta(c: ClipDto): string {
  const len = `${((c.end_ms - c.start_ms) / 1000).toFixed(1)} s`
  const kind = c.kind.toUpperCase()
  if (c.status === 'ready') return [kind, len, formatBytes(c.bytes)].filter(Boolean).join(' · ')
  if (c.status === 'failed') return `${kind} · ${c.error || 'Could not be made'}`
  if (c.status === 'rendering') return `${kind} · Making… ${c.progress ?? 0}%`
  return `${kind} · Waiting to be made`
}

/** The absolute link people paste into chat or mail: the API origin when the
 *  client has one, else this page's. */
export function clipLink(apiBase: string, url: string, pageOrigin: string): string {
  const origin = apiBase.replace(/\/api$/, '')
  return `${origin || pageOrigin}${url}`
}
