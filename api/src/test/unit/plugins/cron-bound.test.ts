import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub shared deployments: a row schedule (scheduled report, retention policy, activity view, sync
// job, flow) registered inside one app is bound to that app — stored as `<id>@<tenant>`, run only
// in that app, never fanned out. Copied app databases share ids (both apps have `sync-job-3`):
// one app's schedule must never replace or run the other's. Self-hosted and Nivaro Cloud keep the
// plain id, exactly as before.

const state = vi.hoisted(() => ({
  runs: [] as Array<{ id: string; tenant: string | null; trigger: string }>,
  paused: new Map<string, Set<string>>()
}))

vi.mock('../../../services/job-runs.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  return {
    startJobRun: vi.fn(async (_kind: string, id: string, o: { trigger?: string } = {}) => {
      state.runs.push({ id, tenant: tc.getTenantId() ?? null, trigger: o.trigger ?? '' })
      return {
        id: state.runs.length,
        complete: async () => {},
        fail: async () => {},
        progress: () => {}
      }
    })
  }
})

vi.mock('../../../services/security.js', () => ({
  maintenanceState: async () => ({
    on: false,
    message: null,
    display: 'page',
    until: null,
    source: 'override'
  })
}))

vi.mock('../../../db/index.js', () => {
  const chain = { where: () => chain, first: async () => undefined }
  return { db: () => chain, _backgroundDb: null, _staticDb: null }
})

vi.mock('../../../services/app-jobs.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../../services/app-jobs.js')>()
  const tc = await import('../../../db/tenant-context.js')
  return {
    ...m,
    forEachApp: vi.fn(m.forEachApp),
    // The app's own pause (its nivaro_settings.paused_crons), read inside that app.
    appPaused: vi.fn(
      async (id: string) => state.paused.get(tc.getTenantId() ?? '')?.has(id) ?? false
    )
  }
})

const { CronManager } = await import('../../../plugins/cron.js')
const appJobs = await import('../../../services/app-jobs.js')
const { runWithTenantDb, withTenant } = await import('../../../db/tenant-context.js')
const { currentTenantKey } = await import('../../../services/tenant-rooms.js')
const { setTenantRegistryForTests } = await import('../../../services/tenancy/registry.js')
const migrations = await import('../../../services/tenancy/app-migrations.js')
type TenantRecord = import('../../../services/tenancy/types.js').TenantRecord

/** In-memory Redis with the calls the claim, hold and lease use. */
class FakeRedis {
  store = new Map<string, string>()
  async set(k: string, v: string, _px: 'PX', _ms: number, _nx: 'NX') {
    if (this.store.has(k)) return null
    this.store.set(k, v)
    return 'OK'
  }
  async get(k: string) {
    return this.store.get(k) ?? null
  }
  async eval(script: string, _n: number, k: string, v: string) {
    if (this.store.get(k) !== v) return 0
    if (script.includes('del')) this.store.delete(k)
    return 1
  }
}

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
    listActive: async () => list,
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
/** Run `fn` synchronously inside app `id` (as a request in that app would). */
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

type Manager = InstanceType<typeof CronManager>
const managers: Manager[] = []
function make(redis?: FakeRedis): Manager {
  const m = new CronManager({ ticksEnabled: () => true, onIssue: () => {} })
  if (redis) {
    const l = m.leader as any
    l.redis = redis
    l.observer = redis
    l.heldUntil = Date.now() + 60 * 60_000
  }
  managers.push(m)
  return m
}

const AT = new Date('2026-11-23T03:00:00.000Z')
/** Fire one scheduled tick of the entry stored under `key`, as croner would. */
async function fire(m: Manager, key: string) {
  const mm = m as any
  const e = mm.entries.get(key)
  return mm.onTick(key, () => AT, e.fn, e.scheduleOpts, m.budgetMs(key))
}

