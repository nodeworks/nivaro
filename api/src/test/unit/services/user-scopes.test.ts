import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// User scopes are EFP's dimensional row security — the successor to legacy
// EFP's restricted_divisions/regions/project_types junctions. Two modes exist
// and they are NOT symmetric:
//
//   mode 'default'  — advisory only. Pre-selects filter chips in the UI.
//                     NOTHING on the server enforces it.
//   mode 'restrict' — enforced, via whereIn/EXISTS injected into read queries.
//
// Conflating the two is the easy and expensive mistake (assuming a "default
// zone" confines a user), so these tests pin the asymmetry explicitly, along
// with the admin bypass, the internal-collection exemption, and the
// strict-vs-fail-open behaviour when a dimension cannot reach a collection.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../../../db/index.js'
import {
  applyScopeEnforcement,
  bustScopeDimensionCache,
  bustScopePathCache,
  bustUserScopeCache,
  describeUserScopes,
  getUserScopeEnforcement
} from '../../../services/user-scopes.js'
import type { User } from '../../../types.js'

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

const REGION_DIM = {
  id: 2,
  name: 'region',
  label: 'Region',
  target_collection: 'regions',
  display_field: 'short_name',
  options_sort: 'short_name',
  overrides: null,
  exclusions: null,
  strict: false,
  is_active: true
}

function scopeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    user: 'user-creator',
    dimension: 'division',
    mode: 'default',
    values: JSON.stringify([10, 20]),
    ...overrides
  }
}

interface Fx {
  dimensions?: Array<Record<string, unknown>>
  scopes?: Array<Record<string, unknown>>
  /** admin_access for the role looked up by isAdminRole(). */
  roleAdmin?: boolean
  /** Relations feeding the hop BFS; empty means "no route to the collection". */
  relations?: Array<Record<string, unknown>>
  /** Physical tables information_schema reports; defaults to every collection
   *  the fixtures mention (the adjacency builder drops hops through tables
   *  that don't physically exist — metadata is a claim, not truth). */
  tables?: string[]
}

function installDb(fx: Fx = {}) {
  const dimensions = fx.dimensions ?? [ZONE_DIM]
  const scopes = fx.scopes ?? []
  const relations = fx.relations ?? []

  vi.mocked(db).mockImplementation(((table: string) => {
    switch (table) {
      case 'nivaro_scope_dimensions':
        return { orderBy: vi.fn(() => Promise.resolve(dimensions)) }
      case 'nivaro_user_scopes':
        return { where: vi.fn(() => Promise.resolve(scopes)) }
      case 'nivaro_roles':
        return {
          where: vi.fn(() => ({
            first: vi.fn(() => Promise.resolve({ admin_access: !!fx.roleAdmin }))
          }))
        }
      case 'nivaro_relations':
        return { select: vi.fn(() => Promise.resolve(relations)) }
      case 'information_schema.tables': {
        const tables =
          fx.tables ??
          [
            ...new Set(
              [
                ...relations.flatMap((r) => [r.many_collection, r.one_collection]),
                ...dimensions.map((d) => d.target_collection),
                'workflows',
                'unrelated_collection'
              ].filter((t): t is string => typeof t === 'string' && t.length > 0)
            )
          ]
        return {
          select: vi.fn(() => Promise.resolve(tables.map((t) => ({ table_name: t }))))
        }
      }
      default:
        throw new Error(`unexpected table: ${table}`)
    }
  }) as unknown as typeof db)
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-creator',
    first_name: 'Casey',
    last_name: 'Creator',
    email: 'creator@example.com',
    external_id: null,
    role: 'role-workflow-creator',
    status: 'active',
    static_token: null,
    last_access: null,
    last_page: null,
    preferences: null,
    current_workspace: null,
    manager_id: null,
    delegate_id: null,
    delegate_expires_at: null,
    is_out_of_office: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides
  } as User
}

