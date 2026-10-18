/**
 * #2204 + #2235 — per-session request facts for two detectors (services/traffic-security.ts):
 *
 *  - scripted session: a person's cookie session making requests at machine pace or in a fixed
 *    repeating loop from outside the app (a browser extension, a script reusing the cookie), or
 *    from a client that names a scripting tool.
 *  - one session from two places: the same session going back and forth between two networks
 *    within five minutes (a possible stolen cookie). Private / loopback / carrier-NAT addresses
 *    and TRAFFIC_KNOWN_PROXIES are never a "place"; masquerade, View-as keys, tokens and API keys
 *    are not sessions and are left out. A confident flag (different browser or country on the
 *    two sides) is raised to admins (services/traffic-security-alerts.ts).
 *
 * Sessions are keyed by a hash of the session id (the id itself is never held), at most
 * SESSION_CAP of them (least recently seen dropped first), each with its last WINDOW requests.
 * Detection runs at most once per EVAL_EVERY_MS per session; the two-places check only when the
 * network changes. Nothing is sent on frames: addresses and user agents reach admins only through
 * GET /traffic-map/security/*.
 */
import { createHash } from 'node:crypto'
import { lookupPlace } from '../traffic-geoip.js'
import {
  detectScripted,
  detectTwoPlaces,
  isKnownProxy,
  isPrivateIp,
  networkKey,
  type PlaceHit,
  type ScriptedVerdict,
  twoPlacesConfidence
} from '../traffic-security.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { clientIpOf, headerOf, reqOf } from './req-facts.js'

export const SESSION_GUARD_TAP = 'session-guard'
export const SESSION_CAP = 2000
const WINDOW = 64
const APP_WINDOW = 32
const ADDR_CAP = 6
const EVAL_EVERY_MS = 5000
/** A flag stays on the map this long after the session's last flagged evaluation. */
export const FLAG_TTL_MS = 30 * 60_000

/** Paths a browser fetches natively (no app headers): never counted as "outside the app". */
const NATIVE_FETCH_RE =
  /\/(assets|download|export|stream|poster|captions(\.vtt)?|thumbnail)(\/|$|\?)/i

export interface Addr {
  ip: string
  net: string
  ua: string | null
  n: number
  first: number
  last: number
  country: string | null
}
export interface TwoPlacesFlag {
  a: Addr
  b: Addr
  at: number
  confidence: 'high' | 'low'
}
export interface Sess {
  id: string
  caller: string
  lastAt: number
  times: number[]
  routes: string[]
  ua: string | null
  appBits: boolean[]
  evalAt: number
  scripted: { verdict: ScriptedVerdict; at: number } | null
  addrs: Map<string, Addr>
  hits: PlaceHit[]
  lastNet: string | null
  twoPlaces: TwoPlacesFlag | null
}
interface State {
  sessions: Map<string, Sess>
}
const state = (): State => tapState<State>(SESSION_GUARD_TAP, () => ({ sessions: new Map() }))

type TwoPlacesListener = (s: Sess, flag: TwoPlacesFlag) => void
let onTwoPlaces: TwoPlacesListener | null = null
/** Called once per session when it is first flagged as used from two places. */
export function setTwoPlacesListener(fn: TwoPlacesListener | null): void {
  onTwoPlaces = fn
}

export function sessionKeyOf(sessionId: string): string {
  return createHash('sha256').update(`nvr-tm|${sessionId}`).digest('hex').slice(0, 16)
}

export interface SessionHit {
  sid: string
  caller: string
  at: number
  route: string
  ip: string | null
  ua: string | null
  /** The request carried x-nivaro-client (it came from a Nivaro front end). */
  fromApp: boolean
  /** A file / stream path a browser fetches without app headers. */
  native: boolean
}

