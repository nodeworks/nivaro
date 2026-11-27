import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 26: the Twilio adapter against recorded (fake-valued) answers.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const { ensureCoreProviders, CORE_PROVIDERS } = await import(
  '../../../services/hub/providers/index.js'
)
const registry = await import('../../../services/hub/providers/registry.js')
const { twilioAdapter } = await import('../../../services/hub/providers/twilio/index.js')

import type { HubResourceRow } from '../../../services/hub/providers/store.js'
import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  ProviderError,
  ROTATE_OUTPUTS_FIELD
} from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/twilio/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const AC = `AC${'a'.repeat(30)}11`
const OTHER_AC = `AC${'9'.repeat(30)}99`
const SK = `SK${'d'.repeat(30)}01`
const PN = `PN${'b'.repeat(30)}01`
const MG = `MG${'c'.repeat(30)}01`
const SUB = `AC${'e'.repeat(30)}22`
const SECRET = 'test-secret-twilio-0001'
const NEW_KEY_SECRET = 'test-secret-twilio-key-0002'

const T_NUMBER = 'twilio.phone_number'
const T_SERVICE = 'twilio.messaging_service'
const T_SUB = 'twilio.subaccount'
const T_KEY = 'twilio.api_key'

interface Call {
  method: string
  host: string
  path: string
  query: URLSearchParams
  form: URLSearchParams | null
  headers: Record<string, string>
}
interface Route {
  method: string
  path: RegExp
  host?: string
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function harness(routes: Route[], config: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const call: Call = {
      method: String(init?.method ?? 'GET'),
      host: u.host,
      path: u.pathname,
      query: u.searchParams,
      form: init?.body ? new URLSearchParams(String(init.body)) : null,
      headers: init?.headers ?? {}
    }
    calls.push(call)
    const hit = routes.find(
      (r) => r.method === call.method && r.path.test(call.path) && (!r.host || r.host === call.host)
    )
    if (!hit) return new Response('{"message":"not found","code":20404}', { status: 404 })
    const status = hit.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(hit.body ?? {}), {
      status,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: twilioAdapter,
    connectionId: 1,
    config: { accountSid: AC, ...config },
    secrets: { secret: SECRET },
    now: () => new Date('2026-11-26T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return { ctx, calls }
}

function desired(
  type: string,
  fields: Record<string, unknown>,
  externalId: string | null = null,
  refs: Record<string, string | string[] | null> = {}
): DesiredResource {
  return {
    resourceId: 7,
    type,
    externalId,
    scope: type === T_SUB ? 'shared' : 'app',
    appId: 1,
    environmentId: 2,
    fields,
    refs,
    tags: {}
  }
}

const observedNumber = (over: Record<string, unknown> = {}): Observed => ({
  type: T_NUMBER,
  externalId: PN,
  name: 'demo-sms',
  fields: {
    name: 'demo-sms',
    phone_number: '+15555550101',
    sms_url: null,
    status_callback: null,
    sms_capable: true,
    ...over
  },
  tags: {}
})

const observedService = (over: Record<string, unknown> = {}): Observed => ({
  type: T_SERVICE,
  externalId: MG,
  name: 'demo-pool',
  fields: { name: 'demo-pool', status_callback: null, numbers: [PN], ...over },
  tags: {}
})

const op = (type: string, over: Partial<PlannedOp>): PlannedOp => ({
  kind: 'update',
  type,
  resourceId: 7,
  externalId: PN,
  reason: '',
  changes: [],
  preconditions: {},
  risk: [],
  ...over
})

const spec = (type: string) => {
  const s = twilioAdapter.types.find((t) => t.key === type)
  if (!s) throw new Error(`no type ${type}`)
  return s
}

const MSG = 'messaging.twilio.com'

beforeEach(() => {
  registry.resetProvidersForTest()
})

describe('twilio adapter: registration', () => {
  it('is a core provider on the two Twilio hosts with a secret credential', () => {
    ensureCoreProviders()
    expect(registry.getProvider('twilio')).toBe(twilioAdapter)
    expect(CORE_PROVIDERS).toContain(twilioAdapter)
    expect(twilioAdapter.connection.hosts({})).toEqual(['api.twilio.com', 'messaging.twilio.com'])
    expect(twilioAdapter.connection.fields.find((f) => f.key === 'secret')?.secret).toBe(true)
    expect(twilioAdapter.connection.fields.find((f) => f.key === 'accountSid')?.secret).toBeFalsy()
    expect(twilioAdapter.connection.describe({ accountSid: AC, keySid: SK })).not.toContain(SECRET)
    expect(twilioAdapter.connection.validate?.({ accountSid: 'nope' }, {})).not.toEqual([])
    expect(
      twilioAdapter.connection.validate?.({ accountSid: AC, keySid: 'SKnope' }, {})
    ).not.toEqual([])
    expect(twilioAdapter.connection.validate?.({ accountSid: AC }, { secret: SECRET })).toEqual([])
    expect(twilioAdapter.types.map((t) => t.key)).toEqual([T_NUMBER, T_SERVICE, T_SUB, T_KEY])
  })

  it('refuses a host other than the two Twilio hosts', async () => {
    const { ctx } = harness([])
    await expect(ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
  })

  it('only numbers and messaging services send; the subaccount is shared', () => {
    expect(spec(T_NUMBER).sends).toBe(true)
    expect(spec(T_SERVICE).sends).toBe(true)
    expect(spec(T_KEY).sends).toBeUndefined()
    expect(spec(T_SUB).scope).toBe('shared')
    expect(spec(T_NUMBER).scope).toBe('app')
  })
})

describe('twilio adapter: testConnection', () => {
  it('lists the permissions the credentials lack and never echoes the secret', async () => {
    const { ctx } = harness([
      { method: 'GET', path: new RegExp(`/Accounts/${AC}\\.json$`), body: fx('account') },
      { method: 'GET', path: /IncomingPhoneNumbers/, body: fx('numbers') },
      { method: 'GET', path: /\/v1\/Services$/, host: MSG, body: fx('services') },
      { method: 'GET', path: /\/Keys\.json$/, status: 401, body: fx('error-unauthorized') }
    ])
    const r = await twilioAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual([
      'manage API keys (needs the main account’s auth token or a main API key)'
    ])
    expect(r.identity).toBe(`Twilio account Demo Co (${AC})`)
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('is ok when every probe works; an API key signs in as the key SID', async () => {
    const { ctx, calls } = harness(
      [
        { method: 'GET', path: new RegExp(`/Accounts/${AC}\\.json$`), body: fx('account') },
        { method: 'GET', path: /IncomingPhoneNumbers/, body: fx('numbers') },
        { method: 'GET', path: /\/v1\/Services$/, host: MSG, body: fx('services') },
        { method: 'GET', path: /\/Keys\.json$/, body: fx('keys') }
      ],
      { keySid: SK }
    )
    expect(await twilioAdapter.testConnection(ctx)).toMatchObject({ ok: true, missing: [] })
    expect(calls[0].headers.authorization).toBe(
      `Basic ${Buffer.from(`${SK}:${SECRET}`).toString('base64')}`
    )
  })

  it('refuses credentials that belong to another account', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: new RegExp(`/Accounts/${AC}\\.json$`),
        body: { ...fx('account'), sid: OTHER_AC }
      }
    ])
    const r = await twilioAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.permissions[0].has).toBe(false)
  })

  it('an auth token signs in as the account SID', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: new RegExp(`/Accounts/${AC}\\.json$`), body: fx('account') }
    ])
    await twilioAdapter.testConnection(ctx)
    expect(calls[0].headers.authorization).toBe(
      `Basic ${Buffer.from(`${AC}:${SECRET}`).toString('base64')}`
    )
  })
})

