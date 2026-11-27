import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 44a: live costs against real SQLite rows — stack estimates from the
// chargeback rate card (costOf of the planned shape × the region factor), the run-rate tick
// (one row per managed resource and per placed stack), month to date / forecast, and the
// over-budget alert (once per threshold per month).

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
  return { db, migrationsDir: '/nowhere' }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const registry = await import('../../../services/hub/providers/registry.js')
const store = await import('../../../services/hub/providers/store.js')
const engine = await import('../../../services/hub/providers/engine/contract.js')
const deps = await import('../../../services/hub/providers/engine/deps.js')
const locks = await import('../../../services/hub/providers/engine/locks.js')
const est = await import('../../../services/hub/providers/estimate.js')
const costs = await import('../../../services/hub/providers/costs-live.js')
const cb = await import('../../../services/hub/placement/chargeback.js')
const F = await import('./hub-costs-fake.js')

import type { HubActor } from '../../../services/hub/providers/engine/contract.js'

const ADMIN: HubActor = {
  id: '0a1b2c3d-0000-4000-8000-000000000001',
  isAdmin: true,
  via: 'session'
}
const NOW = new Date('2026-11-20T12:00:00Z')
const MONTH_MS = 30 * 86_400_000
const RATES = {
  cpu_core_month: 10,
  memory_gb_month: 2,
  storage_gb_month: 0.5,
  database_gb_month: 1,
  environment_month: 5
}

let appId: number
let devEnv: number
let prodEnv: number
let connId: number
let driverId: number

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  process.env.HUB = 'on'
  await F.migrate(db)
  const [a] = await db('nivaro_hub_apps').insert({ key: 'shop', name: 'Shop' })
  appId = Number(a)
  const [dr] = await db('nivaro_hub_drivers').insert({ kind: 'docker', name: 'host-eu' })
  driverId = Number(dr)
  const [pl] = await db('nivaro_hub_placements').insert({ kind: 'dedicated', driver_id: driverId })
  const [d] = await db('nivaro_hub_environments').insert({
    app_id: appId,
    key: 'dev',
    position: 0,
    base_url: 'https://dev.example.com',
    hub_token: 'sealed-dev',
    placement_id: Number(pl)
  })
  devEnv = Number(d)
  const [p] = await db('nivaro_hub_environments').insert({
    app_id: appId,
    key: 'production',
    position: 1,
    base_url: 'https://prod.example.com',
    hub_token: 'sealed-prod'
  })
  prodEnv = Number(p)
  await db('nivaro_hub_stack_settings').insert({ environment_id: devEnv, size: 'small' })
  const [r] = await db('nivaro_hub_regions').insert({ key: 'eu', name: 'EU', cost_percent: 150 })
  await db('nivaro_hub_region_drivers').insert({ driver_id: driverId, region_id: Number(r) })
  connId = (
    await store.createConnection({ provider: 'fake', name: 'Fake', config: {}, secrets: {} })
  ).id
  await cb.writeChargeback({ currency: 'USD', rates: RATES, window_days: 30 })
})

afterAll(async () => {
  delete process.env.HUB
  await db.destroy()
})

beforeEach(async () => {
  registry.resetProvidersForTest()
  registry.registerProvider(F.fakeAdapter)
  locks.resetMemoryResourceLocksForTest()
  deps.resetResourceEngineForTest()
  deps.configureResourceEngine({
    lock: () => locks.memoryResourceLock(),
    inline: true,
    now: () => NOW.getTime(),
    notify: { notify: vi.fn(async () => null), adminBase: () => '', page: null }
  })
  est.resetCostsLiveForTest()
  est.configureCostsLive({ now: () => NOW })
  F.resetFake()
  for (const t of [
    'nivaro_hub_resources',
    'nivaro_hub_resource_changes',
    'nivaro_hub_cost_runrate',
    'nivaro_hub_cost_budgets',
    'nivaro_hub_scale_roles'
  ])
    await db(t).del()
})

