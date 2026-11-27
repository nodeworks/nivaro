import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 29: the OpenAI adapter against recorded (fake-valued) answers.

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
const { openaiAdapter } = await import('../../../services/hub/providers/openai/index.js')

import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  ProviderError,
  ROTATE_OUTPUTS_FIELD
} from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/openai/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const KEY = 'test-secret-openai-admin-0001'
const SA_KEY = 'test-secret-openai-sa-key-0001'
const PROJ = 'proj_test0001'
const SA = `${PROJ}:svc_acct_test01`
const USER = `${PROJ}:user-test0001`
const RL = `${PROJ}:rl-gpt-4o`
const APIKEY = `${PROJ}:key_test01`
const T = {
  project: 'openai.project',
  sa: 'openai.service_account',
  user: 'openai.project_user',
  rl: 'openai.project_rate_limit',
  key: 'openai.project_api_key'
}

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
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function harness(routes: Route[], config: Record<string, unknown> = {}) {
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
    const hit = routes.find((r) => r.method === call.method && r.path.test(call.path))
    if (!hit) return new Response('{"error":{"message":"not found"}}', { status: 404 })
    const status = hit.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(hit.body ?? {}), {
      status,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: openaiAdapter,
    connectionId: 1,
    config,
    secrets: { adminKey: KEY },
    now: () => new Date('2026-11-26T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return { ctx, calls }
}

const liveProject: Route = {
  method: 'GET',
  path: /\/projects\/proj_test0001$/,
  body: fx('project')
}

function desired(
  type: string,
  fields: Record<string, unknown>,
  externalId: string | null = null,
  refs: Record<string, string | null> = { project: PROJ }
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

const spec = (key: string) => {
  const s = openaiAdapter.types.find((t) => t.key === key)
  if (!s) throw new Error(`no type ${key}`)
  return s
}

const obs = (type: string, externalId: string, fields: Record<string, unknown>): Observed => ({
  type,
  externalId,
  name: String(fields.name ?? fields.email ?? fields.model ?? ''),
  fields,
  tags: {}
})

beforeEach(() => {
  registry.resetProvidersForTest()
})

describe('openai adapter: registration', () => {
  it('is a core provider on api.openai.com with a secret admin key', () => {
    ensureCoreProviders()
    expect(registry.getProvider('openai')).toBe(openaiAdapter)
    expect(CORE_PROVIDERS).toContain(openaiAdapter)
    expect(openaiAdapter.connection.hosts({})).toEqual(['api.openai.com'])
    expect(openaiAdapter.connection.fields.find((f) => f.key === 'adminKey')?.secret).toBe(true)
    expect(
      openaiAdapter.connection.fields.find((f) => f.key === 'organization')?.secret
    ).toBeFalsy()
    expect(openaiAdapter.connection.describe({ organization: 'org-abc' })).not.toContain(KEY)
    expect(openaiAdapter.connection.validate?.({ organization: 'nope' }, {})).not.toEqual([])
    expect(openaiAdapter.types.map((t) => t.key)).toEqual(Object.values(T))
  })

  it('refuses a host other than api.openai.com', async () => {
    const { ctx } = harness([])
    await expect(ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
  })
})

describe('openai adapter: testConnection', () => {
  it('lists missing permissions when the key is refused', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /\/projects$/, status: 401, body: fx('error-unauthorized') }
    ])
    const r = await openaiAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.missing).toContain('read and manage projects')
    expect(r.message).not.toContain(KEY)
  })

  it('answers who the credentials are, sends the bearer key and the organization header', async () => {
    const { ctx, calls } = harness(
      [
        { method: 'GET', path: /\/projects$/, body: fx('projects') },
        { method: 'GET', path: /\/costs$/, body: fx('costs') }
      ],
      { organization: 'org-abc123' }
    )
    const r = await openaiAdapter.testConnection(ctx)
    expect(r).toMatchObject({ ok: true, missing: [], identity: 'OpenAI organization org-abc123' })
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(calls[0].headers['openai-organization']).toBe('org-abc123')
  })

  it('a key without the costs scope still works and says costs are missing', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /\/projects$/, body: fx('projects') },
      { method: 'GET', path: /\/costs$/, status: 403, body: fx('error-unauthorized') }
    ])
    const r = await openaiAdapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual(['read organization costs'])
  })
})

