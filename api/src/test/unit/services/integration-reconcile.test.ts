import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import {
  allObligationKinds,
  bustObligationsEpochCache,
  clearObligationKinds,
  registerObligationKind
} from '../../../services/integration-obligations.js'
import {
  decideReconcile,
  dryRunIntegrationReconcile,
  reconcileKind,
  runIntegrationReconcile,
  runIntegrationReconcileForCron
} from '../../../services/integration-reconcile.js'

const now = new Date('2026-09-22T12:00:00Z')
const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000)
const expected = { item: '1', due_at: minsAgo(90) }
const grace = { ackGraceMinutes: 60, skipGraceMinutes: 30 }

describe('decideReconcile', () => {
  it('writes missing when the partner is behind and no trigger ever fired', () => {
    const d = decideReconcile({ expected, latest: null, now, ...grace })
    expect(d.outcome).toBe('missing')
    expect(d.obligation_id).toBeNull()
    expect(d.reason).toMatch(/no send was ever attempted/)
  })

  it('turns a stale skip into overdue and keeps the original reason', () => {
    const d = decideReconcile({
      expected,
      latest: {
        id: 7,
        outcome: 'skipped',
        reason: 'guard unmet: is_on_hold = true',
        due_at: minsAgo(90),
        resolved_at: minsAgo(90)
      },
      now,
      ...grace
    })
    expect(d.outcome).toBe('overdue')
    expect(d.obligation_id).toBe(7)
    expect(d.reason).toBe(
      'skipped: guard unmet: is_on_hold = true — but the partner still lacks it'
    )
  })

  it('leaves a fresh skip alone — the mechanism gets its window', () => {
    const d = decideReconcile({
      expected,
      latest: {
        id: 7,
        outcome: 'skipped',
        reason: 'guard unmet',
        due_at: minsAgo(5),
        resolved_at: minsAgo(5)
      },
      now,
      ...grace
    })
    expect(d.outcome).toBe('none')
  })

  it('turns an unacknowledged pending into overdue past the ack grace', () => {
    const d = decideReconcile({
      expected,
      latest: { id: 9, outcome: 'pending', reason: null, due_at: minsAgo(75), resolved_at: null },
      now,
      ...grace
    })
    expect(d.outcome).toBe('overdue')
    expect(d.reason).toMatch(/no acknowledgement in 60 minutes/)
  })

  it('leaves a pending inside the ack grace alone', () => {
    const d = decideReconcile({
      expected,
      latest: { id: 9, outcome: 'pending', reason: null, due_at: minsAgo(10), resolved_at: null },
      now,
      ...grace
    })
    expect(d.outcome).toBe('none')
  })

  it('never churns a failed row — remediation owns it', () => {
    const d = decideReconcile({
      expected,
      latest: {
        id: 4,
        outcome: 'failed',
        reason: 'HTTP 500',
        due_at: minsAgo(600),
        resolved_at: null
      },
      now,
      ...grace
    })
    expect(d.outcome).toBe('none')
  })

  it('flags a sent row whose expectation still holds — it did not take', () => {
    const d = decideReconcile({
      expected,
      latest: {
        id: 5,
        outcome: 'sent',
        reason: null,
        due_at: minsAgo(600),
        resolved_at: minsAgo(600)
      },
      now,
      ...grace
    })
    expect(d.outcome).toBe('overdue')
    expect(d.reason).toMatch(/recorded as sent/)
  })

  it('supersedes an open row once the expectation is gone', () => {
    const d = decideReconcile({
      expected: null,
      latest: { id: 6, outcome: 'overdue', reason: 'x', due_at: minsAgo(600), resolved_at: null },
      now,
      ...grace
    })
    expect(d.outcome).toBe('superseded')
    expect(d.obligation_id).toBe(6)
  })

  it('leaves a closed row alone when the expectation is gone', () => {
    const d = decideReconcile({
      expected: null,
      latest: {
        id: 6,
        outcome: 'sent',
        reason: null,
        due_at: minsAgo(600),
        resolved_at: minsAgo(600)
      },
      now,
      ...grace
    })
    expect(d.outcome).toBe('none')
  })

  it('does nothing at all when there is neither an expectation nor a row', () => {
    const d = decideReconcile({ expected: null, latest: null, now, ...grace })
    expect(d.outcome).toBe('none')
  })

  // Boundary: age === the grace minute itself. Pinned to the current `<`
  // semantics (equality reads as past-grace) so a future refactor that
  // silently swaps `<` for `<=` shows up here rather than shipping quietly.
  it('treats an age exactly equal to the ack grace as past it — overdue, not none', () => {
    const d = decideReconcile({
      expected,
      latest: { id: 9, outcome: 'pending', reason: null, due_at: minsAgo(60), resolved_at: null },
      now,
      ...grace
    })
    expect(d.outcome).toBe('overdue')
  })

  it('treats an age exactly equal to the skip grace as past it — overdue, not none', () => {
    const d = decideReconcile({
      expected,
      latest: {
        id: 7,
        outcome: 'skipped',
        reason: 'guard unmet',
        due_at: minsAgo(30),
        resolved_at: minsAgo(30)
      },
      now,
      ...grace
    })
    expect(d.outcome).toBe('overdue')
  })
})

