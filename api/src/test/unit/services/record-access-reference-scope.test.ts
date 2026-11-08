import { describe, expect, it, vi } from 'vitest'

// One rule for "does a dimension filter another dimension's target table":
// getUserScopeEnforcement and record-access routeScopeGates must agree, or
// revisions / activity / socket events / access-explain show what /items hides
// (army 9 review H3: projects opted into zone scoping on /items only).

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/user-scopes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/user-scopes.js')>()
  return {
    ...actual,
    scopeHopsFor: vi.fn(async (dim: { target_collection: string }, collection: string) =>
      dim.target_collection === collection
        ? []
        : [
            {
              kind: 'junction',
              from: collection,
              to: dim.target_collection,
              junction: 'j',
              parentFk: 'p',
              targetFk: 't'
            }
          ]
    )
  }
})

import { routeScopeGates } from '../../../services/record-access.js'
import { dimensionScopesTable, type ScopeDimension } from '../../../services/user-scopes.js'

const dim = (name: string, target: string, overrides: Record<string, string[]> | null = null) =>
  ({
    id: 1,
    name,
    label: name,
    target_collection: target,
    display_field: null,
    options_sort: null,
    overrides,
    exclusions: null,
    strict: false,
    is_active: true
  }) as ScopeDimension

describe('dimensionScopesTable', () => {
  it('own target: yes; another target: only with an override route', () => {
    expect(dimensionScopesTable(dim('project', 'projects'), 'projects')).toBe(true)
    expect(dimensionScopesTable(dim('division', 'divisions'), 'projects')).toBe(false)
    expect(
      dimensionScopesTable(dim('division', 'divisions', { projects: ['divisions'] }), 'projects')
    ).toBe(true)
    expect(dimensionScopesTable(dim('division', 'divisions', { projects: [] }), 'projects')).toBe(
      false
    )
  })
})

describe('routeScopeGates follows the same rule', () => {
  const restricts = [{ dimension: 'division', values: [10] }]
  it('skips the zone dimension on projects without an override', async () => {
    const dims = [dim('division', 'divisions'), dim('project', 'projects')]
    const out = await routeScopeGates(restricts, dims, 'projects')
    expect(out.scopes).toHaveLength(0)
  })
  it('applies the zone dimension on projects when it names a route', async () => {
    const dims = [
      dim('division', 'divisions', { projects: ['divisions'] }),
      dim('project', 'projects')
    ]
    const out = await routeScopeGates(restricts, dims, 'projects')
    expect(out.scopes.map((s) => s.dimension)).toEqual(['division'])
  })
})
