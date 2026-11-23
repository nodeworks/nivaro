import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// Hub phase 5 Task 11: on a shared deployment (HUB_SHARED_DEPLOYMENT) the Background Jobs
// routes act for the caller's app. Pause / resume write that app's paused_crons and never touch
// the process roster; schedule edits answer 409 SCHEDULE_IS_DEPLOYMENT_WIDE; a settings time
// zone save leaves the deployment's cron zone alone. Self-hosted and Nivaro Cloud are unchanged.

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async () => {}),
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'admin-1' }
    req.isAdmin = true
  }),
  requireAdmin: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'admin-1' }
    req.isAdmin = true
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/formula-context.js', () => ({ bustFormulaContextCache: vi.fn() }))
vi.mock('../../../services/mail.js', () => ({ sendRawMail: vi.fn(), sendMail: vi.fn() }))
vi.mock('../../../services/teams-bot/config.js', () => ({ bustTeamsBotConfig: vi.fn() }))
vi.mock('../../../services/sms.js', () => ({ sendSms: vi.fn() }))
vi.mock('../../../services/mail-branding.js', () => ({ bustMailBrandingCache: vi.fn() }))
vi.mock('../../../services/session-replay-settings.js', () => ({
  REPLAY_SETTINGS_KEYS: [],
  applyReplaySettingsPatch: vi.fn(() => null)
}))
vi.mock('../../../services/settings-overrides.js', () => ({
  bustInstanceOverridesCache: vi.fn(),
  envOverrideKeys: vi.fn(() => []),
  envOverrideMap: vi.fn(() => ({})),
  describeEnvOverrides: vi.fn(() => []),
  INSTANCE_RESERVED_KEYS: [],
  instanceKey: vi.fn(() => 'test'),
  withoutReservedKeys: vi.fn((x: unknown) => x)
}))
vi.mock('../../../services/security.js', () => ({
  maintenanceState: vi.fn(async () => ({ on: false, source: 'settings' })),
  bustMaintenanceCache: vi.fn(),
  maintenanceWritten: vi.fn(),
  clearMaintenanceOverride: vi.fn(async () => {})
}))

/** Calls into services/row-schedules.js a settings save makes, with the app each ran in. */
const rsCalls = vi.hoisted(() => [] as Array<{ fn: string; tenant: string | null; arg?: unknown }>)
vi.mock('../../../services/row-schedules.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../services/row-schedules.js')>()
  const tc = await import('../../../db/tenant-context.js')
  return {
    ...real,
    resyncAllSchedules: vi.fn(async () => {
      rsCalls.push({ fn: 'resyncAllSchedules', tenant: tc.getTenantId() ?? null })
    }),
    announceScheduleChange: vi.fn((name?: string) => {
      rsCalls.push({ fn: 'announceScheduleChange', tenant: tc.getTenantId() ?? null, arg: name })
    })
  }
})

/** Each app's settings row ('' = the one self-hosted / cloud-static row). */
const sql = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  updates: [] as Array<{ tenant: string; sql: string; bindings: unknown[] }>
}))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  const tc = await import('../../../db/tenant-context.js')
  const db = makeFakeDb((q: FakeQuery) => {
    const tenant = tc.getTenantId() ?? ''
    const row = sql.rows.get(tenant) ?? { id: 1, paused_crons: null }
    sql.rows.set(tenant, row)
    if (q.method === 'update') {
      sql.updates.push({ tenant, sql: q.sql, bindings: q.bindings })
      if (q.sql.includes('paused_crons')) row.paused_crons = q.bindings[0]
      return 1
    }
    return q.method === 'first' ? { ...row } : [{ ...row }]
  })
  return { db, _backgroundDb: null, _staticDb: db, resolveDb: () => db }
})

const { CronManager } = await import('../../../plugins/cron.js')
const { cronRoutes } = await import('../../../routes/cron.js')
const { settingsRoutes } = await import('../../../routes/settings.js')
const { registrationMembers } = await import('../../../extensions/loader.js')
const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const { appPaused } = await import('../../../services/app-jobs.js')
const { forgetAppJobSettings } = await import('../../../services/app-job-settings.js')

type Manager = InstanceType<typeof CronManager>
let manager: Manager
const apps: FastifyInstance[] = []

/** The routes under test, with an `x-app` header putting the request in that app's context. */
async function build(): Promise<FastifyInstance> {
  manager = new CronManager({ ticksEnabled: () => true, onIssue: () => {} })
  manager.schedule('nightly-sync', '0 3 * * *', async () => {})
  manager.schedule('pool-monitor', '* * * * *', async () => {}) // a 'process' core job
  vi.spyOn(manager, 'pause')
  vi.spyOn(manager, 'resume')
  vi.spyOn(manager, 'setTimezone')
  vi.spyOn(manager, 'setInstanceTimezone')
  const app = Fastify()
  app.decorate('cron', manager)
  app.addHook('onRequest', (req, _reply, done) => {
    const appId = req.headers['x-app']
    if (typeof appId === 'string') runWithTenantDb({} as never, appId.toLowerCase(), done, appId)
    else done()
  })
  await app.register(cronRoutes, { prefix: '/cron' })
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.ready()
  apps.push(app)
  return app
}

