import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeProviderContext } from '../../../services/hub/providers/context.js'
import { ensureCoreProviders } from '../../../services/hub/providers/index.js'
import { getProvider } from '../../../services/hub/providers/registry.js'
import { snykFindingsFor } from '../../../services/hub/providers/snyk/findings.js'
import {
  normExpires,
  readSnykFindings,
  snykAdapter
} from '../../../services/hub/providers/snyk/index.js'
import type { DesiredResource, Observed, PlannedOp } from '../../../services/hub/providers/types.js'

// Hub providers Task 41: the Snyk adapter against recorded (fake-valued) answers.

const FIX = join(import.meta.dirname, '../../../services/hub/providers/snyk/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const TOKEN = 'test-secret-snyk-token-0001'
const ORG = '11111111-1111-4111-8111-111111111111'
const GH = '22222222-2222-4222-8222-222222222222'
const GL = '22222222-2222-4222-8222-333333333333'
const TARGET = '33333333-3333-4333-8333-333333333333'
const PROJECT = '44444444-4444-4444-8444-444444444444'
const PROJECT2 = '44444444-4444-4444-8444-555555555555'
const JOB = '55555555-5555-4555-8555-555555555555'
const NOW = new Date('2026-11-26T12:00:00.000Z')

interface Call {
  method: string
  host: string
  path: string
  query: URLSearchParams
  body: any
  headers: Record<string, string>
}
interface Route {
  method: string
  host?: string
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
      host: u.host,
      path: u.pathname,
      query: u.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers ?? {}
    }
    calls.push(call)
    const hit = routes.find(
      (r) => r.method === call.method && r.path.test(call.path) && (!r.host || r.host === call.host)
    )
    if (!hit) return new Response(JSON.stringify(fx('error-forbidden')), { status: 404 })
    const status = hit.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(hit.body ?? {}), {
      status,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: snykAdapter,
    connectionId: 1,
    config: { host: 'api.snyk.io', organization: ORG, ...config },
    secrets: { token: TOKEN },
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 },
    now: () => NOW
  })
  return { ctx, calls }
}

const noCalls = () => harness([])
const writes = (calls: Call[]) =>
  calls.filter((c) => c.method !== 'GET' && !/aggregated|\/projects$/.test(c.path))

