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
import { keySeg, numSeg, ownKeyId, sendgridCall } from './client.js'

/**
 * SendGrid (`sendgrid`): one API key (full access to manage; the Hub makes narrower ones). Host
 * `api.sendgrid.com`. The key is the account: there is no account id to pin, so every read and
 * write below goes through that one key.
 *
 * Types:
 *  - `sendgrid.api_key`: a key limited to `mail.send`. Its value is shown once at create: output
 *    `api_key` (secret, once-only), beside the constant SMTP outputs (`smtp_host`, `smtp_port`,
 *    `smtp_user`) so one set of bindings fills the app's SMTP settings. A lost value is rotated
 *    (a NEW key; the old one stays valid until someone deletes it, so a running app keeps sending
 *    until the new value is applied), never re-read.
 *  - `sendgrid.sender`: a verified single sender. It also SENDS Hub events: `notify` mails the
 *    `recipients` list of the resource through the mail send API (output `smtp_from`).
 *  - `sendgrid.domain_authentication` (shared): the CNAME records come out as the `dns_records`
 *    output; `validate` is an op.
 *  - `sendgrid.ip_access`: the IP access list, read only.
 *
 * Nothing here is priced per resource (SendGrid bills the account's plan), so no type has a
 * `costClass` and none needs an estimate.
 */

const T_KEY = 'sendgrid.api_key'
const T_SENDER = 'sendgrid.sender'
const T_DOMAIN = 'sendgrid.domain_authentication'
const T_IP = 'sendgrid.ip_access'

const MAIL_SEND = 'mail.send'
const SMTP_HOST = 'smtp.sendgrid.net'
const SMTP_PORT = '587'
const SMTP_USER = 'apikey'
const PAGE = 100
const MAX_PAGES = 20
const MAX_RECIPIENTS = 50

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
    `${what} already exists at SendGrid. Adopt it instead of creating it.`,
    { retryable: false }
  )
}

function unknownType(type: unknown): ProviderError {
  return new ProviderError('UNKNOWN_TYPE', `SendGrid has no ${String(type)}.`)
}

function mismatch(op: PlannedOp, desired: DesiredResource | null): void {
  if (desired?.externalId && op.externalId && desired.externalId !== op.externalId)
    throw new ProviderError(
      'TARGET_MISMATCH',
      'This step is for a different SendGrid resource than the one it was planned for.'
    )
}

const EMAIL_RE = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/
const EMAIL_PATTERN = '^[^\\s@,;<>()"]+@[^\\s@,;<>()"]+\\.[^\\s@,;<>()"]+$'

function emailOk(v: unknown): boolean {
  const s = String(v ?? '').trim()
  return s.length <= 254 && EMAIL_RE.test(s)
}

/** The recipient list of a sender resource, checked: emails only, no repeats, at most 50. */
export function recipientsOf(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v == null || v === '' ? [] : [v]
  const out: string[] = []
  for (const x of list) {
    const e = String(x ?? '').trim()
    if (!e) continue
    if (!emailOk(e))
      throw new ProviderError('INVALID_FIELDS', `${e.slice(0, 60)} is not an email address.`)
    if (!out.some((o) => o.toLowerCase() === e.toLowerCase())) out.push(e)
  }
  if (out.length > MAX_RECIPIENTS)
    throw new ProviderError('INVALID_FIELDS', `At most ${MAX_RECIPIENTS} recipients.`)
  return out
}

// ═══ API keys ═══

function keyObserved(k: any): Observed {
  const id = String(k.api_key_id)
  const fields: Record<string, unknown> = { name: k.name ?? null }
  // The list answer has no scopes; only a single read does.
  if (Array.isArray(k.scopes)) fields.scopes = [...k.scopes].map(String).sort()
  return {
    type: T_KEY,
    externalId: id,
    name: k.name ?? null,
    fields,
    tags: {},
    version: null,
    status: null,
    url: 'https://app.sendgrid.com/settings/api_keys'
  }
}

/** The SMTP values that never change: bound beside the key so one set fills the app's SMTP settings. */
const SMTP_OUTPUTS = { smtp_host: SMTP_HOST, smtp_port: SMTP_PORT, smtp_user: SMTP_USER }

async function readKey(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const r = await sendgridCall(ctx, 'GET', `/api_keys/${keySeg(id)}`, { allow: [404] })
  if (r.status === 404 || !r.body || typeof r.body !== 'object' || !r.body.api_key_id) return null
  return keyObserved(r.body)
}

async function listKeys(ctx: ProviderContext): Promise<Observed[]> {
  const r = await sendgridCall(ctx, 'GET', '/api_keys', { query: { limit: 1000 } })
  const rows = Array.isArray(r.body?.result) ? r.body.result : []
  return rows.filter((k: any) => k?.api_key_id).map(keyObserved)
}

const KEY_FIELDS: FieldSpec[] = [
  {
    key: 'name',
    label: 'Name',
    kind: 'string',
    required: true,
    pattern: '^[^\\u0000-\\u001f]{1,100}$'
  },
  {
    key: 'scopes',
    label: 'Permissions',
    kind: 'list',
    items: { key: 'item', label: 'Permission', kind: 'string' },
    readOnly: true,
    help: 'A key the Hub makes can send mail and nothing else.'
  },
  {
    key: ROTATE_OUTPUTS_FIELD,
    label: 'Make a new key',
    kind: 'boolean',
    trigger: true,
    default: false,
    help: 'SendGrid shows a key once. This makes a NEW key and hands it out; the old key stays valid until you delete it.'
  }
]

