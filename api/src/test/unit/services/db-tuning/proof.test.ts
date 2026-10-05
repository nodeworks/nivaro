import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../../db/index.js'
import {
  hypotheticalCosts,
  type ProofDeps,
  procCallees,
  prove,
  subtreeCost
} from '../../../../services/db-tuning/proof.js'
import type { Candidate, ProofResult } from '../../../../services/db-tuning/types.js'
import { withLongConnection } from '../../../../services/run-long.js'

vi.mock('../../../../db/dialect.js', () => ({ isMssql: () => true }))
vi.mock('../../../../services/run-long.js', () => ({ withLongConnection: vi.fn() }))

const idx: Candidate = {
  kind: 'index_create',
  target: 'workflows.project_type',
  change_key: 'project_type',
  title: 't',
  evidence: { sources: ['dmv'], dmv_improvement: 12 },
  estimate_ms_per_day: 9000,
  risk: 'reversible',
  apply: {
    type: 'sql',
    statements: [
      'CREATE NONCLUSTERED INDEX idx_workflows_project_type ON [workflows] ([project_type])'
    ]
  },
  undo: { type: 'sql', statements: ['DROP INDEX [idx_workflows_project_type] ON [workflows]'] }
}

describe('prove', () => {
  it('reads StatementSubTreeCost off a plan', () => {
    expect(subtreeCost('<StmtSimple StatementSubTreeCost="12.345" />')).toBe(12.345)
    expect(subtreeCost('<x/>')).toBeNull()
  })
  it('index_create passes on a hypothetical ≥20% cost drop', async () => {
    const r = await prove(idx, {
      procTimeoutMs: 1000,
      deps: {
        statementsTouching: async () => [
          { text: 'select', execution_count: 1, avg_elapsed_ms: 5, total_elapsed_ms: 5 }
        ],
        hypotheticalCosts: async () => [{ before: 10, after: 6 }],
        indexExists: async () => false,
        twin: async () => ({ passed: true, method: 'twin', before: {}, after: {}, detail: '' })
      }
    })
    expect(r.passed).toBe(true)
    expect(r.method).toBe('hypothetical')
  })
  it('index_create falls back to the DMV estimate when the hypothetical path is unavailable', async () => {
    const r = await prove(idx, {
      procTimeoutMs: 1000,
      deps: {
        statementsTouching: async () => [],
        hypotheticalCosts: async () => null,
        indexExists: async () => false,
        twin: async () => ({ passed: true, method: 'twin', before: {}, after: {}, detail: '' })
      }
    })
    expect(r.method).toBe('dmv-estimate')
    expect(r.passed).toBe(true)
  })
  it('index_create fails when the index already exists', async () => {
    const r = await prove(idx, {
      procTimeoutMs: 1000,
      deps: {
        statementsTouching: async () => [],
        hypotheticalCosts: async () => null,
        indexExists: async () => true,
        twin: async () => ({ passed: true, method: 'twin', before: {}, after: {}, detail: '' })
      }
    })
    expect(r.passed).toBe(false)
  })
  it('rollup_store passes on the cost model from the evidence', async () => {
    const c: Candidate = {
      ...idx,
      kind: 'rollup_store',
      target: 'c.f',
      evidence: { reads_per_day: 1000, writes_per_day: 10, per_read_ms: 40, per_recalc_ms: 60 },
      apply: { type: 'field_patch', collection: 'c', field: 'f', patch: { computed_store: true } },
      undo: { type: 'field_patch', collection: 'c', field: 'f', patch: { computed_store: false } }
    }
    const r = await prove(c, { procTimeoutMs: 1 })
    expect(r.method).toBe('cost-model')
    expect(r.passed).toBe(true)
  })
})

describe('subtreeCost', () => {
  it('reads a cost in E notation', () =>
    expect(subtreeCost('<StmtSimple StatementSubTreeCost="3.2831E-05" />')).toBe(3.2831e-5))
})

const OLD = `CREATE PROCEDURE dbo.rpt AS
BEGIN
  SELECT p.id FROM projects p LEFT JOIN project_zones_junction pz ON pz.project_id = p.id
END`
const NEW = `CREATE PROCEDURE dbo.rpt AS
BEGIN
  SELECT p.id FROM projects p
  WHERE EXISTS (SELECT 1 FROM project_zones_junction pz WHERE pz.project_id = p.id)
END`
const CALLER = `CREATE PROCEDURE dbo.rpt AS
BEGIN
  CREATE TABLE #t (id int)
  INSERT INTO #t EXEC dbo.helper @x = 1
  EXEC @rc = [lookup]
  SELECT id FROM #t
END`

