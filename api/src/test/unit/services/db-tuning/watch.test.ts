// api/src/test/unit/services/db-tuning/watch.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProposalRow, WatchSample } from '../../../../services/db-tuning/types.js'

const m = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  runs: [] as Array<Record<string, unknown>>,
  collRows: [] as Array<Record<string, unknown>>,
  twins: [] as Array<{ name: string }>,
  rawSql: [] as string[],
  rawError: null as string | null,
  mssql: true,
  settings: { enabled: true, regression_pct: 25, watch_days: 7, proc_timeout_minutes: 10 },
  cacheMs: 100 as number | null,
  updates: [] as Array<{ table: string; where: Record<string, unknown> }>,
  updateProposal: vi.fn(),
  rollback: vi.fn(),
  notifyUser: vi.fn(async (_app: unknown, _user: string, _opts: Record<string, unknown>) => ({})),
  prove: vi.fn(),
  liveRollup: vi.fn(async (_cfg: unknown, _id: unknown, _c: string): Promise<number> => 0),
  register: vi.fn()
}))

vi.mock('../../../../db/index.js', () => {
  const builder = (table: string) => {
    const where: Record<string, unknown> = {}
    let inIds: unknown[] | null = null
    const matches = (row: Record<string, unknown>) =>
      Object.entries(where).every(([k, v]) => (row[k] ?? null) === v)
    const rowsFor = () => {
      if (table === 'nivaro_job_runs')
        return m.runs.filter((r) => (inIds ? inIds.includes(r.id) : true) && matches(r))
      return m.collRows
    }
    const q = {
      where(o: Record<string, unknown>) {
        Object.assign(where, o)
        return q
      },
      whereIn(_col: string, vals: unknown[]) {
        inIds = vals
        return q
      },
      select() {
        return q
      },
      orderBy() {
        return q
      },
      limit() {
        return q
      },
      async first() {
        if (table === 'nivaro_fields') return { computed_formula: 'sum' }
        if (table === 'nivaro_job_runs')
          return [...rowsFor()].sort((a, b) =>
            String(b.started_at).localeCompare(String(a.started_at))
          )[0]
        return undefined
      },
      async update(patch: Record<string, unknown>) {
        m.updates.push({ table, where: { ...where } })
        if (table !== 'nivaro_tuning_proposals') return 0
        const row = m.rows.get(String(where.id))
        if (!row || !matches(row)) return 0
        Object.assign(row, patch)
        return 1
      },
      // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
      then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
        return Promise.resolve(rowsFor()).then(res, rej)
      }
    }
    return q
  }
  const raw = async (sql: string) => {
    m.rawSql.push(sql)
    if (m.rawError) throw new Error(m.rawError)
    return m.twins
  }
  return { db: Object.assign(builder, { raw }) }
})
vi.mock('../../../../db/dialect.js', () => ({ isMssql: () => m.mssql }))
vi.mock('../../../../services/db-tuning/ledger.js', () => ({
  listProposals: async (f: { status?: string[] }) =>
    [...m.rows.values()]
      .filter((r) => !f.status || f.status.includes(String(r.status)))
      .map((r) => structuredClone(r) as unknown as ProposalRow),
  getProposal: async (id: string) => {
    const r = m.rows.get(id)
    return r ? (structuredClone(r) as unknown as ProposalRow) : null
  },
  updateProposal: m.updateProposal
}))
vi.mock('../../../../services/db-tuning/settings.js', () => ({
  readTuningSettings: async () => m.settings
}))
vi.mock('../../../../services/db-tuning/apply.js', () => ({ rollbackProposal: m.rollback }))
vi.mock('../../../../services/notification-channels.js', () => ({ notifyUser: m.notifyUser }))
vi.mock('../../../../services/db-tuning/twin.js', async (orig) => ({
  ...(await orig<typeof import('../../../../services/db-tuning/twin.js')>()),
  proveProcedureRewrite: m.prove
}))
vi.mock('../../../../services/db-tuning/dmv.js', () => ({
  procedureStats: async () => [{ name: 'p', avg_elapsed_ms: 50 }],
  statementsTouching: async () => []
}))
vi.mock('../../../../services/query-cache-stats.js', () => ({
  cacheStats: () => ({ rows: m.cacheMs == null ? [] : [{ slug: 'q', avg_exec_ms: m.cacheMs }] })
}))
vi.mock('../../../../services/rollups.js', () => ({
  parseRollupFormula: (raw: string | null) => (raw ? { sources: [] } : null),
  computeRollupTotal: m.liveRollup
}))
vi.mock('../../../../services/readiness.js', () => ({ registerReadinessCheck: m.register }))

