import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 44a: the estimate contract against real SQLite rows (Hub migrations up to
// 585) and a fake provider — per-op before → after, plan totals and unknown counts, the plan hash
// leaving estimates out, the owner auto-approve limit, the price book (cache / API / bundled), the
// estimate read (writes nothing, open in maintenance), traffic, tax and discount lines.

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
const { logActivity } = await import('../../../services/activity.js')
const registry = await import('../../../services/hub/providers/registry.js')
const store = await import('../../../services/hub/providers/store.js')
const engine = await import('../../../services/hub/providers/engine/contract.js')
const plan = await import('../../../services/hub/providers/engine/plan.js')
const deps = await import('../../../services/hub/providers/engine/deps.js')
const locks = await import('../../../services/hub/providers/engine/locks.js')
const est = await import('../../../services/hub/providers/estimate.js')
const pricing = await import('../../../services/hub/providers/pricing/index.js')
const costs = await import('../../../services/hub/providers/costs-live.js')
const { makeProviderContext } = await import('../../../services/hub/providers/context.js')
const { maintenanceExemptPath } = await import('../../../services/maintenance-freeze.js')
const { CORE_PROVIDERS } = await import('../../../services/hub/providers/index.js')
const F = await import('./hub-costs-fake.js')

import type { HubActor, PlanRequest } from '../../../services/hub/providers/engine/contract.js'
import type { CostEstimate } from '../../../services/hub/providers/types.js'

const ADMIN: HubActor = {
  id: '0a1b2c3d-0000-4000-8000-000000000001',
  isAdmin: true,
  via: 'session'
}
const OWNER: HubActor = {
  id: '0a1b2c3d-0000-4000-8000-000000000002',
  isAdmin: false,
  via: 'session'
}
const NOW = new Date('2026-11-20T12:00:00Z')

let appId: number
let devEnv: number
let connId: number

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  await F.migrate(db)
  const [a] = await db('nivaro_hub_apps').insert({ key: 'shop', name: 'Shop' })
  appId = Number(a)
  const [d] = await db('nivaro_hub_environments').insert({
    app_id: appId,
    key: 'dev',
    position: 0,
    base_url: 'https://dev.example.com',
    hub_token: 'sealed-dev'
  })
  devEnv = Number(d)
  // The last environment of an app is its production one (the auto rule): dev stays dev.
  await db('nivaro_hub_environments').insert({
    app_id: appId,
    key: 'production',
    position: 1,
    base_url: 'https://prod.example.com',
    hub_token: 'sealed-prod'
  })
  await db('nivaro_hub_app_owners').insert({ app_id: appId, user_id: OWNER.id })
  connId = (
    await store.createConnection({ provider: 'fake', name: 'Fake', config: {}, secrets: {} })
  ).id
  await store.setAppAllowedConnections(appId, [connId])
})

afterAll(async () => {
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
  vi.mocked(logActivity).mockClear()
  for (const t of [
    'nivaro_hub_resources',
    'nivaro_hub_resource_changes',
    'nivaro_hub_price_cache',
    'nivaro_hub_cost_runrate',
    'nivaro_hub_cost_budgets',
    'nivaro_extension_settings'
  ])
    await db(t).del()
  if (await db.schema.hasTable(pricing.PROVIDER_COSTS))
    await db.schema.dropTable(pricing.PROVIDER_COSTS)
  await store.updateConnection(connId, { config: {} })
})

const req = (ops: PlanRequest['ops']): PlanRequest => ({
  connectionId: connId,
  scope: 'app',
  appId,
  environmentId: devEnv,
  ops
})

async function createBox(name: string, size: number) {
  const p = await engine.planResourceChange(
    req([{ action: 'create', type: 'fake.box', fields: { name, size } }]),
    ADMIN
  )
  const out = await engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
  expect(out.status).toBe('applied')
  const row = (await store.listResources({ type: 'fake.box' })).find((r) => r.name === name)
  if (!row) throw new Error('not created')
  return row
}

