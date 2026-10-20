import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── mocks for the apply flow (the pure parts below need none) ─────────────
const live: { defs: string[] } = { defs: [] }
const deployed: string[] = []
const inserted: Array<{ table: string; row: Record<string, unknown> }> = []
const updated: Array<{ table: string; row: Record<string, unknown> }> = []
const findingRow: { value: Record<string, unknown> | undefined } = { value: undefined }
const dupesRow: { value: unknown } = { value: undefined }

vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {}
    let isDupesLookup = false
    for (const m of ['where', 'whereNot', 'whereNotNull', 'whereRaw', 'select', 'orderBy'])
      c[m] = vi.fn((arg: unknown) => {
        if (m === 'where' && arg && typeof arg === 'object' && 'check_key' in (arg as object))
          isDupesLookup = true
        return c
      })
    c.first = vi.fn(async () => (isDupesLookup ? dupesRow.value : findingRow.value))
    c.insert = vi.fn((row: Record<string, unknown>) => {
      inserted.push({ table, row })
      const p = Promise.resolve([{ id: inserted.length }])
      return Object.assign(p, { returning: async () => [{ id: inserted.length }] })
    })
    c.update = vi.fn(async (row: Record<string, unknown>) => {
      updated.push({ table, row })
      return 1
    })
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is awaited as a thenable
    c.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res)
    return c
  }
  const db = vi.fn((t: string) => chain(t)) as unknown as Record<string, unknown>
  db.schema = { hasTable: vi.fn(async () => false) }
  db.raw = vi.fn()
  return { db }
})
vi.mock('../../../db/dialect.js', () => ({ isMssql: () => true }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/run-long.js', () => ({
  withLongConnection: async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ run: async () => [], discard: () => {} })
}))
vi.mock('../../../services/procedure-deploy.js', async (orig) => {
  const m = (await orig()) as Record<string, unknown>
  return {
    ...m,
    liveProcedureDefinition: vi.fn(async () => live.defs.shift() ?? null),
    deployProcedure: vi.fn(async (def: string) => {
      deployed.push(def)
    }),
    snapshotImportDefinition: vi.fn(async () => {})
  }
})
vi.mock('../../../services/sql-checks/run.js', async (orig) => {
  const m = (await orig()) as Record<string, unknown>
  const buildCatalog = m.buildCatalog as (...a: unknown[]) => unknown
  return {
    ...m,
    loadCatalog: vi.fn(async () =>
      buildCatalog(
        [
          {
            sch: 'dbo',
            tbl: 'invoices',
            col: 'invoice_id',
            nullable: 'YES',
            type: 'int',
            len: null
          },
          { sch: 'dbo', tbl: 'invoices', col: 'po', nullable: 'YES', type: 'int', len: null },
          { sch: 'dbo', tbl: 'invoices', col: 'line', nullable: 'NO', type: 'int', len: null }
        ],
        [],
        []
      )
    )
  }
})

import { applyFix, FixError, proposalFor, revertFix } from '../../../services/sql-checks/apply.js'
import {
  applyEdits,
  diffForEdits,
  mergeRisks,
  procBodyStart,
  proposeFix,
  proposeMergeNullSafe,
  proposeXactAbort,
  recheckVerdict,
  splitConjuncts,
  unifiedDiff
} from '../../../services/sql-checks/propose.js'
import { maskSql } from '../../../services/sql-checks/tokenizer.js'

/** Only the edited spans change: everything outside them is byte-identical. */
function onlyEditsChanged(
  before: string,
  after: string,
  edits: Array<{ at: number; remove: number; insert: string }>
) {
  expect(applyEdits(before, edits)).toBe(after)
  const sorted = [...edits].sort((a, b) => a.at - b.at)
  expect(after.startsWith(before.slice(0, sorted[0].at))).toBe(true)
  const last = sorted[sorted.length - 1]
  expect(after.endsWith(before.slice(last.at + last.remove))).toBe(true)
}

// ─── SET XACT_ABORT ON ──────────────────────────────────────────────────────

