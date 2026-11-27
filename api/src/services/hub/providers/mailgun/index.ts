import { randomBytes } from 'node:crypto'
import { fieldWords, typedName } from '../plan-words.js'
import type { HubResourceRow } from '../store.js'
import {
  type ConnectionTest,
  type DesiredResource,
  type FieldChange,
  type FieldSpec,
  type HealthAnswer,
  type ListPage,
  type Observed,
  type OpResult,
  type OutboundMessage,
  type PlannedOp,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError,
  type ResourceTypeSpec,
  type RiskFlag,
  ROTATE_OUTPUTS_FIELD
} from '../types.js'
import {
  DOMAIN_RE,
  domainSeg,
  eventSeg,
  hostFor,
  keySeg,
  LOGIN_RE,
  loginSeg,
  MAILGUN_REGIONS,
  mailgunCall,
  WEBHOOK_EVENTS
} from './client.js'

/**
 * Mailgun (`mailgun`): one API key (a primary account key to manage; the Hub makes narrower
 * domain-scoped sending keys) and a region (US `api.mailgun.net` / EU `api.eu.mailgun.net`).
 * The key is the account: there is no account id to pin.
 *
 * Types:
 *  - `mailgun.domain` (shared): a sending domain. The DNS records Mailgun wants come out as the
 *    `dns_records` output (never in observed); `verify` is an op. It also SENDS Hub events:
 *    `notify` mails the resource's `recipients` From `<notify_from>@<domain>`, one message each.
 *  - `mailgun.smtp_credential` (app): an SMTP login on a domain. The Hub makes the password; it is
 *    shown nowhere afterwards, so it is a once-only secret output (`smtp_pass`), beside the
 *    constant outputs (`smtp_host`, `smtp_port`, `smtp_user`) that fill the app's SMTP settings.
 *    Rotating resets the password at Mailgun, so the old one stops working at once.
 *  - `mailgun.webhook` (app): one URL for one event on a domain (https only). Event data names
 *    recipients, so changing where it goes needs a Hub administrator.
 *  - `mailgun.sending_key` (app): a key that can only send through one domain; the value is shown
 *    once (output `api_key`, once-only). A lost value is rotated (a NEW key; the old one stays).
 *
 * Nothing here is priced per resource (Mailgun bills the account's plan), so no type has a
 * `costClass` and none needs an estimate.
 */

const T_DOMAIN = 'mailgun.domain'
const T_CRED = 'mailgun.smtp_credential'
const T_HOOK = 'mailgun.webhook'
const T_KEY = 'mailgun.sending_key'

const PAGE = 100
const MAX_PAGES = 20
const MAX_RECIPIENTS = 50
const SMTP_PORT = '587'
const VERIFY_FIELD = 'verify'

// ── Small helpers ──

function norm(v: unknown): unknown {
  return v === '' || v === undefined ? null : v
}

function same(a: unknown, b: unknown): boolean {
  const x = norm(a)
  const y = norm(b)
  if (typeof x === 'string' && typeof y === 'string') return x.toLowerCase() === y.toLowerCase()
  return x === y
}

function diffFields(
  keys: string[],
  want: Record<string, unknown>,
  have: Record<string, unknown>
): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of keys) {
    if (want[k] === undefined) continue
    if (!same(want[k], have[k])) out.push({ field: k, from: norm(have[k]), to: norm(want[k]) })
  }
  return out
}

const ok = (
  externalId: string | null,
  observed: Observed | null,
  answer?: Record<string, unknown>,
  outputs?: Record<string, string>
): OpResult => ({
  ok: true,
  externalId,
  observed,
  ...(answer ? { answer } : {}),
  ...(outputs && Object.keys(outputs).length ? { outputs } : {})
})

function alreadyExists(what: string): ProviderError {
  return new ProviderError(
    'ALREADY_EXISTS',
    `${what} already exists at Mailgun. Adopt it instead of creating it.`,
    { retryable: false }
  )
}

function unknownType(type: unknown): ProviderError {
  return new ProviderError('UNKNOWN_TYPE', `Mailgun has no ${String(type)}.`)
}

function invalid(msg: string): ProviderError {
  return new ProviderError('INVALID_FIELDS', msg)
}

function mismatch(op: PlannedOp, desired: DesiredResource | null): void {
  if (desired?.externalId && op.externalId && desired.externalId !== op.externalId)
    throw new ProviderError(
      'TARGET_MISMATCH',
      'This step is for a different Mailgun resource than the one it was planned for.'
    )
}

function withAdminOnly(op: PlannedOp, note: string): PlannedOp {
  return { ...op, reason: `${op.reason}${note}`, data: { ...(op.data ?? {}), $adminOnly: true } }
}

const EMAIL_RE = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/
const EMAIL_PATTERN = '^[^\\s@,;<>()"]+@[^\\s@,;<>()"]+\\.[^\\s@,;<>()"]+$'

/** The recipient list of a domain resource, checked: emails only, no repeats, at most 50. */
export function recipientsOf(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v == null || v === '' ? [] : [v]
  const out: string[] = []
  for (const x of list) {
    const e = String(x ?? '').trim()
    if (!e) continue
    if (e.length > 254 || !EMAIL_RE.test(e))
      throw invalid(`${e.slice(0, 60)} is not an email address.`)
    if (!out.some((o) => o.toLowerCase() === e.toLowerCase())) out.push(e)
  }
  if (out.length > MAX_RECIPIENTS) throw invalid(`At most ${MAX_RECIPIENTS} recipients.`)
  return out
}

function sameSet(a: string[], b: string[]): boolean {
  const x = [...new Set(a.map((s) => s.toLowerCase()))].sort()
  const y = [...new Set(b.map((s) => s.toLowerCase()))].sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** The provider id a ref field resolved to (string), or null while it is not created yet. */
function refId(desired: DesiredResource, field: string): string | null {
  const v = desired.refs[field]
  return typeof v === 'string' && v ? v : null
}

function httpsProblem(label: string, v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return `${label} is not a web address.`
  }
  if (u.protocol !== 'https:') return `${label} must start with https://.`
  if (u.username || u.password) return `${label} must not carry a user name or password.`
  return null
}

// ═══ Domains ═══

const DOMAIN_LABEL = 'Mailgun domain'
const NOTIFY_NOTE = ' Who gets Hub messages is changing, so a Hub administrator must start it.'