function desired(
  type: string,
  fields: Record<string, unknown>,
  refs: DesiredResource['refs'] = {},
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

const TARGET_T = 'snyk.target'
const PROJECT_T = 'snyk.project'
const IGNORE_T = 'snyk.ignore'
const INTEGRATION_T = 'snyk.integration'

const o = (v: Partial<PlannedOp> & { type: string; kind: PlannedOp['kind'] }): PlannedOp => ({
  resourceId: 7,
  externalId: null,
  reason: '',
  changes: [],
  preconditions: {},
  risk: [],
  ...v
})

const orgRe = `/org/${ORG}`
const common: Route[] = [
  { method: 'GET', path: new RegExp(`^/v1${orgRe}/integrations$`), body: fx('integrations') },
  { method: 'GET', path: new RegExp(`^/rest/orgs/${ORG}/targets$`), body: fx('targets') },
  { method: 'GET', path: new RegExp(`^/rest/orgs/${ORG}/targets/${TARGET}$`), body: fx('target') }
]

describe('snyk adapter: registration', () => {
  it('is a core provider pinned to one organization on a regional host', () => {
    ensureCoreProviders()
    expect(getProvider('snyk')).toBe(snykAdapter)
    expect(snykAdapter.connection.hosts({ host: 'api.eu.snyk.io' })).toEqual(['api.eu.snyk.io'])
    expect(snykAdapter.connection.hosts({})).toEqual(['api.snyk.io'])
    // A host that is not one of the three is never called.
    expect(snykAdapter.connection.hosts({ host: 'evil.example.test' })).toEqual(['api.snyk.io'])
    expect(snykAdapter.connection.fields.find((f) => f.key === 'token')?.secret).toBe(true)
    expect(
      snykAdapter.connection.describe({ host: 'api.snyk.io', organization: ORG })
    ).not.toContain(TOKEN)
    expect(snykAdapter.types.map((t) => t.key)).toEqual([
      INTEGRATION_T,
      TARGET_T,
      PROJECT_T,
      IGNORE_T
    ])
    expect(snykAdapter.types.find((t) => t.key === INTEGRATION_T)?.scope).toBe('shared')
    // Not billed per resource, and nothing is handed out.
    for (const t of snykAdapter.types) {
      expect(t.costClass).toBeUndefined()
      expect(t.outputs).toBeUndefined()
      expect(t.sends).toBeUndefined()
    }
  })

  it('validates the region and the organization id', () => {
    const v = snykAdapter.connection.validate
    expect(v?.({ host: 'api.snyk.io', organization: ORG }, { token: TOKEN })).toEqual([])
    expect(v?.({ host: 'api.snyk.io.evil.test', organization: ORG }, {})).not.toEqual([])
    expect(v?.({ host: 'api.snyk.io', organization: 'not-a-uuid' }, {})).not.toEqual([])
    expect(v?.({ host: 'api.snyk.io', organization: ORG }, { token: ' ' })).not.toEqual([])
  })

  it('refuses a host other than the connection’s own and sends the token header', async () => {
    const a = noCalls()
    await expect(a.ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
    const { ctx, calls } = harness(common, { host: 'api.au.snyk.io' })
    await snykAdapter.observe(ctx, INTEGRATION_T, GH)
    expect(calls[0]?.host).toBe('api.au.snyk.io')
    expect(calls[0]?.headers.authorization).toBe(`token ${TOKEN}`)
  })
})

describe('snyk adapter: testConnection', () => {
  it('lists missing permissions when the token cannot read', async () => {
    const { ctx } = harness([
      { method: 'GET', path: new RegExp(`^/rest/orgs/${ORG}$`), body: fx('org') },
      { method: 'GET', path: new RegExp(`^/v1${orgRe}/integrations$`), body: fx('integrations') },
      {
        method: 'POST',
        path: new RegExp(`^/v1${orgRe}/projects$`),
        status: 403,
        body: fx('error-v1')
      },
      {
        method: 'GET',
        path: new RegExp(`^/rest/orgs/${ORG}/targets$`),
        status: 403,
        body: fx('error-forbidden')
      }
    ])
    const t = await snykAdapter.testConnection(ctx)
    expect(t.ok).toBe(true)
    expect(t.identity).toBe('Snyk organization Example Org')
    expect(t.missing).toContain('read snyk.project (view projects)')
    expect(t.missing).toContain('read snyk.target (view targets)')
    expect(t.missing).not.toContain('read snyk.integration (view the organization’s integrations)')
  })

  it('has nothing missing when every read works, and fails closed when the org is not visible', async () => {
    const good = harness([
      { method: 'GET', path: new RegExp(`^/rest/orgs/${ORG}$`), body: fx('org') },
      ...common,
      { method: 'POST', path: new RegExp(`^/v1${orgRe}/projects$`), body: fx('projects') }
    ])
    expect((await snykAdapter.testConnection(good.ctx)).missing).toEqual([])
    const none = harness([
      {
        method: 'GET',
        path: new RegExp(`^/rest/orgs/${ORG}$`),
        status: 404,
        body: fx('error-forbidden')
      }
    ])
    const r = await snykAdapter.testConnection(none.ctx)
    expect(r.ok).toBe(false)
    expect(r.permissions.every((p) => !p.has)).toBe(true)
  })
})

describe('snyk adapter: observe', () => {
  const routes: Route[] = [
    ...common,
    { method: 'GET', path: new RegExp(`^/v1${orgRe}/project/${PROJECT}$`), body: fx('project') },
    {
      method: 'GET',
      path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/settings$`),
      body: fx('settings')
    },
    {
      method: 'POST',
      path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/aggregated-issues$`),
      body: fx('aggregated-issues')
    },
    {
      method: 'GET',
      path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/ignores$`),
      body: fx('ignores')
    }
  ]

  it('maps integration, target, project (counts, fixable, settings) and ignore fields', async () => {
    const { ctx } = harness(routes)
    const integ = await snykAdapter.observe(ctx, INTEGRATION_T, GH)
    expect(integ?.fields).toEqual({ type: 'github' })
    expect(
      await snykAdapter.observe(ctx, INTEGRATION_T, '99999999-9999-4999-8999-999999999999')
    ).toBeNull()

    const target = await snykAdapter.observe(ctx, TARGET_T, TARGET)
    expect(target?.externalId).toBe(TARGET)
    expect(target?.fields.integration).toBe(GH)
    expect(target?.fields.github_repository).toBe('example-org/example-repo')

    const project = await snykAdapter.observe(ctx, PROJECT_T, PROJECT)
    expect(project?.fields).toMatchObject({
      monitored: true,
      pr_checks: true,
      pr_fail_on: 'any',
      critical: 1,
      high: 2,
      medium: 3,
      low: 4,
      fixable: 2
    })

    const ig = await snykAdapter.observe(ctx, IGNORE_T, `${PROJECT}/SNYK-JS-FAKE-0003`)
    expect(ig?.fields).toMatchObject({
      project: PROJECT,
      issue_id: 'SNYK-JS-FAKE-0003',
      reason: 'Not reachable in our code',
      reason_type: 'temporary-ignore',
      expires: '2027-01-31T00:00:00.000Z',
      path: '*'
    })
    expect(await snykAdapter.observe(ctx, IGNORE_T, `${PROJECT}/SNYK-JS-FAKE-9999`)).toBeNull()
  })

  it('answers null for a target or project of another organization (404) and refuses unusable ids', async () => {
    const { ctx } = harness(routes)
    expect(
      await snykAdapter.observe(ctx, TARGET_T, '33333333-3333-4333-8333-999999999999')
    ).toBeNull()
    expect(
      await snykAdapter.observe(ctx, PROJECT_T, '44444444-4444-4444-8444-999999999999')
    ).toBeNull()
    for (const [type, id] of [
      [TARGET_T, '../x'],
      [TARGET_T, ''],
      [PROJECT_T, `${PROJECT}/..`],
      [IGNORE_T, `${PROJECT}/../x`],
      [IGNORE_T, `${PROJECT}/a/b`],
      [IGNORE_T, 'nope']
    ] as const)
      await expect(snykAdapter.observe(ctx, type, id)).rejects.toMatchObject({
        code: expect.stringMatching(/BAD_ID|BAD_EXTERNAL_ID/)
      })
  })

  it('lists targets with the provider cursor, projects with counts only, and every ignore', async () => {
    const { ctx, calls } = harness([
      {
        method: 'GET',
        path: new RegExp(`^/rest/orgs/${ORG}/targets$`),
        body: fx('targets-page1')
      },
      { method: 'POST', path: new RegExp(`^/v1${orgRe}/projects$`), body: fx('projects') },
      {
        method: 'GET',
        path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/ignores$`),
        body: fx('ignores')
      },
      {
        method: 'GET',
        path: new RegExp(`^/v1${orgRe}/project/${PROJECT2}/ignores$`),
        body: fx('ignores-empty')
      }
    ])
    const page = await snykAdapter.list(ctx, TARGET_T)
    expect(page.items).toHaveLength(1)
    expect(page.cursor).toBe('cursor-two')
    await snykAdapter.list(ctx, TARGET_T, 'cursor-two')
    expect(calls[1]?.query.get('starting_after')).toBe('cursor-two')
    const projects = await snykAdapter.list(ctx, PROJECT_T)
    expect(projects.items.map((p) => p.fields.fixable)).toEqual([null, null])
    expect(projects.items[1]?.fields.monitored).toBe(false)
    const ignores = await snykAdapter.list(ctx, IGNORE_T)
    expect(ignores.items.map((i) => i.externalId).sort()).toEqual([
      `${PROJECT}/SNYK-JS-FAKE-0003`,
      `${PROJECT}/SNYK-JS-FAKE-0009`
    ])
  })
})

