import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 20: the Docker Hub adapter against recorded (fake-valued) answers.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const { ensureCoreProviders } = await import('../../../services/hub/providers/index.js')
const { getProvider } = await import('../../../services/hub/providers/registry.js')
const { dockerhubAdapter } = await import('../../../services/hub/providers/dockerhub/index.js')
const { setPinReader } = await import('../../../services/hub/providers/dockerhub/pins.js')

import type { DesiredResource, Observed, PlannedOp } from '../../../services/hub/providers/types.js'

const FIX = join(import.meta.dirname, '../../../services/hub/providers/dockerhub/__fixtures__')
const fx = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'))

const TOKEN = 'test-secret-access-token-0001'
const JWT = 'test-secret-jwt-0001'
const NS = 'testorg'
// The token cache is per connection id: every test gets its own so none inherits a login.
let nextConnection = 100

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

function harness(routes: Route[], config: Record<string, unknown> = {}) {
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
    if (call.method === 'POST' && call.path === '/v2/auth/token')
      return new Response(JSON.stringify(fx('auth_token')), { status: 200 })
    const hit = routes.find((r) => r.method === call.method && r.path.test(call.path))
    if (!hit) return new Response(JSON.stringify(fx('error-not-found')), { status: 404 })
    const status = hit.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(hit.body ?? {}), {
      status,
      headers: hit.headers
    })
  }
  const ctx = makeProviderContext({
    adapter: dockerhubAdapter,
    connectionId: ++nextConnection,
    config: { namespace: NS, username: NS, ...config },
    secrets: { token: TOKEN },
    fetch: { fetchImpl: fetchImpl as any, timeoutMs: 500 }
  })
  return {
    ctx,
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET' && c.path !== '/v2/auth/token')
  }
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

const REPO = 'dockerhub.repository'
const TEAM = 'dockerhub.repo_team_permission'
const TAG = 'dockerhub.tag'

const ID_REPO = `${NS}/nivaro-app`
const ID_TAG = `${NS}/nivaro-app/0.3.217`
const ID_TEAM = `${NS}/nivaro-app/builders`

const repoOk = {
  method: 'GET',
  path: /^\/v2\/namespaces\/testorg\/repositories\/nivaro-app$/,
  body: fx('repo')
}
const tagOk = {
  method: 'GET',
  path: /^\/v2\/namespaces\/testorg\/repositories\/nivaro-app\/tags\/0\.3\.217$/,
  body: fx('tag')
}

function op(over: Partial<PlannedOp>): PlannedOp {
  return {
    kind: 'update',
    type: REPO,
    resourceId: 7,
    externalId: ID_REPO,
    reason: 'x',
    changes: [],
    preconditions: {},
    risk: [],
    ...over
  }
}

beforeEach(() => {
  setPinReader(null)
})
afterEach(() => {
  setPinReader(null)
  vi.unstubAllEnvs()
})

describe('dockerhub adapter: registration', () => {
  it('is a core provider on the three Docker hosts with a pinned namespace and secret token', () => {
    ensureCoreProviders()
    expect(getProvider('dockerhub')).toBe(dockerhubAdapter)
    expect(dockerhubAdapter.connection.hosts({ namespace: NS })).toEqual([
      'hub.docker.com',
      'auth.docker.io',
      'registry-1.docker.io'
    ])
    expect(dockerhubAdapter.connection.fields.find((f) => f.key === 'token')?.secret).toBe(true)
    expect(dockerhubAdapter.connection.describe({ namespace: NS })).not.toContain(TOKEN)
    expect(
      dockerhubAdapter.connection.validate?.({ namespace: 'No Good', username: 'x' }, {})
    ).not.toEqual([])
    expect(dockerhubAdapter.types.map((t) => t.key)).toEqual([REPO, TEAM, TAG])
  })

  it('refuses a host outside the three', async () => {
    const { ctx } = harness([])
    await expect(ctx.fetch('https://example.com/x')).rejects.toThrow(/allowed hosts/)
  })

  it('declares outputs and none leak into observed or desired', async () => {
    // Docker Hub hands out no values and sends no messages.
    for (const t of dockerhubAdapter.types) {
      expect(t.outputs).toBeUndefined()
      expect(t.sends).toBeUndefined()
    }
    expect(dockerhubAdapter.notify).toBeUndefined()
    const { ctx } = harness([repoOk, tagOk])
    const seen = [
      await dockerhubAdapter.observe(ctx, REPO, ID_REPO),
      await dockerhubAdapter.observe(ctx, TAG, ID_TAG)
    ]
    const text = JSON.stringify(seen)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(JWT)
  })
})

