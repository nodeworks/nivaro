import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type LightMyRequestResponse
} from 'fastify'
import { execute, GraphQLObjectType, GraphQLSchema, parse } from 'graphql'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The Hub's API surface by credential (services/hub/api/gate.ts) on the real Hub routes, on an
// in-memory SQLite with the Hub tables: API keys need hub:read / hub:write (`*` never implies
// it), connected apps and MCP tool calls only read and plan, View-as never writes. The GraphQL
// `hub` namespace answers through the same routes, so it gives the same 403 / 404.

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
// The sign-in is faked from headers: x-user, x-admin, x-auth (authMethod), x-scopes (key scopes
// JSON), x-mcp (an MCP tool call), x-masq (View-as admin id).
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
    if (h['x-oscopes']) req.oauthScopes = h['x-oscopes'].split(' ')
    if (h['x-mcpcols'])
      req.mcpScope = { collections: h['x-mcpcols'].split(','), kit_missing: false } as never
  }
  const admin = async (req: FastifyRequest, reply: unknown) => {
    await sign(req)
    void reply
    if (!req.isAdmin)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
    // Like the real requireAdmin: a key limited to named scopes stays out of administration.
    const open = (req.apiKeyScopes ?? []).some(
      (s) => s.collection === '*' && s.actions.includes('*')
    )
    if (req.apiKeyScopes && !open)
      throw Object.assign(new Error('limited key'), {
        statusCode: 403,
        code: 'API_KEY_SCOPE_MISSING'
      })
  }
  return { requireAuth: vi.fn(sign), requireAdmin: vi.fn(admin), authenticate: vi.fn(sign) }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { up } = await import('../../../db/migrations/542_hub_tables.js')
const { up: up544 } = await import('../../../db/migrations/544_hub_databases.js')
const { up: up545 } = await import('../../../db/migrations/545_hub_creations.js')
const { up: up546 } = await import('../../../db/migrations/546_hub_stack_settings.js')
const { up: up550 } = await import('../../../db/migrations/550_hub_oidc.js')
const { up: up551 } = await import('../../../db/migrations/551_hub_signins.js')
const { hubRoutes } = await import('../../../routes/hub.js')
const { hubGraphQLFields } = await import('../../../services/hub/api/graphql.js')
const { installHubCredentialGate, carriesHubGate, carriesRawAuth } = await import(
  '../../../services/hub/api/gate.js'
)

const ADMIN = 'AAAAAAAA-0000-4000-8000-000000000001'
const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const OTHER = 'CCCCCCCC-0000-4000-8000-000000000003'

const admin = { 'x-user': ADMIN, 'x-admin': '1' }
const key = (actions: string[] | null, who = admin) => ({
  ...who,
  'x-auth': 'api_key',
  'x-scopes': JSON.stringify([
    { collection: '*', actions: ['*'] },
    ...(actions ? [{ collection: '$hub', actions }] : [])
  ])
})

let app: FastifyInstance
let prevHub: string | undefined
let prevKey: string | undefined
let appId = 0
const seen: Array<{ url: string; method: string; preHandler: unknown }> = []
let ownedId = 0

beforeAll(async () => {
  prevHub = process.env.HUB
  prevKey = process.env.ENCRYPTION_KEY
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = 'a'.repeat(64)
  for (const m of [up, up544, up545, up546, up550, up551]) await m(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id').primary()
    t.string('first_name')
    t.string('last_name')
    t.string('email')
  })
  await db('nivaro_users').insert([
    { id: ADMIN, email: 'ada@x' },
    { id: OWNER, email: 'olly@x' },
    { id: OTHER, email: 'other@x' }
  ])
  app = Fastify()
  app.decorate('redis', { get: vi.fn(), set: vi.fn(), del: vi.fn(async () => 1) } as never)
  // As production: the gate is installed once at the root (routes/index.ts registerRoutes).
  installHubCredentialGate(app)
  app.addHook('onRoute', (opts) => {
    seen.push({ url: opts.url, method: String(opts.method), preHandler: opts.preHandler })
  })
  await app.register(hubRoutes, { prefix: '/api/hub' })
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
  await db('nivaro_hub_app_owners').del()
  await db('nivaro_hub_apps').del()
  appId = Number(
    (
      await app.inject({
        method: 'POST',
        url: '/api/hub/apps',
        headers: admin,
        payload: { key: 'theirs', name: 'Theirs' }
      })
    ).json().data.id
  )
  ownedId = Number(
    (
      await app.inject({
        method: 'POST',
        url: '/api/hub/apps',
        headers: admin,
        payload: { key: 'mine', name: 'Mine' }
      })
    ).json().data.id
  )
  await app.inject({
    method: 'PUT',
    url: `/api/hub/apps/${ownedId}/owners`,
    headers: admin,
    payload: { user_ids: [OWNER] }
  })
})

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  headers: Record<string, string>,
  payload?: unknown
): Promise<LightMyRequestResponse> =>
  app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as never } : {})
  })