// ─── The db-writing surface ────────────────────────────────────────────────
// db is already mocked in src/test/setup.ts — db(table) is a vi.fn() whose
// return value each test overrides with its own fake query chain, mirroring
// the pattern already established in src/test/unit/services/integration-
// obligations.test.ts.

const mockedDb = () => vi.mocked(db as unknown as (table: string) => unknown)

const base = {
  api: 'Partner',
  collection: 'workflows',
  label: 'x'
}

describe('runIntegrationReconcile / dryRunIntegrationReconcile / runIntegrationReconcileForCron — zero kinds registered', () => {
  beforeEach(() => clearObligationKinds())
  afterEach(() => vi.clearAllMocks())

  it('runIntegrationReconcile writes nothing and reports all-zero counts', async () => {
    mockedDb().mockClear()
    const r = await runIntegrationReconcile()
    expect(r).toEqual({
      kinds: 0,
      missing: 0,
      overdue: 0,
      superseded: 0,
      errors: [],
      failed: 0
    })
    expect(db).not.toHaveBeenCalled()
  })

  it('dryRunIntegrationReconcile reports "0 kinds" without touching the db', async () => {
    mockedDb().mockClear()
    const r = await dryRunIntegrationReconcile()
    expect(r).toEqual({ kinds: 0, behind: [] })
    expect(db).not.toHaveBeenCalled()
  })

  it('runIntegrationReconcileForCron completes without throwing and never warns', async () => {
    mockedDb().mockClear()
    const warn = vi.fn()
    const fakeApp = { log: { warn } } as unknown as Parameters<
      typeof runIntegrationReconcileForCron
    >[0]
    const r = await runIntegrationReconcileForCron(fakeApp)
    expect(r).toEqual({ kinds: 0, missing: 0, overdue: 0, superseded: 0, errors: [], failed: 0 })
    expect(warn).not.toHaveBeenCalled()
    expect(db).not.toHaveBeenCalled()
  })
})

