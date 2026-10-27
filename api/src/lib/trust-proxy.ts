import { isIP } from 'node:net'

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
