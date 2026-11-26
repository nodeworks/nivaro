import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeProviderContext } from '../../../services/hub/providers/context.js'
import { ensureCoreProviders } from '../../../services/hub/providers/index.js'
import { getProvider } from '../../../services/hub/providers/registry.js'
import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  ProviderError
} from '../../../services/hub/providers/types.js'
import { vercelAdapter } from '../../../services/hub/providers/vercel/index.js'

// Hub providers Task 8: the Vercel adapter against recorded (fake-valued) answers.

const FIX = join(import.meta.dirname, '../../../services/hub/providers/vercel/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const TOKEN = 'test-secret-token-0001'
const TEAM = 'team_test0000000000000000'
const PRJ = 'prj_test000000000000000001'
const NEW_VALUE = 'test-secret-env-value-9876'

interface Call {
  method: string
  path: string
  query: URLSearchParams
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

function harness(routes: Route[]) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const call: Call = {
      method: String(init?.method ?? 'GET'),
      path: u.pathname,
      query: u.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers ?? {}
    }
    calls.push(call)
    const hit = routes.find((r) => r.method === call.method && r.path.test(call.path))
    if (!hit) return new Response(JSON.stringify(fx('error-not-found')), { status: 404 })
    const status = hit.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(hit.body ?? {}), {
      status,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: vercelAdapter,
    connectionId: 1,
    config: { teamId: TEAM },
    secrets: { token: TOKEN },
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return { ctx, calls }
}

const noCalls = () => harness([])

function desired(type: string, fields: Record<string, unknown>, refs = {}): DesiredResource {
  return {
    resourceId: 7,
    type,
    externalId: null,
    scope: 'app',
    appId: 1,
    environmentId: 2,
    fields,
    refs,
    tags: {}
  }
}

const secret = (changed: boolean, plain?: string) => ({
  fingerprint: 'fp-test',
  changed,
  ...(plain ? { plain } : {})
})

describe('vercel adapter: registration', () => {
  it('is a core provider on api.vercel.com with a pinned team and a secret token', () => {
    ensureCoreProviders()
    expect(getProvider('vercel')).toBe(vercelAdapter)
    expect(vercelAdapter.connection.hosts({ teamId: TEAM })).toEqual(['api.vercel.com'])
    const token = vercelAdapter.connection.fields.find((f) => f.key === 'token')
    expect(token?.secret).toBe(true)
    expect(vercelAdapter.connection.fields.find((f) => f.key === 'teamId')?.secret).toBeFalsy()
    expect(vercelAdapter.connection.describe({ teamId: TEAM })).not.toContain(TOKEN)
    expect(vercelAdapter.connection.validate?.({ teamId: 'nope' }, {})).not.toEqual([])
    expect(vercelAdapter.types.map((t) => t.key)).toEqual([
      'vercel.project',
      'vercel.env_var',
      'vercel.domain',
      'vercel.deployment'
    ])
  })

  it('refuses a host other than api.vercel.com', async () => {
    const { ctx } = noCalls()
    await expect(ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
  })
})

describe('vercel adapter: testConnection', () => {
  it('lists missing permissions for a read-only team role', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/v2\/teams\//, body: fx('team-viewer') },
      { method: 'GET', path: /^\/v9\/projects$/, body: fx('projects') }
    ])
    const r = await vercelAdapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.identity).toContain('test-team')
    expect(r.permissions.some((p) => p.type === 'vercel.env_var' && !p.has)).toBe(true)
    expect(r.missing).toContain('write vercel.project (team role Developer or above)')
    expect(r.missing.some((m) => m.startsWith('read '))).toBe(false)
    // Every call is scoped to the pinned team and carries the bearer token.
    for (const c of calls) {
      expect(c.query.get('teamId')).toBe(TEAM)
      expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`)
    }
  })

  it('has no missing permission for a member who can read', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/v2\/teams\//, body: fx('team') },
      { method: 'GET', path: /^\/v9\/projects$/, body: fx('projects') }
    ])
    const r = await vercelAdapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
  })

  it('answers not ok when the token cannot see the team', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/v2\/teams\//, status: 403, body: fx('error-forbidden') }
    ])
    const r = await vercelAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.identity).toBeNull()
    expect(r.missing.length).toBe(r.permissions.length)
  })
})

describe('vercel adapter: observe', () => {
  it('maps project, env var (no value, even plain), domain and deployment fields', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/v9\/projects\/prj_[^/]+$/, body: fx('project') },
      { method: 'GET', path: /^\/v9\/projects\/prj_[^/]+\/env$/, body: fx('env-list') },
      {
        method: 'GET',
        path: /^\/v9\/projects\/prj_[^/]+\/domains\/app\.example\.com$/,
        body: fx('domain')
      },
      { method: 'GET', path: /^\/v13\/deployments\/dpl_/, body: fx('deployment-live') }
    ])
    const p = await vercelAdapter.observe(ctx, 'vercel.project', PRJ)
    expect(p?.fields).toMatchObject({
      name: 'web-app',
      framework: 'nextjs',
      rootDirectory: 'apps/web',
      installCommand: null,
      repoType: 'github',
      repo: 'acme/web-app'
    })
    const e = await vercelAdapter.observe(ctx, 'vercel.env_var', `${PRJ}/env_test0000000000000002`)
    expect(e?.fields).toEqual({
      project: PRJ,
      key: 'FEATURE_FLAG',
      type: 'plain',
      target: ['development'],
      gitBranch: null
    })
    expect(JSON.stringify(e)).not.toContain('plain-value-visible')
    const d = await vercelAdapter.observe(ctx, 'vercel.domain', `${PRJ}/app.example.com`)
    expect(d?.fields).toMatchObject({ project: PRJ, name: 'app.example.com', verified: true })
    const dep = await vercelAdapter.observe(ctx, 'vercel.deployment', 'dpl_test00000000000000002')
    expect(dep?.fields).toMatchObject({
      project: PRJ,
      state: 'READY',
      target: 'production',
      production: true,
      checks: 'succeeded'
    })
    expect(dep?.url).toBe('https://web-app-def456.vercel.app')
  })

  it('answers null for a project that is gone and treats a staged build as not live', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /^\/v13\/deployments\/dpl_test00000000000000001$/,
        body: fx('deployment-staged')
      }
    ])
    expect(await vercelAdapter.observe(ctx, 'vercel.project', 'prj_gone')).toBeNull()
    const staged = await vercelAdapter.observe(
      ctx,
      'vercel.deployment',
      'dpl_test00000000000000001'
    )
    expect(staged?.fields.production).toBe(false)
  })

  it('lists projects and pages by the provider cursor; children list per page of projects', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/v9\/projects$/, body: fx('projects-page1') },
      { method: 'GET', path: /^\/v9\/projects\/prj_[^/]+\/env$/, body: fx('env-list') },
      { method: 'GET', path: /^\/v9\/projects\/prj_[^/]+\/domains$/, body: fx('domains') },
      { method: 'GET', path: /^\/v6\/deployments$/, body: fx('deployments') }
    ])
    const projects = await vercelAdapter.list(ctx, 'vercel.project')
    expect(projects.items).toHaveLength(1)
    expect(projects.cursor).toBe('1767225500000')
    expect((await vercelAdapter.list(ctx, 'vercel.env_var')).items).toHaveLength(2)
    expect((await vercelAdapter.list(ctx, 'vercel.domain')).items[0].externalId).toBe(
      `${PRJ}/app.example.com`
    )
    expect((await vercelAdapter.list(ctx, 'vercel.deployment')).items[0].externalId).toBe(
      'dpl_test00000000000000002'
    )
  })
})

describe('vercel adapter: plan', () => {
  const { ctx } = noCalls()
  const observedProject = (): Observed => ({
    type: 'vercel.project',
    externalId: PRJ,
    name: 'web-app',
    fields: {
      name: 'web-app',
      framework: 'nextjs',
      rootDirectory: 'apps/web',
      buildCommand: 'pnpm build',
      installCommand: null,
      outputDirectory: null,
      nodeVersion: '22.x'
    },
    tags: {},
    version: '1'
  })
  const observedEnv = (): Observed => ({
    type: 'vercel.env_var',
    externalId: `${PRJ}/env_1`,
    name: 'API_URL',
    fields: {
      project: PRJ,
      key: 'API_URL',
      type: 'sensitive',
      target: ['production'],
      gitBranch: null
    },
    tags: {},
    version: '5'
  })

  it('project: create, update, delete, noop', () => {
    const want = {
      name: 'web-app',
      framework: 'nextjs',
      buildCommand: 'pnpm build',
      repoType: 'github',
      repo: 'acme/x'
    }
    const create = vercelAdapter.plan(ctx, desired('vercel.project', want), null)
    expect(create).toHaveLength(1)
    expect(create[0].kind).toBe('create')
    expect(create[0].changes.map((c) => c.field)).toEqual(
      expect.arrayContaining(['name', 'framework', 'repo'])
    )
    const update = vercelAdapter.plan(
      ctx,
      desired('vercel.project', { ...want, buildCommand: 'pnpm build:prod' }),
      observedProject()
    )
    expect(update[0].kind).toBe('update')
    expect(update[0].changes).toEqual([
      { field: 'buildCommand', from: 'pnpm build', to: 'pnpm build:prod' }
    ])
    expect(update[0].preconditions.buildCommand).toBe('pnpm build')
    expect(
      vercelAdapter.plan(
        ctx,
        desired('vercel.project', { name: 'web-app', framework: 'nextjs' }),
        observedProject()
      )
    ).toEqual([])
    const del = vercelAdapter.plan(ctx, null, observedProject())
    expect(del[0].kind).toBe('delete')
    expect(del[0].externalId).toBe(PRJ)
  })

  it('env var: secret compared by changed flag, never printed; type or project change replaces', () => {
    const base = { key: 'API_URL', type: 'sensitive', target: ['production'], gitBranch: null }
    const same = vercelAdapter.plan(
      ctx,
      desired('vercel.env_var', { ...base, value: secret(false) }, { project: PRJ }),
      observedEnv()
    )
    expect(same).toEqual([])
    const rotated = vercelAdapter.plan(
      ctx,
      desired('vercel.env_var', { ...base, value: secret(true) }, { project: PRJ }),
      observedEnv()
    )
    expect(rotated[0].kind).toBe('update')
    expect(rotated[0].changes).toEqual([{ field: 'value', secret: true }])
    const widened = vercelAdapter.plan(
      ctx,
      desired(
        'vercel.env_var',
        { ...base, target: ['production', 'preview'], value: secret(false) },
        { project: PRJ }
      ),
      observedEnv()
    )
    expect(widened[0].changes).toEqual([
      { field: 'target', from: ['production'], to: ['production', 'preview'] }
    ])
    const retyped = vercelAdapter.plan(
      ctx,
      desired('vercel.env_var', { ...base, type: 'plain', value: secret(true) }, { project: PRJ }),
      observedEnv()
    )
    expect(retyped[0].kind).toBe('replace')
    const create = vercelAdapter.plan(
      ctx,
      desired('vercel.env_var', { ...base, value: secret(true, NEW_VALUE) }, { project: PRJ }),
      null
    )
    expect(create[0].kind).toBe('create')
    expect(JSON.stringify([rotated, retyped, create])).not.toContain(NEW_VALUE)
    expect(vercelAdapter.plan(ctx, null, observedEnv())[0].kind).toBe('delete')
  })

  it('domain: create, redirect update, rename replaces, delete', () => {
    const observed: Observed = {
      type: 'vercel.domain',
      externalId: `${PRJ}/app.example.com`,
      name: 'app.example.com',
      fields: {
        project: PRJ,
        name: 'app.example.com',
        redirect: null,
        redirectStatusCode: null,
        gitBranch: null
      },
      tags: {},
      version: '1'
    }
    expect(
      vercelAdapter.plan(
        ctx,
        desired('vercel.domain', { name: 'app.example.com' }, { project: PRJ }),
        null
      )[0].kind
    ).toBe('create')
    const upd = vercelAdapter.plan(
      ctx,
      desired(
        'vercel.domain',
        { name: 'app.example.com', redirect: 'www.example.com', redirectStatusCode: '308' },
        { project: PRJ }
      ),
      observed
    )
    expect(upd[0].kind).toBe('update')
    expect(upd[0].changes.map((c) => c.field)).toEqual(['redirect', 'redirectStatusCode'])
    expect(
      vercelAdapter.plan(
        ctx,
        desired('vercel.domain', { name: 'other.example.com' }, { project: PRJ }),
        observed
      )[0].kind
    ).toBe('replace')
    expect(vercelAdapter.plan(ctx, null, observed)[0].kind).toBe('delete')
  })

  it('deployment: promote and rollback are named ops to the recorded id; live = noop; no create/delete', () => {
    const staged: Observed = {
      type: 'vercel.deployment',
      externalId: 'dpl_test00000000000000001',
      name: 'x',
      fields: {
        project: PRJ,
        state: 'READY',
        target: 'production',
        checks: 'succeeded',
        production: false
      },
      tags: {}
    }
    const promote = vercelAdapter.plan(
      ctx,
      desired('vercel.deployment', { mode: 'promote' }),
      staged
    )
    expect(promote[0]).toMatchObject({
      kind: 'update',
      action: 'promote',
      externalId: 'dpl_test00000000000000001',
      data: { deploymentId: 'dpl_test00000000000000001', projectId: PRJ }
    })
    const rollback = vercelAdapter.plan(
      ctx,
      desired('vercel.deployment', { mode: 'rollback' }),
      staged
    )
    expect(rollback[0].action).toBe('rollback')
    expect(
      vercelAdapter.plan(ctx, desired('vercel.deployment', { mode: 'promote' }), {
        ...staged,
        fields: { ...staged.fields, production: true }
      })
    ).toEqual([])
    expect(() => vercelAdapter.plan(ctx, desired('vercel.deployment', {}), null)).toThrow(
      ProviderError
    )
    expect(() => vercelAdapter.plan(ctx, null, staged)).toThrow(ProviderError)
  })
})

describe('vercel adapter: apply is idempotent (read before write)', () => {
  it('project create: exists -> no POST; missing -> POST /v11/projects', async () => {
    const want = desired('vercel.project', {
      name: 'web-app',
      framework: 'nextjs',
      repoType: 'github',
      repo: 'acme/web-app'
    })
    const op = {
      kind: 'create',
      type: 'vercel.project',
      resourceId: 7,
      externalId: null,
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    } as PlannedOp
    const have = harness([
      { method: 'GET', path: /^\/v9\/projects\/web-app$/, body: fx('project') }
    ])
    const a = await vercelAdapter.apply(have.ctx, op, want)
    expect(a.externalId).toBe(PRJ)
    expect(have.calls.some((c) => c.method === 'POST')).toBe(false)
    const fresh = harness([
      { method: 'POST', path: /^\/v11\/projects$/, status: 200, body: fx('project') }
    ])
    const b = await vercelAdapter.apply(fresh.ctx, op, want)
    expect(b.externalId).toBe(PRJ)
    const post = fresh.calls.find((c) => c.method === 'POST')
    expect(post?.body).toMatchObject({
      name: 'web-app',
      gitRepository: { type: 'github', repo: 'acme/web-app' }
    })
  })

  it('project delete: already gone -> no DELETE', async () => {
    const h = harness([])
    const r = await vercelAdapter.apply(
      h.ctx,
      {
        kind: 'delete',
        type: 'vercel.project',
        resourceId: 7,
        externalId: PRJ,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      null
    )
    expect(r.ok).toBe(true)
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('project update: already matching -> no PATCH', async () => {
    const h = harness([{ method: 'GET', path: /^\/v9\/projects\/prj_/, body: fx('project') }])
    const r = await vercelAdapter.apply(
      h.ctx,
      {
        kind: 'update',
        type: 'vercel.project',
        resourceId: 7,
        externalId: PRJ,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      desired('vercel.project', { name: 'web-app', buildCommand: 'pnpm build' })
    )
    expect(r.answer).toEqual({ already: 'matches' })
    expect(h.calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  it('env var create: a same key+target already there is patched, not duplicated; value goes only in the body', async () => {
    const want = desired(
      'vercel.env_var',
      {
        key: 'API_URL',
        type: 'sensitive',
        target: ['production'],
        gitBranch: null,
        value: secret(true, NEW_VALUE)
      },
      { project: PRJ }
    )
    const op = {
      kind: 'create',
      type: 'vercel.env_var',
      resourceId: 7,
      externalId: null,
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    } as PlannedOp
    const dup = harness([
      { method: 'GET', path: /\/env$/, body: fx('env-list') },
      { method: 'PATCH', path: /\/env\/env_test0000000000000001$/, body: {} }
    ])
    const a = await vercelAdapter.apply(dup.ctx, op, want)
    expect(a.externalId).toBe(`${PRJ}/env_test0000000000000001`)
    expect(dup.calls.some((c) => c.method === 'POST')).toBe(false)
    expect(dup.calls.find((c) => c.method === 'PATCH')?.body.value).toBe(NEW_VALUE)
    expect(JSON.stringify(a)).not.toContain(NEW_VALUE)

    const fresh = harness([
      { method: 'GET', path: /\/env$/, body: { envs: [] } },
      { method: 'POST', path: /\/v10\/projects\/prj_[^/]+\/env$/, body: fx('env-created') }
    ])
    const b = await vercelAdapter.apply(fresh.ctx, op, want)
    expect(b.externalId).toBe(`${PRJ}/env_test0000000000000009`)
    expect(JSON.stringify(b)).not.toContain(NEW_VALUE)
    expect(fresh.calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      key: 'API_URL',
      value: NEW_VALUE,
      target: ['production']
    })
  })

  it('env var update without a new value changes only target; delete of a missing one still ok', async () => {
    const h = harness([
      { method: 'GET', path: /\/env$/, body: fx('env-list') },
      { method: 'PATCH', path: /\/env\/env_test0000000000000001$/, body: {} }
    ])
    await vercelAdapter.apply(
      h.ctx,
      {
        kind: 'update',
        type: 'vercel.env_var',
        resourceId: 7,
        externalId: `${PRJ}/env_test0000000000000001`,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      desired(
        'vercel.env_var',
        {
          key: 'API_URL',
          type: 'sensitive',
          target: ['production'],
          gitBranch: null,
          value: secret(false)
        },
        { project: PRJ }
      )
    )
    // target already matches? production+preview observed vs production wanted -> a PATCH with target only.
    const patch = h.calls.find((c) => c.method === 'PATCH')
    expect(patch?.body).toEqual({ target: ['production'] })
    const gone = harness([])
    const r = await vercelAdapter.apply(
      gone.ctx,
      {
        kind: 'delete',
        type: 'vercel.env_var',
        resourceId: 7,
        externalId: `${PRJ}/env_x`,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      null
    )
    expect(r.ok).toBe(true)
  })

  it('domain create: already added -> no POST', async () => {
    const h = harness([
      { method: 'GET', path: /\/domains\/app\.example\.com$/, body: fx('domain') }
    ])
    const r = await vercelAdapter.apply(
      h.ctx,
      {
        kind: 'create',
        type: 'vercel.domain',
        resourceId: 7,
        externalId: null,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      desired('vercel.domain', { name: 'app.example.com' }, { project: PRJ })
    )
    expect(r.externalId).toBe(`${PRJ}/app.example.com`)
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('deployment promote posts once; already live -> no POST; rollback uses the rollback path', async () => {
    const op = (action: string): PlannedOp => ({
      kind: 'update',
      type: 'vercel.deployment',
      resourceId: 7,
      externalId: 'dpl_test00000000000000001',
      action,
      reason: '',
      changes: [],
      preconditions: {},
      risk: [],
      data: { projectId: PRJ }
    })
    const h = harness([
      {
        method: 'GET',
        path: /^\/v13\/deployments\/dpl_test00000000000000001$/,
        body: fx('deployment-staged')
      },
      { method: 'POST', path: /\/promote\//, status: 201, body: {} },
      { method: 'POST', path: /\/rollback\//, status: 201, body: {} }
    ])
    const r = await vercelAdapter.apply(
      h.ctx,
      op('promote'),
      desired('vercel.deployment', { mode: 'promote' })
    )
    expect(r.answer).toEqual({ requested: 'promote' })
    expect(h.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      `/v10/projects/${PRJ}/promote/dpl_test00000000000000001`
    ])
    await vercelAdapter.apply(
      h.ctx,
      op('rollback'),
      desired('vercel.deployment', { mode: 'rollback' })
    )
    expect(h.calls.filter((c) => c.method === 'POST').pop()?.path).toBe(
      `/v9/projects/${PRJ}/rollback/dpl_test00000000000000001`
    )
    const live = harness([
      { method: 'GET', path: /^\/v13\/deployments\//, body: fx('deployment-live') }
    ])
    const again = await vercelAdapter.apply(
      live.ctx,
      { ...op('promote'), externalId: 'dpl_test00000000000000002' },
      desired('vercel.deployment', { mode: 'promote' })
    )
    expect(again.answer).toEqual({ already: 'production' })
    expect(live.calls.some((c) => c.method === 'POST')).toBe(false)
  })
})

describe('vercel adapter: errors', () => {
  const projectOp: PlannedOp = {
    kind: 'delete',
    type: 'vercel.project',
    resourceId: 1,
    externalId: PRJ,
    reason: '',
    changes: [],
    preconditions: {},
    risk: []
  }

  it('maps 429 to retryable and scrubs the token the provider echoed', async () => {
    const h = harness([
      {
        method: 'GET',
        path: /^\/v9\/projects\//,
        status: 429,
        body: fx('error-rate-limited'),
        headers: { 'retry-after': '12' }
      }
    ])
    const err = await vercelAdapter.apply(h.ctx, projectOp, null).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.retryable).toBe(true)
    expect(err.status).toBe(429)
    expect(err.code).toBe('RATE_LIMITED')
    expect(err.message).toContain('retry after 12')
    expect(err.message).not.toContain(TOKEN)
  })

  it('maps 5xx to retryable, 403 and 404-on-write to not retryable', async () => {
    const five = harness([{ method: 'GET', path: /./, status: 503, body: {} }])
    expect((await vercelAdapter.apply(five.ctx, projectOp, null).catch((e) => e)).retryable).toBe(
      true
    )
    const forbidden = harness([
      { method: 'GET', path: /./, status: 403, body: fx('error-forbidden') }
    ])
    const e = await vercelAdapter.apply(forbidden.ctx, projectOp, null).catch((x) => x)
    expect(e.retryable).toBe(false)
    expect(e.code).toBe('FORBIDDEN')
  })

  it('a timeout is retryable and the call stays bounded', async () => {
    const ctx = makeProviderContext({
      adapter: vercelAdapter,
      connectionId: 2,
      config: { teamId: TEAM },
      secrets: { token: TOKEN },
      fetch: {
        timeoutMs: 20,
        fetchImpl: ((_u: string, init: any) =>
          new Promise((_res, rej) =>
            init.signal.addEventListener('abort', () => rej(new Error('x')))
          )) as any
      }
    })
    const err = await vercelAdapter.observe(ctx, 'vercel.project', PRJ).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.retryable).toBe(true)
  })

  it('secrets never appear in errors: the env value the provider echoes back is masked', async () => {
    const h = harness([
      { method: 'GET', path: /\/env$/, body: { envs: [] } },
      {
        method: 'POST',
        path: /\/env$/,
        status: 400,
        body: {
          error: { code: 'bad', message: `Invalid value ${NEW_VALUE} for key, token ${TOKEN}` }
        }
      }
    ])
    const err = await vercelAdapter
      .apply(
        h.ctx,
        {
          kind: 'create',
          type: 'vercel.env_var',
          resourceId: 7,
          externalId: null,
          reason: '',
          changes: [],
          preconditions: {},
          risk: []
        },
        desired(
          'vercel.env_var',
          { key: 'K', type: 'sensitive', target: ['production'], value: secret(true, NEW_VALUE) },
          { project: PRJ }
        )
      )
      .catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.message).not.toContain(NEW_VALUE)
    expect(err.message).not.toContain(TOKEN)
    expect(err.retryable).toBe(false)
  })

  it('a replace refuses before deleting when no new value is at hand', async () => {
    const h = harness([])
    const err = await vercelAdapter
      .apply(
        h.ctx,
        {
          kind: 'replace',
          type: 'vercel.env_var',
          resourceId: 7,
          externalId: `${PRJ}/env_1`,
          reason: '',
          changes: [],
          preconditions: {},
          risk: []
        },
        desired(
          'vercel.env_var',
          { key: 'K', type: 'plain', target: ['production'], value: secret(false) },
          { project: PRJ }
        )
      )
      .catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })
})

describe('vercel adapter: risk flags per type', () => {
  const spec = (k: string) => vercelAdapter.types.find((t) => t.key === k)!
  const op = (over: Partial<PlannedOp>): PlannedOp => ({
    kind: 'update',
    type: 'x',
    resourceId: 1,
    externalId: 'x',
    reason: '',
    changes: [],
    preconditions: {},
    risk: [],
    ...over
  })

  it('project delete is destructive + data_loss; create/update carry none', () => {
    expect(
      spec('vercel.project')
        .risk(op({ kind: 'delete' }), null)
        .sort()
    ).toEqual(['data_loss', 'destructive'])
    expect(spec('vercel.project').risk(op({ kind: 'create' }), null)).toEqual([])
    expect(spec('vercel.project').risk(op({ kind: 'update' }), null)).toEqual([])
  })

  it('env var: delete and replace are destructive; a value change is not', () => {
    expect(spec('vercel.env_var').risk(op({ kind: 'delete' }), null)).toEqual(['destructive'])
    expect(spec('vercel.env_var').risk(op({ kind: 'replace' }), null)).toEqual(['destructive'])
    expect(spec('vercel.env_var').risk(op({ kind: 'update' }), null)).toEqual([])
    const f = spec('vercel.env_var').reversible as (field: string) => boolean
    expect(f('value')).toBe(false)
    expect(f('target')).toBe(true)
  })

  it('domain: add is public_exposure; delete is destructive + downtime', () => {
    expect(spec('vercel.domain').risk(op({ kind: 'create' }), null)).toEqual(['public_exposure'])
    expect(
      spec('vercel.domain')
        .risk(op({ kind: 'delete' }), null)
        .sort()
    ).toEqual(['destructive', 'downtime'])
    expect(spec('vercel.domain').risk(op({ kind: 'update' }), null)).toEqual([])
  })

  it('deployment: promote/rollback is downtime only when the target build is not READY or its checks failed', () => {
    const dep = spec('vercel.deployment')
    const good = op({ action: 'promote', preconditions: { state: 'READY', checks: 'succeeded' } })
    expect(dep.risk(good, null)).toEqual([])
    expect(
      dep.risk(op({ action: 'rollback', preconditions: { state: 'READY', checks: null } }), null)
    ).toEqual([])
    expect(
      dep.risk(op({ action: 'promote', preconditions: { state: 'READY', checks: 'failed' } }), null)
    ).toEqual(['downtime'])
    expect(
      dep.risk(op({ action: 'promote', preconditions: { state: 'ERROR', checks: null } }), null)
    ).toEqual(['downtime'])
    expect(
      dep.risk(op({ action: 'rollback', preconditions: { state: 'BUILDING', checks: null } }), null)
    ).toEqual(['downtime'])
    expect(dep.capabilities.create).toBe(false)
    expect(dep.capabilities.delete).toBe(false)
  })
})

describe('vercel adapter: health', () => {
  it('reads a deployment build state', async () => {
    const live = harness([
      { method: 'GET', path: /^\/v13\/deployments\//, body: fx('deployment-live') }
    ])
    expect(
      (await vercelAdapter.health!(live.ctx, 'vercel.deployment', 'dpl_test00000000000000002'))
        .status
    ).toBe('ok')
    const failed = harness([
      { method: 'GET', path: /^\/v13\/deployments\//, body: fx('deployment-failed-checks') }
    ])
    expect(
      (await vercelAdapter.health!(failed.ctx, 'vercel.deployment', 'dpl_test00000000000000003'))
        .status
    ).toBe('warn')
    const gone = harness([])
    expect((await vercelAdapter.health!(gone.ctx, 'vercel.deployment', 'dpl_gone')).status).toBe(
      'down'
    )
  })
})
