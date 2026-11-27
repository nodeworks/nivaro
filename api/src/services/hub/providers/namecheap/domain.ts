import { fieldWords, typedName } from '../plan-words.js'
import { registrarHealth } from '../registrar.js'
import { renewDaysOf } from '../renewal-window.js'
import {
  type DesiredResource,
  type FieldChange,
  type FieldSpec,
  type HealthAnswer,
  type ListPage,
  type Observed,
  type OpResult,
  type PlannedOp,
  type ProviderContext,
  ProviderError,
  type ResourceTypeSpec,
  type RiskFlag
} from '../types.js'
import { type XmlValue, xmlAttr, xmlChild, xmlList, xmlText } from '../xml.js'
import { domainName, ncCall, ncDate, splitDomain, truthy } from './client.js'
import { domainEstimate } from './pricing.js'

/**
 * `namecheap.domain` (shared): a domain registration in the connection's Namecheap account. A
 * registration costs money and cannot be taken back, so:
 *
 *  - Registering is a `cost` change (the registration price now, the renewal price each year,
 *    `estimate`), a Hub ADMINISTRATOR's (`$adminOnly`) with its own typed confirm ("register
 *    example.com"). It checks availability first and never registers a name that is taken or
 *    premium-priced. It only ever happens on an explicit create: reading, adopting and listing
 *    never register (and the tests answer from recorded fixtures, on the sandbox host).
 *  - `renew` is a one-shot trigger: one more year, now (cost, admin, typed confirm "renew …").
 *  - Transfer lock: turning it OFF is `destructive` (the domain can then be transferred away).
 *    There is no transfer-out operation: no EPP / auth code is ever read or shown.
 *  - Nameservers: changing them is `downtime` (names stop resolving until the new servers answer).
 *    An empty list means Namecheap's own DNS (`namecheap.dns_record` works only then).
 *  - Auto-renew AT NAMECHEAP is read only: its API has no command to change it (set it in the
 *    Namecheap dashboard). Instead the Hub can renew by itself (`hub_auto_renew`, Hub-side, off by
 *    default; `renew_days_before` 7–60, default 30): the domain watch plans the `renew` trigger
 *    through a change with origin `renewal` (hooks/domain-renewal.ts), a cost the Hub admin
 *    approves unless the auto-approve limit covers it.
 *  - The Hub never deletes a registration (stop managing it instead).
 *  - Health carries `expiresAt`, `autoRenew`, `locked` (registrar: true) for the domain watch.
 */