const asApp = <T>(id: string, fn: () => Promise<T>) =>
  new Promise<T>((resolve, reject) =>
    runWithTenantDb({} as never, id.toLowerCase(), () => void fn().then(resolve, reject), id)
  )
const pausedIn = (tenant: string) =>
  JSON.parse(String(sql.rows.get(tenant)?.paused_crons ?? '[]')) as string[]

const saved = { ...process.env }
beforeEach(() => {
  sql.rows.clear()
  sql.updates.length = 0
  for (const t of ['A', 'B', '']) forgetAppJobSettings(t)
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
})
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close()
  manager?.stopAll()
  vi.restoreAllMocks()
  process.env = { ...saved }
})

describe('shared deployment: pause and resume are per app', () => {
  beforeEach(() => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
  })

  it('pausing in app A stops the job in A only and never touches the process roster', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/cron/nightly-sync/pause',
      headers: { 'x-app': 'A' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: { id: 'nightly-sync', paused: true } })
    expect(pausedIn('A')).toEqual(['nightly-sync'])
    expect(sql.rows.get('B')).toBeUndefined()
    expect(manager.pause).not.toHaveBeenCalled()
    expect(manager.isPaused('nightly-sync')).toBe(false)
    expect(await asApp('A', () => appPaused('nightly-sync'))).toBe(true)
    expect(await asApp('B', () => appPaused('nightly-sync'))).toBe(false)

    const listA = await app.inject({ url: '/cron', headers: { 'x-app': 'A' } })
    const listB = await app.inject({ url: '/cron', headers: { 'x-app': 'B' } })
    const pausedFlag = (r: typeof listA) =>
      r.json().data.find((j: { id: string }) => j.id === 'nightly-sync').paused
    expect(pausedFlag(listA)).toBe(true)
    expect(pausedFlag(listB)).toBe(false)
  })

  it('resume takes effect at once (the 60 s cache is cleared)', async () => {
    const app = await build()
    await app.inject({
      method: 'POST',
      url: '/cron/nightly-sync/pause',
      headers: { 'x-app': 'A' }
    })
    expect(await asApp('A', () => appPaused('nightly-sync'))).toBe(true) // now cached
    const res = await app.inject({
      method: 'POST',
      url: '/cron/nightly-sync/resume',
      headers: { 'x-app': 'A' }
    })
    expect(res.json()).toEqual({ data: { id: 'nightly-sync', paused: false } })
    expect(pausedIn('A')).toEqual([])
    expect(await asApp('A', () => appPaused('nightly-sync'))).toBe(false)
    expect(manager.resume).not.toHaveBeenCalled()
  })

  it('a job that runs once for the whole deployment cannot be paused by one app', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/cron/pool-monitor/pause',
      headers: { 'x-app': 'A' }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('SCHEDULE_IS_DEPLOYMENT_WIDE')
    expect(sql.updates).toEqual([])
    expect(manager.pause).not.toHaveBeenCalled()
  })

  for (const body of [
    { timezone: 'America/Chicago' },
    { expression: '0 4 * * *' },
    { expression: null },
    { after: 'pool-monitor' }
  ]) {
    it(`PATCH ${JSON.stringify(body)} answers 409 SCHEDULE_IS_DEPLOYMENT_WIDE`, async () => {
      const app = await build()
      const res = await app.inject({
        method: 'PATCH',
        url: '/cron/nightly-sync',
        headers: { 'x-app': 'A' },
        payload: body
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({
        error:
          'This app runs on a shared deployment; its job schedules are set for the whole deployment.',
        code: 'SCHEDULE_IS_DEPLOYMENT_WIDE'
      })
      expect(manager.setTimezone).not.toHaveBeenCalled()
      expect(sql.updates).toEqual([])
    })
  }

  it('reverting an override answers 409 too', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/cron/nightly-sync/revert',
      headers: { 'x-app': 'A' }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('SCHEDULE_IS_DEPLOYMENT_WIDE')
  })

  it('a settings sla_timezone save does not move the deployment cron zone', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: { 'x-app': 'A' },
      payload: { sla_timezone: 'America/Chicago' }
    })
    expect(res.statusCode).toBe(200)
    expect(manager.setInstanceTimezone).not.toHaveBeenCalled()
  })

  it("a settings sla_timezone save re-evaluates that app's row schedules and tells every replica", async () => {
    rsCalls.length = 0
    const app = await build()
    const res = await app.inject({
      method: 'PATCH',
      url: '/settings',
      headers: { 'x-app': 'A' },
      payload: { sla_timezone: 'America/Chicago' }
    })
    expect(res.statusCode).toBe(200)
    await vi.waitFor(() =>
      expect(rsCalls).toEqual([
        { fn: 'resyncAllSchedules', tenant: 'A' },
        { fn: 'announceScheduleChange', tenant: 'A', arg: '*' }
      ])
    )
  })
})