function dnsRecordsOf(raw: any): string | null {
  const rows: Array<{ type: string; name: string; value: string; valid: string }> = []
  for (const r of Array.isArray(raw?.sending_dns_records) ? raw.sending_dns_records : []) {
    const name = String(r?.name ?? '')
    const value = String(r?.value ?? '')
    if (!name || !value) continue
    rows.push({
      type: String(r?.record_type ?? 'TXT').toUpperCase(),
      name,
      value,
      valid: String(r?.valid ?? 'unknown')
    })
  }
  return rows.length ? JSON.stringify(rows) : null
}

const domainOutputs = (raw: any): Record<string, string> => {
  const text = dnsRecordsOf(raw)
  return text ? { dns_records: text } : {}
}

function domainObserved(raw: any): Observed {
  const d = raw?.domain ?? raw
  const name = String(d?.name ?? '')
  const records = Array.isArray(raw?.sending_dns_records) ? raw.sending_dns_records : []
  return {
    type: T_DOMAIN,
    externalId: name,
    name,
    fields: {
      name,
      web_scheme: d?.web_scheme ?? 'https',
      spam_action: d?.spam_action ?? 'disabled',
      wildcard: d?.wildcard === true,
      state: d?.state ?? null,
      verified: d?.state === 'active',
      dns_valid: records.length > 0 && records.every((r: any) => r?.valid === 'valid')
    },
    tags: {},
    version: null,
    status: d?.state ?? null,
    url: `https://app.mailgun.com/mg/sending/domains/${name}`
  }
}

async function readDomainRaw(ctx: ProviderContext, name: string): Promise<any | null> {
  const r = await mailgunCall(ctx, 'GET', `/v4/domains/${domainSeg(name)}`, { allow: [404] })
  if (r.status === 404 || !r.body || typeof r.body !== 'object' || !r.body.domain) return null
  return r.body
}

async function listDomainRows(ctx: ProviderContext, skip: number) {
  const r = await mailgunCall(ctx, 'GET', '/v4/domains', { query: { limit: PAGE, skip } })
  const rows: any[] = Array.isArray(r.body?.items) ? r.body.items : []
  const total = Number(r.body?.total_count ?? 0)
  return {
    rows,
    next: skip + rows.length < total && rows.length ? String(skip + rows.length) : null
  }
}

const DOMAIN_FIELDS: FieldSpec[] = [
  {
    key: 'name',
    label: 'Domain',
    kind: 'string',
    required: true,
    createOnly: true,
    replaceOnChange: true,
    pattern: DOMAIN_RE.source,
    help: 'The sending domain, usually a subdomain such as mg.example.com. Mailgun answers with the DNS records to add.'
  },
  {
    key: 'web_scheme',
    label: 'Tracking links use',
    kind: 'enum',
    default: 'https',
    options: [
      { value: 'https', label: 'https' },
      { value: 'http', label: 'http' }
    ]
  },
  {
    key: 'spam_action',
    label: 'Spam handling',
    kind: 'enum',
    default: 'disabled',
    options: [
      { value: 'disabled', label: 'Off' },
      { value: 'tag', label: 'Tag' },
      { value: 'block', label: 'Block' }
    ]
  },
  { key: 'wildcard', label: 'Accept subdomains', kind: 'boolean', default: false },
  {
    key: 'dkim_key_size',
    label: 'DKIM key size',
    kind: 'enum',
    default: '2048',
    createOnly: true,
    options: [
      { value: '1024', label: '1024' },
      { value: '2048', label: '2048' }
    ]
  },
  {
    key: 'cloudflare_records',
    label: 'Cloudflare DNS records',
    kind: 'list',
    items: { key: 'item', label: 'DNS record', kind: 'ref', refType: 'cloudflare.dns_record' },
    help: 'The records the plan makes beside this one when the zone is at Cloudflare.'
  },
  {
    key: 'route53_records',
    label: 'Route 53 DNS records',
    kind: 'list',
    items: { key: 'item', label: 'DNS record', kind: 'ref', refType: 'aws.route53_record' },
    help: 'The records the plan makes beside this one when the zone is at Route 53.'
  },
  {
    key: 'notify_from',
    label: 'Hub messages come from',
    kind: 'string',
    default: 'nivaro-hub',
    pattern: LOGIN_RE.source,
    help: 'The part before the @ of the address Hub messages are sent From.'
  },
  {
    key: 'recipients',
    label: 'Hub messages go to',
    kind: 'list',
    items: { key: 'item', label: 'Email address', kind: 'string', pattern: EMAIL_PATTERN },
    help: 'When a notify route sends through this domain, each address gets its own copy. Kept in the Hub, not at Mailgun.'
  },
  {
    key: VERIFY_FIELD,
    label: 'Verify DNS now',
    kind: 'boolean',
    trigger: true,
    default: false,
    help: 'Asks Mailgun to check that the DNS records are in place.'
  },
  { key: 'verified', label: 'Verified', kind: 'boolean', readOnly: true },
  { key: 'state', label: 'State', kind: 'string', readOnly: true }
]
const domainWords = (c: Array<{ field: string }>) => fieldWords(DOMAIN_FIELDS, c)
const DOMAIN_WRITABLE = ['web_scheme', 'spam_action', 'wildcard']

function notifyChange(desired: DesiredResource, observed: Observed | null): FieldChange[] {
  const out: FieldChange[] = []
  const want = recipientsOf(desired.fields.recipients)
  const have = observed ? recipientsOf(observed.fields.recipients) : []
  if (!sameSet(want, have)) out.push({ field: 'recipients', from: have, to: want })
  const from = String(norm(desired.fields.notify_from) ?? 'nivaro-hub').toLowerCase()
  const haveFrom = String(norm(observed?.fields.notify_from) ?? 'nivaro-hub').toLowerCase()
  if (from !== haveFrom) out.push({ field: 'notify_from', from: haveFrom, to: from })
  return out
}

function validateDomainFields(f: Record<string, unknown>): void {
  recipientsOf(f.recipients)
  const from = norm(f.notify_from)
  if (from !== null && !LOGIN_RE.test(String(from).toLowerCase()))
    throw invalid('The address Hub messages come from is letters, digits, dots and dashes.')
}

