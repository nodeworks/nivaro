import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub fleet (migration 566): probe tick, fleet page, drift alerts, monthly SLO report, settings
// and the audit timeline, on a real SQLite with the Hub migrations. Apps are never contacted: the
// probe and the status reader are injected / mocked; notifications go to a spy.

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
vi.mock('../../../version.js', () => ({ NIVARO_VERSION: '0.3.214' }))
vi.mock('../../../middleware/authenticate.js', () => {
  const sign = async (req: {
    headers: Record<string, string | undefined>
    user?: unknown
    isAdmin?: boolean
  }) => {
    const id = req.headers['x-user']
    if (!id) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    req.user = { id, status: 'active' }
    req.isAdmin = req.headers['x-admin'] === '1'
  }
  const admin = async (req: Parameters<typeof sign>[0]) => {
    await sign(req)
    if (!req.isAdmin)
      throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
  }
  return { requireAuth: vi.fn(sign), requireAdmin: vi.fn(admin), authenticate: vi.fn(sign) }
})
vi.mock('../../../services/activity.js', async () => {
  const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
  return {
    logActivity: vi.fn(async (o: Record<string, unknown>) => {
      await db('nivaro_activity').insert({
        action: o.action,
        user: o.user ?? null,
        collection: o.collection ?? null,
        item: o.item ?? null,
        comment: o.comment ?? null,
        timestamp: new Date()
      })
      return null
    })
  }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/543_hub_promotions.js'),
  await import('../../../db/migrations/545_hub_creations.js'),
  await import('../../../db/migrations/550_hub_oidc.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js'),
  await import('../../../db/migrations/553_hub_moves.js'),
  await import('../../../db/migrations/566_hub_fleet.js')
]
const { hubFleetRoutes } = await import('../../../routes/hub-fleet.js')
const { runFleetProbeTick } = await import('../../../services/hub/fleet/tick.js')
const { runFleetAlertTick } = await import('../../../services/hub/fleet/alerts.js')
const { runSloReport } = await import('../../../services/hub/fleet/report.js')
const { defaultFleetSettings } = await import('../../../services/hub/fleet/settings.js')

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001'
const OWNER = 'bbbbbbbb-0000-4000-8000-000000000002'
const OTHER = 'cccccccc-0000-4000-8000-000000000003'
const asAdmin = { 'x-user': ADMIN, 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }
const asOther = { 'x-user': OTHER }

let app: FastifyInstance
let prevHub: string | undefined
let efp: number
let pole: number
let prod: number
let staging: number
let poleProd: number

const idOf = (r: unknown[]) => {
  const x = r[0] as { id: number } | number
  return typeof x === 'object' ? x.id : x
}

beforeAll(async () => {
  prevHub = process.env.HUB
  process.env.HUB = 'on'
  for (const m of migrations) await m.up(db)
  await db.schema.createTable('nivaro_activity', (t) => {
    t.increments('id')
    t.string('action')
    t.string('user').nullable()
    t.string('collection').nullable()
    t.string('item').nullable()
    t.text('comment').nullable()
    t.dateTime('timestamp')
  })
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id')
    t.string('first_name').nullable()
    t.string('last_name').nullable()
    t.string('email').nullable()
  })
  await db.schema.createTable('nivaro_extension_settings', (t) => {
    t.increments('id')
    t.string('extension_id')
    t.string('key')
    t.text('value').nullable()
    t.dateTime('updated_at').nullable()
  })
  await db('nivaro_users').insert([
    { id: ADMIN, first_name: 'Ada', last_name: 'Admin' },
    { id: OWNER, first_name: 'Owen', last_name: 'Owner' }
  ])
  app = Fastify()
  await app.register(hubFleetRoutes, { prefix: '/hub' })
  await app.ready()
})
afterAll(async () => {
  await app.close()
  await db.destroy()
  if (prevHub === undefined) delete process.env.HUB
  else process.env.HUB = prevHub
})

