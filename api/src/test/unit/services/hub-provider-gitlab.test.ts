import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 18: the GitLab adapter against recorded (fake-valued) answers.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const { ensureCoreProviders } = await import('../../../services/hub/providers/index.js')
const registry = await import('../../../services/hub/providers/registry.js')
const { gitlabAdapter } = await import('../../../services/hub/providers/gitlab/index.js')
const client = await import('../../../services/hub/providers/gitlab/client.js')
const { ProviderError } = await import('../../../services/hub/providers/types.js')

import type { DesiredResource, Observed, PlannedOp } from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/gitlab/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const TOKEN = 'test-secret-token-0001'
const HOST = 'gitlab.test.example'
const CONFIG = { baseUrl: `https://${HOST}`, groupPath: 'acme' }
const NEW_VALUE = 'test-secret-new-value-7777'

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

function harness(routes: Route[], config: Record<string, unknown> = CONFIG) {
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
    adapter: gitlabAdapter,
    connectionId: 1,
    config,
    secrets: { token: TOKEN },
    now: () => new Date('2026-11-26T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  const writes = () => calls.filter((c) => c.method !== 'GET')
  return { ctx, calls, writes }
}

const noCalls = () => harness([])

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

const secret = (changed: boolean, plain?: string) => ({
  fingerprint: 'fp-test',
  changed,
  ...(plain ? { plain } : {})
})

const typeSpec = (key: string) => gitlabAdapter.types.find((t) => t.key === key) as any

const PROJECT_ROUTE: Route = {
  method: 'GET',
  path: /^\/api\/v4\/projects\/1001$/,
  body: fx('project')
}
const GROUP_ROUTE: Route = { method: 'GET', path: /^\/api\/v4\/groups\/acme$/, body: fx('group') }

beforeEach(() => {
  registry.resetProvidersForTest()
  ensureCoreProviders()
})

describe('gitlab adapter: registration and connection', () => {
  it('is a core provider on the host the admin set, pinned to a group, with a secret token', () => {
    expect(registry.getProvider('gitlab')).toBe(gitlabAdapter)
    expect(gitlabAdapter.connection.hosts(CONFIG)).toEqual([HOST])
    expect(gitlabAdapter.connection.hosts({})).toEqual(['gitlab.com'])
    const token = gitlabAdapter.connection.fields.find((f) => f.key === 'token')
    expect(token?.secret).toBe(true)
    expect(gitlabAdapter.connection.fields.find((f) => f.key === 'groupPath')?.secret).toBeFalsy()
    expect(gitlabAdapter.connection.describe(CONFIG)).toContain('group acme')
    expect(gitlabAdapter.connection.describe(CONFIG)).not.toContain(TOKEN)
    expect(gitlabAdapter.types.map((t) => t.key)).toEqual([
      'gitlab.group',
      'gitlab.project',
      'gitlab.protected_branch',
      'gitlab.environment',
      'gitlab.protected_environment',
      'gitlab.ci_variable',
      'gitlab.deploy_token',
      'gitlab.deploy_key',
      'gitlab.webhook',
      'gitlab.pipeline_schedule',
      'gitlab.runner'
    ])
  })

  it('refuses plain http, a login in the address, and a host that is not the connection’s', async () => {
    expect(gitlabAdapter.connection.hosts({ baseUrl: 'http://gitlab.test.example' })).toEqual([])
    expect(gitlabAdapter.connection.hosts({ baseUrl: 'https://u:p@gitlab.test.example' })).toEqual(
      []
    )
    expect(
      gitlabAdapter.connection.hosts({ baseUrl: 'https://gitlab.test.example/a/../b' })
    ).toEqual([])
    expect(
      gitlabAdapter.connection.validate?.(
        { baseUrl: 'http://gitlab.test.example', groupPath: 'acme' },
        {}
      ).length
    ).toBeGreaterThan(0)
    expect(gitlabAdapter.connection.validate?.(CONFIG, { token: 'x' })).toEqual([])
    expect(gitlabAdapter.connection.validate?.({ ...CONFIG, groupPath: '../x' }, {})).not.toEqual(
      []
    )
    const { ctx } = noCalls()
    await expect(ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
    await expect(ctx.fetch(`http://${HOST}/x`)).rejects.toThrow(/https/)
  })

  it('a self-hosted install under a path keeps its prefix', async () => {
    const { ctx, calls } = harness(
      [{ method: 'GET', path: /^\/gitlab\/api\/v4\/projects\/1001$/, body: fx('project') }],
      { baseUrl: `https://${HOST}/gitlab/`, groupPath: 'acme' }
    )
    expect(gitlabAdapter.connection.hosts({ baseUrl: `https://${HOST}/gitlab/` })).toEqual([HOST])
    const seen = await gitlabAdapter.observe(ctx, 'gitlab.project', '1001')
    expect(seen?.externalId).toBe('1001')
    expect(calls[0]?.path).toBe('/gitlab/api/v4/projects/1001')
  })
})

describe('gitlab adapter: testConnection', () => {
  const base: Route[] = [
    { method: 'GET', path: /^\/api\/v4\/user$/, body: fx('user') },
    GROUP_ROUTE,
    { method: 'GET', path: /^\/api\/v4\/groups\/100\/members\/all\/9001$/, body: fx('member') }
  ]

  it('lists missing permissions for a read-only token', async () => {
    const { ctx, calls } = harness([
      ...base,
      { method: 'GET', path: /personal_access_tokens\/self$/, body: fx('pat-self') }
    ])
    const r = await gitlabAdapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.identity).toContain('hub-bot')
    expect(r.identity).toContain('group acme')
    expect(r.missing).toContain('write gitlab.project (token scope api, role Maintainer or above)')
    expect(r.missing.some((m) => m.startsWith('read '))).toBe(false)
    expect(r.permissions.some((p) => p.type === 'gitlab.group' && p.need.startsWith('write'))).toBe(
      false
    )
    for (const c of calls) expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('has nothing missing for an api token of a maintainer', async () => {
    const { ctx } = harness([
      ...base,
      { method: 'GET', path: /personal_access_tokens\/self$/, body: fx('pat-self-api') }
    ])
    const r = await gitlabAdapter.testConnection(ctx)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
  })

  it('fails with a plain message when the pinned group cannot be seen', async () => {
    const { ctx } = harness([{ method: 'GET', path: /^\/api\/v4\/user$/, body: fx('user') }])
    const r = await gitlabAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('acme')
    expect(r.missing.length).toBeGreaterThan(0)
  })

  it('answers a refused token without the token in the message', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/api\/v4\/user$/, status: 401, body: fx('error-rate-limited') }
    ])
    const r = await gitlabAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain(TOKEN)
  })
})