export const DOMAIN = 'namecheap.domain'
const LABEL = 'Namecheap domain'
const PHONE_RE = /^\+\d{1,3}\.\d{4,15}$/
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[^\s@<>"]{2,63}$/
const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

const invalid = (msg: string) => new ProviderError('INVALID_FIELDS', msg)
const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

const CONTACT_FIELDS: FieldSpec[] = [
  { key: 'first_name', label: 'First name', kind: 'string', required: true },
  { key: 'last_name', label: 'Last name', kind: 'string', required: true },
  { key: 'organization_name', label: 'Organization', kind: 'string' },
  { key: 'email', label: 'Email', kind: 'string', required: true },
  {
    key: 'phone',
    label: 'Phone',
    kind: 'string',
    required: true,
    help: 'Written +1.5551234567 (country code, a dot, the number).'
  },
  { key: 'address_line_1', label: 'Address', kind: 'string', required: true },
  { key: 'address_line_2', label: 'Address line 2', kind: 'string' },
  { key: 'city', label: 'City', kind: 'string', required: true },
  { key: 'state', label: 'State or province', kind: 'string', required: true },
  { key: 'zip_code', label: 'Postal code', kind: 'string', required: true },
  {
    key: 'country_code',
    label: 'Country',
    kind: 'string',
    required: true,
    help: 'Two letters, e.g. US.'
  }
]

/** The Registrant/Tech/Admin/AuxBilling parameters of one contact (checked first). */
export function contactParams(raw: unknown): Record<string, string> {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  for (const f of CONTACT_FIELDS)
    if (f.required && !s(c[f.key]))
      throw invalid(`The registration contact needs ${f.label.toLowerCase()}.`)
  if (!EMAIL_RE.test(s(c.email))) throw invalid('The contact email is not an email address.')
  if (!PHONE_RE.test(s(c.phone)))
    throw invalid('The contact phone is written +1.5551234567 (country code, a dot, the number).')
  if (!/^[A-Z]{2}$/.test(s(c.country_code)))
    throw invalid('The contact country is a two-letter code such as US.')
  for (const f of CONTACT_FIELDS)
    if (s(c[f.key]).length > 255 || /[\r\n]/.test(s(c[f.key])))
      throw invalid(`The contact ${f.label.toLowerCase()} is too long or has a line break.`)
  const one: Record<string, string> = {
    FirstName: s(c.first_name),
    LastName: s(c.last_name),
    Address1: s(c.address_line_1),
    City: s(c.city),
    StateProvince: s(c.state),
    PostalCode: s(c.zip_code),
    Country: s(c.country_code),
    Phone: s(c.phone),
    EmailAddress: s(c.email)
  }
  if (s(c.address_line_2)) one.Address2 = s(c.address_line_2)
  if (s(c.organization_name)) one.OrganizationName = s(c.organization_name)
  const out: Record<string, string> = {}
  for (const who of ['Registrant', 'Tech', 'Admin', 'AuxBilling'])
    for (const [k, v] of Object.entries(one)) out[`${who}${k}`] = v
  return out
}

export function nameserversOf(v: unknown): string[] {
  const list = Array.isArray(v)
    ? v.map((x) => s(x).toLowerCase().replace(/\.$/, '')).filter(Boolean)
    : []
  if (!list.length) return []
  if (list.length < 2 || list.length > 12) throw invalid('A domain has 2 to 12 nameservers.')
  for (const n of list) if (!HOST_RE.test(n)) throw invalid(`${n} is not a nameserver host name.`)
  return [...new Set(list)].sort()
}

const yearsOf = (v: unknown): number => {
  const n = Number(v ?? 1)
  if (!Number.isInteger(n) || n < 1 || n > 10) throw invalid('Register for 1 to 10 years.')
  return n
}

export const domainSpec: ResourceTypeSpec = {
  key: DOMAIN,
  label: LABEL,
  scope: 'shared',
  registrar: true,
  // A registration is charged now and again every year: the owner-approval gate applies.
  costClass: () => 'yearly',
  estimate: domainEstimate,
  fields: [
    {
      key: 'name',
      label: 'Domain name',
      kind: 'string',
      required: true,
      createOnly: true,
      pattern: '^[a-z0-9.-]{4,253}$',
      help: 'For example example.com, without a trailing dot.'
    },
    {
      key: 'years',
      label: 'Years to register',
      kind: 'number',
      createOnly: true,
      default: 1,
      min: 1,
      max: 10,
      help: 'Only used when registering. Registration is charged once, now.'
    },
    {
      key: 'transfer_lock',
      label: 'Transfer lock',
      kind: 'boolean',
      default: true,
      help: 'On keeps the domain from being transferred to another registrar. Turning it off is a destructive change.'
    },
    {
      key: 'nameservers',
      label: 'Nameservers',
      kind: 'list',
      items: { key: 'ns', label: 'Nameserver', kind: 'string' },
      help: 'Empty = Namecheap’s own DNS. 2 to 12 host names otherwise. Changing them stops names resolving until the new servers answer.'
    },
    {
      key: 'whois_privacy',
      label: 'Hide contact details (WHOIS privacy)',
      kind: 'boolean',
      createOnly: true,
      default: true
    },
    {
      key: 'contact',
      label: 'Registration contact',
      kind: 'object',
      createOnly: true,
      fields: CONTACT_FIELDS,
      help: 'Used for the registrant, technical, admin and billing contact when registering. Afterwards it is not shown.'
    },
    {
      key: 'renew',
      label: 'Renew one year now',
      kind: 'boolean',
      trigger: true,
      help: 'Charges one more year now. A Hub administrator confirms it by typing “renew <domain>”.'
    },
    {
      key: 'hub_auto_renew',
      label: 'Renewed by the Hub',
      kind: 'boolean',
      default: false,
      help: 'The Hub renews this domain for one year when it is inside the window below. The renewal costs money: it waits for a Hub administrator unless it is under the auto-approve limit.'
    },
    {
      key: 'renew_days_before',
      label: 'Hub renews this many days before it ends',
      kind: 'number',
      default: 30,
      min: 7,
      max: 60,
      help: 'Only used when “Renewed by the Hub” is on. 7 to 60 days.'
    },
    {
      key: 'auto_renew',
      label: 'Auto-renew at Namecheap (read only)',
      kind: 'boolean',
      readOnly: true,
      help: 'Namecheap’s API cannot change this: set it in the Namecheap dashboard, or let the Hub renew it.'
    },
    { key: 'expires_at', label: 'Expires', kind: 'string', readOnly: true },
    { key: 'created_at', label: 'Registered', kind: 'string', readOnly: true },
    { key: 'whois_guard', label: 'WHOIS privacy', kind: 'string', readOnly: true },
    { key: 'premium', label: 'Premium name', kind: 'boolean', readOnly: true }
  ],
  capabilities: {
    create: true,
    update: true,
    delete: false,
    adopt: true,
    snapshot: false,
    tag: false
  },
  reversible: (field) => field === 'transfer_lock' || field === 'nameservers',
  refs: [],
  nameField: 'name',
  risk(op) {
    const out = new Set<RiskFlag>()
    if (op.kind === 'create' || op.kind === 'replace' || op.action === 'renew') out.add('cost')
    for (const ch of op.changes) {
      if (ch.field === 'nameservers') out.add('downtime')
      if (ch.field === 'transfer_lock' && ch.to === false) out.add('destructive')
    }
    return [...out]
  }
}

// ── Reads ──

/** One `<Domain …/>` of domains.getList as an observation (nameservers filled separately). */
function fromListEntry(d: XmlValue): Observed | null {
  const name = xmlAttr(d, 'Name').toLowerCase()
  if (!name) return null
  const ours = truthy(xmlAttr(d, 'IsOurDNS'))
  const expired = truthy(xmlAttr(d, 'IsExpired'))
  return {
    type: DOMAIN,
    externalId: name,
    name,
    fields: {
      name,
      auto_renew: truthy(xmlAttr(d, 'AutoRenew')),
      transfer_lock: truthy(xmlAttr(d, 'IsLocked')),
      expires_at: ncDate(xmlAttr(d, 'Expires')),
      created_at: ncDate(xmlAttr(d, 'Created')),
      whois_guard: xmlAttr(d, 'WhoisGuard').toLowerCase() || null,
      premium: truthy(xmlAttr(d, 'IsPremium')),
      ...(ours ? { nameservers: [] } : {})
    },
    tags: {},
    status: expired ? 'expired' : 'registered',
    url: `https://ap.www.namecheap.com/domains/domaincontrolpanel/${name}/domain`
  }
}

async function nameserversNow(ctx: ProviderContext, name: string): Promise<string[]> {
  const { sld, tld } = splitDomain(name)
  const r = await ncCall(ctx, 'namecheap.domains.dns.getList', { SLD: sld, TLD: tld })
  const res = xmlChild(r.response, 'DomainDNSGetListResult')
  if (truthy(xmlAttr(res, 'IsUsingOurDNS'))) return []
  return xmlList(res, 'Nameserver')
    .map((n) => xmlText(n).trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean)
    .sort()
}

/** The domain as this account holds it, or null (not in this account). */
export async function readDomain(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const name = domainName(id)
  const r = await ncCall(ctx, 'namecheap.domains.getList', {
    ListType: 'ALL',
    SearchTerm: name,
    PageSize: 20,
    Page: 1
  })
  const hit = xmlList(xmlChild(r.response, 'DomainGetListResult'), 'Domain').find(
    (d) => xmlAttr(d, 'Name').toLowerCase() === name
  )
  const o = hit ? fromListEntry(hit) : null
  if (!o) return null
  if (!Array.isArray(o.fields.nameservers)) o.fields.nameservers = await nameserversNow(ctx, name)
  return o
}

export async function listDomains(ctx: ProviderContext, cursor?: string | null): Promise<ListPage> {
  const page = Math.max(1, Number.parseInt(cursor ?? '1', 10) || 1)
  const r = await ncCall(ctx, 'namecheap.domains.getList', {
    ListType: 'ALL',
    PageSize: 100,
    Page: page
  })
  const items = xmlList(xmlChild(r.response, 'DomainGetListResult'), 'Domain')
    .map(fromListEntry)
    .filter((o): o is Observed => !!o)
  const paging = xmlChild(r.response, 'Paging')
  const total = Number(xmlText(xmlChild(paging, 'TotalItems')))
  const size = Number(xmlText(xmlChild(paging, 'PageSize'))) || 100
  const more = Number.isFinite(total) && page * size < total
  return { items, cursor: more ? String(page + 1) : null }
}

// ── Plan ──

const WRITABLE = ['transfer_lock', 'nameservers'] as const

function base(
  kind: PlannedOp['kind'],
  desired: DesiredResource | null,
  externalId: string | null,
  reason: string,
  extra: Partial<PlannedOp> = {}
): PlannedOp {
  return {
    kind,
    type: DOMAIN,
    resourceId: desired?.resourceId ?? null,
    externalId,
    reason,
    changes: [],
    preconditions: {},
    risk: [],
    ...extra
  }
}

const sameList = (a: unknown, b: unknown) =>
  JSON.stringify([...(Array.isArray(a) ? a : [])].map(String).sort()) ===
  JSON.stringify([...(Array.isArray(b) ? b : [])].map(String).sort())

export function planDomain(
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  // A registration is never deleted (capabilities.delete is false: the engine refuses first).
  if (!desired) return []
  const name = domainName(desired.fields.name ?? observed?.externalId)
  if (!observed) {
    const years = yearsOf(desired.fields.years)
    contactParams(desired.fields.contact)
    nameserversOf(desired.fields.nameservers)
    return [
      base(
        'create',
        desired,
        null,
        `Register ${name} at Namecheap for ${years} year${years === 1 ? '' : 's'}. It is charged now and cannot be undone; a Hub administrator confirms by typing “register ${name}”.`,
        {
          changes: [
            { field: 'name', to: name },
            { field: 'years', to: years },
            ...(desired.fields.transfer_lock !== undefined
              ? [{ field: 'transfer_lock', to: desired.fields.transfer_lock !== false }]
              : []),
            ...(nameserversOf(desired.fields.nameservers).length
              ? [{ field: 'nameservers', to: nameserversOf(desired.fields.nameservers) }]
              : [])
          ],
          data: { $adminOnly: true, $confirm: `register ${name}` }
        }
      )
    ]
  }
  const ops: PlannedOp[] = []
  const changes: FieldChange[] = []
  for (const key of WRITABLE) {
    const want = desired.fields[key]
    if (want === undefined) continue
    if (key === 'nameservers') {
      const list = nameserversOf(want)
      if (!sameList(list, observed.fields.nameservers))
        changes.push({ field: key, from: observed.fields.nameservers ?? [], to: list })
      continue
    }
    if ((want !== false) !== (observed.fields[key] === true))
      changes.push({ field: key, from: observed.fields[key], to: want !== false })
  }
  if (changes.length)
    ops.push(
      base(
        'update',
        desired,
        observed.externalId,
        `Change ${fieldWords(domainSpec.fields, changes)} on ${typedName(LABEL, name)}.${
          changes.some((c) => c.field === 'transfer_lock' && c.to === false)
            ? ' With the lock off the domain can be transferred to another registrar.'
            : ''
        }${changes.some((c) => c.field === 'nameservers') ? ' Names may stop resolving until the new servers answer.' : ''}`,
        {
          changes,
          preconditions: Object.fromEntries(
            changes.map((c) => [c.field, observed.fields[c.field] ?? null])
          )
        }
      )
    )
  // The Hub-side renewal settings live in the Hub: echoed into observed so a later plan sees them.
  const hubWant = desired.fields.hub_auto_renew === true
  const hubHave = observed.fields.hub_auto_renew === true
  const hubChanges: FieldChange[] = []
  if (desired.fields.hub_auto_renew !== undefined && hubWant !== hubHave)
    hubChanges.push({ field: 'hub_auto_renew', from: hubHave, to: hubWant })
  if (
    hubWant &&
    desired.fields.renew_days_before !== undefined &&
    renewDaysOf(desired.fields) !== renewDaysOf(observed.fields)
  )
    hubChanges.push({
      field: 'renew_days_before',
      from: renewDaysOf(observed.fields),
      to: renewDaysOf(desired.fields)
    })
  if (hubChanges.length)
    ops.push(
      base(
        'update',
        desired,
        observed.externalId,
        hubWant
          ? `The Hub renews ${name} by itself ${renewDaysOf(desired.fields)} days before it ends (one year at the renewal price; a Hub administrator approves each renewal unless it is under the auto-approve limit). Nothing changes at Namecheap now.`
          : `The Hub stops renewing ${name} by itself. Nothing changes at Namecheap.`,
        { changes: hubChanges, data: { $hubSetting: true } }
      )
    )
  if (desired.fields.renew === true)
    ops.push(
      base(
        'update',
        desired,
        observed.externalId,
        `Renew ${name} at Namecheap for one more year (registered until ${String(observed.fields.expires_at ?? '').slice(0, 10) || 'unknown'}). It is charged now; a Hub administrator confirms by typing “renew ${name}”.`,
        {
          changes: [{ field: 'renew', to: true }],
          action: 'renew',
          preconditions: { expires_at: observed.fields.expires_at ?? null },
          data: { $adminOnly: true, $confirm: `renew ${name}` }
        }
      )
    )
  return ops.length
    ? ops
    : [base('noop', desired, observed.externalId, `${typedName(LABEL, name)} is up to date.`)]
}

// ── Apply ──

const done = (
  observed: Observed | null,
  externalId: string | null,
  desired: DesiredResource | null = null
): OpResult => ({
  ok: true,
  externalId,
  observed: observed && desired ? withHubEcho(observed, desired) : observed,
  answer: { status: 200 }
})

/** The Hub-side renewal settings mirrored into observed, so a later plan can tell they are unchanged. */
function withHubEcho(o: Observed, desired: DesiredResource): Observed {
  return {
    ...o,
    fields: {
      ...o.fields,
      hub_auto_renew: desired.fields.hub_auto_renew === true,
      renew_days_before: renewDaysOf(desired.fields)
    }
  }
}

export async function applyDomain(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'noop') {
    const seen = op.externalId ? await readDomain(ctx, op.externalId) : null
    return done(seen, op.externalId, desired)
  }
  if (op.kind === 'delete' || op.kind === 'replace')
    throw new ProviderError(
      'NOT_DELETABLE',
      'The Hub never deletes a domain registration. Stop managing it instead.'
    )
  if (!desired) throw invalid('Nothing to apply.')
  if (op.kind === 'create') {
    const name = domainName(desired.fields.name)
    const years = yearsOf(desired.fields.years)
    const contact = contactParams(desired.fields.contact)
    const ns = nameserversOf(desired.fields.nameservers)
    // Read before write: a name already in this account is never registered (or paid) again.
    if (await readDomain(ctx, name))
      throw new ProviderError(
        'ALREADY_EXISTS',
        `${name} is already in this Namecheap account: adopt it instead of registering it.`
      )
    const check = await ncCall(ctx, 'namecheap.domains.check', { DomainList: name })
    const res = xmlList(check.response, 'DomainCheckResult').find(
      (d) => xmlAttr(d, 'Domain').toLowerCase() === name
    )
    if (!res || !truthy(xmlAttr(res, 'Available')))
      throw new ProviderError(
        'DOMAIN_UNAVAILABLE',
        `${name} cannot be registered now (it is taken or reserved).`
      )
    if (truthy(xmlAttr(res, 'IsPremiumName')))
      throw new ProviderError(
        'DOMAIN_PREMIUM',
        `${name} is a premium name with its own price: the Hub does not register premium names.`
      )
    const privacy = desired.fields.whois_privacy !== false
    const made = await ncCall(ctx, 'namecheap.domains.create', {
      DomainName: name,
      Years: years,
      ...contact,
      ...(privacy ? { AddFreeWhoisguard: 'yes', WGEnabled: 'yes' } : {}),
      ...(ns.length ? { Nameservers: ns.join(',') } : {})
    })
    const r = xmlChild(made.response, 'DomainCreateResult')
    if (!truthy(xmlAttr(r, 'Registered')))
      throw new ProviderError('DOMAIN_NOT_REGISTERED', `Namecheap did not register ${name}.`)
    if (desired.fields.transfer_lock === false)
      await ncCall(ctx, 'namecheap.domains.setRegistrarLock', {
        DomainName: name,
        LockAction: 'UNLOCK'
      })
    return {
      ok: true,
      externalId: name,
      observed: await readDomain(ctx, name),
      answer: { status: 200, order: xmlAttr(r, 'OrderID') || null }
    }
  }
  // update (plain or the renew action)
  const name = domainName(op.externalId)
  if (desired.externalId && desired.externalId !== name)
    throw new ProviderError('TARGET_MISMATCH', 'The planned domain is not this resource’s.')
  const seen = await readDomain(ctx, name)
  if (!seen) throw new ProviderError('NOT_FOUND', `${name} is no longer in this Namecheap account.`)
  if (op.action === 'renew') {
    // Read before write: a renewal that already moved the expiry is not charged again.
    if (op.preconditions.expires_at && seen.fields.expires_at !== op.preconditions.expires_at)
      return done(seen, name, desired)
    const r = await ncCall(ctx, 'namecheap.domains.renew', { DomainName: name, Years: 1 })
    const ok = truthy(xmlAttr(xmlChild(r.response, 'DomainRenewResult'), 'Renew'))
    if (!ok) throw new ProviderError('DOMAIN_NOT_RENEWED', `Namecheap did not renew ${name}.`)
    return done(await readDomain(ctx, name), name, desired)
  }
  const changed = new Set(op.changes.map((c) => c.field))
  if (changed.has('transfer_lock')) {
    const want = desired.fields.transfer_lock !== false
    if ((seen.fields.transfer_lock === true) !== want)
      await ncCall(ctx, 'namecheap.domains.setRegistrarLock', {
        DomainName: name,
        LockAction: want ? 'LOCK' : 'UNLOCK'
      })
  }
  if (changed.has('nameservers')) {
    const ns = nameserversOf(desired.fields.nameservers)
    if (!sameList(ns, seen.fields.nameservers)) {
      const { sld, tld } = splitDomain(name)
      if (ns.length)
        await ncCall(ctx, 'namecheap.domains.dns.setCustom', {
          SLD: sld,
          TLD: tld,
          Nameservers: ns.join(',')
        })
      else await ncCall(ctx, 'namecheap.domains.dns.setDefault', { SLD: sld, TLD: tld })
    }
  }
  return done(await readDomain(ctx, name), name, desired)
}

export function domainHealth(ctx: ProviderContext, o: Observed): HealthAnswer {
  const exp =
    typeof o.fields.expires_at === 'string' && o.fields.expires_at ? o.fields.expires_at : null
  return registrarHealth(ctx.now(), {
    expiresAt: exp,
    autoRenew: o.fields.auto_renew === true,
    locked: o.fields.transfer_lock === true
  })
}