describe('runIntegrationReconcileForCron — total-failure visibility', () => {
  beforeEach(() => clearObligationKinds())
  afterEach(() => vi.clearAllMocks())

  it('logs every error but does not throw when only some kinds failed', async () => {
    registerObligationKind({
      ...base,
      kind: 'wf.ok',
      expect: async () => []
    })
    registerObligationKind({
      ...base,
      kind: 'wf.broken',
      expect: async () => {
        throw new Error('connection refused')
      }
    })
    mockedDb().mockClear()
    const warn = vi.fn()
    const fakeApp = { log: { warn } } as unknown as Parameters<
      typeof runIntegrationReconcileForCron
    >[0]

    const r = await runIntegrationReconcileForCron(fakeApp)

    expect(r).toMatchObject({
      kinds: 2,
      failed: 1,
      errors: ['wf.broken: connection refused']
    })
    expect(warn).toHaveBeenCalledWith(
      { err: 'wf.broken: connection refused' },
      'integration reconcile: a kind reported an error'
    )
  })

  it('throws when every registered kind failed, so the job run records as failed', async () => {
    registerObligationKind({
      ...base,
      kind: 'wf.broken.one',
      expect: async () => {
        throw new Error('timeout')
      }
    })
    registerObligationKind({
      ...base,
      kind: 'wf.broken.two',
      expect: async () => {
        throw new Error('auth failed')
      }
    })
    mockedDb().mockClear()
    const warn = vi.fn()
    const fakeApp = { log: { warn } } as unknown as Parameters<
      typeof runIntegrationReconcileForCron
    >[0]

    await expect(runIntegrationReconcileForCron(fakeApp)).rejects.toThrow(
      /every registered kind failed/
    )
    // Both failures were still logged before the throw — a total outage is
    // loud, not just failed.
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('a kind that only truncated does not count as failed and never throws', async () => {
    // 20,001 raw entries exercises the real EXPECT_CEILING boundary (a genuine
    // "20,001 > 20,000" comparison, not a stubbed flag) without a 20,000-item
    // write storm: every entry names the SAME item, so `byItem` — a Map keyed
    // on item — collapses them to one row after slicing. `truncated` is
    // computed from the raw (pre-dedup, pre-slice) length, so it's still
    // genuinely true.
    const manyRows = Array.from({ length: 20_001 }, () => ({ item: '1', due_at: now }))
    registerObligationKind({
      ...base,
      kind: 'wf.big',
      expect: async () => manyRows
    })

    const apiChain = {
      where: vi.fn(),
      first: vi.fn().mockResolvedValue({ ack_grace_minutes: 60, skip_grace_minutes: 30 })
    }
    apiChain.where.mockReturnValue(apiChain)
    // The one collapsed item's only ledger row is `failed` — decideReconcile
    // always reads that as `none`, and it is its own newest row, so neither
    // the orphan scan nor the final open-row scan has anything to supersede.
    // Reused for every `nivaro_integration_obligations` select this run —
    // latestByItem, the orphan scan and the final open-row scan all ask a
    // shape this same array satisfies.
    const matchingRow = {
      id: 1,
      item: '1',
      outcome: 'failed',
      reason: 'x',
      due_at: now,
      resolved_at: null
    }
    const obligationsChain = {
      where: vi.fn(),
      whereIn: vi.fn(),
      orderBy: vi.fn(),
      select: vi.fn().mockResolvedValue([matchingRow])
    }
    obligationsChain.where.mockReturnValue(obligationsChain)
    obligationsChain.whereIn.mockReturnValue(obligationsChain)
    obligationsChain.orderBy.mockReturnValue(obligationsChain)

    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_external_apis') return apiChain
      if (table === 'nivaro_integration_obligations') return obligationsChain
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const warn = vi.fn()
    const fakeApp = { log: { warn } } as unknown as Parameters<
      typeof runIntegrationReconcileForCron
    >[0]

    const r = await runIntegrationReconcileForCron(fakeApp)

    expect(r.failed).toBe(0)
    expect(r.missing).toBe(0)
    expect(r.overdue).toBe(0)
    expect(r.superseded).toBe(0)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatch(/^wf\.big: expectation set truncated at 20000 \(20000 reconciled\)/)
    expect(r.errors[0]).toMatch(/supersede was skipped for this kind/)
    expect(warn).toHaveBeenCalledWith(
      { err: r.errors[0] },
      'integration reconcile: a kind reported an error'
    )
  })
})

describe('I1 — a truncated kind never supersedes on a partial view', () => {
  afterEach(() => vi.clearAllMocks())

  it('skips the "no longer expected" supersede entirely when the expectation set was capped', async () => {
    clearObligationKinds()
    // Over the ceiling, and every entry names item '1' — so `byItem` holds
    // exactly one expectation while the ledger holds an OPEN row for a
    // DIFFERENT item ('2'), which is precisely the item the cap hid. The old
    // loop would have closed it as "the record moved on"; it must not.
    registerObligationKind({
      ...base,
      kind: 'wf.capped',
      expect: async () => Array.from({ length: 20_001 }, () => ({ item: '1', due_at: now }))
    })

    const apiChain = {
      where: vi.fn(),
      first: vi.fn().mockResolvedValue({ ack_grace_minutes: 60, skip_grace_minutes: 30 })
    }
    apiChain.where.mockReturnValue(apiChain)

    const rowsByCall = [
      // latestByItem: item '1' already has a `failed` row → decideReconcile 'none'
      [{ id: 1, item: '1', outcome: 'failed', reason: 'x', due_at: now, resolved_at: null }],
      // supersedeOlderOpenRows (scoped to the items we could see): same row,
      // which IS the newest for its item, so nothing is superseded.
      [{ id: 1, item: '1' }]
    ]
    let call = 0
    const obligationsChain = {
      where: vi.fn(),
      whereIn: vi.fn(),
      orderBy: vi.fn(),
      update: vi.fn().mockResolvedValue(1),
      select: vi.fn(() => Promise.resolve(rowsByCall[call++] ?? []))
    }
    obligationsChain.where.mockReturnValue(obligationsChain)
    obligationsChain.whereIn.mockReturnValue(obligationsChain)
    obligationsChain.orderBy.mockReturnValue(obligationsChain)

    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_external_apis') return apiChain
      if (table === 'nivaro_integration_obligations') return obligationsChain
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const r = await reconcileKind(
      allObligationKinds().find((d) => d.kind === 'wf.capped') as never,
      db as unknown as Knex,
      now
    )

    expect(r.truncated).toBe(true)
    expect(r.superseded).toBe(0)
    // Exactly two selects: latestByItem and the scoped orphan scan. A third
    // would be the unscoped open-row scan this fix removes for capped kinds.
    expect(call).toBe(2)
    expect(obligationsChain.update).not.toHaveBeenCalled()
  })
})

describe('reconcileKind — duplicate/orphan open rows for one item are superseded', () => {
  afterEach(() => vi.clearAllMocks())

  it('supersedes an older open row that is not the newest, and never touches the newest row itself', async () => {
    // One item, expected present throughout. The ledger currently holds TWO
    // open rows for it: id 20 (the newest, outcome `failed` — decideReconcile
    // always reads that as `none`, so the main per-item loop writes nothing)
    // and id 15 (an older `pending`, orphaned — nothing else in the sweep
    // would ever touch it, since the item is still expected).
    const apiChain = {
      where: vi.fn(),
      first: vi.fn().mockResolvedValue({ ack_grace_minutes: 60, skip_grace_minutes: 30 })
    }
    apiChain.where.mockReturnValue(apiChain)

    const latestChain = {
      where: vi.fn(),
      whereIn: vi.fn(),
      orderBy: vi.fn(),
      select: vi.fn().mockResolvedValue([
        {
          id: 20,
          item: '1',
          outcome: 'failed',
          reason: 'HTTP 500',
          due_at: now,
          resolved_at: null
        }
      ])
    }
    latestChain.where.mockReturnValue(latestChain)
    latestChain.whereIn.mockReturnValue(latestChain)
    latestChain.orderBy.mockReturnValue(latestChain)

    const orphanChain = {
      where: vi.fn(),
      whereIn: vi.fn(),
      orderBy: vi.fn(),
      select: vi.fn().mockResolvedValue([
        { id: 20, item: '1' },
        { id: 15, item: '1' }
      ])
    }
    orphanChain.where.mockReturnValue(orphanChain)
    orphanChain.whereIn.mockReturnValue(orphanChain)
    orphanChain.orderBy.mockReturnValue(orphanChain)

    const updateChain = { where: vi.fn(), update: vi.fn().mockResolvedValue(1) }
    updateChain.where.mockReturnValue(updateChain)

    const finalChain = {
      where: vi.fn(),
      whereIn: vi.fn(),
      orderBy: vi.fn(),
      // Row 15 no longer shows up here — it was just superseded above, so a
      // fresh open-row scan for this kind would not find it either.
      select: vi.fn().mockResolvedValue([{ id: 20, item: '1' }])
    }
    finalChain.where.mockReturnValue(finalChain)
    finalChain.whereIn.mockReturnValue(finalChain)
    finalChain.orderBy.mockReturnValue(finalChain)

    const obligationsQueue: unknown[] = [latestChain, orphanChain, updateChain, finalChain]
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_external_apis') return apiChain
      if (table === 'nivaro_integration_obligations') {
        const next = obligationsQueue.shift()
        if (!next) throw new Error('unscripted extra call on nivaro_integration_obligations')
        return next
      }
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const def = { ...base, kind: 'wf.only', expect: async () => [{ item: '1', due_at: now }] }

    const r = await reconcileKind(def, db as unknown as Knex, now)

    expect(r.missing).toBe(0)
    expect(r.overdue).toBe(0)
    expect(r.superseded).toBe(1)
    expect(updateChain.where).toHaveBeenCalledWith({ id: 15 })
    const patch = updateChain.update.mock.calls[0][0] as Record<string, unknown>
    expect(patch.outcome).toBe('superseded')
    expect(patch.reason).toBe('superseded by obligation 20')
    expect(obligationsQueue).toHaveLength(0)
  })
})

describe('reconcileKind honours the injected database param', () => {
  afterEach(() => vi.clearAllMocks())

  it('reads grace settings, the ledger and the final supersede scan through the passed database — never the module db singleton', async () => {
    mockedDb().mockClear()
    const row = {
      id: 1,
      item: '1',
      outcome: 'failed',
      reason: 'x',
      due_at: now,
      resolved_at: null
    }
    const chain = {
      where: vi.fn(),
      whereIn: vi.fn(),
      orderBy: vi.fn(),
      select: vi.fn().mockResolvedValue([row]),
      first: vi.fn().mockResolvedValue({ ack_grace_minutes: 60, skip_grace_minutes: 30 })
    }
    chain.where.mockReturnValue(chain)
    chain.whereIn.mockReturnValue(chain)
    chain.orderBy.mockReturnValue(chain)
    const fakeDatabase = vi.fn().mockReturnValue(chain) as unknown as Knex

    const def = { ...base, kind: 'wf.only', expect: async () => [{ item: '1', due_at: now }] }

    const r = await reconcileKind(def, fakeDatabase, now)

    expect(r).toMatchObject({ kind: 'wf.only', missing: 0, overdue: 0, superseded: 0 })
    expect(fakeDatabase).toHaveBeenCalledWith('nivaro_external_apis')
    expect(fakeDatabase).toHaveBeenCalledWith('nivaro_integration_obligations')
    // Row 1 is the newest (outcome `failed` → `none`, and the orphan/final
    // scans see only itself, never something to supersede), so nothing was
    // ever written — the module `db` singleton should be completely silent.
    expect(db).not.toHaveBeenCalled()
  })
})

describe('reconcileKind threads the obligations epoch into expect()', () => {
  // getObligationsEpoch has ONE shared cache key (there is only ever one
  // epoch) — an earlier test in this file may have already warmed it via a
  // mismatched mock shape, so bust before AND after or this test's own
  // assertion on the epoch value is at the mercy of test order.
  beforeEach(() => bustObligationsEpochCache())
  afterEach(() => {
    vi.clearAllMocks()
    bustObligationsEpochCache()
  })

  it("resolves getObligationsEpoch through the SAME injected database and hands it to the kind's expect()", async () => {
    const epoch = new Date('2026-09-10T00:00:00Z')
    const settingsChain = {
      orderBy: vi.fn(),
      first: vi.fn().mockResolvedValue({ integration_obligations_epoch: epoch })
    }
    settingsChain.orderBy.mockReturnValue(settingsChain)

    const apiChain = {
      where: vi.fn(),
      first: vi.fn().mockResolvedValue({ ack_grace_minutes: 60, skip_grace_minutes: 30 })
    }
    apiChain.where.mockReturnValue(apiChain)

    // Nothing expected (expectFn returns []), so the only remaining db touch
    // is the unconditional "anything open no longer expected" scan at the
    // end of reconcileKind.
    const obligationsChain = {
      where: vi.fn(),
      whereIn: vi.fn(),
      orderBy: vi.fn(),
      select: vi.fn().mockResolvedValue([])
    }
    obligationsChain.where.mockReturnValue(obligationsChain)
    obligationsChain.whereIn.mockReturnValue(obligationsChain)
    obligationsChain.orderBy.mockReturnValue(obligationsChain)

    const fakeDatabase = vi.fn().mockImplementation((table: string) => {
      if (table === 'nivaro_settings') return settingsChain
      if (table === 'nivaro_external_apis') return apiChain
      if (table === 'nivaro_integration_obligations') return obligationsChain
      throw new Error(`unexpected table: ${table}`)
    }) as unknown as Knex

    const expectFn = vi.fn().mockResolvedValue([])
    const def = { ...base, kind: 'wf.epoch', expect: expectFn }

    const r = await reconcileKind(def, fakeDatabase, new Date('2026-09-22T00:00:00Z'))

    expect(r).toMatchObject({ kind: 'wf.epoch', missing: 0, overdue: 0, superseded: 0 })
    expect(expectFn).toHaveBeenCalledTimes(1)
    expect(expectFn).toHaveBeenCalledWith(fakeDatabase, { epoch })
  })
})