function planDomain(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: T_DOMAIN,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName(DOMAIN_LABEL, observed.name)}. Mail sent through it is refused afterwards, and its SMTP logins, webhooks and sending keys go with it; its DNS records stay where they are.`,
        changes: [],
        preconditions: { name: observed.fields.name },
        risk: []
      }
    ]
  }
  validateDomainFields(desired.fields)
  const notify = notifyChange(desired, observed)
  if (!observed) {
    const name = String(desired.fields.name ?? '')
    const op: PlannedOp = {
      kind: 'create',
      type: T_DOMAIN,
      resourceId: desired.resourceId,
      externalId: null,
      reason: `Create ${typedName(DOMAIN_LABEL, name)}. Mailgun answers with the DNS records to add (the dns_records output); add them, then verify.`,
      changes: ['name', 'web_scheme', 'spam_action', 'wildcard']
        .filter((k) => norm(desired.fields[k]) !== null)
        .map((k) => ({ field: k, to: desired.fields[k] })),
      preconditions: {},
      risk: []
    }
    return [notify.length ? withAdminOnly(op, NOTIFY_NOTE) : op]
  }
  const replace = diffFields(['name'], desired.fields, observed.fields)
  if (replace.length)
    return [
      {
        kind: 'replace',
        type: T_DOMAIN,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(DOMAIN_LABEL, observed.name)}: ${domainWords(replace)} cannot change in place, so it is deleted and made again with new DNS records, and mail is not sent through it until they are added and verified.`,
        changes: replace,
        preconditions: { name: observed.fields.name },
        risk: []
      }
    ]
  const ops: PlannedOp[] = []
  const changes = diffFields(DOMAIN_WRITABLE, desired.fields, observed.fields)
  if (changes.length) {
    const pre: Record<string, unknown> = {}
    for (const c of changes) pre[c.field] = c.from ?? null
    ops.push({
      kind: 'update',
      type: T_DOMAIN,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${domainWords(changes)} on ${typedName(DOMAIN_LABEL, observed.name)}.`,
      changes,
      preconditions: pre,
      risk: []
    })
  }
  if (notify.length)
    ops.push(
      withAdminOnly(
        {
          kind: 'update',
          type: T_DOMAIN,
          resourceId: desired.resourceId,
          externalId: observed.externalId,
          reason: `Change ${domainWords(notify)} on ${typedName(DOMAIN_LABEL, observed.name)}. Kept in the Hub; nothing is written to Mailgun.`,
          changes: notify,
          preconditions: {},
          risk: [],
          action: 'save_notify'
        },
        NOTIFY_NOTE
      )
    )
  if (desired.fields[VERIFY_FIELD] === true && observed.fields.verified !== true)
    ops.push({
      kind: 'update',
      type: T_DOMAIN,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Ask Mailgun to verify ${typedName(DOMAIN_LABEL, observed.name)} against the DNS records. DNS can take a few minutes to show.`,
      changes: [{ field: VERIFY_FIELD, to: true }],
      preconditions: { verified: false },
      risk: [],
      action: 'verify'
    })
  return ops
}

/** The notify settings live in the Hub: they are echoed into observed so a later plan sees them. */
function withNotifyEcho(result: OpResult, desired: DesiredResource | null): OpResult {
  if (!result.observed || !desired || result.observed.type !== T_DOMAIN) return result
  return {
    ...result,
    observed: {
      ...result.observed,
      fields: {
        ...result.observed.fields,
        recipients: recipientsOf(desired.fields.recipients),
        notify_from: String(norm(desired.fields.notify_from) ?? 'nivaro-hub').toLowerCase()
      }
    }
  }
}

async function applyDomain(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'create') {
    if (!desired) throw invalid('Nothing to create.')
    return createDomain(ctx, desired)
  }
  const id = op.externalId as string
  if (op.kind === 'delete') {
    await mailgunCall(ctx, 'DELETE', `/v3/domains/${domainSeg(id)}`, { allow: [404] })
    return ok(id, null)
  }
  if (!desired) throw invalid('Nothing to write.')
  if (op.kind === 'replace') {
    await mailgunCall(ctx, 'DELETE', `/v3/domains/${domainSeg(id)}`, { allow: [404] })
    return createDomain(ctx, { ...desired, externalId: null })
  }
  mismatch(op, desired)
  const raw = await readDomainRaw(ctx, id)
  if (!raw) throw new ProviderError('NOT_FOUND', 'The domain no longer exists.', { status: 404 })
  const have = domainObserved(raw)
  if (op.action === 'save_notify') return ok(id, have, { saved: 'in the Hub' })
  if (op.action === 'verify') {
    if (have.fields.verified === true) return ok(id, have, { already: 'verified' })
    const r = await mailgunCall(ctx, 'PUT', `/v4/domains/${domainSeg(id)}/verify`)
    const after = r.body?.domain ? r.body : await readDomainRaw(ctx, id)
    const seen = after ? domainObserved(after) : have
    if (seen.fields.verified !== true) {
      const failing = (Array.isArray(after?.sending_dns_records) ? after.sending_dns_records : [])
        .filter((x: any) => x?.valid !== 'valid')
        .map((x: any) => String(x?.name ?? ''))
        .filter(Boolean)
        .slice(0, 5)
      throw new ProviderError(
        'NOT_VALID_YET',
        `Mailgun cannot see the DNS records yet${failing.length ? ` (${failing.join(', ')})` : ''}. DNS can take a few minutes; try again.`,
        { retryable: true }
      )
    }
    return ok(id, seen, { verified: true }, domainOutputs(after))
  }
  const diff = diffFields(DOMAIN_WRITABLE, desired.fields, have.fields)
  if (!diff.length) return ok(id, have, { already: 'matches' })
  const form: Record<string, string> = {}
  for (const c of diff) form[c.field] = String(c.to ?? '')
  await mailgunCall(ctx, 'PUT', `/v4/domains/${domainSeg(id)}`, { form })
  const after = await readDomainRaw(ctx, id)
  return ok(id, after ? domainObserved(after) : null, { changed: diff.map((c) => c.field) })
}

async function createDomain(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const name = domainSeg(desired.fields.name)
  validateDomainFields(desired.fields)
  if (desired.externalId) {
    const raw = await readDomainRaw(ctx, desired.externalId)
    if (raw) return ok(name, domainObserved(raw), { already: 'exists' }, domainOutputs(raw))
  }
  if (await readDomainRaw(ctx, name)) throw alreadyExists(`The domain ${name}`)
  const form: Record<string, string> = { name }
  for (const k of ['web_scheme', 'spam_action', 'dkim_key_size'])
    if (norm(desired.fields[k]) !== null) form[k] = String(desired.fields[k])
  if (desired.fields.wildcard !== undefined)
    form.wildcard = desired.fields.wildcard ? 'true' : 'false'
  const r = await mailgunCall(ctx, 'POST', '/v4/domains', { form })
  const raw = r.body?.domain ? r.body : await readDomainRaw(ctx, name)
  if (!raw) throw new ProviderError('PROVIDER_REJECTED', 'Mailgun did not return the new domain.')
  return ok(name, domainObserved(raw), { created: true }, domainOutputs(raw))
}

