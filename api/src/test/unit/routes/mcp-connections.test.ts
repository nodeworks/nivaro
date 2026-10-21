import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ admin: false, revoked: [] as string[] }))

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U1' }
    req.isAdmin = state.admin
  },
  requireAdmin: async (req: { user?: unknown }) => {
    if (!state.admin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    req.user = { id: 'ADMIN' }
  }
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/permission-cache.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/permission-cache.js')>()),
  bumpUserAccessVersion: vi.fn()
}))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/oauth-store.js', () => ({
  listGrants: vi.fn(async () => []),
  getGrant: vi.fn(async () => null),
  revokeGrant: vi.fn(async (_r: unknown, user: string, id: string) => {
    state.revoked.push(`${user}:${id}`)
    return id === '0b6a6f0e-3f6c-4d8e-9b1a-2c3d4e5f6a7b'
  })
}))
vi.mock('../../../services/mcp-activity.js', async (orig) => {
  const real = await orig<typeof import('../../../services/mcp-activity.js')>()
  return {
    ...real,
    listConnections: vi.fn(async () => ({ logged: true, connections: [] })),
    readAgentActivity: vi.fn(async () => ({ logged: true, calls: [], next_before: null })),
    undoAgentWrite: vi.fn(async (_u: unknown, id: number) => {
      if (id === 9) throw new real.AgentUndoError('The record changed after this', 409)
      return { collection: 'projects', item: '1', action: 'update' }
    })
  }
})
vi.mock('../../../services/mcp-calls.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/mcp-calls.js')>()),
  readMcpSettings: vi.fn(async () => ({
    idle_flag_days: 60,
    idle_revoke_days: 90,
    rate_limit_per_minute: 120,
    connection_limits: {}
  }))
}))

const { mcpConnectionRoutes } = await import('../../../routes/mcp-connections.js')

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  app.decorate('redis', {} as never)
  await app.register(mcpConnectionRoutes, { prefix: '/mcp-connections' })
  await app.ready()
})
afterAll(() => app.close())

const GRANT = '0b6a6f0e-3f6c-4d8e-9b1a-2c3d4e5f6a7b'

describe('/mcp-connections', () => {
  it('lists the person’s own connections with the review settings', async () => {
    const res = await app.inject({ method: 'GET', url: '/mcp-connections/mine' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.settings).toEqual({
      idle_flag_days: 60,
      idle_revoke_days: 90,
      rate_limit_per_minute: 120
    })
  })

  it('disconnects only the person’s own sign-in connections', async () => {
    const ok = await app.inject({ method: 'DELETE', url: `/mcp-connections/mine/o${GRANT}` })
    expect(ok.statusCode).toBe(200)
    expect(state.revoked.at(-1)).toBe(`U1:${GRANT}`)
    const key = await app.inject({ method: 'DELETE', url: '/mcp-connections/mine/k3' })
    expect(key.statusCode).toBe(400)
    const bad = await app.inject({ method: 'DELETE', url: '/mcp-connections/mine/zzz' })
    expect(bad.statusCode).toBe(400)
  })

  it('validates the activity filters', async () => {
    const res = await app.inject({ method: 'GET', url: '/mcp-connections/mine/activity?conn=x' })
    expect(res.statusCode).toBe(400)
    const ok = await app.inject({ method: 'GET', url: '/mcp-connections/mine/activity?conn=k3' })
    expect(ok.statusCode).toBe(200)
  })

  it('answers an undo that cannot happen with its reason', async () => {
    const no = await app.inject({ method: 'POST', url: '/mcp-connections/mine/activity/9/undo' })
    expect(no.statusCode).toBe(409)
    expect(no.json().error).toMatch(/changed after/)
    const yes = await app.inject({ method: 'POST', url: '/mcp-connections/mine/activity/8/undo' })
    expect(yes.statusCode).toBe(200)
  })

  it('keeps the across-everyone view and settings for administrators', async () => {
    state.admin = false
    expect((await app.inject({ method: 'GET', url: '/mcp-connections' })).statusCode).toBe(403)
    state.admin = true
    expect((await app.inject({ method: 'GET', url: '/mcp-connections' })).statusCode).toBe(200)
    const bad = await app.inject({
      method: 'PATCH',
      url: '/mcp-connections/nope/limit',
      payload: { rate_limit_per_minute: 5 }
    })
    expect(bad.statusCode).toBe(400)
    state.admin = false
  })
})
