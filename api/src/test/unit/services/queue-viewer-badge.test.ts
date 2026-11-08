import { beforeEach, describe, expect, it, vi } from 'vitest'

const sigs = new Map<string, string>()
vi.mock('../../../services/queue-snapshot-access.js', () => ({
  accessSigFor: vi.fn(async (u: { id: string }) => sigs.get(u.id) ?? '[]')
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => ({
    where: (w: { id: string }) => ({ first: async () => ({ id: w.id }) })
  }))
}))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => 't1' }))
// The viewer may read workflows 1 and 2 only (a Zones 1-3 person, say).
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(async (_u: unknown, collection: string) => ({ collection })),
  visibleIds: vi.fn(async (_g: unknown, ids: string[]) => new Set(ids.filter((i) => i !== '3')))
}))
vi.mock('../../../services/queues.js', () => ({
  isUnowned: (it: { owners: unknown[] }) => it.owners.length === 0
}))

const { liveBadgeForViewer, resetViewerBadgeCache } = await import(
  '../../../services/queue-viewer-badge.js'
)

const item = (id: string, over: Record<string, unknown> = {}) => ({
  collection: 'workflows',
  item_id: id,
  owners: [{ id: 'o', name: 'O' }],
  sla_status: null,
  ...over
})

describe('liveBadgeForViewer (army 11: no live read per restricted viewer)', () => {
  beforeEach(() => {
    sigs.clear()
    resetViewerBadgeCache()
  })

  it("counts the owner's set through the viewer's own access", async () => {
    const resolve = vi.fn(async () => [
      item('1', { sla_status: 'breached' }),
      item('2', { owners: [] }),
      item('3', { sla_status: 'breached' })
    ])
    const b = await liveBadgeForViewer(
      { id: 'Q', owner: 'owner' },
      { id: 'cj' } as never,
      false,
      resolve as never
    )
    expect(b).toMatchObject({ total: 2, sla_breached: 1, unowned: 1, sla_warning: 0 })
  })

  it('resolves the owner set once for many viewers (one live read per queue a minute)', async () => {
    const resolve = vi.fn(async () => [item('1')])
    await Promise.all(
      ['a', 'b', 'c'].map((v) =>
        liveBadgeForViewer({ id: 'Q', owner: 'owner' }, { id: v } as never, false, resolve as never)
      )
    )
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('gives no figure when the owner is restricted (the set would be too small)', async () => {
    sigs.set('owner', '[["division",["1"]]]')
    const resolve = vi.fn(async () => [item('1')])
    expect(
      await liveBadgeForViewer(
        { id: 'Q', owner: 'owner' },
        { id: 'v' } as never,
        false,
        resolve as never
      )
    ).toBeNull()
  })
})
