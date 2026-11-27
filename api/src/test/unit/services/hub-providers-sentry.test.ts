import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeProviderContext } from '../../../services/hub/providers/context.js'
import { ensureCoreProviders } from '../../../services/hub/providers/index.js'
import { getProvider } from '../../../services/hub/providers/registry.js'
import { sentryAdapter } from '../../../services/hub/providers/sentry/index.js'
import {
  type DesiredResource,
  type Observed,
  type PlannedOp,
  ProviderError
} from '../../../services/hub/providers/types.js'

// Hub providers Task 21: the Sentry adapter against recorded (fake-valued) answers.

const FIX = join(import.meta.dirname, '../../../services/hub/providers/sentry/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const TOKEN = 'test-secret-sentry-token-0001'
const KEY_ID = '0123456789abcdef0123456789abcdef'
const DSN = 'https://0123456789abcdef0123456789abcdef@o1000001.ingest.sentry.io/3000001'
const NEW_DSN = 'https://fedcba9876543210fedcba9876543210@o1000001.ingest.sentry.io/3000001'

interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: any
  headers: Record<string, string>
  host: string
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
      path: u.pathname.replace(/^\/api\/0/, ''),
      query: u.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers ?? {},
      host: u.host
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
    adapter: sentryAdapter,
    connectionId: 1,
    config: { host: 'sentry.io', organization: 'test-org', ...config },
    secrets: { token: TOKEN },
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return { ctx, calls }
}

const noCalls = () => harness([])
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET')

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
    scope: type === 'sentry.team' ? 'shared' : 'app',
    appId: 1,
    environmentId: 2,
    fields,
    refs,
    tags: {}
  }
}

const emailAction = { type: 'email', targetType: 'team', targetIdentifier: '2000001' }
const metricFields = {
  name: 'Error spike',
  environment: null,
  dataset: 'events',
  aggregate: 'count()',
  query: '',
  timeWindow: '10',
  thresholdType: 'above',
  triggers: [
    { label: 'critical', alertThreshold: 100, resolveThreshold: 50, actions: [emailAction] }
  ]
}
const issueFields = {
  name: 'New errors',
  actionMatch: 'any',
  filterMatch: 'all',
  frequency: 30,
  environment: null,
  conditions: [
    { id: 'sentry.rules.conditions.first_seen_event.FirstSeenEventCondition', settings: {} }
  ],
  filters: [],
  actions: [
    {
      id: 'sentry.mail.actions.NotifyEmailAction',
      settings: { targetType: 'IssueOwners', fallthroughType: 'ActiveMembers' }
    }
  ]
}

describe('sentry adapter: registration', () => {
  it('is a core provider on the host the connection names, pinned to one organization', () => {
    ensureCoreProviders()
    expect(getProvider('sentry')).toBe(sentryAdapter)
    expect(sentryAdapter.connection.hosts({ host: 'us.sentry.io' })).toEqual(['us.sentry.io'])
    expect(sentryAdapter.connection.hosts({})).toEqual(['sentry.io'])
    expect(sentryAdapter.connection.hosts({ host: 'sentry.example.com' })).toEqual([
      'sentry.example.com'
    ])
    expect(sentryAdapter.connection.fields.find((f) => f.key === 'token')?.secret).toBe(true)
    expect(sentryAdapter.connection.fields.find((f) => f.key === 'organization')?.secret).toBe(
      undefined
    )
    expect(
      sentryAdapter.connection.describe({ host: 'sentry.io', organization: 'test-org' })
    ).not.toContain(TOKEN)
    expect(sentryAdapter.types.map((t) => t.key)).toEqual([
      'sentry.team',
      'sentry.project',
      'sentry.client_key',
      'sentry.issue_alert',
      'sentry.metric_alert'
    ])
    expect(sentryAdapter.types.find((t) => t.key === 'sentry.team')?.scope).toBe('shared')
  })

  it('validates the host and the organization slug', () => {
    const v = sentryAdapter.connection.validate
    expect(v?.({ host: 'sentry.io', organization: 'test-org' }, { token: TOKEN })).toEqual([])
    expect(v?.({ host: 'https://sentry.io', organization: 'test-org' }, {})).not.toEqual([])
    expect(v?.({ host: '10.0.0.5', organization: 'test-org' }, {})).not.toEqual([])
    expect(v?.({ host: 'localhost', organization: 'test-org' }, {})).not.toEqual([])
    expect(v?.({ host: 'sentry.io', organization: 'Bad Org' }, {})).not.toEqual([])
    expect(v?.({ host: 'sentry.io', organization: 'test-org' }, { token: ' ' })).not.toEqual([])
  })

  it('refuses a host other than the connection’s own', async () => {
    const { ctx } = noCalls()
    await expect(ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
  })

  it('calls the configured host with the bearer token', async () => {
    const { ctx, calls } = harness(
      [{ method: 'GET', path: /^\/teams\/test-org\/test-team\/$/, body: fx('team') }],
      { host: 'de.sentry.io' }
    )
    await sentryAdapter.observe(ctx, 'sentry.team', 'test-team')
    expect(calls[0]?.host).toBe('de.sentry.io')
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
  })
})

describe('sentry adapter: testConnection', () => {
  it('lists missing permissions for a read-only token', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/organizations\/test-org\/$/, body: fx('organization-readonly') }
    ])
    const r = await sentryAdapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.identity).toContain('test-org')
    expect(r.missing).toContain('write sentry.project (scope project:write)')
    expect(r.missing).toContain('delete sentry.team (scope team:admin)')
    expect(r.missing.some((m) => m.startsWith('read '))).toBe(false)
  })

  it('has nothing missing for an admin token', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/organizations\/test-org\/$/, body: fx('organization') }
    ])
    const r = await sentryAdapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
  })

  it('answers not ok when the token cannot see the organization', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /^\/organizations\/test-org\/$/,
        status: 403,
        body: fx('error-forbidden')
      }
    ])
    const r = await sentryAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.identity).toBeNull()
    expect(r.missing.length).toBe(r.permissions.length)
  })
})

