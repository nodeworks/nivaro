import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #2492: a chat message an AI assistant posts through MCP names the connected
// app — `via_app` where migration 478 has run, the sender name otherwise — and
// nothing else (the browser, flows) is ever labelled.

const state = vi.hoisted(() => ({
  hasViaApp: true,
  req: {} as Record<string, unknown>,
  inserts: [] as Array<Record<string, unknown>>
}))

function builder(table: string) {
  let insert: Record<string, unknown> | null = null
  let first = false
  const settle = () => {
    if (insert) {
      state.inserts.push({ table, ...insert })
      return [{ id: 41 }]
    }
    return first ? undefined : []
  }
  const b: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(settle()).then(res, rej)
        if (prop === 'catch')
          return (fn: (e: unknown) => unknown) => Promise.resolve(settle()).catch(fn)
        if (prop === 'first')
          return () => {
            first = true
            return b
          }
        if (prop === 'insert')
          return (row: Record<string, unknown>) => {
            insert = row
            return b
          }
        return () => b
      }
    }
  )
  return b
}

vi.mock('../../../db/index.js', () => ({ db: vi.fn((t: string) => builder(String(t))) }))
vi.mock('../../../lib/column-probe.js', () => ({
  hasColumn: vi.fn(async (_t: string, c: string) => (c === 'via_app' ? state.hasViaApp : true))
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: Record<string, unknown>) => {
    Object.assign(req, { user: { id: 'U1', first_name: 'Pat', last_name: 'Lee' } }, state.req)
  },
  requireAdmin: async () => undefined
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn(async () => {}) }))
vi.mock('../../../services/chat-semantic.js', () => ({
  indexChatMessage: vi.fn(async () => {}),
  dropEmbedding: vi.fn(),
  searchByMeaning: vi.fn()
}))
vi.mock('../../../services/chat.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/chat.js')>()),
  canSeeRoom: vi.fn(async () => true),
  channels: vi.fn(async () => new Map()),
  generalChannel: vi.fn(async () => undefined)
}))

const { chatRoutes } = await import('../../../routes/chat.js')

async function post(headers: Record<string, string> = {}) {
  const app = Fastify()
  await app.register(chatRoutes, { prefix: '/api/chat' })
  const res = await app.inject({
    method: 'POST',
    url: '/api/chat/messages',
    headers,
    payload: { room: 'ch:team', message: 'Status: green' }
  })
  await app.close()
  return res
}

const lastInsert = () => state.inserts.filter((i) => i.table === 'chat_messages').at(-1)

beforeEach(() => {
  state.inserts.length = 0
  state.hasViaApp = true
  state.req = {}
})

describe('chat messages posted through MCP (#2492)', () => {
  it('an OAuth connection labels the message with the app name', async () => {
    state.req = { authMethod: 'oauth', mcpInner: true, oauthClientName: 'Claude' }
    const res = await post()
    expect(res.statusCode).toBe(201)
    expect(lastInsert()).toMatchObject({ sender_name: 'Pat Lee', via_app: 'Claude' })
    expect(res.json().data.via_app).toBe('Claude')
  })

  it('an API key over the stdio server labels it with the key name', async () => {
    state.req = { authMethod: 'api_key', apiKeyName: 'Rob laptop Claude Code' }
    await post({ 'x-nivaro-app': 'mcp' })
    expect(lastInsert()?.via_app).toBe('Rob laptop Claude Code')
  })

  it('the browser and other API callers are never labelled', async () => {
    state.req = { authMethod: 'session' }
    await post()
    expect(lastInsert()?.via_app).toBeUndefined()
    state.req = { authMethod: 'api_key', apiKeyName: 'ERP sync' }
    const res = await post()
    expect(lastInsert()?.via_app).toBeUndefined()
    expect(res.json().data.via_app).toBeNull()
  })

  it('before migration 478 the label rides the sender name', async () => {
    state.hasViaApp = false
    state.req = { authMethod: 'oauth', mcpInner: true, oauthClientName: 'ChatGPT' }
    await post()
    expect(lastInsert()).toMatchObject({ sender_name: 'Pat Lee (via ChatGPT)' })
    expect(lastInsert()?.via_app).toBeUndefined()
  })
})
