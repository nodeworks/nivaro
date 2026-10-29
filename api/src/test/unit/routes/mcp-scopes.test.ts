import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const GRANT = '0b6a6f0e-3f6c-4d8e-9b1a-2c3d4e5f6a7b'
const OTHER = '1c7b7f1f-4a7d-4e9f-8c2b-3d4e5f6a7b8c'

const state = vi.hoisted(() => ({
  admin: false,
  method: 'session' as string,
  rows: new Map<string, Record<string, unknown>>(),
  writes: [] as Array<{ conn: string; patch: Record<string, unknown> }>
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: async (req: { user?: unknown; isAdmin?: boolean; authMethod?: string }) => {
    req.user = { id: 'U1' }
    req.isAdmin = state.admin
    req.authMethod = state.method
  },
  requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }) => {
    if (!state.admin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    req.user = { id: 'ADMIN' }
    req.isAdmin = true
  }
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/mcp-tool-catalog.js', () => ({
  toolCatalogFor: vi.fn(async () => [
    { name: 'search', title: 'Search', description: '', group: 'everyday', read_only: true }
  ])
}))
vi.mock('../../../services/oauth-store.js', () => ({
  getGrant: vi.fn(async (_r: unknown, id: string) =>
    id === GRANT ? { id, user_id: 'U1' } : id === OTHER ? { id, user_id: 'U2' } : null
  )
}))
vi.mock('../../../db/index.js', () => ({
  db: () => ({
    where: () => ({ first: async () => undefined })
  })
}))
vi.mock('../../../services/mcp-scope.js', async (orig) => {
  const real = await orig<typeof import('../../../services/mcp-scope.js')>()
  return {
    ...real,
    scopesReady: async () => true,
    readScopeRow: async (conn: string) => (state.rows.get(conn) as never) ?? null,
    kitUseCount: async (kit: string) => (kit === 'finance' ? 2 : 0),
    writeScope: async (conn: string, patch: Record<string, unknown>) => {
      state.writes.push({ conn, patch })
      const row = { conn, ...patch, user: 'U1', updated_by: 'U1', updated_at: null }
      state.rows.set(conn, row)
      return row
    },
    deleteScope: async (conn: string) => state.rows.delete(conn)
  }
})
vi.mock('../../../services/mcp-kits.js', async (orig) => {
  const real = await orig<typeof import('../../../services/mcp-kits.js')>()
  const finance = {
    key: 'finance',
    label: 'Finance',
    description: '',
    tools: ['search'],
    collections: null,
    actions: null,
    builtin: false,
    sort: 100
  }
  return {
    ...real,
    kitsReady: async () => true,
    listKits: async () => [...real.BUILTIN_KITS, finance],
    kitMap: async () => new Map([...real.BUILTIN_KITS, finance].map((k) => [k.key, k])),
    storedKitCount: async () => 1,
    saveKit: vi.fn(async () => {}),
    deleteKit: vi.fn(async () => true)
  }
})

const { mcpScopeRoutes } = await import('../../../routes/mcp-scopes.js')

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  app.decorate('redis', {} as never)
  await app.register(mcpScopeRoutes, { prefix: '/mcp-connections' })
  await app.ready()
})
afterAll(() => app.close())
beforeEach(() => {
  state.admin = false
  state.method = 'session'
  state.rows.clear()
  state.writes.length = 0
})

const put = (url: string, payload: unknown) =>
  app.inject({ method: 'PUT', url, payload: payload as object })

describe('a person limits their own connection', () => {
  it('sets a kit on their own OAuth connection, never locked', async () => {
    const res = await put(`/mcp-connections/mine/o${GRANT}/scope`, { kit: 'buyer', locked: true })
    expect(res.statusCode).toBe(200)
    expect(state.writes[0].patch).toMatchObject({ kit: 'buyer', locked: false })
    expect(res.json().data.effective.tools).toContain('read_items')
  })

  it('cannot touch someone else’s connection or an API key', async () => {
    expect((await put(`/mcp-connections/mine/o${OTHER}/scope`, { kit: 'buyer' })).statusCode).toBe(
      404
    )
    expect((await put('/mcp-connections/mine/k4/scope', { kit: 'buyer' })).statusCode).toBe(400)
  })

  it('cannot change a limit an administrator locked', async () => {
    state.rows.set(`o${GRANT}`, { conn: `o${GRANT}`, locked: true })
    const res = await put(`/mcp-connections/mine/o${GRANT}/scope`, { kit: null })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('MCP_SCOPE_LOCKED')
    const del = await app.inject({ method: 'DELETE', url: `/mcp-connections/mine/o${GRANT}/scope` })
    expect(del.statusCode).toBe(403)
  })

  it('must be signed in as themselves', async () => {
    state.method = 'api_key'
    expect((await put(`/mcp-connections/mine/o${GRANT}/scope`, { kit: 'buyer' })).statusCode).toBe(
      403
    )
  })

  it('refuses a kit that does not exist', async () => {
    const res = await put(`/mcp-connections/mine/o${GRANT}/scope`, { kit: 'nope' })
    expect(res.statusCode).toBe(400)
  })
})

describe('administrators', () => {
  it('lock a limit on anyone’s connection', async () => {
    state.admin = true
    const res = await put(`/mcp-connections/o${OTHER}/scope`, {
      collections: ['projects'],
      actions: ['read'],
      locked: true,
      note: 'pilot'
    })
    expect(res.statusCode).toBe(200)
    expect(state.writes[0]).toMatchObject({
      conn: `o${OTHER}`,
      patch: { collections: ['projects'], actions: ['read'], locked: true, note: 'pilot' }
    })
  })

  it('refuse a connection that does not exist, and non-admins', async () => {
    state.admin = true
    expect((await put('/mcp-connections/k99/scope', { kit: 'buyer' })).statusCode).toBe(404)
    state.admin = false
    expect((await put(`/mcp-connections/o${GRANT}/scope`, { kit: 'buyer' })).statusCode).toBe(403)
  })

  it('cannot remove a kit in use or a built-in one', async () => {
    state.admin = true
    const used = await app.inject({ method: 'DELETE', url: '/mcp-connections/kits/finance' })
    expect(used.statusCode).toBe(409)
    expect(used.json().code).toBe('KIT_IN_USE')
    const builtin = await app.inject({ method: 'DELETE', url: '/mcp-connections/kits/buyer' })
    expect(builtin.statusCode).toBe(400)
  })

  it('add a kit with a fresh key only', async () => {
    state.admin = true
    const dup = await app.inject({
      method: 'POST',
      url: '/mcp-connections/kits',
      payload: { key: 'finance', label: 'Finance 2', tools: ['search'] }
    })
    expect(dup.statusCode).toBe(409)
    const ok = await app.inject({
      method: 'POST',
      url: '/mcp-connections/kits',
      payload: { key: 'support', label: 'Support', tools: ['support_tickets', 'search'] }
    })
    expect(ok.statusCode).toBe(200)
  })
})

describe('catalog', () => {
  it('answers the tools, kits and actions', async () => {
    const res = await app.inject({ method: 'GET', url: '/mcp-connections/catalog' })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.tools[0].name).toBe('search')
    expect(d.kits.map((k: { key: string }) => k.key)).toEqual(['buyer', 'ops', 'admin', 'finance'])
    expect(d.actions).toEqual(['read', 'create', 'update', 'delete'])
  })
})