describe('API keys on the Hub', () => {
  it('a key without a Hub scope is refused, even with `*`', async () => {
    const r = await call('GET', '/api/hub/apps', key(null))
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('HUB_SCOPE_MISSING')
  })

  it('hub:read reads and plans, but never writes', async () => {
    expect((await call('GET', '/api/hub/apps', key(['read']))).statusCode).toBe(200)
    expect((await call('GET', '/api/hub/drivers', key(['read']))).statusCode).toBe(200)
    const plan = await call('POST', '/api/hub/apps/create/plan', key(['read']), { key: 'x' })
    expect(plan.statusCode).not.toBe(403)
    const write = await call('PATCH', `/api/hub/apps/${appId}`, key(['read']), { name: 'X' })
    expect(write.statusCode).toBe(403)
    expect(write.json().code).toBe('HUB_SCOPE_MISSING')
  })

  it('hub:write on an administrator’s key writes (admin routes included)', async () => {
    const r = await call('PATCH', `/api/hub/apps/${appId}`, key(['read', 'write']), { name: 'New' })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.name).toBe('New')
  })

  it('a key limited to the Hub alone reaches admin Hub routes (the Hub scope is its grant)', async () => {
    const hubOnly = {
      ...admin,
      'x-auth': 'api_key',
      'x-scopes': JSON.stringify([{ collection: '$hub', actions: ['read', 'write'] }])
    }
    expect((await call('GET', '/api/hub/drivers', hubOnly)).statusCode).toBe(200)
    const r = await call('PATCH', `/api/hub/apps/${appId}`, hubOnly, { name: 'Only hub' })
    expect(r.statusCode).toBe(200)
    const none = {
      ...admin,
      'x-auth': 'api_key',
      'x-scopes': JSON.stringify([{ collection: 'x', actions: ['read'] }])
    }
    const refused = await call('GET', '/api/hub/drivers', none)
    expect(refused.statusCode).toBe(403)
    expect(refused.json().code).toBe('HUB_SCOPE_MISSING')
  })

  it('an owner’s key acts as the owner: own app only, no admin routes', async () => {
    const asOwnerKey = key(['read', 'write'], { 'x-user': OWNER } as never)
    const list = await call('GET', '/api/hub/apps', asOwnerKey)
    expect(list.statusCode).toBe(200)
    expect(list.json().data.map((a: { key: string }) => a.key)).toEqual(['mine'])
    expect((await call('GET', `/api/hub/apps/${appId}`, asOwnerKey)).statusCode).toBe(404)
    const adminOnly = await call('PATCH', `/api/hub/apps/${ownedId}`, asOwnerKey, { name: 'Y' })
    expect(adminOnly.statusCode).toBe(403)
    expect(adminOnly.json().code).toBe('ADMIN_ONLY')
  })
})

