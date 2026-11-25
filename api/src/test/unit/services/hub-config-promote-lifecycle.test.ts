import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub config promotion (idea 30), TARGET side, against real SQLite rows: the record of a run
// (nivaro_hub_config_applied) is written BEFORE any work and walks applying → deploying → applied;
// the commit marker (nivaro_hub_config_writes) exists exactly when the write committed; a status
// read tells a live run, a stalled one, a failed one and one that never arrived apart; a resend
// replays, resumes the procedures left, or re-runs a run that wrote nothing; the Changed-here
// baseline moves after the commit for the written rows only, and a failure there is reported. The
// restore engine (SQL Server only) is a fake that calls the hooks the way the real one does.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})

const fake = {
  failBefore: null as Error | null,
  crashAfterMarker: false,
  during: null as null | (() => Promise<void>),
  applyCalls: 0,
  live: {} as Record<string, Record<string, { hash: string; data: Record<string, unknown> }>>,
  drift: 'off' as 'off' | 'on' | 'throws',
  tracking: false,
  overwriteOpts: [] as Array<Record<string, unknown>>,
  stored: [] as Array<{ trigger: string; tables: Record<string, unknown>; markerSeen: boolean }>,
  saved: [] as string[]
}

const CTX = {
  plans: [{ table: 'nivaro_roles', ops: [{ key: 'r1', op: 'update' }] }],
  before: { nivaro_roles: { r1: { hash: 'h0', data: { id: 'r1', name: 'Editor', note: 'old' } } } },
  after: { nivaro_roles: { r1: { hash: 'h1', data: { id: 'r1', name: 'Editor', note: 'new' } } } }
}

vi.mock('../../../services/config-restore.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
  return {
    ...real,
    restoreEngineSupported: () => true,
    previewGivenSnapshot: async () => ({
      snapshot_id: 0,
      snapshot: { taken_at: '', version: '', environment: '', database: '', restore_point: null },
      plan_hash: 'e'.repeat(64),
      tables: [],
      refused: [],
      totals: { inserts: 0, updates: 1, deletes: 0, tables: 1, skipped_inactive_user: 0 },
      cascade: [],
      allow_cascade: false,
      warnings: [],
      over_cap: false,
      cap: 2000
    }),
    // As the real engine: inTransaction inside the write's transaction, afterCommit after it.
    applyGivenSnapshot: async (_snap: unknown, o: Record<string, any>) => {
      fake.applyCalls++
      await fake.during?.()
      if (fake.failBefore) throw fake.failBefore
      let extra: unknown
      await db.transaction(async (trx) => {
        extra = await o.inTransaction?.(trx, CTX)
      })
      const after_commit = o.afterCommit ? await o.afterCommit(db, CTX) : undefined
      if (fake.crashAfterMarker) throw new Error('the process lost its connection')
      return {
        snapshot_id: 0,
        pre_restore_id: 5,
        tables: [{ table: 'nivaro_roles', inserted: 0, updated: 1, deleted: 0 }],
        totals: { inserted: 0, updated: 1, deleted: 0 },
        extra,
        after_commit
      }
    }
  }
})

vi.mock('../../../services/config-inventory.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    buildConfigSnapshot: async (o: { tables: string[] }) => ({
      format: 1,
      generated_at: new Date().toISOString(),
      instance: { version: 'x', environment: 'test', database: '' },
      classification: { config: [], derived: [], runtime: [], unclassified: [], absent: [] },
      tables: Object.fromEntries(o.tables.map((t) => [t, fake.live[t] ?? {}])),
      errors: {}
    })
  }
})

vi.mock('../../../services/env-refresh/registry.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  allKeeps: () => []
}))

vi.mock('../../../services/config-drift/store.js', async () => {
  return {
    driftTrackingHere: async () => fake.tracking,
    // A change made here on step `old`: hit only when the check is told it is removed.
    checkOverwrite: async (_t: unknown, o: Record<string, any>) => {
      fake.overwriteOpts.push(o)
      const hit = !!o.alsoDelete?.nivaro_flow_operations?.includes('old')
      return {
        active: true,
        refuse: true,
        items: hit ? [{ table: 'nivaro_flow_operations', key: 'old' }] : [],
        lines: hit ? ['Step “Legacy step” changed on production'] : []
      }
    },
    getDriftSettings: async () => {
      if (fake.drift === 'throws') throw new Error('drift store unreachable')
      return {}
    },
    driftActive: () => fake.drift === 'on',
    resolveBaseline: async () => ({ snapshot_id: 1, pinned: false })
  }
})

