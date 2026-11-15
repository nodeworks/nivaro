import { describe, expect, it } from 'vitest'
import {
  ANNOUNCE_ID_CAP,
  announceBlock,
  outputClause,
  proposeAnnounce
} from '../../../services/sql-checks/announce-fix.js'
import {
  announcedCollections,
  checkObject,
  findWrites,
  type SqlObject,
  withoutAnnounceBlocks
} from '../../../services/sql-checks/checkers.js'
import { applyEdits, proposeFix, recheckVerdict } from '../../../services/sql-checks/propose.js'
import { buildCatalog } from '../../../services/sql-checks/run.js'
import { depthMap, maskSql } from '../../../services/sql-checks/tokenizer.js'

const col = (tbl: string, c: string, type = 'int') => ({
  sch: 'dbo',
  tbl,
  col: c,
  nullable: 'NO',
  type,
  len: null
})

const catalog = buildCatalog(
  [
    col('workflows', 'id'),
    col('workflows', 'status', 'nvarchar'),
    col('workflows', 'date_updated', 'datetime2'),
    col('forecasts', 'id'),
    col('forecasts', 'amount', 'decimal'),
    col('budget_lines', 'workflow'),
    col('budget_lines', 'year'),
    col('budget_lines', 'amount', 'decimal'),
    col('staging_rows', 'id'),
    col('nivaro_raw_writes', 'id')
  ],
  [
    { sch: 'dbo', tbl: 'workflows', idx: 1, col: 'id', pk: 1, ord: 1 },
    { sch: 'dbo', tbl: 'forecasts', idx: 1, col: 'id', pk: 1, ord: 1 },
    { sch: 'dbo', tbl: 'budget_lines', idx: 1, col: 'workflow', pk: 1, ord: 1 },
    { sch: 'dbo', tbl: 'budget_lines', idx: 1, col: 'year', pk: 1, ord: 2 }
  ],
  [],
  ['workflows', 'Forecasts', 'budget_lines', 'nivaro_raw_writes']
)

const proc = (definition: string, name = 'usp_reforecast'): SqlObject => ({
  schema: 'dbo',
  name,
  type: 'procedure',
  definition
})

const unannounced = (sql: string) =>
  checkObject(proc(sql), catalog).filter((f) => f.check_key === 'write-unannounced')

