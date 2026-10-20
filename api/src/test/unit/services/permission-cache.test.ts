import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import {
  attachPermissionCacheSeam,
  bumpAccessVersion,
  bumpUserAccessVersion,
  clearPermissionCache,
  isAccessWrite,
  notePrincipalKind,
  PERMISSION_CACHE_TTL_MS,
  permissionCacheStats,
  resetPermissionCacheForTests,
  setPermissionCacheEnabled,
  setPermissionCacheRedis
} from '../../../services/permission-cache.js'
import { can, getAllowedFields, getRowFilter, isAdminRole } from '../../../services/permissions.js'
import {
  bustScopeDimensionCache,
  bustUserScopeCache,
  getUserScopeEnforcement
} from '../../../services/user-scopes.js'
import type { User } from '../../../types.js'
import { makeRegularUser } from '../../helpers.js'

// ── a tiny in-memory database behind the mocked knex ─────────────────────────

interface FakePolicy {
  id: number
  role: string
  action: string
  collection: string
  fields?: string | null
  row_filter?: string | null
}
const state = {
  roles: new Map<string, { id: string; admin_access: boolean }>(),
  policies: [] as FakePolicy[],
  userScopes: [] as Array<Record<string, unknown>>,
  dimensions: [] as Array<Record<string, unknown>>,
  reads: 0
}

function chainFor(table: string) {
  const where: Record<string, unknown> = {}
  const collections: string[] = []
  const chain: Record<string, unknown> = {}
  const take = (arg: unknown) => {
    if (typeof arg === 'function') {
      const sub = {
        where: (o: Record<string, unknown>) => {
          if (typeof o.collection === 'string') collections.push(o.collection)
          return sub
        },
        orWhere: (o: Record<string, unknown>) => {
          if (typeof o.collection === 'string') collections.push(o.collection)
          return sub
        }
      }
      arg(sub)
    } else if (arg && typeof arg === 'object') Object.assign(where, arg)
    return chain
  }
  const rows = (): unknown[] => {
    state.reads++
    if (table === 'nivaro_roles') {
      const r = state.roles.get(String(where.id))
      return r ? [{ ...r }] : []
    }
    if (table === 'nivaro_policies') {
      const matching = state.policies.filter(
        (p) =>
          p.role === where.role &&
          (where.action === undefined || p.action === where.action) &&
          (collections.length === 0 || collections.includes(p.collection))
      )
      return matching
        .sort((a, b) => (a.collection === '*' ? 1 : 0) - (b.collection === '*' ? 1 : 0))
        .map((p) => ({ ...p }))
    }
    if (table === 'nivaro_user_scopes')
      return state.userScopes.filter((s) => s.user === where.user).map((s) => ({ ...s }))
    if (table === 'nivaro_scope_dimensions') return state.dimensions.map((d) => ({ ...d }))
    return []
  }
  Object.assign(chain, {
    where: vi.fn(take),
    orWhere: vi.fn(take),
    orderByRaw: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    select: vi.fn(() => chain),
    first: vi.fn(async () => rows()[0]),
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej)
  })
  return chain
}

// ── a Redis that two "processes" share ───────────────────────────────────────

function makeRedis() {
  const kv = new Map<string, string>()
  const r = {
    status: 'ready' as string,
    hang: false,
    kv,
    mget: vi.fn(async (...keys: string[]) => {
      if (r.hang) return new Promise<Array<string | null>>(() => {})
      return keys.map((k) => kv.get(k) ?? null)
    }),
    incr: vi.fn(async (key: string) => {
      const n = Number(kv.get(key) ?? 0) + 1
      kv.set(key, String(n))
      return n
    }),
    expire: vi.fn(async () => 1)
  }
  return r
}
let redis = makeRedis()

/** Another replica moving the cluster-wide version (its own write went through its seam). */
async function remoteBump(userId?: string) {
  await redis.incr(userId ? `nvr:permver:u:${userId.toLowerCase()}` : 'nvr:permver:g')
}

