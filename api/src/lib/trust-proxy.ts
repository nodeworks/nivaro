import { BlockList, isIP } from 'node:net'

/**
 * TRUST_PROXY → Fastify's `trustProxy` (M14, security audit 2026-10-27).
 *
 *   unset / false / 0     trust nobody: req.ip is the socket peer
 *   true                  trust EVERY hop: req.ip is the left-most X-Forwarded-For entry, which
 *                         the client writes — per-IP limits and API-key IP allowlists can be
 *                         spoofed. Still accepted (deployments set it), with one boot warning.
 *   <n>                   trust the n proxies nearest the app (traefik alone = 1)
 *   ip, cidr, …           trust only these proxy addresses (also proxy-addr's names
 *                         loopback / linklocal / uniquelocal)
 *
 * Leaf module: no app imports, so config.ts, server.ts and realtime-server.ts can share it.
 */

export type TrustProxySetting = boolean | number | string[]

export interface ParsedTrustProxy {
  value: TrustProxySetting
  /** A line for the boot log, or null when the setting needs no comment. */
  warning: string | null
}

const NAMED = new Set(['loopback', 'linklocal', 'uniquelocal'])

function validToken(token: string): boolean {
  if (NAMED.has(token)) return true
  const [addr, bits, extra] = token.split('/')
  if (extra !== undefined) return false
  const family = isIP(addr ?? '')
  if (!family) return false
  if (bits === undefined) return true
  if (!/^\d{1,3}$/.test(bits)) return false
  return Number(bits) <= (family === 4 ? 32 : 128)
}

export function parseTrustProxy(raw: string | undefined | null): ParsedTrustProxy {
  const v = String(raw ?? '').trim()
  const lower = v.toLowerCase()
  if (!v || lower === 'false' || lower === '0' || lower === 'off' || lower === 'no') {
    return { value: false, warning: null }
  }
  if (lower === 'true') {
    return {
      value: true,
      warning:
        'TRUST_PROXY=true trusts every X-Forwarded-For hop, so a client can choose the address ' +
        'per-IP limits and API-key IP allowlists see. Set the number of proxies in front of the ' +
        'app (e.g. TRUST_PROXY=1) or their addresses (TRUST_PROXY=10.0.0.0/8) instead.'
    }
  }
  if (/^\d+$/.test(v)) return { value: Number(v), warning: null }
  const tokens = v
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const good = tokens.filter(validToken)
  const bad = tokens.filter((t) => !validToken(t))
  if (good.length === 0) {
    return {
      value: false,
      warning: `TRUST_PROXY="${v}" is not true, false, a hop count or a list of IPs/CIDRs — no proxy is trusted.`
    }
  }
  return {
    value: good,
    warning: bad.length
      ? `TRUST_PROXY: ignored entries that are not an IP or CIDR: ${bad.join(', ')}`
      : null
  }
}

/** The process's own setting (read once; the env does not change while it runs). */
let cached: ParsedTrustProxy | null = null
export function trustProxyFromEnv(): ParsedTrustProxy {
  if (!cached) cached = parseTrustProxy(process.env.TRUST_PROXY)
  return cached
}

/** The value Fastify's `trustProxy` option takes. Fastify's types (5.12+) no longer list a
 *  bare hop count, so a number becomes the same rule proxy-addr applies to one: trust the
 *  first N hops counting back from the socket. */
export function fastifyTrustProxy(
  value: TrustProxySetting
): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (typeof value === 'number') return (_address: string, hop: number) => hop < value
  return value
}

const NAMED_SUBNETS: Record<string, Array<[string, number, 'ipv4' | 'ipv6']>> = {
  loopback: [
    ['127.0.0.0', 8, 'ipv4'],
    ['::1', 128, 'ipv6']
  ],
  linklocal: [
    ['169.254.0.0', 16, 'ipv4'],
    ['fe80::', 10, 'ipv6']
  ],
  uniquelocal: [
    ['10.0.0.0', 8, 'ipv4'],
    ['172.16.0.0', 12, 'ipv4'],
    ['192.168.0.0', 16, 'ipv4'],
    ['fc00::', 7, 'ipv6']
  ]
}

/**
 * Whether the peer a connection came from is a trusted proxy (the first hop, as Fastify judges
 * X-Forwarded-Host with `trustProxy`). Sockets and graphql-ws upgrades never pass Fastify's
 * request object, so a Hub shared deployment asks this before it believes a handshake's
 * X-Forwarded-Host (ruling P5-16). `true` trusts everyone, a hop count trusts the nearest peer,
 * a list trusts those addresses (named ranges included), unset trusts nobody.
 */
export function peerIsTrustedProxy(
  address: string | null | undefined,
  value: TrustProxySetting = trustProxyFromEnv().value
): boolean {
  if (value === true) return true
  if (value === false) return false
  if (typeof value === 'number') return value > 0
  const raw = String(address ?? '').trim()
  if (!raw) return false
  // An IPv4 peer on a dual-stack socket reads as ::ffff:a.b.c.d.
  const addr = /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(raw) ? raw.slice(7) : raw
  const family = isIP(addr)
  if (!family) return false
  const list = new BlockList()
  for (const token of value) {
    const named = NAMED_SUBNETS[token]
    if (named) {
      for (const [net, bits, fam] of named) list.addSubnet(net, bits, fam)
      continue
    }
    const [ip, bits] = token.split('/')
    const fam = isIP(ip ?? '') === 6 ? 'ipv6' : 'ipv4'
    if (bits === undefined) list.addAddress(ip, fam)
    else list.addSubnet(ip, Number(bits), fam)
  }
  return list.check(addr, family === 6 ? 'ipv6' : 'ipv4')
}

type HeaderValue = string | string[] | undefined

/**
 * The host a request or socket handshake names, by the TRUST_PROXY rule Fastify applies to
 * `req.host`: the LAST entry of X-Forwarded-Host (the one the trusted proxy appended — a client
 * can put anything in front of it) when the peer is a trusted proxy, else the Host header.
 * A Hub shared deployment resolves its app from this on HTTP, socket.io and graphql-ws alike,
 * so one connection can never name one app on HTTP and another on its socket (ruling P5-16).
 */
export function trustedRequestHost(
  headers: { host?: HeaderValue; 'x-forwarded-host'?: HeaderValue } | undefined,
  peer: string | null | undefined,
  value: TrustProxySetting = trustProxyFromEnv().value
): string | null {
  const one = (v: HeaderValue) => (Array.isArray(v) ? v.join(',') : (v ?? ''))
  const forwarded = one(headers?.['x-forwarded-host'])
  if (forwarded.trim() && peerIsTrustedProxy(peer, value)) {
    const last = forwarded.slice(forwarded.lastIndexOf(',') + 1).trim()
    if (last) return last
  }
  const host = one(headers?.host).trim()
  return host || null
}
