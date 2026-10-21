import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

process.env.MCP_PUBLIC_URL = 'https://nivaro.example'

// Two people: a fixed token each.
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: {
    headers: Record<string, string>
    user?: unknown
    isAdmin?: boolean
  }) => {
    const who = { 'Bearer pat-token': 'U1', 'Bearer sam-token': 'U2' }[req.headers.authorization]
    if (!who) throw Object.assign(new Error('Invalid token'), { statusCode: 401 })
    req.user = { id: who }
    req.isAdmin = false
  },
  requireAuth: async () => {}
}))

const { mcpRoutes } = await import('../../../routes/mcp.js')
const { notifyJournalListeners } = await import('../../../services/journal-listeners.js')

let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  await app.register(
    async (api) => {
      await api.register(mcpRoutes)
      api.get('/auth/me', async () => ({ data: { id: 'U1' } }))
      // Record 7 is readable; anything else is not.
      api.get('/items/:collection/:id', async (req, reply) => {
        const { id } = req.params as { id: string }
        if (id !== '7') return reply.code(404).send({ error: 'Not found' })
        return { data: { id: 7 } }
      })
    },
    { prefix: '/api' }
  )
  await app.ready()
})
afterAll(() => app.close())

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '1' }
  }
}

const rpc = (body: unknown, opts: { url?: string; session?: string; auth?: string } = {}) =>
  app.inject({
    method: 'POST',
    url: opts.url ?? '/api/mcp?live=1',
    headers: {
      authorization: opts.auth ?? 'Bearer pat-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(opts.session ? { 'mcp-session-id': opts.session } : {})
    },
    payload: JSON.stringify(body)
  })

async function liveSession(): Promise<string> {
  const init = await rpc(INIT)
  expect(init.statusCode).toBe(200)
  const sid = init.headers['mcp-session-id']
  expect(typeof sid).toBe('string')
  return String(sid)
}

describe('/api/mcp live sessions (#2467)', () => {
  it('stays stateless without ?live=1', async () => {
    const init = await rpc(INIT, { url: '/api/mcp' })
    expect(init.statusCode).toBe(200)
    expect(init.headers['mcp-session-id']).toBeUndefined()
    expect(init.json().result.capabilities.resources.subscribe).toBeUndefined()
    const sub = await rpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/subscribe',
        params: { uri: 'nivaro://record/articles/7' }
      },
      { url: '/api/mcp' }
    )
    expect(sub.json().error).toBeTruthy()
  })

  it('hands out a session and advertises subscriptions', async () => {
    const init = await rpc(INIT)
    expect(init.headers['mcp-session-id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(init.json().result.capabilities.resources.subscribe).toBe(true)
  })

  it('subscribes to a readable record and refuses one the caller cannot read', async () => {
    const sid = await liveSession()
    const ok = await rpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/subscribe',
        params: { uri: 'nivaro://record/articles/7' }
      },
      { session: sid }
    )
    expect(ok.json().result).toEqual({})
    const no = await rpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/subscribe',
        params: { uri: 'nivaro://record/articles/9' }
      },
      { session: sid }
    )
    expect(no.json().error.message).toContain('cannot read it')
  })

  it("treats another person's session id as not found", async () => {
    const sid = await liveSession()
    const res = await rpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { session: sid, auth: 'Bearer sam-token' }
    )
    expect(res.statusCode).toBe(404)
    const stream = await app.inject({
      method: 'GET',
      url: '/api/mcp',
      headers: {
        authorization: 'Bearer sam-token',
        accept: 'text/event-stream',
        'mcp-session-id': sid
      }
    })
    expect(stream.statusCode).toBe(404)
  })

  it('streams notices for the followed record and ends with the session', async () => {
    const sid = await liveSession()
    await rpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/subscribe',
        params: { uri: 'nivaro://record/articles/7' }
      },
      { session: sid }
    )
    const streaming = app.inject({
      method: 'GET',
      url: '/api/mcp?live=1',
      headers: {
        authorization: 'Bearer pat-token',
        accept: 'text/event-stream',
        'mcp-session-id': sid
      }
    })
    await new Promise((r) => setTimeout(r, 50))
    notifyJournalListeners({
      seq: 5,
      room: 'collection:articles',
      event: 'collection:update',
      payload: { collection: 'articles', item: '7', action: 'update', changed_fields: ['title'] }
    })
    await new Promise((r) => setTimeout(r, 400))
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/mcp?live=1',
      headers: { authorization: 'Bearer pat-token', 'mcp-session-id': sid }
    })
    expect(del.statusCode).toBe(204)
    const res = await streaming
    expect(res.headers['content-type']).toBe('text/event-stream')
    const data = res.body
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice(6)))
    expect(data).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/resources/updated',
        params: {
          uri: 'nivaro://record/articles/7',
          _meta: { 'nivaro.dev/changed_fields': ['title'], 'nivaro.dev/action': 'update' }
        }
      }
    ])
    // The session is gone.
    const after = await rpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { session: sid, url: '/api/mcp' }
    )
    expect(after.statusCode).toBe(200) // a stateless client never had one: served stateless
  })

  it('answers 405 to GET and DELETE without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/mcp' })).statusCode).toBe(405)
    expect((await app.inject({ method: 'DELETE', url: '/api/mcp' })).statusCode).toBe(405)
  })
})
