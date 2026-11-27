import { fieldWords, typedName } from '../plan-words.js'
import type { HubResourceRow } from '../store.js'
import {
  type ConnectionTest,
  type CostRow,
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
  ACCOUNT_SID_RE,
  accountOf,
  accountPath,
  clipScrubbed,
  cursorQuery,
  E164_RE,
  httpsProblem,
  KEY_SID_RE,
  MESSAGING_ORIGIN,
  nextCursor,
  sidSeg,
  twilioCall
} from './client.js'
import { countryRefusal, smsCountries } from './countries.js'
import { TWILIO_BUNDLED, twilioNumberEstimate } from './pricing.js'

/**
 * Twilio (`twilio`): an API key (SID + secret, preferred) or the account SID + auth token. The
 * connection pins ONE account SID: every account path is built from it and every read checks the
 * answer's account. Hosts `api.twilio.com` and `messaging.twilio.com`.
 *
 * Types:
 *  - `twilio.phone_number`      buy = a monthly charge (`cost`), release = `destructive` and final.
 *  - `twilio.messaging_service` a sender pool (numbers) and a status callback (https only).
 *  - `twilio.subaccount`        shared; delete = close, which Twilio never reopens.
 *  - `twilio.api_key`           per app; the secret is an output shown once (rotate to get another).
 *
 * Outputs (the engine seals them and pushes bound ones into the app's SMS settings): a number gives
 * `phone_number` (→ sms_from) and `account_sid` (→ sms_account_sid); a key gives `sid` and the
 * once-only `secret` (→ sms_auth_token, a credential setting); a service gives its SID.
 * Notify: a number or a messaging service sends an SMS to its `notify_numbers`, critical events
 * only unless `critical_only` is turned off.
 */

const T_NUMBER = 'twilio.phone_number'
const T_SERVICE = 'twilio.messaging_service'
const T_SUB = 'twilio.subaccount'
const T_KEY = 'twilio.api_key'

const E164_SRC = E164_RE.source
const MAX_NOTIFY_NUMBERS = 10
/** A number bought by an interrupted run is recognised for this long (by name + age). */
const RESUME_WINDOW_MS = 10 * 60 * 1000
const MAX_SERVICE_SCAN = 100

// ── Small helpers ──

function norm(v: unknown): unknown {
  return v === '' || v === undefined ? null : v
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function diffFields(
  keys: string[],
  want: Record<string, unknown>,
  have: Record<string, unknown>
): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of keys) {
    if (want[k] === undefined) continue
    if (norm(want[k]) !== norm(have[k]))
      out.push({ field: k, from: norm(have[k]), to: norm(want[k]) })
  }
  return out
}

function alreadyExists(what: string, name: string): ProviderError {
  return new ProviderError(
    'ALREADY_EXISTS',
    `${what} ${name} already exists at Twilio. Adopt it instead of creating it.`
  )
}