describe('gitlab adapter: observe', () => {
  it('maps project fields', async () => {
    const { ctx } = harness([PROJECT_ROUTE])
    const seen = await gitlabAdapter.observe(ctx, 'gitlab.project', '1001')
    expect(seen).toMatchObject({
      externalId: '1001',
      name: 'web-app',
      status: 'active',
      fields: {
        namespace: '100',
        path: 'web-app',
        visibility: 'private',
        defaultBranch: 'main',
        archived: false,
        fullPath: 'acme/web-app'
      }
    })
  })

  it('a variable is observed without its value', async () => {
    const { ctx, calls } = harness([
      PROJECT_ROUTE,
      {
        method: 'GET',
        path: /^\/api\/v4\/projects\/1001\/variables\/API_BASE$/,
        body: fx('variable')
      }
    ])
    const seen = await gitlabAdapter.observe(ctx, 'gitlab.ci_variable', 'project:1001:API_BASE:*')
    expect(seen?.fields).toMatchObject({
      project: '1001',
      key: 'API_BASE',
      masked: true,
      protected: true,
      environmentScope: '*'
    })
    expect(JSON.stringify(seen)).not.toContain('test-secret-value-seen-by-api')
    expect(
      calls.find((c) => /variables/.test(c.path))?.query.get('filter[environment_scope]')
    ).toBe('*')
  })

  it('maps protected branch, environment, protected environment, key, hook, schedule and runner', async () => {
    const { ctx } = harness([
      PROJECT_ROUTE,
      { method: 'GET', path: /protected_branches\/main$/, body: fx('protected-branch') },
      { method: 'GET', path: /\/environments\/31$/, body: fx('environment') },
      {
        method: 'GET',
        path: /protected_environments\/production$/,
        body: fx('protected-environment')
      },
      { method: 'GET', path: /deploy_keys\/61$/, body: fx('deploy-key') },
      { method: 'GET', path: /hooks\/81$/, body: fx('hook') },
      { method: 'GET', path: /pipeline_schedules\/91$/, body: fx('schedule') },
      { method: 'GET', path: /^\/api\/v4\/runners\/301$/, body: fx('runner') }
    ])
    const o = async (t: string, id: string) => (await gitlabAdapter.observe(ctx, t, id)) as Observed
    expect((await o('gitlab.protected_branch', '1001/main')).fields).toMatchObject({
      pushAccess: 'maintainers',
      mergeAccess: 'maintainers',
      allowForcePush: false
    })
    expect((await o('gitlab.environment', '1001/31')).fields).toMatchObject({
      name: 'production',
      tier: 'production',
      externalUrl: 'https://app.example.test'
    })
    expect((await o('gitlab.protected_environment', '1001/production')).fields).toMatchObject({
      deployAccess: 'maintainers',
      requiredApprovals: 2,
      approverRole: 'maintainers'
    })
    expect((await o('gitlab.deploy_key', '1001/61')).fields).toMatchObject({
      key: 'ssh-ed25519 AAAATESTKEYAAAA',
      canPush: false
    })
    expect((await o('gitlab.webhook', '1001/81')).fields).toMatchObject({
      url: 'https://hooks.example.test/gitlab',
      events: ['push_events', 'merge_requests_events'],
      enableSslVerification: true
    })
    expect((await o('gitlab.pipeline_schedule', '1001/91')).fields).toMatchObject({
      ref: 'main',
      cron: '0 3 * * *',
      active: true
    })
    expect((await o('gitlab.runner', '301')).fields).toMatchObject({
      project: '1001',
      tagList: ['docker'],
      online: true,
      runnerType: 'project_type'
    })
  })

  it('a deploy token is observed without its token, username as a readable output', async () => {
    const { ctx } = harness([
      PROJECT_ROUTE,
      {
        method: 'GET',
        path: /^\/api\/v4\/projects\/1001\/deploy_tokens$/,
        body: fx('deploy-tokens')
      }
    ])
    const seen = await gitlabAdapter.observe(ctx, 'gitlab.deploy_token', 'project:1001:55')
    expect(seen?.fields).toMatchObject({ name: 'ci-pull', scopes: ['read_repository'] })
    expect(JSON.stringify(seen)).not.toContain('test-secret')
    expect(
      await gitlabAdapter.readOutputs?.(ctx, 'gitlab.deploy_token', 'project:1001:55')
    ).toEqual({
      username: 'gitlab+deploy-token-55'
    })
  })

  it('lists a page of projects and the children of each', async () => {
    const { ctx } = harness([
      GROUP_ROUTE,
      {
        method: 'GET',
        path: /^\/api\/v4\/groups\/100\/projects$/,
        body: fx('projects-page1'),
        headers: { 'x-next-page': '2' }
      },
      { method: 'GET', path: /^\/api\/v4\/projects\/1001\/hooks$/, body: [fx('hook')] },
      { method: 'GET', path: /^\/api\/v4\/projects\/1002\/hooks$/, body: [] }
    ])
    const projects = await gitlabAdapter.list(ctx, 'gitlab.project', null)
    expect(projects.items.map((i) => i.externalId)).toEqual(['1001', '1002'])
    expect(projects.cursor).toBe('2')
    const hooks = await gitlabAdapter.list(ctx, 'gitlab.webhook', null)
    expect(hooks.items.map((i) => i.externalId)).toEqual(['1001/81'])
  })
})

describe('gitlab adapter: the pinned group', () => {
  it('a project outside the group reads as gone; its children too', async () => {
    const { ctx, calls } = harness([
      { method: 'GET', path: /^\/api\/v4\/projects\/2002$/, body: fx('project-outside') }
    ])
    expect(await gitlabAdapter.observe(ctx, 'gitlab.project', '2002')).toBeNull()
    expect(
      await gitlabAdapter.observe(ctx, 'gitlab.ci_variable', 'project:2002:API_BASE:*')
    ).toBeNull()
    expect(await gitlabAdapter.observe(ctx, 'gitlab.webhook', '2002/81')).toBeNull()
    // Only the parent was ever read: the child was never asked for.
    expect(calls.every((c) => c.path === '/api/v4/projects/2002')).toBe(true)
  })

  it('a group outside is refused; an apply names the pin', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/api\/v4\/groups\/200$/, body: fx('group-other') },
      { method: 'GET', path: /^\/api\/v4\/projects\/2002$/, body: fx('project-outside') }
    ])
    expect(await gitlabAdapter.observe(ctx, 'gitlab.group', '200')).toBeNull()
    const op: PlannedOp = {
      kind: 'update',
      type: 'gitlab.project',
      resourceId: 7,
      externalId: '2002',
      reason: 'x',
      changes: [],
      preconditions: {},
      risk: []
    }
    await expect(
      gitlabAdapter.apply(ctx, op, desired('gitlab.project', { name: 'x' }))
    ).rejects.toMatchObject({ code: 'GITLAB_OUT_OF_ACCOUNT' })
    const del: PlannedOp = { ...op, kind: 'delete', action: 'archive' }
    await expect(gitlabAdapter.apply(ctx, del, null)).rejects.toMatchObject({
      code: 'GITLAB_OUT_OF_ACCOUNT'
    })
  })

  it('an instance runner and a runner of another group read as gone', async () => {
    const other = {
      ...fx('runner'),
      id: 304,
      projects: [{ id: 2002, path_with_namespace: 'elsewhere/stranger' }]
    }
    const { ctx } = harness([
      { method: 'GET', path: /^\/api\/v4\/runners\/302$/, body: fx('runner-instance') },
      { method: 'GET', path: /^\/api\/v4\/runners\/304$/, body: other }
    ])
    expect(await gitlabAdapter.observe(ctx, 'gitlab.runner', '302')).toBeNull()
    expect(await gitlabAdapter.observe(ctx, 'gitlab.runner', '304')).toBeNull()
  })

  it('a project path that only starts with the group name is outside it', () => {
    const { ctx } = noCalls()
    expect(client.withinPin(ctx, 'acme/web', false)).toBe(true)
    expect(client.withinPin(ctx, 'acme-evil/web', false)).toBe(false)
    expect(client.withinPin(ctx, 'acme', false)).toBe(false)
    expect(client.withinPin(ctx, 'acme', true)).toBe(true)
  })
})

