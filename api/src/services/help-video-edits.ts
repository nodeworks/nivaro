import { createHash } from 'node:crypto'

// The stored form of everything an author does in the help-video editor.
// All times are SOURCE time (the original recording's clock): `segments` are
// the kept parts in order, everything else is pinned to the moment it
// describes, so later cuts never shift an arrow onto the wrong frame. Rects
// are fractions of the frame. packages/shared/src/components/help-videos/edits.ts
// is the client twin of the pure helpers below — keep them in step.

export type Rect = { x: number; y: number; w: number; h: number }
export type Point = { x: number; y: number }
export type Speed = 1 | 1.5 | 2 | 4
export type AnnotationType = 'callout' | 'arrow' | 'box' | 'ripple'
export type Tone = 'accent' | 'warning' | 'neutral'
export interface Segment {
  start_ms: number
  end_ms: number
  speed: Speed
}
export interface Chapter {
  id: string
  at_ms: number
  title: string
}
export interface Annotation {
  id: string
  type: AnnotationType
  start_ms: number
  end_ms: number
  rect: Rect
  to: Point | null
  text: string
  tone: Tone
}
export interface Zoom {
  id: string
  start_ms: number
  end_ms: number
  rect: Rect
  ease_ms: number
}
export interface Blur {
  id: string
  start_ms: number
  end_ms: number
  rect: Rect
  strength: number
}
export interface Caption {
  id: string
  start_ms: number
  end_ms: number
  text: string
}
/** A title card played BEFORE the recording: real extra time on the edited
 *  timeline. Blank `title` / `subtitle` mean the video's own title and the
 *  first line of its description. */
export interface IntroCard {
  enabled: true
  duration_ms: number
  show_chapters: boolean
  title: string
  subtitle: string
}
/** An end card played AFTER the recording. Blank `text` shows OUTRO_DEFAULT_TEXT
 *  (kept blank in storage, so clearing the field to retype it never refills it). */
export interface OutroCard {
  enabled: true
  duration_ms: number
  text: string
}
export interface VideoEdits {
  v: 1
  segments: Segment[]
  poster_ms: number
  chapters: Chapter[]
  annotations: Annotation[]
  zooms: Zoom[]
  blurs: Blur[]
  captions: Caption[]
  // Optional and stored only when switched on: a video without them keeps the
  // exact edits (and edits_hash) it always had.
  intro?: IntroCard
  outro?: OutroCard
  chapter_banners?: true
}

export const ALLOWED_SPEEDS: Speed[] = [1, 1.5, 2, 4]
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
  zoomMinSide: 0.25,
  cardMinMs: 2000,
  cardMaxMs: 6000,
  cardDefaultMs: 3000,
  introTitle: 120,
  introSubtitle: 200,
  outroText: 200,
  /** How long a chapter banner stays up, in edited time. */
  bannerMs: 2500
} as const

export const OUTRO_DEFAULT_TEXT = 'Questions? Ask your administrator.'

export class EditsError extends Error {
  statusCode = 422
  code = 'HELP_VIDEO_EDITS_INVALID'
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const TYPES: AnnotationType[] = ['callout', 'arrow', 'box', 'ripple']
const TONES: Tone[] = ['accent', 'warning', 'neutral']

function makeId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}
function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? (v.filter((x) => x && typeof x === 'object') as Record<string, unknown>[])
    : []
}
function id(v: unknown): string {
  return typeof v === 'string' && ID_RE.test(v) ? v : makeId()
}
function text(v: unknown, max: number): string {
  return (typeof v === 'string' ? v : '').slice(0, max)
}
function rect(v: unknown): Rect {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const w = clamp(num(r.w, 0.2), 0.01, 1)
  const h = clamp(num(r.h, 0.1), 0.01, 1)
  return { x: clamp(num(r.x), 0, 1 - w), y: clamp(num(r.y), 0, 1 - h), w, h }
}
function point(v: unknown): Point | null {
  if (!v || typeof v !== 'object') return null
  const p = v as Record<string, unknown>
  return { x: clamp(num(p.x), 0, 1), y: clamp(num(p.y), 0, 1) }
}
function span(
  r: Record<string, unknown>,
  sourceMs: number
): { start_ms: number; end_ms: number } | null {
  const start = Math.round(clamp(num(r.start_ms), 0, sourceMs))
  const end = Math.round(clamp(num(r.end_ms), 0, sourceMs))
  return end - start >= EDIT_LIMITS.minItemMs ? { start_ms: start, end_ms: end } : null
}
function speed(v: unknown): Speed {
  const n = num(v, 1)
  return (ALLOWED_SPEEDS as number[]).includes(n) ? (n as Speed) : 1
}