/** Record one session request and re-run the detectors (exported for tests). */
export function noteSessionHit(h: SessionHit): Sess {
  const st = state()
  let s = st.sessions.get(h.sid)
  if (s) st.sessions.delete(h.sid)
  else {
    if (st.sessions.size >= SESSION_CAP) {
      const oldest = st.sessions.keys().next().value
      if (oldest !== undefined) st.sessions.delete(oldest)
    }
    s = {
      id: h.sid,
      caller: h.caller,
      lastAt: h.at,
      times: [],
      routes: [],
      ua: null,
      appBits: [],
      evalAt: 0,
      scripted: null,
      addrs: new Map(),
      hits: [],
      lastNet: null,
      twoPlaces: null
    }
  }
  st.sessions.set(h.sid, s)
  s.caller = h.caller
  s.lastAt = h.at
  s.ua = h.ua ? h.ua.slice(0, 300) : null
  s.times.push(h.at)
  s.routes.push(h.route.slice(0, 160))
  if (s.times.length > WINDOW) {
    s.times.shift()
    s.routes.shift()
  }
  if (!h.native) {
    s.appBits.push(h.fromApp)
    if (s.appBits.length > APP_WINDOW) s.appBits.shift()
  }
  if (h.at - s.evalAt >= EVAL_EVERY_MS && s.times.length >= 3) {
    s.evalAt = h.at
    const outside = s.appBits.filter((b) => !b).length
    const verdict = detectScripted({
      times: s.times,
      routes: s.routes,
      ua: s.ua,
      outside,
      appCalls: s.appBits.length
    })
    if (verdict.flagged) s.scripted = { verdict, at: h.at }
  }
  notePlace(s, h)
  return s
}

function notePlace(s: Sess, h: SessionHit): void {
  if (!h.ip || isPrivateIp(h.ip) || isKnownProxy(h.ip)) return
  const net = networkKey(h.ip)
  if (!net) return
  let a = s.addrs.get(net)
  if (!a) {
    if (s.addrs.size >= ADDR_CAP) return
    a = {
      ip: h.ip,
      net,
      ua: s.ua,
      n: 0,
      first: h.at,
      last: h.at,
      country: lookupPlace(h.ip)?.country ?? null
    }
    s.addrs.set(net, a)
  }
  a.n++
  a.last = h.at
  a.ip = h.ip
  a.ua = s.ua
  s.hits.push({ t: h.at, net })
  if (s.hits.length > WINDOW) s.hits.shift()
  const changed = s.lastNet !== null && s.lastNet !== net
  s.lastNet = net
  if (!changed || s.twoPlaces) return
  const pair = detectTwoPlaces(s.hits)
  if (!pair) return
  const A = s.addrs.get(pair.a)
  const B = s.addrs.get(pair.b)
  if (!A || !B) return
  const flag: TwoPlacesFlag = {
    a: { ...A },
    b: { ...B },
    at: pair.at,
    confidence: twoPlacesConfidence(A, B)
  }
  s.twoPlaces = flag
  try {
    onTwoPlaces?.(s, flag)
  } catch {
    /* raising never affects recording */
  }
}

/** Sessions with a live flag, newest first. */
export function flaggedSessions(nowMs: number): Sess[] {
  const out: Sess[] = []
  for (const s of state().sessions.values()) {
    const live =
      (s.scripted && nowMs - s.scripted.at <= FLAG_TTL_MS) ||
      (s.twoPlaces && nowMs - s.twoPlaces.at <= FLAG_TTL_MS)
    if (live) out.push(s)
  }
  return out.sort((a, b) => b.lastAt - a.lastAt)
}

const tap: TrafficTap = {
  id: SESSION_GUARD_TAP,
  onRequest(c) {
    if (c.ev.authMethod !== 'session') return
    const r = reqOf(c.ev)
    if (!r || r.masqueradeAdminId) return
    const sid = (r as { session?: { sessionId?: unknown } }).session?.sessionId
    if (typeof sid !== 'string' || !sid) return
    noteSessionHit({
      sid: sessionKeyOf(sid),
      caller: c.caller,
      at: c.ev.at,
      route: c.route,
      ip: clientIpOf(r),
      ua: headerOf(r, 'user-agent'),
      fromApp: headerOf(r, 'x-nivaro-client') != null,
      native: c.lane === 'files' || c.lane === 'socket' || NATIVE_FETCH_RE.test(c.ev.path)
    })
  },
  sweep(sec) {
    const st = state()
    const cutoff = sec * 1000 - 6 * 3600_000
    for (const [k, s] of st.sessions) if (s.lastAt < cutoff) st.sessions.delete(k)
  }
}
registerTrafficTap(tap)