describe('sentry adapter: observe', () => {
  it('maps team, project, key (no DSN), issue alert and metric alert fields', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/teams\/test-org\/test-team\/$/, body: fx('team') },
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/$/, body: fx('project') },
      {
        method: 'GET',
        path: new RegExp(`^/projects/test-org/test-app/keys/${KEY_ID}/$`),
        body: fx('key')
      },
      {
        method: 'GET',
        path: /^\/projects\/test-org\/test-app\/rules\/4000001\/$/,
        body: fx('issue-rule')
      },
      {
        method: 'GET',
        path: /^\/organizations\/test-org\/alert-rules\/5000001\/$/,
        body: fx('metric-alert')
      }
    ])
    const team = await sentryAdapter.observe(ctx, 'sentry.team', 'test-team')
    expect(team?.fields).toEqual({ slug: 'test-team', memberCount: 3 })
    const project = await sentryAdapter.observe(ctx, 'sentry.project', 'test-app')
    expect(project?.fields).toEqual({
      name: 'Test App',
      slug: 'test-app',
      platform: 'node',
      team: 'test-team'
    })
    expect(project?.url).toBe('https://test-org.sentry.io/settings/projects/test-app/')
    const key = await sentryAdapter.observe(ctx, 'sentry.client_key', `test-app/${KEY_ID}`)
    expect(key?.fields).toEqual({
      project: 'test-app',
      name: 'Hub key',
      isActive: true,
      rateLimitCount: null,
      rateLimitWindow: null
    })
    const issue = await sentryAdapter.observe(ctx, 'sentry.issue_alert', 'test-app/4000001')
    expect(issue?.fields).toMatchObject({
      project: 'test-app',
      name: 'New errors',
      frequency: 30,
      conditions: [
        { id: 'sentry.rules.conditions.first_seen_event.FirstSeenEventCondition', settings: {} }
      ],
      actions: [
        {
          id: 'sentry.mail.actions.NotifyEmailAction',
          settings: { targetType: 'IssueOwners', fallthroughType: 'ActiveMembers' }
        }
      ]
    })
    const metric = await sentryAdapter.observe(ctx, 'sentry.metric_alert', '5000001')
    expect(metric?.fields).toMatchObject({
      projects: ['test-app'],
      timeWindow: 10,
      thresholdType: 'above',
      triggers: [
        {
          label: 'critical',
          alertThreshold: 100,
          resolveThreshold: 50,
          actions: [{ type: 'email', targetType: 'team', targetIdentifier: '2000001' }]
        }
      ]
    })
    const all = JSON.stringify([team, project, key, issue, metric])
    expect(all).not.toContain('test-secret-sentry-key-0001')
    expect(all).not.toContain('ingest.sentry.io')
  })

  it('answers null for a missing resource and for a project of another organization', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/projects\/test-org\/foreign\/$/, body: fx('project-foreign') }
    ])
    expect(await sentryAdapter.observe(ctx, 'sentry.team', 'gone')).toBeNull()
    expect(await sentryAdapter.observe(ctx, 'sentry.project', 'foreign')).toBeNull()
  })

  it('refuses ids that cannot sit in a URL path', async () => {
    const { ctx, calls } = noCalls()
    for (const id of ['..', 'a/b', '', 'a\\b', 'x\n'])
      await expect(sentryAdapter.observe(ctx, 'sentry.team', id)).rejects.toMatchObject({
        code: 'BAD_ID'
      })
    await expect(
      sentryAdapter.observe(ctx, 'sentry.issue_alert', 'test-app/12x')
    ).rejects.toMatchObject({ code: 'BAD_ID' })
    await expect(
      sentryAdapter.observe(ctx, 'sentry.client_key', 'test-app/../keys')
    ).rejects.toMatchObject({ code: 'BAD_ID' })
    expect(calls).toHaveLength(0)
  })

  it('lists with the provider cursor from the Link header', async () => {
    const link =
      '<https://sentry.io/api/0/organizations/test-org/projects/?cursor=1:0:1>; rel="previous"; results="false"; cursor="1:0:1", ' +
      '<https://sentry.io/api/0/organizations/test-org/projects/?cursor=1:100:0>; rel="next"; results="true"; cursor="1:100:0"'
    const { ctx } = harness([
      {
        method: 'GET',
        path: /^\/organizations\/test-org\/projects\/$/,
        body: fx('projects'),
        headers: { link }
      },
      { method: 'GET', path: /^\/organizations\/test-org\/teams\/$/, body: fx('teams') },
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/keys\/$/, body: fx('keys') },
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/rules\/$/, body: fx('issue-rules') },
      {
        method: 'GET',
        path: /^\/organizations\/test-org\/alert-rules\/$/,
        body: fx('metric-alerts')
      }
    ])
    const projects = await sentryAdapter.list(ctx, 'sentry.project')
    expect(projects.items).toHaveLength(1)
    expect(projects.cursor).toBe('1:100:0')
    expect((await sentryAdapter.list(ctx, 'sentry.team')).cursor).toBeNull()
    expect((await sentryAdapter.list(ctx, 'sentry.client_key')).items[0]?.externalId).toBe(
      `test-app/${KEY_ID}`
    )
    expect((await sentryAdapter.list(ctx, 'sentry.issue_alert')).items[0]?.externalId).toBe(
      'test-app/4000001'
    )
    expect((await sentryAdapter.list(ctx, 'sentry.metric_alert')).items[0]?.externalId).toBe(
      '5000001'
    )
  })
})

