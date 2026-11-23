import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryDb } from '../../helpers/memory-db.js'

// Hub shared deployment: staged imports run per app. Apps A and B are copies (same import key,
// same run id 1): each app's tick drains only its own queue, every hand-off key but the kick
// channel names the app, a kick `A|7` drains A only, and a kick for an app this process does not
// list, or one that is not ready, does nothing. Self-hosted keys stay byte-identical; Nivaro Cloud
// stays off.

const h = vi.hoisted(() => ({
  mems: {} as Record<string, MemoryDb>,
  defs: [] as string[]
}))

vi.mock('../../../db/index.js', async () => {
  const { makeMemoryDb } = await import('../../helpers/memory-db.js')
  const tc = await import('../../../db/tenant-context.js')
  h.mems = { A: makeMemoryDb(), B: makeMemoryDb(), N: makeMemoryDb(), '-': makeMemoryDb() }
  // The real `db` follows the tenant context; so does this one.
  const db = (table: string) => h.mems[tc.getTenantId() || '-'](table)
  return { db }
})
vi.mock('../../../services/staged-imports.js', async (orig) => {
  const tc = await import('../../../db/tenant-context.js')
  return {
    ...(await orig<object>()),
    listImportDefinitions: vi.fn(async () => []),
    // No definition: the run claims, then fails at once with a sentence (no file work).
    getImportDefinition: vi.fn(async (key: string) => {
      h.defs.push(`${tc.getTenantId() ?? '-'}:${key}`)
      return null
    })
  }
})
vi.mock('../../../services/import-queue-standing.js', () => ({
  loadQueueStanding: vi.fn(async () => ({ entries: [], standing: new Map() })),
  publishQueueStanding: vi.fn()
}))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn(async () => {}) }))
vi.mock('../../../services/live-progress.js', () => ({
  emitImportProgress: vi.fn(),
  emitJobProgress: vi.fn()
}))
vi.mock('../../../services/traffic-taps/sources.js', () => ({ noteImportRun: vi.fn() }))
vi.mock('../../../services/import-collection-runs.js', () => ({
  announceCollectionImportRun: vi.fn(async () => {})
}))

const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const handoff = await import('../../../services/import-handoff.js')
const worker = await import('../../../services/staged-import-worker.js')
const { bulkUnavailableReason } = await import('../../../services/staged-imports.js')
const { setTenantRegistryForTests } = await import('../../../services/tenancy/registry.js')
const migrations = await import('../../../services/tenancy/app-migrations.js')
const { NIVARO_VERSION } = await import('../../../version.js')
type TenantRecord = import('../../../services/tenancy/types.js').TenantRecord

const SHARED = {
  HUB_SHARED_DEPLOYMENT: 'shared-1',
  HUB_URL: 'https://hub.example.com',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40)
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
/** Run `fn` inside app `id`; the context lasts as long as the promise fn returns. */
function inApp<T>(id: string, fn: () => T): T {
  let out!: T
  runWithTenantDb(
    fakeKnex,
    id.toLowerCase(),
    () => {
      out = fn()
    },
    id
  )
  return out
}

