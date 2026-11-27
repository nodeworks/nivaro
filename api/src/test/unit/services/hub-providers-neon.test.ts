import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 16: the Neon adapter against recorded (fake-valued) answers.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const { CORE_PROVIDERS, ensureCoreProviders } = await import(
  '../../../services/hub/providers/index.js'
)
const registry = await import('../../../services/hub/providers/registry.js')
const { neonAdapter } = await import('../../../services/hub/providers/neon/index.js')
const { waitOperations } = await import('../../../services/hub/providers/neon/client.js')

import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  ProviderError
} from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/neon/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const KEY = 'test-secret-neon-key-0001'
const ORG = 'org-test-acme-0001'
const PRJ = 'prj-test-cool-0001'
const MAIN = 'br-test-main-0001'
const STAGE = 'br-test-stage-0002'
const EP = 'ep-test-stage-0001'
const ROLE_PASS = 'test-secret-role-pass-7788'
const NEW_ROLE_PASS = 'test-secret-new-role-pass-5544'

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

function harness(routes: Route[], config: Record<string, unknown> = { orgId: ORG }) {
  const calls: Call[] = []
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const call: Call = {
      method: String(init?.method ?? 'GET'),
      path: u.pathname.replace(/^\/api\/v2/, ''),
      query: u.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers ?? {}
    }
    calls.push(call)
    const hit = routes.find((r) => r.method === call.method && r.path.test(call.path))
    if (!hit) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
    const status = hit.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(hit.body ?? {}), {
      status,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: neonAdapter,
    connectionId: 16,
    config,
    secrets: { apiKey: KEY },
    now: () => new Date('2026-11-26T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return { ctx, calls }
}

const noCalls = () => harness([])
const ops = (finished = true) => [
  { id: 'op-test-9', action: 'apply_config', status: finished ? 'finished' : 'running' }
]

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

const REFS = { project: PRJ, branch: `${PRJ}/${STAGE}` }
const typeOf = (key: string) => neonAdapter.types.find((t) => t.key === key)!

const PROJECT_ROUTES: Route[] = [
  { method: 'GET', path: new RegExp(`^/projects/${PRJ}$`), body: fx('project') }
]

beforeEach(() => {
  registry.resetProvidersForTest()
  ensureCoreProviders()
})

describe('neon adapter: registration', () => {
  it('is a core provider on console.neon.tech with a pinned organisation and a secret key', () => {
    expect(registry.getProvider('neon')).toBe(neonAdapter)
    expect(CORE_PROVIDERS).toContain(neonAdapter)
    expect(neonAdapter.connection.hosts({ orgId: ORG })).toEqual(['console.neon.tech'])
    expect(neonAdapter.connection.fields.find((f) => f.key === 'apiKey')?.secret).toBe(true)
    expect(neonAdapter.connection.fields.find((f) => f.key === 'orgId')?.secret).toBeFalsy()
    expect(neonAdapter.connection.describe({ orgId: ORG })).not.toContain(KEY)
    expect(neonAdapter.connection.validate?.({ orgId: 'nope' }, {})).not.toEqual([])
    expect(neonAdapter.connection.validate?.({ orgId: ORG }, { apiKey: KEY })).toEqual([])
    expect(neonAdapter.types.map((t) => t.key)).toEqual([
      'neon.project',
      'neon.branch',
      'neon.endpoint',
      'neon.database',
      'neon.role'
    ])
  })

  it('refuses a host other than console.neon.tech', async () => {
    const { ctx } = noCalls()
    await expect(ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
  })
})

describe('neon adapter: testConnection', () => {
  it('lists the missing permissions when the key cannot read the organisation', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/projects$/, status: 403, body: { message: 'no' } }
    ])
    const t = await neonAdapter.testConnection(ctx)
    expect(t.ok).toBe(false)
    expect(t.missing.length).toBe(neonAdapter.types.length * 2)
    expect(t.identity).toBeNull()
  })

  it('answers the organisation by name and says writes are assumed', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/projects$/, body: { projects: [] } },
      {
        method: 'GET',
        path: new RegExp(`^/organizations/${ORG}$`),
        body: { id: ORG, name: 'Acme' }
      }
    ])
    const t = await neonAdapter.testConnection(ctx)
    expect(t.ok).toBe(true)
    expect(t.identity).toBe('organization Acme')
    expect(t.missing).toEqual([])
    expect(calls[0].query.get('org_id')).toBe(ORG)
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(t.message).toContain('assumed')
  })
})

