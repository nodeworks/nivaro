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

export type HubDnsMode = 'automatic' | 'manual' | 'route53'

/** Names are made from the wildcard domain (no ticket): automatic and route53. */
export function namesAutomatically(mode: unknown): boolean {
  return mode === 'automatic' || mode === 'route53'
}

/** The config value of `dns_zone_resource_id`: a positive whole number, null, or undefined = bad. */
export function zoneResourceIdOf(v: unknown): number | null | undefined {
  if (v === undefined || v === null || v === '') return null
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined
}

/** The sync part of a route53 config check (shape only); null = fine. */
export function route53ConfigProblem(c: {
  dns_mode: unknown
  dns_zone_resource_id?: unknown
  wildcard_domain: string | null
  edge: string | null
}): string | null {
  if (c.dns_mode !== 'route53') return null
  if (zoneResourceIdOf(c.dns_zone_resource_id) == null)
    return 'Route 53 names need dns_zone_resource_id (the hosted zone the Hub manages).'
  if (!c.wildcard_domain)
    return 'Route 53 names need wildcard_domain (the domain every name ends with, in the zone).'
  if (!c.edge) return 'Route 53 names need the edge address each record points at.'
  return null
}

const bareName = (s: string) => s.trim().toLowerCase().replace(/\.$/, '')

/** The create op of one environment's record: an address → A / AAAA, a name → CNAME. */
export function recordOp(zoneResourceId: number, hostname: string, edge: string): PlanRequestOp {
  const target = edge.trim().replace(/^\[|]$/g, '')
  const ip = isIP(target)
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
