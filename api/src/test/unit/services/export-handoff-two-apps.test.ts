import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryDb } from '../../helpers/memory-db.js'

// Task 15 — the export hand-off on a Hub shared deployment, per app (as Task 4 did for imports).
// Apps A and B are copies (same run id 3, same person): every hand-off key but the kick channel
// names the app, a kick `A|3` drains A only, each app's drain pass runs only its own job inside
// its own app, the exporter runs its own 10 s pass over every ready app, and the worker/importer
// fallback stands down per app (only where that app's exporter beats). Self-hosted keys and
// payloads stay byte-identical; Nivaro Cloud stays off.

const h = vi.hoisted(() => ({
  mems: {} as Record<string, MemoryDb>,
  /** `<app>:<run id>` of every export the drainer ran, in order. */
  ran: [] as string[],
  /** When set, a run waits for it before it finishes. */
  hold: null as Promise<void> | null,
  release: () => {},
  shutdown: [] as string[]
}))

vi.mock('../../../db/index.js', async () => {
  const { makeMemoryDb } = await import('../../helpers/memory-db.js')
  const tc = await import('../../../db/tenant-context.js')
  h.mems = {
    A: makeMemoryDb(),
    B: makeMemoryDb(),
    M: makeMemoryDb(),
    N: makeMemoryDb(),
    '-': makeMemoryDb()
  }
  const db = (table: string) => h.mems[tc.getTenantId() || '-'](table)
  return { db }
})
vi.mock('../../../services/export-runs.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  const { db } = await import('../../../db/index.js')
  return {
    runHandedOffExport: vi.fn(async (_app: unknown, job: { run_id: number }) => {
      h.ran.push(`${tc.getTenantId() ?? '-'}:${job.run_id}`)
      if (h.hold) await h.hold
      await db('nivaro_job_runs')
        .where({ id: job.run_id, status: 'running' })
        .update({ status: 'completed' })
      return 'ran'
    }),
    abortLocalExport: vi.fn(),
    exportCancelRequested: vi.fn(async () => false),
    exportRowsDoneHere: vi.fn(() => 5),
    exportStoppedUntouched: vi.fn(() => false),
    SHUTDOWN_EXPORT_NOTE: 'The process stopped.',
    stopExportForShutdown: vi.fn(() => {
      h.shutdown.push(tc.getTenantId() ?? '-')
      h.release()
    }),
    markHandedOff: vi.fn(async () => {})
  }
})
vi.mock('../../../services/background-runs.js', () => ({
  releaseRunSlot: vi.fn(async () => {}),
  renewRunSlot: vi.fn(async () => {})
}))
vi.mock('../../../services/live-progress.js', () => ({ emitJobProgress: vi.fn() }))

const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const handoff = await import('../../../services/export-handoff.js')
const { handoffDbScope } = await import('../../../services/import-handoff.js')
const worker = await import('../../../services/export-worker.js')
const { setTenantRegistryForTests } = await import('../../../services/tenancy/registry.js')
const migrations = await import('../../../services/tenancy/app-migrations.js')
const { NIVARO_VERSION } = await import('../../../version.js')
type TenantRecord = import('../../../services/tenancy/types.js').TenantRecord
type ExportJob = import('../../../services/export-handoff.js').ExportJob

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