describe('XACT_ABORT placement (#2563)', () => {
  it('goes first in the body after AS', () => {
    const sql =
      'CREATE PROCEDURE dbo.p @a int AS\n  BEGIN TRAN\n  UPDATE t SET a = 1 WHERE id = @a\n  COMMIT'
    const p = proposeXactAbort(sql)
    expect(p.proposable).toBe(true)
    expect(p.newDefinition).toBe(
      'CREATE PROCEDURE dbo.p @a int AS\n  SET XACT_ABORT ON;\n  BEGIN TRAN\n  UPDATE t SET a = 1 WHERE id = @a\n  COMMIT'
    )
    onlyEditsChanged(sql, p.newDefinition as string, p.edits)
  })
  it('goes inside AS BEGIN, after SET NOCOUNT ON', () => {
    const sql = 'CREATE PROCEDURE p AS\nBEGIN\n    SET NOCOUNT ON;\n    BEGIN TRANSACTION\nEND'
    expect(proposeXactAbort(sql).newDefinition).toBe(
      'CREATE PROCEDURE p AS\nBEGIN\n    SET NOCOUNT ON;\n    SET XACT_ABORT ON;\n    BEGIN TRANSACTION\nEND'
    )
  })
  it('treats AS BEGIN TRAN as a statement, not a block', () => {
    const sql = 'CREATE PROC p AS BEGIN TRAN; COMMIT'
    expect(proposeXactAbort(sql).newDefinition).toBe(
      'CREATE PROC p AS\n    SET XACT_ABORT ON; BEGIN TRAN; COMMIT'
    )
  })
  it('skips WITH EXECUTE AS, parameters named @as and an AS inside a comment', () => {
    const sql =
      "-- AS a comment\nCREATE OR ALTER PROCEDURE [dbo].[p] (@as int = 1, @b nvarchar(10) = 'x AS y')\nWITH EXECUTE AS OWNER\nAS\nBEGIN TRAN\nCOMMIT"
    const masked = maskSql(sql)
    const at = procBodyStart(masked)
    expect(sql.slice(at - 3, at)).toBe('\nAS')
    const p = proposeXactAbort(sql)
    expect(p.newDefinition).toContain('WITH EXECUTE AS OWNER\nAS\nSET XACT_ABORT ON;\nBEGIN TRAN')
    onlyEditsChanged(sql, p.newDefinition as string, p.edits)
  })
  it('refuses when XACT_ABORT is already set or it is not a procedure', () => {
    expect(proposeXactAbort('CREATE PROC p AS SET XACT_ABORT ON; BEGIN TRAN').proposable).toBe(
      false
    )
    expect(proposeXactAbort('SELECT 1').proposable).toBe(false)
  })
})

// ─── NULL-safe MERGE ON ─────────────────────────────────────────────────────

const mergeFinding = (line: number | null, nullable: string[], extra = 0) => ({
  check_key: 'merge-null-key',
  object_type: 'procedure',
  line,
  detail: {
    target_table: 'invoices',
    nullable_columns: nullable,
    key_columns: ['invoice_id', 'po', 'line'],
    extra_rows: extra
  }
})