const keyWords = (changes: Array<{ field: string }>) => fieldWords(KEY_FIELDS, changes)
const KEY_LABEL = 'SendGrid API key'
const BIND_NOTE =
  ' Bind its value to the app setting smtp_pass, with smtp_host, smtp_port and smtp_user from the same resource.'

function planKey(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    if (ownKeyId(ctx.secrets.apiKey) === observed.externalId)
      throw new ProviderError(
        'CONNECTION_KEY',
        'This is the API key the connection itself uses. Delete it in SendGrid after the connection has another key.'
      )
    return [
      {
        kind: 'delete',
        type: T_KEY,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName(KEY_LABEL, observed.name)}. Anything still sending with it is refused straight away.`,
        changes: [],
        preconditions: { name: observed.fields.name },
        risk: []
      }
    ]
  }
  if (!observed) {
    return [
      {
        kind: 'create',
        type: T_KEY,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(KEY_LABEL, String(desired.fields.name ?? ''))} that can send mail only. SendGrid shows the value once; the Hub seals it.${BIND_NOTE}`,
        changes: [
          { field: 'name', to: desired.fields.name },
          { field: 'scopes', to: [MAIL_SEND] }
        ],
        preconditions: {},
        risk: []
      }
    ]
  }
  const ops: PlannedOp[] = []
  const changes = diffFields(['name'], desired.fields, observed.fields)
  if (changes.length)
    ops.push({
      kind: 'update',
      type: T_KEY,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${keyWords(changes)} on ${typedName(KEY_LABEL, observed.name)}.`,
      changes,
      preconditions: { name: observed.fields.name },
      risk: []
    })
  if (desired.fields[ROTATE_OUTPUTS_FIELD] === true)
    ops.push({
      kind: 'update',
      type: T_KEY,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Make a new key for ${typedName(KEY_LABEL, observed.name)}. The old key stays valid until you delete it, so the app keeps sending until the new value is applied.${BIND_NOTE}`,
      changes: [{ field: ROTATE_OUTPUTS_FIELD, to: true }],
      preconditions: { name: observed.fields.name },
      risk: [],
      action: 'rotate'
    })
  return ops
}

async function createKey(
  ctx: ProviderContext,
  name: string,
  opts: { checkName: boolean }
): Promise<{ id: string; observed: Observed; outputs: Record<string, string> }> {
  if (!name) throw new ProviderError('INVALID_FIELDS', 'The API key needs a name.')
  if (opts.checkName) {
    const hit = (await listKeys(ctx)).find((k) => k.name === name)
    if (hit) throw alreadyExists(`An API key named ${name}`)
  }
  const r = await sendgridCall(ctx, 'POST', '/api_keys', {
    body: { name, scopes: [MAIL_SEND] }
  })
  const made = r.body
  if (!made?.api_key_id || typeof made.api_key !== 'string')
    throw new ProviderError('PROVIDER_REJECTED', 'SendGrid did not return the new key.')
  // The value goes out as an output only: never into the observed state or the answer.
  const observed = keyObserved({
    api_key_id: made.api_key_id,
    name: made.name ?? name,
    scopes: Array.isArray(made.scopes) ? made.scopes : [MAIL_SEND]
  })
  return {
    id: String(made.api_key_id),
    observed,
    outputs: { api_key: made.api_key, ...SMTP_OUTPUTS }
  }
}

async function applyKey(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'create') {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to create.')
    const name = String(desired.fields.name ?? '').trim()
    if (desired.externalId) {
      // A resumed create: the key exists, its value was shown once and is not re-readable.
      const have = await readKey(ctx, desired.externalId)
      if (have)
        return ok(
          have.externalId,
          have,
          { already: 'exists' },
          SMTP_OUTPUTS as Record<string, string>
        )
    }
    const made = await createKey(ctx, name, { checkName: true })
    return ok(made.id, made.observed, { created: true }, made.outputs)
  }
  const id = op.externalId as string
  if (op.kind === 'delete') {
    if (ownKeyId(ctx.secrets.apiKey) === id)
      throw new ProviderError(
        'CONNECTION_KEY',
        'This is the API key the connection itself uses; it is not deleted from here.'
      )
    await sendgridCall(ctx, 'DELETE', `/api_keys/${keySeg(id)}`, { allow: [404] })
    return ok(id, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  mismatch(op, desired)
  const have = await readKey(ctx, id)
  if (!have) throw new ProviderError('NOT_FOUND', 'The API key no longer exists.', { status: 404 })
  if (op.action === 'rotate') {
    const name = String(desired.fields.name ?? have.name ?? '').trim()
    const made = await createKey(ctx, name, { checkName: false })
    return ok(
      made.id,
      made.observed,
      { rotated: true, previous_key_id: id, previous_key_kept: true },
      made.outputs
    )
  }
  const diff = diffFields(['name'], desired.fields, have.fields)
  if (!diff.length) return ok(id, have, { already: 'matches' })
  const name = String(diff[0].to ?? '').trim()
  if (!name) throw new ProviderError('INVALID_FIELDS', 'The API key needs a name.')
  await sendgridCall(ctx, 'PATCH', `/api_keys/${keySeg(id)}`, { body: { name } })
  const after = await readKey(ctx, id)
  return ok(id, after, { changed: ['name'] })
}

// ═══ Verified senders ═══

const SENDER_WRITABLE = [
  'nickname',
  'from_name',
  'reply_to',
  'reply_to_name',
  'address',
  'address2',
  'city',
  'state',
  'zip',
  'country'
]
const SENDER_LABEL = 'Verified sender'
const RESEND_FIELD = 'resend_verification'

function senderObserved(s: any): Observed {
  const id = String(s.id)
  return {
    type: T_SENDER,
    externalId: id,
    name: s.nickname ?? null,
    fields: {
      nickname: s.nickname ?? null,
      from_email: s.from_email ?? null,
      from_name: norm(s.from_name),
      reply_to: norm(s.reply_to),
      reply_to_name: norm(s.reply_to_name),
      address: norm(s.address),
      address2: norm(s.address2),
      city: norm(s.city),
      state: norm(s.state),
      zip: norm(s.zip),
      country: norm(s.country),
      verified: s.verified === true,
      locked: s.locked === true
    },
    tags: {},
    version: null,
    status: s.verified === true ? 'verified' : 'pending',
    url: 'https://app.sendgrid.com/settings/sender_auth/senders'
  }
}

async function sendersPage(
  ctx: ProviderContext,
  after: string | null
): Promise<{ rows: any[]; last: string | null }> {
  const r = await sendgridCall(ctx, 'GET', '/verified_senders', {
    query: { limit: PAGE, lastSeenID: after ?? undefined }
  })
  const rows: any[] = Array.isArray(r.body?.results)
    ? r.body.results
    : Array.isArray(r.body)
      ? r.body
      : []
  const last = rows.length ? String(rows[rows.length - 1]?.id ?? '') : ''
  return { rows, last: rows.length >= PAGE && last ? last : null }
}

async function allSenders(ctx: ProviderContext): Promise<any[]> {
  const out: any[] = []
  let after: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await sendersPage(ctx, after)
    out.push(...page.rows)
    if (!page.last) break
    after = page.last
  }
  return out
}