describe('snyk adapter: plan', () => {
  const plan = (d: DesiredResource | null, ob: Observed | null) =>
    snykAdapter.plan(noCalls().ctx, d, ob)
  const observed = (
    type: string,
    externalId: string,
    fields: Record<string, unknown>,
    name: string | null = null
  ): Observed => ({
    type,
    externalId,
    name,
    fields,
    tags: {}
  })

  it('target: create, delete, noop; exactly one repository; a GitLab project needs its path', () => {
    const create = plan(
      desired(TARGET_T, { integration: { resourceId: 1 }, github_repository: { resourceId: 2 } }),
      null
    )
    expect(create).toHaveLength(1)
    expect(create[0]?.kind).toBe('create')
    expect(create[0]?.reason).toMatch(/GitHub repository/)
    expect(() => plan(desired(TARGET_T, { integration: { resourceId: 1 } }), null)).toThrow(
      /exactly one/
    )
    expect(() =>
      plan(
        desired(TARGET_T, {
          integration: { resourceId: 1 },
          github_repository: { resourceId: 2 },
          gitlab_project: { resourceId: 3 }
        }),
        null
      )
    ).toThrow(/exactly one/)
    expect(() =>
      plan(
        desired(TARGET_T, { integration: { resourceId: 1 }, gitlab_project: { resourceId: 3 } }),
        null
      )
    ).toThrow(/path/)
    const del = plan(null, observed(TARGET_T, TARGET, {}, 'example-org/example-repo'))
    expect(del[0]?.kind).toBe('delete')
    expect(del[0]?.reason).toMatch(/Stop monitoring/)
    expect(
      plan(
        desired(TARGET_T, { github_repository: { resourceId: 2 } }, {}, TARGET),
        observed(TARGET_T, TARGET, {})
      )
    ).toEqual([])
  })

  it('project: update compares the three settings only; create and delete are refused', () => {
    const have = observed(PROJECT_T, PROJECT, {
      monitored: true,
      pr_checks: true,
      pr_fail_on: 'any',
      critical: 1
    })
    expect(
      plan(
        desired(PROJECT_T, { monitored: true, pr_checks: true, pr_fail_on: 'any' }, {}, PROJECT),
        have
      )
    ).toEqual([])
    const up = plan(desired(PROJECT_T, { monitored: false, pr_fail_on: 'high' }, {}, PROJECT), have)
    expect(up[0]?.kind).toBe('update')
    expect(up[0]?.changes.map((c) => c.field)).toEqual(['monitored', 'pr_fail_on'])
    // A setting Snyk would not show is not compared.
    const blind = observed(PROJECT_T, PROJECT, {
      monitored: true,
      pr_checks: null,
      pr_fail_on: null
    })
    expect(plan(desired(PROJECT_T, { pr_checks: false }, {}, PROJECT), blind)).toEqual([])
    expect(() => plan(null, have)).toThrow(/target/)
    expect(() => plan(desired(PROJECT_T, {}), null)).toThrow(/imported/)
  })

  it('ignore: create, expiry date forms are equal, update, delete', () => {
    const f = {
      project: { resourceId: 3 },
      issue_id: 'SNYK-JS-FAKE-0003',
      reason: 'Not reachable',
      reason_type: 'temporary-ignore',
      expires: '2027-01-31',
      path: '*',
      disregard_if_fixable: false
    }
    const create = plan(desired(IGNORE_T, f), null)
    expect(create[0]?.kind).toBe('create')
    expect(create[0]?.reason).toMatch(/until 2027-01-31/)
    expect(plan(desired(IGNORE_T, { ...f, expires: '' }), null)[0]?.reason).toMatch(/no expiry/)
    const have = observed(IGNORE_T, `${PROJECT}/SNYK-JS-FAKE-0003`, {
      reason: 'Not reachable',
      reason_type: 'temporary-ignore',
      expires: '2027-01-31T00:00:00.000Z',
      path: '*',
      disregard_if_fixable: false,
      issue_id: 'SNYK-JS-FAKE-0003'
    })
    expect(plan(desired(IGNORE_T, f, {}, have.externalId), have)).toEqual([])
    const up = plan(
      desired(
        IGNORE_T,
        { ...f, expires: '2027-06-01', reason: 'Still unreachable' },
        {},
        have.externalId
      ),
      have
    )
    expect(up[0]?.changes.map((c) => c.field)).toEqual(['reason', 'expires'])
    expect(plan(null, have)[0]?.kind).toBe('delete')
    expect(normExpires('2027-01-31')).toBe('2027-01-31T00:00:00.000Z')
    expect(normExpires('')).toBeNull()
  })

  it('integration: nothing to plan, never created or deleted by the Hub', () => {
    expect(
      plan(desired(INTEGRATION_T, {}, {}, GH), observed(INTEGRATION_T, GH, { type: 'github' }))
    ).toEqual([])
    expect(() => plan(desired(INTEGRATION_T, {}), null)).toThrow(/adopt/)
    expect(() => plan(null, observed(INTEGRATION_T, GH, {}))).toThrow(/never removes/)
  })
})

