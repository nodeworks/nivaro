import { describe, expect, it } from 'vitest'
import { feedPageIdsSql } from '../../../services/activity-feed-ids.js'

describe('activity feed page ids on SQL Server (one seek per collection)', () => {
  it('one branch per collection in name order, lists always OPENJSON, no row goal', () => {
    const q = feedPageIdsSql(
      new Map([
        ['workflows', ['1', '2']],
        ['invoices', ['9']],
        ['empty', []]
      ]),
      { limit: 30, before: null }
    )!
    expect(q.sql.match(/UNION ALL/g)).toHaveLength(1)
    expect(q.sql).toContain("OPTION (USE HINT('DISABLE_OPTIMIZER_ROWGOAL'))")
    expect(q.sql).not.toMatch(/\bOR\b/)
    expect(q.bindings).toEqual([
      30,
      30,
      'read',
      'view-as-move',
      'invoices',
      '["9"]',
      30,
      'read',
      'view-as-move',
      'workflows',
      '["1","2"]'
    ])
    expect((q.sql.match(/\?/g) ?? []).length).toBe(q.bindings.length)
  })

  it('the cursor narrows every branch', () => {
    const q = feedPageIdsSql(
      new Map([
        ['a', ['1']],
        ['b', ['2']]
      ]),
      { limit: 10, before: 500 }
    )!
    expect(q.sql.match(/\[a\]\.\[id\] < \?/g)).toHaveLength(2)
    expect(q.bindings.filter((b) => b === 500)).toHaveLength(2)
    expect((q.sql.match(/\?/g) ?? []).length).toBe(q.bindings.length)
  })

  it('the statement text depends only on how many collections it covers', () => {
    const a = feedPageIdsSql(
      new Map([
        ['x', ['1']],
        ['y', ['2', '3']]
      ]),
      { limit: 30 }
    )!
    const b = feedPageIdsSql(
      new Map([
        ['p', Array.from({ length: 200 }, (_, i) => String(i))],
        ['q', ['1']]
      ]),
      { limit: 30 }
    )!
    expect(a.sql).toBe(b.sql)
  })

  it('nothing to read is no statement', () => {
    expect(feedPageIdsSql(new Map([['a', []]]), { limit: 30 })).toBeNull()
  })
})