describe('write-unannounced: detection', () => {
  it('reports one finding per registered collection a procedure writes', () => {
    const sql = `CREATE PROCEDURE dbo.usp_reforecast AS
BEGIN
  SET NOCOUNT ON;
  UPDATE workflows SET status = 'x' WHERE id = 1;
  INSERT INTO forecasts (amount) VALUES (1);
  UPDATE #tmp SET a = 1;
  UPDATE staging_rows SET id = 2 WHERE id = 1;
END`
    const f = unannounced(sql)
    expect(f.map((x) => (x.detail as { collection: string }).collection)).toEqual([
      'workflows',
      'Forecasts'
    ])
    expect(f[0].line).toBe(4)
    expect(f[0].severity).toBe('warning')
    expect(f[1].message).toMatch(/^Adds Forecasts records/)
  })

  it('resolves an UPDATE / DELETE alias through the FROM list', () => {
    const sql = `CREATE PROC p AS
UPDATE w SET status = s.status FROM workflows w JOIN #src s ON s.id = w.id
DELETE x FROM forecasts x WHERE x.amount = 0`
    const writes = findWrites(maskSql(sql), depthMap(maskSql(sql)))
    expect(writes.map((w) => [w.verb, w.table.name, w.aliased])).toEqual([
      ['UPDATE', 'workflows', true],
      ['DELETE', 'forecasts', true]
    ])
    expect(unannounced(sql)).toHaveLength(2)
  })

  it('ignores MERGE actions, comments, literals, temp tables and system tables', () => {
    const sql = `CREATE PROC p AS
-- UPDATE workflows SET status = 1
PRINT 'DELETE FROM workflows'
MERGE #t AS t USING #s AS s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = 1;
INSERT INTO nivaro_raw_writes (collection) VALUES (N'x')`
    expect(unannounced(sql)).toEqual([])
  })

  it('counts an EXEC of nivaro_announce_writes or an INSERT into nivaro_raw_writes as announcing', () => {
    const base = `CREATE PROC p AS
UPDATE workflows SET status = 1 WHERE id = 3;
UPDATE forecasts SET amount = 1 WHERE id = 3;`
    expect(
      unannounced(`${base}\nEXEC dbo.nivaro_announce_writes @Collection = N'workflows', @Ids = '3'`)
    ).toHaveLength(1)
    expect(
      unannounced(
        `${base}\nINSERT INTO nivaro_raw_writes (collection, item) VALUES (N'forecasts', '3')`
      ).map((f) => (f.detail as { collection: string }).collection)
    ).toEqual(['workflows'])
    // a collection named by a variable: nothing to judge
    const dyn = `${base}\nEXEC nivaro_announce_writes @Collection = @c`
    expect(announcedCollections(dyn, maskSql(dyn)).all).toBe(true)
    expect(unannounced(dyn)).toEqual([])
  })

  it('needs the catalog to know collections, and only judges procedures', () => {
    const sql = 'CREATE PROC p AS UPDATE workflows SET status = 1 WHERE id = 1'
    const bare = buildCatalog([col('workflows', 'id')], [], [])
    expect(checkObject(proc(sql), bare).some((f) => f.check_key === 'write-unannounced')).toBe(
      false
    )
    const view: SqlObject = { schema: 'dbo', name: 'v', type: 'view', definition: sql }
    expect(checkObject(view, catalog).some((f) => f.check_key === 'write-unannounced')).toBe(false)
  })
})

const plan = (sql: string) => proposeAnnounce(sql, catalog, { source: 'procedure:dbo.p' })
const fixed = (sql: string) => {
  const p = plan(sql)
  expect(p.ok).toBe(true)
  return applyEdits(sql, p.edits)
}

