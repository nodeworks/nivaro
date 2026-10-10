import type { CardAnimation, CardTransition } from './cardDesign'
import type {
  Annotation,
  Blur,
  Caption,
  CaptionStyle,
  Chapter,
  CursorEdits,
  Hold,
  IntroCard,
  MusicBed,
  OutroCard,
  Point,
  Rect,
  Segment,
  Speed,
  StepStyle,
  VideoEdits,
  Zoom,
  ZoomKeyframe
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

export const ALLOWED_SPEEDS: Speed[] = [0.5, 1, 1.5, 2, 4]
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
  /** Kept pieces: each is one branch of the render's and a clip's graph. */
  segments: 500,
  /** Smallest zoom rect side (fraction of the frame): at most 4x magnification. */
  zoomMinSide: 0.25,
  /** Stops of a moving zoom (#1539), per zoom and over the whole video. */
  zoomKeyframes: 40,
  zoomKeyframesTotal: 300,
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
  cropMinSide: 0.2,
  /** Held frames (#1537): how many, and how long each holds (edited time). */
  holds: 50,
  holdMinMs: 200,
  holdMaxMs: 10_000,
  holdDefaultMs: 3000
} as const
/** The annotation types that carry text (the server's TEXT_TYPES). */
export const TEXT_TYPES: Annotation['type'][] = ['callout', 'box', 'step']
/** Step badge look when nothing is stored (the server's STEP_STYLE_DEFAULTS).
 *  A later house style sets instance defaults from this. */
export const STEP_STYLE_DEFAULTS: Readonly<StepStyle> = { shape: 'circle', size: 'medium' }
/** A step badge's diameter in annotation units (the server's STEP_BADGE_UNITS). */
export const STEP_BADGE_UNITS: Record<StepStyle['size'], number> = {
  small: 10,
  medium: 13,
  large: 17
}
/** How dark a spotlight makes everything outside its rect (the server's SPOTLIGHT_DIM). */
export const SPOTLIGHT_DIM = 0.6
/** Same text as the server's OUTRO_DEFAULT_TEXT. */
export const OUTRO_DEFAULT_TEXT = 'Questions? Ask your administrator.'
export const MIN_KEPT_MS = EDIT_LIMITS.minKeptMs
const MIN_SEGMENT_MS = EDIT_LIMITS.minSegmentMs
export type ListKey = 'chapters' | 'annotations' | 'zooms' | 'blurs' | 'captions' | 'holds'
/** The lanes a timeline item can be on, with their items (`holds` is stored
 *  only when there are any). */
export const LIST_KEYS: ListKey[] = [
  'chapters',
  'annotations',
  'zooms',
  'blurs',
  'captions',
  'holds'
]
export function itemsOf<K extends ListKey>(e: VideoEdits, key: K): NonNullable<VideoEdits[K]> {
  return (e[key] ?? []) as NonNullable<VideoEdits[K]>
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export function newId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}
// Edited time = intro card + the kept pieces (at their speeds, plus the held
// frames inside them) + outro card.

/** The intro card's length in edited time (0 when it is off). */
export function introMs(e: VideoEdits): number {
  return e.intro?.enabled ? e.intro.duration_ms : 0
}
/** The outro card's length in edited time (0 when it is off). */
export function outroMs(e: VideoEdits): number {
  return e.outro?.enabled ? e.outro.duration_ms : 0
}
/** The held frames inside a kept piece, in time order. A hold outside every
 *  kept piece counts for nothing (the server drops it on save). */
export function holdsIn(e: VideoEdits, s: Segment): Hold[] {
  const holds = e.holds
  if (!holds?.length) return []
  return holds
    .filter((h) => h.at_ms >= s.start_ms && h.at_ms < s.end_ms)
    .sort((a, b) => a.at_ms - b.at_ms)
}
/** How long the edited timeline holds on exactly this source moment (0 when
 *  no held frame sits there). */
