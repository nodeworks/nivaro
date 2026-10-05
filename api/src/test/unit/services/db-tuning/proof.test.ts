import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../../db/index.js'
import {
  hypotheticalCosts,
  type ProofDeps,
  procCallees,
  prove,
  subtreeCost
} from '../../../../services/db-tuning/proof.js'
import {
  type Candidate,
  isErrorRefusal,
  type ProofResult
} from '../../../../services/db-tuning/types.js'
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
      timeoutMs: 5000,
      twin: expect.stringMatching(/^rpt__tune_[0-9a-f]{8}$/)
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
    expect(r.detail).toBe('error: could not read the procedures it calls: VIEW DEFINITION denied')
    expect(isErrorRefusal(r)).toBe(true)
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
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatch(/^rpt__tune_[0-9a-f]{8}$/)
    expect(r).toMatchObject({ passed: false, method: 'refused' })
    expect(r.detail).toBe(`a procedure named ${asked[0]} already exists`)
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
      [false, [expect.stringMatching(/^rpt__tune_[0-9a-f]{8}$/)]]
    ])
    // the twin that runs is the name just checked
    expect(twin).toHaveBeenCalledWith(
      expect.objectContaining({ twin: (calls[2][1] as string[])[0] })
    )
  })
  it('refuses when the twin-name check itself fails', async () => {
    vi.mocked(db.raw).mockImplementation((() => Promise.reject(new Error('denied'))) as never)
    const twin = vi.fn(async () => passing)
    const r = await prove(proc(), { procTimeoutMs: 1, deps: { twin } })
    expect(r.detail).toMatch(
      /^error: could not check for an existing rpt__tune_[0-9a-f]{8}: denied$/
    )
    expect(twin).not.toHaveBeenCalled()
  })
})

