// Task 11a (Hub providers): DNS mode `route53` for Docker drivers and creation targets — new app
// names get a Route 53 record the Hub makes (through the change engine), instead of a wildcard
// name that already points at the edge (`automatic`) or a ticket someone works (`manual`).
//
// A `route53` config names the hosted zone as a managed `aws.route53_zone` resource
// (`dns_zone_resource_id`, a shared resource a Hub admin adopted), the domain every name ends with
// (`wildcard_domain`, the zone's own name or under it) and what each record points at (the edge
// target / edge address: an address → an A / AAAA record, a name → a CNAME). For naming it is the
// same as `automatic` (`<app>[--<env>].<wildcard_domain>`); the creation's providers step makes
// the record before the name step waits for it to resolve.
//
// Task 33: DNS mode `cloudflare` is the same with a managed `cloudflare.zone` (shared, adopted by
// a Hub admin) and `cloudflare.dns_record` records (not proxied; TTL automatic).
import { db } from '../../../db/index.js'
import { MANAGED_DNS, type ManagedDnsMode } from './dns.js'

export {
  type HubDnsMode,
  isManagedDnsMode,
  MANAGED_DNS,
  type ManagedDnsMode,
  namesAutomatically,
  recordOp,
  route53ConfigProblem,
  zoneResourceIdOf
} from './dns.js'

export type ZoneLook =
  | { ok: true; zoneResourceId: number; connectionId: number; zoneName: string }
  | { ok: false; message: string }

const bare = (s: string) => s.trim().toLowerCase().replace(/\.$/, '')

/**
 * The hosted zone a route53 config names: a live, shared `aws.route53_zone` the Hub manages, whose
 * name is the wildcard domain or a parent of it.
 */
export async function route53Zone(
  zoneResourceId: number,
  wildcard: string | null,
  mode: ManagedDnsMode = 'route53'
): Promise<ZoneLook> {
  const want = MANAGED_DNS[mode]
  const what = mode === 'route53' ? 'hosted zone' : 'Cloudflare zone'
  let r: Record<string, unknown> | undefined
  try {
    r = (await db('nivaro_hub_resources')
      .where({ id: zoneResourceId })
      .whereNull('deleted_at')
      .first('id', 'type', 'scope', 'name', 'connection_id', 'observed')) as
      | Record<string, unknown>
      | undefined
  } catch {
    return { ok: false, message: `The Hub could not read the ${what} — try again.` }
  }
  if (!r || String(r.type) !== want.zone || String(r.scope) !== 'shared')
    return { ok: false, message: `The ${what} is not a ${want.label} zone the Hub manages.` }
  let observedName: unknown = null
  try {
    const o = typeof r.observed === 'string' ? JSON.parse(r.observed) : r.observed
    observedName = o?.fields?.name ?? o?.name ?? null
  } catch {
    observedName = null
  }
  const zoneName = bare(String(observedName ?? r.name ?? ''))
  if (!zoneName) return { ok: false, message: `The ${what} has no name the Hub has read yet.` }
  const w = wildcard ? bare(wildcard) : ''
  if (!w || (w !== zoneName && !w.endsWith(`.${zoneName}`)))
    return {
      ok: false,
      message: `Names under ${w || '(no wildcard domain)'} are not in the ${what} ${zoneName}.`
    }
  return {
    ok: true,
    zoneResourceId: Number(r.id),
    connectionId: Number(r.connection_id),
    zoneName
  }
}