const proc = (over: Partial<Candidate> = {}): Candidate => ({
  kind: 'proc_rewrite',
  target: 'rpt',
  change_key: 'h',
  title: 't',
  evidence: { parameter_set_values: [{ Zone: 'A' }], transformers: ['junction-exists'] },
  estimate_ms_per_day: 1000,
  risk: 'review',
  apply: { type: 'proc_body', proc: 'rpt', body: NEW, hash: 'n' },
  undo: { type: 'proc_body', proc: 'rpt', body: OLD, hash: 'o' },
  ...over
})
const withNew = (body: string) =>
  proc({ apply: { type: 'proc_body', proc: 'rpt', body, hash: 'n' } })

const passing: ProofResult = { passed: true, method: 'twin', before: {}, after: {}, detail: 'ok' }

function procDeps(over: Partial<ProofDeps> = {}) {
  const twin = vi.fn(async () => passing)
  const deps: Partial<ProofDeps> = {
    twin,
    calleeBodies: async (names) => new Map(names.map((n) => [n, null])),
    procExists: async () => false,
    ...over
  }
  return { deps, twin }
}

describe('procCallees', () => {
  it('names one- and two-part callees, skips EXECUTE AS, ignores comments and strings', () =>
    expect(
      procCallees(`CREATE PROC x WITH EXECUTE AS OWNER AS
        -- EXEC dbo.commented
        SELECT 'EXEC dbo.quoted'
        EXEC dbo.a; EXECUTE [b] @p = 1; EXEC @rc = [dbo].[c]; EXEC/*x*/d`)
    ).toEqual(['dbo.a', 'dbo.b', 'dbo.c', 'dbo.d']))
  it('is null when an EXEC names three parts or nothing readable', () => {
    expect(procCallees('EXEC other.dbo.p')).toBeNull()
    expect(procCallees('EXEC (@sql)')).toBeNull()
  })
})