export function heldAtMoment(e: VideoEdits, ms: number): number {
  if (!e.holds?.length) return 0
  const s = e.segments.find((x) => ms >= x.start_ms && ms < x.end_ms)
  if (!s) return 0
  return holdsIn(e, s)
    .filter((h) => h.at_ms === ms)
    .reduce((t, h) => t + h.hold_ms, 0)
}
/** A kept piece's length in edited time: at its speed, plus its holds. */
export function pieceEditedMs(e: VideoEdits, s: Segment): number {
  return (s.end_ms - s.start_ms) / s.speed + holdsIn(e, s).reduce((t, h) => t + h.hold_ms, 0)
}
/** The kept recording alone, at its speeds, with its held frames. */
export function bodyDuration(e: VideoEdits): number {
  return Math.round(e.segments.reduce((t, s) => t + pieceEditedMs(e, s), 0))
}
export function editedDuration(e: VideoEdits): number {
  return introMs(e) + bodyDuration(e) + outroMs(e)
}
export function keptMs(e: VideoEdits): number {
  return e.segments.reduce((t, s) => t + (s.end_ms - s.start_ms), 0)
}
/** The edited moment a source moment first shows at: a moment inside a hold
 *  maps to the hold's start (the frame is shown from then on). */
export function sourceToEdited(e: VideoEdits, ms: number): number | null {
  const lead = introMs(e)
  let acc = 0
  for (const s of e.segments) {
    if (ms >= s.start_ms && ms < s.end_ms) {
      const held = holdsIn(e, s)
        .filter((h) => h.at_ms < ms)
        .reduce((t, h) => t + h.hold_ms, 0)
      return Math.round(lead + acc + (ms - s.start_ms) / s.speed + held)
    }
    acc += pieceEditedMs(e, s)
  }
  return null
}
/** The source moment shown `m` ms into a kept piece (edited time): before,
 *  during (the held frame itself) and after each of its holds. */
function sourceWithin(e: VideoEdits, s: Segment, m: number): number {
  let held = 0
  for (const h of holdsIn(e, s)) {
    const at = (h.at_ms - s.start_ms) / s.speed + held
    if (m < at) break
    if (m < at + h.hold_ms) return h.at_ms
    held += h.hold_ms
  }
  return Math.round(s.start_ms + (m - held) * s.speed)
}
/** The source moment shown at an edited time. Inside the intro card: the first
 *  kept frame; inside the outro card: the last. */
export function editedToSource(e: VideoEdits, ms: number): number {
  const m = ms - introMs(e)
  if (m < 0) return e.segments.length ? e.segments[0].start_ms : 0
  let acc = 0
  for (const s of e.segments) {
    const len = pieceEditedMs(e, s)
    if (m < acc + len) return sourceWithin(e, s, m - acc)
    acc += len
  }
  return e.segments.length ? e.segments[e.segments.length - 1].end_ms : 0
}
/** The hold the edited timeline is frozen in at an edited moment, with where
 *  it starts (edited time) and how far into it that moment is; null when the
 *  frame is moving. */
export function holdAtEdited(
  e: VideoEdits,
  ms: number
): { hold: Hold; start_ms: number; at: number } | null {
  if (!e.holds?.length) return null
  const m = ms - introMs(e)
  let acc = 0
  for (const s of e.segments) {
    let held = 0
    for (const h of holdsIn(e, s)) {
      const start = acc + (h.at_ms - s.start_ms) / s.speed + held
      if (m >= start && m < start + h.hold_ms)
        return { hold: h, start_ms: Math.round(introMs(e) + start), at: m - start }
      held += h.hold_ms
    }
    acc += pieceEditedMs(e, s)
  }
  return null
}
/** A kept hold at a source moment (one that sits inside a kept piece), else null. */
export function holdAtSource(e: VideoEdits, srcMs: number): Hold | null {
  const s = e.segments.find((x) => srcMs >= x.start_ms && srcMs < x.end_ms)
  if (!s) return null
  return holdsIn(e, s).find((h) => h.at_ms === srcMs) ?? null
}
/** Two holds this close together are one hold. */
const SAME_HOLD_MS = 300
/** A held frame at the playhead, HOLD_DEFAULT long. Refused (edits unchanged,
 *  with the reason) when the playhead is not on a part viewers see, one
 *  already sits within 0.3 s, or there are already as many as allowed;
 *  `id` is the new hold, or the one already there. */
