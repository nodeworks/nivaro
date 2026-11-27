import { createHash } from 'node:crypto'
import { fieldWords, typedName } from '../plan-words.js'
import { freeEstimate } from '../pricing/index.js'
import {
  type DesiredResource,
  type FieldChange,
  type ListPage,
  type Observed,
  type OpResult,
  type PlannedOp,
  type ProviderContext,
  ProviderError,
  type ResourceTypeSpec,
  type RiskFlag
} from '../types.js'
import { xmlAttr, xmlChild, xmlList } from '../xml.js'
import { domainName, ncCall, splitDomain, truthy } from './client.js'
import { DOMAIN } from './domain.js'

/**
 * `namecheap.dns_record` (app): one host record of a domain that uses Namecheap's own DNS.
 *
 * Namecheap has no per-record API: `domains.dns.setHosts` REPLACES the whole list. So every write
 * reads the list, changes the one record and writes the list back (the domain's mail setting,
 * `EmailType`, is sent back as it was). Records carry no id that survives a write and no comment,
 * so a record is known by host + type + value: its provider id is
 * `<domain>:<host>:<type>:<sha256(value)[:12]>` (a new value = a new id, answered by the update).
 * A record the Hub did not make that already has the same host, type and value is ALREADY_EXISTS.
 *
 * Types A, AAAA, CNAME, TXT and CAA. MX records are not offered: they need the domain's mail
 * setting switched to custom MX, which would stop Namecheap's mail forwarding.
 */

export const DNS_RECORD = 'namecheap.dns_record'
const LABEL = 'Namecheap DNS record'
const TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'CAA'] as const
const HOST_RE =
  /^(@|\*|(\*\.)?[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*)$/

const invalid = (msg: string) => new ProviderError('INVALID_FIELDS', msg)

export interface HostRecord {
  host: string
  type: string
  address: string
  ttl: number
  mxPref: number | null
}

const hash12 = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 12)

export function recordId(domain: string, r: Pick<HostRecord, 'host' | 'type' | 'address'>): string {
  return `${domain}:${r.host}:${r.type}:${hash12(r.address)}`
}

export function parseRecordId(id: string): {
  domain: string
  host: string
  type: string
  hash: string
} {
  const parts = String(id ?? '').split(':')
  if (parts.length !== 4 || !/^[0-9a-f]{12}$/.test(parts[3]))
    throw new ProviderError('BAD_EXTERNAL_ID', 'The provider id has the wrong shape.')
  return { domain: domainName(parts[0]), host: parts[1], type: parts[2], hash: parts[3] }
}

function checkRecord(fields: Record<string, unknown>): Omit<HostRecord, 'mxPref'> {
  const host =
    String(fields.host ?? '@')
      .trim()
      .toLowerCase() || '@'
  if (!HOST_RE.test(host))
    throw invalid(`${host} is not a host name (use @ for the domain itself).`)
  const type = String(fields.type ?? '').toUpperCase()
  if (!(TYPES as readonly string[]).includes(type))
    throw invalid(`The record type must be one of ${TYPES.join(', ')}.`)
  const address = String(fields.address ?? '').trim()
  if (!address || address.length > 2048 || /[\r\n]/.test(address))
    throw invalid('Enter the record value (one line, up to 2048 characters).')
  const ttl = Number(fields.ttl ?? 1800)
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 60000)
    throw invalid('The TTL is 60 to 60000 seconds.')
  return { host, type, address, ttl }
}

export const dnsRecordSpec: ResourceTypeSpec = {
  key: DNS_RECORD,
  label: LABEL,
  scope: 'app',
  fields: [
    {
      key: 'domain',
      label: 'Domain',
      kind: 'ref',
      refType: DOMAIN,
      required: true,
      replaceOnChange: true
    },
    {
      key: 'host',
      label: 'Host',
      kind: 'string',
      default: '@',
      replaceOnChange: true,
      help: '@ for the domain itself, or a name such as www or *.app.'
    },
    {
      key: 'type',
      label: 'Type',
      kind: 'enum',
      required: true,
      replaceOnChange: true,
      options: TYPES.map((t) => ({ value: t, label: t }))
    },
    { key: 'address', label: 'Value', kind: 'string', required: true },
    { key: 'ttl', label: 'TTL (seconds)', kind: 'number', default: 1800, min: 60, max: 60000 }
  ],
  capabilities: {
    create: true,
    update: true,
    delete: true,
    adopt: true,
    snapshot: false,
    tag: false
  },
  reversible: (field) => field === 'address' || field === 'ttl',
  refs: [{ field: 'domain', type: DOMAIN }],
  nameField: 'host',
  estimate: async () => freeEstimate('Namecheap DNS is included with the domain.'),
  risk(op) {
    const out = new Set<RiskFlag>()
    if (op.kind === 'delete') out.add('destructive')
    if (op.kind === 'replace') {
      out.add('destructive')
      out.add('downtime')
    }
    if (op.kind === 'update' && op.changes.some((c) => c.field === 'address')) {
      const type = String((op.data as Record<string, unknown> | undefined)?.type ?? '')
      if (type !== 'TXT' && type !== 'CAA') out.add('downtime')
    }
    return [...out]
  }
}