beforeEach(() => {
  // All three caches are 60s TTL and module-level; without a bust every test
  // after the first would read the previous test's fixture (the path cache
  // also holds the adjacency built from information_schema).
  bustScopeDimensionCache()
  bustUserScopeCache()
  bustScopePathCache()
})

afterEach(() => vi.clearAllMocks())

// ─── describeUserScopes — what GET /users/me/scopes returns ────────────────

describe('describeUserScopes', () => {
  it('reports no defaults or restrictions for a user with no scope rows', async () => {
    installDb({ scopes: [] })

    const out = await describeUserScopes('user-creator')

    expect(out.defaults).toEqual({})
    expect(out.restricted).toEqual({})
    expect(out.dimensions).toHaveLength(1)
  })

  it('buckets a default row under defaults, keyed by dimension name', async () => {
    installDb({ scopes: [scopeRow({ mode: 'default', values: JSON.stringify([10, 20]) })] })

    const out = await describeUserScopes('user-creator')

    expect(out.defaults).toEqual({ division: [10, 20] })
    expect(out.restricted).toEqual({})
  })

  it('buckets a restrict row under restricted', async () => {
    installDb({ scopes: [scopeRow({ mode: 'restrict', values: JSON.stringify([10]) })] })

    const out = await describeUserScopes('user-creator')

    expect(out.restricted).toEqual({ division: [10] })
    expect(out.defaults).toEqual({})
  })

  it('reports both modes independently for the same dimension', async () => {
    installDb({
      scopes: [
        scopeRow({ id: 1, mode: 'default', values: JSON.stringify([10]) }),
        scopeRow({ id: 2, mode: 'restrict', values: JSON.stringify([10, 20, 30]) })
      ]
    })

    const out = await describeUserScopes('user-creator')

    expect(out.defaults).toEqual({ division: [10] })
    expect(out.restricted).toEqual({ division: [10, 20, 30] })
  })

  it('drops scope rows whose dimension is inactive or no longer exists', async () => {
    installDb({
      dimensions: [ZONE_DIM],
      scopes: [
        scopeRow({ id: 1, dimension: 'division', mode: 'restrict' }),
        scopeRow({ id: 2, dimension: 'ghost_dimension', mode: 'restrict' })
      ]
    })

    const out = await describeUserScopes('user-creator')

    expect(Object.keys(out.restricted)).toEqual(['division'])
  })

  it('exposes only active dimensions', async () => {
    installDb({ dimensions: [ZONE_DIM, { ...REGION_DIM, is_active: false }] })

    const out = await describeUserScopes('user-creator')

    expect(out.dimensions.map((d) => d.name)).toEqual(['division'])
  })

  it('carries the display metadata the UI needs, preserving the legacy Zone label', async () => {
    installDb({ dimensions: [ZONE_DIM] })

    const out = await describeUserScopes('user-creator')

    expect(out.dimensions[0]).toEqual({
      name: 'division',
      label: 'Zone',
      target_collection: 'divisions',
      display_field: 'short_name',
      options_sort: 'short_name'
    })
  })

  it('treats an unparseable values blob as an empty list rather than throwing', async () => {
    installDb({ scopes: [scopeRow({ mode: 'restrict', values: '{not json' })] })

    const out = await describeUserScopes('user-creator')

    expect(out.restricted).toEqual({ division: [] })
  })
})

// ─── getUserScopeEnforcement — what is actually enforced ───────────────────

