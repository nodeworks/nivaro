import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { refusalDetail } from '../../../lib/db-refusal.js'

// SQLite's refusals name columns (UNIQUE), nothing (FOREIGN KEY) or a CHECK expression.
vi.mock('../../../db/dialect/items-query.js', () => ({ dialectOf: () => 'sqlite' }))
vi.mock('../../../services/collections.js', () => ({
  getFields: vi.fn(async (collection: string) =>
    collection === 'orders'
      ? [
          { field: 'po', db_column: null, label: 'PO number' },
          { field: 'line', db_column: null, label: 'Line' },
          { field: 'vendor_id', db_column: null, label: 'Vendor' }
        ]
      : []
  ),
  getCollection: vi.fn(async (c: string) => (c === 'shipments' ? { plural: 'Shipments' } : null))
}))

const { _resetRefusalLabelCache, labelDbRefusal } = await import(
  '../../../services/db-refusal-labels.js'
)
const raw = (db as unknown as { raw: ReturnType<typeof vi.fn<(...args: any[]) => any>> }).raw

beforeEach(() => {
  _resetRefusalLabelCache()
  raw.mockReset()
  raw.mockResolvedValue([])
})

describe('SQLite refusals in field labels', () => {
  it('a duplicate names its columns without a catalogue read', async () => {
    const one = refusalDetail(
      new Error("insert into `orders` (`po`) values ('4471') - UNIQUE constraint failed: orders.po")
    )!
    expect(await labelDbRefusal(one, { collection: 'orders', values: { po: '4471' } })).toEqual({
      message: 'Another record already has this PO number (4471)',
      hint: 'Use a different PO number, or open the existing record instead.',
      fields: ['po']
    })
    const two = refusalDetail(new Error('UNIQUE constraint failed: orders.po, orders.line'))!
    expect((await labelDbRefusal(two, { collection: 'orders' }))?.fields).toEqual(['po', 'line'])
    expect(raw).not.toHaveBeenCalled()
  })

  it('a missing link is the foreign key whose written value has no parent row', async () => {
    const detail = refusalDetail(
      new Error('insert into `orders` (`vendor_id`) values (9) - FOREIGN KEY constraint failed')
    )!
    raw.mockResolvedValueOnce([
      { col: 'vendor_id', parent: 'vendors', ref: 'id' },
      { col: 'line', parent: 'lines', ref: 'id' }
    ])
    raw.mockResolvedValueOnce([]) // vendors 9: none
    const out = await labelDbRefusal(detail, {
      collection: 'orders',
      values: { vendor_id: 9, po: 'x' }
    })
    expect(out).toEqual({
      message: 'The Vendor you picked no longer exists',
      hint: 'Pick Vendor again from the list, then save.',
      fields: ['vendor_id']
    })
    expect(raw.mock.calls[1]).toEqual(['SELECT 1 AS x FROM "vendors" WHERE "id" = ? LIMIT 1', [9]])
  })

  it('a refused delete names the table that still links to the record', async () => {
    const detail = refusalDetail(
      new Error('delete from `orders` where `id` = 5 - FOREIGN KEY constraint failed')
    )!
    raw.mockResolvedValueOnce([
      { tbl: 'invoices', col: 'order_id', ref: 'id' },
      { tbl: 'shipments', col: 'order_id', ref: null }
    ])
    raw.mockResolvedValueOnce([]) // no invoice
    raw.mockResolvedValueOnce([{ x: 1 }]) // a shipment
    const out = await labelDbRefusal(detail, { collection: 'orders', id: '5' })
    expect(out?.message).toBe('Shipments still link to this record')
  })

  it('a too-long value names its column', async () => {
    const detail = refusalDetail(
      new Error(
        'update `orders` set `po` = ? where `id` = ? - CHECK constraint failed: length("po") <= 10'
      )
    )!
    expect(detail).toEqual({ kind: 'too_long', column: 'po', table: 'orders' })
    expect((await labelDbRefusal(detail, { collection: 'orders' }))?.message).toBe(
      'PO number is too long'
    )
  })
})
