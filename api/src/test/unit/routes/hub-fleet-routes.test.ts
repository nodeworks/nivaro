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
const { rollupHours, writeFleetStatus } = await import('../../../services/hub/fleet/store.js')
const { PROBE_LOCK_KEY, withLock } = await import('../../../services/hub/fleet/lock.js')

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001'
const OWNER = 'bbbbbbbb-0000-4000-8000-000000000002'
const OTHER = 'cccccccc-0000-4000-8000-000000000003'
const asAdmin = { 'x-user': ADMIN, 'x-admin': '1' }
const asOwner = { 'x-user': OWNER }
const asOther = { 'x-user': OTHER }

/** An in-memory Redis: SET (NX, EX/PX ignored for expiry), GET, DEL, and the release script. */
class FakeRedis {
  store = new Map<string, string>()
  async get(k: string) {
    return this.store.get(k) ?? null
  }
  async set(k: string, v: string, ...args: Array<string | number>) {
    if (args.includes('NX') && this.store.has(k)) return null
    this.store.set(k, v)
    return 'OK'
  }
  async del(...keys: string[]) {
    for (const k of keys) this.store.delete(k)
    return keys.length
  }
  async eval(_script: string, _n: number, key: string | number, token: string | number) {
    if (this.store.get(String(key)) === String(token)) {
      this.store.delete(String(key))
      return 1
    }
    return 0
  }
}
const redis = new FakeRedis()

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
  app.decorate('redis', redis as never)
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
  redis.store.clear()
  for (const t of [
    'nivaro_hub_fleet_status',
    'nivaro_hub_uptime_samples',
    'nivaro_hub_uptime_hours',
    'nivaro_hub_fleet_alerts',
    'nivaro_hub_slo_reports',
    'nivaro_hub_deploys',
    'nivaro_hub_shared_deploys',
    'nivaro_hub_moves',
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

/** Known releases: successful Hub deploys of these versions (on staging). */
async function knownDeploys(versions: string[]) {
  for (const v of versions)
    await db('nivaro_hub_deploys').insert({
      app_id: efp,
      environment_id: staging,
      kind: 'promote',
      version: v,
      status: 'success',
      started_at: new Date('2026-11-01T10:00:00Z'),
      finished_at: new Date('2026-11-01T10:05:00Z')
    })
}

const baseOf = new Map<string, number>()
async function tick(map: Record<number, string>, now = new Date(), extra = {}) {
  for (const e of (await db('nivaro_hub_environments').select('id', 'base_url')) as Array<{
    id: number
    base_url: string
  }>)
    baseOf.set(e.base_url, Number(e.id))
  const probe = vi.fn(async (url: string) => {
    const v = map[baseOf.get(url) ?? -1]
    return {
      up: !!v,
      version_ok: !!v,
      ready: true,
      ms: 12,
      code: v ? null : 'UNREACHABLE',
      version: v ?? null
    }
  })
  const status = vi.fn(async () => ({
    state: 'ok' as const,
    version: null,
    preflight: 'ok',
    checked_at: new Date().toISOString(),
    source: 'hub-link' as const,
    readiness_score: 92,
    open_issues: 3
  }))
  const out = await runFleetProbeTick({ probe, status, now: () => now, ...extra })
  return { out, probe, status }
}

const fleetAs = async (headers: Record<string, string>) => {
  redis.store.clear() // the 30 s page cache
  return (await app.inject({ method: 'GET', url: '/hub/fleet', headers })).json().data
}

describe('probe tick', () => {
  it('stores one sample per active environment and the status snapshot', async () => {
    const { out } = await tick({ [staging]: '0.3.214', [prod]: '0.3.210' })
    expect(out).toMatchObject({ environments: 3, probed: 3, samples: 3, status_reads: 3, down: 1 })
    const st = await db('nivaro_hub_fleet_status').where({ environment_id: prod }).first()
    expect(st).toMatchObject({ version: '0.3.210', readiness_score: 92, open_issues: 3 })
  })
  it('at most one sample a minute; status every 5 minutes (or forced); version_since on change', async () => {
    const t0 = new Date('2026-11-24T10:00:00.000Z')
    await tick({ [prod]: '0.3.210' }, t0)
    const since0 = (await db('nivaro_hub_fleet_status').where({ environment_id: prod }).first())
      .version_since
    const r1 = await tick({ [prod]: '0.3.210' }, new Date(t0.getTime() + 20_000))
    expect(r1.out).toMatchObject({ samples: 0, status_reads: 0 })
    const r2 = await tick({ [prod]: '0.3.210' }, new Date(t0.getTime() + 25_000), {
      forceStatus: true
    })
    expect(r2.out).toMatchObject({ samples: 0, status_reads: 3 })
    const r3 = await tick({ [prod]: '0.3.211' }, new Date(t0.getTime() + 60_000))
    expect(r3.out.samples).toBe(3)
    const row = await db('nivaro_hub_fleet_status').where({ environment_id: prod }).first()
    expect(row.version_since).not.toEqual(since0)
  })
  it('an environment not active, or busy with a Hub run, stores no sample', async () => {
    await db('nivaro_hub_environments').where({ id: staging }).update({ status: 'maintenance' })
    await db('nivaro_hub_deploys').insert({
      app_id: efp,
      environment_id: prod,
      kind: 'promote',
      version: '0.3.214',
      status: 'running'
    })
    const { out, probe } = await tick({ [prod]: '0.3.210', [poleProd]: '0.3.214' })
    expect(out).toMatchObject({ environments: 2, samples: 1, busy: 1 })
    expect(probe).toHaveBeenCalledTimes(1)
  })
  it('the status write is race-safe and cuts what does not fit', async () => {
    const now = new Date()
    await Promise.all([
      writeFleetStatus(
        prod,
        efp,
        {
          probe: { up: true, version_ok: true, ready: true, ms: 1, code: null, version: '0.3.214' }
        },
        now
      ),
      writeFleetStatus(
        prod,
        efp,
        {
          status: {
            state: 'ok',
            version: 'v'.repeat(80),
            preflight: 'warn-and-more-words',
            checked_at: '',
            source: 'hub-link'
          }
        },
        now
      )
    ])
    const rows = await db('nivaro_hub_fleet_status').where({ environment_id: prod })
    expect(rows).toHaveLength(1)
    expect(String(rows[0].version ?? '').length).toBeLessThanOrEqual(64)
    expect(String(rows[0].preflight ?? '').length).toBeLessThanOrEqual(16)
  })
  it('the probe lock lets one run at a time', async () => {
    let inner: unknown = 'not run'
    const outer = await withLock(redis, PROBE_LOCK_KEY, async () => {
      inner = await withLock(redis, PROBE_LOCK_KEY, async () => 'second')
      return 'first'
    })
    expect(outer).toEqual({ ran: true, value: 'first' })
    expect(inner).toEqual({ ran: false })
    expect(redis.store.has(PROBE_LOCK_KEY)).toBe(false)
  })
})

describe('GET /hub/fleet', () => {
  it('admins see every environment with drift in known releases, placement, uptime, last deploy', async () => {
    await knownDeploys(['0.3.210', '0.3.211', '0.3.212', '0.3.213', '0.3.214'])
    await tick({ [staging]: '0.3.214', [prod]: '0.3.210', [poleProd]: '99.0.0' })
    await rollupHours(new Date())
    await db('nivaro_hub_deploys').insert({
      app_id: efp,
      environment_id: prod,
      kind: 'rollback',
      version: '0.3.210',
      status: 'success',
      started_by: OWNER,
      started_at: new Date('2026-11-20T10:00:00Z'),
      finished_at: new Date('2026-11-20T10:05:00Z')
    })
    const data = await fleetAs(asAdmin)
    expect(data.newest).toBe('0.3.214')
    expect(data.rows).toHaveLength(3)
    const p = data.rows.find((r: { environment_id: number }) => r.environment_id === prod)
    expect(p).toMatchObject({
      behind: 4,
      version_unverified: false,
      placement: 'none',
      readiness_score: 92,
      open_issues: 3,
      uptime_24h: 100,
      probe_stale: false,
      last_deploy: { status: 'success', by_name: 'Owen Owner' }
    })
    const pp = data.rows.find((r: { environment_id: number }) => r.environment_id === poleProd)
    // A version above every known release: flagged, never "behind" anything.
    expect(pp).toMatchObject({ placement: 'shared', version_unverified: true, behind: null })
  })
  it('owners see their apps only; others see nothing; answers are cached 30 s per viewer', async () => {
    const own = await fleetAs(asOwner)
    expect(own.rows.map((r: { app_key: string }) => r.app_key)).toEqual(['efp', 'efp'])
    expect((await fleetAs(asOther)).rows).toEqual([])
    await app.inject({ method: 'GET', url: '/hub/fleet', headers: asOwner })
    expect([...redis.store.keys()]).toContain(`nvr:hub:fleet-page:${OWNER}`)
  })
})

describe('drift alerts', () => {
  const on = () => {
    const s = defaultFleetSettings()
    s.rules = s.rules.map((r) => ({ ...r, enabled: true }))
    return s
  }
  const deps = (notify: (...args: any[]) => Promise<void>, extra = {}) => ({
    notify,
    admins: async () => [ADMIN],
    settings: on(),
    refreshRegistry: async () => null,
    ...extra
  })

  it('opens once per rule + environment, tells owners + admins once, resolves when gone', async () => {
    await knownDeploys(['0.3.205', '0.3.206', '0.3.207', '0.3.208', '0.3.209', '0.3.214'])
    await tick({ [staging]: '0.3.214', [prod]: '0.3.205', [poleProd]: '0.3.214' })
    const notify = vi.fn(async () => {})
    const r1 = await runFleetAlertTick(deps(notify))
    // behind-newest (5 behind ≥ 5) and staging-production (5 apart > 3), both on production.
    expect(r1).toMatchObject({ opened: 2, resolved: 0 })
    expect(notify).toHaveBeenCalledTimes(2) // one per person (owner + admin), not per alert
    expect(
      (await db('nivaro_hub_fleet_alerts')).every((a) => a.subject_key === `env:${prod}`)
    ).toBe(true)
    const r2 = await runFleetAlertTick(deps(notify))
    expect(r2).toMatchObject({ opened: 0 })
    expect(notify).toHaveBeenCalledTimes(2)

    const p = (await fleetAs(asAdmin)).rows.find(
      (r: { environment_id: number }) => r.environment_id === prod
    )
    expect(p.alerts.map((a: { rule_id: string }) => a.rule_id).sort()).toEqual([
      'behind-newest',
      'staging-production'
    ])

    await tick(
      { [staging]: '0.3.214', [prod]: '0.3.214', [poleProd]: '0.3.214' },
      new Date(Date.now() + 61_000)
    )
    const r3 = await runFleetAlertTick(deps(notify))
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

  it('an environment under a move keeps its alert (no resolve, no re-open)', async () => {
    await knownDeploys(['0.3.205', '0.3.206', '0.3.207', '0.3.208', '0.3.209', '0.3.214'])
    await tick({ [staging]: '0.3.214', [prod]: '0.3.205', [poleProd]: '0.3.214' })
    const notify = vi.fn(async () => {})
    await runFleetAlertTick(deps(notify))
    const r = await runFleetAlertTick(deps(notify, { busy: async () => new Set([prod]) }))
    expect(r).toMatchObject({ resolved: 0, opened: 0 })
    expect(await db('nivaro_hub_fleet_alerts').whereNull('resolved_at')).toHaveLength(2)
  })

  it('administrators that cannot be read: nothing stamped, the next pass tells', async () => {
    await knownDeploys(['0.3.205', '0.3.206', '0.3.207', '0.3.208', '0.3.209', '0.3.214'])
    await tick({ [staging]: '0.3.214', [prod]: '0.3.205', [poleProd]: '0.3.214' })
    const notify = vi.fn(async () => {})
    const fail = async () => {
      throw new Error('db')
    }
    await runFleetAlertTick(deps(notify, { admins: fail }))
    expect(notify).not.toHaveBeenCalled()
    expect(await db('nivaro_hub_fleet_alerts').whereNotNull('notified_at')).toHaveLength(0)
    await runFleetAlertTick(deps(notify))
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('a rule just turned on tells one summary line, not one per environment', async () => {
    await knownDeploys(['0.3.205', '0.3.206', '0.3.207', '0.3.208', '0.3.209', '0.3.214'])
    await tick({ [staging]: '0.3.205', [prod]: '0.3.205', [poleProd]: '0.3.205' })
    const notify = vi.fn(async (_uid: string, _note: { message: string }) => {})
    const s = defaultFleetSettings()
    s.rules = s.rules.map((r) => ({ ...r, enabled: r.id === 'behind-newest' }))
    await runFleetAlertTick({ ...deps(notify), settings: s })
    const adminNote = notify.mock.calls.find((c) => c[0] === ADMIN)?.[1]
    expect(adminNote?.message).toBe(
      'Releases behind the newest (just turned on): 3 environments match.'
    )
  })

  it('rules ship off: nothing fires by default', async () => {
    await knownDeploys(['0.3.205', '0.3.206', '0.3.207', '0.3.208', '0.3.209', '0.3.214'])
    await tick({ [staging]: '0.3.205', [prod]: '0.3.205', [poleProd]: '0.3.205' })
    const notify = vi.fn(async () => {})
    const r = await runFleetAlertTick({ ...deps(notify), settings: defaultFleetSettings() })
    expect(r).toMatchObject({ findings: 0, opened: 0 })
  })
})

describe('monthly SLO report', () => {
  const hour = (d: string, samples: number, up: number) => ({
    environment_id: prod,
    hour: new Date(d),
    samples,
    up_samples: up
  })
  it('catches up ended months from the hours, tells owners per app and admins once, never twice', async () => {
    await db('nivaro_hub_uptime_hours').insert([
      hour('2026-09-30T10:00:00Z', 60, 60),
      hour('2026-10-05T00:00:00Z', 30, 30),
      hour('2026-10-06T00:00:00Z', 10, 0)
    ])
    const notify = vi.fn(async () => {})
    const deps = {
      now: new Date('2026-11-01T07:00:00Z'),
      notify,
      admins: async () => [ADMIN],
      settings: defaultFleetSettings()
    }
    const out = await runSloReport(deps)
    expect(out.months).toEqual(['2026-09', '2026-10'])
    expect(out).toMatchObject({ environments: 2, missed: 1, notified: 4 })
    const oct = await db('nivaro_hub_slo_reports').where({ month: '2026-10' }).first()
    expect(oct).toMatchObject({ samples: 40, up_samples: 30, uptime_bp: 7500, target_bp: 9950 })
    expect(oct.sent_at).not.toBeNull()
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
    const read0 = await app.inject({ method: 'GET', url: '/hub/fleet/settings', headers: asAdmin })
    expect(read0.json().data.rules.every((r: { enabled: boolean }) => !r.enabled)).toBe(true)
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

describe('Check now', () => {
  it('answers 202 at once, refuses a second one while it runs, and reports the result', async () => {
    const first = await app.inject({ method: 'POST', url: '/hub/fleet/check', headers: asAdmin })
    expect(first.statusCode).toBe(202)
    expect(first.json().data.status).toBe('running')
    const second = await app.inject({ method: 'POST', url: '/hub/fleet/check', headers: asAdmin })
    expect(second.statusCode).toBe(409)
    expect(second.json().code).toBe('CHECK_RUNNING')
    let state: { status: string } | null = null
    for (let i = 0; i < 100; i++) {
      state = (
        await app.inject({ method: 'GET', url: '/hub/fleet/check', headers: asAdmin })
      ).json().data
      if (state?.status !== 'running') break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(state?.status).not.toBe('running')
    expect(
      (await app.inject({ method: 'POST', url: '/hub/fleet/check', headers: asOwner })).statusCode
    ).toBe(403)
  })
})

describe('uptime route', () => {
  it('owners read their environment from the hourly rows; others get 404', async () => {
    await tick({ [prod]: '0.3.214' })
    await rollupHours(new Date())
    const ok = await app.inject({
      method: 'GET',
      url: `/hub/fleet/environments/${prod}/uptime?days=1`,
      headers: asOwner
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.hours[0]).toMatchObject({ samples: 1, up: 1, ms: 12 })
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
