import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeDb } from './fake-db.test-helper.js'

const ME = 'u-me'
const now = new Date('2026-11-14T12:00:00Z')

const tables: Record<string, Array<Record<string, unknown>>> = {}
vi.mock('../../db/index.js', () => ({
  db: fakeDb(
    new Proxy(
      {},
      {
        get: (_t, k: string) => tables[k] ?? []
      }
    ) as never
  )
}))
// The read gate: only orders 1 and 2 pass for this person (3 is outside their scope).
const visibleAsked: string[][] = []
vi.mock('../record-access.js', () => ({
  compileAccessGates: async () => ({ collection: 'orders' }),
  visibleIds: async (_g: unknown, ids: string[]) => {
    visibleAsked.push(ids)
    return new Set(ids.filter((i) => i !== '3'))
  }
}))
vi.mock('../collections.js', () => ({
  getCollection: async () => ({ singular: 'Order' }),
  getFields: async () => [{ field: 'id', special: null }]
}))
vi.mock('../command-center/regions.js', () => ({ readableName: () => 'Order' }))
vi.mock('../record-labels-as-viewer.js', () => ({
  recordLabelsAsViewer: async () => ({ 'orders:1': 'PO-1' })
}))
vi.mock('../branch-instances.js', () => ({ excludeBranchChildren: async (r: unknown) => r }))
vi.mock('../../routes/pipelines.js', () => ({
  pickInstancePerItem: (r: unknown) => r,
  resolvedOwnerNames: async () => ({
    '1': [{ id: 'u-beth', name: 'Beth Lee' }],
    // The person owns this step themselves: not waiting on anyone else.
    '2': [{ id: 'U-ME', name: 'Me' }],
    '3': [{ id: 'u-beth', name: 'Beth Lee' }]
  })
}))

import { readWaiting, sortWaiting, waitsOnOthers } from './waiting.js'

beforeEach(() => {
  visibleAsked.length = 0
  tables.nivaro_activity = [
    { collection: 'orders', item: '1' },
    { collection: 'orders', item: '2' },
    { collection: 'orders', item: '3' },
    { collection: 'nivaro_users', item: 'x' }
  ]
  tables.nivaro_workflow_instances = ['1', '2', '3'].map((item) => ({
    id: `i${item}`,
    item,
    collection: 'orders',
    template: 't',
    current_state: 's-review',
    completed_at: null,
    started_at: new Date('2026-11-10T00:00:00Z')
  }))
  tables.nivaro_workflow_history = [
    { instance: 'i1', to_state: 's-review', at: new Date('2026-11-13T12:00:00Z') }
  ]
  tables.nivaro_workflow_states = [
    { id: 's-review', key: 'review', label: 'In review', color: '#f59e0b' }
  ]
})

describe('waiting on others', () => {
  it('lists records the person raised that sit with someone else, as the person', async () => {
    const rows = await readWaiting({ id: ME } as never, false, { now, fresh: true })
    expect(rows.map((r) => r.id)).toEqual(['1'])
    expect(rows[0]).toMatchObject({
      title: 'PO-1',
      state: { label: 'In review' },
      waiting_on: [{ name: 'Beth Lee' }],
      since: '2026-11-13T12:00:00.000Z'
    })
    // The gate was asked about every open candidate, never skipped.
    expect(visibleAsked.flat()).toEqual(expect.arrayContaining(['1', '2', '3']))
  })

  it('needs owners, an open record and an owner other than the person', () => {
    expect(waitsOnOthers('u1', [{ id: 'u2' }], true)).toBe(true)
    expect(waitsOnOthers('u1', [{ id: 'U1' }, { id: 'u2' }], true)).toBe(false)
    expect(waitsOnOthers('u1', [], true)).toBe(false)
    expect(waitsOnOthers('u1', [{ id: 'u2' }], false)).toBe(false)
  })

  it('puts the longest wait first', () => {
    const r = (id: string, since: string | null) =>
      ({ id, since }) as Parameters<typeof sortWaiting>[0][number]
    expect(
      sortWaiting([
        r('a', '2026-11-13T00:00:00Z'),
        r('b', null),
        r('c', '2026-11-01T00:00:00Z')
      ]).map((x) => x.id)
    ).toEqual(['c', 'a', 'b'])
  })
})