describe('openai adapter: observe and list', () => {
  it('observe maps a project; an archived or missing one is gone', async () => {
    const { ctx } = harness([liveProject])
    expect(await openaiAdapter.observe(ctx, T.project, PROJ)).toMatchObject({
      type: T.project,
      externalId: PROJ,
      name: 'demo-app',
      fields: { name: 'demo-app', status: 'active' }
    })
    const { ctx: c2 } = harness([
      { method: 'GET', path: /\/projects\/proj_test0001$/, body: fx('project-archived') }
    ])
    expect(await openaiAdapter.observe(c2, T.project, PROJ)).toBeNull()
    const { ctx: c3 } = harness([])
    expect(await openaiAdapter.observe(c3, T.project, PROJ)).toBeNull()
  })

  it('observe maps each child and carries no key value', async () => {
    const { ctx } = harness([
      liveProject,
      { method: 'GET', path: /\/service_accounts\/svc_acct_test01$/, body: fx('service-account') },
      { method: 'GET', path: /\/users\/user-test0001$/, body: fx('project-user') },
      { method: 'GET', path: /\/rate_limits$/, body: fx('rate-limits') },
      { method: 'GET', path: /\/api_keys\/key_test01$/, body: fx('api-key') }
    ])
    const sa = await openaiAdapter.observe(ctx, T.sa, SA)
    expect(sa).toMatchObject({ externalId: SA, fields: { project: PROJ, name: 'demo-env-prod' } })
    expect(await openaiAdapter.observe(ctx, T.user, USER)).toMatchObject({
      fields: { project: PROJ, email: 'person@example.com', role: 'member' }
    })
    expect(await openaiAdapter.observe(ctx, T.rl, RL)).toMatchObject({
      fields: { model: 'gpt-4o', max_requests_per_1_minute: 500, max_images_per_1_minute: 50 }
    })
    const key = await openaiAdapter.observe(ctx, T.key, APIKEY)
    expect(key?.fields).toMatchObject({
      redacted: 'sk-proj-********abcd',
      owner_type: 'service_account',
      owner: 'demo-env-prod'
    })
    expect(JSON.stringify([sa, key])).not.toContain(SA_KEY)
  })

  it('a child of an archived or foreign project reads as gone', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/projects\/proj_test0001$/, body: fx('project-archived') }
    ])
    expect(await openaiAdapter.observe(ctx, T.sa, SA)).toBeNull()
    expect(calls.map((c) => c.path)).toEqual([`/v1/organization/projects/${PROJ}`])
  })

  it('list walks projects and skips archived ones', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /\/projects$/, body: fx('projects') },
      { method: 'GET', path: /\/service_accounts$/, body: fx('service-accounts') }
    ])
    expect((await openaiAdapter.list(ctx, T.project)).items.map((i) => i.externalId)).toEqual([
      PROJ
    ])
    const sas = await openaiAdapter.list(ctx, T.sa)
    expect(sas.cursor).toBeNull()
    expect(sas.items.map((i) => i.externalId)).toEqual([SA])
  })

  it('pages a long list by the last id', async () => {
    const page1 = {
      data: [{ id: 'proj_a', name: 'a', status: 'active' }],
      has_more: true,
      last_id: 'proj_a'
    }
    const page2 = { data: [{ id: 'proj_b', name: 'b', status: 'active' }], has_more: false }
    const calls: string[] = []
    const ctx = makeProviderContext({
      adapter: openaiAdapter,
      connectionId: 3,
      config: {},
      secrets: { adminKey: KEY },
      fetch: {
        fetchImpl: (async (url: string) => {
          calls.push(decodeURIComponent(new URL(url).search))
          return new Response(JSON.stringify(calls.length === 1 ? page1 : page2))
        }) as any,
        timeoutMs: 500
      }
    })
    const page = await openaiAdapter.list(ctx, T.project)
    expect(page.items.map((i) => i.externalId)).toEqual(['proj_a', 'proj_b'])
    expect(calls[1]).toContain('after=proj_a')
  })

  it('refuses ids that are not a safe path segment', async () => {
    const { ctx, calls } = harness([])
    for (const bad of ['../x', 'a/b', '', '.', 'a\\b']) {
      await expect(openaiAdapter.observe(ctx, T.project, bad)).rejects.toMatchObject({
        code: 'BAD_ID'
      })
    }
    for (const bad of [`${PROJ}:..`, `${PROJ}:a/b`, 'noproject', `:x`, `${PROJ}:`]) {
      await expect(openaiAdapter.observe(ctx, T.sa, bad)).rejects.toMatchObject({ code: 'BAD_ID' })
    }
    expect(calls).toEqual([])
  })
})

