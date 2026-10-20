import { afterEach, describe, expect, it } from 'vitest'
import {
  aliasColumns,
  checkObject,
  fingerprintOf,
  nullSafeIn,
  parseMerges,
  type SqlObject
} from '../../../services/sql-checks/checkers.js'
import {
  applyFigures,
  buildCatalog,
  diffFindings,
  fingerprintAll,
  type StoredFinding
} from '../../../services/sql-checks/run.js'
import {
  nightlyEnabled,
  SQL_CHECK_DEFAULTS,
  sqlChecksEnvOverride,
  validateSqlCheckSettings
} from '../../../services/sql-checks/settings.js'
import {
  keepLintCode,
  lintSql,
  setLintFetchForTests
} from '../../../services/sql-checks/sqlfluff.js'
import {
  canonicalDefinition,
  depthMap,
  lineAt,
  maskSql,
  splitName
} from '../../../services/sql-checks/tokenizer.js'

const catalog = buildCatalog(
  [
    { sch: 'dbo', tbl: 'invoices', col: 'id', nullable: 'NO', type: 'int', len: null },
    { sch: 'dbo', tbl: 'invoices', col: 'invoice_id', nullable: 'YES', type: 'nvarchar', len: 255 },
    { sch: 'dbo', tbl: 'invoices', col: 'purchase_order', nullable: 'YES', type: 'int', len: null },
    { sch: 'dbo', tbl: 'invoices', col: 'notes', nullable: 'YES', type: 'nvarchar', len: -1 },
    {
      sch: 'dbo',
      tbl: 'staging_invoices',
      col: 'invoice_id',
      nullable: 'YES',
      type: 'nvarchar',
      len: 255
    },
    { sch: 'dbo', tbl: 'vendors', col: 'id', nullable: 'NO', type: 'int', len: null },
    { sch: 'dbo', tbl: 'vendors', col: 'code', nullable: 'NO', type: 'nvarchar', len: 50 },
    { sch: 'dbo', tbl: 'vendor_src', col: 'code', nullable: 'NO', type: 'nvarchar', len: 50 },
    { sch: 'dbo', tbl: 'blocked', col: 'vendor', nullable: 'YES', type: 'int', len: null }
  ],
  [{ sch: 'dbo', tbl: 'vendor_src', idx: 1, col: 'code' }],
  [{ sch: 'dbo', tbl: 'invoices', n: 1000 }]
)

const proc = (definition: string, name = 'import_invoices'): SqlObject => ({
  schema: 'dbo',
  name,
  type: 'procedure',
  definition
})
const keys = (sql: string) => checkObject(proc(sql), catalog).map((f) => f.check_key)

describe('tokenizer', () => {
  it('blanks comments and literal contents but keeps offsets and lines', () => {
    const sql = "SELECT 1 -- MERGE x\n/* UPDATE y /* nested */ */ SELECT 'DELETE FROM t' AS [a]]b]"
    const m = maskSql(sql)
    expect(m.length).toBe(sql.length)
    expect(m).not.toMatch(/MERGE|UPDATE|DELETE/)
    expect(m.split('\n').length).toBe(sql.split('\n').length)
    expect(m).toContain('[a]]b]')
    expect(lineAt(sql, sql.indexOf('SELECT', 5))).toBe(2)
  })
  it('handles escaped quotes in literals', () => {
    expect(maskSql("SELECT 'it''s; DELETE' , 2")).toBe(`SELECT '${' '.repeat(13)}' , 2`)
  })
  it('splits names', () => {
    expect(splitName('[dbo].[my]]t]')).toEqual({ schema: 'dbo', name: 'my]t' })
    expect(splitName('x')).toEqual({ schema: null, name: 'x' })
  })
  it('canonical definitions ignore the CREATE / ALTER verb, comments and whitespace', () => {
    expect(canonicalDefinition('CREATE   PROCEDURE p AS -- hi\n SELECT 1')).toBe(
      canonicalDefinition('create or alter proc p as\nselect 1')
    )
    expect(canonicalDefinition("CREATE PROC p AS SELECT 'a'")).not.toBe(
      canonicalDefinition("CREATE PROC p AS SELECT 'b'")
    )
  })
})