/** The same sync job id in both apps (copied databases), each with its own handler. */
function scheduleBoth(m: Manager) {
  const ran: Array<{ app: string; tenant: string }> = []
  inApp('A', () =>
    m.schedule('sync-job-3', '0 3 * * *', async () => {
      ran.push({ app: 'A', tenant: currentTenantKey() })
    })
  )
  inApp('B', () =>
    m.schedule('sync-job-3', '0 3 * * *', async () => {
      ran.push({ app: 'B', tenant: currentTenantKey() })
    })
  )
  return ran
}

const keys = (m: Manager) =>
  m
    .list()
    .map((j) => j.id)
    .sort()

const saved = { ...process.env }
beforeEach(() => {
  state.runs.length = 0
  state.paused.clear()
  delete process.env.CLOUD_META_DB_URL
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
  vi.mocked(appJobs.forEachApp).mockClear()
  useRegistry()
})
afterEach(() => {
  migrations._resetAppMigrationsForTests()
  for (const m of managers.splice(0)) m.stopAll()
  setTenantRegistryForTests(null)
  process.env = { ...saved }
})

describe('cron entries bound to one app (shared deployment)', () => {
  it('the same id in two apps is two entries; inside an app list() shows its own under the base id', () => {
    const m = make()
    scheduleBoth(m)
    expect(keys(m)).toEqual(['sync-job-3@A', 'sync-job-3@B'])
    const inA = inApp('A', () => m.list())
    expect(inA).toHaveLength(1)
    expect(inA[0]).toMatchObject({ id: 'sync-job-3', baseId: 'sync-job-3', tenant: 'A' })
    expect(inApp('B', () => m.list()).map((j) => j.tenant)).toEqual(['B'])
  })

  it("firing A's entry runs only A's handler, inside A, recorded as the base id", async () => {
    const m = make()
    const ran = scheduleBoth(m)
    await fire(m, 'sync-job-3@A')
    expect(ran).toEqual([{ app: 'A', tenant: 'A' }])
    expect(state.runs).toEqual([{ id: 'sync-job-3', tenant: 'A', trigger: 'schedule' }])
    // Never a fan-out, though sync-job-* is an app-scoped id.
    expect(appJobs.forEachApp).not.toHaveBeenCalled()
  })

  it("claims the fire under the app's own slot", async () => {
    const redis = new FakeRedis()
    const m = make(redis)
    const ran = scheduleBoth(m)
    await fire(m, 'sync-job-3@A')
    await fire(m, 'sync-job-3@B')
    expect([...redis.store.keys()].filter((k) => k.startsWith('nvr:cron:run:')).sort()).toEqual([
      `nvr:cron:run:sync-job-3@A:${AT.toISOString()}`,
      `nvr:cron:run:sync-job-3@B:${AT.toISOString()}`
    ])
    // A second replica's fire of the same slot is claimed already: nothing runs twice.
    await fire(m, 'sync-job-3@A')
    expect(ran.map((r) => r.app).sort()).toEqual(['A', 'B'])
  })

  it("unschedule inside A drops A's entry only", () => {
    const m = make()
    scheduleBoth(m)
    inApp('A', () => m.unschedule('sync-job-3'))
    expect(keys(m)).toEqual(['sync-job-3@B'])
  })

  it("re-scheduling inside A replaces A's entry, never B's", async () => {
    const m = make()
    const ran = scheduleBoth(m)
    inApp('A', () =>
      m.schedule('sync-job-3', '*/5 * * * *', async () => {
        ran.push({ app: 'A2', tenant: currentTenantKey() })
      })
    )
    expect(keys(m)).toEqual(['sync-job-3@A', 'sync-job-3@B'])
    expect(m.list().find((j) => j.id === 'sync-job-3@B')?.expression).toBe('0 3 * * *')
    await fire(m, 'sync-job-3@B')
    expect(ran).toEqual([{ app: 'B', tenant: 'B' }])
  })

  it('an app that is not ready runs nothing; the other app is unaffected', async () => {
    migrations._configureAppMigrationsForTests({ gate: true })
    await migrations.ensureAppSchema(tenant('B'), {
      migrate: async () => [1, []] as [number, string[]],
      schemaSteps: async () => ({ applied: [], skipped: [], failed: [] }),
      workspace: async () => {}
    })
    const m = make()
    const ran = scheduleBoth(m)
    await fire(m, 'sync-job-3@A')
    await fire(m, 'sync-job-3@B')
    expect(ran).toEqual([{ app: 'B', tenant: 'B' }])
    expect(state.runs.map((r) => r.tenant)).toEqual(['B'])
  })

  it('an app in Hub maintenance runs nothing', async () => {
    useRegistry([tenant('A', 'maintenance'), tenant('B')])
    const m = make()
    const ran = scheduleBoth(m)
    await fire(m, 'sync-job-3@A')
    await fire(m, 'sync-job-3@B')
    expect(ran.map((r) => r.app)).toEqual(['B'])
  })

  it("an app's own pause of the base id stops its bound entry only", async () => {
    state.paused.set('A', new Set(['sync-job-3']))
    const m = make()
    const ran = scheduleBoth(m)
    await fire(m, 'sync-job-3@A')
    await fire(m, 'sync-job-3@B')
    expect(ran.map((r) => r.app)).toEqual(['B'])
  })

  it('an app the registry no longer lists: the tick skips without throwing', async () => {
    const m = make()
    const ran = scheduleBoth(m)
    useRegistry([tenant('B')])
    await expect(fire(m, 'sync-job-3@A')).resolves.not.toThrow()
    expect(ran).toEqual([])
    expect(state.runs).toEqual([])
  })

  it('a registry that cannot list apps: the tick skips without throwing', async () => {
    const m = make()
    const ran = scheduleBoth(m)
    setTenantRegistryForTests({
      source: 'hub',
      resolve: async () => null,
      listActive: async () => {
        throw new Error('hub down')
      },
      status: () => ({ source: 'hub', count: 0, loadedAt: null, stale: true, lastError: 'x' })
    })
    await fire(m, 'sync-job-3@A')
    expect(ran).toEqual([])
  })

  it('byId wins over listActive for the lookup; a suspended app runs nothing', async () => {
    const m = make()
    const ran = scheduleBoth(m)
    setTenantRegistryForTests({
      source: 'hub',
      resolve: async () => null,
      listActive: async () => [],
      byId: async (id: string) => (id === 'A' ? tenant('A') : tenant(id, 'suspended')),
      status: () => ({ source: 'hub', count: 2, loadedAt: null, stale: false, lastError: null })
    })
    await fire(m, 'sync-job-3@A')
    await fire(m, 'sync-job-3@B')
    expect(ran.map((r) => r.app)).toEqual(['A'])
  })

  it("unscheduleTenant drops only that app's entries", () => {
    const m = make()
    scheduleBoth(m)
    m.schedule('nightly-app-job', '0 3 * * *', async () => {})
    expect(m.unscheduleTenant('A')).toBe(1)
    expect(keys(m)).toEqual(['nightly-app-job', 'sync-job-3@B'])
    expect(m.unscheduleTenant('A')).toBe(0)
  })

  it('an explicit opts.tenant binds outside any app', () => {
    const m = make()
    m.schedule('scheduled-report-12', '0 6 * * *', async () => {}, { tenant: 'B' })
    expect(keys(m)).toEqual(['scheduled-report-12@B'])
  })

  it('a job scheduled outside any app stays unbound and still fans out', async () => {
    const m = make()
    const seen: string[] = []
    m.schedule('nightly-app-job', '0 3 * * *', async () => {
      seen.push(currentTenantKey())
    })
    expect(keys(m)).toEqual(['nightly-app-job'])
    const r = await fire(m, 'nightly-app-job')
    await r?.fanOut
    expect(seen.sort()).toEqual(['A', 'B'])
  })

  it('run-now, pause, override and lookups inside an app reach its bound entry', async () => {
    const m = make()
    const ran = scheduleBoth(m)
    await withTenant(tenant('A'), async () => {
      expect(await m.runNow('sync-job-3', 'u1')).toBe(true)
    })
    expect(ran).toEqual([{ app: 'A', tenant: 'A' }])
    expect(state.runs).toEqual([{ id: 'sync-job-3', tenant: 'A', trigger: 'run-now' }])

    inApp('A', () => {
      m.pause('sync-job-3')
      m.override('sync-job-3', '*/10 * * * *')
      expect(m.isPaused('sync-job-3')).toBe(true)
      expect(m.getOverride('sync-job-3')).toBe('*/10 * * * *')
      expect(m.jobScope('sync-job-3')).toBe('app')
      expect(m.expectedPreviousRun('sync-job-3')).not.toBeNull()
    })
    const all = m.list()
    expect(all.find((j) => j.id === 'sync-job-3@A')).toMatchObject({
      paused: true,
      expression: '*/10 * * * *',
      tenant: 'A'
    })
    expect(all.find((j) => j.id === 'sync-job-3@B')).toMatchObject({
      paused: false,
      expression: '0 3 * * *'
    })
    // Composite ids passed directly still work (outside any app).
    expect(m.isPaused('sync-job-3@A')).toBe(true)
    m.resume('sync-job-3@A')
    expect(m.isPaused('sync-job-3@A')).toBe(false)
    // The override's rebuild kept the entry bound to A.
    expect(m.list().find((j) => j.id === 'sync-job-3@A')?.tenant).toBe('A')
  })

  it('run-now of a bound entry from outside its app runs inside that app', async () => {
    const m = make()
    const ran = scheduleBoth(m)
    expect(await m.runNow('sync-job-3@B', null, 'chained')).toBe(true)
    expect(ran).toEqual([{ app: 'B', tenant: 'B' }])
    expect(state.runs).toEqual([{ id: 'sync-job-3', tenant: 'B', trigger: 'chained' }])
  })

  it("the miss detector inside an app sees that app's bound entries under the base id", async () => {
    const m = make()
    scheduleBoth(m)
    await withTenant(tenant('A'), async () => {
      expect((await m.missCheckJobs()).map((j) => j.id)).toEqual(['sync-job-3'])
    })
    // Outside an app, bound entries belong to no app's run history: left out.
    expect((await m.missCheckJobs()).map((j) => j.id)).toEqual([])
  })
})

