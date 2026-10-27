import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { pipeline, Readable } from 'node:stream'
import zlib from 'node:zlib'

/**
 * Outbound request guard (SSRF). Two layers:
 *
 *  - `assertSafeUrl(url)` — http(s) only; refuses private/reserved hosts by name, by IP literal
 *    (every IPv4/IPv6 spelling the URL parser accepts, IPv4-mapped/compatible/NAT64/6to4 IPv6
 *    included) and by what the name resolves to.
 *  - `safeFetch(url, init)` — the same checks, then the connection is made to the address that
 *    was checked (the resolved address is pinned through the socket's `lookup`), so a DNS answer
 *    that changes between the check and the connect (rebinding) cannot reach a private host.
 *    Redirects are followed by hand and every hop is checked and pinned again.
 *
 * SSRF_ALLOW_HOSTS (comma list; self-hosted only, ignored in cloud mode) lets named hosts
 * (`erp.corp`, `*.corp.example`), IP literals or CIDRs (`10.20.0.0/16`) through — for
 * deployments whose integrations deliberately reach internal services.
 */

const BLOCKED_NAME_RE = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i

const PRIVATE_MESSAGE = 'Requests to private/loopback addresses are not allowed'
const RESOLVES_PRIVATE_MESSAGE = 'Hostname resolves to a private/reserved address'

function parseIPv4(s: string): number[] | null {
  if (isIP(s) !== 4) return null
  const parts = s.split('.').map((p) => Number(p))
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : null
}

/** Eight 16-bit groups, or null. Accepts `::` compression, a dotted IPv4 tail and a zone id. */
function parseIPv6(input: string): number[] | null {
  let s = input.replace(/^\[|\]$/g, '')
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (isIP(s) !== 6) return null
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail)
    if (!v4) return null
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${(
      (v4[2] << 8) | v4[3]
    ).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if (halves.length === 1 && head.length !== 8) return null
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if (fill < 0) return null
  const groups = [...head, ...new Array(fill).fill('0'), ...rest].map((h) => Number.parseInt(h, 16))
  if (groups.length !== 8 || groups.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null
  return groups
}

function blockedV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // RFC 1918
    (a === 100 && (b & 0xc0) === 64) || // 100.64.0.0/10 CGNAT (Alibaba metadata 100.100.100.200)
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local (cloud metadata 169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 192 && b === 168) || // RFC 1918
    (a === 198 && (b & 0xfe) === 18) || // 198.18.0.0/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast 224/4, reserved 240/4, broadcast
  )
}