describe('openai adapter: plan', () => {
  const { ctx } = harness([])

  it('project: create, rename, archive (no way back), nothing', () => {
    const [c] = openaiAdapter.plan(ctx, desired(T.project, { name: 'demo-app' }, null, {}), null)
    expect(c.kind).toBe('create')
    expect(c.reason).toContain('OpenAI project demo-app')
    const [u] = openaiAdapter.plan(
      ctx,
      desired(T.project, { name: 'renamed' }, PROJ, {}),
      obs(T.project, PROJ, { name: 'demo-app', status: 'active' })
    )
    expect(u).toMatchObject({ kind: 'update', preconditions: { name: 'demo-app' } })
    const [d] = openaiAdapter.plan(ctx, null, obs(T.project, PROJ, { name: 'demo-app' }))
    expect(d.kind).toBe('delete')
    expect(d.reason).toContain('Archive')
    expect(d.reason).toContain('no way back')
    expect(
      openaiAdapter.plan(
        ctx,
        desired(T.project, { name: 'demo-app' }, PROJ, {}),
        obs(T.project, PROJ, { name: 'demo-app' })
      )
    ).toEqual([])
  })

  it('service account: create names the once-shown key; a rename is a replace; rotate is a named op', () => {
    const [c] = openaiAdapter.plan(ctx, desired(T.sa, { name: 'demo-env-prod' }), null)
    expect(c.reason).toContain('shows its API key once')
    const have = obs(T.sa, SA, { project: PROJ, name: 'demo-env-prod' })
    const [r] = openaiAdapter.plan(ctx, desired(T.sa, { name: 'other' }, SA), have)
    expect(r.kind).toBe('replace')
    expect(r.reason).toContain('cannot rename')
    const [rot] = openaiAdapter.plan(
      ctx,
      desired(T.sa, { name: 'demo-env-prod', [ROTATE_OUTPUTS_FIELD]: true }, SA),
      have
    )
    expect(rot).toMatchObject({ kind: 'update', action: 'rotate', externalId: SA })
    expect(rot.reason).toContain('stops working at once')
    expect(openaiAdapter.plan(ctx, desired(T.sa, { name: 'demo-env-prod' }, SA), have)).toEqual([])
    const [d] = openaiAdapter.plan(ctx, null, have)
    expect(d.reason).toContain('no way back')
  })

  it('member: add, role change, replace on a new person, remove', () => {
    const have = obs(T.user, USER, { project: PROJ, email: 'person@example.com', role: 'member' })
    const [c] = openaiAdapter.plan(
      ctx,
      desired(T.user, { email: 'person@example.com', role: 'owner' }),
      null
    )
    expect(c.reason).toContain('already be in the organization')
    const [u] = openaiAdapter.plan(
      ctx,
      desired(T.user, { email: 'person@example.com', role: 'owner' }, USER),
      have
    )
    expect(u).toMatchObject({
      kind: 'update',
      changes: [{ field: 'role', from: 'member', to: 'owner' }]
    })
    expect(
      openaiAdapter.plan(
        ctx,
        desired(T.user, { email: 'x@example.com', role: 'member' }, USER),
        have
      )[0].kind
    ).toBe('replace')
    expect(openaiAdapter.plan(ctx, null, have)[0].kind).toBe('delete')
  })

  it('rate limit: set, change only what is filled in, dropping it plans nothing', () => {
    const have = obs(T.rl, RL, {
      project: PROJ,
      model: 'gpt-4o',
      max_requests_per_1_minute: 500,
      max_tokens_per_1_minute: 30000,
      max_images_per_1_minute: null
    })
    const [c] = openaiAdapter.plan(
      ctx,
      desired(T.rl, { model: 'gpt-4o', max_requests_per_1_minute: 100 }),
      null
    )
    expect(c.kind).toBe('create')
    expect(c.reason).toContain('already exists at OpenAI')
    const [u] = openaiAdapter.plan(
      ctx,
      desired(
        T.rl,
        { model: 'gpt-4o', max_requests_per_1_minute: 100, max_tokens_per_1_minute: null },
        RL
      ),
      have
    )
    expect(u.changes).toEqual([{ field: 'max_requests_per_1_minute', from: 500, to: 100 }])
    expect(openaiAdapter.plan(ctx, null, have)).toEqual([])
  })

  it('project key: adopt-only; planning a create says so', () => {
    const [c] = openaiAdapter.plan(ctx, desired(T.key, {}), null)
    expect(c.reason).toContain('cannot be created through the OpenAI API')
    const have = obs(T.key, APIKEY, { project: PROJ, name: 'Secret key' })
    expect(openaiAdapter.plan(ctx, desired(T.key, {}, APIKEY), have)).toEqual([])
    expect(openaiAdapter.plan(ctx, null, have)[0].kind).toBe('delete')
  })
})