function invalid(msg: string): ProviderError {
  return new ProviderError('INVALID_FIELDS', msg)
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

/** What a person typed into a field, as a list of trimmed strings. */
function listOf(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []
}

function sameSet(a: string[], b: string[]): boolean {
  const x = [...new Set(a)].sort()
  const y = [...new Set(b)].sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** The provider ids a ref-list field resolved to; null while some are not created yet. */
function refIds(desired: DesiredResource, field: string): string[] | null {
  const v = desired.refs[field]
  if (v == null) {
    const f = desired.fields[field]
    return Array.isArray(f) && f.length === 0 ? [] : null
  }
  const arr = Array.isArray(v) ? v : [v]
  if (arr.some((x) => typeof x !== 'string' || !x)) return null
  return arr as string[]
}

function consoleUrl(path: string): string {
  return `https://console.twilio.com/${path}`
}

// ── Validation (plan and apply) ──

function validateFields(
  type: string,
  f: Record<string, unknown>,
  config: Record<string, unknown>
): void {
  const url = (label: string, v: unknown) => {
    const p = httpsProblem(label, v)
    if (p) throw invalid(p)
  }
  const notify = () => {
    const nums = listOf(f.notify_numbers)
    if (nums.length > MAX_NOTIFY_NUMBERS)
      throw invalid(`At most ${MAX_NOTIFY_NUMBERS} numbers get notifications.`)
    const allowed = smsCountries(config)
    for (const n of nums) {
      if (!E164_RE.test(n)) throw invalid(`${n} is not a phone number written with +country.`)
      const why = countryRefusal(n, allowed)
      if (why) throw new ProviderError('COUNTRY_NOT_ALLOWED', why)
    }
  }
  if (type === T_NUMBER) {
    const n = str(f.phone_number)
    if (n && !E164_RE.test(n))
      throw invalid('The phone number is written +, the country code and the number, digits only.')
    const a = str(f.area_code)
    if (a && !/^\d{3}$/.test(a)) throw invalid('An area code is three digits.')
    const c = str(f.country)
    if (c && !/^[A-Z]{2}$/.test(c)) throw invalid('The country is a two-letter code such as US.')
    url('The SMS webhook', f.sms_url)
    url('The status callback', f.status_callback)
    notify()
  }
  if (type === T_SERVICE) {
    url('The status callback', f.status_callback)
    notify()
  }
}

// ── Phone numbers ──

function numberObserved(n: any): Observed {
  const sid = String(n.sid)
  return {
    type: T_NUMBER,
    externalId: sid,
    name: n.friendly_name ?? n.phone_number ?? null,
    fields: {
      name: n.friendly_name ?? null,
      phone_number: n.phone_number ?? null,
      sms_url: norm(n.sms_url),
      status_callback: norm(n.status_callback),
      sms_capable: n.capabilities?.sms === true
    },
    tags: {},
    version: null,
    status: null,
    url: consoleUrl(`us1/develop/phone-numbers/manage/incoming/${sid}/configure`)
  }
}

const numberOutputs = (ctx: ProviderContext, n: any): Record<string, string> => ({
  ...(typeof n?.phone_number === 'string' && n.phone_number
    ? { phone_number: n.phone_number }
    : {}),
  account_sid: accountOf(ctx)
})

async function numberRaw(ctx: ProviderContext, id: string): Promise<any | null> {
  const r = await twilioCall(
    ctx,
    'GET',
    accountPath(ctx, `/IncomingPhoneNumbers/${sidSeg('PN', id, 'phone number id')}.json`),
    { allow: [404] }
  )
  if (r.status === 404 || !r.body || typeof r.body !== 'object') return null
  if (r.body.account_sid !== accountOf(ctx)) return null
  return r.body
}

async function numberPage(
  ctx: ProviderContext,
  query: Record<string, string | number | undefined> = {}
): Promise<{ items: any[]; cursor: string | null }> {
  const r = await twilioCall(ctx, 'GET', accountPath(ctx, '/IncomingPhoneNumbers.json'), {
    query: { PageSize: 50, ...query }
  })
  const items = (r.body?.incoming_phone_numbers ?? []).filter(
    (n: any) => n?.account_sid === accountOf(ctx)
  )
  return { items, cursor: nextCursor(r.body) }
}

/** The services whose pool holds this number (scans up to MAX_SERVICE_SCAN services). */
async function servicesHolding(ctx: ProviderContext, numberSid: string): Promise<string[]> {
  const hits: string[] = []
  let scanned = 0
  let cursor: string | null = null
  do {
    const page: any = await twilioCall(ctx, 'GET', '/v1/Services', {
      origin: MESSAGING_ORIGIN,
      query: { PageSize: 50, ...cursorQuery(cursor) }
    })
    for (const s of page.body?.services ?? []) {
      if (s?.account_sid !== accountOf(ctx)) continue
      scanned++
      const pool = await poolOf(ctx, String(s.sid))
      if (pool.includes(numberSid)) hits.push(String(s.sid))
    }
    cursor = nextCursor(page.body)
    if (cursor && scanned >= MAX_SERVICE_SCAN)
      throw new ProviderError(
        'IN_USE_UNCHECKED',
        'There are more than 100 messaging services, so the Hub cannot tell whether one still uses this number. Check in Twilio first.'
      )
  } while (cursor)
  return hits
}

async function searchAvailable(
  ctx: ProviderContext,
  country: string,
  type: string,
  areaCode: string | null
): Promise<string | null> {
  const kind = type === 'toll_free' ? 'TollFree' : 'Local'
  const r = await twilioCall(
    ctx,
    'GET',
    accountPath(ctx, `/AvailablePhoneNumbers/${country}/${kind}.json`),
    { query: { SmsEnabled: 'true', PageSize: 1, ...(areaCode ? { AreaCode: areaCode } : {}) } }
  )
  const first = r.body?.available_phone_numbers?.[0]?.phone_number
  return typeof first === 'string' && E164_RE.test(first) ? first : null
}

async function createNumber(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  validateFields(T_NUMBER, desired.fields, ctx.config)
  const name = str(desired.fields.name)
  if (!name) throw invalid('The phone number needs a name.')
  if (desired.externalId) {
    const raw = await numberRaw(ctx, desired.externalId)
    if (raw)
      return ok(
        String(raw.sid),
        numberObserved(raw),
        { already: 'exists' },
        numberOutputs(ctx, raw)
      )
  }
  const wanted = str(desired.fields.phone_number)
  const area = str(desired.fields.area_code)
  if (!wanted && !area) throw invalid('Name the number to buy, or an area code to search in.')
  let number = wanted
  if (wanted) {
    const held = await numberPage(ctx, { PhoneNumber: wanted })
    if (held.items.length) throw alreadyExists('The number', wanted)
  } else {
    // A run that bought a number and stopped before recording it: same name, bought minutes ago.
    const recent = (await numberPage(ctx, { FriendlyName: name })).items.find((n: any) => {
      const made = Date.parse(String(n.date_created ?? ''))
      return Number.isFinite(made) && ctx.now().getTime() - made <= RESUME_WINDOW_MS
    })
    if (recent)
      return ok(
        String(recent.sid),
        numberObserved(recent),
        { already: 'bought' },
        numberOutputs(ctx, recent)
      )
    number = await searchAvailable(
      ctx,
      str(desired.fields.country) ?? 'US',
      String(desired.fields.number_type ?? 'local'),
      area
    )
    if (!number)
      throw new ProviderError(
        'NO_NUMBER_AVAILABLE',
        `Twilio has no number available in area code ${area}. Try another area code.`
      )
  }
  const r = await twilioCall(ctx, 'POST', accountPath(ctx, '/IncomingPhoneNumbers.json'), {
    form: {
      PhoneNumber: number as string,
      FriendlyName: name,
      SmsUrl: str(desired.fields.sms_url) ?? undefined,
      StatusCallback: str(desired.fields.status_callback) ?? undefined
    }
  })
  if (!r.body?.sid)
    throw new ProviderError('PROVIDER_REJECTED', 'Twilio did not return the new number.')
  return ok(
    String(r.body.sid),
    numberObserved(r.body),
    { created: true },
    numberOutputs(ctx, r.body)
  )
}

async function releaseNumber(ctx: ProviderContext, id: string): Promise<void> {
  const sid = sidSeg('PN', id, 'phone number id')
  const raw = await numberRaw(ctx, sid)
  if (!raw) return
  const holders = await servicesHolding(ctx, sid)
  if (holders.length)
    throw new ProviderError(
      'IN_USE',
      `This number is still in the sender pool of messaging service ${holders[0]}. Take it out of the pool first.`
    )
  await twilioCall(ctx, 'DELETE', accountPath(ctx, `/IncomingPhoneNumbers/${sid}.json`), {
    allow: [404]
  })
}

const NUMBER_WRITABLE = ['name', 'sms_url', 'status_callback']
const NUMBER_FORM: Record<string, string> = {
  name: 'FriendlyName',
  sms_url: 'SmsUrl',
  status_callback: 'StatusCallback'
}

async function updateNumber(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource
): Promise<OpResult> {
  validateFields(T_NUMBER, desired.fields, ctx.config)
  const id = op.externalId as string
  const raw = await numberRaw(ctx, id)
  if (!raw) throw new ProviderError('NOT_FOUND', 'The number no longer exists.', { status: 404 })
  const seen = numberObserved(raw)
  const diff = diffFields(NUMBER_WRITABLE, desired.fields, seen.fields)
  if (!diff.length) return ok(id, seen, { already: 'matches' }, numberOutputs(ctx, raw))
  const form: Record<string, string> = {}
  for (const c of diff) form[NUMBER_FORM[c.field]] = String(c.to ?? '')
  await twilioCall(
    ctx,
    'POST',
    accountPath(ctx, `/IncomingPhoneNumbers/${sidSeg('PN', id, 'phone number id')}.json`),
    { form }
  )
  const after = await numberRaw(ctx, id)
  return ok(
    id,
    after ? numberObserved(after) : null,
    { changed: diff.map((c) => c.field) },
    after ? numberOutputs(ctx, after) : undefined
  )
}

// ── Messaging services ──

function serviceObserved(s: any, numbers: string[]): Observed {
  const sid = String(s.sid)
  return {
    type: T_SERVICE,
    externalId: sid,
    name: s.friendly_name ?? null,
    fields: {
      name: s.friendly_name ?? null,
      status_callback: norm(s.status_callback),
      numbers: [...numbers].sort()
    },
    tags: {},
    version: null,
    status: null,
    url: consoleUrl(`us1/develop/sms/services/${sid}`)
  }
}

async function poolOf(ctx: ProviderContext, serviceSid: string): Promise<string[]> {
  const out: string[] = []
  let cursor: string | null = null
  do {
    const r: any = await twilioCall(
      ctx,
      'GET',
      `/v1/Services/${sidSeg('MG', serviceSid, 'messaging service id')}/PhoneNumbers`,
      { origin: MESSAGING_ORIGIN, query: { PageSize: 100, ...cursorQuery(cursor) }, allow: [404] }
    )
    if (r.status === 404) return out
    for (const p of r.body?.phone_numbers ?? []) if (p?.sid) out.push(String(p.sid))
    cursor = nextCursor(r.body)
  } while (cursor && out.length < 1000)
  return out
}

async function serviceRaw(ctx: ProviderContext, id: string): Promise<any | null> {
  const r = await twilioCall(
    ctx,
    'GET',
    `/v1/Services/${sidSeg('MG', id, 'messaging service id')}`,
    { origin: MESSAGING_ORIGIN, allow: [404] }
  )
  if (r.status === 404 || !r.body || typeof r.body !== 'object') return null
  if (r.body.account_sid !== accountOf(ctx)) return null
  return r.body
}

async function readService(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const raw = await serviceRaw(ctx, id)
  return raw ? serviceObserved(raw, await poolOf(ctx, id)) : null
}

async function servicePage(
  ctx: ProviderContext,
  cursor?: string | null
): Promise<{ items: any[]; cursor: string | null }> {
  const r = await twilioCall(ctx, 'GET', '/v1/Services', {
    origin: MESSAGING_ORIGIN,
    query: { PageSize: 50, ...cursorQuery(cursor) }
  })
  return {
    items: (r.body?.services ?? []).filter((s: any) => s?.account_sid === accountOf(ctx)),
    cursor: nextCursor(r.body)
  }
}

async function findServiceByName(ctx: ProviderContext, name: string): Promise<any | null> {
  let cursor: string | null = null
  let pages = 0
  do {
    const page = await servicePage(ctx, cursor)
    const hit = page.items.find((s: any) => s.friendly_name === name)
    if (hit) return hit
    cursor = page.cursor
  } while (cursor && ++pages < 10)
  return null
}

async function setPool(ctx: ProviderContext, serviceSid: string, want: string[]): Promise<void> {
  const base = `/v1/Services/${sidSeg('MG', serviceSid, 'messaging service id')}/PhoneNumbers`
  const have = await poolOf(ctx, serviceSid)
  for (const sid of want.filter((s) => !have.includes(s)))
    await twilioCall(ctx, 'POST', base, {
      origin: MESSAGING_ORIGIN,
      form: { PhoneNumberSid: sidSeg('PN', sid, 'phone number id') }
    })
  for (const sid of have.filter((s) => !want.includes(s)))
    await twilioCall(ctx, 'DELETE', `${base}/${sidSeg('PN', sid, 'phone number id')}`, {
      origin: MESSAGING_ORIGIN,
      allow: [404]
    })
}

async function createService(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  validateFields(T_SERVICE, desired.fields, ctx.config)
  const name = str(desired.fields.name)
  if (!name) throw invalid('The messaging service needs a name.')
  const want = refIds(desired, 'numbers') ?? []
  if (desired.externalId) {
    const seen = await readService(ctx, desired.externalId)
    if (seen) {
      await setPool(ctx, desired.externalId, want)
      return ok(
        seen.externalId,
        await readService(ctx, seen.externalId),
        { already: 'exists' },
        {
          messaging_service_sid: seen.externalId
        }
      )
    }
  }
  if (await findServiceByName(ctx, name)) throw alreadyExists('A messaging service named', name)
  const r = await twilioCall(ctx, 'POST', '/v1/Services', {
    origin: MESSAGING_ORIGIN,
    form: {
      FriendlyName: name,
      StatusCallback: str(desired.fields.status_callback) ?? undefined
    }
  })
  const sid = r.body?.sid
  if (!sid)
    throw new ProviderError('PROVIDER_REJECTED', 'Twilio did not return the new messaging service.')
  await setPool(ctx, String(sid), want)
  return ok(
    String(sid),
    await readService(ctx, String(sid)),
    { created: true },
    {
      messaging_service_sid: String(sid)
    }
  )
}

async function updateService(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource
): Promise<OpResult> {
  validateFields(T_SERVICE, desired.fields, ctx.config)
  const id = op.externalId as string
  const raw = await serviceRaw(ctx, id)
  if (!raw)
    throw new ProviderError('NOT_FOUND', 'The messaging service no longer exists.', { status: 404 })
  const pool = await poolOf(ctx, id)
  const seen = serviceObserved(raw, pool)
  const diff = diffFields(['name', 'status_callback'], desired.fields, seen.fields)
  if (diff.length) {
    const form: Record<string, string> = {}
    for (const c of diff)
      form[c.field === 'name' ? 'FriendlyName' : 'StatusCallback'] = String(c.to ?? '')
    await twilioCall(ctx, 'POST', `/v1/Services/${sidSeg('MG', id, 'messaging service id')}`, {
      origin: MESSAGING_ORIGIN,
      form
    })
  }
  const want = refIds(desired, 'numbers')
  const poolChanged = want !== null && !sameSet(want, pool)
  if (want !== null && poolChanged) await setPool(ctx, id, want)
  return ok(
    id,
    await readService(ctx, id),
    diff.length || poolChanged
      ? { changed: [...diff.map((c) => c.field), ...(poolChanged ? ['numbers'] : [])] }
      : { already: 'matches' },
    { messaging_service_sid: id }
  )
}

// ── API keys ──

const KEY_ID_RE = /^(AC[0-9a-f]{32})\/(SK[0-9a-f]{32})$/

/** A key's provider id: `SK…` in the connection's own account, `AC…/SK…` in one of its subaccounts. */
function parseKeyId(id: string): { account: string | null; sid: string } {
  const m = KEY_ID_RE.exec(id)
  if (m) return { account: m[1], sid: m[2] }
  return { account: null, sid: sidSeg('SK', id, 'API key id') }
}

function keyObserved(k: any, account: string | null): Observed {
  const sid = String(k.sid)
  return {
    type: T_KEY,
    externalId: account ? `${account}/${sid}` : sid,
    name: k.friendly_name ?? null,
    fields: { name: k.friendly_name ?? null, subaccount: account },
    tags: {},
    version: null,
    status: null,
    url: consoleUrl('us1/account/keys-credentials/api-keys')
  }
}

/** The path of an account's keys; a subaccount must be one of this connection's own. */
async function keyBase(ctx: ProviderContext, account: string | null): Promise<string> {
  if (!account || account === accountOf(ctx)) return accountPath(ctx, '/Keys')
  const sub = await subRaw(ctx, account)
  if (!sub)
    throw new ProviderError(
      'TWILIO_OUT_OF_ACCOUNT',
      'That subaccount is not one of this connection’s subaccounts.'
    )
  return `/2010-04-01/Accounts/${sidSeg('AC', account, 'account id')}/Keys`
}

async function keyRaw(ctx: ProviderContext, id: string): Promise<any | null> {
  const { account, sid } = parseKeyId(id)
  const base = await keyBase(ctx, account)
  const r = await twilioCall(ctx, 'GET', `${base}/${sid}.json`, { allow: [404] })
  return r.status === 404 || !r.body || typeof r.body !== 'object' ? null : r.body
}

async function keyPage(
  ctx: ProviderContext,
  cursor?: string | null,
  account: string | null = null
): Promise<{ items: any[]; cursor: string | null }> {
  const r = await twilioCall(ctx, 'GET', `${await keyBase(ctx, account)}.json`, {
    query: { PageSize: 50, ...cursorQuery(cursor) }
  })
  return { items: r.body?.keys ?? [], cursor: nextCursor(r.body) }
}

async function keysNamed(
  ctx: ProviderContext,
  name: string,
  account: string | null = null
): Promise<any[]> {
  const out: any[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const page = await keyPage(ctx, cursor, account)
    out.push(...page.items.filter((k: any) => k.friendly_name === name))
    cursor = page.cursor
  } while (cursor && ++pages < 10)
  return out
}

async function findKeyByName(
  ctx: ProviderContext,
  name: string,
  account: string | null = null
): Promise<any | null> {
  return (await keysNamed(ctx, name, account))[0] ?? null
}

function refuseOwnKey(ctx: ProviderContext, sid: string): void {
  if (String(ctx.config.keySid ?? '').trim() === sid)
    throw new ProviderError(
      'OWN_KEY',
      'This is the API key the Hub connects with. Use another connection to change or remove it.'
    )
}

/** The subaccount an app key is made in: the resolved ref, or null for the main account. */
function keyAccountOf(desired: DesiredResource): string | null {
  const ref = desired.refs.subaccount
  if (typeof ref === 'string' && ref) return sidSeg('AC', ref, 'account id')
  if (desired.fields.subaccount) throw invalid('The subaccount for this key is not created yet.')
  return null
}

async function makeKey(
  ctx: ProviderContext,
  name: string,
  account: string | null
): Promise<{ made: any; out: OpResult }> {
  const r = await twilioCall(ctx, 'POST', `${await keyBase(ctx, account)}.json`, {
    form: { FriendlyName: name }
  })
  const made = r.body
  if (!made?.sid || typeof made.secret !== 'string')
    throw new ProviderError('PROVIDER_REJECTED', 'Twilio did not return the new API key.')
  const observed = keyObserved(made, account)
  return {
    made,
    out: ok(
      observed.externalId,
      observed,
      { created: true },
      { sid: String(made.sid), account_sid: account ?? accountOf(ctx), secret: made.secret }
    )
  }
}

async function createKey(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const name = str(desired.fields.name)
  if (!name) throw invalid('The API key needs a name.')
  const account = keyAccountOf(desired)
  if (desired.externalId) {
    const raw = await keyRaw(ctx, desired.externalId)
    // The secret was shown once with the create: a resumed run cannot show it again.
    if (raw)
      return ok(desired.externalId, keyObserved(raw, parseKeyId(desired.externalId).account), {
        already: 'exists'
      })
  }
  if (await findKeyByName(ctx, name, account)) throw alreadyExists('An API key named', name)
  return (await makeKey(ctx, name, account)).out
}

const ROTATING = ' (rotating)'

/**
 * Rotation never leaves two working keys behind and never hides a failure. The new key is made
 * under a marker name, then the old one is removed (404 = already gone). If the old key cannot be
 * removed, the new key is taken back and the step FAILS (retryable) naming the old key: its
 * secret was never handed over, so nothing is lost and a retry starts clean. A marker key a
 * stopped run left behind is removed first, so a retry never makes the new key twice. Only when
 * the old key is gone is the new key renamed to the real name.
 */
async function rotateKey(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource
): Promise<OpResult> {
  const { account, sid } = parseKeyId(op.externalId as string)
  refuseOwnKey(ctx, sid)
  const base = await keyBase(ctx, account)
  const current = await keyRaw(ctx, op.externalId as string)
  if (!current)
    throw new ProviderError('NOT_FOUND', 'The API key no longer exists.', { status: 404 })
  const name = str(current.friendly_name) ?? str(desired.fields.name) ?? 'nivaro-hub'
  const marker = `${name}${ROTATING}`
  for (const stale of await keysNamed(ctx, marker, account))
    await twilioCall(ctx, 'DELETE', `${base}/${sidSeg('SK', stale.sid, 'API key id')}.json`, {
      allow: [404]
    })
  const { made } = await makeKey(ctx, marker, account)
  try {
    await twilioCall(ctx, 'DELETE', `${base}/${sid}.json`, { allow: [404] })
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err
    let takenBack = true
    try {
      await twilioCall(ctx, 'DELETE', `${base}/${sidSeg('SK', made.sid, 'API key id')}.json`, {
        allow: [404]
      })
    } catch (e2) {
      if (!(e2 instanceof ProviderError)) throw e2
      takenBack = false
    }
    return {
      ok: false,
      externalId: op.externalId,
      observed: null,
      answer: { oldKeySid: sid, newKeyTakenBack: takenBack },
      error: {
        code: 'OLD_KEY_NOT_REMOVED',
        message: clipScrubbed(
          ctx,
          `The old API key ${sid} could not be removed (${err.message}). ${
            takenBack
              ? 'The new key was taken back; run the rotation again.'
              : 'The new key could not be taken back either; a retry removes it first.'
          }`
        ),
        retryable: true,
        ...(err.status ? { status: err.status } : {})
      }
    }
  }
  let finalName = marker
  try {
    await twilioCall(ctx, 'POST', `${base}/${sidSeg('SK', made.sid, 'API key id')}.json`, {
      form: { FriendlyName: name }
    })
    finalName = name
  } catch (err) {
    // The old key is already gone and the secret must be handed over: a failed rename only
    // leaves the marker name, which the next plan shows and renames.
    if (!(err instanceof ProviderError)) throw err
  }
  const observed = keyObserved({ ...made, friendly_name: finalName }, account)
  return ok(
    observed.externalId,
    observed,
    { rotated: true, replaced: sid },
    { sid: String(made.sid), account_sid: account ?? accountOf(ctx), secret: made.secret }
  )
}

// ── Subaccounts ──

function subObserved(a: any): Observed {
  const sid = String(a.sid)
  return {
    type: T_SUB,
    externalId: sid,
    name: a.friendly_name ?? null,
    fields: { name: a.friendly_name ?? null, status: a.status ?? null },
    tags: {},
    version: null,
    status: a.status ?? null,
    url: consoleUrl('us1/account/subaccounts')
  }
}

async function subRaw(ctx: ProviderContext, id: string): Promise<any | null> {
  const sid = sidSeg('AC', id, 'account id')
  if (sid === accountOf(ctx))
    throw new ProviderError(
      'TWILIO_OUT_OF_ACCOUNT',
      'That is the connection’s own account, not a subaccount of it.'
    )
  const r = await twilioCall(ctx, 'GET', `/2010-04-01/Accounts/${sid}.json`, { allow: [404] })
  if (r.status === 404 || !r.body || typeof r.body !== 'object') return null
  if (r.body.owner_account_sid !== accountOf(ctx)) return null
  if (String(r.body.status).toLowerCase() === 'closed') return null
  return r.body
}

async function subPage(
  ctx: ProviderContext,
  cursor?: string | null,
  name?: string
): Promise<{ items: any[]; cursor: string | null }> {
  const r = await twilioCall(ctx, 'GET', '/2010-04-01/Accounts.json', {
    query: { PageSize: 50, ...(name ? { FriendlyName: name } : {}), ...cursorQuery(cursor) }
  })
  return {
    items: (r.body?.accounts ?? []).filter(
      (a: any) =>
        a?.owner_account_sid === accountOf(ctx) &&
        a?.sid !== accountOf(ctx) &&
        String(a?.status).toLowerCase() !== 'closed'
    ),
    cursor: nextCursor(r.body)
  }
}

async function createSub(ctx: ProviderContext, desired: DesiredResource): Promise<OpResult> {
  const name = str(desired.fields.name)
  if (!name) throw invalid('The subaccount needs a name.')
  if (desired.externalId) {
    const raw = await subRaw(ctx, desired.externalId)
    if (raw) return ok(String(raw.sid), subObserved(raw), { already: 'exists' })
  }
  if ((await subPage(ctx, null, name)).items.some((a: any) => a.friendly_name === name))
    throw alreadyExists('A subaccount named', name)
  const r = await twilioCall(ctx, 'POST', '/2010-04-01/Accounts.json', {
    form: { FriendlyName: name }
  })
  if (!r.body?.sid)
    throw new ProviderError('PROVIDER_REJECTED', 'Twilio did not return the new subaccount.')
  // The new subaccount's own auth token is in this answer: it is never read, kept or returned.
  return ok(String(r.body.sid), subObserved(r.body), { created: true })
}

async function updateSub(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource
): Promise<OpResult> {
  const id = op.externalId as string
  const raw = await subRaw(ctx, id)
  if (!raw)
    throw new ProviderError('NOT_FOUND', 'The subaccount no longer exists.', { status: 404 })
  const seen = subObserved(raw)
  const diff = diffFields(['name', 'status'], desired.fields, seen.fields)
  if (!diff.length) return ok(id, seen, { already: 'matches' })
  const form: Record<string, string> = {}
  for (const c of diff) {
    if (c.field === 'name') form.FriendlyName = String(c.to ?? '')
    else {
      const s = String(c.to ?? '')
      if (s !== 'active' && s !== 'suspended')
        throw invalid('A subaccount is active or suspended; closing it is a delete.')
      form.Status = s
    }
  }
  await twilioCall(ctx, 'POST', `/2010-04-01/Accounts/${sidSeg('AC', id, 'account id')}.json`, {
    form
  })
  const after = await subRaw(ctx, id)
  return ok(id, after ? subObserved(after) : null, { changed: diff.map((c) => c.field) })
}

async function closeSub(ctx: ProviderContext, id: string): Promise<void> {
  const raw = await subRaw(ctx, id)
  if (!raw) return
  await twilioCall(ctx, 'POST', `/2010-04-01/Accounts/${sidSeg('AC', id, 'account id')}.json`, {
    form: { Status: 'closed' }
  })
}

// ── Planning ──

interface PlanCfg {
  type: string
  label: string
  /** Fields sent on a create, in order. */
  create: string[]
  writable: string[]
  replace?: string[]
  fields: FieldSpec[]
  createNote?: string
  deleteNote: string
  replaceNote?: string
  /** More changes the diff cannot see (a pool of numbers). */
  extra?: (desired: DesiredResource, observed: Observed) => FieldChange[]
}

function planOf(
  cfg: PlanCfg,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  const words = (c: Array<{ field: string }>) => fieldWords(cfg.fields, c)
  if (!desired) {
    if (!observed) return []
    return [
      {
        kind: 'delete',
        type: cfg.type,
        resourceId: null,
        externalId: observed.externalId,
        reason: `${cfg.deleteNote.replace('{name}', typedName(cfg.label, observed.name))}`,
        changes: [],
        preconditions: { name: observed.fields.name ?? null },
        risk: []
      }
    ]
  }
  if (!observed)
    return [
      {
        kind: 'create',
        type: cfg.type,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(cfg.label, String(desired.fields.name ?? ''))}.${cfg.createNote ?? ''}`,
        changes: cfg.create
          .filter((k) => norm(desired.fields[k]) !== null)
          .map((k) => ({ field: k, to: desired.fields[k] })),
        preconditions: {},
        risk: []
      }
    ]
  const replace = cfg.replace ? diffFields(cfg.replace, desired.fields, observed.fields) : []
  if (replace.length)
    return [
      {
        kind: 'replace',
        type: cfg.type,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason:
          `Replace ${typedName(cfg.label, observed.name)}: ${words(replace)} cannot change in place. ${cfg.replaceNote ?? ''}`.trim(),
        changes: replace,
        preconditions: Object.fromEntries(cfg.replace?.map((k) => [k, observed.fields[k]]) ?? []),
        risk: []
      }
    ]
  const changes = [
    ...diffFields(cfg.writable, desired.fields, observed.fields),
    ...(cfg.extra?.(desired, observed) ?? [])
  ]
  if (!changes.length) return []
  const pre: Record<string, unknown> = {}
  for (const c of changes) pre[c.field] = c.from ?? null
  return [
    {
      kind: 'update',
      type: cfg.type,
      resourceId: desired.resourceId,
      externalId: observed.externalId,
      reason: `Change ${words(changes)} on ${typedName(cfg.label, observed.name)}.`,
      changes,
      preconditions: pre,
      risk: []
    }
  ]
}

// ── Field specs ──

const NOTIFY_FIELDS: FieldSpec[] = [
  {
    key: 'notify_numbers',
    label: 'Notify these numbers',
    kind: 'list',
    items: { key: 'n', label: 'Phone number', kind: 'string', pattern: `^${E164_SRC}$` },
    help: 'Hub events routed here are texted to these numbers (at most 10, written +15551234567).'
  },
  {
    key: 'critical_only',
    label: 'Critical events only',
    kind: 'boolean',
    default: true,
    help: 'Text only events marked critical (failed deploys, incidents, failed backups). Turn off to text everything routed here.'
  }
]

const NUMBER_FIELDS: FieldSpec[] = [
  {
    key: 'name',
    label: 'Name',
    kind: 'string',
    required: true,
    pattern: '^.{1,64}$',
    help: 'Twilio’s friendly name for the number.'
  },
  {
    key: 'phone_number',
    label: 'Phone number',
    kind: 'string',
    pattern: `^${E164_SRC}$`,
    replaceOnChange: true,
    help: 'The number to buy, written +15551234567. Leave empty to buy the first one found in the area code. Changing it releases this number and buys another.'
  },
  {
    key: 'country',
    label: 'Country',
    kind: 'string',
    createOnly: true,
    default: 'US',
    pattern: '^[A-Z]{2}$',
    help: 'Two-letter country code to search in when no number is given.'
  },
  {
    key: 'number_type',
    label: 'Number type',
    kind: 'enum',
    createOnly: true,
    default: 'local',
    options: [
      { value: 'local', label: 'Local' },
      { value: 'toll_free', label: 'Toll-free' }
    ]
  },
  {
    key: 'area_code',
    label: 'Area code',
    kind: 'string',
    createOnly: true,
    pattern: '^\\d{3}$',
    help: 'Search for a number in this area code when no number is given.'
  },
  {
    key: 'sms_url',
    label: 'SMS webhook',
    kind: 'string',
    help: 'https only. Where Twilio sends texts people send to this number.'
  },
  { key: 'status_callback', label: 'Status callback', kind: 'string', help: 'https only.' },
  { key: 'sms_capable', label: 'Can text', kind: 'boolean', readOnly: true },
  ...NOTIFY_FIELDS
]

const SERVICE_FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Name', kind: 'string', required: true, pattern: '^.{1,64}$' },
  {
    key: 'status_callback',
    label: 'Status callback',
    kind: 'string',
    help: 'https only. Twilio posts delivery status of messages sent through the service here.'
  },
  {
    key: 'numbers',
    label: 'Sender numbers',
    kind: 'list',
    items: { key: 'n', label: 'Phone number', kind: 'ref', refType: T_NUMBER },
    help: 'The sender pool. A number stays in the pool until it is taken out here.'
  },
  ...NOTIFY_FIELDS
]

const KEY_FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Name', kind: 'string', required: true, pattern: '^.{1,64}$' },
  {
    key: 'subaccount',
    label: 'Subaccount',
    kind: 'ref',
    refType: T_SUB,
    createOnly: true,
    help: 'The key is made inside this subaccount, so it can only reach what that subaccount holds. Without one the key belongs to the main account and can do anything on it: only a Hub administrator may start that.'
  },
  {
    key: ROTATE_OUTPUTS_FIELD,
    label: 'Rotate the secret',
    kind: 'boolean',
    trigger: true,
    help: 'Makes a new key and removes this one. The old secret stops working at once; bound settings get the new one.'
  }
]

const SUB_FIELDS: FieldSpec[] = [
  { key: 'name', label: 'Name', kind: 'string', required: true, pattern: '^.{1,64}$' },
  {
    key: 'status',
    label: 'Status',
    kind: 'enum',
    default: 'active',
    options: [
      { value: 'active', label: 'Active' },
      { value: 'suspended', label: 'Suspended' }
    ],
    help: 'A suspended subaccount cannot send or receive. Closing it is a delete and cannot be undone.'
  }
]

const NUMBER_CFG: PlanCfg = {
  type: T_NUMBER,
  label: 'Twilio phone number',
  create: [
    'name',
    'phone_number',
    'area_code',
    'country',
    'number_type',
    'sms_url',
    'status_callback'
  ],
  writable: NUMBER_WRITABLE,
  replace: ['phone_number'],
  fields: NUMBER_FIELDS,
  createNote:
    ' Twilio charges a monthly rental plus per-message usage from the moment it is bought, until it is released.',
  deleteNote:
    'Release {name}: the number goes back to Twilio and cannot be got back, and nobody can text it any more. It is refused while a messaging service pool still holds it.',
  replaceNote:
    'The current number is released (final, it cannot be got back) and another is bought at the monthly rental.'
}

const SERVICE_CFG: PlanCfg = {
  type: T_SERVICE,
  label: 'messaging service',
  create: ['name', 'status_callback'],
  writable: ['name', 'status_callback'],
  fields: SERVICE_FIELDS,
  createNote: ' Its sender pool is filled from the numbers listed.',
  deleteNote: 'Delete {name} and its sender pool setup. The numbers in it are kept.',
  extra(desired, observed) {
    const want = refIds(desired, 'numbers')
    if (want === null) return []
    const have = listOf(observed.fields.numbers)
    return sameSet(want, have) ? [] : [{ field: 'numbers', from: have, to: want }]
  }
}

const KEY_CFG: PlanCfg = {
  type: T_KEY,
  label: 'Twilio API key',
  create: ['name'],
  writable: ['name'],
  fields: KEY_FIELDS,
  createNote: ' Its secret is shown once, and the Hub seals it.',
  deleteNote: 'Delete {name}: anything signing in with it stops working at once.'
}

const SUB_CFG: PlanCfg = {
  type: T_SUB,
  label: 'Twilio subaccount',
  create: ['name'],
  writable: ['name', 'status'],
  fields: SUB_FIELDS,
  deleteNote:
    'Close {name}: Twilio closes the subaccount for good (its numbers and logs go with it) and it cannot be reopened.'
}

const CFGS: Record<string, PlanCfg> = {
  [T_NUMBER]: NUMBER_CFG,
  [T_SERVICE]: SERVICE_CFG,
  [T_KEY]: KEY_CFG,
  [T_SUB]: SUB_CFG
}

const NO_SUB_NOTE =
  ' This key belongs to the main account (no subaccount), so it can do anything on the account: a Hub administrator must start it.'

function withAdminOnly(op: PlannedOp, note: string): PlannedOp {
  return { ...op, reason: `${op.reason}${note}`, data: { ...(op.data ?? {}), $adminOnly: true } }
}

const NOTIFY_NOTE =
  ' Who gets texted (or how often) is changing, so a Hub administrator must start it.'

/** The notify settings a plan would change (they live only in the Hub, mirrored into observed). */
function notifyChange(desired: DesiredResource, observed: Observed | null): FieldChange[] {
  const out: FieldChange[] = []
  const want = listOf(desired.fields.notify_numbers)
  const have = observed ? listOf(observed.fields.notify_numbers) : []
  if (!sameSet(want, have)) out.push({ field: 'notify_numbers', from: have, to: want })
  const wantCritical = desired.fields.critical_only !== false
  const haveCritical = observed ? observed.fields.critical_only !== false : true
  if (wantCritical !== haveCritical)
    out.push({ field: 'critical_only', from: haveCritical, to: wantCritical })
  return out
}

function planAny(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  const type = desired?.type ?? observed?.type
  const cfg = type ? CFGS[type] : undefined
  if (!cfg) throw new ProviderError('UNKNOWN_TYPE', `Twilio has no ${String(type)}.`)
  if (desired) validateFields(cfg.type, desired.fields, ctx.config)
  if (type === T_KEY) {
    // Which account the key lives in is judged on the provider's own answer once the key exists;
    // the desired ref decides only for a create (security review: never trust the request alone).
    // The connection's own account is the main account, however the id is written (`SK…` or
    // `<own AC>/SK…`): only a DIFFERENT account counts as a subaccount (security review).
    const own = accountOf(ctx)
    const notOwn = (a: string | null) => (a && a !== own ? a : null)
    const observedAccount = observed ? notOwn(parseKeyId(observed.externalId).account) : null
    const wantAccount = desired
      ? typeof desired.refs.subaccount === 'string' && desired.refs.subaccount
        ? notOwn(desired.refs.subaccount)
        : null
      : null
    // A create names a subaccount by ref; a ref that resolves to the connection's own account is the
    // main account. An unresolved ref (made in the same change) is checked again at apply.
    const sub = observed
      ? !!observedAccount
      : !!desired?.fields.subaccount &&
        (desired.refs.subaccount == null || desired.refs.subaccount === '' || wantAccount !== null)
    const moved = !!(observed && desired && wantAccount !== observedAccount)
    const ops =
      desired && observed && desired.fields[ROTATE_OUTPUTS_FIELD] === true
        ? [
            {
              kind: 'update' as const,
              type: T_KEY,
              resourceId: desired.resourceId,
              externalId: observed.externalId,
              reason: `Rotate ${typedName(cfg.label, observed.name)}: a new key is made and this one is removed, so its secret stops working at once. If the old key cannot be removed the new one is taken back and the step fails.`,
              changes: [{ field: ROTATE_OUTPUTS_FIELD, to: true }],
              preconditions: { name: observed.fields.name ?? null },
              risk: [],
              action: 'rotate',
              data: { $oneShot: [ROTATE_OUTPUTS_FIELD] }
            }
          ]
        : planOf(cfg, desired, observed)
    if (moved)
      return ops.map((o) => ({
        ...withAdminOnly(o, NO_SUB_NOTE),
        data: {
          ...(o.data ?? {}),
          $adminOnly: true,
          $blocker: {
            code: 'SUBACCOUNT_MISMATCH',
            message:
              'This key lives in another account than the one named here. A key cannot move between accounts: make a new key in the subaccount and delete this one.'
          }
        }
      }))
    return sub ? ops : ops.map((o) => withAdminOnly(o, NO_SUB_NOTE))
  }
  const ops = planOf(cfg, desired, observed)
  if (!desired || (type !== T_NUMBER && type !== T_SERVICE)) return ops
  const change = notifyChange(desired, observed)
  if (!change.length) return ops
  if (!observed) return ops.map((o) => withAdminOnly(o, NOTIFY_NOTE))
  const upd = ops.find((o) => o.kind === 'update')
  if (upd) {
    const merged = withAdminOnly({ ...upd, changes: [...upd.changes, ...change] }, NOTIFY_NOTE)
    return ops.map((o) => (o === upd ? merged : o))
  }
  if (ops.some((o) => o.kind === 'replace')) return ops.map((o) => withAdminOnly(o, NOTIFY_NOTE))
  return [
    ...ops,
    withAdminOnly(
      {
        kind: 'update',
        type: cfg.type,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Change ${fieldWords(cfg.fields, change)} on ${typedName(cfg.label, observed.name)}.`,
        changes: change,
        preconditions: {},
        risk: []
      },
      NOTIFY_NOTE
    )
  ]
}