describe('self-hosted and Nivaro Cloud are unchanged', () => {
  for (const [label, env] of [
    ['self-hosted', {}],
    ['cloud', { CLOUD_META_DB_URL: 'mssql://meta' }]
  ] as const) {
    it(`${label}: pause / resume use the process roster and write its set`, async () => {
      Object.assign(process.env, env)
      const app = await build()
      const res = await app.inject({ method: 'POST', url: '/cron/nightly-sync/pause' })
      expect(res.json()).toEqual({ data: { id: 'nightly-sync', paused: true } })
      expect(manager.pause).toHaveBeenCalledWith('nightly-sync')
      expect(manager.isPaused('nightly-sync')).toBe(true)
      expect(pausedIn('')).toEqual(['nightly-sync'])
      // a 'process' core job pauses exactly like any other
      await app.inject({ method: 'POST', url: '/cron/pool-monitor/pause' })
      expect(pausedIn('')).toEqual(['nightly-sync', 'pool-monitor'])
      await app.inject({ method: 'POST', url: '/cron/nightly-sync/resume' })
      expect(manager.resume).toHaveBeenCalledWith('nightly-sync')
      expect(pausedIn('')).toEqual(['pool-monitor'])
      const list = await app.inject({ url: '/cron' })
      expect(list.json().data.find((j: { id: string }) => j.id === 'pool-monitor').paused).toBe(
        true
      )
    })

    it(`${label}: schedule edits still apply`, async () => {
      Object.assign(process.env, env)
      const app = await build()
      const res = await app.inject({
        method: 'PATCH',
        url: '/cron/nightly-sync',
        payload: { timezone: 'America/Chicago' }
      })
      expect(res.statusCode).toBe(200)
      expect(manager.setTimezone).toHaveBeenCalledWith('nightly-sync', 'America/Chicago')
      const rev = await app.inject({ method: 'POST', url: '/cron/nightly-sync/revert' })
      expect(rev.statusCode).toBe(200)
    })

    it(`${label}: a settings sla_timezone save still moves the cron zone`, async () => {
      Object.assign(process.env, env)
      rsCalls.length = 0
      const app = await build()
      const res = await app.inject({
        method: 'PATCH',
        url: '/settings',
        payload: { sla_timezone: 'America/Chicago' }
      })
      expect(res.statusCode).toBe(200)
      await vi.waitFor(() =>
        expect(manager.setInstanceTimezone).toHaveBeenCalledWith('America/Chicago')
      )
      expect(rsCalls).toEqual([])
    })
  }
})

describe('extension jobs choose their scope', () => {
  function members() {
    const cron = { schedule: vi.fn(), unschedule: vi.fn(), annotate: vi.fn() }
    const m = registrationMembers(
      'ext1',
      {
        app: { cron } as never,
        logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
        database: {} as never
      },
      { note: () => {}, own: () => {}, cronPrefix: 'ext:ext1:' }
    )
    return { m, cron }
  }

  it("passes scope: 'process' (and 'app') through to app.cron.schedule", () => {
    const { m, cron } = members()
    m.cron.schedule('sampler', '* * * * *', async () => {}, { scope: 'process' })
    m.cron.schedule('nightly', '0 3 * * *', async () => {}, { scope: 'app', heavy: true })
    expect(cron.schedule).toHaveBeenNthCalledWith(
      1,
      'ext:ext1:sampler',
      '* * * * *',
      expect.any(Function),
      { extensionId: 'ext1', scope: 'process' }
    )
    expect(cron.schedule).toHaveBeenNthCalledWith(
      2,
      'ext:ext1:nightly',
      '0 3 * * *',
      expect.any(Function),
      { extensionId: 'ext1', scope: 'app', heavy: true }
    )
  })

  it('drops a scope it does not know, and adds none when the extension gave none', () => {
    const { m, cron } = members()
    m.cron.schedule('a', '* * * * *', async () => {}, { scope: 'everywhere' as never })
    m.cron.schedule('b', '* * * * *', async () => {})
    expect(cron.schedule.mock.calls[0][3]).toEqual({ extensionId: 'ext1' })
    expect(cron.schedule.mock.calls[1][3]).toEqual({ extensionId: 'ext1' })
  })
})