async function readSender(ctx: ProviderContext, id: string): Promise<Observed | null> {
  numSeg(id, 'sender id')
  const hit = (await allSenders(ctx)).find((s) => String(s?.id) === id)
  return hit ? senderObserved(hit) : null
}

const SENDER_FIELDS: FieldSpec[] = [
  { key: 'nickname', label: 'Nickname', kind: 'string', required: true, pattern: '^.{1,100}$' },
  {
    key: 'from_email',
    label: 'From address',
    kind: 'string',
    required: true,
    createOnly: true,
    replaceOnChange: true,
    pattern: EMAIL_PATTERN,
    help: 'SendGrid emails a link to this address; the sender works once someone clicks it. A different address is a new sender.'
  },
  { key: 'from_name', label: 'From name', kind: 'string' },
  { key: 'reply_to', label: 'Reply-to address', kind: 'string', pattern: EMAIL_PATTERN },
  { key: 'reply_to_name', label: 'Reply-to name', kind: 'string' },
  { key: 'address', label: 'Address', kind: 'string', required: true },
  { key: 'address2', label: 'Address line 2', kind: 'string' },
  { key: 'city', label: 'City', kind: 'string', required: true },
  { key: 'state', label: 'State or region', kind: 'string' },
  { key: 'zip', label: 'Postal code', kind: 'string' },
  { key: 'country', label: 'Country', kind: 'string', required: true },
  {
    key: 'recipients',
    label: 'Hub messages go to',
    kind: 'list',
    items: { key: 'item', label: 'Email address', kind: 'string', pattern: EMAIL_PATTERN },
    help: 'When a notify route sends through this sender, each of these addresses gets its own copy. Leave it empty to mail the route’s people (Hub administrators, or the app’s owners). Kept in the Hub, not at SendGrid.'
  },
  {
    key: RESEND_FIELD,
    label: 'Send the verification email again',
    kind: 'boolean',
    trigger: true,
    default: false
  },
  { key: 'verified', label: 'Verified', kind: 'boolean', readOnly: true },
  { key: 'locked', label: 'Locked', kind: 'boolean', readOnly: true }
]
const senderWords = (changes: Array<{ field: string }>) => fieldWords(SENDER_FIELDS, changes)

/** The effective desired values: a blank reply-to means the From address. */
function senderWant(f: Record<string, unknown>): Record<string, unknown> {
  return { ...f, reply_to: norm(f.reply_to) ?? norm(f.from_email) }
}

function planSender(desired: DesiredResource | null, observed: Observed | null): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: T_SENDER,
        resourceId: null,
        externalId: observed.externalId,
        reason: `Delete ${typedName(SENDER_LABEL, observed.name)}. Mail sent From ${String(observed.fields.from_email ?? 'this address')} is refused afterwards.`,
        changes: [],
        preconditions: { from_email: observed.fields.from_email },
        risk: []
      }
    ]
  }
  recipientsOf(desired.fields.recipients)
  if (!observed) {
    const email = String(desired.fields.from_email ?? '')
    return [
      {
        kind: 'create',
        type: T_SENDER,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(SENDER_LABEL, String(desired.fields.nickname ?? ''))}. SendGrid emails a link to ${email}; the sender cannot send until someone clicks it.`,
        changes: ['nickname', 'from_email', 'from_name', 'reply_to', 'city', 'country']
          .filter((k) => norm(desired.fields[k]) !== null)
          .map((k) => ({ field: k, to: desired.fields[k] })),
        preconditions: {},
        risk: []
      }
    ]
  }
  const replace = diffFields(['from_email'], desired.fields, observed.fields)
  if (replace.length)
    return [
      {
        kind: 'replace',
        type: T_SENDER,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(SENDER_LABEL, observed.name)}: ${senderWords(replace)} cannot change in place, so the old sender is deleted and a new one is made. SendGrid emails the new address a link to verify it.`,
        changes: replace,
        preconditions: { from_email: observed.fields.from_email },
        risk: []
      }
    ]
  const ops: PlannedOp[] = []
  const changes = diffFields(SENDER_WRITABLE, senderWant(desired.fields), observed.fields)
  if (changes.length) {
    const pre: Record<string, unknown> = {}
    for (const c of changes) pre[c.field] = c.from ?? null
    ops.push({
      kind: 'update',
      type: T_SENDER,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${senderWords(changes)} on ${typedName(SENDER_LABEL, observed.name)}.`,
      changes,
      preconditions: pre,
      risk: []
    })
  }
  if (desired.fields[RESEND_FIELD] === true && observed.fields.verified !== true)
    ops.push({
      kind: 'update',
      type: T_SENDER,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Send the verification email for ${typedName(SENDER_LABEL, observed.name)} again to ${String(observed.fields.from_email ?? 'its address')}.`,
      changes: [{ field: RESEND_FIELD, to: true }],
      preconditions: { verified: false },
      risk: [],
      action: 'resend_verification'
    })
  return ops
}

