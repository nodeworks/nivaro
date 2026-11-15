import { describe, expect, it } from 'vitest'
import { FTS_FRESH_ROWS, isIntegerType, textArm } from '../../../routes/global-search.js'

// rt4 #9 — the full-text index fills in the background, so a record saved a moment ago is not
// in it yet. A collection numbered by an integer id also LIKE-matches its newest rows (one short
// backward read of the id index) on the full-text columns until the index catches up.

const kinds = { workflow_id: 'ansi', name: 'unicode' } as const
const ft = { cols: ['name'], cond: { sql: 'CONTAINS([name], ?)', bindings: ['"fiber*"'] } }

describe('textArm — fresh rows beside the full-text index', () => {
  it('adds the newest-rows LIKE arm, bound in order, when the id allows it', () => {
    const arm = textArm(
      { collection: 'workflows', kinds, freshById: true },
      ['name', 'workflow_id'],
      'fiber',
      ['%fiber%'],
      ft,
      8,
      false
    )
    expect(arm.sql).toContain('CONTAINS([name], ?)')
    expect(arm.sql).toContain(
      `([id] IN (SELECT TOP ${FTS_FRESH_ROWS} [id] FROM [workflows] ORDER BY [id] DESC) AND ([name] LIKE ? ESCAPE '\\'))`
    )
    // CONTAINS, the fresh LIKE, then the id column's LIKE, then the rank bindings.
    expect(arm.bindings.slice(0, 3)).toEqual(['"fiber*"', '%fiber%', '%fiber%'])
    const placeholders = (arm.sql.match(/\?/g) ?? []).length
    expect(placeholders).toBe(arm.bindings.length)
    expect(arm.sql).not.toContain('fiber')
  })

  it('leaves the statement as before without an integer id or without full-text', () => {
    const plain = textArm(
      { collection: 'workflows', kinds },
      ['name'],
      'fiber',
      ['%fiber%'],
      ft,
      8,
      false
    )
    expect(plain.sql).not.toContain('ORDER BY [id] DESC)')
    const noFts = textArm(
      { collection: 'workflows', kinds, freshById: true },
      ['name'],
      'fiber',
      ['%fiber%'],
      null,
      8,
      false
    )
    expect(noFts.sql).not.toContain('ORDER BY [id] DESC)')
  })
})

describe('isIntegerType', () => {
  it('knows the integer column types', () => {
    for (const t of ['int', 'bigint', 'smallint', 'tinyint', 'INT'])
      expect(isIntegerType(t)).toBe(true)
    for (const t of ['uniqueidentifier', 'nvarchar', 'decimal', '', null, undefined])
      expect(isIntegerType(t)).toBe(false)
  })
})