describe('NULL-safe ON rewrite (#2563)', () => {
  it('rewrites only nullable target pairs, keeping brackets and aliases as written', () => {
    const sql = [
      'CREATE PROCEDURE p AS',
      'MERGE dbo.invoices AS t',
      'USING (SELECT * FROM s) AS src',
      'ON src.[invoice_id] = t.[invoice_id] AND t.line = src.line AND (src.po = t.po)',
      'WHEN MATCHED THEN UPDATE SET x = 1;'
    ].join('\n')
    const p = proposeMergeNullSafe(sql, mergeFinding(2, ['invoice_id', 'po']))
    expect(p.proposable).toBe(true)
    expect(p.newDefinition).toContain(
      'ON (src.[invoice_id] = t.[invoice_id] OR (src.[invoice_id] IS NULL AND t.[invoice_id] IS NULL)) AND t.line = src.line AND (src.po = t.po OR (src.po IS NULL AND t.po IS NULL))\nWHEN'
    )
    onlyEditsChanged(sql, p.newDefinition as string, p.edits)
  })
  it('picks the MERGE on the finding’s line when there are several', () => {
    const sql = [
      'CREATE PROC p AS',
      'MERGE invoices t USING a s ON s.po = t.po WHEN MATCHED THEN DELETE;',
      'MERGE invoices t USING b s ON s.po = t.po WHEN MATCHED THEN DELETE;'
    ].join('\n')
    const p = proposeMergeNullSafe(sql, mergeFinding(3, ['po']))
    const lines = (p.newDefinition as string).split('\n')
    expect(lines[1]).toBe('MERGE invoices t USING a s ON s.po = t.po WHEN MATCHED THEN DELETE;')
    expect(lines[2]).toContain('ON (s.po = t.po OR (s.po IS NULL AND t.po IS NULL)) WHEN')
  })
  it('leaves anything but column equalities to a person', () => {
    const shapes = [
      'ON ISNULL(s.po, 0) = ISNULL(t.po, 0)',
      'ON s.po = t.po OR s.line = t.line',
      "ON s.po = t.po AND t.kind = 'x'",
      'ON s.po = t.po AND s.line BETWEEN 1 AND 3'
    ]
    for (const on of shapes) {
      const sql = `CREATE PROC p AS MERGE invoices t USING src s ${on} WHEN MATCHED THEN DELETE;`
      expect(proposeMergeNullSafe(sql, mergeFinding(1, ['po'])).proposable, on).toBe(false)
    }
  })
  it('splits conjuncts at top-level AND only', () => {
    expect(splitConjuncts(' a.x = b.x AND (c.y = d.y AND e.z = f.z) ')?.length).toBe(2)
    expect(splitConjuncts('a.x = b.x OR a.y = b.y')).toBeNull()
  })
  it('flags copies already stored and a source that may repeat a key as risky', () => {
    expect(mergeRisks(mergeFinding(1, ['po'], 0), false).risky).toBe(false)
    const r = mergeRisks(mergeFinding(1, ['po'], 12), true)
    expect(r.risky).toBe(true)
    expect(r.reasons).toHaveLength(2)
    expect(r.reasons[0]).toMatch(/12 rows already repeat/)
    expect(r.reasons[1]).toMatch(/same row more than once/)
  })
  it('only fixes procedures and stored import bodies', () => {
    const f = { ...mergeFinding(1, ['po']), object_type: 'view' }
    expect(proposeFix('CREATE VIEW v AS SELECT 1', f).proposable).toBe(false)
    expect(
      proposeFix('SELECT 1', {
        check_key: 'local-time',
        object_type: 'procedure',
        line: 1,
        detail: {}
      }).proposable
    ).toBe(false)
  })
})

describe('diff and re-check', () => {
  it('builds hunks with line numbers on both sides', () => {
    const sql = 'a\nb\nc\nd\ne'
    const edits = [{ at: 4, remove: 1, insert: 'C\nC2' }]
    const h = diffForEdits(sql, edits, 1)
    expect(h).toHaveLength(1)
    expect(h[0].lines.map((l) => `${l.type}${l.text}`)).toEqual([' b', '-c', '+C', '+C2', ' d'])
    expect(h[0].lines.at(-1)).toMatchObject({ old_no: 4, new_no: 5 })
    expect(unifiedDiff(h, 'dbo.p')).toContain('@@ -2,3 +2,4 @@')
  })
  it('accepts a re-check only when the fixed check drops and nothing grows', () => {
    const f = (k: string) => ({ check_key: k })
    expect(
      recheckVerdict([f('merge-null-key'), f('local-time')], [f('local-time')], 'merge-null-key').ok
    ).toBe(true)
    expect(recheckVerdict([f('merge-null-key')], [f('merge-null-key')], 'merge-null-key').ok).toBe(
      false
    )
    expect(
      recheckVerdict([f('merge-null-key')], [f('write-without-where')], 'merge-null-key')
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/write-without-where/)
    })
  })
})

// ─── the apply flow ─────────────────────────────────────────────────────────

const BAD =
  'CREATE PROCEDURE dbo.import_invoices AS\nMERGE invoices t USING src s ON s.po = t.po WHEN MATCHED THEN DELETE;'
const who = { userId: 'u-1', label: 'admin@x' }