/** In-memory Redis with the calls the hand-off makes; every key it touched is kept. */
function fakeRedis() {
  const lists = new Map<string, string[]>()
  const strings = new Map<string, string>()
  const hashes = new Map<string, Map<string, number>>()
  const published: Array<[string, string]> = []
  const touched = new Set<string>()
  const t = (k: string) => touched.add(k)
  return {
    lists,
    strings,
    published,
    touched,
    rpush: async (k: string, v: string) => {
      t(k)
      const l = lists.get(k) ?? []
      l.push(v)
      lists.set(k, l)
      return l.length
    },
    lrange: async (k: string, a: number, b: number) => {
      t(k)
      return (lists.get(k) ?? []).slice(a, b + 1)
    },
    lrem: async (k: string, _n: number, v: string) => {
      t(k)
      const l = lists.get(k) ?? []
      const i = l.indexOf(v)
      if (i >= 0) l.splice(i, 1)
      return i >= 0 ? 1 : 0
    },
    llen: async (k: string) => (lists.get(k) ?? []).length,
    publish: async (c: string, m: string) => {
      published.push([c, m])
      return 1
    },
    set: async (k: string, v: string) => {
      t(k)
      strings.set(k, v)
      return 'OK'
    },
    get: async (k: string) => {
      t(k)
      return strings.get(k) ?? null
    },
    hget: async (k: string, f: string) => {
      t(k)
      const n = hashes.get(k)?.get(f)
      return n == null ? null : String(n)
    },
    hincrby: async (k: string, f: string, by: number) => {
      t(k)
      const m = hashes.get(k) ?? new Map<string, number>()
      m.set(f, (m.get(f) ?? 0) + by)
      hashes.set(k, m)
      return m.get(f) as number
    },
    hdel: async (k: string, f: string) => {
      t(k)
      return hashes.get(k)?.delete(f) ? 1 : 0
    }
  }
}

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
const makeApp = (redis = fakeRedis()) =>
  ({ log, redis }) as unknown as FastifyInstance & { redis: ReturnType<typeof fakeRedis> }

const queued = (id: number, key = 'invoices') => ({
  id,
  import_key: key,
  status: 'queued',
  sort: 0,
  file: null,
  created_by: null,
  created_at: new Date()
})

const saved = { ...process.env }
beforeEach(() => {
  for (const m of Object.values(h.mems)) m.reset()
  h.defs.length = 0
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
  delete process.env.NIVARO_ROLE
  delete process.env.IMPORT_WORKER
  process.env.REDIS_CHANNEL_PREFIX = 'p1:'
  process.env.CRON_TICKS = 'on'
  migrations._resetAppMigrationsForTests()
})
afterEach(() => {
  process.env = { ...saved }
  setTenantRegistryForTests(null)
  migrations._resetAppMigrationsForTests()
})

describe('hand-off keys', () => {
  it('self-hosted: every key and the kick channel are byte-identical', () => {
    const db = handoff.handoffDbScope()
    const base = `p1:nvr:import-handoff:${db}`
    expect(handoff.importQueueKey()).toBe(base)
    expect(handoff.importAttemptsKey()).toBe(`${base}:attempts`)
    expect(handoff.importKickChannel()).toBe(`${base}:kick`)
    expect(handoff.importWorkerKey()).toBe(`p1:nvr:import-worker:${db}`)
    expect(handoff.importFallbackKey()).toBe(`p1:nvr:import-worker:${db}:fallback`)
    expect(handoff.importJobQueueKey()).toBe(`${base}:jobs`)
    expect(handoff.importJobAttemptsKey()).toBe(`${base}:jobs:attempts`)
    expect(handoff.importJobLeaseKey('u1')).toBe(`${base}:jobs:lease:u1`)
  })

  it('inside an app every key names the app; the kick channel stays deployment-wide', () => {
    Object.assign(process.env, SHARED)
    const db = handoff.handoffDbScope()
    const base = `p1:nvr:import-handoff:${db}`
    const keys = inApp('A', () => ({
      queue: handoff.importQueueKey(),
      attempts: handoff.importAttemptsKey(),
      kick: handoff.importKickChannel(),
      worker: handoff.importWorkerKey(),
      fallback: handoff.importFallbackKey(),
      jobs: handoff.importJobQueueKey(),
      jobAttempts: handoff.importJobAttemptsKey(),
      lease: handoff.importJobLeaseKey('u1')
    }))
    expect(keys).toEqual({
      queue: `${base}:A`,
      attempts: `${base}:A:attempts`,
      kick: `${base}:kick`,
      worker: `p1:nvr:import-worker:${db}:A`,
      fallback: `p1:nvr:import-worker:${db}:A:fallback`,
      jobs: `${base}:A:jobs`,
      jobAttempts: `${base}:A:jobs:attempts`,
      lease: `${base}:A:jobs:lease:u1`
    })
    expect(inApp('B', () => handoff.importQueueKey())).toBe(`${base}:B`)
  })
})