/** Enough of ioredis for the export hand-off (the scripts as export-handoff.test.ts runs them). */
class FakeRedis {
  strings = new Map<string, string>()
  lists = new Map<string, string[]>()
  hashes = new Map<string, Map<string, string>>()
  published: Array<[string, string]> = []
  touched = new Set<string>()
  private t(k: string) {
    this.touched.add(k)
  }
  async get(k: string) {
    this.t(k)
    return this.strings.get(k) ?? null
  }
  async set(k: string, v: string) {
    this.t(k)
    this.strings.set(k, v)
    return 'OK'
  }
  async del(k: string) {
    this.t(k)
    return this.strings.delete(k) ? 1 : 0
  }
  async rpush(k: string, v: string) {
    this.t(k)
    const l = this.lists.get(k) ?? []
    l.push(v)
    this.lists.set(k, l)
    return l.length
  }
  async lpop(k: string) {
    this.t(k)
    return this.lists.get(k)?.shift() ?? null
  }
  async lrange(k: string, a: number, b: number) {
    this.t(k)
    return (this.lists.get(k) ?? []).slice(a, b < 0 ? undefined : b + 1)
  }
  async lrem(k: string, _n: number, v: string) {
    this.t(k)
    const l = this.lists.get(k) ?? []
    const i = l.indexOf(v)
    if (i < 0) return 0
    l.splice(i, 1)
    return 1
  }
  async publish(c: string, m: string) {
    this.published.push([c, m])
    return 0
  }
  async hset(k: string, f: string, v: string) {
    this.t(k)
    const m = this.hashes.get(k) ?? new Map()
    m.set(f, v)
    this.hashes.set(k, m)
    return 1
  }
  async hget(k: string, f: string) {
    this.t(k)
    return this.hashes.get(k)?.get(f) ?? null
  }
  async hgetall(k: string) {
    this.t(k)
    return Object.fromEntries(this.hashes.get(k) ?? new Map())
  }
  async hdel(k: string, f: string) {
    this.t(k)
    return this.hashes.get(k)?.delete(f) ? 1 : 0
  }
  async eval(script: string, _n: number, ...args: string[]) {
    if (script.includes('nvr:export-claim')) {
      const [list, claimed, leases, lease] = args
      const raw = await this.lpop(list)
      if (raw == null) return null
      const id = /"run_id":(\d+)/.exec(raw)?.[1] as string
      await this.hset(leases, id, lease)
      await this.hset(claimed, id, raw)
      return [raw, 'claimed']
    }
    if (script.includes('nvr:export-renew')) {
      const [leases, id, by, value] = args
      if (!this.hashes.get(leases)?.get(id)?.startsWith(`${by}|`)) return 0
      await this.hset(leases, id, value)
      return 1
    }
    if (script.includes('nvr:export-release')) {
      const [claimed, leases, id, match, mode] = args
      const v = this.hashes.get(leases)?.get(id)
      const mine =
        mode === 'exact' ? (v == null && match === '') || v === match : !!v?.startsWith(`${match}|`)
      if (!mine) return 0
      await this.hdel(leases, id)
      await this.hdel(claimed, id)
      return 1
    }
    return 0
  }
  /** The kick subscriber's connection: hears what is published on the channels it joined. */
  subs: Array<{ channels: Set<string>; fns: Array<(c: string, m: string) => void> }> = []
  duplicate() {
    const sub = { channels: new Set<string>(), fns: [] as Array<(c: string, m: string) => void> }
    this.subs.push(sub)
    return {
      subscribe: async (c: string) => sub.channels.add(c),
      on: (e: string, fn: (c: string, m: string) => void) => {
        if (e === 'message') sub.fns.push(fn)
      },
      quit: async () => {}
    }
  }
  hear(channel: string, message: string) {
    for (const s of this.subs)
      if (s.channels.has(channel)) for (const fn of s.fns) fn(channel, message)
  }
}

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
const makeApp = (redis = new FakeRedis()) => {
  const hooks: Array<() => Promise<void>> = []
  const app = {
    log,
    redis,
    hooks,
    addHook: (_n: string, fn: () => Promise<void>) => hooks.push(fn)
  }
  return app as unknown as FastifyInstance & { redis: FakeRedis; hooks: typeof hooks }
}

const job = (run_id: number): ExportJob => ({
  v: 1,
  run_id,
  kind: 'items',
  subject: 'workflows',
  label: 'Exporting Workflows',
  user_id: 'u1',
  workspace_id: null,
  params: {},
  total: null,
  slot: 0,
  slot_owner: 'web-1',
  started_at: Date.now()
})

const status = (app: string, id = 3) =>
  h.mems[app].rows('nivaro_job_runs').find((r) => r.id === id)?.status

/** Queue run `id` for app `app` the way a web process does (row running, entry + kick). */
async function queueIn(r: FakeRedis, app: string, id = 3) {
  h.mems[app].rows('nivaro_job_runs').push({ id, status: 'running' })
  await inApp(app, () => handoff.enqueueExport(r as never, job(id)))
}

/** What the migrating replicas keep in Redis for an app whose schema is ok at this version. */
const schemaOk = (r: FakeRedis, t: TenantRecord) =>
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

const beat = (r: FakeRedis, app: string, role: 'exporter' | 'importer' | 'fallback') =>
  inApp(app, () =>
    handoff.beatExportWorker(r as never, {
      role,
      instance: `other-${role}`,
      name: null,
      version: 'test',
      at: new Date().toISOString()
    })
  )

