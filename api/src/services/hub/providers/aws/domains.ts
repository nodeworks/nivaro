import {
  type FieldSpec,
  type HealthAnswer,
  type Observed,
  type ProviderContext,
  ProviderError
} from '../types.js'
import { awsFixedJson, waitFor } from './client.js'
import { type AwsListPage, type AwsTypeDef, cap, observed, riskOf } from './kit.js'
import { domainEstimate } from './pricing-part4.js'

/**
 * Route 53 Domains (`route53domains`, us-east-1 only, whatever the connection's regions): one
 * type, `aws.domain` (Task 40). A domain is a registration that costs money and cannot be taken
 * back, so:
 *
 *  - Shared scope: only Hub administrators act on it. Registering is a `cost` change with an
 *    estimate (registration price now, renewal each year) and a TYPED CONFIRM ("register
 *    example.com"); it checks availability first and never registers anything that is not
 *    available. It is only ever done on an explicit create: reading, adopting and listing never
 *    register, and the tests answer from recorded fixtures.
 *  - Auto-renew on or off (off = `downtime`: the domain expires and the site goes with it).
 *  - Transfer lock: turning it OFF is `destructive` (it allows the domain to be transferred
 *    away). The Hub has no transfer-out operation: no auth code is ever read or shown.
 *  - Nameservers: changing them is `downtime` (names stop resolving until the new ones answer).
 *  - The Hub never deletes a registration (capabilities.delete = false): stop managing it instead.
 *  - Contacts are given once, at registration (one contact used for admin, registrant and tech,
 *    privacy protection on); afterwards only the registrant email is shown.
 *  - Health carries `expiresAt`, `autoRenew` and `locked` for the domain watch (Task 34,
 *    `domain.expiring` at 45 and 14 days).
 */

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[^\s@<>"]{2,63}$/
const PHONE_RE = /^\+\d{1,3}\.\d{4,15}$/
const CONTACT_TYPES = ['PERSON', 'COMPANY', 'ASSOCIATION', 'PUBLIC_BODY', 'RESELLER']
const LOCK_STATUS = 'clientTransferProhibited'
const WATCH_DAYS = 45

const invalid = (msg: string) => new ProviderError('INVALID_FIELDS', msg)

const r53d = (ctx: ProviderContext, target: string, body: Record<string, unknown>) =>
  awsFixedJson(ctx, 'route53domains', target, body)

function checkName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (!DOMAIN_RE.test(name))
    throw new ProviderError('BAD_ID', 'That is not a domain name (example.com, no trailing dot).')
  return name
}

// ── Contact ──

const CONTACT_FIELDS: FieldSpec[] = [
  { key: 'first_name', label: 'First name', kind: 'string', required: true },
  { key: 'last_name', label: 'Last name', kind: 'string', required: true },
  {
    key: 'contact_type',
    label: 'Contact type',
    kind: 'enum',
    default: 'PERSON',
    options: CONTACT_TYPES.map((v) => ({ value: v, label: v }))
  },
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
  { key: 'state', label: 'State or province', kind: 'string' },
  {
    key: 'country_code',
    label: 'Country',
    kind: 'string',
    required: true,
    help: 'Two letters, e.g. US.'
  },
  { key: 'zip_code', label: 'Postal code', kind: 'string', required: true }
]

const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** The ContactDetail every one of the three contacts gets (checked first). */
function contactDetail(raw: unknown): Record<string, string> {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  for (const f of CONTACT_FIELDS)
    if (f.required && !s(c[f.key]))
      throw invalid(`The registration contact needs ${f.label.toLowerCase()}.`)
  const type = s(c.contact_type) || 'PERSON'
  if (!CONTACT_TYPES.includes(type)) throw invalid('The contact type is not valid.')
  if (type !== 'PERSON' && !s(c.organization_name))
    throw invalid('A contact that is not a person needs an organization name.')
  if (!EMAIL_RE.test(s(c.email))) throw invalid('The contact email is not an email address.')
  if (!PHONE_RE.test(s(c.phone)))
    throw invalid('The contact phone is written +1.5551234567 (country code, a dot, the number).')
  if (!/^[A-Z]{2}$/.test(s(c.country_code)))
    throw invalid('The contact country is a two-letter code such as US.')
  const out: Record<string, string> = {
    FirstName: s(c.first_name),
    LastName: s(c.last_name),
    ContactType: type,
    Email: s(c.email),
    PhoneNumber: s(c.phone),
    AddressLine1: s(c.address_line_1),
    City: s(c.city),
    CountryCode: s(c.country_code),
    ZipCode: s(c.zip_code)
  }
  if (s(c.organization_name)) out.OrganizationName = s(c.organization_name)
  if (s(c.address_line_2)) out.AddressLine2 = s(c.address_line_2)
  if (s(c.state)) out.State = s(c.state)
  return out
}

