import { type VideoEdits, viewAt } from './help-video-edits.js'

// The recorded cursor and shortcut badges (#1517): the pointer path the
// recorder sampled on the author's own tab (source time, frame fractions)
// and the shortcuts pressed meanwhile. The render burns a smoothed,
// highlighted cursor (a soft halo with a pointer glyph) and the badges in
// from an ASS subtitle file built here — one event per stretch of the path,
// with \move between its two ends, which stays small and quick however many
// samples there are. The shared twin (pointer.ts) draws the same cursor live
// in the player — keep the limits, smoothing, sizes and badge timing in step.

export type PointerSample = { t_ms: number; x: number; y: number }
export type RecordedShortcut = { t_ms: number; keys: string }
export type PointerPath = { samples: PointerSample[]; shortcuts: RecordedShortcut[] }

/** The recorder samples the pointer this often (~20 Hz), when it moved. */
export const POINTER_SAMPLE_MS = 50
export const POINTER_LIMITS = {
  /** Samples kept per recording, thinned evenly past this (~450 KB of JSON). */
  samples: 12_000,
  shortcuts: 2000,
  keys: 24,
  /** 31 minutes: a recording may run a little past the 30:00 limit. */
  maxMs: 31 * 60_000
}
/** A shortcut badge stays up this long (source time), or until the next one. */
export const SHORTCUT_BADGE_MS = 1200
/** The cursor's size as a share of the picture's width: the halo's radius
 *  and the pointer glyph's height. */
export const CURSOR_HALO = 14 / 1280
export const CURSOR_POINTER = 20 / 1280
/** Inside a zoom the picture moves under a still pointer, so a stretch of
 *  the path there is drawn in pieces no longer than this. */
const ZOOM_PIECE_MS = 100

const KEYS_RE = /^[\x21-\x7e]{1,24}$/
const r4 = (n: number) => Math.round(n * 10_000) / 10_000
const frac = (n: number) => r4(Math.min(1, Math.max(0, n)))

/** At most `max` samples, spread evenly (first and last kept). */
export function thinPointerPath(samples: PointerSample[], max = POINTER_LIMITS.samples) {
  if (max < 2) return samples.slice(0, Math.max(0, max))
  if (samples.length <= max) return samples
  const k = (samples.length - 1) / (max - 1)
  const out: PointerSample[] = []
  for (let i = 0; i < max; i++) out.push(samples[Math.round(i * k)])
  return out
}

/**
 * The recorder's pointer path as stored: broken samples dropped, times and
 * positions clamped and rounded, sorted, one sample per moment, thinned to
 * the cap; shortcuts likewise, their keys checked (printable ASCII, at most
 * POINTER_LIMITS.keys). Null stays null (capture was off); a path with no
 * samples and no shortcuts is null too.
 */
export function normalizePointer(raw: unknown): PointerPath | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as { samples?: unknown; shortcuts?: unknown }
  const samples: PointerSample[] = []
  if (Array.isArray(o.samples)) {
    for (const s of o.samples) {
      if (!s || typeof s !== 'object') continue
      const r = s as Record<string, unknown>
      const t = Number(r.t_ms)
      const x = Number(r.x)
      const y = Number(r.y)
      if (![t, x, y].every(Number.isFinite) || t < 0 || t > POINTER_LIMITS.maxMs) continue
      samples.push({ t_ms: Math.round(t), x: frac(x), y: frac(y) })
    }
  }
  samples.sort((a, b) => a.t_ms - b.t_ms)
  const unique: PointerSample[] = []
  for (const s of samples)
    if (!unique.length || unique[unique.length - 1].t_ms !== s.t_ms) unique.push(s)
  const shortcuts: RecordedShortcut[] = []
  if (Array.isArray(o.shortcuts)) {
    for (const s of o.shortcuts) {
      if (!s || typeof s !== 'object') continue
      const r = s as Record<string, unknown>
      const t = Number(r.t_ms)
      if (!Number.isFinite(t) || t < 0 || t > POINTER_LIMITS.maxMs) continue
      if (typeof r.keys !== 'string' || !KEYS_RE.test(r.keys)) continue
      shortcuts.push({ t_ms: Math.round(t), keys: r.keys })
    }
  }
  shortcuts.sort((a, b) => a.t_ms - b.t_ms)
  const out = {
    samples: thinPointerPath(unique),
    shortcuts: shortcuts.slice(0, POINTER_LIMITS.shortcuts)
  }
  return out.samples.length || out.shortcuts.length ? out : null
}

/** Each sample averaged with its neighbours when they are within three
 *  sample gaps (the shared smoothPointerPath): jitter settles, holds stay. */
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

/** Where the pointer was at a SOURCE moment (the shared pointerAt): null
 *  before the first sample, held after the last, and a hold-then-move
 *  across a gap (a sample is only taken when the pointer moved). */
