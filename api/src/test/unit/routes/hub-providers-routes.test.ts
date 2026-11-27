import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers REST API (routes/hub-providers.ts) on a real in-memory SQLite with migrations 542
// and 582, the real store and the real credential gate; the engine (Task 1) and the observe
// functions (Task 4) are mocked. Auth is faked from headers: x-user, x-admin, x-auth, x-scopes,
// x-mcp, x-masq.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: FastifyRequest) => {
    const h = req.headers as Record<string, string | undefined>
    const id = h['x-user']
    if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active' } as never
    req.isAdmin = h['x-admin'] === '1'
    req.authMethod = (h['x-auth'] ?? 'session') as never
    if (h['x-scopes']) req.apiKeyScopes = JSON.parse(h['x-scopes'])
    if (h['x-mcp'] === '1') req.mcpInner = true
    if (h['x-masq']) req.masqueradeAdminId = h['x-masq']
  }
  const admin = async (req: FastifyRequest) => {
    await sign(req)
    if (!req.isAdmin)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
  }
  return { requireAuth: vi.fn(sign), requireAdmin: vi.fn(admin), authenticate: vi.fn(sign) }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

const engine = vi.hoisted(() => ({
  plan: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  undo: vi.fn(),
  approve: vi.fn(),
  decline: vi.fn()
}))
vi.mock('../../../services/hub/providers/engine/contract.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  planResourceChange: engine.plan,
  startResourceChange: engine.start,
  cancelResourceChange: engine.cancel,
  resumeResourceChange: engine.resume,
  undoResourceChange: engine.undo,
  approveResourceChange: engine.approve,
  declineResourceChange: engine.decline
}))
const observe = vi.hoisted(() => ({
  listUnmanaged: vi.fn(),
  adoptResource: vi.fn(),
  registerResourceObserveCron: vi.fn()
}))
vi.mock('../../../services/hub/providers/observe.js', () => observe)

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/582_hub_providers.js')
]
const { hubProviderRoutes } = await import('../../../routes/hub-providers.js')
const { installHubCredentialGate } = await import('../../../services/hub/api/gate.js')
const registry = await import('../../../services/hub/providers/registry.js')
const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const store = await import('../../../services/hub/providers/store.js')
const { ResourceChangeError } = await import('../../../services/hub/providers/engine/contract.js')
const { HUB_ROUTES } = await import('../../../services/hub/api/catalog.js')

import type { ProviderAdapter } from '../../../services/hub/providers/types.js'

const ADMIN = 'AAAAAAAA-0000-4000-8000-000000000001'
const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const OTHER = 'CCCCCCCC-0000-4000-8000-000000000003'
const admin = { 'x-user': ADMIN, 'x-admin': '1' }
const owner = { 'x-user': OWNER }
const other = { 'x-user': OTHER }
const key = (level: 'read' | 'write' | null, who: Record<string, string> = admin) => ({
  ...who,
  'x-auth': 'api_key',
  'x-scopes': JSON.stringify([
    { collection: '*', actions: ['*'] },
    ...(level
      ? [{ collection: '$hub', actions: level === 'write' ? ['read', 'write'] : ['read'] }]
      : [])
  ])
})

const SECRET = 'test-secret-token-0001'
const SECRET2 = 'test-secret-token-0002'

const PLAN = {
  changeId: 7,
  planHash: 'a'.repeat(64),
  status: 'planned',
  ops: [],
  gates: [],
  needsConfirm: null,
  needsApproval: false,
  blockers: []
}

function demoAdapter(testConnection?: ProviderAdapter['testConnection']): ProviderAdapter {
  return {
    key: 'demo',
    label: 'Demo',
    connection: {
      fields: [
        { key: 'org', label: 'Organisation', kind: 'string', required: true },
        { key: 'note', label: 'Note', kind: 'string' },
        { key: 'token', label: 'Token', kind: 'string', secret: true, required: true },
        { key: 'hook', label: 'Hook secret', kind: 'string', secret: true }
      ],
      hosts: (c) => [`${String(c.org ?? 'x')}.demo.example`],
      describe: (c) => `Demo ${String(c.org ?? '')}`
    },
    types: [
      {
        key: 'demo.thing',
        label: 'Thing',
        scope: 'app',
        fields: [
          { key: 'name', label: 'Name', kind: 'string', required: true },
          { key: 'password', label: 'Password', kind: 'secret' }
        ],
        capabilities: {
          create: true,
          update: true,
          delete: true,
          adopt: true,
          snapshot: false,
          tag: true
        },
        reversible: true,
        refs: [],
        risk: () => []
      }
    ],
    testConnection:
      testConnection ??
      (async () => ({
        ok: true,
        identity: 'demo-user',
        permissions: [{ type: 'demo.thing', need: 'read', has: true }],
        missing: []
      })),
    observe: async () => null,
    list: async () => ({ items: [], cursor: null }),
    plan: () => [],
    apply: async () => ({ ok: true, externalId: null, observed: null })
  }
}