describe('neon adapter: observe', () => {
  it('maps a project and never reads past the pinned organisation', async () => {
    const { ctx } = harness(PROJECT_ROUTES)
    const o = (await neonAdapter.observe(ctx, 'neon.project', PRJ)) as Observed
    expect(o).toMatchObject({
      type: 'neon.project',
      externalId: PRJ,
      name: 'acme-api',
      fields: {
        name: 'acme-api',
        region: 'aws-us-east-2',
        pgVersion: '17',
        historyRetentionSeconds: 86400,
        plan: 'launch',
        storageGb: 2
      }
    })
    const other = harness([
      { method: 'GET', path: /^\/projects\/prj-test-other-0009$/, body: fx('project-other-org') }
    ])
    expect(await neonAdapter.observe(other.ctx, 'neon.project', 'prj-test-other-0009')).toBeNull()
  })

  it('maps a branch and an endpoint through their project; a foreign project hides its children', async () => {
    const { ctx } = harness([
      ...PROJECT_ROUTES,
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}$`),
        body: { branch: fx('branches').branches[1] }
      },
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/endpoints/${EP}$`),
        body: { endpoint: fx('endpoints').endpoints[0] }
      }
    ])
    const b = (await neonAdapter.observe(ctx, 'neon.branch', `${PRJ}/${STAGE}`)) as Observed
    expect(b.fields).toMatchObject({
      project: PRJ,
      name: 'staging',
      parent: MAIN,
      protected: false
    })
    expect(b.status).toBe('ready')
    const e = (await neonAdapter.observe(ctx, 'neon.endpoint', `${PRJ}/${EP}`)) as Observed
    expect(e.fields).toMatchObject({
      branch: `${PRJ}/${STAGE}`,
      type: 'read_write',
      minCu: 0.25,
      maxCu: 1,
      suspendTimeoutSeconds: 300,
      poolerEnabled: true
    })
    const foreign = harness([
      { method: 'GET', path: /^\/projects\/prj-test-other-0009$/, body: fx('project-other-org') },
      {
        method: 'GET',
        path: /^\/projects\/prj-test-other-0009\/branches\/br-x$/,
        body: { branch: { id: 'br-x', name: 'x' } }
      }
    ])
    expect(
      await neonAdapter.observe(foreign.ctx, 'neon.branch', 'prj-test-other-0009/br-x')
    ).toBeNull()
  })

  it('maps a database and a role without any password', async () => {
    const { ctx } = harness([
      ...PROJECT_ROUTES,
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}/databases/appdb$`),
        body: { database: fx('databases').databases[0] }
      },
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}/roles/app_owner$`),
        body: { role: { name: 'app_owner', password: NEW_ROLE_PASS, protected: false } }
      }
    ])
    const d = (await neonAdapter.observe(ctx, 'neon.database', `${PRJ}/${STAGE}/appdb`)) as Observed
    expect(d.fields).toMatchObject({ name: 'appdb', owner: 'app_owner', branch: `${PRJ}/${STAGE}` })
    const r = (await neonAdapter.observe(ctx, 'neon.role', `${PRJ}/${STAGE}/app_owner`)) as Observed
    expect(JSON.stringify(r)).not.toContain(NEW_ROLE_PASS)
    expect(r.fields.name).toBe('app_owner')
  })

  it('refuses an id with a path trick before any call', async () => {
    const { ctx, calls } = noCalls()
    for (const id of ['..', 'a/../b', '']) {
      await expect(neonAdapter.observe(ctx, 'neon.project', id)).rejects.toMatchObject({
        code: 'BAD_ID'
      })
    }
    await expect(neonAdapter.observe(ctx, 'neon.branch', `${PRJ}/..`)).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    expect(calls).toEqual([])
  })
})

describe('neon adapter: list', () => {
  it('drops a project of another organisation and pages with the cursor', async () => {
    const { ctx, calls } = harness([{ method: 'GET', path: /^\/projects$/, body: fx('projects') }])
    const page = await neonAdapter.list(ctx, 'neon.project', 'cursor-test-1')
    expect(page.items.map((i) => i.externalId)).toEqual([PRJ])
    expect(page.cursor).toBe('cursor-test-2')
    expect(calls[0].query.get('org_id')).toBe(ORG)
    expect(calls[0].query.get('cursor')).toBe('cursor-test-1')
  })

  it('lists branches and endpoints of each project of the page', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/projects$/, body: fx('projects') },
      { method: 'GET', path: new RegExp(`^/projects/${PRJ}/branches$`), body: fx('branches') },
      { method: 'GET', path: new RegExp(`^/projects/${PRJ}/endpoints$`), body: fx('endpoints') },
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}/databases$`),
        body: fx('databases')
      },
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/${MAIN}/databases$`),
        body: { databases: [] }
      }
    ])
    expect((await neonAdapter.list(ctx, 'neon.branch')).items.map((i) => i.name)).toEqual([
      'production',
      'staging'
    ])
    expect((await neonAdapter.list(ctx, 'neon.endpoint')).items).toHaveLength(1)
    expect((await neonAdapter.list(ctx, 'neon.database')).items.map((i) => i.externalId)).toEqual([
      `${PRJ}/${STAGE}/appdb`
    ])
  })
})