describe('sentry adapter: plan', () => {
  const { ctx } = noCalls()
  const project = (over: Record<string, unknown> = {}): Observed => ({
    type: 'sentry.project',
    externalId: 'test-app',
    name: 'Test App',
    fields: { name: 'Test App', slug: 'test-app', platform: 'node', team: 'test-team', ...over },
    tags: {}
  })
  const key = (over: Record<string, unknown> = {}): Observed => ({
    type: 'sentry.client_key',
    externalId: `test-app/${KEY_ID}`,
    name: 'Hub key',
    fields: {
      project: 'test-app',
      name: 'Hub key',
      isActive: true,
      rateLimitCount: null,
      rateLimitWindow: null,
      ...over
    },
    tags: {}
  })

  it('team: create, replace on a slug change, delete, noop', () => {
    const create = sentryAdapter.plan(ctx, desired('sentry.team', { slug: 'test-team' }), null)
    expect(create[0]?.kind).toBe('create')
    expect(create[0]?.reason).toBe('Create Sentry team test-team.')
    const observed: Observed = {
      type: 'sentry.team',
      externalId: 'test-team',
      name: 'test-team',
      fields: { slug: 'test-team', memberCount: 3 },
      tags: {}
    }
    expect(
      sentryAdapter.plan(ctx, desired('sentry.team', { slug: 'test-team' }), observed)
    ).toEqual([])
    expect(
      sentryAdapter.plan(ctx, desired('sentry.team', { slug: 'other-team' }), observed)[0]?.kind
    ).toBe('replace')
    expect(sentryAdapter.plan(ctx, null, observed)[0]?.kind).toBe('delete')
  })

  it('project: update compares name and platform only; team is create-only', () => {
    const want = { name: 'Test App', slug: 'test-app', platform: 'node' }
    expect(
      sentryAdapter.plan(ctx, desired('sentry.project', want, { team: 'other-team' }), project())
    ).toEqual([])
    const update = sentryAdapter.plan(
      ctx,
      desired('sentry.project', { ...want, platform: 'javascript-react' }),
      project()
    )
    expect(update[0]?.kind).toBe('update')
    expect(update[0]?.changes).toEqual([
      { field: 'platform', from: 'node', to: 'javascript-react' }
    ])
    expect(update[0]?.preconditions.platform).toBe('node')
    expect(update[0]?.reason).toBe('Change Platform on Sentry project Test App.')
  })

  it('project: a release is a named op with the version and environment in its data', () => {
    const want = {
      name: 'Test App',
      slug: 'test-app',
      platform: 'node',
      record_release: true,
      release_version: '1.2.3',
      release_environment: 'staging'
    }
    const ops = sentryAdapter.plan(ctx, desired('sentry.project', want, {}, 'test-app'), project())
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({
      kind: 'update',
      action: 'release',
      data: { version: '1.2.3', environment: 'staging' }
    })
    expect(() =>
      sentryAdapter.plan(
        ctx,
        desired('sentry.project', { ...want, release_version: '' }),
        project()
      )
    ).toThrow(ProviderError)
  })

  it('client key: replace on a project change; rate limit change is an update', () => {
    const base = { name: 'Hub key', isActive: true }
    expect(
      sentryAdapter.plan(ctx, desired('sentry.client_key', base, { project: 'test-app' }), key())
    ).toEqual([])
    expect(
      sentryAdapter.plan(
        ctx,
        desired('sentry.client_key', base, { project: 'other-app' }),
        key()
      )[0]?.kind
    ).toBe('replace')
    const limited = sentryAdapter.plan(
      ctx,
      desired(
        'sentry.client_key',
        { ...base, rateLimitCount: 100, rateLimitWindow: 60 },
        { project: 'test-app' }
      ),
      key()
    )
    expect(limited[0]?.kind).toBe('update')
    expect(limited[0]?.changes.map((c) => c.field)).toEqual(['rateLimitCount', 'rateLimitWindow'])
  })

  it('issue alert: equal rules (Sentry’s display names and uuids ignored) plan nothing', () => {
    const observed: Observed = {
      type: 'sentry.issue_alert',
      externalId: 'test-app/4000001',
      name: 'New errors',
      fields: {
        project: 'test-app',
        name: 'New errors',
        actionMatch: 'any',
        filterMatch: 'all',
        frequency: 30,
        environment: null,
        conditions: issueFields.conditions,
        filters: [],
        actions: issueFields.actions
      },
      tags: {}
    }
    expect(
      sentryAdapter.plan(
        ctx,
        desired('sentry.issue_alert', issueFields, { project: 'test-app' }),
        observed
      )
    ).toEqual([])
    const changed = sentryAdapter.plan(
      ctx,
      desired('sentry.issue_alert', { ...issueFields, frequency: 60 }, { project: 'test-app' }),
      observed
    )
    expect(changed[0]?.kind).toBe('update')
    expect(changed[0]?.changes).toEqual([{ field: 'frequency', from: 30, to: 60 }])
  })

  it('metric alert: time window as text equals the number; a project set change is an update', () => {
    const observed: Observed = {
      type: 'sentry.metric_alert',
      externalId: '5000001',
      name: 'Error spike',
      fields: {
        name: 'Error spike',
        projects: ['test-app'],
        environment: null,
        dataset: 'events',
        aggregate: 'count()',
        query: '',
        timeWindow: 10,
        thresholdType: 'above',
        triggers: metricFields.triggers.map((t) => ({ ...t }))
      },
      tags: {}
    }
    expect(
      sentryAdapter.plan(
        ctx,
        desired('sentry.metric_alert', metricFields, { projects: ['test-app'] }),
        observed
      )
    ).toEqual([])
    const more = sentryAdapter.plan(
      ctx,
      desired('sentry.metric_alert', metricFields, { projects: ['test-app', 'test-web'] }),
      observed
    )
    expect(more[0]?.kind).toBe('update')
    expect(more[0]?.changes).toEqual([
      { field: 'projects', from: ['test-app'], to: ['test-app', 'test-web'] }
    ])
    const window = sentryAdapter.plan(
      ctx,
      desired(
        'sentry.metric_alert',
        { ...metricFields, timeWindow: '30' },
        { projects: ['test-app'] }
      ),
      observed
    )
    expect(window[0]?.changes).toEqual([{ field: 'timeWindow', from: 10, to: 30 }])
  })
})

