import { EDIT_LIMITS } from './edits'
import { pointerAt } from './pointer'
import type { Point, PointerSample, Zoom, ZoomKeyframe } from './types'

// "Follow the pointer" (#1540): a moving zoom's stops made from the recorded
// pointer path (#1517), kept pure so the editor's button is a one-liner and
// the maths is tested on its own.

/** A stop about every half second; fewer when the zoom is long (at most
 *  EDIT_LIMITS.zoomKeyframes stops) or the pointer is still. */
export const FOLLOW_STEP_MS = 500
/** Movement smaller than this (a frame fraction) between stops is "still":
 *  the stops inside a still stretch are left out. */
export const FOLLOW_STILL = 0.01
const r3 = (n: number) => Math.round(n * 1000) / 1000
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** The pointer's average position over a window (a moving average that
 *  settles hand jitter), or null when it was never seen in it. */
function averageOver(samples: PointerSample[], from: number, to: number): Point | null {
  let x = 0
  let y = 0
  let n = 0
  const steps = 4
  for (let i = 0; i <= steps; i++) {
    const p = pointerAt(samples, from + ((to - from) * i) / steps)
    if (!p) continue
    x += p.x
    y += p.y
    n++
  }
  return n ? { x: x / n, y: y / n } : null
}

/**
 * Stops for a zoom that follows the pointer: the zoom's own size, centred
 * on the smoothed pointer position every `stepMs` over the zoom's span
 * (stretched so the stops fit EDIT_LIMITS.zoomKeyframes) and kept inside the
 * frame; the stops inside a stretch where the pointer stays still are left
 * out, so the zoom holds there. Null when the pointer was not seen during
 * the zoom (the recording has no path, or it was not on this tab then). The
 * result can be edited like any other stop afterwards.
 */
export function followPointerKeyframes(
  z: Zoom,
  samples: PointerSample[] | null | undefined,
  stepMs = FOLLOW_STEP_MS
): ZoomKeyframe[] | null {
  if (!samples?.length) return null
  const span = z.end_ms - z.start_ms
  if (span <= 0) return null
  const count = clamp(Math.floor(span / stepMs) + 1, 2, EDIT_LIMITS.zoomKeyframes)
  const step = span / (count - 1)
  const side = z.rect.w
  const at: Array<{ t: number; p: Point | null }> = []
  for (let i = 0; i < count; i++) {
    const t = Math.round(z.start_ms + i * step)
    at.push({ t, p: averageOver(samples, t - step / 2, t + step / 2) })
  }
  // Before the pointer was first seen, the zoom waits where it is first seen.
  const firstSeen = at.find((s) => s.p)?.p
  if (!firstSeen) return null
  let last: Point = firstSeen
  const positions = at.map((s) => {
    last = s.p ?? last
    return { t: s.t, p: last }
  })
  const still = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < FOLLOW_STILL
  const out: ZoomKeyframe[] = []
  positions.forEach((s, i) => {
    const prev = positions[i - 1]
    const next = positions[i + 1]
    const edge = !prev || !next
    if (!edge && still(prev.p, s.p) && still(s.p, next.p)) return
    out.push({
      at_ms: s.t,
      rect: {
        x: r3(clamp(s.p.x - side / 2, 0, 1 - side)),
        y: r3(clamp(s.p.y - side / 2, 0, 1 - side)),
        w: side,
        h: side
      }
    })
  })
  return out.length >= 2 ? out : null
}
