import { execute, GraphQLObjectType, GraphQLSchema, parse } from 'graphql'
import { describe, expect, it } from 'vitest'

// Hub providers (Task 11b): the GraphQL `hub` namespace reaches the provider routes. Every field
// is one REST call as the caller; planning is a mutation, starting a change is REST only.

const { hubGraphQLFields, queryString } = await import('../../../services/hub/api/graphql.js')

const fields = hubGraphQLFields({ HUB: 'on' } as never)
if (!fields) throw new Error('hub fields missing')
const schema = new GraphQLSchema({
  query: new GraphQLObjectType({ name: 'Query', fields: { hub: fields.query } }),
  mutation: new GraphQLObjectType({ name: 'Mutation', fields: { hub: fields.mutation } })
})

type Inject = { method: string; url: string; payload?: string }

async function run(source: string, answer: (url: string) => { status?: number; body: unknown }) {
  const calls: Inject[] = []
  const server = {
    inject: async (o: Inject) => {
      calls.push({ method: o.method, url: o.url, payload: o.payload })
      const a = answer(o.url)
      return { statusCode: a.status ?? 200, body: JSON.stringify(a.body) }
    }
  }
  const res = await execute({
    schema,
    document: parse(source),
    contextValue: {
      req: { headers: {}, server, socket: { remoteAddress: '127.0.0.1' }, ip: '127.0.0.1' }
    }
  })
  return { res, calls }
}

describe('queryString', () => {
  it('keeps given values, encodes them, drops the rest', () => {
    expect(queryString({ a: 1, b: 'x y&z', c: undefined, d: null, e: '' })).toBe('?a=1&b=x%20y%26z')
    expect(queryString({})).toBe('')
  })
})

describe('GraphQL hub provider fields', () => {
  it('reads each provider route as REST does', async () => {
    const { res, calls } = await run(
      `{ hub {
        providerTypes
        connections(provider: "github")
        connection(id: 7)
        connectionUnmanaged(id: 7, type: "github.repository", cursor: "c 1")
        appConnections(appId: 3)
        resources(app: 3, environment: 9, drift: true, scope: "app")
        resource(id: 5)
        resourceChanges(app: 3, status: "applied,failed", limit: 10)
        resourceChange(id: 11)
      } }`,
      (url) => ({ body: { data: { url } } })
    )
    expect(res.errors).toBeUndefined()
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/hub/provider-types',
      'GET /api/hub/connections?provider=github',
      'GET /api/hub/connections/7',
      'GET /api/hub/connections/7/unmanaged?type=github.repository&cursor=c%201',
      'GET /api/hub/apps/3/connections',
      'GET /api/hub/resources?app=3&environment=9&drift=1&scope=app',
      'GET /api/hub/resources/5',
      'GET /api/hub/resource-changes?app=3&status=applied%2Cfailed&limit=10',
      'GET /api/hub/resource-changes/11'
    ])
  })

  it('plans through a mutation and sends the input untouched', async () => {
    const { res, calls } = await run(
      `mutation { hub { planResourceChanges(input: {connectionId: 7, scope: "app", appId: 3, environmentId: 9, ops: []}) } }`,
      () => ({ body: { data: { changeId: 1 } } })
    )
    expect(res.errors).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('/api/hub/resources/plan')
    expect(JSON.parse(calls[0].payload as string)).toEqual({
      connectionId: 7,
      scope: 'app',
      appId: 3,
      environmentId: 9,
      ops: []
    })
  })

  it('a REST refusal comes back with its code and status', async () => {
    const { res } = await run('{ hub { connection(id: 99) } }', () => ({
      status: 404,
      body: { error: 'Connection not found.', code: 'CONNECTION_NOT_FOUND' }
    }))
    const ext = res.errors?.[0]?.extensions as { code?: string; status?: number }
    expect(ext.status).toBe(404)
    expect(ext.code).toBe('CONNECTION_NOT_FOUND')
  })

  it('has no field that starts, approves or changes a connection (REST only)', () => {
    const hub = schema.getMutationType()?.getFields().hub
    const names = Object.keys(
      (hub?.type as unknown as { ofType: GraphQLObjectType }).ofType.getFields()
    )
    expect(names).toContain('planResourceChanges')
    for (const name of names) expect(name).not.toMatch(/start|approve|decline|connection|adopt/i)
  })
})