/** Each request gets a fresh user object from authenticate. */
function freshUser(overrides: Partial<User> = {}): User {
  return makeRegularUser(overrides)
}

beforeEach(() => {
  state.roles = new Map([
    ['regular-role-id', { id: 'regular-role-id', admin_access: false }],
    ['other-role-id', { id: 'other-role-id', admin_access: false }],
    ['admin-role-id', { id: 'admin-role-id', admin_access: true }]
  ])
  state.policies = [
    {
      id: 1,
      role: 'regular-role-id',
      action: 'read',
      collection: 'articles',
      fields: '["id","title"]'
    },
    {
      id: 2,
      role: 'regular-role-id',
      action: 'update',
      collection: 'articles',
      row_filter: JSON.stringify([{ field: 'owner', op: 'eq', value: '$CURRENT_USER' }])
    }
  ]
  state.userScopes = []
  state.dimensions = []
  state.reads = 0
  vi.mocked(db as unknown as (t: string) => unknown).mockImplementation(
    (t: string) => chainFor(t) as never
  )
  redis = makeRedis()
  bustUserScopeCache()
  bustScopeDimensionCache()
  resetPermissionCacheForTests()
  setPermissionCacheRedis(redis)
  setPermissionCacheEnabled(true)
})

afterEach(() => {
  vi.useRealTimers()
  setPermissionCacheEnabled(false)
  setPermissionCacheRedis(null)
  resetPermissionCacheForTests()
})

describe('off', () => {
  it('reads the database on every call, as before', async () => {
    setPermissionCacheEnabled(false)
    for (let i = 0; i < 3; i++) expect(await can(freshUser(), 'read', 'articles')).toBe(true)
    expect(state.reads).toBe(6) // role + policy, three times
    expect(redis.mget).not.toHaveBeenCalled()
  })
})

describe('on: hits', () => {
  it('answers a repeat question from the cache, with the same answer', async () => {
    const first = await can(freshUser(), 'read', 'articles')
    const reads = state.reads
    const second = await can(freshUser(), 'read', 'articles')
    expect(second).toBe(first)
    expect(state.reads).toBe(reads)
    expect(permissionCacheStats().hits).toBe(1)
  })

  it('caches a denial exactly like an allow (same version and TTL)', async () => {
    expect(await can(freshUser(), 'delete', 'articles')).toBe(false)
    const reads = state.reads
    expect(await can(freshUser(), 'delete', 'articles')).toBe(false)
    expect(state.reads).toBe(reads)
    state.policies.push({
      id: 3,
      role: 'regular-role-id',
      action: 'delete',
      collection: 'articles'
    })
    bumpAccessVersion()
    expect(await can(freshUser(), 'delete', 'articles')).toBe(true)
  })

  it('hands every caller its own copy', async () => {
    const a = await getAllowedFields(freshUser(), 'read', 'articles')
    a?.push('secret')
    expect(await getAllowedFields(freshUser(), 'read', 'articles')).toEqual(['id', 'title'])
    const f = await getRowFilter(freshUser(), 'update', 'articles')
    if (f) f[0].value = 'someone-else'
    expect(await getRowFilter(freshUser(), 'update', 'articles')).toEqual([
      { field: 'owner', op: 'eq', value: '$CURRENT_USER' }
    ])
  })

  it('keeps the API key scope check outside the cache', async () => {
    expect(await can(freshUser(), 'read', 'articles')).toBe(true)
    const keyUser = freshUser({ api_key_scopes: [{ collection: 'other', actions: ['read'] }] })
    expect(await can(keyUser, 'read', 'articles')).toBe(false)
    expect(keyUser.api_key_scope_denied).toEqual({ action: 'read', collection: 'articles' })
  })
})