// ── Reads / writes of the whole host list ──

interface HostList {
  emailType: string
  records: HostRecord[]
}

export async function readHosts(ctx: ProviderContext, domain: string): Promise<HostList> {
  const { sld, tld } = splitDomain(domain)
  const r = await ncCall(ctx, 'namecheap.domains.dns.getHosts', { SLD: sld, TLD: tld })
  const res = xmlChild(r.response, 'DomainDNSGetHostsResult')
  if (!truthy(xmlAttr(res, 'IsUsingOurDNS')))
    throw new ProviderError(
      'NOT_NAMECHEAP_DNS',
      `${domain} does not use Namecheap's DNS: its records live with its own nameservers.`
    )
  const records = [...xmlList(res, 'host'), ...xmlList(res, 'Host')].map((h) => ({
    host: xmlAttr(h, 'Name').toLowerCase() || '@',
    type: xmlAttr(h, 'Type').toUpperCase(),
    address: xmlAttr(h, 'Address'),
    ttl: Number(xmlAttr(h, 'TTL')) || 1800,
    mxPref: xmlAttr(h, 'MXPref') ? Number(xmlAttr(h, 'MXPref')) : null
  }))
  return { emailType: xmlAttr(res, 'EmailType'), records }
}

async function writeHosts(ctx: ProviderContext, domain: string, list: HostList): Promise<void> {
  const { sld, tld } = splitDomain(domain)
  const params: Record<string, string | number> = { SLD: sld, TLD: tld }
  list.records.forEach((r, i) => {
    const n = i + 1
    params[`HostName${n}`] = r.host
    params[`RecordType${n}`] = r.type
    params[`Address${n}`] = r.address
    params[`TTL${n}`] = r.ttl
    if (r.mxPref != null) params[`MXPref${n}`] = r.mxPref
  })
  if (list.emailType) params.EmailType = list.emailType
  await ncCall(ctx, 'namecheap.domains.dns.setHosts', params)
}

function observedOf(domain: string, r: HostRecord): Observed {
  return {
    type: DNS_RECORD,
    externalId: recordId(domain, r),
    name: r.host === '@' ? domain : `${r.host}.${domain}`,
    fields: { domain, host: r.host, type: r.type, address: r.address, ttl: r.ttl },
    tags: {},
    status: 'active',
    url: null
  }
}

const matches = (want: { host: string; type: string; hash: string }) => (r: HostRecord) =>
  r.host === want.host && r.type === want.type && hash12(r.address) === want.hash

export async function readRecord(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const want = parseRecordId(id)
  let list: HostList
  try {
    list = await readHosts(ctx, want.domain)
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'NOT_FOUND') return null
    throw err
  }
  const r = list.records.find(matches(want))
  return r ? observedOf(want.domain, r) : null
}

export async function listRecords(ctx: ProviderContext, domains: string[]): Promise<ListPage> {
  const items: Observed[] = []
  for (const d of domains.slice(0, 20)) {
    try {
      const list = await readHosts(ctx, d)
      for (const r of list.records)
        if ((TYPES as readonly string[]).includes(r.type)) items.push(observedOf(d, r))
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'NOT_NAMECHEAP_DNS') continue
      throw err
    }
  }
  return { items, cursor: null }
}

// ── Plan ──

function base(
  kind: PlannedOp['kind'],
  desired: DesiredResource | null,
  externalId: string | null,
  reason: string,
  extra: Partial<PlannedOp> = {}
): PlannedOp {
  return {
    kind,
    type: DNS_RECORD,
    resourceId: desired?.resourceId ?? null,
    externalId,
    reason,
    changes: [],
    preconditions: {},
    risk: [],
    ...extra
  }
}

