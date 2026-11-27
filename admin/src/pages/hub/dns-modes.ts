/**
 * How a Docker driver or a creation target makes the names of new apps (api create/dns.ts
 * `DNS_MODES`): a wildcard name that already points at the edge, a ticket per name, or a record
 * the Hub makes in a zone it manages (Route 53 since Task 11, Cloudflare since Task 33). The
 * managed modes differ only in the zone's resource type and their words, so the driver form and
 * both target forms read them from this one table: a new provider is one entry here.
 */

export type ManagedDnsMode = 'route53' | 'cloudflare'
export type DnsMode = 'automatic' | 'manual' | ManagedDnsMode

export interface ManagedDnsInfo {
  /** The shared resource type the zone is (a Hub admin adopts it under Shared infra). */
  zoneType: string
  /** The provider, as people say it. */
  label: string
  /** What its zone is called there. */
  zoneWord: string
}

export const MANAGED_DNS: Record<ManagedDnsMode, ManagedDnsInfo> = {
  route53: { zoneType: 'aws.route53_zone', label: 'Route 53', zoneWord: 'hosted zone' },
  cloudflare: { zoneType: 'cloudflare.zone', label: 'Cloudflare', zoneWord: 'zone' }
}

export const DNS_MODES: readonly DnsMode[] = ['automatic', 'route53', 'cloudflare', 'manual']

export const isManagedDns = (mode: unknown): mode is ManagedDnsMode =>
  typeof mode === 'string' && Object.keys(MANAGED_DNS).includes(mode)

/** A stored mode, or `fallback` when the config holds none the screen knows. */
export function dnsModeOf(raw: unknown, fallback: DnsMode = 'automatic'): DnsMode {
  return raw === 'automatic' || raw === 'manual' || isManagedDns(raw) ? raw : fallback
}

/** The mode picker's choices; `automatic` / `manual` words differ between the two forms. */
export function dnsModeOptions(words: { automatic: string; manual: string }) {
  return DNS_MODES.map((m) => ({
    value: m,
    label:
      m === 'automatic'
        ? words.automatic
        : m === 'manual'
          ? words.manual
          : `${MANAGED_DNS[m].label} (the Hub adds each name)`
  }))
}

/** One line under the picker for a managed mode. */
export const managedDnsHint = (mode: ManagedDnsMode) =>
  `Each new name gets a record in a ${MANAGED_DNS[mode].label} ${MANAGED_DNS[mode].zoneWord} the Hub manages, pointing at the edge.`

/** The zone field's label, hint and empty-pick error. */
export function zoneFieldWords(mode: ManagedDnsMode) {
  const m = MANAGED_DNS[mode]
  const word = mode === 'route53' ? 'Hosted zone' : `${m.label} zone`
  return {
    label: word,
    hint: `A shared ${m.label} ${m.zoneWord} the Hub manages; it must cover the wildcard domain.`,
    placeholder: `Pick a ${m.zoneWord}`,
    missing: `Pick the ${m.label} ${m.zoneWord} the names go in`
  }
}

/**
 * The draft after the mode picker changed: a zone picked for one provider never carries over to
 * another (it is a different resource type).
 */
export function withDnsMode<D extends { dns_mode: DnsMode; dns_zone_resource_id?: number | null }>(
  d: D,
  mode: DnsMode
): Partial<D> {
  const keep = mode === d.dns_mode
  return { dns_mode: mode, ...(keep ? {} : { dns_zone_resource_id: null }) } as Partial<D>
}

/** The zone part of a config body: only a managed mode sends it. */
export const zoneBody = (d: { dns_mode: DnsMode; dns_zone_resource_id?: number | null }) =>
  isManagedDns(d.dns_mode) ? { dns_zone_resource_id: d.dns_zone_resource_id ?? null } : {}
