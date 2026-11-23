import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub shared deployments: row schedules (scheduled reports, retention policies, activity views,
// sync jobs, flows) run per app. Each app's rows are reconciled inside that app, so its entries
// bind to it (plugins/cron.ts); an app that becomes ready is hydrated, one that leaves is dropped;
// an edit on any replica reaches every replica's roster over a Redis channel. Copied databases:
// apps A and B carry the same ids (scheduled-report-1, sync-job-3) and never touch each other's.

const state = vi.hoisted(() => ({
  /** Rows per app and table, as each app's own database would answer. */
  rows: new Map<string, Record<string, unknown[]>>(),
  reads: [] as Array<{ table: string; tenant: string | null }>
}))

vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: vi.fn(async () => ({
    id: 1,
    complete: async () => {},
    fail: async () => {},
    progress: () => {}
  }))
}))

vi.mock('../../../services/security.js', () => ({
  maintenanceState: async () => ({
    on: false,
    message: null,
    display: 'page',
    until: null,
    source: 'override'
  })
}))

// Every query answers with the current app's rows for the table (copied data per app).
vi.mock('../../../db/index.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  const db = (table: string) => {
    const tenant = tc.getTenantId() || null
    state.reads.push({ table, tenant })
    const rows = () => state.rows.get(tenant ?? '')?.[table] ?? []
    const chain: Record<string, unknown> = {}
    for (const m of ['where', 'whereNotNull', 'select', 'orderBy']) chain[m] = () => chain
    chain.first = async () => rows()[0]
    // biome-ignore lint/suspicious/noThenProperty: a knex query builder is thenable
    chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(ok, bad)
    return chain
  }
  return { db, _backgroundDb: null, _staticDb: null }
})

// The activity-views source registers on import; this suite exercises the others.
vi.mock('../../../services/activity-views.js', () => ({}))

const { CronManager } = await import('../../../plugins/cron.js')
const { runWithTenantDb, getTenantId } = await import('../../../db/tenant-context.js')
const { setTenantRegistryForTests } = await import('../../../services/tenancy/registry.js')
const migrations = await import('../../../services/tenancy/app-migrations.js')
const lifecycle = await import('../../../services/tenancy/app-lifecycle.js')
const rs = await import('../../../services/row-schedules.js')
type TenantRecord = import('../../../services/tenancy/types.js').TenantRecord
type Manager = InstanceType<typeof CronManager>

const tenant = (id: string, status: TenantRecord['status'] = 'active'): TenantRecord => ({
  id,
  slug: id.toLowerCase(),
  name: `App ${id}`,
  status,
  dbClient: 'pg',
  dbConnection: `postgres://u@127.0.0.1:1/app_${id.toLowerCase()}`,
  poolMax: 1,
  hostnames: []
})

function useRegistry(list: TenantRecord[] = [tenant('A'), tenant('B')]) {
  setTenantRegistryForTests({
    source: 'hub',
    resolve: async () => null,
    listActive: async () => list.filter((t) => t.status === 'active' || t.status === 'maintenance'),
    byId: async (id: string) => list.find((t) => t.id === id) ?? null,
    status: () => ({
      source: 'hub',
      count: list.length,
      loadedAt: null,
      stale: false,
      lastError: null
    })
  })
}

const fakeKnex = {} as Knex
/** Run `fn` inside app `id` (as a request in that app would); the context lasts as long as fn. */
function inApp<T>(id: string, fn: () => T): T {
  let out!: T
  runWithTenantDb(
    fakeKnex,
    id,
    () => {
      out = fn()
    },
    id
  )
  return out
}

/** A Redis double: one bus shared by every replica's client, pub/sub only. */
class FakeBus {
  subs: Array<{ channels: Set<string>; handlers: Array<(ch: string, msg: string) => void> }> = []
  published: Array<{ channel: string; message: string }> = []
  client() {
    const bus = this
    return {
      async publish(channel: string, message: string) {
        bus.published.push({ channel, message })
        for (const s of bus.subs)
          if (s.channels.has(channel)) for (const h of s.handlers) h(channel, message)
        return 1
      },
      duplicate() {
        const sub = {
          channels: new Set<string>(),
          handlers: [] as Array<(ch: string, msg: string) => void>
        }
        bus.subs.push(sub)
        return {
          on(ev: string, fn: (ch: string, msg: string) => void) {
            if (ev === 'message') sub.handlers.push(fn)
          },
          async subscribe(channel: string) {
            sub.channels.add(channel)
            return 1
          },
          async quit() {
            sub.channels.clear()
            return 'OK'
          }
        }
      }
    }
  }
}

