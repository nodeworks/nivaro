import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeProviderContext } from '../../../services/hub/providers/context.js'
import { ensureCoreProviders } from '../../../services/hub/providers/index.js'
import { jiraAdapter } from '../../../services/hub/providers/jira/index.js'
import { parseRuleId, ruleHash } from '../../../services/hub/providers/jira/notify.js'
import { getProvider } from '../../../services/hub/providers/registry.js'
import type { HubResourceRow } from '../../../services/hub/providers/store.js'
import {
  type DesiredResource,
  type Observed,
  type OutboundMessage,
  ProviderError
} from '../../../services/hub/providers/types.js'

// Hub providers Task 36: the Jira adapter against recorded (fake-valued) answers.

const FIX = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../services/hub/providers/jira/__fixtures__/answers.json'),
    'utf8'
  )
)
const fx = (name: string): any => JSON.parse(JSON.stringify(FIX[name]))

const API_TOKEN = 'test-secret-jira-token'
const PAT = 'test-secret-jira-pat'

interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: any
  headers: Record<string, string>
  host: string
  url: string
}
interface Route {
  method: string
  path: RegExp
  body?: unknown
  status?: number
  headers?: Record<string, string>
  once?: boolean
  when?: (c: Call) => boolean
}

let nextConnection = 300

type Mode = 'cloud_token' | 'cloud_oauth' | 'datacenter_pat'
const CONFIGS: Record<Mode, Record<string, unknown>> = {
  cloud_token: {
    mode: 'cloud_token',
    base_url: 'https://acme.atlassian.net',
    email: 'bot@example.test'
  },
  cloud_oauth: {
    mode: 'cloud_oauth',
    cloud_id: '11111111-2222-4333-8444-555555555555',
    client_id: 'client-test-1'
  },
  datacenter_pat: { mode: 'datacenter_pat', base_url: 'https://jira.example.test/jira' }
}
const SECRETS: Record<Mode, Record<string, string>> = {
  cloud_token: { api_token: API_TOKEN },
  cloud_oauth: { client_secret: 'test-secret-oauth-client' },
  datacenter_pat: { pat: PAT }
}