const sum = (e: CostEstimate) => e.lines.reduce((n, l) => n + l.monthlyCents, 0)

describe('estimate contract', () => {
  it('estimate lines sum to monthly', async () => {
    const e = pricing.estimateOf({
      basis: 'price_list',
      confidence: 'list_price',
      lines: [
        pricing.lineOf('Instance', 730, 'hour', 1.04, 'price_list'),
        pricing.lineOf('Storage', 20, 'GB-month', 8, 'price_list'),
        pricing.lineOf('Out', 12.5, 'GB', 9, 'assumed', 'transfer')
      ],
      priceAsOf: '2026-11-01'
    })
    expect(e.monthlyCents).toBe(sum(e))
    const taxed = pricing.applyRates(e, {
      taxPercent: 8,
      discountPercent: 10,
      source: 'bill',
      months: 3
    })
    expect(taxed.lines.map((l) => l.kind)).toEqual(['base', 'base', 'transfer', 'discount', 'tax'])
    expect(taxed.monthlyCents).toBe(sum(taxed))

    const p = await engine.planResourceChange(
      req([{ action: 'create', type: 'fake.box', fields: { name: 'a', size: 3 } }]),
      ADMIN
    )
    const cost = p.ops[0].cost
    expect(cost?.before).toBeNull()
    expect(cost?.after?.monthlyCents).toBe(750)
    expect(cost?.after && sum(cost.after)).toBe(750)
    expect(cost?.after?.priceAsOf).toBe('2026-11-01')
    expect(cost?.deltaMonthlyCents).toBe(750)
  })

  it('delete estimate is the saving', async () => {
    const row = await createBox('gone', 2)
    const p = await engine.planResourceChange(
      req([{ action: 'delete', resourceId: row.id }]),
      ADMIN
    )
    expect(p.ops[0].kind).toBe('delete')
    expect(p.ops[0].cost?.before?.monthlyCents).toBe(500)
    expect(p.ops[0].cost?.after).toBeNull()
    expect(p.ops[0].cost?.deltaMonthlyCents).toBe(-500)
    expect(p.costTotal?.deltaMonthlyCents).toBe(-500)
  })

  it('plan totals add ops and count unknown', async () => {
    const row = await createBox('grow', 1)
    const p = await engine.planResourceChange(
      req([
        { action: 'create', type: 'fake.box', fields: { name: 'b', size: 2 } },
        { action: 'update', resourceId: row.id, fields: { size: 4 } },
        { action: 'create', type: 'fake.blob', fields: { name: 'c' } }
      ]),
      ADMIN
    )
    // +500 (new box) + (1000 − 250) (grown box); the blob type has no estimate: unknown.
    expect(p.costTotal).toMatchObject({ deltaMonthlyCents: 1250, unknownOps: 1, oneTimeCents: 0 })
    const blob = p.ops.find((o) => o.type === 'fake.blob')
    expect(blob?.cost?.after?.confidence).toBe('unknown')
    // An estimate that throws is "No estimate", never a failed plan.
    F.fake.estimateThrows = true
    const q = await engine.planResourceChange(
      req([{ action: 'create', type: 'fake.box', fields: { name: 'd' } }]),
      ADMIN
    )
    expect(q.ops[0].cost?.after?.confidence).toBe('unknown')
    expect(q.costTotal?.unknownOps).toBe(1)
  })

  it('estimate not in plan_hash', async () => {
    const r = req([{ action: 'create', type: 'fake.box', fields: { name: 'h', size: 1 } }])
    const a = await plan.computePlan(r, ADMIN, { mode: 'request' })
    F.fake.api = { unitCents: 999, unit: 'month', currency: 'USD', asOf: '2026-11-20' }
    await db('nivaro_hub_price_cache').del()
    const b = await plan.computePlan(r, ADMIN, { mode: 'request' })
    expect(a.stored.ops[0].cost?.after?.monthlyCents).toBe(250)
    expect(b.stored.ops[0].cost?.after?.monthlyCents).toBe(999)
    expect(b.planHash).toBe(a.planHash)
  })

  it('owner change under auto-approve threshold skips pending_approval', async () => {
    await est.writeCostSettings({ cost_auto_approve_under_cents: 1000 })
    const p = await engine.planResourceChange(
      req([
        { action: 'create', type: 'fake.box', fields: { name: 'cheap', size: 2, costly: true } }
      ]),
      OWNER
    )
    expect(p.ops[0].risk).toContain('cost')
    expect(p.needsApproval).toBe(false)
    expect(p.gates.find((g) => g.code === 'APPROVAL_REQUIRED')).toMatchObject({ passed: true })
    const out = await engine.startResourceChange(p.changeId, { planHash: p.planHash }, OWNER)
    expect(out.status).toBe('applied')

    // Over the limit: waits. A per-app limit beats the Hub-wide one.
    const big = await engine.planResourceChange(
      req([{ action: 'create', type: 'fake.box', fields: { name: 'big', size: 8, costly: true } }]),
      OWNER
    )
    expect(big.needsApproval).toBe(true)
    await est.writeBudget(appId, { monthly_cents: 0, auto_approve_under_cents: 5000 }, null)
    const again = await engine.planResourceChange(
      req([{ action: 'create', type: 'fake.box', fields: { name: 'big', size: 8, costly: true } }]),
      OWNER
    )
    expect(again.needsApproval).toBe(false)
    // No limit at all (0): every costed change waits.
    await est.writeBudget(appId, { monthly_cents: 0, auto_approve_under_cents: 0 }, null)
    const none = await engine.planResourceChange(
      req([{ action: 'create', type: 'fake.box', fields: { name: 'one', size: 1, costly: true } }]),
      OWNER
    )
    expect(none.needsApproval).toBe(true)
  })

  it('unknown estimate never auto-approves', async () => {
    await est.writeCostSettings({ cost_auto_approve_under_cents: 1_000_000 })
    const p = await engine.planResourceChange(
      req([{ action: 'create', type: 'fake.blob', fields: { name: 'x', costly: true } }]),
      OWNER
    )
    expect(p.costTotal?.unknownOps).toBe(1)
    expect(p.needsApproval).toBe(true)
    F.fake.estimateThrows = true
    const q = await engine.planResourceChange(
      req([{ action: 'create', type: 'fake.box', fields: { name: 'y', costly: true } }]),
      OWNER
    )
    expect(q.needsApproval).toBe(true)
    const started = await engine.startResourceChange(q.changeId, { planHash: q.planHash }, OWNER)
    expect(started.status).toBe('pending_approval')
  })

  it('guard fails for a costed type without estimate outside the allow-list', () => {
    expect(pricing.missingEstimates([F.fakeAdapter])).toEqual(['fake.blob'])
    expect(pricing.missingEstimates([F.fakeAdapter], new Set(['fake.blob']))).toEqual([])
    // The core list is a separate guard (hub-providers-estimate.guard.test.ts); sanity here.
    expect(Array.isArray(CORE_PROVIDERS)).toBe(true)
  })
})