const saved = { ...process.env }
beforeEach(() => {
  for (const m of Object.values(h.mems)) m.reset()
  h.ran.length = 0
  h.shutdown.length = 0
  h.hold = null
  for (const k of [
    'CLOUD_META_DB_URL',
    'HUB_SHARED_DEPLOYMENT',
    'NIVARO_ROLE',
    'EXPORT_WORKER',
    'EXPORT_HANDOFF'
  ])
    delete process.env[k]
  process.env.REDIS_CHANNEL_PREFIX = 'p1:'
  process.env.CRON_TICKS = 'on'
  // One app at a time in a pass: vitest's module mocker can hand the worker's lazy
  // `import('./export-runs.js')` the real module when two tenant lanes import it at once (a test
  // runner quirk; Node caches one module). Two apps running at once is covered below.
  process.env.TENANT_JOB_CONCURRENCY = '1'
  migrations._resetAppMigrationsForTests()
  worker.__resetExportWorker()
})
afterEach(() => {
  process.env = { ...saved }
  setTenantRegistryForTests(null)
  migrations._resetAppMigrationsForTests()
})

describe('hand-off keys', () => {
  it('self-hosted: every key and the kick channel are byte-identical', () => {
    const db = handoffDbScope()
    const base = `p1:nvr:export-handoff:${db}`
    expect(handoff.exportQueueKey()).toBe(base)
    expect(handoff.exportKickChannel()).toBe(`${base}:kick`)
    expect(handoff.exportClaimedKey()).toBe(`${base}:claimed`)
    expect(handoff.exportLeasesKey()).toBe(`${base}:leases`)
    expect(handoff.exportWorkerKey()).toBe(`p1:nvr:export-worker:${db}`)
    expect(handoff.exportImporterBeatKey()).toBe(`p1:nvr:export-worker:${db}:importer`)
    expect(handoff.exportFallbackKey()).toBe(`p1:nvr:export-worker:${db}:fallback`)
    expect(handoff.exportCancelKey(3)).toBe(`p1:nvr:export-cancel:${db}:-:3`)
  })

  it('inside an app every key names the app; the kick channel stays deployment-wide', () => {
    Object.assign(process.env, SHARED)
    const db = handoffDbScope()
    const base = `p1:nvr:export-handoff:${db}`
    const keys = inApp('A', () => ({
      queue: handoff.exportQueueKey(),
      kick: handoff.exportKickChannel(),
      claimed: handoff.exportClaimedKey(),
      leases: handoff.exportLeasesKey(),
      exporter: handoff.exportWorkerKey(),
      importer: handoff.exportImporterBeatKey(),
      fallback: handoff.exportFallbackKey(),
      cancel: handoff.exportCancelKey(3)
    }))
    expect(keys).toEqual({
      queue: `${base}:A`,
      kick: `${base}:kick`,
      claimed: `${base}:A:claimed`,
      leases: `${base}:A:leases`,
      exporter: `p1:nvr:export-worker:${db}:A`,
      importer: `p1:nvr:export-worker:${db}:A:importer`,
      fallback: `p1:nvr:export-worker:${db}:A:fallback`,
      cancel: `p1:nvr:export-cancel:${db}:A:3`
    })
    expect(inApp('B', () => handoff.exportQueueKey())).toBe(`${base}:B`)
  })
})

describe('kicks', () => {
  it('self-hosted: the payload is the bare run id', async () => {
    const r = new FakeRedis()
    await handoff.enqueueExport(r as never, job(3))
    expect(r.published).toEqual([[handoff.exportKickChannel(), '3']])
  })

  it('shared, inside an app: the payload names the app, on the one deployment channel', async () => {
    Object.assign(process.env, SHARED)
    const r = new FakeRedis()
    await queueIn(r, 'A')
    await queueIn(r, 'B')
    const channel = handoff.exportKickChannel()
    expect(r.published).toEqual([
      [channel, 'A|3'],
      [channel, 'B|3']
    ])
  })
})

describe('who drains on a shared deployment', () => {
  it('the hand-off is on (off in Nivaro Cloud); each role drains as self-hosted', () => {
    expect(handoff.exportHandoffEnabled({ ...SHARED })).toBe(true)
    expect(handoff.exportHandoffEnabled({ ...SHARED, EXPORT_HANDOFF: 'off' })).toBe(false)
    expect(handoff.exportHandoffEnabled({ CLOUD_META_DB_URL: 'postgres://meta' })).toBe(false)
    expect(handoff.exportDrainMode({ ...SHARED, NIVARO_ROLE: 'exporter' })).toBe('exporter')
    expect(handoff.exportDrainMode({ ...SHARED, NIVARO_ROLE: 'importer' })).toBe('importer')
    expect(handoff.exportDrainMode({ ...SHARED, NIVARO_ROLE: 'worker' })).toBe('fallback')
    expect(handoff.exportDrainMode({ ...SHARED, NIVARO_ROLE: 'web' })).toBe('off')
    expect(handoff.exportDrainMode({ ...SHARED })).toBe('inline')
    expect(
      handoff.exportDrainMode({ CLOUD_META_DB_URL: 'postgres://meta', NIVARO_ROLE: 'exporter' })
    ).toBe('off')
  })

  it('a web process hands off only to a drainer beating for the app it is in', async () => {
    Object.assign(process.env, SHARED, { NIVARO_ROLE: 'web' })
    const r = new FakeRedis()
    await beat(r, 'A', 'exporter')
    expect(await inApp('A', () => handoff.exportPlacement(r as never))).toBe('handoff')
    expect(await inApp('B', () => handoff.exportPlacement(r as never))).toBe('here')
  })
})