describe('applying a fix', () => {
  beforeEach(() => {
    live.defs = []
    deployed.length = 0
    inserted.length = 0
    updated.length = 0
    dupesRow.value = undefined
    findingRow.value = {
      id: 5,
      check_key: 'merge-null-key',
      status: 'open',
      object_type: 'procedure',
      object_schema: 'dbo',
      object_name: 'import_invoices',
      object_ref: null,
      line: 2,
      message: 'MERGE into invoices …',
      detail: JSON.stringify(mergeFinding(2, ['po']).detail)
    }
  })

  it('previews without changing anything', async () => {
    live.defs = [BAD]
    const p = await proposalFor(5)
    expect(p.proposable).toBe(true)
    expect(p.compile?.ok).toBe(true)
    expect(p.new_definition_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(deployed).toHaveLength(0)
  })

  it('refuses a stale preview (409) and an unconfirmed risky fix (400)', async () => {
    live.defs = [BAD]
    await expect(
      applyFix({ findingId: 5, newDefinitionHash: '0'.repeat(64), confirmRisky: false, who })
    ).rejects.toMatchObject({ status: 409, code: 'SQL_CHECK_FIX_STALE' })
    dupesRow.value = { id: 9 }
    live.defs = [BAD]
    const p = await proposalFor(5)
    expect(p.risky).toBe(true)
    live.defs = [BAD]
    await expect(
      applyFix({
        findingId: 5,
        newDefinitionHash: p.new_definition_hash as string,
        confirmRisky: false,
        who
      })
    ).rejects.toBeInstanceOf(FixError)
    expect(deployed).toHaveLength(0)
  })

  it('deploys, re-checks, resolves the finding and keeps the previous definition', async () => {
    live.defs = [BAD]
    const p = await proposalFor(5)
    const fixed = BAD.replace('s.po = t.po', '(s.po = t.po OR (s.po IS NULL AND t.po IS NULL))')
    live.defs = [BAD, fixed]
    const r = await applyFix({
      findingId: 5,
      newDefinitionHash: p.new_definition_hash as string,
      confirmRisky: false,
      who
    })
    expect(r).toMatchObject({ applied: true, rolled_back: false, deployed: true })
    expect(deployed).toEqual([fixed])
    const fix = inserted.find((i) => i.table === 'nivaro_sql_check_fixes')?.row
    expect(fix).toMatchObject({
      action: 'proc_fix',
      target_object: 'dbo.import_invoices',
      run_by: 'admin@x'
    })
    const detail = JSON.parse(String(fix?.detail))
    expect(detail).toMatchObject({
      applied: true,
      previous_definition: BAD,
      source: 'sql-checks-page'
    })
    expect(updated.find((u) => u.table === 'nivaro_sql_check_findings')?.row).toMatchObject({
      status: 'resolved'
    })
    expect(inserted.find((i) => i.table === 'nivaro_sql_check_events')?.row).toMatchObject({
      event: 'fixed'
    })
  })

  it('puts the previous definition back when the re-check is not clean', async () => {
    live.defs = [BAD]
    const p = await proposalFor(5)
    // SQL Server hands back the old text (say, a trigger rewrote it): the finding is still there
    live.defs = [BAD, BAD]
    const r = await applyFix({
      findingId: 5,
      newDefinitionHash: p.new_definition_hash as string,
      confirmRisky: false,
      who
    })
    expect(r).toMatchObject({ applied: false, rolled_back: true })
    expect(deployed).toHaveLength(2)
    expect(deployed[1]).toBe(BAD)
    expect(inserted.find((i) => i.table === 'nivaro_sql_check_events')?.row).toMatchObject({
      event: 'fix_undone'
    })
  })

  it('reverts only a fix from this page whose result is still in place', async () => {
    findingRow.value = {
      id: 3,
      target_object: 'dbo.p',
      detail: JSON.stringify({ source: 'script' })
    }
    await expect(revertFix(3, who)).rejects.toMatchObject({ status: 409 })
    const applied = 'CREATE OR ALTER PROCEDURE p AS SELECT 2'
    const { sha256 } = await import('../../../services/procedure-deploy.js')
    findingRow.value = {
      id: 4,
      target_object: 'dbo.p',
      detail: JSON.stringify({
        source: 'sql-checks-page',
        applied: true,
        kind: 'module',
        finding_id: 5,
        object: { type: 'procedure', schema: 'dbo', name: 'p', ref: null },
        previous_definition: 'CREATE PROCEDURE p AS SELECT 1',
        applied_definition_hash: sha256(applied)
      })
    }
    live.defs = ['CREATE OR ALTER PROCEDURE p AS SELECT 3'] // someone changed it since
    await expect(revertFix(4, who)).rejects.toMatchObject({ status: 409 })
    live.defs = [applied]
    await expect(revertFix(4, who)).resolves.toEqual({ reverted: true })
    expect(deployed).toEqual(['CREATE PROCEDURE p AS SELECT 1'])
  })
})
