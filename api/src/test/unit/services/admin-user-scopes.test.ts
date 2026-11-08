import knexFactory from 'knex'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Decision 2026-11-08: restrict-mode User Scopes bind administrators too.
// An admin limited to Zones 1-3 sees Zones 1-3 in lists, records, queues,
// pickers and search, exactly like anyone else; every other admin power
// (no policy checks, no row filters) stays. An admin with no restriction is
// unchanged. These tests run the REAL user-scopes / record-access / queue
// gate code over fixture metadata; only the role policy layer is stubbed.

const knex = knexFactory({ client: 'mssql' })

interface Fx {
  /** user id → scope rows */
  scopes: Record<string, Array<Record<string, unknown>>>
  /** role id → admin_access */
  roles: Record<string, boolean>
}
const fx: Fx = { scopes: {}, roles: {} }

const ZONE_DIM = {
  id: 1,
  name: 'division',
  label: 'Zone',
  target_collection: 'divisions',
  display_field: 'short_name',
  options_sort: 'short_name',
  overrides: null,
  exclusions: null,
  strict: false,
  is_active: true
}

vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    switch (table) {
      case 'nivaro_scope_dimensions':
        return { orderBy: () => Promise.resolve([ZONE_DIM]) }
      case 'nivaro_user_scopes':
        return {
          where: (w: { user: string }) => Promise.resolve(fx.scopes[String(w.user)] ?? [])
        }
      case 'nivaro_roles':
        return {
          where: (w: { id: string }) => ({
            first: () => Promise.resolve({ admin_access: !!fx.roles[String(w.id)] })
          })
        }
      case 'nivaro_relations':
        return { select: () => Promise.resolve([]) }
      case 'information_schema.tables':
        return { select: () => Promise.resolve([{ table_name: 'divisions' }]) }
      default:
        return knex(table)
    }
  }
  return { db: Object.assign(db, { raw: knex.raw.bind(knex) }) }
})

const perms = {
  can: vi.fn(async () => true),
  getRowFilter: vi.fn(async () => null as unknown),
  applyRowFilter: vi.fn((q: { where: (c: string, v: unknown) => void }) => q.where('owner', 'me')),
  getAllowedFields: vi.fn(async () => null),
  scopeAllows: vi.fn(() => true),
  isAdminRole: vi.fn(async () => false)
}
vi.mock('../../../services/permissions.js', () => perms)

const scopesMod = await import('../../../services/user-scopes.js')
const { applyUserScopesToQuery, bustUserScopeCache, getUserScopeEnforcement, seesAllRecords } =
  scopesMod
const { compileAccessGates } = await import('../../../services/record-access.js')
const { queueGateFor, applyQueueGate } = await import('../../../services/queue-access.js')
const { nestedGate } = await import('../../../services/graphql-nested-access.js')
const { applyScopeParams } = await import('../../../services/custom-query-scope.js')
const { assertInstanceAccess, InstanceAccessError } = await import(
  '../../../services/instance-guard.js'
)

const restrictRow = (user: string, values: unknown[]) => ({
  id: 1,
  user,
  dimension: 'division',
  mode: 'restrict',
  values: JSON.stringify(values)
})

// Distinct ids per test so the per-user caches never cross tests.
let n = 0
function person(opts: { admin: boolean; restrict?: unknown[]; key?: unknown[] }) {
  n++
  const id = `user-${n}`
  const role = `role-${n}`
  fx.roles[role] = opts.admin
  fx.scopes[id] = opts.restrict ? [restrictRow(id, opts.restrict)] : []
  return {
    id,
    role,
    ...(opts.key
      ? { api_key_scope_restrictions: [{ dimension: 'division', values: opts.key }] }
      : {})
  } as never
}

beforeEach(() => {
  bustUserScopeCache()
  perms.can.mockClear()
  perms.getRowFilter.mockClear()
})

