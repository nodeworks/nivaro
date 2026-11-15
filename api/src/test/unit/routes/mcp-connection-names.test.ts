import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// rt8 #21 — the name an agent goes by: its owner or an administrator sets it.

const GRANT = '0b6a6f0e-3f6c-4d8e-9b1a-2c3d4e5f6a7b'
const OTHER = '1c7b7f1f-4f7d-4e9f-8c2b-3d4e5f6a7b8c'
const MISSING = '2d8c8a2a-5a8e-4fa0-9d3c-4e5f6a7b8c9d'

const state = vi.hoisted(() => ({
  admin: false,
  names: {} as Record<string, string>,
  writes: [] as unknown[],
  // Active people's display names / e-mails in the directory (lower-cased).
  people: new Set<string>(['beth ortiz', 'beth@example.test'])
}))
vi.mock('../../../services/agent-name-guard.js', async (orig) => {
  const real = await orig<typeof import('../../../services/agent-name-guard.js')>()
  return {
    ...real,
    agentNameRefusal: (name: string) =>
      real.agentNameRefusal(name, {
        isPersonName: async (n: string) => state.people.has(n.trim().toLowerCase())
      })
  }
})

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: async (req: { user?: unknown }) => {
    req.user = { id: 'U1' }
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
vi.mock('../../../db/index.js', () => ({
  // Every API key in this test belongs to U2.
  db: vi.fn(() => ({ where: () => ({ first: async () => ({ user: 'U2' }) }) }))
}))
vi.mock('../../../services/oauth-store.js', () => ({
  listGrants: vi.fn(async () => []),
  getGrant: vi.fn(async (_r: unknown, id: string) =>
    id === GRANT ? { id, user_id: 'u1' } : id === OTHER ? { id, user_id: 'U9' } : null
  ),
  revokeGrant: vi.fn(async () => false)
}))
vi.mock('../../../services/mcp-calls.js', async (orig) => {
  const real = await orig<typeof import('../../../services/mcp-calls.js')>()
  return {
    ...real,
    readMcpSettings: vi.fn(async () => real.MCP_SETTINGS_DEFAULTS),
    writeMcpSettings: vi.fn(async (patch: unknown) => {
      state.writes.push(patch)
      const next = real.mergeMcpSettings(
        { ...real.MCP_SETTINGS_DEFAULTS, connection_names: state.names },
        patch
      )
      state.names = next.connection_names
      return next
    })
  }
})

const { mcpConnectionRoutes } = await import('../../../routes/mcp-connections.js')

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  app.decorate('redis', {} as never)
  await app.register(mcpConnectionRoutes, { prefix: '/mcp-connections' })
  await app.ready()
})
afterAll(() => app.close())
beforeEach(() => {
  state.admin = false
  state.names = {}
  state.writes = []
})

const rename = (url: string, name: unknown) =>
  app.inject({ method: 'PATCH', url, payload: { name } })

describe('agent names', () => {
  it('lets the owner name their own connection, as plain text', async () => {
    const res = await rename(`/mcp-connections/mine/o${GRANT}/name`, '  Claude <b>Desk</b>  ')
    expect(res.statusCode).toBe(200)
    expect(res.json().data.custom_name).toBe('Claude bDesk/b')
    expect(state.names[`o${GRANT}`]).toBe('Claude bDesk/b')
  })

  it('never renames someone else’s connection, and answers not found alike', async () => {
    expect((await rename(`/mcp-connections/mine/o${OTHER}/name`, 'Mine now')).statusCode).toBe(404)
    expect((await rename('/mcp-connections/mine/k7/name', 'Mine now')).statusCode).toBe(404)
    expect((await rename(`/mcp-connections/mine/o${MISSING}/name`, 'x1')).statusCode).toBe(404)
    expect((await rename(`/mcp-connections/mine/u${OTHER}/name`, 'x1')).statusCode).toBe(404)
    expect(state.writes).toEqual([])
  })

  it('clears back to the app’s own name', async () => {
    state.names = { [`o${GRANT}`]: 'Old' }
    const res = await rename(`/mcp-connections/mine/o${GRANT}/name`, null)
    expect(res.statusCode).toBe(200)
    expect(res.json().data.custom_name).toBeNull()
    expect(state.names[`o${GRANT}`]).toBeUndefined()
  })

  it('refuses names that are too long, unreadable or not text', async () => {
    const url = `/mcp-connections/mine/o${GRANT}/name`
    expect((await rename(url, 'x'.repeat(201))).statusCode).toBe(400)
    expect((await rename(url, '<<>>')).statusCode).toBe(400)
    expect((await rename(url, 5)).statusCode).toBe(400)
    expect((await rename('/mcp-connections/mine/nope/name', 'x')).statusCode).toBe(400)
  })

  it('lets an administrator name anyone’s connection, API keys included', async () => {
    expect((await rename('/mcp-connections/k7/name', 'Ops bot')).statusCode).toBe(403)
    state.admin = true
    const res = await rename('/mcp-connections/k7/name', 'Ops bot')
    expect(res.statusCode).toBe(200)
    expect(state.names.k7).toBe('Ops bot')
    expect((await rename(`/mcp-connections/o${OTHER}/name`, 'Beth’s Claude')).statusCode).toBe(200)
    expect((await rename(`/mcp-connections/o${MISSING}/name`, 'Gone')).statusCode).toBe(404)
  })
})

describe('names that pass for a person or the system (security review 2026-11-15)', () => {
  const url = `/mcp-connections/mine/o${GRANT}/name`
  it('refuses an active person’s display name or e-mail, any case', async () => {
    for (const n of ['Beth Ortiz', 'BETH ORTIZ', 'beth@example.test']) {
      const res = await rename(url, n)
      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('AGENT_NAME_REFUSED')
    }
    expect(state.writes).toEqual([])
  })

  it('refuses reserved words, as a whole word anywhere in the name', async () => {
    for (const n of ['Administrator', 'System', 'nivaro', 'Support bot', 'Service-Desk']) {
      expect((await rename(url, n)).statusCode).toBe(400)
    }
    expect((await rename(url, 'Supporter')).statusCode).toBe(200)
  })

  it('applies the same rule to names set in the admin settings', async () => {
    state.admin = true
    const res = await app.inject({
      method: 'PATCH',
      url: '/mcp-connections/settings',
      payload: { connection_names: { k7: 'Beth Ortiz' } }
    })
    expect(res.statusCode).toBe(400)
    expect(state.writes).toEqual([])
  })
})