describe('sentry adapter: risk flags', () => {
  const op = (type: string, kind: PlannedOp['kind'], changes: PlannedOp['changes'] = []) =>
    ({
      kind,
      type,
      resourceId: 1,
      externalId: 'x',
      reason: '',
      changes,
      preconditions: {},
      risk: []
    }) as PlannedOp
  const risk = (type: string, o: PlannedOp) =>
    sentryAdapter.types.find((t) => t.key === type)?.risk(o, null)

  it('flags what is lost', () => {
    expect(risk('sentry.team', op('sentry.team', 'delete'))).toEqual(['destructive'])
    expect(risk('sentry.project', op('sentry.project', 'delete'))).toEqual([
      'destructive',
      'data_loss'
    ])
    expect(risk('sentry.client_key', op('sentry.client_key', 'delete'))).toEqual([
      'destructive',
      'downtime'
    ])
    expect(
      risk(
        'sentry.client_key',
        op('sentry.client_key', 'update', [{ field: 'isActive', from: true, to: false }])
      )
    ).toEqual(['downtime'])
    expect(
      risk(
        'sentry.client_key',
        op('sentry.client_key', 'update', [{ field: 'name', from: 'a', to: 'b' }])
      )
    ).toEqual([])
    expect(risk('sentry.issue_alert', op('sentry.issue_alert', 'delete'))).toEqual(['destructive'])
    expect(risk('sentry.metric_alert', op('sentry.metric_alert', 'update'))).toEqual([])
    expect(risk('sentry.project', op('sentry.project', 'create'))).toEqual([])
  })

  it('no type is costed: Sentry bills the organization plan, not each resource', () => {
    for (const t of sentryAdapter.types) expect(t.costClass).toBeUndefined()
  })
})