let app: FastifyInstance
let prevHub: string | undefined
let prevKey: string | undefined
let appA = 0
let appB = 0

async function insertApp(k: string): Promise<number> {
  const [r] = await db('nivaro_hub_apps').insert({ key: k, name: k }).returning('id')
  return Number(typeof r === 'object' ? (r as { id: number }).id : r)
}

function inject(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = admin
) {
  return app.inject({ method, url: `/api/hub${url}`, payload: payload as never, headers })
}

async function makeConnection(name = 'Main', secrets: Record<string, string> = { token: SECRET }) {
  const res = await inject('POST', '/connections', {
    provider: 'demo',
    name,
    config: { org: 'zz-conn-org-7f3' },
    secrets
  })
  expect(res.statusCode).toBe(201)
  return res.json().data as { id: number }
}

async function makeResource(
  connectionId: number,
  o: { app?: number | null; scope?: 'app' | 'shared'; desired?: Record<string, unknown> } = {}
) {
  return store.insertResource({
    connection_id: connectionId,
    provider: 'demo',
    type: 'demo.thing',
    external_id: `ext-${Math.random()}`,
    name: 'thing',
    scope: o.scope ?? 'app',
    app_id: o.app === undefined ? appA : o.app,
    desired: o.desired ?? { name: 'thing' }
  } as never)
}

beforeAll(async () => {
  prevHub = process.env.HUB
  prevKey = process.env.ENCRYPTION_KEY
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = 'd'.repeat(64)
  for (const m of migrations) await m.up(db)
  app = Fastify()
  installHubCredentialGate(app)
  await app.register(hubProviderRoutes, { prefix: '/api/hub' })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
  if (prevHub === undefined) delete process.env.HUB
  else process.env.HUB = prevHub
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
})
beforeEach(async () => {
  registry.resetProvidersForTest()
  registry.registerProvider(demoAdapter())
  for (const t of [
    'nivaro_hub_resource_changes',
    'nivaro_hub_resources',
    'nivaro_hub_app_connections',
    'nivaro_hub_connections',
    'nivaro_hub_app_owners',
    'nivaro_hub_apps'
  ])
    await db(t).del()
  appA = await insertApp('app-a')
  appB = await insertApp('app-b')
  await db('nivaro_hub_app_owners').insert({ app_id: appA, user_id: OWNER })
  await db('nivaro_hub_app_owners').insert({ app_id: appB, user_id: OTHER })
  for (const f of Object.values(engine)) f.mockReset()
  observe.listUnmanaged.mockReset()
  observe.adoptResource.mockReset()
})

describe('catalog', () => {
  it('lists every provider route with the access the gate needs', () => {
    const get = (m: string, p: string) => HUB_ROUTES.find((e) => e.method === m && e.path === p)
    expect(get('POST', '/resources/plan')?.access).toBe('plan')
    expect(get('POST', '/resource-changes/:id/start')?.access).toBe('write')
    expect(get('GET', '/connections')?.access).toBe('read')
    expect(get('POST', '/connections')?.auth).toBe('admin')
    expect(get('POST', '/resource-changes/:id/approve')?.auth).toBe('admin')
  })
})

describe('provider types', () => {
  it('lists adapters, their fields and types, and never connection data', async () => {
    await makeConnection()
    const res = await inject('GET', '/provider-types', undefined, owner)
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.risk_flags).toContain('destructive')
    const demo = data.providers.find((p: { key: string }) => p.key === 'demo')
    expect(demo.connection.fields.map((f: { key: string }) => f.key)).toEqual([
      'org',
      'note',
      'token',
      'hook'
    ])
    expect(demo.types[0]).toMatchObject({ key: 'demo.thing', scope: 'app', reversible: true })
    expect(JSON.stringify(data)).not.toContain(SECRET)
    expect(JSON.stringify(data)).not.toContain('zz-conn-org-7f3')
  })
})