describe("an app never reaches another app's bound entry", () => {
  /** B's entry with a dry-run handler, so a reached dry run would show. */
  function scheduleWithDryRun(m: Manager) {
    const ran = scheduleBoth(m)
    const dry: string[] = []
    inApp('B', () =>
      m.schedule(
        'sync-job-3',
        '0 3 * * *',
        async () => {
          ran.push({ app: 'B', tenant: currentTenantKey() })
        },
        {
          dryRun: async () => {
            dry.push('B')
            return 'B report'
          }
        }
      )
    )
    return { ran, dry }
  }
  const snapshotB = (m: Manager) => m.list().find((j) => j.id === 'sync-job-3@B')

  it("inside A, B's composite id is unknown to every by-id method", async () => {
    const m = make()
    const { ran, dry } = scheduleWithDryRun(m)
    const before = snapshotB(m)
    await withTenant(tenant('A'), async () => {
      const k = 'sync-job-3@B'
      expect(await m.runNow(k, 'u1')).toBe(false)
      expect(await m.dryRun(k)).toEqual({ supported: false, report: null })
      m.pause(k)
      expect(m.isPaused(k)).toBe(false)
      m.override(k, '*/1 * * * *')
      expect(m.getOverride(k)).toBeNull()
      m.setTimezone(k, 'UTC')
      m.annotate(k, { heavy: true, description: 'hijacked' })
      expect(m.isHeavy(k)).toBe(false)
      expect(m.expectedPreviousRun(k)).toBeNull()
      expect(m.getAfter(k)).toBeNull()
      expect(() => m.setAfter('sync-job-3', k)).toThrow()
      m.setAfter(k, 'sync-job-3')
      m.markCatchUp(k, 24)
      m.unschedule(k)
      expect(m.list().map((j) => j.id)).toEqual(['sync-job-3'])
    })
    expect(ran).toEqual([])
    expect(dry).toEqual([])
    expect(state.runs).toEqual([])
    expect(m.isPaused('sync-job-3@B')).toBe(false)
    expect(m.getAfter('sync-job-3@B')).toBeNull()
    const after = snapshotB(m)
    expect(after).toEqual({ ...before, nextRun: after?.nextRun })
    expect(after).toMatchObject({ expression: '0 3 * * *', paused: false, tenant: 'B' })
    expect(after?.description).toBeUndefined()
    expect(after?.heavy).not.toBe(true)
    // B's own fire still runs B's handler.
    await fire(m, 'sync-job-3@B')
    expect(ran).toEqual([{ app: 'B', tenant: 'B' }])
  })

  it('outside any app the composite id still runs in its app', async () => {
    const m = make()
    const ran = scheduleBoth(m)
    expect(await m.runNow('sync-job-3@B', null, 'chained')).toBe(true)
    expect(ran).toEqual([{ app: 'B', tenant: 'B' }])
  })

  it('opts.tenant naming another app inside an app binds to the current app', () => {
    const m = make()
    inApp('A', () => m.schedule('ext-job', '0 3 * * *', async () => {}, { tenant: 'B' }))
    expect(m.list().map((j) => j.id)).toEqual(['ext-job@A'])
    inApp('A', () => m.schedule('ext-job-2', '0 3 * * *', async () => {}, { tenant: 'A' }))
    expect(
      m
        .list()
        .map((j) => j.id)
        .sort()
    ).toEqual(['ext-job-2@A', 'ext-job@A'])
  })

  it('unscheduleTenant drops chains whose parent is a dropped entry', () => {
    const m = make()
    scheduleBoth(m)
    m.schedule('nightly-app-job', '0 3 * * *', async () => {})
    m.setAfter('nightly-app-job', 'sync-job-3@A')
    expect(m.getAfter('nightly-app-job')).toBe('sync-job-3@A')
    m.unscheduleTenant('A')
    expect(m.getAfter('nightly-app-job')).toBeNull()
  })
})

