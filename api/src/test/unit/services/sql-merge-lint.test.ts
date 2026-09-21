import { describe, expect, it } from 'vitest'
import { findMergeKeys, gradeFindings, maskSql } from '../../../services/sql-merge-lint.js'

describe('findMergeKeys', () => {
  it('reports each plain equality in the ON clause', () => {
    const found = findMergeKeys(`
      MERGE line_items AS target
      USING (SELECT a.id, b.project FROM staging a JOIN projects b ON b.code = a.code) AS source
        ON source.purchase_order = target.purchase_order
       AND source.project = target.project
      WHEN MATCHED THEN UPDATE SET amount = source.amount
      WHEN NOT MATCHED THEN INSERT (amount) VALUES (source.amount);`)
    expect(found.map((f) => f.targetColumn)).toEqual(['purchase_order', 'project'])
    expect(found[0]).toMatchObject({ target: 'line_items', targetAlias: 'target', sourceAlias: 'source', line: 2 })
  })

  it('is not fooled by the ON of a join inside the USING subquery', () => {
    const found = findMergeKeys(`
      MERGE t USING (SELECT x.k FROM x JOIN y ON y.k = x.k) s ON s.k = t.k
      WHEN NOT MATCHED THEN INSERT (k) VALUES (s.k);`)
    expect(found).toHaveLength(1)
    expect(found[0].clause).toBe('s.k = t.k')
  })

  it('accepts a NULL-safe guard, in either spelling', () => {
    const found = findMergeKeys(`
      MERGE t USING s ON s.a = t.a
        AND (s.b = t.b OR (s.b IS NULL AND t.b IS NULL))
        AND ISNULL(s.c, -1) = ISNULL(t.c, -1)
        AND COALESCE(s.d, '') = COALESCE(t.d, '')
      WHEN NOT MATCHED THEN INSERT (a) VALUES (s.a);`)
    expect(found.map((f) => f.targetColumn)).toEqual(['a'])
    // …but the FULL key still names the guarded columns, so a duplicate check
    // groups by what the MERGE really matches on.
    expect(found[0].keyColumns).toEqual(['a', 'b', 'c', 'd'])
  })

  it('handles target on the left, brackets, schema prefixes and INTO', () => {
    const found = findMergeKeys(`
      MERGE INTO [dbo].[project_other_spends] AS [tgt]
      USING #rows AS src ON [tgt].[year] = src.[year]
      WHEN NOT MATCHED THEN INSERT ([year]) VALUES (src.[year]);`)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ target: 'project_other_spends', targetColumn: 'year', sourceExpr: 'src.[year]' })
  })

  it('uses the table name when the target has no alias', () => {
    const found = findMergeKeys(`
      MERGE vendors USING staging_vendors s ON s.number = vendors.number
      WHEN NOT MATCHED THEN INSERT (number) VALUES (s.number);`)
    expect(found[0]).toMatchObject({ target: 'vendors', targetAlias: 'vendors', targetColumn: 'number' })
  })

  it('ignores a MERGE written inside a comment or a string', () => {
    const found = findMergeKeys(`
      -- MERGE t USING s ON s.a = t.a WHEN MATCHED THEN DELETE;
      /* MERGE t USING s ON s.a = t.a WHEN MATCHED THEN DELETE; */
      PRINT 'MERGE t USING s ON s.a = t.a WHEN MATCHED THEN DELETE;';`)
    expect(found).toEqual([])
  })

  it('finds every MERGE in a body, with its own line', () => {
    const found = findMergeKeys(
      'MERGE a USING s ON s.k = a.k WHEN MATCHED THEN DELETE;\n\nMERGE b USING s ON s.k = b.k WHEN MATCHED THEN DELETE;'
    )
    expect(found.map((f) => [f.target, f.line])).toEqual([
      ['a', 1],
      ['b', 3]
    ])
  })

  it('skips inequalities and comparisons against a constant', () => {
    const found = findMergeKeys(`
      MERGE t USING s ON s.k = t.k AND t.kind <> s.kind AND t.active = 1 AND s.n >= t.n
      WHEN MATCHED THEN DELETE;`)
    expect(found.map((f) => f.targetColumn)).toEqual(['k'])
  })
})

describe('maskSql', () => {
  it('keeps length and newlines so line numbers survive', () => {
    const sql = "a -- x\nb /* y\nz */ c 'it''s'"
    const masked = maskSql(sql)
    expect(masked).toHaveLength(sql.length)
    expect(masked.split('\n')).toHaveLength(3)
    expect(masked).not.toMatch(/[xyz]/)
  })
})

describe('gradeFindings', () => {
  const findings = findMergeKeys(`
    MERGE t USING s ON s.a = t.a AND s.b = t.b AND s.c = t.c
    WHEN NOT MATCHED THEN INSERT (a) VALUES (s.a);`)

  it('separates unsafe, safe and could-not-check', () => {
    const graded = gradeFindings(findings, (_t, col) =>
      col === 'a' ? true : col === 'b' ? false : undefined
    )
    expect(graded.map((g) => [g.targetColumn, g.severity])).toEqual([
      ['a', 'unsafe'],
      ['b', 'safe'],
      ['c', 'unknown']
    ])
  })
})