describe('prove — proc_rewrite', () => {
  it('runs the twin with the recorded sets when nothing is called and the name is free', async () => {
    const { deps, twin } = procDeps()
    const r = await prove(proc({ evidence: { parameter_set_values: [{ Zone: 'A' }] } }), {
      procTimeoutMs: 5000,
      deps
    })
    expect(r).toEqual(passing)
    expect(twin).toHaveBeenCalledWith({
      proc: 'rpt',
      oldBody: OLD,
      newBody: NEW,
      paramSets: [{ Zone: 'A' }],
      timeoutMs: 5000
    })
  })
  it('refuses a rewrite that calls a procedure which writes', async () => {
    const { deps, twin } = procDeps({
      calleeBodies: async (names) =>
        new Map(
          names.map((n) => [
            n,
            n === 'dbo.helper'
              ? 'CREATE PROC helper @x int AS UPDATE invoices SET amount = 0'
              : 'CREATE PROC lookup AS SELECT 1'
          ])
        )
    })
    const r = await prove(withNew(CALLER), { procTimeoutMs: 1, deps })
    expect(r).toMatchObject({ passed: false, method: 'refused' })
    expect(r.detail).toBe('calls dbo.helper, which writes invoices')
    expect(twin).not.toHaveBeenCalled()
  })
  it('refuses a callee that cannot be found', async () => {
    const { deps, twin } = procDeps()
    const r = await prove(withNew(CALLER), { procTimeoutMs: 1, deps })
    expect(r.method).toBe('refused')
    expect(r.detail).toBe('calls dbo.helper, which cannot be found')
    expect(twin).not.toHaveBeenCalled()
  })
  it('refuses a callee that calls further, and checks the current body’s callees too', async () => {
    const { deps } = procDeps({
      calleeBodies: async (names) =>
        new Map(names.map((n) => [n, 'CREATE PROC helper AS EXEC dbo.deeper']))
    })
    const r = await prove(
      proc({ undo: { type: 'proc_body', proc: 'rpt', body: CALLER, hash: 'o' } }),
      {
        procTimeoutMs: 1,
        deps
      }
    )
    expect(r.detail).toBe(
      'current body calls dbo.helper, which calls dbo.deeper (only one level of callees is checked)'
    )
  })
  it('refuses when a catalog read fails instead of guessing', async () => {
    const { deps, twin } = procDeps({
      calleeBodies: async () => {
        throw new Error('VIEW DEFINITION denied')
      }
    })
    const r = await prove(withNew(CALLER), { procTimeoutMs: 1, deps })
    expect(r.method).toBe('refused')
    expect(r.detail).toMatch(/VIEW DEFINITION denied/)
    expect(twin).not.toHaveBeenCalled()
  })
  it('refuses when a real procedure already holds the twin name', async () => {
    const asked: string[] = []
    const { deps, twin } = procDeps({
      procExists: async (n) => {
        asked.push(n)
        return true
      }
    })
    const r = await prove(proc(), { procTimeoutMs: 1, deps })
    expect(asked).toEqual(['rpt__tune'])
    expect(r).toMatchObject({ passed: false, method: 'refused' })
    expect(r.detail).toBe('a procedure named rpt__tune already exists')
    expect(twin).not.toHaveBeenCalled()
  })
  it('names a junction fan-out when a junction rewrite changes rows', async () => {
    const diff: ProofResult = {
      passed: false,
      method: 'twin',
      before: { sets: 1 },
      after: { differing_sets: 1 },
      detail: 'rows differ on 1 of 1 parameter set(s)',
      rows_diff: [{ set: 1, added: [], removed: ['[1]'] }]
    }
    const { deps } = procDeps({ twin: vi.fn(async () => diff) })
    const r = await prove(proc(), { procTimeoutMs: 1, deps })
    expect(r.passed).toBe(false)
    expect(r.detail).toBe(
      'the original multiplies rows through a junction; a correctness question for a person, not a tuning change; rows differ on 1 of 1 parameter set(s)'
    )
    expect(r.rows_diff).toEqual(diff.rows_diff)
  })
  it('also reads the transformer list from evidence.applied', async () => {
    const diff: ProofResult = {
      passed: false,
      method: 'twin',
      before: {},
      after: {},
      detail: 'rows differ',
      rows_diff: [{ set: 1, added: [], removed: ['[1]'] }]
    }
    const { deps } = procDeps({ twin: vi.fn(async () => diff) })
    const r = await prove(proc({ evidence: { applied: ['junction-exists'] } }), {
      procTimeoutMs: 1,
      deps
    })
    expect(r.detail).toMatch(/^the original multiplies rows through a junction/)
  })
  it('leaves a nondeterminism refusal and a non-junction diff as the twin said', async () => {
    const unstable: ProofResult = {
      passed: false,
      method: 'refused',
      before: {},
      after: {},
      detail: 'nondeterministic',
      rows_diff: [{ set: 1, added: ['[2]'], removed: [] }]
    }
    const a = procDeps({ twin: vi.fn(async () => unstable) })
    expect((await prove(proc(), { procTimeoutMs: 1, deps: a.deps })).detail).toBe(
      'nondeterministic'
    )
    const diff = { ...unstable, method: 'twin' as const, detail: 'rows differ' }
    const b = procDeps({ twin: vi.fn(async () => diff) })
    const r = await prove(proc({ evidence: { transformers: ['last-success-grouped'] } }), {
      procTimeoutMs: 1,
      deps: b.deps
    })
    expect(r.detail).toBe('rows differ')
  })
  it('refuses a body the pure check refuses before any catalog read', async () => {
    const calleeBodies = vi.fn(async () => new Map())
    const { deps, twin } = procDeps({ calleeBodies })
    const r = await prove(withNew('CREATE PROC rpt AS UPDATE invoices SET amount = 0'), {
      procTimeoutMs: 1,
      deps
    })
    expect(r.detail).toBe('rewrite writes invoices')
    expect(calleeBodies).not.toHaveBeenCalled()
    expect(twin).not.toHaveBeenCalled()
  })
})

describe('prove — proc_rewrite catalog reads', () => {
  afterEach(() => vi.mocked(db.raw).mockReset())
  it('reads callee bodies by schema and name, and the twin name in dbo', async () => {
    const raw = vi.mocked(db.raw)
    raw.mockImplementation(((sql: string, b?: string[]) =>
      Promise.resolve(
        /sql_modules/.test(sql) ? [{ definition: `CREATE PROC ${b?.[0]} AS SELECT 1` }] : []
      )) as never)
    const twin = vi.fn(async () => passing)
    const r = await prove(withNew(CALLER), { procTimeoutMs: 1, deps: { twin } })
    expect(r).toEqual(passing)
    const calls = raw.mock.calls.map(([sql, b]) => [/sql_modules/.test(String(sql)), b])
    expect(calls).toEqual([
      [true, ['helper', 'dbo']],
      [true, ['lookup', 'dbo']],
      [false, ['rpt__tune']]
    ])
  })
  it('refuses when the twin-name check itself fails', async () => {
    vi.mocked(db.raw).mockImplementation((() => Promise.reject(new Error('denied'))) as never)
    const twin = vi.fn(async () => passing)
    const r = await prove(proc(), { procTimeoutMs: 1, deps: { twin } })
    expect(r.detail).toBe('could not check for an existing rpt__tune: denied')
    expect(twin).not.toHaveBeenCalled()
  })
})