export function emptyEdits(sourceMs: number): VideoEdits {
  return {
    v: 1,
    segments: [{ start_ms: 0, end_ms: Math.max(0, Math.round(sourceMs)), speed: 1 }],
    poster_ms: 0,
    chapters: [],
    annotations: [],
    zooms: [],
    blurs: [],
    captions: []
  }
}

export function normalizeEdits(input: unknown, sourceMs: number): VideoEdits {
  const src = Math.max(0, Math.round(sourceMs))
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>

  let segments: Segment[]
  if (!('segments' in o)) {
    segments = emptyEdits(src).segments
  } else {
    const raw = arr(o.segments)
      .map((s) => ({
        start_ms: Math.round(clamp(num(s.start_ms), 0, src)),
        end_ms: Math.round(clamp(num(s.end_ms), 0, src)),
        speed: speed(s.speed)
      }))
      .sort((a, b) => a.start_ms - b.start_ms)
    segments = []
    for (const s of raw) {
      const prevEnd = segments.length ? segments[segments.length - 1].end_ms : 0
      const start = Math.max(s.start_ms, prevEnd)
      if (s.end_ms - start >= EDIT_LIMITS.minSegmentMs) segments.push({ ...s, start_ms: start })
    }
  }
  const kept = segments.reduce((t, s) => t + (s.end_ms - s.start_ms), 0)
  if (kept < EDIT_LIMITS.minKeptMs)
    throw new EditsError('Keep at least one second of the recording')

  const chapters = arr(o.chapters)
    .slice(0, EDIT_LIMITS.chapters)
    .map((c) => ({
      id: id(c.id),
      at_ms: Math.round(clamp(num(c.at_ms), 0, src)),
      title: text(c.title, EDIT_LIMITS.chapterTitle).trim() || 'Chapter'
    }))
    .sort((a, b) => a.at_ms - b.at_ms)

  const annotations: Annotation[] = []
  for (const a of arr(o.annotations)) {
    if (annotations.length >= EDIT_LIMITS.annotations) break
    const t = TYPES.find((x) => x === a.type)
    const s = span(a, src)
    if (!t || !s) continue
    annotations.push({
      id: id(a.id),
      type: t,
      ...s,
      rect: rect(a.rect),
      to: t === 'arrow' ? (point(a.to) ?? { x: 0.5, y: 0.5 }) : null,
      text: t === 'callout' || t === 'box' ? text(a.text, EDIT_LIMITS.text) : '',
      tone: TONES.find((x) => x === a.tone) ?? 'accent'
    })
  }

  const zooms: Zoom[] = []
  for (const z of arr(o.zooms).sort((a, b) => num(a.start_ms) - num(b.start_ms))) {
    if (zooms.length >= EDIT_LIMITS.zooms) break
    const s = span(z, src)
    if (!s) continue
    if (zooms.length && s.start_ms < zooms[zooms.length - 1].end_ms) continue
    const r = rect(z.rect)
    const side = clamp(Math.max(r.w, r.h), EDIT_LIMITS.zoomMinSide, 1)
    const sq = { x: clamp(r.x, 0, 1 - side), y: clamp(r.y, 0, 1 - side), w: side, h: side }
    const half = Math.floor((s.end_ms - s.start_ms) / 2)
    zooms.push({
      id: id(z.id),
      ...s,
      rect: sq,
      ease_ms: Math.round(clamp(num(z.ease_ms, 400), 0, half))
    })
  }

  const blurs: Blur[] = []
  for (const b of arr(o.blurs)) {
    if (blurs.length >= EDIT_LIMITS.blurs) break
    const s = span(b, src)
    if (!s) continue
    blurs.push({
      id: id(b.id),
      ...s,
      rect: rect(b.rect),
      strength: Math.round(clamp(num(b.strength, 12), 2, 40))
    })
  }

  const captions: Caption[] = []
  for (const c of arr(o.captions)) {
    if (captions.length >= EDIT_LIMITS.captions) break
    const s = span(c, src)
    const t = text(c.text, EDIT_LIMITS.text)
    if (!s || !t.trim()) continue
    captions.push({ id: id(c.id), ...s, text: t })
  }
  captions.sort((a, b) => a.start_ms - b.start_ms)

  const out: VideoEdits = {
    v: 1,
    segments,
    poster_ms: Math.round(clamp(num(o.poster_ms), 0, src)),
    chapters,
    annotations,
    zooms,
    blurs,
    captions
  }
  // Cards and banners are stored only while switched on; never added otherwise.
  const intro = normalizeIntro(o.intro)
  if (intro) out.intro = intro
  const outro = normalizeOutro(o.outro)
  if (outro) out.outro = outro
  if (o.chapter_banners === true) out.chapter_banners = true
  return out
}