describe('connected apps, MCP and View-as on the Hub', () => {
  it('OAuth needs the hub:read scope; OAuth and MCP tool calls read and plan, never write', async () => {
    const noScope = await call('GET', '/api/hub/apps', { ...admin, 'x-auth': 'oauth' })
    expect(noScope.statusCode).toBe(403)
    expect(noScope.json().code).toBe('HUB_SCOPE_MISSING')
    for (const h of [
      { ...admin, 'x-auth': 'oauth', 'x-oscopes': 'nivaro hub:read' },
      { ...admin, 'x-auth': 'oauth', 'x-oscopes': 'nivaro hub:read', 'x-mcp': '1' },
      { ...admin, 'x-mcp': '1' },
      { ...key(['read', 'write']), 'x-mcp': '1' }
    ]) {
      expect((await call('GET', '/api/hub/apps', h)).statusCode).toBe(200)
      expect((await call('POST', '/api/hub/apps/create/plan', h, {})).statusCode).not.toBe(403)
      const w = await call('PATCH', `/api/hub/apps/${appId}`, h, { name: 'Z' })
      expect(w.statusCode).toBe(403)
      expect(w.json().code).toBe('HUB_WRITE_NOT_FOR_AGENTS')
    }
  })

  it('a collection-scoped admin key, a collection-limited MCP connection and the Teams bot see no Hub app', async () => {
    const scopedKey = {
      ...admin,
      'x-auth': 'api_key',
      'x-scopes': JSON.stringify([{ collection: 'projects', actions: ['read'] }])
    }
    const limitedConn = { ...key(['read']), 'x-mcp': '1', 'x-mcpcols': 'projects' }
    for (const h of [scopedKey, limitedConn, { ...admin, 'x-auth': 'teams' }]) {
      const r = await call('GET', '/api/hub/apps', h)
      expect(r.statusCode).toBe(403)
      expect(r.json().code).toBe('HUB_SCOPE_MISSING')
    }
  })

  it('View-as and run-as-key never write', async () => {
    const viewAs = { ...admin, 'x-auth': 'masquerade', 'x-masq': OTHER }
    expect((await call('GET', '/api/hub/apps', viewAs)).statusCode).toBe(200)
    const w = await call('PATCH', `/api/hub/apps/${appId}`, viewAs, { name: 'Q' })
    expect(w.statusCode).toBe(403)
    expect(w.json().code).toBe('NOT_WHILE_MASQUERADING')
    const runAs = { ...key(['read', 'write']), 'x-auth': 'key_sim', 'x-masq': ADMIN }
    const w2 = await call('PATCH', `/api/hub/apps/${appId}`, runAs, { name: 'Q' })
    expect(w2.statusCode).toBe(403)
    expect(w2.json().code).toBe('NOT_WHILE_MASQUERADING')
  })

  it('a person on their own session is unchanged', async () => {
    expect((await call('PATCH', `/api/hub/apps/${appId}`, admin, { name: 'S' })).statusCode).toBe(
      200
    )
  })
})

