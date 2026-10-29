import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

process.env.MCP_PUBLIC_URL = 'https://nivaro.example'

// The endpoint authenticates like any route; here a fixed token stands for a person.
const costs = vi.hoisted(() => [] as number[])
const fakeAuth = async (req: {
  headers: Record<string, string>
  user?: unknown
  isAdmin?: boolean
  authMethod?: string
  oauthScopes?: string[]
}) => {
  const auth = req.headers.authorization
  if (auth !== 'Bearer good-token' && auth !== 'Bearer chat-token') {
    throw Object.assign(new Error('Invalid token'), { statusCode: 401 })
  }
  req.user = { id: 'U1' }
  req.isAdmin = false
  // chat-token stands for an OAuth connection the person allowed chat for (#2492).
  req.authMethod = 'oauth'
  req.oauthScopes = auth === 'Bearer chat-token' ? ['nivaro', 'chat'] : ['nivaro']
}
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: fakeAuth,
  requireAuth: fakeAuth,
  // The per-connection tool-call limit (#2469): a test header stands for "over the limit".
  enforceRateLimit: async (
    req: { headers: Record<string, string> },
    _reply: unknown,
    opts: { code: string; message: (wait: number) => string; cost?: number }
  ) => {
    costs.push(opts.cost ?? 1)
    if (req.headers['x-test-over-limit'])
      throw Object.assign(new Error(opts.message(12)), {
        statusCode: 429,
        code: opts.code,
        retryAfter: 12
      })
  }
}))
vi.mock('../../../services/mcp-calls.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/mcp-calls.js')>()),
  readMcpSettings: async () => ({
    idle_flag_days: 60,
    idle_revoke_days: 90,
    rate_limit_per_minute: 120,
    connection_limits: {}
  })
}))

// No database here: named instance tools (migration 473) read as "not there yet".
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => false }))

const { mcpRoutes } = await import('../../../routes/mcp.js')

let app: FastifyInstance
const seen: string[] = []
const stamps: unknown[] = []

beforeAll(async () => {
  app = Fastify()
  // What the request logger would write on the POST /api/mcp row.
  app.addHook('onResponse', async (req) => {
    if (req.url === '/api/mcp') stamps.push(req.mcpCall ? { ...req.mcpCall } : null)
  })
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

  it('offers chat tools only to a connection allowed chat (#2492)', async () => {
    const names = async (auth: string) =>
      (
        (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, auth)).json().result
          .tools as Array<{ name: string }>
      ).map((t) => t.name)
    const plain = await names('Bearer good-token')
    expect(plain).toContain('read_dashboard')
    expect(plain).not.toContain('list_chat_rooms')
    expect(plain).not.toContain('post_chat_message')
    const chat = await names('Bearer chat-token')
    expect(chat).toContain('list_chat_rooms')
    expect(chat).toContain('post_chat_message')
  })

  it('answers the stdio server which tool sets the credential gets', async () => {
    const res = await app.inject({
      url: '/api/mcp/capabilities',
      headers: { authorization: 'Bearer chat-token' }
    })
    expect(res.json()).toEqual({ data: { admin_tools: false, chat: 'post', update_preview: true } })
  })

  it('stamps a tool call with its connection, tool, outcome and bytes', async () => {
    stamps.length = 0
    const call = await rpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} }
    })
    expect(call.statusCode).toBe(200)
    expect(stamps.at(-1)).toEqual({
      conn: 'uu1',
      client: 'Assistant',
      tool: 'whoami',
      outcome: 'ok',
      bytes: call.rawPayload.length
    })
  })

  it('answers a call over the connection limit with a 429 that says why', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: {
        authorization: 'Bearer good-token',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-test-over-limit': '1'
      },
      payload: JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'whoami', arguments: {} }
      })
    })
    expect(res.statusCode).toBe(429)
    const body = res.json()
    expect(body.id).toBe(6)
    expect(body.error.message).toMatch(/120 tool calls a minute.*Wait 12 seconds/)
    expect(body.error.data).toEqual({ code: 'MCP_CONNECTION_RATE_LIMITED', retry_after_s: 12 })
    expect(stamps.at(-1)).toMatchObject({ tool: 'whoami', outcome: 'refused' })
  })

  it('spends one unit per tool call of a batch and refuses the whole POST over the limit', async () => {
    const batch = [
      { jsonrpc: '2.0', id: 7, method: 'tools/list' },
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'Not A Tool!' } }
    ]
    costs.length = 0
    const res = await app.inject({
      method: 'POST',
      url: '/api/mcp',
      headers: {
        authorization: 'Bearer good-token',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-test-over-limit': '1'
      },
      payload: JSON.stringify(batch)
    })
    expect(costs).toEqual([2])
    expect(res.statusCode).toBe(429)
    expect(res.json().id).toBe(8)
  })

  it('counts a tool call whose name the log would not keep', async () => {
    costs.length = 0
    await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'Bad Name' } })
    expect(costs).toEqual([1])
    expect(stamps.at(-1)).toMatchObject({ tool: null })
  })

  it('has no standalone stream (stateless)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/mcp' })
    expect(res.statusCode).toBe(405)
  })
})