describe('openai adapter: risk flags and cost class', () => {
  const r = (type: string, o: Partial<PlannedOp>) => spec(type).risk(op(type, o), null)

  it('risk flags per type', () => {
    expect(r(T.project, { kind: 'delete' })).toEqual(['destructive', 'data_loss'])
    expect(r(T.project, { kind: 'update' })).toEqual([])
    expect(r(T.sa, { kind: 'delete' })).toEqual(['destructive'])
    expect(r(T.sa, { kind: 'replace' })).toEqual(['destructive', 'downtime'])
    expect(r(T.sa, { kind: 'update', action: 'rotate' })).toEqual(['downtime'])
    expect(r(T.key, { kind: 'delete' })).toEqual(['destructive'])
    expect(r(T.user, { kind: 'delete' })).toEqual([])
  })

  it('raising a rate limit is a cost risk; lowering it is not', () => {
    expect(r(T.rl, { kind: 'create' })).toEqual(['cost'])
    expect(
      r(T.rl, {
        kind: 'update',
        changes: [{ field: 'max_requests_per_1_minute', from: 100, to: 500 }]
      })
    ).toEqual(['cost'])
    expect(
      r(T.rl, {
        kind: 'update',
        changes: [{ field: 'max_requests_per_1_minute', from: 500, to: 100 }]
      })
    ).toEqual([])
  })

  it('capabilities match what the API can do', () => {
    expect(spec(T.rl).capabilities).toMatchObject({ create: true, update: true, delete: false })
    expect(spec(T.key).capabilities).toMatchObject({ create: false, update: false, delete: true })
    expect(spec(T.sa).capabilities).toMatchObject({ create: true, update: false, delete: true })
    expect(spec(T.sa).costClass?.(desired(T.sa, {}))).toBe('monthly')
    expect(spec(T.project).costClass).toBeUndefined()
  })
})

