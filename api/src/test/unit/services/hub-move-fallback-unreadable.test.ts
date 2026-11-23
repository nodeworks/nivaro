import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, stat as statFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, untested path 1: a move's file copy when the SOURCE reads stored objects
// through FILES_FALLBACK_DIR and that folder (or a file in it) cannot be read — EACCES, ENOENT,
// EIO. Everything between the source's disk and the move's decision is real here: the source's
// transfer route (routes/hub-transfer.ts → openTransferObject → the strict fallback chain) on a
// loopback port, the target's pull (services/hub-transfer/pull.ts) into a temp folder, and the
// move run (services/hub/move/run.ts) on SQLite with the hub tables. Only the move's other side
// effects (maintenance, routes, placement) are a fake MoveOps.
//
// Expected: the copy names the files that failed with a plain reason; inside maintenance the
// move rolls back (P6-26) instead of releasing without them; nothing failed is stored on the
// target or counted as copied; neither the fallback path nor the ticket reaches the move's
// record; and once the folder is readable again a new move completes.

const h = vi.hoisted(() => ({
  own: '',
  /** Paths whose stat answers EIO (an NFS fallback mount gone bad). */
  eio: [] as string[]
}))

vi.mock('node:fs/promises', async (orig) => {
  const real = (await orig()) as typeof import('node:fs/promises')
  const stat = (async (p: Parameters<typeof real.stat>[0], o?: unknown) => {
    if (h.eio.some((x) => String(p).startsWith(x)))
      throw Object.assign(new Error(`EIO: i/o error, stat '${String(p)}'`), { code: 'EIO' })
    return real.stat(p, o as never)
  }) as typeof real.stat
  return { ...real, default: { ...real, stat }, stat }
})
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
  return { db, resolveDb: () => db }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