describe('dockerhub adapter: testConnection lists missing permissions', () => {
  it('an organization with a readable namespace has nothing missing', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/v2\/namespaces\/testorg\/repositories$/, body: fx('repos_page') },
      { method: 'GET', path: /^\/v2\/orgs\/testorg$/, body: fx('org') }
    ])
    const t = await dockerhubAdapter.testConnection(ctx)
    expect(t.ok).toBe(true)
    expect(t.missing).toEqual([])
    expect(t.identity).toContain('organization')
  })

  it('a personal namespace misses the team permission', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/v2\/namespaces\/testorg\/repositories$/, body: fx('repos_page') }
    ])
    const t = await dockerhubAdapter.testConnection(ctx)
    expect(t.ok).toBe(true)
    expect(t.missing).toEqual(['organization owner, to manage team access'])
  })

  it('a namespace the token cannot see fails with every permission missing', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/v2\/namespaces\/testorg\/repositories$/, status: 403, body: {} }
    ])
    const t = await dockerhubAdapter.testConnection(ctx)
    expect(t.ok).toBe(false)
    expect(t.missing.length).toBe(t.permissions.length)
    expect(JSON.stringify(t)).not.toContain(TOKEN)
  })
})

describe('dockerhub adapter: observe maps provider fields', () => {
  it('maps a repository, a tag and a team permission', async () => {
    const { ctx } = harness([
      repoOk,
      tagOk,
      {
        method: 'GET',
        path: /^\/v2\/repositories\/testorg\/nivaro-app\/groups$/,
        body: fx('groups')
      }
    ])
    const repo = await dockerhubAdapter.observe(ctx, REPO, ID_REPO)
    expect(repo?.fields).toMatchObject({
      name: 'nivaro-app',
      private: true,
      description: 'Test image',
      fullDescription: 'Long test description',
      pullCount: 42
    })
    const tag = await dockerhubAdapter.observe(ctx, TAG, ID_TAG)
    expect(tag?.fields).toMatchObject({
      repository: ID_REPO,
      name: '0.3.217',
      digest: expect.stringMatching(/^sha256:/),
      pinned: null
    })
    const team = await dockerhubAdapter.observe(ctx, TEAM, ID_TEAM)
    expect(team?.fields).toMatchObject({
      repository: ID_REPO,
      team: 'builders',
      permission: 'write'
    })
  })

  it('a missing resource is null', async () => {
    const { ctx } = harness([])
    expect(await dockerhubAdapter.observe(ctx, REPO, ID_REPO)).toBeNull()
    expect(await dockerhubAdapter.observe(ctx, TAG, ID_TAG)).toBeNull()
  })

  it('answers null for another namespace and makes no call', async () => {
    const { ctx, calls } = harness([repoOk])
    expect(await dockerhubAdapter.observe(ctx, REPO, 'someone-else/nivaro-app')).toBeNull()
    expect(await dockerhubAdapter.observe(ctx, TAG, 'someone-else/nivaro-app/1.0')).toBeNull()
    expect(calls).toEqual([])
  })

  it('refuses ids that could climb out of their path segment', async () => {
    const { ctx } = harness([repoOk])
    await expect(dockerhubAdapter.observe(ctx, REPO, `${NS}/..`)).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    await expect(dockerhubAdapter.observe(ctx, TAG, `${NS}/nivaro-app/..`)).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    await expect(dockerhubAdapter.observe(ctx, REPO, `${NS}/a%2Fb`)).rejects.toMatchObject({
      code: 'BAD_ID'
    })
    await expect(dockerhubAdapter.observe(ctx, REPO, `${NS}/a\u0001b`)).rejects.toMatchObject({
      code: 'BAD_ID'
    })
  })

  it('marks a tag pinned when a Hub image pin uses it', async () => {
    vi.stubEnv('HUB_IMAGE', ID_REPO)
    setPinReader(async () => ['0.3.217'])
    const { ctx } = harness([tagOk])
    const tag = await dockerhubAdapter.observe(ctx, TAG, ID_TAG)
    expect(tag?.fields.pinned).toBe(true)
  })
})