describe('two apps, copied runs (both run 3)', () => {
  beforeEach(() => {
    Object.assign(process.env, SHARED, { NIVARO_ROLE: 'exporter' })
  })

  it("each app's drain pass runs only its own run 3, inside its own app", async () => {
    const app = makeApp()
    await queueIn(app.redis, 'A')
    await queueIn(app.redis, 'B')
    app.redis.touched.clear()
    await inApp('A', () => worker.drainExportsTick(app))
    await vi.waitFor(() => expect(status('A')).toBe('completed'))
    expect(status('B')).toBe('running')
    expect(h.ran).toEqual(['A:3'])
    expect(h.mems.B.reads).toEqual([])
    // A's beat, claim and lease are A's own keys.
    const touched = [...app.redis.touched]
    expect(touched.length).toBeGreaterThan(0)
    for (const k of touched) expect(k).toMatch(/:A(:|$)/)
    expect(app.redis.strings.has(inApp('A', () => handoff.exportWorkerKey()))).toBe(true)
    expect(app.redis.strings.has(inApp('B', () => handoff.exportWorkerKey()))).toBe(false)

    await inApp('B', () => worker.drainExportsTick(app))
    await vi.waitFor(() => expect(status('B')).toBe('completed'))
    expect(h.ran).toEqual(['A:3', 'B:3'])
  })

  it('both apps can hold their run 3 at once on one process', async () => {
    let release!: () => void
    h.hold = new Promise<void>((r) => {
      release = r
    })
    const app = makeApp()
    await queueIn(app.redis, 'A')
    await queueIn(app.redis, 'B')
    await inApp('A', () => worker.drainExportsTick(app))
    await inApp('B', () => worker.drainExportsTick(app))
    await vi.waitFor(() => expect(h.ran.sort()).toEqual(['A:3', 'B:3']))
    expect(worker.__exportRunsHere()).toEqual([3, 3])
    // Neither app's lost-run sweep takes the other's live run 3 for its own.
    await inApp('A', () => worker.drainExportsTick(app))
    expect(status('A')).toBe('running')
    expect(status('B')).toBe('running')
    release()
    await vi.waitFor(() => expect([status('A'), status('B')]).toEqual(['completed', 'completed']))
    await vi.waitFor(() => expect(worker.__exportRunsHere()).toEqual([]))
  })

  it('a kick `A|3` drains A only; an unknown, malformed, not-ready or maintenance kick does nothing', async () => {
    useRegistry([tenant('A'), tenant('B'), tenant('M', 'maintenance'), tenant('N')])
    const app = makeApp()
    for (const t of ['A', 'B', 'M']) schemaOk(app.redis, tenant(t)) // N: never migrated
    await queueIn(app.redis, 'A')
    await queueIn(app.redis, 'B')
    await queueIn(app.redis, 'M')
    await queueIn(app.redis, 'N')
    for (const raw of ['Z|3', '3', '|3', 'garbage', '', 'M|3', 'N|3'])
      await expect(worker.onExportKick(app, raw)).resolves.toBeUndefined()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.ran).toEqual([])
    await worker.onExportKick(app, 'A|3')
    await vi.waitFor(() => expect(status('A')).toBe('completed'))
    expect(status('B')).toBe('running')
    expect(h.ran).toEqual(['A:3'])
  })

  it("the exporter's own pass drains every listed, ready app, each inside its own app", async () => {
    const all = [tenant('A'), tenant('B'), tenant('M', 'maintenance'), tenant('N')]
    useRegistry(all)
    const app = makeApp()
    for (const t of [all[0], all[1], all[2]]) schemaOk(app.redis, t) // N: never migrated
    for (const id of ['A', 'B', 'M', 'N']) await queueIn(app.redis, id)
    const out = await worker.drainEveryAppExports(app)
    expect(out?.ran.sort()).toEqual(['A', 'B'])
    expect(out?.skipped).toEqual(
      expect.arrayContaining([
        { tenant: 'M', why: 'maintenance' },
        { tenant: 'N', why: 'not_ready' }
      ])
    )
    await vi.waitFor(() => expect([status('A'), status('B')]).toEqual(['completed', 'completed']))
    expect(status('N')).toBe('running')
    expect(h.mems.N.reads).toEqual([])
    expect(h.ran.sort()).toEqual(['A:3', 'B:3'])
    // Each app's exporter beat is its own key.
    for (const id of ['A', 'B'])
      expect(app.redis.strings.has(inApp(id, () => handoff.exportWorkerKey()))).toBe(true)
  })

  it('startExportDrainer runs the pass at once, hears kicks, and a web role starts none', async () => {
    useRegistry()
    const app = makeApp()
    schemaOk(app.redis, tenant('A'))
    schemaOk(app.redis, tenant('B'))
    await queueIn(app.redis, 'A')
    await queueIn(app.redis, 'B')
    expect(await worker.startExportDrainer(app)).toBe('exporter')
    await vi.waitFor(() => expect([status('A'), status('B')]).toEqual(['completed', 'completed']))
    // A kick on the deployment channel drains the app it names at once.
    await queueIn(app.redis, 'B', 4)
    app.redis.hear(handoff.exportKickChannel(), 'B|4')
    await vi.waitFor(() => expect(status('B', 4)).toBe('completed'))
    for (const fn of app.hooks) await fn()

    process.env.NIVARO_ROLE = 'web'
    expect(await worker.startExportDrainer(makeApp())).toBe('off')
  })
})

