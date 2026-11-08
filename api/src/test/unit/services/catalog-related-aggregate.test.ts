import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  countAllColumnIn,
  parentTokens,
  resolveCountAllMatch
} from '../../../services/catalog-related-aggregate.js'

// army 11 a2 F3 (Rob): IR "Open Orders" read 1,354 for the creator and 6 for
// the warehouse approver of the same request — the sum ran as the viewer.
const OPEN_ORDERS = {
  key: 'open_orders',
  label: 'Open Orders',
  collection: 'inventory_request_materials',
  item_field: 'cifa',
  value_field: 'quantity',
  aggregate: 'sum',
  count_all: true,
  match: {
    inventory_request: {
      _and: [
        { _or: [{ request_state: { _nin: [5, 6] } }, { request_state: { _null: true } }] },
        { supporting_warehouse: { _eq: '$parent.supporting_warehouse' } }
      ]
    }
  }
}

describe('countAllColumnIn', () => {
  it('finds an admin-marked column in catalog_mode', () => {
    const col = countAllColumnIn(
      JSON.stringify({ options: { catalog_mode: { related_columns: [OPEN_ORDERS] } } }),
      'open_orders'
    )
    expect(col).toMatchObject({
      collection: 'inventory_request_materials',
      item_field: 'cifa',
      value_field: 'quantity',
      aggregate: 'sum'
    })
  })

  it('never answers a column without count_all, or with odd identifiers', () => {
    const { count_all: _c, ...plain } = OPEN_ORDERS
    expect(
      countAllColumnIn({ options: { catalog_mode: { related_columns: [plain] } } }, 'open_orders')
    ).toBeNull()
    expect(
      countAllColumnIn(
        { options: { related_columns: [{ ...OPEN_ORDERS, value_field: 'quantity]; DROP' }] } },
        'open_orders'
      )
    ).toBeNull()
    expect(
      countAllColumnIn(
        { options: { related_columns: [{ ...OPEN_ORDERS, aggregate: undefined }] } },
        'open_orders'
      )
    ).toBeNull()
  })
})

describe('resolveCountAllMatch', () => {
  it('fills nested $parent tokens; no warehouse = no figure yet', () => {
    expect([...parentTokens(OPEN_ORDERS.match)]).toEqual(['supporting_warehouse'])
    const f = resolveCountAllMatch(OPEN_ORDERS.match, { supporting_warehouse: 6 })
    expect(JSON.stringify(f)).toContain('{"supporting_warehouse":{"_eq":6}}')
    expect(resolveCountAllMatch(OPEN_ORDERS.match, {})).toBeNull()
  })

  it('takes only scalar parent values (no filter objects smuggled in)', () => {
    expect(
      resolveCountAllMatch(OPEN_ORDERS.match, { supporting_warehouse: { _nnull: true } })
    ).toBeNull()
    expect(resolveCountAllMatch({ warehouse: '$parent.w' }, { w: 'PAE77' })).toEqual({
      warehouse: { _eq: 'PAE77' }
    })
  })
})