// ── Types ──

const base = (c: Partial<ResourceTypeSpec['capabilities']> = {}) => ({
  create: true,
  update: true,
  delete: true,
  adopt: true,
  snapshot: false,
  tag: false,
  ...c
})

const TYPES: ResourceTypeSpec[] = [
  {
    key: T_NUMBER,
    label: 'Twilio phone number',
    scope: 'app',
    nameField: 'name',
    fields: NUMBER_FIELDS,
    capabilities: base(),
    reversible: false,
    refs: [],
    outputs: [
      { key: 'phone_number', label: 'Phone number (sender)', secret: false },
      { key: 'account_sid', label: 'Account SID', secret: false }
    ],
    sends: true,
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'create') out.push('cost')
      if (op.kind === 'replace') out.push('destructive', 'cost')
      if (op.kind === 'delete') out.push('destructive')
      return out
    },
    costClass: () => 'monthly',
    estimate: twilioNumberEstimate
  },
  {
    key: T_SERVICE,
    label: 'Twilio messaging service',
    scope: 'app',
    nameField: 'name',
    fields: SERVICE_FIELDS,
    capabilities: base(),
    reversible: false,
    refs: [{ field: 'numbers', type: T_NUMBER, required: true }],
    outputs: [{ key: 'messaging_service_sid', label: 'Messaging service SID', secret: false }],
    sends: true,
    risk(op) {
      return op.kind === 'delete' ? ['destructive'] : []
    }
  },
  {
    key: T_SUB,
    label: 'Twilio subaccount',
    scope: 'shared',
    nameField: 'name',
    fields: SUB_FIELDS,
    capabilities: base(),
    reversible: false,
    refs: [],
    risk(op, desired) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete') out.push('destructive', 'data_loss')
      if (
        op.kind === 'update' &&
        op.changes.some((c) => c.field === 'status' && c.to === 'suspended')
      )
        out.push('downtime')
      void desired
      return out
    }
  },
  {
    key: T_KEY,
    label: 'Twilio API key',
    scope: 'app',
    nameField: 'name',
    fields: KEY_FIELDS,
    capabilities: base(),
    reversible: false,
    refs: [{ field: 'subaccount', type: T_SUB, required: true }],
    outputs: [
      { key: 'sid', label: 'API key SID', secret: false },
      { key: 'account_sid', label: 'Account SID (the key’s account)', secret: false },
      { key: 'secret', label: 'API key secret', secret: true, onceOnly: true }
    ],
    risk(op) {
      const out: RiskFlag[] = []
      if (op.kind === 'delete') out.push('destructive')
      if (op.action === 'rotate') out.push('downtime')
      return out
    }
  }
]

