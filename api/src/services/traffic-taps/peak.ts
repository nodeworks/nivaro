// api/src/services/traffic-taps/peak.ts
/**
 * #2173 — the busiest minute of the UTC day, so the snapshot scheduler can capture the map just
 * after it. O(1) per request: one counter for the minute in progress and one record for the
 * day's best. Nothing is emitted; the scheduler reads `peakFacts()`.
 */
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'

export const PEAK_TAP = 'peak'

interface State {
  /** UTC day (days since epoch) the peak belongs to. */
  day: number
  peakMinute: number
  peakCount: number
  /** The minute being counted and its requests so far. */
  minute: number
  count: number
  /** The peak minute a snapshot was already taken for. */
  capturedMinute: number
}
const state = (): State =>
  tapState<State>(PEAK_TAP, () => ({
    day: -1,
    peakMinute: -1,
    peakCount: 0,
    minute: -1,
    count: 0,
    capturedMinute: -1
  }))

const MIN_PER_DAY = 1440
const dayOf = (minute: number) => Math.floor(minute / MIN_PER_DAY)

/** Fold the finished minute into the day's best (pure on the state it is given). */
export function closeMinute(st: State): void {
  if (st.minute < 0 || st.count === 0) return
  const d = dayOf(st.minute)
  if (d !== st.day) {
    st.day = d
    st.peakMinute = -1
    st.peakCount = 0
  }
  if (st.count > st.peakCount) {
    st.peakCount = st.count
    st.peakMinute = st.minute
  }
}

/** Count one request in the minute of `sec` (pure on the state it is given). */
export function countRequest(st: State, sec: number): void {
  const minute = Math.floor(sec / 60)
  if (minute !== st.minute) {
    if (minute < st.minute) return // an older event than the minute in progress
    closeMinute(st)
    st.minute = minute
    st.count = 0
  }
  st.count++
}

const tap: TrafficTap = {
  id: PEAK_TAP,
  onRequest(c) {
    countRequest(state(), c.sec)
  },
  reset() {
    /* tap state is cleared by resetTapState */
  }
}
registerTrafficTap(tap)

export interface PeakFacts {
  /** UTC day number, the peak minute (minutes since epoch) and its request count. */
  day: number
  peakMinute: number
  peakCount: number
  capturedMinute: number
}
/** The current store's peak of the day, with the minute in progress folded in. */
export function peakFacts(nowSec: number): PeakFacts {
  const st = state()
  // The minute in progress could itself be the peak; fold a copy so counting carries on.
  const copy = { ...st }
  closeMinute(copy)
  if (dayOf(Math.floor(nowSec / 60)) !== copy.day) {
    return { day: dayOf(Math.floor(nowSec / 60)), peakMinute: -1, peakCount: 0, capturedMinute: -1 }
  }
  return {
    day: copy.day,
    peakMinute: copy.peakMinute,
    peakCount: copy.peakCount,
    capturedMinute: st.capturedMinute
  }
}
export function markPeakCaptured(minute: number): void {
  state().capturedMinute = minute
}

/** Fewer requests than this in the best minute is not worth a snapshot. */
export const MIN_PEAK_REQ = 30
/** Wait this long after the peak minute so a rising peak has finished. */
export const PEAK_SETTLE_MIN = 5
/** The map's ring holds 15 minutes; past this the peak is out of reach. */
export const PEAK_REACH_MIN = 14

/** The peak minute to capture now, or null (pure). */
export function peakToCapture(f: PeakFacts, nowSec: number): number | null {
  if (f.peakMinute < 0 || f.peakCount < MIN_PEAK_REQ) return null
  if (f.peakMinute === f.capturedMinute) return null
  const age = Math.floor(nowSec / 60) - f.peakMinute
  return age >= PEAK_SETTLE_MIN && age <= PEAK_REACH_MIN ? f.peakMinute : null
}
