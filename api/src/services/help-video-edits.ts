import { createHash } from 'node:crypto'
import { type CardMotion, settledMs } from './help-video-card-design.js'

// The stored form of everything an author does in the help-video editor.
// All times are SOURCE time (the original recording's clock): `segments` are
// the kept parts in order, everything else is pinned to the moment it
// describes, so later cuts never shift an arrow onto the wrong frame. Rects
// are fractions of the frame. packages/shared/src/components/help-videos/edits.ts
// is the client twin of the pure helpers below — keep them in step.

export type Rect = { x: number; y: number; w: number; h: number }
export type Point = { x: number; y: number }
export type Speed = 0.5 | 1 | 1.5 | 2 | 4
/** A `step` is a callout with a number badge (numbered in timeline order);
 *  a `spotlight` dims the whole frame except its rect. */
export type AnnotationType = 'callout' | 'arrow' | 'box' | 'ripple' | 'step' | 'spotlight'
export type Tone = 'accent' | 'warning' | 'neutral'
export interface Segment {
  start_ms: number
  end_ms: number
  speed: Speed
  /** This piece's music level, a share of the video's music volume: 0 = no
   *  music under it. Stored only when the music is on and the share is not 1. */
  music?: number
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
  /** How the card's elements arrive. Absent = none (a still card). */
  animation?: StoredAnimation
  /** How the card hands over to the recording. Absent = a cut. */
  transition?: StoredTransition
}
// Card motion values as stored: 'none' and 'cut' are never stored, so a card
// that chose nothing keeps the exact edits (and edits_hash) it always had.
export const CARD_ANIMATIONS = ['subtle', 'lively'] as const
export const CARD_TRANSITIONS = ['fade', 'fade_black', 'slide', 'zoom', 'wipe'] as const
export type StoredAnimation = (typeof CARD_ANIMATIONS)[number]
export type StoredTransition = (typeof CARD_TRANSITIONS)[number]
const cardAnimation = (v: unknown): StoredAnimation | null =>
  (CARD_ANIMATIONS as readonly unknown[]).includes(v) ? (v as StoredAnimation) : null
const cardTransition = (v: unknown): StoredTransition | null =>
  (CARD_TRANSITIONS as readonly unknown[]).includes(v) ? (v as StoredTransition) : null
/** How every step badge looks. Stored only when it differs from
 *  STEP_STYLE_DEFAULTS (a later house style sets instance defaults). */
export interface StepStyle {
  shape: 'circle' | 'square'
  size: 'small' | 'medium' | 'large'
}
export const STEP_SHAPES = ['circle', 'square'] as const
export const STEP_SIZES = ['small', 'medium', 'large'] as const
export const STEP_STYLE_DEFAULTS: Readonly<StepStyle> = { shape: 'circle', size: 'medium' }
/** A step badge's diameter in annotation units (annotationUnit of the frame). */
export const STEP_BADGE_UNITS: Record<StepStyle['size'], number> = {
  small: 10,
  medium: 13,
  large: 17
}
/** How dark a spotlight makes everything outside its rect. */
export const SPOTLIGHT_DIM = 0.6
/** A music bed under the whole video (cards included), looped to length and
 *  lowered while someone speaks. `track` is a library key (MUSIC_TRACK_RE)
 *  or, for an uploaded file, the music row's id. */
export interface MusicBed {
  enabled: true
  source: 'library' | 'upload'
  track: string
  /** Shown to authors: the library title or the uploaded file's name. */
  name: string
  /** Music level while nobody speaks, 0.05–1. */
  volume: number
  /** Lower the music under narration. */
  duck: boolean
}
/** An end card played AFTER the recording. Blank `text` shows OUTRO_DEFAULT_TEXT
 *  (kept blank in storage, so clearing the field to retype it never refills it). */
export interface OutroCard {
  enabled: true
  duration_ms: number
  text: string
  /** How the card's elements arrive. Absent = none (a still card). */
  animation?: StoredAnimation
  /** How the card takes over from the recording. Absent = a cut. */
  transition?: StoredTransition
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
  /** How chapter banners arrive and leave. Stored only while chapter_banners
   *  is on; absent = they pop on and off. */
  banner_animation?: StoredAnimation
  /** The name drawn on the cards instead of the instance name. Stored only
   *  when filled in. */
  card_brand?: string
  /** The poster is this card instead of the frame at poster_ms. Stored only
   *  while that card is switched on. */
  poster_card?: 'intro' | 'outro'
  /** Background music. Stored only when switched on. */
  music?: MusicBed
  /** What viewers see of the recording (frame fractions). Stored only when
   *  it is smaller than the whole frame. Every other rect stays relative to
   *  the whole recorded frame; cards are always full frame. */
  crop?: Rect
  /** Step badge look. Stored only when it differs from STEP_STYLE_DEFAULTS. */
  step_style?: StepStyle
}

