import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── mocks for the apply flow (the pure parts below need none) ─────────────
/** liveProcedureDefinition (the preview's read). */
const live: { defs: string[] } = { defs: [] }
/** Reads of sys.sql_modules on the pinned, app-locked connection (before / after each deploy). */
const lockedReads: { defs: Array<string | null> } = { defs: [] }
const lock = { r: 0 }
const deployed: string[] = []
const compiled: string[] = []
const batches: string[] = []
const inserted: Array<{ table: string; row: Record<string, unknown> }> = []
const updated: Array<{ table: string; row: Record<string, unknown>; where: unknown[] }> = []
const updateCount = { n: 1 }
const findingRow: { value: Record<string, unknown> | undefined } = { value: undefined }
const dupesRow: { value: unknown } = { value: undefined }
const importRows: { byKey: Record<string, Record<string, unknown>> } = { byKey: {} }

vi.mock('../../../db/index.js', () => {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {}
    const where: unknown[] = []
    let isDupesLookup = false
    for (const m of ['where', 'whereNot', 'whereNotNull', 'whereRaw', 'select', 'orderBy'])
      c[m] = vi.fn((...args: unknown[]) => {
        if (m === 'where') where.push(args)
        if (
          m === 'where' &&
          args[0] &&
          typeof args[0] === 'object' &&
          'check_key' in (args[0] as object)
        )
          isDupesLookup = true
        return c
      })
    c.first = vi.fn(async () => {
      if (isDupesLookup) return dupesRow.value
      if (table === 'nivaro_import_definitions') {
        const by = (col: string) =>
          (where.find((w) => (w as unknown[])[0] === col) as unknown[] | undefined)?.[1]
        const key = by('key')
        const id = by('id')
        return key != null
          ? importRows.byKey[String(key)]
          : id != null
            ? importRows.byKey[`id:${id}`]
            : undefined
      }
      return findingRow.value
    })
    c.insert = vi.fn((row: Record<string, unknown>) => {
      inserted.push({ table, row })
      const p = Promise.resolve([{ id: inserted.length }])
      return Object.assign(p, { returning: async () => [{ id: inserted.length }] })
    })
    c.update = vi.fn(async (row: Record<string, unknown>) => {
      updated.push({ table, row, where })
      return updateCount.n
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
/** The owner answer and the managed config store (app-managed procedures). */
const mp: {
  owner: Record<string, unknown> | null
  row: Record<string, unknown> | null
  save: ReturnType<typeof vi.fn>
} = { owner: null, row: null, save: vi.fn() }
vi.mock('../../../services/managed-procedures/owners.js', () => ({
  procedureOwner: vi.fn(async () => mp.owner)
}))
vi.mock('../../../services/managed-procedures/store.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getManagedProcedure: vi.fn(async () => mp.row)
}))
vi.mock('../../../services/managed-procedures/deploy.js', () => ({
  saveAndDeployManaged: (...a: unknown[]) => mp.save(...a)
}))

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/run-long.js', () => ({
  withLongConnection: async (fn: (c: unknown) => Promise<unknown>) => {
    let inTran = false
    return fn({
      run: async (sql: string) => {
        batches.push(sql)
        if (/sp_getapplock/.test(sql)) return [{ r: lock.r }]
        if (/sys\.sql_modules/.test(sql)) return [{ definition: lockedReads.defs.shift() ?? null }]
        if (/^BEGIN TRANSACTION/.test(sql)) inTran = true
        if (/ROLLBACK/.test(sql)) inTran = false
        if (/CREATE OR ALTER PROCEDURE/.test(sql)) (inTran ? compiled : deployed).push(sql)
        return []
      },
      discard: () => {}
    })
  }
}))
vi.mock('../../../services/procedure-deploy.js', async (orig) => {
  const m = (await orig()) as Record<string, unknown>
  return {
    ...m,
    liveProcedureDefinition: vi.fn(async () => live.defs.shift() ?? null),
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

import { procBodyHash } from '../../../services/managed-procedures/normalize.js'
import { ManagedProcError } from '../../../services/managed-procedures/store.js'
import {
  definitionNameMatches,
  deployProcedure,
  importBodyTargetsOwn,
  sha256,
  toCreateOrAlter
} from '../../../services/procedure-deploy.js'
import {
  applyFix,
  compileProposal,
  deployText,
  FixError,
  proposalFor,
  revertFix
} from '../../../services/sql-checks/apply.js'
import {
  applyEdits,
  diffForEdits,
  mergeRisks,
  procBodyStart,
  procHeaderName,
  proposeFix,
  proposeMergeNullSafe,
  proposeXactAbort,
  recheckVerdict,
  splitConjuncts,
  unifiedDiff,
  xactAbortRisks
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
    expect(p.risky).toBe(false)
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
    const at = procBodyStart(maskSql(sql))
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
  // S4
  it('is risky when the body commits in CATCH, reads XACT_STATE() or @@ERROR', () => {
    const catchCommit =
      'CREATE PROC p AS BEGIN TRAN BEGIN TRY UPDATE t SET a=1 WHERE id=1 END TRY BEGIN CATCH COMMIT END CATCH'
    const p = proposeXactAbort(catchCommit)
    expect(p.risky).toBe(true)
    expect(p.reasons[0]).toMatch(/3930/)
    expect(xactAbortRisks(maskSql('IF XACT_STATE() = 1 COMMIT'))).toHaveLength(1)
    expect(xactAbortRisks(maskSql('IF @@ERROR <> 0 GOTO done'))).toHaveLength(1)
    // a comment mentioning them does not count
    expect(xactAbortRisks(maskSql('-- XACT_STATE() @@ERROR\nSELECT 1'))).toHaveLength(0)
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
    extra_rows: extra,
    table_rows: 250000
  }
})

describe('NULL-safe ON rewrite (#2563)', () => {
  it('wraps only nullable target pairs, keeping brackets, aliases and parens as written', () => {
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
      'ON (src.[invoice_id] = t.[invoice_id] OR (src.[invoice_id] IS NULL AND t.[invoice_id] IS NULL)) AND t.line = src.line AND ((src.po = t.po) OR (src.po IS NULL AND t.po IS NULL))\nWHEN'
    )
    onlyEditsChanged(sql, p.newDefinition as string, p.edits)
    // S10: the scan note names the table size
    expect(p.notes[0]).toMatch(/250,000-row/)
  })
  // S10
  it('keeps a comment inside a rewritten pair', () => {
    const sql =
      'CREATE PROC p AS MERGE invoices t USING src s ON s.po /* order key */ = t.po WHEN MATCHED THEN DELETE;'
    const p = proposeMergeNullSafe(sql, mergeFinding(1, ['po']))
    expect(p.newDefinition).toContain(
      'ON (s.po /* order key */ = t.po OR (s.po IS NULL AND t.po IS NULL)) WHEN'
    )
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

// ─── S1: the deployed header always names the finding's object ─────────────

describe('deploy text names its target (S1)', () => {
  it('keeps a header that already names [schema].[name]', () => {
    const sql = 'CREATE PROCEDURE dbo.p AS SELECT 1'
    expect(deployText(sql, 'dbo', 'p')).toBe(sql)
  })
  it('rewrites a renamed procedure’s old name and a schema-less header', () => {
    expect(deployText('CREATE PROCEDURE dbo.old_name AS SELECT 1', 'dbo', 'p')).toBe(
      'CREATE PROCEDURE [dbo].[p] AS SELECT 1'
    )
    expect(deployText('CREATE PROC p AS SELECT 1', 'etl', 'p')).toBe(
      'CREATE PROC [etl].[p] AS SELECT 1'
    )
  })
  it('reads the header outside comments', () => {
    const sql = '/* CREATE PROCEDURE dbo.decoy */\nCREATE PROCEDURE dbo.p AS SELECT 1'
    expect(procHeaderName(sql)).toMatchObject({ schema: 'dbo', name: 'p' })
    expect(toCreateOrAlter(sql)).toBe(
      '/* CREATE PROCEDURE dbo.decoy */\nCREATE OR ALTER PROCEDURE dbo.p AS SELECT 1'
    )
  })
})

describe('procedure-deploy helpers', () => {
  // S8
  it('escapes the procedure name in the stored-body check', () => {
    expect(importBodyTargetsOwn('CREATE OR ALTER PROCEDURE axb AS SELECT 1', 'a.b')).toBe(false)
    expect(importBodyTargetsOwn('CREATE OR ALTER PROCEDURE [a.b] AS SELECT 1', 'a.b')).toBe(true)
  })
  // S6
  it('sends the text as one batch, with ? and backslashes untouched, under the procedure lock (R2)', async () => {
    deployed.length = 0
    batches.length = 0
    await deployProcedure("CREATE PROCEDURE p AS SELECT '?' AS q, 'a\\?b' AS r", {
      schema: 'dbo',
      name: 'p'
    })
    expect(deployed).toEqual(["CREATE OR ALTER PROCEDURE p AS SELECT '?' AS q, 'a\\?b' AS r"])
    const steps = batches.map((b) =>
      /sp_getapplock/.test(b)
        ? 'lock'
        : /sp_releaseapplock/.test(b)
          ? 'unlock'
          : /CREATE OR ALTER/.test(b)
            ? 'create'
            : null
    )
    expect(steps.filter(Boolean)).toEqual(['lock', 'create', 'unlock'])
    expect(batches.find((b) => /sp_getapplock/.test(b))).toContain("N'sqlcheck:dbo.p'")
  })
  // R3
  it('leaves a header that already says CREATE OR ALTER exactly as written', () => {
    const body = 'create or alter proc dbo.p as select 1'
    expect(toCreateOrAlter(body)).toBe(body)
  })
  // R1
  it('reads the procedure name outside comments, so a decoy comment cannot pass the check', () => {
    const decoy = '/* create procedure Foo */\nCREATE PROCEDURE Bar AS SELECT 1'
    expect(definitionNameMatches(decoy, 'Foo')).toBe(false)
    expect(definitionNameMatches(decoy, 'Bar')).toBe(true)
    expect(definitionNameMatches('CREATE PROCEDURE etl.Bar AS SELECT 1', 'Bar')).toBe(false)
    const body = '-- create or alter procedure Foo\nCREATE OR ALTER PROCEDURE Bar AS SELECT 1'
    expect(importBodyTargetsOwn(body, 'Foo')).toBe(false)
    expect(importBodyTargetsOwn(body, 'Bar')).toBe(true)
    expect(importBodyTargetsOwn('CREATE PROCEDURE Bar AS SELECT 1', 'Bar')).toBe(false)
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
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/write-without-where/) })
  })
})

// ─── the apply flow ─────────────────────────────────────────────────────────

const BAD =
  'CREATE PROCEDURE dbo.import_invoices AS\nMERGE invoices t USING src s ON s.po = t.po WHEN MATCHED THEN DELETE;'
const FIXED = BAD.replace('s.po = t.po', '(s.po = t.po OR (s.po IS NULL AND t.po IS NULL))')
const who = { userId: 'u-1', label: 'admin@x' }

function reset() {
  live.defs = []
  lockedReads.defs = []
  lock.r = 0
  deployed.length = 0
  compiled.length = 0
  batches.length = 0
  inserted.length = 0
  updated.length = 0
  updateCount.n = 1
  dupesRow.value = undefined
  importRows.byKey = {}
  mp.owner = null
  mp.row = null
  mp.save = vi.fn()
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
}

describe('applying a fix', () => {
  beforeEach(reset)

  it('previews without compiling or changing anything (S5)', async () => {
    live.defs = [BAD]
    const p = await proposalFor(5)
    expect(p.proposable).toBe(true)
    expect('compile' in p).toBe(false)
    expect(p.new_definition_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(batches).toHaveLength(0)
    expect(deployed).toHaveLength(0)
  })

  it('compiles on request in a rolled-back transaction', async () => {
    live.defs = [BAD]
    const p = await proposalFor(5)
    live.defs = [BAD]
    await expect(compileProposal(5, p.new_definition_hash as string)).resolves.toEqual({ ok: true })
    expect(compiled).toHaveLength(1)
    expect(deployed).toHaveLength(0)
    expect(batches).toContain('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION')
  })

  // R4
  it('does not compile for a finding that is resolved or marked as expected', async () => {
    for (const status of ['resolved', 'accepted']) {
      findingRow.value = { ...(findingRow.value as object), status }
      live.defs = [BAD]
      await expect(compileProposal(5, 'a'.repeat(64))).rejects.toMatchObject({ status: 409 })
    }
    expect(compiled).toHaveLength(0)
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

  it('deploys under the lock, re-checks, resolves the finding and keeps the previous definition', async () => {
    live.defs = [BAD]
    const p = await proposalFor(5)
    live.defs = [BAD]
    lockedReads.defs = [BAD, FIXED]
    const r = await applyFix({
      findingId: 5,
      newDefinitionHash: p.new_definition_hash as string,
      confirmRisky: false,
      who
    })
    expect(r).toMatchObject({ applied: true, rolled_back: false, deployed: true })
    expect(deployed).toEqual([toCreateOrAlter(FIXED)])
    // S2: the lock is taken before the read and released after the deploy, on one connection
    const order = batches.map((b) =>
      /sp_getapplock/.test(b)
        ? 'lock'
        : /sp_releaseapplock/.test(b)
          ? 'unlock'
          : /sys\.sql_modules/.test(b)
            ? 'read'
            : /CREATE OR ALTER/.test(b) && !/ROLLBACK/.test(b)
              ? 'create'
              : null
    )
    const tail = order.filter(Boolean).slice(-5)
    expect(tail).toEqual(['lock', 'read', 'create', 'read', 'unlock'])
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
      source: 'sql-checks-page',
      applied_definition_hash: sha256(FIXED)
    })
    expect(updated.find((u) => u.table === 'nivaro_sql_check_findings')?.row).toMatchObject({
      status: 'resolved'
    })
    expect(inserted.find((i) => i.table === 'nivaro_sql_check_events')?.row).toMatchObject({
      event: 'fixed'
    })
  })

  // S1
  it('deploys a renamed procedure under the finding’s own name, never the old one', async () => {
    const renamed = BAD.replace('dbo.import_invoices', 'dbo.import_invoices_old')
    live.defs = [renamed]
    const p = await proposalFor(5)
    live.defs = [renamed]
    lockedReads.defs = [renamed, FIXED]
    await applyFix({
      findingId: 5,
      newDefinitionHash: p.new_definition_hash as string,
      confirmRisky: false,
      who
    })
    expect(deployed[0]).toMatch(/^CREATE OR ALTER PROCEDURE \[dbo\]\.\[import_invoices\] AS/)
    expect(deployed[0]).not.toContain('import_invoices_old')
  })

  // S2
  it('refuses when the procedure changed between the preview and the locked read, or the lock is held', async () => {
    live.defs = [BAD]
    const p = await proposalFor(5)
    live.defs = [BAD]
    lockedReads.defs = [`${BAD} -- edited by someone`]
    await expect(
      applyFix({
        findingId: 5,
        newDefinitionHash: p.new_definition_hash as string,
        confirmRisky: false,
        who
      })
    ).rejects.toMatchObject({ status: 409, code: 'SQL_CHECK_FIX_STALE' })
    expect(deployed).toHaveLength(0)
    expect(batches.some((b) => /sp_releaseapplock/.test(b))).toBe(true)
    live.defs = [BAD]
    lock.r = -1
    await expect(
      applyFix({
        findingId: 5,
        newDefinitionHash: p.new_definition_hash as string,
        confirmRisky: false,
        who
      })
    ).rejects.toMatchObject({ status: 409 })
    expect(deployed).toHaveLength(0)
  })

  it('puts the previous definition back when the re-check is not clean', async () => {
    live.defs = [BAD]
    const p = await proposalFor(5)
    live.defs = [BAD]
    // SQL Server hands back the old text: the finding is still there
    lockedReads.defs = [BAD, BAD, BAD, BAD]
    const r = await applyFix({
      findingId: 5,
      newDefinitionHash: p.new_definition_hash as string,
      confirmRisky: false,
      who
    })
    expect(r).toMatchObject({ applied: false, rolled_back: true })
    expect(deployed).toHaveLength(2)
    expect(deployed[1]).toBe(toCreateOrAlter(BAD))
    expect(inserted.find((i) => i.table === 'nivaro_sql_check_events')?.row).toMatchObject({
      event: 'fix_undone'
    })
  })

  it('does not put back over a change made after the deploy; the failure can be restored later (D2)', async () => {
    live.defs = [BAD]
    const p = await proposalFor(5)
    live.defs = [BAD]
    // deployed text reads back unfixed (re-check fails), then someone else changes it before put-back
    lockedReads.defs = [BAD, BAD, `${BAD} -- someone else`]
    await expect(
      applyFix({
        findingId: 5,
        newDefinitionHash: p.new_definition_hash as string,
        confirmRisky: false,
        who
      })
    ).rejects.toMatchObject({ status: 500, code: 'SQL_CHECK_FIX_ROLLBACK_FAILED' })
    expect(deployed).toHaveLength(1)
    const detail = JSON.parse(
      String(inserted.find((i) => i.table === 'nivaro_sql_check_fixes')?.row.detail)
    )
    expect(detail).toMatchObject({ applied: false, rollback_error: expect.any(String) })
    expect(detail.applied_definition_hash).toBe(sha256(BAD))
  })

  // S7
  it('rewrites a stored import body only if it is unchanged since it was read', async () => {
    findingRow.value = {
      ...(findingRow.value as object),
      object_type: 'import_definition',
      object_ref: '12',
      object_name: 'invoices'
    }
    const body = BAD.replace('CREATE PROCEDURE', 'CREATE OR ALTER PROCEDURE')
    importRows.byKey = {
      'id:12': { key: 'invoices', procedure: 'import_invoices', procedure_body: body }
    }
    const p = await proposalFor(5)
    updateCount.n = 0
    await expect(
      applyFix({
        findingId: 5,
        newDefinitionHash: p.new_definition_hash as string,
        confirmRisky: false,
        who
      })
    ).rejects.toMatchObject({ status: 409, code: 'SQL_CHECK_FIX_STALE' })
    const u = updated.find((x) => x.table === 'nivaro_import_definitions')
    expect(u?.where).toContainEqual(['procedure_body', body])
  })
})

describe('reverting a fix', () => {
  beforeEach(reset)
  const applied = 'CREATE OR ALTER PROCEDURE p AS SELECT 2'
  const detail = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      source: 'sql-checks-page',
      applied: true,
      kind: 'module',
      finding_id: 5,
      object: { type: 'procedure', schema: 'dbo', name: 'p', ref: null },
      previous_definition: 'CREATE PROCEDURE dbo.p AS SELECT 1',
      applied_definition_hash: sha256(applied),
      ...extra
    })

  it('reverts only a fix from this page whose result is still in place', async () => {
    findingRow.value = {
      id: 3,
      target_object: 'dbo.p',
      detail: JSON.stringify({ source: 'script' })
    }
    await expect(revertFix(3, who)).rejects.toMatchObject({ status: 409 })
    findingRow.value = { id: 4, target_object: 'dbo.p', detail: detail() }
    lockedReads.defs = ['CREATE OR ALTER PROCEDURE p AS SELECT 3'] // someone changed it since
    await expect(revertFix(4, who)).rejects.toMatchObject({ status: 409 })
    expect(deployed).toHaveLength(0)
    lockedReads.defs = [applied, 'CREATE OR ALTER PROCEDURE dbo.p AS SELECT 1']
    await expect(revertFix(4, who)).resolves.toMatchObject({ reverted: true })
    expect(deployed).toEqual(['CREATE OR ALTER PROCEDURE dbo.p AS SELECT 1'])
  })

  it('restores a failed put-back (rollback_error) too (D2)', async () => {
    findingRow.value = {
      id: 6,
      target_object: 'dbo.p',
      detail: detail({ applied: false, rollback_error: 'lock timeout' })
    }
    lockedReads.defs = [applied, 'x']
    await expect(revertFix(6, who)).resolves.toMatchObject({ reverted: true })
    expect(deployed).toHaveLength(1)
  })

  // S3
  it('restores synced import bodies only when unchanged, with their hash and deploy time', async () => {
    const synced = toCreateOrAlter(applied)
    findingRow.value = {
      id: 7,
      target_object: 'dbo.p',
      detail: detail({
        import_previous_bodies: [
          {
            key: 'kept',
            previous_body: 'OLD-A',
            previous_hash: 'h-a',
            previous_deployed_at: '2026-10-01T00:00:00.000Z',
            synced_hash: sha256(synced)
          },
          {
            key: 'edited',
            previous_body: 'OLD-B',
            previous_hash: 'h-b',
            previous_deployed_at: null,
            synced_hash: sha256(synced)
          }
        ]
      })
    }
    importRows.byKey = {
      kept: { procedure_body: synced },
      edited: { procedure_body: `${synced} -- changed by a person` }
    }
    lockedReads.defs = [applied, 'x']
    const r = await revertFix(7, who)
    expect(r.skipped_import_bodies).toEqual(['edited'])
    const imp = updated.filter((u) => u.table === 'nivaro_import_definitions')
    expect(imp).toHaveLength(1)
    expect(imp[0].row).toMatchObject({ procedure_body: 'OLD-A', procedure_hash: 'h-a' })
    expect(imp[0].row.procedure_deployed_at).toEqual(new Date('2026-10-01T00:00:00.000Z'))
    expect(imp[0].where).toContainEqual(['procedure_body', synced])
  })
})

// ─── app-managed procedures: the fix goes through config ────────────────────

describe('a fix to an app-managed procedure', () => {
  beforeEach(reset)
  const MANAGED_NOTE =
    'This procedure is app-managed: the fix is saved as a new version in config and deployed from there.'
  // config holds the body (CREATE OR ALTER form); the live text differs (never read)
  const CONFIG = `${toCreateOrAlter(BAD)}\n-- config copy`
  const managed = () => {
    mp.owner = { kind: 'managed', id: 4, name: 'import_invoices', dropped: false }
    mp.row = {
      id: 4,
      name: 'import_invoices',
      body: CONFIG,
      body_hash: procBodyHash(CONFIG),
      version: 3,
      dropped_at: null
    }
  }

  it('is proposed from the config body and applied through config, never by a raw ALTER', async () => {
    managed()
    live.defs = [`${BAD} -- live differs`]
    const p = await proposalFor(5)
    expect(p.target.kind).toBe('managed_procedure')
    expect(p.deploys).toBe(true)
    expect(p.note).toBe(MANAGED_NOTE)
    expect(p.current_hash).toBe(sha256(CONFIG))
    mp.save.mockResolvedValue({ version: 4, unchanged: false, deployed: { action: 'altered' } })
    const out = await applyFix({
      findingId: 5,
      newDefinitionHash: p.new_definition_hash as string,
      confirmRisky: false,
      who
    })
    expect(out).toMatchObject({ applied: true, rolled_back: false, deployed: true })
    expect(mp.save).toHaveBeenCalledTimes(1)
    const arg = mp.save.mock.calls[0][0] as Record<string, unknown>
    expect(arg).toMatchObject({
      name: 'import_invoices',
      note: 'SQL checks fix (finding #5)',
      baseHash: procBodyHash(CONFIG),
      userId: 'u-1',
      by: 'user:u-1'
    })
    expect(String(arg.body)).toContain('(s.po = t.po OR (s.po IS NULL AND t.po IS NULL))')
    expect(sha256(String(arg.body))).toBe(p.new_definition_hash)
    // no lock, no raw deploy: only the rolled-back compile ran
    expect(deployed).toHaveLength(0)
    expect(batches.some((b) => /sp_getapplock/.test(b))).toBe(false)
    const detail = JSON.parse(
      String(inserted.find((i) => i.table === 'nivaro_sql_check_fixes')?.row.detail)
    )
    expect(detail).toMatchObject({
      kind: 'managed_procedure',
      applied: true,
      deployed: true,
      previous_definition: CONFIG,
      managed_version: 4,
      applied_definition_hash: procBodyHash(String(arg.body))
    })
    expect(updated.find((u) => u.table === 'nivaro_sql_check_findings')?.row).toMatchObject({
      status: 'resolved'
    })
  })

  it('a stale config body on apply is 409 SQL_CHECK_FIX_STALE and nothing is recorded', async () => {
    managed()
    const p = await proposalFor(5)
    mp.save.mockRejectedValue(new ManagedProcError(409, 'PROC_STALE', 'changed', { current: null }))
    await expect(
      applyFix({
        findingId: 5,
        newDefinitionHash: p.new_definition_hash as string,
        confirmRisky: false,
        who
      })
    ).rejects.toMatchObject({ status: 409, code: 'SQL_CHECK_FIX_STALE' })
    expect(inserted.filter((i) => i.table === 'nivaro_sql_check_fixes')).toHaveLength(0)
    expect(deployed).toHaveLength(0)
  })

  it('a deploy the database refuses is recorded as failed and answered 422', async () => {
    managed()
    const p = await proposalFor(5)
    mp.save.mockRejectedValue(new ManagedProcError(400, 'DEPLOY_FAILED', 'Invalid column name'))
    await expect(
      applyFix({
        findingId: 5,
        newDefinitionHash: p.new_definition_hash as string,
        confirmRisky: false,
        who
      })
    ).rejects.toMatchObject({ status: 422 })
    const detail = JSON.parse(
      String(inserted.find((i) => i.table === 'nivaro_sql_check_fixes')?.row.detail)
    )
    expect(detail).toMatchObject({ applied: false, error: 'Invalid column name' })
    expect(updated.find((u) => u.table === 'nivaro_sql_check_findings')).toBeUndefined()
  })

  it('a procedure marked dropped in config is refused (the deploy drops it)', async () => {
    managed()
    mp.owner = { kind: 'managed', id: 4, name: 'import_invoices', dropped: true }
    await expect(proposalFor(5)).rejects.toMatchObject({ status: 409 })
    expect(mp.save).not.toHaveBeenCalled()
  })

  it('an import-owned procedure finding keeps the live deploy (and its import bodies)', async () => {
    mp.owner = { kind: 'import', key: 'invoices', name: 'import_invoices' }
    live.defs = [BAD]
    const p = await proposalFor(5)
    expect(p.target.kind).toBe('module')
    live.defs = [BAD]
    lockedReads.defs = [BAD, FIXED]
    await expect(
      applyFix({
        findingId: 5,
        newDefinitionHash: p.new_definition_hash as string,
        confirmRisky: false,
        who
      })
    ).resolves.toMatchObject({ applied: true, deployed: true })
    expect(deployed).toEqual([toCreateOrAlter(FIXED)])
    expect(mp.save).not.toHaveBeenCalled()
  })

  const appliedBody = 'CREATE OR ALTER PROCEDURE p AS SELECT 2'
  const managedDetail = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      source: 'sql-checks-page',
      applied: true,
      deployed: true,
      kind: 'managed_procedure',
      finding_id: 5,
      object: { type: 'procedure', schema: 'dbo', name: 'p', ref: null },
      managed_procedure: 'p',
      previous_definition: 'CREATE OR ALTER PROCEDURE p AS SELECT 1',
      applied_definition_hash: procBodyHash(appliedBody),
      ...extra
    })

  it('revert of a managed fix saves the previous body as a new version and deploys it', async () => {
    findingRow.value = { id: 8, target_object: 'dbo.p', detail: managedDetail() }
    mp.save.mockResolvedValue({ version: 5, unchanged: false, deployed: { action: 'altered' } })
    await expect(revertFix(8, who)).resolves.toMatchObject({ reverted: true })
    expect(mp.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'p',
        body: 'CREATE OR ALTER PROCEDURE p AS SELECT 1',
        baseHash: procBodyHash(appliedBody),
        note: 'Reverted SQL checks fix #8',
        userId: 'u-1'
      })
    )
    expect(deployed).toHaveLength(0)
    expect(batches).toHaveLength(0)
    const fixRow = updated.find((u) => u.table === 'nivaro_sql_check_fixes')
    expect(JSON.parse(String(fixRow?.row.detail))).toMatchObject({ reverted: true })
  })

  it('a live fix to a procedure adopted into config since is not reverted by a raw ALTER', async () => {
    mp.owner = { kind: 'managed', id: 4, name: 'p', dropped: false }
    findingRow.value = {
      id: 9,
      target_object: 'dbo.p',
      detail: managedDetail({
        kind: 'module',
        managed_procedure: undefined,
        applied_definition_hash: sha256(appliedBody)
      })
    }
    lockedReads.defs = [appliedBody, 'x']
    await expect(revertFix(9, who)).rejects.toMatchObject({
      status: 409,
      code: 'MANAGED_PROCEDURE'
    })
    expect(deployed).toHaveLength(0)
    expect(mp.save).not.toHaveBeenCalled()
  })

  it('revert of a managed fix never revives a procedure dropped in config', async () => {
    mp.owner = { kind: 'managed', id: 4, name: 'p', dropped: true }
    findingRow.value = { id: 8, target_object: 'dbo.p', detail: managedDetail() }
    mp.save.mockResolvedValue({ version: 5, unchanged: false, deployed: { action: 'created' } })
    await expect(revertFix(8, who)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(
        'marked dropped in app config — restore it on the Procedures page'
      )
    })
    expect(mp.save).not.toHaveBeenCalled()
    expect(updated.find((u) => u.table === 'nivaro_sql_check_fixes')).toBeUndefined()
  })

  it('revert of a managed fix whose config moved on is 409 and changes nothing', async () => {
    findingRow.value = { id: 8, target_object: 'dbo.p', detail: managedDetail() }
    mp.save.mockRejectedValue(new ManagedProcError(409, 'PROC_STALE', 'changed', { current: null }))
    await expect(revertFix(8, who)).rejects.toMatchObject({ status: 409 })
    expect(updated.find((u) => u.table === 'nivaro_sql_check_fixes')).toBeUndefined()
  })
})