describe('stack estimates', () => {
  it('stack estimate = costOf of planned shape × region factor', async () => {
    const shape = {
      roles: costs.templateRoles('medium'),
      storage_gb: 12,
      database_gb: 3
    }
    const e = cb.estimateStack(shape, RATES, 150)
    const c = cb.costOf(cb.stackUsageOf(shape), RATES, 150)
    expect(e.monthlyCents).toBe(Math.round(c.total * 100))
    expect(e.lines.reduce((n, l) => n + l.monthlyCents, 0)).toBe(e.monthlyCents)
    expect(e).toMatchObject({ basis: 'rate_card', confidence: 'exact' })
    // No rates set: a figure of 0 is "No estimate", never a free stack.
    expect(
      cb.estimateStack(shape, {
        ...RATES,
        cpu_core_month: 0,
        memory_gb_month: 0,
        storage_gb_month: 0,
        database_gb_month: 0,
        environment_month: 0
      }).confidence
    ).toBe('unknown')

    // The environment on a host in a 150 % region: small (2 cores, 3 GB) → medium (6, 10 GB).
    const out = await costs.stackEstimate(devEnv, { size: 'medium' })
    expect(out.before?.monthlyCents).toBe(Math.round((2 * 10 + 3 * 2 + 5) * 1.5 * 100))
    expect(out.after?.monthlyCents).toBe(Math.round((6 * 10 + 10 * 2 + 5) * 1.5 * 100))
    expect(out.deltaMonthlyCents).toBe(12_750 - 4_650)
    expect(out.after?.note).toContain('Not counted')
    // Replicas lay over the template: 3 web (2 cores, 3 GB each) + the worker (2 cores, 4 GB).
    const scaled = await costs.stackEstimate(devEnv, { size: 'medium', replicas: { web: 3 } })
    expect(scaled.after?.monthlyCents).toBe(Math.round((8 * 10 + 13 * 2 + 5) * 1.5 * 100))
    await expect(costs.stackEstimate(devEnv, { size: 'huge' })).rejects.toMatchObject({
      code: 'INVALID_FIELDS'
    })
    // A scale plan's from → to, and a move to an unplaced host (factor 100).
    const sc = await costs.scaleCost(
      { kind: 'environment', id: devEnv },
      [{ role: 'all', replicas: 1, cpus: 2, memory_mb: 3072 }],
      [{ role: 'all', replicas: 1, cpus: 4, memory_mb: 3072 }]
    )
    expect(sc.deltaMonthlyCents).toBe(Math.round(2 * 10 * 1.5 * 100))
    const [other] = await db('nivaro_hub_placements').insert({ kind: 'dedicated', driver_id: 999 })
    const mv = await costs.moveCost(devEnv, { kind: 'dedicated', placement_id: Number(other) })
    expect(mv?.after?.monthlyCents).toBe((2 * 10 + 3 * 2 + 5) * 100)
  })
})