describe('price book', () => {
  const ctxAt = (at: Date) =>
    makeProviderContext({
      adapter: F.fakeAdapter,
      connectionId: connId,
      config: {},
      secrets: {},
      region: 'eu-1',
      now: () => at
    })

  it('price cache hit / stale refetch / api failure → bundled with date', async () => {
    F.fake.api = { unitCents: 300, unit: 'month', currency: 'USD', asOf: '2026-11-19' }
    const first = await pricing.priceLookup(ctxAt(NOW), 'fake', 'box.month', 'eu-1')
    expect(first).toMatchObject({ unitCents: 300, source: 'api', asOf: '2026-11-19' })
    expect(F.fake.apiCalls).toBe(1)
    const hit = await pricing.priceLookup(
      ctxAt(new Date(NOW.getTime() + 86_400_000)),
      'fake',
      'box.month',
      'eu-1'
    )
    expect(hit).toMatchObject({ unitCents: 300, source: 'cache' })
    expect(F.fake.apiCalls).toBe(1)
    // Eight days on, the cache is stale: asked again.
    F.fake.api = { unitCents: 320, unit: 'month', currency: 'USD', asOf: '2026-11-27' }
    const later = new Date(NOW.getTime() + 8 * 86_400_000)
    expect(await pricing.priceLookup(ctxAt(later), 'fake', 'box.month', 'eu-1')).toMatchObject({
      unitCents: 320,
      source: 'api'
    })
    expect(F.fake.apiCalls).toBe(2)
    // The API fails on a stale cache: the bundled table answers, with its own date.
    F.fake.api = 'throw'
    const muchLater = new Date(NOW.getTime() + 30 * 86_400_000)
    expect(await pricing.priceLookup(ctxAt(muchLater), 'fake', 'box.month', 'eu-1')).toMatchObject({
      unitCents: 250,
      source: 'bundled',
      asOf: '2026-11-01'
    })
    // Nothing anywhere: null, never a throw.
    expect(await pricing.priceLookup(ctxAt(NOW), 'fake', 'nope', 'eu-1')).toBeNull()
  })
})