// ── Notify ──

function textOf(msg: OutboundMessage): string {
  const parts = [msg.title, msg.body, msg.link].filter((p) => typeof p === 'string' && p)
  return parts.join('\n').slice(0, 600)
}

async function sendTexts(
  ctx: ProviderContext,
  resource: HubResourceRow,
  msg: OutboundMessage
): Promise<OpResult> {
  const f = (resource.desired ?? {}) as Record<string, unknown>
  const criticalOnly = f.critical_only !== false
  if (criticalOnly && msg.severity !== 'critical')
    return ok(resource.external_id, null, { skipped: 'not critical' })
  const numbers = listOf(f.notify_numbers)
  if (!numbers.length)
    throw new ProviderError('NO_RECIPIENTS', 'No numbers are set to be texted on this resource.')
  const allowed = smsCountries(ctx.config)
  for (const n of numbers) {
    if (!E164_RE.test(n)) throw new ProviderError('BAD_NUMBER', `${n} is not a valid phone number.`)
    const why = countryRefusal(n, allowed)
    if (why) throw new ProviderError('COUNTRY_NOT_ALLOWED', why)
  }
  const texts = numbers.slice(0, MAX_NOTIFY_NUMBERS)
  takeRate(ctx, resource.id, texts.length)
  let sender: Record<string, string>
  if (resource.type === T_SERVICE)
    sender = { MessagingServiceSid: sidSeg('MG', resource.external_id, 'messaging service id') }
  else if (resource.type === T_NUMBER) {
    const from = str(resource.observed?.fields.phone_number) ?? str(f.phone_number)
    if (!from || !E164_RE.test(from))
      throw new ProviderError('NO_SENDER', 'The sending number is not known yet.')
    sender = { From: from }
  } else throw new ProviderError('NOT_A_SENDER', 'This resource cannot send texts.')
  const body = textOf(msg)
  const failures: ProviderError[] = []
  let sent = 0
  for (const to of texts) {
    try {
      await twilioCall(ctx, 'POST', accountPath(ctx, '/Messages.json'), {
        form: { To: to, Body: body, ...sender }
      })
      sent++
    } catch (err) {
      if (err instanceof ProviderError) failures.push(err)
      else throw err
    }
  }
  if (failures.length) {
    const first = failures[0]
    throw new ProviderError(
      first.code,
      clipScrubbed(
        ctx,
        `${failures.length} of ${numbers.length} texts were not sent: ${first.message}`
      ),
      {
        retryable: failures.every((e) => e.retryable),
        ...(first.status ? { status: first.status } : {})
      }
    )
  }
  return ok(resource.external_id, null, { sent })
}

