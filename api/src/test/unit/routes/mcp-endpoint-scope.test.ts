import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

process.env.MCP_PUBLIC_URL = 'https://nivaro.example'

const GRANT = '0b6a6f0e-3f6c-4d8e-9b1a-2c3d4e5f6a7b'
const rows = vi.hoisted(() => new Map<string, Record<string, unknown>>())

// The scope table: one OAuth connection limited to whoami + read_items on projects.
vi.mock('../../../lib/column-probe.js', () => ({
  hasColumn: async (table: string) => table === 'nivaro_mcp_connection_scopes'
}))
vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    let conn: string | null = null
    const b = {
      where: (w: { conn?: string }) => {
        conn = w.conn ?? null
        return b
      },
      first: async () =>
        table === 'nivaro_mcp_connection_scopes' && conn ? rows.get(conn) : undefined,
      select: () => b,
      catch: () => Promise.resolve([])
    }
    return b
  }
}))

// authenticate = a fixed OAuth person, then the REAL connection-scope step.
const auth = vi.hoisted(() => ({
  apply: null as null | ((req: FastifyRequest) => Promise<void>)
}))
const fakeAuth = async (req: FastifyRequest) => {
  if (req.headers.authorization !== 'Bearer good-token')
    throw Object.assign(new Error('Invalid token'), { statusCode: 401 })
  req.user = { id: 'U1' } as never
  req.isAdmin = false
  req.authMethod = 'oauth'
  req.oauthGrantId = GRANT
  req.oauthScopes = ['nivaro']
  await auth.apply?.(req)
}
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: fakeAuth,
  requireAuth: fakeAuth,
  enforceRateLimit: async () => {}
}))
vi.mock('../../../services/mcp-calls.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/mcp-calls.js')>()),
  readMcpSettings: async () => ({
    idle_flag_days: 60,
    idle_revoke_days: 90,
    rate_limit_per_minute: 0,
    connection_limits: {}
  })
}))

const { applyMcpConnectionScope } = await import('../../../services/mcp-scope.js')
auth.apply = applyMcpConnectionScope
const { markMcpInnerRequest, MCP_INNER_HEADER, mcpInnerHeaderValue } = await import(
  '../../../services/mcp-config.js'
)
const { mcpRoutes } = await import('../../../routes/mcp.js')

let app: FastifyInstance
const reached: Array<{ path: string; scopes: unknown }> = []

beforeAll(async () => {
  rows.set(`o${GRANT}`, {
    conn: `o${GRANT}`,
    kit: null,
    tools: JSON.stringify(['whoami', 'read_items']),
    collections: JSON.stringify(['projects']),
    actions: JSON.stringify(['read']),
    locked: true,
    note: null,
    user: 'U1',
    updated_by: 'ADMIN',
    updated_at: null
  })
  app = Fastify()
  app.addHook('onRequest', markMcpInnerRequest)
  await app.register(
    async (api) => {
      await api.register(mcpRoutes)
      api.get('/auth/me', { preHandler: fakeAuth }, async (req) => {
        reached.push({ path: '/auth/me', scopes: req.user?.api_key_scopes })
        return { data: { id: 'U1', email: 'pat@example.com', first_name: 'Pat', role: null } }
      })
      api.delete('/items/:collection/:id', { preHandler: fakeAuth }, async (req) => {
        reached.push({ path: req.url, scopes: req.user?.api_key_scopes })
        return { data: null }
      })
    },
    { prefix: '/api' }
  )
  await app.ready()
})
afterAll(() => app.close())

const rpc = (body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: {
      authorization: 'Bearer good-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    payload: JSON.stringify(body)
  })

describe('a scoped connection on /api/mcp (#3205)', () => {
  it('lists only its allowed tools', async () => {
    const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const names = (list.json().result.tools as Array<{ name: string }>).map((t) => t.name).sort()
    expect(names).toEqual(['read_items', 'whoami'])
  })

  it('runs an allowed tool with the narrowed scopes on its inner call', async () => {
    const call = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} }
    })
    expect(JSON.stringify(call.json().result)).toContain('pat@example.com')
    expect(reached.at(-1)).toEqual({
      path: '/auth/me',
      scopes: [
        { collection: 'projects', actions: ['read'] },
        { collection: 'nivaro_users', actions: ['read'] }
      ]
    })
  })

  it('refuses a tool that is not allowed', async () => {
    const call = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'delete_item', arguments: { collection: 'projects', id: '1' } }
    })
    const body = call.json()
    expect(body.error ?? body.result?.isError).toBeTruthy()
    expect(reached.some((r) => r.path.startsWith('/api/items/'))).toBe(false)
  })

  it('refuses a hand-made inner call naming a tool outside the list', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/items/projects/1',
      headers: {
        authorization: 'Bearer good-token',
        [MCP_INNER_HEADER]: mcpInnerHeaderValue(),
        'x-nivaro-mcp-tool': 'delete_item'
      }
    })
    expect(res.statusCode).toBe(403)
    expect(reached.some((r) => r.path.startsWith('/api/items/'))).toBe(false)
  })
})