export function planRecord(
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      base('delete', null, observed.externalId, `Delete ${typedName(LABEL, observed.name)}.`, {
        preconditions: { address: observed.fields.address ?? null },
        data: { type: observed.fields.type }
      })
    ]
  }
  const want = checkRecord(desired.fields)
  const domain = typeof desired.refs.domain === 'string' ? desired.refs.domain : null
  const shown = domain ? (want.host === '@' ? domain : `${want.host}.${domain}`) : want.host
  if (!observed)
    return [
      base('create', desired, null, `Create ${typedName(LABEL, `${shown} ${want.type}`)}.`, {
        changes: [
          { field: 'domain', to: domain },
          { field: 'host', to: want.host },
          { field: 'type', to: want.type },
          { field: 'address', to: want.address },
          { field: 'ttl', to: want.ttl }
        ],
        data: { type: want.type }
      })
    ]
  const replace: Array<'domain' | 'host' | 'type'> = (['host', 'type'] as const).filter(
    (k) => want[k] !== observed.fields[k]
  )
  if (domain && domain !== observed.fields.domain) replace.unshift('domain')
  if (replace.length)
    return [
      base(
        'replace',
        desired,
        observed.externalId,
        `Replace ${typedName(LABEL, observed.name)}: ${fieldWords(dnsRecordSpec.fields, replace)} cannot change in place.`,
        {
          changes: replace.map((k) => ({
            field: k,
            from: observed.fields[k],
            to: k === 'domain' ? domain : want[k]
          })),
          preconditions: { address: observed.fields.address ?? null },
          data: { type: want.type }
        }
      )
    ]
  const changes: FieldChange[] = []
  if (want.address !== observed.fields.address)
    changes.push({ field: 'address', from: observed.fields.address, to: want.address })
  if (want.ttl !== Number(observed.fields.ttl))
    changes.push({ field: 'ttl', from: observed.fields.ttl, to: want.ttl })
  if (!changes.length)
    return [
      base(
        'noop',
        desired,
        observed.externalId,
        `${typedName(LABEL, observed.name)} is up to date.`
      )
    ]
  return [
    base(
      'update',
      desired,
      observed.externalId,
      `Change ${fieldWords(dnsRecordSpec.fields, changes)} on ${typedName(LABEL, observed.name)}.`,
      {
        changes,
        preconditions: Object.fromEntries(
          changes.map((c) => [c.field, observed.fields[c.field] ?? null])
        ),
        data: { type: want.type }
      }
    )
  ]
}

// ── Apply ──

const ok = (observed: Observed | null, externalId: string | null): OpResult => ({
  ok: true,
  externalId,
  observed,
  answer: { status: 200 }
})

export async function applyRecord(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'noop')
    return ok(op.externalId ? await readRecord(ctx, op.externalId) : null, op.externalId)
  if (op.kind === 'delete') {
    const want = parseRecordId(String(op.externalId))
    const list = await readHosts(ctx, want.domain)
    const kept = list.records.filter((r) => !matches(want)(r))
    if (kept.length !== list.records.length)
      await writeHosts(ctx, want.domain, { ...list, records: kept })
    return ok(null, op.externalId)
  }
  if (!desired) throw invalid('Nothing to apply.')
  const domain = domainName(desired.refs.domain)
  const want = checkRecord(desired.fields)
  const list = await readHosts(ctx, domain)
  const newId = recordId(domain, want)
  const same = list.records.find(matches(parseRecordId(newId)))
  if (op.kind === 'create') {
    if (same) {
      // A resumed run whose write already landed is recognised by its recorded id only.
      if (desired.externalId === newId) return ok(observedOf(domain, same), newId)
      throw new ProviderError(
        'ALREADY_EXISTS',
        `${want.host === '@' ? domain : `${want.host}.${domain}`} already has this ${want.type} record: adopt it instead.`
      )
    }
    const records = [...list.records, { ...want, mxPref: null }]
    await writeHosts(ctx, domain, { ...list, records })
    return ok(observedOf(domain, { ...want, mxPref: null }), newId)
  }
  // update / replace: the record this resource is, changed in the list.
  const old = parseRecordId(String(op.externalId))
  if (desired.externalId && desired.externalId !== op.externalId)
    throw new ProviderError('TARGET_MISMATCH', 'The planned record is not this resource’s.')
  if (old.domain !== domain && op.kind !== 'replace')
    throw new ProviderError('TARGET_MISMATCH', 'The planned record is on another domain.')
  const mine = list.records.findIndex(matches(old))
  if (op.kind === 'replace' && old.domain !== domain) {
    // Another domain: drop it there, add it here.
    const oldList = await readHosts(ctx, old.domain)
    const kept = oldList.records.filter((r) => !matches(old)(r))
    if (kept.length !== oldList.records.length)
      await writeHosts(ctx, old.domain, { ...oldList, records: kept })
    if (!same)
      await writeHosts(ctx, domain, {
        ...list,
        records: [...list.records, { ...want, mxPref: null }]
      })
    return ok(observedOf(domain, { ...want, mxPref: null }), newId)
  }
  if (mine === -1 && same) return ok(observedOf(domain, same), newId)
  if (mine === -1) throw new ProviderError('NOT_FOUND', 'The record is no longer at Namecheap.')
  if (same && list.records.indexOf(same) !== mine)
    throw new ProviderError(
      'ALREADY_EXISTS',
      'Another record already has that host, type and value.'
    )
  const records = list.records.map((r, i) => (i === mine ? { ...want, mxPref: null } : r))
  await writeHosts(ctx, domain, { ...list, records })
  return ok(observedOf(domain, { ...want, mxPref: null }), newId)
}