function blockedV6(g: number[]): boolean {
  const [a, b, c, d, e, f, gg, h] = g
  const v4 = () => [gg >> 8, gg & 0xff, h >> 8, h & 0xff]
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0) {
    if (f === 0xffff) return blockedV4(v4()) // ::ffff:a.b.c.d IPv4-mapped
    if (f === 0) {
      if (gg === 0 && (h === 0 || h === 1)) return true // :: unspecified, ::1 loopback
      return blockedV4(v4()) // ::a.b.c.d IPv4-compatible (deprecated)
    }
  }
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0xffff && f === 0) return true // ::ffff:0:a.b.c.d SIIT
  if (a === 0x64 && b === 0xff9b) {
    if (c === 0 && d === 0 && e === 0 && f === 0) return blockedV4(v4()) // NAT64 64:ff9b::/96
    return true // 64:ff9b:1::/48 local-use NAT64 and the rest of the prefix
  }
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return true // 100::/64 discard
  if (a === 0x2001 && b === 0) return true // Teredo 2001::/32 (embeds a client IPv4)
  if (a === 0x2001 && b >= 0x10 && b <= 0x2f) return true // ORCHID 2001:10::/28, 2001:20::/28
  if (a === 0x2001 && b === 0xdb8) return true // documentation
  if (a === 0x2002) return blockedV4([b >> 8, b & 0xff, c >> 8, c & 0xff]) // 6to4 embeds IPv4
  if ((a & 0xfe00) === 0xfc00) return true // fc00::/7 unique local (AWS metadata fd00:ec2::254)
  if ((a & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return true // multicast
  return false
}

/** True when an IP address (v4 or v6, any spelling) is loopback, private, link-local, CGNAT,
 *  unique-local, unspecified, multicast, documentation or otherwise not a public unicast
 *  address. Non-IP input is refused (true). */
export function isBlockedAddress(ip: string): boolean {
  const v4 = parseIPv4(ip)
  if (v4) return blockedV4(v4)
  const v6 = parseIPv6(ip)
  if (v6) return blockedV6(v6)
  return true
}

// ─── SSRF_ALLOW_HOSTS ────────────────────────────────────────────────────────

interface AllowList {
  names: string[]
  suffixes: string[]
  cidrs: Array<{ v6: boolean; bits: number[]; len: number }>
}

let allowCache: { raw: string; list: AllowList } | null = null

function toBits(ip: string): { v6: boolean; bits: number[] } | null {
  const v4 = parseIPv4(ip)
  if (v4) return { v6: false, bits: v4.flatMap((o) => byteBits(o, 8)) }
  const v6 = parseIPv6(ip)
  if (v6) return { v6: true, bits: v6.flatMap((x) => byteBits(x, 16)) }
  return null
}

function byteBits(n: number, width: number): number[] {
  const out: number[] = []
  for (let i = width - 1; i >= 0; i--) out.push((n >> i) & 1)
  return out
}

function allowList(): AllowList {
  if (process.env.CLOUD_META_DB_URL) return { names: [], suffixes: [], cidrs: [] }
  const raw = process.env.SSRF_ALLOW_HOSTS ?? ''
  if (allowCache && allowCache.raw === raw) return allowCache.list
  const list: AllowList = { names: [], suffixes: [], cidrs: [] }
  for (const entry of raw.split(',').map((s) => s.trim().toLowerCase())) {
    if (!entry) continue
    const [addr, lenText] = entry.split('/')
    const parsed = toBits(addr)
    if (parsed) {
      const max = parsed.v6 ? 128 : 32
      const len = lenText === undefined ? max : Number(lenText)
      if (Number.isInteger(len) && len >= 0 && len <= max) list.cidrs.push({ ...parsed, len })
      continue
    }
    if (entry.startsWith('*.')) list.suffixes.push(entry.slice(1))
    else if (entry.startsWith('.')) list.suffixes.push(entry)
    else list.names.push(entry)
  }
  allowCache = { raw, list }
  return list
}

function hostAllowed(hostname: string): boolean {
  const list = allowList()
  return list.names.includes(hostname) || list.suffixes.some((s) => hostname.endsWith(s))
}

function addressAllowed(ip: string): boolean {
  const list = allowList()
  if (list.cidrs.length === 0) return false
  const parsed = toBits(ip)
  if (!parsed) return false
  return list.cidrs.some(
    (c) => c.v6 === parsed.v6 && c.bits.slice(0, c.len).every((bit, i) => bit === parsed.bits[i])
  )
}

// ─── Checks ──────────────────────────────────────────────────────────────────

interface Pin {
  address: string
  family: 4 | 6
}

interface CheckedUrl {
  url: URL
  /** Null for an IP literal (nothing to resolve) or an allow-listed name (resolved normally). */
  pin: Pin | null
}

function normalHost(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(/^\[|]$/g, '')
    .replace(/\.$/, '')
}

async function checkUrl(rawUrl: string | URL): Promise<CheckedUrl> {
  let url: URL
  try {
    url = new URL(String(rawUrl))
  } catch {
    throw new Error('Invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed')
  }
  const hostname = normalHost(url)
  if (!hostname) throw new Error('Invalid URL')
  if (hostAllowed(hostname)) return { url, pin: null }
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname) && !addressAllowed(hostname)) throw new Error(PRIVATE_MESSAGE)
    return { url, pin: null }
  }
  if (BLOCKED_NAME_RE.test(hostname)) throw new Error(PRIVATE_MESSAGE)
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await dns.promises.lookup(hostname, { all: true, family: 0 })
  } catch {
    throw new Error('Hostname could not be resolved')
  }
  if (addresses.length === 0) throw new Error('Hostname could not be resolved')
  for (const { address } of addresses) {
    if (isBlockedAddress(address) && !addressAllowed(address)) {
      throw new Error(RESOLVES_PRIVATE_MESSAGE)
    }
  }
  const chosen = addresses.find((a) => a.family === 4) ?? addresses[0]
  return { url, pin: { address: chosen.address, family: chosen.family === 6 ? 6 : 4 } }
}

/**
 * Throws if the URL is non-http(s), targets a private/loopback/reserved host, or resolves to a
 * private/reserved address. Callers that then `fetch()` themselves are still open to DNS
 * rebinding between this check and their connect — prefer `safeFetch`.
 */
export async function assertSafeUrl(rawUrl: string): Promise<void> {
  await checkUrl(rawUrl)
}

// ─── safeFetch ───────────────────────────────────────────────────────────────

export type SafeFetchInit = Omit<RequestInit, 'redirect'> & {
  redirect?: 'follow' | 'manual' | 'error'
  /** Redirect hops followed (each one re-checked). Default 5. */
  maxRedirects?: number
  /** Whole-request timeout (in addition to `signal`). */
  timeoutMs?: number
}

function abortError(): Error {
  const err = new Error('This operation was aborted')
  err.name = 'AbortError'
  return err
}

function headerRecord(h: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h) return out
  new Headers(h).forEach((value, key) => {
    out[key] = value
  })
  return out
}

async function bodyBuffer(
  body: RequestInit['body'],
  headers: Record<string, string>
): Promise<Buffer | null> {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof URLSearchParams) {
    if (!headers['content-type'])
      headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
    return Buffer.from(body.toString())
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (body instanceof Blob) {
    if (!headers['content-type'] && body.type) headers['content-type'] = body.type
    return Buffer.from(await body.arrayBuffer())
  }
  throw new TypeError('safeFetch: unsupported request body type')
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304])

