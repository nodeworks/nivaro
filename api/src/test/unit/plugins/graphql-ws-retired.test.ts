import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'

// Nivaro Hub phase 6 Task 9 fix round 1 (ruling M17): the raw /api/graphql-ws upgrade bypasses
// every Fastify hook, so a retired app refuses it there, and closes the connections already open.

vi.mock('../../../services/schema-builder.js', async () => {
  const g = await import('graphql')
  return {
    buildGraphQLSchema: async () =>
      new g.GraphQLSchema({
        query: new g.GraphQLObjectType({
          name: 'Query',
          fields: { hello: { type: g.GraphQLString, resolve: () => 'hi' } }
        })
      })
  }
})
vi.mock('../../../services/api-changelog.js', () => ({ recordGraphQLSchema: vi.fn() }))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://admin.example.test' }))

const { graphqlPlugin } = await import('../../../plugins/graphql.js')
const retire = await import('../../../services/hub-link/retire.js')

let app: FastifyInstance | null = null
let port = 0

const store = new Map<string, string>()
const redis = {
  get: async (k: string) => store.get(k) ?? null,
  set: async (k: string, v: string) => {
    store.set(k, v)
    return 'OK'
  },
  del: async (k: string) => (store.delete(k) ? 1 : 0)
}

beforeEach(async () => {
  store.clear()
  retire._resetRetiredForTests('no')
  process.env.HUB_TOKEN = 'g'.repeat(40)
  app = Fastify()
  app.decorate('redis', {} as never)
  await app.register(graphqlPlugin, { prefix: '/api' })
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as { port: number }).port
  await retire.startRetiredWatch(redis as never)
})

afterEach(async () => {
  retire._resetRetiredForTests('no')
  await app?.close()
  app = null
})

function open(): Promise<{ ws: WebSocket; error?: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/graphql-ws`, 'graphql-transport-ws')
    ws.once('open', () => resolve({ ws }))
    ws.once('error', (e) => resolve({ ws, error: String(e.message) }))
  })
}

describe('graphql-ws on a retired app', () => {
  it('accepts an upgrade before retire, refuses it after, and closes the open one', async () => {
    const first = await open()
    expect(first.error).toBeUndefined()
    const closed = new Promise<void>((r) => first.ws.once('close', () => r()))
    await retire.setRetired({ move_id: 3 })
    await closed
    const second = await open()
    expect(second.error).toMatch(/503/)
    await retire.setRetired(null)
    const third = await open()
    expect(third.error).toBeUndefined()
    third.ws.close()
  })
})
