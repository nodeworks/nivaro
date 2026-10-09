import type { CaptionStyle } from '../types'

// Links to a moment in a help video (#1501). The contract every host follows:
//   <app path to the videos page>?watch=<video id>&t=<whole seconds>[&c=<chapter id>]
// A chapter (`c`) that resolves wins over `t`.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CHAPTER_RE = /^[A-Za-z0-9_-]{1,40}$/

/** `t` (whole seconds) and `c` (chapter id) as given in a link; junk reads as absent. */
export function momentFromParams(
  t: string | null | undefined,
  c: string | null | undefined
): { atMs: number | null; chapterId: string | null } {
  const atMs = t != null && /^\d{1,6}$/.test(t) ? Number(t) * 1000 : null
  return { atMs, chapterId: c && CHAPTER_RE.test(c) ? c : null }
}

/** Where the player starts: the chapter when it resolves, else `atMs`
 *  (kept inside the video), else null (the viewer's resume point). */
export function resolveMomentStart(
  chapters: Array<{ id: string; edited_ms: number }>,
  durationMs: number | null | undefined,
  atMs: number | null,
  chapterId: string | null
): number | null {
  const hit = chapterId ? chapters.find((c) => c.id === chapterId) : undefined
  if (hit) return hit.edited_ms
  if (atMs == null) return null
  const total = Number(durationMs) > 0 ? Number(durationMs) : null
  return total ? Math.max(0, Math.min(atMs, total - 1000)) : Math.max(0, atMs)
}

/** A shareable link. `atMs` rounds down to whole seconds; 0 leaves `t` out. */
export function momentLink(
  origin: string,
  videosPath: string,
  id: string,
  opts: { atMs?: number | null; chapterId?: string | null } = {}
): string {
  const q = new URLSearchParams({ watch: id })
  const secs = opts.atMs != null ? Math.floor(Math.max(0, opts.atMs) / 1000) : 0
  if (secs > 0) q.set('t', String(secs))
  if (opts.chapterId) q.set('c', opts.chapterId)
  return `${origin}${videosPath}?${q.toString()}`
}

/** The moment a pasted link names (any origin, any path), or null. */
export function parseMomentUrl(
  raw: string
): { id: string; search: string; atMs: number | null; chapterId: string | null } | null {
  let u: URL
  try {
    u = new URL(raw, 'http://app.local')
  } catch {
    return null
  }
  const id = u.searchParams.get('watch')
  if (!id || !UUID_RE.test(id)) return null
  const m = momentFromParams(u.searchParams.get('t'), u.searchParams.get('c'))
  const q = new URLSearchParams({ watch: id.toLowerCase() })
  if (m.atMs) q.set('t', String(m.atMs / 1000))
  if (m.chapterId) q.set('c', m.chapterId)
  return { id: id.toLowerCase(), search: `?${q.toString()}`, ...m }
}

// ── Caption settings (#1529) ────────────────────────────────────────────────

export const CAPTION_DEFAULTS: CaptionStyle = {
  size: 'm',
  background: 'shaded',
  position: 'bottom'
}
export const CAPTION_SIZE_SCALE: Record<CaptionStyle['size'], number> = {
  s: 0.8,
  m: 1,
  l: 1.3,
  xl: 1.65
}

/** The person's saved caption settings (preferences.help_video_captions)
 *  over `base`: the video's own caption look (#1551), else the defaults. A
 *  key the person set wins; a key they never set follows the video. */
export function captionStyleFrom(
  prefs: Record<string, unknown> | null | undefined,
  base: CaptionStyle = CAPTION_DEFAULTS
): CaptionStyle {
  const raw = (prefs?.help_video_captions ?? null) as Record<string, unknown> | null
  const pick = <K extends keyof CaptionStyle>(k: K, allowed: readonly CaptionStyle[K][]) =>
    raw && allowed.includes(raw[k] as CaptionStyle[K]) ? (raw[k] as CaptionStyle[K]) : base[k]
  return {
    size: pick('size', ['s', 'm', 'l', 'xl']),
    background: pick('background', ['none', 'shaded', 'solid']),
    position: pick('position', ['bottom', 'top'])
  }
}

/** What to store after the person changes `current` to `next` while watching
 *  a video whose own look is `base`: the keys they changed are kept as their
 *  choice (even when that is the default, so it beats a video's look), the
 *  keys they set before stay, and a key equal to both the default and the
 *  video's look is dropped. Null when nothing is left. */
export function captionPrefsAfter(
  prefs: Record<string, unknown> | null | undefined,
  current: CaptionStyle,
  next: CaptionStyle,
  base: CaptionStyle = CAPTION_DEFAULTS
): Partial<CaptionStyle> | null {
  const kept = captionStyleFrom(prefs, {
    size: null,
    background: null,
    position: null
  } as unknown as CaptionStyle)
  const out: Partial<CaptionStyle> = {}
  for (const k of Object.keys(CAPTION_DEFAULTS) as Array<keyof CaptionStyle>) {
    // What the person set before (null when they never set this key).
    const was = kept[k] ?? undefined
    const v = next[k] !== current[k] ? next[k] : was
    if (v === undefined) continue
    if (v === CAPTION_DEFAULTS[k] && v === base[k]) continue
    ;(out as Record<string, string>)[k] = v
  }
  return Object.keys(out).length ? out : null
}

/** What to store: only the keys that differ from the defaults (null when none). */
export function captionStylePatch(s: CaptionStyle): Partial<CaptionStyle> | null {
  const out: Partial<CaptionStyle> = {}
  for (const k of Object.keys(CAPTION_DEFAULTS) as Array<keyof CaptionStyle>) {
    if (s[k] !== CAPTION_DEFAULTS[k]) (out as Record<string, string>)[k] = s[k]
  }
  return Object.keys(out).length ? out : null
}