function requestOnce(
  checked: CheckedUrl,
  method: string,
  headers: Record<string, string>,
  body: Buffer | null,
  signal: AbortSignal | undefined
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const { url, pin } = checked
    const isHttps = url.protocol === 'https:'
    const reqHeaders: Record<string, string> = {
      accept: '*/*',
      'accept-encoding': 'gzip, deflate, br',
      'user-agent': 'node',
      ...headers
    }
    if (body) reqHeaders['content-length'] = String(body.length)
    const options: https.RequestOptions = {
      method,
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|]$/g, ''),
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: reqHeaders,
      agent: false
    }
    if (url.username || url.password) {
      options.auth = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
    }
    if (pin) {
      // The connection goes to the address that was checked, whatever DNS says now.
      options.lookup = ((
        _host: string,
        opts: { all?: boolean } | number | undefined,
        cb: (...args: unknown[]) => void
      ) => {
        if (typeof opts === 'object' && opts?.all) cb(null, [{ ...pin }])
        else cb(null, pin.address, pin.family)
      }) as never
    }
    let settled = false
    const onAbort = () => {
      req.destroy(abortError())
    }
    const req = (isHttps ? https : http).request(options, (res) => {
      const status = res.statusCode ?? 0
      const outHeaders = new Headers()
      const raw = res.rawHeaders
      for (let i = 0; i + 1 < raw.length; i += 2) {
        try {
          outHeaders.append(raw[i], raw[i + 1])
        } catch {
          /* a header the Headers class refuses is dropped */
        }
      }
      let stream: Readable = res
      const encoding = (res.headers['content-encoding'] ?? '').toString().trim().toLowerCase()
      const decoder =
        encoding === 'gzip' || encoding === 'x-gzip'
          ? zlib.createGunzip()
          : encoding === 'deflate'
            ? zlib.createInflate()
            : encoding === 'br'
              ? zlib.createBrotliDecompress()
              : null
      if (decoder) {
        stream = pipeline(res, decoder, () => {}) as unknown as Readable
        outHeaders.delete('content-encoding')
        outHeaders.delete('content-length')
      }
      const noBody = method === 'HEAD' || NULL_BODY_STATUS.has(status)
      if (noBody) res.resume()
      if (signal) {
        signal.removeEventListener('abort', onAbort)
        signal.addEventListener('abort', () => stream.destroy(abortError()), { once: true })
      }
      settled = true
      try {
        resolve(
          new Response(
            noBody ? null : (Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>),
            { status: status >= 200 && status <= 599 ? status : 502, headers: outHeaders }
          )
        )
      } catch (err) {
        res.destroy()
        reject(err)
      }
    })
    req.on('error', (err) => {
      if (!settled) reject(err)
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (body) req.end(body)
    else req.end()
  })
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const CROSS_ORIGIN_DROP = ['authorization', 'cookie', 'proxy-authorization']

/**
 * `fetch` with the SSRF guard applied to the URL and to every redirect hop, and the connection
 * pinned to the checked address (no DNS-rebinding window). Supports string / URLSearchParams /
 * ArrayBuffer(View) / Blob bodies. `redirect: 'manual'` returns the 3xx response untouched.
 */
export async function safeFetch(rawUrl: string | URL, init: SafeFetchInit = {}): Promise<Response> {
  const maxRedirects = init.maxRedirects ?? 5
  const signals: AbortSignal[] = []
  if (init.signal) signals.push(init.signal)
  if (init.timeoutMs && init.timeoutMs > 0) signals.push(AbortSignal.timeout(init.timeoutMs))
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
  let method = (init.method ?? 'GET').toUpperCase()
  const headers = headerRecord(init.headers)
  let body = await bodyBuffer(init.body, headers)
  let current = String(rawUrl)
  for (let hop = 0; ; hop++) {
    const checked = await checkUrl(current)
    const res = await requestOnce(checked, method, headers, body, signal)
    if (!REDIRECT_STATUS.has(res.status) || init.redirect === 'manual') return res
    const location = res.headers.get('location')
    if (!location) return res
    await res.body?.cancel().catch(() => {})
    if (init.redirect === 'error') throw new TypeError('Redirect not allowed')
    if (hop >= maxRedirects) throw new Error('Too many redirects')
    const next = new URL(location, checked.url)
    if (
      res.status === 303
        ? method !== 'HEAD'
        : (res.status === 301 || res.status === 302) && method === 'POST'
    ) {
      method = 'GET'
      body = null
      delete headers['content-type']
    }
    if (next.origin !== checked.url.origin) for (const h of CROSS_ORIGIN_DROP) delete headers[h]
    current = next.toString()
  }
}

/** Cloud mode: every outbound call made on a tenant's behalf goes through `safeFetch`
 *  (private hosts and the metadata endpoint refused, redirects re-checked). Self-hosted:
 *  plain `fetch` — admin-configured integrations reach internal services on purpose. */
export function fetchGuardedInCloud(url: string, init: RequestInit = {}): Promise<Response> {
  if (!process.env.CLOUD_META_DB_URL) return fetch(url, init)
  return safeFetch(url, init as SafeFetchInit)
}