describe('self-hosted and Nivaro Cloud: unchanged', () => {
  it('self-hosted stores the plain id, inside or outside a tenant context', () => {
    delete process.env.HUB_SHARED_DEPLOYMENT
    const m = make()
    m.schedule('sync-job-3', '0 3 * * *', async () => {})
    expect(keys(m)).toEqual(['sync-job-3'])
    inApp('A', () => m.schedule('sync-job-4', '0 3 * * *', async () => {}))
    expect(keys(m)).toEqual(['sync-job-3', 'sync-job-4'])
    const e = m.list()[0]
    expect(e.tenant).toBeUndefined()
    expect(e.baseId).toBeUndefined()
    // opts.tenant is ignored off a shared deployment.
    m.schedule('sync-job-5', '0 3 * * *', async () => {}, { tenant: 'A' })
    expect(keys(m)).toEqual(['sync-job-3', 'sync-job-4', 'sync-job-5'])
    expect(m.unscheduleTenant('A')).toBe(0)
  })

  it('Nivaro Cloud stores the plain id inside a tenant', () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta/x'
    const m = make()
    inApp('A', () => m.schedule('sync-job-3', '0 3 * * *', async () => {}))
    expect(keys(m)).toEqual(['sync-job-3'])
    expect(inApp('A', () => m.list()).map((j) => j.id)).toEqual(['sync-job-3'])
  })
})
