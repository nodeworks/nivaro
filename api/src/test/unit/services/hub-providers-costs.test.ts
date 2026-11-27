import { join } from 'node:path'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub providers Task 34: the provider cost feed (mapping, replace-not-add, unassigned rows, the
// 400-day prune, Outside spend + its CSV, the learned tax rate and billed figures reading it), the
// widened cost classes (a yearly type needs an admin's approval for an owner) and the registrar
// domain watch (notify once per threshold), against real SQLite rows (Hub migrations to 586).

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
const pricing = await import('../../../services/hub/providers/pricing/index.js')
const live = await import('../../../services/hub/providers/costs-live.js')
const costs = await import('../../../services/hub/providers/costs.js')
const domains = await import('../../../services/hub/providers/domains.js')
const F = await import('./hub-costs-fake.js')

import type { HubActor } from '../../../services/hub/providers/engine/contract.js'
import type {
  CostRow,
  DesiredResource,
  HealthAnswer,
  ProviderAdapter,
  ResourceTypeSpec
} from '../../../services/hub/providers/types.js'
import { ProviderError } from '../../../services/hub/providers/types.js'

const OWNER: HubActor = {
  id: '0a1b2c3d-0000-4000-8000-000000000002',
  isAdmin: false,
  via: 'session'
}
const NOW = new Date('2026-11-20T12:00:00Z')

const feed = {
  rows: [] as CostRow[],
  calls: [] as Array<{ from: string; to: string }>,
  fail: null as Error | null,
  health: new Map<string, HealthAnswer | null>()
}

const caps = { create: true, update: true, delete: true, adopt: true, snapshot: false, tag: true }
const plainType = (key: string, extra: Partial<ResourceTypeSpec> = {}): ResourceTypeSpec => ({
  key,
  label: key,
  scope: 'app',
  fields: [
    { key: 'name', label: 'Name', kind: 'string', required: true },
    { key: 'yearly', label: 'Yearly', kind: 'boolean' }
  ],
  capabilities: caps,
  reversible: true,
  refs: [],
  risk: () => [],
  ...extra
})

const feedAdapter: ProviderAdapter = {
  ...F.fakeAdapter,
  key: 'feed',
  label: 'Feed Co',
  bundledPrices: undefined,
  priceApi: undefined,
  types: [
    plainType('feed.box', {
      costClass: (d: DesiredResource) => (d.fields.yearly === true ? 'yearly' : 'none'),
      estimate: async () =>
        pricing.estimateOf({
          basis: 'plan_price',
          confidence: 'list_price',
          lines: [],
          priceAsOf: '2026-11-01',
          yearlyCents: 1500
        })
    }),
    plainType('feed.domain', { registrar: true })
  ],
  async costs(_ctx, range) {
    feed.calls.push(range)
    if (feed.fail) throw feed.fail
    return feed.rows
  },
  async health(_ctx, _type, externalId) {
    const h = feed.health.get(externalId)
    if (h === undefined) return { status: 'unknown', checkedAt: NOW.toISOString() }
    if (h === null) throw new ProviderError('DOWN', 'registrar down')
    return h
  }
}

let appId: number
let otherApp: number
let devEnv: number
let connId: number

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  await F.migrate(db)
  const dir = join(import.meta.dirname, '../../../db/migrations')
  await (await import(/* @vite-ignore */ join(dir, '586_hub_provider_costs.ts'))).up(db)
  const [a] = await db('nivaro_hub_apps').insert({ key: 'shop', name: 'Shop' })
  appId = Number(a)
  const [b] = await db('nivaro_hub_apps').insert({ key: 'blog', name: 'Blog' })
  otherApp = Number(b)
  const [d] = await db('nivaro_hub_environments').insert({
    app_id: appId,
    key: 'dev',
    position: 0,
    base_url: 'https://dev.example.com',
    hub_token: 'sealed-dev'
  })
  devEnv = Number(d)
  await db('nivaro_hub_environments').insert({
    app_id: appId,
    key: 'production',
    position: 1,
    base_url: 'https://prod.example.com',
    hub_token: 'sealed-prod'
  })
  await db('nivaro_hub_app_owners').insert({ app_id: appId, user_id: OWNER.id })
  connId = (
    await store.createConnection({
      provider: 'feed',
      name: 'Feed billing',
      config: {},
      secrets: { token: 'test-secret-feed-token-123' }
    })
  ).id
  await store.setAppAllowedConnections(appId, [connId])
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  registry.resetProvidersForTest()
  registry.registerProvider(feedAdapter)
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
  feed.rows = []
  feed.calls = []
  feed.fail = null
  feed.health = new Map()
  for (const t of [
    'nivaro_hub_resources',
    'nivaro_hub_resource_changes',
    'nivaro_hub_provider_costs',
    'nivaro_hub_domain_checks',
    'nivaro_extension_settings'
  ])
    await db(t).del()
})