describe('dockerhub adapter: list', () => {
  it('pages repositories, then tags and team access per repository', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/v2\/namespaces\/testorg\/repositories$/, body: fx('repos_page') },
      {
        method: 'GET',
        path: /^\/v2\/namespaces\/testorg\/repositories\/[a-z-]+\/tags$/,
        body: fx('tags_page')
      },
      { method: 'GET', path: /^\/v2\/repositories\/testorg\/[a-z-]+\/groups$/, body: fx('groups') }
    ])
    const repos = await dockerhubAdapter.list(ctx, REPO)
    expect(repos.items.map((i) => i.externalId)).toEqual([ID_REPO, `${NS}/public-docs`])
    expect(repos.cursor).toBeNull()
    const tags = await dockerhubAdapter.list(ctx, TAG)
    expect(tags.items.length).toBe(4)
    expect(tags.items[0].externalId).toBe(ID_TAG)
    const teams = await dockerhubAdapter.list(ctx, TEAM)
    expect(teams.items.length).toBe(2)
  })
})

describe('dockerhub adapter: plan diff per type', () => {
  const { ctx } = harness([])
  const observedRepo: Observed = {
    type: REPO,
    externalId: ID_REPO,
    name: 'nivaro-app',
    fields: { name: 'nivaro-app', private: true, description: 'Test image', fullDescription: 'x' },
    tags: {}
  }

  it('creates a private repository by default, in plain words', () => {
    const ops = dockerhubAdapter.plan(ctx, desired(REPO, { name: 'nivaro-app' }), null)
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ kind: 'create', type: REPO })
    expect(ops[0].changes).toContainEqual({ field: 'private', to: true })
    expect(ops[0].reason).toContain('Docker Hub repository nivaro-app')
    expect(ops[0].reason).not.toContain('dockerhub.')
  })

  it('updates only what differs, nothing when it matches', () => {
    expect(
      dockerhubAdapter.plan(
        ctx,
        desired(REPO, {
          name: 'nivaro-app',
          private: true,
          description: 'Test image',
          fullDescription: 'x'
        }),
        observedRepo
      )
    ).toEqual([])
    const ops = dockerhubAdapter.plan(
      ctx,
      desired(REPO, { name: 'nivaro-app', private: false, description: 'Test image' }),
      observedRepo
    )
    expect(ops[0]).toMatchObject({ kind: 'update' })
    expect(ops[0].changes).toEqual([{ field: 'private', from: true, to: false }])
    expect(ops[0].reason).toContain('Private')
  })

  it('deletes a repository, a team access and a tag', () => {
    expect(dockerhubAdapter.plan(ctx, null, observedRepo)[0].kind).toBe('delete')
    const team: Observed = {
      type: TEAM,
      externalId: ID_TEAM,
      name: 'builders on nivaro-app',
      fields: { repository: ID_REPO, team: 'builders', permission: 'write' },
      tags: {}
    }
    expect(dockerhubAdapter.plan(ctx, null, team)[0].kind).toBe('delete')
    const tag: Observed = {
      type: TAG,
      externalId: ID_TAG,
      name: '0.3.217',
      fields: { digest: 'sha256:x', pinned: true },
      tags: {}
    }
    const [d] = dockerhubAdapter.plan(ctx, null, tag)
    expect(d.kind).toBe('delete')
    expect(d.reason).toContain('pin')
  })

  it('changes a team permission, and a tag cannot be created here', () => {
    const team: Observed = {
      type: TEAM,
      externalId: ID_TEAM,
      name: 'builders on nivaro-app',
      fields: { repository: ID_REPO, team: 'builders', permission: 'write' },
      tags: {}
    }
    const ops = dockerhubAdapter.plan(
      ctx,
      desired(TEAM, { team: 'builders', permission: 'read' }, { repository: ID_REPO }),
      team
    )
    expect(ops[0].changes).toEqual([{ field: 'permission', from: 'write', to: 'read' }])
    expect(() =>
      dockerhubAdapter.plan(ctx, desired(TAG, { name: 'x' }, { repository: ID_REPO }), null)
    ).toThrow(/pushed with docker/)
  })
})

