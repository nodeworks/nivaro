import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

process.env.MCP_PUBLIC_URL = 'https://nivaro.example'

// The endpoint authenticates like any route; here a fixed token stands for a person.
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: {
    headers: Record<string, string>
    user?: unknown
    isAdmin?: boolean
  }) => {
    if (req.headers.authorization !== 'Bearer good-token') {
      throw Object.assign(new Error('Invalid token'), { statusCode: 401 })
    }
    req.user = { id: 'U1' }
    req.isAdmin = false
  }
}))

// No database here: named instance tools (migration 473) read as "not there yet".
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => false }))

const { mcpRoutes } = await import('../../../routes/mcp.js')

let app: FastifyInstance
const seen: string[] = []

beforeAll(async () => {
  app = Fastify()
  await app.register(
    async (api) => {
      await api.register(mcpRoutes)
      // What whoami reads — answered in-process, as the caller.
      api.get('/auth/me', async (req) => {
        seen.push(String(req.headers.authorization))
        return { data: { id: 'U1', email: 'pat@example.com', first_name: 'Pat', role: null } }
      })
    },
    { prefix: '/api' }
  )
  await app.ready()
})
afterAll(() => app.close())

const rpc = (body: unknown, auth = 'Bearer good-token') =>
  app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: {
      authorization: auth,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    payload: JSON.stringify(body)
  })

describe('POST /api/mcp', () => {
  it('challenges an anonymous client towards the OAuth metadata', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/mcp', payload: {} })
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBe(
      'Bearer resource_metadata="https://nivaro.example/.well-known/oauth-protected-resource"'
    )
  })

  it('marks a bad token invalid_token', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer nope')
    expect(res.statusCode).toBe(401)
    expect(String(res.headers['www-authenticate'])).toContain('error="invalid_token"')
  })

  it('initializes, lists tools and runs one as the caller', async () => {
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' }
      }
    })
    expect(init.statusCode).toBe(200)
    expect(init.json().result.serverInfo.name).toBe('nivaro')

    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = (list.json().result.tools as Array<{ name: string }>).map((t) => t.name)
    expect(names).toContain('whoami')
    expect(names).toContain('read_items')

    const call = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} }
    })
    expect(call.statusCode).toBe(200)
    expect(JSON.stringify(call.json().result)).toContain('pat@example.com')
    // The tool call reached the API with the caller's own credential.
    expect(seen.at(-1)).toBe('Bearer good-token')
  })

  it('has no standalone stream (stateless)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/mcp' })
    expect(res.statusCode).toBe(405)
  })
})
