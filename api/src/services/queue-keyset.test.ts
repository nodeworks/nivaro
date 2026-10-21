// #2447 — materialized queue worklists page forward by cursor.
import knex from 'knex'
import { describe, expect, it } from 'vitest'
import { applyQueueKeyset, queueKeysetPlan, queueNextCursor } from './queue-keyset.js'

const k = knex({ client: 'mssql' })
const Q = 'queue-1'

describe('queue keyset', () => {
  it('walks only the plain-column sorts the SQL path orders by', () => {
    for (const s of ['', 'label', '-label', 'state', 'collection', '-at_risk']) {
      expect(queueKeysetPlan(Q, s, 'start')).not.toBeNull()
    }
    for (const s of ['aging_hours', 'sla_status', 'owners', 'priority', 'extra.amount']) {
      expect(queueKeysetPlan(Q, s, 'start')).toBeNull()
    }
    expect(queueKeysetPlan(Q, 'label', undefined)).toBeNull()
  })

  it('a next cursor reaches the rows after the last one, ties broken by id', () => {
    const plan = queueKeysetPlan(Q, '-label', 'start')!
    expect(plan.values).toBeNull()
    const cursor = queueNextCursor(
      Q,
      plan,
      [
        { id: 7, label: 'B' },
        { id: 9, label: 'A' }
      ],
      2
    )!
    expect(cursor).toBeTruthy()
    const next = queueKeysetPlan(Q, '-label', cursor)!
    expect(next.values).toEqual(['A', 9])
    const q = k('nivaro_queue_items as qi').select('qi.id')
    applyQueueKeyset(q, next, true)
    const sql = q.toSQL()
    expect(sql.sql).toContain('[qi].[label] < ?')
    expect(sql.sql).toContain('[qi].[label] = ?')
    expect(sql.sql).toContain('[qi].[id] > ?')
    expect(sql.bindings).toEqual(['A', 'A', 9])
  })

  it('no cursor after a short page; another queue/sort cursor falls back to the page number', () => {
    const plan = queueKeysetPlan(Q, '', 'start')!
    expect(queueNextCursor(Q, plan, [{ id: 1 }], 25)).toBeNull()
    const cursor = queueNextCursor(Q, plan, [{ id: 1 }], 1)!
    expect(queueKeysetPlan('queue-2', '', cursor)).toBeNull()
    expect(queueKeysetPlan(Q, 'label', cursor)).toBeNull()
    expect(queueKeysetPlan(Q, '', `${cursor}x`)).toBeNull()
  })

  it('carries a bit sort as 0/1', () => {
    const plan = queueKeysetPlan(Q, 'at_risk', 'start')!
    const cursor = queueNextCursor(Q, plan, [{ id: 3, at_risk: true }], 1)!
    expect(queueKeysetPlan(Q, 'at_risk', cursor)!.values).toEqual([1, 3])
  })
})
