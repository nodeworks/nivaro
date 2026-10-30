import knexLib from 'knex'
import { describe, expect, it } from 'vitest'
import { SEARCH_PROBE_CAP, searchProbeOutcome, searchProbeQuery } from '../../../services/items.js'

// A searched list reads the matching ids once (the count query asked for ids):
// up to the cap the count IS that number and the page reads those rows by key.
describe('searched list — one scan for page and count', () => {
  const k = knexLib({ client: 'mssql' })

  it('asks the count query (every gate + the search) for ids, capped at cap + 1', () => {
    const countQ = k('workflows')
      .count('* as count')
      .where('vendor', 7)
      .whereRaw('[name] LIKE ?', ['%x%'])
    const sql = searchProbeQuery(countQ, 'workflows', 500).toSQL()
    expect(sql.sql).toContain('select top (?) [workflows].[id] as [id] from [workflows]')
    expect(sql.sql).toContain('[vendor] = ?')
    expect(sql.sql).toContain('[name] LIKE ?')
    expect(sql.sql).not.toContain('count(')
    expect(sql.bindings).toEqual([501, 7, '%x%'])
    // the count query itself is untouched
    expect(countQ.toSQL().sql).toContain('count(*)')
  })

  it('up to the cap: the count is the rows read, ids deduped; past it: no verdict', () => {
    expect(searchProbeOutcome([], 3)).toEqual({ ids: [], n: 0 })
    expect(searchProbeOutcome([{ id: 1 }, { id: 2 }, { id: 2 }], 3)).toEqual({ ids: [1, 2], n: 3 })
    expect(searchProbeOutcome([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], 3)).toBeNull()
    expect(SEARCH_PROBE_CAP).toBeGreaterThanOrEqual(500)
  })
})