import {
  registerTuningReadiness,
  tuningReadiness
} from '../../../../services/db-tuning/readiness.js'
import { isStuckClaim, judgeRegression, runWatch } from '../../../../services/db-tuning/watch.js'

const s = (vals: number[]) =>
  vals.map((v, i) => ({ at: new Date(i * 3_600_000).toISOString(), value: v }))

describe('judgeRegression', () => {
  it('needs 20 samples before it judges', () => {
    expect(judgeRegression(s(Array(19).fill(200)), 100, 25).regressed).toBe(false)
  })
  it('one bad hour in twenty is not a regression', () => {
    const vals = [...Array(17).fill(100), 300, 310, 320]
    expect(judgeRegression(s(vals), 100, 25).regressed).toBe(false)
  })
  it('20 of 24 samples ≥ 25% worse than the baseline is a regression', () => {
    const vals = [...Array(20).fill(130), 100, 100, 100, 100]
    const r = judgeRegression(s(vals), 100, 25)
    expect(r.regressed).toBe(true)
    expect(r.reason).toMatch(/20 of 24/)
  })
  it('no baseline → never regresses', () => {
    expect(judgeRegression(s(Array(30).fill(999)), null, 25).regressed).toBe(false)
  })
  it('unmeasured hours (null) are not samples', () => {
    const vals: WatchSample[] = [...s(Array(19).fill(200)), { at: 'x', value: null }]
    const r = judgeRegression(vals, 100, 25)
    expect(r.regressed).toBe(false)
    expect(r.reason).toMatch(/19 of 20/)
  })
  it('judges the trailing 24: 19 bad of them is not a regression', () => {
    const vals = [...Array(5).fill(100), ...Array(19).fill(200)]
    expect(judgeRegression(s(vals), 100, 25).regressed).toBe(false)
  })
  it('a regression that starts late (after 100 good hours) is still caught', () => {
    const vals = [...Array(100).fill(100), ...Array(20).fill(200)]
    const r = judgeRegression(s(vals), 100, 25)
    expect(r.regressed).toBe(true)
    expect(r.reason).toMatch(/20 of 24 trailing/)
  })
  it('good hours before the trailing window do not count', () => {
    const vals = [...Array(30).fill(200), ...Array(20).fill(100)]
    expect(judgeRegression(s(vals), 100, 25).regressed).toBe(false)
  })
  it('a value exactly at the limit is not worse', () => {
    expect(judgeRegression(s(Array(24).fill(125)), 100, 25).regressed).toBe(false)
    expect(judgeRegression(s(Array(24).fill(125.01)), 100, 25).regressed).toBe(true)
  })
  it('a zero baseline is no baseline', () => {
    expect(judgeRegression(s(Array(24).fill(999)), 0, 25)).toEqual({
      regressed: false,
      reason: 'no baseline'
    })
    expect(judgeRegression(s(Array(24).fill(999)), null, 25).reason).toBe('no baseline')
  })
})

describe('isStuckClaim', () => {
  const now = Date.parse('2026-10-05T12:00:00Z')
  const ago = (min: number) => new Date(now - min * 60_000).toISOString()
  it('a claim whose job run still runs is never stuck, however old', () => {
    expect(isStuckClaim({ status: 'running', started_at: ago(600) }, null, now)).toBe(false)
  })
  it('a finished run under 30 minutes old is not stuck yet; over 30 it is', () => {
    expect(isStuckClaim({ status: 'interrupted', started_at: ago(10) }, null, now)).toBe(false)
    expect(isStuckClaim({ status: 'interrupted', started_at: ago(31) }, null, now)).toBe(true)
  })
  it('no run record: timed from the first sighting', () => {
    expect(isStuckClaim(null, null, now)).toBe(false)
    expect(isStuckClaim(null, now - 10 * 60_000, now)).toBe(false)
    expect(isStuckClaim(null, now - 31 * 60_000, now)).toBe(true)
  })
})

