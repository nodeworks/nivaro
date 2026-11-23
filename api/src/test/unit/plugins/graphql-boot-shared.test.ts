import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The startup schema build reads the collections of the one database. A Hub shared deployment
// has none outside an app (boot logged "Cannot read properties of undefined (reading 'map')"
// from listCollections): it skips the build there, and each app's schema is built on its first
// GraphQL request, inside the app, as before.

const state = vi.hoisted(() => ({ tenant: '', builds: [] as string[] }))

vi.mock('../../../services/schema-builder.js', async () => {
  const g = await import('graphql')
  return {
    buildGraphQLSchema: async () => {
      state.builds.push(state.tenant)
      const built = `${state.tenant || 'self'}#${state.builds.length}`
      return new g.GraphQLSchema({
        query: new g.GraphQLObjectType({
          name: 'Query',
          fields: { built: { type: g.GraphQLString, resolve: () => built } }
        })
      })
    }
  }
})
vi.mock('../../../services/api-changelog.js', () => ({ recordGraphQLSchema: vi.fn() }))
vi.mock('../../../services/tenant-rooms.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/tenant-rooms.js')>()),
  currentTenantKey: () => state.tenant
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {})
}))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://admin.example.test' }))

const SHARED: Record<string, string> = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(32)
}
const KEYS = ['CLOUD_META_DB_URL', 'HUB_SHARED_DEPLOYMENT', 'HUB_URL', 'HUB_DEPLOYMENT_TOKEN']
const saved = { ...process.env }
function useEnv(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, env)
}

let app: FastifyInstance | null = null
const settle = () => new Promise((r) => setTimeout(r, 20))

async function boot() {
  // A fresh module each time: the built schemas are cached per app key in module state.
  vi.resetModules()
  const { graphqlPlugin } = await import('../../../plugins/graphql.js')
  app = Fastify()
  app.decorate('redis', {} as never)
  await app.register(graphqlPlugin, { prefix: '/api' })
  await app.ready()
  await settle()
  return app
}

beforeEach(() => {
  state.tenant = ''
  state.builds = []
})
afterEach(async () => {
  await app?.close()
  app = null
  process.env = { ...saved }
})

describe('GraphQL schema build at startup', () => {
  it('self-hosted: builds the one schema at startup, as before', async () => {
    useEnv({})
    await boot()
    expect(state.builds).toEqual([''])
  })

  it('shared: no build outside an app at startup; an app builds its own on first request', async () => {
    useEnv(SHARED)
    const a = await boot()
    expect(state.builds).toEqual([])
    state.tenant = 'A'
    const res = await a.inject({
      method: 'POST',
      url: '/api/graphql',
      payload: { query: '{ built }' }
    })
    expect(res.json()).toEqual({ data: { built: 'A#1' } })
    expect(state.builds).toEqual(['A'])
  })
})