function senderBody(f: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of keys) if (f[k] !== undefined) out[k] = f[k] ?? ''
  return out
}

async function createSender(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const f = senderWant(desired.fields)
  for (const k of ['nickname', 'from_email', 'address', 'city', 'country'])
    if (norm(f[k]) === null)
      throw new ProviderError('INVALID_FIELDS', `A verified sender needs ${k.replace(/_/g, ' ')}.`)
  const email = String(f.from_email).trim()
  if (!emailOk(email))
    throw new ProviderError('INVALID_FIELDS', 'The From address is not an email address.')
  if (f.reply_to && !emailOk(f.reply_to))
    throw new ProviderError('INVALID_FIELDS', 'The reply-to address is not an email address.')
  recipientsOf(desired.fields.recipients)
  if (desired.externalId) {
    const have = await readSender(ctx, desired.externalId)
    if (have)
      return ok(
        have.externalId,
        have,
        { already: 'exists' },
        { smtp_from: String(have.fields.from_email) }
      )
  }
  const hit = (await allSenders(ctx)).find(
    (s) => String(s?.from_email ?? '').toLowerCase() === email.toLowerCase()
  )
  if (hit) throw alreadyExists(`A verified sender for ${email}`)
  const r = await sendgridCall(ctx, 'POST', '/verified_senders', {
    body: {
      nickname: String(f.nickname).trim(),
      from_email: email,
      ...senderBody(f, [
        'from_name',
        'reply_to',
        'reply_to_name',
        'address',
        'address2',
        'city',
        'state',
        'zip',
        'country'
      ])
    }
  })
  if (!r.body?.id)
    throw new ProviderError('PROVIDER_REJECTED', 'SendGrid did not return the new sender.')
  return ok(
    String(r.body.id),
    senderObserved(r.body),
    { created: true, verification: 'sent' },
    { smtp_from: email }
  )
}

async function applySender(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'create') {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to create.')
    return createSender(ctx, desired)
  }
  const id = op.externalId as string
  if (op.kind === 'delete') {
    await sendgridCall(ctx, 'DELETE', `/verified_senders/${numSeg(id, 'sender id')}`, {
      allow: [404]
    })
    return ok(id, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'replace') {
    await sendgridCall(ctx, 'DELETE', `/verified_senders/${numSeg(id, 'sender id')}`, {
      allow: [404]
    })
    return createSender(ctx, { ...desired, externalId: null })
  }
  mismatch(op, desired)
  const have = await readSender(ctx, id)
  if (!have) throw new ProviderError('NOT_FOUND', 'The sender no longer exists.', { status: 404 })
  if (op.action === 'resend_verification') {
    if (have.fields.verified === true) return ok(id, have, { already: 'verified' })
    await sendgridCall(ctx, 'POST', `/verified_senders/resend/${numSeg(id, 'sender id')}`)
    return ok(id, have, { resent: true })
  }
  const diff = diffFields(SENDER_WRITABLE, senderWant(desired.fields), have.fields)
  if (!diff.length) return ok(id, have, { already: 'matches' })
  const want = senderWant(desired.fields)
  await sendgridCall(ctx, 'PATCH', `/verified_senders/${numSeg(id, 'sender id')}`, {
    body: senderBody(
      want,
      diff.map((c) => c.field)
    )
  })
  const after = await readSender(ctx, id)
  return ok(id, after, { changed: diff.map((c) => c.field) })
}

// ═══ Domain authentication ═══

const DOMAIN_LABEL = 'Domain authentication'
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

function dnsRecordsOf(d: any): string | null {
  const dns = d?.dns
  if (!dns || typeof dns !== 'object') return null
  const rows: Array<{ key: string; type: string; host: string; data: string }> = []
  for (const [key, v] of Object.entries(dns as Record<string, any>)) {
    if (!v || typeof v !== 'object') continue
    const host = String(v.host ?? '')
    const data = String(v.data ?? '')
    if (!host || !data) continue
    rows.push({ key, type: String(v.type ?? 'cname').toUpperCase(), host, data })
  }
  return rows.length ? JSON.stringify(rows) : null
}

const domainOutputs = (d: any): Record<string, string> => {
  const text = dnsRecordsOf(d)
  return text ? { dns_records: text } : {}
}

function domainObserved(d: any): Observed {
  const id = String(d.id)
  return {
    type: T_DOMAIN,
    externalId: id,
    name: d.domain ?? null,
    fields: {
      domain: d.domain ?? null,
      subdomain: d.subdomain ?? '',
      automatic_security: d.automatic_security !== false,
      default: d.default === true,
      valid: d.valid === true
    },
    tags: {},
    version: null,
    status: d.valid === true ? 'valid' : 'pending',
    url: 'https://app.sendgrid.com/settings/sender_auth'
  }
}

async function readDomainRaw(ctx: ProviderContext, id: string): Promise<any | null> {
  const r = await sendgridCall(ctx, 'GET', `/whitelabel/domains/${numSeg(id, 'domain id')}`, {
    allow: [404]
  })
  if (r.status === 404 || !r.body || typeof r.body !== 'object' || r.body.id === undefined)
    return null
  return r.body
}