export function addHoldAt(
  e: VideoEdits,
  srcMs: number,
  holdMs: number = EDIT_LIMITS.holdDefaultMs
): { edits: VideoEdits; id?: string; refused?: string } {
  let at = Math.round(Math.max(0, srcMs))
  // At the very end of a piece, hold its last frame.
  if (segmentIndexAt(e, at) < 0 && e.segments.some((s) => s.end_ms === at)) at -= 1
  if (segmentIndexAt(e, at) < 0)
    return { edits: e, refused: 'Move the playhead to a part viewers see, then try again' }
  const near = (e.holds ?? []).find((h) => Math.abs(h.at_ms - at) < SAME_HOLD_MS)
  if (near) return { edits: e, id: near.id, refused: 'A hold already sits here' }
  const id = newId()
  const r = upsertItemChecked(e, 'holds', { id, at_ms: at, hold_ms: holdMs })
  return r.refused ? r : { edits: r.edits, id }
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
 *  banner or the end of the recording. Empty when banners are off. Same rule
 *  as the server's render. */
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
/** A card change from the editor: any field, plus motion choices where
 *  'none' / 'cut' mean "nothing stored". */
export type CardPatch<T> = Partial<Omit<T, 'animation' | 'transition'>> & {
  animation?: CardAnimation
  transition?: CardTransition
}
/** A new card starts subtle with a fade; an existing card keeps what it has
 *  (absent = none / cut). 'none' and 'cut' are never stored, the server's
 *  rule, so a card that chose nothing keeps its exact edits. */
function withMotion<T extends IntroCard | OutroCard>(
  next: T,
  patch: CardPatch<T>,
  cur: T | undefined
): T {
  const a = patch.animation ?? (cur ? (cur.animation ?? 'none') : 'subtle')
  const t = patch.transition ?? (cur ? (cur.transition ?? 'cut') : 'fade')
  const out: T = { ...next }
  if (a !== 'none') out.animation = a
  if (t !== 'cut') out.transition = t
  return out
}
/** The intro / outro the server would store for an editor change: the
 *  server's normalizeIntro / normalizeOutro rules (off = absent). */
export function setIntro(e: VideoEdits, intro: CardPatch<IntroCard> | null): VideoEdits {
  const { intro: _drop, ...rest } = e
  if (!intro) return dropPosterCard(rest as VideoEdits, 'intro')
  const cur = e.intro
  const next: IntroCard = {
    enabled: true,
    duration_ms: clampCardMs(intro.duration_ms ?? cur?.duration_ms),
    show_chapters: (intro.show_chapters ?? cur?.show_chapters) === true,
    title: (intro.title ?? cur?.title ?? '').slice(0, EDIT_LIMITS.introTitle),
    subtitle: (intro.subtitle ?? cur?.subtitle ?? '').slice(0, EDIT_LIMITS.introSubtitle)
  }
  return { ...rest, intro: withMotion(next, intro, cur) } as VideoEdits
}
export function setOutro(e: VideoEdits, outro: CardPatch<OutroCard> | null): VideoEdits {
  const { outro: _drop, ...rest } = e
  if (!outro) return dropPosterCard(rest as VideoEdits, 'outro')
  const cur = e.outro
  const next: OutroCard = {
    enabled: true,
    duration_ms: clampCardMs(outro.duration_ms ?? cur?.duration_ms),
    text: (outro.text ?? cur?.text ?? '').slice(0, EDIT_LIMITS.outroText)
  }
  return { ...rest, outro: withMotion(next, outro, cur) } as VideoEdits
}
function dropPosterCard(e: VideoEdits, card: 'intro' | 'outro'): VideoEdits {
  if (e.poster_card !== card) return e
  const { poster_card: _drop, ...rest } = e
  return rest as VideoEdits
}
/** The poster: a card (while it is on), or a recording frame (`srcMs`),
 *  which clears any card choice. Same rule as the server's normalizeEdits. */
export function setPoster(
  e: VideoEdits,
  to: { card: 'intro' | 'outro' } | { srcMs: number }
): VideoEdits {
  const { poster_card: _drop, ...rest } = e
  if ('card' in to) return (e[to.card] ? { ...rest, poster_card: to.card } : e) as VideoEdits
  return { ...rest, poster_ms: Math.max(0, Math.round(to.srcMs)) } as VideoEdits
}
/** The cards' name override: blank removes it (the instance name shows). */
export function setCardBrand(e: VideoEdits, name: string): VideoEdits {
  const { card_brand: _drop, ...rest } = e
  const v = name.slice(0, EDIT_LIMITS.cardBrand)
  return (v.trim() ? { ...rest, card_brand: v } : rest) as VideoEdits
}
/** Banners switched on start with the subtle animation; off drops it too. */
export function setChapterBanners(e: VideoEdits, on: boolean): VideoEdits {
  const { chapter_banners: _drop, banner_animation: _anim, ...rest } = e
  return (
    on ? { ...rest, chapter_banners: true, banner_animation: e.banner_animation ?? 'subtle' } : rest
  ) as VideoEdits
}
/** How banners arrive and leave; 'none' stores nothing. Ignored while off. */
export function setBannerAnimation(e: VideoEdits, a: CardAnimation): VideoEdits {
  const { banner_animation: _drop, ...rest } = e
  return (e.chapter_banners && a !== 'none' ? { ...rest, banner_animation: a } : rest) as VideoEdits
}
function clampCardMs(v: number | undefined): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : EDIT_LIMITS.cardDefaultMs
  return Math.round(clamp(n, EDIT_LIMITS.cardMinMs, EDIT_LIMITS.cardMaxMs))
}
/** Same rule as the server's musicShare: 0–1 in steps of 0.05, 1 when unset. */
export function musicShare(v: unknown): number {
  if (v === undefined || v === null || v === '') return 1
  const n = Number(v)
  if (!Number.isFinite(n)) return 1
  return Math.round(clamp(n, 0, 1) * 20) / 20
}
/** The music the server would store (null = off). Turning music off also
 *  drops every piece's share, as the server does. */