describe('prove — every branch passes and fails', () => {
  const noTwin = async () => passing
  const index = (
    hypothetical: Awaited<ReturnType<ProofDeps['hypotheticalCosts']>>,
    evidence: Record<string, unknown> = idx.evidence
  ) =>
    prove(
      { ...idx, evidence },
      {
        procTimeoutMs: 1,
        deps: {
          statementsTouching: async () => [
            { text: 'select', execution_count: 1, avg_elapsed_ms: 5, total_elapsed_ms: 5 }
          ],
          hypotheticalCosts: async () => hypothetical,
          indexExists: async () => false,
          twin: noTwin
        }
      }
    )

  it('hypothetical fails below a 20% drop', async () => {
    const r = await index([{ before: 10, after: 9 }])
    expect(r).toMatchObject({ passed: false, method: 'hypothetical' })
    expect(r.detail).toMatch(/−10%/)
  })
  it('hypothetical fails when one statement gets more than 1% worse', async () => {
    const r = await index([
      { before: 10, after: 5 },
      { before: 10, after: 10.2 }
    ])
    expect(r).toMatchObject({ passed: false, method: 'hypothetical' })
    expect(r.detail).toMatch(/one got worse/)
  })
  it('hypothetical fails, naming the error, when the plan run failed part-way', async () => {
    const r = await index({ error: 'SET AUTOPILOT OFF failed' })
    expect(r).toMatchObject({ passed: false, method: 'hypothetical' })
    expect(r.detail).toBe('hypothetical plan failed: SET AUTOPILOT OFF failed')
  })
  it('dmv-estimate fails below an improvement measure of 10, live reads or not', async () => {
    const r = await index(null, {
      sources: ['dmv', 'config'],
      dmv_improvement: 9,
      live: { filter: 40, sort: 0 }
    })
    expect(r).toMatchObject({ passed: false, method: 'dmv-estimate' })
    expect(r.detail).toMatch(/is 9 \(needs ≥ 10\)/)
  })
  it('dmv-estimate passes a candidate SQL Server never asked for on observed reads', async () => {
    const live = await index(null, { sources: ['config'], live: { filter: 3, sort: 1 } })
    expect(live).toMatchObject({ passed: true, method: 'dmv-estimate' })
    const plan = await index(null, { sources: ['plan'], live: null })
    expect(plan).toMatchObject({ passed: true, method: 'dmv-estimate' })
  })
  it('dmv-estimate fails a config-only candidate with no observed traffic', async () => {
    const r = await index(null, { sources: ['config'], live: null })
    expect(r).toEqual({
      passed: false,
      method: 'dmv-estimate',
      before: {},
      after: {},
      detail: 'no observed traffic'
    })
  })

  const drop = (evidence: Record<string, unknown>): Candidate => ({
    ...idx,
    kind: 'index_drop',
    target: 'workflows.idx_workflows_owner',
    evidence,
    apply: { type: 'sql', statements: ['DROP INDEX [idx_workflows_owner] ON [workflows]'] },
    undo: { type: 'sql', statements: ['CREATE NONCLUSTERED INDEX …'] }
  })
  const dropDeps = (exists: boolean): Partial<ProofDeps> => ({ indexExists: async () => exists })
  it('index_drop passes on zero reads over 30+ days, or a strict prefix', async () => {
    const unused = await prove(drop({ reads: 0, uptime_days: 31, covered_by: null }), {
      procTimeoutMs: 1,
      deps: dropDeps(true)
    })
    expect(unused).toMatchObject({ passed: true, method: 'usage-stats' })
    const prefix = await prove(drop({ reads: 400, uptime_days: 31, covered_by: 'idx_wide' }), {
      procTimeoutMs: 1,
      deps: dropDeps(true)
    })
    expect(prefix).toMatchObject({ passed: true, detail: 'strict prefix of idx_wide' })
  })
  it('index_drop fails with the actual reads when the index is read', async () => {
    const r = await prove(drop({ reads: 5, uptime_days: 31, covered_by: null }), {
      procTimeoutMs: 1,
      deps: dropDeps(true)
    })
    expect(r).toMatchObject({ passed: false, method: 'usage-stats' })
    expect(r.detail).toBe('5 reads over 31 days of uptime (needs 0 reads over ≥ 30 days)')
  })
  it('index_drop fails when the index no longer exists', async () => {
    const r = await prove(drop({ reads: 0, uptime_days: 31, covered_by: null }), {
      procTimeoutMs: 1,
      deps: dropDeps(false)
    })
    expect(r).toMatchObject({ passed: false, detail: 'index no longer exists' })
  })

  const cache = (sources: number, estimate: number): Candidate => ({
    ...idx,
    kind: 'query_cache',
    target: 'spend',
    evidence: { freshness: { sources } },
    estimate_ms_per_day: estimate,
    apply: {
      type: 'query_patch',
      id: 1,
      slug: 'spend',
      patch: { cache_ttl: 600, warm_daily: false }
    },
    undo: { type: 'query_patch', id: 1, slug: 'spend', patch: { cache_ttl: 0, warm_daily: false } }
  })
  it('query_cache passes on resolved freshness and a ≥ 5 s/day saving', async () => {
    const r = await prove(cache(2, 6000), { procTimeoutMs: 1 })
    expect(r).toMatchObject({ passed: true, method: 'freshness' })
  })
  it('query_cache fails on unresolved freshness or a small saving', async () => {
    expect((await prove(cache(0, 60_000), { procTimeoutMs: 1 })).passed).toBe(false)
    expect((await prove(cache(2, 4999), { procTimeoutMs: 1 })).passed).toBe(false)
  })
  it('rollup_store fails when reads cost less than 3× the upkeep', async () => {
    const c: Candidate = {
      ...idx,
      kind: 'rollup_store',
      target: 'c.f',
      evidence: { reads_per_day: 100, writes_per_day: 50, per_read_ms: 40, per_recalc_ms: 60 },
      apply: { type: 'field_patch', collection: 'c', field: 'f', patch: { computed_store: true } },
      undo: { type: 'field_patch', collection: 'c', field: 'f', patch: { computed_store: false } }
    }
    expect(await prove(c, { procTimeoutMs: 1 })).toMatchObject({
      passed: false,
      method: 'cost-model'
    })
  })
  it('refuses, naming the error, when an evidence read throws', async () => {
    const r = await prove(idx, {
      procTimeoutMs: 1,
      deps: {
        indexExists: async () => false,
        statementsTouching: async () => {
          throw new Error('plan cache unreadable')
        }
      }
    })
    expect(r).toEqual({
      passed: false,
      method: 'refused',
      before: {},
      after: {},
      detail: 'error: proof could not run: plan cache unreadable'
    })
  })
})

