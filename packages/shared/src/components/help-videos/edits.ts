import type {
  Annotation,
  Blur,
  Caption,
  Chapter,
  IntroCard,
  OutroCard,
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
  zoomMinSide: 0.25,
  cardMinMs: 2000,
  cardMaxMs: 6000,
  cardDefaultMs: 3000,
  introTitle: 120,
  introSubtitle: 200,
  outroText: 200,
  cardBrand: 60,
  /** How long a chapter banner stays up, in edited time. */
  bannerMs: 2500
} as const
/** Same text as the server's OUTRO_DEFAULT_TEXT. */
export const OUTRO_DEFAULT_TEXT = 'Questions? Ask your administrator.'
export const MIN_KEPT_MS = EDIT_LIMITS.minKeptMs
const MIN_SEGMENT_MS = EDIT_LIMITS.minSegmentMs
export type ListKey = 'chapters' | 'annotations' | 'zooms' | 'blurs' | 'captions'

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export function newId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
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
export function keptMs(e: VideoEdits): number {
  return e.segments.reduce((t, s) => t + (s.end_ms - s.start_ms), 0)
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
/** The intro / outro the server would store for an editor change: the
 *  server's normalizeIntro / normalizeOutro rules (off = absent). */
export function setIntro(e: VideoEdits, intro: Partial<IntroCard> | null): VideoEdits {
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
  return { ...rest, intro: next } as VideoEdits
}
export function setOutro(e: VideoEdits, outro: Partial<OutroCard> | null): VideoEdits {
  const { outro: _drop, ...rest } = e
  if (!outro) return dropPosterCard(rest as VideoEdits, 'outro')
  const cur = e.outro
  const next: OutroCard = {
    enabled: true,
    duration_ms: clampCardMs(outro.duration_ms ?? cur?.duration_ms),
    text: (outro.text ?? cur?.text ?? '').slice(0, EDIT_LIMITS.outroText)
  }
  return { ...rest, outro: next } as VideoEdits
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
export function setChapterBanners(e: VideoEdits, on: boolean): VideoEdits {
  const { chapter_banners: _drop, ...rest } = e
  return (on ? { ...rest, chapter_banners: true } : rest) as VideoEdits
}
function clampCardMs(v: number | undefined): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : EDIT_LIMITS.cardDefaultMs
  return Math.round(clamp(n, EDIT_LIMITS.cardMinMs, EDIT_LIMITS.cardMaxMs))
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