function cardMs(v: unknown): number {
  return Math.round(
    clamp(num(v, EDIT_LIMITS.cardDefaultMs), EDIT_LIMITS.cardMinMs, EDIT_LIMITS.cardMaxMs)
  )
}
function oneLine(v: unknown, max: number): string {
  return text(v, max * 2)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export function normalizeIntro(v: unknown): IntroCard | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (r.enabled !== true) return null
  return {
    enabled: true,
    duration_ms: cardMs(r.duration_ms),
    show_chapters: r.show_chapters === true,
    title: oneLine(r.title, EDIT_LIMITS.introTitle),
    subtitle: oneLine(r.subtitle, EDIT_LIMITS.introSubtitle)
  }
}

export function normalizeOutro(v: unknown): OutroCard | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (r.enabled !== true) return null
  return {
    enabled: true,
    duration_ms: cardMs(r.duration_ms),
    text: oneLine(r.text, EDIT_LIMITS.outroText)
  }
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])])
    )
  }
  return v
}

export function hashEdits(e: VideoEdits): string {
  return createHash('sha1')
    .update(JSON.stringify(stable(e)))
    .digest('hex')
}

// Edited time = intro card + the kept pieces (at their speeds) + outro card.

/** The intro card's length in edited time (0 when it is off). */
export function introMs(e: VideoEdits): number {
  return e.intro?.enabled ? e.intro.duration_ms : 0
}
/** The outro card's length in edited time (0 when it is off). */
export function outroMs(e: VideoEdits): number {
  return e.outro?.enabled ? e.outro.duration_ms : 0
}
/** The kept recording alone, at its speeds. */
export function bodyDuration(e: VideoEdits): number {
  return Math.round(e.segments.reduce((t, s) => t + (s.end_ms - s.start_ms) / s.speed, 0))
}
export function editedDuration(e: VideoEdits): number {
  return introMs(e) + bodyDuration(e) + outroMs(e)
}

export function sourceToEdited(e: VideoEdits, ms: number): number | null {
  const lead = introMs(e)
  let acc = 0
  for (const s of e.segments) {
    if (ms >= s.start_ms && ms < s.end_ms)
      return Math.round(lead + acc + (ms - s.start_ms) / s.speed)
    acc += (s.end_ms - s.start_ms) / s.speed
  }
  return null
}

/** The source moment shown at an edited time. Inside the intro card: the first
 *  kept frame; inside the outro card: the last. */
export function editedToSource(e: VideoEdits, ms: number): number {
  const m = ms - introMs(e)
  if (m < 0) return e.segments.length ? e.segments[0].start_ms : 0
  let acc = 0
  for (const s of e.segments) {
    const len = (s.end_ms - s.start_ms) / s.speed
    if (m < acc + len) return Math.round(s.start_ms + (m - acc) * s.speed)
    acc += len
  }
  return e.segments.length ? e.segments[e.segments.length - 1].end_ms : 0
}