describe('hypotheticalCosts', () => {
  const PLAN = (cost: number) => [
    { 'Microsoft SQL Server 2005 XML Showplan': `<StmtSimple StatementSubTreeCost="${cost}" />` }
  ]
  /**
   * A session that behaves like SQL Server's modes: under SHOWPLAN_XML / AUTOPILOT a statement
   * (a ROLLBACK, the closing @@TRANCOUNT read) is only planned, never executed. `failOn` throws
   * before the statement takes effect, so a failing OFF leaves the mode on.
   */
  function fakeConnection(opts: { failOn?: RegExp; afterCost?: number; stuckTran?: boolean } = {}) {
    const sent: string[] = []
    const timeouts = new Map<string, number | undefined>()
    const discard = vi.fn()
    let showplan = false
    let autopilot = false
    let tran = 0
    vi.mocked(withLongConnection).mockImplementation((async (fn: (c: unknown) => unknown) =>
      fn({
        discard,
        run: async (sql: string, timeoutMs?: number) => {
          sent.push(sql)
          timeouts.set(sql, timeoutMs)
          if (opts.failOn?.test(sql)) throw new Error('boom')
          if (sql === 'SET SHOWPLAN_XML ON') showplan = true
          else if (sql === 'SET SHOWPLAN_XML OFF') showplan = false
          else if (sql === 'SET AUTOPILOT ON') autopilot = true
          else if (sql === 'SET AUTOPILOT OFF') autopilot = false
          else if (showplan || autopilot) {
            if (/^SELECT \d|^SELECT \*/.test(sql))
              return PLAN(showplan ? 10 : (opts.afterCost ?? 4))
            return PLAN(0.1)
          } else if (sql === 'BEGIN TRAN') tran++
          else if (/ROLLBACK/.test(sql)) tran = opts.stuckTran ? tran : 0
          else if (sql === 'SELECT @@TRANCOUNT AS n') return [{ n: tran }]
          else if (/^SELECT/.test(sql))
            throw new Error('a statement ran outside SHOWPLAN / AUTOPILOT')
          return []
        }
      })) as never)
    return { sent, timeouts, discard }
  }
  afterEach(() => vi.mocked(withLongConnection).mockReset())
  const one = ['SELECT 1 FROM [workflows]']

  it('plans before, creates the hypothetical index in a transaction, plans after, rolls back', async () => {
    const { sent, timeouts, discard } = fakeConnection()
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
    const create = sent.find((s) => /CREATE NONCLUSTERED/.test(s)) ?? ''
    expect(create).toMatch(/WITH STATISTICS_ONLY = -1$/)
    expect(timeouts.get(create)).toBe(15_000)
    expect(at(/DBCC AUTOPILOT/)).toBeLessThan(at(/^SET AUTOPILOT ON$/))
    expect(at(/^SET AUTOPILOT OFF$/)).toBeLessThan(at(/ROLLBACK/))
    expect(sent.slice(-2)).toEqual(['SET LOCK_TIMEOUT -1', 'SELECT @@TRANCOUNT AS n'])
    expect(discard).not.toHaveBeenCalled()
  })
  it('is unavailable (null) when SQL Server refuses the hypothetical index, rolled back cleanly', async () => {
    for (const failOn of [/DBCC AUTOPILOT/, /CREATE NONCLUSTERED/]) {
      const { sent, discard } = fakeConnection({ failOn })
      expect(await hypotheticalCosts('workflows', ['project_type'], one)).toBeNull()
      expect(sent).toContain('IF @@TRANCOUNT > 0 ROLLBACK')
      expect(sent).not.toContain('SET AUTOPILOT ON')
      expect(discard).not.toHaveBeenCalled()
    }
  })
  it('discards the connection when SET AUTOPILOT OFF fails (the ROLLBACK was only planned)', async () => {
    const { sent, discard } = fakeConnection({ failOn: /^SET AUTOPILOT OFF$/ })
    const r = await hypotheticalCosts('workflows', ['project_type'], one)
    expect(r).toEqual({ error: 'boom' })
    expect(sent).toContain('IF @@TRANCOUNT > 0 ROLLBACK')
    expect(discard).toHaveBeenCalledOnce()
  })
  it('discards the connection when SET SHOWPLAN_XML OFF fails, before any transaction', async () => {
    const { sent, discard } = fakeConnection({ failOn: /^SET SHOWPLAN_XML OFF$/ })
    expect(await hypotheticalCosts('workflows', ['project_type'], one)).toEqual({ error: 'boom' })
    expect(sent).not.toContain('BEGIN TRAN')
    expect(discard).toHaveBeenCalledOnce()
  })
  it('discards the connection when the ROLLBACK fails', async () => {
    const { discard } = fakeConnection({ failOn: /ROLLBACK/ })
    expect(await hypotheticalCosts('workflows', ['project_type'], one)).toEqual({ error: 'boom' })
    expect(discard).toHaveBeenCalledOnce()
  })
  it('discards the connection when @@TRANCOUNT does not read 0 afterwards', async () => {
    const { discard } = fakeConnection({ stuckTran: true })
    const r = await hypotheticalCosts('workflows', ['project_type'], one)
    expect(r).toEqual({ error: 'the session did not come back clean after the hypothetical plan' })
    expect(discard).toHaveBeenCalledOnce()
  })
  it('fails with an error, AUTOPILOT off before the ROLLBACK, when an after-plan has no cost', async () => {
    const { sent, discard } = fakeConnection({ afterCost: Number.NaN })
    const r = await hypotheticalCosts('workflows', ['project_type'], one)
    expect(r).toEqual({ error: 'an estimated plan came back without a cost' })
    const off = sent.indexOf('SET AUTOPILOT OFF')
    expect(off).toBeGreaterThan(-1)
    expect(sent.indexOf('IF @@TRANCOUNT > 0 ROLLBACK')).toBeGreaterThan(off)
    expect(discard).toHaveBeenCalledOnce()
  })
  it('skips a statement that does not compile before the index is created', async () => {
    const { sent, discard } = fakeConnection({ failOn: /@p0/ })
    const r = await hypotheticalCosts(
      'workflows',
      ['project_type'],
      ['SELECT 1 FROM [workflows] WHERE [project_type] = @p0', 'SELECT 2 FROM [workflows]']
    )
    expect(r).toEqual([{ before: 10, after: 4 }])
    expect(sent.filter((s) => /@p0/.test(s))).toHaveLength(1)
    expect(discard).not.toHaveBeenCalled()
  })
  it('never opens a connection for non-identifiers or writes only', async () => {
    fakeConnection()
    expect(await hypotheticalCosts('a]b', ['c'], ['SELECT 1'])).toBeNull()
    expect(await hypotheticalCosts('t', ['c'], ['DELETE FROM [t] WHERE [c] = 1'])).toBeNull()
    expect(withLongConnection).not.toHaveBeenCalled()
  })
})