describe('kicks', () => {
  it('self-hosted: the payload is the bare run id or job:<id>', async () => {
    const r = fakeRedis()
    await handoff.enqueueImportRun(r, 7)
    await handoff.enqueueImportJob(r, 'u1')
    expect(r.published).toEqual([
      [handoff.importKickChannel(), '7'],
      [handoff.importKickChannel(), 'job:u1']
    ])
  })

  it('shared, inside an app: the payload names the app, on the one deployment channel', async () => {
    Object.assign(process.env, SHARED)
    const r = fakeRedis()
    await inApp('A', () => handoff.enqueueImportRun(r, 7))
    await inApp('B', () => handoff.enqueueImportJob(r, 'u1'))
    const channel = handoff.importKickChannel()
    expect(r.published).toEqual([
      [channel, 'A|7'],
      [channel, 'B|job:u1']
    ])
    expect(r.lists.get(`${handoff.importQueueKey()}:A`)?.map((e) => JSON.parse(e).id)).toEqual([7])
    expect(r.lists.get(`${handoff.importQueueKey()}:B:jobs`)?.map((e) => JSON.parse(e).id)).toEqual(
      ['u1']
    )
  })

  it('Nivaro Cloud queues nothing (the tenant process runs its own work)', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta/x'
    const r = fakeRedis()
    expect(await handoff.enqueueImportRun(r, 7)).toBe(false)
    expect(await handoff.enqueueImportJob(r, 'u1')).toBe(false)
    expect(r.published).toEqual([])
  })

  it('parseKick reads the app and the target', () => {
    expect(handoff.parseKick('A|7')).toEqual({ tenant: 'A', target: '7' })
    expect(handoff.parseKick('A|job:u1')).toEqual({ tenant: 'A', target: 'job:u1' })
    expect(handoff.parseKick('7')).toEqual({ tenant: null, target: '7' })
    expect(handoff.parseKick('job:u1')).toEqual({ tenant: null, target: 'job:u1' })
    expect(handoff.parseKick('|7')).toEqual({ tenant: null, target: '7' })
  })
})

describe('who drains', () => {
  it('Nivaro Cloud is off; a shared deployment drains from its cron; web roles never', () => {
    expect(handoff.importDrainMode({ CLOUD_META_DB_URL: 'postgres://meta' })).toBe('off')
    expect(handoff.importDrainMode({ ...SHARED })).not.toBe('off')
    expect(handoff.importDrainMode({ ...SHARED })).toBe('inline')
    expect(handoff.importDrainMode({ ...SHARED, NIVARO_ROLE: 'worker' })).toBe('fallback')
    expect(handoff.importDrainMode({ ...SHARED, NIVARO_ROLE: 'web' })).toBe('off')
    expect(handoff.importDrainMode({ ...SHARED, IMPORT_WORKER: 'off' })).toBe('off')
    // No process loop on a shared deployment: IMPORT_WORKER=on does not turn one on.
    expect(handoff.importDrainMode({ ...SHARED, IMPORT_WORKER: 'on' })).toBe('inline')
  })
})

