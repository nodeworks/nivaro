/**
 * #2236 — facts for the misconfigured-client lens: per caller, the hosts its Referer / Origin
 * named (this instance's own hosts left out), tokens this instance refused (a 401 — typically a
 * key minted on another environment), environments a non-browser user agent names, and the
 * address + app each caller last called from. The route judges them against the Environments
 * registry and this instance's tier (services/traffic-security.ts misconfigFindings).
 *
 * Bounded: CALLER_CAP callers × HOST_CAP hosts / claims, KEY_CAP refused tokens; counts per
 * minute over the 15-minute ring. Secrets never enter the state: an API key keeps its
 * 8-character display prefix (what the API keys page shows), every token a fingerprint (the
 * first 8 hex of its SHA-256 — for an API key, the start of its stored key_hash) and the
 * environment word its own text declares.
 */
import { createHash } from 'node:crypto'
import { config } from '../../config.js'
import { MinuteCounter } from '../traffic-ring.js'
import { type DeclaredTier, declaredTier, hostOf, uaLabel } from '../traffic-security.js'
import { registerTrafficTap, type TrafficTap, tapState } from '../traffic-taps.js'
import { clientIpOf, headerOf, reqOf } from './req-facts.js'

export const MISCONFIGURED_TAP = 'misconfigured'
const CALLER_CAP = 200
const HOST_CAP = 6
const KEY_CAP = 40
const WHO_CAP = 400

type TokenKind = 'api-key' | 'oauth' | 'token'
interface UnknownKey {
  n: MinuteCounter
  lastAt: number
  referer: string | null
  prefix: string | null
  kind: TokenKind
  tier: DeclaredTier | null
  ip: string | null
  app: string | null
}
interface State {
  referers: Map<string, MinuteCounter>
  /** fingerprint → refused token facts */
  keys: Map<string, UnknownKey>
  uaClaims: Map<string, MinuteCounter>
  who: Map<string, { ip: string | null; app: string | null; at: number }>
}
const state = (): State =>
  tapState<State>(MISCONFIGURED_TAP, () => ({
    referers: new Map(),
    keys: new Map(),
    uaClaims: new Map(),
    who: new Map()
  }))

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

/** This instance's configured hosts (PUBLIC_URL / ADMIN_URL). */
export function configuredOwnHosts(): string[] {
  return [...ownHosts()]
}

/** First 8 hex of the token's SHA-256 — matches the start of an API key's stored key_hash. */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8)
}

function tokenKind(token: string): TokenKind {
  if (token.startsWith('nvk_')) return 'api-key'
  if (token.startsWith('nvo_') || token.startsWith('nvd_') || token.startsWith('nvdr_'))
    return 'oauth'
  return 'token'
}