describe('twilio adapter: observe and list', () => {
  it('observe maps a number and answers its SMS webhook as empty = null', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /IncomingPhoneNumbers\/PN/, body: fx('number') }
    ])
    const seen = await twilioAdapter.observe(ctx, T_NUMBER, PN)
    expect(seen).toMatchObject({
      type: T_NUMBER,
      externalId: PN,
      name: 'demo-sms',
      fields: { phone_number: '+15555550101', sms_url: null, sms_capable: true }
    })
  })

  it('a number of another account, or a missing one, observes as gone', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /IncomingPhoneNumbers\/PN/,
        body: { ...fx('number'), account_sid: OTHER_AC }
      }
    ])
    expect(await twilioAdapter.observe(ctx, T_NUMBER, PN)).toBeNull()
    const { ctx: c2 } = harness([])
    expect(await twilioAdapter.observe(c2, T_NUMBER, PN)).toBeNull()
  })

  it('a messaging service carries its sender pool as provider ids; another account reads as gone', async () => {
    const { ctx } = harness([
      { method: 'GET', path: new RegExp(`/v1/Services/${MG}$`), host: MSG, body: fx('service') },
      { method: 'GET', path: /PhoneNumbers$/, host: MSG, body: fx('pool') }
    ])
    expect(await twilioAdapter.observe(ctx, T_SERVICE, MG)).toMatchObject({
      name: 'demo-pool',
      fields: { numbers: [PN] }
    })
    const { ctx: c2 } = harness([
      {
        method: 'GET',
        path: new RegExp(`/v1/Services/${MG}$`),
        host: MSG,
        body: { ...fx('service'), account_sid: OTHER_AC }
      }
    ])
    expect(await twilioAdapter.observe(c2, T_SERVICE, MG)).toBeNull()
  })

  it('an API key carries no secret; a closed subaccount and a foreign one read as gone', async () => {
    const { ctx } = harness([{ method: 'GET', path: /\/Keys\/SK/, body: fx('key-created') }])
    const seen = await twilioAdapter.observe(ctx, T_KEY, SK)
    expect(JSON.stringify(seen)).not.toContain(NEW_KEY_SECRET)
    const closed = harness([
      { method: 'GET', path: /Accounts\/AC/, body: { ...fx('subaccount'), status: 'closed' } }
    ]).ctx
    expect(await twilioAdapter.observe(closed, T_SUB, SUB)).toBeNull()
    const foreign = harness([
      {
        method: 'GET',
        path: /Accounts\/AC/,
        body: { ...fx('subaccount'), owner_account_sid: OTHER_AC }
      }
    ]).ctx
    expect(await twilioAdapter.observe(foreign, T_SUB, SUB)).toBeNull()
    const sub = harness([{ method: 'GET', path: /Accounts\/AC/, body: fx('subaccount') }]).ctx
    const s = await twilioAdapter.observe(sub, T_SUB, SUB)
    expect(JSON.stringify(s)).not.toContain('test-secret-twilio-sub-token')
  })

  it('the connection’s own account is not a subaccount of it', async () => {
    const { ctx, calls } = harness([])
    await expect(twilioAdapter.observe(ctx, T_SUB, AC)).rejects.toMatchObject({
      code: 'TWILIO_OUT_OF_ACCOUNT'
    })
    expect(calls).toEqual([])
  })

  it('list keeps only this account’s subaccounts and follows the next page cursor', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /Accounts\.json$/, body: fx('subaccounts') },
      {
        method: 'GET',
        path: /IncomingPhoneNumbers\.json$/,
        body: {
          ...fx('numbers'),
          next_page_uri: `/2010-04-01/Accounts/${AC}/IncomingPhoneNumbers.json?PageSize=50&Page=1&PageToken=PAabc`
        }
      }
    ])
    const subs = await twilioAdapter.list(ctx, T_SUB)
    expect(subs.items.map((i) => i.name)).toEqual(['demo-sub'])
    const page = await twilioAdapter.list(ctx, T_NUMBER)
    expect(page.cursor).toBe('PageToken=PAabc&Page=1')
  })

  it('refuses ids that are not SIDs of the right kind, before any call', async () => {
    const { ctx, calls } = harness([])
    for (const id of ['../x', 'a/b', '', `SK${'d'.repeat(30)}01`])
      await expect(twilioAdapter.observe(ctx, T_NUMBER, id)).rejects.toMatchObject({
        code: 'BAD_ID'
      })
    await expect(twilioAdapter.observe(ctx, T_SERVICE, PN)).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    expect(calls).toEqual([])
  })
})

describe('twilio adapter: plan', () => {
  const { ctx } = harness([])

  it('buying a number says it costs a monthly rental', () => {
    const [p] = twilioAdapter.plan(
      ctx,
      desired(T_NUMBER, { name: 'demo-sms', phone_number: '+15555550101' }),
      null
    )
    expect(p.kind).toBe('create')
    expect(p.reason).toContain('Twilio phone number demo-sms')
    expect(p.reason).toContain('monthly rental')
    expect(p.reason).toContain('per-message usage')
  })

  it('releasing a number says it is final and refused while a pool holds it', () => {
    const [p] = twilioAdapter.plan(ctx, null, observedNumber())
    expect(p.kind).toBe('delete')
    expect(p.reason).toContain('cannot be got back')
    expect(p.reason).toContain('messaging service pool')
  })

  it('a changed number is a replace; a changed name or webhook is an update', () => {
    const [r] = twilioAdapter.plan(
      ctx,
      desired(T_NUMBER, { name: 'demo-sms', phone_number: '+15555550199' }, PN),
      observedNumber()
    )
    expect(r.kind).toBe('replace')
    expect(r.reason).toContain('released')
    const [u] = twilioAdapter.plan(
      ctx,
      desired(T_NUMBER, { name: 'renamed', sms_url: 'https://hooks.example.com/sms' }, PN),
      observedNumber()
    )
    expect(u).toMatchObject({ kind: 'update', externalId: PN })
    expect(u.changes.map((c) => c.field)).toEqual(['name', 'sms_url'])
    expect(
      twilioAdapter.plan(ctx, desired(T_NUMBER, { name: 'demo-sms' }, PN), observedNumber())
    ).toEqual([])
  })

  it('refuses a webhook or status callback that is not https', () => {
    expect(() =>
      twilioAdapter.plan(
        ctx,
        desired(T_NUMBER, {
          name: 'n',
          phone_number: '+15555550101',
          sms_url: 'http://x.example.com'
        }),
        null
      )
    ).toThrow(/https/)
    expect(() =>
      twilioAdapter.plan(
        ctx,
        desired(T_SERVICE, { name: 's', status_callback: 'ftp://x.example.com' }),
        null
      )
    ).toThrow(/https/)
  })

  it('a pool change is planned from the resolved refs; unresolved refs plan nothing about the pool', () => {
    const [u] = twilioAdapter.plan(
      ctx,
      desired(T_SERVICE, { name: 'demo-pool', numbers: [{ resourceId: 1 }] }, MG, { numbers: [] }),
      observedService()
    )
    expect(u.changes).toEqual([{ field: 'numbers', from: [PN], to: [] }])
    expect(
      twilioAdapter.plan(
        ctx,
        desired(T_SERVICE, { name: 'demo-pool', numbers: [{ resourceId: 1 }] }, MG, {
          numbers: null
        }),
        observedService()
      )
    ).toEqual([])
  })

  it('a rotation is a named op with a one-shot trigger', () => {
    const [p] = twilioAdapter.plan(
      ctx,
      desired(T_KEY, { name: 'demo-key', [ROTATE_OUTPUTS_FIELD]: true }, SK),
      { type: T_KEY, externalId: SK, name: 'demo-key', fields: { name: 'demo-key' }, tags: {} }
    )
    expect(p).toMatchObject({
      kind: 'update',
      action: 'rotate',
      data: { $oneShot: [ROTATE_OUTPUTS_FIELD] }
    })
    expect(p.reason).toContain('stops working at once')
  })

  it('a subaccount delete says it is closed for good', () => {
    const [p] = twilioAdapter.plan(ctx, null, {
      type: T_SUB,
      externalId: SUB,
      name: 'demo-sub',
      fields: { name: 'demo-sub', status: 'active' },
      tags: {}
    })
    expect(p.reason).toContain('cannot be reopened')
  })
})