function harness(
  routes: Route[],
  mode: Mode = 'cloud_token',
  config: Record<string, unknown> = {},
  now = new Date('2026-11-27T10:00:00Z')
) {
  const calls: Call[] = []
  const used = new Set<Route>()
  const fetchImpl = async (url: string, init: any) => {
    const u = new URL(url)
    const path = u.pathname
      .replace(/^\/ex\/jira\/[0-9a-f-]{36}/, '')
      .replace(/^\/jira/, '')
      .replace(/^\/rest\/api\/2/, '')
      .replace(/^\/rest\/webhooks\/1\.0/, '/@webhooks')
    const call: Call = {
      method: init?.method ?? 'GET',
      path: u.pathname === '/oauth/token' ? '/oauth/token' : path,
      query: u.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers ?? {},
      host: u.host,
      url
    }
    calls.push(call)
    const hit = routes.find(
      (r) =>
        r.method === call.method &&
        r.path.test(call.path) &&
        !used.has(r) &&
        (!r.when || r.when(call))
    )
    if (hit?.once) used.add(hit)
    if (!hit) return new Response(JSON.stringify(fx('error-404')), { status: 404 })
    return new Response(hit.status === 204 ? null : JSON.stringify(hit.body ?? {}), {
      status: hit.status ?? 200,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: jiraAdapter,
    connectionId: nextConnection++,
    config: { ...CONFIGS[mode], ...config },
    secrets: SECRETS[mode],
    now: () => now,
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return { ctx, calls }
}

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
    scope: 'app',
    appId: 1,
    environmentId: 2,
    fields,
    refs,
    tags: {}
  }
}

function row(over: Partial<HubResourceRow> = {}): HubResourceRow {
  return {
    id: 5,
    connection_id: 1,
    provider: 'jira',
    type: 'jira.issue_link_rule',
    external_id: 'rule:WEB:7:2d1f5f0e-1111-4222-8333-444455556666:aaaaaaaaaaaa',
    name: 'incidents',
    scope: 'app',
    app_id: 1,
    environment_id: 2,
    desired: { name: 'incidents', issue_type: 'Task', labels: ['ops'], priority_critical: 'High' },
    observed: null,
    drift: false,
    observed_at: null,
    tags: { 'nivaro-hub:app': 'shop' },
    refs: [],
    created_by: null,
    adopted: false,
    deleted_at: null,
    created_at: null,
    updated_at: null,
    ...over
  }
}

const MSG: OutboundMessage = {
  kind: 'card',
  title: 'Incident: shop is down',
  body: 'Checkout fails {noformat} with [brackets] and *bold*.',
  link: 'https://hub.example.test/hub/incidents?incident=4',
  severity: 'critical',
  dedupKey: 'incident:4',
  action: 'open'
}

const RULE_ID = 'rule:WEB:7:2d1f5f0e-1111-4222-8333-444455556666:aaaaaaaaaaaa'

describe('jira adapter: registration', () => {
  it('is a core provider; hosts follow the mode and the token only goes to the right host', () => {
    ensureCoreProviders()
    expect(getProvider('jira')).toBe(jiraAdapter)
    const hosts = (c: Record<string, unknown>) => jiraAdapter.connection.hosts(c)
    expect(hosts(CONFIGS.cloud_token)).toEqual(['acme.atlassian.net'])
    expect(hosts(CONFIGS.cloud_oauth)).toEqual(['api.atlassian.com'])
    expect(hosts(CONFIGS.datacenter_pat)).toEqual(['jira.example.test'])
    expect(hosts({ mode: 'cloud_token', base_url: 'https://evil.example.test' })).toEqual([])
    expect(hosts({ mode: 'datacenter_pat', base_url: 'http://jira.example.test' })).toEqual([])
    expect(hosts({ mode: 'datacenter_pat', base_url: 'https://u:p@jira.example.test' })).toEqual([])
    expect(jiraAdapter.connection.describe(CONFIGS.cloud_token)).not.toContain(API_TOKEN)
  })

  it('validates each mode and the project keys', () => {
    const v = (c: Record<string, unknown>, s: Record<string, string> = {}) =>
      jiraAdapter.connection.validate?.(c, s) ?? []
    expect(v(CONFIGS.cloud_token, SECRETS.cloud_token)).toEqual([])
    expect(
      v({ ...CONFIGS.cloud_token, base_url: 'https://evil.example.test' }).join(' ')
    ).toContain('atlassian.net')
    expect(v({ ...CONFIGS.cloud_token, email: 'nope' }).join(' ')).toContain('email')
    expect(v({ ...CONFIGS.cloud_oauth, cloud_id: 'abc' }).join(' ')).toContain('cloud id')
    expect(
      v({ ...CONFIGS.datacenter_pat, base_url: 'http://jira.example.test' }).join(' ')
    ).toContain('https')
    expect(v({ ...CONFIGS.datacenter_pat, project_keys: ['web', 'bad key!'] }).join(' ')).toContain(
      'project key'
    )
    expect(v(CONFIGS.datacenter_pat, { pat: ' ' }).join(' ')).toContain('token is empty')
  })

  it('declares outputs and none leak into observed or desired; only the issue rule sends', async () => {
    for (const t of jiraAdapter.types) expect(t.outputs ?? []).toEqual([])
    expect(jiraAdapter.types.filter((t) => t.sends).map((t) => t.key)).toEqual([
      'jira.issue_link_rule'
    ])
    const { ctx } = harness([{ method: 'GET', path: /^\/component\/7$/, body: fx('component-7') }])
    const seen = await jiraAdapter.observe(ctx, 'jira.component', '7')
    expect(JSON.stringify(seen)).not.toContain(API_TOKEN)
  })

  it('cloud basic auth goes in the header, never the url or body', async () => {
    const { ctx, calls } = harness([{ method: 'GET', path: /^\/myself$/, body: fx('myself') }])
    await jiraAdapter.testConnection(ctx)
    const c = calls[0] as Call
    expect(c.host).toBe('acme.atlassian.net')
    expect(c.headers.authorization).toBe(
      `Basic ${Buffer.from(`bot@example.test:${API_TOKEN}`).toString('base64')}`
    )
    expect(c.url).not.toContain(API_TOKEN)
  })

  it('oauth: one token call, cached, then calls through api.atlassian.com/ex/jira/<cloud id>', async () => {
    const { ctx, calls } = harness(
      [
        { method: 'POST', path: /^\/oauth\/token$/, body: fx('oauth-token') },
        { method: 'GET', path: /^\/component\/7$/, body: fx('component-7') }
      ],
      'cloud_oauth'
    )
    await jiraAdapter.observe(ctx, 'jira.component', '7')
    await jiraAdapter.observe(ctx, 'jira.component', '7')
    expect(calls.filter((c) => c.path === '/oauth/token')).toHaveLength(1)
    const get = calls.find((c) => c.path === '/component/7') as Call
    expect(get.url).toContain(
      '/ex/jira/11111111-2222-4333-8444-555555555555/rest/api/2/component/7'
    )
    expect(get.headers.authorization).toBe('Bearer test-secret-oauth-access-token')
  })

  it('oauth: a refused sign-in is an AUTH_FAILED that is not retryable', async () => {
    const { ctx } = harness(
      [{ method: 'POST', path: /^\/oauth\/token$/, status: 401, body: {} }],
      'cloud_oauth'
    )
    const r = await jiraAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('refused')
  })
})

describe('jira adapter: testConnection', () => {
  it('lists missing permissions from what Jira says this account may do', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/myself$/, body: fx('myself') },
      { method: 'GET', path: /^\/project\/search$/, body: fx('project-search') },
      { method: 'GET', path: /^\/mypermissions$/, body: fx('mypermissions-browse-only') }
    ])
    const r = await jiraAdapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.identity).toBe('Hub Bot (test)')
    expect(r.missing).toEqual([
      'Administer projects',
      'Administer projects',
      'Create issues',
      'Transition issues'
    ])
    expect(r.permissions.some((p) => p.type === 'jira.webhook')).toBe(false)
  })

  it('Data Center also asks for the global administrator permission (webhooks)', async () => {
    const { ctx } = harness(
      [
        { method: 'GET', path: /^\/myself$/, body: fx('myself') },
        { method: 'GET', path: /^\/project$/, body: [fx('project-web')] },
        {
          method: 'GET',
          path: /^\/mypermissions$/,
          when: (c) => c.query.get('permissions') === 'ADMINISTER',
          body: fx('mypermissions-admin')
        },
        { method: 'GET', path: /^\/mypermissions$/, body: fx('mypermissions-all') }
      ],
      'datacenter_pat'
    )
    const r = await jiraAdapter.testConnection(ctx)
    expect(r.missing).toEqual([])
    expect(r.permissions.find((p) => p.type === 'jira.webhook')?.has).toBe(true)
  })

  it('answers not ok with scrubbed text when the credentials are refused', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/myself$/, status: 401, body: fx('error-400-echo') }
    ])
    const r = await jiraAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain(API_TOKEN)
    expect(r.missing.length).toBeGreaterThan(0)
  })
})