async function managed(type: string, externalId: string, app: number | null, name = externalId) {
  return store.insertResource({
    connection_id: connId,
    provider: 'feed',
    type,
    external_id: externalId,
    name,
    scope: app == null ? 'shared' : 'app',
    app_id: app,
    environment_id: app === appId ? devEnv : null,
    observed: { type, externalId, name, fields: {}, tags: {} },
    observed_at: NOW
  })
}

const stored = () =>
  db('nivaro_hub_provider_costs').orderBy(['date', 'service', 'record_type']).select()

describe('provider cost feed', () => {
  it('cost rows map by external id before tag', async () => {
    const box = await managed('feed.box', 'box-1', appId)
    feed.rows = [
      // Names a managed resource of Shop AND carries Blog's tag: the resource wins.
      {
        date: '2026-11-18',
        amountCents: 1234,
        currency: 'USD',
        externalId: 'box-1',
        appTag: 'blog',
        service: 'Compute'
      },
      // Only the tag: Blog.
      { date: '2026-11-18', amountCents: 500, currency: 'usd', appTag: 'blog', service: 'Storage' }
    ]
    const r = await costs.costFeedTick({ now: () => NOW })
    expect(r).toMatchObject({ connections: 1, failed: 0, rows: 2 })
    const rows = await stored()
    expect(rows).toHaveLength(2)
    expect(rows.find((x) => x.service === 'Compute')).toMatchObject({
      app_id: appId,
      resource_id: box.id,
      source: 'resource',
      provider: 'feed'
    })
    // bigint columns read as text on every engine.
    expect(Number(rows.find((x) => x.service === 'Compute')?.amount_cents)).toBe(1234)
    expect(rows.find((x) => x.service === 'Storage')).toMatchObject({
      app_id: otherApp,
      resource_id: null,
      source: 'tag',
      currency: 'USD'
    })
    // The first read goes back a year; the feed state says how it went.
    expect(feed.calls[0]).toEqual({ from: '2025-11-20', to: '2026-11-20' })
    const st = await costs.readFeedState()
    expect(st[String(connId)]).toMatchObject({ ok: true, rows: 2, days: 1, error: null })
  })

  it('unassigned rows kept', async () => {
    await managed('feed.box', 'shared-1', null)
    feed.rows = [
      { date: '2026-11-17', amountCents: 900, currency: 'USD', service: 'Support' },
      { date: '2026-11-17', amountCents: 100, currency: 'USD', appTag: 'gone-app', service: 'X' },
      { date: '2026-11-17', amountCents: 300, currency: 'USD', externalId: 'shared-1' },
      // Bad rows are skipped, never stored.
      { date: '2026-13-01', amountCents: 5, currency: 'USD' },
      { date: '2026-11-17', amountCents: Number.NaN, currency: 'USD' },
      { date: '2026-11-17', amountCents: 5, currency: 'dollars' },
      { date: '2024-01-01', amountCents: 5, currency: 'USD' }
    ]
    await costs.costFeedTick({ now: () => NOW })
    const rows = await stored()
    expect(rows).toHaveLength(3)
    expect(rows.filter((x) => x.app_id == null)).toHaveLength(3)
    expect(rows.map((x) => x.source).sort()).toEqual(['none', 'none', 'resource'])
    expect((await costs.readFeedState())[String(connId)]?.skipped).toBe(4)

    const s = await costs.outsideSpend(NOW)
    expect(s.months).toHaveLength(12)
    expect(s.months[11]).toBe('2026-11')
    expect(s.rows.map((r) => [r.kind, r.month_to_date_cents])).toEqual([
      ['shared', 300],
      ['unassigned', 1000]
    ])
    expect(s.totals).toEqual([
      { currency: 'USD', month_to_date_cents: 1300, last_12_months_cents: 1300 }
    ])
    expect(s.feeds).toEqual([
      expect.objectContaining({ connection_id: connId, through: '2026-11-17', ok: true })
    ])
    const csv = costs.outsideSpendCsv(s).join('\r\n')
    expect(csv).toContain('Outside spend')
    expect(csv).toContain('"Unassigned","","Feed Co","unassigned",10.00,10.00,"USD"')
    expect(csv).toContain('"Shared resources","","Feed Co","shared",3.00,3.00,"USD"')
  })

  it('re-run of same day replaces, never doubles', async () => {
    await managed('feed.box', 'box-1', appId)
    feed.rows = [
      { date: '2026-11-18', amountCents: 1000, currency: 'USD', externalId: 'box-1', service: 'A' },
      // Two rows of one key are one stored row (summed).
      { date: '2026-11-18', amountCents: 250, currency: 'USD', externalId: 'box-1', service: 'A' },
      { date: '2026-11-19', amountCents: 400, currency: 'USD', externalId: 'box-1', service: 'A' }
    ]
    await costs.costFeedTick({ now: () => NOW })
    expect((await stored()).map((r) => [r.date, Number(r.amount_cents)])).toEqual([
      ['2026-11-18', 1250],
      ['2026-11-19', 400]
    ])
    // The provider revised the 19th and has the 20th now; the 18th is not in this answer.
    feed.rows = [
      { date: '2026-11-19', amountCents: 450, currency: 'USD', externalId: 'box-1', service: 'A' },
      { date: '2026-11-20', amountCents: 80, currency: 'USD', externalId: 'box-1', service: 'A' }
    ]
    const later = new Date('2026-11-21T06:10:00Z')
    await costs.costFeedTick({ now: () => later })
    await costs.costFeedTick({ now: () => later })
    expect((await stored()).map((r) => [r.date, Number(r.amount_cents)])).toEqual([
      ['2026-11-18', 1250],
      ['2026-11-19', 450],
      ['2026-11-20', 80]
    ])
    // Later reads go back REREAD_DAYS only.
    expect(feed.calls.at(-1)).toEqual({ from: '2026-10-17', to: '2026-11-21' })
  })

  it('keeps 400 days, scrubs a failure and reads it into billed + learned tax', async () => {
    await db('nivaro_hub_provider_costs').insert([
      {
        connection_id: connId,
        provider: 'feed',
        date: '2025-09-01',
        service: 'Old',
        record_type: 'usage',
        amount_cents: 1,
        currency: 'USD',
        source: 'none'
      },
      ...['2026-08-10', '2026-09-10', '2026-10-10'].flatMap((date) => [
        {
          connection_id: connId,
          provider: 'feed',
          date,
          app_id: appId,
          service: 'Compute',
          record_type: 'usage',
          amount_cents: 10_000,
          currency: 'USD',
          source: 'tag'
        },
        {
          connection_id: connId,
          provider: 'feed',
          date,
          service: 'Tax',
          record_type: 'tax',
          amount_cents: 800,
          currency: 'USD',
          source: 'none'
        }
      ]),
      {
        connection_id: connId,
        provider: 'feed',
        date: '2026-11-05',
        app_id: appId,
        service: 'Compute',
        record_type: 'usage',
        amount_cents: 4200,
        currency: 'USD',
        source: 'tag'
      }
    ])
    feed.fail = new ProviderError('FEED_DOWN', 'bad token test-secret-feed-token-123 refused')
    const r = await costs.costFeedTick({ now: () => NOW })
    expect(r).toMatchObject({ connections: 1, failed: 1, pruned: 1 })
    const st = (await costs.readFeedState())[String(connId)]
    expect(st?.ok).toBe(false)
    expect(st?.error).toContain('FEED_DOWN')
    expect(st?.error).not.toContain('test-secret-feed-token-123')
    // Task 44a's readers find the table and its record_type column.
    const rates = await pricing.effectiveRates(connId, { now: NOW, config: {} })
    expect(rates).toMatchObject({ source: 'bill', taxPercent: 8, months: 3 })
    const lc = await live.liveCosts({ appIds: [appId] }, NOW)
    expect(lc.billed).toEqual({ throughDate: '2026-11-05', monthToDateCents: 4200 })
    const s = await costs.outsideSpend(NOW)
    const shop = s.rows.find((x) => x.kind === 'app' && x.app_id === appId)
    expect(shop).toMatchObject({
      app_name: 'Shop',
      provider_label: 'Feed Co',
      month_to_date_cents: 4200,
      last_12_months_cents: 34_200
    })
    expect(shop?.months_cents.slice(-4)).toEqual([10_000, 10_000, 10_000, 4200])
  })

  it('yearly cost needs approval for owner', async () => {
    const plan = (yearly: boolean) =>
      engine.planResourceChange(
        {
          connectionId: connId,
          scope: 'app',
          appId,
          environmentId: devEnv,
          ops: [{ action: 'create', type: 'feed.box', fields: { name: `b-${yearly}`, yearly } }]
        },
        OWNER
      )
    const y = await plan(true)
    expect(y.ops[0].risk).toContain('cost')
    expect(y.needsApproval).toBe(true)
    expect(y.costTotal?.yearlyCents).toBe(1500)
    const n = await plan(false)
    expect(n.ops[0].risk).not.toContain('cost')
    expect(n.needsApproval).toBe(false)
  })
})