describe('gitlab adapter: path segments', () => {
  it('refuses ids and names that could reach another path', () => {
    for (const bad of ['', '1/../2', '12a', '..', '-1', '1 2'])
      expect(() => client.idSeg(bad)).toThrow(ProviderError)
    for (const bad of ['', 'a/b', 'A-B', 'a b', '../x'])
      expect(() => client.keySeg(bad)).toThrow(ProviderError)
    for (const bad of ['', '..', 'a..b', 'a b', 'a\\b', 'a//b', '/a', 'a/', 'x.lock', '-x', 'a\nb'])
      expect(() => client.branchSeg(bad)).toThrow(ProviderError)
    for (const bad of ['', '.', '..', 'a/../b', 'a\\b', ' a', 'a\u0000b'])
      expect(() => client.envNameSeg(bad)).toThrow(ProviderError)
    for (const bad of ['', 'acme/../x', '/acme', 'acme/', 'a b'])
      expect(() => client.pathSeg(bad)).toThrow(ProviderError)
    expect(client.branchSeg('release/*')).toBe('release%2F*')
    expect(client.envNameSeg('review/feature one')).toBe('review%2Ffeature%20one')
    expect(client.pathSeg('acme/web-app')).toBe('acme%2Fweb-app')
  })

  it('a bad branch id stops before the branch is asked for', async () => {
    const { ctx, calls } = harness([PROJECT_ROUTE])
    await expect(
      gitlabAdapter.observe(ctx, 'gitlab.protected_branch', '1001/..')
    ).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    expect(calls.some((c) => /protected_branches/.test(c.path))).toBe(false)
    await expect(
      gitlabAdapter.observe(ctx, 'gitlab.ci_variable', 'project:1001:BAD/KEY:*')
    ).rejects.toMatchObject({ code: 'BAD_EXTERNAL_ID' })
  })
})