describe('run-rate', () => {
  it('runrate rows per app/env/provider, month to date integrates rows', async () => {
    const p = await engine.planResourceChange(
      {
        connectionId: connId,
        scope: 'app',
        appId,
        environmentId: devEnv,
        ops: [{ action: 'create', type: 'fake.box', fields: { name: 'b', size: 2 } }]
      },
      ADMIN
    )
    await engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    const tick = await costs.runRateTick(NOW)
    expect(tick.rows).toBe(2)
    const rows = (await db(costs.RUNRATE).orderBy('kind')) as Array<Record<string, unknown>>
    expect(rows.map((r) => [r.kind, r.app_id, r.environment_id, r.provider])).toEqual([
      ['resource', appId, devEnv, 'fake'],
      ['stack', appId, devEnv, null]
    ])
    expect(Number(rows[0].monthly_cents)).toBe(500)
    // Measured usage only (nothing sampled yet): the flat amount × 150 %. The unplaced
    // production environment has no row.
    expect(Number(rows[1].monthly_cents)).toBe(750)
    expect(rows.some((r) => r.environment_id === prodEnv)).toBe(false)
    // The provider was not read again since the last sample: the figure is kept, not re-priced.
    F.fake.estimateThrows = true
    await costs.runRateTick(new Date(NOW.getTime() + 15 * 60_000))
    const kept = (await db(costs.RUNRATE).where({ kind: 'resource' })) as Array<
      Record<string, unknown>
    >
    expect(kept.map((r) => Number(r.monthly_cents))).toEqual([500, 500])

    // Month to date: every row stands for one 15-minute sample interval.
    await db(costs.RUNRATE).del()
    const series = (at: Date, monthly: number, kind = 'resource') => ({
      sampled_at: at,
      app_id: appId,
      environment_id: devEnv,
      provider: kind === 'resource' ? 'fake' : null,
      resource_id: kind === 'resource' ? 1 : null,
      kind,
      monthly_cents: monthly,
      basis: 'plan_price',
      confidence: 'list_price'
    })
    const MONTHLY = 2_592_000 // 900 cents per 15 minutes in a 30-day month
    await db(costs.RUNRATE).insert([
      series(new Date('2026-10-31T23:45:00Z'), MONTHLY),
      ...[45, 30, 15, 0].map((m) => series(new Date(NOW.getTime() - m * 60_000), MONTHLY))
    ])
    const live = await costs.liveCosts({ appIds: [appId] }, NOW)
    expect(live.month).toBe('2026-11')
    expect(live.monthToDateCents).toBe(4 * 900)
    expect(live.nowCents).toBe(MONTHLY)
    const left = (Date.parse('2026-12-01T00:00:00Z') - NOW.getTime()) / MONTH_MS
    expect(live.forecastCents).toBe(3600 + Math.round(MONTHLY * left))
    expect(live.byProvider).toEqual([
      { provider: 'fake', nowCents: MONTHLY, monthToDateCents: 3600 }
    ])
    expect(live.billed).toBeNull()
    // Another app's rows never show up.
    expect((await costs.liveCosts({ appIds: [appId + 1] }, NOW)).nowCents).toBe(0)
  })

  it('budget alert once per threshold per month', async () => {
    const sent: Array<{ pct: number; month: string }> = []
    est.configureCostsLive({
      notifyOverBudget: async (n) => {
        sent.push({ pct: n.pct, month: n.month })
      }
    })
    await est.writeBudget(appId, { monthly_cents: 1_000_000, auto_approve_under_cents: null }, null)
    const row = (at: Date, monthly: number, kind = 'stack') => ({
      sampled_at: at,
      app_id: appId,
      environment_id: devEnv,
      provider: null,
      resource_id: null,
      kind,
      monthly_cents: monthly,
      basis: 'rate_card',
      confidence: 'exact'
    })
    // Forecast ≈ 0.35 × 2,592,000 ≈ 91 % of the budget.
    await db(costs.RUNRATE).insert(row(NOW, 2_592_000))
    expect(await costs.checkBudgets(NOW)).toBe(1)
    expect(await costs.checkBudgets(NOW)).toBe(0)
    expect(sent).toEqual([{ pct: 80, month: '2026-11' }])
    // Over 100 %: the higher threshold, once.
    await db(costs.RUNRATE).insert(row(NOW, 1_000_000, 'resource'))
    expect(await costs.checkBudgets(NOW)).toBe(1)
    expect(await costs.checkBudgets(NOW)).toBe(0)
    expect(sent.map((s) => s.pct)).toEqual([80, 100])
    // A new month starts again (straight to 100 when both are crossed).
    const dec = new Date('2026-12-02T00:00:00Z')
    await db(costs.RUNRATE).insert(row(dec, 50_000_000))
    expect(await costs.checkBudgets(dec)).toBe(1)
    expect(sent.at(-1)).toEqual({ pct: 100, month: '2026-12' })
    expect(costs.budgetThreshold(790, 1000, { month: null, pct: null }, '2026-11')).toBeNull()
  })
})
