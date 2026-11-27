import { typedName } from '../plan-words.js'
import type {
  DesiredResource,
  FieldChange,
  ListPage,
  Observed,
  OpResult,
  PlannedOp,
  ResourceTypeSpec,
  RiskFlag
} from '../types.js'
import { ProviderError } from '../types.js'
import {
  accountIdOf,
  cfCall,
  checkId,
  joinId,
  nextCursor,
  type RawZone,
  readZone,
  requireZone,
  splitId
} from './client.js'
import {
  FULL_CAPS,
  ok,
  type PlanCfg,
  planGeneric,
  preconditionsOf,
  same,
  str,
  type TypeImpl
} from './common.js'
import { includedEstimate } from './pricing.js'
import { ZONE } from './zone.js'

/**
 * `cloudflare.dns_record`: one DNS record of a zone of the pinned account. External id
 * `<zoneId>:<recordId>`. Task 38 (ACME DNS-01) uses `createDnsRecord` / `deleteDnsRecord` here for
 * its `_acme-challenge` TXT records; Task 43 reuses the zone helpers in client.ts.
 *
 * Marker: DNS records have no tags on every plan, so the Hub writes its resource id at the end of
 * the record's comment (`nivaro-hub:resource=41`). A create that finds a matching record with no
 * marker (or another resource's) refuses ALREADY_EXISTS; one with its own marker is a resumed run.
 */

export const DNS_RECORD = 'cloudflare.dns_record'
export const PROXIABLE = ['A', 'AAAA', 'CNAME']
const TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS']
const MARKER_RE = / ?nivaro-hub:resource=(\d+)$/
const TRAFFIC_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS']

export const dnsRecordSpec: ResourceTypeSpec = {
  key: DNS_RECORD,
  label: 'DNS record',
  scope: 'app',
  nameField: 'name',
  fields: [
    {
      key: 'zone',
      label: 'Zone',
      kind: 'ref',
      refType: ZONE,
      required: true,
      replaceOnChange: true
    },
    {
      key: 'type',
      label: 'Type',
      kind: 'enum',
      required: true,
      options: TYPES.map((t) => ({ value: t, label: t }))
    },
    {
      key: 'name',
      label: 'Name',
      kind: 'string',
      required: true,
      help: 'The host name: "api", "api.example.com" or "@" for the zone itself.'
    },
    {
      key: 'content',
      label: 'Content',
      kind: 'string',
      required: true,
      help: 'The address, target host or text.'
    },
    {
      key: 'ttl',
      label: 'TTL (seconds)',
      kind: 'number',
      default: 1,
      min: 1,
      max: 86400,
      help: '1 = automatic. A proxied record is always automatic.'
    },
    {
      key: 'proxied',
      label: 'Proxied through Cloudflare',
      kind: 'boolean',
      default: false,
      help: 'Only A, AAAA and CNAME records can be proxied. Turning it off exposes the origin address.'
    },
    {
      key: 'priority',
      label: 'Priority',
      kind: 'number',
      min: 0,
      max: 65535,
      help: 'MX records only.'
    },
    { key: 'comment', label: 'Comment', kind: 'string', pattern: '^.{0,70}$' },
    { key: 'zone_name', label: 'Zone name', kind: 'string', readOnly: true }
  ],
  capabilities: { ...FULL_CAPS },
  reversible: true,
  refs: [{ field: 'zone', type: ZONE, required: true }],
  risk(op: PlannedOp, desired: DesiredResource | null): RiskFlag[] {
    if (op.kind === 'noop') return []
    const flags = new Set<RiskFlag>()
    if (op.kind === 'delete') flags.add('destructive')
    if (op.kind === 'replace') {
      flags.add('destructive')
      flags.add('downtime')
    }
    const type = String(desired?.fields.type ?? op.preconditions.type ?? '')
    if (op.kind === 'update') {
      const moved = op.changes.some((c) =>
        ['content', 'name', 'type', 'priority'].includes(c.field)
      )
      if (moved && TRAFFIC_TYPES.includes(type)) flags.add('downtime')
      // Un-proxying a record shows the origin's real address to everyone.
      const p = op.changes.find((c) => c.field === 'proxied')
      if (p && p.from === true && p.to === false) flags.add('public_exposure')
    }
    return [...flags]
  },
  estimate: includedEstimate('DNS records are included in every Cloudflare plan.')
}