beforeEach(async () => {
  for (const t of [
    'nivaro_hub_fleet_status',
    'nivaro_hub_uptime_samples',
    'nivaro_hub_fleet_alerts',
    'nivaro_hub_slo_reports',
    'nivaro_hub_deploys',
    'nivaro_hub_shared_deploys',
    'nivaro_hub_environments',
    'nivaro_hub_app_owners',
    'nivaro_hub_apps',
    'nivaro_hub_placements',
    'nivaro_activity',
    'nivaro_extension_settings'
  ])
    await db(t).del()
  efp = idOf(
    await db('nivaro_hub_apps')
      .insert({ key: 'efp', name: 'EFP', signin_mode: 'direct', extensions: '[]' })
      .returning('id')
  )
  pole = idOf(
    await db('nivaro_hub_apps')
      .insert({ key: 'pole', name: 'Pole', signin_mode: 'direct', extensions: '[]' })
      .returning('id')
  )
  await db('nivaro_hub_app_owners').insert({ app_id: efp, user_id: OWNER })
  const shared = idOf(
    await db('nivaro_hub_placements')
      .insert({ kind: 'shared', shared_deployment_id: null })
      .returning('id')
  )
  const env = async (appId: number, key: string, position: number, placement: number | null) =>
    idOf(
      await db('nivaro_hub_environments')
        .insert({
          app_id: appId,
          key,
          position,
          status: 'active',
          base_url: `https://${key}.${appId}.example.com`,
          hostnames: '[]',
          placement_id: placement
        })
        .returning('id')
    )
  staging = await env(efp, 'staging', 0, null)
  prod = await env(efp, 'production', 1, null)
  poleProd = await env(pole, 'production', 0, shared)
})

const versions = (map: Record<number, string>) => ({
  targets: undefined,
  probe: vi.fn(async (url: string) => {
    const id = Object.entries(map).find(([envId]) => url.includes(urlKey(Number(envId))))
    return {
      up: !!id,
      version_ok: !!id,
      ready: true,
      ms: 12,
      code: id ? null : 'UNREACHABLE',
      version: id ? id[1] : null
    }
  }),
  status: vi.fn(async () => ({
    state: 'ok' as const,
    version: null,
    preflight: 'ok',
    checked_at: new Date().toISOString(),
    source: 'hub-link' as const,
    readiness_score: 92,
    open_issues: 3
  }))
})
const urls = new Map<number, string>()
const urlKey = (envId: number) => urls.get(envId) ?? '\u0000'

async function tick(map: Record<number, string>, now = new Date()) {
  for (const e of (await db('nivaro_hub_environments').select('id', 'base_url')) as Array<{
    id: number
    base_url: string
  }>)
    urls.set(Number(e.id), e.base_url)
  const deps = versions(map)
  return runFleetProbeTick({ probe: deps.probe, status: deps.status, now: () => now })
}

describe('probe tick', () => {
  it('stores one sample per active environment and the status snapshot', async () => {
    const out = await tick({ [staging]: '0.3.214', [prod]: '0.3.210' })
    expect(out).toMatchObject({ environments: 3, probed: 3, status_reads: 3, down: 1 })
    expect(await db('nivaro_hub_uptime_samples').count({ n: '*' })).toEqual([{ n: 3 }])
    const st = await db('nivaro_hub_fleet_status').where({ environment_id: prod }).first()
    expect(st).toMatchObject({ version: '0.3.210', readiness_score: 92, open_issues: 3 })
  })
  it('version_since moves only when the version changes; status is read every 5 minutes', async () => {
    const t0 = new Date('2026-11-24T10:00:00.000Z')
    await tick({ [prod]: '0.3.210' }, t0)
    const since0 = (await db('nivaro_hub_fleet_status').where({ environment_id: prod }).first())
      .version_since
    const r1 = await tick({ [prod]: '0.3.210' }, new Date(t0.getTime() + 60_000))
    expect(r1.status_reads).toBe(0)
    const row1 = await db('nivaro_hub_fleet_status').where({ environment_id: prod }).first()
    expect(row1.version_since).toEqual(since0)
    await tick({ [prod]: '0.3.211' }, new Date(t0.getTime() + 120_000))
    const row2 = await db('nivaro_hub_fleet_status').where({ environment_id: prod }).first()
    expect(row2.version_since).not.toEqual(since0)
  })
  it('an environment not active makes no sample', async () => {
    await db('nivaro_hub_environments').where({ id: staging }).update({ status: 'maintenance' })
    const out = await tick({ [prod]: '0.3.210' })
    expect(out.environments).toBe(2)
  })
})

