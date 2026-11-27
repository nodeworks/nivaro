import { type Observed, type ProviderContext, ProviderError } from '../types.js'
import { awsRest, orNull, restXml } from './client.js'
import { type AwsListPage, type AwsTypeDef, cap, riskOf } from './kit.js'
import { route53Estimate } from './pricing.js'
import { type XmlValue, xmlChild, xmlList, xmlText } from './xml.js'

/**
 * Route 53 (global, signed in us-east-1): `aws.route53_zone` is shared and read / adopt only
 * (the Hub never creates or deletes a hosted zone); `aws.route53_record` belongs to an app.
 * A record's id is `<zoneId>|<name>|<type>` (name lower-case, no trailing dot). Records have no
 * tags, so a create uses CREATE (never UPSERT): a record that already exists is `ALREADY_EXISTS`
 * (adopt it); only an update of a record the Hub manages uses UPSERT.
 */

const XMLNS = 'https://route53.amazonaws.com/doc/2013-04-01/'
const t = xmlText
const c = xmlChild
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const normName = (n: string) => n.toLowerCase().replace(/\.$/, '').replace(/\\052/g, '*')
const zoneId = (id: string) => id.replace(/^\/hostedzone\//, '')

export interface RecordSet {
  name: string
  type: string
  ttl?: number
  values?: string[]
  alias_dns_name?: string
  alias_zone_id?: string
  alias_evaluate_health?: boolean
}

export function recordXml(r: RecordSet): string {
  const alias = r.alias_dns_name
    ? `<AliasTarget><HostedZoneId>${esc(r.alias_zone_id ?? '')}</HostedZoneId><DNSName>${esc(r.alias_dns_name)}</DNSName><EvaluateTargetHealth>${r.alias_evaluate_health === true}</EvaluateTargetHealth></AliasTarget>`
    : `<TTL>${r.ttl ?? 300}</TTL><ResourceRecords>${(r.values ?? []).map((v) => `<ResourceRecord><Value>${esc(v)}</Value></ResourceRecord>`).join('')}</ResourceRecords>`
  return `<ResourceRecordSet><Name>${esc(r.name)}.</Name><Type>${r.type}</Type>${alias}</ResourceRecordSet>`
}

/** One ChangeResourceRecordSets batch (shared with the ACM validation records). */
export async function changeRecords(
  ctx: ProviderContext,
  zone: string,
  changes: Array<{ action: 'CREATE' | 'UPSERT' | 'DELETE'; record: RecordSet }>
): Promise<void> {
  const body = `<ChangeResourceRecordSetsRequest xmlns="${XMLNS}"><ChangeBatch><Comment>nivaro-hub:managed</Comment><Changes>${changes
    .map((x) => `<Change><Action>${x.action}</Action>${recordXml(x.record)}</Change>`)
    .join('')}</Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`
  await awsRest(ctx, 'route53', 'POST', `/2013-04-01/hostedzone/${zoneId(zone)}/rrset/`, {
    headers: { 'content-type': 'application/xml' },
    body
  })
}

function parseRecord(node: XmlValue): RecordSet {
  const alias = c(node, 'AliasTarget')
  const ttl = t(c(node, 'TTL'))
  return {
    name: normName(t(c(node, 'Name'))),
    type: t(c(node, 'Type')),
    ttl: ttl === '' ? undefined : Number(ttl),
    values: xmlList(c(node, 'ResourceRecords'), 'ResourceRecord').map((x) => t(c(x, 'Value'))),
    alias_dns_name: alias ? normName(t(c(alias, 'DNSName'))) : undefined,
    alias_zone_id: alias ? t(c(alias, 'HostedZoneId')) : undefined,
    alias_evaluate_health: alias ? t(c(alias, 'EvaluateTargetHealth')) === 'true' : undefined
  }
}

function recordObserved(zone: string, r: RecordSet): Observed {
  const fields: Record<string, unknown> = { zone, name: r.name, record_type: r.type }
  if (r.alias_dns_name) {
    fields.alias_dns_name = r.alias_dns_name
    fields.alias_zone_id = r.alias_zone_id
    fields.alias_evaluate_health = r.alias_evaluate_health
  } else {
    fields.ttl = r.ttl
    fields.values = r.values
  }
  return {
    type: 'aws.route53_record',
    externalId: `${zone}|${r.name}|${r.type}`,
    name: r.name,
    fields,
    tags: {},
    status: 'INSYNC'
  }
}

const splitId = (id: string): { zone: string; name: string; type: string } => {
  const [zone, name, type] = id.split('|')
  if (!zone || !name || !type) throw new ProviderError('BAD_ID', `${id} is not a record id.`)
  return { zone, name, type }
}

async function getRecord(ctx: ProviderContext, id: string): Promise<RecordSet | null> {
  const { zone, name, type } = splitId(id)
  const res = await orNull(() =>
    awsRest(ctx, 'route53', 'GET', `/2013-04-01/hostedzone/${zoneId(zone)}/rrset`, {
      query: { name: `${name}.`, type, maxitems: '1' }
    })
  )
  if (!res) return null
  const first = xmlList(restXml(ctx, res).ResourceRecordSets, 'ResourceRecordSet')[0]
  if (!first) return null
  const rec = parseRecord(first)
  return rec.name === name && rec.type === type ? rec : null
}

// ── Zone ──

function zoneObserved(z: XmlValue): Observed | null {
  const id = zoneId(t(c(z, 'Id')))
  if (!id) return null
  const cfg = c(z, 'Config')
  return {
    type: 'aws.route53_zone',
    externalId: id,
    name: normName(t(c(z, 'Name'))),
    fields: {
      name: normName(t(c(z, 'Name'))),
      private: t(c(cfg, 'PrivateZone')) === 'true',
      comment: t(c(cfg, 'Comment')) || undefined,
      record_count: Number(t(c(z, 'ResourceRecordSetCount')) || 0)
    },
    tags: {},
    status: 'available'
  }
}

async function listZones(ctx: ProviderContext, marker?: string | null) {
  const x = restXml(
    ctx,
    await awsRest(ctx, 'route53', 'GET', '/2013-04-01/hostedzone', {
      query: { maxitems: '100', ...(marker ? { marker } : {}) }
    })
  )
  return {
    zones: xmlList(x.HostedZones, 'HostedZone')
      .map(zoneObserved)
      .filter((z): z is Observed => !!z),
    next: t(x.IsTruncated) === 'true' ? t(x.NextMarker) || null : null
  }
}

export const route53ZoneDef: AwsTypeDef = {
  global: true,
  spec: {
    key: 'aws.route53_zone',
    label: 'Route 53 hosted zone',
    scope: 'shared',
    fields: [
      { key: 'name', label: 'Zone name', kind: 'string', readOnly: true },
      { key: 'private', label: 'Private zone', kind: 'boolean', readOnly: true },
      { key: 'comment', label: 'Comment', kind: 'string', readOnly: true },
      { key: 'record_count', label: 'Records', kind: 'number', readOnly: true }
    ],
    estimate: route53Estimate,
    capabilities: cap({ create: false, update: false, delete: false, tag: false }),
    reversible: false,
    refs: [],
    risk: riskOf()
  },
  probe: { need: 'route53:ListHostedZones', run: (ctx) => listZones(ctx) },
  async observe(ctx, id) {
    const res = await orNull(() =>
      awsRest(ctx, 'route53', 'GET', `/2013-04-01/hostedzone/${zoneId(id)}`)
    )
    const z = res && c(restXml(ctx, res), 'HostedZone')
    return z ? zoneObserved(z) : null
  },
  async list(ctx, _region, token): Promise<AwsListPage> {
    const { zones, next } = await listZones(ctx, token)
    return { items: zones, next }
  },
  async create() {
    throw new ProviderError(
      'NOT_SUPPORTED',
      'The Hub adopts hosted zones; it does not create them.'
    )
  },
  async remove() {
    throw new ProviderError('NOT_SUPPORTED', 'The Hub never deletes a hosted zone.')
  }
}

// ── Record ──

const toRecord = (f: Record<string, unknown>): RecordSet => ({
  name: normName(String(f.name)),
  type: String(f.record_type),
  ttl: f.ttl === undefined ? 300 : Number(f.ttl),
  values: Array.isArray(f.values) ? (f.values as string[]) : undefined,
  alias_dns_name: f.alias_dns_name ? normName(String(f.alias_dns_name)) : undefined,
  alias_zone_id: f.alias_zone_id ? String(f.alias_zone_id) : undefined,
  alias_evaluate_health: f.alias_evaluate_health === true || undefined
})

export const route53RecordDef: AwsTypeDef = {
  global: true,
  spec: {
    key: 'aws.route53_record',
    label: 'Route 53 record',
    scope: 'app',
    fields: [
      {
        key: 'zone',
        label: 'Hosted zone',
        kind: 'ref',
        refType: 'aws.route53_zone',
        required: true,
        replaceOnChange: true
      },
      {
        key: 'name',
        label: 'Record name',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        help: 'The full name, e.g. app.example.com'
      },
      {
        key: 'record_type',
        label: 'Type',
        kind: 'enum',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        options: ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV', 'CAA'].map((v) => ({
          value: v,
          label: v
        }))
      },
      { key: 'ttl', label: 'TTL (seconds)', kind: 'number', default: 300, min: 0 },
      {
        key: 'values',
        label: 'Values',
        kind: 'list',
        items: { key: 'value', label: 'Value', kind: 'string' }
      },
      {
        key: 'alias_dns_name',
        label: 'Alias target name',
        kind: 'string',
        help: 'Instead of values: an AWS resource (load balancer DNS name).'
      },
      { key: 'alias_zone_id', label: 'Alias target zone id', kind: 'string' },
      {
        key: 'alias_evaluate_health',
        label: 'Evaluate target health',
        kind: 'boolean'
      }
    ],
    capabilities: cap({ tag: false }),
    reversible: true,
    refs: [{ field: 'zone', type: 'aws.route53_zone' }],
    risk: riskOf()
  },
  probe: {
    need: 'route53:ListResourceRecordSets',
    run: async (ctx) => {
      const { zones } = await listZones(ctx)
      if (zones[0])
        await awsRest(
          ctx,
          'route53',
          'GET',
          `/2013-04-01/hostedzone/${zones[0].externalId}/rrset`,
          { query: { maxitems: '1' } }
        )
    }
  },
  normalize: (f) => ({
    ...f,
    name: typeof f.name === 'string' ? normName(f.name) : f.name,
    alias_dns_name:
      typeof f.alias_dns_name === 'string' ? normName(f.alias_dns_name) : f.alias_dns_name
  }),
  async observe(ctx, id) {
    const rec = await getRecord(ctx, id)
    return rec ? recordObserved(splitId(id).zone, rec) : null
  },
  async list(ctx, _region, token): Promise<AwsListPage> {
    const { zones } = await listZones(ctx)
    const [idxRaw, name, type] = (token ?? '0||').split('|')
    const idx = Number.parseInt(idxRaw, 10) || 0
    const zone = zones[idx]
    if (!zone) return { items: [], next: null }
    const query: Record<string, string> = { maxitems: '100' }
    if (name) query.name = `${name}.`
    if (type) query.type = type
    const x = restXml(
      ctx,
      await awsRest(ctx, 'route53', 'GET', `/2013-04-01/hostedzone/${zone.externalId}/rrset`, {
        query
      })
    )
    const items: Observed[] = []
    for (const n of xmlList(x.ResourceRecordSets, 'ResourceRecordSet')) {
      const r = parseRecord(n)
      // Apex NS and SOA belong to the zone itself.
      if ((r.type === 'NS' || r.type === 'SOA') && r.name === zone.name) continue
      items.push(recordObserved(zone.externalId, r))
    }
    const next =
      t(x.IsTruncated) === 'true'
        ? `${idx}|${normName(t(x.NextRecordName))}|${t(x.NextRecordType)}`
        : idx + 1 < zones.length
          ? `${idx + 1}||`
          : null
    return { items, next }
  },
  async create(ctx, desired) {
    const zone = typeof desired.refs.zone === 'string' ? desired.refs.zone : ''
    if (!zone) throw new ProviderError('REF_UNRESOLVED', 'The hosted zone is not known yet.')
    const rec = toRecord(desired.fields)
    const id = `${zoneId(zone)}|${rec.name}|${rec.type}`
    try {
      await changeRecords(ctx, zone, [{ action: 'CREATE', record: rec }])
    } catch (err) {
      if (
        err instanceof ProviderError &&
        err.code === 'InvalidChangeBatch' &&
        /already exists/i.test(err.message)
      )
        throw new ProviderError(
          'ALREADY_EXISTS',
          `Record ${rec.name} ${rec.type} already exists. Adopt it instead of creating it.`
        )
      throw err
    }
    return id
  },
  async update(ctx, id, _region, desired) {
    const { zone } = splitId(id)
    await changeRecords(ctx, zone, [
      {
        action: 'UPSERT',
        record: toRecord({
          ...desired.fields,
          name: splitId(id).name,
          record_type: splitId(id).type
        })
      }
    ])
  },
  async remove(ctx, id) {
    const { zone } = splitId(id)
    const have = await getRecord(ctx, id)
    if (!have) return
    await changeRecords(ctx, zone, [{ action: 'DELETE', record: have }])
  }
}

export const route53Defs: AwsTypeDef[] = [route53ZoneDef, route53RecordDef]