describe('neon adapter: plan', () => {
  const projectObserved = (over: Record<string, unknown> = {}): Observed => ({
    type: 'neon.project',
    externalId: PRJ,
    name: 'acme-api',
    fields: {
      name: 'acme-api',
      region: 'aws-us-east-2',
      pgVersion: '17',
      historyRetentionSeconds: 86400
    },
    tags: {},
    version: 'v1',
    ...over
  })

  it('diff per type: create, change, nothing, delete', () => {
    const ctx = noCalls().ctx
    const create = neonAdapter.plan(
      ctx,
      desired('neon.project', { name: 'acme-new', region: 'aws-us-east-2', pgVersion: '17' }),
      null
    )
    expect(create).toHaveLength(1)
    expect(create[0]).toMatchObject({ kind: 'create', type: 'neon.project' })
    expect(create[0].reason).toContain('Neon project acme-new')
    expect(create[0].changes.map((c) => c.field)).toEqual(['name', 'region', 'pgVersion'])

    const change = neonAdapter.plan(
      ctx,
      desired(
        'neon.project',
        { name: 'acme-api', region: 'aws-eu-central-1', historyRetentionSeconds: 3600 },
        {},
        PRJ
      ),
      projectObserved()
    )
    // Region is create-only: only the retention is a change.
    expect(change[0].changes.map((c) => c.field)).toEqual(['historyRetentionSeconds'])
    expect(change[0].reason).toContain('History retention (seconds)')
    expect(change[0].reason).not.toContain('historyRetentionSeconds')

    expect(
      neonAdapter.plan(
        ctx,
        desired('neon.project', { name: 'acme-api', historyRetentionSeconds: 86400 }, {}, PRJ),
        projectObserved()
      )
    ).toEqual([])
    const del = neonAdapter.plan(ctx, null, projectObserved())
    expect(del[0]).toMatchObject({ kind: 'delete', externalId: PRJ })
    expect(neonAdapter.plan(ctx, null, null)).toEqual([])
  })

  it('an endpoint size change, a database owner change and a role create are planned', () => {
    const ctx = noCalls().ctx
    const epObs: Observed = {
      type: 'neon.endpoint',
      externalId: `${PRJ}/${EP}`,
      name: EP,
      fields: {
        minCu: 0.25,
        maxCu: 1,
        suspendTimeoutSeconds: 300,
        poolerEnabled: true,
        type: 'read_write'
      },
      tags: {}
    }
    const up = neonAdapter.plan(
      ctx,
      desired(
        'neon.endpoint',
        {
          type: 'read_write',
          minCu: 0.5,
          maxCu: 2,
          suspendTimeoutSeconds: 300,
          poolerEnabled: true
        },
        REFS,
        `${PRJ}/${EP}`
      ),
      epObs
    )
    expect(up[0].changes.map((c) => c.field)).toEqual(['minCu', 'maxCu'])
    const dbObs: Observed = {
      type: 'neon.database',
      externalId: `${PRJ}/${STAGE}/appdb`,
      name: 'appdb',
      fields: { name: 'appdb', owner: 'app_owner' },
      tags: {}
    }
    const owner = neonAdapter.plan(
      ctx,
      desired('neon.database', { name: 'appdb', owner: 'other' }, REFS, dbObs.externalId),
      dbObs
    )
    expect(owner[0].changes).toEqual([{ field: 'owner', from: 'app_owner', to: 'other' }])
    const role = neonAdapter.plan(ctx, desired('neon.role', { name: 'svc' }, REFS), null)
    expect(role[0]).toMatchObject({ kind: 'create', type: 'neon.role' })
  })

  it('a reset trigger on an existing branch adds the named reset op; a create never does', () => {
    const ctx = noCalls().ctx
    const obs: Observed = {
      type: 'neon.branch',
      externalId: `${PRJ}/${STAGE}`,
      name: 'staging',
      fields: { name: 'staging', parent: MAIN, protected: false },
      tags: {}
    }
    const planned = neonAdapter.plan(
      ctx,
      desired(
        'neon.branch',
        { name: 'staging', protected: false, resetFromParent: true },
        REFS,
        obs.externalId
      ),
      obs
    )
    expect(planned).toHaveLength(1)
    expect(planned[0]).toMatchObject({ action: 'reset_from_parent', kind: 'update' })
    expect(planned[0].reason).toContain('lost')
    const created = neonAdapter.plan(
      ctx,
      desired('neon.branch', { name: 'x', resetFromParent: true }, REFS),
      null
    )
    expect(created).toHaveLength(1)
    expect(created[0].action).toBeUndefined()
  })
})

describe('neon adapter: risk flags per type', () => {
  const op = (
    kind: PlannedOp['kind'],
    type: string,
    extra: Partial<PlannedOp> = {}
  ): PlannedOp => ({
    kind,
    type,
    resourceId: 1,
    externalId: 'x',
    reason: '',
    changes: [],
    preconditions: {},
    risk: [],
    ...extra
  })

  it('project delete is destructive + data_loss; create is costed', () => {
    const t = typeOf('neon.project')
    expect(t.risk(op('delete', 'neon.project'), null)).toEqual(['destructive', 'data_loss'])
    expect(t.risk(op('create', 'neon.project'), desired('neon.project', {}))).toEqual([])
    expect(t.costClass?.(desired('neon.project', {}))).toBe('monthly')
  })

  it('branch reset is data_loss; delete is destructive + data_loss', () => {
    const t = typeOf('neon.branch')
    expect(t.risk(op('update', 'neon.branch', { action: 'reset_from_parent' }), null)).toEqual([
      'data_loss'
    ])
    expect(t.risk(op('delete', 'neon.branch'), null)).toEqual(['destructive', 'data_loss'])
  })

  it('endpoint size change is downtime; autosuspend alone is not; delete is destructive + downtime', () => {
    const t = typeOf('neon.endpoint')
    expect(
      t.risk(op('update', 'neon.endpoint', { changes: [{ field: 'minCu', from: 1, to: 2 }] }), null)
    ).toEqual(['downtime'])
    expect(
      t.risk(
        op('update', 'neon.endpoint', {
          changes: [{ field: 'suspendTimeoutSeconds', from: 300, to: 600 }]
        }),
        null
      )
    ).toEqual([])
    expect(t.risk(op('delete', 'neon.endpoint'), null)).toEqual(['destructive', 'downtime'])
  })

  it('database delete is destructive + data_loss; role delete is destructive', () => {
    expect(typeOf('neon.database').risk(op('delete', 'neon.database'), null)).toEqual([
      'destructive',
      'data_loss'
    ])
    expect(typeOf('neon.role').risk(op('delete', 'neon.role'), null)).toEqual(['destructive'])
    expect(typeOf('neon.role').risk(op('create', 'neon.role'), null)).toEqual([])
  })
})