export function pointerAt(
  samples: PointerSample[],
  srcMs: number
): { x: number; y: number } | null {
  if (!samples.length || srcMs < samples[0].t_ms) return null
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

const KEY_GLYPHS: Record<string, string> = {
  Meta: '⌘',
  Shift: '⇧',
  Enter: '↵ Enter',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'Page Up',
  PageDown: 'Page Down'
}
const GLYPH_MODIFIERS = new Set(['Meta', 'Shift'])
/** What a badge shows for stored keys (the shared shortcutLabel). */
export function shortcutLabel(keys: string): string {
  const parts = keys.split('+').filter(Boolean)
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    if (i > 0 && !GLYPH_MODIFIERS.has(parts[i - 1])) out += '+'
    out += KEY_GLYPHS[parts[i]] ?? parts[i]
  }
  return out
}

/** The badges in SOURCE time: each shortcut from its press until
 *  SHORTCUT_BADGE_MS later, the next badge or the end of the recording. */
export function badgeWindows(
  shortcuts: RecordedShortcut[],
  endMs: number
): Array<{ start_ms: number; end_ms: number; keys: string }> {
  const out: Array<{ start_ms: number; end_ms: number; keys: string }> = []
  shortcuts.forEach((s, i) => {
    const next = shortcuts[i + 1]?.t_ms ?? Number.POSITIVE_INFINITY
    const end = Math.min(s.t_ms + SHORTCUT_BADGE_MS, next, endMs)
    if (end > s.t_ms) out.push({ start_ms: s.t_ms, end_ms: end, keys: s.keys })
  })
  return out
}

// ── The ASS file ─────────────────────────────────────────────────────────

export interface CursorAssInput {
  pointer: PointerPath
  edits: VideoEdits
  /** The finished picture's size (the render's `out`): the ASS play area. */
  out: { width: number; height: number }
  /** How long the recording is (source time): the last badge ends there. */
  durationMs: number
  /** Draw the shortcut badges too (edits.cursor.shortcuts). */
  shortcuts: boolean
  /** The badge's look: light text on a dark plate (default) or the reverse. */
  badge?: 'dark' | 'light'
}

