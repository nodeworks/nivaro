import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: Object.assign(() => ({}), { raw: () => '' }) }))

import {
  compileRelatedFilter,
  evalConditionRule,
  relatedCountKey
} from '../../../services/workflow-conditions.js'

describe('compileRelatedFilter', () => {
  it('ignores empty / malformed input (legacy behaviour: no filter)', () => {
    expect(compileRelatedFilter(null).clauses).toEqual([])
    expect(compileRelatedFilter('').clauses).toEqual([])
    expect(compileRelatedFilter('{not json').clauses).toEqual([])
    expect(compileRelatedFilter('[1,2]').clauses).toEqual([])
  })

  it('compiles plain columns with literal and operator specs', () => {
    const c = compileRelatedFilter('{"quantity":{"_gt":0},"status":"open"}')
    expect(c.failClosed).toBe(false)
    expect(c.clauses).toEqual([
      { hop: null, col: 'quantity', op: '_gt', value: 0 },
      { hop: null, col: 'status', op: '_eq', value: 'open' }
    ])
  })

  it('splits ONE dotted hop and drops deeper or non-identifier keys', () => {
    const c = compileRelatedFilter(
      '{"purchase_order.amount":{"_round_eq":100},"a.b.c":{"_eq":1},"bad-col":{"_eq":1}}'
    )
    expect(c.clauses).toEqual([
      { hop: 'purchase_order', col: 'amount', op: '_round_eq', value: 100 }
    ])
  })

  it('resolves $record tokens against the parent record', () => {
    const c = compileRelatedFilter(
      '{"purchase_order.project":{"_eq":"$record.project"},"purchase_order.amount":{"_round_eq":"$record.requisition_amount"}}',
      { project: 7581, requisition_amount: 1234.56 }
    )
    expect(c.failClosed).toBe(false)
    expect(c.clauses).toEqual([
      { hop: 'purchase_order', col: 'project', op: '_eq', value: 7581 },
      { hop: 'purchase_order', col: 'amount', op: '_round_eq', value: 1234.56 }
    ])
  })

  it('fails CLOSED when a $record token resolves to null: never widens to any row', () => {
    const c = compileRelatedFilter('{"amount":{"_eq":"$record.requisition_amount"}}', {
      requisition_amount: null
    })
    expect(c.failClosed).toBe(true)
    expect(compileRelatedFilter('{"amount":{"_eq":"$record.missing"}}', {}).failClosed).toBe(true)
  })

  it('resolves tokens inside _in arrays and skips unknown ops', () => {
    const c = compileRelatedFilter('{"state":{"_in":["$record.a","x"],"_bogus":1}}', { a: 'y' })
    expect(c.clauses).toEqual([{ hop: null, col: 'state', op: '_in', value: ['y', 'x'] }])
  })
})

describe('evalConditionRule related ops read the pre-resolved count', () => {
  const field = 'workflow_purchase_orders_junction:workflow'
  const value = '{"purchase_order.amount":{"_round_eq":"$record.requisition_amount"}}'
  const key = relatedCountKey(field, value)
  it('related_some passes on count > 0, related_none on count === 0', () => {
    expect(evalConditionRule({ field, op: 'related_some', value }, { [key]: 1 })).toBe(true)
    expect(evalConditionRule({ field, op: 'related_some', value }, { [key]: 0 })).toBe(false)
    expect(evalConditionRule({ field, op: 'related_none', value }, { [key]: 0 })).toBe(true)
    expect(evalConditionRule({ field, op: 'related_none', value }, {})).toBe(true)
  })
})
