import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Maintenance write freeze (2026-11-06 staging rebuild: LinX created workflow
 * 372957 "CR26-1" through POST /graphql while maintenance was on — GraphQL,
 * the legacy paths and extension routes sat outside the hook, and the LinX
 * integration account has the Admin role, which was exempt).
 */

type Caller = {
  isAdmin?: boolean
  authMethod?: string
  masqueradeAdminId?: string
  account_kind?: string | null
}
const state = vi.hoisted(() => ({
  on: true,
  caller: null as null | Caller
}))

vi.mock('../../../services/security.js', () => ({
  maintenanceState: async () => ({
    on: state.on,
    message: 'Down for the upgrade.',
    display: 'page',
    until: null,
    source: 'override'
  }),
  MAINTENANCE_EXPLAINER: 'Changes are paused.',
  MAINTENANCE_DEFAULT_MESSAGE: 'Maintenance.'
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: FastifyRequest) => {
    const c = state.caller
    if (!c) return
    req.user = { id: 'U1', role: 'R', account_kind: c.account_kind ?? null } as never
    req.isAdmin = c.isAdmin ?? false
    req.authMethod = c.authMethod as never
    if (c.masqueradeAdminId) req.masqueradeAdminId = c.masqueradeAdminId
  })
}))

vi.mock('../../../services/schema-builder.js', async () => {
  const g = await import('graphql')
  return {
    buildGraphQLSchema: async () =>
      new g.GraphQLSchema({
        query: new g.GraphQLObjectType({
          name: 'Query',
          fields: { hello: { type: g.GraphQLString, resolve: () => 'hi' } }
        }),
        mutation: new g.GraphQLObjectType({
          name: 'Mutation',
          fields: { create_workflows_item: { type: g.GraphQLString, resolve: () => 'CR26-1' } }
        })
      })
  }
})
vi.mock('../../../services/api-changelog.js', () => ({ recordGraphQLSchema: vi.fn() }))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://admin.example.test' }))

import { graphqlPlugin } from '../../../plugins/graphql.js'
import {
  maintenanceExemptCaller,
  maintenanceExemptPath,
  maintenanceFreezeHook
} from '../../../services/maintenance-freeze.js'

const HUMAN_ADMIN: Caller = { isAdmin: true, authMethod: 'session' }

describe('maintenanceExemptPath', () => {
  it('keeps sign-in, the switch, MCP protocol, presence and GraphQL (judged inside) open', () => {
    for (const p of [
      '/api/auth/login',
      '/api/settings',
      '/api/mcp',
      '/api/mcp?live=1',
      '/api/graphql',
      '/api/graphql/stream',
      '/graphql',
      '/api/presence/ping',
      '/oauth/token',
      '/api/items/batch-read'
    ])
      expect(maintenanceExemptPath(p), p).toBe(true)
  })

  it('freezes record writes on every surface', () => {
    for (const p of [
      '/api/items/workflows',
      '/items/workflows',
      '/files',
      '/api/files',
      '/api/graphql/rebuild',
      '/api/efp/fusion-push/batch',
      '/api/inbound/fusion',
      '/api/mcp/tools'
    ])
      expect(maintenanceExemptPath(p), p).toBe(false)
  })
})

describe('maintenanceExemptCaller', () => {
  const req = (c: Caller & { mcpInner?: boolean }) =>
    ({
      ...c,
      user: { id: 'U', account_kind: c.account_kind ?? null }
    }) as unknown as FastifyRequest

  it('exempts only a person who is an administrator on their own session', () => {
    expect(maintenanceExemptCaller(req(HUMAN_ADMIN))).toBe(true)
  })

  it.each([
    ['non-admin session', { isAdmin: false, authMethod: 'session' }],
    ['admin static token', { isAdmin: true, authMethod: 'token' }],
    ['admin API key', { isAdmin: true, authMethod: 'api_key' }],
    ['connected app', { isAdmin: true, authMethod: 'oauth' }],
    ['phone token', { isAdmin: true, authMethod: 'device' }],
    ['View-as', { isAdmin: true, authMethod: 'masquerade', masqueradeAdminId: 'A' }],
    ['session marked as View-as', { ...HUMAN_ADMIN, masqueradeAdminId: 'A' }],
    ['integration account with Admin role', { ...HUMAN_ADMIN, account_kind: 'integration' }],
    ['service account with Admin role', { ...HUMAN_ADMIN, account_kind: 'service' }],
    ['MCP tool call on an admin session', { ...HUMAN_ADMIN, mcpInner: true }]
  ])('refuses %s', (_label, c) => {
    expect(maintenanceExemptCaller(req(c as Caller))).toBe(false)
  })
})

