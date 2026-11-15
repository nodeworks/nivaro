import { useEffect, useRef, useState } from 'react'
import { liveMotionAllowed } from './live-preference'
import { isOwnWrite } from './own-writes'

/**
 * The pipeline track follows a move (realtime round 8, item 17). When the record on screen
 * changes step because of someone else — a live event refetched the instance — the track draws
 * the hop instead of jumping: each crossed segment draws in turn (a send back right to left)
 * and the step the record lands on fills when the line reaches it. Short and calm: under a
 * second whatever the distance.
 *
 * Never: on the first paint, for this tab's own move (the person just clicked it), in Calm /
 * Off live mode or with reduced motion (liveMotionAllowed). CSS keeps the same rule for
 * `.nvr-track-travel` (styles.css / globals.css).
 */

export const TRACK_TRAVEL_TOTAL_MS = 840
export const TRACK_TRAVEL_SEG_MS = 240

export interface TrackTravel {
  from: string
  to: string
  /** Changes per hop so a second move restarts the drawing. */
  n: number
}

export interface TravelPlan {
  /** Duration of one segment's draw (ms). */
  seg: number
  /** Connector index (the line after step i) → delay before it draws (ms). */
  segments: Map<number, number>
  backward: boolean
  arriveIndex: number
  arriveDelay: number
}

const up = (v: unknown) => String(v ?? '').toUpperCase()

/** Which segments of the shown track draw, in what order (pure; exported for tests). */
export function travelPlan(order: string[], travel: TrackTravel | null): TravelPlan | null {
  if (!travel) return null
  const ids = order.map(up)
  const fi = ids.indexOf(up(travel.from))
  const ti = ids.indexOf(up(travel.to))
  if (fi < 0 || ti < 0 || fi === ti) return null
  const backward = ti < fi
  const count = Math.abs(ti - fi)
  const seg = Math.max(90, Math.min(TRACK_TRAVEL_SEG_MS, Math.floor(TRACK_TRAVEL_TOTAL_MS / count)))
  const segments = new Map<number, number>()
  for (let k = 0; k < count; k++) {
    const connector = backward ? fi - 1 - k : fi + k
    segments.set(connector, k * seg)
  }
  return { seg, segments, backward, arriveIndex: ti, arriveDelay: count * seg }
}

/** Should this step change draw? (pure; exported for tests) */
export function shouldTravel(
  before: string | null | undefined,
  after: string | null | undefined,
  opts: { own: boolean; motion: boolean }
): boolean {
  if (!before || !after || up(before) === up(after)) return false
  return !opts.own && opts.motion
}

export function useTrackTravel(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  currentStateId: string | null | undefined
): TrackTravel | null {
  const prev = useRef<string | null | undefined>(undefined)
  const seq = useRef(0)
  const [travel, setTravel] = useState<TrackTravel | null>(null)
  useEffect(() => {
    const before = prev.current
    prev.current = currentStateId ?? null
    // First paint (or the instance arriving): nothing moved.
    if (before === undefined) return
    const own = !!collection && isOwnWrite(collection, item, ['$state'])
    if (!shouldTravel(before, currentStateId, { own, motion: liveMotionAllowed() })) {
      setTravel(null)
      return
    }
    seq.current += 1
    setTravel({ from: before as string, to: currentStateId as string, n: seq.current })
    const t = setTimeout(() => setTravel(null), TRACK_TRAVEL_TOTAL_MS + 600)
    return () => clearTimeout(t)
  }, [currentStateId, collection, item])
  return travel
}
