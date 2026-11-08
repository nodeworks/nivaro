import { beforeEach, describe, expect, it, vi } from 'vitest'

const scopes = new Map<string, Array<{ dimension: string; values: Array<string | number> }>>()
vi.mock('../../../services/user-scopes.js', () => ({
  restrictScopesFor: vi.fn(async (u: { id: string }) => scopes.get(u.id) ?? [])
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => ({
    where: (w: { id: string }) => ({ first: async () => ({ id: w.id }) })
  }))
}))

const { snapshotsFitViewer, accessSigFor } = await import(
  '../../../services/queue-snapshot-access.js'
)

describe('snapshotsFitViewer (army 11 Q2-7)', () => {
  beforeEach(() => scopes.clear())

  it('fits when viewer and queue owner carry the same restrictions (none)', async () => {
    expect(await snapshotsFitViewer({ owner: 'owner' }, { id: 'viewer' })).toBe(true)
  })

  it('does not fit a Zones 1-3 viewer against an unrestricted owner', async () => {
    scopes.set('viewer', [{ dimension: 'division', values: [1, 2, 3] }])
    expect(await snapshotsFitViewer({ owner: 'owner' }, { id: 'viewer' })).toBe(false)
  })

  it('fits when both are restricted the same way, whatever the order', async () => {
    scopes.set('viewer', [{ dimension: 'division', values: [3, 1, 2] }])
    scopes.set('owner', [{ dimension: 'division', values: ['1', '2', '3'] }])
    expect(await snapshotsFitViewer({ owner: 'owner' }, { id: 'viewer' })).toBe(true)
  })

  it('an unrestricted person signs as "[]"', async () => {
    expect(await accessSigFor({ id: 'nobody' })).toBe('[]')
    expect(await accessSigFor(null)).toBe('[]')
  })
})