describe('root freeze hook covers every route plugin', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    state.on = true
    state.caller = null
    app = Fastify()
    app.decorate('redis', {} as never)
    app.addHook('preHandler', maintenanceFreezeHook)
    // the core routes plugin
    await app.register(
      async (f) => {
        f.post('/items/:c', async () => ({ ok: 'core' }))
        f.get('/items/:c', async () => ({ ok: 'read' }))
        f.post('/auth/login', async () => ({ ok: 'auth' }))
      },
      { prefix: '/api' }
    )
    // a sibling plugin (GraphQL lives beside the core routes)
    await app.register(graphqlPlugin, { prefix: '/api' })
    // legacy compat + an extension route, registered later at the root
    await app.register(async (f) => {
      f.post('/files', async () => ({ ok: 'legacy' }))
    })
    await app.register(
      async (f) => {
        f.post('/efp/fusion-push/batch', async () => ({ ok: 'extension' }))
      },
      { prefix: '/api' }
    )
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  const gql = (query: string) =>
    app.inject({ method: 'POST', url: '/api/graphql', payload: { query } })

  it.each([
    ['/api/items/workflows'],
    ['/files'],
    ['/api/efp/fusion-push/batch']
  ])('refuses POST %s for an integration admin', async (url) => {
    state.caller = { isAdmin: true, authMethod: 'token', account_kind: 'integration' }
    const res = await app.inject({ method: 'POST', url, payload: {} })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ code: 'MAINTENANCE' })
  })

  it('lets a signed-in human admin write', async () => {
    state.caller = HUMAN_ADMIN
    const res = await app.inject({ method: 'POST', url: '/api/items/workflows', payload: {} })
    expect(res.statusCode).toBe(200)
  })

  it('keeps reads and sign-in open', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/items/workflows' })).statusCode).toBe(200)
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} })).statusCode
    ).toBe(200)
  })

  it('lets everything through when maintenance is off', async () => {
    state.on = false
    state.caller = { isAdmin: false, authMethod: 'session' }
    const res = await app.inject({ method: 'POST', url: '/api/items/workflows', payload: {} })
    expect(res.statusCode).toBe(200)
  })

  it('refuses a GraphQL mutation from the LinX-style admin token', async () => {
    state.caller = { isAdmin: true, authMethod: 'token', account_kind: 'integration' }
    const res = await gql('mutation CreateWorkflow { create_workflows_item }')
    expect(res.statusCode).toBe(503)
    const body = res.json() as { errors: Array<{ extensions: { code: string } }>; code: string }
    expect(body.code).toBe('MAINTENANCE')
    expect(body.errors[0].extensions.code).toBe('MAINTENANCE')
  })

  it('still answers GraphQL queries during maintenance', async () => {
    state.caller = { isAdmin: false, authMethod: 'token' }
    const res = await gql('{ hello }')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: { hello: 'hi' } })
  })

  it('lets a signed-in human admin run a mutation', async () => {
    state.caller = HUMAN_ADMIN
    const res = await gql('mutation { create_workflows_item }')
    expect(res.json()).toEqual({ data: { create_workflows_item: 'CR26-1' } })
  })

  it('judges the operation that runs, not the first one in the document', async () => {
    state.caller = { isAdmin: false, authMethod: 'session' }
    const doc = 'query Q { hello } mutation M { create_workflows_item }'
    const q = await app.inject({
      method: 'POST',
      url: '/api/graphql',
      payload: { query: doc, operationName: 'Q' }
    })
    expect(q.statusCode).toBe(200)
    const m = await app.inject({
      method: 'POST',
      url: '/api/graphql',
      payload: { query: doc, operationName: 'M' }
    })
    expect(m.statusCode).toBe(503)
  })
})
