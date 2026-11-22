import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 8: on a Hub shared deployment, an app whose database is not migrated at this
// version (or whose migration failed) runs no app job: the fan-out skips it with why 'not_ready'.

const state = vi.hoisted(() => ({
  runs: [] as Array<{ id: string; tenant: string | null; trigger: string }>,
  fails: [] as Array<{ id: string; tenant: string | null }>,
  maintenance: false,
  recentRun: false,
  dbReads: [] as Array<string | null>
}))

vi.mock('../../../services/job-runs.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  return {
    startJobRun: vi.fn(async (_kind: string, id: string, o: { trigger?: string } = {}) => {
      const tenant = tc.getTenantId() ?? null
      state.runs.push({ id, tenant, trigger: o.trigger ?? '' })
      return {
        id: state.runs.length,
        complete: async () => {},
        fail: async () => {
          state.fails.push({ id, tenant })
        },
        progress: () => {}
      }
    })
  }
})

vi.mock('../../../services/security.js', () => ({
  maintenanceState: async () => ({
    on: state.maintenance,
    message: null,
    display: 'page',
    until: null,
    source: 'override'
  })
}))

vi.mock('../../../db/index.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  const chain = {
    where: () => chain,
    first: async () => (state.recentRun ? { id: 1 } : undefined)
  }
  const db = () => {
    state.dbReads.push(tc.getTenantId() ?? null)
    return chain
  }
  return { db, _backgroundDb: null, _staticDb: null }
})

vi.mock('../../../services/app-jobs.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../../services/app-jobs.js')>()
  return { ...m, forEachApp: vi.fn(m.forEachApp) }
})

const { CronManager } = await import('../../../plugins/cron.js')
const appJobs = await import('../../../services/app-jobs.js')
const { getTenantId } = await import('../../../db/tenant-context.js')
const { setTenantRegistryForTests } = await import('../../../services/tenancy/registry.js')
const { startJobRun } = await import('../../../services/job-runs.js')
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

const tenant = (id: string): TenantRecord => ({
  id,
  slug: id.toLowerCase(),
  name: `App ${id}`,
  status: 'active',
  dbClient: 'pg',
  dbConnection: `postgres://u@127.0.0.1:1/app_${id.toLowerCase()}`,
  poolMax: 1,
  hostnames: []
})
const TENANTS = ['A', 'B', 'C'].map(tenant)

function useRegistry(list: TenantRecord[] = TENANTS) {
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

type Manager = InstanceType<typeof CronManager>
type Fan = Promise<import('../../../services/app-jobs.js').AppFanOutResult>
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

/** Fire one scheduled tick of `id` as croner would, for the fire time `at`. */
async function fire(m: Manager, id: string, at = new Date('2026-11-21T03:00:00.000Z')) {
  const mm = m as any
  const e = mm.entries.get(id)
  const r = (await mm.onTick(id, () => at, e.fn, e.scheduleOpts, m.budgetMs(id))) as
    | { fanOut: Fan }
    | undefined
  return r?.fanOut ? await r.fanOut : undefined
}
const saved = { ...process.env }
beforeEach(() => {
  state.runs.length = 0
  state.fails.length = 0
  state.dbReads.length = 0
  state.maintenance = false
  state.recentRun = false
  delete process.env.CLOUD_META_DB_URL
  delete process.env.TENANT_JOB_CONCURRENCY
  process.env.HUB_SHARED_DEPLOYMENT = 'shared-1'
  vi.mocked(appJobs.forEachApp).mockClear()
  vi.mocked(startJobRun).mockClear()
})
afterEach(() => {
  migrations._resetAppMigrationsForTests()
  for (const m of managers.splice(0)) m.stopAll()
  setTenantRegistryForTests(null)
  process.env = { ...saved }
})

const withStatus = (id: string, status: TenantRecord['status']): TenantRecord => ({
  ...tenant(id),
  status
})

/** Mark apps migrated (ok) and the rest failed, as the migration loop would. */
async function migrated(ok: string[], failed: string[]) {
  migrations._configureAppMigrationsForTests({ gate: true })
  const migrate = async () => {
    if (failed.includes(getTenantId() ?? '')) throw new Error('boom')
    return [1, []] as [number, string[]]
  }
  const deps = {
    migrate,
    schemaSteps: async () => ({ applied: [], skipped: [], failed: [] }),
    workspace: async () => {}
  }
  for (const id of [...ok, ...failed]) await migrations.ensureAppSchema(tenant(id), deps)
}

describe('Not-ready apps and app jobs', () => {
  it('a scheduled fire skips an app whose migration failed with why not_ready', async () => {
    useRegistry(TENANTS)
    await migrated(['A', 'C'], ['B'])
    const m = make()
    const seen: Array<string | undefined> = []
    m.schedule('nightly-app-job', '0 3 * * *', async () => {
      seen.push(getTenantId())
    })
    const r = await fire(m, 'nightly-app-job')
    expect(r?.ran.sort()).toEqual(['A', 'C'])
    expect(r?.skipped).toEqual([{ tenant: 'B', why: 'not_ready' }])
    expect(seen.sort()).toEqual(['A', 'C'])
  })

  it('an app still being migrated (no state yet) is skipped too; maintenance wins over not_ready', async () => {
    useRegistry([tenant('A'), withStatus('B', 'maintenance'), tenant('C')])
    await migrated(['A'], [])
    const m = make()
    m.schedule('nightly-app-job', '0 3 * * *', async () => {})
    const r = await fire(m, 'nightly-app-job')
    expect(r?.ran).toEqual(['A'])
    expect(r?.skipped).toEqual([
      { tenant: 'B', why: 'maintenance' },
      { tenant: 'C', why: 'not_ready' }
    ])
  })

  it('without the migration loop (self-hosted, cloud) nothing is skipped as not_ready', async () => {
    useRegistry(TENANTS)
    const m = make()
    m.schedule('nightly-app-job', '0 3 * * *', async () => {})
    const r = await fire(m, 'nightly-app-job')
    expect(r?.ran.sort()).toEqual(['A', 'B', 'C'])
    expect(r?.skipped).toEqual([])
  })
})