describe('snyk adapter: risk flags', () => {
  const spec = (k: string) => snykAdapter.types.find((t) => t.key === k)!
  const noExp = desired(IGNORE_T, { reason: 'x', expires: '' })
  const exp = desired(IGNORE_T, { reason: 'x', expires: '2027-01-31' })

  it('weakening protection is public_exposure (admin)', () => {
    const p = spec(PROJECT_T)
    const change = (field: string, to: unknown) =>
      o({ kind: 'update', type: PROJECT_T, changes: [{ field, from: null, to }] })
    expect(p.risk(change('monitored', false), null)).toEqual(['public_exposure'])
    expect(p.risk(change('pr_checks', false), null)).toEqual(['public_exposure'])
    expect(p.risk(change('pr_fail_on', 'high'), null)).toEqual(['public_exposure'])
    // Strengthening is not.
    expect(p.risk(change('monitored', true), null)).toEqual([])
    expect(p.risk(change('pr_checks', true), null)).toEqual([])
    expect(p.risk(change('pr_fail_on', 'any'), null)).toEqual([])
  })

  it('an ignore with no expiry is public_exposure; one with an expiry, and a removal, are not', () => {
    const i = spec(IGNORE_T)
    expect(i.risk(o({ kind: 'create', type: IGNORE_T }), noExp)).toEqual(['public_exposure'])
    expect(i.risk(o({ kind: 'update', type: IGNORE_T }), noExp)).toEqual(['public_exposure'])
    expect(i.risk(o({ kind: 'create', type: IGNORE_T }), exp)).toEqual([])
    expect(i.risk(o({ kind: 'delete', type: IGNORE_T }), null)).toEqual([])
  })

  it('removing a target stops monitoring: destructive and public_exposure; an import is neither', () => {
    const t = spec(TARGET_T)
    expect(t.risk(o({ kind: 'delete', type: TARGET_T }), null)).toEqual([
      'destructive',
      'public_exposure'
    ])
    expect(t.risk(o({ kind: 'create', type: TARGET_T }), null)).toEqual([])
    expect(spec(INTEGRATION_T).risk(o({ kind: 'noop', type: INTEGRATION_T }), null)).toEqual([])
  })
})