export const ALLOWED_SPEEDS: Speed[] = [0.5, 1, 1.5, 2, 4]
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
  cardBrand: 60,
  /** How long a chapter banner stays up, in edited time. */
  bannerMs: 2500,
  musicName: 120,
  musicMinVolume: 0.05,
  musicDefaultVolume: 0.25,
  /** Callouts, boxes and arrows fade in and out over this long (source time). */
  fadeMs: 200,
  /** Smallest crop side (fraction of the frame). */
  cropMinSide: 0.2
} as const

/** A library track key, or an uploaded music row's id. */
export const MUSIC_TRACK_RE =
  /^(?:[a-z][a-z0-9-]{0,39}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

export const OUTRO_DEFAULT_TEXT = 'Questions? Ask your administrator.'

export class EditsError extends Error {
  statusCode = 422
  code = 'HELP_VIDEO_EDITS_INVALID'
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const TYPES: AnnotationType[] = ['callout', 'arrow', 'box', 'ripple', 'step', 'spotlight']
/** The annotation types that carry text. */
export const TEXT_TYPES: AnnotationType[] = ['callout', 'box', 'step']
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
      .map((s) => {
        const seg: Segment = {
          start_ms: Math.round(clamp(num(s.start_ms), 0, src)),
          end_ms: Math.round(clamp(num(s.end_ms), 0, src)),
          speed: speed(s.speed)
        }
        const share = musicShare(s.music)
        if (share !== 1) seg.music = share
        return seg
      })
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
      text: TEXT_TYPES.includes(t) ? text(a.text, EDIT_LIMITS.text) : '',
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
  const bannerAnimation = out.chapter_banners ? cardAnimation(o.banner_animation) : null
  if (bannerAnimation) out.banner_animation = bannerAnimation
  const cardBrand = oneLine(o.card_brand, EDIT_LIMITS.cardBrand)
  if (cardBrand) out.card_brand = cardBrand
  if (o.poster_card === 'intro' && out.intro) out.poster_card = 'intro'
  else if (o.poster_card === 'outro' && out.outro) out.poster_card = 'outro'
  const music = normalizeMusic(o.music)
  if (music) out.music = music
  // A piece's music share means nothing without music: never stored then.
  else for (const seg of out.segments) delete seg.music
  const crop = normalizeCrop(o.crop)
  if (crop) out.crop = crop
  const stepStyle = normalizeStepStyle(o.step_style)
  if (stepStyle) out.step_style = stepStyle
  return out
}

const r4 = (n: number) => Math.round(n * 10000) / 10000

/** The crop the server stores: sides at least EDIT_LIMITS.cropMinSide, inside
 *  the frame, rounded to 4 places; null (stored as absent) when it is missing
 *  or covers the whole frame. */
export function normalizeCrop(v: unknown): Rect | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const w = r4(clamp(num(r.w, 1), EDIT_LIMITS.cropMinSide, 1))
  const h = r4(clamp(num(r.h, 1), EDIT_LIMITS.cropMinSide, 1))
  const x = r4(clamp(num(r.x), 0, 1 - w))
  const y = r4(clamp(num(r.y), 0, 1 - h))
  if (x <= 0.0005 && y <= 0.0005 && w >= 0.9995 && h >= 0.9995) return null
  return { x, y, w, h }
}

/** The step style the server stores: null (absent) when it is the default. */
export function normalizeStepStyle(v: unknown): StepStyle | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const shape = (STEP_SHAPES as readonly unknown[]).includes(r.shape)
    ? (r.shape as StepStyle['shape'])
    : STEP_STYLE_DEFAULTS.shape
  const size = (STEP_SIZES as readonly unknown[]).includes(r.size)
    ? (r.size as StepStyle['size'])
    : STEP_STYLE_DEFAULTS.size
  if (shape === STEP_STYLE_DEFAULTS.shape && size === STEP_STYLE_DEFAULTS.size) return null
  return { shape, size }
}

/** The step style in effect (stored or default). */
export function stepStyleOf(e: VideoEdits): StepStyle {
  return { ...STEP_STYLE_DEFAULTS, ...(e.step_style ?? {}) }
}

/** Each step's number: the steps viewers see (not inside a cut), in timeline
 *  order (start, then top to bottom, then left to right), from 1. A step
 *  inside a cut has no number. */
export function stepNumbers(e: VideoEdits): Map<string, number> {
  const steps = e.annotations
    .filter((a) => a.type === 'step' && !isHiddenByCuts(e, a.start_ms, a.end_ms))
    .sort((a, b) => a.start_ms - b.start_ms || a.rect.y - b.rect.y || a.rect.x - b.rect.x)
  return new Map(steps.map((a, i) => [a.id, i + 1]))
}

