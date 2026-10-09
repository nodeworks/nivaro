import type { VideoEdits } from '../types'

/** The recorder stores one microphone level every 100 ms. */
const SAMPLE_MS = 100
/** Levels run 0 (silence) to 1. Below 0.06 is room noise, not speech. */
const QUIET = 0.06

export type Stretch = { start_ms: number; end_ms: number }

/** Long silent stretches (from the recorder's microphone levels) that are
 *  still inside kept pieces — candidates to cut or speed up. */
export function suggestCuts(
  levels: number[] | null,
  edits: VideoEdits,
  opts: { threshold?: number; minMs?: number; padMs?: number } = {}
): Stretch[] {
  if (!levels?.length) return []
  const threshold = opts.threshold ?? QUIET
  const minMs = opts.minMs ?? 3000
  const pad = opts.padMs ?? 300
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
  // Only silences inside a kept piece playing at normal speed: a cut-away or
  // sped-up pause has been dealt with and leaves the list.
  return runs.filter((r) =>
    edits.segments.some((s) => s.speed === 1 && r.start_ms >= s.start_ms && r.end_ms <= s.end_ms)
  )
}
