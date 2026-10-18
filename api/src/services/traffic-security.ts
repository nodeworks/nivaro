/**
 * Traffic Map security lenses (#2154 #2204 #2235 #2236 #2257 #2196) — the pure logic: address
 * classification, user-agent reading, the scripted-session and one-session-two-places detectors,
 * the wrong-environment checks, Data Integrity attribution and the HTTP caching verdicts. The taps
 * (services/traffic-taps/caller-geo, session-guard, misconfigured, http-cache) hold the bounded
 * facts; the route (routes/traffic-map-extras/security.ts) reads them through these functions.
 *
 * Nothing here touches the network or the database.
 */

// ── addresses ───────────────────────────────────────────────────────────────

/** An address as bytes (4 for IPv4, 16 for IPv6); an IPv4-mapped IPv6 address reads as IPv4. */
export function parseIp(raw: string | null | undefined): Uint8Array | null {
  if (!raw) return null
  let s = raw.trim()
  if (s.startsWith('[')) s = s.slice(1, s.indexOf(']') > 0 ? s.indexOf(']') : undefined)
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s)
  if (mapped) s = mapped[1]
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) {
    const parts = s.split('.').map(Number)
    if (parts.some((p) => p > 255)) return null
    return Uint8Array.from(parts)
  }
  if (!s.includes(':') || !/^[0-9a-f:.]+$/i.test(s)) return null
  const halves = s.split('::')
  if (halves.length > 2) return null
  const words = (h: string): number[] | null => {
    if (!h) return []
    const out: number[] = []
    for (const w of h.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(w)) return null
      out.push(Number.parseInt(w, 16))
    }
    return out
  }
  const head = words(halves[0])
  const tail = halves.length === 2 ? words(halves[1]) : []
  if (!head || !tail) return null
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null
  const all = [...head, ...new Array<number>(fill).fill(0), ...tail]
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    out[i * 2] = all[i] >> 8
    out[i * 2 + 1] = all[i] & 0xff
  }
  return out
}

export interface Cidr {
  bytes: Uint8Array
  bits: number
}

/** `10.0.0.0/8`, `2001:db8::/32`, or a bare address (a /32 or /128). */
export function parseCidr(raw: string): Cidr | null {
  const [ip, len] = raw.trim().split('/')
  const bytes = parseIp(ip)
  if (!bytes) return null
  const max = bytes.length * 8
  const bits = len == null || len === '' ? max : Number(len)
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null
  return { bytes, bits }
}

export function inCidr(ip: Uint8Array, c: Cidr): boolean {
  if (ip.length !== c.bytes.length) return false
  const full = Math.floor(c.bits / 8)
  for (let i = 0; i < full; i++) if (ip[i] !== c.bytes[i]) return false
  const rest = c.bits % 8
  if (!rest) return true
  const mask = (0xff << (8 - rest)) & 0xff
  return (ip[full] & mask) === (c.bytes[full] & mask)
}

const PRIVATE = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '0.0.0.0/8',
  '::1/128',
  '::/128',
  'fc00::/7',
  'fe80::/10'
]
  .map(parseCidr)
  .filter((c): c is Cidr => !!c)

/** Loopback, private, link-local and carrier-grade NAT ranges (never a place on the map). */
export function isPrivateIp(raw: string | null | undefined): boolean {
  const ip = parseIp(raw)
  if (!ip) return true
  return PRIVATE.some((c) => inCidr(ip, c))
}

/** Parse a comma / whitespace separated CIDR list; bad entries are dropped. */
export function parseCidrList(raw: string | null | undefined): Cidr[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(parseCidr)
    .filter((c): c is Cidr => !!c)
}

let proxyCache: { raw: string; list: Cidr[] } | null = null
/** TRAFFIC_KNOWN_PROXIES — addresses of proxies, VPN egress and gateways people share. */
export function knownProxies(): Cidr[] {
  const raw = process.env.TRAFFIC_KNOWN_PROXIES ?? ''
  if (!proxyCache || proxyCache.raw !== raw) proxyCache = { raw, list: parseCidrList(raw) }
  return proxyCache.list
}