describe('two apps, copied queues', () => {
  beforeEach(() => {
    Object.assign(process.env, SHARED)
    h.mems.A.rows('nivaro_import_queue').push(queued(1))
    h.mems.B.rows('nivaro_import_queue').push(queued(1))
  })

  const status = (app: string) => h.mems[app].rows('nivaro_import_queue')[0]?.status

  it("each app's tick drains only its own run 1", async () => {
    const app = makeApp()
    await inApp('A', () => worker.drainImportsTick(app))
    await vi.waitFor(() => expect(status('A')).toBe('error'))
    expect(status('B')).toBe('queued')
    expect(h.mems.B.reads).toEqual([])
    expect(h.mems['-'].reads).toEqual([])
    expect(h.defs).toEqual(['A:invoices'])
    // A's beat and its hand-off entries are A's own keys.
    const touched = [...app.redis.touched]
    expect(touched.length).toBeGreaterThan(0)
    for (const k of touched) expect(k).toMatch(/:A(:|$)/)

    await inApp('B', () => worker.drainImportsTick(app))
    await vi.waitFor(() => expect(status('B')).toBe('error'))
    expect(h.defs).toEqual(['A:invoices', 'B:invoices'])
  })

  it('a kick `A|1` drains A only', async () => {
    useRegistry()
    const app = makeApp()
    await worker.onImportKick(app, 'A|1')
    await vi.waitFor(() => expect(status('A')).toBe('error'))
    expect(status('B')).toBe('queued')
    expect(h.mems.B.reads).toEqual([])
    expect(h.defs).toEqual(['A:invoices'])
  })

  it('a kick for an app this process does not list, or a malformed one, does nothing', async () => {
    useRegistry()
    const app = makeApp()
    for (const raw of ['Z|1', '1', '|1', 'garbage', ''])
      await expect(worker.onImportKick(app, raw)).resolves.toBeUndefined()
    await new Promise((r) => setTimeout(r, 20))
    expect(status('A')).toBe('queued')
    expect(status('B')).toBe('queued')
    expect(h.defs).toEqual([])
  })

  it('a kick for an app that is not ready, in maintenance or suspended is skipped', async () => {
    useRegistry([tenant('A'), tenant('M', 'maintenance'), tenant('S', 'suspended')])
    migrations._configureAppMigrationsForTests({ gate: true }) // nothing migrated: A not ready
    const app = makeApp()
    for (const raw of ['A|1', 'M|1', 'S|1'])
      await expect(worker.onImportKick(app, raw)).resolves.toBeUndefined()
    await new Promise((r) => setTimeout(r, 20))
    expect(status('A')).toBe('queued')
    expect(h.mems.A.reads).toEqual([])
    expect(h.defs).toEqual([])
  })
})