/** The crop in effect: the stored one, else the whole frame. */
export function cropOf(e: VideoEdits): Rect {
  return e.crop ?? { x: 0, y: 0, w: 1, h: 1 }
}

/** A zoom as seen inside the crop: how much it magnifies the cropped picture
 *  (at least 1: a zoom larger than the crop shows the whole crop) and its
 *  centre as a fraction of the cropped picture. Without a crop this is
 *  exactly 1 / rect.w and the rect's centre. */
export function zoomInView(e: VideoEdits, rect: Rect): { mag: number; cx: number; cy: number } {
  const c = cropOf(e)
  const w = rect.w / c.w
  const h = rect.h / c.h
  return {
    mag: Math.max(1, 1 / Math.max(w, h)),
    cx: (rect.x - c.x) / c.w + w / 2,
    cy: (rect.y - c.y) / c.h + h / 2
  }
}

/** A piece's music share: 0–1 in steps of 0.05, 1 when missing or unreadable. */
export function musicShare(v: unknown): number {
  if (v === undefined || v === null || v === '') return 1
  const n = Number(v)
  if (!Number.isFinite(n)) return 1
  return Math.round(clamp(n, 0, 1) * 20) / 20
}

export function normalizeMusic(v: unknown): MusicBed | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (r.enabled !== true) return null
  const source = r.source === 'upload' ? 'upload' : r.source === 'library' ? 'library' : null
  const track = typeof r.track === 'string' ? r.track.trim() : ''
  if (!source || !MUSIC_TRACK_RE.test(track)) return null
  // An upload is named by its row id, a library track by its key: never mixed.
  const isId = /^[0-9a-f]{8}-/i.test(track) && track.length === 36
  if ((source === 'upload') !== isId) return null
  return {
    enabled: true,
    source,
    track: track.toLowerCase(),
    name: oneLine(r.name, EDIT_LIMITS.musicName),
    volume:
      Math.round(
        clamp(num(r.volume, EDIT_LIMITS.musicDefaultVolume), EDIT_LIMITS.musicMinVolume, 1) * 100
      ) / 100,
    duck: r.duck !== false
  }
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
  const out: IntroCard = {
    enabled: true,
    duration_ms: cardMs(r.duration_ms),
    show_chapters: r.show_chapters === true,
    title: oneLine(r.title, EDIT_LIMITS.introTitle),
    subtitle: oneLine(r.subtitle, EDIT_LIMITS.introSubtitle)
  }
  return withCardMotion(out, r)
}

/** Adds the card's animation and transition when they are real choices. */
function withCardMotion<T extends IntroCard | OutroCard>(out: T, r: Record<string, unknown>): T {
  const a = cardAnimation(r.animation)
  if (a) out.animation = a
  const t = cardTransition(r.transition)
  if (t) out.transition = t
  return out
}

export function normalizeOutro(v: unknown): OutroCard | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  if (r.enabled !== true) return null
  const out: OutroCard = {
    enabled: true,
    duration_ms: cardMs(r.duration_ms),
    text: oneLine(r.text, EDIT_LIMITS.outroText)
  }
  return withCardMotion(out, r)
}

/** How visible a callout, box or arrow is at a SOURCE moment: it fades in
 *  over its first EDIT_LIMITS.fadeMs and out over its last (half its length
 *  each when shorter). The render's overlay fade and the live player use it. */
export function annotationFade(start: number, end: number): number {
  return Math.min(EDIT_LIMITS.fadeMs, Math.max(0, (end - start) / 2))
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

/** How long a card takes to finish arriving (0 for a still card). */
function cardSettledMs(e: VideoEdits, side: 'intro' | 'outro'): number {
  const c = e[side]
  if (!c) return 0
  const m: CardMotion = {
    t_ms: 0,
    duration_ms: c.duration_ms,
    animation: c.animation ?? 'none',
    transition: c.transition ?? 'cut',
    side
  }
  return settledMs(m)
}

/** The EDITED moment the poster is taken from: a card the author chose, once
 *  it has finished arriving (a still card: just inside it), else the frame at poster_ms, else
 *  (a frame inside a cut) the first recorded frame after any intro. */
export function posterEditedMs(e: VideoEdits): number {
  if (e.poster_card === 'intro' && e.intro)
    return Math.max(100, Math.round(cardSettledMs(e, 'intro')))
  if (e.poster_card === 'outro' && e.outro)
    return introMs(e) + bodyDuration(e) + Math.max(100, Math.round(cardSettledMs(e, 'outro')))
  return sourceToEdited(e, e.poster_ms) ?? introMs(e)
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