describe('neon adapter: apply is idempotent (read-before-write)', () => {
  const createProject = (): PlannedOp => ({
    kind: 'create',
    type: 'neon.project',
    resourceId: 7,
    externalId: null,
    reason: '',
    changes: [],
    preconditions: {},
    risk: []
  })

  it('project create: a same-named project is refused ALREADY_EXISTS; a resumed run reuses it; missing -> POST in the pinned org', async () => {
    const found = harness([
      { method: 'GET', path: /^\/projects$/, body: { projects: [fx('project').project] } }
    ])
    const d = desired('neon.project', { name: 'acme-api', region: 'aws-us-east-2' })
    const refused = await neonAdapter.apply(found.ctx, createProject(), d).catch((e) => e)
    expect(refused).toBeInstanceOf(ProviderError)
    expect(refused.code).toBe('ALREADY_EXISTS')
    expect(refused.retryable).toBe(false)
    expect(found.calls.every((c) => c.method === 'GET')).toBe(true)

    const resumed = harness([
      { method: 'GET', path: /^\/projects$/, body: { projects: [fx('project').project] } }
    ])
    const again = await neonAdapter.apply(resumed.ctx, createProject(), { ...d, externalId: PRJ })
    expect(again).toMatchObject({ ok: true, externalId: PRJ })
    expect(resumed.calls.every((c) => c.method === 'GET')).toBe(true)

    const missing = harness([
      { method: 'GET', path: /^\/projects$/, body: { projects: [] } },
      { method: 'POST', path: /^\/projects$/, body: fx('project-created') },
      {
        method: 'GET',
        path: /^\/projects\/prj-test-new-0003$/,
        body: { project: fx('project-created').project }
      }
    ])
    const made = await neonAdapter.apply(missing.ctx, createProject(), {
      ...d,
      fields: { name: 'acme-new', region: 'aws-us-east-2', pgVersion: '17' }
    })
    expect(made.externalId).toBe('prj-test-new-0003')
    const post = missing.calls.find((c) => c.method === 'POST')!
    expect(post.body.project).toMatchObject({
      name: 'acme-new',
      region_id: 'aws-us-east-2',
      org_id: ORG,
      pg_version: 17
    })
    // The first role's password in Neon's answer is never kept.
    expect(JSON.stringify(made)).not.toContain('test-secret-first-role-pass')
  })

  it('project update: nothing to change sends no PATCH; a change sends only that field', async () => {
    const same = harness(PROJECT_ROUTES)
    const op: PlannedOp = {
      kind: 'update',
      type: 'neon.project',
      resourceId: 7,
      externalId: PRJ,
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    const r = await neonAdapter.apply(
      same.ctx,
      op,
      desired('neon.project', { name: 'acme-api', historyRetentionSeconds: 86400 }, {}, PRJ)
    )
    expect(r.answer).toEqual({ already: 'matches' })
    expect(same.calls.some((c) => c.method === 'PATCH')).toBe(false)
    const change = harness([
      ...PROJECT_ROUTES,
      {
        method: 'PATCH',
        path: new RegExp(`^/projects/${PRJ}$`),
        body: {
          project: { ...fx('project').project, history_retention_seconds: 3600 },
          operations: ops()
        }
      }
    ])
    await neonAdapter.apply(
      change.ctx,
      op,
      desired('neon.project', { name: 'acme-api', historyRetentionSeconds: 3600 }, {}, PRJ)
    )
    expect(change.calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      project: { history_retention_seconds: 3600 }
    })
  })

  it('delete of something already gone sends no DELETE', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: new RegExp(`^/projects/${PRJ}$`), status: 404, body: {} }
    ])
    const r = await neonAdapter.apply(
      ctx,
      {
        kind: 'delete',
        type: 'neon.project',
        resourceId: 7,
        externalId: PRJ,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      null
    )
    expect(r.answer).toEqual({ already: 'gone' })
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('a write on a project of another organisation is refused NEON_OUT_OF_ACCOUNT, nothing written', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/projects\/prj-test-other-0009$/, body: fx('project-other-org') }
    ])
    const op: PlannedOp = {
      kind: 'delete',
      type: 'neon.project',
      resourceId: 7,
      externalId: 'prj-test-other-0009',
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    const err = await neonAdapter.apply(ctx, op, null).catch((e) => e)
    expect(err.code).toBe('NEON_OUT_OF_ACCOUNT')
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('branch create: a same-named branch is refused; a missing one is POSTed under its parent without compute', async () => {
    const op: PlannedOp = {
      kind: 'create',
      type: 'neon.branch',
      resourceId: 7,
      externalId: null,
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    const taken = harness([
      ...PROJECT_ROUTES,
      { method: 'GET', path: new RegExp(`^/projects/${PRJ}/branches$`), body: fx('branches') }
    ])
    const err = await neonAdapter
      .apply(taken.ctx, op, desired('neon.branch', { name: 'staging' }, { project: PRJ }))
      .catch((e) => e)
    expect(err.code).toBe('ALREADY_EXISTS')
    const fresh = harness([
      ...PROJECT_ROUTES,
      { method: 'GET', path: new RegExp(`^/projects/${PRJ}/branches$`), body: fx('branches') },
      {
        method: 'POST',
        path: new RegExp(`^/projects/${PRJ}/branches$`),
        body: {
          branch: { id: 'br-test-dev-0003', name: 'dev', parent_id: MAIN },
          operations: ops()
        }
      },
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/br-test-dev-0003/databases$`),
        body: { databases: [] }
      }
    ])
    const r = await neonAdapter.apply(
      fresh.ctx,
      op,
      desired(
        'neon.branch',
        { name: 'dev', parent: 'production', protected: true },
        { project: PRJ }
      )
    )
    expect(r.externalId).toBe(`${PRJ}/br-test-dev-0003`)
    const post = fresh.calls.find((c) => c.method === 'POST')!
    expect(post.body).toEqual({ branch: { name: 'dev', parent_id: MAIN, protected: true } })
    expect(post.body.endpoints).toBeUndefined()
    // An unknown parent is refused before any write.
    const bad = harness([
      ...PROJECT_ROUTES,
      { method: 'GET', path: new RegExp(`^/projects/${PRJ}/branches$`), body: fx('branches') }
    ])
    const e2 = await neonAdapter
      .apply(bad.ctx, op, desired('neon.branch', { name: 'dev', parent: 'nope' }, { project: PRJ }))
      .catch((e) => e)
    expect(e2.code).toBe('INVALID_FIELDS')
  })

  it('endpoint create: one per branch and type; size range checked; POST carries the branch', async () => {
    const op: PlannedOp = {
      kind: 'create',
      type: 'neon.endpoint',
      resourceId: 7,
      externalId: null,
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    const taken = harness([
      ...PROJECT_ROUTES,
      { method: 'GET', path: new RegExp(`^/projects/${PRJ}/endpoints$`), body: fx('endpoints') }
    ])
    const err = await neonAdapter
      .apply(taken.ctx, op, desired('neon.endpoint', { type: 'read_write' }, REFS))
      .catch((e) => e)
    expect(err.code).toBe('ALREADY_EXISTS')
    const inverted = harness(PROJECT_ROUTES)
    const e2 = await neonAdapter
      .apply(inverted.ctx, op, desired('neon.endpoint', { minCu: 2, maxCu: 1 }, REFS))
      .catch((e) => e)
    expect(e2.code).toBe('INVALID_FIELDS')
    const fresh = harness([
      ...PROJECT_ROUTES,
      { method: 'GET', path: new RegExp(`^/projects/${PRJ}/endpoints$`), body: { endpoints: [] } },
      {
        method: 'POST',
        path: new RegExp(`^/projects/${PRJ}/endpoints$`),
        body: {
          endpoint: { ...fx('endpoints').endpoints[0], id: 'ep-test-new-0002' },
          operations: ops()
        }
      }
    ])
    const r = await neonAdapter.apply(
      fresh.ctx,
      op,
      desired(
        'neon.endpoint',
        { type: 'read_write', minCu: 0.5, maxCu: 2, suspendTimeoutSeconds: -1 },
        REFS
      )
    )
    expect(r.externalId).toBe(`${PRJ}/ep-test-new-0002`)
    expect(fresh.calls.find((c) => c.method === 'POST')!.body.endpoint).toEqual({
      branch_id: STAGE,
      type: 'read_write',
      autoscaling_limit_min_cu: 0.5,
      autoscaling_limit_max_cu: 2,
      suspend_timeout_seconds: -1
    })
  })

  it('a child whose branch ref lives in another project is refused PROJECT_MISMATCH', async () => {
    const op: PlannedOp = {
      kind: 'create',
      type: 'neon.database',
      resourceId: 7,
      externalId: null,
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    const { ctx, calls } = harness(PROJECT_ROUTES)
    const err = await neonAdapter
      .apply(
        ctx,
        op,
        desired(
          'neon.database',
          { name: 'x', owner: 'o' },
          { project: PRJ, branch: 'prj-test-other-0009/br-x' }
        )
      )
      .catch((e) => e)
    expect(err.code).toBe('PROJECT_MISMATCH')
    expect(calls).toEqual([])
  })

  it('database create reads first; a name taken is refused; owner change PATCHes', async () => {
    const op: PlannedOp = {
      kind: 'create',
      type: 'neon.database',
      resourceId: 7,
      externalId: null,
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    const taken = harness([
      ...PROJECT_ROUTES,
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}/databases/appdb$`),
        body: { database: fx('databases').databases[0] }
      }
    ])
    const err = await neonAdapter
      .apply(taken.ctx, op, desired('neon.database', { name: 'appdb', owner: 'app_owner' }, REFS))
      .catch((e) => e)
    expect(err.code).toBe('ALREADY_EXISTS')
    const upd = harness([
      ...PROJECT_ROUTES,
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}/databases/appdb$`),
        body: { database: fx('databases').databases[0] }
      },
      {
        method: 'PATCH',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}/databases/appdb$`),
        body: { database: { name: 'appdb', owner_name: 'other' }, operations: ops() }
      }
    ])
    await neonAdapter.apply(
      upd.ctx,
      { ...op, kind: 'update', externalId: `${PRJ}/${STAGE}/appdb` },
      desired('neon.database', { name: 'appdb', owner: 'other' }, REFS, `${PRJ}/${STAGE}/appdb`)
    )
    expect(upd.calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      database: { owner_name: 'other' }
    })
  })
})

