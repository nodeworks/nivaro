import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

process.env.MCP_PUBLIC_URL = 'https://nivaro.example'

// A fixed token stands for a person; requireAdmin is never reached here.
vi.mock('../../../middleware/authenticate.js', () => {
  const authenticate = async (req: {
    headers: Record<string, string>
    user?: unknown
    isAdmin?: boolean
  }) => {
    if (req.headers.authorization !== 'Bearer good-token') {
      throw Object.assign(new Error('Invalid token'), { statusCode: 401 })
    }
    req.user = { id: 'U1', email: 'pat@example.com' }
    req.isAdmin = false
  }
  // The per-connection tool-call limit (#2469) never trips here.
  return {
    authenticate,
    requireAdmin: authenticate,
    requireAuth: authenticate,
    enforceRateLimit: async () => {}
  }
})
vi.mock('../../../services/mcp-calls.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/mcp-calls.js')>()),
  readMcpSettings: async () => ({
    idle_flag_days: 60,
    idle_revoke_days: 90,
    rate_limit_per_minute: 120,
    connection_limits: {}
  })
}))
// No database here: named tools (migration 473) read as "not there yet".
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => false }))

const { mcpRoutes } = await import('../../../routes/mcp.js')
const { mcpToolRoutes } = await import('../../../routes/mcp-tools.js')
const tools = await import('../../../services/extension-tools.js')

let app: FastifyInstance
const handler = vi.fn(async (caller: { id: string }, input: Record<string, unknown>) => ({
  caller: caller.id,
  echoed: input.note
}))

beforeAll(async () => {
  tools._setExtensionToolsEnabledCheck(async () => true)
  tools.registerExtensionTool('mcp', 'crm', [
    'log_call',
    {
      type: 'object',
      properties: { note: { type: 'string', description: 'What was said' } },
      required: ['note']
    },
    handler,
    { description: 'Log a phone call.' }
  ])
  app = Fastify()
  await app.register(
    async (api) => {
      await api.register(mcpRoutes)
      await api.register(mcpToolRoutes, { prefix: '/mcp-tools' })
    },
    { prefix: '/api' }
  )
  await app.ready()
})
afterAll(async () => {
  tools._resetExtensionTools()
  await app.close()
})

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

describe('extension MCP tools through the hosted endpoint (#2465)', () => {
  it('GET /api/mcp-tools lists the extension tool for a signed-in caller', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/mcp-tools',
      headers: { authorization: 'Bearer good-token' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual([
      expect.objectContaining({
        name: 'log_call',
        source: { kind: 'extension', extension: 'crm' },
        read_only: false
      })
    ])
  })

  it('lists it by name on /api/mcp and runs it as the caller', async () => {
    await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' }
      }
    })
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const listed = (list.json().result.tools as Array<{ name: string }>).map((t) => t.name)
    expect(listed).toContain('log_call')
    expect(listed).toContain('call_instance_tool')

    const call = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'log_call', arguments: { note: 'hello' } }
    })
    expect(call.statusCode).toBe(200)
    expect(JSON.parse(call.json().result.content[0].text)).toEqual({
      caller: 'U1',
      echoed: 'hello'
    })
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'U1' }),
      { note: 'hello' },
      expect.any(Object)
    )
  })

  it('refuses missing input and unknown tools with the right status', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/mcp-tools/log_call/call',
      headers: { authorization: 'Bearer good-token', 'content-type': 'application/json' },
      payload: { input: {} }
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toContain('note')
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/mcp-tools/nope_tool/call',
      headers: { authorization: 'Bearer good-token', 'content-type': 'application/json' },
      payload: { input: {} }
    })
    expect(unknown.statusCode).toBe(404)
  })
})