function nameserversOf(v: unknown): string[] {
  const list = Array.isArray(v)
    ? v.map((x) => s(x).toLowerCase().replace(/\.$/, '')).filter(Boolean)
    : []
  if (!list.length) return []
  if (list.length < 2 || list.length > 6) throw invalid('A domain has 2 to 6 nameservers.')
  for (const n of list) if (!HOST_RE.test(n)) throw invalid(`${n} is not a nameserver host name.`)
  return [...new Set(list)]
}

// ── Reads ──

const iso = (seconds: unknown): string => {
  const n = Number(seconds)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : ''
}

/** An answer that means "this account has no such domain". */
const notRegistered = (err: unknown): boolean =>
  err instanceof ProviderError &&
  (err.code === 'InvalidInput' || err.code === 'NotFound') &&
  /not (found|registered|associated)|does not exist|no such/i.test(err.message)

async function readDomain(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const name = checkName(id)
  let r: Record<string, any>
  try {
    r = await r53d(ctx, 'GetDomainDetail', { DomainName: name })
  } catch (err) {
    if (notRegistered(err)) return null
    throw err
  }
  const status = ((r.StatusList as string[] | undefined) ?? []).map(String)
  const ns = ((r.Nameservers as Array<{ Name?: string }> | undefined) ?? [])
    .map((x) => String(x.Name ?? '').toLowerCase())
    .filter(Boolean)
    .sort()
  return observed(
    'aws.domain',
    name,
    'us-east-1',
    name,
    {
      name,
      auto_renew: r.AutoRenew === true,
      transfer_lock: status.includes(LOCK_STATUS),
      nameservers: ns,
      expires_at: iso(r.ExpirationDate),
      registrar: String(r.RegistrarName ?? ''),
      registrant_email: String(r.RegistrantContact?.Email ?? '')
    },
    {},
    'registered'
  )
}

/** When the domain expires (ISO), from an observed domain, for the domain watch (Task 34). */
export const domainExpiresAt = (o: Observed): string | null =>
  typeof o.fields.expires_at === 'string' && o.fields.expires_at ? o.fields.expires_at : null

async function operationDone(ctx: ProviderContext, opId: string): Promise<boolean | null> {
  const r = await r53d(ctx, 'GetOperationDetail', { OperationId: opId })
  const status = String(r.Status ?? '')
  if (status === 'SUCCESSFUL') return true
  if (status === 'ERROR' || status === 'FAILED')
    throw new ProviderError(
      'DOMAIN_OPERATION_FAILED',
      ctx.scrub(String(r.Message ?? 'The registrar refused the request.')).slice(0, 300)
    )
  return null
}

// ── The type ──