describe('Task 14: the importer role on a shared deployment', () => {
  const status = (app: string) => h.mems[app].rows('nivaro_import_queue')[0]?.status
  /** What the migrating replicas keep in Redis for an app whose schema is ok at this version. */
  const schemaOk = (r: ReturnType<typeof fakeRedis>, t: TenantRecord) =>
    r.strings.set(
      migrations.appSchemaKey(t.id),
      JSON.stringify({
        version: NIVARO_VERSION,
        state: 'ok',
        at: new Date().toISOString(),
        error: null,
        conn: migrations.appConnFingerprint(t)
      })
    )

  beforeEach(() => {
    Object.assign(process.env, SHARED, { NIVARO_ROLE: 'importer' })
    h.mems.A.rows('nivaro_import_queue').push(queued(1))
    h.mems.B.rows('nivaro_import_queue').push(queued(1))
  })

  it('drains on kicks and on its own per-app pass', () => {
    expect(handoff.importDrainMode()).toBe('importer')
  })

  it('its pass drains every listed, ready app without a kick, each inside its own app', async () => {
    const all = [tenant('A'), tenant('B'), tenant('M', 'maintenance'), tenant('N')]
    useRegistry(all)
    h.mems.N.rows('nivaro_import_queue').push(queued(1))
    const app = makeApp()
    for (const t of [all[0], all[1], all[2]]) schemaOk(app.redis, t) // N: never migrated
    const out = await worker.drainEveryAppImports(app)
    expect(out?.ran.sort()).toEqual(['A', 'B'])
    expect(out?.skipped).toEqual(
      expect.arrayContaining([
        { tenant: 'M', why: 'maintenance' },
        { tenant: 'N', why: 'not_ready' }
      ])
    )
    await vi.waitFor(() => expect([status('A'), status('B')]).toEqual(['error', 'error']))
    expect(status('N')).toBe('queued')
    expect(h.mems.N.reads).toEqual([])
    expect(h.defs.sort()).toEqual(['A:invoices', 'B:invoices'])
    // Each app's importer beat is its own key: its fallback stands down only while it beats.
    const db = handoff.handoffDbScope()
    for (const id of ['A', 'B'])
      expect(app.redis.strings.has(`p1:nvr:import-worker:${db}:${id}`)).toBe(true)
  })

  it('a run whose worker died is put back and run by the pass, with no kick', async () => {
    useRegistry([tenant('A')])
    const old = new Date(Date.now() - 30 * 60_000)
    h.mems.A.reset()
    h.mems.A.rows('nivaro_import_queue').push({
      ...queued(1),
      status: 'running',
      started_at: old,
      updated_at: old
    })
    const app = makeApp()
    schemaOk(app.redis, tenant('A'))
    await worker.drainEveryAppImports(app)
    // Put back in the queue (lease recovery), then claimed and run (no definition: error).
    await vi.waitFor(() => expect(status('A')).toBe('error'))
    expect(h.defs).toEqual(['A:invoices'])
  })

  it('a kick on the importer reads readiness from the stored state (it runs no migration loop)', async () => {
    useRegistry()
    const app = makeApp()
    await worker.onImportKick(app, 'A|1')
    await new Promise((r) => setTimeout(r, 20))
    expect(status('A')).toBe('queued')
    expect(h.mems.A.reads).toEqual([])
    // Stored for another database (a replaced connection) is not this app's state either.
    app.redis.strings.set(
      migrations.appSchemaKey('A'),
      JSON.stringify({ version: NIVARO_VERSION, state: 'ok', conn: 'other' })
    )
    await worker.onImportKick(app, 'A|1')
    await new Promise((r) => setTimeout(r, 20))
    expect(status('A')).toBe('queued')
    schemaOk(app.redis, tenant('A'))
    await worker.onImportKick(app, 'A|1')
    await vi.waitFor(() => expect(status('A')).toBe('error'))
    expect(status('B')).toBe('queued')
  })

  it('startImportDrainer runs the pass at once and every 10 s; a worker role starts none', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      useRegistry()
      const hooks: Array<() => Promise<void>> = []
      const app = Object.assign(makeApp(), {
        addHook: (_n: string, fn: () => Promise<void>) => hooks.push(fn)
      })
      schemaOk(app.redis, tenant('A'))
      schemaOk(app.redis, tenant('B'))
      expect(await worker.startImportDrainer(app)).toBe('importer')
      await vi.waitFor(() => expect([status('A'), status('B')]).toEqual(['error', 'error']))
      h.mems.A.rows('nivaro_import_queue').push(queued(2))
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() =>
        expect(h.mems.A.rows('nivaro_import_queue').map((r) => r.status)).toEqual([
          'error',
          'error'
        ])
      )
      for (const fn of hooks) await fn()

      // The worker (fallback) keeps draining from its per-app cron only: no loop of its own.
      process.env.NIVARO_ROLE = 'worker'
      const w = Object.assign(makeApp(), {
        addHook: (_n: string, fn: () => Promise<void>) => hooks.push(fn)
      })
      h.mems.B.rows('nivaro_import_queue').push(queued(3))
      expect(await worker.startImportDrainer(w)).toBe('fallback')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(h.mems.B.rows('nivaro_import_queue').map((r) => r.status)).toEqual(['error', 'queued'])
      for (const fn of hooks) await fn()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the bulk loader on a shared deployment', () => {
  it('is unavailable, so the run loads with inserts', () => {
    const err = new Error('Bulk load data conversion error (type mismatch)')
    expect(bulkUnavailableReason(err)).toBeNull() // self-hosted: a file problem fails the run
    Object.assign(process.env, SHARED)
    expect(bulkUnavailableReason(err)).toBe(
      "The bulk loader uses the server's file share, which a shared deployment does not give each app; rows load with inserts."
    )
  })
})