describe('GET /hub/fleet', () => {
  it('admins see every environment with drift, placement, uptime and last deploy', async () => {
    await tick({ [staging]: '0.3.214', [prod]: '0.3.210', [poleProd]: '0.3.214' })
    await db('nivaro_hub_deploys').insert({
      app_id: efp,
      environment_id: prod,
      kind: 'promote',
      version: '0.3.210',
      status: 'success',
      started_by: OWNER,
      started_at: new Date('2026-11-20T10:00:00Z'),
      finished_at: new Date('2026-11-20T10:05:00Z')
    })
    const res = await app.inject({ method: 'GET', url: '/hub/fleet', headers: asAdmin })
    expect(res.statusCode).toBe(200)
    const data = res.json().data
    expect(data.newest).toBe('0.3.214')
    expect(data.rows).toHaveLength(3)
    const p = data.rows.find((r: { environment_id: number }) => r.environment_id === prod)
    expect(p).toMatchObject({
      behind: 4,
      placement: 'none',
      readiness_score: 92,
      open_issues: 3,
      uptime_24h: 100,
      last_deploy: { status: 'success', by_name: 'Owen Owner' }
    })
    const pp = data.rows.find((r: { environment_id: number }) => r.environment_id === poleProd)
    expect(pp.placement).toBe('shared')
  })
  it('owners see their apps only; others see nothing', async () => {
    const own = (await app.inject({ method: 'GET', url: '/hub/fleet', headers: asOwner })).json()
    expect(own.data.rows.map((r: { app_key: string }) => r.app_key)).toEqual(['efp', 'efp'])
    const other = (await app.inject({ method: 'GET', url: '/hub/fleet', headers: asOther })).json()
    expect(other.data.rows).toEqual([])
  })
})

describe('drift alerts', () => {
  it('opens once, tells owners + admins once, resolves when the finding goes', async () => {
    await tick({ [staging]: '0.3.214', [prod]: '0.3.205', [poleProd]: '0.3.214' })
    const notify = vi.fn(async () => {})
    const deps = { notify, admins: async () => [ADMIN], settings: defaultFleetSettings() }
    const r1 = await runFleetAlertTick(deps)
    // behind-newest (9 behind ≥ 5) and staging-production (9 apart > 3).
    expect(r1).toMatchObject({ opened: 2, resolved: 0 })
    expect(notify).toHaveBeenCalledTimes(2) // one per person (owner + admin), not per alert
    const r2 = await runFleetAlertTick(deps)
    expect(r2).toMatchObject({ opened: 0 })
    expect(notify).toHaveBeenCalledTimes(2)

    const fleet = (await app.inject({ method: 'GET', url: '/hub/fleet', headers: asAdmin })).json()
    const p = fleet.data.rows.find((r: { environment_id: number }) => r.environment_id === prod)
    expect(p.alerts.map((a: { rule_id: string }) => a.rule_id).sort()).toEqual([
      'behind-newest',
      'staging-production'
    ])

    await tick({ [staging]: '0.3.214', [prod]: '0.3.214', [poleProd]: '0.3.214' })
    const r3 = await runFleetAlertTick(deps)
    expect(r3.resolved).toBe(2)
    const open = await app.inject({ method: 'GET', url: '/hub/fleet/alerts', headers: asOwner })
    expect(open.json().data).toEqual([])
    const all = await app.inject({
      method: 'GET',
      url: '/hub/fleet/alerts?state=all',
      headers: asOwner
    })
    expect(all.json().data).toHaveLength(2)
  })
})

describe('monthly SLO report', () => {
  it('stores the month, tells owners per app and admins once, never twice', async () => {
    const at = (d: string, up: boolean) => ({
      environment_id: prod,
      at: new Date(d),
      up,
      version_ok: up,
      ready: up
    })
    await db('nivaro_hub_uptime_samples').insert([
      at('2026-10-05T00:00:00Z', true),
      at('2026-10-06T00:00:00Z', true),
      at('2026-10-07T00:00:00Z', true),
      at('2026-10-08T00:00:00Z', false),
      at('2026-11-02T00:00:00Z', false)
    ])
    const notify = vi.fn(async () => {})
    const deps = {
      now: new Date('2026-11-01T07:00:00Z'),
      notify,
      admins: async () => [ADMIN],
      settings: defaultFleetSettings()
    }
    const out = await runSloReport(deps)
    expect(out).toMatchObject({ month: '2026-10', environments: 1, missed: 1, notified: 2 })
    const row = await db('nivaro_hub_slo_reports').first()
    expect(row).toMatchObject({ samples: 4, up_samples: 3, uptime_bp: 7500, target_bp: 9950 })
    const again = await runSloReport(deps)
    expect(again.notified).toBe(0)
    const reports = await app.inject({ method: 'GET', url: '/hub/fleet/reports', headers: asOwner })
    expect(reports.json().data[0]).toMatchObject({ month: '2026-10', uptime: 75, met: false })
  })
})

describe('settings', () => {
  it('admin only; validated; targets of unknown environments dropped; logged', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/hub/fleet/settings', headers: asOwner })).statusCode
    ).toBe(403)
    const bad = await app.inject({
      method: 'PUT',
      url: '/hub/fleet/settings',
      headers: asAdmin,
      payload: { rules: [{ id: 'x', kind: 'nope', n: 1 }] }
    })
    expect(bad.statusCode).toBe(400)
    const res = await app.inject({
      method: 'PUT',
      url: '/hub/fleet/settings',
      headers: asAdmin,
      payload: {
        rules: [],
        slo: { default_target: 99.9, targets: { [String(prod)]: 99.95, '999999': 99 } },
        report_enabled: false
      }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.slo.targets).toEqual({ [String(prod)]: 99.95 })
    const read = await app.inject({ method: 'GET', url: '/hub/fleet/settings', headers: asAdmin })
    expect(read.json().data.report_enabled).toBe(false)
    expect(await db('nivaro_activity').where({ action: 'hub-fleet-settings' })).toHaveLength(1)
  })
})

