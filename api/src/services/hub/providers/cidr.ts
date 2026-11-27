import { isIP } from 'node:net'

/**
 * CIDR parsing shared by adapters that must judge "does this allow-list let everyone in" (Cloudflare
 * Access IP rules, LiveKit SIP trunk allowed addresses). Numeric (BigInt) ranges, never a regex on
 * the text, so leading zeros, mapped IPv6 and unions of wide ranges cannot slip past.
 */

export interface Range {
  v: 4 | 6
  start: bigint
  end: bigint
  prefix: number
}

/** An IPv6 address as a 128-bit number (null when it is not one). */
export function v6ToBig(addr: string): bigint | null {
  if (isIP(addr) !== 6) return null
  let a = addr.toLowerCase()
  const zone = a.indexOf('%')
  if (zone >= 0) a = a.slice(0, zone)
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  if (dotted) {
    const o = dotted[1].split('.').map(Number)
    a = `${a.slice(0, -dotted[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
  }
  const [head, tail] = a.split('::')
  const h = head ? head.split(':') : []
  const t = tail === undefined ? [] : tail ? tail.split(':') : []
  if (tail === undefined && h.length !== 8) return null
  const parts = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  if (parts.length !== 8) return null
  let n = 0n
  for (const part of parts) n = (n << 16n) | BigInt(Number.parseInt(part || '0', 16))
  return n
}

/**
 * An address or CIDR as a numeric range; null when it does not parse (callers treat that as
 * unknown = everyone). A mask with a leading zero ("/08") does not parse.
 */
export function parseRange(text: string): Range | null {
  const [addr, len, extra] = text.trim().split('/')
  if (extra !== undefined || !addr) return null
  const fam = isIP(addr)
  if (fam === 0) return null
  const bits = fam === 4 ? 32 : 128
  let prefix = bits
  if (len !== undefined) {
    if (!/^(0|[1-9]\d{0,2})$/.test(len)) return null
    prefix = Number(len)
    if (prefix > bits) return null
  }
  const n =
    fam === 4
      ? addr.split('.').reduce((acc, o) => (acc << 8n) | BigInt(Number(o)), 0n)
      : v6ToBig(addr)
  if (n === null) return null
  const host = BigInt(bits - prefix)
  const start = (n >> host) << host
  return { v: fam as 4 | 6, start, end: start | ((1n << host) - 1n), prefix }
}

/** True when the ranges together cover every address of a family. */
export function coversFamily(ranges: Range[], v: 4 | 6): boolean {
  const top = (1n << (v === 4 ? 32n : 128n)) - 1n
  const sorted = ranges.filter((r) => r.v === v).sort((a, b) => (a.start < b.start ? -1 : 1))
  let next = 0n
  for (const r of sorted) {
    if (r.start > next) return false
    if (r.end + 1n > next) next = r.end + 1n
    if (next > top) return true
  }
  return next > top
}

/** An IP rule so wide it is no restriction: IPv4 shorter than /8, IPv6 shorter than /16, or unparseable. */
export function ipTooWide(value: unknown): boolean {
  const r = parseRange(String(value ?? ''))
  if (!r) return true
  return r.v === 4 ? r.prefix < 8 : r.prefix < 16
}

/** ::ffff:0:0/96, the IPv4-mapped IPv6 block. */
// IPv6 blocks that carry IPv4 addresses: IPv4-mapped ::ffff:0:0/96 and NAT64 64:ff9b::/96. Any
// range that overlaps either counts as everyone (security review: a /95 or a range straddling the
// block also reaches IPv4 hosts).
const V4_IN_V6: Array<[bigint, bigint]> = [
  [0xffff_0000_0000n, 0xffff_ffff_ffffn],
  [0x0064_ff9b_0000_0000_0000_0000_0000_0000n, 0x0064_ff9b_0000_0000_0000_0000_ffff_ffffn]
]
const isMapped = (r: Range) =>
  r.v === 6 && V4_IN_V6.some(([lo, hi]) => r.start <= hi && r.end >= lo)

/**
 * Does this allow-list amount to "everyone"? True for any entry that does not parse, any IPv4
 * prefix shorter than /8, any IPv6 prefix shorter than /16, any IPv4-mapped IPv6 entry, and for a
 * set whose union covers a whole address family (two /1 ranges). An empty list is not judged here
 * (what empty means differs per provider).
 */
export function coversEveryone(cidrs: string[]): boolean {
  const ranges: Range[] = []
  for (const c of cidrs) {
    const r = parseRange(String(c ?? ''))
    if (!r) return true
    if ((r.v === 4 ? r.prefix < 8 : r.prefix < 16) || isMapped(r)) return true
    ranges.push(r)
  }
  return coversFamily(ranges, 4) || coversFamily(ranges, 6)
}