async function domainsPage(
  ctx: ProviderContext,
  offset: number
): Promise<{ rows: any[]; next: string | null }> {
  const r = await sendgridCall(ctx, 'GET', '/whitelabel/domains', {
    query: { limit: PAGE, offset, exclude_subusers: 'true' }
  })
  const rows: any[] = Array.isArray(r.body) ? r.body : []
  return { rows, next: rows.length >= PAGE ? String(offset + PAGE) : null }
}

const DOMAIN_FIELDS: FieldSpec[] = [
  {
    key: 'domain',
    label: 'Domain',
    kind: 'string',
    required: true,
    createOnly: true,
    replaceOnChange: true,
    pattern: DOMAIN_RE.source,
    help: 'The domain mail is sent From, e.g. example.com.'
  },
  {
    key: 'subdomain',
    label: 'Link subdomain',
    kind: 'string',
    default: 'em',
    createOnly: true,
    replaceOnChange: true,
    pattern: LABEL_RE.source,
    help: 'The subdomain SendGrid uses for return-path and link records.'
  },
  {
    key: 'automatic_security',
    label: 'Automated security',
    kind: 'boolean',
    default: true,
    createOnly: true,
    replaceOnChange: true,
    help: 'SendGrid manages the SPF and DKIM records (three CNAMEs). Recommended.'
  },
  {
    key: 'default',
    label: 'Default for this account',
    kind: 'boolean',
    default: false
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
    key: 'validate',
    label: 'Validate DNS now',
    kind: 'boolean',
    trigger: true,
    default: false,
    help: 'Asks SendGrid to check that the DNS records are in place.'
  },
  { key: 'valid', label: 'Valid', kind: 'boolean', readOnly: true }
]
const domainWords = (changes: Array<{ field: string }>) => fieldWords(DOMAIN_FIELDS, changes)

function domainText(f: Record<string, unknown>): string {
  const sub = String(f.subdomain ?? 'em')
  return `${sub ? `${sub}.` : ''}${String(f.domain ?? '')}`
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
        reason: `Delete ${typedName(DOMAIN_LABEL, String(observed.fields.domain ?? ''))}. Mail From this domain stops being signed by SendGrid; its DNS records stay where they are.`,
        changes: [],
        preconditions: { domain: observed.fields.domain, subdomain: observed.fields.subdomain },
        risk: []
      }
    ]
  }
  if (!observed) {
    return [
      {
        kind: 'create',
        type: T_DOMAIN,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(DOMAIN_LABEL, String(desired.fields.domain ?? ''))}. SendGrid answers with the DNS records to add (the dns_records output); add them, then validate.`,
        changes: ['domain', 'subdomain', 'automatic_security', 'default']
          .filter((k) => norm(desired.fields[k]) !== null)
          .map((k) => ({ field: k, to: desired.fields[k] })),
        preconditions: {},
        risk: []
      }
    ]
  }
  const replace = diffFields(
    ['domain', 'subdomain', 'automatic_security'],
    { ...desired.fields, subdomain: desired.fields.subdomain ?? 'em' },
    observed.fields
  )
  if (replace.length)
    return [
      {
        kind: 'replace',
        type: T_DOMAIN,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Replace ${typedName(DOMAIN_LABEL, String(observed.fields.domain ?? ''))}: ${domainWords(replace)} cannot change in place, so it is deleted and made again with new DNS records, and mail is not authenticated until they are added and validated.`,
        changes: replace,
        preconditions: { domain: observed.fields.domain, subdomain: observed.fields.subdomain },
        risk: []
      }
    ]
  const ops: PlannedOp[] = []
  const changes = diffFields(['default'], desired.fields, observed.fields)
  if (changes.length)
    ops.push({
      kind: 'update',
      type: T_DOMAIN,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${domainWords(changes)} on ${typedName(DOMAIN_LABEL, String(observed.fields.domain ?? ''))}.`,
      changes,
      preconditions: { default: observed.fields.default },
      risk: []
    })
  if (desired.fields.validate === true) {
    const beside = ['cloudflare_records', 'route53_records'].reduce((n, k) => {
      const v = desired.refs[k]
      return n + (Array.isArray(v) ? v.filter(Boolean).length : v ? 1 : 0)
    }, 0)
    ops.push({
      kind: 'update',
      type: T_DOMAIN,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Ask SendGrid to validate ${domainText(observed.fields)}${beside ? ` against the ${beside} DNS record${beside === 1 ? '' : 's'} made beside it` : ''}. DNS can take a few minutes to show.`,
      changes: [{ field: 'validate', to: true }],
      preconditions: { domain: observed.fields.domain },
      risk: [],
      action: 'validate'
    })
  }
  return ops
}

async function createDomain(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const domain = String(desired.fields.domain ?? '')
    .trim()
    .toLowerCase()
  const subdomain = String(norm(desired.fields.subdomain) ?? 'em')
    .trim()
    .toLowerCase()
  if (!DOMAIN_RE.test(domain))
    throw new ProviderError('INVALID_FIELDS', `${domain || 'No domain'} is not a domain name.`)
  if (!LABEL_RE.test(subdomain))
    throw new ProviderError('INVALID_FIELDS', 'The link subdomain is a single DNS label.')
  if (desired.externalId) {
    const raw = await readDomainRaw(ctx, desired.externalId)
    if (raw)
      return ok(String(raw.id), domainObserved(raw), { already: 'exists' }, domainOutputs(raw))
  }
  const hit = await findDomain(ctx, domain, subdomain)
  if (hit) throw alreadyExists(`Domain authentication for ${subdomain}.${domain}`)
  const r = await sendgridCall(ctx, 'POST', '/whitelabel/domains', {
    body: {
      domain,
      subdomain,
      automatic_security: desired.fields.automatic_security !== false,
      custom_spf: false,
      default: desired.fields.default === true
    }
  })
  if (r.body?.id === undefined)
    throw new ProviderError('PROVIDER_REJECTED', 'SendGrid did not return the new domain.')
  return ok(String(r.body.id), domainObserved(r.body), { created: true }, domainOutputs(r.body))
}

