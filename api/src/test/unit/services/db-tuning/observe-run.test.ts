// api/src/test/unit/services/db-tuning/observe-run.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OBSERVER_TIMEOUT_MS } from '../../../../services/db-tuning/deadline.js'
import { fingerprintOf } from '../../../../services/db-tuning/ledger.js'

const targetKey = (c: { kind: string }, target: string) => `${c.kind}|${target.toLowerCase()}`

import {
  AI_BUDGET,
  isObserveRunning,
  PROOF_BUDGET,
  runObserve,
  selectForProof,
  WALL_MS
} from '../../../../services/db-tuning/observe-run.js'
import {
  listTuningObservers,
  registerTuningObserver,
  runExtensionObservers,
  unregisterTuningObservers
} from '../../../../services/db-tuning/observers/registry.js'
import { bodyHash } from '../../../../services/db-tuning/twin.js'
import type { Candidate, ProofResult } from '../../../../services/db-tuning/types.js'

const m = vi.hoisted(() => ({
  settings: {
    enabled: true,
    ai_rewrites: true,
    min_estimate_ms_per_day: 50,
    watch_days: 7,
    regression_pct: 25,
    proc_timeout_minutes: 10,
    ai_daily_budget_usd: 2
  },
  startJobRun: vi.fn(),
  decision: vi.fn(async (_fp: string): Promise<'insert' | 'update' | 'quiet'> => 'insert'),
  upsertProposal: vi.fn(),
  touchSeen: vi.fn(async (_fps: string[]) => 0),
  closeUnseen: vi.fn(async () => 0),
  loadIndexCreate: vi.fn(async (): Promise<unknown> => ({})),
  prove: vi.fn(),
  aiBudgetAllows: vi.fn(async () => true),
  aiRewriteCandidate: vi.fn(),
  mechanical: vi.fn(
    (_body: string) => null as null | { body: string; notes: string[]; applied: string[] }
  ),
  indexCreate: vi.fn((): Candidate[] => []),
  procSelections: vi.fn((): unknown[] => []),
  tenant: undefined as string | undefined,
  /** `running` db-tuning-observe job rows started in the last 70 minutes */
  inFlight: 0,
  wheres: [] as unknown[][],
  inFlightTargets: vi.fn(async () => new Set<string>())
}))

vi.mock('../../../../db/tenant-context.js', () => ({ getTenantId: () => m.tenant }))

vi.mock('../../../../db/index.js', () => {
  const chain = () => {
    let counted = false
    const q: Record<string, unknown> = {
      where: (...args: unknown[]) => {
        m.wheres.push(args)
        return q
      },
      orderBy: () => q,
      count: () => {
        counted = true
        return q
      },
      first: async () => (counted ? { n: m.inFlight } : undefined)
    }
    return q
  }
  return { db: Object.assign(() => chain(), { raw: async () => [] }) }
})
vi.mock('../../../../services/db-tuning/settings.js', () => ({
  readTuningSettings: async () => m.settings
}))
vi.mock('../../../../services/job-runs.js', () => ({ startJobRun: m.startJobRun }))
vi.mock('../../../../services/db-tuning/ledger.js', async (orig) => ({
  ...(await orig<typeof import('../../../../services/db-tuning/ledger.js')>()),
  ledgerDecision: m.decision,
  inFlightTargets: m.inFlightTargets,
  upsertProposal: m.upsertProposal,
  touchSeen: m.touchSeen,
  closeUnseen: m.closeUnseen
}))
vi.mock('../../../../services/db-tuning/proof.js', () => ({ prove: m.prove }))
vi.mock('../../../../services/db-tuning/rewrites/ai.js', () => ({
  aiBudgetAllows: m.aiBudgetAllows,
  aiRewriteCandidate: m.aiRewriteCandidate
}))
vi.mock('../../../../services/db-tuning/observers/index-create.js', () => ({
  loadIndexCreateEvidence: m.loadIndexCreate,
  observeIndexCreate: m.indexCreate
}))
vi.mock('../../../../services/db-tuning/observers/index-drop.js', () => ({
  loadIndexDropEvidence: async () => {
    throw new Error('dmv unreadable')
  },
  observeIndexDrop: () => []
}))
vi.mock('../../../../services/db-tuning/observers/rollup-store.js', () => ({
  loadRollupEvidence: async () => ({}),
  observeRollupStore: () => []
}))
vi.mock('../../../../services/db-tuning/observers/query-cache.js', () => ({
  loadQueryCacheEvidence: async () => ({}),
  observeQueryCache: () => []
}))
vi.mock('../../../../services/db-tuning/observers/proc-rewrite.js', async (orig) => ({
  ...(await orig<typeof import('../../../../services/db-tuning/observers/proc-rewrite.js')>()),
  loadProcEvidence: async () => ({}),
  selectProcCandidates: m.procSelections,
  mechanicalProcRewrite: m.mechanical
}))