describe('GraphQL hub namespace answers like its REST twin', () => {
  function schema() {
    const f = hubGraphQLFields()
    if (!f) throw new Error('hub fields missing with HUB=on')
    return new GraphQLSchema({
      query: new GraphQLObjectType({ name: 'Query', fields: { hub: f.query } }),
      mutation: new GraphQLObjectType({ name: 'Mutation', fields: { hub: f.mutation } })
    })
  }
  const gql = (source: string, headers: Record<string, string>) =>
    execute({
      schema: schema(),
      document: parse(source),
      contextValue: {
        req: { headers, server: app, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' }
      }
    })
  const statusOf = (res: Awaited<ReturnType<typeof gql>>) =>
    (res.errors?.[0]?.extensions as { status?: number } | undefined)?.status ?? 200
  /** Runs `source`, counting the inner Hub requests and the most in flight at once. */
  async function gqlCounted(source: string, headers: Record<string, string>) {
    let calls = 0
    let active = 0
    let peak = 0
    const server = {
      inject: async (o: Parameters<typeof app.inject>[0]) => {
        calls++
        active++
        peak = Math.max(peak, active)
        try {
          await new Promise((r) => setTimeout(r, 2))
          return await app.inject(o as never)
        } finally {
          active--
        }
      }
    }
    const res = await execute({
      schema: schema(),
      document: parse(source),
      contextValue: {
        req: { headers, server, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' }
      }
    })
    return { res, calls, peak }
  }

  it('one operation reads each Hub path once, at most 8 at a time', async () => {
    const aliases = Array.from(
      { length: 30 },
      (_, i) => `a${i}: app(id: ${appId}) { name owners { userId } environments { id } }`
    )
    const { res, calls, peak } = await gqlCounted(`{ hub { ${aliases.join(' ')} } }`, admin)
    expect(res.errors).toBeUndefined()
    expect(calls).toBe(1)
    const many = Array.from(
      { length: 30 },
      (_, i) => `d${i}: drivers { id } s${i}: app(id: ${i + 1000}) { id }`
    )
    const r2 = await gqlCounted(`{ hub { ${many.join(' ')} } }`, admin)
    expect(r2.calls).toBe(31)
    expect(r2.peak).toBeLessThanOrEqual(8)
  })

  it('refuses an operation past 200 inner Hub requests (QUERY_TOO_COSTLY)', async () => {
    const many = Array.from({ length: 210 }, (_, i) => `x${i}: app(id: ${i + 5000}) { id }`)
    const { res, calls } = await gqlCounted(`{ hub { ${many.join(' ')} } }`, admin)
    expect(calls).toBe(200)
    const codes = (res.errors ?? []).map((e) => (e.extensions as { code?: string }).code)
    expect(codes).toContain('QUERY_TOO_COSTLY')
  })

  it('the same apps as REST for an owner', async () => {
    const h = { 'x-user': OWNER }
    const res = await gql('{ hub { apps { id key } } }', h)
    const rest = (await call('GET', '/api/hub/apps', h)).json().data
    expect(res.errors).toBeUndefined()
    expect((res.data?.hub as { apps: unknown[] }).apps).toEqual(
      rest.map((a: { id: number; key: string }) => ({ id: a.id, key: a.key }))
    )
  })

  it('404 for an app the caller does not own, 403 for a key without the Hub scope', async () => {
    const owner = { 'x-user': OWNER }
    const rest404 = await call('GET', `/api/hub/apps/${appId}`, owner)
    const gql404 = await gql(`{ hub { app(id: ${appId}) { id } } }`, owner)
    expect(rest404.statusCode).toBe(404)
    expect(statusOf(gql404)).toBe(404)

    const k = key(null)
    const rest403 = await call('GET', '/api/hub/drivers', k)
    const gql403 = await gql('{ hub { drivers { id } } }', k)
    expect(rest403.statusCode).toBe(403)
    expect(statusOf(gql403)).toBe(403)
    expect((gql403.errors?.[0]?.extensions as { code?: string }).code).toBe('HUB_SCOPE_MISSING')
  })

  it('metadata mutations go through the same gate', async () => {
    const ok = await gql(
      `mutation { hub { updateApp(id: ${appId}, name: "Via GraphQL") { name } } }`,
      admin
    )
    expect(ok.errors).toBeUndefined()
    expect((ok.data?.hub as { updateApp: { name: string } }).updateApp.name).toBe('Via GraphQL')
    const agent = await gql(`mutation { hub { updateApp(id: ${appId}, name: "No") { name } } }`, {
      ...admin,
      'x-auth': 'oauth'
    })
    expect(statusOf(agent)).toBe(403)
  })
})

describe('Hub mode off', () => {
  it('a regular install mounts no Hub routes (404) and has no GraphQL hub fields', async () => {
    const saved = process.env.HUB
    delete process.env.HUB
    try {
      const plain = Fastify()
      installHubCredentialGate(plain)
      await plain.register(hubRoutes, { prefix: '/api/hub' })
      await plain.ready()
      expect(
        (await plain.inject({ method: 'GET', url: '/api/hub/apps', headers: admin })).statusCode
      ).toBe(404)
      await plain.close()
      expect(hubGraphQLFields()).toBeNull()
    } finally {
      process.env.HUB = saved
    }
  })

  it('cloud mode never has them, even with HUB=on', () => {
    expect(hubGraphQLFields({ HUB: 'on', CLOUD_META_DB_URL: 'mssql://x' } as never)).toBeNull()
    expect(hubGraphQLFields({ HUB: 'on', HUB_SHARED_DEPLOYMENT: 'pool-a' } as never)).toBeNull()
  })
})

describe('every registered Hub route is behind the gate', () => {
  it('no /api/hub route keeps the raw requireAuth / requireAdmin; signed-in ones carry the gate', () => {
    const hub = seen.filter((r) => r.url.startsWith('/api/hub/'))
    expect(hub.length).toBeGreaterThan(80)
    const raw = hub.filter((r) => carriesRawAuth(r.preHandler)).map((r) => `${r.method} ${r.url}`)
    expect(raw).toEqual([])
    // Only the shared deployment's tenant list (its own bearer) has no person gate.
    const open = hub.filter((r) => !carriesHubGate(r.preHandler)).map((r) => `${r.method} ${r.url}`)
    expect(open.every((r) => r.includes('/api/hub/shared/:key/tenants'))).toBe(true)
  })
})