async function findDomain(
  ctx: ProviderContext,
  domain: string,
  subdomain: string
): Promise<any | null> {
  let offset = 0
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await domainsPage(ctx, offset)
    const hit = page.rows.find(
      (d) =>
        String(d?.domain ?? '').toLowerCase() === domain &&
        String(d?.subdomain ?? '').toLowerCase() === subdomain
    )
    if (hit) return hit
    if (!page.next) return null
    offset += PAGE
  }
  return null
}

async function applyDomain(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'create') {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to create.')
    return createDomain(ctx, desired)
  }
  const id = op.externalId as string
  if (op.kind === 'delete') {
    await sendgridCall(ctx, 'DELETE', `/whitelabel/domains/${numSeg(id, 'domain id')}`, {
      allow: [404]
    })
    return ok(id, null)
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (op.kind === 'replace') {
    await sendgridCall(ctx, 'DELETE', `/whitelabel/domains/${numSeg(id, 'domain id')}`, {
      allow: [404]
    })
    return createDomain(ctx, { ...desired, externalId: null })
  }
  mismatch(op, desired)
  const raw = await readDomainRaw(ctx, id)
  if (!raw) throw new ProviderError('NOT_FOUND', 'The domain no longer exists.', { status: 404 })
  if (op.action === 'validate') {
    const r = await sendgridCall(
      ctx,
      'POST',
      `/whitelabel/domains/${numSeg(id, 'domain id')}/validate`
    )
    if (r.body?.valid !== true) {
      const results = r.body?.validation_results
      const failing =
        results && typeof results === 'object'
          ? Object.entries(results as Record<string, any>)
              .filter(([, v]) => v && v.valid === false)
              .map(([k]) => k)
          : []
      throw new ProviderError(
        'NOT_VALID_YET',
        `SendGrid cannot see the DNS records yet${failing.length ? ` (${failing.join(', ')})` : ''}. DNS can take a few minutes; try again.`,
        { retryable: true }
      )
    }
    const after = await readDomainRaw(ctx, id)
    return ok(id, after ? domainObserved(after) : domainObserved({ ...raw, valid: true }), {
      valid: true
    })
  }
  const seen = domainObserved(raw)
  const diff = diffFields(['default'], desired.fields, seen.fields)
  if (!diff.length) return ok(id, seen, { already: 'matches' }, domainOutputs(raw))
  await sendgridCall(ctx, 'PATCH', `/whitelabel/domains/${numSeg(id, 'domain id')}`, {
    body: { default: diff[0].to === true }
  })
  const after = await readDomainRaw(ctx, id)
  return ok(
    id,
    after ? domainObserved(after) : null,
    { changed: ['default'] },
    after ? domainOutputs(after) : undefined
  )
}

// ═══ IP access (read only) ═══

const IP_LABEL = 'IP access rule'

function ipObserved(r: any): Observed {
  return {
    type: T_IP,
    externalId: String(r.id),
    name: r.ip ?? null,
    fields: {
      ip: r.ip ?? null,
      created_at: r.created_at ?? null,
      updated_at: r.updated_at ?? null
    },
    tags: {},
    version: null,
    status: null,
    url: 'https://app.sendgrid.com/settings/access'
  }
}

const IP_FIELDS: FieldSpec[] = [
  { key: 'ip', label: 'IP address', kind: 'string', readOnly: true },
  { key: 'created_at', label: 'Added', kind: 'string', readOnly: true },
  { key: 'updated_at', label: 'Changed', kind: 'string', readOnly: true }
]

function readOnly(): ProviderError {
  return new ProviderError(
    'READ_ONLY',
    'The IP access list is read only here; change it in SendGrid.'
  )
}

// ═══ Types ═══

const TYPES: ResourceTypeSpec[] = [
  {
    key: T_KEY,
    label: KEY_LABEL,
    scope: 'app',
    nameField: 'name',
    fields: KEY_FIELDS,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: false,
    refs: [],
    outputs: [
      {
        key: 'api_key',
        label: 'API key (SMTP password)',
        secret: true,
        onceOnly: true
      },
      { key: 'smtp_host', label: 'SMTP host', secret: false },
      { key: 'smtp_port', label: 'SMTP port', secret: false },
      { key: 'smtp_user', label: 'SMTP user', secret: false }
    ],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete') out.push('destructive')
      return out
    }
  },
  {
    key: T_SENDER,
    label: SENDER_LABEL,
    scope: 'app',
    nameField: 'nickname',
    fields: SENDER_FIELDS,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: false,
    refs: [],
    outputs: [{ key: 'smtp_from', label: 'From address', secret: false }],
    sends: true,
    // Task 33: with no list of its own, the sender mails the route's audience.
    audience: 'email',
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive')
      return out
    }
  },
  {
    key: T_DOMAIN,
    label: DOMAIN_LABEL,
    scope: 'shared',
    nameField: 'domain',
    fields: DOMAIN_FIELDS,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: false,
    refs: [
      { field: 'cloudflare_records', type: 'cloudflare.dns_record', required: false },
      { field: 'route53_records', type: 'aws.route53_record', required: false }
    ],
    outputs: [{ key: 'dns_records', label: 'DNS records to add (JSON)', secret: false }],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete' || op.kind === 'replace') out.push('destructive', 'downtime')
      return out
    }
  },
  {
    key: T_IP,
    label: IP_LABEL,
    scope: 'shared',
    nameField: 'ip',
    fields: IP_FIELDS,
    capabilities: {
      create: false,
      update: false,
      delete: false,
      adopt: true,
      snapshot: false,
      tag: false
    },
    reversible: false,
    refs: [],
    risk: () => []
  }
]