describe('dockerhub adapter: risk flags per type', () => {
  const spec = (k: string) => dockerhubAdapter.types.find((t) => t.key === k)!
  it('flags a public create, private → public, and deletes', () => {
    expect(
      spec(REPO).risk(
        op({ kind: 'create', changes: [] }),
        desired(REPO, { name: 'a', private: false })
      )
    ).toEqual(['public_exposure'])
    expect(
      spec(REPO).risk(op({ kind: 'create', changes: [] }), desired(REPO, { name: 'a' }))
    ).toEqual([])
    expect(
      spec(REPO).risk(
        op({ kind: 'update', changes: [{ field: 'private', from: true, to: false }] }),
        desired(REPO, { private: false })
      )
    ).toEqual(['public_exposure'])
    expect(
      spec(REPO).risk(
        op({ kind: 'update', changes: [{ field: 'description', to: 'x' }] }),
        desired(REPO, {})
      )
    ).toEqual([])
    expect(spec(REPO).risk(op({ kind: 'delete' }), null)).toEqual(['destructive', 'data_loss'])
    expect(spec(TAG).risk(op({ kind: 'delete', type: TAG }), null)).toEqual([
      'destructive',
      'data_loss'
    ])
    expect(spec(TEAM).risk(op({ kind: 'delete', type: TEAM }), null)).toEqual(['destructive'])
  })

  it('costs monthly only for a private repository', () => {
    expect(spec(REPO).costClass?.(desired(REPO, { name: 'a' }))).toBe('monthly')
    expect(spec(REPO).costClass?.(desired(REPO, { name: 'a', private: false }))).toBe('none')
    expect(spec(TAG).costClass).toBeUndefined()
  })
})

