import { describe, expect, it, vi } from 'vitest'

// Army 5 b03-N10: forecast_left (read formula requisition_amount - forecast_total,
// a decimal currency field) read 101.50999999999999 in the API and in mail.

const fieldRows = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))
vi.mock('../../../db/index.js', () => {
  const chain = (table: string): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then')
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(table === 'nivaro_fields' ? fieldRows.rows : []).then(res, rej)
        return () => chain(table)
      },
      apply: () => chain(table)
    })
  const db = new Proxy((table: string) => chain(table), {
    get(_t, prop) {
      if (prop === 'raw') return (sql: string) => ({ sql, toString: () => sql })
      return () => chain('')
    }
  })
  return { db, dbRead: db, isMssql: () => true }
})

import { applyReadComputedFields, readComputedScale } from '../../../services/items.js'

const formula = 'item.requisition_amount - item.forecast_total'

describe('read-computed numbers round to the field scale', () => {
  it('forecast_left (decimal, currency) reads 101.51, not 101.50999999999999', async () => {
    fieldRows.rows = [
      {
        field: 'forecast_left',
        computed_type: 'read',
        computed_formula: formula,
        computed_store: false,
        type: 'decimal',
        options: '{"format":"currency","currency":"USD"}'
      }
    ]
    const items = [
      { id: 1, requisition_amount: 151.51, forecast_total: 50 },
      { id: 2, requisition_amount: 101.51, forecast_total: 50 }
    ]
    expect(151.51 - 50).not.toBe(101.51)
    await applyReadComputedFields('workflows', items)
    expect(items[0]).toHaveProperty('forecast_left', 101.51)
    expect(items[1]).toHaveProperty('forecast_left', 51.51)
  })

  it('a text result and a missing input are untouched', async () => {
    fieldRows.rows = [
      {
        field: 'label',
        computed_type: 'read',
        computed_formula: 'concat(item.a, "-", item.b)',
        computed_store: false,
        type: 'string',
        options: null
      },
      {
        field: 'left',
        computed_type: 'read',
        computed_formula: formula,
        computed_store: false,
        type: 'decimal',
        options: null
      }
    ]
    const items: Array<Record<string, unknown>> = [{ id: 1, a: 'x', b: 'y' }]
    await applyReadComputedFields('workflows', items)
    expect(items[0].label).toBe('x-y')
    expect(items[0].left).toBeNull()
  })
})

describe('readComputedScale', () => {
  it.each([
    [{ type: 'decimal', options: null }, 2],
    [{ type: 'decimal', options: '{"precision":4}' }, 4],
    [{ type: 'numeric', options: { digits: 0 } }, 0],
    [{ type: 'float', options: '{"format":"currency"}' }, 2],
    [{ type: 'float', options: '{"precision":3}' }, 3],
    [{ type: 'float', options: null }, null],
    [{ type: 'integer', options: null }, null],
    [{ type: 'string', options: null }, null],
    [{ type: undefined, options: undefined }, null]
  ])('%j → %s', (f, want) => {
    expect(readComputedScale(f as never)).toBe(want)
  })
})