const managers: Manager[] = []
const closers: Array<() => Promise<void>> = []
type FakeApp = { cron: Manager; log: Record<string, () => void>; redis?: unknown }
function makeApp(redis?: unknown): FakeApp {
  const m = new CronManager({ ticksEnabled: () => true, onIssue: () => {} })
  managers.push(m)
  const noop = () => {}
  return {
    cron: m,
    log: { info: noop, warn: noop, error: noop, debug: noop },
    ...(redis ? { redis } : {}),
    // registerRowScheduleLifecycle closes its subscriber on close
    addHook: (name: string, fn: () => Promise<void>) => {
      if (name === 'onClose') closers.push(fn)
    }
  } as unknown as FakeApp
}
const asApp = (a: FakeApp) => a as any

const report = (id: number) => ({ id, name: `Report ${id}`, cron_schedule: '0 7 * * *' })
const keys = (m: Manager) =>
  m
    .list()
    .map((j) => j.id)
    .sort()

const saved = { ...process.env }
beforeEach(() => {
  state.rows.clear()
  state.reads.length = 0
  delete process.env.CLOUD_META_DB_URL
  delete process.env.REDIS_CHANNEL_PREFIX
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
  useRegistry()
})
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  lifecycle._resetAppLifecycleForTests()
  migrations._resetAppMigrationsForTests()
  for (const m of managers.splice(0)) m.stopAll()
  setTenantRegistryForTests(null)
  process.env = { ...saved }
})

describe('reconcile inside an app (shared deployment)', () => {
  const desired = (...ids: number[]) =>
    new Map(
      ids.map((n) => [
        `scheduled-report-${n}`,
        {
          expression: '0 7 * * *',
          run: async () => {}
        } as import('../../../services/row-schedules.js').DesiredSchedule
      ])
    )

  it("each app's reconcile binds its own entries; the same id in both apps is two entries", () => {
    const app = makeApp()
    inApp('A', () => rs.reconcile(asApp(app), 'scheduled-report-', desired(1)))
    inApp('B', () => rs.reconcile(asApp(app), 'scheduled-report-', desired(1, 2)))
    expect(keys(app.cron)).toEqual([
      'scheduled-report-1@A',
      'scheduled-report-1@B',
      'scheduled-report-2@B'
    ])
    expect(inApp('A', () => app.cron.list().map((j) => j.id))).toEqual(['scheduled-report-1'])
    expect(
      inApp('B', () =>
        app.cron
          .list()
          .map((j) => j.id)
          .sort()
      )
    ).toEqual(['scheduled-report-1', 'scheduled-report-2'])
  })

  it("reconcile in A with nothing wanted removes only A's entries", () => {
    const app = makeApp()
    inApp('A', () => rs.reconcile(asApp(app), 'scheduled-report-', desired(1)))
    inApp('B', () => rs.reconcile(asApp(app), 'scheduled-report-', desired(1, 2)))
    const res = inApp('A', () => rs.reconcile(asApp(app), 'scheduled-report-', new Map()))
    expect(res.unscheduled).toEqual(['scheduled-report-1'])
    expect(keys(app.cron)).toEqual(['scheduled-report-1@B', 'scheduled-report-2@B'])
  })

  it("a second reconcile in an app changes nothing (it sees its own entries, not the other app's)", () => {
    const app = makeApp()
    inApp('B', () => rs.reconcile(asApp(app), 'scheduled-report-', desired(1)))
    const first = inApp('A', () => rs.reconcile(asApp(app), 'scheduled-report-', desired(1)))
    expect(first.scheduled).toEqual(['scheduled-report-1'])
    const again = inApp('A', () => rs.reconcile(asApp(app), 'scheduled-report-', desired(1)))
    expect(again).toEqual({ scheduled: [], rescheduled: [], unscheduled: [], invalid: [] })
  })
})