const NOW = Date.parse('2026-10-05T12:00:00Z')

const qrow = (over: Partial<ProposalRow> = {}): ProposalRow => ({
  id: 'w1',
  kind: 'query_cache',
  target: 'q',
  fingerprint: 'f',
  status: 'watching',
  title: 'Cache query q',
  evidence: {},
  proof: { passed: true, method: 'freshness', before: {}, after: {}, detail: 'ok', watch: [] },
  estimate_ms_per_day: 1,
  risk: 'reversible',
  replicated: false,
  dialect_note: null,
  apply: { type: 'query_patch', id: 1, slug: 'q', patch: { cache_ttl: 600, warm_daily: false } },
  undo: { type: 'query_patch', id: 1, slug: 'q', patch: { cache_ttl: 0, warm_daily: false } },
  applied_at: new Date(NOW - 86_400_000).toISOString(),
  applied_by: 'u1',
  watch_until: new Date(NOW + 6 * 86_400_000).toISOString(),
  watch_baseline: { before: { metric: 100 }, after: {} },
  rolled_back_at: null,
  rollback_reason: null,
  dismissed_at: null,
  dismissed_by: null,
  dismiss_note: null,
  first_seen: '',
  last_seen: '',
  run_id: null,
  ...over
})
const put = (r: ProposalRow) => m.rows.set(r.id, r as unknown as Record<string, unknown>)
const app = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  m.rows.clear()
  m.runs = []
  m.collRows = []
  m.twins = []
  m.rawSql = []
  m.rawError = null
  m.mssql = true
  m.updates = []
  m.cacheMs = 100
  m.settings = { enabled: true, regression_pct: 25, watch_days: 7, proc_timeout_minutes: 10 }
  m.rollback.mockImplementation(async (id: string) => {
    const r = m.rows.get(id)
    if (r) r.status = 'rolled_back'
    return r
  })
  m.updateProposal.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
    const r = m.rows.get(id)
    if (r) Object.assign(r, patch)
  })
  m.prove.mockImplementation(async () => ({
    passed: false,
    method: 'twin',
    before: {},
    after: {},
    detail: 'identical rows'
  }))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('runWatch', () => {
  it('returns at once while database tuning is off', async () => {
    m.settings = { ...m.settings, enabled: false }
    put(qrow())
    const out = await runWatch(app)
    expect(out).toMatchObject({ checked: 0, rolled_back: 0, finished: 0 })
    expect(m.updateProposal).not.toHaveBeenCalled()
  })
  it('appends one sample to proof.watch and keeps watching under 20 samples', async () => {
    put(qrow())
    m.cacheMs = 300
    const out = await runWatch(app)
    expect(out).toMatchObject({ checked: 1, rolled_back: 0, finished: 0 })
    const watch = (m.rows.get('w1')?.proof as { watch: WatchSample[] }).watch
    expect(watch).toEqual([{ at: new Date(NOW).toISOString(), value: 300 }])
    expect(m.rows.get('w1')?.status).toBe('watching')
    expect(m.rollback).not.toHaveBeenCalled()
  })
  it('caps the sample history at 400', async () => {
    const prior = s(Array(400).fill(100))
    put(
      qrow({
        proof: {
          passed: true,
          method: 'freshness',
          before: {},
          after: {},
          detail: '',
          watch: prior
        }
      })
    )
    await runWatch(app)
    const watch = (m.rows.get('w1')?.proof as { watch: WatchSample[] }).watch
    expect(watch).toHaveLength(400)
    expect(watch.at(-1)?.at).toBe(new Date(NOW).toISOString())
  })
  it('a regression rolls back as the system and tells whoever applied it', async () => {
    const prior = s(Array(19).fill(140))
    put(
      qrow({
        proof: {
          passed: true,
          method: 'freshness',
          before: {},
          after: {},
          detail: '',
          watch: prior
        }
      })
    )
    m.cacheMs = 150
    const out = await runWatch(app)
    expect(out.rolled_back).toBe(1)
    expect(m.rollback).toHaveBeenCalledWith('w1', {
      userId: null,
      reason: expect.stringMatching(/^regressed: 20 of 20 trailing samples above 125/),
      app
    })
    expect(m.notifyUser).toHaveBeenCalledTimes(1)
    const [, user, opts] = m.notifyUser.mock.calls[0]
    expect(user).toBe('u1')
    expect(opts).toMatchObject({
      category: 'system',
      subject: expect.stringMatching(/rolled back/),
      target: { kind: 'external', url: '/db-tuning?proposal=w1' }
    })
  })
  it('one bad hour in the window does not roll back', async () => {
    const prior = s([...Array(18).fill(100), 400])
    put(
      qrow({
        proof: {
          passed: true,
          method: 'freshness',
          before: {},
          after: {},
          detail: '',
          watch: prior
        }
      })
    )
    m.cacheMs = 100
    await runWatch(app)
    expect(m.rollback).not.toHaveBeenCalled()
  })
  it('a rollback that loses its claim to an admin is theirs: no count, no notice', async () => {
    put(
      qrow({
        proof: {
          passed: true,
          method: 'freshness',
          before: {},
          after: {},
          detail: '',
          watch: s(Array(19).fill(200))
        }
      })
    )
    m.cacheMs = 200
    m.rollback.mockImplementation(async (id: string) => {
      const r = m.rows.get(id)
      if (r) r.status = 'applying'
      const err = new Error('another apply or rollback holds this proposal') as Error & {
        status: number
      }
      err.status = 409
      throw err
    })
    const out = await runWatch(app)
    expect(out.rolled_back).toBe(0)
    expect(m.notifyUser).not.toHaveBeenCalled()
  })
  it('a rollback that fails leaves the row failed and tells the applier a person is needed', async () => {
    put(
      qrow({
        proof: {
          passed: true,
          method: 'freshness',
          before: {},
          after: {},
          detail: '',
          watch: s(Array(19).fill(200))
        }
      })
    )
    m.cacheMs = 200
    m.rollback.mockImplementation(async (id: string) => {
      const r = m.rows.get(id)
      if (r) r.status = 'failed'
      throw new Error('the query settings changed since the apply')
    })
    const out = await runWatch(app)
    expect(out.rolled_back).toBe(0)
    expect(m.notifyUser).toHaveBeenCalledTimes(1)
    expect(m.notifyUser.mock.calls[0][2]).toMatchObject({
      subject: expect.stringMatching(/needs a person/),
      message: expect.stringMatching(/changed since the apply/)
    })
  })
  it('a stored rollup that drifts from the live figure rolls back at once', async () => {
    put(
      qrow({
        kind: 'rollup_store',
        target: 'projects.total',
        apply: {
          type: 'field_patch',
          collection: 'projects',
          field: 'total',
          patch: { computed_store: true }
        },
        undo: {
          type: 'field_patch',
          collection: 'projects',
          field: 'total',
          patch: { computed_store: false }
        }
      })
    )
    m.collRows = [
      { id: 1, total: 10 },
      { id: 2, total: 20 }
    ]
    m.liveRollup.mockImplementation(async (_c, id) => (id === 1 ? 10 : 25))
    const out = await runWatch(app)
    expect(out.rolled_back).toBe(1)
    expect(m.rollback.mock.calls[0][1].reason).toMatch(/1 sampled row\(s\) drifted/)
  })
  it('past the window with no regression the change is applied (finished)', async () => {
    put(qrow({ watch_until: new Date(NOW - 60_000).toISOString() }))
    const out = await runWatch(app)
    expect(out.finished).toBe(1)
    expect(m.rows.get('w1')?.status).toBe('applied')
    const write = m.updates.find((u) => u.table === 'nivaro_tuning_proposals')
    expect(write?.where).toMatchObject({ id: 'w1', status: 'watching' })
  })
  it('re-diffs one parameter set of a watched rewrite at 07 UTC: old body as the twin', async () => {
    vi.setSystemTime(Date.parse('2026-10-05T07:55:00Z'))
    put(
      qrow({
        kind: 'proc_rewrite',
        target: 'p',
        evidence: { parameter_set_values: [{ a: 1 }, { a: 2 }] },
        apply: { type: 'proc_body', proc: 'p', body: 'NEW', hash: 'n' },
        undo: { type: 'proc_body', proc: 'p', body: 'OLD', hash: 'o' }
      })
    )
    m.prove.mockImplementation(async () => ({
      passed: false,
      method: 'twin',
      before: {},
      after: {},
      detail: 'rows differ',
      rows_diff: [{ set: 0, added: ['x'], removed: [] }]
    }))
    const out = await runWatch(app)
    expect(m.prove).toHaveBeenCalledTimes(1)
    const args = m.prove.mock.calls[0][0]
    expect(args).toMatchObject({ proc: 'p', oldBody: 'NEW', newBody: 'OLD', timeoutMs: 600_000 })
    expect(args.paramSets).toHaveLength(1)
    expect(out.rolled_back).toBe(1)
    // day 20731 % 2 sets → set #1 (the sets rotate by day); one row added, none removed
    expect(args.paramSets).toEqual([{ a: 2 }])
    expect(m.rollback.mock.calls[0][1].reason).toBe(
      'nightly re-check: parameter set #1 differs from the previous body (+1 / −0 rows)'
    )
  })
  it('a live procedure whose own two runs differ is nondeterministic: listed, never rolled back', async () => {
    vi.setSystemTime(Date.parse('2026-10-05T07:55:00Z'))
    put(
      qrow({
        kind: 'proc_rewrite',
        target: 'p',
        title: 'Busy one',
        evidence: { parameter_set_values: [{ a: 1 }] },
        apply: { type: 'proc_body', proc: 'p', body: 'NEW', hash: 'n' },
        undo: { type: 'proc_body', proc: 'p', body: 'OLD', hash: 'o' }
      })
    )
    // a1 ≠ a2: the twin harness refuses, carrying the unstable set as its rows_diff
    m.prove.mockImplementation(async () => ({
      passed: false,
      method: 'refused',
      before: { sets: 1 },
      after: {},
      detail: 'nondeterministic: results differ between identical runs (set 1)',
      rows_diff: [{ set: 1, added: ['[2]'], removed: ['[1]'] }]
    }))
    const out = await runWatch(app)
    expect(m.rollback).not.toHaveBeenCalled()
    expect(out.rolled_back).toBe(0)
    expect(m.rows.get('w1')?.status).toBe('watching')
    expect(out.actions).toContain(
      're-check nondeterministic: Busy one — nondeterministic: results differ between identical runs (set 1)'
    )
  })
  it('a re-check that is refused or cannot run is listed, not read as a pass', async () => {
    vi.setSystemTime(Date.parse('2026-10-05T07:55:00Z'))
    const proc = {
      kind: 'proc_rewrite' as const,
      target: 'p',
      apply: { type: 'proc_body' as const, proc: 'p', body: 'NEW', hash: 'n' },
      undo: { type: 'proc_body' as const, proc: 'p', body: 'OLD', hash: 'o' }
    }
    put(qrow({ id: 'r1', title: 'Refused one', ...proc }))
    put(qrow({ id: 'r2', title: 'Broken one', ...proc }))
    m.prove
      .mockImplementationOnce(async () => ({
        passed: false,
        method: 'refused',
        before: {},
        after: {},
        detail: 'current body writes to a table'
      }))
      .mockImplementationOnce(async () => {
        throw new Error('pool exhausted')
      })
    const out = await runWatch(app)
    expect(out.rolled_back).toBe(0)
    expect(out.actions).toContain('re-check refused: Refused one — current body writes to a table')
    expect(out.actions).toContain('re-check could not run: Broken one — pool exhausted')
  })
  it('does not re-diff outside 07 UTC', async () => {
    put(
      qrow({
        kind: 'proc_rewrite',
        target: 'p',
        apply: { type: 'proc_body', proc: 'p', body: 'NEW', hash: 'n' },
        undo: { type: 'proc_body', proc: 'p', body: 'OLD', hash: 'o' }
      })
    )
    await runWatch(app)
    expect(m.prove).not.toHaveBeenCalled()
  })
  it('a dry run writes nothing and reports what it would do', async () => {
    put(
      qrow({
        id: 'a',
        proof: {
          passed: true,
          method: 'freshness',
          before: {},
          after: {},
          detail: '',
          watch: s(Array(19).fill(200))
        }
      })
    )
    put(qrow({ id: 'b', watch_until: new Date(NOW - 60_000).toISOString() }))
    m.cacheMs = 200
    const out = await runWatch(app, { dryRun: true })
    expect(out).toMatchObject({ dry_run: true, checked: 2 })
    expect(out.actions.join('\n')).toMatch(/would roll back/)
    expect(out.actions.join('\n')).toMatch(/would finish/)
    expect(m.updateProposal).not.toHaveBeenCalled()
    expect(m.updates).toHaveLength(0)
    expect(m.rollback).not.toHaveBeenCalled()
    expect(m.rows.get('b')?.status).toBe('watching')
  })
})