// ── Notify rate limit ──

const RATE_PER_HOUR = 20
const HOUR_MS = 60 * 60 * 1000

/**
 * At most 20 texts an hour per resource (a stolen route or a flood of events must not run up the
 * bill). Counted in the connection's token cache, so it is per Hub process and forgotten on a
 * restart: a ceiling against runaway sends, not an exact meter. Over the limit = RATE_LIMITED,
 * not retryable (a retry in the same hour would only hit it again); the route records it.
 */
function takeRate(ctx: ProviderContext, resourceId: number, count: number): number {
  const key = `twilio-notify:${resourceId}`
  const now = ctx.now().getTime()
  let stamps: number[] = []
  try {
    const raw = ctx.tokens.get(key)
    const parsed = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed))
      stamps = parsed.filter((t) => typeof t === 'number' && now - t < HOUR_MS)
  } catch {
    stamps = []
  }
  if (stamps.length + count > RATE_PER_HOUR)
    throw new ProviderError(
      'RATE_LIMITED',
      `At most ${RATE_PER_HOUR} texts an hour go out through one resource (${stamps.length} sent in the last hour). This one was not sent.`,
      { retryable: false }
    )
  for (let i = 0; i < count; i++) stamps.push(now)
  ctx.tokens.set(key, JSON.stringify(stamps), new Date(now + HOUR_MS + 2 * 60 * 1000))
  return stamps.length
}

