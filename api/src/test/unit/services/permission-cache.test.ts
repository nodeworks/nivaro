import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import {
  attachPermissionCacheCommitHook,
  attachPermissionCacheSeam,
  bodyTouchesAccess,
  bumpAccessVersion,
  bumpUserAccessVersion,
  classifyStatement,
  clearPermissionCache,
  isAccessWrite,
  notePermissionStatement,
  notePrincipalKind,
  PERMISSION_CACHE_TTL_MS,
  permissionCacheStats,
  resetPermissionCacheForTests,
  setPermissionCacheEnabled,
  setPermissionCacheProcLookup,
  setPermissionCacheRedis
} from '../../../services/permission-cache.js'
import { can, getAllowedFields, getRowFilter, isAdminRole } from '../../../services/permissions.js'
import {
  bustScopeDimensionCache,
  bustUserScopeCache,
  getUserScopeEnforcement,
  getUserScopes
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
  columnFail: 0,
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
    columnInfo: vi.fn(async () => {
      if (state.columnFail > 0) {
        state.columnFail--
        throw new Error('column read failed')
      }
      return { id: {}, first_name: {}, last_name: {}, email: {} }
    }),
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej)
  })
  return chain
}

// ── a Redis that two "processes" share ───────────────────────────────────────

const G = 'nvr:permver:{}:g'
const NONCE = 'nvr:permver:{}:n'
const U = (id: string) => `nvr:permver:{}:u:${id}`

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
    expire: vi.fn(async () => 1),
    set: vi.fn(async (key: string, value: string, _mode: 'NX') => {
      if (kv.has(key)) return null
      kv.set(key, value)
      return 'OK'
    })
  }
  // The incarnation nonce a running cluster already has.
  kv.set(NONCE, 'boot-1')
  return r
}
let redis = makeRedis()

