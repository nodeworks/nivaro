import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Hub enhancement 25: the Hub MCP tools see exactly what the Hub's REST routes let the caller see.
// The real @nivaro/mcp server runs over a fetch that re-enters the real hub routes as the caller
// (as the hosted endpoint does in-process); SQLite with the real hub tables. An administrator sees
// every app, an owner only theirs (another answers not found), anyone else nothing.

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
  const sign = async (req: {
    headers: Record<string, string | undefined>
    user?: unknown
    isAdmin?: boolean
  }) => {
    const id = req.headers['x-user']
    if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active' }
    req.isAdmin = req.headers['x-admin'] === '1'
  }
  const admin = async (req: Parameters<typeof sign>[0]) => {
    await sign(req)
    if (!req.isAdmin)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
  }
  return {
    requireAuth: vi.fn(sign),
    requireAdmin: vi.fn(admin),
    authenticate: vi.fn(sign),
    enforceRateLimit: vi.fn()
  }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/543_hub_promotions.js'),
  await import('../../../db/migrations/544_hub_databases.js'),
  await import('../../../db/migrations/545_hub_creations.js'),
  await import('../../../db/migrations/546_hub_stack_settings.js'),
  await import('../../../db/migrations/550_hub_oidc.js'),
  await import('../../../db/migrations/551_hub_signins.js')
]
const { hubRoutes } = await import('../../../routes/hub.js')
const { createNivaroMcpServer, HUB_ADMIN_TOOL_NAMES, HUB_TOOL_NAMES } = await import('@nivaro/mcp')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

const ADMIN = 'AAAAAAAA-0000-4000-8000-000000000001'
const OWNER = 'BBBBBBBB-0000-4000-8000-000000000002'
const OTHER = 'CCCCCCCC-0000-4000-8000-000000000003'
const KEY = 'a'.repeat(64)
const who = {
  admin: { 'x-user': ADMIN, 'x-admin': '1' },
  owner: { 'x-user': OWNER },
  other: { 'x-user': OTHER }
}

let app: FastifyInstance
let prevHub: string | undefined
let prevKey: string | undefined
let mine: { id: number; envId: number }
let theirs: { id: number; envId: number }

/** A fetch that re-enters the hub routes as `headers` (what injectFetch does on /api/mcp). */
function fetchAs(headers: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: `${u.pathname}${u.search}`,
      headers: { ...headers, 'content-type': 'application/json' },
      ...(init?.body ? { payload: String(init.body) } : {})
    })
    return new Response(res.statusCode === 204 ? null : res.body, {
      status: res.statusCode,
      headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') }
    })
  }) as typeof fetch
}

async function connectAs(headers: Record<string, string>, adminTools = false) {
  const { server } = createNivaroMcpServer({
    url: 'http://hub.test',
    token: 'nvk_test',
    fetch: fetchAs(headers),
    adminTools,
    hub: { adminUrl: 'https://hub.example.com' }
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 't', version: '0' })
  await server.connect(b)
  await mcp.connect(a)
  return mcp
}

const text = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text)

beforeAll(async () => {
  prevHub = process.env.HUB
  prevKey = process.env.ENCRYPTION_KEY
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = KEY
  for (const m of migrations) await m.up(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id').primary()
    t.string('first_name')
    t.string('last_name')
    t.string('email')
  })
  await db('nivaro_users').insert([
    { id: ADMIN, email: 'ada@x' },
    { id: OWNER, first_name: 'Olly', email: 'olly@x' },
    { id: OTHER, email: 'other@x' }
  ])
  app = Fastify()
  app.decorate('redis', { get: vi.fn(), set: vi.fn(), del: vi.fn(async () => 1) } as never)
  await app.register(hubRoutes, { prefix: '/api/hub' })
  await app.ready()
  const make = async (key: string, owner: string | null) => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/hub/apps',
      headers: who.admin,
      payload: { key, name: key.toUpperCase(), adopted: true }
    })
    const id = r.json().data.id as number
    if (owner)
      await app.inject({
        method: 'PUT',
        url: `/api/hub/apps/${id}/owners`,
        headers: who.admin,
        payload: { user_ids: [owner], owners: [owner] }
      })
    const e = await app.inject({
      method: 'POST',
      url: `/api/hub/apps/${id}/environments`,
      headers: who.admin,
      payload: { key: 'production', base_url: `https://${key}.example.com` }
    })
    return { id, envId: e.json().data?.id as number }
  }
  mine = await make('mine', OWNER)
  theirs = await make('theirs', null)
})
afterAll(async () => {
  await app.close()
  await db.destroy()
  if (prevHub === undefined) delete process.env.HUB
  else process.env.HUB = prevHub
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
})

