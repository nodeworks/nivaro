import { beforeEach, describe, expect, it, vi } from 'vitest'

// army9 security review: the remove-line undo read the row with raw knex and
// returned every column — fields the caller may not read leaked in the answer.
// It is now read AS THE CALLER and kept to fields they may create.

const rawRow = {
  id: 163116,
  inventory_request: 37827,
  cifa: null,
  quantity: 1,
  secret_cost: 999.99,
  created: '2026-11-07T22:00:00Z'
}
const rawFirst = vi.fn(async () => rawRow)

vi.mock('../../../db/index.js', () => {
  const builder = () => ({ where: () => ({ first: rawFirst }) })
  return { db: Object.assign(builder, { raw: vi.fn() }) }
})
vi.mock('../../../services/items.js', () => ({
  applyFilterToQuery: vi.fn(),
  createOne: vi.fn(),
  updateOne: vi.fn(),
  deleteOne: vi.fn(async () => undefined),
  // The caller's own read: no secret_cost (field permissions hide it).
  readOne: vi.fn(async () => ({ id: 163116, inventory_request: 37827, cifa: null, quantity: 1 }))
}))
vi.mock('../../../services/permissions.js', () => ({
  getAllowedFields: vi.fn(async () => ['inventory_request', 'cifa', 'quantity', 'secret_cost'])
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))

const { applyProposal } = await import('../../../services/integrity-proposals.js')
const items = await import('../../../services/items.js')

describe('remove-line undo snapshot', () => {
  beforeEach(() => vi.clearAllMocks())

  it('never carries a field the caller cannot read, and is read as the caller', async () => {
    const res = await applyProposal(
      {} as never,
      { id: 'u1', role: 'r1' } as never,
      'inventory_request',
      '37827',
      {
        id: 'p1',
        kind: 'clear',
        label: 'Line 3: remove this line',
        basis: '',
        confidence: 'low',
        writes: [{ op: 'delete', collection: 'inventory_request_materials', item_id: '163116' }],
        preview: []
      },
      { field: 'materials', rule: 'row-input', message: 'Line 3: CIFA is empty' }
    )
    expect(res.applied).toBe(1)
    expect(items.readOne).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      'inventory_request_materials',
      '163116'
    )
    expect(rawFirst).not.toHaveBeenCalled()
    expect(res.undo).toEqual([
      {
        op: 'create',
        collection: 'inventory_request_materials',
        data: { inventory_request: 37827, cifa: null, quantity: 1 }
      }
    ])
    expect(JSON.stringify(res.undo)).not.toContain('secret_cost')
  })
})