// ── Records ──

export interface RawDnsRecord {
  id: string
  type: string
  name: string
  content: string
  ttl?: number
  proxied?: boolean
  priority?: number
  comment?: string | null
  zone_id?: string
  zone_name?: string
}

/** What `createDnsRecord` needs (also what Task 38 passes for a TXT challenge). */
export interface DnsRecordInput {
  type: string
  /** Relative, absolute or "@". */
  name: string
  content: string
  ttl?: number
  proxied?: boolean
  priority?: number
  comment?: string
}

/** Lower-case FQDN of `name` inside `zoneName` ("@" and relative names resolved). */
export function fqdn(name: string, zoneName: string | null): string {
  const n = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
  const z = (zoneName ?? '').toLowerCase()
  if (!z) return n
  if (n === '@' || n === '') return z
  if (n === z || n.endsWith(`.${z}`)) return n
  return `${n}.${z}`
}

/** TXT content comes back wrapped in quotes: compare without the one outer pair. */
export function unquoted(content: unknown): string {
  const s = String(content ?? '')
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
}

function markerOf(comment: unknown): { text: string | null; resource: string | null } {
  const s = typeof comment === 'string' ? comment : ''
  const m = MARKER_RE.exec(s)
  if (!m) return { text: s || null, resource: null }
  return { text: s.slice(0, m.index) || null, resource: m[1] }
}

function withMarker(comment: string | null | undefined, resourceId: number | null): string {
  const text = (comment ?? '').trim()
  if (resourceId == null) return text
  return `${text ? `${text} ` : ''}nivaro-hub:resource=${resourceId}`
}

export function observedDnsRecord(raw: RawDnsRecord, zone: { id: string; name: string }): Observed {
  const { text, resource } = markerOf(raw.comment)
  const type = String(raw.type)
  return {
    type: DNS_RECORD,
    externalId: joinId(zone.id, raw.id),
    name: raw.name,
    fields: {
      zone: zone.id,
      zone_name: zone.name,
      type,
      name: String(raw.name).toLowerCase(),
      content: type === 'TXT' ? unquoted(raw.content) : String(raw.content ?? ''),
      ttl: typeof raw.ttl === 'number' ? raw.ttl : 1,
      proxied: raw.proxied === true,
      priority: typeof raw.priority === 'number' ? raw.priority : null,
      comment: text
    },
    tags: resource ? { 'nivaro-hub:resource': resource } : {},
    url: `https://dash.cloudflare.com/${encodeURIComponent(zone.name)}/dns`
  }
}

/** The records of a zone with the given type + name (FQDN), as raw rows. */
export async function findDnsRecords(
  ctx: Parameters<typeof cfCall>[0],
  zoneId: string,
  filter: { type?: string; name?: string }
): Promise<RawDnsRecord[]> {
  const res = await cfCall<RawDnsRecord[]>(
    ctx,
    'GET',
    `/zones/${checkId(zoneId, 'zone id')}/dns_records`,
    { query: { type: filter.type, name: filter.name, per_page: 100 } }
  )
  return Array.isArray(res.result) ? res.result : []
}

function bodyOf(
  input: DnsRecordInput,
  zoneName: string,
  resourceId: number | null
): Record<string, unknown> {
  const type = input.type.toUpperCase()
  const proxied = PROXIABLE.includes(type) && input.proxied === true
  const body: Record<string, unknown> = {
    type,
    name: fqdn(input.name, zoneName),
    content: input.content,
    ttl: proxied ? 1 : (input.ttl ?? 1),
    comment: withMarker(input.comment, resourceId)
  }
  if (PROXIABLE.includes(type)) body.proxied = proxied
  if (type === 'MX') body.priority = input.priority ?? 10
  return body
}