describe('resyncSchedules by deployment', () => {
  it('shared: inside an app it reads that app and binds to it; outside any app it does nothing', async () => {
    const app = makeApp()
    state.rows.set('A', { nivaro_scheduled_reports: [report(1)] })
    state.rows.set('B', { nivaro_scheduled_reports: [report(1), report(2)] })
    expect(await rs.resyncSchedules(asApp(app), 'scheduled-reports')).toBeNull()
    expect(state.reads).toEqual([])
    expect(app.cron.list()).toEqual([])
    await new Promise<void>((done) =>
      runWithTenantDb(
        fakeKnex,
        'a',
        () => void rs.resyncSchedules(asApp(app), 'scheduled-reports').then(() => done()),
        'A'
      )
    )
    expect(keys(app.cron)).toEqual(['scheduled-report-1@A'])
    expect(state.reads.every((r) => r.tenant === 'A')).toBe(true)
  })

  it('cloud: resyncSchedules answers null, as before', async () => {
    delete process.env.HUB_SHARED_DEPLOYMENT
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    const app = makeApp()
    expect(await inApp('A', () => rs.resyncSchedules(asApp(app), 'scheduled-reports'))).toBeNull()
    expect(app.cron.list()).toEqual([])
  })

  it('self-hosted: resyncSchedules reconciles on the plain ids, as before', async () => {
    delete process.env.HUB_SHARED_DEPLOYMENT
    const app = makeApp()
    state.rows.set('', { nivaro_scheduled_reports: [report(4)] })
    const res = await rs.resyncSchedules(asApp(app), 'scheduled-reports')
    expect(res?.scheduled).toEqual(['scheduled-report-4'])
    expect(keys(app.cron)).toEqual(['scheduled-report-4'])
  })
})

describe("row schedules follow each app's own time zone (shared deployment)", () => {
  const inAppAsync = <T>(id: string, fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) =>
      runWithTenantDb(fakeKnex, id, () => void fn().then(resolve, reject), id)
    )
  const zoneOf = (m: Manager, key: string) => m.list().find((j) => j.id === key)?.timezone
  // Each app's zone is cached a minute; outside any app a bust forgets every app's.
  beforeEach(async () => (await import('../../../services/user-time.js')).bustAppTimeZone())

  it("A in London and B in Los Angeles: each app's entries are evaluated in its own zone", async () => {
    const app = makeApp()
    app.cron.setInstanceTimezone('America/New_York')
    state.rows.set('A', {
      nivaro_settings: [{ sla_timezone: 'Europe/London' }],
      nivaro_scheduled_reports: [report(1)]
    })
    state.rows.set('B', {
      nivaro_settings: [{ sla_timezone: 'America/Los_Angeles' }],
      nivaro_scheduled_reports: [report(1)]
    })
    await inAppAsync('A', () => rs.resyncSchedules(asApp(app), 'scheduled-reports'))
    await inAppAsync('B', () => rs.resyncSchedules(asApp(app), 'scheduled-reports'))
    expect(zoneOf(app.cron, 'scheduled-report-1@A')).toBe('Europe/London')
    expect(zoneOf(app.cron, 'scheduled-report-1@B')).toBe('America/Los_Angeles')
  })

  it("a changed app zone reschedules that app's entries on the next resync (the other app's stay)", async () => {
    const app = makeApp()
    state.rows.set('A', {
      nivaro_settings: [{ sla_timezone: 'Europe/London' }],
      nivaro_scheduled_reports: [report(1)]
    })
    state.rows.set('B', {
      nivaro_settings: [{ sla_timezone: 'America/Los_Angeles' }],
      nivaro_scheduled_reports: [report(1)]
    })
    await inAppAsync('A', () => rs.resyncSchedules(asApp(app), 'scheduled-reports'))
    await inAppAsync('B', () => rs.resyncSchedules(asApp(app), 'scheduled-reports'))
    state.rows.set('A', {
      nivaro_settings: [{ sla_timezone: 'Asia/Tokyo' }],
      nivaro_scheduled_reports: [report(1)]
    })
    const { bustAppTimeZone } = await import('../../../services/user-time.js')
    await inAppAsync('A', async () => bustAppTimeZone())
    const res = await inAppAsync('A', () => rs.resyncSchedules(asApp(app), 'scheduled-reports'))
    expect(res?.rescheduled).toEqual(['scheduled-report-1'])
    expect(zoneOf(app.cron, 'scheduled-report-1@A')).toBe('Asia/Tokyo')
    expect(zoneOf(app.cron, 'scheduled-report-1@B')).toBe('America/Los_Angeles')
  })

  it('self-hosted: no zone is passed, the entry follows the instance zone as before', async () => {
    delete process.env.HUB_SHARED_DEPLOYMENT
    const app = makeApp()
    app.cron.setInstanceTimezone('America/Chicago')
    state.rows.set('', {
      nivaro_settings: [{ sla_timezone: 'Europe/London' }],
      nivaro_scheduled_reports: [report(4)]
    })
    await rs.resyncSchedules(asApp(app), 'scheduled-reports')
    const e = app.cron.list().find((j) => j.id === 'scheduled-report-4')
    expect(e?.timezone).toBe('America/Chicago')
    expect(e?.timezone_source).toBe('instance')
    expect(state.reads.some((r) => r.table === 'nivaro_settings')).toBe(false)
  })
})