describe('MERGE parsing and the NULL key check', () => {
  const unsafe = `CREATE PROCEDURE import_invoices AS
MERGE INTO dbo.invoices AS target
USING (SELECT invoice_id, po FROM staging_invoices) AS source (invoice_id, po)
ON source.invoice_id = target.invoice_id AND source.po = target.purchase_order
WHEN MATCHED THEN UPDATE SET target.purchase_order = source.po
WHEN NOT MATCHED THEN INSERT (invoice_id) VALUES (source.invoice_id);`

  it('parses target, alias, source and ON', () => {
    const m = maskSql(unsafe)
    const [mg] = parseMerges(m, depthMap(m))
    expect(mg.target).toEqual({ schema: 'dbo', name: 'invoices' })
    expect(mg.targetAlias).toBe('target')
    expect(mg.source.kind).toBe('subquery')
    expect(aliasColumns(mg.on, 'target').map((c) => c.column)).toEqual([
      'invoice_id',
      'purchase_order'
    ])
  })

  it('flags nullable keys compared with =', () => {
    const fs = checkObject(proc(unsafe), catalog).filter((f) => f.check_key === 'merge-null-key')
    expect(fs).toHaveLength(1)
    expect(fs[0].detail.nullable_columns).toEqual(['invoice_id', 'purchase_order'])
    expect(fs[0].line).toBe(2)
    // the source subquery has no dedupe
    expect(keys(unsafe)).toContain('merge-source-dupes')
    // the MERGE's own THEN UPDATE is not a write without WHERE
    expect(keys(unsafe)).not.toContain('write-without-where')
  })

  it.each([
    ['ISNULL', "ISNULL(target.invoice_id, '') = ISNULL(source.invoice_id, '')"],
    [
      'IS NULL pair',
      '(target.invoice_id = source.invoice_id OR (target.invoice_id IS NULL AND source.invoice_id IS NULL))'
    ],
    ['IS NOT DISTINCT FROM', 'target.invoice_id IS NOT DISTINCT FROM source.invoice_id'],
    ['INTERSECT', 'EXISTS (SELECT target.invoice_id INTERSECT SELECT source.invoice_id)']
  ])('passes a NULL-safe compare (%s)', (_label, on) => {
    expect(nullSafeIn(on, 'target', 'invoice_id')).toBe(true)
    const sql = `MERGE dbo.invoices t USING (SELECT DISTINCT invoice_id FROM staging_invoices) s ON ${on.replaceAll('target.', 't.').replaceAll('source.', 's.')} WHEN MATCHED THEN UPDATE SET t.notes = NULL;`
    expect(keys(sql)).not.toContain('merge-null-key')
  })

  it('ignores a comment that mentions a MERGE and a temp-table target', () => {
    expect(
      keys('-- MERGE dbo.invoices t USING x s ON s.a = t.invoice_id WHEN MATCHED THEN DELETE;')
    ).toEqual([])
    expect(keys('MERGE #t AS t USING x s ON s.a = t.b WHEN MATCHED THEN DELETE;')).toEqual([])
  })

  it('accepts a source with a unique index on the joined columns, or a deduping CTE', () => {
    const viaTable =
      'MERGE dbo.vendors t USING dbo.vendor_src s ON s.code = t.code WHEN MATCHED THEN UPDATE SET t.code = s.code;'
    expect(keys(viaTable)).not.toContain('merge-source-dupes')
    const viaCte =
      'WITH src AS (SELECT code, ROW_NUMBER() OVER (PARTITION BY code ORDER BY code) rn FROM vendor_src) MERGE dbo.vendors t USING src s ON s.code = t.code WHEN MATCHED THEN UPDATE SET t.code = s.code;'
    expect(keys(viaCte)).not.toContain('merge-source-dupes')
  })
})