describe('neon adapter: named op and branch delete', () => {
  const reset = (externalId = `${PRJ}/${STAGE}`): PlannedOp => ({
    kind: 'update',
    type: 'neon.branch',
    resourceId: 7,
    externalId,
    reason: '',
    changes: [],
    preconditions: {},
    risk: [],
    action: 'reset_from_parent'
  })
  const branchRoutes: Route[] = [
    ...PROJECT_ROUTES,
    { method: 'GET', path: new RegExp(`^/projects/${PRJ}/branches$`), body: fx('branches') },
    {
      method: 'GET',
      path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}$`),
      body: { branch: fx('branches').branches[1] }
    }
  ]

  it('reset from parent restores the parent branch over this one', async () => {
    const { ctx, calls } = harness([
      ...branchRoutes,
      {
        method: 'POST',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}/restore$`),
        body: { branch: fx('branches').branches[1], operations: ops() }
      }
    ])
    const r = await neonAdapter.apply(
      ctx,
      reset(),
      desired('neon.branch', { name: 'staging', resetFromParent: true }, REFS, `${PRJ}/${STAGE}`)
    )
    expect(r.answer).toEqual({ reset: true })
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ source_branch_id: MAIN })
  })

  it('refuses a target that is not this resource, a foreign project and a branch with no parent', async () => {
    const { ctx, calls } = harness(branchRoutes)
    const d = desired(
      'neon.branch',
      { name: 'staging', resetFromParent: true },
      REFS,
      `${PRJ}/${STAGE}`
    )
    expect(
      (await neonAdapter.apply(ctx, reset(`${PRJ}/br-other-0007`), d).catch((e) => e)).code
    ).toBe('TARGET_MISMATCH')
    expect((await neonAdapter.apply(ctx, reset('prj-other/br-x'), d).catch((e) => e)).code).toBe(
      'PROJECT_MISMATCH'
    )
    const root = harness([
      ...PROJECT_ROUTES,
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/${MAIN}$`),
        body: { branch: fx('branches').branches[0] }
      }
    ])
    const dm = desired(
      'neon.branch',
      { name: 'production', resetFromParent: true },
      REFS,
      `${PRJ}/${MAIN}`
    )
    expect(
      (await neonAdapter.apply(root.ctx, reset(`${PRJ}/${MAIN}`), dm).catch((e) => e)).code
    ).toBe('NO_PARENT')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    expect(root.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('there is no snapshot before a branch delete (a child branch would block its own parent)', () => {
    expect(typeOf('neon.branch').capabilities.snapshot).toBe(false)
    expect(typeOf('neon.branch').reversible).toBe(false)
    expect(neonAdapter.snapshot).toBeUndefined()
  })

  it('plan time: a delete says the data cannot come back and is blocked while the branch has children', async () => {
    const ctx = noCalls().ctx
    const seen = (await neonAdapter.observe(
      harness([
        ...PROJECT_ROUTES,
        {
          method: 'GET',
          path: new RegExp(`^/projects/${PRJ}/branches/${MAIN}$`),
          body: { branch: fx('branches').branches[0] }
        },
        { method: 'GET', path: new RegExp(`^/projects/${PRJ}/branches$`), body: fx('branches') }
      ]).ctx,
      'neon.branch',
      `${PRJ}/${MAIN}`
    )) as Observed
    expect(seen.fields.children).toBe(1)
    const blocked = neonAdapter.plan(ctx, null, seen)
    expect(blocked[0].reason).toContain('cannot bring its data back')
    expect(blocked[0].data?.$blocker).toMatchObject({ code: 'BRANCH_HAS_CHILDREN' })
    const leaf = neonAdapter.plan(ctx, null, { ...seen, fields: { ...seen.fields, children: 0 } })
    expect(leaf[0].kind).toBe('delete')
    expect(leaf[0].data?.$blocker).toBeUndefined()
    expect(typeOf('neon.branch').risk(leaf[0], null)).toEqual(['destructive', 'data_loss'])
  })

  it("apply refuses a delete while children exist (BRANCH_HAS_CHILDREN, no DELETE); maps Neon's own refusal; the primary is refused", async () => {
    const del: PlannedOp = {
      kind: 'delete',
      type: 'neon.branch',
      resourceId: 7,
      externalId: `${PRJ}/${STAGE}`,
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    const withChild = {
      branches: [
        ...fx('branches').branches,
        { id: 'br-test-dev-0003', name: 'dev', parent_id: STAGE, default: false }
      ]
    }
    const kids = harness([
      { method: 'GET', path: new RegExp(`^/projects/${PRJ}/branches$`), body: withChild },
      ...branchRoutes
    ])
    expect((await neonAdapter.apply(kids.ctx, del, null).catch((e) => e)).code).toBe(
      'BRANCH_HAS_CHILDREN'
    )
    expect(kids.calls.some((c) => c.method === 'DELETE')).toBe(false)
    const theirs = harness([
      ...branchRoutes,
      {
        method: 'DELETE',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}$`),
        status: 422,
        body: { message: 'branch has child branches' }
      }
    ])
    expect((await neonAdapter.apply(theirs.ctx, del, null).catch((e) => e)).code).toBe(
      'BRANCH_HAS_CHILDREN'
    )
    const clean = harness([
      ...branchRoutes,
      {
        method: 'DELETE',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}$`),
        body: { operations: ops() }
      }
    ])
    expect((await neonAdapter.apply(clean.ctx, del, null)).ok).toBe(true)
    const primary = harness([
      ...PROJECT_ROUTES,
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/${MAIN}$`),
        body: { branch: fx('branches').branches[0] }
      }
    ])
    expect(
      (
        await neonAdapter
          .apply(primary.ctx, { ...del, externalId: `${PRJ}/${MAIN}` }, null)
          .catch((e) => e)
      ).code
    ).toBe('PRIMARY_BRANCH')
    expect(primary.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })
})