// The source's own storage: an empty folder, so every object comes from the fallback folder.
vi.mock('../../../services/storage/index.js', async () => {
  const { LocalStorage } = await import('../../../services/storage/local.js')
  const s = Object.create(LocalStorage.prototype) as InstanceType<typeof LocalStorage>
  ;(s as unknown as { resolveKey: (k: string) => string }).resolveKey = (k: string) =>
    join(h.own, k)
  return { getStorage: () => s, getStorageProviderName: () => 'local' }
})
vi.mock('../../../services/storage-drivers.js', () => ({
  getActiveStorageDriver: async () => ({ name: 'local' }),
  readOwnStoredObject: async () => {
    throw new Error('not used')
  }
}))
vi.mock('../../../services/storage/fallback-url.js', () => ({
  openFallbackUrl: async () => null,
  peekFallbackUrl: async () => null
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/543_hub_promotions.js'),
  await import('../../../db/migrations/544_hub_databases.js'),
  await import('../../../db/migrations/545_hub_creations.js'),
  await import('../../../db/migrations/546_hub_stack_settings.js'),
  await import('../../../db/migrations/550_hub_oidc.js'),
  await import('../../../db/migrations/551_hub_signins.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js'),
  await import('../../../db/migrations/553_hub_moves.js')
]
const Run = await import('../../../services/hub/move/run.js')
const { readMove } = await import('../../../services/hub/move/rows.js')
const { MOVE_STEPS } = await import('../../../services/hub/move/plan.js')
const { memoryPromoteLock, sharedLock } = await import('../../../services/hub/promote-lock.js')
const { hubTransferRoutes } = await import('../../../routes/hub-transfer.js')
const Pull = await import('../../../services/hub-transfer/pull.js')
const Tickets = await import('../../../services/hub-transfer/tickets.js')
type MovePlan = import('../../../services/hub/move/types.js').MovePlan
type MoveOps = import('../../../services/hub/move/ops.js').MoveOps
type PullStatus = import('../../../services/hub-transfer/pull.js').PullStatus

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const HUB_KEY = 'e'.repeat(64)
const START = Date.parse('2026-11-22T10:00:00Z')
const saved = { ...process.env }

// ─── an in-memory Redis with the commands tickets and the pull use ─────────────────────────

class FakeRedis {
  kv = new Map<string, string>()
  sets = new Map<string, Set<string>>()
  async get(k: string) {
    return this.kv.get(k) ?? null
  }
  async set(k: string, v: string, ...args: unknown[]) {
    if (args.includes('NX') && this.kv.has(k)) return null
    if (args.includes('XX') && !this.kv.has(k)) return null
    this.kv.set(k, v)
    return 'OK'
  }
  async del(...keys: string[]) {
    let n = 0
    for (const k of keys) if (this.kv.delete(k) || this.sets.delete(k)) n++
    return n
  }
  async pexpire() {
    return 1
  }
  async sadd(k: string, ...m: string[]) {
    const s = this.sets.get(k) ?? new Set<string>()
    for (const x of m) s.add(x)
    this.sets.set(k, s)
    return m.length
  }
  async smembers(k: string) {
    return [...(this.sets.get(k) ?? [])]
  }
}

// ─── the files ─────────────────────────────────────────────────────────────────────────────

const ID = {
  ok: '10000000-0000-4000-8000-000000000001',
  fileLocked: '10000000-0000-4000-8000-000000000002',
  dirLocked: '10000000-0000-4000-8000-000000000003',
  eio: '10000000-0000-4000-8000-000000000004'
}
const KEY: Record<keyof typeof ID, string> = {
  ok: 'ok/a.bin',
  fileLocked: 'ok/b.bin',
  dirLocked: 'locked/c.bin',
  eio: 'eio-mount/d.bin'
}
const BYTES: Record<keyof typeof ID, string> = {
  ok: 'bytes of a',
  fileLocked: 'bytes of b!',
  dirLocked: 'bytes of c!!',
  eio: 'bytes of d!!!'
}

let base = ''
let fallback = ''
let target = ''
let tmp = ''
let redis: FakeRedis
let server: FastifyInstance
let SOURCE = ''
const sourceLog: string[] = []

/** The fallback folder as it is on a good day: every object readable. */
function writeFallback() {
  for (const k of Object.keys(ID) as Array<keyof typeof ID>) {
    mkdirSync(dirname(join(fallback, KEY[k])), { recursive: true })
    writeFileSync(join(fallback, KEY[k]), BYTES[k])
  }
}

/** What goes wrong on the bad day. */
function breakFallback() {
  chmodSync(join(fallback, KEY.fileLocked), 0o000) // stat works, open is EACCES
  chmodSync(join(fallback, 'locked'), 0o000) // stat is EACCES
  h.eio = [join(fallback, 'eio-mount')] // stat is EIO
}

function fixFallback() {
  if (existsSync(join(fallback, 'locked'))) chmodSync(join(fallback, 'locked'), 0o755)
  if (existsSync(join(fallback, KEY.fileLocked))) chmodSync(join(fallback, KEY.fileLocked), 0o644)
  h.eio = []
}

/** The target's storage: a plain folder. */
const targetStorage = {
  async size(k: string) {
    try {
      return (await statFile(join(target, k))).size
    } catch {
      return null
    }
  },
  async putFile(k: string, from: string) {
    await mkdir(dirname(join(target, k)), { recursive: true })
    await writeFile(join(target, k), await readFile(from))
    return (await statFile(join(target, k))).size
  }
}

async function finished(runId: string): Promise<PullStatus> {
  for (let i = 0; i < 1000; i++) {
    const s = Pull.pullStatus(runId)
    if (s && s.state !== 'running') return s
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('the pull did not finish')
}

/** One pull as the target runs it, against the real source route. */
async function pullOnce(mode: 'full' | 'delta'): Promise<PullStatus> {
  const { ticket } = await Tickets.mintTransferTicket(null)
  const { run_id } = await Pull.startPull({ source: SOURCE, ticket, mode })
  return finished(run_id)
}

// ─── the move (fake ops apart from the file copy) ──────────────────────────────────────────

let t = START
const now = () => t
const sleep = vi.fn(async (ms: number) => {
  t += ms
  await new Promise((r) => setImmediate(r))
})

let seq = 0
async function insertId(table: string, row: Record<string, unknown>): Promise<number> {
  const [r] = await db(table).insert(row).returning('id')
  return Number(typeof r === 'object' ? (r as { id: number }).id : r)
}

async function world() {
  const n = ++seq
  const sharedA = await insertId('nivaro_hub_shared_deployments', {
    key: `shared-a${n}`,
    name: 'A',
    mode: 'docker',
    link_url: 'https://a.internal.example.com',
    status: 'active',
    version_pin: '0.3.210'
  })
  const driver = await insertId('nivaro_hub_drivers', {
    kind: 'docker',
    name: `agent${n}`,
    config: JSON.stringify({ agent_url: 'https://agent.example.com' })
  })
  const dockerPlacement = await insertId('nivaro_hub_placements', {
    kind: 'dedicated',
    driver_id: driver,
    target: JSON.stringify({ stack: `acme-prod${n}` })
  })
  const appKey = `acme${n}`
  const appId = await insertId('nivaro_hub_apps', { key: appKey, name: 'Acme' })
  const envId = await insertId('nivaro_hub_environments', {
    app_id: appId,
    key: 'prod',
    status: 'active',
    base_url: `https://acme${n}.apps.example.com`,
    hostnames: '[]',
    placement_id: dockerPlacement,
    version_pin: '0.3.210'
  })
  const { setAppKey } = await import('../../../services/hub/shared/store.js')
  await setAppKey(envId, 'ab'.repeat(32))
  return { envId, appKey, sharedA, dockerPlacement }
}

const plan: MovePlan = {
  kind: 'to_shared',
  routing: 'automatic',
  steps: [...MOVE_STEPS.to_shared],
  route: [
    { side: 'source', op: 'drop_host', host: 'acme.example.com' },
    { side: 'target', op: 'add_host', host: 'acme.example.com' }
  ],
  manual_request: null,
  version: '0.3.210',
  hostnames: ['acme.example.com'],
  files: { count: 4, bytes: 46, first_pull: 'full' },
  blockers: [],
  warnings: [],
  checklist: [],
  plan_hash: 'a'.repeat(64)
}

function moveOps() {
  const calls: string[] = []
  const rec =
    <A extends unknown[], R>(name: string, out: (...a: A) => R) =>
    async (...a: A): Promise<Awaited<R>> => {
      calls.push(name)
      return (await out(...a)) as Awaited<R>
    }
  const ops: MoveOps = {
    sourceMaintenance: rec('sourceMaintenance', () => undefined),
    targetMaintenance: rec('targetMaintenance', () => undefined),
    sourceBusy: rec('sourceBusy', () => ({ imports: 0, exports: 0, renders: 0 })),
    // The real copy: the target pulls from the source's transfer route.
    pullFiles: rec('pullFiles', (mode: 'full' | 'delta') => pullOnce(mode)),
    placeOnTarget: rec('placeOnTarget', () => undefined),
    unplace: rec('unplace', () => undefined),
    waitReplicas: rec('waitReplicas', () => undefined),
    targetUnretire: rec('targetUnretire', () => undefined),
    targetReady: rec('targetReady', () => undefined),
    freezeTarget: rec('freezeTarget', () => undefined),
    deployTarget: rec('deployTarget', () => undefined),
    removeTarget: rec('removeTarget', () => undefined),
    route: rec('route', () => undefined),
    unroute: rec('unroute', () => undefined),
    verifyName: rec('verifyName', () => true),
    retireSource: rec('retireSource', () => undefined),
    verifyTargetKey: rec('verifyTargetKey', () => undefined),
    dropTempHost: rec('dropTempHost', () => null as string | null),
    revokeTickets: rec('revokeTickets', () => undefined),
    databaseIdentity: rec('databaseIdentity', () => 'pg|db.internal|5432|acme')
  }
  return { ops, calls }
}

const runLines: string[] = []
function useDeps(ops: MoveOps) {
  Run.setMoveRunDeps({
    ops: () => ops,
    planner: async () => plan,
    lock: memoryPromoteLock,
    sharedLock: sharedLock(null),
    now,
    sleep,
    startJobRun: async () => ({
      id: 77,
      progress: () => undefined,
      log: (l: string) => void runLines.push(l),
      complete: async () => undefined,
      fail: async () => undefined
    }),
    addresses: async () => ({
      source_link_base: 'https://src.direct.example.com',
      source_link_public: false,
      pull_source: SOURCE,
      target_link_base: null,
      target_publish_host: null,
      target_temp_host: null
    }),
    renewMs: 3_600_000,
    pollMs: 5_000,
    manualPollMs: 60 * 60_000
  } as never)
}

async function startMove(w: Awaited<ReturnType<typeof world>>) {
  const { move_id } = await Run.startMove(
    w.envId,
    {
      to: { kind: 'shared', shared_id: w.sharedA },
      plan_hash: plan.plan_hash,
      confirm: `${w.appKey}/prod`,
      checklist: {}
    } as never,
    'AAAAAAAA-0000-4000-8000-000000000001'
  )
  await Run.awaitMove(move_id)
  return move_id
}

// ─── setup ─────────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = HUB_KEY
  delete process.env.CLOUD_META_DB_URL
  delete process.env.HUB_SHARED_DEPLOYMENT
  process.env.HUB_TOKEN = 'h'.repeat(40)
  for (const m of migrations) await m.up(db)
  await db.schema.createTable('nivaro_files', (tb) => {
    tb.uuid('id').primary()
    tb.string('filename_disk')
    tb.string('storage')
    tb.integer('filesize')
    tb.string('type')
    tb.timestamp('uploaded_on')
    tb.timestamp('modified_on')
  })
  for (const k of Object.keys(ID) as Array<keyof typeof ID>)
    await db('nivaro_files').insert({
      id: ID[k],
      filename_disk: KEY[k],
      storage: 'local',
      filesize: BYTES[k].length,
      type: 'application/octet-stream',
      uploaded_on: new Date('2026-11-01T00:00:00Z')
    })

  base = mkdtempSync(join(tmpdir(), 'nvr-hub-fallback-'))
  h.own = join(base, 'own')
  fallback = join(base, 'fallback')
  mkdirSync(h.own)
  mkdirSync(fallback)

  server = Fastify({
    logger: { level: 'info', stream: { write: (l: string) => void sourceLog.push(l) } }
  })
  await server.register(
    async (f) => {
      await f.register(hubTransferRoutes, { prefix: '/hub-transfer' })
    },
    { prefix: '/api' }
  )
  await server.listen({ port: 0, host: '127.0.0.1' })
  const a = server.server.address()
  SOURCE = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/api/hub-transfer/files`
})

afterAll(async () => {
  Run.setMoveRunDeps(null)
  await server?.close()
  fixFallback()
  rmSync(base, { recursive: true, force: true })
  process.env = { ...saved }
  await db.destroy()
})

beforeEach(() => {
  process.env.FILES_FALLBACK_DIR = fallback
  fixFallback()
  rmSync(fallback, { recursive: true, force: true })
  mkdirSync(fallback)
  writeFallback()
  h.eio = []
  target = mkdtempSync(join(base, 'target-'))
  tmp = mkdtempSync(join(base, 'tmp-'))
  redis = new FakeRedis()
  sourceLog.length = 0
  runLines.length = 0
  t = START
  Pull.resetPullsForTests()
  Tickets.ticketDeps.redis = () => redis as never
  Tickets.ticketDeps.now = () => Date.now()
  Pull.pullDeps.redis = () => redis as never
  Pull.pullDeps.storage = () => targetStorage as never
  Pull.pullDeps.tmpDir = () => tmp
  Pull.pullDeps.fetch = (url, init) => fetch(url, init)
  Pull.pullDeps.safeFetch = () => Promise.reject(new Error('not expected'))
  Pull.pullDeps.log = () => undefined
  Pull.pullDeps.limits = { ...Pull.pullDeps.defaultLimits }
})

const targetHas = (k: keyof typeof ID) => existsSync(join(target, KEY[k]))

// ─── the copy itself ───────────────────────────────────────────────────────────────────────

describe.skipIf(isRoot)('the copy with an unreadable fallback folder', () => {
  it('every kind of unreadable object fails its row (never "missing"), with a plain reason', async () => {
    breakFallback()
    const s = await pullOnce('full')
    expect(s.state).toBe('done')
    expect(s.copied).toBe(1)
    expect(s.missing).toEqual([])
    expect(s.failed).toBe(3)
    expect([...(s.failed_ids ?? [])].sort()).toEqual([ID.fileLocked, ID.dirLocked, ID.eio].sort())
    // A plain reason per failure kind, counted.
    expect(s.failed_reasons).toEqual({ source_read_failed: 3 })
    // Nothing that failed is on the target, half-written or whole.
    expect(targetHas('ok')).toBe(true)
    expect(targetHas('fileLocked')).toBe(false)
    expect(targetHas('dirLocked')).toBe(false)
    expect(targetHas('eio')).toBe(false)
    // The source logged no path and no error text (name and status only).
    expect(sourceLog.join('\n')).not.toContain(fallback)
  })

  it('a fallback folder that is gone (ENOENT: the mount is missing) fails every row, never "missing"', async () => {
    process.env.FILES_FALLBACK_DIR = join(base, 'not-mounted')
    const s = await pullOnce('full')
    expect(s.missing).toEqual([])
    expect(s.copied).toBe(0)
    expect(s.failed).toBe(4)
    expect(s.failed_reasons).toEqual({ source_read_failed: 4 })
  })

  it('a key that is really not in a readable folder is still "missing" (404)', async () => {
    rmSync(join(fallback, KEY.ok))
    const s = await pullOnce('full')
    expect(s.missing).toEqual([ID.ok])
    expect(s.failed).toBe(0)
  })
})

// ─── the move ──────────────────────────────────────────────────────────────────────────────

describe.skipIf(isRoot)('a move whose source fallback folder is unreadable', () => {
  it('rolls back with the files named and the reason; a retry after the fix completes', async () => {
    const w = await world()
    breakFallback()
    const first = moveOps()
    useDeps(first.ops)
    const id1 = await startMove(w)
    const m1 = await readMove(id1)
    expect(m1?.status).toBe('rolled_back')
    expect(m1?.error).toMatch(/^FILES_NOT_COPIED/)
    for (const k of ['fileLocked', 'dirLocked', 'eio'] as const) expect(m1?.error).toContain(ID[k])
    expect(m1?.error).toContain(': the source could not read 3; the move rolls back')
    expect(m1?.files.delta?.failed_reasons).toEqual({ source_read_failed: 3 })
    // Never released, never retired: the environment is still on its source.
    expect(first.calls).not.toContain('retireSource')
    const env1 = await db('nivaro_hub_environments').where({ id: w.envId }).first()
    expect(Number(env1.placement_id)).toBe(w.dockerPlacement)
    expect(env1.status).toBe('active')
    // The warm copy and the delta both counted the failures; neither called them missing.
    expect(m1?.files.warm?.failed).toBe(3)
    expect(m1?.files.delta?.failed).toBe(3)
    expect(m1?.files.delta?.missing).toBe(0)
    // Nothing that failed was stored on the target.
    expect(targetHas('fileLocked') || targetHas('dirLocked') || targetHas('eio')).toBe(false)
    // No path of the source's disk and no ticket in the move's record or its log.
    const record = JSON.stringify(m1) + runLines.join('\n')
    expect(record).not.toContain(base)
    expect(record).not.toMatch(/nvt_/)

    // The folder is fixed: a new move copies every file and completes.
    fixFallback()
    const second = moveOps()
    useDeps(second.ops)
    const id2 = await startMove(w)
    const m2 = await readMove(id2)
    expect(m2?.status).toBe('success')
    expect(m2?.error).toBeNull()
    for (const k of Object.keys(ID) as Array<keyof typeof ID>) {
      expect(targetHas(k)).toBe(true)
      expect(await readFile(join(target, KEY[k]), 'utf8')).toBe(BYTES[k])
    }
    expect(second.calls).toContain('retireSource')
  })

  it('a fallback that breaks only after the warm copy still stops the move inside maintenance', async () => {
    const w = await world()
    const ops = moveOps()
    // Readable for the warm copy; the mount goes bad before the delta.
    const pull = ops.ops.pullFiles
    ops.ops.pullFiles = async (mode) => {
      if (mode === 'delta') {
        process.env.FILES_FALLBACK_DIR = join(base, 'not-mounted')
        // A file changed since the warm copy: the delta must read it again.
        await db('nivaro_files')
          .where({ id: ID.ok })
          .update({ modified_on: new Date(Date.now() + 60_000) })
      }
      return pull(mode)
    }
    useDeps(ops.ops)
    const id = await startMove(w)
    const m = await readMove(id)
    expect(m?.status).toBe('rolled_back')
    expect(m?.error).toMatch(/^FILES_NOT_COPIED/)
    expect(m?.error).toContain(ID.ok)
    expect(m?.files.warm?.copied).toBe(4)
  })
})
