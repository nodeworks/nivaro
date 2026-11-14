import { beforeEach, describe, expect, it, vi } from 'vitest'

// The real canReadPath walks a dotted dimension path hop by hop through the
// Ask AI guard: a readable link on the record is not enough — the related
// collection's own field list decides whether its value may be named.

const allowedBy = new Map<string, string[] | null>()
vi.mock('./permissions.js', () => ({
  can: async () => true,
  getRowFilter: async () => null,
  getAllowedFields: async (_u: unknown, _a: string, c: string) => allowedBy.get(c) ?? null
}))
vi.mock('./user-scopes.js', () => ({
  getUserScopeEnforcement: async () => ({ deny: false, filters: [] })
}))
vi.mock('./ai-chat.js', () => ({
  chatFieldSet: async (c: string) =>
    new Set(
      c === 'inventory_request' ? ['id', 'division', 'region', 'user_created'] : ['id', 'name']
    ),
  chatRelationsFor: async (c: string) => ({
    m2o:
      c === 'inventory_request'
        ? [
            { field: 'division', collection: 'divisions' },
            { field: 'region', collection: 'regions' }
          ]
        : []
  })
}))

const { realStandInDeps } = await import('./stand-in-reason.js')
const viewer = { user: { id: 'U1', role: 'R1' } as never, isAdmin: false }

describe('realStandInDeps.canReadPath', () => {
  beforeEach(() => allowedBy.clear())

  it('needs read access at every hop, not just the root', async () => {
    allowedBy.set('inventory_request', ['id', 'division', 'region'])
    allowedBy.set('divisions', ['id']) // the link is readable, the name is not
    allowedBy.set('regions', ['id', 'name'])
    expect(await realStandInDeps.canReadPath(viewer, 'inventory_request', 'division.name')).toBe(
      false
    )
    expect(await realStandInDeps.canReadPath(viewer, 'inventory_request', 'region.name')).toBe(true)
  })

  it('refuses an unreadable root and lets administrators read everything', async () => {
    allowedBy.set('inventory_request', ['id', 'region'])
    expect(await realStandInDeps.canReadPath(viewer, 'inventory_request', 'division.name')).toBe(
      false
    )
    expect(await realStandInDeps.canReadPath(viewer, 'inventory_request', 'user_created')).toBe(
      false
    )
    expect(
      await realStandInDeps.canReadPath(
        { user: undefined, isAdmin: true },
        'inventory_request',
        'division.name'
      )
    ).toBe(true)
  })
})