const c = (kind: Candidate['kind'], est: number): Candidate => ({
  kind,
  target: `${kind}-${est}`,
  change_key: 'k',
  title: 't',
  evidence: {},
  estimate_ms_per_day: est,
  risk: 'reversible',
  apply: { type: 'sql', statements: [] },
  undo: { type: 'sql', statements: [] }
})

describe('selectForProof', () => {
  it('takes the biggest estimates up to the budget and counts the carry-over', () => {
    const r = selectForProof(
      [
        c('index_create', 100),
        c('query_cache', 9000),
        c('rollup_store', 7000),
        c('index_drop', 20)
      ],
      2,
      50
    )
    expect(r.chosen.map((x) => x.estimate_ms_per_day)).toEqual([9000, 7000])
    expect(r.carried).toBe(1) // the 100 is carried; the 20 is below the floor and dropped
  })
  it('keeps proc rewrites regardless of the floor (their estimate is a lower bound) but still inside the budget', () => {
    const r = selectForProof([c('proc_rewrite', 0), c('query_cache', 9000)], 5, 50)
    expect(r.chosen).toHaveLength(2)
  })
  it('a proc rewrite still competes for the budget', () => {
    const r = selectForProof([c('proc_rewrite', 0), c('query_cache', 9000)], 1, 50)
    expect(r.chosen.map((x) => x.kind)).toEqual(['query_cache'])
    expect(r.carried).toBe(1)
  })
})

const body = {
  type: 'proc_body' as const,
  proc: 'rpt',
  body: 'CREATE PROC rpt AS SELECT 1',
  hash: 'h'
}

describe('tuning observer registry', () => {
  afterEach(() => unregisterTuningObservers())
  it('refuses a malformed id, a missing observe() and an unknown kind', () => {
    const observe = async () => []
    expect(() =>
      registerTuningObserver({ id: 'nocolon', kind: 'index_create', observe }, 'x')
    ).toThrow(/<owner>:<name>/)
    expect(() => registerTuningObserver({ id: 'x:a', kind: 'index_create' } as never, 'x')).toThrow(
      /observe/
    )
    expect(() =>
      registerTuningObserver({ id: 'x:a', kind: 'bogus' as never, observe }, 'x')
    ).toThrow(/kind/)
    registerTuningObserver({ id: 'x:a', kind: 'query_cache', observe }, 'x')
    expect(listTuningObservers()).toEqual([{ id: 'x:a', owner: 'x', kind: 'query_cache' }])
  })
  it('stamps the kind, its risk and the observer; a throwing observer is skipped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerTuningObserver(
      {
        id: 'x:boom',
        kind: 'index_create',
        observe: async () => {
          throw new Error('nope')
        }
      },
      'x'
    )
    registerTuningObserver(
      {
        id: 'x:ok',
        kind: 'proc_rewrite',
        observe: async () => [
          { ...c('index_create', 10), risk: 'reversible' as const, apply: body, undo: body },
          { bad: true } as never
        ]
      },
      'x'
    )
    const out = await runExtensionObservers()
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'proc_rewrite',
      risk: 'review',
      evidence: { observer: 'x:ok' }
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('x:boom'))
    warn.mockRestore()
  })
  it("drops a candidate whose apply or undo is not its kind's shape", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sql = { type: 'sql' as const, statements: ['DROP TABLE t'] }
    registerTuningObserver(
      {
        id: 'x:mix',
        kind: 'proc_rewrite',
        observe: async () => [
          { ...c('proc_rewrite', 1), apply: sql, undo: body },
          { ...c('proc_rewrite', 2), apply: body, undo: sql },
          { ...c('proc_rewrite', 3), apply: body, undo: body }
        ]
      },
      'x'
    )
    registerTuningObserver(
      {
        id: 'x:idx',
        kind: 'index_create',
        observe: async () => [{ ...c('index_create', 4), apply: body, undo: sql }]
      },
      'x'
    )
    const out = await runExtensionObservers()
    expect(out.map((x) => x.estimate_ms_per_day)).toEqual([3])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed'))
    warn.mockRestore()
  })
  it('an observer past its time slot is skipped; a spent budget calls nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hang = vi.fn(() => new Promise<never>(() => {}))
    registerTuningObserver({ id: 'x:hang', kind: 'index_create', observe: hang }, 'x')
    registerTuningObserver(
      { id: 'x:fine', kind: 'index_create', observe: async () => [c('index_create', 7)] },
      'x'
    )
    expect(await runExtensionObservers(() => 5)).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('x:hang'))
    hang.mockClear()
    expect(await runExtensionObservers(() => 0)).toEqual([])
    expect(hang).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