describe('planReconcile and time zones', () => {
  it('a zone change is a reschedule; no wanted zone, or an admin zone override, is not', () => {
    const cur = [
      { id: 'r-1', expression: '0 7 * * *', timezone: 'Europe/London', timezone_source: 'job' },
      { id: 'r-2', expression: '0 7 * * *', timezone: 'UTC', timezone_source: 'override' },
      { id: 'r-3', expression: '0 7 * * *', timezone: 'America/New_York', timezone_source: 'instance' }
    ] as const
    const want = new Map([
      ['r-1', { expression: '0 7 * * *', timezone: 'Asia/Tokyo' }],
      ['r-2', { expression: '0 7 * * *', timezone: 'Asia/Tokyo' }],
      ['r-3', { expression: '0 7 * * *' }]
    ])
    expect(rs.planReconcile([...cur], want, 'r-')).toEqual({ add: [], change: ['r-1'], remove: [] })
  })
})

describe('registerRowScheduleLifecycle', () => {
  it('an app that becomes ready has every registered source hydrated inside it', async () => {
    const app = makeApp()
    const seen: Array<{ source: string; tenant: string | undefined }> = []
    rs.registerScheduleResync('test-source', async (a) => {
      seen.push({ source: 'test-source', tenant: getTenantId() })
      return rs.reconcile(
        a,
        'sync-job-',
        new Map([['sync-job-3', { expression: '0 3 * * *', run: async () => {} }]])
      )
    })
    try {
      state.rows.set('A', {
        nivaro_scheduled_reports: [report(1)],
        nivaro_retention_policies: [{ id: 9, name: 'Old', cron_schedule: '0 2 * * *' }]
      })
      rs.registerRowScheduleLifecycle(asApp(app))
      lifecycle.fireAppReady(tenant('A'))
      await vi.waitFor(() =>
        expect(keys(app.cron)).toEqual(
          expect.arrayContaining(['retention-policy-9@A', 'scheduled-report-1@A', 'sync-job-3@A'])
        )
      )
      expect(seen).toEqual([{ source: 'test-source', tenant: 'A' }])
      expect(
        app.cron.list().every((j) => j.id === 'row-schedules-resync' || j.tenant === 'A')
      ).toBe(true)
    } finally {
      rs._unregisterScheduleResyncForTests('test-source')
    }
  })

  it("an app that leaves has its bound entries dropped; the other app's stay", async () => {
    const app = makeApp()
    rs.registerRowScheduleLifecycle(asApp(app))
    state.rows.set('A', { nivaro_scheduled_reports: [report(1)] })
    state.rows.set('B', { nivaro_scheduled_reports: [report(1)] })
    lifecycle.fireAppReady(tenant('A'))
    lifecycle.fireAppReady(tenant('B'))
    await vi.waitFor(() =>
      expect(keys(app.cron)).toEqual(
        expect.arrayContaining(['scheduled-report-1@A', 'scheduled-report-1@B'])
      )
    )
    lifecycle.fireAppLeft('A')
    expect(keys(app.cron).filter((k) => k.startsWith('scheduled-report-'))).toEqual([
      'scheduled-report-1@B'
    ])
  })

  it('registers the five-minute per-app resync job on a shared deployment only', () => {
    const shared = makeApp()
    rs.registerRowScheduleLifecycle(asApp(shared))
    const job = shared.cron.list().find((j) => j.id === 'row-schedules-resync')
    expect(job?.defaultExpression).toBe('*/5 * * * *')
    expect(shared.cron.jobScope('row-schedules-resync')).toBe('app')

    delete process.env.HUB_SHARED_DEPLOYMENT
    const selfHosted = makeApp()
    rs.registerRowScheduleLifecycle(asApp(selfHosted))
    expect(selfHosted.cron.list()).toEqual([])
  })

  it('self-hosted: announcing a change still moves the schedules epoch and publishes nothing', async () => {
    delete process.env.HUB_SHARED_DEPLOYMENT
    const bus = new FakeBus()
    rs.registerRowScheduleLifecycle(asApp(makeApp(bus.client())))
    rs.announceScheduleChange('scheduled-reports')
    expect(bus.published).toEqual([])
  })
})

