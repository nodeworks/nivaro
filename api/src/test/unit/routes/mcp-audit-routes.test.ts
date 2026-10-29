import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Who may apply what an agent proposed or roll back what it wrote (#3209, #3219): only a person
 * signed in with a session — never an API key, an OAuth connection or the MCP endpoint's own
 * in-process calls.
 */
const state = vi.hoisted(() => ({ admin: true, method: 'session', inner: false }))

vi.mock('../../../middleware/authenticate.js', () => {
  const sign = (req: Record<string, unknown>) => {
    req.user = { id: 'a1b2c3d4-0000-4000-8000-000000000001' }
    req.isAdmin = state.admin
    req.authMethod = state.method
    req.mcpInner = state.inner
  }
  return {
    requireAuth: async (req: Record<string, unknown>) => sign(req),
    requireAdmin: async (req: Record<string, unknown>) => {
      if (!state.admin) throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
      sign(req)
    }
  }
})
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/oauth-store.js', () => ({ getClient: vi.fn(async () => null) }))
vi.mock('../../../routes/mcp.js', () => ({ injectFetch: vi.fn() }))
const h = vi.hoisted(() => ({
  planRollback: vi.fn(async () => ({ plan: { actions: [], plan_hash: 'a'.repeat(32) } })),
  applyRollback: vi.fn(async () => ({ done: 0, failed: [], skipped: 0, acted_as: 'owner' })),
  readSchemaProposal: vi.fn(async () => null),
  createSchemaProposal: vi.fn(async () => ({ id: 'p1', sentences: ['Add field'] }))
}))
vi.mock('../../../services/mcp-rollback.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/mcp-rollback.js')>()),
  planRollback: h.planRollback,
  applyRollback: h.applyRollback
}))
vi.mock('../../../services/schema-proposals.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/schema-proposals.js')>()),
  readSchemaProposal: h.readSchemaProposal,
  createSchemaProposal: h.createSchemaProposal
}))

const { mcpRollbackRoutes } = await import('../../../routes/mcp-rollback.js')
const { schemaProposalRoutes } = await import('../../../routes/schema-proposals.js')

let app: FastifyInstance
beforeAll(async () => {
  app = Fastify()
  app.decorate('redis', {} as never)
  await app.register(mcpRollbackRoutes, { prefix: '/mcp-connections' })
  await app.register(schemaProposalRoutes, { prefix: '/schema-proposals' })
  await app.ready()
})
afterAll(() => app.close())
beforeEach(() => {
  state.admin = true
  state.method = 'session'
  state.inner = false
  for (const f of Object.values(h)) f.mockClear()
})

const P = '0b6a6f0e-3f6c-4d8e-9b1a-2c3d4e5f6a7b'
const window = { from: new Date(Date.now() - 3_600_000).toISOString() }

describe('rollback routes (#3219)', () => {
  it('previews the person’s own connection as them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp-connections/mine/k7/rollback/preview',
      payload: window
    })
    expect(res.statusCode).toBe(200)
    expect(h.planRollback).toHaveBeenCalledWith(
      expect.objectContaining({ conn: 'k7', ownerId: 'a1b2c3d4-0000-4000-8000-000000000001' })
    )
  })

  it('refuses a bad connection key and a missing plan hash', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/mcp-connections/mine/zz/rollback/preview',
      payload: window
    })
    expect(bad.statusCode).toBe(400)
    const noHash = await app.inject({
      method: 'POST',
      url: '/mcp-connections/k7/rollback',
      payload: window
    })
    expect(noHash.statusCode).toBe(400)
  })

  it.each([
    ['an API key', 'api_key', false],
    ['an OAuth connection', 'oauth', false],
    ['the MCP endpoint', 'session', true]
  ])('never applies through %s', async (_n, method, inner) => {
    state.method = method
    state.inner = inner
    const res = await app.inject({
      method: 'POST',
      url: '/mcp-connections/k7/rollback',
      payload: { ...window, plan_hash: 'a'.repeat(32) }
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('SESSION_REQUIRED')
    expect(h.applyRollback).not.toHaveBeenCalled()
  })

  it('applies for a signed-in administrator', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp-connections/k7/rollback',
      payload: { ...window, plan_hash: 'a'.repeat(32) }
    })
    expect(res.statusCode).toBe(200)
    expect(h.applyRollback).toHaveBeenCalledWith(
      expect.objectContaining({ conn: 'k7', ownerId: null, callerIsAdmin: true })
    )
  })
})

describe('schema proposal routes (#3209)', () => {
  it('anyone signed in proposes, through any credential', async () => {
    state.admin = false
    state.method = 'oauth'
    const res = await app.inject({
      method: 'POST',
      url: '/schema-proposals',
      payload: { changes: [{ kind: 'add_field', collection: 'work_orders', field: 'x' }] }
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().data).toMatchObject({ id: 'p1', status: 'proposed' })
  })

  it.each([
    ['apply', 'api_key', false],
    ['apply', 'oauth', false],
    ['reject', 'session', true]
  ])('refuses %s through anything but a person’s session', async (verb, method, inner) => {
    state.method = method
    state.inner = inner
    const res = await app.inject({ method: 'POST', url: `/schema-proposals/${P}/${verb}` })
    expect(res.statusCode).toBe(403)
    expect(h.readSchemaProposal).not.toHaveBeenCalled()
  })

  it('apply and reject are for administrators', async () => {
    state.admin = false
    const res = await app.inject({ method: 'POST', url: `/schema-proposals/${P}/apply` })
    expect(res.statusCode).toBe(403)
  })

  it('a missing proposal is 404', async () => {
    const res = await app.inject({ method: 'POST', url: `/schema-proposals/${P}/apply` })
    expect(res.statusCode).toBe(404)
  })
})