describe('gitlab adapter: plan diff per type', () => {
  const projectObserved = (over: Record<string, unknown> = {}): Observed => ({
    type: 'gitlab.project',
    externalId: '1001',
    name: 'web-app',
    fields: {
      name: 'web-app',
      description: 'The web app',
      visibility: 'private',
      defaultBranch: 'main',
      archived: false,
      ...over
    },
    tags: {}
  })

  it('a project: create, change in place, remove = archive, destroy', () => {
    const { ctx } = noCalls()
    const create = gitlabAdapter.plan(ctx, desired('gitlab.project', { name: 'new-app' }), null)
    expect(create).toHaveLength(1)
    expect(create[0]).toMatchObject({ kind: 'create', type: 'gitlab.project' })
    expect(create[0]?.reason).toContain('GitLab project new-app')

    const change = gitlabAdapter.plan(
      ctx,
      desired('gitlab.project', {
        name: 'web-app',
        visibility: 'public',
        description: 'The web app'
      }),
      projectObserved()
    )
    expect(change[0]).toMatchObject({ kind: 'update' })
    expect(change[0]?.changes).toEqual([{ field: 'visibility', from: 'private', to: 'public' }])

    const same = gitlabAdapter.plan(
      ctx,
      desired('gitlab.project', { name: 'web-app', visibility: 'private' }),
      projectObserved()
    )
    expect(same).toEqual([])

    const archive = gitlabAdapter.plan(ctx, null, projectObserved())
    expect(archive[0]).toMatchObject({ kind: 'delete', action: 'archive' })
    expect(archive[0]?.reason).toContain('Archive')
    expect(gitlabAdapter.plan(ctx, null, projectObserved({ archived: true }))[0]?.kind).toBe('noop')

    const destroy = gitlabAdapter.plan(
      ctx,
      desired('gitlab.project', { name: 'web-app', destroy: true }),
      projectObserved()
    )
    expect(destroy[0]).toMatchObject({ kind: 'delete', action: 'destroy' })
  })

  it('a group is read-only: a plan never changes it and never creates one', () => {
    const { ctx } = noCalls()
    const seen: Observed = {
      type: 'gitlab.group',
      externalId: '100',
      name: 'acme',
      fields: {},
      tags: {}
    }
    expect(gitlabAdapter.plan(ctx, null, seen)[0]?.kind).toBe('noop')
    expect(gitlabAdapter.plan(ctx, desired('gitlab.group', {}), seen)[0]?.kind).toBe('noop')
    expect(() => gitlabAdapter.plan(ctx, desired('gitlab.group', {}), null)).toThrow(/adopts/)
  })

  it('a variable: replace on a new key or scope, update on flags and value', () => {
    const { ctx } = noCalls()
    const seen: Observed = {
      type: 'gitlab.ci_variable',
      externalId: 'project:1001:API_BASE:*',
      name: 'API_BASE',
      fields: {
        project: '1001',
        group: null,
        key: 'API_BASE',
        variableType: 'env_var',
        masked: true,
        protected: true,
        raw: false,
        environmentScope: '*'
      },
      tags: {}
    }
    const want = (over: Record<string, unknown>) =>
      desired(
        'gitlab.ci_variable',
        {
          key: 'API_BASE',
          variableType: 'env_var',
          masked: true,
          protected: true,
          raw: false,
          environmentScope: '*',
          value: secret(false),
          ...over
        },
        { project: '1001' }
      )
    expect(gitlabAdapter.plan(ctx, want({}), seen)).toEqual([])
    const flags = gitlabAdapter.plan(ctx, want({ masked: false }), seen)
    expect(flags[0]).toMatchObject({
      kind: 'update',
      changes: [{ field: 'masked', from: true, to: false }]
    })
    const value = gitlabAdapter.plan(ctx, want({ value: secret(true) }), seen)
    expect(value[0]?.changes).toEqual([{ field: 'value', secret: true }])
    expect(JSON.stringify(value)).not.toContain(NEW_VALUE)
    const scope = gitlabAdapter.plan(ctx, want({ environmentScope: 'production' }), seen)
    expect(scope[0]).toMatchObject({ kind: 'replace' })
    const moved = gitlabAdapter.plan(
      ctx,
      desired('gitlab.ci_variable', { key: 'API_BASE', value: secret(false) }, { group: '100' }),
      seen
    )
    expect(moved[0]).toMatchObject({ kind: 'replace' })
  })

  it('a deploy token: replace on scopes, nothing on a date written another way, rotate on request', () => {
    const { ctx } = noCalls()
    const seen: Observed = {
      type: 'gitlab.deploy_token',
      externalId: 'project:1001:55',
      name: 'ci-pull',
      fields: {
        project: '1001',
        group: null,
        name: 'ci-pull',
        scopes: ['read_repository'],
        expiresAt: '2099-01-01T00:00:00.000Z',
        username: 'gitlab+deploy-token-55'
      },
      tags: {},
      status: 'active'
    }
    const want = (over: Record<string, unknown>) =>
      desired(
        'gitlab.deploy_token',
        {
          name: 'ci-pull',
          scopes: ['read_repository'],
          expiresAt: '2099-01-01',
          username: '',
          ...over
        },
        { project: '1001' }
      )
    expect(gitlabAdapter.plan(ctx, want({}), seen)).toEqual([])
    const scopes = gitlabAdapter.plan(
      ctx,
      want({ scopes: ['read_repository', 'read_registry'] }),
      seen
    )
    expect(scopes[0]).toMatchObject({ kind: 'replace' })
    expect(scopes[0]?.reason).toContain('new token is made')
    const rotate = gitlabAdapter.plan(ctx, want({ rotate_outputs: true }), seen)
    expect(rotate).toHaveLength(1)
    expect(rotate[0]).toMatchObject({ kind: 'update', action: 'rotate' })
    const create = gitlabAdapter.plan(ctx, want({}), null)
    expect(create[0]?.reason).toContain('shows the token once')
  })

  it('protected branch, protected environment, schedule: changes in place; name or ref spelling', () => {
    const { ctx } = noCalls()
    const branch: Observed = {
      type: 'gitlab.protected_branch',
      externalId: '1001/main',
      name: 'main',
      fields: {
        project: '1001',
        name: 'main',
        pushAccess: 'maintainers',
        mergeAccess: 'maintainers',
        allowForcePush: false,
        codeOwnerApprovalRequired: false
      },
      tags: {}
    }
    const b = gitlabAdapter.plan(
      ctx,
      desired(
        'gitlab.protected_branch',
        { name: 'main', pushAccess: 'developers' },
        { project: '1001' }
      ),
      branch
    )
    expect(b[0]).toMatchObject({
      kind: 'update',
      changes: [{ field: 'pushAccess', from: 'maintainers', to: 'developers' }]
    })
    expect(
      gitlabAdapter.plan(
        ctx,
        desired('gitlab.protected_branch', { name: 'release/*' }, { project: '1001' }),
        branch
      )[0]
    ).toMatchObject({ kind: 'replace' })

    const env: Observed = {
      type: 'gitlab.protected_environment',
      externalId: '1001/production',
      name: 'production',
      fields: {
        project: '1001',
        environment: 'production',
        deployAccess: 'maintainers',
        approverRole: 'maintainers',
        requiredApprovals: 2
      },
      tags: {}
    }
    const e = gitlabAdapter.plan(
      ctx,
      desired(
        'gitlab.protected_environment',
        { environment: 'production', deployAccess: 'maintainers', requiredApprovals: 3 },
        { project: '1001' }
      ),
      env
    )
    expect(e[0]?.changes).toEqual([{ field: 'requiredApprovals', from: 2, to: 3 }])

    const sched: Observed = {
      type: 'gitlab.pipeline_schedule',
      externalId: '1001/91',
      name: 'Nightly',
      fields: {
        project: '1001',
        description: 'Nightly',
        ref: 'main',
        cron: '0 3 * * *',
        cronTimezone: 'UTC',
        active: true
      },
      tags: {}
    }
    expect(
      gitlabAdapter.plan(
        ctx,
        desired(
          'gitlab.pipeline_schedule',
          {
            description: 'Nightly',
            ref: 'refs/heads/main',
            cron: '0 3 * * *',
            cronTimezone: 'UTC',
            active: true
          },
          { project: '1001' }
        ),
        sched
      )
    ).toEqual([])
    expect(
      gitlabAdapter
        .plan(
          ctx,
          desired(
            'gitlab.pipeline_schedule',
            { description: 'Nightly', ref: 'main', cron: '0 4 * * *', active: false },
            { project: '1001' }
          ),
          sched
        )[0]
        ?.changes.map((c) => c.field)
    ).toEqual(['cron', 'active'])
  })

  it('a webhook: the secret token is a fingerprint, never its value', () => {
    const { ctx } = noCalls()
    const seen: Observed = {
      type: 'gitlab.webhook',
      externalId: '1001/81',
      name: 'x',
      fields: {
        project: '1001',
        url: 'https://hooks.example.test/gitlab',
        events: ['push_events'],
        enableSslVerification: true
      },
      tags: {}
    }
    const ops = gitlabAdapter.plan(
      ctx,
      desired(
        'gitlab.webhook',
        {
          url: 'https://hooks.example.test/gitlab',
          events: ['push_events'],
          enableSslVerification: true,
          token: secret(true)
        },
        { project: '1001' }
      ),
      seen
    )
    expect(ops[0]?.changes).toEqual([{ field: 'token', secret: true }])
  })

  it('a runner: update flags, and a rotate on request', () => {
    const { ctx } = noCalls()
    const seen: Observed = {
      type: 'gitlab.runner',
      externalId: '301',
      name: 'build box',
      fields: {
        description: 'build box',
        tagList: ['docker'],
        runUntagged: true,
        locked: false,
        accessLevel: 'not_protected',
        paused: false,
        maximumTimeout: null
      },
      tags: {},
      status: 'online'
    }
    const ops = gitlabAdapter.plan(
      ctx,
      desired('gitlab.runner', {
        description: 'build box',
        tagList: ['docker', 'arm'],
        paused: true,
        rotate_outputs: true
      }),
      seen
    )
    expect(ops.map((o) => o.action ?? o.kind)).toEqual(['update', 'rotate'])
    expect(ops[0]?.changes.map((c) => c.field)).toEqual(['tagList', 'paused'])
    expect(ops[1]?.reason).toContain('restarted')
  })
})

