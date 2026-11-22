import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 5 Task 10: on a shared deployment (HUB_SHARED_DEPLOYMENT), a job scoped to an app
// runs once per active app, in that app's tenant context, with per-app claim / unsafe / heavy
// keys. Self-hosted and Nivaro Cloud run every job exactly as before.

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
    // biome-ignore lint/suspicious/noExplicitAny: test double
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
  // biome-ignore lint/suspicious/noExplicitAny: reaching the private tick
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
  useRegistry()
})
afterEach(() => {
  for (const m of managers.splice(0)) m.stopAll()
  setTenantRegistryForTests(null)
  process.env = { ...saved }
})

describe('per-app jobs on a shared deployment', () => {
  it('one fire runs the job once per app, each run recorded inside that app', async () => {
    const m = make()
    const seen: Array<string | undefined> = []
    m.schedule('nightly-app-job', '0 3 * * *', async () => {
      seen.push(getTenantId())
    })
    const r = await fire(m, 'nightly-app-job')
    expect(r?.ran.sort()).toEqual(['A', 'B', 'C'])
    expect(seen.sort()).toEqual(['A', 'B', 'C'])
    expect(state.runs.map((x) => x.tenant).sort()).toEqual(['A', 'B', 'C'])
    expect(state.runs.every((x) => x.id === 'nightly-app-job' && x.trigger === 'schedule')).toBe(
      true
    )
  })

  it('one app throwing never stops the others; the failure lands in that app only', async () => {
    const m = make()
    m.schedule('nightly-app-job', '0 3 * * *', async () => {
      if (getTenantId() === 'B') throw new Error('B broke')
    })
    const r = await fire(m, 'nightly-app-job')
    expect(r?.ran.sort()).toEqual(['A', 'C'])
    expect(r?.failed).toEqual([{ tenant: 'B', error: 'B broke' }])
    expect(state.fails).toEqual([{ id: 'nightly-app-job', tenant: 'B' }])
  })

  it('a hung app holds one lane; the others still run on that fire', async () => {
    const m = make()
    let release!: () => void
    const hang = new Promise<void>((res) => (release = res))
    const done: string[] = []
    m.schedule('nightly-app-job', '0 3 * * *', async () => {
      if (getTenantId() === 'A') await hang
      done.push(getTenantId() as string)
    })
    process.env.TENANT_JOB_CONCURRENCY = '2'
    const pending = fire(m, 'nightly-app-job')
    await new Promise((res) => setTimeout(res, 30))
    expect(done.sort()).toEqual(['B', 'C'])
    // the next fire skips the hung app (its run is still going) and runs the others
    const next = await fire(m, 'nightly-app-job', new Date('2026-11-22T03:00:00.000Z'))
    expect(next?.skipped).toEqual([{ tenant: 'A', why: 'busy' }])
    expect(next?.ran.sort()).toEqual(['B', 'C'])
    release()
    const first = await pending
    expect(first?.ran.sort()).toEqual(['A', 'B', 'C'])
  })

  it('runs at most TENANT_JOB_CONCURRENCY apps at once', async () => {
    useRegistry(['A', 'B', 'C', 'D', 'E'].map(tenant))
    process.env.TENANT_JOB_CONCURRENCY = '2'
    const m = make()
    let now = 0
    let max = 0
    m.schedule('nightly-app-job', '0 3 * * *', async () => {
      now++
      max = Math.max(max, now)
      await new Promise((res) => setTimeout(res, 15))
      now--
    })
    const r = await fire(m, 'nightly-app-job')
    expect(r?.ran).toHaveLength(5)
    expect(max).toBe(2)
  })

  it('forEachApp honours its own concurrency and runs each call inside withTenant', async () => {
    let now = 0
    let max = 0
    const tenants: Array<string | undefined> = []
    const r = await appJobs.forEachApp(
      async (t) => {
        now++
        max = Math.max(max, now)
        tenants.push(getTenantId())
        await new Promise((res) => setTimeout(res, 10))
        now--
        return t.id === 'D' ? 'paused' : 'ran'
      },
      { concurrency: 2, listActive: async () => ['A', 'B', 'C', 'D'].map(tenant) }
    )
    expect(max).toBe(2)
    expect(tenants.sort()).toEqual(['A', 'B', 'C', 'D'])
    expect(r.ran.sort()).toEqual(['A', 'B', 'C'])
    expect(r.skipped).toEqual([{ tenant: 'D', why: 'paused' }])
  })

  it('appJobConcurrency: default 4, clamped 1..16', () => {
    expect(appJobs.appJobConcurrency()).toBe(4)
    process.env.TENANT_JOB_CONCURRENCY = '0'
    expect(appJobs.appJobConcurrency()).toBe(1)
    process.env.TENANT_JOB_CONCURRENCY = '99'
    expect(appJobs.appJobConcurrency()).toBe(16)
    process.env.TENANT_JOB_CONCURRENCY = 'lots'
    expect(appJobs.appJobConcurrency()).toBe(4)
  })

  it('two replicas that both believe they lead run each app once on the same fire', async () => {
    const r = new FakeRedis()
    const a = make(r)
    const b = make(r)
    const fn = async () => {}
    a.schedule('nightly-app-job', '0 3 * * *', fn)
    b.schedule('nightly-app-job', '0 3 * * *', fn)
    const [ra, rb] = await Promise.all([fire(a, 'nightly-app-job'), fire(b, 'nightly-app-job')])
    expect(state.runs.map((x) => x.tenant).sort()).toEqual(['A', 'B', 'C'])
    expect([...(ra?.ran ?? []), ...(rb?.ran ?? [])].sort()).toEqual(['A', 'B', 'C'])
    const claimed = [...(ra?.skipped ?? []), ...(rb?.skipped ?? [])]
    expect(claimed.map((s) => s.why)).toEqual(['claimed', 'claimed', 'claimed'])
    const keys = [...r.store.keys()].filter((k) => k.startsWith('nvr:cron:run:')).sort()
    expect(keys).toEqual([
      'nvr:cron:run:nightly-app-job@A:2026-11-21T03:00:00.000Z',
      'nvr:cron:run:nightly-app-job@B:2026-11-21T03:00:00.000Z',
      'nvr:cron:run:nightly-app-job@C:2026-11-21T03:00:00.000Z'
    ])
  })

  it('two environments of one app (same slug, different ids) each get their own run and keys', async () => {
    const prod = { ...tenant('P1'), slug: 'efp' }
    const staging = { ...tenant('P2'), slug: 'efp' }
    useRegistry([prod, staging])
    const r = new FakeRedis()
    const m = make(r)
    const held = new Set<string>()
    m.schedule(
      'mailer',
      '0 3 * * *',
      async () => {
        for (const k of r.store.keys()) if (!k.startsWith('nvr:cron:run:')) held.add(k)
      },
      { idempotent: 'unsafe', heavy: true }
    )
    const out = await fire(m, 'mailer')
    expect(out?.ran.sort()).toEqual(['P1', 'P2'])
    expect(state.runs.map((x) => x.tenant).sort()).toEqual(['P1', 'P2'])
    expect([...r.store.keys()].sort()).toEqual([
      'nvr:cron:run:mailer@P1:2026-11-21T03:00:00.000Z',
      'nvr:cron:run:mailer@P2:2026-11-21T03:00:00.000Z'
    ])
    expect([...held].sort()).toEqual([
      'nvr:cron:active:mailer@P1',
      'nvr:cron:active:mailer@P2',
      'nvr:cron:heavy:P1',
      'nvr:cron:heavy:P2'
    ])
    expect([...held].some((k) => k.includes('efp'))).toBe(false)
  })

  it('a lease lost mid fan-out starts no new app (slow first app)', async () => {
    const r = new FakeRedis()
    const m = make(r)
    process.env.TENANT_JOB_CONCURRENCY = '1'
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const started: string[] = []
    m.schedule('nightly-app-job', '0 3 * * *', async () => {
      started.push(getTenantId() as string)
      if (getTenantId() === 'A') await gate
    })
    const pending = fire(m, 'nightly-app-job')
    await new Promise((res) => setTimeout(res, 30))
    expect(started).toEqual(['A'])
    // biome-ignore lint/suspicious/noExplicitAny: the lease lapses (another replica leads now)
    ;(m.leader as any).heldUntil = 0
    release()
    const out = await pending
    expect(started).toEqual(['A'])
    expect(out?.ran).toEqual(['A'])
    expect(out?.skipped).toEqual([
      { tenant: 'B', why: 'lease-lost' },
      { tenant: 'C', why: 'lease-lost' }
    ])
    // every app's claim for this fire was taken up front, before any app ran
    expect([...r.store.keys()].filter((k) => k.startsWith('nvr:cron:run:')).length).toBe(3)
  })

  it('a job dropped mid fan-out starts no new app', async () => {
    const m = make()
    process.env.TENANT_JOB_CONCURRENCY = '1'
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    m.schedule('nightly-app-job', '0 3 * * *', async () => {
      if (getTenantId() === 'A') await gate
    })
    const pending = fire(m, 'nightly-app-job')
    await new Promise((res) => setTimeout(res, 30))
    m.unschedule('nightly-app-job')
    release()
    const out = await pending
    expect(out?.ran).toEqual(['A'])
    expect(out?.skipped.map((x) => x.why)).toEqual(['lease-lost', 'lease-lost'])
  })

  it('a newer fire takes apps an older, slower fire still has queued', async () => {
    const m = make()
    process.env.TENANT_JOB_CONCURRENCY = '1'
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const runs: string[] = []
    let firstA = true
    m.schedule('nightly-app-job', '0 3 * * *', async () => {
      runs.push(getTenantId() as string)
      if (getTenantId() === 'A' && firstA) {
        firstA = false
        await gate
      }
    })
    const older = fire(m, 'nightly-app-job')
    await new Promise((res) => setTimeout(res, 30))
    const newer = await fire(m, 'nightly-app-job', new Date('2026-11-21T03:05:00.000Z'))
    // A is running on the older fire; B and C, only queued there, run on the newer one
    expect(newer?.skipped).toEqual([{ tenant: 'A', why: 'busy' }])
    expect(newer?.ran.sort()).toEqual(['B', 'C'])
    release()
    expect((await older)?.ran.sort()).toEqual(['A', 'B', 'C'])
  })

  it('warns at most once a minute per job when no app is listed', async () => {
    useRegistry([])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const m = make()
      m.schedule('nightly-app-job', '0 3 * * *', async () => {})
      m.schedule('other-app-job', '0 4 * * *', async () => {})
      await fire(m, 'nightly-app-job')
      await fire(m, 'nightly-app-job', new Date('2026-11-21T03:01:00.000Z'))
      await fire(m, 'other-app-job')
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('no apps'))
      expect(lines).toHaveLength(2)
      expect(lines.some((l) => l.includes('postgres'))).toBe(false)
      setTenantRegistryForTests(null) // shared deployment, registry null on this base
      await fire(m, 'other-app-job', new Date('2026-11-21T04:01:00.000Z'))
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('no apps'))).toHaveLength(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('the miss detector leaves process jobs out only on a shared deployment', () => {
    const m = make()
    m.schedule('pool-monitor', '*/5 * * * *', async () => {})
    m.schedule('own-sampler', '*/5 * * * *', async () => {}, { scope: 'process' })
    m.schedule('nightly-app-job', '0 3 * * *', async () => {})
    expect(m.skipsMissCheck('pool-monitor')).toBe(true)
    expect(m.skipsMissCheck('own-sampler')).toBe(true)
    expect(m.skipsMissCheck('nightly-app-job')).toBe(false)
    delete process.env.HUB_SHARED_DEPLOYMENT
    expect(m.skipsMissCheck('pool-monitor')).toBe(false)
    process.env.CLOUD_META_DB_URL = 'mssql://meta'
    expect(m.skipsMissCheck('pool-monitor')).toBe(false)
  })

  it('a process job runs once, with no tenant', async () => {
    const m = make()
    const seen: Array<string | undefined> = []
    m.schedule('pool-monitor', '*/5 * * * *', async () => {
      seen.push(getTenantId())
    })
    m.schedule('own-sampler', '*/5 * * * *', async () => void seen.push(getTenantId()), {
      scope: 'process'
    })
    expect(await fire(m, 'pool-monitor')).toBeUndefined()
    expect(await fire(m, 'own-sampler')).toBeUndefined()
    expect(seen).toEqual([undefined, undefined])
    expect(state.runs.map((x) => x.tenant)).toEqual([null, null])
    expect(appJobs.forEachApp).not.toHaveBeenCalled()
  })

  it('a heavy job takes the heavy slot of its own app', async () => {
    const r = new FakeRedis()
    const m = make(r)
    const held: Record<string, string[]> = {}
    m.schedule(
      'nightly-app-job',
      '0 3 * * *',
      async () => {
        held[getTenantId() as string] = [...r.store.keys()].filter((k) =>
          k.startsWith('nvr:cron:heavy')
        )
      },
      { heavy: true }
    )
    await fire(m, 'nightly-app-job')
    for (const t of ['A', 'B', 'C']) expect(held[t]).toContain(`nvr:cron:heavy:${t}`)
    expect(Object.values(held).flat()).not.toContain('nvr:cron:heavy')
    expect([...r.store.keys()].some((k) => k.startsWith('nvr:cron:heavy'))).toBe(false)
  })

  it('an unsafe job is held per app: one app running never blocks another', async () => {
    const r = new FakeRedis()
    const m = make(r)
    m.schedule('mailer', '0 3 * * *', async () => {}, { idempotent: 'unsafe' })
    r.store.set('nvr:cron:active:mailer@B', 'other|run now|1')
    const out = await fire(m, 'mailer')
    expect(out?.ran.sort()).toEqual(['A', 'C'])
    expect(out?.skipped).toEqual([{ tenant: 'B', why: 'busy' }])
  })

  it('maintenance holds the job in that fire for every app it is on in', async () => {
    const m = make()
    m.schedule('nightly-app-job', '0 3 * * *', async () => {})
    state.maintenance = true
    const out = await fire(m, 'nightly-app-job')
    expect(out?.ran).toEqual([])
    expect(out?.skipped.map((s) => s.why)).toEqual(['maintenance', 'maintenance', 'maintenance'])
    expect(await m.heldByMaintenanceAt('nightly-app-job', new Date('2026-11-21T03:00:00Z'))).toBe(
      false
    )
  })

  it('run-now takes the unsafe hold of the caller’s app', async () => {
    const r = new FakeRedis()
    const m = make(r)
    m.schedule('mailer', '0 3 * * *', async () => {}, { idempotent: 'unsafe' })
    r.store.set('nvr:cron:active:mailer@B', 'other|run now|1')
    const { withTenant } = await import('../../../db/tenant-context.js')
    await expect(withTenant(TENANTS[0], () => m.runNow('mailer', 'u1'))).resolves.toBe(true)
    await expect(withTenant(TENANTS[1], () => m.runNow('mailer', 'u1'))).rejects.toThrow(
      /already running/
    )
    expect(state.runs.map((x) => x.tenant)).toEqual(['A'])
  })

  it('catch-ups fan out: each app checks its own runs and catches up on its own', async () => {
    const m = make()
    const seen: Array<string | undefined> = []
    m.schedule('fk-integrity-sweep', '40 3 * * *', async () => void seen.push(getTenantId()))
    m.markCatchUp('fk-integrity-sweep', 26)
    await m.runCatchUps()
    expect(state.dbReads.sort()).toEqual(['A', 'B', 'C'])
    expect(seen.sort()).toEqual(['A', 'B', 'C'])
    expect(state.runs.every((x) => x.trigger === 'catch-up')).toBe(true)

    state.runs.length = 0
    state.recentRun = true
    vi.mocked(appJobs.forEachApp).mockClear()
    await m.runCatchUps()
    expect(state.runs).toEqual([])
    const res = await vi.mocked(appJobs.forEachApp).mock.results[0]?.value
    expect(res.skipped.map((x: { why: string }) => x.why)).toEqual(['recent', 'recent', 'recent'])
  })
})