describe('getUserScopeEnforcement — defaults are advisory, restrictions are not', () => {
  it('does NOT enforce a default-mode scope', async () => {
    // The headline asymmetry: a "default zone" pre-selects a filter chip in the
    // UI and nothing more. It must never confine the user's query.
    installDb({ scopes: [scopeRow({ mode: 'default', values: JSON.stringify([10]) })] })

    const out = await getUserScopeEnforcement(makeUser(), 'workflows')

    expect(out).toEqual({ filters: [], deny: false })
  })

  it('enforces a restrict-mode scope on the dimension target collection itself', async () => {
    installDb({ scopes: [scopeRow({ mode: 'restrict', values: JSON.stringify([10, 20]) })] })

    const out = await getUserScopeEnforcement(makeUser(), 'divisions')

    expect(out.deny).toBe(false)
    expect(out.filters).toHaveLength(1)
    // Zero hops => compare the collection's own id.
    expect(out.filters[0].hops).toEqual([])
    expect(out.filters[0].ids).toEqual([10, 20])
  })

  it('ignores a restrict row with an empty value list', async () => {
    installDb({ scopes: [scopeRow({ mode: 'restrict', values: JSON.stringify([]) })] })

    const out = await getUserScopeEnforcement(makeUser(), 'divisions')

    expect(out).toEqual({ filters: [], deny: false })
  })

  it('exempts an admin from every restriction', async () => {
    installDb({
      roleAdmin: true,
      scopes: [scopeRow({ mode: 'restrict', values: JSON.stringify([10]) })]
    })

    const out = await getUserScopeEnforcement(
      makeUser({ role: 'role-admin-unique-1' }),
      'divisions'
    )

    expect(out).toEqual({ filters: [], deny: false })
  })

  it('exempts internal nivaro_ collections', async () => {
    installDb({ scopes: [scopeRow({ mode: 'restrict', values: JSON.stringify([10]) })] })

    const out = await getUserScopeEnforcement(makeUser(), 'nivaro_queues')

    expect(out).toEqual({ filters: [], deny: false })
  })

  it('exempts legacy directus_ collections', async () => {
    installDb({ scopes: [scopeRow({ mode: 'restrict', values: JSON.stringify([10]) })] })

    const out = await getUserScopeEnforcement(makeUser(), 'directus_users')

    expect(out).toEqual({ filters: [], deny: false })
  })

  it('silently skips a restrict row naming an unknown dimension', async () => {
    installDb({
      dimensions: [ZONE_DIM],
      scopes: [scopeRow({ dimension: 'ghost_dimension', mode: 'restrict' })]
    })

    const out = await getUserScopeEnforcement(makeUser(), 'divisions')

    expect(out).toEqual({ filters: [], deny: false })
  })

  it('fails OPEN on a non-strict dimension that cannot reach the collection', async () => {
    // Documents current behaviour: no route found and strict=false means the
    // query is left unfiltered — the user sees everything in that collection.
    installDb({
      dimensions: [{ ...ZONE_DIM, strict: false }],
      scopes: [scopeRow({ mode: 'restrict', values: JSON.stringify([10]) })],
      relations: []
    })

    const out = await getUserScopeEnforcement(makeUser(), 'unrelated_collection')

    expect(out.deny).toBe(false)
    expect(out.filters).toEqual([])
  })

  it('denies outright on a strict dimension that cannot reach the collection', async () => {
    installDb({
      dimensions: [{ ...ZONE_DIM, strict: true }],
      scopes: [scopeRow({ mode: 'restrict', values: JSON.stringify([10]) })],
      relations: []
    })

    const out = await getUserScopeEnforcement(makeUser(), 'unrelated_collection')

    expect(out.deny).toBe(true)
  })

  it('leaves an excluded collection unscoped on a non-strict dimension', async () => {
    installDb({
      dimensions: [{ ...ZONE_DIM, strict: false, exclusions: JSON.stringify(['workflows']) }],
      scopes: [scopeRow({ mode: 'restrict', values: JSON.stringify([10]) })]
    })

    const out = await getUserScopeEnforcement(makeUser(), 'workflows')

    expect(out).toEqual({ filters: [], deny: false })
  })

  it('DENIES an excluded collection on a strict dimension — exclusion is not an exemption', async () => {
    // Sharp edge worth knowing: scopeHopsFor() returns null both for "explicitly
    // excluded" and for "no route found", and getUserScopeEnforcement cannot tell
    // them apart. On a strict dimension that null becomes deny=true, so excluding
    // a collection locks it down completely instead of opening it up.
    installDb({
      dimensions: [{ ...ZONE_DIM, strict: true, exclusions: JSON.stringify(['workflows']) }],
      scopes: [scopeRow({ mode: 'restrict', values: JSON.stringify([10]) })]
    })

    const out = await getUserScopeEnforcement(makeUser(), 'workflows')

    expect(out.deny).toBe(true)
  })

  it('accumulates one filter per restricting dimension', async () => {
    installDb({
      dimensions: [
        { ...ZONE_DIM, target_collection: 'divisions' },
        { ...REGION_DIM, target_collection: 'divisions' }
      ],
      scopes: [
        scopeRow({ id: 1, dimension: 'division', mode: 'restrict', values: JSON.stringify([10]) }),
        scopeRow({ id: 2, dimension: 'region', mode: 'restrict', values: JSON.stringify([99]) })
      ]
    })

    const out = await getUserScopeEnforcement(makeUser(), 'divisions')

    expect(out.filters).toHaveLength(2)
    expect(out.filters.map((f) => f.ids)).toEqual([[10], [99]])
  })
})

