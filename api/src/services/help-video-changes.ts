import {
  bodyDuration,
  EditsError,
  introMs,
  normalizeEdits,
  sourceToEdited,
  type VideoEdits
} from './help-video-edits.js'

// "What changed" between the version a person watched and the one published
// now (#1497). The rule, in order:
//
//  1. A different recording (re-recorded or replaced): the whole video changed,
//     so the change is at 0.
//  2. Otherwise every visible difference gives a moment in the NEW version's
//     edited time, and the earliest one wins:
//     - the intro card (or the name drawn on the cards) changed: 0;
//     - background music changed: 0 (it plays under the whole video);
//     - the kept pieces: walking both lists in order, the first piece that
//       differs (start, end, speed or its music level). When both start at the
//       same source moment at the same speed, the shared part plays the same,
//       so the change is where the shorter one ends;
//     - captions, chapters, annotations, zooms and blurs: each item added,
//       removed or changed (compared whole, by id) at its source start, mapped
//       to the new version's edited time (an item inside a cut moves to the
//       next kept moment, past the end to the end of the recording);
//     - chapter banners switched on or off, or their animation changed: the
//       first visible chapter;
//     - the outro card: where it starts.
//  3. Nothing a viewer sees changed (only the poster, say): null.
//
// The jump target is the chapter the change falls in (the last visible chapter
// starting at or before it), else two seconds before the change.

export type ChangePoint = { at_ms: number; whole: boolean } | null

/** JSON with object keys sorted at every level, so key order never reads as a change. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v ?? null)
}
const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b)

/** A source moment on the new version's edited timeline, moved forward out of a cut. */
function snapForward(e: VideoEdits, sourceMs: number): number {
  const direct = sourceToEdited(e, sourceMs)
  if (direct !== null) return direct
  let acc = introMs(e)
  for (const s of e.segments) {
    if (sourceMs < s.start_ms) return Math.round(acc)
    acc += (s.end_ms - s.start_ms) / s.speed
  }
  return introMs(e) + bodyDuration(e)
}

/** Where the kept pieces first differ, in the new version's edited time. */
function firstPieceChange(oldE: VideoEdits, newE: VideoEdits): number | null {
  let acc = introMs(newE)
  const n = Math.max(oldE.segments.length, newE.segments.length)
  for (let i = 0; i < n; i++) {
    const a = oldE.segments[i]
    const b = newE.segments[i]
    if (!b) return Math.round(acc) // pieces removed at the end
    if (!a) return Math.round(acc) // pieces added at the end
    if (
      a.start_ms === b.start_ms &&
      a.end_ms === b.end_ms &&
      a.speed === b.speed &&
      (a.music ?? 1) === (b.music ?? 1)
    ) {
      acc += (b.end_ms - b.start_ms) / b.speed
      continue
    }
    if (a.start_ms === b.start_ms && a.speed === b.speed && (a.music ?? 1) === (b.music ?? 1)) {
      return Math.round(acc + (Math.min(a.end_ms, b.end_ms) - b.start_ms) / b.speed)
    }
    return Math.round(acc)
  }
  return null
}

type Timed = { id: string; start_ms?: number; at_ms?: number }
function itemStart(x: Timed): number {
  return Number(x.start_ms ?? x.at_ms ?? 0)
}

/** Source starts of the items added, removed or changed between two lists. */
function changedItemStarts(a: Timed[], b: Timed[]): number[] {
  const before = new Map(a.map((x) => [x.id, stable(x)]))
  const after = new Map(b.map((x) => [x.id, stable(x)]))
  const out: number[] = []
  for (const x of b) if (before.get(x.id) !== after.get(x.id)) out.push(itemStart(x))
  for (const x of a) if (!after.has(x.id)) out.push(itemStart(x))
  return out
}

function firstChapterEdited(e: VideoEdits): number | null {
  const at = e.chapters
    .map((c) => sourceToEdited(e, c.at_ms))
    .filter((x): x is number => x !== null)
  return at.length ? Math.min(...at) : null
}

/** The earliest moment (new version, edited time) a viewer would see differ. */
export function firstChange(oldE: VideoEdits, newE: VideoEdits, sameSource: boolean): ChangePoint {
  if (!sameSource) return { at_ms: 0, whole: true }
  const points: number[] = []
  if (!same(oldE.intro ?? null, newE.intro ?? null)) points.push(0)
  if ((oldE.card_brand ?? '') !== (newE.card_brand ?? '') && (newE.intro || newE.outro))
    points.push(0)
  if (!same(oldE.music ?? null, newE.music ?? null)) points.push(0)
  const piece = firstPieceChange(oldE, newE)
  if (piece !== null) points.push(piece)
  for (const key of ['captions', 'chapters', 'annotations', 'zooms', 'blurs'] as const) {
    for (const s of changedItemStarts(oldE[key] as Timed[], newE[key] as Timed[])) {
      points.push(snapForward(newE, s))
    }
  }
  if (
    (oldE.chapter_banners ?? false) !== (newE.chapter_banners ?? false) ||
    (oldE.banner_animation ?? null) !== (newE.banner_animation ?? null)
  ) {
    points.push(firstChapterEdited(newE) ?? introMs(newE))
  }
  if (!same(oldE.outro ?? null, newE.outro ?? null)) points.push(introMs(newE) + bodyDuration(newE))
  if (!points.length) return null
  return { at_ms: Math.max(0, Math.min(...points)), whole: false }
}

export interface JumpTarget {
  jump_ms: number
  chapter: { id: string; title: string } | null
}

/** Where "Jump to what changed" starts: the chapter the change falls in, else a
 *  little before the change. */
export function jumpTarget(e: VideoEdits, atMs: number): JumpTarget {
  const chapters = e.chapters
    .map((c) => ({ id: c.id, title: c.title, at: sourceToEdited(e, c.at_ms) }))
    .filter((c): c is { id: string; title: string; at: number } => c.at !== null)
    .sort((a, b) => a.at - b.at)
  let hit: (typeof chapters)[number] | null = null
  for (const c of chapters) if (c.at <= atMs) hit = c
  if (hit) return { jump_ms: hit.at, chapter: { id: hit.id, title: hit.title } }
  return { jump_ms: Math.max(0, atMs - 2000), chapter: null }
}

/** The version note a viewer is shown. Notes the system writes for authors
 *  ("Restored from version 3") say nothing to a viewer. */
export function viewerNote(note: unknown): string | null {
  const s = typeof note === 'string' ? note.trim() : ''
  if (!s || /^Restored from version \d+$/i.test(s)) return null
  return s
}

/** Parse a stored version's edits; null when they cannot be read. */
export function readEdits(raw: unknown, sourceMs: unknown): VideoEdits | null {
  const src = Number(sourceMs)
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (v == null) return null
  try {
    return normalizeEdits(v, Number.isFinite(src) && src > 0 ? src : 30 * 60_000)
  } catch (err) {
    if (err instanceof EditsError) return null
    throw err
  }
}

/** Longest version note an author may write when publishing. */
export const VERSION_NOTE_MAX = 500

/** The note an author typed when publishing: trimmed, at most 500 characters, null when empty. */
export function cleanVersionNote(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\r\n/g, '\n').trim().slice(0, VERSION_NOTE_MAX).trim()
  return s || null
}
