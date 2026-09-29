import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({
  db: Object.assign(
    vi.fn(() => ({})),
    { raw: () => '' }
  )
}))

import { db } from '../../../db/index.js'
import {
  compileRelatedFilter,
  evalConditionRule,
  fetchRecordForConditions,
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

describe('fetchRecordForConditions — strict mode', () => {
  /** Point the mocked db at a knex-shaped fake whose reads of the listed tables reject. */
  function useDb(rows: Record<string, unknown[]>, fail: string[]) {
    vi.mocked(db).mockImplementation(((table: string) => {
      const chain: Record<string, unknown> = {}
      const settle = () =>
        fail.includes(table)
          ? Promise.reject(new Error(`read failed: ${table}`))
          : Promise.resolve(rows[table] ?? [])
      for (const m of ['where', 'whereIn', 'whereNull', 'whereNotNull', 'count', 'join']) {
        chain[m] = () => chain
      }
      chain.select = () => settle()
      chain.first = () => settle().then((r) => (r as unknown[])[0])
      return chain
    }) as never)
  }

  it('rethrows a failed record read under strict, and answers {} without it', async () => {
    useDb({}, ['workflows'])
    await expect(fetchRecordForConditions('workflows', '1', [], { strict: true })).rejects.toThrow(
      'read failed: workflows'
    )
    await expect(fetchRecordForConditions('workflows', '1')).resolves.toEqual({})
  })

  it('rethrows a failed related-count read under strict, and answers 0 without it', async () => {
    useDb({ workflows: [{ id: '1' }] }, ['workflow_line_items'])
    const rules = JSON.stringify([
      { field: 'workflow_line_items:workflow', op: 'related_some', value: null }
    ])
    await expect(
      fetchRecordForConditions('workflows', '1', [rules], { strict: true })
    ).rejects.toThrow('read failed: workflow_line_items')
    const lax = await fetchRecordForConditions('workflows', '1', [rules])
    expect(Object.values(lax)).toContain(0)
  })

  it('rethrows a failed children-in-state read under strict', async () => {
    useDb({ workflows: [{ id: '1' }] }, ['workflow_line_items'])
    const rules = JSON.stringify([
      { field: 'workflow_line_items:workflow', op: 'children_in_state', value: 'done' }
    ])
    await expect(
      fetchRecordForConditions('workflows', '1', [rules], { strict: true })
    ).rejects.toThrow('read failed: workflow_line_items')
    const lax = await fetchRecordForConditions('workflows', '1', [rules])
    expect(Object.values(lax)).toContainEqual({ total: 0, matched: 0 })
  })

  it('rethrows a failed dotted-path read under strict, and answers null without it', async () => {
    useDb({ workflows: [{ id: '1', project: 7 }] }, ['nivaro_relations'])
    const rules = JSON.stringify([{ field: 'project.name', op: 'eq', value: 'x' }])
    await expect(
      fetchRecordForConditions('workflows', '1', [rules], { strict: true })
    ).rejects.toThrow('read failed: nivaro_relations')
    const lax = await fetchRecordForConditions('workflows', '1', [rules])
    expect(lax['project.name']).toBeNull()
  })
})