/**
 * Creates a record in a zone of the pinned account (the zone is checked first). Reusable: ACME's
 * DNS-01 step calls it for a TXT. Never replaces: a same type + name + content record already
 * there is returned as-is when it carries `resourceId`'s own marker, else ALREADY_EXISTS.
 */
export async function createDnsRecord(
  ctx: Parameters<typeof cfCall>[0],
  zoneId: string,
  input: DnsRecordInput,
  resourceId: number | null = null
): Promise<{ record: RawDnsRecord; zone: RawZone; created: boolean }> {
  const zone = await requireZone(ctx, zoneId)
  const body = bodyOf(input, zone.name, resourceId)
  const name = String(body.name)
  const type = String(body.type)
  const sameName = await findDnsRecords(ctx, zone.id, { type, name })
  const hit = sameName.find(
    (r) => type === 'CNAME' || unquoted(r.content) === unquoted(input.content)
  )
  if (hit) {
    const owner = markerOf(hit.comment).resource
    if (resourceId != null && owner === String(resourceId))
      return { record: hit, zone, created: false }
    throw new ProviderError(
      'ALREADY_EXISTS',
      `A ${type} record for ${name} already exists in ${zone.name} and was not created by the Hub. Adopt it instead of creating it.`,
      { status: 409 }
    )
  }
  const res = await cfCall<RawDnsRecord>(ctx, 'POST', `/zones/${checkId(zone.id)}/dns_records`, {
    body
  })
  return { record: res.result, zone, created: true }
}

/** Deletes one record (404 = already gone). The zone is checked against the pinned account. */
export async function deleteDnsRecord(
  ctx: Parameters<typeof cfCall>[0],
  zoneId: string,
  recordId: string
): Promise<void> {
  const zone = await requireZone(ctx, zoneId)
  await cfCall(
    ctx,
    'DELETE',
    `/zones/${checkId(zone.id)}/dns_records/${checkId(recordId, 'record id')}`,
    {
      allow: [404]
    }
  )
}

async function getRecord(
  ctx: Parameters<typeof cfCall>[0],
  zone: { id: string; name: string },
  recordId: string
): Promise<Observed | null> {
  const res = await cfCall<RawDnsRecord>(
    ctx,
    'GET',
    `/zones/${checkId(zone.id)}/dns_records/${checkId(recordId, 'record id')}`,
    { allow: [404] }
  )
  return res.status === 404 || !res.result ? null : observedDnsRecord(res.result, zone)
}

const cfg: PlanCfg = {
  spec: dnsRecordSpec,
  writable: ['type', 'name', 'content', 'ttl', 'proxied', 'priority', 'comment'],
  replaceOn: ['zone'],
  nameOf: (f, o) => String(f.name ?? o?.name ?? ''),
  createHint:
    'a record with the same type, name and content that the Hub did not create is refused: adopt it instead'
}

/** Desired values in the form the provider reports them (FQDN, quotes, effective TTL). */
function effective(fields: Record<string, unknown>, zoneName: string | null) {
  const type = String(fields.type ?? '').toUpperCase()
  const proxied = PROXIABLE.includes(type) ? fields.proxied === true : false
  return {
    type,
    name: fields.name === undefined ? undefined : fqdn(String(fields.name), zoneName),
    content:
      fields.content === undefined
        ? undefined
        : type === 'TXT'
          ? unquoted(fields.content)
          : String(fields.content),
    proxied,
    ttl: proxied ? 1 : fields.ttl === undefined ? 1 : Number(fields.ttl),
    priority: type === 'MX' ? Number(fields.priority ?? 10) : null,
    comment: fields.comment === undefined ? undefined : String(fields.comment)
  }
}