describe('jira adapter: observe', () => {
  it('maps a component and a version, finding the project key through projectId', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/component\/7$/, body: fx('component-7') },
      { method: 'GET', path: /^\/version\/9$/, body: fx('version-9') },
      { method: 'GET', path: /^\/project\/10001$/, body: fx('project-web') }
    ])
    const c = await jiraAdapter.observe(ctx, 'jira.component', '7')
    expect(c?.fields).toEqual({ project: 'WEB', name: 'shop-app', description: 'The shop' })
    const v = await jiraAdapter.observe(ctx, 'jira.version', '9')
    expect(v?.fields).toMatchObject({
      project: 'WEB',
      name: '0.3.1',
      released: false,
      archived: false
    })
    expect(v?.status).toBe('unreleased')
    // The id → key lookup is made once and remembered.
    expect(calls.filter((x) => x.path === '/project/10001')).toHaveLength(1)
  })

  it('a missing item is null; a project outside the connection’s allow-list reads as gone', async () => {
    const { ctx } = harness(
      [
        { method: 'GET', path: /^\/component\/8$/, body: fx('component-8-other') },
        { method: 'GET', path: /^\/project\/OTHER$/, body: fx('project-other') }
      ],
      'cloud_token',
      { project_keys: ['WEB'] }
    )
    expect(await jiraAdapter.observe(ctx, 'jira.component', '99')).toBeNull()
    expect(await jiraAdapter.observe(ctx, 'jira.component', '8')).toBeNull()
    expect(await jiraAdapter.observe(ctx, 'jira.project', 'OTHER')).toBeNull()
  })

  it('refuses ids that could change the path', async () => {
    const { ctx, calls } = harness([])
    for (const id of ['../7', '7/x', '', '7?a=1', '%2e%2e'])
      await expect(jiraAdapter.observe(ctx, 'jira.component', id)).rejects.toMatchObject({
        code: 'BAD_ID'
      })
    await expect(jiraAdapter.observe(ctx, 'jira.project', '../WEB')).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    expect(calls).toHaveLength(0)
  })

  it('webhooks read on Data Center only', async () => {
    const dc = harness(
      [{ method: 'GET', path: /^\/@webhooks\/webhook\/3$/, body: fx('webhook-3') }],
      'datacenter_pat'
    )
    const w = await jiraAdapter.observe(dc.ctx, 'jira.webhook', '3')
    expect(w?.fields).toMatchObject({ name: 'hub events', jql: 'project = WEB', enabled: true })
    const cloud = harness([])
    expect(await jiraAdapter.observe(cloud.ctx, 'jira.webhook', '3')).toBeNull()
    expect(cloud.calls).toHaveLength(0)
  })

  it('lists projects, then components of each allowed project, with the provider cursor', async () => {
    const { ctx } = harness(
      [
        { method: 'GET', path: /^\/project\/search$/, body: fx('project-search') },
        { method: 'GET', path: /^\/project\/WEB\/components$/, body: fx('components-web') }
      ],
      'cloud_token',
      { project_keys: ['WEB'] }
    )
    const projects = await jiraAdapter.list(ctx, 'jira.project', null)
    expect(projects.items.map((i) => i.externalId)).toEqual(['WEB'])
    const comps = await jiraAdapter.list(ctx, 'jira.component', null)
    expect(comps.items.map((i) => i.externalId)).toEqual(['7'])
    expect(comps.cursor).toBeNull()
    expect((await jiraAdapter.list(ctx, 'jira.issue_link_rule', null)).items).toEqual([])
  })
})

describe('jira adapter: plan', () => {
  const { ctx } = harness([])
  const compObserved = (over: Record<string, unknown> = {}): Observed => ({
    type: 'jira.component',
    externalId: '7',
    name: 'shop-app',
    fields: { project: 'WEB', name: 'shop-app', description: 'The shop', ...over },
    tags: {}
  })

  it('component: create, noop, update, replace on another project, delete', () => {
    const d = desired(
      'jira.component',
      { name: 'shop-app', description: 'The shop' },
      { project: 'WEB' }
    )
    expect(jiraAdapter.plan(ctx, d, null)[0]?.kind).toBe('create')
    expect(jiraAdapter.plan(ctx, d, compObserved())).toEqual([])
    const upd = jiraAdapter.plan(
      ctx,
      { ...d, fields: { name: 'shop', description: 'The shop' } },
      compObserved()
    )
    expect(upd[0]).toMatchObject({ kind: 'update', externalId: '7' })
    expect(upd[0]?.changes.map((c) => c.field)).toEqual(['name'])
    const move = jiraAdapter.plan(ctx, { ...d, refs: { project: 'OTHER' } }, compObserved())
    expect(move[0]?.kind).toBe('replace')
    expect(jiraAdapter.plan(ctx, null, compObserved())[0]?.kind).toBe('delete')
  })

  it('version: the release trigger plans the named op once, and nothing when already released', () => {
    const obs: Observed = {
      type: 'jira.version',
      externalId: '9',
      name: '0.3.1',
      fields: {
        project: 'WEB',
        name: '0.3.1',
        description: null,
        release_date: null,
        archived: false,
        released: false
      },
      tags: {}
    }
    const d = desired(
      'jira.version',
      { name: '0.3.1', release: true, archived: false },
      { project: 'WEB' }
    )
    const ops = jiraAdapter.plan(ctx, d, obs)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ kind: 'update', action: 'release' })
    expect(jiraAdapter.plan(ctx, d, { ...obs, fields: { ...obs.fields, released: true } })).toEqual(
      []
    )
    expect(jiraAdapter.plan(ctx, { ...d, fields: { ...d.fields, release: false } }, obs)).toEqual(
      []
    )
  })

  it('webhook: planning on a Cloud connection is refused, and a limited connection gets a Hub-built filter', () => {
    const d = desired('jira.webhook', {
      name: 'hub events',
      url: 'https://hub.example.test/hooks/jira'
    })
    expect(() => jiraAdapter.plan(ctx, d, null)).toThrowError(
      expect.objectContaining({ code: 'WEBHOOK_DC_ONLY' })
    )
    const dc = harness([], 'datacenter_pat', { project_keys: ['WEB'] })
    expect(jiraAdapter.plan(dc.ctx, d, null)[0]?.changes).toContainEqual({
      field: 'jql',
      to: 'project in ("WEB")'
    })
    const open = harness([], 'datacenter_pat')
    expect(jiraAdapter.plan(open.ctx, d, null)[0]?.kind).toBe('create')
    expect(() =>
      jiraAdapter.plan(
        open.ctx,
        desired('jira.webhook', { name: 'x', url: 'https://u:p@h.example.test/x' }),
        null
      )
    ).toThrowError(expect.objectContaining({ code: 'INVALID_FIELDS' }))
  })

  it('webhook secret: a new value is a change without its value, a kept one is not', () => {
    const open = harness([], 'datacenter_pat')
    const obs: Observed = {
      type: 'jira.webhook',
      externalId: '3',
      name: 'hub events',
      fields: {
        name: 'hub events',
        url: 'https://hub.example.test/hooks/jira',
        events: ['jira:issue_created', 'jira:issue_updated'],
        jql: null,
        enabled: true
      },
      tags: {}
    }
    const base = {
      name: 'hub events',
      url: 'https://hub.example.test/hooks/jira',
      secret: { fingerprint: 'f', changed: false }
    }
    expect(jiraAdapter.plan(open.ctx, desired('jira.webhook', base), obs)).toEqual([])
    const op = jiraAdapter.plan(
      open.ctx,
      desired('jira.webhook', { ...base, secret: { fingerprint: 'g', changed: true } }),
      obs
    )[0]
    expect(op?.changes).toEqual([{ field: 'secret', secret: true }])
    expect(JSON.stringify(op)).not.toContain('plain')
  })

  it('rule: create, noop, and an update when the project, component or settings move', () => {
    const fields = { name: 'incidents', issue_type: 'Task', labels: ['ops'] }
    const d = desired('jira.issue_link_rule', fields, { project: 'WEB', component: '7' })
    expect(jiraAdapter.plan(ctx, d, null)[0]?.kind).toBe('create')
    const id = `rule:WEB:7:2d1f5f0e-1111-4222-8333-444455556666:${ruleHash(fields)}`
    const obs: Observed = {
      type: 'jira.issue_link_rule',
      externalId: id,
      name: null,
      fields: {},
      tags: {}
    }
    expect(jiraAdapter.plan(ctx, d, obs)).toEqual([])
    expect(
      jiraAdapter.plan(
        ctx,
        desired('jira.issue_link_rule', { ...fields, issue_type: 'Bug' }, d.refs),
        obs
      )[0]?.kind
    ).toBe('update')
    expect(
      jiraAdapter.plan(
        ctx,
        desired('jira.issue_link_rule', fields, { project: 'OTHER', component: '7' }),
        obs
      )[0]?.kind
    ).toBe('update')
    expect(
      jiraAdapter.plan(
        ctx,
        desired('jira.issue_link_rule', fields, { project: 'WEB', component: null }),
        obs
      )[0]?.kind
    ).toBe('update')
    expect(jiraAdapter.plan(ctx, null, obs)[0]?.kind).toBe('delete')
  })

  it('risk flags: deleting or replacing a component or version is destructive, the rest is not', () => {
    const spec = (t: string) => jiraAdapter.types.find((x) => x.key === t)
    const del = jiraAdapter.plan(ctx, null, compObserved())[0]
    expect(del).toBeDefined()
    for (const t of ['jira.component', 'jira.version']) {
      expect(spec(t)?.risk({ ...(del as any), kind: 'delete' }, null)).toEqual(['destructive'])
      expect(spec(t)?.risk({ ...(del as any), kind: 'replace' }, null)).toEqual(['destructive'])
      expect(spec(t)?.risk({ ...(del as any), kind: 'update' }, null)).toEqual([])
    }
    for (const t of ['jira.webhook', 'jira.issue_link_rule', 'jira.project'])
      expect(spec(t)?.risk({ ...(del as any), kind: 'delete' }, null)).toEqual([])
  })
})