vi.mock('../../../services/config-snapshots.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    loadConfigSnapshot: async () => ({
      format: 1,
      generated_at: '',
      instance: { version: 'x', environment: 'test', database: '' },
      classification: { config: [], derived: [], runtime: [], unclassified: [], absent: [] },
      tables: {
        nivaro_roles: {
          r1: { hash: 'h0', data: { id: 'r1' } },
          r2: { hash: 'mine', data: { id: 'r2', note: 'changed here' } }
        }
      },
      errors: {}
    }),
    storeConfigSnapshot: async (
      snap: { tables: Record<string, unknown> },
      trigger: string,
      _o: unknown,
      k: Knex
    ) => {
      // After the commit: the marker reads back on the plain connection.
      const markerSeen = !!(await k('nivaro_hub_config_writes').first())
      fake.stored.push({ trigger, tables: snap.tables, markerSeen })
      return { id: 99 }
    }
  }
})

vi.mock('../../../services/hub-link/config-promote-procs.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  managedWriter: () => ({
    current: async () => null,
    save: async (name: string) => {
      fake.saved.push(name)
      return 7
    },
    drop: async () => null
  })
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const m575 = await import('../../../db/migrations/575_hub_config_promotions.js')
const T = await import('../../../services/hub-link/config-promote.js')
const { procsRef } = await import('../../../services/hub-link/config-promote-procs.js')
const { hashRow } = await import('../../../services/config-inventory.js')

const RUN = 'run-key-lifecycle-0001'
const ENGINE = 'e'.repeat(64)
const PROCS = procsRef([])
const PLAN = createHash('sha256').update(`${ENGINE}:${PROCS}`).digest('hex')
const roleRow = { id: 'r1', name: 'Editor', description: 'new' }

const body = (runKey = RUN) => ({
  snapshot: {
    format: 1,
    generated_at: '2026-11-25T00:00:00.000Z',
    instance: { version: 'x', environment: 'dev', database: '' },
    classification: { config: [], derived: [], runtime: [], unclassified: [], absent: [] },
    tables: { nivaro_roles: { r1: { hash: hashRow(roleRow), data: roleRow } } },
    errors: {}
  },
  refs: {},
  stripped: {},
  tables: ['nivaro_roles'],
  deletes: false,
  allow_cascade: false,
  run_key: runKey,
  source_label: 'EFP/dev',
  promotion_id: 3,
  plan_hash: PLAN,
  engine_hash: ENGINE,
  procs_hash: PROCS
})

const record = async (runKey = RUN) =>
  (await db(T.APPLIED).where({ run_key: runKey }).first()) as Record<string, any> | undefined
const marker = async (runKey = RUN) =>
  (await db(T.WRITES).where({ run_key: runKey }).first()) as Record<string, any> | undefined
const status = (o: Record<string, unknown> = {}) => T.promotionStatus({ run_key: RUN, ...o })
const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return (e as { code?: string }).code ?? String(e)
  }
}

beforeAll(async () => {
  await m575.up(db)
  await db.schema.createTable('nivaro_config_snapshots', (t) => {
    t.increments('id')
    t.string('trigger', 32)
  })
  await m575.up(db) // guarded: a second run (and the trigger index) changes nothing
})
afterAll(async () => {
  await db.destroy()
})
beforeEach(async () => {
  await db(T.APPLIED).del()
  await db(T.WRITES).del()
  fake.failBefore = null
  fake.crashAfterMarker = false
  fake.during = null
  fake.applyCalls = 0
  fake.drift = 'off'
  fake.tracking = false
  fake.overwriteOpts = []
  fake.stored = []
  fake.saved = []
  fake.live = { nivaro_roles: { r1: { hash: 'h1', data: { id: 'r1', name: 'Editor' } } } }
})