describe('writes without WHERE', () => {
  it('ignores names that only contain the word (a @delete parameter, t.update)', () => {
    expect(
      keys(
        'CREATE PROCEDURE dbo.forecast_orphans @delete bit = 0 AS SELECT t.update FROM t WHERE 1 = 1'
      )
    ).not.toContain('write-without-where')
  })
  it('reports clear-and-refill of a scratch table as info, not critical', () => {
    const found = checkObject(
      proc(
        'DELETE FROM temp_forecast; INSERT INTO temp_forecast (a) SELECT a FROM forecasts WHERE a > 0'
      ),
      catalog
    ).filter((f) => f.check_key === 'write-without-where')
    expect(found.map((f) => f.severity)).toEqual(['info'])
    const plain = checkObject(proc('DELETE FROM forecasts'), catalog).filter(
      (f) => f.check_key === 'write-without-where'
    )
    expect(plain.map((f) => f.severity)).toEqual(['critical'])
  })
  it('flags UPDATE and DELETE with no WHERE', () => {
    expect(keys('UPDATE dbo.invoices SET notes = NULL')).toContain('write-without-where')
    expect(keys('DELETE FROM invoices;')).toContain('write-without-where')
  })
  it('passes WHERE, JOIN predicates, temp tables, CASE … END and the next statement', () => {
    expect(
      keys('UPDATE invoices SET notes = CASE WHEN id > 1 THEN 1 ELSE 0 END WHERE id = 3')
    ).not.toContain('write-without-where')
    expect(
      keys(
        'UPDATE t SET notes = s.x FROM invoices t JOIN staging_invoices s ON s.invoice_id = t.invoice_id'
      )
    ).not.toContain('write-without-where')
    expect(keys('DELETE FROM #work; UPDATE @rows SET a = 1')).not.toContain('write-without-where')
    expect(keys('UPDATE t SET a = 1 FROM #tmp t')).not.toContain('write-without-where')
    expect(keys("IF UPDATE(notes) PRINT 'x'")).not.toContain('write-without-where')
    expect(keys('DELETE FROM invoices WHERE id IN (SELECT id FROM vendors)')).not.toContain(
      'write-without-where'
    )
  })
  it('a WHERE inside a subquery does not count', () => {
    expect(
      keys('UPDATE invoices SET notes = (SELECT TOP 1 code FROM vendors WHERE id = 1)')
    ).toContain('write-without-where')
  })
})

describe('other checks', () => {
  it('transactions without XACT_ABORT or a rolling-back CATCH', () => {
    expect(keys('BEGIN TRAN; UPDATE invoices SET notes = 1 WHERE id = 1; COMMIT')).toContain(
      'tran-without-xact-abort'
    )
    expect(keys('SET XACT_ABORT ON; BEGIN TRANSACTION; COMMIT')).not.toContain(
      'tran-without-xact-abort'
    )
    expect(
      keys(
        'BEGIN TRY BEGIN TRAN; COMMIT END TRY BEGIN CATCH IF @@TRANCOUNT > 0 ROLLBACK; THROW; END CATCH'
      )
    ).not.toContain('tran-without-xact-abort')
  })
  it('local time: one finding per object with the count', () => {
    const fs = checkObject(proc('SELECT GETDATE(), SYSDATETIME(), GETUTCDATE()'), catalog)
    const lt = fs.filter((f) => f.check_key === 'local-time')
    expect(lt).toHaveLength(1)
    expect(lt[0].detail.count).toBe(2)
    expect(keys("SELECT 'GETDATE()'")).not.toContain('local-time')
  })
  it('NOT IN over a nullable column, unless it filters NULLs', () => {
    expect(keys('SELECT * FROM vendors WHERE id NOT IN (SELECT vendor FROM blocked)')).toContain(
      'not-in-subquery'
    )
    expect(
      keys(
        'SELECT 1 FROM vendors WHERE id NOT IN (SELECT vendor FROM blocked WHERE vendor IS NOT NULL)'
      )
    ).not.toContain('not-in-subquery')
    expect(
      keys('SELECT 1 FROM vendors WHERE code NOT IN (SELECT code FROM vendor_src)')
    ).not.toContain('not-in-subquery')
  })
  it('SELECT * on a table with a max column, but not inside EXISTS', () => {
    expect(keys('SELECT * FROM invoices')).toContain('select-star-wide')
    expect(keys('SELECT * FROM vendors')).not.toContain('select-star-wide')
    expect(keys('IF EXISTS (SELECT * FROM invoices) PRINT 1')).not.toContain('select-star-wide')
  })
})

