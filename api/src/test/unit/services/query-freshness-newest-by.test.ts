// R7 review: a declared freshness source may probe the newest row by an
// indexed key (a seek) instead of MAX(column) (a scan on a column with no index).
import { describe, expect, it, vi } from 'vitest'

const calls: Array<{ table: string; op: string; args: unknown[] }> = []
vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    const c: Record<string, (...a: unknown[]) => unknown> = {
      max: (...a) => (calls.push({ table, op: 'max', args: a }), c),
      select: (...a) => (calls.push({ table, op: 'select', args: a }), c),
      orderBy: (...a) => (calls.push({ table, op: 'orderBy', args: a }), c),
      first: async () => ({ v: new Date('2026-11-07T12:00:00Z') })
    }
    return c
  }
}))

import { parseFreshnessSources, queryFreshness } from '../../../services/query-freshness.js'

describe('freshness sources: newest_by', () => {
  it('keeps a valid newest_by, drops an unsafe one', () => {
    expect(
      parseFreshnessSources(
        JSON.stringify([
          { table: 'invoices', column: 'changed', newest_by: 'id' },
          { table: 'projects', column: 'changed' },
          { table: 'x', column: 'changed', newest_by: 'id; DROP TABLE x' }
        ])
      )
    ).toEqual([
      { table: 'invoices', column: 'changed', newest_by: 'id' },
      { table: 'projects', column: 'changed' },
      { table: 'x', column: 'changed' }
    ])
  })

  it('probes the newest row by the key instead of MAX(column)', async () => {
    calls.length = 0
    const f = await queryFreshness({
      id: 'q1',
      freshness_sources: JSON.stringify([
        { table: 'inventory_item_transactions', column: 'changed', newest_by: 'id' },
        { table: 'projects', column: 'changed' }
      ])
    })
    expect(f.data_changed_at).toBe('2026-11-07T12:00:00.000Z')
    const iit = calls.filter((c) => c.table === 'inventory_item_transactions')
    expect(iit.map((c) => c.op)).toEqual(['select', 'orderBy'])
    expect(iit[0].args).toEqual(['changed as v'])
    expect(iit[1].args).toEqual(['id', 'desc'])
    expect(calls.filter((c) => c.table === 'projects').map((c) => c.op)).toEqual(['max'])
  })
})