describe('sentry adapter: apply', () => {
  it('team: create reads first, refuses a name it did not make, resumes its own', async () => {
    const created = harness([
      { method: 'GET', path: /^\/teams\/test-org\/test-team\/$/, status: 404 },
      {
        method: 'POST',
        path: /^\/organizations\/test-org\/teams\/$/,
        status: 201,
        body: fx('team')
      }
    ])
    const planned = sentryAdapter.plan(
      created.ctx,
      desired('sentry.team', { slug: 'test-team' }),
      null
    )[0] as PlannedOp
    const r = await sentryAdapter.apply(
      created.ctx,
      planned,
      desired('sentry.team', { slug: 'test-team' })
    )
    expect(r.externalId).toBe('test-team')
    expect(writes(created.calls)).toHaveLength(1)
    expect(writes(created.calls)[0]?.body).toEqual({ slug: 'test-team' })

    const exists = harness([
      { method: 'GET', path: /^\/teams\/test-org\/test-team\/$/, body: fx('team') }
    ])
    await expect(
      sentryAdapter.apply(exists.ctx, planned, desired('sentry.team', { slug: 'test-team' }))
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(writes(exists.calls)).toHaveLength(0)
    const resumed = await sentryAdapter.apply(
      exists.ctx,
      planned,
      desired('sentry.team', { slug: 'test-team' }, {}, 'test-team')
    )
    expect(resumed.answer).toEqual({ already: 'exists' })
    expect(writes(exists.calls)).toHaveLength(0)
  })

  it('team: delete of a gone team is a no-op success; replace deletes then creates', async () => {
    const gone = harness([{ method: 'DELETE', path: /^\/teams\//, status: 404 }])
    const del = sentryAdapter.plan(gone.ctx, null, {
      type: 'sentry.team',
      externalId: 'test-team',
      name: 'test-team',
      fields: { slug: 'test-team' },
      tags: {}
    })[0] as PlannedOp
    expect((await sentryAdapter.apply(gone.ctx, del, null)).ok).toBe(true)

    const replace = harness([
      { method: 'DELETE', path: /^\/teams\/test-org\/test-team\/$/, status: 204 },
      { method: 'GET', path: /^\/teams\/test-org\/other-team\/$/, status: 404 },
      {
        method: 'POST',
        path: /^\/organizations\/test-org\/teams\/$/,
        status: 201,
        body: { slug: 'other-team', name: 'other-team' }
      }
    ])
    const r = await sentryAdapter.apply(
      replace.ctx,
      {
        kind: 'replace',
        type: 'sentry.team',
        resourceId: 7,
        externalId: 'test-team',
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      desired('sentry.team', { slug: 'other-team' }, {}, 'test-team')
    )
    expect(r.externalId).toBe('other-team')
    expect(writes(replace.calls).map((c) => c.method)).toEqual(['DELETE', 'POST'])
  })

  it('project: create posts under the team without default alert rules; update is read-before-write', async () => {
    const created = harness([
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/$/, status: 404 },
      {
        method: 'POST',
        path: /^\/teams\/test-org\/test-team\/projects\/$/,
        status: 201,
        body: fx('project')
      }
    ])
    const want = desired(
      'sentry.project',
      { name: 'Test App', slug: 'test-app', platform: 'node' },
      { team: 'test-team' }
    )
    const create = sentryAdapter.plan(created.ctx, want, null)[0] as PlannedOp
    const r = await sentryAdapter.apply(created.ctx, create, want)
    expect(r.externalId).toBe('test-app')
    expect(writes(created.calls)[0]?.body).toEqual({
      name: 'Test App',
      slug: 'test-app',
      platform: 'node',
      default_rules: false
    })

    const same = harness([
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/$/, body: fx('project') }
    ])
    const noop = await sentryAdapter.apply(
      same.ctx,
      {
        kind: 'update',
        type: 'sentry.project',
        resourceId: 7,
        externalId: 'test-app',
        reason: '',
        changes: [{ field: 'name', from: 'x', to: 'Test App' }],
        preconditions: {},
        risk: []
      },
      desired(
        'sentry.project',
        { name: 'Test App', slug: 'test-app', platform: 'node' },
        {},
        'test-app'
      )
    )
    expect(noop.answer).toEqual({ already: 'matches' })
    expect(writes(same.calls)).toHaveLength(0)

    const renamed = harness([
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/$/, body: fx('project') },
      {
        method: 'PUT',
        path: /^\/projects\/test-org\/test-app\/$/,
        body: { ...fx('project'), name: 'Test App 2' }
      }
    ])
    await sentryAdapter.apply(
      renamed.ctx,
      {
        kind: 'update',
        type: 'sentry.project',
        resourceId: 7,
        externalId: 'test-app',
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      desired(
        'sentry.project',
        { name: 'Test App 2', slug: 'test-app', platform: 'node' },
        {},
        'test-app'
      )
    )
    expect(writes(renamed.calls)[0]?.body).toEqual({ name: 'Test App 2' })
  })

  it('project delete: gone is idempotent, present is deleted once', async () => {
    const gone = harness([{ method: 'GET', path: /^\/projects\//, status: 404 }])
    const op: PlannedOp = {
      kind: 'delete',
      type: 'sentry.project',
      resourceId: 7,
      externalId: 'test-app',
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    expect((await sentryAdapter.apply(gone.ctx, op, null)).answer).toEqual({ already: 'gone' })
    expect(writes(gone.calls)).toHaveLength(0)
    const there = harness([
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/$/, body: fx('project') },
      { method: 'DELETE', path: /^\/projects\/test-org\/test-app\/$/, status: 204 }
    ])
    await sentryAdapter.apply(there.ctx, op, null)
    expect(writes(there.calls)).toHaveLength(1)
  })

  it('client key: a create hands the DSN out as an output only', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/keys\/$/, body: [] },
      {
        method: 'POST',
        path: /^\/projects\/test-org\/test-app\/keys\/$/,
        status: 201,
        body: fx('key-created')
      }
    ])
    const want = desired(
      'sentry.client_key',
      { name: 'Hub key', isActive: true, rateLimitCount: 100, rateLimitWindow: 60 },
      { project: 'test-app' }
    )
    const op = sentryAdapter.plan(ctx, want, null)[0] as PlannedOp
    const r = await sentryAdapter.apply(ctx, op, want)
    expect(r.externalId).toBe('test-app/fedcba9876543210fedcba9876543210')
    expect(r.outputs).toEqual({ dsn: NEW_DSN })
    expect(writes(calls)[0]?.body).toEqual({
      name: 'Hub key',
      rateLimit: { count: 100, window: 60 }
    })
    // Declared, public, and nowhere else: not in observed, the answer, the op or the desired state.
    const spec = sentryAdapter.types.find((t) => t.key === 'sentry.client_key')
    expect(spec?.outputs).toEqual([{ key: 'dsn', label: 'DSN', secret: false }])
    const rest = JSON.stringify({ observed: r.observed, answer: r.answer, op, want })
    expect(rest).not.toContain('ingest.sentry.io')
    expect(rest).not.toContain('test-secret-sentry-key')
  })

  it('client key: an existing name is refused unless this resource already recorded it', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/keys\/$/, body: fx('keys') },
      {
        method: 'GET',
        path: new RegExp(`^/projects/test-org/test-app/keys/${KEY_ID}/$`),
        body: fx('key')
      }
    ])
    const want = (externalId: string | null) =>
      desired(
        'sentry.client_key',
        { name: 'Hub key', isActive: true },
        { project: 'test-app' },
        externalId
      )
    const op = sentryAdapter.plan(ctx, want(null), null)[0] as PlannedOp
    await expect(sentryAdapter.apply(ctx, op, want(null))).rejects.toMatchObject({
      code: 'ALREADY_EXISTS'
    })
    const resumed = await sentryAdapter.apply(ctx, op, want(`test-app/${KEY_ID}`))
    expect(resumed.outputs).toEqual({ dsn: DSN })
    expect(writes(calls)).toHaveLength(0)
  })

  it('client key: update writes only the changes; unchanged is a no-write that still answers the DSN', async () => {
    const get = {
      method: 'GET',
      path: new RegExp(`^/projects/test-org/test-app/keys/${KEY_ID}/$`),
      body: fx('key')
    }
    const same = harness([get])
    const noop = await sentryAdapter.apply(
      same.ctx,
      {
        kind: 'update',
        type: 'sentry.client_key',
        resourceId: 7,
        externalId: `test-app/${KEY_ID}`,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      desired(
        'sentry.client_key',
        { name: 'Hub key', isActive: true },
        { project: 'test-app' },
        `test-app/${KEY_ID}`
      )
    )
    expect(noop.answer).toEqual({ already: 'matches' })
    expect(noop.outputs).toEqual({ dsn: DSN })
    expect(writes(same.calls)).toHaveLength(0)

    const off = harness([
      get,
      {
        method: 'PUT',
        path: new RegExp(`^/projects/test-org/test-app/keys/${KEY_ID}/$`),
        body: { ...fx('key'), isActive: false }
      }
    ])
    await sentryAdapter.apply(
      off.ctx,
      {
        kind: 'update',
        type: 'sentry.client_key',
        resourceId: 7,
        externalId: `test-app/${KEY_ID}`,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      desired(
        'sentry.client_key',
        { name: 'Hub key', isActive: false },
        { project: 'test-app' },
        `test-app/${KEY_ID}`
      )
    )
    expect(writes(off.calls)[0]?.body).toEqual({ isActive: false })
  })

  it('readOutputs re-reads the DSN; other types have none', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: new RegExp(`^/projects/test-org/test-app/keys/${KEY_ID}/$`),
        body: fx('key')
      }
    ])
    expect(
      await sentryAdapter.readOutputs?.(ctx, 'sentry.client_key', `test-app/${KEY_ID}`)
    ).toEqual({
      dsn: DSN
    })
    expect(await sentryAdapter.readOutputs?.(ctx, 'sentry.project', 'test-app')).toEqual({})
  })

  it('issue alert: create posts the rule with Sentry’s shape; a taken name is refused', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/rules\/$/, body: [] },
      {
        method: 'POST',
        path: /^\/projects\/test-org\/test-app\/rules\/$/,
        status: 201,
        body: fx('issue-rule')
      }
    ])
    const want = desired('sentry.issue_alert', issueFields, { project: 'test-app' })
    const op = sentryAdapter.plan(ctx, want, null)[0] as PlannedOp
    const r = await sentryAdapter.apply(ctx, op, want)
    expect(r.externalId).toBe('test-app/4000001')
    expect(writes(calls)[0]?.body).toMatchObject({
      name: 'New errors',
      frequency: 30,
      conditions: [{ id: 'sentry.rules.conditions.first_seen_event.FirstSeenEventCondition' }],
      actions: [
        {
          id: 'sentry.mail.actions.NotifyEmailAction',
          targetType: 'IssueOwners',
          fallthroughType: 'ActiveMembers'
        }
      ]
    })
    const taken = harness([
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/rules\/$/, body: fx('issue-rules') }
    ])
    await expect(sentryAdapter.apply(taken.ctx, op, want)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS'
    })
    expect(writes(taken.calls)).toHaveLength(0)
  })

  it('metric alert: create posts project slugs and numeric thresholds', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/organizations\/test-org\/alert-rules\/$/, body: [] },
      {
        method: 'POST',
        path: /^\/organizations\/test-org\/alert-rules\/$/,
        status: 201,
        body: fx('metric-alert')
      }
    ])
    const want = desired('sentry.metric_alert', metricFields, { projects: ['test-app'] })
    const op = sentryAdapter.plan(ctx, want, null)[0] as PlannedOp
    const r = await sentryAdapter.apply(ctx, op, want)
    expect(r.externalId).toBe('5000001')
    expect(writes(calls)[0]?.body).toMatchObject({
      name: 'Error spike',
      projects: ['test-app'],
      timeWindow: 10,
      thresholdType: 0,
      triggers: [{ label: 'critical', alertThreshold: 100, resolveThreshold: 50 }]
    })
    const taken = harness([
      {
        method: 'GET',
        path: /^\/organizations\/test-org\/alert-rules\/$/,
        body: fx('metric-alerts')
      }
    ])
    await expect(sentryAdapter.apply(taken.ctx, op, want)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS'
    })
  })

  it('findExisting names the project’s key / alert / team with the same name or slug', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/teams\/test-org\/test-team\/$/, body: fx('team') },
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/keys\/$/, body: fx('keys') },
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/rules\/$/, body: fx('issue-rules') }
    ])
    expect(
      (
        await sentryAdapter.findExisting?.(
          ctx,
          'sentry.team',
          desired('sentry.team', { slug: 'test-team' })
        )
      )?.externalId
    ).toBe('test-team')
    expect(
      (
        await sentryAdapter.findExisting?.(
          ctx,
          'sentry.client_key',
          desired('sentry.client_key', { name: 'Hub key' }, { project: 'test-app' })
        )
      )?.externalId
    ).toBe(`test-app/${KEY_ID}`)
    expect(
      await sentryAdapter.findExisting?.(
        ctx,
        'sentry.issue_alert',
        desired('sentry.issue_alert', { name: 'Other' }, { project: 'test-app' })
      )
    ).toBeNull()
    expect(
      await sentryAdapter.findExisting?.(
        ctx,
        'sentry.client_key',
        desired('sentry.client_key', { name: 'Hub key' }, { project: null })
      )
    ).toBeNull()
  })
})