/** Which part of the edited timeline a moment falls in, and how far into it. */
export function cardPhaseAt(
  e: VideoEdits,
  ms: number
): { phase: 'intro' | 'body' | 'outro'; at: number } {
  const lead = introMs(e)
  if (ms < lead) return { phase: 'intro', at: Math.max(0, ms) }
  const bodyEnd = lead + bodyDuration(e)
  if (outroMs(e) > 0 && ms >= bodyEnd) return { phase: 'outro', at: ms - bodyEnd }
  return { phase: 'body', at: ms - lead }
}

/** Chapter banners in edited time: one per chapter viewers see (a chapter
 *  inside a cut gets none), up for EDIT_LIMITS.bannerMs or until the next
 *  banner or the end of the recording. Empty when banners are off. */
export function chapterBannerWindows(
  e: VideoEdits
): Array<{ id: string; title: string; start_ms: number; end_ms: number }> {
  if (e.chapter_banners !== true) return []
  const bodyEnd = introMs(e) + bodyDuration(e)
  const kept = e.chapters
    .map((c) => ({ id: c.id, title: c.title, at: sourceToEdited(e, c.at_ms) }))
    .filter((c): c is { id: string; title: string; at: number } => c.at !== null)
    .sort((a, b) => a.at - b.at)
  const out: Array<{ id: string; title: string; start_ms: number; end_ms: number }> = []
  kept.forEach((c, i) => {
    const next = kept[i + 1]?.at ?? Number.POSITIVE_INFINITY
    const end = Math.min(c.at + EDIT_LIMITS.bannerMs, next, bodyEnd)
    if (end - c.at >= EDIT_LIMITS.minItemMs)
      out.push({ id: c.id, title: c.title, start_ms: c.at, end_ms: end })
  })
  return out
}

/** The source spans an edited-time window covers inside the recording: one per
 *  kept piece it crosses (cards contribute none). */
export function editedSpanToSource(
  e: VideoEdits,
  start: number,
  end: number
): Array<{ start_ms: number; end_ms: number }> {
  const out: Array<{ start_ms: number; end_ms: number }> = []
  let acc = introMs(e)
  for (const s of e.segments) {
    const len = (s.end_ms - s.start_ms) / s.speed
    const a = Math.max(start, acc)
    const b = Math.min(end, acc + len)
    if (b > a) {
      out.push({
        start_ms: Math.round(s.start_ms + (a - acc) * s.speed),
        end_ms: Math.round(s.start_ms + (b - acc) * s.speed)
      })
    }
    acc += len
  }
  return out
}

export function isHiddenByCuts(e: VideoEdits, start: number, end: number): boolean {
  return !e.segments.some((s) => start < s.end_ms && end > s.start_ms)
}

/** Edited-time position of a source moment, moved forward (dir 1) or back
 *  (dir -1) to the nearest kept time when it falls inside a cut. */
function snapToEdited(e: VideoEdits, ms: number, dir: 1 | -1): number | null {
  const direct = sourceToEdited(e, ms)
  if (direct !== null) return direct
  let acc = introMs(e)
  let prevEnd: number | null = null
  for (const s of e.segments) {
    const len = (s.end_ms - s.start_ms) / s.speed
    if (ms < s.start_ms) return dir === 1 ? Math.round(acc) : prevEnd
    acc += len
    prevEnd = Math.round(acc)
  }
  return dir === 1 ? null : prevEnd
}

function vttTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const f = ms % 1000
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)}.${p(f, 3)}`
}

export function captionsToVtt(e: VideoEdits): string {
  const cues: string[] = []
  for (const c of e.captions) {
    const a = snapToEdited(e, c.start_ms, 1)
    const b = snapToEdited(e, c.end_ms, -1)
    if (a === null || b === null || b <= a) continue
    cues.push(
      `${cues.length + 1}\n${vttTime(a)} --> ${vttTime(b)}\n${c.text.replace(/\n{2,}/g, '\n')}`
    )
  }
  return `WEBVTT\n\n${cues.join('\n\n')}${cues.length ? '\n' : ''}`
}
