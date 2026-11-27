import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import sodium from 'libsodium-wrappers'
import { describe, expect, it } from 'vitest'
import { makeProviderContext } from '../../../services/hub/providers/context.js'
import { githubAdapter } from '../../../services/hub/providers/github/index.js'
import { CORE_PROVIDERS } from '../../../services/hub/providers/index.js'
import type {
  DesiredResource,
  Observed,
  PlannedOp,
  ProviderContext
} from '../../../services/hub/providers/types.js'

// Nivaro Hub providers, Task 5: the GitHub adapter driven through makeProviderContext with a fake
// fetch that answers from recorded-shape fixtures (hand-written from GitHub's documented shapes).

const FIX = join(import.meta.dirname, '../../../services/hub/providers/github/__fixtures__')
const fx = (name: string): unknown => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))
const NOW = new Date('2026-11-26T12:00:00Z')

interface Call {
  method: string
  path: string
  headers: Record<string, string>
  body: any
}
interface Reply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function fake(routes: Record<string, Reply | ((c: Call) => Reply)>) {
  const calls: Call[] = []
  const impl = async (url: string, init: any) => {
    const u = new URL(url)
    const call: Call = {
      method: String(init.method ?? 'GET'),
      path: u.pathname,
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(String(init.body)) : undefined
    }
    calls.push(call)
    const hit = routes[`${call.method} ${call.path}`]
    const reply: Reply = (typeof hit === 'function' ? hit(call) : hit) ?? {
      status: 404,
      body: { message: 'Not Found' }
    }
    const status = reply.status ?? 200
    const body = reply.body === undefined ? '' : JSON.stringify(reply.body)
    return new Response(status === 204 || status === 304 ? null : body, {
      status,
      headers: reply.headers ?? {}
    })
  }
  return { calls, impl }
}

const pem = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
}).privateKey

function ctxFor(
  impl: (url: string, init: any) => Promise<Response>,
  auth: 'app' | 'pat' = 'pat',
  extra: { timeoutMs?: number } = {}
): ProviderContext {
  return makeProviderContext({
    adapter: githubAdapter,
    connectionId: Math.floor(Math.random() * 1e6),
    config:
      auth === 'app'
        ? { auth_method: 'app', owner: 'acme', app_id: '123', installation_id: '77' }
        : { auth_method: 'pat', owner: 'acme' },
    secrets: auth === 'app' ? { private_key: pem } : { token: 'test-secret-pat-0000' },
    now: () => NOW,
    fetch: { fetchImpl: impl as any, ...extra }
  })
}

function desired(
  type: string,
  fields: Record<string, unknown>,
  over: Partial<DesiredResource> = {}
): DesiredResource {
  return {
    resourceId: 1,
    type,
    externalId: null,
    scope: 'app',
    appId: 1,
    environmentId: null,
    fields,
    refs: { repository: 'acme/web' },
    tags: {},
    ...over
  }
}

function observedOf(
  type: string,
  ext: string,
  fields: Record<string, unknown>,
  over: Partial<Observed> = {}
): Observed {
  return {
    type,
    externalId: ext,
    name: null,
    fields,
    tags: {},
    version: null,
    status: 'active',
    ...over
  }
}

const ROUTES_REPO = {
  'GET /users/acme': { body: fx('user_acme') },
  'GET /repos/acme/web': { body: fx('repo') }
}

describe('github adapter: registration', () => {
  it('is in CORE_PROVIDERS and declares only api.github.com', () => {
    expect(CORE_PROVIDERS).toContain(githubAdapter)
    expect(githubAdapter.connection.hosts({ owner: 'acme' })).toEqual(['api.github.com'])
    expect(githubAdapter.types.map((t) => t.key)).toEqual([
      'github.repository',
      'github.branch_protection',
      'github.environment',
      'github.actions_secret',
      'github.actions_variable',
      'github.workflow',
      'github.deploy_key',
      'github.webhook'
    ])
  })

  it('validates both connection forms and marks the key and token secret', () => {
    const v = githubAdapter.connection.validate!
    expect(v({ owner: 'acme', auth_method: 'app' }, {}).length).toBe(3)
    expect(v({ owner: 'acme', auth_method: 'pat' }, {})).toEqual([
      'The personal access token is required.'
    ])
    expect(
      v(
        { owner: 'acme', auth_method: 'app', app_id: '1', installation_id: '2' },
        { private_key: '-----BEGIN PRIVATE KEY-----' }
      )
    ).toEqual([])
    const secret = githubAdapter.connection.fields.filter((f) => f.secret).map((f) => f.key)
    expect(secret.sort()).toEqual(['private_key', 'token'])
  })
})