/** h:mm:ss.cc, ASS's own time format (centiseconds). */
export function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10))
  const h = Math.floor(cs / 360_000)
  const m = Math.floor((cs % 360_000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

/** Text safe inside an ASS event: braces and backslashes would start
 *  override tags, and a line break would start another event. */
export function assText(s: string): string {
  return s.replace(/[{}\\\r\n]/g, '')
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toString()

/** A circle of radius r with its top-left at (0,0), as ASS drawing commands
 *  (four Bézier arcs). */
function circlePath(r: number): string {
  const k = 0.5523 * r
  const d = 2 * r
  return (
    `m ${n1(r)} 0 b ${n1(r + k)} 0 ${n1(d)} ${n1(r - k)} ${n1(d)} ${n1(r)} ` +
    `b ${n1(d)} ${n1(r + k)} ${n1(r + k)} ${n1(d)} ${n1(r)} ${n1(d)} ` +
    `b ${n1(r - k)} ${n1(d)} 0 ${n1(r + k)} 0 ${n1(r)} ` +
    `b 0 ${n1(r - k)} ${n1(r - k)} 0 ${n1(r)} 0`
  )
}
/** The pointer glyph, its tip at (0,0), `h` tall: the classic arrow. */
function pointerPath(h: number): string {
  const u = h / 20
  const pts: Array<[number, number]> = [
    [0, 0],
    [0, 20],
    [5, 15],
    [8.5, 23],
    [12, 21.5],
    [8.5, 14],
    [15, 14]
  ]
  return pts.map(([x, y], i) => `${i === 0 ? 'm' : 'l'} ${n1(x * u)} ${n1(y * u)}`).join(' ')
}

/**
 * The ASS file the render burns in. The path is smoothed, then drawn as one
 * stretch per pair of samples (a hold, then a move, when the pointer stood
 * still between them): a halo event and a pointer event each, with \move
 * between the two ends in picture pixels. The picture's crop and zoom at
 * each moment are applied (viewAt), so the cursor sits on what it pointed at;
 * inside a zoom a stretch is cut into short pieces, since the picture moves
 * under the pointer. A stretch outside the visible picture is left out. Then
 * the badges, bottom-left, one event each.
 */
export function buildCursorAss(input: CursorAssInput): string {
  const { out, edits } = input
  const W = out.width
  const H = out.height
  const r = Math.max(4, W * CURSOR_HALO)
  const ph = Math.max(6, W * CURSOR_POINTER)
  const badgeSize = Math.max(10, Math.round(W / 56))
  const outline = Math.max(1, Math.round((W / 1280) * 15) / 10)
  const halo = circlePath(r)
  const glyph = pointerPath(ph)
  const lines: string[] = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // The halo: the accent blue (#2563eb → &HEB6325) at 55 % opacity, no border.
    'Style: Halo,DejaVu Sans,20,&H73EB6325,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    // The pointer: white with a dark edge.
    `Style: Pointer,DejaVu Sans,20,&H00FFFFFF,&H000000FF,&H00141414,&H00000000,0,0,0,0,100,100,0,0,1,${n1(outline)},0,7,0,0,0,1`,
    // The badges: an opaque plate (BorderStyle 3) around bold text.
    `Style: Badge,DejaVu Sans,${badgeSize},&H00FFFFFF,&H000000FF,&HBF101010,&HBF101010,-1,0,0,0,100,100,0,0,3,${Math.round(badgeSize * 0.4)},0,1,0,0,0,1`,
    `Style: BadgeLight,DejaVu Sans,${badgeSize},&H00101010,&H000000FF,&HBFFFFFFF,&HBFFFFFFF,-1,0,0,0,100,100,0,0,3,${Math.round(badgeSize * 0.4)},0,1,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]
  const samples = smoothPointerPath(input.pointer.samples)
  /** The pointer at `t`, through the picture's view at `viewT`. */
  const px = (t: number, viewT = t): { x: number; y: number } | null => {
    const p = pointerAt(samples, t)
    if (!p) return null
    const v = viewAt(edits, viewT)
    return { x: (p.x * v.sx + v.ox) * W, y: (p.y * v.sy + v.oy) * H }
  }
  const inZoom = (a: number, b: number) => edits.zooms.some((z) => a >= z.start_ms && b <= z.end_ms)
  const visible = (p: { x: number; y: number }) =>
    p.x >= -r && p.x <= W + r && p.y >= -r && p.y <= H + r
  const event = (
    start: number,
    end: number,
    a: { x: number; y: number },
    b: { x: number; y: number }
  ) => {
    if (end - start < 10 || !visible(a) || !visible(b)) return
    const still = Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05
    const at = (dx: number, dy: number) =>
      still
        ? `\\pos(${n1(a.x + dx)},${n1(a.y + dy)})`
        : `\\move(${n1(a.x + dx)},${n1(a.y + dy)},${n1(b.x + dx)},${n1(b.y + dy)})`
    const t = `${assTime(start)},${assTime(end)}`
    lines.push(
      `Dialogue: 0,${t},Halo,,0,0,0,,{\\an7${at(-r, -r)}\\blur${n1(r / 5)}\\p1}${halo}{\\p0}`
    )
    lines.push(`Dialogue: 1,${t},Pointer,,0,0,0,,{\\an7${at(0, 0)}\\p1}${glyph}{\\p0}`)
  }
  /** One event pair. A piece outside every zoom reads the view just inside
   *  its own ends, so a zoom starting or ending exactly there is not seen. */
  const piece = (start: number, end: number, zoomed: boolean) => {
    const a = px(start, zoomed ? start : Math.min(start + 1, end))
    const b = px(end, zoomed ? end : Math.max(end - 1, start))
    if (a && b) event(start, end, a, b)
  }
  /** A stretch between two moments: whole outside the zooms, cut at their
   *  edges, and in short pieces inside them. */
  const stretch = (start: number, end: number) => {
    if (end <= start) return
    const cuts = new Set([start, end])
    for (const z of edits.zooms) {
      if (z.start_ms > start && z.start_ms < end) cuts.add(z.start_ms)
      if (z.end_ms > start && z.end_ms < end) cuts.add(z.end_ms)
    }
    const at = [...cuts].sort((a, b) => a - b)
    for (let i = 1; i < at.length; i++) {
      const a = at[i - 1]
      const b = at[i]
      if (!inZoom(a, b)) piece(a, b, false)
      else for (let t = a; t < b; t += ZOOM_PIECE_MS) piece(t, Math.min(b, t + ZOOM_PIECE_MS), true)
    }
  }
  const endMs = Math.max(0, input.durationMs)
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i]
    const b = samples[i + 1]
    if (!b) {
      // The pointer stays where it was last seen until the recording ends.
      stretch(a.t_ms, endMs)
      break
    }
    const moveStart = Math.max(a.t_ms, b.t_ms - POINTER_SAMPLE_MS * 2)
    if (moveStart > a.t_ms) stretch(a.t_ms, moveStart)
    stretch(moveStart, b.t_ms)
  }
  if (input.shortcuts) {
    const style = input.badge === 'light' ? 'BadgeLight' : 'Badge'
    const x = n1(W * 0.03)
    const y = n1(H * 0.95)
    for (const w of badgeWindows(input.pointer.shortcuts, endMs)) {
      lines.push(
        `Dialogue: 2,${assTime(w.start_ms)},${assTime(w.end_ms)},${style},,0,0,0,,{\\an1\\pos(${x},${y})}${assText(shortcutLabel(w.keys))}`
      )
    }
  }
  return `${lines.join('\n')}\n`
}