/** Another replica moving the cluster-wide version (its own write went through its seam). */
async function remoteBump(userId?: string) {
  await redis.incr(userId ? U(userId.toLowerCase()) : G)
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
    expect(redis.mget.mock.calls.some((c) => c[1] === 'nvr:permver:{tenant-a}:g')).toBe(true)
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
      expect(redis.kv.get(G)).toBe('1')
      client.emit('query-response', [], { sql })
      expect(redis.kv.get(G)).toBe('2')
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
    const after = Number(redis.kv.get(G))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(Number(redis.kv.get(G))).toBe(after + 1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(Number(redis.kv.get(G))).toBe(after + 3)
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

  it("a person's bump drops only that person's entries here", async () => {
    const other = () => freshUser({ id: 'other-user-id' })
    await can(other(), 'read', 'articles')
    await can(freshUser(), 'read', 'articles')
    const reads = state.reads
    bumpUserAccessVersion('test-user-id')
    await can(other(), 'read', 'articles')
    expect(state.reads).toBe(reads)
    await can(freshUser(), 'read', 'articles')
    expect(state.reads).toBeGreaterThan(reads)
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
    expect(redis.kv.get(U('test-user-id'))).toBe('1')
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

describe('statement shapes that may change access', () => {
  it.each([
    ['UPDATE nivaro_roles WITH (ROWLOCK) SET admin_access = 0', true],
    ['update /* x */ nivaro_roles set admin_access = 0', true],
    ['update nivaro_roles r set admin_access = false', true],
    ['update nivaro_roles as r set admin_access = false', true],
    ['SET NOCOUNT ON; DROP TABLE nivaro_policies', true],
    ['SET NOCOUNT ON; DROP TABLE some_junction', true],
    ['create table [projects_regions] ([id] int)', true],
    ['CREATE OR ALTER VIEW v_scope AS SELECT 1 AS x', true],
    ['select * into archive_copy from projects', true],
    ["EXEC sp_executesql N'UPDATE nivaro_roles SET admin_access = 0'", true],
    ['exec (@sql)', true],
    ["exec('update x set y = 1')", true],
    ['insert into [nivaro_policies] ([role]) output inserted.[id] values (@p0)', true],
    ['update [nivaro_policies] set [fields] = @p0 where [id] = @p1;select @@rowcount', true],
    [
      'merge [nivaro_user_scopes] as t using (select 1 as a) s on 1 = 0 when not matched then insert (a) values (1);',
      true
    ],
    ["select * from nivaro_roles where name = 'update nivaro_roles set x'", false],
    ['select * from nivaro_roles -- update nivaro_roles set x', false],
    ['select [id] into #ids from [nivaro_relations]', false],
    ['create table #scratch (id int)', false],
    ['drop table if exists #scratch', false],
    ['exec sp_getapplock @Resource = @p0', false]
  ])('%s → %s', (sql, want) => {
    expect(isAccessWrite(sql)).toBe(want)
  })

  it('names the procedures a batch runs', () => {
    expect(classifyStatement('EXEC dbo.usp_budget_rollup @year = 2026').procs).toEqual([
      'dbo.usp_budget_rollup'
    ])
    expect(classifyStatement('exec @rc = [dbo].[sync_scopes]').procs).toEqual(['dbo.sync_scopes'])
  })

  it('a procedure body decides: unknown or touching = bump, a plain one = no bump', async () => {
    const bodies: Record<string, string> = {
      'dbo.report_only': 'CREATE PROCEDURE dbo.report_only AS SELECT * FROM projects',
      'dbo.sync_scopes': 'CREATE PROCEDURE dbo.sync_scopes AS DELETE FROM nivaro_user_scopes',
      'dbo.nested': 'CREATE PROCEDURE dbo.nested AS EXEC dbo.other'
    }
    setPermissionCacheProcLookup(async (name) => bodies[name] ?? null)
    const tick = () => new Promise((r) => setTimeout(r, 0))
    const start = Number(redis.kv.get(G) ?? 0)
    // First sight: not known yet, so it counts.
    expect(notePermissionStatement('exec dbo.report_only', false)).toBe(true)
    await tick()
    expect(notePermissionStatement('exec dbo.report_only', false)).toBe(false)
    notePermissionStatement('exec dbo.sync_scopes', false)
    await tick()
    expect(notePermissionStatement('exec dbo.sync_scopes', false)).toBe(true)
    notePermissionStatement('exec dbo.nested', false)
    await tick()
    expect(notePermissionStatement('exec dbo.nested', false)).toBe(true)
    // A redeployed procedure is looked at again.
    notePermissionStatement('CREATE OR ALTER PROCEDURE dbo.report_only AS SELECT 1', false)
    expect(notePermissionStatement('exec dbo.report_only', false)).toBe(true)
    expect(bodyTouchesAccess(null)).toBe(true)
    await tick()
    expect(Number(redis.kv.get(G))).toBeGreaterThan(start)
    setPermissionCacheProcLookup(null)
  })
})

describe('transactions move the version when they settle', () => {
  type Pending = { resolve: () => void; reject: (e: unknown) => void }
  class FakeClient {
    trxs: Pending[] = []
    transaction(_container: unknown, _config: unknown, outerTx?: { txid: string }) {
      let resolve: () => void = () => {}
      let reject: (e: unknown) => void = () => {}
      const p = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      p.catch(() => {})
      this.trxs.push({ resolve, reject })
      return {
        txid: `trx${this.trxs.length}`,
        outerTx: outerTx ?? null,
        // biome-ignore lint/suspicious/noThenProperty: a knex Transaction is a thenable
        then: (a: () => void, b: (e: unknown) => void) => p.then(a, b)
      }
    }
  }
  const client = new FakeClient()
  attachPermissionCacheCommitHook(client)
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const g = () => Number(redis.kv.get(G) ?? 0)

  it('commit of a transaction that wrote an access table moves the version after it', async () => {
    const trx = client.transaction(null, null)
    notePermissionStatement('update [nivaro_policies] set [x] = @p0', false, trx.txid)
    await tick()
    const during = g()
    client.trxs[client.trxs.length - 1].resolve()
    await tick()
    expect(g()).toBe(during + 1)
  })

  it('a rollback moves it too, and an unrelated transaction does not', async () => {
    const trx = client.transaction(null, null)
    notePermissionStatement('delete from [nivaro_roles] where [id] = @p0', false, trx.txid)
    client.transaction(null, null)
    await tick()
    const during = g()
    client.trxs[client.trxs.length - 1].resolve()
    await tick()
    expect(g()).toBe(during)
    client.trxs[client.trxs.length - 2].reject(new Error('rolled back'))
    await tick()
    expect(g()).toBe(during + 1)
  })

  it('a savepoint hands its mark to the outer transaction', async () => {
    const outer = client.transaction(null, null)
    const inner = client.transaction(null, null, outer)
    notePermissionStatement(
      'insert into [nivaro_user_scopes] ([user]) values (@p0)',
      false,
      inner.txid
    )
    await tick()
    const during = g()
    client.trxs[client.trxs.length - 1].resolve() // savepoint released
    await tick()
    expect(g()).toBe(during)
    client.trxs[client.trxs.length - 2].resolve() // outer commit
    await tick()
    expect(g()).toBe(during + 1)
  })
})

describe('races and resets the fills must not survive', () => {
  const region = {
    id: 1,
    name: 'region',
    label: 'Region',
    target_collection: 'articles',
    strict: false,
    is_active: true
  }
  const restrict = {
    id: 1,
    user: 'test-user-id',
    dimension: 'region',
    mode: 'restrict',
    values: '[7]'
  }

  it('the cache console / epoch clear also drops the scope rows the entries came from', async () => {
    state.dimensions = [region]
    expect((await getUserScopeEnforcement(freshUser(), 'articles')).filters).toEqual([])
    state.userScopes.push(restrict)
    clearPermissionCache()
    expect((await getUserScopeEnforcement(freshUser(), 'articles')).filters).toHaveLength(1)
  })

  it('a scope-row read that straddled a reset is answered but not kept', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((t: string) => {
      const c = chainFor(t) as Record<string, unknown>
      const then = c.then as (a: (v: unknown) => unknown, b?: (e: unknown) => unknown) => unknown
      // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
      c.then = (a: (v: unknown) => unknown, b?: (e: unknown) => unknown) =>
        gate.then(() => then(a, b))
      return c as never
    })
    const pending = getUserScopes('test-user-id')
    await new Promise((r) => setTimeout(r, 0))
    bumpAccessVersion() // a write landed while the read was out…
    release() // …and the read comes back with what it saw before it
    expect(await pending).toHaveLength(0)
    state.userScopes.push(restrict)
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation(
      (t: string) => chainFor(t) as never
    )
    expect(await getUserScopes('test-user-id')).toHaveLength(1)
  })

  it('counters lost and climbed back to the same number still count as a move (nonce)', async () => {
    await remoteBump()
    expect(await can(freshUser(), 'delete', 'articles')).toBe(false)
    state.policies.push({
      id: 9,
      role: 'regular-role-id',
      action: 'delete',
      collection: 'articles'
    })
    // Redis came back empty, then one write moved g back to exactly 1.
    redis.kv.clear()
    await remoteBump()
    expect(await can(freshUser(), 'delete', 'articles')).toBe(true) // no nonce: uncached
    await new Promise((r) => setTimeout(r, 0))
    expect(redis.kv.get(NONCE)).toBeTruthy()
    expect(await can(freshUser(), 'delete', 'articles')).toBe(true) // new nonce: rebuilt
  })

  it('a field list built from the fallback column list is not kept', async () => {
    state.policies.push({
      id: 20,
      role: 'regular-role-id',
      action: 'read',
      collection: 'nivaro_users'
    })
    state.columnFail = 1
    expect(await getAllowedFields(freshUser(), 'read', 'nivaro_users')).toEqual(['id'])
    expect(await getAllowedFields(freshUser(), 'read', 'nivaro_users')).toContain('first_name')
  })
})

describe('off: nothing on the write side', () => {
  it('moves no version and reads nothing', async () => {
    setPermissionCacheEnabled(false)
    expect(notePermissionStatement('update [nivaro_roles] set [x] = 1', false, 'trx9')).toBe(false)
    bumpAccessVersion()
    bumpUserAccessVersion('test-user-id')
    await new Promise((r) => setTimeout(r, 0))
    expect(redis.incr).not.toHaveBeenCalled()
  })
})