describe('runWatch — stuck applying sweep', () => {
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
  it('flips a claim whose run ended over 30 minutes ago to failed, without an undo', async () => {
    put(qrow({ id: 's1', status: 'applying', run_id: 5 }))
    m.runs = [{ id: 5, status: 'interrupted', started_at: ago(45), job_id: 'tuning:apply:s1' }]
    const out = await runWatch(app)
    expect(out.stuck).toBe(1)
    expect(m.rows.get('s1')).toMatchObject({
      status: 'failed',
      rollback_reason: 'apply did not finish (process restart?)'
    })
    expect(m.rollback).not.toHaveBeenCalled()
    const write = m.updates.find((u) => u.table === 'nivaro_tuning_proposals')
    expect(write?.where).toMatchObject({ id: 's1', status: 'applying', run_id: 5 })
  })
  it('names a stuck rollback claim as a rollback', async () => {
    put(qrow({ id: 's2', status: 'applying', run_id: 6 }))
    m.runs = [{ id: 6, status: 'completed', started_at: ago(45), job_id: 'tuning:rollback:s2' }]
    await runWatch(app)
    expect(m.rows.get('s2')?.rollback_reason).toBe('rollback did not finish (process restart?)')
  })
  it('never races a live apply: a running run, or a young claim, stays applying', async () => {
    put(qrow({ id: 'live', status: 'applying', run_id: 7 }))
    put(qrow({ id: 'young', status: 'applying', run_id: 8 }))
    m.runs = [
      { id: 7, status: 'running', started_at: ago(300), job_id: 'tuning:apply:live' },
      { id: 8, status: 'error', started_at: ago(5), job_id: 'tuning:apply:young' }
    ]
    const out = await runWatch(app)
    expect(out.stuck).toBe(0)
    expect(m.rows.get('live')?.status).toBe('applying')
    expect(m.rows.get('young')?.status).toBe('applying')
  })
  it('a claim with no run record is timed from the first sighting', async () => {
    put(qrow({ id: 'norun', status: 'applying', run_id: null }))
    await runWatch(app)
    expect(m.rows.get('norun')?.status).toBe('applying')
    vi.setSystemTime(NOW + 61 * 60_000)
    const out = await runWatch(app)
    expect(out.stuck).toBe(1)
    expect(m.rows.get('norun')?.status).toBe('failed')
    expect(m.rows.get('norun')?.rollback_reason).toBe(
      'apply or rollback did not finish (process restart?)'
    )
  })
  it('a re-claim starts its own clock (the first sighting is per claim)', async () => {
    put(qrow({ id: 're', status: 'applying', run_id: null }))
    await runWatch(app)
    // between ticks the claim ended and the row was claimed again (its run row is missing)
    const r = m.rows.get('re')
    if (r) r.run_id = 99
    vi.setSystemTime(NOW + 61 * 60_000)
    expect((await runWatch(app)).stuck).toBe(0)
    expect(m.rows.get('re')?.status).toBe('applying')
    vi.setSystemTime(NOW + 122 * 60_000)
    expect((await runWatch(app)).stuck).toBe(1)
  })
  it('a dry run reports a stuck claim and writes nothing', async () => {
    put(qrow({ id: 'dry', title: 'Dry one', status: 'applying', run_id: 5 }))
    m.runs = [{ id: 5, status: 'interrupted', started_at: ago(45), job_id: 'tuning:apply:dry' }]
    const out = await runWatch(app, { dryRun: true })
    expect(out.stuck).toBe(1)
    expect(out.actions).toContain(
      'would mark failed: Dry one — apply did not finish (process restart?)'
    )
    expect(m.updates).toHaveLength(0)
    expect(m.rows.get('dry')?.status).toBe('applying')
  })
})