describe('sentry adapter: release op', () => {
  const op: PlannedOp = {
    kind: 'update',
    type: 'sentry.project',
    resourceId: 7,
    externalId: 'test-app',
    action: 'release',
    reason: '',
    changes: [{ field: 'record_release', from: false, to: true }],
    preconditions: {},
    risk: [],
    data: { version: '1.2.3', environment: 'staging' }
  }
  const want = (over: Record<string, unknown> = {}, externalId: string | null = 'test-app') =>
    desired(
      'sentry.project',
      {
        name: 'Test App',
        slug: 'test-app',
        platform: 'node',
        record_release: true,
        release_version: '1.2.3',
        release_environment: 'staging',
        ...over
      },
      {},
      externalId
    )
  const project = { method: 'GET', path: /^\/projects\/test-org\/test-app\/$/, body: fx('project') }

  it('creates the release and one deploy when neither exists', async () => {
    const { ctx, calls } = harness([
      project,
      { method: 'GET', path: /^\/organizations\/test-org\/releases\/1\.2\.3\/$/, status: 404 },
      {
        method: 'POST',
        path: /^\/organizations\/test-org\/releases\/$/,
        status: 201,
        body: fx('release')
      },
      {
        method: 'GET',
        path: /^\/organizations\/test-org\/releases\/1\.2\.3\/deploys\/$/,
        body: fx('deploys-empty')
      },
      {
        method: 'POST',
        path: /^\/organizations\/test-org\/releases\/1\.2\.3\/deploys\/$/,
        status: 201,
        body: { id: '8000002', environment: 'staging' }
      }
    ])
    const r = await sentryAdapter.apply(
      ctx,
      op,
      want({ release_url: 'https://hub.example.com/r/1' })
    )
    expect(r.answer).toEqual({ release: '1.2.3', environment: 'staging', deploy: 'created' })
    const w = writes(calls)
    expect(w.map((c) => c.method)).toEqual(['POST', 'POST'])
    expect(w[0]?.body).toEqual({ version: '1.2.3', projects: ['test-app'] })
    expect(w[1]?.body).toMatchObject({ environment: 'staging', url: 'https://hub.example.com/r/1' })
  })

  it('writes nothing when the release has the project and the deploy exists', async () => {
    const { ctx, calls } = harness([
      project,
      {
        method: 'GET',
        path: /^\/organizations\/test-org\/releases\/1\.2\.3\/$/,
        body: fx('release')
      },
      {
        method: 'GET',
        path: /^\/organizations\/test-org\/releases\/1\.2\.3\/deploys\/$/,
        body: fx('deploys')
      }
    ])
    const r = await sentryAdapter.apply(ctx, op, want())
    expect(r.answer).toMatchObject({ deploy: 'already' })
    expect(writes(calls)).toHaveLength(0)
  })

  it('refuses a project that is not the one the resource points at, and a changed release', async () => {
    const { ctx, calls } = harness([project])
    await expect(sentryAdapter.apply(ctx, op, want({}, 'other-app'))).rejects.toMatchObject({
      code: 'TARGET_MISMATCH'
    })
    await expect(
      sentryAdapter.apply(ctx, op, want({ release_version: '9.9.9' }))
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    await expect(
      sentryAdapter.apply(ctx, { ...op, externalId: 'other-app' }, want())
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(calls).toHaveLength(0)
  })

  it('refuses a release version that cannot sit in a URL path', async () => {
    const { ctx, calls } = harness([project])
    await expect(
      sentryAdapter.apply(
        ctx,
        { ...op, data: { version: '../x', environment: 'staging' } },
        want({ release_version: '../x' })
      )
    ).rejects.toMatchObject({ code: 'BAD_ID' })
    expect(writes(calls)).toHaveLength(0)
  })
})

describe('sentry adapter: health', () => {
  it('counts unresolved issues in 24 hours for the project and each environment', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/$/, body: fx('project') },
      {
        method: 'GET',
        path: /^\/projects\/test-org\/test-app\/issues\/$/,
        body: [{ id: '1' }],
        headers: { 'x-hits': '7' }
      },
      {
        method: 'GET',
        path: /^\/projects\/test-org\/test-app\/environments\/$/,
        body: fx('environments')
      }
    ])
    const h = await sentryAdapter.health?.(ctx, 'sentry.project', 'test-app')
    expect(h?.status).toBe('ok')
    expect(h?.details).toMatchObject({
      unresolved_24h: 7,
      unresolved_24h_production: 7,
      unresolved_24h_staging: 7
    })
  })

  it('warns at many unresolved issues, says down when gone, warns on a disabled key', async () => {
    const many = harness([
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/$/, body: fx('project') },
      {
        method: 'GET',
        path: /^\/projects\/test-org\/test-app\/issues\/$/,
        body: [{ id: '1' }],
        headers: { 'x-hits': '80' }
      }
    ])
    expect((await sentryAdapter.health?.(many.ctx, 'sentry.project', 'test-app'))?.status).toBe(
      'warn'
    )
    const gone = noCalls()
    expect((await sentryAdapter.health?.(gone.ctx, 'sentry.project', 'test-app'))?.status).toBe(
      'down'
    )
    const off = harness([
      {
        method: 'GET',
        path: new RegExp(`^/projects/test-org/test-app/keys/${KEY_ID}/$`),
        body: { ...fx('key'), isActive: false }
      }
    ])
    expect(
      (await sentryAdapter.health?.(off.ctx, 'sentry.client_key', `test-app/${KEY_ID}`))?.status
    ).toBe('warn')
  })
})

