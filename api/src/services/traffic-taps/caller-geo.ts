/**
 * #2154 — caller geography: requests by country and region from the caller's address (offline
 * MaxMind database, services/traffic-geoip.ts), and the places a caller had not called from
 * before. Does nothing without TRAFFIC_GEOIP_DB.
 *
 * "Before" = since this process first saw the caller: its first LEARN_S seconds (and first
 * LEARN_N requests) only learn places; a place first seen after that is flagged. Anonymous
 * traffic (everyone) is counted but never flagged.
 *
 * No frame/snapshot figures (addresses and places stay off the socket and out of stored
 * snapshots); the security route reads `geoOf()` / `geoFlags()`.
 */
import { lookupPlace, placeKey } from '../traffic-geoip.js'
import { MinuteCounter } from '../traffic-ring.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { clientIpOf, reqOf } from './req-facts.js'

export const CALLER_GEO_TAP = 'caller-geo'
const CALLER_CAP = 300
const PLACE_CAP = 16
const NEW_CAP = 8
export const LEARN_S = 900
export const LEARN_N = 20

interface NewPlace {
  place: string
  country_name: string | null
  city: string | null
  ip: string
  first_at: number
}
interface CallerGeo {
  firstSec: number
  seen: number
  lastSec: number
  places: MinuteCounter
  /** place → first epoch ms seen */
  known: Map<string, number>
  names: Map<string, string | null>
  fresh: NewPlace[]
}
interface State {
  callers: Map<string, CallerGeo>
}
const state = (): State => tapState<State>(CALLER_GEO_TAP, () => ({ callers: new Map() }))

function evictIdle(st: State, sec: number): boolean {
  let oldest: string | null = null
  let oldestSec = Number.POSITIVE_INFINITY
  for (const [k, c] of st.callers) {
    if (c.lastSec < oldestSec) {
      oldest = k
      oldestSec = c.lastSec
    }
  }
  if (oldest && sec - oldestSec > LEARN_S) {
    st.callers.delete(oldest)
    return true
  }
  return false
}

/** Record one request's place for a caller (exported for tests). */
export function noteCallerPlace(caller: string, ip: string, sec: number, at: number): void {
  const p = lookupPlace(ip)
  if (!p?.country) return
  const st = state()
  let c = st.callers.get(caller)
  if (!c) {
    if (st.callers.size >= CALLER_CAP && !evictIdle(st, sec)) return
    c = {
      firstSec: sec,
      seen: 0,
      lastSec: sec,
      places: new MinuteCounter(PLACE_CAP),
      known: new Map(),
      names: new Map(),
      fresh: []
    }
    st.callers.set(caller, c)
  }
  c.seen++
  c.lastSec = sec
  const key = placeKey(p)
  c.places.bump(key, sec)
  if (!c.names.has(key) && c.names.size < PLACE_CAP * 2) c.names.set(key, p.country_name)
  if (c.known.has(key)) return
  if (c.known.size >= PLACE_CAP * 4) return
  c.known.set(key, at)
  const learning = sec - c.firstSec < LEARN_S || c.seen <= LEARN_N
  if (learning || caller === 'anon') return
  c.fresh.unshift({ place: key, country_name: p.country_name, city: p.city, ip, first_at: at })
  if (c.fresh.length > NEW_CAP) c.fresh.pop()
}

export interface CallerGeoView {
  places: Array<{ place: string; country_name: string | null; n: number }>
  new_places: Array<{
    place: string
    country_name: string | null
    city: string | null
    ip: string
    first_at: string
  }>
  learning: boolean
  since: string
}

/** One caller's breakdown over the window (null when no place was seen). */
export function geoOf(caller: string, windowS: number, sec: number): CallerGeoView | null {
  const c = state().callers.get(caller)
  if (!c) return null
  return {
    places: c.places
      .top(windowS, sec, PLACE_CAP)
      .map(([place, n]) => ({ place, country_name: c.names.get(place) ?? null, n })),
    new_places: c.fresh.map((f) => ({ ...f, first_at: new Date(f.first_at).toISOString() })),
    learning: sec - c.firstSec < LEARN_S || c.seen <= LEARN_N,
    since: new Date(c.firstSec * 1000).toISOString()
  }
}

/** Callers with a new place in the last `withinS` seconds → the newest such place. */
export function geoFlags(withinS: number, nowMs: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [caller, c] of state().callers) {
    const f = c.fresh[0]
    if (f && nowMs - f.first_at <= withinS * 1000) out[caller] = f.place
  }
  return out
}

const tap: TrafficTap = {
  id: CALLER_GEO_TAP,
  onRequest(c) {
    if (!process.env.TRAFFIC_GEOIP_DB) return
    const ip = clientIpOf(reqOf(c.ev))
    if (ip) noteCallerPlace(c.caller, ip, c.sec, c.ev.at)
  },
  sweep(sec) {
    const st = state()
    for (const [k, c] of st.callers) {
      c.places.sweep(sec)
      if (sec - c.lastSec > 86_400) st.callers.delete(k)
    }
  }
}
registerTrafficTap(tap)