export function setMusic(e: VideoEdits, music: Partial<MusicBed> | null): VideoEdits {
  const { music: _drop, ...rest } = e
  if (!music) {
    return {
      ...rest,
      segments: e.segments.map(({ music: _m, ...seg }) => seg)
    } as VideoEdits
  }
  const cur = e.music
  const source = music.source ?? cur?.source
  const track = (music.track ?? cur?.track ?? '').toLowerCase()
  if (!source || !track) return e
  const next: MusicBed = {
    enabled: true,
    source,
    track,
    name: (music.name ?? cur?.name ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, EDIT_LIMITS.musicName),
    volume:
      Math.round(
        clamp(
          music.volume ?? cur?.volume ?? EDIT_LIMITS.musicDefaultVolume,
          EDIT_LIMITS.musicMinVolume,
          1
        ) * 100
      ) / 100,
    duck: (music.duck ?? cur?.duck ?? true) !== false
  }
  return { ...rest, music: next } as VideoEdits
}
/** The edits key that carries the narration cleanup (#1519) and its default
 *  (off) — the server's AUDIO_EDIT_KEY / AUDIO_IMPROVE_DEFAULT. */
export const AUDIO_EDIT_KEY = 'audio' as const
export const AUDIO_IMPROVE_DEFAULT = false
/** Narration cleanup on or off. Off removes the key, as the server stores it,
 *  so a video that never used it keeps its edits_hash. */