describe('jira adapter: apply', () => {
  const compDesired = (extra: Partial<DesiredResource> = {}) =>
    ({
      ...desired(
        'jira.component',
        { name: 'shop-app', description: 'The shop' },
        { project: 'WEB' }
      ),
      ...extra
    }) as DesiredResource

  it('component create: refuses a name it did not make, resumes its own', async () => {
    const dup = harness([
      { method: 'GET', path: /^\/project\/WEB\/components$/, body: fx('components-web') }
    ])
    await expect(
      jiraAdapter.apply(
        dup.ctx,
        {
          kind: 'create',
          type: 'jira.component',
          resourceId: 7,
          externalId: null,
          reason: '',
          changes: [],
          preconditions: {},
          risk: []
        },
        compDesired()
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(writes(dup.calls)).toHaveLength(0)
    const resumed = harness([{ method: 'GET', path: /^\/component\/7$/, body: fx('component-7') }])
    const r = await jiraAdapter.apply(
      resumed.ctx,
      {
        kind: 'create',
        type: 'jira.component',
        resourceId: 7,
        externalId: null,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      compDesired({ externalId: '7' })
    )
    expect(r.externalId).toBe('7')
    expect(writes(resumed.calls)).toHaveLength(0)
  })

  it('component create posts project, name and description', async () => {
    const h = harness([
      { method: 'GET', path: /^\/project\/WEB\/components$/, body: [] },
      { method: 'POST', path: /^\/component$/, body: { id: '12' } },
      { method: 'GET', path: /^\/component\/12$/, body: { ...fx('component-7'), id: '12' } }
    ])
    const r = await jiraAdapter.apply(
      h.ctx,
      {
        kind: 'create',
        type: 'jira.component',
        resourceId: 7,
        externalId: null,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      compDesired()
    )
    expect(r.externalId).toBe('12')
    expect(writes(h.calls)[0]?.body).toEqual({
      project: 'WEB',
      name: 'shop-app',
      description: 'The shop'
    })
  })

  it('component update is read-first, sends only the changed fields, and refuses another project', async () => {
    const h = harness([
      { method: 'GET', path: /^\/component\/7$/, body: fx('component-7') },
      { method: 'PUT', path: /^\/component\/7$/, body: {} }
    ])
    const op = {
      kind: 'update' as const,
      type: 'jira.component',
      resourceId: 7,
      externalId: '7',
      reason: '',
      changes: [{ field: 'name', to: 'shop' }],
      preconditions: {},
      risk: []
    }
    await jiraAdapter.apply(
      h.ctx,
      op,
      compDesired({ fields: { name: 'shop', description: 'The shop' } })
    )
    expect(writes(h.calls)[0]?.body).toEqual({ name: 'shop' })
    const bad = harness([{ method: 'GET', path: /^\/component\/7$/, body: fx('component-7') }])
    await expect(
      jiraAdapter.apply(bad.ctx, op, compDesired({ refs: { project: 'OTHER' } }))
    ).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' })
    expect(writes(bad.calls)).toHaveLength(0)
  })

  it('a change on a project outside the allow-list throws JIRA_OUT_OF_ACCOUNT before any write', async () => {
    const h = harness(
      [{ method: 'GET', path: /^\/component\/7$/, body: fx('component-7') }],
      'cloud_token',
      {
        project_keys: ['OTHER']
      }
    )
    await expect(
      jiraAdapter.apply(
        h.ctx,
        {
          kind: 'create',
          type: 'jira.component',
          resourceId: 7,
          externalId: null,
          reason: '',
          changes: [],
          preconditions: {},
          risk: []
        },
        compDesired()
      )
    ).rejects.toMatchObject({ code: 'JIRA_OUT_OF_ACCOUNT' })
    expect(writes(h.calls)).toHaveLength(0)
  })

  it('delete: a gone component is a no-write success; a present one is deleted once', async () => {
    const op = {
      kind: 'delete' as const,
      type: 'jira.component',
      resourceId: 7,
      externalId: '7',
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    const gone = harness([])
    expect((await jiraAdapter.apply(gone.ctx, op, null)).ok).toBe(true)
    expect(writes(gone.calls)).toHaveLength(0)
    const h = harness([
      { method: 'GET', path: /^\/component\/7$/, body: fx('component-7') },
      { method: 'DELETE', path: /^\/component\/7$/, status: 204 }
    ])
    await jiraAdapter.apply(h.ctx, op, null)
    expect(writes(h.calls)).toHaveLength(1)
  })

  it('version release: one PUT with released and the date, nothing when already released', async () => {
    const op = {
      kind: 'update' as const,
      type: 'jira.version',
      resourceId: 7,
      externalId: '9',
      action: 'release',
      reason: '',
      changes: [{ field: 'released', from: false, to: true }],
      preconditions: {},
      risk: [],
      data: { releaseDate: null }
    }
    const d = desired('jira.version', { name: '0.3.1', release: true }, { project: 'WEB' })
    const h = harness([
      { method: 'GET', path: /^\/version\/9$/, body: fx('version-9') },
      { method: 'GET', path: /^\/project\/10001$/, body: fx('project-web') },
      { method: 'PUT', path: /^\/version\/9$/, body: {} }
    ])
    const r = await jiraAdapter.apply(h.ctx, op, d)
    expect(writes(h.calls)[0]?.body).toEqual({ released: true, releaseDate: '2026-11-27' })
    expect(r.answer).toEqual({ released: true })
    const done = harness([
      { method: 'GET', path: /^\/version\/9$/, body: fx('version-9-released') },
      { method: 'GET', path: /^\/project\/10001$/, body: fx('project-web') }
    ])
    await jiraAdapter.apply(done.ctx, op, d)
    expect(writes(done.calls)).toHaveLength(0)
  })

  it('version release for a version of another project is a PROJECT_MISMATCH and writes nothing', async () => {
    const op = {
      kind: 'update' as const,
      type: 'jira.version',
      resourceId: 7,
      externalId: '9',
      action: 'release',
      reason: '',
      changes: [],
      preconditions: {},
      risk: [],
      data: {}
    }
    const h = harness([
      { method: 'GET', path: /^\/version\/9$/, body: fx('version-9') },
      { method: 'GET', path: /^\/project\/10001$/, body: fx('project-web') }
    ])
    await expect(
      jiraAdapter.apply(
        h.ctx,
        op,
        desired('jira.version', { name: '0.3.1', release: true }, { project: 'OTHER' })
      )
    ).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' })
    expect(writes(h.calls)).toHaveLength(0)
  })

  it('webhook create sends the secret to Data Center and scrubs it from a refusal', async () => {
    const secret = 'test-secret-webhook-shared-1'
    const d = desired('jira.webhook', {
      name: 'hub events',
      url: 'https://hub.example.test/hooks/jira',
      jql: 'project = WEB',
      secret: { fingerprint: 'f', changed: true, plain: secret }
    })
    const op = {
      kind: 'create' as const,
      type: 'jira.webhook',
      resourceId: 7,
      externalId: null,
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    const h = harness(
      [
        { method: 'GET', path: /^\/@webhooks\/webhook$/, body: [] },
        { method: 'POST', path: /^\/@webhooks\/webhook$/, body: fx('webhook-3') },
        { method: 'GET', path: /^\/@webhooks\/webhook\/3$/, body: fx('webhook-3') }
      ],
      'datacenter_pat'
    )
    const r = await jiraAdapter.apply(h.ctx, op, d)
    expect(r.externalId).toBe('3')
    expect(writes(h.calls)[0]?.body).toMatchObject({
      secret,
      filters: { 'issue-related-events-section': 'project = WEB' }
    })
    expect(JSON.stringify(r)).not.toContain(secret)
    const bad = harness(
      [
        { method: 'GET', path: /^\/@webhooks\/webhook$/, body: [] },
        {
          method: 'POST',
          path: /^\/@webhooks\/webhook$/,
          status: 400,
          body: { errorMessages: [`bad secret ${secret}`] }
        }
      ],
      'datacenter_pat'
    )
    const err = await jiraAdapter.apply(bad.ctx, op, d).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.message).not.toContain(secret)
  })

  it('webhook apply on a Cloud connection is refused without a call', async () => {
    const h = harness([])
    await expect(
      jiraAdapter.apply(
        h.ctx,
        {
          kind: 'create',
          type: 'jira.webhook',
          resourceId: 7,
          externalId: null,
          reason: '',
          changes: [],
          preconditions: {},
          risk: []
        },
        desired('jira.webhook', { name: 'x', url: 'https://hub.example.test/x' })
      )
    ).rejects.toMatchObject({ code: 'WEBHOOK_DC_ONLY' })
    expect(h.calls).toHaveLength(0)
  })

  it('rule create checks the project, the issue type and the component, then names the id', async () => {
    const h = harness([
      { method: 'GET', path: /^\/project\/WEB$/, body: fx('project-web') },
      { method: 'GET', path: /^\/component\/7$/, body: fx('component-7') }
    ])
    const d = desired(
      'jira.issue_link_rule',
      { name: 'incidents', issue_type: 'Task' },
      { project: 'WEB', component: '7' }
    )
    const r = await jiraAdapter.apply(
      h.ctx,
      {
        kind: 'create',
        type: 'jira.issue_link_rule',
        resourceId: 7,
        externalId: null,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      d
    )
    const id = parseRuleId(r.externalId)
    expect(id).toMatchObject({ project: 'WEB', component: '7' })
    expect(writes(h.calls)).toHaveLength(0)
    const wrong = desired(
      'jira.issue_link_rule',
      { name: 'incidents', issue_type: 'Epic' },
      { project: 'WEB' }
    )
    await expect(
      jiraAdapter.apply(
        harness([{ method: 'GET', path: /^\/project\/WEB$/, body: fx('project-web') }]).ctx,
        {
          kind: 'create',
          type: 'jira.issue_link_rule',
          resourceId: 7,
          externalId: null,
          reason: '',
          changes: [],
          preconditions: {},
          risk: []
        },
        wrong
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    // An update keeps the id's uuid and changes the rest.
    const u = await jiraAdapter.apply(
      harness([{ method: 'GET', path: /^\/project\/WEB$/, body: fx('project-web') }]).ctx,
      {
        kind: 'update',
        type: 'jira.issue_link_rule',
        resourceId: 7,
        externalId: RULE_ID,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      desired('jira.issue_link_rule', { name: 'incidents', issue_type: 'Bug' }, { project: 'WEB' })
    )
    expect(parseRuleId(u.externalId)?.uuid).toBe('2d1f5f0e-1111-4222-8333-444455556666')
  })

  it('maps 429 to retryable with the retry-after, and an auth failure to a non-retryable error', async () => {
    const h = harness([
      {
        method: 'GET',
        path: /^\/component\/7$/,
        status: 429,
        headers: { 'retry-after': '30' },
        body: {}
      }
    ])
    const err = await jiraAdapter.observe(h.ctx, 'jira.component', '7').catch((e) => e)
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true, status: 429 })
    expect(err.message).toContain('30')
    const auth = harness([{ method: 'GET', path: /^\/component\/7$/, status: 401, body: {} }])
    expect(
      await jiraAdapter.observe(auth.ctx, 'jira.component', '7').catch((e) => e)
    ).toMatchObject({
      code: 'AUTH_FAILED',
      retryable: false
    })
  })

  it('secrets never appear in errors, including the Basic credential Jira could echo', async () => {
    const basic = Buffer.from(`bot@example.test:${API_TOKEN}`).toString('base64')
    const h = harness([
      {
        method: 'GET',
        path: /^\/component\/7$/,
        status: 400,
        body: { errorMessages: [`bad ${API_TOKEN} and ${basic}`] }
      }
    ])
    const err = await jiraAdapter.observe(h.ctx, 'jira.component', '7').catch((e) => e)
    expect(err.message).not.toContain(API_TOKEN)
    expect(err.message).not.toContain(basic)
  })
})

describe('jira adapter: notify', () => {
  const LABEL_RE = /^hub-[0-9a-f]{16}$/
  const createRoutes = (): Route[] => [
    { method: 'GET', path: /^\/search\/jql$/, body: fx('search-empty') },
    { method: 'POST', path: /^\/issue$/, body: fx('issue-created') }
  ]

  it('open creates one issue: summary, noformat description with the link, labels, component, priority', async () => {
    const h = harness(createRoutes())
    const r = await jiraAdapter.notify?.(h.ctx, row(), MSG)
    expect(r?.ok).toBe(true)
    expect(r?.answer).toMatchObject({ issue: 'WEB-41', action: 'created' })
    const post = writes(h.calls)[0] as Call
    const f = post.body.fields
    expect(f.project).toEqual({ key: 'WEB' })
    expect(f.summary).toBe('Incident: shop is down')
    expect(f.issuetype).toEqual({ name: 'Task' })
    expect(f.components).toEqual([{ id: '7' }])
    expect(f.priority).toEqual({ name: 'High' })
    expect(f.labels).toEqual(expect.arrayContaining(['nivaro-hub', 'app:shop', 'ops']))
    expect(f.labels.some((l: string) => LABEL_RE.test(l))).toBe(true)
    expect(f.description).toContain('{noformat}')
    expect(f.description).toContain('https://hub.example.test/hub/incidents?incident=4')
    // The body cannot break out of its block.
    expect(f.description.match(/\{noformat\}/g)).toHaveLength(2)
    const jql = h.calls.find((c) => c.path === '/search/jql')?.query.get('jql') as string
    expect(jql).toContain('project = "WEB"')
    expect(jql).toContain('statusCategory != Done')
  })

  it('open again for the same incident comments on the open issue instead of creating another', async () => {
    const h = harness([
      { method: 'GET', path: /^\/search\/jql$/, body: fx('search-hit') },
      { method: 'POST', path: /^\/issue\/WEB-41\/comment$/, body: { id: '1' } }
    ])
    const r = await jiraAdapter.notify?.(h.ctx, row(), MSG)
    expect(r?.answer).toMatchObject({ issue: 'WEB-41', action: 'commented' })
    expect(writes(h.calls).map((c) => c.path)).toEqual(['/issue/WEB-41/comment'])
  })

  it('update adds a comment; with no open issue it creates one so nothing is lost', async () => {
    const h = harness([
      { method: 'GET', path: /^\/search\/jql$/, body: fx('search-hit') },
      { method: 'POST', path: /^\/issue\/WEB-41\/comment$/, body: {} }
    ])
    const r = await jiraAdapter.notify?.(h.ctx, row(), {
      ...MSG,
      action: 'update',
      title: 'Still down'
    })
    expect(r?.answer).toMatchObject({ action: 'commented' })
    expect(writes(h.calls)[0]?.body.body).toContain('Still down')
    const none = harness(createRoutes())
    expect(
      (await jiraAdapter.notify?.(none.ctx, row(), { ...MSG, action: 'update' }))?.answer
    ).toMatchObject({ action: 'created' })
  })

  it('resolve comments and moves along the transition that lands in the done category, never by name', async () => {
    const h = harness([
      { method: 'GET', path: /^\/search\/jql$/, body: fx('search-hit') },
      { method: 'POST', path: /^\/issue\/WEB-41\/comment$/, body: {} },
      { method: 'GET', path: /^\/issue\/WEB-41\/transitions$/, body: fx('transitions') },
      { method: 'POST', path: /^\/issue\/WEB-41\/transitions$/, status: 204 }
    ])
    const r = await jiraAdapter.notify?.(h.ctx, row(), {
      ...MSG,
      action: 'resolve',
      title: 'Incident resolved'
    })
    expect(r?.answer).toMatchObject({ issue: 'WEB-41', action: 'resolved', transitioned: true })
    const t = writes(h.calls).find((c) => c.path.endsWith('/transitions')) as Call
    expect(t.body).toEqual({ transition: { id: '31' } })
  })

  it('resolve with no done transition still comments and says it did not move the issue', async () => {
    const h = harness([
      { method: 'GET', path: /^\/search\/jql$/, body: fx('search-hit') },
      { method: 'POST', path: /^\/issue\/WEB-41\/comment$/, body: {} },
      { method: 'GET', path: /^\/issue\/WEB-41\/transitions$/, body: fx('transitions-none') }
    ])
    const r = await jiraAdapter.notify?.(h.ctx, row(), { ...MSG, action: 'resolve' })
    expect(r?.ok).toBe(true)
    expect(r?.answer).toMatchObject({ transitioned: false })
    expect(writes(h.calls).some((c) => c.path.endsWith('/transitions'))).toBe(false)
  })

  it('resolve with no open issue is a no-write success (a second resolve is harmless)', async () => {
    const h = harness([{ method: 'GET', path: /^\/search\/jql$/, body: fx('search-empty') }])
    const r = await jiraAdapter.notify?.(h.ctx, row(), { ...MSG, action: 'resolve' })
    expect(r).toMatchObject({ ok: true, answer: { action: 'skipped' } })
    expect(writes(h.calls)).toHaveLength(0)
  })

  it('one incident is one issue across a Hub restart: the issue is found again by label, not memory', async () => {
    const first = harness(createRoutes())
    await jiraAdapter.notify?.(first.ctx, row(), MSG)
    const label = (writes(first.calls)[0] as Call).body.fields.labels.find((l: string) =>
      LABEL_RE.test(l)
    )
    // A new process: an empty token cache, Jira's search finds the issue by that label.
    const second = harness([
      { method: 'GET', path: /^\/search\/jql$/, body: fx('search-hit') },
      { method: 'POST', path: /^\/issue\/WEB-41\/comment$/, body: {} }
    ])
    await jiraAdapter.notify?.(second.ctx, row(), { ...MSG, action: 'update' })
    expect(second.calls.find((c) => c.path === '/search/jql')?.query.get('jql')).toContain(label)
    expect(writes(second.calls).every((c) => c.path.endsWith('/comment'))).toBe(true)
  })

  it('within one process the issue is remembered and checked by key; a resolved one is searched for again', async () => {
    const h = harness([
      { method: 'GET', path: /^\/search\/jql$/, body: fx('search-empty') },
      { method: 'POST', path: /^\/issue$/, body: fx('issue-created') },
      { method: 'POST', path: /^\/issue\/WEB-41\/comment$/, body: {} }
    ])
    await jiraAdapter.notify?.(h.ctx, row(), MSG)
    const label = (writes(h.calls)[0] as Call).body.fields.labels.find((l: string) =>
      LABEL_RE.test(l)
    )
    const open = JSON.parse(JSON.stringify(fx('issue-open')).replace('LABEL', label))
    h.calls.length = 0
    const routes = [
      { method: 'GET', path: /^\/issue\/WEB-41$/, once: true, body: open, when: () => true }
    ]
    // Same context (same token cache): the second message verifies the remembered key.
    const again = harness(routes)
    again.ctx.tokens.set(`issue:5:${label}`, 'WEB-41', new Date('2026-11-27T11:00:00Z'))
    again.calls.length = 0
    await jiraAdapter
      .notify?.(again.ctx, row(), { ...MSG, action: 'update' })
      .catch(() => undefined)
    expect(again.calls[0]?.path).toBe('/issue/WEB-41')
    expect(again.calls.some((c) => c.path === '/search/jql')).toBe(false)
    // A cached issue that is Done is dropped and Jira's search runs.
    const done = harness([
      {
        method: 'GET',
        path: /^\/issue\/WEB-41$/,
        body: JSON.parse(JSON.stringify(fx('issue-done')).replace('LABEL', label))
      },
      { method: 'GET', path: /^\/search\/jql$/, body: fx('search-empty') },
      { method: 'POST', path: /^\/issue$/, body: fx('issue-created') }
    ])
    done.ctx.tokens.set(`issue:5:${label}`, 'WEB-41', new Date('2026-11-27T11:00:00Z'))
    const r = await jiraAdapter.notify?.(done.ctx, row(), MSG)
    expect(done.calls.some((c) => c.path === '/search/jql')).toBe(true)
    expect(r?.answer).toMatchObject({ action: 'created' })
  })

  it('maps 429 to retryable; a refusal is not retryable and never shows the token', async () => {
    const limited = harness([
      {
        method: 'GET',
        path: /^\/search\/jql$/,
        status: 429,
        headers: { 'retry-after': '12' },
        body: {}
      }
    ])
    const a = await jiraAdapter.notify?.(limited.ctx, row(), MSG)
    expect(a).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', retryable: true } })
    expect(a?.error?.message).toContain('12')
    const refused = harness([
      { method: 'GET', path: /^\/search\/jql$/, body: fx('search-empty') },
      { method: 'POST', path: /^\/issue$/, status: 400, body: fx('error-400-echo') }
    ])
    const b = await jiraAdapter.notify?.(refused.ctx, row(), MSG)
    expect(b).toMatchObject({ ok: false, error: { retryable: false, status: 400 } })
    expect(JSON.stringify(b)).not.toContain(API_TOKEN)
  })

  it('a message without a dedup key always opens a new issue; a non-https link is left out', async () => {
    const h = harness([{ method: 'POST', path: /^\/issue$/, body: fx('issue-created') }])
    await jiraAdapter.notify?.(h.ctx, row(), {
      ...MSG,
      dedupKey: undefined,
      link: 'javascript:alert(1)'
    })
    const f = (writes(h.calls)[0] as Call).body.fields
    expect(f.description).not.toContain('javascript')
    expect(h.calls.some((c) => c.path.startsWith('/search'))).toBe(false)
    expect(f.labels.some((l: string) => LABEL_RE.test(l))).toBe(false)
  })

  it('Data Center searches with /search; other types and a bad rule id do not send', async () => {
    const dc = harness(
      [
        { method: 'GET', path: /^\/search$/, body: fx('search-empty') },
        { method: 'POST', path: /^\/issue$/, body: fx('issue-created') }
      ],
      'datacenter_pat'
    )
    await jiraAdapter.notify?.(dc.ctx, row(), MSG)
    expect(dc.calls.some((c) => c.path === '/search')).toBe(true)
    expect(dc.calls[0]?.url.startsWith('https://jira.example.test/jira/rest/api/2/')).toBe(true)
    const other = await jiraAdapter.notify?.(harness([]).ctx, row({ type: 'jira.component' }), MSG)
    expect(other).toMatchObject({ ok: false, error: { code: 'NOT_A_SENDER' } })
    const bad = await jiraAdapter.notify?.(harness([]).ctx, row({ external_id: 'nope' }), MSG)
    expect(bad).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } })
  })

  it('a rule whose project is outside the connection’s allow-list sends nothing', async () => {
    const h = harness([], 'cloud_token', { project_keys: ['OTHER'] })
    const r = await jiraAdapter.notify?.(h.ctx, row(), MSG)
    expect(r).toMatchObject({ ok: false, error: { code: 'JIRA_OUT_OF_ACCOUNT' } })
    expect(h.calls).toHaveLength(0)
  })
})

describe('jira adapter: health', () => {
  it('ok, warns when archived, down when gone; a rule is down when its project is', async () => {
    const h = harness([
      { method: 'GET', path: /^\/component\/7$/, body: fx('component-7') },
      { method: 'GET', path: /^\/version\/9$/, body: { ...fx('version-9'), archived: true } },
      { method: 'GET', path: /^\/project\/10001$/, body: fx('project-web') },
      { method: 'GET', path: /^\/project\/WEB$/, body: fx('project-web') }
    ])
    expect((await jiraAdapter.health?.(h.ctx, 'jira.component', '7'))?.status).toBe('ok')
    expect((await jiraAdapter.health?.(h.ctx, 'jira.version', '9'))?.status).toBe('warn')
    expect((await jiraAdapter.health?.(h.ctx, 'jira.component', '99'))?.status).toBe('down')
    expect((await jiraAdapter.health?.(h.ctx, 'jira.issue_link_rule', RULE_ID))?.status).toBe('ok')
    const gone = harness([])
    expect((await jiraAdapter.health?.(gone.ctx, 'jira.issue_link_rule', RULE_ID))?.status).toBe(
      'down'
    )
  })
})

describe('jira adapter: injection and project limits', () => {
  it('a nested {noformat} cannot rebuild the tag: braces in the body are neutralised', async () => {
    const h = harness([
      { method: 'GET', path: /^\/search\/jql$/, body: fx('search-empty') },
      { method: 'POST', path: /^\/issue$/, body: fx('issue-created') }
    ])
    await jiraAdapter.notify?.(h.ctx, row(), { ...MSG, body: 'a {no{noformat}format} b {code}' })
    const d = (writes(h.calls)[0] as Call).body.fields.description as string
    expect(d.match(/\{noformat\}/g)).toHaveLength(2)
    expect(d).not.toContain('{code}')
    expect(d).toContain('\uFF5B')
  })

  it('a title with {code} or [link|x] is inside the safe block, in the summary and in comments', async () => {
    const title = 'Down {code}x{code} [link|http://evil.example.test] *b*'
    const h = harness([
      { method: 'GET', path: /^\/search\/jql$/, body: fx('search-hit') },
      { method: 'POST', path: /^\/issue\/WEB-41\/comment$/, body: {} },
      { method: 'GET', path: /^\/issue\/WEB-41\/transitions$/, body: fx('transitions-none') }
    ])
    await jiraAdapter.notify?.(h.ctx, row(), { ...MSG, title, action: 'resolve' })
    const c = (writes(h.calls)[0] as Call).body.body as string
    expect(c).not.toContain('{code}')
    const outside = c
      .split('{noformat}')
      .filter((_, i) => i % 2 === 0)
      .join('')
    expect(outside).not.toMatch(/[[\]|*{}]/)
    expect(c).toContain('[link|http://evil.example.test]')
  })

  it('webhook JQL on a limited connection is wrapped, never trusted to limit itself', async () => {
    const d = desired('jira.webhook', {
      name: 'hub events',
      url: 'https://hub.example.test/hooks/jira',
      jql: 'project = OTHER'
    })
    const h = harness(
      [
        { method: 'GET', path: /^\/@webhooks\/webhook$/, body: [] },
        { method: 'POST', path: /^\/@webhooks\/webhook$/, body: fx('webhook-3') },
        { method: 'GET', path: /^\/@webhooks\/webhook\/3$/, body: fx('webhook-3') }
      ],
      'datacenter_pat',
      { project_keys: ['web', 'ABC'] }
    )
    await jiraAdapter.apply(
      h.ctx,
      {
        kind: 'create',
        type: 'jira.webhook',
        resourceId: 7,
        externalId: null,
        reason: '',
        changes: [],
        preconditions: {},
        risk: []
      },
      d
    )
    expect((writes(h.calls)[0] as Call).body.filters['issue-related-events-section']).toBe(
      'project in ("ABC", "WEB") AND (project = OTHER)'
    )
  })

  it('a webhook not limited to the connection’s projects is refused on update and delete, and invisible to adopt', async () => {
    const foreign = fx('webhook-3') // filter: project = WEB, not the Hub-built limit
    const routes: Route[] = [{ method: 'GET', path: /^\/@webhooks\/webhook\/3$/, body: foreign }]
    const cfg = { project_keys: ['WEB'] }
    const d = desired(
      'jira.webhook',
      { name: 'hub events', url: 'https://hub.example.test/hooks/jira' },
      {},
      '3'
    )
    for (const kind of ['update', 'delete'] as const) {
      const h = harness(routes, 'datacenter_pat', cfg)
      await expect(
        jiraAdapter.apply(
          h.ctx,
          {
            kind,
            type: 'jira.webhook',
            resourceId: 7,
            externalId: '3',
            reason: '',
            changes: [],
            preconditions: {},
            risk: []
          },
          kind === 'delete' ? null : d
        )
      ).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' })
      expect(writes(h.calls)).toHaveLength(0)
    }
    const a = harness(routes, 'datacenter_pat', cfg)
    expect(await jiraAdapter.observe(a.ctx, 'jira.webhook', '3')).toBeNull()
    const listed = harness(
      [{ method: 'GET', path: /^\/@webhooks\/webhook$/, body: [foreign] }],
      'datacenter_pat',
      cfg
    )
    expect((await jiraAdapter.list(listed.ctx, 'jira.webhook', null)).items).toEqual([])
    // Limited the way the Hub writes it: visible.
    const own = {
      ...foreign,
      filters: { 'issue-related-events-section': 'project in ("WEB") AND (type = Bug)' }
    }
    const ok = harness(
      [{ method: 'GET', path: /^\/@webhooks\/webhook\/3$/, body: own }],
      'datacenter_pat',
      cfg
    )
    expect((await jiraAdapter.observe(ok.ctx, 'jira.webhook', '3'))?.externalId).toBe('3')
  })
})