describe('openai adapter: apply', () => {
  it('project create posts the name once and answers the id', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /\/projects$/, body: { data: [], has_more: false } },
      { method: 'POST', path: /\/projects$/, body: fx('project') }
    ])
    const res = await openaiAdapter.apply(
      ctx,
      op(T.project, { kind: 'create' }),
      desired(T.project, { name: 'demo-app' }, null, {})
    )
    expect(res).toMatchObject({ ok: true, externalId: PROJ })
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'demo-app' })
  })

  it('project create over a name the Hub did not make is ALREADY_EXISTS, nothing written', async () => {
    const { ctx, calls } = harness([{ method: 'GET', path: /\/projects$/, body: fx('projects') }])
    await expect(
      openaiAdapter.apply(
        ctx,
        op(T.project, { kind: 'create' }),
        desired(T.project, { name: 'demo-app' }, null, {})
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('a resumed project create with its id recorded posts nothing', async () => {
    const { ctx, calls } = harness([liveProject])
    const res = await openaiAdapter.apply(
      ctx,
      op(T.project, { kind: 'create' }),
      desired(T.project, { name: 'demo-app' }, PROJ, {})
    )
    expect(res.answer).toMatchObject({ already: 'exists' })
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('findExisting names the project or service account that would collide', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /\/projects$/, body: fx('projects') },
      { method: 'GET', path: /\/service_accounts$/, body: fx('service-accounts') },
      { method: 'GET', path: /\/users$/, body: fx('project-users') }
    ])
    expect(
      (
        await openaiAdapter.findExisting?.(
          ctx,
          T.project,
          desired(T.project, { name: 'demo-app' }, null, {})
        )
      )?.externalId
    ).toBe(PROJ)
    expect(
      (await openaiAdapter.findExisting?.(ctx, T.sa, desired(T.sa, { name: 'demo-env-prod' })))
        ?.externalId
    ).toBe(SA)
    expect(
      (
        await openaiAdapter.findExisting?.(
          ctx,
          T.user,
          desired(T.user, { email: 'PERSON@example.com' })
        )
      )?.externalId
    ).toBe(USER)
    expect(
      await openaiAdapter.findExisting?.(ctx, T.sa, desired(T.sa, { name: 'nope' }))
    ).toBeNull()
  })

  it('project rename posts only when the name differs; delete archives, and gone is a success', async () => {
    const { ctx, calls } = harness([
      liveProject,
      {
        method: 'POST',
        path: /\/projects\/proj_test0001$/,
        body: { ...fx('project'), name: 'renamed' }
      }
    ])
    await openaiAdapter.apply(
      ctx,
      op(T.project, { externalId: PROJ }),
      desired(T.project, { name: 'renamed' }, PROJ, {})
    )
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'renamed' })
    const { ctx: c2, calls: calls2 } = harness([liveProject])
    const same = await openaiAdapter.apply(
      c2,
      op(T.project, { externalId: PROJ }),
      desired(T.project, { name: 'demo-app' }, PROJ, {})
    )
    expect(same.answer).toMatchObject({ already: 'matches' })
    expect(calls2.filter((c) => c.method === 'POST')).toEqual([])
    const { ctx: c3, calls: calls3 } = harness([
      { method: 'POST', path: /\/archive$/, body: fx('project-archived') }
    ])
    expect(
      (await openaiAdapter.apply(c3, op(T.project, { kind: 'delete', externalId: PROJ }), null)).ok
    ).toBe(true)
    expect(calls3[0].path).toBe(`/v1/organization/projects/${PROJ}/archive`)
    const { ctx: c4 } = harness([{ method: 'POST', path: /\/archive$/, status: 404, body: {} }])
    expect(
      (await openaiAdapter.apply(c4, op(T.project, { kind: 'delete', externalId: PROJ }), null)).ok
    ).toBe(true)
  })

  it('service account create returns the key as an output only, never in observed or answer', async () => {
    const { ctx, calls } = harness([
      liveProject,
      { method: 'GET', path: /\/service_accounts$/, body: { data: [], has_more: false } },
      { method: 'POST', path: /\/service_accounts$/, body: fx('service-account-created') }
    ])
    const res = await openaiAdapter.apply(
      ctx,
      op(T.sa, { kind: 'create' }),
      desired(T.sa, { name: 'demo-env-prod' })
    )
    expect(res.ok).toBe(true)
    expect(res.externalId).toBe(`${PROJ}:svc_acct_test02`)
    expect(res.outputs).toEqual({ api_key: SA_KEY })
    expect(JSON.stringify(res.observed)).not.toContain(SA_KEY)
    expect(JSON.stringify(res.answer)).not.toContain(SA_KEY)
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'demo-env-prod' })
  })

  it('service account create over a name the Hub did not make is ALREADY_EXISTS; a resumed one reads back with no key', async () => {
    const { ctx, calls } = harness([
      liveProject,
      { method: 'GET', path: /\/service_accounts$/, body: fx('service-accounts') }
    ])
    await expect(
      openaiAdapter.apply(
        ctx,
        op(T.sa, { kind: 'create' }),
        desired(T.sa, { name: 'demo-env-prod' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
    const { ctx: c2 } = harness([
      liveProject,
      { method: 'GET', path: /\/service_accounts\/svc_acct_test01$/, body: fx('service-account') }
    ])
    const res = await openaiAdapter.apply(
      c2,
      op(T.sa, { kind: 'create' }),
      desired(T.sa, { name: 'demo-env-prod' }, SA)
    )
    expect(res.answer).toMatchObject({ already: 'exists' })
    expect(res.outputs).toBeUndefined()
  })

  it('rotate makes the new account first, then removes the old one, and answers the new id and key', async () => {
    const { ctx, calls } = harness([
      liveProject,
      { method: 'GET', path: /\/service_accounts\/svc_acct_test01$/, body: fx('service-account') },
      { method: 'POST', path: /\/service_accounts$/, body: fx('service-account-created') },
      { method: 'DELETE', path: /\/service_accounts\/svc_acct_test01$/, body: { deleted: true } }
    ])
    const res = await openaiAdapter.apply(
      ctx,
      op(T.sa, { action: 'rotate', externalId: SA }),
      desired(T.sa, { name: 'demo-env-prod', [ROTATE_OUTPUTS_FIELD]: true }, SA)
    )
    expect(res.externalId).toBe(`${PROJ}:svc_acct_test02`)
    expect(res.outputs).toEqual({ api_key: SA_KEY })
    expect(res.answer).toMatchObject({ rotated: true, old_removed: true })
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => c.method)
    expect(writes).toEqual(['POST', 'DELETE'])
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'demo-env-prod' })
  })

  it('rotate keeps the new key when removing the old account fails', async () => {
    const { ctx } = harness([
      liveProject,
      { method: 'GET', path: /\/service_accounts\/svc_acct_test01$/, body: fx('service-account') },
      { method: 'POST', path: /\/service_accounts$/, body: fx('service-account-created') },
      {
        method: 'DELETE',
        path: /\/service_accounts\//,
        status: 500,
        body: fx('error-rate-limited')
      }
    ])
    const res = await openaiAdapter.apply(
      ctx,
      op(T.sa, { action: 'rotate', externalId: SA }),
      desired(T.sa, { name: 'demo-env-prod' }, SA)
    )
    expect(res.outputs).toEqual({ api_key: SA_KEY })
    expect(res.answer).toMatchObject({ old_removed: false })
  })

  it('replace deletes then creates and hands out the new key', async () => {
    const { ctx, calls } = harness([
      { method: 'DELETE', path: /\/service_accounts\/svc_acct_test01$/, body: {} },
      { method: 'POST', path: /\/service_accounts$/, body: fx('service-account-created') }
    ])
    const res = await openaiAdapter.apply(
      ctx,
      op(T.sa, { kind: 'replace', externalId: SA }),
      desired(T.sa, { name: 'new-name' }, SA)
    )
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'POST'])
    expect(res.outputs?.api_key).toBe(SA_KEY)
  })

  it('named and write ops refuse a target in another project (PROJECT_MISMATCH), nothing written', async () => {
    const { ctx, calls } = harness([])
    const other = desired(T.sa, { name: 'demo-env-prod' }, SA, { project: 'proj_other' })
    for (const o of [
      op(T.sa, { action: 'rotate', externalId: SA }),
      op(T.sa, { kind: 'replace', externalId: SA }),
      op(T.sa, { kind: 'delete', externalId: SA })
    ])
      await expect(openaiAdapter.apply(ctx, o, other)).rejects.toMatchObject({
        code: 'PROJECT_MISMATCH'
      })
    await expect(
      openaiAdapter.apply(
        ctx,
        op(T.user, { externalId: USER }),
        desired(T.user, { email: 'person@example.com', role: 'owner' }, USER, {
          project: 'proj_other'
        })
      )
    ).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' })
    await expect(
      openaiAdapter.apply(
        ctx,
        op(T.rl, { externalId: RL }),
        desired(T.rl, { model: 'gpt-4o', max_requests_per_1_minute: 1 }, RL, {
          project: 'proj_other'
        })
      )
    ).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' })
    expect(calls).toEqual([])
  })

  it('member add resolves the organization user by email (case-insensitive) and posts the role', async () => {
    const { ctx, calls } = harness([
      liveProject,
      { method: 'GET', path: /\/organization\/users$/, body: fx('org-users') },
      {
        method: 'GET',
        path: /\/projects\/proj_test0001\/users$/,
        body: { data: [], has_more: false }
      },
      { method: 'POST', path: /\/projects\/proj_test0001\/users$/, body: fx('project-user') }
    ])
    const res = await openaiAdapter.apply(
      ctx,
      op(T.user, { kind: 'create' }),
      desired(T.user, { email: 'person@example.com', role: 'owner' })
    )
    expect(res.externalId).toBe(USER)
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      user_id: 'user-test0001',
      role: 'owner'
    })
  })

  it('member add refuses someone who is not in the organization and someone already in the project', async () => {
    const { ctx, calls } = harness([
      liveProject,
      { method: 'GET', path: /\/organization\/users$/, body: fx('org-users') }
    ])
    await expect(
      openaiAdapter.apply(
        ctx,
        op(T.user, { kind: 'create' }),
        desired(T.user, { email: 'stranger@example.com', role: 'member' })
      )
    ).rejects.toMatchObject({ code: 'USER_NOT_IN_ORG' })
    const { ctx: c2 } = harness([
      liveProject,
      { method: 'GET', path: /\/organization\/users$/, body: fx('org-users') },
      { method: 'GET', path: /\/projects\/proj_test0001\/users$/, body: fx('project-users') }
    ])
    await expect(
      openaiAdapter.apply(
        c2,
        op(T.user, { kind: 'create' }),
        desired(T.user, { email: 'person@example.com', role: 'member' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('member role change posts the role; removing a gone member is a success', async () => {
    const { ctx, calls } = harness([
      liveProject,
      { method: 'GET', path: /\/users\/user-test0001$/, body: fx('project-user') },
      {
        method: 'POST',
        path: /\/users\/user-test0001$/,
        body: { ...fx('project-user'), role: 'owner' }
      }
    ])
    await openaiAdapter.apply(
      ctx,
      op(T.user, { externalId: USER }),
      desired(T.user, { email: 'person@example.com', role: 'owner' }, USER)
    )
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ role: 'owner' })
    const { ctx: c2 } = harness([{ method: 'DELETE', path: /\/users\//, status: 404, body: {} }])
    expect(
      (await openaiAdapter.apply(c2, op(T.user, { kind: 'delete', externalId: USER }), null)).ok
    ).toBe(true)
  })

  it('rate limit sets only the filled-in numbers that differ, on the existing limit', async () => {
    const { ctx, calls } = harness([
      liveProject,
      { method: 'GET', path: /\/rate_limits$/, body: fx('rate-limits') },
      { method: 'POST', path: /\/rate_limits\/rl-gpt-4o$/, body: {} }
    ])
    const res = await openaiAdapter.apply(
      ctx,
      op(T.rl, { kind: 'create' }),
      desired(T.rl, {
        model: 'gpt-4o',
        max_requests_per_1_minute: 500,
        max_tokens_per_1_minute: 60000,
        max_images_per_1_minute: null
      })
    )
    expect(res.externalId).toBe(RL)
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ max_tokens_per_1_minute: 60000 })
  })

  it('rate limit: an unknown model, nothing to set, a negative number and a delete are refused', async () => {
    const routes: Route[] = [
      liveProject,
      { method: 'GET', path: /\/rate_limits$/, body: fx('rate-limits') }
    ]
    const { ctx, calls } = harness(routes)
    await expect(
      openaiAdapter.apply(
        ctx,
        op(T.rl, { kind: 'create' }),
        desired(T.rl, { model: 'nope-model', max_requests_per_1_minute: 1 })
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      openaiAdapter.apply(ctx, op(T.rl, { kind: 'create' }), desired(T.rl, { model: 'gpt-4o' }))
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    await expect(
      openaiAdapter.apply(
        ctx,
        op(T.rl, { kind: 'create' }),
        desired(T.rl, { model: 'gpt-4o', max_requests_per_1_minute: -5 })
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    await expect(
      openaiAdapter.apply(ctx, op(T.rl, { kind: 'delete', externalId: RL }), null)
    ).rejects.toMatchObject({ code: 'CAPABILITY_MISSING' })
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('project key: delete only; create and update are refused', async () => {
    const { ctx, calls } = harness([
      { method: 'DELETE', path: /\/api_keys\/key_test01$/, body: {} }
    ])
    expect(
      (await openaiAdapter.apply(ctx, op(T.key, { kind: 'delete', externalId: APIKEY }), null)).ok
    ).toBe(true)
    expect(calls[0].path).toBe(`/v1/organization/projects/${PROJ}/api_keys/key_test01`)
    for (const kind of ['create', 'update'] as const)
      await expect(
        openaiAdapter.apply(ctx, op(T.key, { kind }), desired(T.key, {}, APIKEY))
      ).rejects.toMatchObject({ code: 'CAPABILITY_MISSING' })
  })
})

describe('openai adapter: errors', () => {
  it('maps 429 to a retryable error and says when to retry', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /\/projects$/,
        status: 429,
        body: fx('error-rate-limited'),
        headers: { 'retry-after': '7' }
      }
    ])
    const err: ProviderError = await openaiAdapter.list(ctx, T.project).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true, status: 429 })
    expect(err.message).toContain('retry after 7 s')
  })

  it('a 5xx is retryable, a 401 and a 400 are not', async () => {
    const mk = (status: number) =>
      harness([
        { method: 'GET', path: /\/projects$/, status, body: { error: { message: 'nope' } } }
      ]).ctx
    expect(await openaiAdapter.list(mk(503), T.project).catch((e) => e)).toMatchObject({
      retryable: true,
      code: 'PROVIDER_UNAVAILABLE'
    })
    expect(await openaiAdapter.list(mk(401), T.project).catch((e) => e)).toMatchObject({
      retryable: false,
      code: 'AUTH_FAILED'
    })
    expect(await openaiAdapter.list(mk(400), T.project).catch((e) => e)).toMatchObject({
      retryable: false,
      code: 'PROVIDER_REJECTED'
    })
  })

  it('secrets never appear in errors, even when the key sits past the clip', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /\/projects$/, status: 401, body: fx('error-unauthorized') }
    ])
    const err: ProviderError = await openaiAdapter.list(ctx, T.project).catch((e) => e)
    expect(err.message).toContain('OpenAI answered 401')
    expect(err.message).not.toContain(KEY)
    // The key straddles the 300-character clip: scrubbing first means no fragment survives.
    const padded = `${'x'.repeat(280)} ${KEY}`
    const { ctx: c2 } = harness([
      {
        method: 'GET',
        path: /\/projects$/,
        status: 400,
        body: { error: { message: padded } }
      }
    ])
    const e2: ProviderError = await openaiAdapter.list(c2, T.project).catch((e) => e)
    expect(e2.message).not.toContain(KEY.slice(0, 10))
    const fetchFail = makeProviderContext({
      adapter: openaiAdapter,
      connectionId: 2,
      config: {},
      secrets: { adminKey: KEY },
      fetch: {
        fetchImpl: (async () => {
          throw new TypeError(`getaddrinfo failed for ${KEY}`)
        }) as any,
        timeoutMs: 200
      }
    })
    const e3: Error = await openaiAdapter.list(fetchFail, T.project).catch((e) => e)
    expect(e3.message).not.toContain(KEY)
  })
})

