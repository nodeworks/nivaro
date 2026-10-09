import type { ActivitySpan, VideoEdits } from '../types'

/** The recorder stores one microphone level every 100 ms. */
const SAMPLE_MS = 100
/** Levels run 0 (silence) to 1. Below 0.06 is room noise, not speech. */
const QUIET = 0.06

export type Stretch = { start_ms: number; end_ms: number }

/** Silence = the microphone went quiet; idle = nothing was touched on the
 *  recorded tab; typing = keys went into a text field (#1518). */
export type SuggestionKind = 'silence' | 'idle' | 'typing'
/** A stretch to cut out or play at 4×. `action` is what the editor suggests;
 *  the author may pick either. */
export type Suggestion = Stretch & { kind?: SuggestionKind; action?: 'cut' | 'speed' }

/** Quiet runs at least `minMs` long, padded inward by `pad`. */
function quietRuns(levels: number[], threshold: number, minMs: number, pad: number): Stretch[] {
  const runs: Stretch[] = []
  let start: number | null = null
  for (let i = 0; i <= levels.length; i++) {
    const quiet = i < levels.length && levels[i] < threshold
    if (quiet && start === null) start = i
    if (!quiet && start !== null) {
      if ((i - start) * SAMPLE_MS >= minMs)
        runs.push({ start_ms: start * SAMPLE_MS + pad, end_ms: i * SAMPLE_MS - pad })
      start = null
    }
  }
  return runs
}

/** Long silent stretches (from the recorder's microphone levels) that are
 *  still inside kept pieces — candidates to cut or speed up. */
export function suggestCuts(
  levels: number[] | null,
  edits: VideoEdits,
  opts: { threshold?: number; minMs?: number; padMs?: number } = {}
): Stretch[] {
  if (!levels?.length) return []
  const runs = quietRuns(levels, opts.threshold ?? QUIET, opts.minMs ?? 3000, opts.padMs ?? 300)
  // Only silences inside a kept piece playing at normal speed: a cut-away or
  // sped-up pause has been dealt with and leaves the list.
  return runs.filter((r) =>
    edits.segments.some((s) => s.speed === 1 && r.start_ms >= s.start_ms && r.end_ms <= s.end_ms)
  )
}

/** Where the narration speaks: loud samples, with gaps under 0.7 s bridged. */
function speechRuns(levels: number[], threshold: number): Stretch[] {
  const out: Stretch[] = []
  levels.forEach((v, i) => {
    if (v < threshold) return
    const s = i * SAMPLE_MS
    const last = out[out.length - 1]
    if (last && s - last.end_ms < 700) last.end_ms = s + SAMPLE_MS
    else out.push({ start_ms: s, end_ms: s + SAMPLE_MS })
  })
  return out
}

/** `a` minus every stretch in `cuts` (sorted), as the pieces left over. */
function subtract(a: Stretch, cuts: Stretch[]): Stretch[] {
  let pieces: Stretch[] = [a]
  for (const c of cuts) {
    pieces = pieces.flatMap((p) => {
      if (c.end_ms <= p.start_ms || c.start_ms >= p.end_ms) return [p]
      const left = { start_ms: p.start_ms, end_ms: Math.min(p.end_ms, c.start_ms) }
      const right = { start_ms: Math.max(p.start_ms, c.end_ms), end_ms: p.end_ms }
      return [left, right].filter((x) => x.end_ms > x.start_ms)
    })
  }
  return pieces
}

const MIN_MS: Record<SuggestionKind, number> = { silence: 2000, idle: 2400, typing: 2000 }

/**
 * Everything the editor suggests cutting or speeding up, in source time and
 * never overlapping:
 * - long silences (the microphone levels) → cut, or 4× if the author prefers;
 * - idle stretches, 3 s+ with no input on the recorded tab → cut;
 * - typing in a text field → 4×, so viewers still see what was entered.
 * Narration is never touched: with levels, idle and typing stretches lose the
 * parts where the author speaks. Silence and idle stretches that overlap become
 * one cut (named idle — nothing moved and nothing was said); a cut beats a
 * speed-up where they overlap. Only what is still inside a kept piece at 1×
 * is offered (a handled stretch leaves the list).
 */
export function suggestEdits(
  levels: number[] | null,
  activity: ActivitySpan[] | null,
  edits: VideoEdits,
  opts: { threshold?: number; padMs?: number } = {}
): Suggestion[] {
  const threshold = opts.threshold ?? QUIET
  const pad = opts.padMs ?? 300
  const hasLevels = !!levels?.length
  const speech = hasLevels ? speechRuns(levels as number[], threshold) : []
  const unspoken = (s: Stretch) => (hasLevels ? subtract(s, speech) : [s])

  const cuts: Array<Stretch & { kind: SuggestionKind }> = [
    ...(hasLevels ? quietRuns(levels as number[], threshold, 3000, pad) : []).map((r) => ({
      ...r,
      kind: 'silence' as const
    })),
    ...(activity ?? [])
      .filter((a) => a.kind === 'idle')
      .flatMap((a) => unspoken({ start_ms: a.start_ms + pad, end_ms: a.end_ms - pad }))
      .filter((r) => r.end_ms - r.start_ms >= MIN_MS.idle)
      .map((r) => ({ ...r, kind: 'idle' as const }))
  ].sort((a, b) => a.start_ms - b.start_ms)
  // Overlapping (or touching) cuts become one.
  const merged: Array<Stretch & { kind: SuggestionKind }> = []
  for (const c of cuts) {
    const last = merged[merged.length - 1]
    if (last && c.start_ms <= last.end_ms) {
      last.end_ms = Math.max(last.end_ms, c.end_ms)
      if (c.kind === 'idle') last.kind = 'idle'
    } else merged.push({ ...c })
  }
  const typing = (activity ?? [])
    .filter((a) => a.kind === 'typing')
    .flatMap((a) => unspoken({ start_ms: a.start_ms, end_ms: a.end_ms }))
    .flatMap((t) => subtract(t, merged))
    .filter((r) => r.end_ms - r.start_ms >= MIN_MS.typing)
    .map((r) => ({ ...r, kind: 'typing' as const }))

  const kept = edits.segments.filter((s) => s.speed === 1)
  const out: Suggestion[] = []
  for (const c of [...merged, ...typing]) {
    for (const s of kept) {
      const start = Math.max(c.start_ms, s.start_ms)
      const end = Math.min(c.end_ms, s.end_ms)
      if (end - start < MIN_MS[c.kind]) continue
      out.push({
        start_ms: start,
        end_ms: end,
        kind: c.kind,
        action: c.kind === 'typing' ? 'speed' : 'cut'
      })
    }
  }
  return out.sort((a, b) => a.start_ms - b.start_ms)
}