// ─── applyScopeEnforcement — the SQL it emits ──────────────────────────────

describe('applyScopeEnforcement', () => {
  function makeQuery() {
    const q = {
      whereIn: vi.fn(() => q),
      whereRaw: vi.fn(() => q),
      whereExists: vi.fn(() => q)
    }
    return q
  }

  it('emits an impossible predicate when denied — an empty result, never an error', () => {
    const q = makeQuery()

    applyScopeEnforcement(q as never, 'workflows', {
      filters: [{ hops: [], ids: [10] }],
      deny: true
    })

    expect(q.whereRaw).toHaveBeenCalledWith('1 = 0')
    // A deny short-circuits — no per-filter predicate is added on top.
    expect(q.whereIn).not.toHaveBeenCalled()
  })

  it('compares the collection’s own id when the dimension targets it directly', () => {
    const q = makeQuery()

    applyScopeEnforcement(q as never, 'divisions', {
      filters: [{ hops: [], ids: [10, 20] }],
      deny: false
    })

    expect(q.whereIn).toHaveBeenCalledWith('divisions.id', [10, 20])
  })

  it('applies every filter, so multiple dimensions intersect', () => {
    const q = makeQuery()

    applyScopeEnforcement(q as never, 'divisions', {
      filters: [
        { hops: [], ids: [10] },
        { hops: [], ids: [20] }
      ],
      deny: false
    })

    expect(q.whereIn).toHaveBeenCalledTimes(2)
  })

  it('is a no-op when nothing restricts the user', () => {
    const q = makeQuery()

    applyScopeEnforcement(q as never, 'workflows', { filters: [], deny: false })

    expect(q.whereIn).not.toHaveBeenCalled()
    expect(q.whereRaw).not.toHaveBeenCalled()
    expect(q.whereExists).not.toHaveBeenCalled()
  })

  it('compares the foreign key directly for a single-hop m2o route', () => {
    // A terminal m2o needs no subquery — the FK lives on the row being filtered,
    // so scoping workflows by division is just workflows.division IN (…).
    const q = makeQuery()

    applyScopeEnforcement(q as never, 'workflows', {
      filters: [{ hops: [{ kind: 'm2o', to: 'divisions', fk: 'division' }], ids: [10] }],
      deny: false
    } as never)

    expect(q.whereIn).toHaveBeenCalledWith('workflows.division', [10])
    expect(q.whereExists).not.toHaveBeenCalled()
  })

  it('nests an EXISTS subquery when the route needs more than one hop', () => {
    const q = makeQuery()

    applyScopeEnforcement(q as never, 'workflow_line_items', {
      filters: [
        {
          hops: [
            { kind: 'm2o', to: 'workflows', fk: 'workflow' },
            { kind: 'm2o', to: 'divisions', fk: 'division' }
          ],
          ids: [10]
        }
      ],
      deny: false
    } as never)

    expect(q.whereExists).toHaveBeenCalledTimes(1)
  })
})