describe('openai adapter: outputs', () => {
  it('declares api_key as a secret once-only output; none leak into observed, desired fields or plans', async () => {
    expect(spec(T.sa).outputs).toEqual([
      { key: 'api_key', label: 'API key', secret: true, onceOnly: true }
    ])
    for (const t of [T.project, T.user, T.rl, T.key]) expect(spec(t).outputs).toBeUndefined()
    expect(spec(T.sa).fields.map((f) => f.key)).not.toContain('api_key')
    expect(spec(T.sa).fields.find((f) => f.key === ROTATE_OUTPUTS_FIELD)).toMatchObject({
      kind: 'boolean',
      trigger: true
    })
    const { ctx } = harness([
      liveProject,
      {
        method: 'GET',
        path: /\/service_accounts\/svc_acct_test01$/,
        body: fx('service-account-created')
      }
    ])
    const seen = await openaiAdapter.observe(ctx, T.sa, SA)
    expect(JSON.stringify(seen)).not.toContain(SA_KEY)
    expect(Object.keys(seen?.fields ?? {})).not.toContain('api_key')
    expect(openaiAdapter.readOutputs).toBeUndefined()
  })
})

describe('openai adapter: health and usage', () => {
  it('a project shows what it spent today and this month', async () => {
    const { ctx, calls } = harness([
      liveProject,
      { method: 'GET', path: /\/costs$/, body: fx('costs') }
    ])
    const h = await openaiAdapter.health?.(ctx, T.project, PROJ)
    expect(h?.status).toBe('ok')
    expect(h?.details).toMatchObject({
      cost_today: 0.46,
      cost_month_to_date: 2.19,
      currency: 'USD'
    })
    const costCall = calls.find((c) => c.path.endsWith('/costs'))
    expect(costCall?.search).toContain('project_ids[]=proj_test0001')
    expect(costCall?.search).toContain('bucket_width=1d')
  })

  it('costs that cannot be read leave the project ok with the reason; gone is down', async () => {
    const { ctx } = harness([
      liveProject,
      { method: 'GET', path: /\/costs$/, status: 403, body: fx('error-unauthorized') }
    ])
    const h = await openaiAdapter.health?.(ctx, T.project, PROJ)
    expect(h?.status).toBe('ok')
    expect(h?.message).toContain('costs could not be read')
    expect(h?.message).not.toContain(KEY)
    const { ctx: c2 } = harness([])
    expect((await openaiAdapter.health?.(c2, T.project, PROJ))?.status).toBe('down')
    expect((await openaiAdapter.health?.(c2, T.sa, SA))?.status).toBe('down')
  })

  it('usageNow answers one row per day and project, in cents, from the costs feed', async () => {
    const { ctx, calls } = harness([{ method: 'GET', path: /\/costs$/, body: fx('costs') }])
    const rows = await openaiAdapter.usageNow?.(ctx, {
      from: '2026-11-01T00:00:00Z',
      to: '2026-11-27T00:00:00Z'
    })
    expect(rows).toEqual([
      {
        date: '2026-11-01',
        amountCents: 173,
        currency: 'USD',
        externalId: PROJ,
        service: 'openai',
        recordType: 'usage'
      },
      {
        date: '2026-11-01',
        amountCents: 200,
        currency: 'USD',
        externalId: 'proj_test0002',
        service: 'openai',
        recordType: 'usage'
      },
      {
        date: '2026-11-26',
        amountCents: 46,
        currency: 'USD',
        externalId: PROJ,
        service: 'openai',
        recordType: 'usage'
      }
    ])
    expect(calls[0].search).toContain('group_by[]=project_id')
    expect(await openaiAdapter.usageNow?.(ctx, { from: 'x', to: 'y' })).toEqual([])
  })
})

describe('openai adapter: estimates', () => {
  beforeEach(() => ensureCoreProviders())

  it('estimate from recorded price answer: a service account is a known zero plus usage, never a made-up price', async () => {
    const { ctx } = harness([])
    const est = await spec(T.sa).estimate?.(ctx, desired(T.sa, { name: 'demo-env-prod' }), null)
    expect(est).toMatchObject({
      basis: 'usage',
      confidence: 'usage_varies',
      monthlyCents: 0,
      lines: []
    })
    expect(est?.note).toContain('plus usage')
    const del = await spec(T.sa).estimate?.(ctx, null, obs(T.sa, SA, { name: 'x' }))
    expect(del?.monthlyCents).toBe(0)
  })
})