export function setImproveAudio(e: VideoEdits, on: boolean): VideoEdits {
  const { audio: _drop, ...rest } = e
  return (on ? { ...rest, audio: { improve: true } } : rest) as VideoEdits
}
/** Text size in callouts, boxes and steps for the whole video (#1551): the
 *  server's CALLOUT_TEXT_SCALE. 'medium' is stored as nothing. */
export type CalloutText = 'small' | 'medium' | 'large'
export const CALLOUT_TEXT_SCALE: Record<CalloutText, number> = {
  small: 0.8,
  medium: 1,
  large: 1.25
}
export function calloutTextOf(e: VideoEdits): CalloutText {
  return e.callout_text ?? 'medium'
}
export function setCalloutText(e: VideoEdits, size: CalloutText): VideoEdits {
  const { callout_text: _drop, ...rest } = e
  return (size === 'medium' ? rest : { ...rest, callout_text: size }) as VideoEdits
}
/** The default caption look (the server's CAPTION_LOOK_DEFAULTS). */
export const CAPTION_LOOK_DEFAULTS: Readonly<CaptionStyle> = {
  size: 'm',
  background: 'shaded',
  position: 'bottom'
}
/** The video's caption look: what viewers see until they choose their own. */
export function captionLookOf(e: VideoEdits): CaptionStyle {
  return { ...CAPTION_LOOK_DEFAULTS, ...(e.caption_style ?? {}) }
}
/** Change the video's caption look; only keys that differ from the default
 *  are stored, and none at all = the key is absent (the server's rule). */
export function setCaptionLook(e: VideoEdits, patch: Partial<CaptionStyle>): VideoEdits {
  const { caption_style: _drop, ...rest } = e
  const next = { ...captionLookOf(e), ...patch }
  const stored: Partial<CaptionStyle> = {}
  for (const k of Object.keys(CAPTION_LOOK_DEFAULTS) as Array<keyof CaptionStyle>) {
    if (next[k] !== CAPTION_LOOK_DEFAULTS[k]) (stored as Record<string, string>)[k] = next[k]
  }
  return (Object.keys(stored).length ? { ...rest, caption_style: stored } : rest) as VideoEdits
}
/** One piece's music share (1 removes the key, as the server stores it). */
export function setPieceMusic(e: VideoEdits, index: number, share: number): VideoEdits {
  const v = musicShare(share)
  return {
    ...e,
    segments: e.segments.map((s, i) => {
      if (i !== index) return s
      const { music: _m, ...rest } = s
      return v === 1 ? rest : { ...rest, music: v }
    })
  }
}
/** How long a callout, box or arrow fades in and out (the server's
 *  annotationFade): EDIT_LIMITS.fadeMs, or half its length when shorter. */