// ═══ SMTP credentials ═══

const CRED_LABEL = 'Mailgun SMTP login'
const BIND_NOTE =
  ' Bind the password to the app setting smtp_pass, with smtp_host, smtp_port and smtp_user from the same resource.'

function credId(domain: string, login: string): string {
  return `${domain}:${login}`
}

function parseCredId(id: string): { domain: string; login: string } {
  const at = id.indexOf(':')
  if (at < 1) throw new ProviderError('BAD_ID', 'That SMTP login id cannot be used.')
  return { domain: domainSeg(id.slice(0, at)), login: loginSeg(id.slice(at + 1)) }
}

function smtpOutputs(ctx: ProviderContext, domain: string, login: string): Record<string, string> {
  return {
    smtp_host:
      hostFor(ctx.config) === 'api.eu.mailgun.net' ? 'smtp.eu.mailgun.org' : 'smtp.mailgun.org',
    smtp_port: SMTP_PORT,
    smtp_user: `${login}@${domain}`
  }
}

function credObserved(domain: string, row: any): Observed {
  const full = String(row?.login ?? '')
  const login = full.split('@')[0].toLowerCase()
  return {
    type: T_CRED,
    externalId: credId(domain, login),
    name: full || `${login}@${domain}`,
    fields: { domain, login },
    tags: {},
    version: null,
    status: null,
    url: `https://app.mailgun.com/mg/sending/domains/${domain}/smtp-credentials`
  }
}

async function domainCreds(ctx: ProviderContext, domain: string): Promise<any[]> {
  const r = await mailgunCall(ctx, 'GET', `/v3/domains/${domainSeg(domain)}/credentials`, {
    query: { limit: 1000 },
    allow: [404]
  })
  return r.status === 404 || !Array.isArray(r.body?.items) ? [] : r.body.items
}

async function readCred(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const { domain, login } = parseCredId(id)
  const hit = (await domainCreds(ctx, domain)).find(
    (c) =>
      String(c?.login ?? '')
        .split('@')[0]
        .toLowerCase() === login
  )
  return hit ? credObserved(domain, hit) : null
}

const CRED_FIELDS: FieldSpec[] = [
  {
    key: 'domain',
    label: 'Domain',
    kind: 'ref',
    refType: T_DOMAIN,
    required: true,
    createOnly: true,
    replaceOnChange: true
  },
  {
    key: 'login',
    label: 'Login',
    kind: 'string',
    required: true,
    createOnly: true,
    replaceOnChange: true,
    pattern: LOGIN_RE.source,
    help: 'The part before the @ of the SMTP user name.'
  },
  {
    key: ROTATE_OUTPUTS_FIELD,
    label: 'Make a new password',
    kind: 'boolean',
    trigger: true,
    default: false,
    help: 'Mailgun never shows a password again. This sets a NEW one and hands it out; the old password stops working at once, so the app cannot send until the new value is applied.'
  }
]
const credWords = (c: Array<{ field: string }>) => fieldWords(CRED_FIELDS, c)

function newPassword(): string {
  // 24 url-safe characters; Mailgun takes 5 to 32.
  return randomBytes(18).toString('base64url')
}

function planCred(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: T_CRED,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName(CRED_LABEL, observed.name)}. Anything still sending with it is refused straight away.`,
        changes: [],
        preconditions: { login: observed.fields.login },
        risk: []
      }
    ]
  }
  const login = String(desired.fields.login ?? '').toLowerCase()
  if (!LOGIN_RE.test(login)) throw invalid('The login is letters, digits, dots and dashes.')
  if (!observed)
    return [
      {
        kind: 'create',
        type: T_CRED,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(CRED_LABEL, login)} with a password the Hub makes. Mailgun never shows it again; the Hub seals it.${BIND_NOTE}`,
        changes: [{ field: 'login', to: login }],
        preconditions: {},
        risk: []
      }
    ]
  const replace = diffFields(['login'], { login }, observed.fields)
  if (replace.length)
    return [
      {
        kind: 'replace',
        type: T_CRED,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(CRED_LABEL, observed.name)}: ${credWords(replace)} cannot change in place, so the old login is deleted and a new one is made.`,
        changes: replace,
        preconditions: { login: observed.fields.login },
        risk: []
      }
    ]
  if (desired.fields[ROTATE_OUTPUTS_FIELD] === true)
    return [
      {
        kind: 'update',
        type: T_CRED,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Set a new password on ${typedName(CRED_LABEL, observed.name)}. The old password stops working at once, so the app cannot send until the new value is applied.${BIND_NOTE}`,
        changes: [{ field: ROTATE_OUTPUTS_FIELD, to: true }],
        preconditions: { login: observed.fields.login },
        risk: [],
        action: 'rotate'
      }
    ]
  return []
}

async function createCred(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const domain = refId(desired, 'domain')
  if (!domain) throw invalid('The domain this login belongs to is not created yet.')
  const dom = domainSeg(domain)
  const login = loginSeg(desired.fields.login)
  const id = credId(dom, login)
  const constants = smtpOutputs(ctx, dom, login)
  if (desired.externalId) {
    // A resumed create: the login exists, its password was shown once and is not re-readable.
    const have = await readCred(ctx, desired.externalId)
    if (have) return ok(have.externalId, have, { already: 'exists' }, constants)
  }
  if (await readCred(ctx, id)) throw alreadyExists(`An SMTP login ${login}@${dom}`)
  const password = newPassword()
  await mailgunCall(ctx, 'POST', `/v3/domains/${dom}/credentials`, {
    form: { login: `${login}@${dom}`, password },
    extraScrub: [password]
  })
  const have = await readCred(ctx, id)
  return ok(
    id,
    have ?? credObserved(dom, { login: `${login}@${dom}` }),
    { created: true },
    { ...constants, smtp_pass: password }
  )
}