describe('snyk adapter: apply', () => {
  const targetFields = { integration: { resourceId: 1 }, github_repository: { resourceId: 2 } }
  const targetRefs = { integration: GH, github_repository: 'example-org/example-repo' }
  const importRoutes: Route[] = [
    { method: 'GET', path: new RegExp(`^/v1${orgRe}/integrations$`), body: fx('integrations') },
    {
      method: 'POST',
      path: new RegExp(`^/v1${orgRe}/integrations/${GH}/import$`),
      status: 201,
      body: fx('import-started')
    },
    {
      method: 'GET',
      path: new RegExp(`^/v1${orgRe}/integrations/${GH}/import/${JOB}$`),
      body: fx('job-complete')
    }
  ]

  it('target create: lists first, refuses an existing target it did not make, resumes its own', async () => {
    const taken = harness([...importRoutes, ...common])
    await expect(
      snykAdapter.apply(
        taken.ctx,
        o({ kind: 'create', type: TARGET_T }),
        desired(TARGET_T, targetFields, targetRefs)
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(writes(taken.calls)).toEqual([])
    const resumed = await snykAdapter.apply(
      taken.ctx,
      o({ kind: 'create', type: TARGET_T }),
      desired(TARGET_T, targetFields, targetRefs, TARGET)
    )
    expect(resumed).toMatchObject({ ok: true, externalId: TARGET })
    expect(writes(taken.calls)).toEqual([])
  })

  it('target create: posts the import for the repository and waits for the job', async () => {
    let listed = 0
    const fresh = harness([
      ...importRoutes,
      { method: 'GET', path: new RegExp(`^/rest/orgs/${ORG}/targets$`), body: fx('targets') }
    ])
    // The first list (before the import) must be empty, the second must show the target.
    const base = fresh.ctx.fetch
    fresh.ctx.fetch = (async (url: string, init: any) => {
      if (/\/targets/.test(url) && !/\/targets\//.test(url)) {
        listed += 1
        if (listed === 1)
          return new Response(JSON.stringify({ data: [], links: {} }), { status: 200 })
      }
      return base(url, init)
    }) as any
    const r = await snykAdapter.apply(
      fresh.ctx,
      o({ kind: 'create', type: TARGET_T }),
      desired(TARGET_T, { ...targetFields, branch: 'main' }, targetRefs)
    )
    expect(r).toMatchObject({ ok: true, externalId: TARGET, answer: { import_job: JOB } })
    const post = fresh.calls.find((c) => c.method === 'POST')
    expect(post?.body).toEqual({
      target: { owner: 'example-org', name: 'example-repo', branch: 'main' }
    })
  })

  it('target create: a GitLab project is imported by its numeric id; kinds must match', async () => {
    const empty: Route = {
      method: 'GET',
      path: new RegExp(`^/rest/orgs/${ORG}/targets$`),
      body: { data: [], links: {} }
    }
    const gl = harness([
      { method: 'GET', path: new RegExp(`^/v1${orgRe}/integrations$`), body: fx('integrations') },
      {
        method: 'POST',
        path: new RegExp(`^/v1${orgRe}/integrations/${GL}/import$`),
        status: 201,
        body: fx('import-started')
      },
      {
        method: 'GET',
        path: new RegExp(`^/v1${orgRe}/integrations/${GL}/import/${JOB}$`),
        body: fx('job-failed')
      },
      empty
    ])
    await expect(
      snykAdapter.apply(
        gl.ctx,
        o({ kind: 'create', type: TARGET_T }),
        desired(
          TARGET_T,
          {
            integration: { resourceId: 1 },
            gitlab_project: { resourceId: 3 },
            repository_path: 'group/project'
          },
          { integration: GL, gitlab_project: '4242' }
        )
      )
    ).rejects.toMatchObject({ code: 'IMPORT_FAILED', retryable: false })
    expect(gl.calls.find((c) => c.method === 'POST')?.body).toEqual({ target: { id: 4242 } })
    // A GitHub repository through a GitLab integration (and the reverse) is refused before any write.
    const wrong = harness([...importRoutes, empty])
    await expect(
      snykAdapter.apply(
        wrong.ctx,
        o({ kind: 'create', type: TARGET_T }),
        desired(
          TARGET_T,
          {
            integration: { resourceId: 1 },
            gitlab_project: { resourceId: 3 },
            repository_path: 'group/project'
          },
          { integration: GH, gitlab_project: '4242' }
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    expect(writes(wrong.calls)).toEqual([])
    // An integration from another organization is not in this list.
    await expect(
      snykAdapter.apply(
        wrong.ctx,
        o({ kind: 'create', type: TARGET_T }),
        desired(TARGET_T, targetFields, {
          integration: '22222222-2222-4222-8222-999999999999',
          github_repository: 'example-org/example-repo'
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
  })

  it('target create: a job that has not finished is a retryable pending, never a half-made success', async () => {
    const pending = harness([
      ...importRoutes.slice(0, 2),
      {
        method: 'GET',
        path: new RegExp(`^/v1${orgRe}/integrations/${GH}/import/${JOB}$`),
        body: fx('job-pending')
      },
      {
        method: 'GET',
        path: new RegExp(`^/rest/orgs/${ORG}/targets$`),
        body: { data: [], links: {} }
      }
    ])
    const ac = new AbortController()
    const ctx2 = makeProviderContext({
      adapter: snykAdapter,
      connectionId: 1,
      config: { host: 'api.snyk.io', organization: ORG },
      secrets: { token: TOKEN },
      signal: ac.signal,
      fetch: { fetchImpl: ((u: string, i: any) => pending.ctx.fetch(u, i)) as any, timeoutMs: 500 },
      now: () => NOW
    })
    // An aborted run stops waiting at once.
    ac.abort()
    await expect(
      snykAdapter.apply(
        ctx2,
        o({ kind: 'create', type: TARGET_T }),
        desired(TARGET_T, targetFields, targetRefs)
      )
    ).rejects.toMatchObject({ code: 'IMPORT_PENDING', retryable: true })
  })

  it('target delete: gone is idempotent, present is deleted once', async () => {
    const gone = harness([
      {
        method: 'GET',
        path: new RegExp(`^/rest/orgs/${ORG}/targets/${TARGET}$`),
        status: 404,
        body: fx('error-forbidden')
      }
    ])
    expect(
      (
        await snykAdapter.apply(
          gone.ctx,
          o({ kind: 'delete', type: TARGET_T, externalId: TARGET }),
          null
        )
      ).answer
    ).toEqual({ already: 'gone' })
    expect(writes(gone.calls)).toEqual([])
    const there = harness([
      ...common,
      { method: 'DELETE', path: new RegExp(`^/rest/orgs/${ORG}/targets/${TARGET}$`), status: 204 }
    ])
    await snykAdapter.apply(
      there.ctx,
      o({ kind: 'delete', type: TARGET_T, externalId: TARGET }),
      null
    )
    expect(writes(there.calls).map((c) => c.method)).toEqual(['DELETE'])
  })

  const projectRoutes = (
    settings: unknown = fx('settings'),
    project: unknown = fx('project')
  ): Route[] => [
    { method: 'GET', path: new RegExp(`^/v1${orgRe}/project/${PROJECT}$`), body: project },
    {
      method: 'GET',
      path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/settings$`),
      body: settings
    },
    {
      method: 'POST',
      path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/aggregated-issues$`),
      body: fx('aggregated-issues')
    },
    { method: 'POST', path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/deactivate$`), body: {} },
    { method: 'POST', path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/activate$`), body: {} },
    { method: 'PUT', path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/settings$`), body: {} }
  ]

  it('project update: read-before-write, only the differing writes go out', async () => {
    const same = harness(projectRoutes())
    const r = await snykAdapter.apply(
      same.ctx,
      o({ kind: 'update', type: PROJECT_T, externalId: PROJECT }),
      desired(PROJECT_T, { monitored: true, pr_checks: true, pr_fail_on: 'any' }, {}, PROJECT)
    )
    expect(r.answer).toEqual({ already: 'matches' })
    expect(writes(same.calls)).toEqual([])

    const changed = harness(projectRoutes())
    await snykAdapter.apply(
      changed.ctx,
      o({ kind: 'update', type: PROJECT_T, externalId: PROJECT }),
      desired(PROJECT_T, { monitored: false, pr_checks: true, pr_fail_on: 'high' }, {}, PROJECT)
    )
    const w = writes(changed.calls)
    expect(w.map((c) => `${c.method} ${c.path.split('/').pop()}`)).toEqual([
      'POST deactivate',
      'PUT settings'
    ])
    expect(w[1]?.body).toEqual({
      pullRequestFailOnAnyVulns: false,
      pullRequestFailOnlyForHighSeverity: true
    })
  })

  it('project update: refuses an id that is not the one in the plan’s organization', async () => {
    const { ctx } = harness([])
    await expect(
      snykAdapter.apply(
        ctx,
        o({ kind: 'update', type: PROJECT_T, externalId: PROJECT }),
        desired(PROJECT_T, { monitored: false }, {}, PROJECT)
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      snykAdapter.apply(
        ctx,
        o({ kind: 'update', type: PROJECT_T, externalId: '../x' }),
        desired(PROJECT_T, { monitored: false })
      )
    ).rejects.toMatchObject({ code: 'BAD_ID' })
  })

  const ignoreRoutes = (map: unknown): Route[] => [
    { method: 'GET', path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/ignores$`), body: map },
    {
      method: 'POST',
      path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/ignore/SNYK-JS-FAKE-0100$`),
      status: 200,
      body: {}
    },
    {
      method: 'PUT',
      path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/ignore/SNYK-JS-FAKE-0003$`),
      status: 200,
      body: {}
    },
    {
      method: 'DELETE',
      path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/ignore/SNYK-JS-FAKE-0003$`),
      status: 200,
      body: {}
    }
  ]
  const ignoreFields = {
    project: { resourceId: 3 },
    issue_id: 'SNYK-JS-FAKE-0100',
    reason: 'Test reason',
    reason_type: 'wont-fix',
    expires: '2027-01-31',
    path: '*',
    disregard_if_fixable: true
  }

  it('ignore create: a taken issue is refused, a free one is posted with the Snyk body', async () => {
    const taken = harness(ignoreRoutes({ 'SNYK-JS-FAKE-0100': fx('ignores')['SNYK-JS-FAKE-0003'] }))
    await expect(
      snykAdapter.apply(
        taken.ctx,
        o({ kind: 'create', type: IGNORE_T }),
        desired(IGNORE_T, ignoreFields, { project: PROJECT })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(writes(taken.calls)).toEqual([])
    const free = harness(ignoreRoutes(fx('ignores')))
    await snykAdapter.apply(
      free.ctx,
      o({ kind: 'create', type: IGNORE_T }),
      desired(IGNORE_T, ignoreFields, { project: PROJECT })
    )
    expect(writes(free.calls)[0]?.body).toEqual({
      ignorePath: '*',
      reasonType: 'wont-fix',
      disregardIfFixable: true,
      reason: 'Test reason',
      expires: '2027-01-31T00:00:00.000Z'
    })
  })

  it('ignore create: an expiry in the past is refused before any write', async () => {
    const { ctx, calls } = harness(ignoreRoutes(fx('ignores')))
    await expect(
      snykAdapter.apply(
        ctx,
        o({ kind: 'create', type: IGNORE_T }),
        desired(IGNORE_T, { ...ignoreFields, expires: '2020-01-01' }, { project: PROJECT })
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    expect(calls).toEqual([])
  })

  it('ignore update replaces with one item; delete of a gone ignore is a no-op', async () => {
    const id = `${PROJECT}/SNYK-JS-FAKE-0003`
    const up = harness(ignoreRoutes(fx('ignores')))
    await snykAdapter.apply(
      up.ctx,
      o({ kind: 'update', type: IGNORE_T, externalId: id }),
      desired(
        IGNORE_T,
        {
          ...ignoreFields,
          issue_id: 'SNYK-JS-FAKE-0003',
          reason: 'Changed reason',
          expires: '2027-06-01'
        },
        { project: PROJECT },
        id
      )
    )
    const put = writes(up.calls)[0]
    expect(put?.method).toBe('PUT')
    expect(Array.isArray(put?.body)).toBe(true)
    expect(put?.body[0]).toMatchObject({
      reason: 'Changed reason',
      expires: '2027-06-01T00:00:00.000Z'
    })
    const gone = harness(ignoreRoutes({}))
    expect(
      (
        await snykAdapter.apply(
          gone.ctx,
          o({ kind: 'delete', type: IGNORE_T, externalId: id }),
          null
        )
      ).answer
    ).toEqual({ already: 'gone' })
    expect(writes(gone.calls)).toEqual([])
    const del = harness(ignoreRoutes(fx('ignores')))
    await snykAdapter.apply(del.ctx, o({ kind: 'delete', type: IGNORE_T, externalId: id }), null)
    expect(writes(del.calls).map((c) => c.method)).toEqual(['DELETE'])
  })

  it('findExisting names the imported repository and an ignore already on the issue', async () => {
    const { ctx } = harness([...common, ...ignoreRoutes(fx('ignores'))])
    const hit = await snykAdapter.findExisting?.(
      ctx,
      TARGET_T,
      desired(TARGET_T, targetFields, targetRefs)
    )
    expect(hit?.externalId).toBe(TARGET)
    const ig = await snykAdapter.findExisting?.(
      ctx,
      IGNORE_T,
      desired(IGNORE_T, { ...ignoreFields, issue_id: 'SNYK-JS-FAKE-0003' }, { project: PROJECT })
    )
    expect(ig?.externalId).toBe(`${PROJECT}/SNYK-JS-FAKE-0003`)
    expect(
      await snykAdapter.findExisting?.(
        ctx,
        TARGET_T,
        desired(TARGET_T, targetFields, targetRefs, TARGET)
      )
    ).toBeNull()
  })
})

describe('snyk adapter: health', () => {
  const routes: Route[] = [
    { method: 'GET', path: new RegExp(`^/v1${orgRe}/project/${PROJECT}$`), body: fx('project') },
    {
      method: 'GET',
      path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/settings$`),
      body: fx('settings')
    },
    {
      method: 'POST',
      path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/aggregated-issues$`),
      body: fx('aggregated-issues')
    },
    {
      method: 'GET',
      path: new RegExp(`^/v1${orgRe}/project/${PROJECT2}$`),
      body: fx('project-unmonitored')
    },
    {
      method: 'GET',
      path: new RegExp(`^/v1${orgRe}/project/${PROJECT2}/settings$`),
      status: 403,
      body: fx('error-v1')
    },
    {
      method: 'POST',
      path: new RegExp(`^/v1${orgRe}/project/${PROJECT2}/aggregated-issues$`),
      status: 403,
      body: fx('error-v1')
    },
    {
      method: 'GET',
      path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/ignores$`),
      body: fx('ignores')
    }
  ]
  it('warns on critical or high issues and on a project nobody monitors', async () => {
    const { ctx } = harness(routes)
    const h = await snykAdapter.health?.(ctx, PROJECT_T, PROJECT)
    expect(h?.status).toBe('warn')
    expect(h?.details).toMatchObject({ critical: 1, high: 2, fixable: 2 })
    const u = await snykAdapter.health?.(ctx, PROJECT_T, PROJECT2)
    expect(u?.message).toMatch(/not monitoring/)
    const ig = await snykAdapter.health?.(ctx, IGNORE_T, `${PROJECT}/SNYK-JS-FAKE-0009`)
    expect(ig?.message).toMatch(/never expires/)
    const gone = await snykAdapter.health?.(ctx, PROJECT_T, '44444444-4444-4444-8444-999999999999')
    expect(gone?.status).toBe('down')
  })
})

describe('snyk adapter: failures', () => {
  it('maps 429 to retryable', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /.*/,
        status: 429,
        body: fx('error-rate-limited'),
        headers: { 'retry-after': '7' }
      }
    ])
    await expect(snykAdapter.observe(ctx, TARGET_T, TARGET)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      status: 429,
      message: expect.stringContaining('retry after 7 s')
    })
  })

  it('a 5xx is retryable and a refusal is not', async () => {
    const five = harness([{ method: 'GET', path: /.*/, status: 503, body: {} }])
    await expect(snykAdapter.observe(five.ctx, TARGET_T, TARGET)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true
    })
    const no = harness([{ method: 'GET', path: /.*/, status: 403, body: fx('error-forbidden') }])
    await expect(snykAdapter.observe(no.ctx, TARGET_T, TARGET)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      retryable: false
    })
  })

  it('never shows the token in an error, even one a clip would cut in half', async () => {
    const echo = harness([{ method: 'POST', path: /.*/, status: 422, body: fx('error-v1') }])
    const err = await snykAdapter
      .list(echo.ctx, PROJECT_T)
      .then(() => null)
      .catch((e) => e)
    expect(err.code).toBe('PROVIDER_REJECTED')
    expect(String(err.message)).not.toContain(TOKEN)
    // The token starts 280 characters in, so a clip before the scrub would leave a partial token.
    const long = { code: 422, message: `${'x'.repeat(280)}${TOKEN}${'y'.repeat(50)}` }
    const cut = harness([{ method: 'POST', path: /.*/, status: 422, body: long }])
    const e2 = await snykAdapter.list(cut.ctx, PROJECT_T).catch((e) => e)
    expect(String(e2.message)).not.toContain('test-secret')
    expect(String(e2.message)).not.toContain('snyk-token')
  })
})