describe('items reads (lists, readOne, pickers, search all compile through this)', () => {
  it('an admin with a restriction is filtered to it', async () => {
    const q = knex('divisions').select('id')
    await applyUserScopesToQuery(q, 'divisions', person({ admin: true, restrict: [1, 2, 3] }))
    const sql = q.toSQL()
    expect(sql.sql).toContain('[divisions].[id] in (?, ?, ?)')
    expect(sql.bindings).toEqual([1, 2, 3])
  })

  it('an admin with no restriction reads unchanged', async () => {
    const q = knex('divisions').select('id')
    await applyUserScopesToQuery(q, 'divisions', person({ admin: true }))
    expect(q.toSQL().sql).toBe('select [id] from [divisions]')
  })

  it('a non-admin is unchanged: restricted is filtered, unrestricted is not', async () => {
    const restricted = knex('divisions').select('id')
    await applyUserScopesToQuery(restricted, 'divisions', person({ admin: false, restrict: [4] }))
    expect(restricted.toSQL().bindings).toEqual([4])
    const open = knex('divisions').select('id')
    await applyUserScopesToQuery(open, 'divisions', person({ admin: false }))
    expect(open.toSQL().sql).toBe('select [id] from [divisions]')
  })

  it('API-key restrictions apply as before (non-admin key: own + key)', async () => {
    const e = await getUserScopeEnforcement(
      person({ admin: false, restrict: [1, 2, 3], key: [2] }),
      'divisions'
    )
    expect(e.filters.map((f) => f.ids)).toEqual([[1, 2, 3], [2]])
  })

  it('View-as judges the target person: their rows, not the viewing admin', async () => {
    const target = person({ admin: false, restrict: [4] })
    person({ admin: true }) // the unrestricted admin behind the View-as session
    const e = await getUserScopeEnforcement(target, 'divisions')
    expect(e.filters.map((f) => f.ids)).toEqual([[4]])
  })
})

describe('record-access gates (record pages, revisions, comments, sockets, exports)', () => {
  it('an acting admin skips policy and row filter but keeps their scope', async () => {
    const gates = await compileAccessGates(
      person({ admin: true, restrict: [1, 2, 3] }),
      'divisions',
      { actingAdmin: true }
    )
    expect(gates.bypass).toBe(false)
    expect(gates.permitted).toBe(true)
    expect(gates.rowFilter).toBeNull()
    expect(gates.scopes.map((s) => s.values)).toEqual([[1, 2, 3]])
    expect(perms.can).not.toHaveBeenCalled()
    expect(perms.getRowFilter).not.toHaveBeenCalled()
  })

  it('an acting admin with no restriction bypasses, as before', async () => {
    const gates = await compileAccessGates(person({ admin: true }), 'divisions', {
      actingAdmin: true
    })
    expect(gates.bypass).toBe(true)
    expect(perms.can).not.toHaveBeenCalled()
  })

  it('system tables still bypass for an acting admin', async () => {
    const gates = await compileAccessGates(person({ admin: true, restrict: [1] }), 'nivaro_tasks', {
      actingAdmin: true
    })
    expect(gates.bypass).toBe(true)
  })

  it('a non-admin is unchanged: policy, row filter and scope all checked', async () => {
    perms.getRowFilter.mockResolvedValueOnce([{ field: 'owner' }])
    const gates = await compileAccessGates(person({ admin: false, restrict: [4] }), 'divisions')
    expect(perms.can).toHaveBeenCalled()
    expect(gates.rowFilter).toEqual([{ field: 'owner' }])
    expect(gates.scopes.map((s) => s.values)).toEqual([[4]])
    expect(gates.bypass).toBe(false)
  })
})

describe('queues (live and materialized reads both use queueGateFor)', () => {
  it('a restricted admin gets a scope gate; an unrestricted admin none', async () => {
    const restricted = await queueGateFor(person({ admin: true, restrict: [1, 2, 3] }), 'divisions')
    expect(restricted?.scopes.filters.map((f) => f.ids)).toEqual([[1, 2, 3]])
    const q = knex('divisions').select('id')
    applyQueueGate(q, restricted, person({ admin: true }))
    expect(q.toSQL().bindings).toEqual([1, 2, 3])
    expect(await queueGateFor(person({ admin: true }), 'divisions')).toBeNull()
  })
})