describe('github adapter: testConnection lists missing permissions', () => {
  it('app: signs an RS256 JWT, caches the installation token, names missing permissions', async () => {
    const f = fake({
      'GET /users/acme': { body: fx('user_acme') },
      'POST /app/installations/77/access_tokens': { status: 201, body: fx('installation_token') },
      'GET /installation/repositories': { body: fx('installation_repos') }
    })
    const ctx = ctxFor(f.impl, 'app')
    const r = await githubAdapter.testConnection(ctx)
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(['variables:write'])
    expect(r.identity).toContain('14 repositories')
    expect(r.permissions.find((p) => p.type === 'github.actions_secret')?.has).toBe(true)

    const mint = f.calls.find((c) => c.path.endsWith('/access_tokens'))!
    const jwt = mint.headers.authorization.replace('Bearer ', '').split('.')
    expect(jwt).toHaveLength(3)
    expect(JSON.parse(Buffer.from(jwt[0], 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT'
    })
    const claims = JSON.parse(Buffer.from(jwt[1], 'base64url').toString())
    expect(claims.iss).toBe('123')
    expect(claims.exp - claims.iat).toBe(600)
    // The installation token is used for the next calls and minted once.
    const second = await githubAdapter.testConnection(ctx)
    expect(second.ok).toBe(false)
    expect(f.calls.filter((c) => c.path.endsWith('/access_tokens'))).toHaveLength(1)
    const used = f.calls.filter((c) => c.path === '/installation/repositories')[0]
    expect(used.headers.authorization).toBe('Bearer ghs_test-installation-token-0001')
  })

  it('app: an installation token past its expiry is minted again', async () => {
    let t = NOW
    const f = fake({
      'GET /users/acme': { body: fx('user_acme') },
      'POST /app/installations/77/access_tokens': { status: 201, body: fx('installation_token') },
      'GET /installation/repositories': { body: fx('installation_repos') }
    })
    const ctx = makeProviderContext({
      adapter: githubAdapter,
      connectionId: 4242,
      config: { auth_method: 'app', owner: 'acme', app_id: '123', installation_id: '77' },
      secrets: { private_key: pem },
      now: () => t,
      fetch: { fetchImpl: f.impl as any }
    })
    await githubAdapter.testConnection(ctx)
    const mints = () => f.calls.filter((c) => c.path.endsWith('/access_tokens')).length
    t = new Date('2026-11-26T12:58:30Z') // still more than 60 s before 13:00
    await githubAdapter.testConnection(ctx)
    expect(mints()).toBe(1)
    t = new Date('2026-11-26T12:59:30Z') // inside the 60 s slack before 13:00
    await githubAdapter.testConnection(ctx)
    expect(mints()).toBeGreaterThan(1)
  })

  it('pat: a classic token without repo scope misses every repo permission', async () => {
    const f = fake({
      'GET /users/acme': { body: fx('user_acme') },
      'GET /user': { body: { login: 'rob' }, headers: { 'x-oauth-scopes': 'read:org' } }
    })
    const r = await githubAdapter.testConnection(ctxFor(f.impl))
    expect(r.ok).toBe(false)
    expect(r.identity).toContain('user rob')
    expect(r.missing).toContain('repo')
    expect(r.missing).toEqual(['repo'])
  })

  it('pat: a fine-grained token cannot list scopes, says so, and passes', async () => {
    const f = fake({
      'GET /users/acme': { body: fx('user_acme') },
      'GET /user': { body: { login: 'rob' } }
    })
    const r = await githubAdapter.testConnection(ctxFor(f.impl))
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/fine-grained/)
  })

  it('an unknown account or refused credentials is a failed test, not a throw', async () => {
    const none = await githubAdapter.testConnection(ctxFor(fake({}).impl))
    expect(none).toMatchObject({ ok: false, identity: null })
    const refused = await githubAdapter.testConnection(
      ctxFor(
        fake({ 'GET /users/acme': { status: 401, body: { message: 'Bad credentials' } } }).impl
      )
    )
    expect(refused.ok).toBe(false)
    expect(refused.message).toMatch(/refused the credentials/)
  })
})

describe('github adapter: observe maps provider fields', () => {
  const routes = {
    ...ROUTES_REPO,
    'GET /repos/acme/web/branches/main/protection': { body: fx('protection') },
    'GET /repos/acme/web/environments/production': { body: fx('environment') },
    'GET /repos/acme/web/actions/secrets/DEPLOY_TOKEN': { body: fx('secret') },
    'GET /repos/acme/web/environments/production/secrets/DEPLOY_TOKEN': { body: fx('secret') },
    'GET /repos/acme/web/actions/variables/REGION': { body: fx('variable') },
    'GET /repos/acme/web/actions/workflows/deploy.yml': { body: fx('workflow') },
    'GET /repos/acme/web/keys/42': { body: fx('deploy_key') },
    'GET /repos/acme/web/hooks/12345678': { body: fx('hook') }
  }
  const run = (type: string, ext: string) =>
    githubAdapter.observe(ctxFor(fake(routes).impl), type, ext)

  it('repository', async () => {
    const o = await run('github.repository', 'acme/web')
    expect(o).toMatchObject({
      externalId: 'acme/web',
      status: 'active',
      url: 'https://github.com/acme/web'
    })
    expect(o!.fields).toEqual({
      name: 'web',
      description: 'Marketing site',
      visibility: 'private',
      default_branch: 'main',
      has_issues: true,
      has_wiki: false,
      archived: false,
      topics: ['nivaro', 'web']
    })
  })

  it('branch protection, environment', async () => {
    const p = await run('github.branch_protection', 'acme/web#main')
    expect(p!.fields).toMatchObject({
      repository: 'acme/web',
      branch: 'main',
      required_reviews: 2,
      dismiss_stale_reviews: true,
      required_status_checks: ['ci/build', 'ci/test'],
      strict_status_checks: true,
      enforce_admins: true,
      required_conversation_resolution: true,
      allow_force_pushes: false
    })
    const e = await run('github.environment', 'acme/web#production')
    expect(e!.fields).toMatchObject({
      wait_timer: 30,
      prevent_self_review: true,
      deployment_branches: 'protected'
    })
  })

  it('secret never carries a value; variable does; scoped ids parse the environment', async () => {
    const s = await run('github.actions_secret', 'acme/web#DEPLOY_TOKEN')
    expect(Object.keys(s!.fields).sort()).toEqual(['environment', 'name', 'repository'])
    const es = await run('github.actions_secret', 'acme/web@production#DEPLOY_TOKEN')
    expect(es!.externalId).toBe('acme/web@production#DEPLOY_TOKEN')
    expect(es!.fields.environment).toBe('production')
    const v = await run('github.actions_variable', 'acme/web#REGION')
    expect(v!.fields.value).toBe('us-east-1')
  })

  it('workflow, deploy key, webhook (secret masked by GitHub is not carried)', async () => {
    const w = await run('github.workflow', 'acme/web#deploy.yml')
    expect(w!.fields).toMatchObject({ workflow: 'deploy.yml', enabled: true, name: 'Deploy' })
    const k = await run('github.deploy_key', 'acme/web#42')
    expect(k!.fields).toMatchObject({ title: 'ci deploy', read_only: true })
    const h = await run('github.webhook', 'acme/web#12345678')
    expect(h!.fields).toMatchObject({
      url: 'https://hooks.example.com/gh',
      content_type: 'json',
      events: ['push', 'pull_request'],
      active: true
    })
    expect(JSON.stringify(h)).not.toContain('********')
  })

  it('a missing resource is null', async () => {
    expect(await run('github.repository', 'acme/gone')).toBeNull()
    expect(await run('github.branch_protection', 'acme/web#dev')).toBeNull()
  })

  it('list pages through the account repositories (org, then user fallback)', async () => {
    const f = fake({
      'GET /orgs/acme/repos': {
        body: fx('repo_list'),
        headers: { link: '<https://api.github.com/orgs/acme/repos?page=2>; rel="next"' }
      }
    })
    const page = await githubAdapter.list(ctxFor(f.impl), 'github.repository', null)
    expect(page.items.map((i) => i.externalId)).toEqual(['acme/web', 'acme/old'])
    expect(page.items[1].status).toBe('archived')
    expect(page.cursor).toBe('2')
    const user = fake({ 'GET /users/acme/repos': { body: fx('repo_list') } })
    const p2 = await githubAdapter.list(ctxFor(user.impl), 'github.repository', null)
    expect(p2.cursor).toBeNull()
    expect(user.calls[0].path).toBe('/orgs/acme/repos')
  })

  it('list of a repo-scoped type walks the repositories, skipping archived ones', async () => {
    const f = fake({
      'GET /orgs/acme/repos': { body: fx('repo_list') },
      'GET /repos/acme/web/hooks': { body: [fx('hook')] }
    })
    const page = await githubAdapter.list(ctxFor(f.impl), 'github.webhook', null)
    expect(page.items.map((i) => i.externalId)).toEqual(['acme/web#12345678'])
    expect(f.calls.some((c) => c.path.startsWith('/repos/acme/old'))).toBe(false)
  })
})

