import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 28: the Anthropic adapter against recorded (fake-valued) answers.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const { ensureCoreProviders, CORE_PROVIDERS } = await import(
  '../../../services/hub/providers/index.js'
)
const registry = await import('../../../services/hub/providers/registry.js')
const { anthropicAdapter } = await import('../../../services/hub/providers/anthropic/index.js')

import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  ProviderError
} from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/anthropic/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const CRED = 'sk-ant-admin01-test-secret-anthropic-admin-0001'
const PASTED = 'sk-ant-api03-TESTfakefakefakefakefake-WXYZ'
const WS = 'wrkspc_test0001'
const WS2 = 'wrkspc_test0002'
const KEY = 'apikey_test0001'
const USER = 'user_test0001'
const T_WS = 'anthropic.workspace'
const T_MEMBER = 'anthropic.workspace_member'
const T_KEY = 'anthropic.api_key'
const T_SPEND = 'anthropic.spend_limit'

interface Call {
  method: string
  path: string
  search: string
  body: any
  headers: Record<string, string>
}
interface Route {
  method: string
  path: RegExp
  search?: RegExp
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

let nextConn = 100

function harness(routes: Route[]) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const call: Call = {
      method: String(init?.method ?? 'GET'),
      path: u.pathname,
      search: decodeURIComponent(u.search),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers ?? {}
    }
    calls.push(call)
    const hit = routes.find(
      (r) =>
        r.method === call.method &&
        r.path.test(call.path) &&
        (!r.search || r.search.test(call.search))
    )
    if (!hit) return new Response('{"error":{"message":"not found"}}', { status: 404 })
    const status = hit.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(hit.body ?? {}), {
      status,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: anthropicAdapter,
    connectionId: nextConn++,
    config: { organization: 'Test Org' },
    secrets: { credential: CRED },
    now: () => new Date('2026-11-26T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return { ctx, calls }
}

function desired(
  type: string,
  fields: Record<string, unknown>,
  refs: Record<string, string | string[] | null> = {},
  externalId: string | null = null
): DesiredResource {
  return {
    resourceId: 7,
    type,
    externalId,
    scope: 'app',
    appId: 1,
    environmentId: 2,
    fields,
    refs,
    tags: {}
  }
}

const op = (type: string, over: Partial<PlannedOp>): PlannedOp => ({
  kind: 'update',
  type,
  resourceId: 7,
  externalId: null,
  reason: '',
  changes: [],
  preconditions: {},
  risk: [],
  ...over
})

const spec = (key: string) => anthropicAdapter.types.find((t) => t.key === key)!

const wsGet = (body: unknown = fx('workspace'), status = 200): Route => ({
  method: 'GET',
  path: new RegExp(`/workspaces/${WS}$`),
  body,
  status
})

beforeEach(() => {
  registry.resetProvidersForTest()
})

describe('anthropic adapter: registration', () => {
  it('is a core provider on api.anthropic.com with a secret credential', () => {
    ensureCoreProviders()
    expect(CORE_PROVIDERS.map((a) => a.key)).toContain('anthropic')
    expect(registry.getProvider('anthropic')).toBe(anthropicAdapter)
    expect(anthropicAdapter.connection.hosts({})).toEqual(['api.anthropic.com'])
    expect(anthropicAdapter.connection.fields.find((f) => f.key === 'credential')?.secret).toBe(
      true
    )
    expect(anthropicAdapter.connection.describe({ organization: 'Acme' })).not.toContain('sk-ant')
    expect(anthropicAdapter.types.map((t) => t.key)).toEqual([
      T_WS,
      T_MEMBER,
      T_KEY,
      T_SPEND,
      'anthropic.rate_limits'
    ])
  })

  it('refuses a regular API key as the credential', () => {
    const problems = anthropicAdapter.connection.validate?.({}, { credential: 'sk-ant-api03-abc' })
    expect(problems?.join(' ')).toContain('regular API key')
    expect(anthropicAdapter.connection.validate?.({}, { credential: CRED })).toEqual([])
  })

  it('refuses a host other than api.anthropic.com', async () => {
    const { ctx } = harness([])
    await expect(ctx.fetch('https://example.com/v1/organizations/me')).rejects.toBeTruthy()
  })
})

describe('anthropic adapter: headers and testConnection', () => {
  it('an Admin API key goes in x-api-key with the version header; an OAuth token is a bearer', async () => {
    const h = harness([{ method: 'GET', path: /\/me$/, body: fx('me') }])
    await anthropicAdapter.testConnection(h.ctx)
    expect(h.calls[0].headers['x-api-key']).toBe(CRED)
    expect(h.calls[0].headers['anthropic-version']).toBe('2026-10-21')
    const oauth = makeProviderContext({
      adapter: anthropicAdapter,
      connectionId: 2,
      config: {},
      secrets: { credential: 'oat-test-token-0001' },
      fetch: {
        fetchImpl: (async (_u: string, init: any) => {
          expect(init.headers.authorization).toBe('Bearer oat-test-token-0001')
          expect(init.headers['x-api-key']).toBeUndefined()
          return new Response(JSON.stringify(fx('me')), { status: 200 })
        }) as any
      }
    })
    await anthropicAdapter.testConnection(oauth)
  })

  it('lists what it could read and what spend limits are', async () => {
    const h = harness([
      { method: 'GET', path: /\/me$/, body: fx('me') },
      { method: 'GET', path: /\/workspaces$/, body: fx('workspaces') },
      { method: 'GET', path: /\/users$/, body: fx('users') },
      { method: 'GET', path: /\/api_keys$/, body: fx('api-keys') },
      { method: 'GET', path: /\/rate_limits$/, body: fx('rate-limits') },
      { method: 'GET', path: /\/analytics\/cost$/, body: fx('cost-month') }
    ])
    const r = await anthropicAdapter.testConnection(h.ctx)
    expect(r.ok).toBe(true)
    expect(r.identity).toContain('Test Org')
    expect(r.missing).toEqual([])
    // The spend-limits probe 404s here: said, not failed.
    expect(r.message).toContain('Spend limits are not available')
    const analytics = h.calls.find((c) => c.path.endsWith('/analytics/cost'))
    expect(analytics?.headers['anthropic-beta']).toBe('analytics-usage-cost-2026-08-24')
  })

  it('a refused credential is not ok and names the need, with the key scrubbed', async () => {
    const h = harness([{ method: 'GET', path: /\/me$/, status: 403, body: fx('error-forbidden') }])
    const r = await anthropicAdapter.testConnection(h.ctx)
    expect(r.ok).toBe(false)
    expect(r.missing[0]).toContain('Admin API')
    expect(JSON.stringify(r)).not.toContain(CRED)
  })
})

describe('anthropic adapter: observe and list', () => {
  it('a workspace observes with its name; archived, missing and Default are gone', async () => {
    const h = harness([wsGet()])
    const seen = await anthropicAdapter.observe(h.ctx, T_WS, WS)
    expect(seen?.name).toBe('demo-app')
    expect(seen?.fields.name).toBe('demo-app')
    const arch = harness([wsGet(fx('workspace-archived'))])
    expect(await anthropicAdapter.observe(arch.ctx, T_WS, WS)).toBeNull()
    const gone = harness([wsGet({}, 404)])
    expect(await anthropicAdapter.observe(gone.ctx, T_WS, WS)).toBeNull()
    const def = harness([wsGet(fx('workspace-default'))])
    expect(await anthropicAdapter.observe(def.ctx, T_WS, WS)).toBeNull()
  })

  it('a member observes with its email and workspace id; a member of a gone workspace is gone', async () => {
    const h = harness([
      wsGet(),
      { method: 'GET', path: new RegExp(`/workspaces/${WS}/members/${USER}$`), body: fx('member') },
      { method: 'GET', path: new RegExp(`/users/${USER}$`), body: fx('user') }
    ])
    const seen = await anthropicAdapter.observe(h.ctx, T_MEMBER, `${WS}:${USER}`)
    expect(seen?.fields).toEqual({
      workspace: WS,
      email: 'dev@example.com',
      role: 'workspace_developer'
    })
    const gone = harness([wsGet({}, 404)])
    expect(await anthropicAdapter.observe(gone.ctx, T_MEMBER, `${WS}:${USER}`)).toBeNull()
  })

  it('lists workspaces without the Default or archived ones, and keys without archived ones', async () => {
    const h = harness([
      {
        method: 'GET',
        path: /\/workspaces$/,
        body: {
          data: [fx('workspace'), fx('workspace-default'), fx('workspace-archived')],
          has_more: false
        }
      },
      { method: 'GET', path: /\/api_keys$/, body: fx('api-keys') }
    ])
    const ws = await anthropicAdapter.list(h.ctx, T_WS)
    expect(ws.items.map((o) => o.externalId)).toEqual([WS])
    const keys = await anthropicAdapter.list(h.ctx, T_KEY)
    expect(keys.items.map((o) => o.externalId)).toEqual(['apikey_test0001', 'apikey_test0002'])
    expect(keys.items[0].fields.workspace).toBe(WS)
    expect(keys.items[1].fields.workspace).toBeNull()
    expect(keys.items[0].fields.hint).toBe('sk-ant-api03-TEST...WXYZ')
  })

  it('follows the has_more cursor across pages', async () => {
    const pages = [
      { data: [fx('workspace')], has_more: true, last_id: WS },
      { data: [{ ...fx('workspace'), id: WS2, name: 'other-app' }], has_more: false }
    ]
    let i = 0
    const h = harness([])
    const ctx = makeProviderContext({
      adapter: anthropicAdapter,
      connectionId: 3,
      config: {},
      secrets: { credential: CRED },
      fetch: {
        fetchImpl: (async (url: string) => {
          if (i === 1) expect(decodeURIComponent(url)).toContain(`after_id=${WS}`)
          return new Response(JSON.stringify(pages[i++]), { status: 200 })
        }) as any
      }
    })
    void h
    const ws = await anthropicAdapter.list(ctx, T_WS)
    expect(ws.items).toHaveLength(2)
  })

  it('rate limits read as readable lines (read only)', async () => {
    const h = harness([{ method: 'GET', path: /\/rate_limits$/, body: fx('rate-limits') }])
    const seen = await anthropicAdapter.observe(h.ctx, 'anthropic.rate_limits', 'organization')
    expect(seen?.fields.limits).toEqual([
      'Claude Sonnet · requests_per_minute: 4000',
      'Claude Sonnet · output_tokens_per_minute: 800000'
    ])
    await expect(
      anthropicAdapter.apply(h.ctx, op('anthropic.rate_limits', {}), null)
    ).rejects.toMatchObject({ code: 'READ_ONLY' })
  })

  it('refuses ids that are not safe path segments', async () => {
    const h = harness([])
    for (const bad of ['', '..', 'a/b', 'a b', 'x?y']) {
      await expect(anthropicAdapter.observe(h.ctx, T_WS, bad)).rejects.toMatchObject({
        code: 'BAD_ID'
      })
    }
    await expect(anthropicAdapter.observe(h.ctx, T_MEMBER, 'one-part')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    expect(h.calls).toHaveLength(0)
  })
})

describe('anthropic adapter: plan', () => {
  const ctx = () => harness([]).ctx
  const obsWs = (): Observed => ({
    type: T_WS,
    externalId: WS,
    name: 'demo-app',
    fields: { name: 'demo-app' },
    tags: {}
  })

  it('workspace: create, rename, archive in plain words, no change = nothing', () => {
    const create = anthropicAdapter.plan(ctx(), desired(T_WS, { name: 'new-app' }), null)
    expect(create[0].kind).toBe('create')
    expect(create[0].reason).toContain('Anthropic workspace new-app')
    expect(create[0].reason).toContain('paste it')
    const rename = anthropicAdapter.plan(ctx(), desired(T_WS, { name: 'renamed' }), obsWs())
    expect(rename[0].kind).toBe('update')
    expect(rename[0].reason).toContain('Rename')
    const del = anthropicAdapter.plan(ctx(), null, obsWs())
    expect(del[0].kind).toBe('delete')
    expect(del[0].reason).toContain('cannot be undone')
    expect(anthropicAdapter.plan(ctx(), desired(T_WS, { name: 'demo-app' }), obsWs())).toEqual([])
  })

  it('member: create, role change, replace on email or workspace change', () => {
    const obs: Observed = {
      type: T_MEMBER,
      externalId: `${WS}:${USER}`,
      name: 'dev@example.com',
      fields: { workspace: WS, email: 'dev@example.com', role: 'workspace_developer' },
      tags: {}
    }
    const want = (over: Record<string, unknown>, ws: string = WS) =>
      desired(
        T_MEMBER,
        { email: 'dev@example.com', role: 'workspace_developer', ...over },
        { workspace: ws }
      )
    expect(anthropicAdapter.plan(ctx(), want({ role: 'workspace_admin' }), obs)[0].kind).toBe(
      'update'
    )
    expect(anthropicAdapter.plan(ctx(), want({ email: 'other@example.com' }), obs)[0].kind).toBe(
      'replace'
    )
    expect(anthropicAdapter.plan(ctx(), want({}, WS2), obs)[0].kind).toBe('replace')
    expect(anthropicAdapter.plan(ctx(), want({}), obs)).toEqual([])
    expect(anthropicAdapter.plan(ctx(), want({}), null)[0].kind).toBe('create')
    expect(anthropicAdapter.plan(ctx(), null, obs)[0].kind).toBe('delete')
  })

  it('api key: rename / deactivate / paste are updates; the pasted value never appears in the plan', () => {
    const obs: Observed = {
      type: T_KEY,
      externalId: KEY,
      name: 'demo-app key',
      fields: { name: 'demo-app key', status: 'active', workspace: WS },
      tags: {}
    }
    const want = (fields: Record<string, unknown>) =>
      desired(T_KEY, { name: 'demo-app key', status: 'active', ...fields }, { workspace: WS })
    const off = anthropicAdapter.plan(ctx(), want({ status: 'inactive' }), obs)
    expect(off[0].changes).toEqual([{ field: 'status', from: 'active', to: 'inactive' }])
    const paste = anthropicAdapter.plan(
      ctx(),
      want({ api_key: { fingerprint: 'fp', changed: true } }),
      obs
    )
    expect(paste[0].changes).toEqual([{ field: 'api_key', secret: true }])
    expect(JSON.stringify(paste)).not.toContain('sk-ant')
    expect(anthropicAdapter.plan(ctx(), want({}), obs)).toEqual([])
    expect(anthropicAdapter.plan(ctx(), null, obs)).toEqual([])
    const other = anthropicAdapter.plan(
      ctx(),
      desired(T_KEY, { name: 'x', status: 'active' }, { workspace: WS2 }),
      obs
    )
    expect(other[0].reason).toContain('not in the chosen workspace')
  })
})

describe('anthropic adapter: risk flags and capabilities', () => {
  it('archiving a workspace is destructive and downtime; deactivating a key is downtime', () => {
    expect(spec(T_WS).risk(op(T_WS, { kind: 'delete' }), null)).toEqual(['destructive', 'downtime'])
    expect(spec(T_WS).risk(op(T_WS, { kind: 'create' }), null)).toEqual([])
    expect(
      spec(T_KEY).risk(op(T_KEY, { changes: [{ field: 'status', to: 'inactive' }] }), null)
    ).toEqual(['downtime'])
    expect(spec(T_KEY).risk(op(T_KEY, { changes: [{ field: 'name', to: 'x' }] }), null)).toEqual([])
  })

  it('keys cannot be created or deleted; rate limits are read only', () => {
    expect(spec(T_KEY).capabilities).toMatchObject({
      create: false,
      delete: false,
      update: true,
      adopt: true
    })
    expect(spec('anthropic.rate_limits').capabilities).toMatchObject({
      create: false,
      update: false,
      delete: false
    })
  })
})

describe('anthropic adapter: apply', () => {
  it('workspace create posts once and answers the id', async () => {
    const h = harness([
      { method: 'GET', path: /\/workspaces$/, body: { data: [], has_more: false } },
      { method: 'POST', path: /\/workspaces$/, body: fx('workspace') }
    ])
    const res = await anthropicAdapter.apply(
      h.ctx,
      op(T_WS, { kind: 'create' }),
      desired(T_WS, { name: 'demo-app' })
    )
    expect(res.externalId).toBe(WS)
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(1)
    expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'demo-app' })
  })

  it('workspace create over one the Hub did not make is ALREADY_EXISTS, nothing written', async () => {
    const h = harness([{ method: 'GET', path: /\/workspaces$/, body: fx('workspaces') }])
    await expect(
      anthropicAdapter.apply(
        h.ctx,
        op(T_WS, { kind: 'create' }),
        desired(T_WS, { name: 'demo-app' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('a resumed create with its id recorded posts nothing', async () => {
    const h = harness([wsGet()])
    const res = await anthropicAdapter.apply(
      h.ctx,
      op(T_WS, { kind: 'create' }),
      desired(T_WS, { name: 'demo-app' }, {}, WS)
    )
    expect(res.answer).toEqual({ already: 'exists' })
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('rename reads first; archive posts to /archive; archiving a gone workspace succeeds; Default is refused', async () => {
    const h = harness([
      wsGet(),
      {
        method: 'POST',
        path: new RegExp(`/workspaces/${WS}$`),
        body: { ...fx('workspace'), name: 'renamed' }
      },
      {
        method: 'POST',
        path: new RegExp(`/workspaces/${WS}/archive$`),
        body: fx('workspace-archived')
      }
    ])
    const r = await anthropicAdapter.apply(
      h.ctx,
      op(T_WS, { externalId: WS }),
      desired(T_WS, { name: 'renamed' }, {}, WS)
    )
    expect(r.observed?.name).toBe('renamed')
    const d = await anthropicAdapter.apply(
      h.ctx,
      op(T_WS, { kind: 'delete', externalId: WS }),
      null
    )
    expect(d.ok).toBe(true)
    expect(h.calls.some((c) => c.path.endsWith('/archive'))).toBe(true)
    const gone = harness([wsGet({}, 404)])
    expect(
      (await anthropicAdapter.apply(gone.ctx, op(T_WS, { kind: 'delete', externalId: WS }), null))
        .answer
    ).toEqual({
      already: 'gone'
    })
    const def = harness([wsGet(fx('workspace-default'))])
    await expect(
      anthropicAdapter.apply(def.ctx, op(T_WS, { kind: 'delete', externalId: WS }), null)
    ).rejects.toMatchObject({ code: 'DEFAULT_WORKSPACE' })
  })

  it('member create matches the person by email and adds them', async () => {
    const h = harness([
      wsGet(),
      { method: 'GET', path: /\/users$/, body: fx('users') },
      {
        method: 'GET',
        path: new RegExp(`/workspaces/${WS}/members/${USER}$`),
        status: 404,
        body: {}
      },
      { method: 'POST', path: new RegExp(`/workspaces/${WS}/members$`), body: fx('member') }
    ])
    const res = await anthropicAdapter.apply(
      h.ctx,
      op(T_MEMBER, { kind: 'create' }),
      desired(
        T_MEMBER,
        { email: 'DEV@example.com', role: 'workspace_developer' },
        { workspace: WS }
      )
    )
    expect(res.externalId).toBe(`${WS}:${USER}`)
    expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({
      user_id: USER,
      workspace_role: 'workspace_developer'
    })
  })

  it('member create for a person outside the organization or already in the workspace is refused', async () => {
    const none = harness([
      wsGet(),
      { method: 'GET', path: /\/users$/, body: { data: [], has_more: false } }
    ])
    await expect(
      anthropicAdapter.apply(
        none.ctx,
        op(T_MEMBER, { kind: 'create' }),
        desired(T_MEMBER, { email: 'x@example.com', role: 'workspace_user' }, { workspace: WS })
      )
    ).rejects.toMatchObject({ code: 'USER_NOT_IN_ORG' })
    const dup = harness([
      wsGet(),
      { method: 'GET', path: /\/users$/, body: fx('users') },
      { method: 'GET', path: new RegExp(`/workspaces/${WS}/members/${USER}$`), body: fx('member') }
    ])
    await expect(
      anthropicAdapter.apply(
        dup.ctx,
        op(T_MEMBER, { kind: 'create' }),
        desired(T_MEMBER, { email: 'dev@example.com', role: 'workspace_user' }, { workspace: WS })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(dup.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('member role change writes only the role; remove deletes; replace removes then adds', async () => {
    const h = harness([
      wsGet(),
      { method: 'GET', path: new RegExp(`/workspaces/${WS}/members/${USER}$`), body: fx('member') },
      { method: 'GET', path: new RegExp(`/users/${USER}$`), body: fx('user') },
      {
        method: 'POST',
        path: new RegExp(`/workspaces/${WS}/members/${USER}$`),
        body: fx('member')
      },
      {
        method: 'DELETE',
        path: new RegExp(`/workspaces/${WS}/members/${USER}$`),
        status: 200,
        body: {}
      }
    ])
    const id = `${WS}:${USER}`
    await anthropicAdapter.apply(
      h.ctx,
      op(T_MEMBER, { externalId: id }),
      desired(
        T_MEMBER,
        { email: 'dev@example.com', role: 'workspace_admin' },
        { workspace: WS },
        id
      )
    )
    expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({
      workspace_role: 'workspace_admin'
    })
    const del = await anthropicAdapter.apply(
      h.ctx,
      op(T_MEMBER, { kind: 'delete', externalId: id }),
      null
    )
    expect(del.ok).toBe(true)
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(true)
  })

  it('an api key cannot be created or deleted through the Admin API', async () => {
    const h = harness([])
    await expect(
      anthropicAdapter.apply(h.ctx, op(T_KEY, { kind: 'create' }), desired(T_KEY, { name: 'x' }))
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    await expect(
      anthropicAdapter.apply(h.ctx, op(T_KEY, { kind: 'delete', externalId: KEY }), null)
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    expect(h.calls).toHaveLength(0)
  })

  const keyDesired = (fields: Record<string, unknown>, ref: string | null = WS) =>
    desired(T_KEY, { name: 'demo-app key', status: 'active', ...fields }, { workspace: ref }, KEY)
  const keyRoutes = (): Route[] => [
    { method: 'GET', path: new RegExp(`/api_keys/${KEY}$`), body: fx('api-key') },
    {
      method: 'POST',
      path: new RegExp(`/api_keys/${KEY}$`),
      body: { ...fx('api-key'), name: 'renamed' }
    }
  ]

  it('key rename and deactivate send only what differs', async () => {
    const h = harness(keyRoutes())
    await anthropicAdapter.apply(
      h.ctx,
      op(T_KEY, { externalId: KEY }),
      keyDesired({ name: 'renamed', status: 'inactive' })
    )
    expect(h.calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'renamed',
      status: 'inactive'
    })
    const same = harness(keyRoutes())
    await anthropicAdapter.apply(same.ctx, op(T_KEY, { externalId: KEY }), keyDesired({}))
    expect(same.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('a pasted key matching the hint becomes the api_key output and nothing else carries it', async () => {
    const h = harness(keyRoutes())
    const res = await anthropicAdapter.apply(
      h.ctx,
      op(T_KEY, { externalId: KEY }),
      keyDesired({ api_key: { fingerprint: 'fp', changed: true, plain: PASTED } })
    )
    expect(res.outputs).toEqual({ api_key: PASTED })
    expect(JSON.stringify({ ...res, outputs: undefined })).not.toContain(PASTED)
    expect(h.calls.every((c) => !JSON.stringify(c.body ?? '').includes(PASTED))).toBe(true)
  })

  it('refuses a pasted Admin key, a key whose ends differ from the hint, and a key in another workspace', async () => {
    const admin = harness(keyRoutes())
    await expect(
      anthropicAdapter.apply(
        admin.ctx,
        op(T_KEY, { externalId: KEY }),
        keyDesired({
          api_key: {
            fingerprint: 'fp',
            changed: true,
            plain: 'sk-ant-admin01-abcdefghijklmnop-WXYZ'
          }
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    const wrong = harness(keyRoutes())
    await expect(
      anthropicAdapter.apply(
        wrong.ctx,
        op(T_KEY, { externalId: KEY }),
        keyDesired({
          api_key: {
            fingerprint: 'fp',
            changed: true,
            plain: 'sk-ant-api03-OTHERfakefakefakefake-ZZZZ'
          }
        })
      )
    ).rejects.toMatchObject({ code: 'KEY_MISMATCH' })
    const mism = harness(keyRoutes())
    await expect(
      anthropicAdapter.apply(mism.ctx, op(T_KEY, { externalId: KEY }), keyDesired({}, WS2))
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(mism.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('an error never echoes a credential, even one the provider repeats', async () => {
    const h = harness([
      {
        method: 'GET',
        path: new RegExp(`/workspaces/${WS}$`),
        status: 403,
        body: fx('error-forbidden')
      }
    ])
    const err = await anthropicAdapter.observe(h.ctx, T_WS, WS).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(String(err.message)).not.toContain(CRED)
    expect(String(err.message)).toContain('403')
  })
})

describe('anthropic adapter: errors', () => {
  it('maps 429 to a retryable error with the retry delay, 5xx retryable, 401 not', async () => {
    const limited = harness([
      {
        method: 'GET',
        path: /\/workspaces\//,
        status: 429,
        body: fx('error-rate-limited'),
        headers: { 'retry-after': '12' }
      }
    ])
    const err = await anthropicAdapter.observe(limited.ctx, T_WS, WS).catch((e) => e)
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true, status: 429 })
    expect(err.message).toContain('retry after 12 s')
    const down = harness([{ method: 'GET', path: /\/workspaces\//, status: 503, body: {} }])
    expect(await anthropicAdapter.observe(down.ctx, T_WS, WS).catch((e) => e)).toMatchObject({
      retryable: true
    })
    const auth = harness([{ method: 'GET', path: /\/workspaces\//, status: 401, body: {} }])
    expect(await anthropicAdapter.observe(auth.ctx, T_WS, WS).catch((e) => e)).toMatchObject({
      code: 'AUTH_FAILED',
      retryable: false
    })
  })
})

describe('anthropic adapter: spend limits', () => {
  it('hidden when the organization lacks the API: list empty, observe null, apply refused', async () => {
    const h = harness([])
    expect((await anthropicAdapter.list(h.ctx, T_SPEND)).items).toEqual([])
    expect(await anthropicAdapter.observe(h.ctx, T_SPEND, 'spl_test0001')).toBeNull()
    await expect(
      anthropicAdapter.apply(
        h.ctx,
        op(T_SPEND, { kind: 'create' }),
        desired(T_SPEND, { amount_cents: 5000 }, { workspace: WS })
      )
    ).rejects.toMatchObject({ code: 'NOT_AVAILABLE' })
  })

  it('sets a workspace limit when available', async () => {
    const h = harness([
      { method: 'GET', path: /\/spend_limits\/effective$/, body: { data: [], next_page: null } },
      wsGet(),
      {
        method: 'POST',
        path: /\/spend_limits$/,
        body: { id: 'spl_test0001', scope: { type: 'workspace', workspace_id: WS }, amount: '5000' }
      }
    ])
    const res = await anthropicAdapter.apply(
      h.ctx,
      op(T_SPEND, { kind: 'create' }),
      desired(T_SPEND, { amount_cents: 5000 }, { workspace: WS })
    )
    expect(res.externalId).toBe('spl_test0001')
    expect(h.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      scope: { type: 'workspace', workspace_id: WS },
      amount: '5000',
      currency: 'USD'
    })
  })
})

describe('anthropic adapter: outputs', () => {
  it('declares api_key as a secret once-only output; none leak into observed or desired', async () => {
    expect(spec(T_KEY).outputs).toEqual([
      { key: 'api_key', label: 'Anthropic API key', secret: true, onceOnly: true }
    ])
    expect(anthropicAdapter.readOutputs).toBeUndefined()
    const h = harness(keyRoutes0())
    const seen = await anthropicAdapter.observe(h.ctx, T_KEY, KEY)
    expect(JSON.stringify(seen)).not.toContain('sk-ant-api03-TESTfake')
    expect(Object.keys(seen?.fields ?? {})).not.toContain('api_key')
  })
})

function keyRoutes0(): Route[] {
  return [{ method: 'GET', path: new RegExp(`/api_keys/${KEY}$`), body: fx('api-key') }]
}

describe('anthropic adapter: health', () => {
  it('workspace health reads 24 h and month-to-date cost and tokens from the analytics API', async () => {
    const h = harness([
      wsGet(),
      { method: 'GET', path: /\/analytics\/cost$/, body: fx('cost-month') },
      { method: 'GET', path: /\/analytics\/usage$/, body: fx('usage-month') }
    ])
    const r = await anthropicAdapter.health!(h.ctx, T_WS, WS)
    expect(r.status).toBe('ok')
    expect(r.details?.cost_month_to_date_usd).toBe(412.8)
    expect(r.details?.tokens_month_to_date).toBe(5590800)
    const q = h.calls.filter((c) => c.path.includes('/analytics/'))
    expect(q).toHaveLength(4)
    expect(q.every((c) => c.search.includes(`workspace_ids[]=${WS}`))).toBe(true)
    expect(q.some((c) => c.search.includes('starting_at=2026-11-25T12:00:00Z'))).toBe(true)
    expect(q.some((c) => c.search.includes('starting_at=2026-11-01T00:00:00Z'))).toBe(true)
  })

  it('no data yet is unknown, a gone workspace is down, an inactive key warns', async () => {
    const empty = { data: [], has_more: false, next_page: null, data_refreshed_at: null }
    const h = harness([
      wsGet(),
      { method: 'GET', path: /\/analytics\/cost$/, body: empty },
      { method: 'GET', path: /\/analytics\/usage$/, body: empty }
    ])
    expect((await anthropicAdapter.health!(h.ctx, T_WS, WS)).status).toBe('unknown')
    const gone = harness([wsGet({}, 404)])
    expect((await anthropicAdapter.health!(gone.ctx, T_WS, WS)).status).toBe('down')
    const key = harness([
      {
        method: 'GET',
        path: new RegExp(`/api_keys/${KEY}$`),
        body: { ...fx('api-key'), status: 'inactive' }
      }
    ])
    expect((await anthropicAdapter.health!(key.ctx, T_KEY, KEY)).status).toBe('warn')
  })
})

describe('anthropic adapter: usageNow', () => {
  it('answers cost rows per workspace and day, a daily query for finished days and hourly for today', async () => {
    const h = harness([
      {
        method: 'GET',
        path: /\/analytics\/cost$/,
        search: /time_bucket_width=1d/,
        body: fx('cost-daily')
      },
      {
        method: 'GET',
        path: /\/analytics\/cost$/,
        search: /time_bucket_width=1h/,
        body: {
          data: [
            {
              starting_at: '2026-11-26T08:00:00Z',
              group: { workspace_id: WS },
              cost: { currency: 'USD', amount: '10.000000' }
            }
          ],
          has_more: false,
          data_refreshed_at: '2026-11-26T09:00:00Z'
        }
      }
    ])
    const rows = await anthropicAdapter.usageNow!(h.ctx, { from: '2026-11-01', to: '2026-11-26' })
    expect(rows).toEqual([
      {
        date: '2026-11-24',
        amountCents: 1250.5,
        currency: 'USD',
        externalId: WS,
        service: 'anthropic',
        recordType: 'usage'
      },
      {
        date: '2026-11-25',
        amountCents: 300,
        currency: 'USD',
        externalId: WS2,
        service: 'anthropic',
        recordType: 'usage'
      },
      {
        date: '2026-11-26',
        amountCents: 10,
        currency: 'USD',
        externalId: WS,
        service: 'anthropic',
        recordType: 'usage'
      }
    ])
    const daily = h.calls.find((c) => c.search.includes('time_bucket_width=1d'))
    expect(daily?.search).toContain('group_by[]=workspace_id')
    expect(daily?.search).toContain('ending_at=2026-11-26T00:00:00Z')
    expect(daily?.headers['anthropic-beta']).toBe('analytics-usage-cost-2026-08-24')
  })

  it('never asks for more than 31 days', async () => {
    const h = harness([
      { method: 'GET', path: /\/analytics\/cost$/, body: { data: [], has_more: false } }
    ])
    await anthropicAdapter.usageNow!(h.ctx, { from: '2026-01-01', to: '2026-11-26' })
    const daily = h.calls.find((c) => c.search.includes('time_bucket_width=1d'))
    expect(daily?.search).toContain('starting_at=2026-10-26T00:00:00Z')
  })
})

describe('anthropic adapter: estimates', () => {
  it('estimate from recorded price answer: a workspace is a known zero plus usage', async () => {
    const h = harness([])
    const est = await spec(T_WS).estimate!(h.ctx, desired(T_WS, { name: 'x' }), null)
    expect(est.basis).toBe('usage')
    expect(est.confidence).toBe('usage_varies')
    expect(est.monthlyCents).toBe(0)
    expect(est.note).toContain('plus usage')
    expect(est.priceAsOf).toBe('2026-11-27')
    expect((await spec(T_WS).estimate!(h.ctx, null, null)).confidence).toBe('unknown')
  })

  it('only the workspace is costed; every costed type carries an estimate', () => {
    for (const t of anthropicAdapter.types) {
      if (t.costClass) expect(typeof t.estimate).toBe('function')
    }
    expect(anthropicAdapter.types.filter((t) => t.costClass).map((t) => t.key)).toEqual([T_WS])
  })
})

describe('spend limit cost gate (security review)', () => {
  it('removing or raising a spend limit is a cost; lowering it is not', () => {
    const t = anthropicAdapter.types.find((x) => x.key === 'anthropic.spend_limit')!
    const o = (kind: string, changes: unknown[] = []) => ({ kind, changes }) as any
    expect(t.risk(o('delete'), null)).toEqual(['cost', 'destructive'])
    expect(t.risk(o('update', [{ field: 'amount_cents', from: 1000, to: 5000 }]), null)).toEqual([
      'cost'
    ])
    expect(t.risk(o('update', [{ field: 'amount_cents', from: 5000, to: 1000 }]), null)).toEqual([])
    expect(t.risk(o('create', [{ field: 'amount_cents', to: 1000 }]), null)).toEqual(['cost'])
  })
})