async function applyCred(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'create') {
    if (!desired) throw invalid('Nothing to create.')
    return createCred(ctx, desired)
  }
  const id = op.externalId as string
  const { domain, login } = parseCredId(id)
  if (op.kind === 'delete') {
    await mailgunCall(ctx, 'DELETE', `/v3/domains/${domain}/credentials/${login}`, { allow: [404] })
    return ok(id, null)
  }
  if (!desired) throw invalid('Nothing to write.')
  if (op.kind === 'replace') {
    await mailgunCall(ctx, 'DELETE', `/v3/domains/${domain}/credentials/${login}`, { allow: [404] })
    return createCred(ctx, { ...desired, externalId: null })
  }
  mismatch(op, desired)
  const have = await readCred(ctx, id)
  if (!have)
    throw new ProviderError('NOT_FOUND', 'The SMTP login no longer exists.', { status: 404 })
  if (op.action === 'rotate') {
    const password = newPassword()
    await mailgunCall(ctx, 'PUT', `/v3/domains/${domain}/credentials/${login}`, {
      form: { password },
      extraScrub: [password]
    })
    return ok(
      id,
      have,
      { rotated: true },
      { ...smtpOutputs(ctx, domain, login), smtp_pass: password }
    )
  }
  return ok(id, have, { already: 'matches' })
}

// ═══ Webhooks ═══

const HOOK_LABEL = 'Mailgun webhook'
const HOOK_NOTE =
  ' Mailgun sends delivery events (they name recipients) to this address, so a Hub administrator must start it.'

function hookId(domain: string, event: string): string {
  return `${domain}:${event}`
}

function parseHookId(id: string): { domain: string; event: string } {
  const at = id.indexOf(':')
  if (at < 1) throw new ProviderError('BAD_ID', 'That webhook id cannot be used.')
  return { domain: domainSeg(id.slice(0, at)), event: eventSeg(id.slice(at + 1)) }
}

function hookObserved(domain: string, event: string, urls: string[]): Observed {
  return {
    type: T_HOOK,
    externalId: hookId(domain, event),
    name: `${event} on ${domain}`,
    fields: { domain, event, url: urls[0] ?? null, other_urls: Math.max(0, urls.length - 1) },
    tags: {},
    version: null,
    status: null,
    url: `https://app.mailgun.com/mg/sending/domains/${domain}/webhooks`
  }
}

async function readHookUrls(
  ctx: ProviderContext,
  domain: string,
  event: string
): Promise<string[] | null> {
  const r = await mailgunCall(ctx, 'GET', `/v3/domains/${domain}/webhooks/${event}`, {
    allow: [404]
  })
  if (r.status === 404) return null
  const urls = r.body?.webhook?.urls ?? r.body?.urls
  return Array.isArray(urls) ? urls.map(String).filter(Boolean) : []
}

async function readHook(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const { domain, event } = parseHookId(id)
  const urls = await readHookUrls(ctx, domain, event)
  return urls && urls.length ? hookObserved(domain, event, urls) : null
}

const HOOK_FIELDS: FieldSpec[] = [
  {
    key: 'domain',
    label: 'Domain',
    kind: 'ref',
    refType: T_DOMAIN,
    required: true,
    createOnly: true,
    replaceOnChange: true
  },
  {
    key: 'event',
    label: 'Event',
    kind: 'enum',
    required: true,
    createOnly: true,
    replaceOnChange: true,
    options: WEBHOOK_EVENTS.map((e) => ({ value: e, label: e.replace(/_/g, ' ') }))
  },
  {
    key: 'url',
    label: 'Send to',
    kind: 'string',
    required: true,
    help: 'An https address. The Hub manages one address per event.'
  },
  { key: 'other_urls', label: 'Other addresses at Mailgun', kind: 'number', readOnly: true }
]
const hookWords = (c: Array<{ field: string }>) => fieldWords(HOOK_FIELDS, c)

function hookUrl(f: Record<string, unknown>): string {
  const url = String(f.url ?? '').trim()
  const problem = httpsProblem('The webhook address', url)
  if (problem) throw invalid(problem)
  if (!url) throw invalid('The webhook needs an address.')
  return url
}

function refuseOthers(observed: Observed): void {
  if (Number(observed.fields.other_urls ?? 0) > 0)
    throw new ProviderError(
      'HAS_OTHER_URLS',
      'This event sends to other addresses at Mailgun too. The Hub manages one address per event and will not replace or remove the others; change it in Mailgun.'
    )
}