const pass = (extra: Partial<ProofResult> = {}): ProofResult => ({
  passed: true,
  method: 'usage-stats',
  before: {},
  after: {},
  detail: 'ok',
  ...extra
})
const handle = () => ({
  id: 77,
  progress: vi.fn(),
  complete: vi.fn(async () => {}),
  fail: vi.fn(async () => {})
})

describe('runObserve', () => {
  beforeEach(() => {
    m.settings.enabled = true
    m.settings.ai_rewrites = true
    m.startJobRun.mockReset().mockImplementation(async () => handle())
    m.upsertProposal.mockReset().mockImplementation(async () => ({ id: 'p', action: 'inserted' }))
    m.prove.mockReset().mockImplementation(async () => pass())
    m.decision.mockReset().mockImplementation(async () => 'insert')
    m.touchSeen.mockReset().mockImplementation(async () => 0)
    m.closeUnseen.mockReset().mockImplementation(async () => 0)
    m.loadIndexCreate.mockReset().mockImplementation(async () => ({}))
    m.aiBudgetAllows.mockReset().mockImplementation(async () => true)
    m.aiRewriteCandidate.mockReset().mockImplementation(async () => null)
    m.mechanical.mockReset().mockImplementation(() => null)
    m.indexCreate.mockReset().mockImplementation(() => [])
    m.procSelections.mockReset().mockImplementation(() => [])
    m.inFlight = 0
    m.wheres = []
    m.inFlightTargets.mockReset().mockImplementation(async () => new Set<string>())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('returns at once while db_tuning.enabled is off — no run, no evidence read', async () => {
    m.settings.enabled = false
    const r = await runObserve({ trigger: 'run-now' })
    expect(r.skipped).toBe('disabled')
    expect(m.startJobRun).not.toHaveBeenCalled()
    expect(m.indexCreate).not.toHaveBeenCalled()
  })

  it('a scheduled run rides the cron row; run-now opens its own tuning run', async () => {
    await runObserve({ trigger: 'schedule' })
    expect(m.startJobRun).not.toHaveBeenCalled()
    await runObserve({ trigger: 'run-now', userId: 'u1' })
    expect(m.startJobRun).toHaveBeenCalledWith(
      'tuning',
      'db-tuning-observe',
      expect.objectContaining({ triggeredBy: 'u1', trigger: 'run-now' })
    )
  })

  it('a dry run proves and writes nothing', async () => {
    m.indexCreate.mockImplementation(() => [c('index_create', 9000)])
    const r = await runObserve({ dryRun: true })
    expect(r.by_kind).toEqual({ index_create: 1 })
    expect(m.prove).not.toHaveBeenCalled()
    expect(m.upsertProposal).not.toHaveBeenCalled()
    expect(m.closeUnseen).not.toHaveBeenCalled()
    expect(m.startJobRun).not.toHaveBeenCalled()
  })

  it('proves at most PROOF_BUDGET, carries the rest, and skips quiet or in-flight fingerprints', async () => {
    const many = Array.from({ length: PROOF_BUDGET + 3 }, (_, i) => ({
      ...c('index_create', 1000 + i),
      target: `t${i}`
    }))
    m.indexCreate.mockImplementation(() => many)
    m.decision.mockImplementationOnce(async () => 'quiet')
    const r = await runObserve({ trigger: 'schedule' })
    expect(m.prove).toHaveBeenCalledTimes(PROOF_BUDGET)
    expect(r.quiet).toBe(1)
    expect(r.carried_over).toBe(2)
    expect(r.proposed).toBe(PROOF_BUDGET)
  })

  it('25 candidates over a budget of 20: all 25 stay seen before closeUnseen runs', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...c('index_create', 1000 + i),
      target: `t${i}`
    }))
    m.indexCreate.mockImplementation(() => many)
    const r = await runObserve({ trigger: 'schedule' })
    expect(r.carried_over).toBe(5)
    expect(m.touchSeen).toHaveBeenCalledOnce()
    const touched = m.touchSeen.mock.calls[0][0]
    expect(new Set(touched)).toEqual(new Set(many.map((x) => fingerprintOf(x))))
    expect(m.touchSeen.mock.invocationCallOrder[0]).toBeLessThan(
      m.closeUnseen.mock.invocationCallOrder[0]
    )
  })

  it('a dry run touches nothing', async () => {
    m.indexCreate.mockImplementation(() => [c('index_create', 9000)])
    await runObserve({ dryRun: true })
    expect(m.touchSeen).not.toHaveBeenCalled()
  })

  it('the counts reconcile: duplicates, quiet, below the floor, carried, proved', async () => {
    const big = Array.from({ length: PROOF_BUDGET + 1 }, (_, i) => ({
      ...c('index_create', 1000 + i),
      target: `t${i}`
    }))
    m.indexCreate.mockImplementation(() => [
      ...big,
      big[0],
      c('index_drop', 10),
      c('rollup_store', 5000)
    ])
    m.decision.mockImplementation(async (fp) =>
      fp === fingerprintOf(c('rollup_store', 5000)) ? 'quiet' : 'insert'
    )
    const r = await runObserve({ trigger: 'schedule' })
    expect(r).toMatchObject({
      candidates: 24,
      duplicates: 1,
      quiet: 1,
      below_floor: 1,
      carried_over: 1,
      proved: PROOF_BUDGET
    })
    expect(r.duplicates + r.quiet + r.below_floor + r.carried_over + r.proved).toBe(r.candidates)
  })

  it('an errored proof on a standing proposal counts as kept, not rejected', async () => {
    m.indexCreate.mockImplementation(() => [c('index_create', 9000)])
    m.prove.mockImplementation(async () => ({
      ...pass(),
      passed: false,
      method: 'refused',
      detail: 'error: proof could not run: x'
    }))
    m.upsertProposal.mockImplementation(async () => ({ id: 'p', action: 'kept' }))
    const r = await runObserve({ trigger: 'schedule' })
    expect(r).toMatchObject({ kept: 1, rejected: 0, proposed: 0 })
  })

  it('a second run while one is proving is refused as already running', async () => {
    m.indexCreate.mockImplementation(() => [c('index_create', 9000)])
    let release: (p: ProofResult) => void = () => {}
    m.prove.mockImplementation(
      () =>
        new Promise<ProofResult>((res) => {
          release = res
        })
    )
    const first = runObserve({ trigger: 'schedule' })
    await vi.waitFor(() => expect(m.prove).toHaveBeenCalled())
    expect((await runObserve({ trigger: 'run-now' })).skipped).toBe('already running')
    // a dry run neither takes nor waits for the lock
    expect((await runObserve({ dryRun: true })).skipped).toBeUndefined()
    release(pass())
    expect((await first).proposed).toBe(1)
    m.prove.mockImplementation(async () => pass())
    expect((await runObserve({ trigger: 'schedule' })).skipped).toBeUndefined()
  })

  it('a target with a change in flight is left alone, whatever the new change', async () => {
    m.indexCreate.mockImplementation(() => [
      { ...c('index_create', 9000), target: 'orders.customer_id', change_key: 'other' },
      { ...c('index_create', 8000), target: 'orders.status' }
    ])
    m.inFlightTargets.mockImplementation(
      async () => new Set([targetKey(c('index_create', 0), 'orders.customer_id')])
    )
    const r = await runObserve({ trigger: 'schedule' })
    expect(m.prove).toHaveBeenCalledOnce()
    expect(m.prove.mock.calls[0][0]).toMatchObject({ target: 'orders.status' })
    expect(r).toMatchObject({ candidates: 2, quiet: 1, proved: 1 })
  })

  it('refuses while a fresh running observe row exists anywhere (another process)', async () => {
    m.indexCreate.mockImplementation(() => [c('index_create', 9000)])
    m.inFlight = 1
    const r = await runObserve({ trigger: 'run-now', userId: 'u1' })
    expect(r.skipped).toBe('running')
    expect(m.startJobRun).not.toHaveBeenCalled()
    expect(m.prove).not.toHaveBeenCalled()
    const since = m.wheres.find((w) => w[0] === 'started_at')
    expect(since?.[1]).toBe('>')
    expect(Date.now() - (since?.[2] as Date).getTime()).toBeGreaterThanOrEqual(70 * 60_000 - 1000)
    expect(Date.now() - (since?.[2] as Date).getTime()).toBeLessThanOrEqual(70 * 60_000 + 1000)
    expect(m.wheres).toContainEqual([{ job_id: 'db-tuning-observe', status: 'running' }])
    // the lock is released: the next run (nothing else in flight) goes ahead
    m.inFlight = 0
    expect((await runObserve({ trigger: 'run-now' })).skipped).toBeUndefined()
  })
  it('a scheduled run counts its own cron row: only a second one holds it', async () => {
    m.indexCreate.mockImplementation(() => [c('index_create', 9000)])
    m.inFlight = 1
    expect((await runObserve({ trigger: 'schedule' })).skipped).toBeUndefined()
    m.inFlight = 2
    expect((await runObserve({ trigger: 'schedule' })).skipped).toBe('running')
  })
  it("one tenant's run in flight does not hold another tenant's run", async () => {
    m.indexCreate.mockImplementation(() => [c('index_create', 9000)])
    let release: (p: ProofResult) => void = () => {}
    m.prove.mockImplementation(
      () =>
        new Promise<ProofResult>((res) => {
          release = res
        })
    )
    try {
      m.tenant = 'a'
      const first = runObserve({ trigger: 'schedule' })
      await vi.waitFor(() => expect(m.prove).toHaveBeenCalled())
      expect(isObserveRunning()).toBe(true)
      m.tenant = 'b'
      expect(isObserveRunning()).toBe(false)
      m.prove.mockImplementation(async () => pass())
      expect((await runObserve({ trigger: 'schedule' })).skipped).toBeUndefined()
      m.tenant = 'a'
      expect((await runObserve({ trigger: 'run-now' })).skipped).toBe('already running')
      release(pass())
      await first
      expect(isObserveRunning()).toBe(false)
    } finally {
      m.tenant = undefined
    }
  })

  it('past the 60-minute wall the remaining chosen candidates carry over', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    m.indexCreate.mockImplementation(() => [
      c('index_create', 9000),
      c('query_cache', 8000),
      c('rollup_store', 7000)
    ])
    m.prove.mockImplementation(async () => {
      now += WALL_MS + 1
      return pass()
    })
    const r = await runObserve({ trigger: 'schedule' })
    expect(m.prove).toHaveBeenCalledOnce()
    expect(r).toMatchObject({ proved: 1, carried_over: 2 })
    expect(m.touchSeen.mock.calls[0][0]).toHaveLength(3)
  })

  it('an observer whose evidence read hangs is cut off at 10 minutes and the rest still run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      m.loadIndexCreate.mockImplementation(() => new Promise(() => {}))
      const sel = {
        proc: 'rpt',
        body: 'CREATE PROC rpt AS SELECT 1',
        stat: {
          name: 'rpt',
          execution_count: 70,
          avg_elapsed_ms: 3000,
          total_elapsed_ms: 210000,
          cached_days: 7
        },
        paramSets: [{}],
        planOps: [],
        replicated: false
      }
      m.procSelections.mockImplementation(() => [sel])
      m.mechanical.mockImplementation(() => ({
        body: 'CREATE PROC rpt AS SELECT 2',
        notes: [],
        applied: ['x']
      }))
      const p = runObserve({ trigger: 'schedule' })
      await vi.advanceTimersByTimeAsync(OBSERVER_TIMEOUT_MS)
      const r = await p
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /index_create observer failed: index_create evidence took longer than 600 s/
        )
      )
      expect(r.by_kind).toEqual({ proc_rewrite: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ties break on kind, target and change_key, whatever order the observers gave', () => {
    const a = { ...c('index_create', 500), target: 'b' }
    const b = { ...c('index_create', 500), target: 'a' }
    const q = { ...c('query_cache', 500), target: 'a' }
    expect(selectForProof([q, a, b], 2, 0).chosen.map((x) => `${x.kind}:${x.target}`)).toEqual([
      'index_create:a',
      'index_create:b'
    ])
    expect(selectForProof([b, q, a], 2, 0).chosen.map((x) => `${x.kind}:${x.target}`)).toEqual([
      'index_create:a',
      'index_create:b'
    ])
  })

  it('a rows_diff proof is stored as a rejection, with the proof', async () => {
    m.indexCreate.mockImplementation(() => [c('index_create', 9000)])
    const failed: ProofResult = {
      passed: false,
      method: 'twin',
      before: {},
      after: {},
      detail: 'the original multiplies rows the rewrite keeps once',
      rows_diff: [{ set: 0, added: [], removed: ['x'] }]
    }
    m.prove.mockImplementation(async () => failed)
    const r = await runObserve({ trigger: 'run-now' })
    expect(m.upsertProposal).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'index_create' }),
      failed,
      77
    )
    expect(r.rejected).toBe(1)
    expect(r.proposed).toBe(0)
  })

  it('caps AI rewrites at AI_BUDGET and skips AI when the budget says no', async () => {
    const sel = (i: number) => ({
      proc: `p${i}`,
      body: `CREATE PROC p${i} AS SELECT ${i}`,
      stat: {
        name: `p${i}`,
        execution_count: 70,
        avg_elapsed_ms: 3000,
        total_elapsed_ms: 210000,
        cached_days: 7
      },
      paramSets: [{}],
      planOps: [],
      replicated: false
    })
    m.procSelections.mockImplementation(() =>
      Array.from({ length: AI_BUDGET + 2 }, (_, i) => sel(i))
    )
    await runObserve({ trigger: 'schedule' })
    expect(m.aiRewriteCandidate).toHaveBeenCalledTimes(AI_BUDGET)
    m.aiRewriteCandidate.mockClear()
    m.aiBudgetAllows.mockImplementation(async () => false)
    await runObserve({ trigger: 'schedule' })
    expect(m.aiRewriteCandidate).not.toHaveBeenCalled()
  })

  it('an AI rewrite is keyed by the body it rewrites, and not asked again while that key is quiet', async () => {
    const sel = {
      proc: 'rpt',
      body: 'CREATE PROC rpt AS SELECT 1',
      stat: {
        name: 'rpt',
        execution_count: 70,
        avg_elapsed_ms: 3000,
        total_elapsed_ms: 210000,
        cached_days: 7
      },
      paramSets: [{}],
      planOps: [],
      replicated: false
    }
    m.procSelections.mockImplementation(() => [sel])
    let n = 0
    m.aiRewriteCandidate.mockImplementation(async () => ({
      body: `CREATE PROC rpt AS SELECT ${++n + 1}`,
      notes: ['AI-written']
    }))
    await runObserve({ trigger: 'schedule' })
    const first = m.upsertProposal.mock.calls[0]?.[0] as Candidate
    expect(first.change_key).toBe(`ai:${bodyHash(sel.body)}`)
    // tonight's different AI body is the same attempt on the same live body
    m.upsertProposal.mockClear()
    await runObserve({ trigger: 'schedule' })
    expect((m.upsertProposal.mock.calls[0]?.[0] as Candidate).change_key).toBe(first.change_key)
    // its rejection is quiet: the AI is not asked again
    m.aiRewriteCandidate.mockClear()
    const fp = fingerprintOf(first)
    m.decision.mockImplementation(async (f) => (f === fp ? 'quiet' : 'insert'))
    await runObserve({ trigger: 'schedule' })
    expect(m.aiRewriteCandidate).not.toHaveBeenCalled()
  })

  it('a passed proc rewrite carries the measured saving as its estimate', async () => {
    const sel = {
      proc: 'rpt',
      body: 'CREATE PROC rpt AS SELECT 1',
      stat: {
        name: 'rpt',
        execution_count: 70,
        avg_elapsed_ms: 3000,
        total_elapsed_ms: 210000,
        cached_days: 7
      },
      paramSets: [{}],
      planOps: [],
      replicated: false
    }
    m.procSelections.mockImplementation(() => [sel])
    m.mechanical.mockImplementation(() => ({
      body: 'CREATE PROC rpt AS SELECT 2',
      notes: [],
      applied: ['junction-exists']
    }))
    m.prove.mockImplementation(async () =>
      pass({ method: 'twin', before: { median_ms: 3000 }, after: { median_ms: 1000 } })
    )
    await runObserve({ trigger: 'schedule' })
    const stored = m.upsertProposal.mock.calls[0]?.[0] as Candidate
    expect(stored.kind).toBe('proc_rewrite')
    expect(stored.estimate_ms_per_day).toBe(2000 * 10) // 2 s saved × 10 runs/day
    expect(m.aiRewriteCandidate).not.toHaveBeenCalled()
  })

  it('a failing observer is logged and the rest still run', async () => {
    m.indexCreate.mockImplementation(() => [c('index_create', 9000)])
    const r = await runObserve({ trigger: 'schedule' })
    expect(r.proposed).toBe(1)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('index_drop'))
  })
})