export function annotationFade(start: number, end: number): number {
  return Math.min(EDIT_LIMITS.fadeMs, Math.max(0, (end - start) / 2))
}
/** A callout, box or arrow's opacity at a SOURCE moment (ripples: always 1). */
export function annotationOpacity(
  a: { type: string; start_ms: number; end_ms: number },
  srcMs: number
): number {
  if (a.type === 'ripple') return 1
  const f = annotationFade(a.start_ms, a.end_ms)
  if (f <= 0) return 1
  return clamp(Math.min(srcMs - a.start_ms, a.end_ms - srcMs) / f, 0, 1)
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

type Item<K extends ListKey> = NonNullable<VideoEdits[K]>[number]

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
  if (key === 'holds') {
    const h = item as Hold
    return {
      ...h,
      at_ms: Math.round(Math.max(0, h.at_ms)),
      hold_ms: Math.round(clamp(h.hold_ms, EDIT_LIMITS.holdMinMs, EDIT_LIMITS.holdMaxMs))
    } as Item<K>
  }
  if (key === 'zooms') {
    const z = item as Zoom
    const s = span(z)
    const half = Math.floor((s.end_ms - s.start_ms) / 2)
    const { keyframes: _k, ...rest } = z
    const keyframes = normalizeZoomKeyframes(z.keyframes, s)
    // A moving zoom's area is its first stop (the server's rule).
    const out: Zoom = {
      ...rest,
      ...s,
      rect: keyframes ? keyframes[0].rect : zoomSquare(clampRect(z.rect)),
      ease_ms: Math.round(clamp(z.ease_ms, 0, Math.max(0, half)))
    }
    if (keyframes) out.keyframes = keyframes
    return out as Item<K>
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
      // only callouts, boxes and steps carry text; the server stores '' for the rest
      text: TEXT_TYPES.includes(a.type) ? a.text.slice(0, EDIT_LIMITS.text) : ''
    } as Item<K>
  }
  const c = item as Caption
  return { ...c, ...span(c), text: c.text.slice(0, EDIT_LIMITS.text) } as Item<K>
}

const startOf = (x: { start_ms?: number; at_ms?: number }) => x.start_ms ?? x.at_ms ?? 0
/** The lists the server stores sorted by start (annotations and blurs keep
 *  their order). */
const SORTED: ListKey[] = ['chapters', 'zooms', 'captions', 'holds']
/** A lane's list in the order the server stores it (chapters, zooms,
 *  captions and holds by start; annotations and blurs as they are). */
export function sortedList<T extends { start_ms?: number; at_ms?: number }>(
  key: ListKey,
  list: T[]
): T[] {
  return SORTED.includes(key) ? [...list].sort((a, b) => startOf(a) - startOf(b)) : list
}
/** The note for a hold the server would drop (one outside every kept piece). */
export const HOLD_OUTSIDE_NOTE = 'A hold has to sit on a part viewers see'

/** Add or replace an item by id, normalized the way the server's
 *  normalizeEdits would store it. Refused (edits unchanged, with the reason)
 *  when the server would drop the item: shorter than 0.2 seconds, a zoom
 *  overlapping another zoom, a hold outside every kept piece, or a new item
 *  past the list cap. */