describe('write-unannounced: the proposed fix', () => {
  it('captures ids with OUTPUT INTO a table variable and announces them at the end', () => {
    const sql = `CREATE PROCEDURE dbo.p AS
BEGIN
    SET NOCOUNT ON;
    UPDATE workflows SET status = 'x'
    WHERE id = 1;
    INSERT INTO forecasts (amount) VALUES (1);
    DELETE FROM forecasts WHERE amount = 0;
END`
    const out = fixed(sql)
    expect(out).toContain(
      '    SET NOCOUNT ON;\n    DECLARE @nvr_announced TABLE (c TINYINT NOT NULL, a CHAR(1) NOT NULL, id NVARCHAR(255) NULL);'
    )
    expect(out).toContain(
      "UPDATE workflows SET status = 'x'\n    OUTPUT 1, 'U', CAST(inserted.[id] AS NVARCHAR(255)) INTO @nvr_announced (c, a, id)\n    WHERE id = 1;"
    )
    expect(out).toContain(
      "INSERT INTO forecasts (amount) OUTPUT 2, 'I', CAST(inserted.[id] AS NVARCHAR(255)) INTO @nvr_announced (c, a, id) VALUES (1);"
    )
    expect(out).toContain(
      "DELETE FROM forecasts OUTPUT 2, 'D', CAST(deleted.[id] AS NVARCHAR(255)) INTO @nvr_announced (c, a, id) WHERE amount = 0;"
    )
    // the block sits inside the body, before its END, and names each collection + action
    expect(out).toMatch(/-- nivaro:announce end\nEND$/)
    expect(out).toContain(
      "EXEC dbo.nivaro_announce_writes @Collection = N'workflows', @Ids = @nvr_ann_ids, @Action = N'update', @Source = N'procedure:dbo.p';"
    )
    expect(out).toContain("@Collection = N'Forecasts', @Ids = @nvr_ann_ids, @Action = N'create'")
    expect(out).toContain("@Collection = N'Forecasts', @Ids = @nvr_ann_ids, @Action = N'delete'")
    // after the fix the check is clean, and no other check reports more than before
    expect(unannounced(out)).toEqual([])
    const before = checkObject(proc(sql), catalog)
    const after = checkObject(proc(out), catalog)
    expect(recheckVerdict(before, after, 'write-unannounced')).toEqual({ ok: true })
  })

  it('announces "many records changed" past the id cap', () => {
    const block = announceBlock('  ', 'procedure:p', [
      { collection: 'workflows', c: 1, idActions: ['U'], wholeActions: [] }
    ])
    expect(block).toContain(`IF @nvr_ann_n <= ${ANNOUNCE_ID_CAP}`)
    // the ids list stays NULL past the cap → the announcer's collection-wide row
    expect(block).toContain('SELECT @nvr_ann_n = COUNT(DISTINCT id), @nvr_ann_ids = NULL')
  })

  it('MERGE: OUTPUT with $action before the closing semicolon (or OPTION)', () => {
    const sql = `CREATE PROC p AS
MERGE workflows AS t USING #src AS s ON t.id = s.id
WHEN MATCHED THEN UPDATE SET status = s.status
WHEN NOT MATCHED THEN INSERT (status) VALUES (s.status)
OPTION (RECOMPILE);`
    const out = fixed(sql)
    expect(out).toContain(`${outputClause('MERGE', 1, 'id')}\nOPTION (RECOMPILE);`)
    expect(out).toContain('LEFT($action, 1)')
    const p = plan(sql)
    expect(p.notes.join(' ')).toMatch(/MERGE now writes one row per record/)
    expect(unannounced(out)).toEqual([])
  })

  it('falls back to a collection-wide announcement where no OUTPUT can be added', () => {
    const sql = `CREATE PROC p AS
BEGIN
  INSERT INTO workflows (status) EXEC dbo.load_status;
  UPDATE budget_lines SET amount = 0 WHERE year = 2020;
  TRUNCATE TABLE forecasts;
END`
    const p = plan(sql)
    expect(p.ok).toBe(true)
    expect(p.plan.map((x) => [x.collection, x.ids, x.whole])).toEqual([
      ['workflows', false, true],
      ['budget_lines', false, true],
      ['Forecasts', false, true]
    ])
    const out = applyEdits(sql, p.edits)
    // no table variable when nothing collects ids
    expect(out).not.toContain('DECLARE @nvr_announced')
    expect(out).toContain(
      "EXEC dbo.nivaro_announce_writes @Collection = N'workflows', @Ids = NULL, @Action = N'create'"
    )
    expect(p.notes.join(' ')).toMatch(/INSERT … EXEC cannot carry an OUTPUT clause/)
    expect(p.notes.join(' ')).toMatch(/primary key of 2 columns/)
    expect(unannounced(out)).toEqual([])
  })

  it('keeps an existing OUTPUT clause and goes collection-wide for that statement', () => {
    const sql = `CREATE PROC p AS
UPDATE workflows SET status = 1 OUTPUT inserted.id INTO #log(id) WHERE id = 2`
    const p = plan(sql)
    expect(p.plan[0].statements[0]).toMatchObject({ mode: 'whole' })
    expect(applyEdits(sql, p.edits)).toContain('OUTPUT inserted.id INTO #log(id) WHERE id = 2')
  })

  it('puts the block before a trailing RETURN and notes early returns', () => {
    const sql = `CREATE PROC p AS
BEGIN
  IF @x = 1 RETURN 1;
  UPDATE workflows SET status = 1 WHERE id = 2;
  RETURN 0;
END`
    const out = fixed(sql)
    expect(out).toMatch(/-- nivaro:announce end\n {2}RETURN 0;\nEND$/)
    expect(plan(sql).notes.join(' ')).toMatch(/RETURN early/)
  })

  it('appends at the end of a body without BEGIN … END', () => {
    const sql = 'CREATE PROC p AS\nUPDATE workflows SET status = 1 WHERE id = 2'
    const out = fixed(sql)
    // the body's own indentation (none here)
    expect(out.startsWith('CREATE PROC p AS\nDECLARE @nvr_announced')).toBe(true)
    expect(out.trimEnd().endsWith('-- nivaro:announce end')).toBe(true)
  })

  it('refuses what it cannot do safely', () => {
    expect(plan('CREATE VIEW v AS SELECT 1 AS x').manual_reason).toMatch(/Only procedures/)
    expect(plan('CREATE PROC p AS SELECT 1').manual_reason).toMatch(/already announces/)
    const done = fixed('CREATE PROC p AS\nUPDATE workflows SET status = 1 WHERE id = 2')
    const again = `${done}\nUPDATE forecasts SET amount = 1 WHERE id = 1`
    expect(plan(again).manual_reason).toMatch(/already has an announce block/)
  })

  it('goes through proposeFix as the announce class', () => {
    const sql = 'CREATE PROC p AS\nUPDATE workflows SET status = 1 WHERE id = 2'
    const finding = {
      check_key: 'write-unannounced',
      object_type: 'procedure',
      line: 2,
      detail: {}
    }
    expect(proposeFix(sql, finding).proposable).toBe(false)
    const p = proposeFix(sql, finding, { catalog, source: 'procedure:dbo.p' })
    expect(p).toMatchObject({ proposable: true, class: 'announce', risky: false })
    expect(p.plan?.[0].collection).toBe('workflows')
  })
})