/** The notify settings mirrored into observed, so a later plan can tell they are unchanged. */
function withNotifyEcho(result: OpResult, desired: DesiredResource | null): OpResult {
  if (!result.observed || !desired) return result
  if (result.observed.type !== T_NUMBER && result.observed.type !== T_SERVICE) return result
  return {
    ...result,
    observed: {
      ...result.observed,
      fields: {
        ...result.observed.fields,
        notify_numbers: listOf(desired.fields.notify_numbers),
        critical_only: desired.fields.critical_only !== false
      }
    }
  }
}

// ── The adapter ──

function typeOf(type: string): string {
  if (!CFGS[type]) throw new ProviderError('UNKNOWN_TYPE', `Twilio has no ${type}.`)
  return type
}

async function applyOp(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'noop') return ok(op.externalId, null)
  const type = typeOf(op.type)
  if (op.kind === 'create') {
    if (!desired) throw invalid('Nothing to create.')
    if (type === T_NUMBER) return createNumber(ctx, desired)
    if (type === T_SERVICE) return createService(ctx, desired)
    if (type === T_KEY) return createKey(ctx, desired)
    return createSub(ctx, desired)
  }
  const id = op.externalId as string
  if (op.kind === 'delete') {
    if (type === T_NUMBER) await releaseNumber(ctx, id)
    else if (type === T_SERVICE)
      await twilioCall(ctx, 'DELETE', `/v1/Services/${sidSeg('MG', id, 'messaging service id')}`, {
        origin: MESSAGING_ORIGIN,
        allow: [404]
      })
    else if (type === T_KEY) {
      const { account, sid } = parseKeyId(id)
      refuseOwnKey(ctx, sid)
      await twilioCall(ctx, 'DELETE', `${await keyBase(ctx, account)}/${sid}.json`, {
        allow: [404]
      })
    } else await closeSub(ctx, id)
    return ok(id, null)
  }
  if (!desired) throw invalid('Nothing to write.')
  if (op.kind === 'replace') {
    // Only a phone number replaces: release the old one, then buy the new one.
    if (type !== T_NUMBER) throw invalid(`${type} cannot be replaced.`)
    await releaseNumber(ctx, id)
    return createNumber(ctx, { ...desired, externalId: null })
  }
  if (type === T_KEY && op.action === 'rotate') return rotateKey(ctx, op, desired)
  if (type === T_NUMBER) return updateNumber(ctx, op, desired)
  if (type === T_SERVICE) return updateService(ctx, op, desired)
  if (type === T_SUB) return updateSub(ctx, op, desired)
  // A key: only its name changes.
  const { account, sid } = parseKeyId(id)
  const raw = await keyRaw(ctx, id)
  if (!raw) throw new ProviderError('NOT_FOUND', 'The API key no longer exists.', { status: 404 })
  const name = str(desired.fields.name)
  if (!name || name === raw.friendly_name)
    return ok(id, keyObserved(raw, account), { already: 'matches' })
  await twilioCall(ctx, 'POST', `${await keyBase(ctx, account)}/${sid}.json`, {
    form: { FriendlyName: name }
  })
  const after = await keyRaw(ctx, id)
  return ok(id, after ? keyObserved(after, account) : null, { changed: ['name'] })
}