describe('snyk findings', () => {
  const proj = (fields: Record<string, unknown>): Observed => ({
    type: 'snyk.project',
    externalId: 'p',
    name: null,
    fields,
    tags: {}
  })

  it('snykFindingsFor sums severities and fixable, counts unmonitored, ignores other types', () => {
    const f = snykFindingsFor([
      proj({ critical: 1, high: 2, medium: 3, low: 4, fixable: 2, monitored: true }),
      proj({ critical: 0, high: 1, medium: 0, low: 0, fixable: null, monitored: false }),
      { type: 'snyk.target', externalId: 't', name: null, fields: { critical: 99 }, tags: {} }
    ])
    expect(f).toEqual({
      source: 'snyk',
      critical: 1,
      high: 3,
      medium: 3,
      low: 4,
      fixable: 2,
      projects: 2,
      unmonitored: 1
    })
    expect(snykFindingsFor([])).toMatchObject({ projects: 0, fixable: null, critical: 0 })
    expect(snykFindingsFor([proj({ critical: -3, high: 'x' })]).critical).toBe(0)
  })

  it('readSnykFindings lists projects once and reads fixable only for monitored ones with issues', async () => {
    const { ctx, calls } = harness([
      { method: 'POST', path: new RegExp(`^/v1${orgRe}/projects$`), body: fx('projects') },
      {
        method: 'POST',
        path: new RegExp(`^/v1${orgRe}/project/${PROJECT}/aggregated-issues$`),
        body: fx('aggregated-issues')
      }
    ])
    const f = await readSnykFindings(ctx)
    expect(f).toEqual({
      source: 'snyk',
      critical: 1,
      high: 3,
      medium: 3,
      low: 4,
      fixable: 2,
      projects: 2,
      unmonitored: 1
    })
    expect(calls.filter((c) => /aggregated/.test(c.path))).toHaveLength(1)
    expect(calls.every((c) => c.headers.authorization === `token ${TOKEN}`)).toBe(true)
  })
})