describe('github adapter: plan diff per type', () => {
  const repoObs = () =>
    observedOf('github.repository', 'acme/web', {
      name: 'web',
      description: 'Marketing site',
      visibility: 'private',
      default_branch: 'main',
      has_issues: true,
      has_wiki: false,
      archived: false,
      topics: ['nivaro', 'web']
    })
  const plan = (d: DesiredResource | null, o: Observed | null) =>
    githubAdapter.plan(null as any, d, o)

  it('repository: create, update, noop, archive on remove, permanent delete only on request', () => {
    const create = plan(
      desired('github.repository', { name: 'web', visibility: 'public', template: 'acme/tpl' }),
      null
    )
    expect(create).toHaveLength(1)
    expect(create[0].kind).toBe('create')
    expect(create[0].changes.map((c) => c.field).sort()).toEqual(['name', 'template', 'visibility'])

    const upd = plan(
      desired('github.repository', {
        name: 'web',
        description: 'New',
        topics: ['web', 'nivaro'],
        visibility: 'private'
      }),
      repoObs()
    )
    expect(upd[0].kind).toBe('update')
    expect(upd[0].changes).toEqual([{ field: 'description', from: 'Marketing site', to: 'New' }])
    expect(upd[0].preconditions).toEqual({ description: 'Marketing site', status: 'active' })

    expect(plan(desired('github.repository', { name: 'web' }), repoObs())[0].kind).toBe('noop')

    const archive = plan(null, repoObs())
    expect(archive[0]).toMatchObject({ kind: 'delete', action: 'archive' })
    expect(
      plan(null, observedOf('github.repository', 'acme/web', { archived: true }))[0].kind
    ).toBe('noop')

    const destroy = plan(desired('github.repository', { name: 'web', destroy: true }), repoObs())
    expect(destroy[0]).toMatchObject({ kind: 'delete', action: 'destroy' })
  })

  it('branch protection and environment diff only the fields they own', () => {
    const o = observedOf('github.branch_protection', 'acme/web#main', {
      required_reviews: 2,
      dismiss_stale_reviews: true,
      required_status_checks: ['ci/build', 'ci/test'],
      enforce_admins: true
    })
    const p = plan(
      desired('github.branch_protection', {
        branch: 'main',
        required_reviews: 1,
        required_status_checks: ['ci/test', 'ci/build'],
        enforce_admins: true
      }),
      o
    )
    expect(p[0].changes).toEqual([{ field: 'required_reviews', from: 2, to: 1 }])
    const e = plan(
      desired('github.environment', {
        name: 'production',
        wait_timer: 30,
        deployment_branches: 'all'
      }),
      observedOf('github.environment', 'acme/web#production', {
        wait_timer: 30,
        deployment_branches: 'protected'
      })
    )
    expect(e[0].changes).toEqual([{ field: 'deployment_branches', from: 'protected', to: 'all' }])
  })

  it('secrets: updated only when the person sent a new value; value never in the plan', () => {
    const o = observedOf('github.actions_secret', 'acme/web#TOKEN', { name: 'TOKEN' })
    const same = plan(
      desired('github.actions_secret', {
        name: 'TOKEN',
        value: { fingerprint: 'abc', changed: false }
      }),
      o
    )
    expect(same[0].kind).toBe('noop')
    const changed = plan(
      desired('github.actions_secret', {
        name: 'TOKEN',
        value: { fingerprint: 'def', changed: true, plain: 'test-secret-x' }
      }),
      o
    )
    expect(changed[0].kind).toBe('update')
    expect(changed[0].changes).toEqual([{ field: 'value', secret: true }])
    expect(JSON.stringify(changed)).not.toContain('test-secret-x')
    const made = plan(
      desired('github.actions_secret', {
        name: 'TOKEN',
        value: { fingerprint: 'def', changed: true }
      }),
      null
    )
    expect(made[0].changes).toEqual([
      { field: 'name', to: 'TOKEN' },
      { field: 'value', secret: true }
    ])
  })

  it('variable updates on a value change; a deploy key change is a replace', () => {
    const v = plan(
      desired('github.actions_variable', { name: 'REGION', value: 'eu-west-1' }),
      observedOf('github.actions_variable', 'acme/web#REGION', {
        name: 'REGION',
        value: 'us-east-1'
      })
    )
    expect(v[0].kind).toBe('update')
    const k = plan(
      desired('github.deploy_key', {
        title: 'ci deploy',
        key: 'ssh-ed25519 AAAA',
        read_only: false
      }),
      observedOf('github.deploy_key', 'acme/web#42', {
        title: 'ci deploy',
        key: 'ssh-ed25519 AAAA comment',
        read_only: true
      })
    )
    expect(k[0].kind).toBe('replace')
    expect(k[0].changes.map((c) => c.field)).toEqual(['read_only'])
  })

  it('workflow: dispatch is a named op, enable/disable an update, remove a noop', () => {
    const o = observedOf(
      'github.workflow',
      'acme/web#deploy.yml',
      { enabled: true },
      { status: 'active' }
    )
    const p = plan(
      desired('github.workflow', {
        workflow: 'deploy.yml',
        enabled: true,
        dispatch: true,
        ref: 'main',
        inputs: '{"env":"prod"}'
      }),
      o
    )
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({
      kind: 'update',
      action: 'dispatch',
      data: { ref: 'main', inputs: { env: 'prod' } }
    })
    const off = plan(desired('github.workflow', { workflow: 'deploy.yml', enabled: false }), o)
    expect(off[0]).toMatchObject({ kind: 'update', action: 'disable' })
    expect(plan(null, o)[0].kind).toBe('noop')
  })

  it('webhook: secret change updates; events compared as a set', () => {
    const o = observedOf('github.webhook', 'acme/web#1', {
      url: 'https://hooks.example.com/gh',
      content_type: 'json',
      events: ['push', 'pull_request'],
      active: true
    })
    const p = plan(
      desired('github.webhook', {
        url: 'https://hooks.example.com/gh',
        events: ['pull_request', 'push'],
        secret: { fingerprint: 'n', changed: true }
      }),
      o
    )
    expect(p[0].changes).toEqual([{ field: 'secret', secret: true }])
  })
})

