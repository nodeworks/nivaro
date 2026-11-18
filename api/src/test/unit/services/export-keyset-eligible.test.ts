import { beforeEach, describe, expect, it, vi } from 'vitest'

// keysetEligible reads the catalog: a base table's primary key (fix round 2). A view has no row
// in sys.tables, so the join answers nothing and the export pages by OFFSET.

const cat = vi.hoisted(() => ({ rows: [] as unknown[], calls: [] as unknown[][], mssql: true }))
vi.mock('../../../db/dialect.js', () => ({ isMssql: () => cat.mssql }))
vi.mock('../../../db/index.js', () => ({
  db: {
    raw: vi.fn(async (sql: string, binds: unknown[]) => {
      cat.calls.push([sql, binds])
      return cat.rows
    })
  }
}))

import { __resetKeysetEligibility, keysetEligible } from '../../../services/export-paging.js'

beforeEach(() => {
  __resetKeysetEligibility()
  cat.calls = []
  cat.mssql = true
})

describe('keysetEligible', () => {
  it('asks the catalog for the base table’s primary key, by OBJECT_ID', async () => {
    cat.rows = [{ col: 'id', type: 'int' }]
    expect(await keysetEligible('units')).toBe(true)
    const [sql, binds] = cat.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/sys\.tables/)
    expect(sql).toMatch(/is_primary_key = 1/)
    expect(binds).toEqual(['units'])
    // Cached: no second catalog read.
    expect(await keysetEligible('units')).toBe(true)
    expect(cat.calls).toHaveLength(1)
  })

  it('a view (no primary key row) or a text id is not eligible; another dialect never is', async () => {
    cat.rows = []
    expect(await keysetEligible('v_units')).toBe(false)
    cat.rows = [{ col: 'id', type: 'nvarchar' }]
    expect(await keysetEligible('codes')).toBe(false)
    cat.mssql = false
    cat.rows = [{ col: 'id', type: 'int' }]
    expect(await keysetEligible('pg_table')).toBe(false)
  })
})