describe('on: separate principals never share an entry', () => {
  it('a different role is a different key', async () => {
    expect(await can(freshUser(), 'read', 'articles')).toBe(true)
    expect(await can(freshUser({ role: 'other-role-id' }), 'read', 'articles')).toBe(false)
    expect(await isAdminRole(freshUser({ role: 'admin-role-id' }))).toBe(true)
    expect(await isAdminRole(freshUser())).toBe(false)
  })

  it('key scopes, row restrictions, sandbox and sign-in kind are part of the key', async () => {
    await getUserScopeEnforcement(freshUser(), 'articles')
    const misses = () => Number(permissionCacheStats().misses)
    const before = misses()
    await getUserScopeEnforcement(
      freshUser({ api_key_scope_restrictions: [{ dimension: 'd', values: [1] }] }),
      'articles'
    )
    await getUserScopeEnforcement(freshUser({ api_key_sandbox: true }), 'articles')
    await getUserScopeEnforcement(
      freshUser({ api_key_scopes: [{ collection: '*', actions: ['read'] }] }),
      'articles'
    )
    const viewAs = freshUser()
    notePrincipalKind(viewAs, 'masquerade:::admin-1')
    await getUserScopeEnforcement(viewAs, 'articles')
    expect(misses() - before).toBe(4)
  })

  it('tenants never share entries or version keys', async () => {
    await can(freshUser(), 'read', 'articles')
    const reads = state.reads
    await new Promise<void>((resolve) =>
      runWithTenantDb(
        {} as never,
        'acme',
        () => void can(freshUser(), 'read', 'articles').then(() => resolve()),
        'tenant-a'
      )
    )
    expect(state.reads).toBeGreaterThan(reads)
    expect(redis.mget.mock.calls.some((c) => c[0] === 'nvr:permver:t:tenant-a:g')).toBe(true)
  })
})