describe('github adapter: apply is idempotent (read-before-write)', () => {
  const repoRoutes = (extra: Record<string, any> = {}) => ({
    ...ROUTES_REPO,
    'PATCH /repos/acme/web': (c: Call) => ({ body: { ...(fx('repo') as object), ...c.body } }),
    ...extra
  })

  it('an update that is already in place writes nothing', async () => {
    const f = fake(repoRoutes())
    const d = desired('github.repository', { name: 'web', description: 'Marketing site' })
    const op = githubAdapter.plan(
      null as any,
      d,
      observedOf('github.repository', 'acme/web', { description: 'stale' })
    )[0]
    const r = await githubAdapter.apply(ctxFor(f.impl), op, d)
    expect(r.ok).toBe(true)
    expect(f.calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  it('an update writes only the changed keys, in a safe order around archive', async () => {
    const archived = { ...(fx('repo') as object), archived: true }
    const f = fake(repoRoutes({ 'GET /repos/acme/web': { body: archived } }))
    const d = desired('github.repository', { name: 'web', description: 'New', archived: false })
    const op: PlannedOp = {
      kind: 'update',
      type: 'github.repository',
      resourceId: 1,
      externalId: 'acme/web',
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    await githubAdapter.apply(ctxFor(f.impl), op, d)
    const patches = f.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)
    expect(patches).toEqual([{ archived: false }, { description: 'New' }])
  })

  it('create from template, then follows up on what generate cannot set', async () => {
    let created = false
    const f = fake({
      'GET /repos/acme/new': () =>
        created
          ? {
              body: {
                ...(fx('repo') as object),
                name: 'new',
                full_name: 'acme/new',
                visibility: 'private',
                topics: []
              }
            }
          : { status: 404, body: { message: 'Not Found' } },
      'POST /repos/acme/tpl/generate': () => {
        created = true
        return {
          status: 201,
          body: { ...(fx('repo') as object), name: 'new', full_name: 'acme/new', topics: [] }
        }
      },
      'PUT /repos/acme/new/topics': { body: {} },
      'PATCH /repos/acme/new': { body: {} }
    })
    const d = desired('github.repository', {
      name: 'new',
      template: 'acme/tpl',
      visibility: 'private',
      topics: ['nivaro']
    })
    const op = githubAdapter.plan(null as any, d, null)[0]
    const r = await githubAdapter.apply(ctxFor(f.impl), op, d)
    expect(r.externalId).toBe('acme/new')
    const gen = f.calls.find((c) => c.path.endsWith('/generate'))!
    expect(gen.body).toMatchObject({ owner: 'acme', name: 'new', private: true })
    expect(f.calls.find((c) => c.path.endsWith('/topics'))?.body).toEqual({ names: ['nivaro'] })
  })

  it('create onto a resource the Hub did not make is ALREADY_EXISTS, for every type, with no write', async () => {
    const f = fake({
      ...repoRoutes(),
      'GET /repos/acme/web/branches/main/protection': { body: fx('protection') },
      'GET /repos/acme/web/environments/production': { body: fx('environment') },
      'GET /repos/acme/web/actions/secrets/DEPLOY_TOKEN': { body: fx('secret') },
      'GET /repos/acme/web/actions/variables/REGION': { body: fx('variable') },
      'GET /repos/acme/web/keys': { body: [fx('deploy_key')] },
      'GET /repos/acme/web/hooks': { body: [fx('hook')] }
    })
    const cases: Array<[string, Record<string, unknown>]> = [
      ['github.repository', { name: 'web' }],
      ['github.branch_protection', { branch: 'main', required_reviews: 0 }],
      ['github.environment', { name: 'production' }],
      [
        'github.actions_secret',
        { name: 'DEPLOY_TOKEN', value: { fingerprint: 'f', changed: true, plain: 'test-secret-1' } }
      ],
      ['github.actions_variable', { name: 'REGION', value: 'x' }],
      [
        'github.deploy_key',
        {
          title: 't',
          key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItestkeytestkeytestkeytestkeytestkeytestkeyAB',
          read_only: false
        }
      ],
      ['github.webhook', { url: 'https://hooks.example.com/gh', events: ['push'] }]
    ]
    for (const [type, fields] of cases) {
      const d = desired(type, fields)
      const err = await githubAdapter
        .apply(ctxFor(f.impl), githubAdapter.plan(null as any, d, null)[0], d)
        .catch((e) => e)
      expect(err, type).toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
      expect(err.message).toMatch(/Adopt/)
    }
    expect(f.calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  it('a resumed create (external id recorded) continues onto its own resource without a second create', async () => {
    const f = fake(repoRoutes())
    const d = desired(
      'github.repository',
      { name: 'web', description: 'Marketing site', topics: ['nivaro', 'web'] },
      { externalId: 'acme/web' }
    )
    const op = githubAdapter.plan(null as any, d, null)[0]
    const r = await githubAdapter.apply(ctxFor(f.impl), op, d)
    expect(r.externalId).toBe('acme/web')
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('removing a repository archives it; destroy deletes; both tolerate a missing one', async () => {
    const f = fake(repoRoutes({ 'DELETE /repos/acme/web': { status: 204 } }))
    const archive = githubAdapter.plan(
      null as any,
      null,
      observedOf('github.repository', 'acme/web', { archived: false })
    )[0]
    await githubAdapter.apply(ctxFor(f.impl), archive, null)
    expect(f.calls.map((c) => c.method)).toEqual(['GET', 'PATCH', 'GET'])
    expect(f.calls[1].body).toEqual({ archived: true })
    expect(f.calls.some((c) => c.method === 'DELETE')).toBe(false)

    const g = fake(repoRoutes({ 'DELETE /repos/acme/web': { status: 204 } }))
    const d = desired('github.repository', { name: 'web', destroy: true })
    const destroy = githubAdapter.plan(
      null as any,
      d,
      observedOf('github.repository', 'acme/web', {})
    )[0]
    await githubAdapter.apply(ctxFor(g.impl), destroy, d)
    expect(g.calls.some((c) => c.method === 'DELETE')).toBe(true)

    const gone = fake({})
    const r = await githubAdapter.apply(ctxFor(gone.impl), archive, null)
    expect(r).toMatchObject({ ok: true, observed: null, answer: { alreadyGone: true } })
  })

  it('a secret is sealed with the public key (libsodium sealed box) and the plain value is never sent', async () => {
    await sodium.ready
    const kp = sodium.crypto_box_keypair()
    const keyB64 = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
    const f = fake({
      'GET /repos/acme/web/actions/secrets/DEPLOY_TOKEN': () => ({ body: fx('secret') }),
      'GET /repos/acme/web/actions/secrets/public-key': { body: { key_id: 'k1', key: keyB64 } },
      'PUT /repos/acme/web/actions/secrets/DEPLOY_TOKEN': { status: 204 }
    })
    const d = desired('github.actions_secret', {
      name: 'DEPLOY_TOKEN',
      value: { fingerprint: 'f', changed: true, plain: 'test-secret-value-9' }
    })
    const op = githubAdapter.plan(
      null as any,
      d,
      observedOf('github.actions_secret', 'acme/web#DEPLOY_TOKEN', { name: 'DEPLOY_TOKEN' })
    )[0]
    await githubAdapter.apply(ctxFor(f.impl), op, d)
    const put = f.calls.find((c) => c.method === 'PUT')!
    expect(put.body.key_id).toBe('k1')
    expect(JSON.stringify(put.body)).not.toContain('test-secret-value-9')
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(put.body.encrypted_value, sodium.base64_variants.ORIGINAL),
      kp.publicKey,
      kp.privateKey
    )
    expect(sodium.to_string(opened)).toBe('test-secret-value-9')
  })

  it('a secret write without the plain value fails clearly, before any write', async () => {
    const f = fake({})
    const d = desired('github.actions_secret', {
      name: 'X_TOKEN',
      value: { fingerprint: 'f', changed: true }
    })
    const op = githubAdapter.plan(null as any, d, null)[0]
    await expect(githubAdapter.apply(ctxFor(f.impl), op, d)).rejects.toMatchObject({
      code: 'SECRET_VALUE_MISSING'
    })
    expect(f.calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('variable create when it exists becomes an update (no duplicate POST); environment variables use the env path', async () => {
    const f = fake({
      'GET /repos/acme/web/actions/variables/REGION': { body: fx('variable') },
      'PATCH /repos/acme/web/actions/variables/REGION': { status: 204 }
    })
    const d = desired(
      'github.actions_variable',
      { name: 'REGION', value: 'eu-west-1' },
      { externalId: 'acme/web#REGION' }
    )
    await githubAdapter.apply(ctxFor(f.impl), githubAdapter.plan(null as any, d, null)[0], d)
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false)
    expect(f.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      name: 'REGION',
      value: 'eu-west-1'
    })

    const g = fake({
      'GET /repos/acme/web/environments/production/variables/REGION': { status: 404, body: {} },
      'POST /repos/acme/web/environments/production/variables': { status: 201 }
    })
    const e = desired('github.actions_variable', {
      name: 'REGION',
      value: 'x',
      environment: 'production'
    })
    const r = await githubAdapter.apply(
      ctxFor(g.impl),
      githubAdapter.plan(null as any, e, null)[0],
      e
    )
    expect(r.externalId).toBe('acme/web@production#REGION')
  })

  it('a deploy key that is already there is reused, not added again', async () => {
    const f = fake({
      'GET /repos/acme/web/keys': { body: [fx('deploy_key')] },
      'GET /repos/acme/web/keys/42': { body: fx('deploy_key') }
    })
    const d = desired(
      'github.deploy_key',
      {
        title: 'ci deploy',
        key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItestkeytestkeytestkeytestkeytestkeytestkeyAB host',
        read_only: true
      },
      { externalId: 'acme/web#42' }
    )
    const r = await githubAdapter.apply(
      ctxFor(f.impl),
      githubAdapter.plan(null as any, d, null)[0],
      d
    )
    expect(r.externalId).toBe('acme/web#42')
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('a webhook that exists for the url is updated, with the secret sent when held', async () => {
    const f = fake({
      'GET /repos/acme/web/hooks': { body: [fx('hook')] },
      'PATCH /repos/acme/web/hooks/12345678': { body: fx('hook') },
      'GET /repos/acme/web/hooks/12345678': { body: fx('hook') }
    })
    const d = desired(
      'github.webhook',
      {
        url: 'https://hooks.example.com/gh',
        events: ['push'],
        secret: { fingerprint: 'f', changed: true, plain: 'test-secret-hook-1' }
      },
      { externalId: 'acme/web#12345678' }
    )
    await githubAdapter.apply(ctxFor(f.impl), githubAdapter.plan(null as any, d, null)[0], d)
    expect(f.calls.some((c) => c.method === 'POST')).toBe(false)
    expect(f.calls.find((c) => c.method === 'PATCH')?.body.config.secret).toBe('test-secret-hook-1')
  })

  it('branch protection PUT carries the full body; environment PUT maps the branch policy', async () => {
    let put1 = false
    let put2 = false
    const f = fake({
      'PUT /repos/acme/web/branches/release/v1/protection': () => {
        put1 = true
        return { body: fx('protection') }
      },
      'GET /repos/acme/web/branches/release/v1/protection': () =>
        put1 ? { body: fx('protection') } : { status: 404, body: {} },
      'PUT /repos/acme/web/environments/staging': () => {
        put2 = true
        return { body: fx('environment') }
      },
      'GET /repos/acme/web/environments/staging': () =>
        put2 ? { body: fx('environment') } : { status: 404, body: {} }
    })
    const bp = desired('github.branch_protection', {
      branch: 'release/v1',
      required_reviews: 0,
      required_status_checks: ['ci']
    })
    await githubAdapter.apply(ctxFor(f.impl), githubAdapter.plan(null as any, bp, null)[0], bp)
    const put = f.calls.find((c) => c.path.endsWith('/protection') && c.method === 'PUT')!
    expect(put.body.required_pull_request_reviews).toBeNull()
    expect(put.body.required_status_checks).toEqual({ strict: false, contexts: ['ci'] })
    expect(put.body.restrictions).toBeNull()
    const env = desired('github.environment', {
      name: 'staging',
      wait_timer: 5,
      deployment_branches: 'selected'
    })
    await githubAdapter.apply(ctxFor(f.impl), githubAdapter.plan(null as any, env, null)[0], env)
    expect(f.calls.find((c) => c.path.endsWith('/staging') && c.method === 'PUT')?.body).toEqual({
      wait_timer: 5,
      prevent_self_review: false,
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
    })
  })

  it('workflow dispatch posts to the dispatches endpoint on the default branch when no ref is set', async () => {
    const f = fake({
      'GET /repos/acme/web/actions/workflows/deploy.yml': { body: fx('workflow') },
      'GET /repos/acme/web': { body: fx('repo') },
      'POST /repos/acme/web/actions/workflows/deploy.yml/dispatches': { status: 204 }
    })
    const d = desired('github.workflow', {
      workflow: 'deploy.yml',
      enabled: true,
      dispatch: true,
      inputs: '{"env":"prod"}'
    })
    const o = observedOf(
      'github.workflow',
      'acme/web#deploy.yml',
      { enabled: true },
      { status: 'active' }
    )
    const op = githubAdapter.plan(null as any, d, o)[0]
    const r = await githubAdapter.apply(ctxFor(f.impl), op, d)
    expect(r.answer).toMatchObject({ dispatched: true })
    expect(f.calls.find((c) => c.method === 'POST')?.body).toEqual({
      ref: 'main',
      inputs: { env: 'prod' }
    })

    const other = desired(
      'github.workflow',
      { workflow: 'deploy.yml', dispatch: true },
      { refs: { repository: 'acme/other' } }
    )
    await expect(githubAdapter.apply(ctxFor(f.impl), op, other)).rejects.toMatchObject({
      code: 'TARGET_MISMATCH'
    })
    await expect(githubAdapter.apply(ctxFor(f.impl), op, null)).rejects.toMatchObject({
      code: 'TARGET_MISMATCH'
    })

    const off = fake({
      'GET /repos/acme/web/actions/workflows/deploy.yml': {
        body: { ...(fx('workflow') as object), state: 'disabled_manually' }
      }
    })
    await expect(githubAdapter.apply(ctxFor(off.impl), op, d)).rejects.toMatchObject({
      code: 'WORKFLOW_DISABLED'
    })
  })
})

describe('github adapter: maps 429 to retryable', () => {
  const op: PlannedOp = {
    kind: 'delete',
    type: 'github.webhook',
    resourceId: 1,
    externalId: 'acme/web#1',
    reason: '',
    changes: [],
    preconditions: {},
    risk: []
  }

  it('429, 403 with an exhausted limit, and 5xx retry; 401, 403, 422 do not', async () => {
    const cases: Array<[number, Record<string, string>, boolean, string]> = [
      [429, {}, true, 'RATE_LIMITED'],
      [403, { 'x-ratelimit-remaining': '0' }, true, 'RATE_LIMITED'],
      [403, { 'retry-after': '30' }, true, 'RATE_LIMITED'],
      [502, {}, true, 'PROVIDER_UNAVAILABLE'],
      [401, {}, false, 'AUTH_FAILED'],
      [403, {}, false, 'FORBIDDEN'],
      [422, {}, false, 'VALIDATION']
    ]
    for (const [status, headers, retryable, code] of cases) {
      const f = fake({
        'GET /repos/acme/web/hooks/1': {
          status,
          headers,
          body:
            status === 403 && !Object.keys(headers).length
              ? { message: 'Resource not accessible by integration' }
              : fx('rate_limited')
        }
      })
      const err = await githubAdapter.apply(ctxFor(f.impl), op, null).catch((e) => e)
      expect(err).toMatchObject({ name: 'ProviderError', code, retryable, status })
    }
  })

  it('a timeout is a retryable error, a refused host is not', async () => {
    const hang = (_u: string, init: any) =>
      new Promise<Response>((_res, rej) =>
        init.signal.addEventListener('abort', () => rej(new Error('aborted')))
      )
    const err = await githubAdapter
      .observe(ctxFor(hang, 'pat', { timeoutMs: 20 }), 'github.repository', 'acme/web')
      .catch((e) => e)
    expect(err).toMatchObject({ code: 'FETCH_TIMEOUT', retryable: true })
  })
})

describe('github adapter: risk flags per type', () => {
  const spec = (k: string) => githubAdapter.types.find((t) => t.key === k)!
  const op = (kind: PlannedOp['kind'], over: Partial<PlannedOp> = {}): PlannedOp => ({
    kind,
    type: 'x',
    resourceId: 1,
    externalId: 'e',
    reason: '',
    changes: [],
    preconditions: {},
    risk: [],
    ...over
  })

  it('repository: public exposure, archive is clean, permanent delete is destructive + data_loss', () => {
    const r = spec('github.repository')
    expect(r.risk(op('create'), desired('github.repository', { visibility: 'public' }))).toEqual([
      'public_exposure'
    ])
    expect(r.risk(op('create'), desired('github.repository', { visibility: 'private' }))).toEqual(
      []
    )
    expect(
      r.risk(
        op('update', { changes: [{ field: 'description' }] }),
        desired('github.repository', { visibility: 'public' })
      )
    ).toEqual([])
    expect(
      r.risk(
        op('update', { changes: [{ field: 'visibility' }] }),
        desired('github.repository', { visibility: 'public' })
      )
    ).toEqual(['public_exposure'])
    expect(r.risk(op('delete', { action: 'archive' }), null)).toEqual([])
    expect(r.risk(op('delete', { action: 'destroy' }), null)).toEqual(['destructive', 'data_loss'])
  })

  it('environment delete loses its secrets; secret delete loses an unrecoverable value', () => {
    expect(spec('github.environment').risk(op('delete'), null)).toEqual([
      'destructive',
      'data_loss'
    ])
    expect(spec('github.actions_secret').risk(op('delete'), null)).toEqual([
      'destructive',
      'data_loss'
    ])
    expect(spec('github.actions_variable').risk(op('delete'), null)).toEqual(['destructive'])
    expect(spec('github.branch_protection').risk(op('delete'), null)).toEqual(['destructive'])
  })

  it('a writable deploy key and a plain-http webhook are public exposure', () => {
    const k = spec('github.deploy_key')
    expect(k.risk(op('create'), desired('github.deploy_key', { read_only: false }))).toEqual([
      'public_exposure'
    ])
    expect(k.risk(op('replace'), desired('github.deploy_key', { read_only: false }))).toEqual([
      'public_exposure'
    ])
    expect(k.risk(op('create'), desired('github.deploy_key', { read_only: true }))).toEqual([])
    const w = spec('github.webhook')
    expect(
      w.risk(op('create'), desired('github.webhook', { url: 'http://x.example.com' }))
    ).toEqual(['public_exposure'])
    expect(
      w.risk(op('create'), desired('github.webhook', { url: 'https://x.example.com' }))
    ).toEqual([])
    expect(w.risk(op('delete'), null)).toEqual(['destructive'])
  })

  it('workflow dispatch carries no flag; reversibility excludes write-only values and destroy', () => {
    expect(spec('github.workflow').risk(op('update', { action: 'dispatch' }), null)).toEqual([])
    const rev = spec('github.actions_secret').reversible as (f: string) => boolean
    expect(rev('value')).toBe(false)
    const rrev = spec('github.repository').reversible as (f: string) => boolean
    expect(rrev('destroy')).toBe(false)
    expect(rrev('description')).toBe(true)
  })
})

describe('github adapter: secrets never appear in errors', () => {
  it('the minted installation token and the PAT are masked in provider text', async () => {
    const f = fake({
      'POST /app/installations/77/access_tokens': { status: 201, body: fx('installation_token') },
      'GET /repos/acme/web/hooks/1': { status: 429, body: fx('rate_limited') }
    })
    const ctx = ctxFor(f.impl, 'app')
    const op: PlannedOp = {
      kind: 'delete',
      type: 'github.webhook',
      resourceId: 1,
      externalId: 'acme/web#1',
      reason: '',
      changes: [],
      preconditions: {},
      risk: []
    }
    const err = await githubAdapter.apply(ctx, op, null).catch((e) => e)
    expect(err.code).toBe('RATE_LIMITED')
    expect(err.message).not.toContain('ghs_test-installation-token-0001')
    expect(err.message).toContain('rate limiting')

    const pat = fake({
      'GET /repos/acme/web': {
        status: 422,
        body: { message: 'bad token test-secret-pat-0000 sent' }
      }
    })
    const e2 = await githubAdapter
      .observe(ctxFor(pat.impl), 'github.repository', 'acme/web')
      .catch((e) => e)
    expect(e2.message).not.toContain('test-secret-pat-0000')
  })

  it('a bad private key fails without echoing the key', async () => {
    const ctx = makeProviderContext({
      adapter: githubAdapter,
      connectionId: 9,
      config: { auth_method: 'app', owner: 'acme', app_id: '1', installation_id: '2' },
      secrets: {
        private_key: '-----BEGIN PRIVATE KEY-----\ntest-secret-garbage\n-----END PRIVATE KEY-----'
      },
      now: () => NOW,
      fetch: { fetchImpl: fake({}).impl as any }
    })
    const err = await githubAdapter.observe(ctx, 'github.repository', 'acme/web').catch((e) => e)
    expect(err.code).toBe('AUTH_FAILED')
    expect(err.message).not.toContain('test-secret-garbage')
  })

  it('the value of a resource secret is masked when GitHub echoes it back', async () => {
    const f = fake({
      'GET /repos/acme/web/actions/secrets/X_TOKEN': { status: 404, body: {} },
      'GET /repos/acme/web/actions/secrets/public-key': {
        status: 422,
        body: { message: 'rejected test-secret-echo-77' }
      }
    })
    const d = desired('github.actions_secret', {
      name: 'X_TOKEN',
      value: { fingerprint: 'f', changed: true, plain: 'test-secret-echo-77' }
    })
    const err = await githubAdapter
      .apply(ctxFor(f.impl), githubAdapter.plan(null as any, d, null)[0], d)
      .catch((e) => e)
    expect(err.code).toBe('VALIDATION')
    expect(err.message).not.toContain('test-secret-echo-77')
  })

  it('never calls a host other than api.github.com', async () => {
    const f = fake({})
    const ctx = ctxFor(f.impl)
    await expect(ctx.fetch('https://evil.example.com/x')).rejects.toMatchObject({
      code: 'HOST_NOT_ALLOWED'
    })
    await expect(ctx.fetch('http://api.github.com/x')).rejects.toMatchObject({
      code: 'HOST_NOT_ALLOWED'
    })
    expect(f.calls).toHaveLength(0)
  })
})

describe('github adapter: identities cannot escape their endpoint', () => {
  const del = (type: string, ext: string): PlannedOp => ({
    kind: 'delete',
    type,
    resourceId: 1,
    externalId: ext,
    reason: '',
    changes: [],
    preconditions: {},
    risk: []
  })

  it('dot segments (also %2e) are refused with BAD_ID before any call', async () => {
    const f = fake({})
    const ctx = ctxFor(f.impl)
    const bad: Array<[string, string]> = [
      ['github.environment', 'acme/web#..'],
      ['github.environment', 'acme/web#%2e%2e'],
      ['github.environment', 'acme/web#.'],
      ['github.environment', 'acme/web#a/b'],
      ['github.environment', 'acme/web#a\\b'],
      ['github.actions_secret', 'acme/web@..#TOKEN'],
      ['github.actions_secret', 'acme/web#..'],
      ['github.actions_variable', 'acme/web#../x'],
      ['github.workflow', 'acme/web#..'],
      ['github.workflow', 'acme/web#deploy.txt'],
      ['github.workflow', 'acme/web#a/b.yml'],
      ['github.deploy_key', 'acme/web#..'],
      ['github.deploy_key', 'acme/web#12/../3'],
      ['github.webhook', 'acme/web#%2e%2e'],
      ['github.webhook', 'acme/web#1a'],
      ['github.repository', 'acme/..'],
      ['github.repository', '../web'],
      ['github.repository', 'ac me/web'],
      ['github.branch_protection', 'acme/web#..'],
      ['github.branch_protection', 'acme/web#a/../b'],
      ['github.branch_protection', 'acme/web#/main'],
      ['github.branch_protection', 'acme/web#main/'],
      ['github.branch_protection', 'acme/web#a//b'],
      ['github.branch_protection', 'acme/web#a@{b'],
      ['github.branch_protection', 'acme/web#a\\b'],
      ['github.branch_protection', 'acme/web#a.lock'],
      ['github.branch_protection', 'acme/web#a\u0007b'],
      ['github.branch_protection', 'acme/web#a b']
    ]
    for (const [type, ext] of bad) {
      await expect(githubAdapter.observe(ctx, type, ext), `${type} ${ext}`).rejects.toMatchObject({
        code: 'BAD_ID',
        retryable: false
      })
      await expect(
        githubAdapter.apply(ctx, del(type, ext), null),
        `${type} ${ext}`
      ).rejects.toMatchObject({
        code: 'BAD_ID'
      })
    }
    expect(f.calls).toHaveLength(0)
  })

  it('a bad name in a create is refused before any write', async () => {
    const f = fake({})
    const ctx = ctxFor(f.impl)
    const cases: Array<[string, Record<string, unknown>]> = [
      ['github.environment', { name: '..' }],
      ['github.actions_variable', { name: '../x', value: 'v' }],
      ['github.branch_protection', { branch: 'a/../b' }],
      ['github.repository', { name: '..' }]
    ]
    for (const [type, fields] of cases) {
      const d = desired(type, fields, { externalId: 'acme/web#x' })
      await expect(
        githubAdapter.apply(ctx, githubAdapter.plan(null as any, d, null)[0], d),
        type
      ).rejects.toMatchObject({ code: 'BAD_ID' })
    }
    expect(f.calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  it('ordinary names still work (spaces in environments, slashes in branches)', async () => {
    const f = fake({
      'GET /repos/acme/web/environments/QA%20blue': {
        body: { ...(fx('environment') as object), name: 'QA blue' }
      },
      'GET /repos/acme/web/branches/feature/x-1/protection': { body: fx('protection') }
    })
    const ctx = ctxFor(f.impl)
    const env = await githubAdapter.observe(ctx, 'github.environment', 'acme/web#QA blue')
    expect(env?.name).toBe('QA blue')
    expect(
      await githubAdapter.observe(ctx, 'github.branch_protection', 'acme/web#feature/x-1')
    ).not.toBeNull()
  })
})