export function upsertItemChecked<K extends ListKey>(
  e: VideoEdits,
  key: K,
  item: Item<K>
): { edits: VideoEdits; refused?: string } {
  const list = itemsOf(e, key) as Array<{ id: string }>
  const next = normalizeItem(key, item)
  if (key !== 'chapters' && key !== 'holds') {
    const s = next as { start_ms: number; end_ms: number }
    if (s.end_ms - s.start_ms < EDIT_LIMITS.minItemMs) {
      return { edits: e, refused: 'Make it at least 0.2 seconds long' }
    }
  }
  if (key === 'holds' && segmentIndexAt(e, (next as Hold).at_ms) < 0) {
    return { edits: e, refused: HOLD_OUTSIDE_NOTE }
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
  return withList(
    e,
    key,
    (itemsOf(e, key) as Array<{ id: string }>).filter((x) => x.id !== id)
  )
}
/** The edits with one list replaced; an empty `holds` list is stored as no
 *  key at all (the server's rule), so a video without holds keeps its hash. */
export function withList(e: VideoEdits, key: ListKey, list: unknown[]): VideoEdits {
  if (key === 'holds' && !list.length) {
    const { holds: _drop, ...rest } = e
    return rest as VideoEdits
  }
  return { ...e, [key]: list } as VideoEdits
}

const r4 = (n: number) => Math.round(n * 10000) / 10000

/** A zoom's square (the server's zoomSquare): the longer side, at least
 *  EDIT_LIMITS.zoomMinSide, moved back inside the frame. */
function zoomSquare(r: Rect): Rect {
  const side = clamp(Math.max(r.w, r.h), EDIT_LIMITS.zoomMinSide, 1)
  return { x: clamp(r.x, 0, 1 - side), y: clamp(r.y, 0, 1 - side), w: side, h: side }
}
/** The stops the server stores for a moving zoom (#1539, its
 *  normalizeZoomKeyframes): inside the span, sorted, one per moment (the
 *  first wins), squares, at most EDIT_LIMITS.zoomKeyframes. Null with fewer
 *  than two: that is a still zoom. */
export function normalizeZoomKeyframes(
  raw: ZoomKeyframe[] | null | undefined,
  s: { start_ms: number; end_ms: number }
): ZoomKeyframe[] | null {
  if (!raw?.length) return null
  const stops = raw
    .map((k) => ({
      at_ms: Math.round(clamp(k.at_ms, s.start_ms, s.end_ms)),
      rect: zoomSquare(clampRect(k.rect))
    }))
    .sort((a, b) => a.at_ms - b.at_ms)
  const out: ZoomKeyframe[] = []
  for (const k of stops) {
    if (out.length >= EDIT_LIMITS.zoomKeyframes) break
    if (out.length && out[out.length - 1].at_ms === k.at_ms) continue
    out.push(k)
  }
  return out.length >= 2 ? out : null
}
/** The area a zoom shows at a SOURCE moment (the server's zoomRectAt): its
 *  one area, or for a moving zoom the straight-line blend of the two stops
 *  around that moment (the first held before it, the last after it). */
export function zoomRectAt(z: Zoom, srcMs: number): Rect {
  const k = z.keyframes
  if (!k || k.length < 2) return z.rect
  if (srcMs <= k[0].at_ms) return k[0].rect
  const last = k[k.length - 1]
  if (srcMs >= last.at_ms) return last.rect
  for (let i = 1; i < k.length; i++) {
    const b = k[i]
    if (srcMs > b.at_ms) continue
    const a = k[i - 1]
    const u = b.at_ms === a.at_ms ? 1 : (srcMs - a.at_ms) / (b.at_ms - a.at_ms)
    const mix = (p: number, q: number) => p + (q - p) * u
    return {
      x: mix(a.rect.x, b.rect.x),
      y: mix(a.rect.y, b.rect.y),
      w: mix(a.rect.w, b.rect.w),
      h: mix(a.rect.h, b.rect.h)
    }
  }
  return last.rect
}
/** The zoom with its area at `atMs` set to `rect` (#1539): a still zoom
 *  moved at its start stays still; moved anywhere else inside its span it
 *  gets two stops (its old area at the start, the new one here). A moving
 *  zoom replaces the stop at that moment or gains one. The result is not yet
 *  normalized: write it through upsertItemChecked. */
export function setZoomKeyframe(z: Zoom, atMs: number, rect: Rect): Zoom {
  const at = Math.round(clamp(atMs, z.start_ms, z.end_ms))
  const sq = zoomSquare(clampRect(rect))
  if (!z.keyframes?.length) {
    if (at === z.start_ms) return { ...z, rect: sq }
    return {
      ...z,
      keyframes: [
        { at_ms: z.start_ms, rect: z.rect },
        { at_ms: at, rect: sq }
      ]
    }
  }
  const keyframes = z.keyframes.filter((k) => k.at_ms !== at)
  keyframes.push({ at_ms: at, rect: sq })
  keyframes.sort((a, b) => a.at_ms - b.at_ms)
  return { ...z, rect: keyframes[0].rect, keyframes }
}
/** The zoom without its stop at `atMs`; down to one stop it is a still zoom
 *  showing that area. Unchanged when there is no such stop. */
export function removeZoomKeyframe(z: Zoom, atMs: number): Zoom {
  if (!z.keyframes?.some((k) => k.at_ms === atMs)) return z
  const keyframes = z.keyframes.filter((k) => k.at_ms !== atMs)
  const { keyframes: _drop, ...rest } = z
  if (keyframes.length < 2) return { ...rest, rect: keyframes[0]?.rect ?? z.rect }
  return { ...rest, rect: keyframes[0].rect, keyframes }
}
/** The cursor switches (#1517) as the server stores them: nothing while
 *  "Show cursor" is off; `{ show: true }`, with `shortcuts: true` when the
 *  shortcut badges are on too. */
export function setCursor(
  e: VideoEdits,
  patch: { show?: boolean; shortcuts?: boolean }
): VideoEdits {
  const { cursor: _drop, ...rest } = e
  const show = patch.show ?? !!e.cursor?.show
  if (!show) return rest as VideoEdits
  const cursor: CursorEdits = { show: true }
  if (patch.shortcuts ?? !!e.cursor?.shortcuts) cursor.shortcuts = true
  return { ...rest, cursor } as VideoEdits
}

/** The crop the server stores (normalizeCrop): sides at least
 *  EDIT_LIMITS.cropMinSide, inside the frame, 4 places; null = the whole frame. */
export function normalizeCrop(v: Rect | null | undefined): Rect | null {
  if (!v) return null
  const w = r4(clamp(v.w, EDIT_LIMITS.cropMinSide, 1))
  const h = r4(clamp(v.h, EDIT_LIMITS.cropMinSide, 1))
  const x = r4(clamp(v.x, 0, 1 - w))
  const y = r4(clamp(v.y, 0, 1 - h))
  if (x <= 0.0005 && y <= 0.0005 && w >= 0.9995 && h >= 0.9995) return null
  return { x, y, w, h }
}
/** Set (or with null / the whole frame, remove) the video's crop. */
export function setCrop(e: VideoEdits, crop: Rect | null): VideoEdits {
  const { crop: _drop, ...rest } = e
  const c = normalizeCrop(crop)
  return (c ? { ...rest, crop: c } : rest) as VideoEdits
}
/** The crop in effect: the stored one, else the whole frame. */
export function cropOf(e: VideoEdits): Rect {
  return e.crop ?? { x: 0, y: 0, w: 1, h: 1 }
}
/** A zoom inside the crop (the server's zoomInView): its magnification of the
 *  cropped picture (at least 1) and its centre as a fraction of it. */
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
/** The step style in effect (stored or default). */
export function stepStyleOf(e: VideoEdits): StepStyle {
  return { ...STEP_STYLE_DEFAULTS, ...(e.step_style ?? {}) }
}
/** Change the step style; the defaults are stored as nothing (the server rule). */
export function setStepStyle(e: VideoEdits, patch: Partial<StepStyle>): VideoEdits {
  const { step_style: _drop, ...rest } = e
  const next = { ...stepStyleOf(e), ...patch }
  const isDefault =
    next.shape === STEP_STYLE_DEFAULTS.shape && next.size === STEP_STYLE_DEFAULTS.size
  return (isDefault ? rest : { ...rest, step_style: next }) as VideoEdits
}
/** Each step's number (the server's stepNumbers): steps viewers see, in
 *  timeline order (start, then top to bottom, then left to right), from 1. */
export function stepNumbers(e: VideoEdits): Map<string, number> {
  const steps = e.annotations
    .filter((a) => a.type === 'step' && !isHiddenByCuts(e, a.start_ms, a.end_ms))
    .sort((a, b) => a.start_ms - b.start_ms || a.rect.y - b.rect.y || a.rect.x - b.rect.x)
  return new Map(steps.map((a, i) => [a.id, i + 1]))
}
/** How long a callout, step or caption should stay up for its text: about 3
 *  words a second, never under 2 seconds, in 0.1-second steps. */
export const READ_WORDS_PER_SECOND = 3
export const READ_MIN_MS = 2000
export function textDurationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length
  const ms = Math.ceil((words / READ_WORDS_PER_SECOND) * 10) * 100
  return Math.max(READ_MIN_MS, ms)
}
