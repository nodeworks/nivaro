import { chapterBannerWindows, OUTRO_DEFAULT_TEXT } from './edits'
import type { VideoEdits } from './types'
import { visibleChapters } from './viewer/format'

// The intro card, outro card and chapter banner, as words and measurements.
// The server draws the same cards into the render
// (api/src/services/help-video-cards.ts — keep the two in step): sizes are in
// canvas pixels at 1280 px wide (`cardUnit` scales them), colours and text
// rules are the same.

export type CardBrand = {
  /** The instance name, shown when there is no logo. */
  name: string | null
  /** #rrggbb accent: the rule under the logo and the banner's dot. */
  color: string
  /** An image URL the browser can load (the player prefixes the API origin). */
  logo: string | null
}

/** The card ground and inks: dark, so any brand accent reads on it. */
export const CARD_COLORS = {
  ground: '#0f172a',
  title: '#ffffff',
  body: '#cbd5e1',
  label: '#94a3b8',
  item: '#e2e8f0',
  banner: 'rgba(15, 23, 42, 0.88)'
} as const
export const CARD_FONT = 'Arial, Helvetica, sans-serif'
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
): { title: string; subtitle: string; chapters: string[]; more: number } {
  const title = e.intro?.title?.trim() || String(video.title ?? '').trim() || 'Untitled video'
  const subtitle = e.intro?.subtitle?.trim() || firstLine(video.description)
  const all = e.intro?.show_chapters ? visibleChapters(e).map((c) => c.title) : []
  return {
    title,
    subtitle,
    chapters: all.slice(0, INTRO_CHAPTER_MAX),
    more: Math.max(0, all.length - INTRO_CHAPTER_MAX)
  }
}

export function outroContent(e: VideoEdits): string {
  return e.outro?.text?.trim() || OUTRO_DEFAULT_TEXT
}

/** The banner showing at an edited time, if any. */
export function bannerAt(e: VideoEdits, editedMs: number): { id: string; title: string } | null {
  const w = chapterBannerWindows(e).find((b) => editedMs >= b.start_ms && editedMs < b.end_ms)
  return w ? { id: w.id, title: w.title } : null
}