describe('gitlab adapter: risk flags per type', () => {
  const op = (over: Partial<PlannedOp>): PlannedOp => ({
    kind: 'update',
    type: 'x',
    resourceId: 1,
    externalId: '1',
    reason: '',
    changes: [],
    preconditions: {},
    risk: [],
    ...over
  })
  it('project: public is exposure, archive is clean, destroy is destructive data loss', () => {
    const t = typeSpec('gitlab.project')
    expect(
      t.risk(op({ kind: 'create' }), desired('gitlab.project', { visibility: 'public' }))
    ).toEqual(['public_exposure'])
    expect(
      t.risk(op({ kind: 'create' }), desired('gitlab.project', { visibility: 'private' }))
    ).toEqual([])
    expect(
      t.risk(
        op({ changes: [{ field: 'visibility', from: 'private', to: 'public' }] }),
        desired('gitlab.project', { visibility: 'public' })
      )
    ).toEqual(['public_exposure'])
    expect(t.risk(op({ kind: 'delete', action: 'archive' }), null)).toEqual([])
    expect(t.risk(op({ kind: 'delete', action: 'destroy' }), null)).toEqual([
      'destructive',
      'data_loss'
    ])
  })
  it('protections, variables, keys, hooks and environments: a removal is destructive', () => {
    for (const k of [
      'gitlab.protected_branch',
      'gitlab.protected_environment',
      'gitlab.environment',
      'gitlab.ci_variable',
      'gitlab.deploy_key',
      'gitlab.webhook'
    ])
      expect(typeSpec(k).risk(op({ kind: 'delete' }), null), k).toEqual(['destructive'])
    expect(typeSpec('gitlab.pipeline_schedule').risk(op({ kind: 'delete' }), null)).toEqual([])
    expect(typeSpec('gitlab.group').risk(op({ kind: 'noop' }), null)).toEqual([])
  })
  it('tokens: a replace or rotate is downtime, a removal destructive', () => {
    for (const k of ['gitlab.deploy_token', 'gitlab.runner']) {
      const t = typeSpec(k)
      expect(t.risk(op({ kind: 'replace' }), null)).toEqual(['downtime'])
      expect(t.risk(op({ action: 'rotate' }), null)).toEqual(['downtime'])
      expect(t.risk(op({ kind: 'delete' }), null)).toEqual(['destructive'])
      expect(t.risk(op({ kind: 'create' }), null)).toEqual([])
    }
  })
})