describe('hypotheticalCosts', () => {
  const PLAN = (cost: number) => [
    { 'Microsoft SQL Server 2005 XML Showplan': `<StmtSimple StatementSubTreeCost="${cost}" />` }
  ]
  function fakeConnection(opts: { failOn?: RegExp; afterCost?: number } = {}) {
    const sent: string[] = []
    let showplan = false
    let autopilot = false
    vi.mocked(withLongConnection).mockImplementation((async (fn: (c: unknown) => unknown) =>
      fn({
        run: async (sql: string) => {
          sent.push(sql)
          if (opts.failOn?.test(sql)) throw new Error('boom')
          if (sql === 'SET SHOWPLAN_XML ON') showplan = true
          else if (sql === 'SET SHOWPLAN_XML OFF') showplan = false
          else if (sql === 'SET AUTOPILOT ON') autopilot = true
          else if (sql === 'SET AUTOPILOT OFF') autopilot = false
          else if (/^SELECT/.test(sql)) {
            if (showplan) return PLAN(10)
            if (autopilot) return PLAN(opts.afterCost ?? 4)
            throw new Error('a statement ran outside SHOWPLAN / AUTOPILOT')
          }
          return []
        }
      })) as never)
    return sent
  }
  afterEach(() => vi.mocked(withLongConnection).mockReset())

  it('plans before, creates the hypothetical index in a transaction, plans after, rolls back', async () => {
    const sent = fakeConnection()
    const r = await hypotheticalCosts(
      'workflows',
      ['project_type'],
      [
        'SELECT * FROM [workflows] WHERE [project_type] = 1',
        'UPDATE [workflows] SET [x] = 1 WHERE [project_type] = 1'
      ]
    )
    expect(r).toEqual([{ before: 10, after: 4 }])
    expect(sent.some((s) => /^UPDATE/.test(s))).toBe(false)
    const at = (re: RegExp) => sent.findIndex((s) => re.test(s))
    expect(at(/^BEGIN TRAN$/)).toBeLessThan(
      at(/CREATE NONCLUSTERED INDEX \[hyp_workflows_project_type\]/)
    )
    expect(sent.find((s) => /CREATE NONCLUSTERED/.test(s))).toMatch(/WITH STATISTICS_ONLY = -1$/)
    expect(at(/DBCC AUTOPILOT/)).toBeLessThan(at(/^SET AUTOPILOT ON$/))
    expect(at(/^SET AUTOPILOT OFF$/)).toBeLessThan(at(/ROLLBACK/))
    expect(sent.at(-1)).toBe('SET LOCK_TIMEOUT -1')
  })
  it('rolls back when DBCC AUTOPILOT fails, and returns null', async () => {
    const sent = fakeConnection({ failOn: /DBCC AUTOPILOT/ })
    const r = await hypotheticalCosts('workflows', ['project_type'], ['SELECT 1 FROM [workflows]'])
    expect(r).toBeNull()
    expect(sent).toContain('IF @@TRANCOUNT > 0 ROLLBACK')
    expect(sent).not.toContain('SET AUTOPILOT ON')
  })
  it('switches AUTOPILOT off before rolling back when an after-plan cannot be read', async () => {
    const sent = fakeConnection({ afterCost: Number.NaN })
    const r = await hypotheticalCosts('workflows', ['project_type'], ['SELECT 1 FROM [workflows]'])
    expect(r).toBeNull()
    const off = sent.indexOf('SET AUTOPILOT OFF')
    expect(off).toBeGreaterThan(-1)
    expect(sent.indexOf('IF @@TRANCOUNT > 0 ROLLBACK')).toBeGreaterThan(off)
  })
  it('skips a statement that does not compile before the index is created', async () => {
    const sent = fakeConnection({ failOn: /@p0/ })
    const r = await hypotheticalCosts(
      'workflows',
      ['project_type'],
      ['SELECT 1 FROM [workflows] WHERE [project_type] = @p0', 'SELECT 2 FROM [workflows]']
    )
    expect(r).toEqual([{ before: 10, after: 4 }])
    expect(sent.filter((s) => /@p0/.test(s))).toHaveLength(1)
  })
  it('never opens a connection for non-identifiers or writes only', async () => {
    fakeConnection()
    expect(await hypotheticalCosts('a]b', ['c'], ['SELECT 1'])).toBeNull()
    expect(await hypotheticalCosts('t', ['c'], ['DELETE FROM [t] WHERE [c] = 1'])).toBeNull()
    expect(withLongConnection).not.toHaveBeenCalled()
  })
})