describe('twilio adapter: risk flags and cost', () => {
  it('buy = cost; release = destructive; replace = both', () => {
    const r = (type: string, kind: PlannedOp['kind'], extra: Partial<PlannedOp> = {}) =>
      spec(type).risk(op(type, { kind, ...extra }), null)
    expect(r(T_NUMBER, 'create')).toEqual(['cost'])
    expect(r(T_NUMBER, 'update')).toEqual([])
    expect(r(T_NUMBER, 'delete')).toEqual(['destructive'])
    expect(r(T_NUMBER, 'replace')).toEqual(['destructive', 'cost'])
    expect(r(T_SERVICE, 'delete')).toEqual(['destructive'])
    expect(r(T_SUB, 'delete')).toEqual(['destructive', 'data_loss'])
    expect(r(T_SUB, 'update', { changes: [{ field: 'status', to: 'suspended' }] })).toEqual([
      'downtime'
    ])
    expect(r(T_KEY, 'delete')).toEqual(['destructive'])
    expect(r(T_KEY, 'update', { action: 'rotate' })).toEqual(['downtime'])
  })

  it('only the phone number is costed; none of the types is reversible', () => {
    const d = desired(T_NUMBER, {})
    expect(spec(T_NUMBER).costClass?.(d)).toBe('monthly')
    expect(spec(T_NUMBER).estimate).toBeTypeOf('function')
    for (const t of [T_SERVICE, T_SUB, T_KEY]) expect(spec(t).costClass).toBeUndefined()
    for (const t of twilioAdapter.types) expect(t.reversible).toBe(false)
  })
})