describe('the estimate read', () => {
  it('estimate route writes nothing and works during maintenance', async () => {
    for (const url of [
      '/api/hub/providers/estimate',
      '/api/hub/apps/create/estimate',
      '/api/hub/environments/12/stack/estimate'
    ])
      expect(maintenanceExemptPath(url)).toBe(true)
    expect(maintenanceExemptPath('/api/hub/resources/plan')).toBe(false)
    const before = await db('nivaro_hub_resource_changes').count({ n: '*' }).first()
    const out = await costs.estimateProvider(
      {
        connection_id: connId,
        type: 'fake.box',
        desired: { name: 'q', size: 2 },
        app_id: appId,
        environment_id: devEnv
      },
      OWNER
    )
    expect(out.monthlyCents).toBe(500)
    expect(out.before).toBeNull()
    expect(out.deltaMonthlyCents).toBe(500)
    const after = await db('nivaro_hub_resource_changes').count({ n: '*' }).first()
    expect(after).toEqual(before)
    expect(await db('nivaro_hub_resources').count({ n: '*' }).first()).toEqual({ n: 0 })
    expect(await db('nivaro_hub_cost_runrate').count({ n: '*' }).first()).toEqual({ n: 0 })
    expect(vi.mocked(logActivity)).not.toHaveBeenCalled()
    // Judged like a plan: a stranger is refused before any price is read.
    await expect(
      costs.estimateProvider(
        { connection_id: connId, type: 'fake.box', desired: {}, app_id: appId },
        { id: '0a1b2c3d-0000-4000-8000-000000000009', isAdmin: false, via: 'session' }
      )
    ).rejects.toMatchObject({ code: 'ADMIN_ONLY' })
  })

  it('transfer line from form traffic, prefilled from measured egress', async () => {
    const base = {
      connection_id: connId,
      type: 'fake.box',
      desired: { name: 't' },
      app_id: appId,
      environment_id: devEnv
    }
    const none = await costs.estimateProvider(base, ADMIN)
    expect(none.lines.some((l) => l.kind === 'transfer')).toBe(false)
    expect(none.traffic).toBeNull()

    const typed = await costs.estimateProvider({ ...base, egress_gb_month: 100 }, ADMIN)
    expect(typed.lines.find((l) => l.kind === 'transfer')).toMatchObject({
      qty: 100,
      unitCents: 9,
      monthlyCents: 900,
      source: 'assumed'
    })

    // Another environment of the same app measured 40 GB a month: prefilled from it.
    est.configureCostsLive({ measuredEgress: async () => new Map([[devEnv + 100, 40]]) })
    const measured = await costs.estimateProvider(base, ADMIN)
    expect(measured.traffic).toEqual({ egressGbMonth: 40, source: 'measured' })
    expect(measured.lines.find((l) => l.kind === 'transfer')).toMatchObject({
      qty: 40,
      source: 'measured'
    })
    // The plan prefills it too.
    const p = await engine.planResourceChange(
      req([{ action: 'create', type: 'fake.box', fields: { name: 'u', size: 1 } }]),
      ADMIN
    )
    expect(p.ops[0].cost?.after?.monthlyCents).toBe(250 + 360)
  })
})

