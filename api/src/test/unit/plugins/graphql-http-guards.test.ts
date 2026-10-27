import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ tenant: '', builds: 0, signedIn: false }))

vi.mock('../../../services/schema-builder.js', async () => {
  const g = await import('graphql')
  return {
    buildGraphQLSchema: async () => {
      state.builds++
      const built = `${state.tenant || 'self'}#${state.builds}`
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
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    if (state.signedIn) {
      req.user = { id: 'U1', role: 'R' }
      req.isAdmin = true
    }
  })
}))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://admin.example.test' }))

import { graphqlPlugin } from '../../../plugins/graphql.js'

let app: FastifyInstance

beforeEach(async () => {
  state.tenant = ''
  state.builds = 0
  state.signedIn = false
  app = Fastify()
  app.decorate('redis', {} as never)
  await app.register(graphqlPlugin, { prefix: '/api' })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const post = (query: string) =>
  app.inject({ method: 'POST', url: '/api/graphql', payload: { query } })

describe('GraphQL HTTP guards', () => {
  it('refuses introspection to an anonymous caller (M8)', async () => {
    const res = await post('{ __schema { types { name } } }')
    const body = res.json() as { errors?: Array<{ message: string }>; data?: unknown }
    expect(body.data).toBeUndefined()
    expect(body.errors?.[0]?.message).toMatch(/introspection/i)
  })

  it('allows introspection for a signed-in caller', async () => {
    state.signedIn = true
    const res = await post('{ __schema { queryType { name } } }')
    expect(res.json()).toEqual({ data: { __schema: { queryType: { name: 'Query' } } } })
  })

  it('sends GET /api/graphql to the admin bundled explorer instead of CDN scripts (M22)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/graphql' })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('https://admin.example.test/graphql')
    expect(res.body).not.toContain('esm.sh')
  })

  it('builds and serves one schema per tenant (H15)', async () => {
    state.signedIn = true
    state.tenant = 'A'
    const a = (await post('{ built }')).json() as { data: { built: string } }
    state.tenant = 'B'
    const b = (await post('{ built }')).json() as { data: { built: string } }
    state.tenant = 'A'
    const a2 = (await post('{ built }')).json() as { data: { built: string } }
    expect(a.data.built.startsWith('A#')).toBe(true)
    expect(b.data.built.startsWith('B#')).toBe(true)
    expect(a2.data.built).toBe(a.data.built)
  })

  it('a rebuild replaces only the caller tenant schema (H15)', async () => {
    state.signedIn = true
    state.tenant = 'A'
    const a = (await post('{ built }')).json() as { data: { built: string } }
    state.tenant = 'B'
    const b = (await post('{ built }')).json() as { data: { built: string } }
    await app.inject({ method: 'POST', url: '/api/graphql/rebuild' })
    const b2 = (await post('{ built }')).json() as { data: { built: string } }
    state.tenant = 'A'
    const a2 = (await post('{ built }')).json() as { data: { built: string } }
    expect(b2.data.built).not.toBe(b.data.built)
    expect(a2.data.built).toBe(a.data.built)
  })
})