export function isKnownProxy(raw: string | null | undefined, list = knownProxies()): boolean {
  if (list.length === 0) return false
  const ip = parseIp(raw)
  return !!ip && list.some((c) => inCidr(ip, c))
}

/** The network an address belongs to: its /24 (IPv4) or /48 (IPv6). Null for a bad address. */
export function networkKey(raw: string | null | undefined): string | null {
  const ip = parseIp(raw)
  if (!ip) return null
  if (ip.length === 4) return `${ip[0]}.${ip[1]}.${ip[2]}.0/24`
  const w = (i: number) => ((ip[i] << 8) | ip[i + 1]).toString(16)
  return `${w(0)}:${w(2)}:${w(4)}::/48`
}

// ── user agents ─────────────────────────────────────────────────────────────

const SCRIPT_UA =
  /(curl|wget|python-requests|python-urllib|aiohttp|httpx|node-fetch|undici|axios|got\b|go-http-client|okhttp|java\/|apache-httpclient|postmanruntime|insomnia|powershell|libwww-perl|ruby|guzzlehttp|php\/|scrapy|headlesschrome|phantomjs|selenium|puppeteer|playwright|httpie|dart\/)/i

/** The scripting tool a user agent names (curl, python-requests, HeadlessChrome…); null = none. */
export function scriptedUa(ua: string | null | undefined): string | null {
  if (ua == null || ua.trim() === '') return 'no user agent'
  const m = SCRIPT_UA.exec(ua)
  return m ? m[1] : null
}

const BROWSERS: Array<[string, RegExp]> = [
  ['Edge', /Edg\/(\d+)/],
  ['Firefox', /Firefox\/(\d+)/],
  ['Chrome', /Chrome\/(\d+)/],
  ['Safari', /Version\/(\d+).*Safari/]
]

/** A short "Chrome 128 · macOS" reading of a user agent. */
export function uaLabel(ua: string | null | undefined): string {
  if (!ua) return 'no user agent'
  const tool = SCRIPT_UA.exec(ua)
  if (tool) return tool[1]
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : null
  let browser: string | null = null
  for (const [name, re] of BROWSERS) {
    const m = re.exec(ua)
    if (m) {
      browser = `${name} ${m[1]}`
      break
    }
  }
  return [browser, os].filter(Boolean).join(' · ') || ua.slice(0, 60)
}

// ── #2204 scripted sessions ─────────────────────────────────────────────────

/** Requests a session needs before its pace or loop is judged. */
export const SCRIPTED_MIN_EVENTS = 20
/** Machine pace: the median gap is at most this… */
export const PACE_MAX_GAP_MS = 2000
/** …and the gaps vary by at most this share of their mean. */
export const PACE_MAX_CV = 0.2
/** A loop must repeat at least this many whole times. */
export const LOOP_MIN_REPEATS = 4
/** A loop's cycle must be at most this long (slower is a page someone reloads). */
export const LOOP_MAX_CYCLE_MS = 20_000
/** A loop's cycle times vary by at most this share of their mean. */
export const LOOP_MAX_CV = 0.3
/** Pace and loops count only when at least this share of calls came from outside the app. */
export const OUTSIDE_APP_SHARE = 0.5

export interface ScriptedInput {
  /** Request times (epoch ms), oldest first. */
  times: number[]
  /** Route template of each request (same order). */
  routes: string[]
  /** Newest user agent. */
  ua: string | null
  /** Of the app calls (not file downloads) seen, how many carried no x-nivaro-client header. */
  outside: number
  appCalls: number
}
export interface ScriptedPattern {
  kind: 'tool' | 'outside-app' | 'machine-pace' | 'loop'
  text: string
}
export interface ScriptedVerdict {
  flagged: boolean
  patterns: ScriptedPattern[]
  /** Requests per second over the requests judged. */
  rate: number
}