describe('tuning readiness', () => {
  const healthyRun = () => [
    {
      id: 1,
      job_id: 'db-tuning-observe',
      status: 'completed',
      started_at: new Date(NOW - 3_600_000).toISOString()
    }
  ]
  it('registers as db-tuning in Operations', () => {
    registerTuningReadiness()
    expect(m.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'db-tuning', group: 'Operations' })
    )
  })
  it('passes while database tuning is off', async () => {
    m.settings = { ...m.settings, enabled: false }
    m.twins = [{ name: 'p__tune' }]
    expect(await tuningReadiness()).toMatchObject({ status: 'pass' })
  })
  it('passes when healthy', async () => {
    m.runs = healthyRun()
    put(qrow())
    const r = await tuningReadiness()
    expect(r.status).toBe('pass')
    expect(r.detail).toMatch(/1 change\(s\) under watch/)
  })
  it('a read the check cannot make is a warning, never a throw', async () => {
    m.rawError = 'VIEW DEFINITION permission denied'
    expect(await tuningReadiness()).toEqual({
      status: 'warn',
      detail: 'Database tuning check could not run: VIEW DEFINITION permission denied'
    })
  })
  it('fails on a twin procedure older than a day, naming it', async () => {
    m.runs = healthyRun()
    m.twins = [{ name: 'spend_by_zone__tune' }]
    const r = await tuningReadiness()
    expect(r.status).toBe('fail')
    expect(r.blockers?.join('\n')).toMatch(/spend_by_zone__tune/)
  })
  it('matches every twin name form, and only twin names', async () => {
    m.runs = healthyRun()
    m.twins = [{ name: 'spend_by_zone__tune_0a1b2c3d' }, { name: 'spend__tuner' }]
    const r = await tuningReadiness()
    expect(r.status).toBe('fail')
    expect(r.blockers?.join('\n')).toMatch(/spend_by_zone__tune_0a1b2c3d/)
    expect(r.blockers?.join('\n')).not.toMatch(/spend__tuner/)
    expect(m.rawSql.some((sql) => sql.includes("LIKE '%[_][_]tune%'"))).toBe(true)
  })
  it('warns when the observe run is older than 48 h, or has never run', async () => {
    m.runs = [{ ...healthyRun()[0], started_at: new Date(NOW - 49 * 3_600_000).toISOString() }]
    expect(await tuningReadiness()).toMatchObject({
      status: 'warn',
      detail: expect.stringMatching(/49 h/)
    })
    m.runs = []
    expect(await tuningReadiness()).toMatchObject({
      status: 'warn',
      detail: expect.stringMatching(/not run/)
    })
  })
  it('warns on a row watching a day past its window, a stuck claim and a failed row', async () => {
    m.runs = [
      ...healthyRun(),
      {
        id: 9,
        status: 'interrupted',
        started_at: new Date(NOW - 45 * 60_000).toISOString(),
        job_id: 'tuning:apply:st'
      }
    ]
    put(
      qrow({
        id: 'late',
        title: 'Late one',
        watch_until: new Date(NOW - 26 * 3_600_000).toISOString()
      })
    )
    put(qrow({ id: 'st', title: 'Stuck one', status: 'applying', run_id: 9 }))
    put(
      qrow({
        id: 'bad',
        title: 'Broken one',
        status: 'failed',
        rollback_reason: 'rollback refused: x'
      })
    )
    const r = await tuningReadiness()
    expect(r.status).toBe('warn')
    const text = r.blockers?.join('\n') ?? ''
    expect(text).toMatch(/Late one/)
    expect(text).toMatch(/Stuck one/)
    expect(text).toMatch(/Broken one.*rollback refused/)
  })
})