describe('neon adapter: failures', () => {
  it('maps 429 to retryable and scrubs the key from the text', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}$`),
        status: 429,
        body: fx('error-rate-limited'),
        headers: { 'retry-after': '7' }
      }
    ])
    const err = await neonAdapter.observe(ctx, 'neon.project', PRJ).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true, status: 429 })
    expect(err.message).toContain('retry after 7 s')
    expect(err.message).not.toContain(KEY)
  })

  it('a locked project (423) and a 5xx are retryable; a 400 is not', async () => {
    for (const [status, code, retryable] of [
      [423, 'PROJECT_BUSY', true],
      [503, 'PROVIDER_UNAVAILABLE', true],
      [400, 'PROVIDER_REJECTED', false]
    ] as const) {
      const { ctx } = harness([
        { method: 'GET', path: new RegExp(`^/projects/${PRJ}$`), status, body: { message: 'x' } }
      ])
      const err = await neonAdapter.observe(ctx, 'neon.project', PRJ).catch((e) => e)
      expect(err).toMatchObject({ code, retryable })
    }
  })

  it('secrets never appear in errors: a timeout, a failed operation and a bad answer', async () => {
    const slow = makeProviderContext({
      adapter: neonAdapter,
      connectionId: 16,
      config: { orgId: ORG },
      secrets: { apiKey: KEY },
      fetch: {
        fetchImpl: (async () => {
          throw new Error(`connect failed with ${KEY}`)
        }) as any
      }
    })
    const err = await neonAdapter.observe(slow, 'neon.project', PRJ).catch((e) => e)
    expect(String(err?.message ?? err)).not.toContain(KEY)
    const failedOp = harness([
      {
        method: 'GET',
        path: /^\/projects\/prj-test-cool-0001\/operations\/op-x$/,
        body: { operation: { status: 'failed' } }
      }
    ])
    const e2 = await waitOperations(failedOp.ctx, PRJ, [
      { id: 'op-x', action: 'start_compute', status: 'running' }
    ]).catch((e) => e)
    expect(e2.code).toBe('OPERATION_FAILED')
    expect(e2.message).not.toContain(KEY)
  })

  it('waits for a running operation until it finishes; gives up retryably', async () => {
    let n = 0
    const { ctx } = harness([
      {
        method: 'GET',
        path: /^\/projects\/prj-test-cool-0001\/operations\/op-y$/,
        get body() {
          n++
          return { operation: { status: n < 2 ? 'running' : 'finished' } }
        }
      } as Route
    ])
    await waitOperations(ctx, PRJ, [{ id: 'op-y', action: 'start_compute', status: 'running' }], {
      pollMs: 5
    })
    expect(n).toBe(2)
    const stuck = harness([
      {
        method: 'GET',
        path: /^\/projects\/prj-test-cool-0001\/operations\/op-z$/,
        body: { operation: { status: 'running' } }
      }
    ])
    const err = await waitOperations(stuck.ctx, PRJ, [{ id: 'op-z', status: 'running' }], {
      pollMs: 1,
      tries: 3
    }).catch((e) => e)
    expect(err).toMatchObject({ code: 'OPERATION_TIMEOUT', retryable: true })
  })
})

describe('neon adapter: declares outputs and none leak into observed/desired', () => {
  it('declares outputs per type with secrets marked and none once-only', () => {
    const keys = (t: string) => typeOf(t).outputs?.map((o) => o.key)
    expect(keys('neon.branch')).toEqual(['database_url', 'host', 'database', 'user', 'password'])
    expect(keys('neon.database')).toEqual(['database_url', 'host', 'database', 'user', 'password'])
    expect(keys('neon.role')).toEqual(['user', 'password'])
    expect(keys('neon.project')).toBeUndefined()
    for (const t of neonAdapter.types)
      for (const o of t.outputs ?? []) {
        expect(o.secret).toBe(['database_url', 'password'].includes(o.key))
        expect(o.onceOnly).toBeFalsy()
      }
    expect(neonAdapter.types.some((t) => t.sends)).toBe(false)
    expect(neonAdapter.notify).toBeUndefined()
  })

  it('a role create hands the password only in outputs', async () => {
    const op: PlannedOp = {
      kind: 'create',
      type: 'neon.role',
      resourceId: 7,
      externalId: null,
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    const { ctx } = harness([
      ...PROJECT_ROUTES,
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}/roles/svc$`),
        status: 404,
        body: {}
      },
      {
        method: 'POST',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}/roles$`),
        body: { role: { name: 'svc', password: NEW_ROLE_PASS }, operations: ops() }
      }
    ])
    const r = await neonAdapter.apply(ctx, op, desired('neon.role', { name: 'svc' }, REFS))
    expect(r.outputs).toEqual({ user: 'svc', password: NEW_ROLE_PASS })
    const { outputs, ...rest } = r
    expect(JSON.stringify(rest)).not.toContain(NEW_ROLE_PASS)
  })

  it('a database create gives its five outputs from the pooled address; observed holds none', async () => {
    const op: PlannedOp = {
      kind: 'create',
      type: 'neon.database',
      resourceId: 7,
      externalId: null,
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    // Not there yet at the first read, there at the output read.
    let reads = 0
    const { ctx, calls } = harness([
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}/databases/appdb$`),
        get status() {
          reads++
          return reads === 1 ? 404 : 200
        },
        get body() {
          return reads === 1 ? {} : { database: fx('databases').databases[0] }
        }
      } as Route,
      ...PROJECT_ROUTES,
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/connection_uri$`),
        body: fx('connection-uri')
      },
      {
        method: 'POST',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}/databases$`),
        body: { database: fx('databases').databases[0], operations: ops() }
      }
    ])
    const r = await neonAdapter.apply(
      ctx,
      op,
      desired('neon.database', { name: 'appdb', owner: 'app_owner' }, REFS)
    )
    expect(r.outputs).toMatchObject({
      host: 'ep-test-stage-0001-pooler.us-east-2.example',
      database: 'appdb',
      user: 'app_owner',
      password: ROLE_PASS
    })
    expect(r.outputs?.database_url).toContain('/appdb?sslmode=require')
    const uri = calls.find((c) => c.path.endsWith('/connection_uri'))!
    expect(uri.query.get('pooled')).toBe('true')
    expect(uri.query.get('database_name')).toBe('appdb')
    expect(uri.query.get('role_name')).toBe('app_owner')
    const { outputs, ...rest } = r
    expect(JSON.stringify(rest)).not.toContain(ROLE_PASS)
  })

  it('a failed output read does not fail the create (the engine re-reads later)', async () => {
    const op: PlannedOp = {
      kind: 'create',
      type: 'neon.branch',
      resourceId: 7,
      externalId: null,
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    const { ctx } = harness([
      ...PROJECT_ROUTES,
      { method: 'GET', path: new RegExp(`^/projects/${PRJ}/branches$`), body: { branches: [] } },
      {
        method: 'POST',
        path: new RegExp(`^/projects/${PRJ}/branches$`),
        body: { branch: { id: 'br-test-dev-0003', name: 'dev' }, operations: ops() }
      },
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/br-test-dev-0003/databases$`),
        status: 503,
        body: {}
      }
    ])
    const r = await neonAdapter.apply(
      ctx,
      op,
      desired('neon.branch', { name: 'dev' }, { project: PRJ })
    )
    expect(r.ok).toBe(true)
    expect(r.outputs).toBeUndefined()
  })

  it('readOutputs re-reads a branch, a database and a role', async () => {
    const { ctx } = harness([
      ...PROJECT_ROUTES,
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}/databases$`),
        body: fx('databases')
      },
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}/databases/appdb$`),
        body: { database: fx('databases').databases[0] }
      },
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/connection_uri$`),
        body: fx('connection-uri')
      },
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}/branches/${STAGE}/roles/svc/reveal_password$`),
        body: { password: NEW_ROLE_PASS }
      }
    ])
    const branch = await neonAdapter.readOutputs!(ctx, 'neon.branch', `${PRJ}/${STAGE}`)
    expect(Object.keys(branch).sort()).toEqual([
      'database',
      'database_url',
      'host',
      'password',
      'user'
    ])
    expect(
      (await neonAdapter.readOutputs!(ctx, 'neon.database', `${PRJ}/${STAGE}/appdb`)).user
    ).toBe('app_owner')
    expect(await neonAdapter.readOutputs!(ctx, 'neon.role', `${PRJ}/${STAGE}/svc`)).toEqual({
      user: 'svc',
      password: NEW_ROLE_PASS
    })
    const foreign = harness([
      { method: 'GET', path: /^\/projects\/prj-test-other-0009$/, body: fx('project-other-org') }
    ])
    await expect(
      neonAdapter.readOutputs!(foreign.ctx, 'neon.role', 'prj-test-other-0009/br-x/svc')
    ).rejects.toMatchObject({
      code: 'NEON_OUT_OF_ACCOUNT'
    })
  })
})

describe('neon adapter: estimates', () => {
  const plan = (sub: string | null) =>
    harness([
      {
        method: 'GET',
        path: new RegExp(`^/projects/${PRJ}$`),
        status: sub ? 200 : 404,
        body: sub
          ? { project: { ...fx('project').project, owner: { subscription_type: sub } } }
          : {}
      },
      {
        method: 'GET',
        path: /^\/projects$/,
        body: { projects: [{ ...fx('project').project, owner: { subscription_type: sub } }] }
      }
    ]).ctx

  it('estimate from recorded price answer: a project is its storage plus usage, with the prices in the note', async () => {
    const obs = (await neonAdapter.observe(
      harness(PROJECT_ROUTES).ctx,
      'neon.project',
      PRJ
    )) as Observed
    const e = await typeOf('neon.project').estimate!(
      plan('launch'),
      desired('neon.project', {}, {}, PRJ),
      obs
    )
    expect(e).toMatchObject({ basis: 'usage', confidence: 'usage_varies', priceAsOf: '2026-11-26' })
    expect(e.lines).toHaveLength(1)
    expect(e.lines[0]).toMatchObject({ unit: 'GB-month', qty: 2, unitCents: 35, monthlyCents: 70 })
    expect(e.monthlyCents).toBe(70)
    expect(e.note).toContain('$0.106 per CU-hour')
    expect(e.note).toContain('$5.00 monthly minimum')
  })

  it('an endpoint that never suspends is a known figure at its minimum size; one that suspends is usage', async () => {
    const ep = (suspend: number) =>
      desired('neon.endpoint', { minCu: 1, maxCu: 2, suspendTimeoutSeconds: suspend }, REFS)
    const always = await typeOf('neon.endpoint').estimate!(plan('launch'), ep(-1), null)
    expect(always).toMatchObject({ basis: 'price_list', confidence: 'list_price' })
    expect(always.lines[0]).toMatchObject({
      unit: 'CU-hour',
      qty: 730,
      unitCents: 10.6,
      monthlyCents: 7738
    })
    expect(always.monthlyCents).toBe(7738)
    const idle = await typeOf('neon.endpoint').estimate!(plan('launch'), ep(300), null)
    expect(idle).toMatchObject({ basis: 'usage', confidence: 'usage_varies', monthlyCents: 0 })
    expect(idle.note).toContain('about $77.38 a month')
    const scale = await typeOf('neon.endpoint').estimate!(plan('scale'), ep(-1), null)
    expect(scale.lines[0].unitCents).toBe(22.2)
  })

  it('the free plan is no charge; an unreadable or contract plan is unknown; never throws', async () => {
    const free = await typeOf('neon.project').estimate!(plan('free_v2'), null, null)
    expect(free).toMatchObject({ basis: 'plan_price', confidence: 'exact', monthlyCents: 0 })
    const gone = harness([{ method: 'GET', path: /^\/projects/, status: 500, body: {} }]).ctx
    expect((await typeOf('neon.endpoint').estimate!(gone, null, null)).confidence).toBe('unknown')
    expect(
      (await typeOf('neon.project').estimate!(plan('enterprise'), null, null)).confidence
    ).toBe('unknown')
  })

  it('bundled fallback names its date', async () => {
    expect(neonAdapter.bundledPrices?.asOf).toBe('2026-11-26')
    const e = await typeOf('neon.endpoint').estimate!(
      plan('launch'),
      desired('neon.endpoint', {}, REFS),
      null
    )
    expect(e.priceAsOf).toBe(neonAdapter.bundledPrices?.asOf)
  })
})