function planDns(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired || !observed) return planGeneric(cfg, desired, observed)
  // Compare the wanted record the way the provider reports it, not as typed.
  const want = effective(desired.fields, String(observed.fields.zone_name ?? '') || null)
  const adjusted: DesiredResource = {
    ...desired,
    fields: {
      ...desired.fields,
      ...Object.fromEntries(Object.entries(want).filter(([, v]) => v !== undefined))
    }
  }
  const ops = planGeneric(cfg, adjusted, observed)
  // The proxied flag only means something on A, AAAA and CNAME.
  return ops.map((op) => {
    if (op.kind !== 'update') return op
    const changes = op.changes.filter(
      (c) => !(c.field === 'priority' && String(want.type) !== 'MX')
    )
    if (!changes.length)
      return {
        ...op,
        kind: 'noop',
        changes: [],
        preconditions: {},
        reason: `${typedName(dnsRecordSpec.label, String(observed.name ?? ''))} is up to date.`
      }
    return {
      ...op,
      changes: changes as FieldChange[],
      preconditions: { ...preconditionsOf(changes, observed), type: observed.fields.type }
    }
  })
}

export const dnsImpl: TypeImpl = {
  spec: dnsRecordSpec,
  permissions: [
    {
      need: 'read DNS records',
      group: 'DNS Write',
      async probe(ctx) {
        const zones = await cfCall<RawZone[]>(ctx, 'GET', '/zones', {
          query: { 'account.id': accountIdOf(ctx), per_page: 1 }
        })
        const z = Array.isArray(zones.result) ? zones.result[0] : null
        if (!z) return null
        await cfCall(ctx, 'GET', `/zones/${checkId(z.id)}/dns_records`, { query: { per_page: 1 } })
        return true
      }
    }
  ],

  async observe(ctx, externalId) {
    const ids = splitId(externalId)
    if (!ids) return null
    checkId(ids[1], 'record id')
    const zone = await readZone(ctx, ids[0])
    if (!zone) return null
    return getRecord(ctx, zone, ids[1])
  },

  async list(ctx, cursor): Promise<ListPage> {
    const [zp, zi, rp] = String(cursor ?? '1:0:1')
      .split(':')
      .map((n) => Math.max(0, Number.parseInt(n, 10) || 0))
    const zonePage = zp || 1
    const zoneIdx = zi
    const recPage = rp || 1
    const zones = await cfCall<RawZone[]>(ctx, 'GET', '/zones', {
      query: { 'account.id': accountIdOf(ctx), page: zonePage, per_page: 50 }
    })
    const list = (Array.isArray(zones.result) ? zones.result : []).filter(
      (z) => z.account?.id === accountIdOf(ctx)
    )
    const zone = list[zoneIdx]
    if (!zone) return { items: [], cursor: null }
    const res = await cfCall<RawDnsRecord[]>(ctx, 'GET', `/zones/${checkId(zone.id)}/dns_records`, {
      query: { page: recPage, per_page: 100 }
    })
    const items = (Array.isArray(res.result) ? res.result : []).map((r) =>
      observedDnsRecord(r, zone)
    )
    const moreRecords = nextCursor(res.info, recPage)
    let next: string | null = null
    if (moreRecords) next = `${zonePage}:${zoneIdx}:${recPage + 1}`
    else if (zoneIdx + 1 < list.length) next = `${zonePage}:${zoneIdx + 1}:1`
    else if (nextCursor(zones.info, zonePage)) next = `${zonePage + 1}:0:1`
    return { items, cursor: next }
  },

  async findExisting(ctx, desired) {
    if (desired.externalId) return null
    const zoneId = desired.refs.zone
    if (typeof zoneId !== 'string') return null
    const zone = await readZone(ctx, zoneId)
    if (!zone) return null
    const want = effective(desired.fields, zone.name)
    if (!want.name || !want.type) return null
    const rows = await findDnsRecords(ctx, zone.id, { type: want.type, name: want.name })
    const hit = rows.find((r) => want.type === 'CNAME' || unquoted(r.content) === want.content)
    return hit ? observedDnsRecord(hit, zone) : null
  },

  plan: (_ctx, desired, observed) => planDns(desired, observed),

  async apply(ctx, op, desired): Promise<OpResult> {
    const zoneRef = desired?.refs.zone
    const ids = op.externalId ? splitId(op.externalId) : null
    const zoneId = ids?.[0] ?? (typeof zoneRef === 'string' ? zoneRef : null)
    if (op.kind === 'noop') {
      const observed = op.externalId ? await dnsImpl.observe(ctx, op.externalId) : null
      return ok(observed, op.externalId, 200)
    }
    if (!zoneId)
      throw new ProviderError('REF_UNRESOLVED', 'The zone this record belongs to is not known yet.')
    if (op.kind === 'delete') {
      if (!ids) throw new ProviderError('BAD_ID', 'The record to delete is not known.')
      await deleteDnsRecord(ctx, ids[0], ids[1])
      return ok(null, op.externalId, 204)
    }
    if (!desired) throw new ProviderError('INVALID', 'The wanted record is missing.')
    // The Hub's own recorded resource (a resumed run) or a change: bring it to the wanted values.
    const update = async (externalId: string): Promise<OpResult> => {
      const parts = splitId(externalId)
      if (!parts) throw new ProviderError('BAD_ID', 'The record to change is not known.')
      const zone = await requireZone(ctx, parts[0])
      const current = await getRecord(ctx, zone, parts[1])
      if (!current) {
        // Gone at the provider: a resumed create makes it again.
        return create()
      }
      const want = effective(desired.fields, zone.name)
      const body: Record<string, unknown> = {}
      for (const k of ['type', 'name', 'content', 'ttl', 'proxied', 'priority'] as const) {
        const w = want[k]
        if (w === undefined || (k === 'priority' && want.type !== 'MX')) continue
        if (k === 'proxied' && !PROXIABLE.includes(want.type)) continue
        if (!same(w, current.fields[k])) body[k] = w
      }
      if (want.comment !== undefined && !same(want.comment, current.fields.comment))
        body.comment = withMarker(want.comment, desired.resourceId)
      else if (current.tags['nivaro-hub:resource'] == null && desired.resourceId != null)
        body.comment = withMarker(String(current.fields.comment ?? ''), desired.resourceId)
      if (!Object.keys(body).length) return ok(current, externalId, 200)
      if (body.proxied === true) body.ttl = 1
      const res = await cfCall<RawDnsRecord>(
        ctx,
        'PATCH',
        `/zones/${checkId(zone.id)}/dns_records/${checkId(parts[1], 'record id')}`,
        { body }
      )
      return ok(observedDnsRecord(res.result, zone), externalId, res.status)
    }
    const create = async (): Promise<OpResult> => {
      const { record, zone } = await createDnsRecord(
        ctx,
        zoneId,
        {
          type: String(desired.fields.type ?? ''),
          name: String(desired.fields.name ?? ''),
          content: String(desired.fields.content ?? ''),
          ttl: desired.fields.ttl === undefined ? undefined : Number(desired.fields.ttl),
          proxied: desired.fields.proxied === true,
          priority:
            desired.fields.priority === undefined ? undefined : Number(desired.fields.priority),
          comment: str(desired.fields.comment) ?? undefined
        },
        desired.resourceId
      )
      return ok(observedDnsRecord(record, zone), joinId(zone.id, record.id), 200)
    }
    switch (op.kind) {
      case 'create':
        if (desired.externalId) return update(desired.externalId)
        return create()
      case 'update':
        if (!op.externalId) throw new ProviderError('INVALID', 'An update needs a record.')
        return update(op.externalId)
      case 'replace': {
        if (op.externalId) {
          const parts = splitId(op.externalId)
          if (parts) await deleteDnsRecord(ctx, parts[0], parts[1])
        }
        return create()
      }
      default:
        throw new ProviderError('INVALID', `Unknown operation ${String(op.kind)}.`)
    }
  }
}
