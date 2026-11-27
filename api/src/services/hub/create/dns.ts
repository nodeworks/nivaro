// DNS names for Hub creation targets and the apps they create. Pure functions, shared by
// targets.ts (validating a target) and app-config.ts (making an environment's hostname).
// Task 11a: DNS mode `route53` (dns-route53.ts) — the pure helpers live here.
import { isIP } from 'node:net'
import type { PlanRequestOp } from '../providers/engine/contract.js'

export const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * A DNS suffix (`apps.example.com`, `localhost`), lower-cased; a leading `*.` and trailing `.`
 * dropped. At least two labels, except the single names `localhost` and `test`.
 */
export function dnsSuffix(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
  if (!s || s.length > 253) return null
  const labels = s.split('.')
  if (labels.length < 2 && s !== 'localhost' && s !== 'test') return null
  return labels.every((l) => DNS_LABEL.test(l)) ? s : null
}

/** Names that may be served over plain http: localhost and the reserved .test domain. */
export function httpAllowed(name: string | null): boolean {
  if (!name) return false
  return (
    name === 'localhost' || name.endsWith('.localhost') || name === 'test' || name.endsWith('.test')
  )
}

// ── Task 11a: DNS mode route53 (see dns-route53.ts) ──

// Task 33: DNS mode `cloudflare` works the same way with a managed `cloudflare.zone`.
export type HubDnsMode = 'automatic' | 'manual' | 'route53' | 'cloudflare'

export const DNS_MODES: readonly HubDnsMode[] = ['automatic', 'manual', 'route53', 'cloudflare']

/** The modes where the Hub makes each name's record in a zone it manages. */
export type ManagedDnsMode = 'route53' | 'cloudflare'

export function isManagedDnsMode(mode: unknown): mode is ManagedDnsMode {
  return mode === 'route53' || mode === 'cloudflare'
}

/** The zone resource type and the record type of a managed DNS mode. */
export const MANAGED_DNS: Record<ManagedDnsMode, { zone: string; record: string; label: string }> =
  {
    route53: { zone: 'aws.route53_zone', record: 'aws.route53_record', label: 'Route 53' },
    cloudflare: { zone: 'cloudflare.zone', record: 'cloudflare.dns_record', label: 'Cloudflare' }
  }

/** Names are made from the wildcard domain (no ticket): automatic, route53 and cloudflare. */
export function namesAutomatically(mode: unknown): boolean {
  return mode === 'automatic' || isManagedDnsMode(mode)
}

/** The config value of `dns_zone_resource_id`: a positive whole number, null, or undefined = bad. */
export function zoneResourceIdOf(v: unknown): number | null | undefined {
  if (v === undefined || v === null || v === '') return null
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined
}

/** The sync part of a route53 / cloudflare config check (shape only); null = fine. */
export function route53ConfigProblem(c: {
  dns_mode: unknown
  dns_zone_resource_id?: unknown
  wildcard_domain: string | null
  edge: string | null
}): string | null {
  if (!isManagedDnsMode(c.dns_mode)) return null
  const label = MANAGED_DNS[c.dns_mode].label
  if (zoneResourceIdOf(c.dns_zone_resource_id) == null)
    return `${label} names need dns_zone_resource_id (the ${c.dns_mode === 'route53' ? 'hosted zone' : 'zone'} the Hub manages).`
  if (!c.wildcard_domain)
    return `${label} names need wildcard_domain (the domain every name ends with, in the zone).`
  if (!c.edge) return `${label} names need the edge address each record points at.`
  return null
}

const bareName = (s: string) => s.trim().toLowerCase().replace(/\.$/, '')

/** The create op of one environment's record: an address → A / AAAA, a name → CNAME. */
export function recordOp(
  zoneResourceId: number,
  hostname: string,
  edge: string,
  mode: ManagedDnsMode = 'route53'
): PlanRequestOp {
  const target = edge.trim().replace(/^\[|]$/g, '')
  const ip = isIP(target)
  if (mode === 'cloudflare')
    // Not proxied: the record points at the edge the way a Route 53 one does (the edge serves
    // TLS); ttl 1 = Cloudflare's automatic.
    return {
      action: 'create',
      type: 'cloudflare.dns_record',
      fields: {
        zone: { resourceId: zoneResourceId },
        name: bareName(hostname),
        type: ip === 4 ? 'A' : ip === 6 ? 'AAAA' : 'CNAME',
        content: ip ? target : bareName(target),
        ttl: 1,
        proxied: false
      }
    }
  return {
    action: 'create',
    type: 'aws.route53_record',
    fields: {
      zone: { resourceId: zoneResourceId },
      name: bareName(hostname),
      record_type: ip === 4 ? 'A' : ip === 6 ? 'AAAA' : 'CNAME',
      ttl: 300,
      values: [ip ? target : bareName(target)]
    }
  }
}