describe('Hub MCP tools are scoped like the REST routes', () => {
  it('the fixture: the owner owns one app', async () => {
    const owners = await db('nivaro_hub_app_owners').select('app_id', 'user_id')
    expect(owners).toEqual([{ app_id: mine.id, user_id: OWNER }])
    expect(mine.envId).toBeGreaterThan(0)
  })

  it('hub_list_apps: admin sees both, the owner only theirs, anyone else none', async () => {
    const keys = async (h: Record<string, string>) => {
      const mcp = await connectAs(h)
      const out = text(await mcp.callTool({ name: 'hub_list_apps', arguments: {} }))
      await mcp.close()
      return out.apps.map((a: { key: string }) => a.key)
    }
    expect(await keys(who.admin)).toEqual(['mine', 'theirs'])
    expect(await keys(who.owner)).toEqual(['mine'])
    expect(await keys(who.other)).toEqual([])
  })

  it('hub_read_app: another person’s app answers not found, as the route does', async () => {
    const mcp = await connectAs(who.owner)
    const ok = await mcp.callTool({ name: 'hub_read_app', arguments: { app_id: mine.id } })
    expect(ok.isError).toBeFalsy()
    expect(text(ok).environments.map((e: { key: string }) => e.key)).toEqual(['production'])
    const no = await mcp.callTool({ name: 'hub_read_app', arguments: { app_id: theirs.id } })
    expect(no.isError).toBe(true)
    expect(text(no).status).toBe(404)
    await mcp.close()
  })

  it('hub_deploy_history and hub_plan_promote refuse an environment of an app the owner does not own', async () => {
    const mcp = await connectAs(who.owner)
    const hist = await mcp.callTool({
      name: 'hub_deploy_history',
      arguments: { environment_id: theirs.envId }
    })
    expect(hist.isError).toBe(true)
    expect(text(hist).status).toBe(404)
    const plan = await mcp.callTool({
      name: 'hub_plan_promote',
      arguments: { app_id: theirs.id, environment_id: theirs.envId, version: '0.3.216' }
    })
    expect(plan.isError).toBe(true)
    await mcp.close()
  })

  it('the owner reads their own environment’s Hub deploy history', async () => {
    const mcp = await connectAs(who.owner)
    const hist = await mcp.callTool({
      name: 'hub_deploy_history',
      arguments: { environment_id: mine.envId }
    })
    expect(hist.isError).toBeFalsy()
    expect(text(hist)).toMatchObject({ source: 'hub', deploys: [] })
    await mcp.close()
  })

  it('the admin-only plans are not even listed for an owner; listed for an administrator', async () => {
    const owner = await connectAs(who.owner, false)
    const ownerNames = (await owner.listTools()).tools.map((t) => t.name)
    for (const t of HUB_TOOL_NAMES) expect(ownerNames).toContain(t)
    for (const t of HUB_ADMIN_TOOL_NAMES) expect(ownerNames).not.toContain(t)
    await owner.close()
    const admin = await connectAs(who.admin, true)
    const adminNames = (await admin.listTools()).tools.map((t) => t.name)
    for (const t of HUB_ADMIN_TOOL_NAMES) expect(adminNames).toContain(t)
    await admin.close()
  })
})

describe('mcpToolOptions: Hub tools only on a Hub', () => {
  it('hub is set with HUB=on and null without', async () => {
    const { mcpToolOptions } = await import('../../../routes/mcp.js')
    const req = { isAdmin: false, user: { id: OWNER } } as unknown as FastifyRequest
    process.env.HUB = 'on'
    expect(mcpToolOptions(req).hub).toEqual({ adminUrl: expect.anything() })
    delete process.env.HUB
    expect(mcpToolOptions(req).hub).toBeNull()
    process.env.HUB = 'on'
  })

  it('review M4: a Hub scope on the connection, never a collection-scoped key', async () => {
    const { mcpToolOptions } = await import('../../../routes/mcp.js')
    const has = (r: Record<string, unknown>) =>
      mcpToolOptions({ isAdmin: true, user: { id: ADMIN }, ...r } as unknown as FastifyRequest)
        .hub !== null
    // OAuth: only with hub:read.
    expect(has({ authMethod: 'oauth', oauthScopes: ['mcp'] })).toBe(false)
    expect(has({ authMethod: 'oauth', oauthScopes: ['mcp', 'hub:read'] })).toBe(true)
    // An OAuth connection narrowed to collections never reaches the Hub.
    expect(
      has({
        authMethod: 'oauth',
        oauthScopes: ['hub:read'],
        user: { id: ADMIN, api_key_scopes: [{ collection: 'orders', actions: ['read'] }] }
      })
    ).toBe(false)
    // API key: a $hub read entry; `*` collections do not imply it.
    const key = (scopes: unknown[]) => ({
      authMethod: 'api_key',
      apiKeyScopes: scopes,
      user: { id: ADMIN, api_key_scopes: scopes }
    })
    expect(has(key([{ collection: '*', actions: ['*'] }]))).toBe(false)
    expect(has(key([{ collection: 'orders', actions: ['read'] }]))).toBe(false)
    expect(has(key([{ collection: '$hub', actions: ['read'] }]))).toBe(true)
    // An administrator's own session (the MCP console) keeps them.
    expect(has({})).toBe(true)
  })
})