describe('dockerhub adapter: apply is idempotent (read-before-write)', () => {
  it('create refuses a repository it did not make', async () => {
    const { ctx, writes } = harness([repoOk])
    await expect(
      dockerhubAdapter.apply(
        ctx,
        op({ kind: 'create', externalId: null }),
        desired(REPO, { name: 'nivaro-app' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(writes()).toEqual([])
  })

  it('create resumes onto the id this resource already recorded', async () => {
    const { ctx, writes } = harness([repoOk])
    const r = await dockerhubAdapter.apply(
      ctx,
      op({ kind: 'create', externalId: null }),
      desired(REPO, { name: 'nivaro-app' }, {}, ID_REPO)
    )
    expect(r.externalId).toBe(ID_REPO)
    expect(writes()).toEqual([])
  })

  it('create makes a private repository by default and reads it back', async () => {
    const h = harness([
      {
        method: 'POST',
        path: /^\/v2\/namespaces\/testorg\/repositories$/,
        body: { name: 'new-one' }
      }
    ])
    const r = await dockerhubAdapter.apply(
      h.ctx,
      op({ kind: 'create', externalId: null }),
      desired(REPO, { name: 'new-one', description: 'Hi' })
    )
    expect(r.externalId).toBe(`${NS}/new-one`)
    const post = h.writes()[0]
    expect(post.method).toBe('POST')
    expect(post.body).toMatchObject({
      name: 'new-one',
      namespace: NS,
      is_private: true,
      description: 'Hi'
    })
  })

  it('update with nothing to change sends nothing', async () => {
    const { ctx, writes } = harness([repoOk])
    const r = await dockerhubAdapter.apply(
      ctx,
      op({}),
      desired(
        REPO,
        {
          name: 'nivaro-app',
          private: true,
          description: 'Test image',
          fullDescription: 'Long test description'
        },
        {},
        ID_REPO
      )
    )
    expect(r.answer).toMatchObject({ already: 'matches' })
    expect(writes()).toEqual([])
  })

  it('update patches only the changed fields', async () => {
    const { ctx, writes } = harness([
      repoOk,
      { method: 'PATCH', path: /^\/v2\/namespaces\/testorg\/repositories\/nivaro-app$/, body: {} }
    ])
    await dockerhubAdapter.apply(
      ctx,
      op({}),
      desired(
        REPO,
        {
          name: 'nivaro-app',
          private: false,
          description: 'Test image',
          fullDescription: 'Long test description'
        },
        {},
        ID_REPO
      )
    )
    expect(writes()).toHaveLength(1)
    expect(writes()[0].body).toEqual({ is_private: false })
  })

  it('delete of a repository already gone is a success with no call', async () => {
    const { ctx, writes } = harness([])
    const r = await dockerhubAdapter.apply(ctx, op({ kind: 'delete' }), null)
    expect(r.ok).toBe(true)
    expect(r.answer).toMatchObject({ already: 'gone' })
    expect(writes()).toEqual([])
  })

  it('delete removes the repository', async () => {
    const { ctx, writes } = harness([
      repoOk,
      {
        method: 'DELETE',
        path: /^\/v2\/namespaces\/testorg\/repositories\/nivaro-app$/,
        status: 202
      }
    ])
    await dockerhubAdapter.apply(ctx, op({ kind: 'delete' }), null)
    expect(writes().map((c) => c.method)).toEqual(['DELETE'])
  })

  it('refuses to delete the repository that holds a pinned Hub image', async () => {
    vi.stubEnv('HUB_IMAGE', ID_REPO)
    setPinReader(async () => ['0.3.217'])
    const { ctx, writes } = harness([repoOk])
    await expect(dockerhubAdapter.apply(ctx, op({ kind: 'delete' }), null)).rejects.toMatchObject({
      code: 'REPO_PINNED'
    })
    expect(writes()).toEqual([])
  })
})

describe('dockerhub adapter: tags', () => {
  const del = (): PlannedOp => op({ kind: 'delete', type: TAG, externalId: ID_TAG })
  const delRoute = {
    method: 'DELETE',
    path: /^\/v2\/namespaces\/testorg\/repositories\/nivaro-app\/tags\/0\.3\.217$/,
    status: 204
  }

  it('deletes an unpinned tag', async () => {
    vi.stubEnv('HUB_IMAGE', ID_REPO)
    setPinReader(async () => ['0.3.100'])
    const { ctx, writes } = harness([tagOk, delRoute])
    await dockerhubAdapter.apply(ctx, del(), null)
    expect(writes().map((c) => c.method)).toEqual(['DELETE'])
  })

  it('refuses a tag a Hub image pin uses (TAG_PINNED), slim tags included', async () => {
    vi.stubEnv('HUB_IMAGE', ID_REPO)
    setPinReader(async () => ['0.3.217'])
    const { ctx, writes } = harness([tagOk, delRoute])
    await expect(dockerhubAdapter.apply(ctx, del(), null)).rejects.toMatchObject({
      code: 'TAG_PINNED',
      retryable: false
    })
    expect(writes()).toEqual([])
    const slim = harness([
      {
        method: 'GET',
        path: /\/tags\/0\.3\.217-slim$/,
        body: { ...fx('tag'), name: '0.3.217-slim' }
      },
      { method: 'DELETE', path: /\/tags\/0\.3\.217-slim$/, status: 204 }
    ])
    await expect(
      dockerhubAdapter.apply(
        slim.ctx,
        op({ kind: 'delete', type: TAG, externalId: `${ID_TAG}-slim` }),
        null
      )
    ).rejects.toMatchObject({ code: 'TAG_PINNED' })
  })

  it('fails closed when the pins cannot be read', async () => {
    vi.stubEnv('HUB_IMAGE', ID_REPO)
    setPinReader(async () => {
      throw new Error('db down')
    })
    const { ctx, writes } = harness([tagOk, delRoute])
    await expect(dockerhubAdapter.apply(ctx, del(), null)).rejects.toMatchObject({
      code: 'PINS_UNREADABLE',
      retryable: true
    })
    expect(writes()).toEqual([])
  })

  it('does not ask the pins about a repository that is not the Hub image', async () => {
    vi.stubEnv('HUB_IMAGE', 'nodeworks/nivaro')
    const reader = vi.fn(async () => ['0.3.217'])
    setPinReader(reader)
    const { ctx } = harness([tagOk, delRoute])
    await dockerhubAdapter.apply(ctx, del(), null)
    expect(reader).not.toHaveBeenCalled()
  })

  it('a tag already gone is a success; a foreign namespace is refused', async () => {
    const { ctx } = harness([])
    expect((await dockerhubAdapter.apply(ctx, del(), null)).answer).toMatchObject({
      already: 'gone'
    })
    await expect(
      dockerhubAdapter.apply(
        ctx,
        op({ kind: 'delete', type: TAG, externalId: 'other/nivaro-app/1.0' }),
        null
      )
    ).rejects.toMatchObject({ code: 'DOCKERHUB_OUT_OF_ACCOUNT' })
  })

  it('refuses a change that names a different repository than its target', async () => {
    const { ctx } = harness([tagOk, delRoute])
    await expect(
      dockerhubAdapter.apply(
        ctx,
        del(),
        desired(TAG, { name: '0.3.217' }, { repository: `${NS}/other` })
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })
})

describe('dockerhub adapter: team permissions', () => {
  const groupsRoute = {
    method: 'GET',
    path: /^\/v2\/repositories\/testorg\/nivaro-app\/groups$/,
    body: fx('groups')
  }

  it('create looks the team up by name, then grants it', async () => {
    const { ctx, writes } = harness([
      { method: 'GET', path: /^\/v2\/orgs\/testorg\/groups\/readers$/, body: fx('group') },
      {
        method: 'POST',
        path: /^\/v2\/repositories\/testorg\/nivaro-app\/groups$/,
        status: 201,
        body: {}
      }
    ])
    const r = await dockerhubAdapter.apply(
      ctx,
      op({ kind: 'create', type: TEAM, externalId: null }),
      desired(TEAM, { team: 'readers', permission: 'read' }, { repository: ID_REPO })
    )
    expect(r.externalId).toBe(`${NS}/nivaro-app/readers`)
    expect(writes()[0].body).toEqual({ group_id: 502, permission: 'read' })
  })

  it('create refuses an access the Hub did not make, and an unknown team', async () => {
    const a = harness([groupsRoute])
    await expect(
      dockerhubAdapter.apply(
        a.ctx,
        op({ kind: 'create', type: TEAM, externalId: null }),
        desired(TEAM, { team: 'builders', permission: 'read' }, { repository: ID_REPO })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(a.writes()).toEqual([])
    const b = harness([groupsRoute])
    await expect(
      dockerhubAdapter.apply(
        b.ctx,
        op({ kind: 'create', type: TEAM, externalId: null }),
        desired(TEAM, { team: 'ghosts', permission: 'read' }, { repository: ID_REPO })
      )
    ).rejects.toMatchObject({ code: 'TEAM_NOT_FOUND' })
  })

  it('update puts the new permission; same permission sends nothing', async () => {
    const { ctx, writes } = harness([
      groupsRoute,
      { method: 'PUT', path: /^\/v2\/repositories\/testorg\/nivaro-app\/groups\/501$/, body: {} }
    ])
    const same = await dockerhubAdapter.apply(
      ctx,
      op({ type: TEAM, externalId: ID_TEAM }),
      desired(TEAM, { team: 'builders', permission: 'write' }, { repository: ID_REPO })
    )
    expect(same.answer).toMatchObject({ already: 'matches' })
    expect(writes()).toEqual([])
    await dockerhubAdapter.apply(
      ctx,
      op({ type: TEAM, externalId: ID_TEAM }),
      desired(TEAM, { team: 'builders', permission: 'admin' }, { repository: ID_REPO })
    )
    expect(writes()[0].body).toEqual({ permission: 'admin' })
  })

  it('delete uses the team id from the listing; a different team is refused', async () => {
    const { ctx, writes } = harness([
      groupsRoute,
      {
        method: 'DELETE',
        path: /^\/v2\/repositories\/testorg\/nivaro-app\/groups\/501$/,
        status: 204
      }
    ])
    await dockerhubAdapter.apply(ctx, op({ kind: 'delete', type: TEAM, externalId: ID_TEAM }), null)
    expect(writes().map((c) => c.method)).toEqual(['DELETE'])
    await expect(
      dockerhubAdapter.apply(
        ctx,
        op({ type: TEAM, externalId: ID_TEAM }),
        desired(TEAM, { team: 'someone', permission: 'read' }, { repository: ID_REPO })
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })

  it('refuses a repository outside the connection namespace', async () => {
    const { ctx } = harness([])
    await expect(
      dockerhubAdapter.apply(
        ctx,
        op({ kind: 'create', type: TEAM, externalId: null }),
        desired(TEAM, { team: 'readers', permission: 'read' }, { repository: 'other/nivaro-app' })
      )
    ).rejects.toMatchObject({ code: 'DOCKERHUB_OUT_OF_ACCOUNT' })
  })
})

describe('dockerhub adapter: maps 429 to retryable', () => {
  it('a 429 from the API is retryable and says when to retry', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /^\/v2\/namespaces\/testorg\/repositories\/nivaro-app$/,
        status: 429,
        body: fx('rate-limited'),
        headers: { 'retry-after': '12' }
      }
    ])
    await expect(dockerhubAdapter.observe(ctx, REPO, ID_REPO)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      status: 429,
      message: expect.stringContaining('12')
    })
  })

  it('a 5xx is retryable, a 400 is not', async () => {
    const a = harness([{ method: 'GET', path: /repositories\/nivaro-app$/, status: 503, body: {} }])
    await expect(dockerhubAdapter.observe(a.ctx, REPO, ID_REPO)).rejects.toMatchObject({
      retryable: true
    })
    const b = harness([{ method: 'GET', path: /repositories\/nivaro-app$/, status: 400, body: {} }])
    await expect(dockerhubAdapter.observe(b.ctx, REPO, ID_REPO)).rejects.toMatchObject({
      retryable: false
    })
  })
})

describe('dockerhub adapter: secrets never appear in errors', () => {
  it('scrubs the access token and the login token from provider text', async () => {
    const { ctx } = harness([
      {
        method: 'GET',
        path: /repositories\/nivaro-app$/,
        status: 500,
        body: { message: `boom ${TOKEN} and ${JWT}` }
      }
    ])
    const err: any = await dockerhubAdapter.observe(ctx, REPO, ID_REPO).catch((e) => e)
    expect(err.message).not.toContain(TOKEN)
    expect(err.message).not.toContain(JWT)
  })

  it('a refused login says so without the token', async () => {
    const calls: string[] = []
    const ctx = makeProviderContext({
      adapter: dockerhubAdapter,
      connectionId: ++nextConnection,
      config: { namespace: NS, username: NS },
      secrets: { token: TOKEN },
      fetch: {
        fetchImpl: (async (url: string) => {
          calls.push(url)
          return new Response(JSON.stringify({ message: `bad ${TOKEN}` }), { status: 401 })
        }) as any,
        timeoutMs: 500
      }
    })
    const err: any = await dockerhubAdapter.observe(ctx, REPO, ID_REPO).catch((e) => e)
    expect(err.code).toBe('AUTH_FAILED')
    expect(err.message).not.toContain(TOKEN)
  })
})

describe('dockerhub adapter: login token', () => {
  it('is minted once and reused', async () => {
    const { ctx, calls } = harness([repoOk])
    await dockerhubAdapter.observe(ctx, REPO, ID_REPO)
    await dockerhubAdapter.observe(ctx, REPO, ID_REPO)
    expect(calls.filter((c) => c.path === '/v2/auth/token')).toHaveLength(1)
    expect(calls.find((c) => c.path.includes('/repositories/'))?.headers.authorization).toBe(
      `Bearer ${JWT}`
    )
  })

  it('a 401 on a cached login mints a fresh one and retries once', async () => {
    let n = 0
    const calls: string[] = []
    const ctx = makeProviderContext({
      adapter: dockerhubAdapter,
      connectionId: ++nextConnection,
      config: { namespace: NS, username: NS },
      secrets: { token: TOKEN },
      fetch: {
        fetchImpl: (async (url: string, init: any) => {
          const u = new URL(url)
          calls.push(`${init?.method ?? 'GET'} ${u.pathname}`)
          if (u.pathname === '/v2/auth/token')
            return new Response(JSON.stringify(fx('auth_token')), { status: 200 })
          n++
          return n === 1
            ? new Response('{}', { status: 401 })
            : new Response(JSON.stringify(fx('repo')), { status: 200 })
        }) as any,
        timeoutMs: 500
      }
    })
    const seen = await dockerhubAdapter.observe(ctx, REPO, ID_REPO)
    expect(seen?.externalId).toBe(ID_REPO)
    expect(calls.filter((c) => c === 'POST /v2/auth/token')).toHaveLength(2)
  })
})

describe('dockerhub adapter: health', () => {
  it('a repository reports tag count and last push; no image warns', async () => {
    const a = harness([
      repoOk,
      {
        method: 'GET',
        path: /^\/v2\/namespaces\/testorg\/repositories\/nivaro-app\/tags$/,
        body: fx('tags_page')
      }
    ])
    const ok = await dockerhubAdapter.health!(a.ctx, REPO, ID_REPO)
    expect(ok.status).toBe('ok')
    expect(ok.details).toMatchObject({
      tagCount: 2,
      lastPush: '2026-11-20T10:00:00.000000Z',
      pullCount: 42
    })
    const b = harness([
      repoOk,
      {
        method: 'GET',
        path: /^\/v2\/namespaces\/testorg\/repositories\/nivaro-app\/tags$/,
        body: { count: 0, results: [] }
      }
    ])
    expect((await dockerhubAdapter.health!(b.ctx, REPO, ID_REPO)).status).toBe('warn')
    const gone = harness([])
    expect((await dockerhubAdapter.health!(gone.ctx, REPO, ID_REPO)).status).toBe('down')
  })
})

describe('dockerhub adapter: estimate from recorded price answer', () => {
  const spec = dockerhubAdapter.types.find((t) => t.key === REPO)!
  ensureCoreProviders()

  it('a public repository is free', async () => {
    const { ctx } = harness([])
    const e = await spec.estimate!(ctx, desired(REPO, { name: 'a', private: false }), null)
    expect(e).toMatchObject({ basis: 'free', confidence: 'exact', monthlyCents: 0 })
  })

  it('the only private repository is covered by the free plan', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/v2\/namespaces\/testorg\/repositories$/, body: { results: [] } }
    ])
    const e = await spec.estimate!(ctx, desired(REPO, { name: 'a' }), null)
    expect(e).toMatchObject({ basis: 'plan_price', confidence: 'list_price', monthlyCents: 0 })
    expect(e.note).toContain('free plan')
    expect(e.priceAsOf).toBe('2026-11-26')
  })

  it('a second private repository names the paid plans from the dated table', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/v2\/namespaces\/testorg\/repositories$/, body: fx('repos_page') }
    ])
    const e = await spec.estimate!(ctx, desired(REPO, { name: 'second' }), null)
    expect(e.confidence).toBe('list_price')
    expect(e.note).toContain('$11')
    expect(e.note).toContain('$16')
    expect(e.priceAsOf).toBe('2026-11-26')
  })

  it('an unreadable namespace is "no estimate", never a throw', async () => {
    const { ctx } = harness([
      { method: 'GET', path: /^\/v2\/namespaces\/testorg\/repositories$/, status: 500, body: {} }
    ])
    const e = await spec.estimate!(ctx, desired(REPO, { name: 'a' }), null)
    expect(e.confidence).toBe('unknown')
  })
})

describe('dockerhub adapter: findExisting', () => {
  it('finds a repository and a team access of that name, and nothing for a tag', async () => {
    const { ctx } = harness([
      repoOk,
      {
        method: 'GET',
        path: /^\/v2\/repositories\/testorg\/nivaro-app\/groups$/,
        body: fx('groups')
      }
    ])
    expect(
      (await dockerhubAdapter.findExisting!(ctx, REPO, desired(REPO, { name: 'nivaro-app' })))
        ?.externalId
    ).toBe(ID_REPO)
    expect(
      (
        await dockerhubAdapter.findExisting!(
          ctx,
          TEAM,
          desired(TEAM, { team: 'builders' }, { repository: ID_REPO })
        )
      )?.externalId
    ).toBe(ID_TEAM)
    expect(
      await dockerhubAdapter.findExisting!(
        ctx,
        TAG,
        desired(TAG, { name: 'x' }, { repository: ID_REPO })
      )
    ).toBeNull()
  })
})
