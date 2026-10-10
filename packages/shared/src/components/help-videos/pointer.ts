import type { Point, PointerSample, RecordedShortcut } from './types'

// The recorded pointer path and shortcuts (#1517), kept pure: the recorder
// samples and thins with it, the player and the editor read positions and
// badges from it. The server's twin (api/src/services/help-video-cursor.ts)
// normalizes what is stored and draws the same cursor into the render —
// keep the limits, the smoothing and the badge timing in step.

/** The recorder samples the pointer this often (~20 Hz); a sample is kept
 *  only when the pointer moved since the last one. */
export const POINTER_SAMPLE_MS = 50
export const POINTER_LIMITS = {
  /** Samples kept per recording (~20 Hz for 10 minutes; longer recordings
   *  are thinned evenly): about 450 KB of JSON at most. */
  samples: 12_000,
  shortcuts: 2000,
  /** `keys` length, e.g. `Ctrl+Shift+ArrowDown`. */
  keys: 24,
  /** 31 minutes: a recording may run a little past the 30:00 limit. */
  maxMs: 31 * 60_000
}
/** A shortcut badge stays up this long (source time), or until the next one. */
export const SHORTCUT_BADGE_MS = 1200
/** The pointer moved less than this (a frame fraction) = still: not a new sample. */
export const POINTER_STILL = 0.001
/** The cursor's size as a share of the picture's width (the render's and
 *  the player's): the halo's radius and the pointer glyph's height. */
export const CURSOR_HALO = 14 / 1280
export const CURSOR_POINTER = 20 / 1280

const r4 = (n: number) => Math.round(n * 10_000) / 10_000
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** At most `max` samples, spread evenly over the path (the first and the
 *  last always kept), so a long recording keeps a coarser path instead of
 *  losing its end. */
export function thinPointerPath(
  samples: PointerSample[],
  max = POINTER_LIMITS.samples
): PointerSample[] {
  if (max < 2) return samples.slice(0, Math.max(0, max))
  if (samples.length <= max) return samples
  const k = (samples.length - 1) / (max - 1)
  const out: PointerSample[] = []
  for (let i = 0; i < max; i++) out.push(samples[Math.round(i * k)])
  return out
}

/** The path with each sample's position averaged with its neighbours when
 *  they are close in time (within three sample gaps), so hand jitter settles
 *  without a hold (a long gap) being pulled toward the next move. Times are
 *  unchanged. */
export function smoothPointerPath(samples: PointerSample[]): PointerSample[] {
  const near = POINTER_SAMPLE_MS * 3
  return samples.map((s, i) => {
    let x = s.x
    let y = s.y
    let n = 1
    const prev = samples[i - 1]
    const next = samples[i + 1]
    if (prev && s.t_ms - prev.t_ms <= near) {
      x += prev.x
      y += prev.y
      n++
    }
    if (next && next.t_ms - s.t_ms <= near) {
      x += next.x
      y += next.y
      n++
    }
    return n === 1 ? s : { t_ms: s.t_ms, x: r4(x / n), y: r4(y / n) }
  })
}

/**
 * Where the pointer was at a SOURCE moment, in frame fractions: null before
 * the first sample (not seen yet), the last position after the last sample
 * (it stayed there), and between two samples a straight line — but since a
 * sample is only taken when the pointer moved, a long gap is a hold: the
 * position stays until two sample gaps before the next sample, then moves.
 */
export function pointerAt(samples: PointerSample[], srcMs: number): Point | null {
  if (!samples.length || srcMs < samples[0].t_ms) return null
  // Binary search for the last sample at or before the moment.
  let lo = 0
  let hi = samples.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (samples[mid].t_ms <= srcMs) lo = mid
    else hi = mid - 1
  }
  const a = samples[lo]
  const b = samples[lo + 1]
  if (!b) return { x: a.x, y: a.y }
  const moveStart = Math.max(a.t_ms, b.t_ms - POINTER_SAMPLE_MS * 2)
  if (srcMs <= moveStart || b.t_ms === moveStart) return { x: a.x, y: a.y }
  const u = (srcMs - moveStart) / (b.t_ms - moveStart)
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
}

/** The pointer sampler's rule: a new sample when the pointer moved at all. */
export function pointerMoved(a: Point | null, b: Point): boolean {
  return !a || Math.abs(a.x - b.x) >= POINTER_STILL || Math.abs(a.y - b.y) >= POINTER_STILL
}

const NAMED_KEYS = new Set([
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown'
])
const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'CapsLock', 'Fn'])
const KEYS_RE = /^[\x21-\x7e]{1,24}$/

/**
 * The shortcut a key press is, as stored (`Meta+S`, `Ctrl+Shift+ArrowDown`,
 * `Enter`), or null when it is typing: a character key without Ctrl, Meta
 * or Alt (Shift+letter is a capital), a modifier pressed alone, a dead or
 * composed key, or anything that would not store (non-ASCII, too long).
 * Named keys (Enter, Escape, Tab, arrows, Home/End, Page Up/Down, F1–F12)
 * count on their own; Space counts only with Ctrl, Meta or Alt.
 */
export function shortcutFromKey(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}): string | null {
  const key = e.key === ' ' ? 'Space' : e.key
  if (!key || MODIFIER_KEYS.has(key) || key === 'Dead' || key === 'Unidentified') return null
  const chord = e.ctrlKey || e.metaKey || e.altKey
  const named = NAMED_KEYS.has(key) || /^F([1-9]|1[0-2])$/.test(key)
  if (!chord && !named) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.metaKey) parts.push('Meta')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(key.length === 1 ? key.toUpperCase() : key)
  const keys = parts.join('+')
  return KEYS_RE.test(keys) ? keys : null
}

const KEY_GLYPHS: Record<string, string> = {
  Meta: '⌘',
  Shift: '⇧',
  Alt: 'Alt',
  Ctrl: 'Ctrl',
  Enter: '↵ Enter',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'Page Up',
  PageDown: 'Page Down'
}
/** What a badge shows for stored keys: `⌘S`, `Ctrl+K`, `⇧Tab`, `↵ Enter`;
 *  a glyph modifier joins its key directly, a word modifier with +. */
export function shortcutLabel(keys: string): string {
  const parts = keys.split('+').filter(Boolean)
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    if (i > 0 && !GLYPH_MODIFIERS.has(parts[i - 1])) out += '+'
    out += KEY_GLYPHS[parts[i]] ?? parts[i]
  }
  return out
}
/** Modifiers shown as one glyph join their key directly (⌘S, ⇧Tab). */
const GLYPH_MODIFIERS = new Set(['Meta', 'Shift'])

/** The badge up at a SOURCE moment: the latest shortcut pressed within
 *  SHORTCUT_BADGE_MS before it, unless a later one has taken its place. */
export function shortcutAt(shortcuts: RecordedShortcut[], srcMs: number): RecordedShortcut | null {
  let best: RecordedShortcut | null = null
  for (const s of shortcuts) {
    if (s.t_ms > srcMs) break
    if (srcMs - s.t_ms < SHORTCUT_BADGE_MS) best = s
    else best = null
  }
  return best
}

/** A pointer sample as the recorder stores it (4 places, inside the frame). */
export function pointerSample(t_ms: number, x: number, y: number): PointerSample {
  return { t_ms: Math.round(t_ms), x: r4(clamp01(x)), y: r4(clamp01(y)) }
}