describe('the fallback stands down per app', () => {
  it("the worker drains B (no exporter there) and leaves A's export to A's exporter", async () => {
    Object.assign(process.env, SHARED, { NIVARO_ROLE: 'worker' })
    useRegistry()
    const app = makeApp()
    await queueIn(app.redis, 'A')
    await queueIn(app.redis, 'B')
    await beat(app.redis, 'A', 'exporter')
    const out = await worker.drainEveryAppExports(app)
    expect(out?.ran.sort()).toEqual(['A', 'B'])
    await vi.waitFor(() => expect(status('B')).toBe('completed'))
    expect(status('A')).toBe('running')
    expect(h.ran).toEqual(['B:3'])
    expect(app.redis.lists.get(inApp('A', () => handoff.exportQueueKey()))).toHaveLength(1)
    // The worker beats as B's fallback only.
    expect(app.redis.strings.has(inApp('B', () => handoff.exportFallbackKey()))).toBe(true)
    expect(app.redis.strings.has(inApp('A', () => handoff.exportFallbackKey()))).toBe(false)
  })

  it("the importer drains an app only while that app's exporter does not beat", async () => {
    Object.assign(process.env, SHARED, { NIVARO_ROLE: 'importer' })
    useRegistry()
    const app = makeApp()
    schemaOk(app.redis, tenant('A'))
    schemaOk(app.redis, tenant('B'))
    await queueIn(app.redis, 'A')
    await queueIn(app.redis, 'B')
    await beat(app.redis, 'B', 'exporter')
    await worker.drainEveryAppExports(app)
    await vi.waitFor(() => expect(status('A')).toBe('completed'))
    expect(status('B')).toBe('running')
    expect(h.ran).toEqual(['A:3'])
    expect(app.redis.strings.has(inApp('A', () => handoff.exportImporterBeatKey()))).toBe(true)
  })
})

describe('stopping a shared drainer', () => {
  it("stops each app's run inside its own app and drops its own beat in every app", async () => {
    Object.assign(process.env, SHARED, { NIVARO_ROLE: 'exporter' })
    useRegistry()
    h.hold = new Promise<void>((r) => {
      h.release = r
    })
    const app = makeApp()
    await queueIn(app.redis, 'A')
    await queueIn(app.redis, 'B')
    await inApp('A', () => worker.drainExportsTick(app))
    await inApp('B', () => worker.drainExportsTick(app))
    await vi.waitFor(() => expect(h.ran.sort()).toEqual(['A:3', 'B:3']))
    // Each run is stopped inside its own app (its local key, its row, its slot are that app's).
    await worker.stopExportDrainerRuns(app)
    expect(h.shutdown.sort()).toEqual(['A', 'B'])
    for (const id of ['A', 'B'])
      expect(app.redis.strings.has(inApp(id, () => handoff.exportWorkerKey()))).toBe(false)
  })
})