describe('connections', () => {
  it('creates, answers masked everywhere, never the secret', async () => {
    const created = await inject('POST', '/connections', {
      provider: 'demo',
      name: 'Main',
      config: { org: 'zz-conn-org-7f3' },
      secrets: { token: SECRET }
    })
    expect(created.statusCode).toBe(201)
    const c = created.json().data
    expect(c).toMatchObject({
      provider: 'demo',
      name: 'Main',
      description: 'Demo acme',
      status: 'untested',
      secret_keys: ['token']
    })
    expect(c.secret_mask).toBeTruthy()
    expect(c.secret_fingerprint).toMatch(/^[0-9a-f]{32}$/)
    const reads = [
      created.body,
      (await inject('GET', '/connections')).body,
      (await inject('GET', `/connections/${c.id}`)).body,
      (await inject('PATCH', `/connections/${c.id}`, { name: 'Renamed' })).body,
      (await inject('GET', `/apps/${appA}/connections`)).body
    ]
    for (const body of reads) expect(body).not.toContain(SECRET)
    // Stored sealed, readable only through the store.
    const row = await db('nivaro_hub_connections').where({ id: c.id }).first()
    expect(String(row.secret)).not.toContain(SECRET)
    expect(await store.openConnectionSecrets({ id: c.id })).toEqual({ token: SECRET })
  })

  it('refuses unknown providers, misplaced keys and missing required fields', async () => {
    expect(
      (await inject('POST', '/connections', { provider: 'nope', name: 'x' })).json().code
    ).toBe('UNKNOWN_PROVIDER')
    const noSecret = await inject('POST', '/connections', {
      provider: 'demo',
      name: 'x',
      config: { org: 'a' }
    })
    expect(noSecret.statusCode).toBe(400)
    expect(noSecret.json().code).toBe('INVALID_FIELDS')
    expect(noSecret.json().message).toContain('Token is required')
    const misplaced = await inject('POST', '/connections', {
      provider: 'demo',
      name: 'x',
      config: { org: 'a', token: SECRET },
      secrets: { token: SECRET }
    })
    expect(misplaced.statusCode).toBe(400)
    expect(misplaced.body).not.toContain(SECRET)
    expect((await store.listConnections()).length).toBe(0)
  })

  it('writes are admin-only; an owner gets 403 on every one', async () => {
    const c = await makeConnection()
    const calls: Array<[Parameters<typeof inject>[0], string, unknown?]> = [
      ['POST', '/connections', { provider: 'demo', name: 'x' }],
      ['PATCH', `/connections/${c.id}`, { name: 'y' }],
      ['DELETE', `/connections/${c.id}`],
      ['POST', `/connections/${c.id}/test`],
      ['GET', `/connections/${c.id}/unmanaged?type=demo.thing`],
      ['PUT', `/apps/${appA}/connections`, { connection_ids: [c.id] }],
      ['POST', '/resource-changes/1/approve', { planHash: 'x' }],
      ['POST', '/resource-changes/1/decline', { reason: 'no' }]
    ]
    for (const [m, u, b] of calls) {
      const res = await inject(m, u, b, owner)
      expect(res.statusCode, `${m} ${u}`).toBe(403)
    }
    expect(engine.approve).not.toHaveBeenCalled()
  })

  it('PATCH changes only the secret keys sent; a masked value keeps the stored one', async () => {
    const c = await makeConnection('Main', { token: SECRET, hook: 'test-secret-hook-0001' })
    const keep = await inject('PATCH', `/connections/${c.id}`, {
      secrets: { token: '••••••', hook: SECRET2 }
    })
    expect(keep.statusCode).toBe(200)
    expect(keep.body).not.toContain(SECRET2)
    expect(await store.openConnectionSecrets({ id: c.id })).toEqual({
      token: SECRET,
      hook: SECRET2
    })
    // Clearing a required secret is refused and changes nothing.
    const clear = await inject('PATCH', `/connections/${c.id}`, { secrets: { token: '' } })
    expect(clear.statusCode).toBe(400)
    expect((await store.openConnectionSecrets({ id: c.id })).token).toBe(SECRET)
    // An optional one can be cleared; config merges.
    const ok = await inject('PATCH', `/connections/${c.id}`, {
      config: { note: 'acme2' },
      secrets: { hook: null }
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.config.note).toBe('acme2')
    expect(ok.json().data.secret_keys).toEqual(['token'])
    expect(ok.json().data.status).toBe('untested')
  })

  it('a host change needs every secret again; any change forgets the cached tokens', async () => {
    const c = await makeConnection()
    const adapter = registry.getProvider('demo') as ProviderAdapter
    const seed = async () => {
      const ctx = makeProviderContext({
        adapter,
        connectionId: c.id,
        config: { org: 'zz-conn-org-7f3' },
        secrets: await store.openConnectionSecrets({ id: c.id })
      })
      ctx.tokens.set('t', 'test-token-0001', new Date(Date.now() + 3_600_000))
      return ctx
    }
    const cached = async () => {
      const ctx = makeProviderContext({
        adapter,
        connectionId: c.id,
        config: { org: 'zz-conn-org-7f3' },
        secrets: await store.openConnectionSecrets({ id: c.id })
      })
      return ctx.tokens.get('t')
    }
    await seed()
    // Other host, no secrets: refused, nothing changed, tokens kept.
    const refused = await inject('PATCH', `/connections/${c.id}`, { config: { org: 'evil' } })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().code).toBe('SECRET_REQUIRED_ON_HOST_CHANGE')
    expect((await store.readConnection(c.id))?.config.org).toBe('acme')
    expect(await cached()).toBe('test-token-0001')
    // The mask does not count as re-sending.
    const masked = await inject('PATCH', `/connections/${c.id}`, {
      config: { org: 'evil' },
      secrets: { token: '••••••' }
    })
    expect(masked.statusCode).toBe(409)
    // With the secret typed again: 200, tokens forgotten.
    const ok = await inject('PATCH', `/connections/${c.id}`, {
      config: { org: 'other' },
      secrets: { token: SECRET2 }
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.body).not.toContain(SECRET2)
    expect(await cached()).toBeNull()
    // A change that keeps the hosts: 200 without secrets, tokens forgotten.
    await seed()
    const plain = await inject('PATCH', `/connections/${c.id}`, { config: { note: 'hi' } })
    expect(plain.statusCode).toBe(200)
    expect(await cached()).toBeNull()
    // Delete forgets too.
    const d = await makeConnection('D')
    const dctx = () =>
      makeProviderContext({
        adapter,
        connectionId: d.id,
        config: { org: 'zz-conn-org-7f3' },
        secrets: { token: SECRET }
      })
    dctx().tokens.set('t', 'test-token-0002', new Date(Date.now() + 3_600_000))
    expect((await inject('DELETE', `/connections/${d.id}`)).statusCode).toBe(200)
    expect(dctx().tokens.get('t')).toBeNull()
  })

  it('delete is refused while resources exist, then works', async () => {
    const c = await makeConnection()
    const r = await makeResource(c.id)
    const busy = await inject('DELETE', `/connections/${c.id}`)
    expect(busy.statusCode).toBe(409)
    expect(busy.json().code).toBe('CONNECTION_IN_USE')
    await db('nivaro_hub_resources').where({ id: r.id }).del()
    expect((await inject('DELETE', `/connections/${c.id}`)).statusCode).toBe(200)
    expect(await store.readConnection(c.id)).toBeNull()
  })

  it('test stores the result and scrubs the secret out of provider text', async () => {
    registry.resetProvidersForTest()
    registry.registerProvider(
      demoAdapter(async () => {
        throw new Error(`401 for token ${SECRET}`)
      })
    )
    const c = await makeConnection()
    const res = await inject('POST', `/connections/${c.id}/test`)
    expect(res.statusCode).toBe(200)
    expect(res.json().data.ok).toBe(false)
    expect(res.body).not.toContain(SECRET)
    const row = await store.readConnection(c.id)
    expect(row?.status).toBe('failing')
    expect(JSON.stringify(row)).not.toContain(SECRET)
    // A passing test marks it ok.
    registry.resetProvidersForTest()
    registry.registerProvider(demoAdapter())
    const ok = await inject('POST', `/connections/${c.id}/test`)
    expect(ok.json().data).toMatchObject({ ok: true, identity: 'demo-user' })
    expect((await store.readConnection(c.id))?.status).toBe('ok')
  })

  it('an owner sees only connections allowed for their apps, without settings', async () => {
    const mine = await makeConnection('Mine')
    const theirs = await makeConnection('Theirs')
    await makeConnection('Nobody')
    expect(
      (await inject('PUT', `/apps/${appA}/connections`, { connection_ids: [mine.id] })).statusCode
    ).toBe(200)
    await inject('PUT', `/apps/${appB}/connections`, { connection_ids: [theirs.id] })
    const list = (await inject('GET', '/connections', undefined, owner)).json().data
    expect(list.map((c: { name: string }) => c.name)).toEqual(['Mine'])
    expect(list[0].config).toBeUndefined()
    expect(list[0].secret_mask).toBeUndefined()
    expect((await inject('GET', `/connections/${theirs.id}`, undefined, owner)).statusCode).toBe(
      404
    )
    expect((await inject('GET', `/connections/${mine.id}`, undefined, owner)).statusCode).toBe(200)
    const allowed = await inject('GET', `/apps/${appA}/connections`, undefined, owner)
    expect(allowed.json().data.connection_ids).toEqual([mine.id])
    expect((await inject('GET', `/apps/${appB}/connections`, undefined, owner)).statusCode).toBe(
      404
    )
    const bad = await inject('PUT', `/apps/${appA}/connections`, { connection_ids: [9999] })
    expect(bad.statusCode).toBe(404)
  })
})

describe('adopt and unmanaged', () => {
  it('owners adopt only into their own app through an allowed connection', async () => {
    const c = await makeConnection()
    await store.setAppAllowedConnections(appA, [c.id])
    observe.adoptResource.mockResolvedValue({ id: 1 })
    const body = (app_: number, scope = 'app') => ({
      type: 'demo.thing',
      externalId: 'x1',
      scope,
      appId: app_
    })
    expect((await inject('POST', `/connections/${c.id}/adopt`, body(appB), owner)).statusCode).toBe(
      404
    )
    expect(
      (await inject('POST', `/connections/${c.id}/adopt`, body(appA, 'shared'), owner)).json().code
    ).toBe('SHARED_ADMIN_ONLY')
    await store.setAppAllowedConnections(appA, [])
    expect(
      (await inject('POST', `/connections/${c.id}/adopt`, body(appA), owner)).json().code
    ).toBe('CONNECTION_NOT_ALLOWED')
    expect(observe.adoptResource).not.toHaveBeenCalled()
    await store.setAppAllowedConnections(appA, [c.id])
    const ok = await inject('POST', `/connections/${c.id}/adopt`, body(appA), owner)
    expect(ok.statusCode).toBe(201)
    expect(observe.adoptResource).toHaveBeenCalledWith(
      c.id,
      { type: 'demo.thing', externalId: 'x1', scope: 'app', appId: appA },
      expect.objectContaining({ id: OWNER, isAdmin: false, via: 'session' })
    )
  })

  it('unmanaged passes the type and cursor; NOT_IMPLEMENTED maps to 501', async () => {
    const c = await makeConnection()
    observe.listUnmanaged.mockResolvedValue({ items: [], cursor: null })
    const res = await inject('GET', `/connections/${c.id}/unmanaged?type=demo.thing&cursor=abc`)
    expect(res.statusCode).toBe(200)
    expect(observe.listUnmanaged).toHaveBeenCalledWith(
      c.id,
      'demo.thing',
      'abc',
      expect.objectContaining({ isAdmin: true })
    )
    expect((await inject('GET', `/connections/${c.id}/unmanaged`)).statusCode).toBe(400)
    observe.listUnmanaged.mockRejectedValue(new ResourceChangeError('NOT_IMPLEMENTED', 'later'))
    expect((await inject('GET', `/connections/${c.id}/unmanaged?type=demo.thing`)).statusCode).toBe(
      501
    )
  })
})

describe('resources', () => {
  it('an owner sees only their app resources; shared and foreign ones are 404', async () => {
    const c = await makeConnection()
    const mine = await makeResource(c.id, { app: appA })
    const foreign = await makeResource(c.id, { app: appB })
    const shared = await makeResource(c.id, { app: null, scope: 'shared' })
    const own = (await inject('GET', '/resources', undefined, owner)).json().data
    expect(own.map((r: { id: number }) => r.id)).toEqual([mine.id])
    const all = (await inject('GET', '/resources')).json().data
    expect(all.length).toBe(3)
    expect((await inject('GET', `/resources/${foreign.id}`, undefined, owner)).statusCode).toBe(404)
    expect((await inject('GET', `/resources/${shared.id}`, undefined, owner)).statusCode).toBe(404)
    expect((await inject('GET', `/resources/${mine.id}`, undefined, owner)).statusCode).toBe(200)
    expect((await inject('GET', `/resources?app=${appB}`, undefined, owner)).statusCode).toBe(404)
    expect((await inject('GET', '/resources?scope=shared')).json().data.length).toBe(1)
    expect((await inject('GET', '/resources?drift=1')).json().data.length).toBe(0)
  })

  it('answers a sealed desired secret as its fingerprint only', async () => {
    const c = await makeConnection()
    const r = await makeResource(c.id, {
      desired: {
        name: 'thing',
        password: { $sealed: 'sealed-blob-xyz', fingerprint: 'f'.repeat(32) }
      }
    })
    const res = await inject('GET', `/resources/${r.id}`)
    expect(res.body).not.toContain('sealed-blob-xyz')
    expect(res.json().data.desired.password).toEqual({ secret: true, fingerprint: 'f'.repeat(32) })
  })
})

describe('plan and changes', () => {
  const planBody = (c: number) => ({
    connectionId: c,
    scope: 'app',
    appId: appA,
    ops: [{ action: 'create', type: 'demo.thing', fields: { name: 'x', password: SECRET } }]
  })

  it('plans through the engine as the caller; validates the body first', async () => {
    const c = await makeConnection()
    engine.plan.mockResolvedValue(PLAN)
    const res = await inject('POST', '/resources/plan', planBody(c.id), owner)
    expect(res.statusCode).toBe(200)
    expect(res.json().data.changeId).toBe(7)
    expect(engine.plan).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: c.id, scope: 'app', appId: appA }),
      expect.objectContaining({ id: OWNER, isAdmin: false, via: 'session' })
    )
    for (const bad of [
      {},
      { connectionId: c.id, scope: 'app', ops: [{ action: 'create' }] },
      { connectionId: c.id, scope: 'shared', ops: [] },
      { connectionId: c.id, scope: 'shared', ops: [{ action: 'explode' }] },
      { connectionId: c.id, scope: 'galaxy', ops: [{ action: 'delete' }] }
    ]) {
      const r = await inject('POST', '/resources/plan', bad, admin)
      expect(r.statusCode, JSON.stringify(bad)).toBe(400)
    }
  })

  it('maps an engine refusal to its code and status', async () => {
    const c = await makeConnection()
    engine.plan.mockRejectedValue(
      new ResourceChangeError('CONNECTION_NOT_ALLOWED', 'not allowed for that app')
    )
    const res = await inject('POST', '/resources/plan', planBody(c.id), owner)
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('CONNECTION_NOT_ALLOWED')
    engine.start.mockRejectedValue(new ResourceChangeError('STALE_PLAN', 'plan moved'))
    const stale = await inject('POST', '/resource-changes/7/start', { planHash: 'abc' }, owner)
    expect(stale.statusCode).toBe(409)
    expect(stale.json().code).toBe('STALE_PLAN')
    engine.start.mockRejectedValue(
      new ResourceChangeError('FROZEN', 'frozen', { until: 'tomorrow' })
    )
    const frozen = await inject('POST', '/resource-changes/7/start', { planHash: 'abc' })
    expect(frozen.statusCode).toBe(409)
    expect(frozen.json().details).toEqual({ until: 'tomorrow' })
  })

  it('start passes the plan hash and the typed confirm; cancel, resume, undo, approve, decline', async () => {
    for (const f of Object.values(engine)) f.mockResolvedValue(PLAN)
    const start = await inject(
      'POST',
      '/resource-changes/7/start',
      { planHash: 'h1', confirm: 'my-bucket' },
      owner
    )
    expect(start.statusCode).toBe(202)
    expect(engine.start).toHaveBeenCalledWith(
      7,
      { planHash: 'h1', confirm: 'my-bucket' },
      expect.objectContaining({ id: OWNER })
    )
    expect((await inject('POST', '/resource-changes/7/start', {}, owner)).statusCode).toBe(400)
    expect((await inject('POST', '/resource-changes/7/cancel', undefined, owner)).statusCode).toBe(
      200
    )
    expect((await inject('POST', '/resource-changes/7/resume', undefined, owner)).statusCode).toBe(
      202
    )
    expect((await inject('POST', '/resource-changes/7/undo', undefined, owner)).statusCode).toBe(
      200
    )
    expect(
      (await inject('POST', '/resource-changes/7/approve', { planHash: 'h1' })).statusCode
    ).toBe(202)
    expect(engine.approve).toHaveBeenCalledWith(7, { planHash: 'h1' }, expect.anything())
    expect((await inject('POST', '/resource-changes/7/decline', {})).statusCode).toBe(400)
    expect(
      (await inject('POST', '/resource-changes/7/decline', { reason: 'too costly' })).statusCode
    ).toBe(200)
    expect(engine.decline).toHaveBeenCalledWith(7, 'too costly', expect.anything())
    expect((await inject('POST', '/resource-changes/nope/cancel')).statusCode).toBe(404)
  })

  it('masks fail-closed: a resourceId-only op takes its stored resource type; an unknown type masks everything', async () => {
    const c = await makeConnection()
    const res = await makeResource(c.id)
    const mk = (ops: unknown[], extra: Record<string, unknown> = {}) =>
      store.insertChange({
        connection_id: c.id,
        app_id: appA,
        scope: 'app',
        plan_hash: 'h',
        plan: {
          request: { connectionId: c.id, scope: 'app', appId: appA, ops },
          ops: [],
          gates: [],
          needsConfirm: null,
          needsApproval: false,
          blockers: [],
          preconditionFingerprint: 'p',
          resourceIds: [],
          ...extra
        } as never
      })
    // Update with only resourceId: the type comes from the stored resource row.
    const upd = await mk([
      { action: 'update', resourceId: res.id, fields: { name: 'n2', password: SECRET } }
    ])
    const a = await inject('GET', `/resource-changes/${upd.id}`, undefined, owner)
    expect(a.body).not.toContain(SECRET)
    expect(a.json().data.plan.request.ops[0].fields.name).toBe('n2')
    // Resource row gone: the type comes from the plan's computed op.
    const viaPlan = await mk(
      [{ action: 'update', resourceId: 99999, fields: { name: 'n3', password: SECRET } }],
      { ops: [{ type: 'demo.thing', resourceId: 99999 }] }
    )
    const b = await inject('GET', `/resource-changes/${viaPlan.id}`, undefined, owner)
    expect(b.body).not.toContain(SECRET)
    expect(b.json().data.plan.request.ops[0].fields.name).toBe('n3')
    // Nothing resolves, or the type is unknown: every value is masked.
    const unknown = await mk([
      { action: 'update', resourceId: 99998, fields: { name: 'n4', password: SECRET } },
      { action: 'create', type: 'nope.thing', fields: { name: 'n5', token: SECRET2 } }
    ])
    const d = await inject('GET', `/resource-changes/${unknown.id}`, undefined, owner)
    expect(d.body).not.toContain(SECRET)
    expect(d.body).not.toContain(SECRET2)
    expect(d.body).not.toContain('n4')
    expect(d.body).not.toContain('n5')
    expect(d.json().data.plan.request.ops[0].fields.name).toBe('••••••')
    // An unknown key on a known type is masked too.
    const extra = await mk([
      { action: 'create', type: 'demo.thing', fields: { name: 'n6', apiKey: SECRET } }
    ])
    const e = await inject('GET', `/resource-changes/${extra.id}`, undefined, owner)
    expect(e.body).not.toContain(SECRET)
    expect(e.json().data.plan.request.ops[0].fields.name).toBe('n6')
  })

  it('an owner reads only changes of their own app; a plain secret in a stored plan never leaves', async () => {
    const c = await makeConnection()
    const plan = {
      request: {
        connectionId: c.id,
        scope: 'app',
        appId: appA,
        ops: [{ action: 'create', type: 'demo.thing', fields: { name: 'x', password: SECRET } }]
      },
      ops: [],
      gates: [],
      needsConfirm: null,
      needsApproval: false,
      blockers: [],
      preconditionFingerprint: 'p',
      resourceIds: []
    }
    const mine = await store.insertChange({
      connection_id: c.id,
      app_id: appA,
      scope: 'app',
      plan: plan as never,
      plan_hash: 'h'
    })
    const theirs = await store.insertChange({
      connection_id: c.id,
      app_id: appB,
      scope: 'app',
      plan: { ...plan, request: { ...plan.request, appId: appB } } as never,
      plan_hash: 'h'
    })
    const shared = await store.insertChange({
      connection_id: c.id,
      scope: 'shared',
      plan: plan as never,
      plan_hash: 'h'
    })
    const list = await inject('GET', '/resource-changes', undefined, owner)
    expect(list.json().data.map((r: { id: number }) => r.id)).toEqual([mine.id])
    expect(list.body).not.toContain(SECRET)
    expect(
      (await inject('GET', `/resource-changes/${theirs.id}`, undefined, owner)).statusCode
    ).toBe(404)
    expect(
      (await inject('GET', `/resource-changes/${shared.id}`, undefined, owner)).statusCode
    ).toBe(404)
    const one = await inject('GET', `/resource-changes/${mine.id}`, undefined, owner)
    expect(one.statusCode).toBe(200)
    expect(one.body).not.toContain(SECRET)
    expect(one.json().data.plan.request.ops[0].fields.name).toBe('x')
    expect((await inject('GET', '/resource-changes')).json().data.length).toBe(3)
    expect((await inject('GET', `/resource-changes?app=${appA}`)).json().data.length).toBe(1)
    expect(
      (await inject('GET', `/resource-changes?app=${appB}`, undefined, owner)).statusCode
    ).toBe(404)
  })
})