export const twilioAdapter: ProviderAdapter = {
  bundledPrices: TWILIO_BUNDLED,
  key: 'twilio',
  label: 'Twilio',
  connection: {
    fields: [
      {
        key: 'accountSid',
        label: 'Account SID',
        kind: 'string',
        required: true,
        placeholder: 'AC…',
        help: 'The Twilio account this connection manages. Everything the Hub does stays inside it.'
      },
      {
        key: 'keySid',
        label: 'API key SID',
        kind: 'string',
        placeholder: 'SK…',
        help: 'Preferred: an API key SID (SK…) with its secret below. Leave empty to sign in with the account SID and auth token instead.'
      },
      {
        key: 'sms_countries',
        label: 'Countries the Hub may text',
        kind: 'string',
        default: 'US,CA',
        placeholder: 'US,CA',
        help: 'Two-letter country codes, comma separated. A notification number in any other country is refused (COUNTRY_NOT_ALLOWED): texts to foreign or premium numbers are how a stolen login costs money.'
      },
      {
        key: 'secret',
        label: 'API key secret or auth token',
        kind: 'string',
        secret: true,
        required: true,
        help: 'The API key’s secret, or the account’s auth token when no key SID is given.'
      }
    ],
    hosts: () => ['api.twilio.com', 'messaging.twilio.com'],
    describe: (config) =>
      `Twilio ${String(config.accountSid ?? '')}${config.keySid ? ' (API key)' : ' (auth token)'}`,
    validate(config, secrets) {
      const problems: string[] = []
      if (!ACCOUNT_SID_RE.test(String(config.accountSid ?? '').trim()))
        problems.push('The account SID is AC followed by 32 letters and digits.')
      const key = String(config.keySid ?? '').trim()
      if (key && !KEY_SID_RE.test(key))
        problems.push('The API key SID is SK followed by 32 letters and digits.')
      const raw = config.sms_countries
      if (raw !== undefined && raw !== '') {
        const list = (Array.isArray(raw) ? raw.map(String) : String(raw).split(/[\s,]+/))
          .map((c) => c.trim())
          .filter(Boolean)
        if (!list.length || list.some((c) => !/^[A-Za-z]{2}$/.test(c)))
          problems.push('The countries are two-letter codes separated by commas, such as US,CA.')
      }
      if (secrets.secret !== undefined && !secrets.secret.trim())
        problems.push('The secret is empty.')
      return problems
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const acct = accountOf(ctx)
    const probes: Array<{ type: string; need: string; run: () => Promise<unknown> }> = [
      {
        type: '*',
        need: 'read the account',
        run: async () => {
          const r = await twilioCall(ctx, 'GET', `/2010-04-01/Accounts/${acct}.json`)
          if (r.body?.sid !== acct)
            throw new ProviderError(
              'TWILIO_OUT_OF_ACCOUNT',
              'The credentials belong to another account.'
            )
          return r.body
        }
      },
      {
        type: T_NUMBER,
        need: 'manage phone numbers',
        run: () =>
          twilioCall(ctx, 'GET', accountPath(ctx, '/IncomingPhoneNumbers.json'), {
            query: { PageSize: 1 }
          })
      },
      {
        type: T_SERVICE,
        need: 'manage messaging services',
        run: () =>
          twilioCall(ctx, 'GET', '/v1/Services', {
            origin: MESSAGING_ORIGIN,
            query: { PageSize: 1 }
          })
      },
      {
        type: T_KEY,
        need: 'manage API keys (needs the main account’s auth token or a main API key)',
        run: () =>
          twilioCall(ctx, 'GET', accountPath(ctx, '/Keys.json'), { query: { PageSize: 1 } })
      }
    ]
    const permissions: ConnectionTest['permissions'] = []
    let identity: string | null = null
    let message: string | undefined
    for (const p of probes) {
      try {
        const body: any = await p.run()
        if (p.type === '*' && body?.friendly_name)
          identity = `Twilio account ${String(body.friendly_name)} (${acct})`
        permissions.push({ type: p.type, need: p.need, has: true })
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err
        permissions.push({ type: p.type, need: p.need, has: false })
        message ??= clipScrubbed(ctx, err.message)
      }
    }
    const missing = permissions.filter((p) => !p.has).map((p) => p.need)
    return {
      ok: permissions[0]?.has === true && missing.length === 0,
      identity,
      permissions,
      missing,
      ...(message ? { message } : {})
    }
  },

  async observe(ctx, type, externalId) {
    switch (typeOf(type)) {
      case T_NUMBER: {
        const raw = await numberRaw(ctx, externalId)
        return raw ? numberObserved(raw) : null
      }
      case T_SERVICE:
        return readService(ctx, externalId)
      case T_KEY: {
        const raw = await keyRaw(ctx, externalId)
        return raw ? keyObserved(raw, parseKeyId(externalId).account) : null
      }
      default: {
        const raw = await subRaw(ctx, externalId)
        return raw ? subObserved(raw) : null
      }
    }
  },

  async list(ctx, type, cursor): Promise<ListPage> {
    switch (typeOf(type)) {
      case T_NUMBER: {
        const p = await numberPage(ctx, cursorQuery(cursor))
        return { items: p.items.map(numberObserved), cursor: p.cursor }
      }
      case T_SERVICE: {
        const p = await servicePage(ctx, cursor)
        const items = await Promise.all(
          p.items.map(async (s) => serviceObserved(s, await poolOf(ctx, String(s.sid))))
        )
        return { items, cursor: p.cursor }
      }
      case T_KEY: {
        const p = await keyPage(ctx, cursor)
        return { items: p.items.map((k) => keyObserved(k, null)), cursor: p.cursor }
      }
      default: {
        const p = await subPage(ctx, cursor)
        return { items: p.items.map(subObserved), cursor: p.cursor }
      }
    }
  },

  /** Plan time: a resource of the same name (or the same number) at Twilio. */
  async findExisting(ctx, type, desired) {
    if (desired.externalId) return null
    const name = str(desired.fields.name)
    switch (typeOf(type)) {
      case T_NUMBER: {
        const n = str(desired.fields.phone_number)
        if (!n || !E164_RE.test(n)) return null
        const hit = (await numberPage(ctx, { PhoneNumber: n })).items[0]
        return hit ? numberObserved(hit) : null
      }
      case T_SERVICE: {
        const hit = name ? await findServiceByName(ctx, name) : null
        return hit ? serviceObserved(hit, await poolOf(ctx, String(hit.sid))) : null
      }
      case T_KEY: {
        const account = keyAccountOf(desired)
        const hit = name ? await findKeyByName(ctx, name, account) : null
        return hit ? keyObserved(hit, account) : null
      }
      default: {
        const hit = name
          ? (await subPage(ctx, null, name)).items.find((a: any) => a.friendly_name === name)
          : null
        return hit ? subObserved(hit) : null
      }
    }
  },

  plan(ctx, desired, observed) {
    return planAny(ctx, desired, observed)
  },

  async apply(ctx, op, desired) {
    return withNotifyEcho(await applyOp(ctx, op, desired), desired)
  },

  /** What Twilio shows again: a number's digits, a service's SID, a key's SID (never its secret). */
  async readOutputs(ctx, type, externalId) {
    if (type === T_NUMBER) {
      const raw = await numberRaw(ctx, externalId)
      return raw ? numberOutputs(ctx, raw) : {}
    }
    if (type === T_SERVICE) {
      const raw = await serviceRaw(ctx, externalId)
      return raw ? { messaging_service_sid: String(raw.sid) } : {}
    }
    if (type === T_KEY) {
      const raw = await keyRaw(ctx, externalId)
      return raw
        ? { sid: String(raw.sid), account_sid: parseKeyId(externalId).account ?? accountOf(ctx) }
        : {}
    }
    return {}
  },

  notify(ctx, resource, msg) {
    return sendTexts(ctx, resource, msg)
  },

  /** Usage priced by the day (messages and calls), from Twilio's usage records. */
  async usageNow(ctx, range): Promise<CostRow[]> {
    const r = await twilioCall(ctx, 'GET', accountPath(ctx, '/Usage/Records/Daily.json'), {
      query: { Category: 'totalprice', StartDate: range.from, EndDate: range.to, PageSize: 366 }
    })
    const rows: CostRow[] = []
    for (const u of r.body?.usage_records ?? []) {
      const price = Number(u?.price)
      const date = String(u?.start_date ?? '')
      if (!Number.isFinite(price) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      rows.push({
        date,
        amountCents: Math.round(price * 100),
        currency: String(u?.price_unit ?? 'USD').toUpperCase(),
        service: 'Twilio usage',
        recordType: 'usage'
      })
    }
    return rows
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at Twilio.', checkedAt }
    if (type === T_SUB && seen.status !== 'active')
      return {
        status: 'warn',
        message: `Subaccount is ${String(seen.status ?? 'in an unknown state')}.`,
        checkedAt,
        details: { state: String(seen.status ?? '') }
      }
    return { status: 'ok', checkedAt }
  }
}