function stats(xs: number[]): { mean: number; cv: number; median: number } {
  if (xs.length === 0) return { mean: 0, cv: 0, median: 0 }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length)
  const sorted = [...xs].sort((a, b) => a - b)
  return { mean, cv: mean > 0 ? sd / mean : 0, median: sorted[Math.floor(sorted.length / 2)] }
}

const secs = (ms: number) =>
  ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`

/**
 * The shortest period p (1..12) the tail of `seq` repeats with, at least LOOP_MIN_REPEATS whole
 * times (p = 1 needs 12 repeats); null when there is none.
 */
export function findPeriod(seq: string[]): { period: number; repeats: number } | null {
  for (let p = 1; p <= 12; p++) {
    const need = Math.max(p * LOOP_MIN_REPEATS, 12)
    if (seq.length < need) break
    let len = p
    // how far back the tail keeps matching itself shifted by p
    for (let i = seq.length - 1 - p; i >= 0; i--) {
      if (seq[i] !== seq[i + p]) break
      len++
    }
    if (len >= need) {
      // a "loop" of one distinct call repeated is p = 1; a longer period must really alternate
      const distinct = new Set(seq.slice(seq.length - p)).size
      if (p > 1 && distinct === 1) continue
      return { period: p, repeats: Math.floor(len / p) }
    }
  }
  return null
}

/**
 * #2204 — a person's session making requests like a machine. Flagged when the client names a
 * scripting tool, or when calls from outside the app (no x-nivaro-client header) run at a steady
 * machine pace or in a fixed repeating loop. The app's own polling and bulk loops carry the
 * header, so they never flag on pace alone.
 */
export function detectScripted(input: ScriptedInput): ScriptedVerdict {
  const { times, routes } = input
  const patterns: ScriptedPattern[] = []
  const n = times.length
  const spanMs = n > 1 ? times[n - 1] - times[0] : 0
  const rate = spanMs > 0 ? Math.round(((n - 1) / spanMs) * 10_000) / 10 : 0
  const tool = n >= 3 ? scriptedUa(input.ua) : null
  if (tool) patterns.push({ kind: 'tool', text: `The client calls itself ${tool}` })
  const outsideShare = input.appCalls > 0 ? input.outside / input.appCalls : 0
  const outside = input.appCalls >= 10 && outsideShare >= OUTSIDE_APP_SHARE
  if (outside)
    patterns.push({
      kind: 'outside-app',
      text: `${Math.round(outsideShare * 100)}% of its calls did not come from a Nivaro app`
    })
  let paced = false
  let looped = false
  if (n >= SCRIPTED_MIN_EVENTS) {
    const gaps: number[] = []
    for (let i = 1; i < n; i++) gaps.push(times[i] - times[i - 1])
    const g = stats(gaps)
    if (g.median <= PACE_MAX_GAP_MS && g.cv <= PACE_MAX_CV) {
      paced = true
      patterns.push({
        kind: 'machine-pace',
        text: `A call every ${secs(g.mean)}, steady to ±${Math.round(g.cv * 100)}%`
      })
    }
    const loop = findPeriod(routes)
    if (loop) {
      const p = loop.period
      const starts: number[] = []
      for (let i = n - loop.repeats * p; i < n; i += p) starts.push(times[i])
      const cycles: number[] = []
      for (let i = 1; i < starts.length; i++) cycles.push(starts[i] - starts[i - 1])
      const c = stats(cycles)
      if (cycles.length >= 2 && c.mean <= LOOP_MAX_CYCLE_MS && c.cv <= LOOP_MAX_CV) {
        looped = true
        const calls = routes.slice(n - p)
        patterns.push({
          kind: 'loop',
          text:
            p === 1
              ? `The same call ${loop.repeats} times in a row, every ${secs(c.mean)}: ${calls[0]}`
              : `A loop of ${p} calls repeated ${loop.repeats} times, every ${secs(c.mean)}: ${calls.join(' → ')}`
        })
      }
    }
  }
  const flagged = !!tool || ((paced || looped) && outside)
  return { flagged, patterns, rate }
}

// ── #2235 one session from two places ───────────────────────────────────────

/** Two networks count as "at the same time" when the session goes back and forth within this. */
export const TWO_PLACES_WINDOW_MS = 300_000

export interface PlaceHit {
  t: number
  net: string
}
/**
 * The first pair of networks a session alternated between (A, then B, then A again within
 * TWO_PLACES_WINDOW_MS) — two machines using one cookie, not a laptop moving from office Wi-Fi to
 * a phone hotspot (A A A B B B). Hits oldest first.
 */
export function detectTwoPlaces(
  hits: PlaceHit[],
  windowMs = TWO_PLACES_WINDOW_MS
): { a: string; b: string; at: number } | null {
  const last = new Map<string, number>()
  for (const h of hits) {
    const prev = last.get(h.net)
    if (prev != null && h.t - prev <= windowMs) {
      for (const [net, t] of last) {
        if (net !== h.net && t > prev && t <= h.t) return { a: h.net, b: net, at: h.t }
      }
    }
    last.set(h.net, h.t)
  }
  return null
}

/**
 * How sure the two-places flag is: `high` when the two sides run different browsers or sit in
 * different countries; `low` when it is the same browser (a carrier network can hand one phone a
 * new address per connection). Only `high` is raised to admins.
 */
export function twoPlacesConfidence(
  a: { ua: string | null; country?: string | null },
  b: { ua: string | null; country?: string | null }
): 'high' | 'low' {
  if (uaLabel(a.ua) !== uaLabel(b.ua)) return 'high'
  if (a.country && b.country && a.country !== b.country) return 'high'
  return 'low'
}

// ── #2236 misconfigured clients ─────────────────────────────────────────────

export interface EnvComponent {
  name: string
  environment: string
  kind: string
  host: string
}
export interface MisconfigFacts {
  /** caller → { host of the Referer / Origin it sent: count } (own hosts already left out). */
  referers: Record<string, Record<string, number>>
  /** API keys this instance does not know: prefix → count + the hosts they came from. */
  unknownKeys: Array<{ prefix: string; n: number; last_at: string; referer: string | null }>
  /** Key callers seen in the window with their names. */
  keys: Array<{ caller: string; name: string | null }>
}
export interface MisconfigFinding {
  caller: string
  kind: 'referer' | 'unknown-key' | 'key-name'
  /** The other environment the evidence names (null when it cannot be told). */
  environment: string | null
  text: string
  n: number
}

/** The host of a URL or a bare host (lower case, port kept); null when unreadable. */
export function hostOf(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).host.toLowerCase() || null
  } catch {
    return null
  }
}

/**
 * #2236 — calls aimed at the wrong environment: a Referer / Origin from another environment's
 * frontend or admin, an API key this instance never minted (sent by a client configured for
 * another environment), or a key named for another environment. `self` = this instance's
 * environment name in the registry (null when the registry does not name it).
 */
export function misconfigFindings(
  facts: MisconfigFacts,
  components: EnvComponent[],
  self: string | null
): MisconfigFinding[] {
  const out: MisconfigFinding[] = []
  const others = components.filter((c) => c.environment !== self)
  const envOfHost = (host: string): EnvComponent | null =>
    others.find((c) => c.host === host) ?? null
  for (const [caller, hosts] of Object.entries(facts.referers)) {
    for (const [host, n] of Object.entries(hosts)) {
      const c = envOfHost(host)
      if (!c) continue
      out.push({
        caller,
        kind: 'referer',
        environment: c.environment,
        text: `Calls come from ${c.environment}'s ${c.name} (${host})`,
        n
      })
    }
  }
  for (const k of facts.unknownKeys) {
    const c = k.referer ? envOfHost(k.referer) : null
    out.push({
      caller: 'anon',
      kind: 'unknown-key',
      environment: c?.environment ?? null,
      text: c
        ? `API key ${k.prefix}… is not one of this instance's keys; the calls come from ${c.environment}'s ${c.name}`
        : `API key ${k.prefix}… is not one of this instance's keys (minted on another environment, or revoked)`,
      n: k.n
    })
  }
  const envNames = [...new Set(others.map((c) => c.environment))].filter((e) => e.length >= 3)
  for (const k of facts.keys) {
    if (!k.name) continue
    const named = envNames.find((e) =>
      new RegExp(`\\b${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(k.name ?? '')
    )
    if (!named || (self && new RegExp(`\\b${self}\\b`, 'i').test(k.name))) continue
    out.push({
      caller: k.caller,
      kind: 'key-name',
      environment: named,
      text: `The key is named for ${named} ("${k.name}") but calls ${self ?? 'this instance'}`,
      n: 0
    })
  }
  return out
}

// ── #2257 bad data by caller ────────────────────────────────────────────────

export interface IntegrityRow {
  collection: string
  item_id: string
  findings: string | null
  checked_at: Date | string
}
export interface WriteRow {
  collection: string
  item: string
  user: string | null
  api_key_id: number | null
  auth_method: string | null
  origin: string | null
  timestamp: Date | string
}
export interface BadDataCaller {
  caller: string
  /** Records whose newest integrity check (after a write) found problems. */
  records: number
  findings: number
  by_rule: Array<{ rule: string; n: number }>
  by_collection: Array<{ collection: string; n: number }>
  samples: Array<{ collection: string; item: string; rule: string; message: string; at: string }>
}

/** The caller key of the write behind a record: a key, a person, or the job that wrote it. */
export function writeCaller(
  w: Pick<WriteRow, 'user' | 'api_key_id' | 'auth_method' | 'origin'>
): string {
  if (w.api_key_id != null && (w.auth_method === 'api_key' || w.auth_method == null))
    return `k${w.api_key_id}`
  if (w.user) return `u${String(w.user).toUpperCase()}`
  return w.origin ? `src:${w.origin}` : 'cron'
}

function parseFindings(
  raw: string | null
): Array<{ field?: string; rule?: string; message?: string }> {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []
  } catch {
    return []
  }
}

/**
 * #2257 — Data Integrity findings attributed to the caller whose write produced them: for each
 * record whose stored check (source `write`, the after-write check) found problems, the newest
 * write to that record at or before the check names the caller. Busiest first.
 */
export function attributeFindings(rows: IntegrityRow[], writes: WriteRow[]): BadDataCaller[] {
  const byRecord = new Map<string, WriteRow[]>()
  for (const w of writes) {
    const k = `${w.collection}\u0000${w.item}`
    const list = byRecord.get(k) ?? []
    list.push(w)
    byRecord.set(k, list)
  }
  const callers = new Map<
    string,
    {
      records: number
      findings: number
      rules: Map<string, number>
      cols: Map<string, number>
      samples: BadDataCaller['samples']
    }
  >()
  for (const r of rows) {
    const found = parseFindings(r.findings)
    if (found.length === 0) continue
    const at = new Date(r.checked_at).getTime()
    const list = byRecord.get(`${r.collection}\u0000${r.item_id}`) ?? []
    let best: WriteRow | null = null
    let bestT = -Infinity
    for (const w of list) {
      const t = new Date(w.timestamp).getTime()
      // the check runs ~1.5 s after the write; allow a minute of clock skew either way
      if (t <= at + 60_000 && t > bestT) {
        best = w
        bestT = t
      }
    }
    if (!best) continue
    const caller = writeCaller(best)
    let c = callers.get(caller)
    if (!c) {
      c = { records: 0, findings: 0, rules: new Map(), cols: new Map(), samples: [] }
      callers.set(caller, c)
    }
    c.records++
    c.findings += found.length
    c.cols.set(r.collection, (c.cols.get(r.collection) ?? 0) + 1)
    for (const f of found) {
      const rule = String(f.rule ?? 'check')
      c.rules.set(rule, (c.rules.get(rule) ?? 0) + 1)
    }
    if (c.samples.length < 5)
      c.samples.push({
        collection: r.collection,
        item: r.item_id,
        rule: String(found[0].rule ?? 'check'),
        message: String(found[0].message ?? '').slice(0, 200),
        at: new Date(r.checked_at).toISOString()
      })
  }
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  return [...callers.entries()]
    .map(([caller, c]) => ({
      caller,
      records: c.records,
      findings: c.findings,
      by_rule: top(c.rules, 6).map(([rule, n]) => ({ rule, n })),
      by_collection: top(c.cols, 6).map(([collection, n]) => ({ collection, n })),
      samples: c.samples
    }))
    .sort((a, b) => b.records - a.records)
}

// ── #2196 HTTP caching per route ────────────────────────────────────────────

/** Slots the http-cache tap counts per route. */
export const CACHE_SLOTS = [
  'n',
  'not_modified',
  'conditional',
  'cache_control',
  'no_store',
  'max_age',
  'etag',
  'last_modified',
  'repeat'
] as const
export type CacheSlot = (typeof CACHE_SLOTS)[number]

/** What a response's headers say about browser caching. */
export function cacheHeaderFacts(h: {
  cacheControl: string | null
  etag: string | null
  lastModified: string | null
}): {
  cache_control: boolean
  no_store: boolean
  max_age: boolean
  etag: boolean
  last_modified: boolean
} {
  const cc = (h.cacheControl ?? '').toLowerCase()
  const maxAge = /(?:^|[,\s])(?:s-)?max-age=(\d+)/.exec(cc)
  return {
    cache_control: cc.trim() !== '',
    no_store: /no-store/.test(cc),
    max_age: !!maxAge && Number(maxAge[1]) > 0 && !/no-store|no-cache/.test(cc),
    etag: !!h.etag,
    last_modified: !!h.lastModified
  }
}

/** A route needs this many GETs in the window before its caching is judged. */
export const CACHE_MIN_HITS = 20

export interface CacheRouteRow {
  route: string
  n: number
  not_modified: number
  conditional: number
  cache_control: number
  no_store: number
  max_age: number
  etag: number
  last_modified: number
  /** Requests the same caller had already made, same URL, in the last minute. */
  repeat: number
}
export interface CacheVerdict extends CacheRouteRow {
  /** 304 responses as a share of all (the revalidated browser cache hits). */
  hit_rate: number
  /** Static content, or callers fetch the same URL again within a minute (a browser cache would
   *  answer those). */
  cacheable: boolean
  /** A cacheable route that sends no Cache-Control, ETag or Last-Modified on any response. */
  no_headers: boolean
  /** The route sends validators but browsers never revalidate (no conditional requests). */
  unused_validators: boolean
}

/** A repeat share at or above this makes a route cacheable. */
export const CACHE_REPEAT_SHARE = 0.3

const STATIC_ROUTE_RE =
  /(\/assets|\/thumbnail|\/poster|\/captions|\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?)(\s|$)|^GET \/api\/(version|server\/info|branding|settings\/public|translations))/i

/** Static content by its route: file assets, posters, bundles, version / branding reads. */
export function staticRoute(route: string): boolean {
  return STATIC_ROUTE_RE.test(route)
}

/** Per-route verdicts, worst first: header-less cacheable routes, then by volume. */
export function cacheVerdicts(rows: CacheRouteRow[]): CacheVerdict[] {
  return rows
    .map((r) => {
      const any = r.cache_control + r.etag + r.last_modified
      const cacheable = staticRoute(r.route) || (r.n > 0 && r.repeat / r.n >= CACHE_REPEAT_SHARE)
      return {
        ...r,
        hit_rate: r.n ? Math.round((1000 * r.not_modified) / r.n) / 1000 : 0,
        cacheable,
        no_headers: cacheable && r.n >= CACHE_MIN_HITS && any === 0,
        unused_validators:
          r.n >= CACHE_MIN_HITS && r.etag + r.last_modified > 0 && r.conditional === 0
      }
    })
    .sort(
      (a, b) =>
        Number(b.no_headers) - Number(a.no_headers) ||
        Number(b.cacheable) - Number(a.cacheable) ||
        b.n - a.n
    )
}
