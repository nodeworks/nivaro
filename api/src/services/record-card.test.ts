import { beforeEach, describe, expect, it, vi } from 'vitest'

// The record read AS THE VIEWER: null = they cannot see it (row filter / scope), a throw with
// 403/404 = no access at all. Either way there is no card.
let readOneResult: Record<string, unknown> | null = null
let readOneError: { statusCode: number } | null = null
const readOneCalls: unknown[][] = []
vi.mock('./items.js', () => ({
  readOne: async (...args: unknown[]) => {
    readOneCalls.push(args)
    if (readOneError) throw Object.assign(new Error('refused'), readOneError)
    return readOneResult
  }
}))
vi.mock('./collections.js', () => ({
  getCollection: async () => ({ display_template: '{{number}} · {{total}}', singular: 'Order' }),
  getFields: async () => [
    { field: 'id', type: 'integer' },
    { field: 'number', type: 'string' },
    { field: 'total', type: 'decimal', label: 'Order total' },
    { field: 'tax_amount', type: 'decimal' },
    { field: 'secret_cost', type: 'decimal' },
    { field: 'line_count', type: 'integer' }
  ]
}))
vi.mock('./record-labels-as-viewer.js', () => ({
  recordLabelsAsViewer: async () => ({ 'orders:5': 'PO-5 · 120.5' })
}))
vi.mock('./command-center/geo.js', () => ({
  decorateRecords: async () =>
    new Map([
      [
        '5',
        {
          state: { key: 'review', label: 'In review', color: '#f59e0b' },
          sla: 'ok',
          owners: [{ id: 'u1', name: 'Beth Smith' }]
        }
      ]
    ])
}))
vi.mock('./command-center/regions.js', () => ({
  readableName: (c: string, n?: string | null) => n || c
}))

import { pickCardAmounts, recordCard, templateFieldNames } from './record-card.js'

const user = { id: 'viewer' } as never

describe('recordCard — read as the viewer', () => {
  beforeEach(() => {
    readOneResult = null
    readOneError = null
    readOneCalls.length = 0
  })

  it('no card for a record the viewer cannot read (readOne answers null)', async () => {
    readOneResult = null
    expect(await recordCard(user, 'orders', '5')).toBeNull()
    expect(readOneCalls[0]?.[0]).toBe(user)
  })

  it('no card when the read is refused (403/404)', async () => {
    readOneError = { statusCode: 403 }
    expect(await recordCard(user, 'orders', '5')).toBeNull()
    readOneError = { statusCode: 404 }
    expect(await recordCard(user, 'orders', '5')).toBeNull()
  })

  it('never reads system tables', async () => {
    readOneResult = { id: 1 }
    expect(await recordCard(user, 'nivaro_users', '1')).toBeNull()
    expect(await recordCard(user, 'directus_files', '1')).toBeNull()
    expect(readOneCalls).toHaveLength(0)
  })

  it('a readable record: name, step, owners, and only the amounts the viewer’s read returned', async () => {
    // secret_cost is not in the row: the viewer's field list left it out.
    readOneResult = { id: 5, number: 'PO-5', total: '120.5', tax_amount: 10, line_count: 3 }
    const card = await recordCard(user, 'orders', '5')
    expect(card).toMatchObject({
      title: 'PO-5 · 120.5',
      collection_label: 'Order',
      state: { label: 'In review' },
      owners: [{ name: 'Beth Smith' }]
    })
    expect(card?.amounts.map((a) => a.field)).toEqual(['total', 'tax_amount'])
    expect(card?.amounts[0]).toMatchObject({ label: 'Order total', value: 120.5, money: true })
  })
})

describe('pickCardAmounts / templateFieldNames', () => {
  it('reads the template’s top-level field names', () => {
    expect(templateFieldNames('{{number}} - {{project.name}} {{ number }}')).toEqual([
      'number',
      'project'
    ])
  })
  it('template amounts first, at most three, skipping counts and ids', () => {
    const out = pickCardAmounts(
      { a_total: 1, b_cost: 2, c_price: 3, qty: 4, line_count: 9, vendor_id: 7 },
      [
        { field: 'a_total', type: 'decimal' },
        { field: 'b_cost', type: 'decimal' },
        { field: 'c_price', type: 'decimal' },
        { field: 'qty', type: 'integer' },
        { field: 'line_count', type: 'integer' },
        { field: 'vendor_id', type: 'integer' }
      ],
      '{{qty}}'
    )
    expect(out.map((a) => a.field)).toEqual(['qty', 'a_total', 'b_cost'])
  })
})
