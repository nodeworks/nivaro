import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 42: the Mailgun adapter against recorded (fake-valued) answers.

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
const { mailgunAdapter } = await import('../../../services/hub/providers/mailgun/index.js')

import type { HubResourceRow } from '../../../services/hub/providers/store.js'
import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  ProviderError,
  ROTATE_OUTPUTS_FIELD
} from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/mailgun/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const KEY = 'test-secret-mailgun-key-0001'
const T_DOMAIN = 'mailgun.domain'
const T_CRED = 'mailgun.smtp_credential'
const T_HOOK = 'mailgun.webhook'
const T_KEY = 'mailgun.sending_key'

interface Call {
  method: string
  host: string
  path: string
  query: URLSearchParams
  form: URLSearchParams
  headers: Record<string, string>
}
interface Route {
  method: string
  path: RegExp
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function harness(routes: Route[], region: 'us' | 'eu' = 'us') {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const call: Call = {
      method: String(init?.method ?? 'GET'),
      host: u.host,
      path: u.pathname,
      query: u.searchParams,
      form: new URLSearchParams(init?.body ? String(init.body) : ''),
      headers: init?.headers ?? {}
    }
    calls.push(call)
    const hit = routes.find((r) => r.method === call.method && r.path.test(call.path))
    if (!hit) return new Response('{"message":"not found"}', { status: 404 })
    const status = hit.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(hit.body ?? {}), {
      status,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: mailgunAdapter,
    connectionId: 1,
    config: { region },
    secrets: { apiKey: KEY },
    now: () => new Date('2026-11-26T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return { ctx, calls }
}

function desired(
  type: string,
  fields: Record<string, unknown>,
  externalId: string | null = null,
  refs: DesiredResource['refs'] = {}
): DesiredResource {
  return {
    resourceId: 7,
    type,
    externalId,
    scope: type === T_DOMAIN ? 'shared' : 'app',
    appId: 1,
    environmentId: 2,
    fields,
    refs,
    tags: {}
  }
}

const op = (type: string, over: Partial<PlannedOp>): PlannedOp => ({
  kind: 'update',
  type,
  resourceId: 7,
  externalId: null,
  reason: '',
  changes: [],
  preconditions: {},
  risk: [],
  ...over
})

const typeSpec = (key: string) => mailgunAdapter.types.find((t) => t.key === key)!

const domObs = (over: Record<string, unknown> = {}): Observed => ({
  type: T_DOMAIN,
  externalId: 'mg.example.com',
  name: 'mg.example.com',
  fields: {
    name: 'mg.example.com',
    web_scheme: 'https',
    spam_action: 'disabled',
    wildcard: false,
    state: 'active',
    verified: true,
    dns_valid: true,
    ...over
  },
  tags: {}
})

const credObs = (): Observed => ({
  type: T_CRED,
  externalId: 'mg.example.com:demo-app',
  name: 'demo-app@mg.example.com',
  fields: { domain: 'mg.example.com', login: 'demo-app' },
  tags: {}
})

const hookObs = (over: Record<string, unknown> = {}): Observed => ({
  type: T_HOOK,
  externalId: 'mg.example.com:delivered',
  name: 'delivered on mg.example.com',
  fields: {
    domain: 'mg.example.com',
    event: 'delivered',
    url: 'https://hooks.example.com/mailgun',
    other_urls: 0,
    ...over
  },
  tags: {}
})

const keyObs = (): Observed => ({
  type: T_KEY,
  externalId: 'fake-key-id-0001',
  name: 'demo-app-sending',
  fields: {
    domain: 'mg.example.com',
    description: 'demo-app-sending',
    role: 'sending',
    kind: 'domain',
    disabled: false
  },
  tags: {}
})

const DOM_REF = { domain: 'mg.example.com' }

beforeEach(() => {
  registry.resetProvidersForTest?.()
  ensureCoreProviders()
})

describe('registration', () => {
  it('is a core provider with the four types', () => {
    expect(CORE_PROVIDERS).toContain(mailgunAdapter)
    expect(registry.getProvider('mailgun')).toBe(mailgunAdapter)
    expect(mailgunAdapter.types.map((t) => t.key).sort()).toEqual(
      [T_CRED, T_DOMAIN, T_KEY, T_HOOK].sort()
    )
  })

  it('uses the region host and refuses the other one', async () => {
    expect(mailgunAdapter.connection.hosts({ region: 'eu' })).toEqual(['api.eu.mailgun.net'])
    expect(mailgunAdapter.connection.hosts({ region: 'us' })).toEqual(['api.mailgun.net'])
    const eu = harness([{ method: 'GET', path: /domains$/, body: fx('domains') }], 'eu')
    await mailgunAdapter.list(eu.ctx, T_DOMAIN)
    expect(eu.calls[0].host).toBe('api.eu.mailgun.net')
    expect(mailgunAdapter.connection.validate?.({ region: 'asia' }, {})).toHaveLength(1)
  })
})

describe('mailgun testConnection lists missing permissions', () => {
  it('reports each permission and the missing ones', async () => {
    const h = harness([
      { method: 'GET', path: /^\/v4\/domains$/, body: fx('domains') },
      { method: 'GET', path: /^\/v1\/keys$/, status: 403, body: { message: 'Forbidden' } }
    ])
    const t = await mailgunAdapter.testConnection(h.ctx)
    expect(t.ok).toBe(true)
    expect(t.permissions.find((p) => p.type === T_KEY)?.has).toBe(false)
    expect(t.missing.length).toBe(1)
    expect(t.identity).toContain('api.mailgun.net')
  })

  it('answers not ok with a scrubbed message on a bad key', async () => {
    const h = harness([
      { method: 'GET', path: /^\/v4\/domains$/, status: 401, body: fx('error-unauthorized') }
    ])
    const t = await mailgunAdapter.testConnection(h.ctx)
    expect(t.ok).toBe(false)
    expect(JSON.stringify(t)).not.toContain(KEY)
  })
})

describe('mailgun observe maps provider fields', () => {
  it('maps a domain, keeps the DNS records out of observed', async () => {
    const h = harness([
      { method: 'GET', path: /^\/v4\/domains\/mg\.example\.com$/, body: fx('domain') }
    ])
    const o = await mailgunAdapter.observe(h.ctx, T_DOMAIN, 'mg.example.com')
    expect(o?.fields).toMatchObject({ name: 'mg.example.com', verified: true, dns_valid: true })
    expect(JSON.stringify(o)).not.toContain('FAKEDKIMPUBLICKEY')
    expect(h.calls[0].headers.authorization).toBe(
      `Basic ${Buffer.from(`api:${KEY}`).toString('base64')}`
    )
  })

  it('maps a login, a webhook and a sending key; null when gone', async () => {
    const h = harness([
      { method: 'GET', path: /credentials$/, body: fx('credentials') },
      { method: 'GET', path: /webhooks\/delivered$/, body: fx('webhook') },
      { method: 'GET', path: /^\/v1\/keys$/, body: fx('keys') }
    ])
    expect(
      (await mailgunAdapter.observe(h.ctx, T_CRED, 'mg.example.com:demo-app'))?.fields
    ).toMatchObject({
      login: 'demo-app'
    })
    expect(await mailgunAdapter.observe(h.ctx, T_CRED, 'mg.example.com:nobody')).toBeNull()
    expect(
      (await mailgunAdapter.observe(h.ctx, T_HOOK, 'mg.example.com:delivered'))?.fields.url
    ).toBe('https://hooks.example.com/mailgun')
    expect((await mailgunAdapter.observe(h.ctx, T_KEY, 'fake-key-id-0001'))?.fields.domain).toBe(
      'mg.example.com'
    )
    expect(await mailgunAdapter.observe(h.ctx, T_KEY, 'other')).toBeNull()
  })

  it('refuses ids that are not a name', async () => {
    const h = harness([])
    await expect(mailgunAdapter.observe(h.ctx, T_DOMAIN, '../x')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    await expect(
      mailgunAdapter.observe(h.ctx, T_CRED, 'mg.example.com:../x')
    ).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    expect(h.calls).toHaveLength(0)
  })
})

describe('mailgun plan diff per type', () => {
  const ctx = harness([]).ctx

  it('domain: create, update, replace, verify, delete', () => {
    const f = {
      name: 'mg.example.com',
      web_scheme: 'https',
      spam_action: 'disabled',
      wildcard: false
    }
    expect(mailgunAdapter.plan(ctx, desired(T_DOMAIN, f), null)[0].kind).toBe('create')
    expect(mailgunAdapter.plan(ctx, desired(T_DOMAIN, f, 'mg.example.com'), domObs())).toEqual([])
    const upd = mailgunAdapter.plan(
      ctx,
      desired(T_DOMAIN, { ...f, spam_action: 'block' }, 'mg.example.com'),
      domObs()
    )
    expect(upd[0].changes).toEqual([{ field: 'spam_action', from: 'disabled', to: 'block' }])
    expect(
      mailgunAdapter.plan(
        ctx,
        desired(T_DOMAIN, { ...f, name: 'mail.example.com' }, 'mg.example.com'),
        domObs()
      )[0].kind
    ).toBe('replace')
    const v = mailgunAdapter.plan(
      ctx,
      desired(T_DOMAIN, { ...f, ['verify']: true }, 'mg.example.com'),
      domObs({ verified: false, state: 'unverified' })
    )
    expect(v[0].action).toBe('verify')
    expect(mailgunAdapter.plan(ctx, null, domObs())[0].kind).toBe('delete')
  })

  it('domain: a recipients-only change plans an admin-only save, and is a no-op once echoed', () => {
    const f = { name: 'mg.example.com', recipients: ['ops@example.com'] }
    const first = mailgunAdapter.plan(ctx, desired(T_DOMAIN, f, 'mg.example.com'), domObs())
    expect(first).toHaveLength(1)
    expect(first[0].action).toBe('save_notify')
    expect(first[0].data?.$adminOnly).toBe(true)
    const echoed = domObs({ recipients: ['ops@example.com'], notify_from: 'nivaro-hub' })
    expect(mailgunAdapter.plan(ctx, desired(T_DOMAIN, f, 'mg.example.com'), echoed)).toEqual([])
    expect(() =>
      mailgunAdapter.plan(
        ctx,
        desired(T_DOMAIN, { name: 'mg.example.com', recipients: ['nope'] }),
        null
      )
    ).toThrow(ProviderError)
  })

  it('login: create, replace on a new login, rotate, delete', () => {
    const d = desired(T_CRED, { login: 'demo-app' }, null, DOM_REF)
    expect(mailgunAdapter.plan(ctx, d, null)[0].kind).toBe('create')
    expect(
      mailgunAdapter.plan(
        ctx,
        desired(T_CRED, { login: 'demo-app' }, 'mg.example.com:demo-app', DOM_REF),
        credObs()
      )
    ).toEqual([])
    expect(
      mailgunAdapter.plan(
        ctx,
        desired(T_CRED, { login: 'other' }, 'mg.example.com:demo-app', DOM_REF),
        credObs()
      )[0].kind
    ).toBe('replace')
    const rot = mailgunAdapter.plan(
      ctx,
      desired(
        T_CRED,
        { login: 'demo-app', [ROTATE_OUTPUTS_FIELD]: true },
        'mg.example.com:demo-app',
        DOM_REF
      ),
      credObs()
    )
    expect(rot[0].action).toBe('rotate')
    expect(mailgunAdapter.plan(ctx, null, credObs())[0].kind).toBe('delete')
  })

  it('webhook: needs https, one address per event, never touches other addresses', () => {
    const f = { event: 'delivered', url: 'https://hooks.example.com/mailgun' }
    expect(mailgunAdapter.plan(ctx, desired(T_HOOK, f, null, DOM_REF), null)[0].kind).toBe('create')
    expect(() =>
      mailgunAdapter.plan(
        ctx,
        desired(T_HOOK, { ...f, url: 'http://hooks.example.com' }, null, DOM_REF),
        null
      )
    ).toThrow(ProviderError)
    const upd = mailgunAdapter.plan(
      ctx,
      desired(
        T_HOOK,
        { ...f, url: 'https://hooks.example.com/new' },
        'mg.example.com:delivered',
        DOM_REF
      ),
      hookObs()
    )
    expect(upd[0].kind).toBe('update')
    expect(upd[0].data?.$adminOnly).toBe(true)
    expect(() =>
      mailgunAdapter.plan(
        ctx,
        desired(
          T_HOOK,
          { ...f, url: 'https://hooks.example.com/new' },
          'mg.example.com:delivered',
          DOM_REF
        ),
        hookObs({ other_urls: 1 })
      )
    ).toThrow(/other addresses/)
    expect(() => mailgunAdapter.plan(ctx, null, hookObs({ other_urls: 2 }))).toThrow(ProviderError)
  })

  it('sending key: create, replace on rename, rotate, delete', () => {
    const d = desired(T_KEY, { description: 'demo-app-sending' }, null, DOM_REF)
    expect(mailgunAdapter.plan(ctx, d, null)[0].kind).toBe('create')
    expect(mailgunAdapter.plan(ctx, { ...d, externalId: 'fake-key-id-0001' }, keyObs())).toEqual([])
    expect(
      mailgunAdapter.plan(
        ctx,
        desired(T_KEY, { description: 'renamed' }, 'fake-key-id-0001', DOM_REF),
        keyObs()
      )[0].kind
    ).toBe('replace')
    expect(
      mailgunAdapter.plan(
        ctx,
        desired(
          T_KEY,
          { description: 'demo-app-sending', [ROTATE_OUTPUTS_FIELD]: true },
          'fake-key-id-0001',
          DOM_REF
        ),
        keyObs()
      )[0].action
    ).toBe('rotate')
    expect(mailgunAdapter.plan(ctx, null, keyObs())[0].kind).toBe('delete')
  })
})

describe('mailgun apply is idempotent (read-before-write)', () => {
  it('domain create: refuses one that already exists, records DNS as an output', async () => {
    const exists = harness([
      { method: 'GET', path: /^\/v4\/domains\/mg\.example\.com$/, body: fx('domain') }
    ])
    const d = desired(T_DOMAIN, { name: 'mg.example.com' })
    await expect(
      mailgunAdapter.apply(exists.ctx, op(T_DOMAIN, { kind: 'create' }), d)
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(exists.calls.some((c) => c.method === 'POST')).toBe(false)

    const fresh = harness([
      { method: 'GET', path: /^\/v4\/domains\/mg\.example\.com$/, status: 404, body: {} },
      { method: 'POST', path: /^\/v4\/domains$/, body: fx('domain-unverified') }
    ])
    const r = await mailgunAdapter.apply(fresh.ctx, op(T_DOMAIN, { kind: 'create' }), d)
    expect(r.ok).toBe(true)
    expect(r.externalId).toBe('mg.example.com')
    expect(JSON.parse(r.outputs?.dns_records ?? '[]')).toHaveLength(3)
    expect(JSON.stringify({ ...r, outputs: undefined })).not.toContain('FAKEDKIMPUBLICKEY')
    expect(fresh.calls.find((c) => c.method === 'POST')?.form.get('name')).toBe('mg.example.com')
  })

  it('domain update that already matches writes nothing; resume of a create re-reads', async () => {
    const h = harness([
      { method: 'GET', path: /^\/v4\/domains\/mg\.example\.com$/, body: fx('domain') }
    ])
    const d = desired(
      T_DOMAIN,
      { name: 'mg.example.com', spam_action: 'disabled' },
      'mg.example.com'
    )
    const r = await mailgunAdapter.apply(
      h.ctx,
      op(T_DOMAIN, {
        externalId: 'mg.example.com',
        changes: [{ field: 'spam_action', to: 'disabled' }]
      }),
      d
    )
    expect(r.answer).toEqual({ already: 'matches' })
    expect(h.calls.every((c) => c.method === 'GET')).toBe(true)
    const resumed = await mailgunAdapter.apply(h.ctx, op(T_DOMAIN, { kind: 'create' }), d)
    expect(resumed.answer).toEqual({ already: 'exists' })
  })

  it('domain verify: not valid yet is retryable and names the records', async () => {
    const h = harness([
      { method: 'GET', path: /^\/v4\/domains\/mg\.example\.com$/, body: fx('domain-unverified') },
      { method: 'PUT', path: /\/verify$/, body: fx('domain-unverified') }
    ])
    await expect(
      mailgunAdapter.apply(
        h.ctx,
        op(T_DOMAIN, { externalId: 'mg.example.com', action: 'verify' }),
        desired(T_DOMAIN, { name: 'mg.example.com' }, 'mg.example.com')
      )
    ).rejects.toMatchObject({ code: 'NOT_VALID_YET', retryable: true })
  })

  it('domain save_notify writes nothing to Mailgun and echoes the recipients into observed', async () => {
    const h = harness([
      { method: 'GET', path: /^\/v4\/domains\/mg\.example\.com$/, body: fx('domain') }
    ])
    const d = desired(
      T_DOMAIN,
      { name: 'mg.example.com', recipients: ['ops@example.com'] },
      'mg.example.com'
    )
    const r = await mailgunAdapter.apply(
      h.ctx,
      op(T_DOMAIN, { externalId: 'mg.example.com', action: 'save_notify' }),
      d
    )
    expect(h.calls.every((c) => c.method === 'GET')).toBe(true)
    expect(r.observed?.fields.recipients).toEqual(['ops@example.com'])
  })

  it('login create makes a password, seals it as an output only, and refuses a match', async () => {
    const h = harness([
      { method: 'GET', path: /credentials$/, body: { total_count: 0, items: [] } },
      { method: 'POST', path: /credentials$/, body: { message: 'Created 1 credentials pair(s)' } }
    ])
    const r = await mailgunAdapter.apply(
      h.ctx,
      op(T_CRED, { kind: 'create' }),
      desired(T_CRED, { login: 'demo-app' }, null, DOM_REF)
    )
    const pass = r.outputs?.smtp_pass ?? ''
    expect(pass.length).toBeGreaterThanOrEqual(5)
    expect(pass.length).toBeLessThanOrEqual(32)
    expect(r.outputs).toMatchObject({
      smtp_host: 'smtp.mailgun.org',
      smtp_port: '587',
      smtp_user: 'demo-app@mg.example.com'
    })
    expect(h.calls.find((c) => c.method === 'POST')?.form.get('password')).toBe(pass)
    expect(JSON.stringify({ ...r, outputs: undefined })).not.toContain(pass)

    const taken = harness([{ method: 'GET', path: /credentials$/, body: fx('credentials') }])
    await expect(
      mailgunAdapter.apply(
        taken.ctx,
        op(T_CRED, { kind: 'create' }),
        desired(T_CRED, { login: 'demo-app' }, null, DOM_REF)
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
  })

  it('login resume keeps the constants only; rotate resets the password in place', async () => {
    const h = harness([
      { method: 'GET', path: /credentials$/, body: fx('credentials') },
      { method: 'PUT', path: /credentials\/demo-app$/, body: { message: 'Password changed' } }
    ])
    const resumed = await mailgunAdapter.apply(
      h.ctx,
      op(T_CRED, { kind: 'create' }),
      desired(T_CRED, { login: 'demo-app' }, 'mg.example.com:demo-app', DOM_REF)
    )
    expect(resumed.outputs?.smtp_pass).toBeUndefined()
    const rot = await mailgunAdapter.apply(
      h.ctx,
      op(T_CRED, { externalId: 'mg.example.com:demo-app', action: 'rotate' }),
      desired(T_CRED, { login: 'demo-app' }, 'mg.example.com:demo-app', DOM_REF)
    )
    expect(rot.outputs?.smtp_pass).toBeTruthy()
    expect(h.calls.find((c) => c.method === 'PUT')?.form.get('password')).toBe(
      rot.outputs?.smtp_pass
    )
  })

  it('webhook create refuses an event that already has addresses', async () => {
    const h = harness([{ method: 'GET', path: /webhooks\/delivered$/, body: fx('webhook') }])
    await expect(
      mailgunAdapter.apply(
        h.ctx,
        op(T_HOOK, { kind: 'create' }),
        desired(
          T_HOOK,
          { event: 'delivered', url: 'https://hooks.example.com/other' },
          null,
          DOM_REF
        )
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('webhook create, update and a stopped delete when other addresses exist', async () => {
    const make = harness([
      { method: 'GET', path: /webhooks\/delivered$/, status: 404, body: {} },
      { method: 'POST', path: /webhooks$/, body: { message: 'ok' } }
    ])
    const r = await mailgunAdapter.apply(
      make.ctx,
      op(T_HOOK, { kind: 'create' }),
      desired(
        T_HOOK,
        { event: 'delivered', url: 'https://hooks.example.com/mailgun' },
        null,
        DOM_REF
      )
    )
    expect(r.externalId).toBe('mg.example.com:delivered')
    expect(make.calls.find((c) => c.method === 'POST')?.form.get('id')).toBe('delivered')

    const many = harness([
      {
        method: 'GET',
        path: /webhooks\/delivered$/,
        body: { webhook: { urls: ['https://a.example.com', 'https://b.example.com'] } }
      }
    ])
    await expect(
      mailgunAdapter.apply(
        many.ctx,
        op(T_HOOK, { kind: 'delete', externalId: 'mg.example.com:delivered' }),
        null
      )
    ).rejects.toMatchObject({ code: 'HAS_OTHER_URLS' })
    expect(many.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('sending key create seals the value, rotate keeps the old key and scopes to its domain', async () => {
    const h = harness([
      { method: 'GET', path: /^\/v1\/keys$/, body: { total_count: 0, items: [] } },
      { method: 'POST', path: /^\/v1\/keys$/, body: fx('key-create') }
    ])
    const r = await mailgunAdapter.apply(
      h.ctx,
      op(T_KEY, { kind: 'create' }),
      desired(T_KEY, { description: 'demo-app-sending' }, null, DOM_REF)
    )
    expect(r.outputs?.api_key).toBe('test-secret-mailgun-sending-key-0002')
    expect(JSON.stringify({ ...r, outputs: undefined })).not.toContain(
      'test-secret-mailgun-sending-key-0002'
    )
    expect(h.calls.find((c) => c.method === 'POST')?.form.get('domain_name')).toBe('mg.example.com')

    const rot = harness([
      { method: 'GET', path: /^\/v1\/keys$/, body: fx('keys') },
      { method: 'POST', path: /^\/v1\/keys$/, body: fx('key-create') }
    ])
    const rr = await mailgunAdapter.apply(
      rot.ctx,
      op(T_KEY, { externalId: 'fake-key-id-0001', action: 'rotate' }),
      // desired names another domain: the new key still follows the existing one's domain
      desired(T_KEY, { description: 'demo-app-sending' }, 'fake-key-id-0001', {
        domain: 'evil.example.com'
      })
    )
    expect(rr.answer).toMatchObject({ rotated: true, previous_key_kept: true })
    expect(rot.calls.find((c) => c.method === 'POST')?.form.get('domain_name')).toBe(
      'mg.example.com'
    )
    expect(rot.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('refuses a step for a different resource than it was planned for', async () => {
    const h = harness([
      { method: 'GET', path: /^\/v4\/domains\/mg\.example\.com$/, body: fx('domain') }
    ])
    await expect(
      mailgunAdapter.apply(
        h.ctx,
        op(T_DOMAIN, { externalId: 'mg.example.com' }),
        desired(T_DOMAIN, { name: 'x.example.com' }, 'other.example.com')
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })
})

describe('mailgun maps 429 to retryable', () => {
  it('429 and 5xx are retryable, 400 is not', async () => {
    const limited = harness([
      {
        method: 'GET',
        path: /^\/v4\/domains\/mg\.example\.com$/,
        status: 429,
        headers: { 'retry-after': '30' },
        body: { message: 'slow down' }
      }
    ])
    await expect(
      mailgunAdapter.observe(limited.ctx, T_DOMAIN, 'mg.example.com')
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true
    })
    const down = harness([
      { method: 'GET', path: /^\/v4\/domains\/mg\.example\.com$/, status: 503, body: {} }
    ])
    await expect(
      mailgunAdapter.observe(down.ctx, T_DOMAIN, 'mg.example.com')
    ).rejects.toMatchObject({
      retryable: true
    })
    const bad = harness([
      { method: 'POST', path: /^\/v4\/domains$/, status: 400, body: { message: 'bad' } }
    ])
    await expect(
      mailgunAdapter.apply(
        bad.ctx,
        op(T_DOMAIN, { kind: 'create' }),
        desired(T_DOMAIN, { name: 'mg.example.com' })
      )
    ).rejects.toMatchObject({ retryable: false })
  })
})

describe('mailgun risk flags per type', () => {
  it('flags deletes, rotation downtime and webhook exposure', () => {
    expect(typeSpec(T_DOMAIN).risk(op(T_DOMAIN, { kind: 'delete' }), null)).toEqual([
      'destructive',
      'downtime'
    ])
    expect(typeSpec(T_DOMAIN).risk(op(T_DOMAIN, { kind: 'update' }), null)).toEqual([])
    expect(typeSpec(T_CRED).risk(op(T_CRED, { action: 'rotate' }), null)).toEqual(['downtime'])
    expect(typeSpec(T_CRED).risk(op(T_CRED, { kind: 'delete' }), null)).toEqual(['destructive'])
    const hook = desired(T_HOOK, { event: 'delivered', url: 'https://x.example.com' })
    expect(
      typeSpec(T_HOOK).risk(
        op(T_HOOK, { kind: 'create', changes: [{ field: 'url', to: 'https://x.example.com' }] }),
        hook
      )
    ).toContain('public_exposure')
    expect(typeSpec(T_KEY).risk(op(T_KEY, { kind: 'delete' }), null)).toEqual(['destructive'])
    for (const t of mailgunAdapter.types) expect(t.costClass).toBeUndefined()
  })
})

describe('mailgun secrets never appear in errors', () => {
  it('scrubs the key and its basic-auth form from provider text', async () => {
    const basic = Buffer.from(`api:${KEY}`).toString('base64')
    const h = harness([
      {
        method: 'GET',
        path: /^\/v4\/domains\/mg\.example\.com$/,
        status: 401,
        body: { message: `Invalid ${KEY} / ${basic}` }
      }
    ])
    const err = await mailgunAdapter.observe(h.ctx, T_DOMAIN, 'mg.example.com').catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.message).not.toContain(KEY)
    expect(err.message).not.toContain(basic)
  })

  it('scrubs a password it generated when Mailgun echoes it', async () => {
    let sent = ''
    const routes: Route[] = [
      { method: 'GET', path: /credentials$/, body: { total_count: 0, items: [] } }
    ]
    const h = harness(routes)
    const base = h.ctx.fetch
    h.ctx.fetch = async (url, init) => {
      if (init?.method === 'POST') {
        sent = new URLSearchParams(String(init.body)).get('password') ?? ''
        return new Response(JSON.stringify({ message: `password ${sent} is too weak` }), {
          status: 400
        })
      }
      return base(url, init)
    }
    const err = await mailgunAdapter
      .apply(
        h.ctx,
        op(T_CRED, { kind: 'create' }),
        desired(T_CRED, { login: 'demo-app' }, null, DOM_REF)
      )
      .catch((e) => e)
    expect(sent.length).toBeGreaterThan(0)
    expect(err.message).not.toContain(sent)
  })
})

describe('mailgun declares outputs and none leak into observed/desired', () => {
  it('declares the outputs with the right secrecy', () => {
    const cred = typeSpec(T_CRED).outputs ?? []
    expect(cred.find((o) => o.key === 'smtp_pass')).toMatchObject({ secret: true, onceOnly: true })
    expect(
      cred
        .filter((o) => !o.secret)
        .map((o) => o.key)
        .sort()
    ).toEqual(['smtp_host', 'smtp_port', 'smtp_user'])
    expect(typeSpec(T_KEY).outputs?.[0]).toMatchObject({
      key: 'api_key',
      secret: true,
      onceOnly: true
    })
    expect(typeSpec(T_DOMAIN).outputs?.[0]).toMatchObject({ key: 'dns_records', secret: false })
    for (const t of mailgunAdapter.types)
      for (const o of t.outputs ?? []) expect(t.fields.some((f) => f.key === o.key)).toBe(false)
  })

  it('the EU region fills the EU SMTP host', async () => {
    const eu = harness([{ method: 'GET', path: /credentials$/, body: fx('credentials') }], 'eu')
    const out = await mailgunAdapter.readOutputs?.(eu.ctx, T_CRED, 'mg.example.com:demo-app')
    expect(out).toMatchObject({
      smtp_host: 'smtp.eu.mailgun.org',
      smtp_user: 'demo-app@mg.example.com'
    })
    expect(out?.smtp_pass).toBeUndefined()
  })

  it('readOutputs never answers a once-only value', async () => {
    const h = harness([{ method: 'GET', path: /^\/v1\/keys$/, body: fx('keys') }])
    expect(await mailgunAdapter.readOutputs?.(h.ctx, T_KEY, 'fake-key-id-0001')).toEqual({})
  })
})

describe('mailgun notify sends one message and maps 429 to retryable', () => {
  const row = (over: Record<string, unknown> = {}): HubResourceRow =>
    ({
      id: 7,
      type: T_DOMAIN,
      external_id: 'mg.example.com',
      desired: { recipients: ['ops@example.com', 'dev@example.com'], notify_from: 'hub', ...over }
    }) as unknown as HubResourceRow
  const msg = {
    kind: 'text' as const,
    title: 'Deploy failed\r\nBcc: x@evil.test',
    body: 'It broke <b>',
    severity: 'critical' as const
  }

  it('sends one batch, one copy each, from the domain, with a clean subject', async () => {
    const h = harness([
      { method: 'GET', path: /^\/v4\/domains\/mg\.example\.com$/, body: fx('domain') },
      {
        method: 'POST',
        path: /^\/v3\/mg\.example\.com\/messages$/,
        body: { id: '<x>', message: 'Queued' }
      }
    ])
    const r = await mailgunAdapter.notify!(h.ctx, row(), msg)
    expect(r.answer).toEqual({ sent: 2 })
    const post = h.calls.find((c) => c.method === 'POST')!
    expect(post.form.get('from')).toBe('hub@mg.example.com')
    expect(post.form.getAll('to')).toEqual(['ops@example.com', 'dev@example.com'])
    expect(Object.keys(JSON.parse(post.form.get('recipient-variables') ?? '{}'))).toHaveLength(2)
    expect(post.form.get('subject')).toBe('[Critical] Deploy failed Bcc: x@evil.test')
    expect(post.form.get('html')).toContain('&lt;b&gt;')
  })

  it('refuses no recipients, an unverified domain and a non-domain; 429 is retryable', async () => {
    const h = harness([
      { method: 'GET', path: /^\/v4\/domains\/mg\.example\.com$/, body: fx('domain-unverified') }
    ])
    await expect(mailgunAdapter.notify!(h.ctx, row({ recipients: [] }), msg)).rejects.toMatchObject(
      { code: 'NO_RECIPIENTS' }
    )
    await expect(mailgunAdapter.notify!(h.ctx, row(), msg)).rejects.toMatchObject({
      code: 'DOMAIN_NOT_VERIFIED'
    })
    await expect(
      mailgunAdapter.notify!(h.ctx, { ...row(), type: T_CRED } as HubResourceRow, msg)
    ).rejects.toMatchObject({ code: 'NOT_A_SENDER' })
    const limited = harness([
      { method: 'GET', path: /^\/v4\/domains\/mg\.example\.com$/, body: fx('domain') },
      { method: 'POST', path: /messages$/, status: 429, body: { message: 'slow' } }
    ])
    await expect(mailgunAdapter.notify!(limited.ctx, row(), msg)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true
    })
  })

  it('only the domain type sends', () => {
    expect(mailgunAdapter.types.filter((t) => t.sends).map((t) => t.key)).toEqual([T_DOMAIN])
  })
})