describe('withLongConnection — discard', () => {
  /** A tedious-shaped connection and a knex-shaped client around it. */
  function fakeKnex() {
    const sent: string[] = []
    const events: string[] = []
    let onEnd: (() => void) | undefined
    const conn = {
      connected: true,
      closed: false,
      execSqlBatch(req: { sql: string; handlers: Record<string, () => void> }) {
        sent.push(req.sql)
        queueMicrotask(() => req.handlers.requestCompleted?.())
      },
      once(_ev: 'end', h: () => void) {
        onEnd = h
      },
      close() {
        events.push('close')
        conn.closed = true
        queueMicrotask(() => onEnd?.())
      }
    }
    class Request {
      handlers: Record<string, () => void> = {}
      constructor(public sql: string) {}
      on(ev: string, h: () => void) {
        this.handlers[ev] = h
      }
      once(ev: string, h: () => void) {
        this.handlers[ev] = h
      }
    }
    const client = {
      config: { client: 'mssql' },
      _driver: () => ({ Request }),
      acquireConnection: async () => conn,
      releaseConnection: async (c: typeof conn) => {
        events.push(`release connected=${c.connected}`)
      }
    }
    return { knex: { client } as never, conn, sent, events }
  }
  it('closes a discarded connection before releasing it, marked disconnected, no ROLLBACK sent', async () => {
    const { withLongConnection: real } = await vi.importActual<
      typeof import('../../../../services/run-long.js')
    >('../../../../services/run-long.js')
    const { knex, sent, events } = fakeKnex()
    await real(
      async (c) => {
        await c.run('SET AUTOPILOT ON')
        c.discard()
      },
      { knex }
    )
    expect(sent).toEqual(['SET AUTOPILOT ON'])
    expect(events).toEqual(['close', 'release connected=false'])
  })
  it('rolls back and releases a connection that was not discarded', async () => {
    const { withLongConnection: real } = await vi.importActual<
      typeof import('../../../../services/run-long.js')
    >('../../../../services/run-long.js')
    const { knex, sent, events } = fakeKnex()
    await real(async (c) => c.run('SELECT 1'), { knex })
    expect(sent).toEqual(['SELECT 1', 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION'])
    expect(events).toEqual(['release connected=true'])
  })
})