describe('fingerprints and run bookkeeping', () => {
  it('a fingerprint survives lines added above the statement', () => {
    const a = checkObject(proc('UPDATE invoices SET notes = 1'), catalog)[0]
    const b = checkObject(proc('\n\n-- new\nUPDATE invoices SET notes = 1'), catalog)[0]
    expect(a.line).not.toBe(b.line)
    expect(fingerprintOf(proc(''), a.check_key, a.anchor)).toBe(
      fingerprintOf(proc(''), b.check_key, b.anchor)
    )
  })
  it('identical statements in one object get distinct fingerprints', () => {
    const obj = proc('UPDATE invoices SET notes = 1; UPDATE invoices SET notes = 1')
    const items = checkObject(obj, catalog)
      .filter((f) => f.check_key === 'write-without-where')
      .map((f) => ({ obj, f }))
    const fps = fingerprintAll(items).map((s) => s.fingerprint)
    expect(new Set(fps).size).toBe(2)
  })
  it('diff: new, seen again, resolved only within scope', () => {
    const obj = proc('UPDATE invoices SET notes = 1')
    const [seen] = fingerprintAll(checkObject(obj, catalog).map((f) => ({ obj, f })))
    const stored = (fp: string, over: Partial<StoredFinding> = {}): StoredFinding => ({
      id: 1,
      fingerprint: fp,
      status: 'open',
      object_type: 'procedure',
      object_schema: 'dbo',
      object_name: 'p',
      object_hash: 'h',
      check_key: 'local-time',
      message: 'm',
      ...over
    })
    const scope = {
      types: new Set<'procedure' | 'custom_query'>(['procedure']),
      sqlfluffAnswered: false
    }
    const d = diffFindings(
      [
        stored(seen.fingerprint, { status: 'resolved' }),
        stored('gone'),
        stored('cq', { object_type: 'custom_query' }),
        stored('lint', { check_key: 'sqlfluff' }),
        stored('already', { status: 'resolved' })
      ],
      [seen],
      scope as never
    )
    expect(d.inserts).toEqual([])
    expect(d.updates.map((u) => u.row.status)).toEqual(['resolved'])
    // custom queries were not read and SQLFluff did not answer: those stay as they are
    expect(d.resolves.map((r) => r.fingerprint)).toEqual(['gone'])
  })
  it('data figures turn a NULL-key finding critical with the counts', () => {
    const f = checkObject(
      proc(
        'MERGE invoices t USING staging_invoices s ON s.invoice_id = t.invoice_id WHEN MATCHED THEN DELETE;'
      ),
      catalog
    ).find((x) => x.check_key === 'merge-null-key')!
    const crit = applyFigures(f, {
      null_counts: { invoice_id: 30 },
      extra_rows: 12,
      null_key_rows: 20,
      table_rows: 1000
    })
    expect(crit.severity).toBe('critical')
    expect(crit.message).toMatch(/30 rows hold NULL keys now; 12 extra rows/)
    expect(
      applyFigures(f, {
        null_counts: { invoice_id: 0 },
        extra_rows: 0,
        null_key_rows: 0,
        table_rows: 1
      }).severity
    ).toBe('warning')
    expect(applyFigures(f, { skipped: 'over the cap' }).detail.data).toBe('skipped')
  })
})

