/**
 * Live follow and paused frames: how the player starts rrweb at the live edge
 * of a recording that is still running, and the CSS the replay frame gets.
 *
 * rrweb's own `startLive()` is NOT used to join a running recording. It only
 * moves the clock: none of the events already loaded (everything after the
 * first full snapshot) is ever applied, so the viewer sees the page as it was
 * when the recording began, and later mutations aimed at nodes it never built
 * are dropped. It also leaves rrweb outside its "playing" state, so the frame
 * keeps `rrweb-paused` on its <html> and every CSS animation stays frozen. The
 * page outlet's entrance animation (efp-new `.page-enter`, admin
 * `.animate-page-enter`: opacity 0 → 1, `fill-mode: backwards`) froze on its
 * first frame. The sidebar and header showed and the content view stayed blank
 * (staging, 2026-10-28).
 *
 * `play(offset)` in liveMode does both jobs: it applies everything before the
 * live edge at once (from the last full snapshot before it) and leaves rrweb
 * playing. Events the poll appends later go in through `addEvent`, as before.
 */

/** How far behind the newest event live follow plays; absorbs poll jitter. */
export const LIVE_LAG_MS = 4_000

/**
 * Where live follow starts, in ms from the recording's first event: `lagMs`
 * before the newest event (never before the start).
 */
export function liveStartOffset(events: unknown[], lagMs = LIVE_LAG_MS): number {
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY
  for (const e of events) {
    const t = (e as { timestamp?: unknown } | null)?.timestamp
    if (typeof t !== 'number' || !Number.isFinite(t)) continue
    if (t < first) first = t
    if (t > last) last = t
  }
  if (!Number.isFinite(first)) return 0
  return Math.max(0, last - lagMs - first)
}

/** Start a liveMode Replayer at the live edge with the page fully built. */
export function startLiveFollow(
  replayer: { play: (timeOffset?: number) => void },
  events: unknown[],
  lagMs = LIVE_LAG_MS
): number {
  const offset = liveStartOffset(events, lagMs)
  replayer.play(offset)
  return offset
}

/**
 * Extra CSS for the replay frame (rrweb `insertStyleRules`). While rrweb holds
 * a frame paused it pauses every CSS animation where it is. A frame built while
 * paused (a seek while paused, the Inspector) would then keep every entrance
 * animation on its first frame: page content at opacity 0, popovers scaled down.
 * A paused frame shows animations at their resting state instead. Playing again
 * gives them back their real length, so motion resumes as recorded.
 */
export const REPLAY_FRAME_STYLE_RULES = [
  'html.rrweb-paused *, html.rrweb-paused *::before, html.rrweb-paused *::after { animation-duration: 0s !important; animation-delay: 0s !important; }'
]