describe('gitlab adapter: apply is idempotent (read-before-write)', () => {
  it('updates a project in place, and does not write when it already matches', async () => {
    const op: PlannedOp = {
      kind: 'update',
      type: 'gitlab.project',
      resourceId: 7,
      externalId: '1001',
      reason: 'x',
      changes: [{ field: 'visibility', from: 'private', to: 'public' }],
      preconditions: {},
      risk: []
    }
    const a = harness([
      PROJECT_ROUTE,
      {
        method: 'PUT',
        path: /^\/api\/v4\/projects\/1001$/,
        body: { ...fx('project'), visibility: 'public' }
      }
    ])
    const r = await gitlabAdapter.apply(
      a.ctx,
      op,
      desired('gitlab.project', { name: 'web-app', visibility: 'public' }, {}, '1001')
    )
    expect(r.ok).toBe(true)
    expect(a.writes()).toHaveLength(1)
    expect(a.writes()[0]?.body).toEqual({ visibility: 'public' })

    const b = harness([PROJECT_ROUTE])
    const again = await gitlabAdapter.apply(
      b.ctx,
      op,
      desired('gitlab.project', { name: 'web-app', visibility: 'private' }, {}, '1001')
    )
    expect(again.ok).toBe(true)
    expect(b.writes()).toHaveLength(0)
  })

  it('creates a project in the pinned group, from a template inside the group only', async () => {
    const op: PlannedOp = {
      kind: 'create',
      type: 'gitlab.project',
      resourceId: 7,
      externalId: null,
      reason: 'x',
      changes: [],
      preconditions: {},
      risk: []
    }
    const a = harness([
      GROUP_ROUTE,
      PROJECT_ROUTE,
      {
        method: 'POST',
        path: /^\/api\/v4\/projects$/,
        status: 201,
        body: {
          ...fx('project'),
          id: 1500,
          name: 'new-app',
          path: 'new-app',
          path_with_namespace: 'acme/new-app'
        }
      },
      {
        method: 'GET',
        path: /^\/api\/v4\/projects\/1500$/,
        body: {
          ...fx('project'),
          id: 1500,
          name: 'new-app',
          path: 'new-app',
          path_with_namespace: 'acme/new-app'
        }
      }
    ])
    const r = await gitlabAdapter.apply(
      a.ctx,
      op,
      desired('gitlab.project', { name: 'New App', templateProject: '1001' })
    )
    expect(r.externalId).toBe('1500')
    const post = a.writes()[0]
    expect(post?.body).toMatchObject({
      name: 'New App',
      path: 'new-app',
      namespace_id: 100,
      visibility: 'private',
      template_project_id: 1001,
      use_custom_template: true
    })
    // A template project outside the group is refused before anything is made.
    const b = harness([
      GROUP_ROUTE,
      { method: 'GET', path: /^\/api\/v4\/projects\/2002$/, body: fx('project-outside') }
    ])
    await expect(
      gitlabAdapter.apply(
        b.ctx,
        op,
        desired('gitlab.project', { name: 'x', templateProject: '2002' })
      )
    ).rejects.toMatchObject({ code: 'GITLAB_OUT_OF_ACCOUNT' })
    expect(b.writes()).toHaveLength(0)
  })

  it('a create that finds a project it did not make says to adopt it; a resumed run reuses it', async () => {
    const op: PlannedOp = {
      kind: 'create',
      type: 'gitlab.project',
      resourceId: 7,
      externalId: null,
      reason: 'x',
      changes: [],
      preconditions: {},
      risk: []
    }
    const routes: Route[] = [
      GROUP_ROUTE,
      PROJECT_ROUTE,
      { method: 'GET', path: /^\/api\/v4\/projects\/acme%2Fweb-app$/, body: fx('project') }
    ]
    const a = harness(routes)
    await expect(
      gitlabAdapter.apply(
        a.ctx,
        op,
        desired('gitlab.project', { name: 'web-app', description: 'taken over' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(a.writes()).toHaveLength(0)

    const found = await gitlabAdapter.findExisting?.(
      a.ctx,
      'gitlab.project',
      desired('gitlab.project', { name: 'web-app' })
    )
    expect(found?.externalId).toBe('1001')

    const b = harness(routes)
    const resumed = await gitlabAdapter.apply(
      b.ctx,
      op,
      desired('gitlab.project', { name: 'web-app' }, {}, '1001')
    )
    expect(resumed.ok).toBe(true)
    expect(resumed.answer).toMatchObject({ already: 'exists' })
    expect(b.writes()).toHaveLength(0)
  })

  it('removing a project archives it; destroy deletes it; a gone project is already done', async () => {
    const del: PlannedOp = {
      kind: 'delete',
      type: 'gitlab.project',
      resourceId: 7,
      externalId: '1001',
      action: 'archive',
      reason: 'x',
      changes: [],
      preconditions: {},
      risk: []
    }
    const a = harness([
      PROJECT_ROUTE,
      { method: 'POST', path: /projects\/1001\/archive$/, body: fx('project-archived') }
    ])
    const r = await gitlabAdapter.apply(a.ctx, del, null)
    expect(r.ok).toBe(true)
    expect(a.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v4/projects/1001/archive'
    ])

    const b = harness([
      PROJECT_ROUTE,
      { method: 'DELETE', path: /^\/api\/v4\/projects\/1001$/, status: 202, body: {} }
    ])
    await gitlabAdapter.apply(b.ctx, { ...del, action: 'destroy' }, null)
    expect(b.writes().map((c) => c.method)).toEqual(['DELETE'])

    const c = harness([])
    const gone = await gitlabAdapter.apply(c.ctx, del, null)
    expect(gone.answer).toMatchObject({ already: 'gone' })
    expect(c.writes()).toHaveLength(0)
  })

  it('a variable: create refuses an existing one; write-only value goes to GitLab once', async () => {
    const op: PlannedOp = {
      kind: 'create',
      type: 'gitlab.ci_variable',
      resourceId: 7,
      externalId: null,
      reason: 'x',
      changes: [],
      preconditions: {},
      risk: []
    }
    const fields = {
      key: 'API_BASE',
      value: secret(true, NEW_VALUE),
      masked: true,
      protected: false,
      environmentScope: '*'
    }
    const exists = harness([
      PROJECT_ROUTE,
      { method: 'GET', path: /projects\/1001\/variables\/API_BASE$/, body: fx('variable') }
    ])
    await expect(
      gitlabAdapter.apply(
        exists.ctx,
        op,
        desired('gitlab.ci_variable', fields, { project: '1001' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(exists.writes()).toHaveLength(0)

    const fresh = harness([
      PROJECT_ROUTE,
      { method: 'POST', path: /projects\/1001\/variables$/, status: 201, body: fx('variable') },
      { method: 'GET', path: /projects\/1001\/variables\/API_BASE$/, body: fx('variable') }
    ])
    // After the POST the read finds it; before it the first read (existing check) must say 404.
    let seen = 0
    const orig = fresh.ctx.fetch
    fresh.ctx.fetch = (async (url: string, init: any) => {
      if (/variables\/API_BASE/.test(url) && (init?.method ?? 'GET') === 'GET' && seen++ === 0)
        return new Response('{}', { status: 404 })
      return orig(url, init)
    }) as typeof fresh.ctx.fetch
    const r = await gitlabAdapter.apply(
      fresh.ctx,
      op,
      desired('gitlab.ci_variable', fields, { project: '1001' })
    )
    expect(r.externalId).toBe('project:1001:API_BASE:*')
    expect(fresh.writes()[0]?.body).toMatchObject({
      key: 'API_BASE',
      value: NEW_VALUE,
      masked: true,
      environment_scope: '*'
    })
    expect(JSON.stringify(r)).not.toContain(NEW_VALUE)
  })

  it('a variable update sends the value only when a new one was sent', async () => {
    const op: PlannedOp = {
      kind: 'update',
      type: 'gitlab.ci_variable',
      resourceId: 7,
      externalId: 'project:1001:API_BASE:*',
      reason: 'x',
      changes: [],
      preconditions: {},
      risk: []
    }
    const routes: Route[] = [
      PROJECT_ROUTE,
      { method: 'GET', path: /projects\/1001\/variables\/API_BASE$/, body: fx('variable') },
      { method: 'PUT', path: /projects\/1001\/variables\/API_BASE$/, body: fx('variable') }
    ]
    const base = {
      key: 'API_BASE',
      masked: true,
      protected: true,
      raw: false,
      variableType: 'env_var',
      environmentScope: '*'
    }
    const a = harness(routes)
    await gitlabAdapter.apply(
      a.ctx,
      op,
      desired(
        'gitlab.ci_variable',
        { ...base, value: secret(true, NEW_VALUE) },
        { project: '1001' },
        op.externalId
      )
    )
    expect(a.writes()[0]?.body).toEqual({ value: NEW_VALUE })
    const b = harness(routes)
    await gitlabAdapter.apply(
      b.ctx,
      op,
      desired(
        'gitlab.ci_variable',
        { ...base, value: secret(false) },
        { project: '1001' },
        op.externalId
      )
    )
    expect(b.writes()).toHaveLength(0)
  })

  it('a named update checks its target: another project than the one in the id is refused', async () => {
    const op: PlannedOp = {
      kind: 'update',
      type: 'gitlab.deploy_token',
      resourceId: 7,
      externalId: 'project:1001:55',
      action: 'rotate',
      reason: 'x',
      changes: [],
      preconditions: {},
      risk: []
    }
    const a = harness([PROJECT_ROUTE])
    await expect(
      gitlabAdapter.apply(
        a.ctx,
        op,
        desired(
          'gitlab.deploy_token',
          { name: 'ci-pull', scopes: ['read_repository'] },
          { project: '1002' }
        )
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
    expect(a.calls).toHaveLength(0)
  })

  it('a stopped-first environment delete: stops, then removes; still stopping is retryable', async () => {
    const del: PlannedOp = {
      kind: 'delete',
      type: 'gitlab.environment',
      resourceId: 7,
      externalId: '1001/31',
      reason: 'x',
      changes: [],
      preconditions: {},
      risk: []
    }
    const a = harness([
      PROJECT_ROUTE,
      { method: 'GET', path: /environments\/31$/, body: fx('environment') },
      { method: 'POST', path: /environments\/31\/stop$/, body: fx('environment-stopped') },
      { method: 'DELETE', path: /environments\/31$/, status: 204 }
    ])
    await gitlabAdapter.apply(a.ctx, del, null)
    expect(a.writes().map((c) => `${c.method} ${/stop$/.test(c.path) ? 'stop' : 'env'}`)).toEqual([
      'POST stop',
      'DELETE env'
    ])
    const b = harness([
      PROJECT_ROUTE,
      { method: 'GET', path: /environments\/31$/, body: fx('environment') },
      { method: 'POST', path: /environments\/31\/stop$/, body: {} },
      {
        method: 'DELETE',
        path: /environments\/31$/,
        status: 403,
        body: { message: 'still running' }
      }
    ])
    await expect(gitlabAdapter.apply(b.ctx, del, null)).rejects.toMatchObject({
      code: 'ENVIRONMENT_STOPPING',
      retryable: true
    })
  })

  it('a protected environment change destroys the old rule by id and adds the new one', async () => {
    const op: PlannedOp = {
      kind: 'update',
      type: 'gitlab.protected_environment',
      resourceId: 7,
      externalId: '1001/production',
      reason: 'x',
      changes: [],
      preconditions: {},
      risk: []
    }
    const a = harness([
      PROJECT_ROUTE,
      {
        method: 'GET',
        path: /protected_environments\/production$/,
        body: fx('protected-environment')
      },
      {
        method: 'PUT',
        path: /protected_environments\/production$/,
        body: fx('protected-environment')
      }
    ])
    await gitlabAdapter.apply(
      a.ctx,
      op,
      desired(
        'gitlab.protected_environment',
        {
          environment: 'production',
          deployAccess: 'maintainers',
          approverRole: 'maintainers',
          requiredApprovals: 3
        },
        { project: '1001' },
        '1001/production'
      )
    )
    expect(a.writes()[0]?.body).toEqual({
      approval_rules: [
        { id: 42, _destroy: true },
        { access_level: 40, required_approvals: 3 }
      ]
    })
  })
})

describe('gitlab adapter: outputs', () => {
  const createToken: PlannedOp = {
    kind: 'create',
    type: 'gitlab.deploy_token',
    resourceId: 7,
    externalId: null,
    reason: 'x',
    changes: [],
    preconditions: {},
    risk: []
  }
  const tokenFields = { name: 'ci-pull', scopes: ['read_repository'], expiresAt: '2099-01-01' }
  const tokenRoutes: Route[] = [
    PROJECT_ROUTE,
    {
      method: 'POST',
      path: /projects\/1001\/deploy_tokens$/,
      status: 201,
      body: fx('deploy-token-created')
    },
    {
      method: 'GET',
      path: /projects\/1001\/deploy_tokens$/,
      body: [
        ...fx('deploy-tokens'),
        { ...fx('deploy-tokens')[0], id: 56, username: 'gitlab+deploy-token-56' }
      ]
    },
    { method: 'DELETE', path: /projects\/1001\/deploy_tokens\/55$/, status: 204 }
  ]

  it('declares outputs: the token is once-only and secret, the user name is neither', () => {
    expect(typeSpec('gitlab.deploy_token').outputs).toEqual([
      { key: 'token', label: 'Deploy token', secret: true, onceOnly: true },
      { key: 'username', label: 'Deploy token user name', secret: false }
    ])
    expect(typeSpec('gitlab.runner').outputs).toEqual([
      { key: 'token', label: 'Runner authentication token', secret: true, onceOnly: true }
    ])
    for (const k of ['gitlab.deploy_token', 'gitlab.runner']) {
      const f = typeSpec(k).fields.find((x: any) => x.key === 'rotate_outputs')
      expect(f).toMatchObject({ kind: 'boolean', trigger: true })
    }
    expect(gitlabAdapter.types.filter((t) => t.outputs).map((t) => t.key)).toEqual([
      'gitlab.deploy_token',
      'gitlab.runner'
    ])
  })

  it('declares outputs and none leak into observed, desired, answer or the call log', async () => {
    const a = harness(tokenRoutes)
    const d = desired('gitlab.deploy_token', tokenFields, { project: '1001' })
    const r = await gitlabAdapter.apply(a.ctx, createToken, d)
    expect(r.externalId).toBe('project:1001:56')
    expect(r.outputs).toEqual({
      token: 'test-secret-deploy-token-56',
      username: 'gitlab+deploy-token-56'
    })
    const { outputs: _o, ...rest } = r
    expect(JSON.stringify(rest)).not.toContain('test-secret-deploy-token-56')
    expect(JSON.stringify(d)).not.toContain('test-secret-deploy-token-56')
    expect(a.writes()[0]?.body).toEqual({
      name: 'ci-pull',
      scopes: ['read_repository'],
      expires_at: '2099-01-01'
    })
  })

  it('rotating makes the new token first, then removes the old one', async () => {
    const a = harness(tokenRoutes)
    const op: PlannedOp = {
      ...createToken,
      kind: 'update',
      externalId: 'project:1001:55',
      action: 'rotate'
    }
    const r = await gitlabAdapter.apply(
      a.ctx,
      op,
      desired('gitlab.deploy_token', tokenFields, { project: '1001' }, 'project:1001:55')
    )
    expect(r.externalId).toBe('project:1001:56')
    expect(r.outputs?.token).toBe('test-secret-deploy-token-56')
    expect(a.writes().map((c) => `${c.method} ${c.path.split('/').slice(-1)[0]}`)).toEqual([
      'POST deploy_tokens',
      'DELETE 55'
    ])
  })

  it('a failed removal of the old token never loses the new one', async () => {
    const a = harness([
      ...tokenRoutes.filter((r) => r.method !== 'DELETE'),
      { method: 'DELETE', path: /deploy_tokens\/55$/, status: 500, body: { message: 'boom' } }
    ])
    const op: PlannedOp = { ...createToken, kind: 'replace', externalId: 'project:1001:55' }
    const r = await gitlabAdapter.apply(
      a.ctx,
      op,
      desired('gitlab.deploy_token', tokenFields, { project: '1001' }, 'project:1001:55')
    )
    expect(r.ok).toBe(true)
    expect(r.outputs?.token).toBe('test-secret-deploy-token-56')
    expect(r.answer).toMatchObject({ oldLeftInPlace: 'project:1001:55' })
  })

  it('a runner: create returns the token as an output; rotate resets it', async () => {
    const made = { ...fx('runner'), id: 303 }
    const a = harness([
      PROJECT_ROUTE,
      {
        method: 'POST',
        path: /^\/api\/v4\/user\/runners$/,
        status: 201,
        body: fx('runner-created')
      },
      { method: 'GET', path: /^\/api\/v4\/runners\/303$/, body: made },
      {
        method: 'POST',
        path: /runners\/301\/reset_authentication_token$/,
        body: fx('runner-reset')
      },
      { method: 'GET', path: /^\/api\/v4\/runners\/301$/, body: fx('runner') }
    ])
    const op: PlannedOp = { ...createToken, type: 'gitlab.runner' }
    const r = await gitlabAdapter.apply(
      a.ctx,
      op,
      desired(
        'gitlab.runner',
        { description: 'build box', tagList: ['docker'] },
        { project: '1001' }
      )
    )
    expect(r.externalId).toBe('303')
    expect(r.outputs).toEqual({ token: 'test-secret-runner-token-303' })
    expect(a.writes()[0]?.body).toMatchObject({
      runner_type: 'project_type',
      project_id: 1001,
      description: 'build box',
      tag_list: ['docker']
    })
    expect(JSON.stringify({ ...r, outputs: undefined })).not.toContain('test-secret-runner-token')

    const rot = await gitlabAdapter.apply(
      a.ctx,
      { ...op, kind: 'update', externalId: '301', action: 'rotate' },
      desired('gitlab.runner', { description: 'build box' }, {}, '301')
    )
    expect(rot.externalId).toBe('301')
    expect(rot.outputs).toEqual({ token: 'test-secret-runner-token-new' })
  })

  it('a runner needs a project or a group, not both and not neither', async () => {
    const a = harness([PROJECT_ROUTE])
    const op: PlannedOp = {
      kind: 'create',
      type: 'gitlab.runner',
      resourceId: 7,
      externalId: null,
      reason: 'x',
      changes: [],
      preconditions: {},
      risk: []
    }
    await expect(
      gitlabAdapter.apply(a.ctx, op, desired('gitlab.runner', { description: 'x' }))
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
    await expect(
      gitlabAdapter.apply(
        a.ctx,
        op,
        desired('gitlab.runner', { description: 'x' }, { project: '1001', group: '100' })
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
  })
})

describe('gitlab adapter: errors', () => {
  it('maps 429 to retryable, with the retry hint and no token in the text', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /^\/api\/v4\/projects\/1001$/,
        status: 429,
        headers: { 'retry-after': '7' },
        body: fx('error-rate-limited')
      }
    ])
    const err = await gitlabAdapter.observe(ctx, 'gitlab.project', '1001').catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'RATE_LIMITED', retryable: true, status: 429 })
    expect(err.message).toContain('retry after 7 s')
    expect(err.message).not.toContain(TOKEN)
  })

  it('a server error is retryable; a bad request is not', async () => {
    const a = harness([{ method: 'GET', path: /projects\/1001$/, status: 503, body: {} }])
    await expect(gitlabAdapter.observe(a.ctx, 'gitlab.project', '1001')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true
    })
    const b = harness([
      { method: 'GET', path: /projects\/1001$/, status: 400, body: { error: 'bad' } }
    ])
    await expect(gitlabAdapter.observe(b.ctx, 'gitlab.project', '1001')).rejects.toMatchObject({
      code: 'PROVIDER_REJECTED',
      retryable: false
    })
  })

  it('secrets never appear in errors: a value GitLab echoes back is scrubbed', async () => {
    const a = harness([
      PROJECT_ROUTE,
      {
        method: 'POST',
        path: /projects\/1001\/variables$/,
        status: 400,
        body: fx('error-echo-value')
      }
    ])
    const op: PlannedOp = {
      kind: 'create',
      type: 'gitlab.ci_variable',
      resourceId: 7,
      externalId: null,
      reason: 'x',
      changes: [],
      preconditions: {},
      risk: []
    }
    const err = await gitlabAdapter
      .apply(
        a.ctx,
        op,
        desired(
          'gitlab.ci_variable',
          { key: 'API_BASE', value: secret(true, NEW_VALUE) },
          { project: '1001' }
        )
      )
      .catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.message).toContain('GitLab answered 400')
    expect(err.message).not.toContain(NEW_VALUE)
    expect(err.message).not.toContain(TOKEN)
  })

  it('a webhook secret token is scrubbed from errors too', async () => {
    const a = harness([
      PROJECT_ROUTE,
      { method: 'GET', path: /projects\/1001\/hooks$/, body: [] },
      {
        method: 'POST',
        path: /projects\/1001\/hooks$/,
        status: 422,
        body: { message: `token ${NEW_VALUE} rejected` }
      }
    ])
    const op: PlannedOp = {
      kind: 'create',
      type: 'gitlab.webhook',
      resourceId: 7,
      externalId: null,
      reason: 'x',
      changes: [],
      preconditions: {},
      risk: []
    }
    const err = await gitlabAdapter
      .apply(
        a.ctx,
        op,
        desired(
          'gitlab.webhook',
          { url: 'https://hooks.example.test/gitlab', token: secret(true, NEW_VALUE) },
          { project: '1001' }
        )
      )
      .catch((e) => e)
    expect(err.message).not.toContain(NEW_VALUE)
  })
})

describe('gitlab adapter: health', () => {
  it('flags an archived project, a dead webhook, an offline runner and an expiring token', async () => {
    const a = harness([
      { method: 'GET', path: /^\/api\/v4\/projects\/1001$/, body: fx('project-archived') },
      { method: 'GET', path: /hooks\/81$/, body: fx('hook-disabled') },
      {
        method: 'GET',
        path: /^\/api\/v4\/runners\/301$/,
        body: { ...fx('runner'), online: false, status: 'offline' }
      },
      {
        method: 'GET',
        path: /deploy_tokens$/,
        body: [{ ...fx('deploy-tokens')[0], expires_at: '2026-12-05T00:00:00.000Z' }]
      }
    ])
    expect((await gitlabAdapter.health?.(a.ctx, 'gitlab.project', '1001'))?.status).toBe('warn')
    expect((await gitlabAdapter.health?.(a.ctx, 'gitlab.webhook', '1001/81'))?.status).toBe('down')
    expect((await gitlabAdapter.health?.(a.ctx, 'gitlab.runner', '301'))?.message).toContain(
      'offline'
    )
    const t = await gitlabAdapter.health?.(a.ctx, 'gitlab.deploy_token', 'project:1001:55')
    expect(t?.status).toBe('warn')
    expect(t?.message).toContain('30 days')
    const gone = await gitlabAdapter.health?.(harness([]).ctx, 'gitlab.project', '1001')
    expect(gone?.status).toBe('down')
  })
})

describe('gitlab estimates', () => {
  const namespace = (body: unknown, config: Record<string, unknown> = CONFIG, status = 200) =>
    harness([{ method: 'GET', path: /^\/api\/v4\/namespaces\/acme$/, status, body }], config)

  it('estimate from recorded price answer: a known zero on Premium, the seat price in the note', async () => {
    const x = namespace(fx('namespace-premium'), {
      baseUrl: 'https://gitlab.com',
      groupPath: 'acme'
    })
    for (const t of gitlabAdapter.types.filter((y) => y.key !== 'gitlab.runner')) {
      const e = await t.estimate?.(x.ctx, null, null)
      expect(e, t.key).toMatchObject({
        basis: 'plan_price',
        confidence: 'list_price',
        monthlyCents: 0,
        priceAsOf: '2026-11-26'
      })
      expect(e?.note).toContain('$29 per seat')
      expect(e?.note).toContain('7 seats')
    }
  })

  it('the Free plan is exact and free; a runner says its minutes are usage', async () => {
    const x = namespace(fx('namespace-free'), { baseUrl: 'https://gitlab.com', groupPath: 'acme' })
    const free = await typeSpec('gitlab.project').estimate(x.ctx, null, null)
    expect(free).toMatchObject({ confidence: 'exact', monthlyCents: 0 })
    expect(free.note).toContain('Free plan')
    const runner = await typeSpec('gitlab.runner').estimate(x.ctx, null, null)
    expect(runner.confidence).toBe('usage_varies')
    expect(runner.note).toContain('runner')
  })

  it('self-managed is by contract, and an unreadable plan is no estimate', async () => {
    const self = namespace(fx('namespace-premium'))
    const e = await typeSpec('gitlab.project').estimate(self.ctx, null, null)
    expect(e.note).toContain('Self-managed')
    expect(e.monthlyCents).toBe(0)
    const none = namespace({ message: 'no' }, CONFIG, 404)
    const u = await typeSpec('gitlab.project').estimate(none.ctx, null, null)
    expect(u.confidence).toBe('unknown')
  })

  it('every type carries the estimate', () => {
    expect(gitlabAdapter.types.every((t) => typeof t.estimate === 'function')).toBe(true)
  })
})