describe('the announce block never fails the procedure', () => {
  const block = announceBlock('', 'procedure:p', [
    { collection: "o'brien", c: 1, idActions: ['U'], wholeActions: ['D'] }
  ])

  it('is skipped when the transaction is doomed or the announcer is missing', () => {
    expect(block).toContain(
      "IF XACT_STATE() <> -1 AND OBJECT_ID(N'dbo.nivaro_announce_writes', N'P') IS NOT NULL"
    )
  })

  it('runs in TRY/CATCH with XACT_ABORT off and puts the setting back as found', () => {
    const lines = block.split('\n').map((l) => l.trim())
    const xa = lines.indexOf(
      'DECLARE @nvr_ann_xa BIT = CASE WHEN @@OPTIONS & 16384 = 16384 THEN 1 ELSE 0 END;'
    )
    const off = lines.indexOf('SET XACT_ABORT OFF;')
    const tryAt = lines.indexOf('BEGIN TRY')
    const endTry = lines.indexOf('END TRY')
    const catchAt = lines.indexOf('BEGIN CATCH')
    const endCatch = lines.indexOf('END CATCH')
    const restore = lines.indexOf('IF @nvr_ann_xa = 1 SET XACT_ABORT ON;')
    expect(xa).toBeGreaterThan(-1)
    expect(xa < off && off < tryAt && tryAt < endTry && endTry < catchAt).toBe(true)
    expect(catchAt < endCatch && endCatch < restore).toBe(true)
    // every EXEC sits inside the TRY
    lines.forEach((l, i) => {
      if (l.startsWith('EXEC')) expect(i > tryAt && i < endTry).toBe(true)
    })
  })

  it('quotes collection names and keeps ids short enough for the announcer', () => {
    expect(block).toContain("@Collection = N'o''brien'")
    expect(outputClause('UPDATE', 1, 'id')).toContain('AS NVARCHAR(255)')
  })

  it('does not count as the procedure setting XACT_ABORT ON (other checks skip it)', () => {
    const sql = `CREATE PROC p AS
BEGIN
  BEGIN TRAN
  UPDATE workflows SET status = 1 WHERE id = 2
  COMMIT
END`
    const out = fixed(sql)
    const keys = checkObject(proc(out), catalog).map((f) => f.check_key)
    expect(keys).toContain('tran-without-xact-abort')
    expect(maskSql(out)).toMatch(/SET\s+XACT_ABORT\s+ON/)
    expect(withoutAnnounceBlocks(out, maskSql(out))).not.toMatch(/SET\s+XACT_ABORT\s+ON/)
  })
})