function planHook(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    refuseOthers(observed)
    return [
      {
        kind: 'delete',
        type: T_HOOK,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName(HOOK_LABEL, observed.name)}. Mailgun stops sending these events.`,
        changes: [],
        preconditions: { url: observed.fields.url },
        risk: []
      }
    ]
  }
  const url = hookUrl(desired.fields)
  if (!observed)
    return [
      withAdminOnly(
        {
          kind: 'create',
          type: T_HOOK,
          resourceId: desired.resourceId,
          externalId: null,
          reason: `Create ${typedName(HOOK_LABEL, String(desired.fields.event ?? ''))} sending to ${url}.`,
          changes: [
            { field: 'event', to: desired.fields.event },
            { field: 'url', to: url }
          ],
          preconditions: {},
          risk: []
        },
        HOOK_NOTE
      )
    ]
  const replace = diffFields(['domain', 'event'], desired.fields, observed.fields).filter(
    (c) => c.field !== 'domain'
  )
  if (replace.length)
    return [
      {
        kind: 'replace',
        type: T_HOOK,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(HOOK_LABEL, observed.name)}: ${hookWords(replace)} cannot change in place.`,
        changes: replace,
        preconditions: { url: observed.fields.url },
        risk: []
      }
    ]
  const changes = diffFields(['url'], { url }, observed.fields)
  if (!changes.length) return []
  refuseOthers(observed)
  return [
    withAdminOnly(
      {
        kind: 'update',
        type: T_HOOK,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Send ${typedName(HOOK_LABEL, observed.name)} to ${url} instead.`,
        changes,
        preconditions: { url: observed.fields.url },
        risk: []
      },
      HOOK_NOTE
    )
  ]
}

async function createHook(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const domain = refId(desired, 'domain')
  if (!domain) throw invalid('The domain this webhook belongs to is not created yet.')
  const dom = domainSeg(domain)
  const event = eventSeg(desired.fields.event)
  const url = hookUrl(desired.fields)
  const id = hookId(dom, event)
  const have = await readHookUrls(ctx, dom, event)
  if (have && have.length) {
    // A resumed create of ours holds exactly our address; anything else is not ours to touch.
    if (desired.externalId === id && have.length === 1 && have[0] === url)
      return ok(id, hookObserved(dom, event, have), { already: 'exists' })
    throw alreadyExists(`A ${event} webhook on ${dom}`)
  }
  await mailgunCall(ctx, 'POST', `/v3/domains/${dom}/webhooks`, { form: { id: event, url } })
  return ok(id, hookObserved(dom, event, [url]), { created: true })
}

async function applyHook(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'create') {
    if (!desired) throw invalid('Nothing to create.')
    return createHook(ctx, desired)
  }
  const id = op.externalId as string
  const { domain, event } = parseHookId(id)
  if (op.kind === 'delete' || op.kind === 'replace') {
    const urls = await readHookUrls(ctx, domain, event)
    if (urls && urls.length > 1) refuseOthers(hookObserved(domain, event, urls))
    await mailgunCall(ctx, 'DELETE', `/v3/domains/${domain}/webhooks/${event}`, { allow: [404] })
    if (op.kind === 'delete') return ok(id, null)
    if (!desired) throw invalid('Nothing to write.')
    return createHook(ctx, { ...desired, externalId: null })
  }
  if (!desired) throw invalid('Nothing to write.')
  mismatch(op, desired)
  const urls = await readHookUrls(ctx, domain, event)
  if (!urls || !urls.length)
    throw new ProviderError('NOT_FOUND', 'The webhook no longer exists.', { status: 404 })
  const url = hookUrl(desired.fields)
  const seen = hookObserved(domain, event, urls)
  if (urls.length === 1 && urls[0] === url) return ok(id, seen, { already: 'matches' })
  refuseOthers(seen)
  await mailgunCall(ctx, 'PUT', `/v3/domains/${domain}/webhooks/${event}`, { form: { url } })
  return ok(id, hookObserved(domain, event, [url]), { changed: ['url'] })
}

// ═══ Sending keys ═══

const KEY_LABEL = 'Mailgun sending key'

function keyObserved(k: any): Observed {
  const id = String(k.id)
  return {
    type: T_KEY,
    externalId: id,
    name: k.description ?? id,
    fields: {
      domain: k.domain_name ?? null,
      description: k.description ?? null,
      role: k.role ?? null,
      kind: k.kind ?? null,
      disabled: k.is_disabled === true
    },
    tags: {},
    version: null,
    status: k.is_disabled === true ? 'disabled' : 'active',
    url: 'https://app.mailgun.com/settings/api-security'
  }
}

async function listKeys(ctx: ProviderContext, domain?: string): Promise<Observed[]> {
  const r = await mailgunCall(ctx, 'GET', '/v1/keys', {
    query: { kind: 'domain', domain_name: domain }
  })
  const rows: any[] = Array.isArray(r.body?.items) ? r.body.items : []
  return rows.filter((k) => k?.id && k.kind === 'domain').map(keyObserved)
}

async function readKey(ctx: ProviderContext, id: string): Promise<Observed | null> {
  keySeg(id)
  return (await listKeys(ctx)).find((k) => k.externalId === id) ?? null
}

const KEY_FIELDS: FieldSpec[] = [
  {
    key: 'domain',
    label: 'Domain',
    kind: 'ref',
    refType: T_DOMAIN,
    required: true,
    createOnly: true,
    replaceOnChange: true,
    help: 'The key can send through this domain and nothing else.'
  },
  {
    key: 'description',
    label: 'Description',
    kind: 'string',
    required: true,
    createOnly: true,
    replaceOnChange: true,
    pattern: '^[^\\u0000-\\u001f]{1,100}$'
  },
  {
    key: ROTATE_OUTPUTS_FIELD,
    label: 'Make a new key',
    kind: 'boolean',
    trigger: true,
    default: false,
    help: 'Mailgun shows a key once. This makes a NEW key and hands it out; the old key stays valid until you delete it.'
  }
]

function planKey(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: T_KEY,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName(KEY_LABEL, observed.name)}. Anything still sending with it is refused straight away.`,
        changes: [],
        preconditions: { description: observed.fields.description },
        risk: []
      }
    ]
  }
  const description = String(desired.fields.description ?? '').trim()
  if (!description) throw invalid('The sending key needs a description.')
  if (!observed)
    return [
      {
        kind: 'create',
        type: T_KEY,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(KEY_LABEL, description)} that can send through one domain only. Mailgun shows the value once; the Hub seals it.`,
        changes: [{ field: 'description', to: description }],
        preconditions: {},
        risk: []
      }
    ]
  const replace = diffFields(['description'], { description }, observed.fields)
  if (replace.length)
    return [
      {
        kind: 'replace',
        type: T_KEY,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(KEY_LABEL, observed.name)}: a key cannot be renamed, so the old key is deleted and a new one is made.`,
        changes: replace,
        preconditions: { description: observed.fields.description },
        risk: []
      }
    ]
  if (desired.fields[ROTATE_OUTPUTS_FIELD] === true)
    return [
      {
        kind: 'update',
        type: T_KEY,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Make a new key for ${typedName(KEY_LABEL, observed.name)}. The old key stays valid until you delete it.`,
        changes: [{ field: ROTATE_OUTPUTS_FIELD, to: true }],
        preconditions: { description: observed.fields.description },
        risk: [],
        action: 'rotate'
      }
    ]
  return []
}

async function createKey(
  ctx: ProviderContext,
  domain: string,
  description: string,
  checkName: boolean
): Promise<{ id: string; observed: Observed; outputs: Record<string, string> }> {
  if (checkName) {
    const hit = (await listKeys(ctx, domain)).find((k) => k.fields.description === description)
    if (hit) throw alreadyExists(`A sending key "${description}" on ${domain}`)
  }
  const r = await mailgunCall(ctx, 'POST', '/v1/keys', {
    form: { role: 'sending', kind: 'domain', domain_name: domain, description }
  })
  const made = r.body?.key
  if (!made?.id || typeof made.secret !== 'string')
    throw new ProviderError('PROVIDER_REJECTED', 'Mailgun did not return the new key.')
  return {
    id: String(made.id),
    observed: keyObserved({ ...made, domain_name: made.domain_name ?? domain, secret: undefined }),
    outputs: { api_key: made.secret }
  }
}

async function applyKey(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  const wantDomain = desired ? refId(desired, 'domain') : null
  if (op.kind === 'create') {
    if (!desired) throw invalid('Nothing to create.')
    if (!wantDomain) throw invalid('The domain this key belongs to is not created yet.')
    const description = String(desired.fields.description ?? '').trim()
    if (desired.externalId) {
      const have = await readKey(ctx, desired.externalId)
      if (have) return ok(have.externalId, have, { already: 'exists' })
    }
    const made = await createKey(ctx, domainSeg(wantDomain), description, true)
    return ok(made.id, made.observed, { created: true }, made.outputs)
  }
  const id = op.externalId as string
  if (op.kind === 'delete' || op.kind === 'replace') {
    await mailgunCall(ctx, 'DELETE', `/v1/keys/${keySeg(id)}`, { allow: [404] })
    if (op.kind === 'delete') return ok(id, null)
    if (!desired || !wantDomain) throw invalid('Nothing to write.')
    const made = await createKey(
      ctx,
      domainSeg(wantDomain),
      String(desired.fields.description ?? '').trim(),
      false
    )
    return ok(made.id, made.observed, { replaced: true }, made.outputs)
  }
  if (!desired) throw invalid('Nothing to write.')
  mismatch(op, desired)
  const have = await readKey(ctx, id)
  if (!have)
    throw new ProviderError('NOT_FOUND', 'The sending key no longer exists.', { status: 404 })
  if (op.action === 'rotate') {
    // The new key is made for the domain the existing key is scoped to, never one named in desired.
    const dom = domainSeg(have.fields.domain)
    const made = await createKey(ctx, dom, String(have.fields.description ?? ''), false)
    return ok(
      made.id,
      made.observed,
      { rotated: true, previous_key_id: id, previous_key_kept: true },
      made.outputs
    )
  }
  return ok(id, have, { already: 'matches' })
}

// ═══ Types ═══

const caps = (over: Partial<ResourceTypeSpec['capabilities']> = {}) => ({
  create: true,
  update: true,
  delete: true,
  adopt: true,
  snapshot: false,
  tag: false,
  ...over
})

const TYPES: ResourceTypeSpec[] = [
  {
    key: T_DOMAIN,
    label: DOMAIN_LABEL,
    scope: 'shared',
    nameField: 'name',
    fields: DOMAIN_FIELDS,
    capabilities: caps(),
    reversible: false,
    refs: [
      { field: 'cloudflare_records', type: 'cloudflare.dns_record', required: false },
      { field: 'route53_records', type: 'aws.route53_record', required: false }
    ],
    outputs: [{ key: 'dns_records', label: 'DNS records to add (JSON)', secret: false }],
    sends: true,
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive', 'downtime')
      return out
    }
  },
  {
    key: T_CRED,
    label: CRED_LABEL,
    scope: 'app',
    nameField: 'login',
    fields: CRED_FIELDS,
    capabilities: caps({ update: true }),
    reversible: false,
    refs: [{ field: 'domain', type: T_DOMAIN }],
    outputs: [
      { key: 'smtp_pass', label: 'SMTP password', secret: true, onceOnly: true },
      { key: 'smtp_host', label: 'SMTP host', secret: false },
      { key: 'smtp_port', label: 'SMTP port', secret: false },
      { key: 'smtp_user', label: 'SMTP user', secret: false }
    ],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive')
      // A new password cuts off the old one at once.
      if (op.action === 'rotate' || op.kind === 'replace') out.push('downtime')
      return out
    }
  },
  {
    key: T_HOOK,
    label: HOOK_LABEL,
    scope: 'app',
    nameField: 'event',
    fields: HOOK_FIELDS,
    capabilities: caps(),
    reversible: (field) => field === 'url',
    refs: [{ field: 'domain', type: T_DOMAIN }],
    risk(op, desired) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive')
      // Event data (recipient addresses) goes to an address outside the Hub: administrators only.
      if (
        desired &&
        (op.kind === 'create' || op.kind === 'update' || op.kind === 'replace') &&
        op.changes.some((c) => c.field === 'url' || c.field === 'event')
      )
        out.push('public_exposure')
      return out
    }
  },
  {
    key: T_KEY,
    label: KEY_LABEL,
    scope: 'app',
    nameField: 'description',
    fields: KEY_FIELDS,
    capabilities: caps({ update: true }),
    reversible: false,
    refs: [{ field: 'domain', type: T_DOMAIN }],
    outputs: [{ key: 'api_key', label: 'Sending API key', secret: true, onceOnly: true }],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive')
      return out
    }
  }
]

// ═══ The adapter ═══

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function mailBody(msg: OutboundMessage): { text: string; html: string } {
  const link = msg.link && /^https:\/\//i.test(msg.link) ? msg.link : null
  return {
    text: `${msg.body}${link ? `\n\n${link}` : ''}`,
    html: `<p>${esc(msg.body).replace(/\r?\n/g, '<br>')}</p>${
      link ? `<p><a href="${esc(link)}">Open in the Hub</a></p>` : ''
    }`
  }
}

export const mailgunAdapter: ProviderAdapter = {
  key: 'mailgun',
  label: 'Mailgun',
  connection: {
    fields: [
      {
        key: 'region',
        label: 'Region',
        kind: 'enum',
        required: true,
        default: 'us',
        options: MAILGUN_REGIONS,
        help: 'Where the Mailgun account lives. A US key does not work on the EU host and the other way round.'
      },
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'string',
        secret: true,
        required: true,
        help: 'A Mailgun account API key (the Hub makes narrower sending keys for each app).'
      }
    ],
    hosts: (config) => [hostFor(config)],
    describe: (config) => `Mailgun (${hostFor(config)})`,
    validate(config) {
      const problems: string[] = []
      if (config.region !== undefined && config.region !== 'us' && config.region !== 'eu')
        problems.push('The region is US or EU.')
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const probe = async (path: string, query?: Record<string, string | number>) => {
      try {
        const r = await mailgunCall(ctx, 'GET', path, { query, allow: [401, 403, 404] })
        return r.status < 400
      } catch {
        return false
      }
    }
    let domains = false
    try {
      const r = await mailgunCall(ctx, 'GET', '/v4/domains', { query: { limit: 1 } })
      domains = r.status < 400
    } catch (err) {
      if (err instanceof ProviderError) {
        const permissions = [
          { type: T_DOMAIN, need: 'read and manage domains', has: false },
          { type: T_KEY, need: 'make and delete sending keys', has: false }
        ]
        return {
          ok: false,
          identity: null,
          permissions,
          missing: permissions.map((p) => p.need),
          message: ctx.scrub(err.message)
        }
      }
      throw err
    }
    const keys = await probe('/v1/keys', { kind: 'domain' })
    const permissions = [
      { type: T_DOMAIN, need: 'read and manage domains', has: domains },
      { type: T_CRED, need: 'manage SMTP logins', has: domains },
      { type: T_HOOK, need: 'manage webhooks', has: domains },
      { type: T_KEY, need: 'make and delete sending keys (a primary account key)', has: keys }
    ]
    return {
      ok: true,
      identity: `Mailgun account (${hostFor(ctx.config)})`,
      permissions,
      missing: permissions.filter((p) => !p.has).map((p) => p.need)
    }
  },

  async observe(ctx, type, externalId) {
    if (type === T_DOMAIN) {
      const raw = await readDomainRaw(ctx, externalId)
      return raw ? domainObserved(raw) : null
    }
    if (type === T_CRED) return readCred(ctx, externalId)
    if (type === T_HOOK) return readHook(ctx, externalId)
    if (type === T_KEY) return readKey(ctx, externalId)
    throw unknownType(type)
  },

  async list(ctx, type, cursor): Promise<ListPage> {
    if (type === T_DOMAIN) {
      const skip = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0
      const page = await listDomainRows(ctx, skip)
      return {
        items: page.rows.filter((d) => d?.name).map((d) => domainObserved({ domain: d })),
        cursor: page.next
      }
    }
    if (type === T_KEY) return { items: await listKeys(ctx), cursor: null }
    if (type === T_CRED || type === T_HOOK) {
      const skip = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0
      const page = await listDomainRows(ctx, skip)
      const items: Observed[] = []
      for (const d of page.rows.slice(0, MAX_PAGES)) {
        const name = String(d?.name ?? '')
        if (!DOMAIN_RE.test(name)) continue
        if (type === T_CRED)
          for (const c of await domainCreds(ctx, name)) items.push(credObserved(name, c))
        else
          for (const event of WEBHOOK_EVENTS) {
            const urls = await readHookUrls(ctx, name, event)
            if (urls?.length) items.push(hookObserved(name, event, urls))
          }
      }
      return { items, cursor: page.next }
    }
    throw unknownType(type)
  },

  /** Plan time: a domain, login, webhook or key that already exists at Mailgun. */
  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    if (type === T_DOMAIN) {
      const name = String(desired.fields.name ?? '')
        .trim()
        .toLowerCase()
      if (!DOMAIN_RE.test(name)) return null
      const raw = await readDomainRaw(ctx, name)
      return raw ? domainObserved(raw) : null
    }
    const dom = refId(desired, 'domain')
    if (!dom || !DOMAIN_RE.test(dom)) return null
    if (type === T_CRED) {
      const login = String(desired.fields.login ?? '')
        .trim()
        .toLowerCase()
      return LOGIN_RE.test(login) ? readCred(ctx, credId(dom, login)) : null
    }
    if (type === T_HOOK) {
      const event = String(desired.fields.event ?? '')
      return WEBHOOK_EVENTS.includes(event) ? readHook(ctx, hookId(dom, event)) : null
    }
    if (type === T_KEY) {
      const description = String(desired.fields.description ?? '').trim()
      return description
        ? ((await listKeys(ctx, dom)).find((k) => k.fields.description === description) ?? null)
        : null
    }
    return null
  },

  plan(_ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    if (type === T_DOMAIN) return planDomain(desired, observed)
    if (type === T_CRED) return planCred(desired, observed)
    if (type === T_HOOK) return planHook(desired, observed)
    if (type === T_KEY) return planKey(desired, observed)
    throw unknownType(type)
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    if (op.type === T_DOMAIN) return withNotifyEcho(await applyDomain(ctx, op, desired), desired)
    if (op.type === T_CRED) return applyCred(ctx, op, desired)
    if (op.type === T_HOOK) return applyHook(ctx, op, desired)
    if (op.type === T_KEY) return applyKey(ctx, op, desired)
    throw unknownType(op.type)
  },

  /** What Mailgun shows again. A password and a key are once-only and never asked for. */
  async readOutputs(ctx, type, externalId) {
    if (type === T_DOMAIN) {
      const raw = await readDomainRaw(ctx, externalId)
      return raw ? domainOutputs(raw) : {}
    }
    if (type === T_CRED) {
      const have = await readCred(ctx, externalId)
      if (!have) return {}
      const { domain, login } = parseCredId(externalId)
      return smtpOutputs(ctx, domain, login)
    }
    return {}
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at Mailgun.', checkedAt }
    if (type === T_DOMAIN) {
      if (seen.fields.verified === true && seen.fields.dns_valid === true)
        return { status: 'ok', checkedAt, details: { verified: true } }
      return {
        status: 'warn',
        message: 'The DNS records are not all verified yet.',
        checkedAt,
        details: { verified: seen.fields.verified === true }
      }
    }
    if (type === T_KEY && seen.fields.disabled === true)
      return { status: 'warn', message: 'The key is disabled at Mailgun.', checkedAt }
    return { status: 'ok', checkedAt }
  },

  /** One email, a copy for each address on the domain's recipient list, through Mailgun. */
  async notify(ctx, resource: HubResourceRow, msg: OutboundMessage): Promise<OpResult> {
    if (resource.type !== T_DOMAIN || !resource.external_id)
      throw new ProviderError('NOT_A_SENDER', 'Only a Mailgun domain sends messages.')
    const recipients = recipientsOf(resource.desired?.recipients)
    if (!recipients.length)
      throw new ProviderError(
        'NO_RECIPIENTS',
        'This domain has no recipients to mail. Add at least one address.'
      )
    const domain = domainSeg(resource.external_id)
    // Fresh read: a domain that stopped being active since the last observation decides here.
    const raw = await readDomainRaw(ctx, domain)
    if (!raw)
      throw new ProviderError('NOT_FOUND', 'The domain is gone at Mailgun.', { status: 404 })
    if (raw.domain?.state !== 'active')
      throw new ProviderError(
        'DOMAIN_NOT_VERIFIED',
        'The domain is not verified yet: Mailgun refuses to send through it.'
      )
    const local = String(norm(resource.desired?.notify_from) ?? 'nivaro-hub').toLowerCase()
    const from = `${LOGIN_RE.test(local) ? local : 'nivaro-hub'}@${domain}`
    const tag =
      msg.severity === 'critical' ? '[Critical] ' : msg.severity === 'warning' ? '[Warning] ' : ''
    const subject = `${tag}${msg.title}`.replace(/[\r\n]+/g, ' ').slice(0, 200)
    const { text, html } = mailBody(msg)
    // recipient-variables makes Mailgun send one message per address: nobody sees the others.
    const vars: Record<string, Record<string, never>> = {}
    for (const e of recipients) vars[e] = {}
    await mailgunCall(ctx, 'POST', `/v3/${domain}/messages`, {
      form: {
        from,
        to: recipients,
        subject,
        text,
        html,
        'recipient-variables': JSON.stringify(vars),
        'o:tag': 'nivaro-hub'
      }
    })
    return ok(resource.external_id, null, { sent: recipients.length })
  }
}