// ═══ The adapter ═══

const KEY_SCOPES_NEEDED = ['api_keys.create', 'api_keys.read', 'api_keys.delete']
const DOMAIN_SCOPES_NEEDED = ['whitelabel.create', 'whitelabel.read', 'whitelabel.delete']

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function mailBody(msg: OutboundMessage): { text: string; html: string } {
  const link = msg.link && /^https:\/\//i.test(msg.link) ? msg.link : null
  const text = `${msg.body}${link ? `\n\n${link}` : ''}`
  const html = `<p>${esc(msg.body).replace(/\r?\n/g, '<br>')}</p>${
    link ? `<p><a href="${esc(link)}">Open in the Hub</a></p>` : ''
  }`
  return { text, html }
}

export const sendgridAdapter: ProviderAdapter = {
  key: 'sendgrid',
  label: 'SendGrid',
  connection: {
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'string',
        secret: true,
        required: true,
        help: 'A SendGrid API key with full access (the Hub makes narrower keys for each app). Starts with SG.'
      }
    ],
    hosts: () => ['api.sendgrid.com'],
    describe: () => 'SendGrid (api.sendgrid.com)',
    validate(_config, secrets) {
      const problems: string[] = []
      if (secrets.apiKey !== undefined && !/^SG\.\S+$/.test(secrets.apiKey.trim()))
        problems.push('The API key should start with SG. (copy the whole key).')
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const needs = (scopes: string[], reads: boolean[]) => [
      {
        type: T_KEY,
        need: `make and delete API keys (${KEY_SCOPES_NEEDED.join(', ')})`,
        has: KEY_SCOPES_NEEDED.every((s) => scopes.includes(s))
      },
      {
        type: '*',
        need: `send mail for notify routes (${MAIL_SEND})`,
        has: scopes.includes(MAIL_SEND)
      },
      {
        type: T_DOMAIN,
        need: `manage domain authentication (${DOMAIN_SCOPES_NEEDED.join(', ')})`,
        has: DOMAIN_SCOPES_NEEDED.every((s) => scopes.includes(s)) && reads[0]
      },
      { type: T_SENDER, need: 'read and make verified senders', has: reads[1] },
      {
        type: T_IP,
        need: 'read the IP access list (access_settings.whitelist.read)',
        has: reads[2]
      }
    ]
    let scopes: string[] = []
    try {
      const r = await sendgridCall(ctx, 'GET', '/scopes')
      scopes = Array.isArray(r.body?.scopes) ? r.body.scopes.map(String) : []
    } catch (err) {
      if (err instanceof ProviderError) {
        const permissions = needs([], [false, false, false])
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
    const probe = async (path: string, query?: Record<string, string | number>) => {
      try {
        const r = await sendgridCall(ctx, 'GET', path, { query, allow: [400, 401, 403, 404] })
        return r.status < 400
      } catch {
        return false
      }
    }
    const [domains, senders, ips] = await Promise.all([
      probe('/whitelabel/domains', { limit: 1 }),
      probe('/verified_senders', { limit: 1 }),
      probe('/access_settings/whitelist')
    ])
    let identity = 'SendGrid API key'
    try {
      const u = await sendgridCall(ctx, 'GET', '/user/username', { allow: [401, 403, 404] })
      if (u.status === 200 && typeof u.body?.username === 'string')
        identity = `SendGrid account ${u.body.username}`
    } catch {
      /* the identity is a courtesy */
    }
    const permissions = needs(scopes, [domains, senders, ips])
    return {
      ok: true,
      identity,
      permissions,
      missing: permissions.filter((p) => !p.has).map((p) => p.need)
    }
  },

  async observe(ctx, type, externalId) {
    if (type === T_KEY) return readKey(ctx, externalId)
    if (type === T_SENDER) return readSender(ctx, externalId)
    if (type === T_DOMAIN) {
      const raw = await readDomainRaw(ctx, externalId)
      return raw ? domainObserved(raw) : null
    }
    if (type === T_IP) {
      const r = await sendgridCall(
        ctx,
        'GET',
        `/access_settings/whitelist/${numSeg(externalId, 'rule id')}`,
        { allow: [404] }
      )
      return r.status === 404 || !r.body?.id ? null : ipObserved(r.body)
    }
    throw unknownType(type)
  },

  async list(ctx, type, cursor): Promise<ListPage> {
    if (type === T_KEY) return { items: await listKeys(ctx), cursor: null }
    if (type === T_SENDER) {
      const page = await sendersPage(ctx, cursor ?? null)
      return { items: page.rows.filter((s) => s?.id).map(senderObserved), cursor: page.last }
    }
    if (type === T_DOMAIN) {
      const offset = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0
      const page = await domainsPage(ctx, offset)
      return {
        items: page.rows.filter((d) => d?.id !== undefined).map(domainObserved),
        cursor: page.next
      }
    }
    if (type === T_IP) {
      const r = await sendgridCall(ctx, 'GET', '/access_settings/whitelist')
      const rows: any[] = Array.isArray(r.body?.result) ? r.body.result : []
      return { items: rows.filter((x) => x?.id).map(ipObserved), cursor: null }
    }
    throw unknownType(type)
  },

  /** Plan time: a key of that name, a sender for that address, a domain authentication of that name. */
  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    if (type === T_KEY) {
      const name = String(desired.fields.name ?? '').trim()
      return name ? ((await listKeys(ctx)).find((k) => k.name === name) ?? null) : null
    }
    if (type === T_SENDER) {
      const email = String(desired.fields.from_email ?? '')
        .trim()
        .toLowerCase()
      if (!email) return null
      const hit = (await allSenders(ctx)).find(
        (s) => String(s?.from_email ?? '').toLowerCase() === email
      )
      return hit ? senderObserved(hit) : null
    }
    if (type === T_DOMAIN) {
      const domain = String(desired.fields.domain ?? '')
        .trim()
        .toLowerCase()
      const sub = String(norm(desired.fields.subdomain) ?? 'em')
        .trim()
        .toLowerCase()
      if (!domain) return null
      const hit = await findDomain(ctx, domain, sub)
      return hit ? domainObserved(hit) : null
    }
    return null
  },

  plan(ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    if (type === T_KEY) return planKey(ctx, desired, observed)
    if (type === T_SENDER) return planSender(desired, observed)
    if (type === T_DOMAIN) return planDomain(desired, observed)
    if (type === T_IP) {
      if (desired && observed) return []
      throw readOnly()
    }
    throw unknownType(type)
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    if (op.type === T_KEY) return applyKey(ctx, op, desired)
    if (op.type === T_SENDER) return applySender(ctx, op, desired)
    if (op.type === T_DOMAIN) return applyDomain(ctx, op, desired)
    if (op.type === T_IP) throw readOnly()
    throw unknownType(op.type)
  },

  /** What SendGrid shows again. The key itself is once-only and never asked for. */
  async readOutputs(ctx, type, externalId) {
    if (type === T_KEY) return (await readKey(ctx, externalId)) ? { ...SMTP_OUTPUTS } : {}
    if (type === T_SENDER) {
      const seen = await readSender(ctx, externalId)
      return seen?.fields.from_email ? { smtp_from: String(seen.fields.from_email) } : {}
    }
    if (type === T_DOMAIN) {
      const raw = await readDomainRaw(ctx, externalId)
      return raw ? domainOutputs(raw) : {}
    }
    return {}
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at SendGrid.', checkedAt }
    if (type === T_KEY) {
      const scopes = Array.isArray(seen.fields.scopes) ? (seen.fields.scopes as string[]) : []
      const wider = scopes.filter((s) => s !== MAIL_SEND)
      if (wider.length)
        return {
          status: 'warn',
          message: `The key can do more than send mail (${wider.length} more permission${wider.length === 1 ? '' : 's'}).`,
          checkedAt,
          details: { scopes: scopes.length }
        }
      return { status: 'ok', checkedAt, details: { scopes: scopes.length } }
    }
    if (type === T_SENDER) {
      if (seen.fields.verified === true)
        return { status: 'ok', checkedAt, details: { verified: true } }
      return {
        status: 'warn',
        message: 'Waiting for someone to click the verification link SendGrid emailed.',
        checkedAt,
        details: { verified: false }
      }
    }
    if (type === T_DOMAIN) {
      if (seen.fields.valid === true) return { status: 'ok', checkedAt, details: { valid: true } }
      return {
        status: 'warn',
        message: 'The DNS records are not validated yet.',
        checkedAt,
        details: { valid: false }
      }
    }
    return { status: 'ok', checkedAt }
  },

  /** One email to each address on the sender's recipient list, through the mail send API. */
  async notify(ctx, resource: HubResourceRow, msg: OutboundMessage): Promise<OpResult> {
    if (resource.type !== T_SENDER || !resource.external_id)
      throw new ProviderError('NOT_A_SENDER', 'Only a verified sender sends messages.')
    // The sender's own list wins (an override); else the route's audience the engine resolved
    // (Hub administrators, or the app's owners), checked the same way.
    const own = recipientsOf(resource.desired?.recipients)
    const recipients = own.length ? own : recipientsOf(msg.recipients ?? [])
    if (!recipients.length)
      throw new ProviderError(
        'NO_RECIPIENTS',
        'Nobody to mail: the route has no one to tell and this sender has no list of its own.'
      )
    // Fresh read: a sender verified (or deleted) since the last observation decides here.
    const sender = await readSender(ctx, resource.external_id)
    if (!sender)
      throw new ProviderError('NOT_FOUND', 'The sender is gone at SendGrid.', { status: 404 })
    if (sender.fields.verified !== true)
      throw new ProviderError(
        'SENDER_NOT_VERIFIED',
        'The sender is not verified yet: SendGrid refuses mail From an unverified address.'
      )
    const tag =
      msg.severity === 'critical' ? '[Critical] ' : msg.severity === 'warning' ? '[Warning] ' : ''
    // A subject is one header line: no line breaks in it.
    const subject = `${tag}${msg.title}`.replace(/[\r\n]+/g, ' ').slice(0, 200)
    const { text, html } = mailBody(msg)
    const fromName = norm(sender.fields.from_name)
    await sendgridCall(ctx, 'POST', '/mail/send', {
      body: {
        personalizations: recipients.map((email) => ({ to: [{ email }] })),
        from: {
          email: String(sender.fields.from_email),
          ...(fromName ? { name: String(fromName) } : {})
        },
        subject,
        content: [
          { type: 'text/plain', value: text },
          { type: 'text/html', value: html }
        ],
        categories: ['nivaro-hub']
      }
    })
    return ok(resource.external_id, null, { sent: recipients.length })
  }
}