describe('N1: the record is written before the work; status tells every state apart', () => {
  it('never arrived → not_applied, not running', async () => {
    expect(await status()).toMatchObject({ state: 'not_applied', running: false, stalled: false })
  })

  it('while it runs: applying + running; a second call answers APPLY_RUNNING', async () => {
    let seen: Awaited<ReturnType<typeof status>> | null = null
    let second = ''
    fake.during = async () => {
      seen = await status()
      second = await code(T.applyPromotion(body()))
    }
    const out = await T.applyPromotion(body())
    expect(seen).toMatchObject({ state: 'applying', running: true })
    expect(second).toBe('APPLY_RUNNING')
    expect(out.replayed).toBe(false)
    expect(fake.applyCalls).toBe(1)
    expect((await record())?.status).toBe('applied')
    expect(await marker()).toBeTruthy()
    expect(await status()).toMatchObject({ state: 'applied', running: false, newest: true })
  })

  it('a resend of an applied run replays its answer and writes nothing', async () => {
    await T.applyPromotion(body())
    const again = await T.applyPromotion(body())
    expect(again.replayed).toBe(true)
    expect(again.result.totals.updated).toBe(1)
    expect(fake.applyCalls).toBe(1)
  })

  it('refused before the commit → failed, no marker; a resend runs it again', async () => {
    fake.failBefore = Object.assign(new Error('locked'), { code: 'LOCKED' })
    expect(await code(T.applyPromotion(body()))).not.toBe('ok')
    expect((await record())?.status).toBe('failed')
    expect(await marker()).toBeUndefined()
    expect(await status()).toMatchObject({ state: 'failed', running: false })
    fake.failBefore = null
    const out = await T.applyPromotion(body())
    expect(out.replayed).toBe(false)
    expect((await record())?.status).toBe('applied')
  })

  it('a stale applying record with no marker settles to failed (the write never committed)', async () => {
    await db(T.APPLIED).insert({
      run_key: RUN,
      status: 'applying',
      heartbeat_at: new Date(Date.now() - 5 * 60_000)
    })
    expect(await status()).toMatchObject({ state: 'failed', running: false })
  })

  it('a fresh applying record is never settled (its process is alive)', async () => {
    await db(T.APPLIED).insert({ run_key: RUN, status: 'applying', heartbeat_at: new Date() })
    expect(await status()).toMatchObject({ state: 'applying', running: true })
    expect(await code(T.applyPromotion(body()))).toBe('APPLY_RUNNING')
  })

  it('a crash after the commit leaves the rows in: deploying, never failed', async () => {
    fake.crashAfterMarker = true
    expect(await code(T.applyPromotion(body()))).not.toBe('ok')
    expect(await marker()).toBeTruthy()
    expect((await record())?.status).toBe('deploying')
  })
})

describe('N6: procedures deploy one by one; a stalled run resumes the rest', () => {
  const plan = [
    { name: 'usp_a', op: 'change', body: 'a', description: null, before: null },
    { name: 'usp_b', op: 'add', body: 'b', description: null, before: null }
  ]
  const stalled = async () => {
    await db(T.APPLIED).insert({
      run_key: RUN,
      promotion_id: 3,
      source_label: 'EFP/dev',
      status: 'deploying',
      heartbeat_at: new Date(Date.now() - 5 * 60_000),
      procs_plan: JSON.stringify(plan),
      procs_done: JSON.stringify([
        { name: 'usp_a', op: 'change', before: null, after_version: 3, ok: true, reason: null }
      ])
    })
    await db(T.WRITES).insert({ run_key: RUN, undo_rows: '[]', undone: false })
  }

  it('status says stalled; resume deploys only what is left, then applied', async () => {
    await stalled()
    expect(await status()).toMatchObject({ state: 'deploying', stalled: true, running: false })
    const out = await status({ resume: true })
    expect(fake.saved).toEqual(['usp_b'])
    expect(out.state).toBe('applied')
    expect(out.answer?.procedures.map((p) => p.name)).toEqual(['usp_a', 'usp_b'])
  })

  it('a resend of the run key resumes it too (never re-runs the rows)', async () => {
    await stalled()
    const out = await T.applyPromotion(body())
    expect(out.resumed).toBe(true)
    expect(fake.applyCalls).toBe(0)
    expect(fake.saved).toEqual(['usp_b'])
    expect((await record())?.status).toBe('applied')
  })
})

describe('N2/N3: the Changed-here baseline moves after the commit, written rows only', () => {
  it('moved: a hub-baseline record, after the commit, other rows as they were', async () => {
    fake.drift = 'on'
    const out = await T.applyPromotion(body())
    expect(out.baseline).toBe('moved')
    expect(fake.stored).toHaveLength(1)
    expect(fake.stored[0].trigger).toBe('hub-baseline')
    expect(fake.stored[0].markerSeen).toBe(true)
    const roles = fake.stored[0].tables.nivaro_roles as Record<string, { hash: string }>
    expect(roles.r1.hash).toBe('h1')
    expect(roles.r2.hash).toBe('mine')
  })

  it('a failure there is reported, never swallowed — the promotion itself stands', async () => {
    fake.drift = 'throws'
    const out = await T.applyPromotion(body())
    expect(out.baseline).toMatch(/^not moved: drift store unreachable/)
    expect((await record())?.status).toBe('applied')
  })
})