describe('a schedule change reaches every replica (shared deployment)', () => {
  it('announce inside A publishes A|<source> on the deployment channel', () => {
    process.env.REDIS_CHANNEL_PREFIX = 'dep1:'
    const bus = new FakeBus()
    rs.registerRowScheduleLifecycle(asApp(makeApp(bus.client())))
    inApp('A', () => rs.announceScheduleChange('scheduled-reports'))
    inApp('B', () => rs.announceScheduleChange())
    rs.announceScheduleChange('scheduled-reports') // outside any app: nothing to name
    expect(bus.published).toEqual([
      { channel: 'dep1:nvr:row-schedules', message: 'A|scheduled-reports' },
      { channel: 'dep1:nvr:row-schedules', message: 'B|*' }
    ])
  })

  it('the subscriber runs the named resyncer inside the named app', async () => {
    const bus = new FakeBus()
    rs.registerRowScheduleLifecycle(asApp(makeApp(bus.client())))
    const seen: Array<string | undefined> = []
    rs.registerScheduleResync('probe', async () => {
      seen.push(getTenantId())
      return { scheduled: [], rescheduled: [], unscheduled: [], invalid: [] }
    })
    try {
      await rs.onRowScheduleMessage(asApp(makeApp()), 'A|probe')
      expect(seen).toEqual(['A'])
    } finally {
      rs._unregisterScheduleResyncForTests('probe')
    }
  })

  it("an edit on a non-leader reaches the leader's roster, bound to that app only", async () => {
    const bus = new FakeBus()
    const replica1 = makeApp(bus.client())
    const leader = makeApp(bus.client())
    rs.registerRowScheduleLifecycle(asApp(replica1))
    rs.registerRowScheduleLifecycle(asApp(leader))
    // B already has its own report 1 on the leader (copied databases: same id).
    state.rows.set('B', { nivaro_scheduled_reports: [report(1)] })
    await rs.onRowScheduleMessage(asApp(leader), 'B|scheduled-reports')
    // A's admin adds report 1 in A on replica 1.
    state.rows.set('A', { nivaro_scheduled_reports: [report(1)] })
    await new Promise<void>((done) =>
      runWithTenantDb(
        fakeKnex,
        'a',
        () =>
          void rs.resyncSchedules(asApp(replica1), 'scheduled-reports').then(() => {
            rs.announceScheduleChange('scheduled-reports')
            done()
          }),
        'A'
      )
    )
    await vi.waitFor(() =>
      expect(keys(leader.cron).filter((k) => k.startsWith('scheduled-report-'))).toEqual([
        'scheduled-report-1@A',
        'scheduled-report-1@B'
      ])
    )
    expect(keys(replica1.cron).filter((k) => k.startsWith('scheduled-report-'))).toEqual([
      'scheduled-report-1@A'
    ])
  })

  it('an unknown, suspended, in-maintenance or not-ready app is skipped silently', async () => {
    useRegistry([tenant('A'), tenant('S', 'suspended'), tenant('M', 'maintenance'), tenant('N')])
    migrations._configureAppMigrationsForTests({ gate: true })
    const app = makeApp()
    const seen: Array<string | undefined> = []
    rs.registerScheduleResync('probe', async () => {
      seen.push(getTenantId())
      return { scheduled: [], rescheduled: [], unscheduled: [], invalid: [] }
    })
    try {
      for (const raw of ['Z|probe', 'S|probe', 'M|probe', 'N|probe', 'garbage', '|probe'])
        await expect(rs.onRowScheduleMessage(asApp(app), raw)).resolves.toBeUndefined()
      expect(seen).toEqual([])
    } finally {
      rs._unregisterScheduleResyncForTests('probe')
    }
  })
})

describe('on a shared deployment nothing schedules a row-schedule id outside an app', () => {
  it('the sync-jobs boot loader and loadScheduledFlows schedule nothing', async () => {
    state.rows.set('', {
      nivaro_sync_jobs: [{ id: 3, schedule: '0 3 * * *', is_active: true }],
      nivaro_flows: [
        {
          id: 'f1',
          name: 'F',
          trigger: 'schedule',
          status: 'active',
          trigger_options: '{"cron":"0 4 * * *"}'
        }
      ]
    })
    const app = makeApp()
    const hooks: Record<string, () => Promise<void>> = {}
    const routeApp = new Proxy(asApp(app), {
      get(target, prop) {
        if (prop === 'addHook')
          return (name: string, fn: () => Promise<void>) => {
            hooks[name] = fn
          }
        if (prop in target) return target[prop as keyof typeof target]
        return () => {}
      }
    })
    const { syncJobsRoutes } = await import('../../../routes/sync-jobs.js')
    const { loadScheduledFlows } = await import('../../../routes/flows.js')
    await syncJobsRoutes(routeApp)
    await hooks.onReady?.()
    await loadScheduledFlows(routeApp)
    expect(app.cron.list()).toEqual([])
    // and resyncing every source outside an app adds nothing either
    await rs.resyncAllSchedules(asApp(app))
    expect(app.cron.list()).toEqual([])
  })
})
