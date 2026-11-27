import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auth0Provider } from '../../../services/hub/providers/auth0/index.js'
import { makeProviderContext } from '../../../services/hub/providers/context.js'
import type {
  DesiredResource,
  PlannedOp,
  ProviderContext
} from '../../../services/hub/providers/types.js'
import { ProviderError } from '../../../services/hub/providers/types.js'

// Hub third-party providers, Task 9: the Auth0 adapter against documented Management API answers
// (fixtures under providers/auth0/__fixtures__, fake values only).

const FIXTURES = join(import.meta.dirname, '../../../services/hub/providers/auth0/__fixtures__')
const fixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

const SECRET = 'test-secret-m2m-abcdef'
const CLIENT_SECRET = 'test-secret-client-do-not-leak'
const ALL_SCOPES = [
  'read:clients',
  'create:clients',
  'update:clients',
  'delete:clients',
  'read:resource_servers',
  'create:resource_servers',
  'update:resource_servers',
  'delete:resource_servers',
  'read:connections',
  'update:connections'
].join(' ')

function jwt(scope: string): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b({ alg: 'RS256' })}.${b({ scope })}.test-signature`
}

interface Call {
  method: string
  url: URL
  body: any
}
type Answer = { status: number; body?: unknown } | undefined

let nextId = 1000

function setup(
  handler: (call: Call) => Answer,
  opts: { scope?: string; expiresIn?: number; tokenAnswer?: { status: number; body: unknown } } = {}
) {
  const calls: Call[] = []
  const state = { tokens: 0, now: new Date('2026-11-26T12:00:00Z'), mint: 0 }
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const call: Call = {
      method: String(init.method),
      url: u,
      body: init.body ? JSON.parse(String(init.body)) : undefined
    }
    calls.push(call)
    if (u.pathname === '/oauth/token') {
      state.tokens++
      const a = opts.tokenAnswer ?? {
        status: 200,
        body: {
          access_token: jwt(opts.scope ?? ALL_SCOPES) + (state.mint++ ? `.${state.mint}` : ''),
          expires_in: opts.expiresIn ?? 86_400,
          token_type: 'Bearer'
        }
      }
      return new Response(JSON.stringify(a.body), { status: a.status })
    }
    const r = handler(call) ?? { status: 404, body: { message: 'Not found' } }
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status })
  }
  const ctx = makeProviderContext({
    adapter: auth0Provider,
    connectionId: nextId++,
    config: { domain: 'acme-test.us.auth0.com', client_id: 'cm_test_client' },
    secrets: { client_secret: SECRET },
    now: () => state.now,
    fetch: { fetchImpl }
  })
  return { ctx, calls, state }
}

const writes = (calls: Call[]) =>
  calls.filter((c) => c.method !== 'GET' && c.url.pathname !== '/oauth/token')

function desiredApp(over: Record<string, unknown> = {}, extra: Partial<DesiredResource> = {}) {
  return {
    resourceId: 41,
    type: 'auth0.application',
    externalId: null,
    scope: 'app',
    appId: 7,
    environmentId: 3,
    fields: {
      name: 'Storefront (staging)',
      app_type: 'spa',
      description: 'Staging sign-in',
      callbacks: ['http://localhost:3000/callback', 'https://staging.example.com/callback'],
      allowed_logout_urls: ['https://staging.example.com'],
      allowed_origins: ['https://staging.example.com'],
      web_origins: ['https://staging.example.com'],
      ...over
    },
    refs: {},
    tags: { 'nivaro-hub:app': '7', 'nivaro-hub:env': '3', 'nivaro-hub:resource': '41' },
    ...extra
  } as DesiredResource
}

function desiredApi(over: Record<string, unknown> = {}) {
  return {
    resourceId: 50,
    type: 'auth0.api',
    externalId: null,
    scope: 'app',
    appId: 7,
    environmentId: 3,
    fields: {
      name: 'Storefront API',
      identifier: 'https://api.example.com/',
      signing_alg: 'RS256',
      token_lifetime: 7200,
      allow_offline_access: false,
      scopes: [
        { value: 'write:orders', description: 'Write orders' },
        { value: 'read:orders', description: 'Read orders' }
      ],
      ...over
    },
    refs: {},
    tags: {}
  } as DesiredResource
}

function desiredBinding(clientId: string | null = 'cl_test_app_01', connection = 'con_test_01') {
  return {
    resourceId: 60,
    type: 'auth0.connection_binding',
    externalId: null,
    scope: 'app',
    appId: 7,
    environmentId: 3,
    fields: { client: { resourceId: 41 }, connection_id: connection },
    refs: { client: clientId },
    tags: {}
  } as DesiredResource
}

const noopCtx = {} as ProviderContext
const planOne = (d: DesiredResource | null, o: any) => auth0Provider.plan(noopCtx, d, o)

describe('auth0 connection', () => {
  const spec = auth0Provider.connection

  it('validates the tenant domain', () => {
    const ok = (domain: string) =>
      spec.validate?.({ domain, client_id: 'cm_test_client' }, { client_secret: SECRET })
    expect(ok('acme-test.us.auth0.com')).toEqual([])
    expect(ok('login.example.com')).toEqual([])
    for (const bad of [
      'https://acme.auth0.com',
      'acme.auth0.com/path',
      'acme.auth0.com:8443',
      'Acme.auth0.com',
      '10.0.0.5',
      'localhost',
      'single',
      '*.auth0.com',
      ''
    ])
      expect(ok(bad)?.length, bad).toBeGreaterThan(0)
    expect(spec.validate?.({ domain: 'a.auth0.com' }, {})?.length).toBeGreaterThan(0)
    expect(
      spec.validate?.(
        { domain: 'a.auth0.com', client_id: 'x', audience: 'http://a.auth0.com/api/v2/' },
        {}
      )?.length
    ).toBeGreaterThan(0)
  })

  it('names exactly the tenant host and describes without secrets', () => {
    expect(spec.hosts({ domain: 'acme-test.us.auth0.com' })).toEqual(['acme-test.us.auth0.com'])
    expect(spec.hosts({ domain: 'https://evil' })).toEqual([])
    const line = spec.describe({ domain: 'acme-test.us.auth0.com', client_id: 'cm_test_client' })
    expect(line).toContain('acme-test.us.auth0.com')
    expect(line).not.toContain(SECRET)
    const secretKeys = spec.fields.filter((f) => f.secret).map((f) => f.key)
    expect(secretKeys).toEqual(['client_secret'])
  })

  it('refuses any other host through ctx.fetch', async () => {
    const { ctx } = setup(() => undefined)
    await expect(ctx.fetch('https://evil.example.com/api/v2/clients')).rejects.toThrow(
      /allowed hosts/
    )
  })
})

describe('auth0 testConnection', () => {
  it('lists missing permissions', async () => {
    const { ctx } = setup(() => undefined, {
      scope: 'read:clients create:clients read:resource_servers read:connections'
    })
    const t = await auth0Provider.testConnection(ctx)
    expect(t.ok).toBe(true)
    expect(t.identity).toContain('cm_test_client')
    expect(t.missing).toEqual(
      expect.arrayContaining([
        'update:clients',
        'delete:clients',
        'create:resource_servers',
        'update:connections'
      ])
    )
    expect(t.missing).not.toContain('read:clients')
    expect(t.permissions.find((p) => p.need === 'read:clients')).toMatchObject({
      type: 'auth0.application',
      has: true
    })
  })

  it('reports full access with nothing missing', async () => {
    const { ctx } = setup(() => undefined)
    const t = await auth0Provider.testConnection(ctx)
    expect(t).toMatchObject({ ok: true, missing: [] })
  })

  it('answers not ok when the credentials are refused, without the secret', async () => {
    const { ctx } = setup(() => undefined, {
      tokenAnswer: {
        status: 401,
        body: { error: 'access_denied', error_description: `Unauthorized: ${SECRET} is wrong` }
      }
    })
    const t = await auth0Provider.testConnection(ctx)
    expect(t.ok).toBe(false)
    expect(t.message).toBeTruthy()
    expect(t.message).not.toContain(SECRET)
  })

  it('probes the read paths when the token carries no readable scope', async () => {
    const { ctx, calls } = setup(
      (c) =>
        c.url.pathname.endsWith('/connections')
          ? { status: 403, body: {} }
          : { status: 200, body: [] },
      { scope: '' }
    )
    const t = await auth0Provider.testConnection(ctx)
    expect(calls.some((c) => c.url.pathname === '/api/v2/clients')).toBe(true)
    expect(t.missing).toContain('read:connections')
    expect(t.missing).not.toContain('read:clients')
    expect(t.message).toMatch(/only read access/)
  })
})

describe('auth0 management token', () => {
  it('is cached until 60 s before it expires', async () => {
    const { ctx, state } = setup(() => ({ status: 404, body: {} }), { expiresIn: 600 })
    await auth0Provider.observe(ctx, 'auth0.application', 'cl_a')
    await auth0Provider.observe(ctx, 'auth0.application', 'cl_b')
    expect(state.tokens).toBe(1)
    state.now = new Date(state.now.getTime() + 539_000)
    await auth0Provider.observe(ctx, 'auth0.application', 'cl_c')
    expect(state.tokens).toBe(1)
    state.now = new Date(state.now.getTime() + 2_000)
    await auth0Provider.observe(ctx, 'auth0.application', 'cl_d')
    expect(state.tokens).toBe(2)
  })

  it('mints once more after a 401 and retries the call', async () => {
    let first = true
    const { ctx, state } = setup((c) => {
      if (first && c.url.pathname.startsWith('/api/v2/clients/')) {
        first = false
        return { status: 401, body: { message: 'Invalid token' } }
      }
      return { status: 200, body: fixture('client.json') }
    })
    const o = await auth0Provider.observe(ctx, 'auth0.application', 'cl_test_app_01')
    expect(o?.externalId).toBe('cl_test_app_01')
    expect(state.tokens).toBe(2)
  })
})

describe('auth0 observe', () => {
  it('maps an application and never carries the client secret', async () => {
    const { ctx, calls } = setup(() => ({ status: 200, body: fixture('client.json') }))
    const o = await auth0Provider.observe(ctx, 'auth0.application', 'cl_test_app_01')
    expect(o).toMatchObject({
      type: 'auth0.application',
      externalId: 'cl_test_app_01',
      name: 'Storefront (staging)',
      fields: {
        client_id: 'cl_test_app_01',
        app_type: 'spa',
        callbacks: ['https://staging.example.com/callback', 'http://localhost:3000/callback']
      },
      tags: { 'nivaro-hub:app': '7', 'nivaro-hub:env': '3', 'nivaro-hub:resource': '41' }
    })
    const json = JSON.stringify(o)
    expect(json).not.toContain(CLIENT_SECRET)
    expect(json).not.toContain('test-secret')
    expect(json).not.toMatch(/client_secret|signing_keys|jwt_configuration/)
    // The request asks only for the whitelisted fields.
    const get = calls.find((c) => c.url.pathname === '/api/v2/clients/cl_test_app_01')
    expect(get?.url.searchParams.get('fields')).not.toContain('client_secret')
  })

  it('returns null for a missing resource', async () => {
    const { ctx } = setup(() => ({ status: 404, body: { message: 'Not found' } }))
    expect(await auth0Provider.observe(ctx, 'auth0.application', 'cl_gone')).toBeNull()
    expect(await auth0Provider.observe(ctx, 'auth0.api', 'rs_gone')).toBeNull()
    expect(await auth0Provider.observe(ctx, 'auth0.connection_binding', 'con_x:cl_y')).toBeNull()
  })

  it('maps an API without its signing secret', async () => {
    const { ctx } = setup(() => ({ status: 200, body: fixture('resource-server.json') }))
    const o = await auth0Provider.observe(ctx, 'auth0.api', 'rs_test_01')
    expect(o?.fields).toMatchObject({
      identifier: 'https://api.example.com/',
      signing_alg: 'RS256',
      token_lifetime: 7200
    })
    expect(o?.fields.scopes).toHaveLength(2)
    expect(JSON.stringify(o)).not.toContain('test-secret')
  })

  it('finds an enabled connection and reads the connection name', async () => {
    const { ctx } = setup((c) =>
      c.url.pathname.endsWith('/clients')
        ? { status: 200, body: fixture('connection-clients.json') }
        : { status: 200, body: fixture('connection.json') }
    )
    const o = await auth0Provider.observe(
      ctx,
      'auth0.connection_binding',
      'con_test_01:cl_test_app_01'
    )
    expect(o).toMatchObject({
      externalId: 'con_test_01:cl_test_app_01',
      fields: {
        client: 'cl_test_app_01',
        connection_id: 'con_test_01',
        connection_name: 'Username-Password-Authentication'
      }
    })
    expect(
      await auth0Provider.observe(ctx, 'auth0.connection_binding', 'con_test_01:cl_other')
    ).toBeNull()
  })

  it('lists applications without the global client and without secrets', async () => {
    const { ctx } = setup(() => ({ status: 200, body: fixture('clients-list.json') }))
    const page = await auth0Provider.list(ctx, 'auth0.application')
    expect(page.items.map((i) => i.externalId)).toEqual(['cl_test_app_02'])
    expect(page.cursor).toBeNull()
    expect(JSON.stringify(page)).not.toContain('test-secret')
  })

  it('pages: a full page hands back the next cursor', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ client_id: `cl_${i}`, name: `n${i}` }))
    const { ctx, calls } = setup(() => ({ status: 200, body: rows }))
    const page = await auth0Provider.list(ctx, 'auth0.application', '2')
    expect(page.cursor).toBe('3')
    expect(
      calls.find((c) => c.url.pathname === '/api/v2/clients')?.url.searchParams.get('page')
    ).toBe('2')
  })

  it('lists API resource servers except the system one', async () => {
    const { ctx } = setup(() => ({
      status: 200,
      body: [
        fixture('resource-server.json'),
        { id: 'rs_sys', name: 'Auth0 Management API', is_system: true }
      ]
    }))
    const page = await auth0Provider.list(ctx, 'auth0.api')
    expect(page.items.map((i) => i.externalId)).toEqual(['rs_test_01'])
  })
})

describe('auth0 plan', () => {
  const observedApp = async () => {
    const { ctx } = setup(() => ({ status: 200, body: fixture('client.json') }))
    return auth0Provider.observe(ctx, 'auth0.application', 'cl_test_app_01')
  }

  it('creates, deletes and finds nothing to do', async () => {
    const o = await observedApp()
    const create = planOne(desiredApp(), null)
    expect(create).toHaveLength(1)
    expect(create[0]).toMatchObject({ kind: 'create', externalId: null })
    expect(create[0].changes.map((c) => c.field)).toContain('callbacks')
    expect(planOne(null, o)[0]).toMatchObject({ kind: 'delete', externalId: 'cl_test_app_01' })
    // Same values in another order: nothing to do.
    expect(planOne(desiredApp(), o)[0].kind).toBe('noop')
    expect(planOne(null, null)).toEqual([])
  })

  it('diffs an application field by field and leaves unspecified fields alone', async () => {
    const o = await observedApp()
    const [op] = planOne(
      desiredApp({
        callbacks: ['https://staging.example.com/callback', 'https://new.example.com/callback'],
        description: undefined
      }),
      o
    )
    expect(op.kind).toBe('update')
    expect(op.changes.map((c) => c.field)).toEqual(['callbacks'])
    expect(op.preconditions).toEqual({ callbacks: o?.fields.callbacks })
  })

  it('plans a tag change when the resource tag is missing', async () => {
    const o = await observedApp()
    const [op] = planOne(desiredApp({}, { tags: { 'nivaro-hub:resource': '99' } }), o)
    expect(op.changes.map((c) => c.field)).toEqual(['tags'])
  })

  it('diffs an API and replaces it when the identifier changes', async () => {
    const { ctx } = setup(() => ({ status: 200, body: fixture('resource-server.json') }))
    const o = await auth0Provider.observe(ctx, 'auth0.api', 'rs_test_01')
    expect(planOne(desiredApi(), o)[0].kind).toBe('noop')
    const [upd] = planOne(desiredApi({ token_lifetime: 3600 }), o)
    expect(upd).toMatchObject({ kind: 'update' })
    expect(upd.changes).toEqual([{ field: 'token_lifetime', from: 7200, to: 3600 }])
    const [rep] = planOne(desiredApi({ identifier: 'https://api2.example.com/' }), o)
    expect(rep.kind).toBe('replace')
    expect(rep.changes[0]).toMatchObject({ field: 'identifier', to: 'https://api2.example.com/' })
  })

  it('plans an enabled connection: create, noop, replace, delete', () => {
    const observed = {
      type: 'auth0.connection_binding',
      externalId: 'con_test_01:cl_test_app_01',
      name: 'x',
      fields: { client: 'cl_test_app_01', connection_id: 'con_test_01', connection_name: 'x' },
      tags: {}
    }
    expect(planOne(desiredBinding(), null)[0].kind).toBe('create')
    expect(planOne(desiredBinding(), observed)[0].kind).toBe('noop')
    expect(planOne(desiredBinding('cl_other'), observed)[0].kind).toBe('replace')
    expect(planOne(desiredBinding('cl_test_app_01', 'con_other'), observed)[0].kind).toBe('replace')
    expect(planOne(null, observed)[0].kind).toBe('delete')
  })
})

describe('auth0 risk flags per type', () => {
  const spec = (key: string) => auth0Provider.types.find((t) => t.key === key)!
  const op = (
    kind: PlannedOp['kind'],
    type: string,
    changes: PlannedOp['changes'] = []
  ): PlannedOp => ({
    kind,
    type,
    resourceId: 1,
    externalId: 'x',
    reason: '',
    changes,
    preconditions: {},
    risk: []
  })

  it('application', () => {
    const app = spec('auth0.application')
    expect(app.risk(op('delete', app.key), null).sort()).toEqual(['destructive', 'downtime'])
    expect(app.risk(op('create', app.key), desiredApp())).toEqual([])
    const widen = (to: string[], from?: string[]) =>
      app.risk(op('update', app.key, [{ field: 'callbacks', from, to }]), desiredApp())
    expect(widen(['https://*.example.com/cb'], [])).toContain('public_exposure')
    expect(widen(['http://app.example.com/cb'], [])).toContain('public_exposure')
    expect(widen(['http://localhost:3000/cb'], [])).toEqual([])
    expect(widen(['https://a.example.com/cb'], ['https://a.example.com/cb'])).toEqual([])
    // An address that was already allowed is not new exposure.
    expect(widen(['http://x.example.com'], ['http://x.example.com'])).toEqual([])
  })

  it('api and enabled connection', () => {
    const api = spec('auth0.api')
    expect(api.risk(op('delete', api.key), null)).toEqual(['destructive'])
    expect(
      api.risk(op('update', api.key, [{ field: 'signing_alg', from: 'RS256', to: 'HS256' }]), null)
    ).toEqual(['downtime'])
    expect(api.risk(op('update', api.key, [{ field: 'name', from: 'a', to: 'b' }]), null)).toEqual(
      []
    )
    const bind = spec('auth0.connection_binding')
    expect(bind.risk(op('delete', bind.key), null)).toEqual(['downtime'])
    expect(bind.risk(op('create', bind.key), desiredBinding())).toEqual([])
  })

  it('marks the types reversible except an API identifier', () => {
    expect(spec('auth0.application').reversible).toBe(true)
    const r = spec('auth0.api').reversible as (f: string) => boolean
    expect(r('identifier')).toBe(false)
    expect(r('name')).toBe(true)
    expect(spec('auth0.connection_binding').refs).toEqual([
      { field: 'client', type: 'auth0.application', required: true }
    ])
  })
})

describe('auth0 apply is idempotent (read-before-write)', () => {
  it('creates an application with the tag, never sending a secret, and answers without one', async () => {
    const { ctx, calls } = setup((c) => {
      if (c.method === 'GET') return { status: 200, body: [] }
      if (c.method === 'POST') return { status: 201, body: fixture('client.json') }
      return undefined
    })
    const d = desiredApp()
    const [op] = planOne(d, null)
    const res = await auth0Provider.apply(ctx, op, d)
    expect(res.ok).toBe(true)
    expect(res.externalId).toBe('cl_test_app_01')
    expect(JSON.stringify(res)).not.toContain('test-secret')
    const post = writes(calls)
    expect(post).toHaveLength(1)
    expect(post[0].url.pathname).toBe('/api/v2/clients')
    expect(post[0].body).toMatchObject({
      name: 'Storefront (staging)',
      app_type: 'spa',
      callbacks: expect.any(Array),
      client_metadata: { nivaro_hub_app: '7', nivaro_hub_env: '3', nivaro_hub_resource: '41' }
    })
    expect(JSON.stringify(post[0].body)).not.toContain('client_secret')
  })

  it('a create rerun after an interrupted run finds the application by its tag and does not create twice', async () => {
    const { ctx, calls } = setup((c) => {
      if (c.method !== 'GET') return undefined
      return c.url.pathname === '/api/v2/clients'
        ? { status: 200, body: [fixture('client.json')] }
        : { status: 200, body: fixture('client.json') }
    })
    const d = desiredApp()
    const [op] = planOne(d, null)
    const res = await auth0Provider.apply(ctx, op, d)
    expect(res.externalId).toBe('cl_test_app_01')
    expect(writes(calls)).toHaveLength(0)
  })

  it('an update that is already in place writes nothing', async () => {
    const { ctx, calls } = setup(() => ({ status: 200, body: fixture('client.json') }))
    const d = desiredApp({}, { externalId: 'cl_test_app_01' })
    const res = await auth0Provider.apply(
      ctx,
      { ...planOne(d, null)[0], kind: 'update', externalId: 'cl_test_app_01' },
      d
    )
    expect(res.ok).toBe(true)
    expect(writes(calls)).toHaveLength(0)
  })

  it('an update patches only the changed fields', async () => {
    const { ctx, calls } = setup((c) =>
      c.method === 'GET'
        ? { status: 200, body: fixture('client.json') }
        : { status: 200, body: { ...fixture('client.json'), description: 'New' } }
    )
    const d = desiredApp({ description: 'New' }, { externalId: 'cl_test_app_01' })
    const res = await auth0Provider.apply(
      ctx,
      { ...planOne(d, null)[0], kind: 'update', externalId: 'cl_test_app_01' },
      d
    )
    expect(res.observed?.fields.description).toBe('New')
    const w = writes(calls)
    expect(w).toHaveLength(1)
    expect(w[0].method).toBe('PATCH')
    expect(w[0].body).toEqual({ description: 'New' })
  })

  it('an update of a vanished resource fails with NOT_FOUND', async () => {
    const { ctx } = setup(() => ({ status: 404, body: { message: 'gone' } }))
    const d = desiredApp({}, { externalId: 'cl_gone' })
    await expect(
      auth0Provider.apply(ctx, { ...planOne(d, null)[0], kind: 'update', externalId: 'cl_gone' }, d)
    ).rejects.toMatchObject({ code: 'NOT_FOUND', retryable: false })
  })

  it('a delete of something already gone is a success', async () => {
    const { ctx } = setup(() => ({ status: 404, body: { message: 'gone' } }))
    const res = await auth0Provider.apply(
      ctx,
      {
        ...planOne(null, {
          type: 'auth0.application',
          externalId: 'cl_x',
          name: 'x',
          fields: {},
          tags: {}
        })[0]
      },
      null
    )
    expect(res).toMatchObject({ ok: true, externalId: 'cl_x', observed: null })
  })

  it('replaces an API: delete, then create with the new identifier', async () => {
    const { ctx, calls } = setup((c) => {
      if (c.method === 'DELETE') return { status: 204 }
      if (c.method === 'POST')
        return {
          status: 201,
          body: { ...fixture('resource-server.json'), id: 'rs_new', identifier: c.body.identifier }
        }
      return undefined // GET by identifier: not found
    })
    const d = desiredApi({ identifier: 'https://api2.example.com/' })
    const res = await auth0Provider.apply(
      ctx,
      {
        kind: 'replace',
        type: 'auth0.api',
        resourceId: 50,
        externalId: 'rs_test_01',
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      d
    )
    expect(res.externalId).toBe('rs_new')
    const w = writes(calls)
    expect(w.map((c) => c.method)).toEqual(['DELETE', 'POST'])
    expect(w[1].body.identifier).toBe('https://api2.example.com/')
    expect(w[1].body.scopes).toEqual([
      { value: 'write:orders', description: 'Write orders' },
      { value: 'read:orders', description: 'Read orders' }
    ])
  })

  it('a create that finds an API with the same identifier refuses (ALREADY_EXISTS) and writes nothing', async () => {
    const { ctx, calls } = setup((c) =>
      c.method === 'GET' ? { status: 200, body: fixture('resource-server.json') } : undefined
    )
    const d = desiredApi()
    await expect(auth0Provider.apply(ctx, planOne(d, null)[0], d)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
      retryable: false
    })
    expect(writes(calls)).toHaveLength(0)
    // The Hub's own recorded resource (a resumed run) is brought to the wanted values instead.
    const own = { ...d, externalId: 'rs_test_01' }
    const res = await auth0Provider.apply(ctx, planOne(d, null)[0], own)
    expect(res.externalId).toBe('rs_test_01')
  })

  it('enables a connection for an application with one PATCH, and does nothing when already on', async () => {
    let enabled = false
    const { ctx, calls } = setup((c) => {
      if (c.method === 'PATCH') {
        enabled = true
        return { status: 204 }
      }
      if (c.url.pathname.endsWith('/clients'))
        return { status: 200, body: { clients: enabled ? [{ client_id: 'cl_test_app_01' }] : [] } }
      return { status: 200, body: fixture('connection.json') }
    })
    const d = desiredBinding()
    const [op] = planOne(d, null)
    const res = await auth0Provider.apply(ctx, op, d)
    expect(res.externalId).toBe('con_test_01:cl_test_app_01')
    const w = writes(calls)
    expect(w).toHaveLength(1)
    expect(w[0].body).toEqual([{ client_id: 'cl_test_app_01', status: true }])
    expect(w[0].url.pathname).toBe('/api/v2/connections/con_test_01/clients')
    // Second run of the Hub's own record: already enabled, no more writes.
    await auth0Provider.apply(ctx, op, { ...d, externalId: 'con_test_01:cl_test_app_01' })
    expect(writes(calls)).toHaveLength(1)
    // A pair the Hub did not enable is never bound silently.
    await expect(auth0Provider.apply(ctx, op, d)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(writes(calls)).toHaveLength(1)
  })

  it('refuses to enable a connection before its application exists', async () => {
    const { ctx } = setup(() => undefined)
    const d = desiredBinding(null)
    await expect(auth0Provider.apply(ctx, planOne(d, null)[0], d)).rejects.toMatchObject({
      code: 'REF_UNRESOLVED'
    })
  })

  it('switches a connection off only when it is on', async () => {
    const { ctx, calls } = setup((c) => {
      if (c.method === 'PATCH') return { status: 204 }
      if (c.url.pathname.endsWith('/clients'))
        return { status: 200, body: fixture('connection-clients.json') }
      return { status: 200, body: fixture('connection.json') }
    })
    const del = (externalId: string): PlannedOp => ({
      kind: 'delete',
      type: 'auth0.connection_binding',
      resourceId: 60,
      externalId,
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    })
    await auth0Provider.apply(ctx, del('con_test_01:cl_test_app_01'), null)
    expect(writes(calls)[0].body).toEqual([{ client_id: 'cl_test_app_01', status: false }])
    await auth0Provider.apply(ctx, del('con_test_01:cl_not_enabled'), null)
    expect(writes(calls)).toHaveLength(1)
  })
})

describe('auth0 errors', () => {
  it('maps 429 and 5xx to retryable, other refusals to not retryable', async () => {
    for (const [status, code, retryable] of [
      [429, 'RATE_LIMITED', true],
      [503, 'PROVIDER_ERROR', true],
      [400, 'INVALID', false],
      [403, 'FORBIDDEN', false],
      [409, 'CONFLICT', false]
    ] as const) {
      const { ctx } = setup(() => ({ status, body: { message: 'nope' } }))
      const err = await auth0Provider.observe(ctx, 'auth0.application', 'cl_x').catch((e) => e)
      expect(err, String(status)).toBeInstanceOf(ProviderError)
      expect(err).toMatchObject({ code, retryable, status })
    }
  })

  it('a write that hits 429 is retryable', async () => {
    const { ctx } = setup((c) =>
      c.method === 'POST'
        ? { status: 429, body: { message: 'slow down' } }
        : { status: 200, body: [] }
    )
    const d = desiredApp()
    await expect(auth0Provider.apply(ctx, planOne(d, null)[0], d)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true
    })
  })

  it('a token endpoint failure surfaces as AUTH_FAILED (not retryable on 401)', async () => {
    const { ctx } = setup(() => undefined, {
      tokenAnswer: {
        status: 401,
        body: { error: 'access_denied', error_description: 'Unauthorized' }
      }
    })
    await expect(auth0Provider.observe(ctx, 'auth0.application', 'cl_x')).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      retryable: false
    })
  })

  it('secrets never appear in errors', async () => {
    const { ctx } = setup((c) => ({
      status: 400,
      body: {
        message: `Bad request for ${SECRET} with ${CLIENT_SECRET.slice(0, 0)}token ${c.url.href}`
      }
    }))
    // The call's own bearer token is scrubbed too once it has been minted.
    const err = await auth0Provider.observe(ctx, 'auth0.application', 'cl_x').catch((e) => e)
    expect(err.message).not.toContain(SECRET)
    expect(err.message).toContain('Bad request')

    const tokenText = setup(() => undefined, {
      tokenAnswer: { status: 403, body: { error_description: `client ${SECRET} not allowed` } }
    })
    const e2 = await auth0Provider.observe(tokenText.ctx, 'auth0.api', 'rs_x').catch((e) => e)
    expect(e2.message).not.toContain(SECRET)
    expect(e2.code).toBe('AUTH_FAILED')
  })
})