describe('undo: row-exact, newest only, its own lifecycle', () => {
  const undoPreview = () => T.undoPromotion({ run_key: RUN, mode: 'preview' })

  it('preview then apply: rows back, marker undone, record undone', async () => {
    await T.applyPromotion(body())
    const pv = await undoPreview()
    const done = await T.undoPromotion({
      run_key: RUN,
      mode: 'apply',
      plan_hash: pv.preview?.plan_hash,
      engine_hash: pv.engine_hash,
      procs_hash: pv.procs_hash
    })
    expect(done.mode).toBe('apply')
    expect((await record())?.status).toBe('undone')
    expect(Number((await marker())?.undone)).toBe(1)
    expect(await status()).toMatchObject({ state: 'undone' })
    expect(await code(undoPreview())).toBe('NOT_UNDOABLE')
  })

  it('a refused undo leaves the run applied', async () => {
    await T.applyPromotion(body())
    const pv = await undoPreview()
    fake.failBefore = Object.assign(new Error('locked'), { code: 'LOCKED' })
    expect(
      await code(
        T.undoPromotion({
          run_key: RUN,
          mode: 'apply',
          plan_hash: pv.preview?.plan_hash,
          engine_hash: pv.engine_hash,
          procs_hash: pv.procs_hash
        })
      )
    ).not.toBe('ok')
    expect((await record())?.status).toBe('applied')
    expect(Number((await marker())?.undone)).toBe(0)
  })

  it('only the newest run may be undone; a failed run has nothing to undo', async () => {
    await T.applyPromotion(body())
    await T.applyPromotion(body('run-key-lifecycle-0002'))
    expect(await code(undoPreview())).toBe('NOT_NEWEST')
    await db(T.APPLIED).insert({ run_key: 'run-key-lifecycle-0003', status: 'failed' })
    expect(
      await code(T.undoPromotion({ run_key: 'run-key-lifecycle-0003', mode: 'preview' }))
    ).toBe('NOT_UNDOABLE')
  })

  it('STALE when a row it wrote changed since', async () => {
    await T.applyPromotion(body())
    fake.live = { nivaro_roles: { r1: { hash: 'changed-after', data: { id: 'r1' } } } }
    expect(await code(undoPreview())).toBe('STALE')
  })
})

describe('forced step deletions go through the Changed-here check (security review)', () => {
  const flow = { id: 'f', name: 'Order', status: 'active' }
  const step = { id: 'o1', flow: 'f', key: 'post', name: 'Post' }
  const flowBody = (runKey = RUN) => ({
    ...body(runKey),
    tables: ['nivaro_flows', 'nivaro_flow_operations'],
    snapshot: {
      ...body(runKey).snapshot,
      tables: {
        nivaro_flows: { f: { hash: hashRow(flow), data: flow } },
        nivaro_flow_operations: { o1: { hash: hashRow(step), data: step } }
      }
    }
  })
  const liveFlows = () => {
    fake.tracking = true
    fake.live = {
      nivaro_flows: { F: { hash: 'hf', data: { id: 'F', name: 'Order', status: 'active' } } },
      nivaro_flow_operations: {
        keep: { hash: 'hk', data: { id: 'keep', flow: 'F', key: 'post', name: 'Post' } },
        old: { hash: 'ho', data: { id: 'old', flow: 'F', key: 'legacy', name: 'Legacy step' } }
      }
    }
  }

  it('the plan passes the orphan step to the check and shows the refusal', async () => {
    liveFlows()
    const plan = await T.planPromotion(flowBody())
    expect(plan.orphans.map((o) => o.key)).toEqual(['old'])
    expect(fake.overwriteOpts.at(-1)?.alsoDelete).toEqual({ nivaro_flow_operations: ['old'] })
    expect(plan.prod_only_refuse).toBe(true)
    expect(plan.prod_only_lines[0]).toMatch(/Legacy step/)
  })

  it('the apply refuses PROD_ONLY_CHANGES unless overwriting is confirmed', async () => {
    liveFlows()
    expect(await code(T.applyPromotion(flowBody()))).toBe('PROD_ONLY_CHANGES')
    expect(fake.applyCalls).toBe(0)
    expect((await record())?.status).toBe('failed')
    const out = await T.applyPromotion({ ...flowBody(), overwrite_prod_changes: true })
    expect(out.replayed).toBe(false)
    expect(fake.applyCalls).toBe(1)
  })
})