describe('credential gate', () => {
  it('a hub:read key plans but cannot start; a hub:write key can', async () => {
    const c = await makeConnection()
    engine.plan.mockResolvedValue(PLAN)
    engine.start.mockResolvedValue(PLAN)
    const body = { connectionId: c.id, scope: 'shared', ops: [{ action: 'delete', resourceId: 1 }] }
    expect((await inject('POST', '/resources/plan', body, key('read'))).statusCode).toBe(200)
    const start = await inject('POST', '/resource-changes/7/start', { planHash: 'h' }, key('read'))
    expect(start.statusCode).toBe(403)
    expect(start.json().code).toBe('HUB_SCOPE_MISSING')
    expect((await inject('GET', '/connections', undefined, key('read'))).statusCode).toBe(200)
    expect((await inject('GET', '/connections', undefined, key(null))).statusCode).toBe(403)
    expect(engine.start).not.toHaveBeenCalled()
    expect(
      (await inject('POST', '/resource-changes/7/start', { planHash: 'h' }, key('write')))
        .statusCode
    ).toBe(202)
  })

  it('an MCP tool call plans and reads, never starts or writes a connection', async () => {
    const c = await makeConnection()
    engine.plan.mockResolvedValue(PLAN)
    const mcp = { ...admin, 'x-mcp': '1' }
    const body = { connectionId: c.id, scope: 'shared', ops: [{ action: 'delete', resourceId: 1 }] }
    expect((await inject('POST', '/resources/plan', body, mcp)).statusCode).toBe(200)
    expect((await inject('GET', '/resources', undefined, mcp)).statusCode).toBe(200)
    const start = await inject('POST', '/resource-changes/7/start', { planHash: 'h' }, mcp)
    expect(start.statusCode).toBe(403)
    expect(start.json().code).toBe('HUB_WRITE_NOT_FOR_AGENTS')
    const conn = await inject('POST', '/connections', { provider: 'demo', name: 'x' }, mcp)
    expect(conn.json().code).toBe('HUB_WRITE_NOT_FOR_AGENTS')
    expect(engine.start).not.toHaveBeenCalled()
  })

  it('View-as never writes but may read and plan', async () => {
    const c = await makeConnection()
    engine.plan.mockResolvedValue(PLAN)
    const viewAs = { ...owner, 'x-masq': ADMIN, 'x-auth': 'masquerade' }
    const body = {
      connectionId: c.id,
      scope: 'app',
      appId: appA,
      ops: [{ action: 'accept', resourceId: 1 }]
    }
    expect((await inject('POST', '/resources/plan', body, viewAs)).statusCode).toBe(200)
    expect(engine.plan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ via: 'view_as' })
    )
    const start = await inject('POST', '/resource-changes/7/start', { planHash: 'h' }, viewAs)
    expect(start.statusCode).toBe(403)
    expect(start.json().code).toBe('NOT_WHILE_MASQUERADING')
  })

  it('requires a signed-in caller', async () => {
    expect((await inject('GET', '/connections', undefined, {})).statusCode).toBe(401)
    expect(other).toBeTruthy()
  })
})