describe('tax and discounts', () => {
  async function feed(rows: Array<{ date: string; amount: number; type: string }>) {
    await db.schema.createTable(pricing.PROVIDER_COSTS, (t) => {
      t.increments('id').primary()
      t.integer('connection_id').notNullable()
      t.string('date', 10).notNullable()
      t.integer('app_id').nullable()
      t.integer('resource_id').nullable()
      t.string('service', 64).nullable()
      t.bigInteger('amount_cents').notNullable()
      t.string('currency', 3).nullable()
      t.string('source', 16).nullable()
      t.string('record_type', 16).nullable()
    })
    for (const r of rows)
      await db(pricing.PROVIDER_COSTS).insert({
        connection_id: connId,
        date: r.date,
        service: 'Compute',
        amount_cents: r.amount,
        currency: 'USD',
        record_type: r.type
      })
  }

  const estimate = () =>
    costs.estimateProvider(
      { connection_id: connId, type: 'fake.box', desired: { name: 'z', size: 4 }, app_id: appId },
      ADMIN
    )

  it('tax line from learned bill rate beats admin rate; none says tax not included', async () => {
    const none = await estimate()
    expect(none.lines.some((l) => l.kind === 'tax')).toBe(false)
    expect(none.note).toContain('Tax not included.')
    expect(none.monthlyCents).toBe(1000)

    await store.updateConnection(connId, { config: { tax_percent: 20 } })
    const admin = await estimate()
    expect(admin.lines.find((l) => l.kind === 'tax')).toMatchObject({
      monthlyCents: 200,
      source: 'admin_rate'
    })
    expect(admin.monthlyCents).toBe(1200)
    expect(admin.note ?? '').not.toContain('Tax not included')

    await feed([
      { date: '2026-08-10', amount: 10_000, type: 'usage' },
      { date: '2026-09-10', amount: 10_000, type: 'usage' },
      { date: '2026-10-10', amount: 10_000, type: 'usage' },
      { date: '2026-10-31', amount: 2_400, type: 'tax' },
      // This month's rows are not a billed month yet.
      { date: '2026-11-02', amount: 9_999, type: 'tax' }
    ])
    const bill = await estimate()
    expect(bill.lines.find((l) => l.kind === 'tax')).toMatchObject({
      monthlyCents: 80,
      source: 'learned_from_bill'
    })
    expect(bill.monthlyCents).toBe(1080)
    expect(await pricing.effectiveRates(connId, { now: NOW })).toMatchObject({
      taxPercent: 8,
      source: 'bill',
      months: 3
    })
  })

  it('discount line only when learned from a bill', async () => {
    await store.updateConnection(connId, { config: { tax_percent: 10 } })
    const admin = await estimate()
    expect(admin.lines.some((l) => l.kind === 'discount')).toBe(false)
    await feed([
      { date: '2026-10-05', amount: 20_000, type: 'usage' },
      { date: '2026-10-20', amount: -5_000, type: 'credit' }
    ])
    const learned = await estimate()
    const d = learned.lines.find((l) => l.kind === 'discount')
    expect(d).toMatchObject({ monthlyCents: -250, source: 'learned_from_bill' })
    // The admin rate still taxes what is left (no tax rows in the bill to learn from).
    expect(learned.lines.find((l) => l.kind === 'tax')).toMatchObject({
      monthlyCents: 75,
      source: 'admin_rate'
    })
    expect(learned.monthlyCents).toBe(1000 - 250 + 75)
    expect(learned.monthlyCents).toBe(sum(learned))
  })
})