describe('settings', () => {
  afterEach(() => {
    delete process.env.SQL_CHECKS
  })
  it('validates strictly and names the bad key', () => {
    expect(validateSqlCheckSettings(undefined)).toEqual(SQL_CHECK_DEFAULTS)
    expect(() => validateSqlCheckSettings({ row_cap: 5 })).toThrow(/row_cap/)
    expect(() => validateSqlCheckSettings({ enabled: 'yes' })).toThrow(/enabled/)
    expect(() => validateSqlCheckSettings({ nope: 1 })).toThrow(/nope/)
    expect(validateSqlCheckSettings({ enabled: true, data_checks: false }).data_checks).toBe(false)
  })
  it('SQL_CHECKS forces the nightly run on or off', () => {
    expect(nightlyEnabled({ ...SQL_CHECK_DEFAULTS, enabled: true })).toBe(true)
    process.env.SQL_CHECKS = 'off'
    expect(sqlChecksEnvOverride()).toBe(false)
    expect(nightlyEnabled({ ...SQL_CHECK_DEFAULTS, enabled: true })).toBe(false)
    process.env.SQL_CHECKS = 'on'
    expect(nightlyEnabled(SQL_CHECK_DEFAULTS)).toBe(true)
  })
})

describe('SQLFluff sidecar client', () => {
  afterEach(() => {
    setLintFetchForTests(null)
    delete process.env.SQL_LINT_URL
    delete process.env.SQL_LINT_TOKEN
  })
  it('keeps correctness codes only', () => {
    expect(keepLintCode('RF02')).toBe(true)
    expect(keepLintCode('AM04')).toBe(true)
    expect(keepLintCode('LT02')).toBe(false)
    expect(keepLintCode('RF03')).toBe(false)
  })
  it('sends the bearer token and the text only; retries a busy sidecar', async () => {
    process.env.SQL_LINT_URL = 'http://lint:8080/'
    process.env.SQL_LINT_TOKEN = 'tok'
    const calls: Array<{ url: string; init: RequestInit }> = []
    let n = 0
    setLintFetchForTests(async (url, init) => {
      calls.push({ url, init })
      n++
      if (n === 1) return new Response('', { status: 503 })
      return new Response(
        JSON.stringify({
          violations: [{ code: 'RF02', line: 3, description: 'ambiguous' }],
          parse_errors: 1
        })
      )
    })
    const r = await lintSql('SELECT 1', { backoffMs: 1 })
    expect(r).toEqual({
      ok: true,
      violations: [{ code: 'RF02', line: 3, description: 'ambiguous' }],
      parseErrors: 1
    })
    expect(calls[0].url).toBe('http://lint:8080/lint')
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ sql: 'SELECT 1', dialect: 'tsql' })
  })
  it('reports 401 as unauthorized and 504 as a per-module timeout', async () => {
    process.env.SQL_LINT_URL = 'http://lint'
    setLintFetchForTests(async () => new Response('', { status: 401 }))
    expect(await lintSql('x')).toMatchObject({ ok: false, reason: 'unauthorized' })
    setLintFetchForTests(async () => new Response('', { status: 504 }))
    expect(await lintSql('x')).toMatchObject({ ok: false, reason: 'timeout' })
    setLintFetchForTests(async () => new Response('', { status: 503 }))
    expect(await lintSql('x', { retries: 1, backoffMs: 1 })).toMatchObject({
      ok: false,
      reason: 'unavailable'
    })
  })
  it('is off without a URL', async () => {
    expect(await lintSql('x')).toMatchObject({ ok: false, reason: 'unavailable' })
  })
})