const URL_IN_UA = /https?:\/\/([a-z0-9.-]+(?::\d+)?)/gi
const PLUS_HOST_IN_UA = /\+([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi

/** Hosts and environment words a NON-browser user agent names ("feed/1.0 (+https://efp…)"). */
export function uaClaimsOf(ua: string | null, own: Set<string>, host: string | null): string[] {
  if (!ua || /^Mozilla\//.test(ua)) return []
  const out = new Set<string>()
  for (const re of [URL_IN_UA, PLUS_HOST_IN_UA]) {
    re.lastIndex = 0
    for (let m = re.exec(ua); m; m = re.exec(ua)) {
      const h = hostOf(m[1])
      if (h && h !== host && !own.has(h)) out.add(`host:${h}`)
      if (out.size >= HOST_CAP) break
    }
  }
  // Words outside the URLs: "env=production", "FusionSync-PROD/2.1".
  const words = declaredTier(ua.replace(URL_IN_UA, ' ').replace(PLUS_HOST_IN_UA, ' '))
  if (words) out.add(`env:${words.word}`)
  return [...out]
}

/** Record one request's referer host, user-agent claims and refused-token evidence (exported for tests). */
export function noteClientFacts(f: {
  caller: string
  sec: number
  at: number
  referer: string | null
  host: string | null
  status: number
  code: string | null
  authorization: string | null
  ip?: string | null
  ua?: string | null
  app?: string | null
}): void {
  const st = state()
  const own = ownHosts()
  const ref = hostOf(f.referer)
  const foreign = ref && ref !== f.host && !own.has(ref) ? ref : null
  const app = f.app ?? (f.ua ? uaLabel(f.ua) : null)
  let evidence = false
  if (foreign) {
    let m = st.referers.get(f.caller)
    if (!m && st.referers.size < CALLER_CAP) {
      m = new MinuteCounter(HOST_CAP)
      st.referers.set(f.caller, m)
    }
    m?.bump(foreign, f.sec)
    evidence = true
  }
  const claims = uaClaimsOf(f.ua ?? null, own, f.host)
  if (claims.length) {
    let m = st.uaClaims.get(f.caller)
    if (!m && st.uaClaims.size < CALLER_CAP) {
      m = new MinuteCounter(HOST_CAP)
      st.uaClaims.set(f.caller, m)
    }
    for (const c of claims) m?.bump(c, f.sec)
    evidence = true
  }
  // Who called (address + app): for key callers (judged by name / restore) and callers with
  // evidence. Never for the anonymous caller as a whole — its refused tokens keep their own.
  if ((evidence || /^k\d/.test(f.caller)) && f.caller !== 'anon') {
    if (st.who.has(f.caller) || st.who.size < WHO_CAP)
      st.who.set(f.caller, { ip: f.ip ?? null, app, at: f.at })
  }
  if (f.status === 401 && f.authorization) {
    const token = f.authorization.replace(/^Bearer\s+/i, '').trim()
    if (!token || token === f.authorization.trim()) return // not a bearer token
    const kind = tokenKind(token)
    // An API key refused for another reason (expired, address not allowed) is one of ours.
    if (kind === 'api-key' && f.code !== 'API_KEY_INVALID') return
    const fp = tokenFingerprint(token)
    let k = st.keys.get(fp)
    if (!k) {
      if (st.keys.size >= KEY_CAP) return
      k = {
        n: new MinuteCounter(1),
        lastAt: f.at,
        referer: null,
        prefix: kind === 'api-key' ? token.slice(0, 8) : null,
        kind,
        // What the token's own leading text says (`nvk_prod_…`, `stg-…`) — only the word is
        // kept, and the last (random) segment is never read for it.
        tier: declaredTier(token.split(/[_.-]/).slice(0, -1).slice(0, 3).join('_')),
        ip: null,
        app: null
      }
      st.keys.set(fp, k)
    }
    k.n.bump('n', f.sec)
    k.lastAt = f.at
    k.ip = f.ip ?? k.ip
    k.app = app ?? k.app
    if (foreign) k.referer = foreign
  }
}

/** Facts over the window: referer hosts and user-agent claims per caller, refused tokens, who. */
export function misconfigFacts(
  windowS: number,
  sec: number
): {
  referers: Record<string, Record<string, number>>
  unknownKeys: Array<{
    prefix: string | null
    fingerprint: string
    kind: TokenKind
    n: number
    last_at: string
    referer: string | null
    ip: string | null
    app: string | null
    tier: DeclaredTier | null
  }>
  uaClaims: Record<string, Record<string, number>>
  who: Record<string, { ip: string | null; app: string | null }>
} {
  const st = state()
  const perCaller = (map: Map<string, MinuteCounter>) => {
    const out: Record<string, Record<string, number>> = {}
    for (const [caller, m] of map) {
      const top = m.top(windowS, sec, HOST_CAP)
      if (top.length) out[caller] = Object.fromEntries(top)
    }
    return out
  }
  const unknownKeys = [...st.keys.entries()]
    .map(([fingerprint, k]) => ({
      prefix: k.prefix,
      fingerprint,
      kind: k.kind,
      n: k.n.sum('n', windowS, sec),
      last_at: new Date(k.lastAt).toISOString(),
      referer: k.referer,
      ip: k.ip,
      app: k.app,
      tier: k.tier
    }))
    .filter((k) => k.n > 0)
    .sort((a, b) => b.n - a.n)
  const who: Record<string, { ip: string | null; app: string | null }> = {}
  for (const [caller, w] of st.who) who[caller] = { ip: w.ip, app: w.app }
  return {
    referers: perCaller(st.referers),
    unknownKeys,
    uaClaims: perCaller(st.uaClaims),
    who
  }
}

const tap: TrafficTap = {
  id: MISCONFIGURED_TAP,
  onRequest(c) {
    const r = reqOf(c.ev)
    const referer = headerOf(r, 'origin') ?? headerOf(r, 'referer')
    const ua = headerOf(r, 'user-agent')
    const keyCaller = /^k\d/.test(c.caller)
    // Cheap exit for the common case: a browser call with no referer, not refused, not a key.
    if (!referer && c.ev.status !== 401 && !keyCaller && (!ua || /^Mozilla\//.test(ua))) return
    noteClientFacts({
      caller: c.caller,
      sec: c.sec,
      at: c.ev.at,
      referer,
      host: hostOf(headerOf(r, 'x-forwarded-host') ?? headerOf(r, 'host')),
      status: c.ev.status,
      code: c.code,
      authorization: c.ev.status === 401 ? headerOf(r, 'authorization') : null,
      ip: clientIpOf(r),
      ua,
      app: headerOf(r, 'x-nivaro-app')?.slice(0, 60) ?? null
    })
  },
  sweep(sec) {
    const st = state()
    for (const map of [st.referers, st.uaClaims]) {
      for (const [k, m] of map) {
        m.sweep(sec)
        if (m.size === 0) map.delete(k)
      }
    }
    for (const [k, v] of st.keys) {
      v.n.sweep(sec)
      if (v.n.size === 0) st.keys.delete(k)
    }
    // Who: forget callers quiet for the ring's 15 minutes.
    const cutoff = Date.now() - 15 * 60_000
    for (const [k, w] of st.who) if (w.at < cutoff) st.who.delete(k)
  }
}
registerTrafficTap(tap)