describe('domain watch', () => {
  it('domain expiring fires notify once per threshold', async () => {
    const dom = await managed('feed.domain', 'example.com', appId, 'example.com')
    // A non-registrar type is never asked.
    await managed('feed.box', 'box-9', appId)
    const notify = vi.fn()
    const notice = vi.fn(async () => 1)
    const recipients = vi.fn(async () => ['u1'])
    const at = (iso: string) => ({ now: () => new Date(iso), notify, notice, recipients })
    const answer = (expiresAt: string, autoRenew = false): HealthAnswer => ({
      status: 'ok',
      checkedAt: NOW.toISOString(),
      details: { expiresAt, autoRenew, locked: true }
    })
    feed.health.set('example.com', answer('2027-01-20T00:00:00Z'))

    // 61 days out: nothing.
    expect(await domains.domainWatchTick(at('2026-11-20T00:00:00Z'))).toEqual({
      checked: 1,
      warned: 0
    })
    // 44 days out: the 45-day warning, once.
    await domains.domainWatchTick(at('2026-12-07T00:00:00Z'))
    await domains.domainWatchTick(at('2026-12-08T00:00:00Z'))
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenLastCalledWith(
      'domain.expiring',
      expect.objectContaining({ appId, dedupKey: `domain:${dom.id}:45` })
    )
    // 13 days out: the 14-day warning, once.
    await domains.domainWatchTick(at('2027-01-07T00:00:00Z'))
    await domains.domainWatchTick(at('2027-01-08T00:00:00Z'))
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1][1]).toMatchObject({ severity: 'critical' })
    // Expired: once more.
    await domains.domainWatchTick(at('2027-01-21T00:00:00Z'))
    await domains.domainWatchTick(at('2027-01-22T00:00:00Z'))
    expect(notify).toHaveBeenCalledTimes(3)
    expect(notice).toHaveBeenCalledTimes(3)

    // Renewed for a year: the thresholds start over (auto-renew on skips the 45-day one).
    feed.health.set('example.com', answer('2028-01-20T00:00:00Z', true))
    await domains.domainWatchTick(at('2027-01-23T00:00:00Z'))
    await domains.domainWatchTick(at('2027-12-10T00:00:00Z'))
    expect(notify).toHaveBeenCalledTimes(3)
    await domains.domainWatchTick(at('2028-01-10T00:00:00Z'))
    expect(notify).toHaveBeenCalledTimes(4)

    const listed = await domains.listDomains([appId], new Date('2028-01-10T00:00:00Z'))
    expect(listed).toEqual([
      expect.objectContaining({
        domain: 'example.com',
        state: 'warning',
        days_left: 10,
        auto_renew: true,
        locked: true
      })
    ])
    expect(await domains.listDomains([otherApp])).toEqual([])

    // A registrar that fails: an error row, no warning; a domain no longer managed leaves.
    feed.health.set('example.com', null)
    await domains.domainWatchTick(at('2028-01-11T00:00:00Z'))
    expect((await domains.listDomains(null))[0]).toMatchObject({
      state: 'error',
      error_code: 'HEALTH_FAILED'
    })
    expect(notify).toHaveBeenCalledTimes(4)
    await store.updateResource(dom.id, { deleted_at: new Date() })
    await domains.domainWatchTick(at('2028-01-12T00:00:00Z'))
    expect(await domains.listDomains(null)).toEqual([])
  })
})
