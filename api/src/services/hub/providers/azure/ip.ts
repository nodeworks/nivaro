import { isIPv4 } from 'node:net'

/**
 * IPv4 range maths for Azure SQL firewall rules (no `providers/cidr.ts` existed when this was
 * written: this is the same numeric parse as cloudflare/access.ts, for a start-end range).
 */

/** An IPv4 address as a number (null when it is not a dotted IPv4). */
export function ipv4ToNumber(addr: unknown): number | null {
  const s = typeof addr === 'string' ? addr.trim() : ''
  if (!isIPv4(s)) return null
  return s.split('.').reduce((acc, o) => acc * 256 + Number(o), 0)
}

/** Wider than a /8 (more than 16.7 million addresses): no restriction worth the name. */
const WIDE = 2 ** 24

/**
 * Whether a start-end range lets (nearly) the whole internet in: wider than a /8, the single
 * address 0.0.0.0 (Azure reads it as "every Azure service, of any customer"), or a range the Hub
 * cannot parse (judged on what is SENT: unknown = everyone).
 */
export function coversEveryone(start: unknown, end: unknown): boolean {
  const a = ipv4ToNumber(start)
  const b = ipv4ToNumber(end)
  if (a === null || b === null) return true
  if (a === 0 && b === 0) return true
  return b - a + 1 > WIDE
}

/** True when the pair is a usable range (both IPv4, start not after end). */
export function validRange(start: unknown, end: unknown): boolean {
  const a = ipv4ToNumber(start)
  const b = ipv4ToNumber(end)
  return a !== null && b !== null && a <= b
}
