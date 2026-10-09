import type {
  BannerContent,
  CardBrandShown,
  IntroCardContent,
  OutroCardContent
} from './cardDesign'
import { chapterBannerWindows, editedDuration, OUTRO_DEFAULT_TEXT } from './edits'
import type { VideoEdits } from './types'
import { visibleChapters } from './viewer/format'

// What the intro card, end card and chapter banner SAY. How they look is
// cardDesign.ts (shared byte for byte with the render). The server's
// cardText (api/src/services/help-video-cards.ts) says the same words — keep
// the two in step.

export type CardBrand = {
  /** The instance name, shown when there is no logo. */
  name: string | null
  /** #rrggbb accent: the rule under the logo and the banner's dot. */
  color: string
  /** An image URL the browser can load (the player prefixes the API origin). */
  logo: string | null
}

export { CARD_FONT } from './cardDesign'
export const DEFAULT_CARD_ACCENT = '#00ceff'
/** At most this many chapters are listed on the intro card. */
export const INTRO_CHAPTER_MAX = 6

/** One card "pixel": 1 at 1280 px wide. */
export function cardUnit(canvasWidth: number): number {
  return canvasWidth > 0 ? canvasWidth / 1280 : 1
}

export function cardAccent(v: unknown): string {
  const s = String(v ?? '').trim()
  const hex = s.startsWith('#') ? s : `#${s}`
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : DEFAULT_CARD_ACCENT
}

/** The first non-blank line of a description, whitespace collapsed. */
export function firstLine(text: string | null | undefined, max = 200): string {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find(Boolean)
  return (line ?? '').slice(0, max)
}

/** What the intro card says. Blank card fields fall back to the video's own
 *  title and the first line of its description. */
export function introContent(
  e: VideoEdits,
  video: { title: string | null | undefined; description: string | null | undefined }
): IntroCardContent {
  const title = e.intro?.title?.trim() || String(video.title ?? '').trim() || 'Untitled video'
  const subtitle = e.intro?.subtitle?.trim() || firstLine(video.description)
  const all = e.intro?.show_chapters ? visibleChapters(e).map((c) => c.title) : []
  return {
    title,
    subtitle,
    chapters: all.slice(0, INTRO_CHAPTER_MAX),
    more: Math.max(0, all.length - INTRO_CHAPTER_MAX),
    duration_ms: editedDuration(e)
  }
}

export function outroContent(
  e: VideoEdits,
  video?: { title: string | null | undefined }
): OutroCardContent {
  return {
    text: e.outro?.text?.trim() || OUTRO_DEFAULT_TEXT,
    title: String(video?.title ?? '').trim()
  }
}

/** The banner showing at an edited time, if any, with its place among the
 *  chapters viewers see. */
export function bannerAt(e: VideoEdits, editedMs: number): (BannerContent & { id: string }) | null {
  const w = chapterBannerWindows(e).find((b) => editedMs >= b.start_ms && editedMs < b.end_ms)
  if (!w) return null
  const seen = visibleChapters(e)
  return {
    id: w.id,
    title: w.title,
    index: seen.findIndex((c) => c.id === w.id) + 1,
    total: seen.length
  }
}

/** The brand as the cards draw it for this video: its own name
 *  (card_brand) beats the instance name; the logo and colour stay. */
export function shownBrand(brand: CardBrand, e: VideoEdits): CardBrandShown {
  return { name: e.card_brand?.trim() || brand.name, color: brand.color, logo: brand.logo }
}