describe('sentry adapter: failures', () => {
  it('maps 429 to retryable and scrubs the token from the text', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /^\/teams\//,
        status: 429,
        body: fx('error-rate-limited'),
        headers: { 'retry-after': '12' }
      }
    ])
    const err = (await sentryAdapter
      .observe(ctx, 'sentry.team', 'test-team')
      .catch((e) => e)) as ProviderError
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.code).toBe('RATE_LIMITED')
    expect(err.retryable).toBe(true)
    expect(err.status).toBe(429)
    expect(err.message).toContain('retry after 12 s')
    expect(err.message).not.toContain(TOKEN)
  })

  it('does not retry a refusal and never shows a secret in a validation error', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/projects\/test-org\/test-app\/rules\/$/, body: [] },
      {
        method: 'POST',
        path: /^\/projects\/test-org\/test-app\/rules\/$/,
        status: 400,
        body: fx('error-validation')
      }
    ])
    const want = desired('sentry.issue_alert', issueFields, { project: 'test-app' })
    const op = sentryAdapter.plan(ctx, want, null)[0] as PlannedOp
    const err = (await sentryAdapter.apply(ctx, op, want).catch((e) => e)) as ProviderError
    expect(err.code).toBe('PROVIDER_REJECTED')
    expect(err.retryable).toBe(false)
    expect(err.message).toContain('already exists')
    expect(err.message).not.toContain(TOKEN)
    const forbidden = harness([
      { method: 'GET', path: /^\/teams\//, status: 403, body: fx('error-forbidden') }
    ])
    await expect(
      sentryAdapter.observe(forbidden.ctx, 'sentry.team', 'test-team')
    ).rejects.toMatchObject({ code: 'FORBIDDEN', retryable: false })
  })

  it('a 5xx is retryable', async () => {
    const { ctx } = harness([{ method: 'GET', path: /^\/teams\//, status: 503, body: {} }])
    await expect(sentryAdapter.observe(ctx, 'sentry.team', 'test-team')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true
    })
  })
})