describe('uptime route', () => {
  it('owners read their environment; others get 404', async () => {
    await tick({ [prod]: '0.3.214' })
    const ok = await app.inject({
      method: 'GET',
      url: `/hub/fleet/environments/${prod}/uptime?days=1`,
      headers: asOwner
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.hours[0]).toMatchObject({ samples: 1, up: 1 })
    const no = await app.inject({
      method: 'GET',
      url: `/hub/fleet/environments/${poleProd}/uptime`,
      headers: asOwner
    })
    expect(no.statusCode).toBe(404)
  })
})

describe('audit timeline', () => {
  beforeEach(async () => {
    const dep = idOf(
      await db('nivaro_hub_deploys')
        .insert({
          app_id: efp,
          environment_id: prod,
          kind: 'rollback',
          version: '0.3.209',
          status: 'failed',
          error: 'deploy job failed',
          started_by: OWNER,
          started_at: new Date('2026-11-23T10:00:00Z')
        })
        .returning('id')
    )
    await db('nivaro_activity').insert([
      {
        action: 'hub-promote-start',
        user: OWNER,
        collection: 'nivaro_hub_deploys',
        item: String(dep),
        timestamp: new Date('2026-11-23T10:00:00Z')
      },
      {
        action: 'hub-move-start',
        user: ADMIN,
        collection: 'nivaro_hub_environments',
        item: String(poleProd),
        comment: JSON.stringify({ move_id: 5, reason: 'save money' }),
        timestamp: new Date('2026-11-22T10:00:00Z')
      },
      {
        action: 'update',
        user: ADMIN,
        collection: 'nivaro_hub_drivers',
        item: '1',
        timestamp: new Date('2026-11-21T10:00:00Z')
      },
      {
        action: 'update',
        user: ADMIN,
        collection: 'nivaro_items',
        item: '1',
        timestamp: new Date('2026-11-21T10:00:00Z')
      }
    ])
    // A shared version change nobody started (no activity row).
    await db('nivaro_hub_shared_deploys').insert({
      shared_deployment_id: 1,
      kind: 'observed',
      version: '0.3.214',
      status: 'success',
      started_at: new Date('2026-11-20T10:00:00Z')
    })
  })

  it('lists Hub actions newest first with app, environment, who, result and note', async () => {
    const res = await app.inject({ method: 'GET', url: '/hub/audit', headers: asAdmin })
    expect(res.statusCode).toBe(200)
    const rows = res.json().data
    expect(rows.map((r: { action: string }) => r.action)).toEqual([
      'hub-promote-start',
      'hub-move-start',
      'update',
      'hub-shared-observed'
    ])
    expect(rows[0]).toMatchObject({
      label: 'Rollback started',
      category: 'rollback',
      app_key: 'efp',
      env_key: 'production',
      user_name: 'Owen Owner',
      result: 'failed'
    })
    expect(rows[1]).toMatchObject({ category: 'move', note: 'save money', app_key: 'pole' })
    expect(rows[3]).toMatchObject({ user_name: 'System', category: 'upgrade' })
  })

  it('filters by app, environment, person and category; CSV; admin only', async () => {
    const get = (q: string) =>
      app.inject({ method: 'GET', url: `/hub/audit?${q}`, headers: asAdmin }).then((r) => r.json())
    expect((await get(`app=${pole}`)).data).toHaveLength(1)
    expect((await get(`environment=${prod}`)).data).toHaveLength(1)
    expect((await get(`user=${OWNER}`)).data).toHaveLength(1)
    expect((await get('action=config')).data).toHaveLength(1)
    expect((await get('action=hub-move-start')).data).toHaveLength(1)
    expect((await get('from=2026-11-22&to=2026-11-22')).data).toHaveLength(1)
    expect(
      (await app.inject({ method: 'GET', url: '/hub/audit?from=nope', headers: asAdmin }))
        .statusCode
    ).toBe(400)
    expect(
      (await app.inject({ method: 'GET', url: '/hub/audit', headers: asOwner })).statusCode
    ).toBe(403)
    const csv = await app.inject({ method: 'GET', url: '/hub/audit.csv', headers: asAdmin })
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.body.split('\r\n').filter(Boolean)).toHaveLength(5)
  })
})