describe('self-hosted and Nivaro Cloud are unchanged', () => {
  for (const [label, env] of [
    ['self-hosted', {}],
    ['cloud', { CLOUD_META_DB_URL: 'mssql://meta' }]
  ] as const) {
    it(`${label}: one run, no fan-out, plain keys`, async () => {
      delete process.env.HUB_SHARED_DEPLOYMENT
      Object.assign(process.env, env)
      const r = new FakeRedis()
      const m = make(r)
      let keysDuring: string[] = []
      m.schedule(
        'nightly-app-job',
        '0 3 * * *',
        async () => {
          keysDuring = [...r.store.keys()]
        },
        { heavy: true, idempotent: 'unsafe' }
      )
      expect(await fire(m, 'nightly-app-job')).toBeUndefined()
      expect(appJobs.forEachApp).not.toHaveBeenCalled()
      expect(state.runs).toEqual([{ id: 'nightly-app-job', tenant: null, trigger: 'schedule' }])
      expect(keysDuring.sort()).toEqual([
        'nvr:cron:active:nightly-app-job',
        'nvr:cron:heavy',
        'nvr:cron:run:nightly-app-job:2026-11-21T03:00:00.000Z'
      ])
      m.markCatchUp('nightly-app-job', 26)
      await m.runCatchUps()
      expect(appJobs.forEachApp).not.toHaveBeenCalled()
      expect(state.dbReads).toEqual([null])
    })
  }
})
