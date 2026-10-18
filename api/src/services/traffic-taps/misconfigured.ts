/**
 * #2236 — facts for the misconfigured-client lens: per caller, the hosts its Referer / Origin
 * named (this instance's own hosts left out), and API keys this instance does not know (a 401
 * API_KEY_INVALID — typically a key minted on another environment). The route judges them
 * against the Environments registry (services/traffic-security.ts misconfigFindings).
 *
 * Bounded: CALLER_CAP callers × HOST_CAP hosts, KEY_CAP unknown key prefixes; counts per minute
 * over the 15-minute ring. Key prefixes are the 8-character display prefix the API keys page
 * shows, never the token.
 */
import { config } from '../../config.js'
import { MinuteCounter } from '../traffic-ring.js'
import { hostOf } from '../traffic-security.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { headerOf, reqOf } from './req-facts.js'

export const MISCONFIGURED_TAP = 'misconfigured'
const CALLER_CAP = 200
const HOST_CAP = 6
const KEY_CAP = 40

interface UnknownKey {
  n: MinuteCounter
  lastAt: number
  referer: string | null
}
interface State {
  referers: Map<string, MinuteCounter>
  keys: Map<string, UnknownKey>
}
const state = (): State =>
  tapState<State>(MISCONFIGURED_TAP, () => ({ referers: new Map(), keys: new Map() }))

let ownCache: { key: string; hosts: Set<string> } | null = null
function ownHosts(): Set<string> {
  const key = `${config.PUBLIC_URL}|${config.ADMIN_URL}`
  if (ownCache?.key !== key) {
    const hosts = new Set<string>()
    for (const u of [config.PUBLIC_URL, config.ADMIN_URL]) {
      const h = hostOf(u)
      if (h) hosts.add(h)
    }
    ownCache = { key, hosts }
  }
  return ownCache.hosts
}

/** Record one request's referer host and unknown-key evidence (exported for tests). */
export function noteClientFacts(f: {
  caller: string
  sec: number
  at: number
  referer: string | null
  host: string | null
  status: number
  code: string | null
  authorization: string | null
}): void {
  const st = state()
  const ref = hostOf(f.referer)
  const foreign = ref && ref !== f.host && !ownHosts().has(ref) ? ref : null
  if (foreign) {
    let m = st.referers.get(f.caller)
    if (!m && st.referers.size < CALLER_CAP) {
      m = new MinuteCounter(HOST_CAP)
      st.referers.set(f.caller, m)
    }
    m?.bump(foreign, f.sec)
  }
  if (f.status === 401 && f.code === 'API_KEY_INVALID' && f.authorization) {
    const token = f.authorization.replace(/^Bearer\s+/i, '').trim()
    if (!token.startsWith('nvk_')) return
    const prefix = token.slice(0, 8)
    let k = st.keys.get(prefix)
    if (!k) {
      if (st.keys.size >= KEY_CAP) return
      k = { n: new MinuteCounter(1), lastAt: f.at, referer: null }
      st.keys.set(prefix, k)
    }
    k.n.bump('n', f.sec)
    k.lastAt = f.at
    if (foreign) k.referer = foreign
  }
}

/** Facts over the window: referer hosts per caller, unknown keys. */
export function misconfigFacts(
  windowS: number,
  sec: number
): {
  referers: Record<string, Record<string, number>>
  unknownKeys: Array<{ prefix: string; n: number; last_at: string; referer: string | null }>
} {
  const st = state()
  const referers: Record<string, Record<string, number>> = {}
  for (const [caller, m] of st.referers) {
    const top = m.top(windowS, sec, HOST_CAP)
    if (top.length) referers[caller] = Object.fromEntries(top)
  }
  const unknownKeys = [...st.keys.entries()]
    .map(([prefix, k]) => ({
      prefix,
      n: k.n.sum('n', windowS, sec),
      last_at: new Date(k.lastAt).toISOString(),
      referer: k.referer
    }))
    .filter((k) => k.n > 0)
    .sort((a, b) => b.n - a.n)
  return { referers, unknownKeys }
}

const tap: TrafficTap = {
  id: MISCONFIGURED_TAP,
  onRequest(c) {
    const r = reqOf(c.ev)
    const referer = headerOf(r, 'origin') ?? headerOf(r, 'referer')
    if (!referer && c.ev.status !== 401) return
    noteClientFacts({
      caller: c.caller,
      sec: c.sec,
      at: c.ev.at,
      referer,
      host: hostOf(headerOf(r, 'x-forwarded-host') ?? headerOf(r, 'host')),
      status: c.ev.status,
      code: c.code,
      authorization: c.ev.status === 401 ? headerOf(r, 'authorization') : null
    })
  },
  sweep(sec) {
    const st = state()
    for (const [k, m] of st.referers) {
      m.sweep(sec)
      if (m.size === 0) st.referers.delete(k)
    }
    for (const [k, v] of st.keys) {
      v.n.sweep(sec)
      if (v.n.size === 0) st.keys.delete(k)
    }
  }
}
registerTrafficTap(tap)