describe('on: every access-changing write path makes the next call rebuild', () => {
  function seamClient() {
    const client = new EventEmitter()
    attachPermissionCacheSeam(client)
    return client
  }

  it('control: without a bust the cached answer stands (the cache is real)', async () => {
    expect(await can(freshUser(), 'delete', 'articles')).toBe(false)
    state.policies.push({
      id: 9,
      role: 'regular-role-id',
      action: 'delete',
      collection: 'articles'
    })
    expect(await can(freshUser(), 'delete', 'articles')).toBe(false)
  })

  const writes: Array<[string, string, () => void]> = [
    [
      'policy insert',
      'insert into [nivaro_policies] ([role], [action], [collection]) values (@p0, @p1, @p2)',
      () =>
        state.policies.push({
          id: 9,
          role: 'regular-role-id',
          action: 'delete',
          collection: 'articles'
        })
    ],
    [
      'policy update',
      'update [nivaro_policies] set [action] = @p0 where [id] = @p1',
      () => {
        state.policies[0].action = 'delete'
        state.policies.push({
          id: 9,
          role: 'regular-role-id',
          action: 'delete',
          collection: 'articles'
        })
      }
    ],
    [
      'role update (admin flag)',
      'update [nivaro_roles] set [admin_access] = @p0 where [id] = @p1',
      () => state.roles.set('regular-role-id', { id: 'regular-role-id', admin_access: true })
    ],
    [
      'schema snapshot import / blueprint upsert',
      'insert into [dbo].[nivaro_policies] ([id], [role]) values (@p0, @p1)',
      () =>
        state.policies.push({
          id: 9,
          role: 'regular-role-id',
          action: 'delete',
          collection: 'articles'
        })
    ]
  ]
  for (const [name, sql, mutate] of writes) {
    it(`${name} through the driver seam`, async () => {
      const client = seamClient()
      expect(await can(freshUser(), 'delete', 'articles')).toBe(false)
      mutate()
      client.emit('query', { sql })
      expect(await can(freshUser(), 'delete', 'articles')).toBe(true)
      expect(redis.kv.get('nvr:permver:g')).toBe('1')
      client.emit('query-response', [], { sql })
      expect(redis.kv.get('nvr:permver:g')).toBe('2')
    })
  }

  it('policy delete through the seam', async () => {
    const client = seamClient()
    expect(await can(freshUser(), 'read', 'articles')).toBe(true)
    state.policies = state.policies.filter((p) => p.id !== 1)
    client.emit('query', { sql: 'delete from [nivaro_policies] where [id] = @p0' })
    expect(await can(freshUser(), 'read', 'articles')).toBe(false)
  })

  it('a write in a transaction moves the version again after it (commit has no event)', async () => {
    vi.useFakeTimers()
    const client = seamClient()
    client.emit('query', { sql: 'update [nivaro_roles] set [name] = @p0', __knexTxId: 'trx1' })
    const after = Number(redis.kv.get('nvr:permver:g'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(Number(redis.kv.get('nvr:permver:g'))).toBe(after + 1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(Number(redis.kv.get('nvr:permver:g'))).toBe(after + 3)
  })

  it('another replica moved the cluster-wide version', async () => {
    expect(await can(freshUser(), 'delete', 'articles')).toBe(false)
    state.policies.push({
      id: 9,
      role: 'regular-role-id',
      action: 'delete',
      collection: 'articles'
    })
    await remoteBump()
    expect(await can(freshUser(), 'delete', 'articles')).toBe(true)
  })

  it("another replica moved one person's version (scope assignment) — scope rows re-read", async () => {
    state.dimensions = [
      {
        id: 1,
        name: 'region',
        label: 'Region',
        target_collection: 'articles',
        strict: false,
        is_active: true
      }
    ]
    expect((await getUserScopeEnforcement(freshUser(), 'articles')).filters).toEqual([])
    state.userScopes.push({
      id: 1,
      user: 'test-user-id',
      dimension: 'region',
      mode: 'restrict',
      values: '[7]'
    })
    // Without the bump the (60 s) scope-row cache and this cache both still say "none".
    expect((await getUserScopeEnforcement(freshUser(), 'articles')).filters).toEqual([])
    await remoteBump('test-user-id')
    expect((await getUserScopeEnforcement(freshUser(), 'articles')).filters).toEqual([
      { hops: [], ids: [7] }
    ])
  })

  it('scope assignment / dimension edits through the seam', async () => {
    const client = seamClient()
    state.dimensions = [
      {
        id: 1,
        name: 'region',
        label: 'Region',
        target_collection: 'articles',
        strict: false,
        is_active: true
      }
    ]
    expect((await getUserScopeEnforcement(freshUser(), 'articles')).filters).toEqual([])
    state.userScopes.push({
      id: 1,
      user: 'test-user-id',
      dimension: 'region',
      mode: 'restrict',
      values: '[7]'
    })
    client.emit('query', { sql: 'insert into [nivaro_user_scopes] ([user]) values (@p0)' })
    expect((await getUserScopeEnforcement(freshUser(), 'articles')).filters).toHaveLength(1)
    state.dimensions[0].is_active = false
    client.emit('query', { sql: 'update [nivaro_scope_dimensions] set [is_active] = @p0' })
    expect((await getUserScopeEnforcement(freshUser(), 'articles')).filters).toEqual([])
  })

  it('API key / View-as / scope routes move the person version', async () => {
    expect(await can(freshUser(), 'delete', 'articles')).toBe(false)
    state.policies.push({
      id: 9,
      role: 'regular-role-id',
      action: 'delete',
      collection: 'articles'
    })
    bumpUserAccessVersion('TEST-USER-ID')
    await Promise.resolve()
    expect(redis.kv.get('nvr:permver:u:test-user-id')).toBe('1')
    expect(await can(freshUser(), 'delete', 'articles')).toBe(true)
  })

  it('a role change on the person needs no bump: the role is part of the key', async () => {
    expect(await can(freshUser(), 'read', 'articles')).toBe(true)
    expect(await can(freshUser({ role: 'other-role-id' }), 'read', 'articles')).toBe(false)
    expect(await can(freshUser({ role: null as unknown as string }), 'read', 'articles')).toBe(
      false
    )
  })

  it('the cache console / configuration epoch clear it', async () => {
    expect(await can(freshUser(), 'delete', 'articles')).toBe(false)
    state.policies.push({
      id: 9,
      role: 'regular-role-id',
      action: 'delete',
      collection: 'articles'
    })
    clearPermissionCache()
    expect(await can(freshUser(), 'delete', 'articles')).toBe(true)
  })

  it('a Redis that lost its keys (version went back) is a move too', async () => {
    await remoteBump()
    await remoteBump()
    expect(await can(freshUser(), 'delete', 'articles')).toBe(false)
    state.policies.push({
      id: 9,
      role: 'regular-role-id',
      action: 'delete',
      collection: 'articles'
    })
    redis.kv.clear()
    await remoteBump()
    expect(await can(freshUser(), 'delete', 'articles')).toBe(true)
  })

  it('the hard TTL ends an entry no bump reached (raw SQL outside the app)', async () => {
    vi.useFakeTimers()
    expect(await can(freshUser(), 'delete', 'articles')).toBe(false)
    state.policies.push({
      id: 9,
      role: 'regular-role-id',
      action: 'delete',
      collection: 'articles'
    })
    vi.advanceTimersByTime(PERMISSION_CACHE_TTL_MS - 10)
    expect(await can(freshUser(), 'delete', 'articles')).toBe(false)
    vi.advanceTimersByTime(20)
    expect(await can(freshUser(), 'delete', 'articles')).toBe(true)
  })

  it('a fill that raced a bump is not stored', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((t: string) => {
      const c = chainFor(t) as Record<string, unknown>
      const first = c.first as () => Promise<unknown>
      c.first = async () => {
        await gate
        return first()
      }
      return c as never
    })
    const pending = can(freshUser(), 'read', 'articles')
    await new Promise((r) => setTimeout(r, 0))
    bumpAccessVersion()
    release()
    await pending
    expect(permissionCacheStats().dropped).toBe(1)
    expect(permissionCacheStats().entries).toBe(0)
  })
})

describe('on: fails safe', () => {
  it('skips the cache when Redis is not ready', async () => {
    redis.status = 'reconnecting'
    await can(freshUser(), 'read', 'articles')
    await can(freshUser(), 'read', 'articles')
    expect(state.reads).toBe(4)
    expect(permissionCacheStats().bypassed).toBe(2)
  })

  it('skips the cache when the version read hangs', async () => {
    redis.hang = true
    expect(await can(freshUser(), 'read', 'articles')).toBe(true)
    expect(await can(freshUser(), 'read', 'articles')).toBe(true)
    expect(state.reads).toBe(4)
    expect(permissionCacheStats().version_errors).toBe(2)
  })

  it('skips the cache without a Redis client', async () => {
    setPermissionCacheRedis(null)
    await can(freshUser(), 'read', 'articles')
    await can(freshUser(), 'read', 'articles')
    expect(state.reads).toBe(4)
  })
})

describe('isAccessWrite', () => {
  it.each([
    ['update [nivaro_policies] set [fields] = @p0 where [id] = @p1', true],
    ['insert into [nivaro_roles] ([id]) values (@p0)', true],
    ['delete from [nivaro_user_scopes] where [user] = @p0', true],
    ['delete top (1) from nivaro_scope_dimensions where id = @p0', true],
    ['merge into nivaro_relations as t using x on 1=1', true],
    ['update p set p.collection = @p0 from nivaro_policies p', true],
    ['alter table [nivaro_policies] add [row_filter] nvarchar(max)', true],
    ['truncate table nivaro_tree_permissions', true],
    ['EXEC sp_rename @p0, @p1 -- nivaro_collections', true],
    ['select * from [nivaro_policies] where [role] = @p0', false],
    ["select [id] from [nivaro_roles] where [action] in ('delete', 'update')", false],
    ['update [nivaro_users] set [last_access] = @p0 where [id] = @p1', false],
    ['update [nivaro_api_keys] set [last_used_at] = @p0', false],
    ['update [nivaro_policies_archive] set [x] = @p0', false],
    ['create table #scratch (id int)', false],
    ['update [articles] set [title] = @p0', false]
  ])('%s → %s', (sql, want) => {
    expect(isAccessWrite(sql)).toBe(want)
  })
})
