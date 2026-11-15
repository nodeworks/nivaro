import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeDb } from './fake-db.test-helper.js'

const tables: Record<string, Array<Record<string, unknown>>> = {}
vi.mock('../../db/index.js', () => ({
  db: fakeDb(new Proxy({}, { get: (_t, k: string) => tables[k] ?? [] }) as never)
}))
// The items read AS THE VIEWER returns only what they may read: order 2 is outside their scope.
const readAsked: unknown[][] = []
vi.mock('../items.js', () => ({
  readItems: async (...a: unknown[]) => {
    readAsked.push(a)
    return { data: [{ id: 1, number: 'PO-1', total: 1200, secret_cost: 9 }] }
  }
}))
const gateAsked: string[][] = []
vi.mock('../record-access.js', () => ({
  compileAccessGates: async () => ({}),
  visibleIds: async (_g: unknown, ids: string[]) => {
    gateAsked.push(ids)
    return new Set(ids.filter((i) => i === '1'))
  }
}))
vi.mock('../collections.js', () => ({
  getCollection: async () => ({ singular: 'Order', display_template: '{{number}} {{total}}' }),
  getFields: async () => [
    { field: 'id', type: 'integer' },
    { field: 'number', type: 'string' },
    { field: 'total', type: 'decimal', label: 'Total' },
    { field: 'secret_cost', type: 'decimal' }
  ]
}))
vi.mock('../permissions.js', () => ({
  getAllowedFields: async () => ['id', 'number', 'total']
}))
vi.mock('../command-center/regions.js', () => ({ readableName: () => 'Order' }))
vi.mock('../record-labels-as-viewer.js', () => ({
  recordLabelsAsViewer: async () => ({ 'orders:1': 'PO-1' })
}))
vi.mock('../branch-instances.js', () => ({ excludeBranchChildren: async (r: unknown) => r }))
vi.mock('../../routes/pipelines.js', () => ({
  pickInstancePerItem: (r: unknown) => r,
  resolvedOwnerNames: async () => ({ '1': [{ id: 'u-beth', name: 'Beth Lee' }] })
}))
vi.mock('../../routes/sla.js', () => ({
  computeStatusBatch: async () => ({
    '1': {
      status: 'warning',
      entered_at: '2026-11-14T08:00:00Z',
      warning_at: '2026-11-14T11:00:00Z',
      due_at: '2026-11-14T14:00:00Z'
    }
  })
}))
vi.mock('./step-medians.js', () => ({
  stepMedians: async () => new Map([['s-review', 7200]])
}))

import { readWatchRows } from './rows.js'
import { normalizeWatchList } from './store.js'

const list = normalizeWatchList({
  pins: [
    { c: 'orders', id: '1', at: '2026-11-14T09:00:00Z' },
    { c: 'orders', id: '2', at: '2026-11-14T09:00:00Z' }
  ]
})
const user = { id: 'u-me' } as never

beforeEach(() => {
  readAsked.length = 0
  gateAsked.length = 0
  tables.nivaro_workflow_instances = [
    {
      id: 'i1',
      item: '1',
      template: 't',
      current_state: 's-review',
      completed_at: null,
      started_at: new Date('2026-11-14T08:00:00Z')
    }
  ]
  tables.nivaro_workflow_states = [
    { id: 's-review', key: 'review', label: 'In review', color: '#f59e0b', template: 't' }
  ]
  tables.nivaro_users = [{ id: 'u-beth', first_name: 'Beth', last_name: 'Lee' }]
})

describe('watch rows', () => {
  it('reads every pin as the viewer and says only "not available" about the hidden one', async () => {
    const { rows } = await readWatchRows(list, {
      user,
      isAdmin: false,
      now: new Date('2026-11-14T12:00:00Z')
    })
    expect(readAsked).toHaveLength(1)
    expect(readAsked[0][0]).toBe(user)
    const [one, two] = rows
    expect(one).toMatchObject({
      key: 'orders:1',
      available: true,
      title: 'PO-1',
      state: { label: 'In review' },
      owners: [{ name: 'Beth Lee' }],
      sla: { status: 'warning', due_at: '2026-11-14T14:00:00.000Z' },
      timing: { in_step_s: 4 * 3600, usual_s: 7200, ratio: 2 }
    })
    // Figures only from fields the viewer's read returned.
    expect(one.figures.map((f) => f.field)).toEqual(['total'])
    expect(two).toEqual({
      key: 'orders:2',
      collection: 'orders',
      collection_label: 'Order',
      id: '2',
      pinned_at: '2026-11-14T09:00:00.000Z',
      available: false,
      title: null,
      state: null,
      owners: [],
      figures: [],
      sla: null,
      timing: null,
      change: null,
      updated_at: null
    })
  })

  it('summary mode checks visibility through the read gate and reads no rows', async () => {
    const { rows, changed } = await readWatchRows(list, { user, isAdmin: false, summary: true })
    expect(rows).toEqual([])
    expect(changed).toEqual([])
    expect(readAsked).toHaveLength(0)
    expect(gateAsked).toEqual([['1', '2']])
  })
})