describe('GraphQL nested reads', () => {
  it('an unrestricted admin is OPEN; a restricted one is narrowed', async () => {
    const open = await nestedGate({ user: person({ admin: true }), isAdmin: true }, 'divisions')
    expect(open.open).toBe(true)
    const narrowed = await nestedGate(
      { user: person({ admin: true, restrict: [1, 2, 3] }), isAdmin: true },
      'divisions'
    )
    expect(narrowed.open).toBe(false)
    expect(narrowed.rowFilter).toBeNull()
    expect(narrowed.scopes.filters.map((f) => f.ids)).toEqual([[1, 2, 3]])
  })
})

describe('seesAllRecords — the shortcut every record gate may take', () => {
  it('only for an admin no restriction binds', async () => {
    expect(await seesAllRecords(false, person({ admin: false }))).toBe(false)
    expect(await seesAllRecords(true, person({ admin: true }))).toBe(true)
    expect(await seesAllRecords(true, person({ admin: true, restrict: [1] }))).toBe(false)
    expect(await seesAllRecords(true, person({ admin: true, key: [1] }))).toBe(false)
  })
})

describe('custom queries — scope_params', () => {
  it('injects a restricted admin’s allowance; leaves an unrestricted admin alone', async () => {
    const declared = JSON.stringify({ zones: { dimension: 'division' } })
    const restricted = person({ admin: true, restrict: [1, 2, 3] }) as unknown as { id: string }
    const p1: Record<string, unknown> = {}
    await applyScopeParams(declared, p1, restricted.id, true)
    expect(p1.zones).toBe('1,2,3')
    const p2: Record<string, unknown> = { zones: '4' }
    await applyScopeParams(declared, p2, restricted.id, true)
    expect(p2.zones).toBe('__scope_empty__')
    const open = person({ admin: true }) as unknown as { id: string }
    const p3: Record<string, unknown> = { zones: '4' }
    await applyScopeParams(declared, p3, open.id, true)
    expect(p3.zones).toBe('4')
  })
})

describe('pipeline instance guard (record pipeline reads, transitions)', () => {
  const deps = (row: unknown) => ({
    can: vi.fn(async () => true),
    readOne: vi.fn(async () => row),
    updatable: vi.fn(async () => true),
    subject: vi.fn(async (c: string, i: string) => ({ collection: c, itemId: i })),
    restricted: async (u: unknown) =>
      (await import('../../../services/user-scopes.js')).hasRestrictScope(u as never)
  })

  it('a restricted admin gets 404 outside their scope, passes inside it', async () => {
    const admin = person({ admin: true, restrict: [1, 2, 3] })
    await expect(
      assertInstanceAccess(admin, true, 'workflows', '9', deps(null), 'read')
    ).rejects.toMatchObject({ statusCode: 404 })
    const inside = deps({ id: '9' })
    await assertInstanceAccess(admin, true, 'workflows', '9', inside, 'update')
    // Admin powers stay: no policy or update-row-filter checks.
    expect(inside.can).not.toHaveBeenCalled()
    expect(inside.updatable).not.toHaveBeenCalled()
  })

  it('an unrestricted admin passes without a record read', async () => {
    const d = deps(null)
    await assertInstanceAccess(person({ admin: true }), true, 'workflows', '9', d, 'read')
    expect(d.readOne).not.toHaveBeenCalled()
  })

  it('a non-admin is unchanged', async () => {
    const err = await assertInstanceAccess(
      person({ admin: false, restrict: [4] }),
      false,
      'workflows',
      '9',
      deps(null),
      'read'
    ).catch((e) => e)
    expect(err).toBeInstanceOf(InstanceAccessError)
    expect(err.statusCode).toBe(404)
  })
})