export const domainDef: AwsTypeDef = {
  global: true,
  spec: {
    key: 'aws.domain',
    label: 'Route 53 domain',
    scope: 'shared',
    // Task 34: the domain expiry watch picks registrar types by this flag (health carries
    // expiresAt, autoRenew, locked).
    registrar: true,
    // A registration is charged now and again every year: the owner-approval gate applies.
    costClass: () => 'yearly',
    fields: [
      {
        key: 'name',
        label: 'Domain name',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
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
        key: 'auto_renew',
        label: 'Renew automatically',
        kind: 'boolean',
        default: true,
        help: 'Off lets the domain expire (and everything on it stop working).'
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
        help: 'Only on a registered domain, 2 to 6 host names. Changing them stops names resolving until the new servers answer.'
      },
      {
        key: 'privacy',
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
        help: 'Used for the admin, registrant and technical contact when registering. Afterwards it is not shown.'
      },
      { key: 'expires_at', label: 'Expires', kind: 'string', readOnly: true },
      { key: 'registrar', label: 'Registrar', kind: 'string', readOnly: true },
      { key: 'registrant_email', label: 'Registrant email', kind: 'string', readOnly: true }
    ],
    estimate: domainEstimate,
    capabilities: cap({ delete: false, tag: false }),
    reversible: false,
    refs: [],
    risk: riskOf((op) => {
      const out = new Set<'cost' | 'downtime' | 'destructive'>()
      if (op.kind === 'create') out.add('cost')
      for (const ch of op.changes) {
        if (ch.field === 'nameservers') out.add('downtime')
        if (ch.field === 'auto_renew' && ch.to === false) out.add('downtime')
        if (ch.field === 'transfer_lock' && ch.to === false) out.add('destructive')
      }
      return [...out]
    })
  },
  observe: (ctx, id) => readDomain(ctx, id),
  async list(ctx, _region, token): Promise<AwsListPage> {
    const r = await r53d(ctx, 'ListDomains', { MaxItems: 100, ...(token ? { Marker: token } : {}) })
    const items = ((r.Domains as Array<Record<string, any>> | undefined) ?? [])
      .filter((d) => DOMAIN_RE.test(String(d.DomainName ?? '').toLowerCase()))
      .map((d) => {
        const name = String(d.DomainName).toLowerCase()
        return observed(
          'aws.domain',
          name,
          'us-east-1',
          name,
          {
            name,
            auto_renew: d.AutoRenew === true,
            transfer_lock: d.TransferLock === true,
            expires_at: iso(d.Expiry)
          },
          {},
          'registered'
        )
      })
    return {
      items,
      next: typeof r.NextPageMarker === 'string' && r.NextPageMarker ? r.NextPageMarker : null
    }
  },
  // A domain this account already holds is never "registered" again: adopt it.
  findExisting: (ctx, desired) => readDomain(ctx, String(desired.fields.name ?? '')),
  checkPlan(desired, observedNow) {
    const f = desired.fields
    checkName(f.name)
    const ns = nameserversOf(f.nameservers)
    if (!observedNow) {
      if (ns.length)
        throw invalid('Set nameservers after the domain is registered (Route 53 assigns its own).')
      const years = Number(f.years ?? 1)
      if (!Number.isInteger(years) || years < 1 || years > 10)
        throw invalid('Register for 1 to 10 years.')
      contactDetail(f.contact)
    }
  },
  // Registering is an administrator's call and asks for its own typed confirm; the other changes
  // use the engine's default confirm (the domain name) through their risk flags.
  opData: (_ctx, desired, _seen, kind) =>
    kind === 'create' && desired
      ? {
          $adminOnly: true,
          $confirm: `register ${String(desired.fields.name ?? '').toLowerCase()}`
        }
      : {},
  async create(ctx, desired) {
    const f = desired.fields
    const name = checkName(f.name)
    if (nameserversOf(f.nameservers).length)
      throw invalid('Set nameservers after the domain is registered.')
    const years = Number(f.years ?? 1)
    if (!Number.isInteger(years) || years < 1 || years > 10)
      throw invalid('Register for 1 to 10 years.')
    const contact = contactDetail(f.contact)
    // Never register what is not available (taken, reserved, or not sold by Route 53).
    const avail = await r53d(ctx, 'CheckDomainAvailability', { DomainName: name })
    if (avail.Availability !== 'AVAILABLE')
      throw new ProviderError(
        'DOMAIN_UNAVAILABLE',
        `${name} cannot be registered now (${String(avail.Availability ?? 'unknown')}).`
      )
    const privacy = f.privacy !== false
    const made = await r53d(ctx, 'RegisterDomain', {
      DomainName: name,
      DurationInYears: years,
      AutoRenew: f.auto_renew !== false,
      AdminContact: contact,
      RegistrantContact: contact,
      TechContact: contact,
      PrivacyProtectAdminContact: privacy,
      PrivacyProtectRegistrantContact: privacy,
      PrivacyProtectTechContact: privacy
    })
    const opId = String(made.OperationId ?? '')
    if (opId) {
      // Most registrations finish in minutes: wait a little, never block the step on a slow one.
      await waitFor(ctx, () => operationDone(ctx, opId), { tries: 3, delayMs: 3000 })
    }
    return name
  },
  async update(ctx, id, _region, desired, _have, changed) {
    const f = desired.fields
    const name = checkName(id)
    if (changed.has('auto_renew'))
      await r53d(ctx, f.auto_renew === false ? 'DisableDomainAutoRenew' : 'EnableDomainAutoRenew', {
        DomainName: name
      })
    if (changed.has('transfer_lock'))
      await r53d(
        ctx,
        f.transfer_lock === false ? 'DisableDomainTransferLock' : 'EnableDomainTransferLock',
        { DomainName: name }
      )
    if (changed.has('nameservers')) {
      const ns = nameserversOf(f.nameservers)
      if (!ns.length) throw invalid('Name 2 to 6 nameservers; the Hub does not clear them.')
      await r53d(ctx, 'UpdateDomainNameservers', {
        DomainName: name,
        Nameservers: ns.map((Name) => ({ Name }))
      })
    }
  },
  async remove() {
    throw new ProviderError(
      'NOT_DELETABLE',
      'The Hub never deletes a domain registration. Stop managing it instead.'
    )
  },
  async health(ctx, _id, _region, obs): Promise<Omit<HealthAnswer, 'checkedAt'>> {
    const exp = domainExpiresAt(obs)
    const autoRenew = obs.fields.auto_renew === true
    const locked = obs.fields.transfer_lock === true
    const details: Record<string, string | number | boolean> = {
      expiresAt: exp ?? '',
      autoRenew,
      locked
    }
    if (exp) {
      const days = Math.floor((Date.parse(exp) - ctx.now().getTime()) / 86_400_000)
      details.daysLeft = days
      if (days < 0) return { status: 'down', message: 'The domain has expired.', details }
      if (!autoRenew && days <= WATCH_DAYS)
        return {
          status: 'warn',
          message: `Expires in ${days} days and does not renew automatically.`,
          details
        }
    }
    if (!autoRenew)
      return {
        status: 'warn',
        message: 'Auto-renew is off: the domain expires on its date.',
        details
      }
    if (!locked)
      return {
        status: 'warn',
        message: 'The transfer lock is off: the domain can be transferred to another registrar.',
        details
      }
    return {
      status: 'ok',
      message: exp ? `Registered until ${exp.slice(0, 10)}` : 'Registered',
      details
    }
  }
}

export const domainDefs: AwsTypeDef[] = [domainDef]