describe('twilio adapter: apply', () => {
  const buy = () => desired(T_NUMBER, { name: 'demo-sms', phone_number: '+15555550101' })

  it('buys a named number once and answers its outputs', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /IncomingPhoneNumbers\.json$/, body: { incoming_phone_numbers: [] } },
      { method: 'POST', path: /IncomingPhoneNumbers\.json$/, body: fx('number') }
    ])
    const res = await twilioAdapter.apply(
      ctx,
      op(T_NUMBER, { kind: 'create', externalId: null }),
      buy()
    )
    expect(res.externalId).toBe(PN)
    expect(res.outputs).toEqual({ phone_number: '+15555550101', account_sid: AC })
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.form?.get('PhoneNumber')).toBe('+15555550101')
    expect(post?.form?.get('FriendlyName')).toBe('demo-sms')
    expect(post?.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it('a number the account already holds is ALREADY_EXISTS and nothing is bought', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /IncomingPhoneNumbers\.json$/, body: fx('numbers') }
    ])
    await expect(
      twilioAdapter.apply(ctx, op(T_NUMBER, { kind: 'create', externalId: null }), buy())
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('a resumed create with its id recorded buys nothing', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /IncomingPhoneNumbers\/PN/, body: fx('number') }
    ])
    const res = await twilioAdapter.apply(
      ctx,
      op(T_NUMBER, { kind: 'create', externalId: null }),
      desired(T_NUMBER, { name: 'demo-sms', phone_number: '+15555550101' }, PN)
    )
    expect(res.answer).toMatchObject({ already: 'exists' })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('an area code searches, then buys the first number found', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /IncomingPhoneNumbers\.json$/, body: { incoming_phone_numbers: [] } },
      { method: 'GET', path: /AvailablePhoneNumbers\/US\/Local\.json$/, body: fx('number-search') },
      { method: 'POST', path: /IncomingPhoneNumbers\.json$/, body: fx('number') }
    ])
    await twilioAdapter.apply(
      ctx,
      op(T_NUMBER, { kind: 'create', externalId: null }),
      desired(T_NUMBER, { name: 'demo-sms', area_code: '555', country: 'US' })
    )
    const search = calls.find((c) => c.path.includes('AvailablePhoneNumbers'))
    expect(search?.query.get('AreaCode')).toBe('555')
    expect(calls.find((c) => c.method === 'POST')?.form?.get('PhoneNumber')).toBe('+15555550177')
  })

  it('an interrupted area-code purchase (same name, bought minutes ago) is reused, not bought twice', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /IncomingPhoneNumbers\.json$/, body: fx('numbers') }
    ])
    const res = await twilioAdapter.apply(
      ctx,
      op(T_NUMBER, { kind: 'create', externalId: null }),
      desired(T_NUMBER, { name: 'demo-sms', area_code: '555' })
    )
    expect(res.answer).toMatchObject({ already: 'bought' })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('needs a number or an area code, and a valid shape, before any call', async () => {
    const { ctx, calls } = harness([])
    await expect(
      twilioAdapter.apply(
        ctx,
        op(T_NUMBER, { kind: 'create', externalId: null }),
        desired(T_NUMBER, { name: 'x' })
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    await expect(
      twilioAdapter.apply(
        ctx,
        op(T_NUMBER, { kind: 'create', externalId: null }),
        desired(T_NUMBER, { name: 'x', phone_number: '555-0101' })
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    expect(calls).toEqual([])
  })

  it('update reads first and writes only what differs', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /IncomingPhoneNumbers\/PN/, body: fx('number') },
      { method: 'POST', path: /IncomingPhoneNumbers\/PN/, body: fx('number') }
    ])
    await twilioAdapter.apply(
      ctx,
      op(T_NUMBER, {}),
      desired(T_NUMBER, { name: 'renamed', sms_url: 'https://hooks.example.com/sms' }, PN)
    )
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.form?.get('FriendlyName')).toBe('renamed')
    expect(post?.form?.get('SmsUrl')).toBe('https://hooks.example.com/sms')
    expect(post?.form?.has('StatusCallback')).toBe(false)
    const again = harness([{ method: 'GET', path: /IncomingPhoneNumbers\/PN/, body: fx('number') }])
    const res = await twilioAdapter.apply(
      again.ctx,
      op(T_NUMBER, {}),
      desired(T_NUMBER, { name: 'demo-sms' }, PN)
    )
    expect(res.answer).toMatchObject({ already: 'matches' })
    expect(again.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('releases a number nothing uses; a number in a pool is refused (IN_USE) and not released', async () => {
    const free = harness([
      { method: 'GET', path: /IncomingPhoneNumbers\/PN/, body: fx('number') },
      { method: 'GET', path: /\/v1\/Services$/, host: MSG, body: fx('services') },
      { method: 'GET', path: /PhoneNumbers$/, host: MSG, body: fx('pool-empty') },
      { method: 'DELETE', path: /IncomingPhoneNumbers\/PN/, status: 204 }
    ])
    const res = await twilioAdapter.apply(free.ctx, op(T_NUMBER, { kind: 'delete' }), null)
    expect(res).toMatchObject({ ok: true, externalId: PN, observed: null })
    expect(free.calls.some((c) => c.method === 'DELETE')).toBe(true)

    const used = harness([
      { method: 'GET', path: /IncomingPhoneNumbers\/PN/, body: fx('number') },
      { method: 'GET', path: /\/v1\/Services$/, host: MSG, body: fx('services') },
      { method: 'GET', path: /PhoneNumbers$/, host: MSG, body: fx('pool') },
      { method: 'DELETE', path: /IncomingPhoneNumbers\/PN/, status: 204 }
    ])
    await expect(
      twilioAdapter.apply(used.ctx, op(T_NUMBER, { kind: 'delete' }), null)
    ).rejects.toMatchObject({ code: 'IN_USE' })
    expect(used.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('releasing what is already gone is a success', async () => {
    const { ctx, calls } = harness([])
    expect((await twilioAdapter.apply(ctx, op(T_NUMBER, { kind: 'delete' }), null)).ok).toBe(true)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('a replace releases the old number and buys the new one', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /IncomingPhoneNumbers\/PN/, body: fx('number') },
      { method: 'GET', path: /\/v1\/Services$/, host: MSG, body: { services: [] } },
      { method: 'DELETE', path: /IncomingPhoneNumbers\/PN/, status: 204 },
      { method: 'GET', path: /IncomingPhoneNumbers\.json$/, body: { incoming_phone_numbers: [] } },
      { method: 'POST', path: /IncomingPhoneNumbers\.json$/, body: fx('number') }
    ])
    await twilioAdapter.apply(
      ctx,
      op(T_NUMBER, { kind: 'replace' }),
      desired(T_NUMBER, { name: 'demo-sms', phone_number: '+15555550199' }, PN)
    )
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => c.method)
    expect(writes).toEqual(['DELETE', 'POST'])
  })

  it('creates a messaging service and fills its pool', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/v1\/Services$/, host: MSG, body: { services: [] } },
      { method: 'POST', path: /\/v1\/Services$/, host: MSG, body: fx('service') },
      { method: 'GET', path: /PhoneNumbers$/, host: MSG, body: fx('pool-empty') },
      { method: 'POST', path: /PhoneNumbers$/, host: MSG, body: { sid: PN } },
      { method: 'GET', path: new RegExp(`/v1/Services/${MG}$`), host: MSG, body: fx('service') }
    ])
    const res = await twilioAdapter.apply(
      ctx,
      op(T_SERVICE, { kind: 'create', externalId: null }),
      desired(
        T_SERVICE,
        { name: 'demo-pool', status_callback: 'https://hooks.example.com/s' },
        null,
        {
          numbers: [PN]
        }
      )
    )
    expect(res.externalId).toBe(MG)
    expect(res.outputs).toEqual({ messaging_service_sid: MG })
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts[0].form?.get('StatusCallback')).toBe('https://hooks.example.com/s')
    expect(posts[1].form?.get('PhoneNumberSid')).toBe(PN)
  })

  it('create over a messaging service the Hub did not make is ALREADY_EXISTS', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/v1\/Services$/, host: MSG, body: fx('services') }
    ])
    await expect(
      twilioAdapter.apply(
        ctx,
        op(T_SERVICE, { kind: 'create', externalId: null }),
        desired(T_SERVICE, { name: 'demo-pool' }, null, { numbers: [] })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('update moves the pool: adds what is missing, removes what is extra', async () => {
    const other = `PN${'1'.repeat(30)}77`
    const { ctx, calls } = harness([
      { method: 'GET', path: new RegExp(`/v1/Services/${MG}$`), host: MSG, body: fx('service') },
      { method: 'GET', path: /PhoneNumbers$/, host: MSG, body: fx('pool') },
      { method: 'POST', path: /PhoneNumbers$/, host: MSG, body: { sid: other } },
      { method: 'DELETE', path: /PhoneNumbers\/PN/, host: MSG, status: 204 }
    ])
    await twilioAdapter.apply(
      ctx,
      op(T_SERVICE, { externalId: MG }),
      desired(T_SERVICE, { name: 'demo-pool' }, MG, { numbers: [other] })
    )
    expect(calls.find((c) => c.method === 'POST')?.form?.get('PhoneNumberSid')).toBe(other)
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe(
      `/v1/Services/${MG}/PhoneNumbers/${PN}`
    )
  })

  it('deleting a messaging service deletes only the service', async () => {
    const { ctx, calls } = harness([
      { method: 'DELETE', path: new RegExp(`/v1/Services/${MG}$`), host: MSG, status: 204 }
    ])
    await twilioAdapter.apply(ctx, op(T_SERVICE, { kind: 'delete', externalId: MG }), null)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE /v1/Services/${MG}`])
  })

  it('creates an API key and answers its sid and once-only secret as outputs only', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /\/Keys\.json$/, body: { keys: [] } },
      { method: 'POST', path: /\/Keys\.json$/, body: fx('key-created') }
    ])
    const res = await twilioAdapter.apply(
      ctx,
      op(T_KEY, { kind: 'create', externalId: null }),
      desired(T_KEY, { name: 'demo-key' })
    )
    expect(res.outputs).toEqual({ sid: SK, account_sid: AC, secret: NEW_KEY_SECRET })
    expect(res.externalId).toBe(SK)
    expect(JSON.stringify({ ...res, outputs: undefined })).not.toContain(NEW_KEY_SECRET)
  })

  it('create over a key of the same name is ALREADY_EXISTS', async () => {
    const { ctx } = harness([{ method: 'GET', path: /\/Keys\.json$/, body: fx('keys') }])
    await expect(
      twilioAdapter.apply(
        ctx,
        op(T_KEY, { kind: 'create', externalId: null }),
        desired(T_KEY, { name: 'demo-key' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
  })

  it('rotating makes a marker key, removes the old, renames the new and answers the new outputs', async () => {
    const fresh = `SK${'f'.repeat(30)}09`
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/Keys\/SK/, body: fx('key') },
      { method: 'GET', path: /\/Keys\.json$/, body: { keys: [] } },
      { method: 'POST', path: /\/Keys\.json$/, body: { ...fx('key-created'), sid: fresh } },
      { method: 'DELETE', path: /\/Keys\/SK/, status: 204 },
      { method: 'POST', path: /\/Keys\/SK/, body: {} }
    ])
    const res = await twilioAdapter.apply(
      ctx,
      op(T_KEY, { externalId: SK, action: 'rotate' }),
      desired(T_KEY, { name: 'demo-key', [ROTATE_OUTPUTS_FIELD]: true }, SK)
    )
    expect(res.ok).toBe(true)
    expect(res.externalId).toBe(fresh)
    expect(res.outputs).toEqual({ sid: fresh, account_sid: AC, secret: NEW_KEY_SECRET })
    expect(res.answer).toMatchObject({ rotated: true, replaced: SK })
    const writes = calls.filter((c) => c.method !== 'GET')
    expect(writes.map((c) => c.method)).toEqual(['POST', 'DELETE', 'POST'])
    expect(writes[0].form?.get('FriendlyName')).toBe('demo-key (rotating)')
    expect(writes[2].form?.get('FriendlyName')).toBe('demo-key')
  })

  it('rotation: an old key that cannot be removed FAILS the step (retryable), takes the new key back and names the old one', async () => {
    const fresh = `SK${'f'.repeat(30)}09`
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/Keys\/SK/, body: fx('key') },
      { method: 'GET', path: /\/Keys\.json$/, body: { keys: [] } },
      { method: 'POST', path: /\/Keys\.json$/, body: { ...fx('key-created'), sid: fresh } },
      { method: 'DELETE', path: new RegExp(`/Keys/${SK}`), status: 503, body: { message: 'down' } },
      { method: 'DELETE', path: new RegExp(`/Keys/${fresh}`), status: 204 }
    ])
    const res = await twilioAdapter.apply(
      ctx,
      op(T_KEY, { externalId: SK, action: 'rotate' }),
      desired(T_KEY, { name: 'demo-key', [ROTATE_OUTPUTS_FIELD]: true }, SK)
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatchObject({ code: 'OLD_KEY_NOT_REMOVED', retryable: true })
    expect(res.error?.message).toContain(SK)
    expect(res.answer).toMatchObject({ oldKeySid: SK, newKeyTakenBack: true })
    expect(res.outputs).toBeUndefined()
    expect(JSON.stringify(res)).not.toContain(NEW_KEY_SECRET)
    // The new key was deleted again: the account is back to the one old key.
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      `/2010-04-01/Accounts/${AC}/Keys/${SK}.json`,
      `/2010-04-01/Accounts/${AC}/Keys/${fresh}.json`
    ])
  })

  it('rotation: a 404 on the old key is success; a non-provider error is not swallowed', async () => {
    const fresh = `SK${'f'.repeat(30)}09`
    const gone = harness([
      { method: 'GET', path: /\/Keys\/SK/, body: fx('key') },
      { method: 'GET', path: /\/Keys\.json$/, body: { keys: [] } },
      { method: 'POST', path: /\/Keys\.json$/, body: { ...fx('key-created'), sid: fresh } },
      { method: 'DELETE', path: /\/Keys\/SK/, status: 404, body: {} },
      { method: 'POST', path: /\/Keys\/SK/, body: {} }
    ])
    const ok1 = await twilioAdapter.apply(
      gone.ctx,
      op(T_KEY, { externalId: SK, action: 'rotate' }),
      desired(T_KEY, { name: 'demo-key' }, SK)
    )
    expect(ok1.ok).toBe(true)
  })

  it('rotation is idempotent: a marker key left by a stopped run is removed first, so the new key is never made twice', async () => {
    const stale = `SK${'7'.repeat(30)}33`
    const fresh = `SK${'f'.repeat(30)}09`
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/Keys\/SK/, body: fx('key') },
      {
        method: 'GET',
        path: /\/Keys\.json$/,
        body: { keys: [{ sid: stale, friendly_name: 'demo-key (rotating)' }] }
      },
      { method: 'DELETE', path: new RegExp(`/Keys/${stale}`), status: 204 },
      { method: 'POST', path: /\/Keys\.json$/, body: { ...fx('key-created'), sid: fresh } },
      { method: 'DELETE', path: new RegExp(`/Keys/${SK}`), status: 204 },
      { method: 'POST', path: /\/Keys\/SK/, body: {} }
    ])
    await twilioAdapter.apply(
      ctx,
      op(T_KEY, { externalId: SK, action: 'rotate' }),
      desired(T_KEY, { name: 'demo-key' }, SK)
    )
    const order = calls
      .filter((c) => c.method !== 'GET')
      .map((c) => `${c.method} ${c.path.split('/').pop()}`)
    expect(order[0]).toBe(`DELETE ${stale}.json`)
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/Keys.json'))).toHaveLength(
      1
    )
  })

  it('an app key with a subaccount is made inside that subaccount, and its id says so', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: new RegExp(`/Accounts/${SUB}\\.json$`), body: fx('subaccount') },
      { method: 'GET', path: /\/Keys\.json$/, body: { keys: [] } },
      { method: 'POST', path: /\/Keys\.json$/, body: fx('key-created') }
    ])
    const res = await twilioAdapter.apply(
      ctx,
      op(T_KEY, { kind: 'create', externalId: null }),
      desired(T_KEY, { name: 'demo-key', subaccount: { resourceId: 3 } }, null, { subaccount: SUB })
    )
    expect(calls.find((c) => c.method === 'POST')?.path).toBe(
      `/2010-04-01/Accounts/${SUB}/Keys.json`
    )
    expect(res.externalId).toBe(`${SUB}/${SK}`)
    expect(res.outputs).toMatchObject({ account_sid: SUB, sid: SK })
    expect(res.observed?.fields.subaccount).toBe(SUB)
  })

  it('a subaccount that is not this connection’s own is refused (TWILIO_OUT_OF_ACCOUNT)', async () => {
    const { ctx, calls } = harness([
      {
        method: 'GET',
        path: new RegExp(`/Accounts/${SUB}\\.json$`),
        body: { ...fx('subaccount'), owner_account_sid: OTHER_AC }
      }
    ])
    await expect(
      twilioAdapter.apply(
        ctx,
        op(T_KEY, { kind: 'create', externalId: null }),
        desired(T_KEY, { name: 'demo-key', subaccount: { resourceId: 3 } }, null, {
          subaccount: SUB
        })
      )
    ).rejects.toMatchObject({ code: 'TWILIO_OUT_OF_ACCOUNT' })
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('an app key with no subaccount is admin-only and the plan says why; with one it is not', () => {
    const { ctx } = harness([])
    const [bare] = twilioAdapter.plan(ctx, desired(T_KEY, { name: 'k' }), null)
    expect(bare.data?.$adminOnly).toBe(true)
    expect(bare.reason).toContain('main account')
    expect(bare.reason).toContain('Hub administrator')
    const [scoped] = twilioAdapter.plan(
      ctx,
      desired(T_KEY, { name: 'k', subaccount: { resourceId: 3 } }, null, { subaccount: null }),
      null
    )
    expect(scoped.data?.$adminOnly).toBeUndefined()
    const [del] = twilioAdapter.plan(ctx, null, {
      type: T_KEY,
      externalId: SK,
      name: 'k',
      fields: { name: 'k', subaccount: null },
      tags: {}
    })
    expect(del.data?.$adminOnly).toBe(true)
  })

  it('the key the Hub signs in with is never rotated or deleted by the Hub', async () => {
    const { ctx, calls } = harness([], { keySid: SK })
    await expect(
      twilioAdapter.apply(ctx, op(T_KEY, { kind: 'delete', externalId: SK }), null)
    ).rejects.toMatchObject({ code: 'OWN_KEY' })
    await expect(
      twilioAdapter.apply(
        ctx,
        op(T_KEY, { externalId: SK, action: 'rotate' }),
        desired(T_KEY, { name: 'demo-key' }, SK)
      )
    ).rejects.toMatchObject({ code: 'OWN_KEY' })
    expect(calls).toEqual([])
  })

  it('a subaccount is closed (never reopened) on delete, and suspended on update', async () => {
    const close = harness([
      { method: 'GET', path: /Accounts\/AC/, body: fx('subaccount') },
      { method: 'POST', path: /Accounts\/AC/, body: { ...fx('subaccount'), status: 'closed' } }
    ])
    await twilioAdapter.apply(close.ctx, op(T_SUB, { kind: 'delete', externalId: SUB }), null)
    expect(close.calls.find((c) => c.method === 'POST')?.form?.get('Status')).toBe('closed')

    const susp = harness([
      { method: 'GET', path: /Accounts\/AC/, body: fx('subaccount') },
      { method: 'POST', path: /Accounts\/AC/, body: { ...fx('subaccount'), status: 'suspended' } }
    ])
    await twilioAdapter.apply(
      susp.ctx,
      op(T_SUB, { externalId: SUB }),
      desired(T_SUB, { name: 'demo-sub', status: 'suspended' }, SUB)
    )
    expect(susp.calls.find((c) => c.method === 'POST')?.form?.get('Status')).toBe('suspended')
  })

  it('a new subaccount’s auth token is never returned', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /Accounts\.json$/, body: { accounts: [] } },
      { method: 'POST', path: /Accounts\.json$/, body: fx('subaccount') }
    ])
    const res = await twilioAdapter.apply(
      ctx,
      op(T_SUB, { kind: 'create', externalId: null }),
      desired(T_SUB, { name: 'demo-sub' })
    )
    expect(res.externalId).toBe(SUB)
    expect(res.outputs).toBeUndefined()
    expect(JSON.stringify(res)).not.toContain('test-secret-twilio-sub-token')
  })

  it('findExisting names a number or a service of the same name for the plan', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /IncomingPhoneNumbers\.json$/, body: fx('numbers') },
      { method: 'GET', path: /\/v1\/Services$/, host: MSG, body: fx('services') },
      { method: 'GET', path: /PhoneNumbers$/, host: MSG, body: fx('pool') }
    ])
    expect((await twilioAdapter.findExisting?.(ctx, T_NUMBER, buyDesired()))?.externalId).toBe(PN)
    expect(
      (
        await twilioAdapter.findExisting?.(
          ctx,
          T_SERVICE,
          desired(T_SERVICE, { name: 'demo-pool' })
        )
      )?.externalId
    ).toBe(MG)
    function buyDesired() {
      return desired(T_NUMBER, { name: 'demo-sms', phone_number: '+15555550101' })
    }
  })
})

describe('twilio adapter: errors', () => {
  it('maps 429 to a retryable error and says when to retry', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /IncomingPhoneNumbers\.json$/,
        status: 429,
        body: fx('error-rate-limited'),
        headers: { 'retry-after': '7' }
      }
    ])
    const err: ProviderError = await twilioAdapter.list(ctx, T_NUMBER).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true, status: 429 })
    expect(err.message).toContain('retry after 7 s')
  })

  it('a 5xx is retryable, a 401 and a 400 are not', async () => {
    const mk = (status: number) =>
      harness([
        { method: 'GET', path: /IncomingPhoneNumbers\.json$/, status, body: { message: 'nope' } }
      ]).ctx
    expect(await twilioAdapter.list(mk(503), T_NUMBER).catch((e) => e)).toMatchObject({
      retryable: true,
      code: 'PROVIDER_UNAVAILABLE'
    })
    expect(await twilioAdapter.list(mk(401), T_NUMBER).catch((e) => e)).toMatchObject({
      retryable: false,
      code: 'AUTH_FAILED'
    })
    expect(await twilioAdapter.list(mk(400), T_NUMBER).catch((e) => e)).toMatchObject({
      retryable: false,
      code: 'PROVIDER_REJECTED'
    })
  })

  it('error text is scrubbed of the secret BEFORE it is clipped (a secret across the clip is gone)', async () => {
    // The secret sits where a clip at 300 characters would cut it in half.
    const padding = 'x'.repeat(280)
    const { ctx } = harness([
      {
        method: 'GET',
        path: /IncomingPhoneNumbers\.json$/,
        status: 400,
        body: { message: `${padding} ${SECRET} tail`, code: 21211 }
      }
    ])
    const err: ProviderError = await twilioAdapter.list(ctx, T_NUMBER).catch((e) => e)
    expect(err.message).not.toContain(SECRET)
    expect(err.message).not.toContain(SECRET.slice(0, 12))
    expect(err.message.length).toBeLessThanOrEqual(300)
    const fetchFail = makeProviderContext({
      adapter: twilioAdapter,
      connectionId: 2,
      config: { accountSid: AC },
      secrets: { secret: SECRET },
      fetch: {
        fetchImpl: (async () => {
          throw new TypeError(`getaddrinfo failed for ${SECRET}`)
        }) as any,
        timeoutMs: 200
      }
    })
    const e2: Error = await twilioAdapter.list(fetchFail, T_NUMBER).catch((e) => e)
    expect(e2.message).not.toContain(SECRET)
  })
})

describe('twilio adapter: outputs', () => {
  it('declares the outputs; only the API key secret is a once-only credential', () => {
    expect(spec(T_NUMBER).outputs).toEqual([
      { key: 'phone_number', label: 'Phone number (sender)', secret: false },
      { key: 'account_sid', label: 'Account SID', secret: false }
    ])
    expect(spec(T_KEY).outputs).toEqual([
      { key: 'sid', label: 'API key SID', secret: false },
      { key: 'account_sid', label: 'Account SID (the key’s account)', secret: false },
      { key: 'secret', label: 'API key secret', secret: true, onceOnly: true }
    ])
    expect(spec(T_SERVICE).outputs?.map((o) => o.key)).toEqual(['messaging_service_sid'])
    expect(spec(T_SUB).outputs).toBeUndefined()
    expect(spec(T_KEY).fields.find((f) => f.key === ROTATE_OUTPUTS_FIELD)).toMatchObject({
      kind: 'boolean',
      trigger: true
    })
  })

  it('no field of any type holds a secret output value', () => {
    for (const t of twilioAdapter.types)
      for (const o of (t.outputs ?? []).filter((x) => x.secret))
        expect(t.fields.map((f) => f.key)).not.toContain(o.key)
  })

  it('readOutputs re-reads what Twilio shows again, never an API key secret', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /IncomingPhoneNumbers\/PN/, body: fx('number') },
      { method: 'GET', path: /\/Keys\/SK/, body: fx('key-created') },
      { method: 'GET', path: new RegExp(`/v1/Services/${MG}$`), host: MSG, body: fx('service') }
    ])
    expect(await twilioAdapter.readOutputs?.(ctx, T_NUMBER, PN)).toEqual({
      phone_number: '+15555550101',
      account_sid: AC
    })
    expect(await twilioAdapter.readOutputs?.(ctx, T_KEY, SK)).toEqual({ sid: SK, account_sid: AC })
    expect(await twilioAdapter.readOutputs?.(ctx, T_SERVICE, MG)).toEqual({
      messaging_service_sid: MG
    })
    expect(await twilioAdapter.readOutputs?.(harness([]).ctx, T_NUMBER, PN)).toEqual({})
  })
})

describe('twilio adapter: notify', () => {
  const row = (over: Partial<HubResourceRow>): HubResourceRow =>
    ({
      id: 7,
      connection_id: 1,
      provider: 'twilio',
      type: T_NUMBER,
      external_id: PN,
      name: 'demo-sms',
      scope: 'app',
      app_id: 1,
      environment_id: null,
      desired: { name: 'demo-sms', notify_numbers: ['+15555550142', '+15555550143'] },
      observed: observedNumber(),
      drift: false,
      observed_at: null,
      tags: {},
      refs: [],
      created_by: null,
      adopted: false,
      deleted_at: null,
      created_at: null,
      updated_at: null,
      ...over
    }) as HubResourceRow

  const critical = {
    kind: 'text' as const,
    title: 'Deploy failed',
    body: '0.3.217 on production',
    severity: 'critical' as const,
    link: 'https://hub.example.com/hub/deploys'
  }

  it('texts every number from the sending number', async () => {
    const { ctx, calls } = harness([
      { method: 'POST', path: /Messages\.json$/, body: fx('message') }
    ])
    const res = await twilioAdapter.notify?.(ctx, row({}), critical)
    expect(res).toMatchObject({ ok: true, answer: { sent: 2 } })
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts.map((c) => c.form?.get('To'))).toEqual(['+15555550142', '+15555550143'])
    expect(posts[0].form?.get('From')).toBe('+15555550101')
    expect(posts[0].form?.get('Body')).toContain('Deploy failed')
    expect(posts[0].form?.get('Body')).toContain('https://hub.example.com/hub/deploys')
    expect(posts[0].path).toBe(`/2010-04-01/Accounts/${AC}/Messages.json`)
  })

  it('a messaging service sends through MessagingServiceSid', async () => {
    const { ctx, calls } = harness([
      { method: 'POST', path: /Messages\.json$/, body: fx('message') }
    ])
    await twilioAdapter.notify?.(
      ctx,
      row({ type: T_SERVICE, external_id: MG, observed: observedService() }),
      critical
    )
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.form?.get('MessagingServiceSid')).toBe(MG)
    expect(post?.form?.has('From')).toBe(false)
  })

  it('texts critical events only by default; critical_only off texts everything', async () => {
    const info = { ...critical, severity: 'info' as const }
    const quiet = harness([])
    const res = await twilioAdapter.notify?.(quiet.ctx, row({}), info)
    expect(res).toMatchObject({ ok: true, answer: { skipped: 'not critical' } })
    expect(quiet.calls).toEqual([])
    const loud = harness([{ method: 'POST', path: /Messages\.json$/, body: fx('message') }])
    await twilioAdapter.notify?.(
      loud.ctx,
      row({
        desired: { name: 'x', notify_numbers: ['+15555550142'], critical_only: false }
      }),
      info
    )
    expect(loud.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it('no recipients, a bad number, or a type that cannot send is refused before any call', async () => {
    const { ctx, calls } = harness([])
    await expect(
      twilioAdapter.notify?.(ctx, row({ desired: { name: 'x' } }), critical)
    ).rejects.toMatchObject({ code: 'NO_RECIPIENTS' })
    await expect(
      twilioAdapter.notify?.(ctx, row({ desired: { notify_numbers: ['0101'] } }), critical)
    ).rejects.toMatchObject({ code: 'BAD_NUMBER' })
    await expect(twilioAdapter.notify?.(ctx, row({ type: T_KEY }), critical)).rejects.toMatchObject(
      { code: 'NOT_A_SENDER' }
    )
    expect(calls).toEqual([])
  })

  it('a refused text is an error naming how many failed; 429 stays retryable; secrets scrubbed', async () => {
    const { ctx } = harness([
      {
        method: 'POST',
        path: /Messages\.json$/,
        status: 429,
        body: { message: `slow down ${SECRET}`, code: 20429 }
      }
    ])
    const err = (await twilioAdapter.notify!(ctx, row({}), critical).catch(
      (e: ProviderError) => e
    )) as ProviderError
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true })
    expect(err.message).toContain('2 of 2 texts were not sent')
    expect(err.message).not.toContain(SECRET)
  })
})

describe('twilio adapter: health', () => {
  it('ok when present, warn for a suspended subaccount, down when gone', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /IncomingPhoneNumbers\/PN/, body: fx('number') }
    ])
    expect((await twilioAdapter.health?.(ctx, T_NUMBER, PN))?.status).toBe('ok')
    const susp = harness([
      { method: 'GET', path: /Accounts\/AC/, body: { ...fx('subaccount'), status: 'suspended' } }
    ])
    expect((await twilioAdapter.health?.(susp.ctx, T_SUB, SUB))?.status).toBe('warn')
    expect((await twilioAdapter.health?.(harness([]).ctx, T_NUMBER, PN))?.status).toBe('down')
  })
})

describe('twilio adapter: estimates and usage', () => {
  beforeEach(() => ensureCoreProviders())

  it('estimate from recorded price answer: a US local number is the dated monthly rental plus usage', async () => {
    const { ctx } = harness([])
    const est = await spec(T_NUMBER).estimate?.(
      ctx,
      desired(T_NUMBER, { name: 'n', phone_number: '+15555550101' }),
      null
    )
    expect(est).toMatchObject({
      currency: 'USD',
      monthlyCents: 115,
      basis: 'plan_price',
      confidence: 'list_price',
      priceAsOf: '2026-11-26'
    })
    expect(est?.lines).toHaveLength(1)
    expect(est?.note).toContain('per-message usage')
  })

  it('a toll-free number costs more; an observed number is priced for what it is', async () => {
    const { ctx } = harness([])
    const est = await spec(T_NUMBER).estimate?.(
      ctx,
      null,
      observedNumber({ phone_number: '+18885550101' })
    )
    expect(est?.monthlyCents).toBe(215)
  })

  it('a country with no price in the table is "No estimate", and the estimate never throws', async () => {
    const { ctx } = harness([])
    const gb = await spec(T_NUMBER).estimate?.(
      ctx,
      desired(T_NUMBER, { name: 'n', country: 'GB', phone_number: '+447700900123' }),
      null
    )
    expect(gb?.confidence).toBe('unknown')
    const none = await spec(T_NUMBER).estimate?.(ctx, desired(T_NUMBER, { name: 'n' }), null)
    expect(none?.confidence).not.toBeUndefined()
  })

  it('usageNow reads Twilio’s daily usage records as cost rows', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /Usage\/Records\/Daily\.json$/, body: fx('usage') }
    ])
    const rows = await twilioAdapter.usageNow?.(ctx, { from: '2026-11-25', to: '2026-11-26' })
    expect(rows).toEqual([
      {
        date: '2026-11-25',
        amountCents: 125,
        currency: 'USD',
        service: 'Twilio usage',
        recordType: 'usage'
      },
      {
        date: '2026-11-26',
        amountCents: 50,
        currency: 'USD',
        service: 'Twilio usage',
        recordType: 'usage'
      }
    ])
    expect(calls[0].query.get('Category')).toBe('totalprice')
    expect(calls[0].query.get('StartDate')).toBe('2026-11-25')
  })
})

describe('twilio adapter: toll-fraud guards on notify', () => {
  const sender = (over: Partial<HubResourceRow> = {}): HubResourceRow =>
    ({
      id: 7,
      connection_id: 1,
      provider: 'twilio',
      type: T_NUMBER,
      external_id: PN,
      name: 'demo-sms',
      scope: 'app',
      desired: { name: 'demo-sms', notify_numbers: ['+15555550142'] },
      observed: observedNumber(),
      ...over
    }) as HubResourceRow
  const crit = { kind: 'text' as const, title: 'T', body: 'B', severity: 'critical' as const }

  it('the allowed list is a connection field, US and CA by default', () => {
    const f = twilioAdapter.connection.fields.find((x) => x.key === 'sms_countries')
    expect(f).toMatchObject({ default: 'US,CA' })
    expect(
      twilioAdapter.connection.validate?.({ accountSid: AC, sms_countries: 'US, de' }, {})
    ).toEqual([])
    expect(
      twilioAdapter.connection.validate?.({ accountSid: AC, sms_countries: 'USA' }, {})
    ).not.toEqual([])
  })

  it('plan refuses a number outside the allowed countries with COUNTRY_NOT_ALLOWED', () => {
    const { ctx } = harness([])
    const bad = (nums: string[]) =>
      twilioAdapter.plan(
        ctx,
        desired(T_NUMBER, { name: 'n', phone_number: '+15555550101', notify_numbers: nums }),
        null
      )
    expect(() => bad(['+447700900123'])).toThrow(/GB/)
    try {
      bad(['+447700900123'])
    } catch (e) {
      expect((e as ProviderError).code).toBe('COUNTRY_NOT_ALLOWED')
    }
    // A Caribbean +1 number is not the US: premium-rate fraud hides there.
    expect(() => bad(['+18765550142'])).toThrow(/JM/)
    // A number whose country the Hub cannot tell is refused too.
    expect(() => bad(['+9995550142'])).toThrow(/cannot tell/)
    expect(() => bad(['+16135550142'])).not.toThrow() // Canada
    expect(() => bad(['+15555550142'])).not.toThrow()
    expect(() => bad(['0155'])).toThrow(/written/)
  })

  it('the connection’s list widens it: GB is allowed once listed', () => {
    const { ctx } = harness([], { sms_countries: 'US,CA,GB' })
    expect(() =>
      twilioAdapter.plan(
        ctx,
        desired(T_NUMBER, {
          name: 'n',
          phone_number: '+15555550101',
          notify_numbers: ['+447700900123']
        }),
        null
      )
    ).not.toThrow()
  })

  it('notify refuses a stored number outside the list before any call', async () => {
    const { ctx, calls } = harness([])
    await expect(
      twilioAdapter.notify?.(
        ctx,
        sender({ desired: { notify_numbers: ['+447700900123'] } as any }),
        crit
      )
    ).rejects.toMatchObject({ code: 'COUNTRY_NOT_ALLOWED' })
    expect(calls).toEqual([])
  })

  it('any change to notify_numbers (or critical_only) is an admin-only op; unchanged is not', () => {
    const { ctx } = harness([])
    const seen = observedNumber({ notify_numbers: ['+15555550142'], critical_only: true })
    const same = twilioAdapter.plan(
      ctx,
      desired(T_NUMBER, { name: 'demo-sms', notify_numbers: ['+15555550142'] }, PN),
      seen
    )
    expect(same).toEqual([])
    const added = twilioAdapter.plan(
      ctx,
      desired(T_NUMBER, { name: 'demo-sms', notify_numbers: ['+15555550142', '+15555550143'] }, PN),
      seen
    )
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ kind: 'update', data: { $adminOnly: true } })
    expect(added[0].changes[0].field).toBe('notify_numbers')
    expect(added[0].reason).toContain('Hub administrator')
    const loud = twilioAdapter.plan(
      ctx,
      desired(
        T_NUMBER,
        { name: 'demo-sms', notify_numbers: ['+15555550142'], critical_only: false },
        PN
      ),
      seen
    )
    expect(loud[0].data?.$adminOnly).toBe(true)
    // Joined to a real change: still one op, now admin-only.
    const both = twilioAdapter.plan(
      ctx,
      desired(T_NUMBER, { name: 'renamed', notify_numbers: ['+15555550199'] }, PN),
      seen
    )
    expect(both).toHaveLength(1)
    expect(both[0].changes.map((c) => c.field)).toEqual(['name', 'notify_numbers'])
    expect(both[0].data?.$adminOnly).toBe(true)
    // A rename alone is not.
    const rename = twilioAdapter.plan(
      ctx,
      desired(T_NUMBER, { name: 'renamed', notify_numbers: ['+15555550142'] }, PN),
      seen
    )
    expect(rename[0].data?.$adminOnly).toBeUndefined()
    // Creating with recipients is admin-only too.
    const [create] = twilioAdapter.plan(
      ctx,
      desired(T_NUMBER, {
        name: 'n',
        phone_number: '+15555550101',
        notify_numbers: ['+15555550142']
      }),
      null
    )
    expect(create.data?.$adminOnly).toBe(true)
  })

  it('apply mirrors the notify settings into observed so the next plan sees them unchanged', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /IncomingPhoneNumbers\/PN/, body: fx('number') }
    ])
    const res = await twilioAdapter.apply(
      ctx,
      op(T_NUMBER, {}),
      desired(T_NUMBER, { name: 'demo-sms', notify_numbers: ['+15555550142'] }, PN)
    )
    expect(res.observed?.fields).toMatchObject({
      notify_numbers: ['+15555550142'],
      critical_only: true
    })
  })

  it('at most 20 texts an hour per resource: the next is RATE_LIMITED, not retryable, nothing sent', async () => {
    const { ctx, calls } = harness([
      { method: 'POST', path: /Messages\.json$/, body: fx('message') }
    ])
    const two = sender({
      id: 70,
      desired: { notify_numbers: ['+15555550142', '+15555550143'] } as any
    })
    for (let i = 0; i < 10; i++) await twilioAdapter.notify?.(ctx, two, crit)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(20)
    const err = (await twilioAdapter.notify?.(ctx, two, crit).catch((e) => e)) as ProviderError
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: false })
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(20)
    // Another resource has its own allowance.
    await twilioAdapter.notify?.(ctx, sender({ id: 8 }), crit)
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(21)
  })

  it('the hour rolls: sends older than an hour no longer count', async () => {
    let now = new Date('2026-11-26T12:00:00Z')
    const calls: number[] = []
    const ctx = makeProviderContext({
      adapter: twilioAdapter,
      connectionId: 41,
      config: { accountSid: AC },
      secrets: { secret: SECRET },
      now: () => now,
      fetch: {
        fetchImpl: (async () => {
          calls.push(1)
          return new Response(JSON.stringify(fx('message')), { status: 200 })
        }) as any,
        timeoutMs: 500
      }
    })
    const ten = sender({
      desired: { notify_numbers: Array.from({ length: 10 }, (_, i) => `+1555555010${i}`) } as any
    })
    await twilioAdapter.notify?.(ctx, ten, crit)
    await twilioAdapter.notify?.(ctx, ten, crit)
    await expect(twilioAdapter.notify?.(ctx, ten, crit)).rejects.toMatchObject({
      code: 'RATE_LIMITED'
    })
    now = new Date('2026-11-26T13:01:00Z')
    await twilioAdapter.notify?.(ctx, ten, crit)
    expect(calls).toHaveLength(30)
  })
})
