import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Export hand-off (2026-11-18): a background export started on a web process becomes a
// serializable job the import worker runs — reading the person again, as the starter would —
// with progress, Cancel, the private file and "Your export is ready" working from there.

const state = vi.hoisted(() => ({
  uploads: [] as Array<{ user: string; text: string; name: string; private: boolean }>,
  notices: [] as Array<{ user: string; subject: unknown }>,
  tray: [] as Array<{ user: string; ev: Record<string, unknown> }>,
  runs: new Map<number, Record<string, unknown>>(),
  nextRun: 1,
  users: new Map<string, Record<string, unknown>>(),
  roles: new Map<string, Record<string, unknown>>(),
  reads: [] as Array<{ user: string; offset: number; conditions?: string }>
}))

vi.mock('../../../middleware/authenticate.js', () => {
  const auth = async (req: any, reply: any) => {
    const id = req.headers['x-user']
    if (!id) return reply.code(401).send({ error: 'Unauthorized' })
    req.user = { id, role: 'r-approver' }
    req.isAdmin = false
  }
  return { authenticate: vi.fn(auth), requireAuth: vi.fn(auth) }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/live-progress.js', () => ({
  emitJobProgress: vi.fn((user: string, ev: Record<string, unknown>) =>
    state.tray.push({ user, ev })
  )
}))
vi.mock('../../../services/job-runs.js', () => {
  const handle = (id: number) => {
    const row = state.runs.get(id)!
    return {
      id,
      progress: (p: Record<string, unknown>) => {
        row.progress = JSON.stringify(p)
      },
      log: () => {},
      complete: async (outcome: string) => {
        row.status = 'completed'
        row.outcome = outcome
      },
      fail: async (err: unknown) => {
        row.status = 'error'
        row.error = err instanceof Error ? err.message : String(err)
      }
    }
  }
  return {
    startJobRun: vi.fn(async (kind: string, jobId: string, opts: { triggeredBy: string }) => {
      const id = state.nextRun++
      state.runs.set(id, {
        id,
        kind,
        job_id: jobId,
        status: 'running',
        triggered_by: opts.triggeredBy,
        outcome: null
      })
      return handle(id)
    }),
    // The drainer's handle for a run another process started.
    resumeJobRun: vi.fn((id: number) => handle(id))
  }
})
vi.mock('../../../services/files.js', () => ({
  uploadFileFromPath: vi.fn(
    async (
      user: { id: string },
      path: string,
      name: string,
      _t: string,
      _f: unknown,
      o: { private?: boolean }
    ) => {
      const { readFile } = await import('node:fs/promises')
      state.uploads.push({
        user: user.id,
        text: await readFile(path, 'utf8'),
        name,
        private: !!o?.private
      })
      return { id: `f0000000-0000-0000-0000-00000000000${state.uploads.length}` }
    }
  )
}))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(async (_a: unknown, user: string, opts: { subject: unknown }) => {
    state.notices.push({ user, subject: opts.subject })
    return { id: 1 }
  })
}))
vi.mock('../../../services/mail-builders.js', () => ({ buildExportReadyMail: async () => null }))

// 2,500 rows; Paul's User Scope sees the even ones.
const ROWS = Array.from({ length: 2500 }, (_, i) => ({
  id: i + 1,
  title: `Row ${i + 1}`,
  status: i % 3 === 0 ? 'closed' : 'open',
  region: (i + 1) % 2 === 0 ? 'east' : 'west'
}))
vi.mock('../../../services/items.js', () => ({
  LIST_READ_MAX: 1000,
  readItems: vi.fn(
    async (
      user: { id: string },
      _c: string,
      q: { fields?: string[]; limit?: number; offset?: number; count?: boolean },
      req?: { query?: { conditions?: string } }
    ) => {
      const offset = q.offset ?? 0
      state.reads.push({ user: user.id, offset, conditions: req?.query?.conditions })
      let rows = ROWS.filter((r) => user.id !== 'u-paul' || r.region === 'east')
      const cond = req?.query?.conditions ? JSON.parse(req.query.conditions) : []
      for (const c of cond as Array<{ field: string; value: unknown }>)
        rows = rows.filter((r) => (r as Record<string, unknown>)[c.field] === c.value)
      const fields = q.fields ?? ['*']
      const page = rows
        .slice(offset, offset + Math.min(q.limit ?? 25, 1000))
        .map((r) => Object.fromEntries(fields.map((f) => [f, (r as Record<string, unknown>)[f]])))
      return { data: page, total: q.count === false ? null : rows.length }
    }
  )
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((t: string) => {
    const c: Record<string, any> = {}
    let where: Record<string, unknown> = {}
    for (const m of ['orderBy', 'select']) c[m] = vi.fn(() => c)
    c.where = vi.fn((k: unknown, v?: unknown) => {
      where = typeof k === 'object' ? (k as Record<string, unknown>) : { [String(k)]: v }
      return c
    })
    c.first = vi.fn(async () => {
      if (t === 'nivaro_export_presets')
        return {
          collection: 'workflows',
          name: 'Open work',
          is_shared: 1,
          created_by: 'u-admin',
          config: JSON.stringify({
            format: 'csv',
            columns: [{ key: 'id' }, { key: 'title', label: 'Title' }, { key: 'status' }]
          })
        }
      if (t === 'nivaro_job_runs') return state.runs.get(Number(where.id))
      if (t === 'nivaro_users') {
        const u = state.users.get(String(where.id))
        return u && u.status === where.status ? { ...u } : undefined
      }
      if (t === 'nivaro_roles') return state.roles.get(String(where.id))
      return undefined
    })
    c.update = vi.fn(async (patch: Record<string, unknown>) => {
      const row = t === 'nivaro_job_runs' ? state.runs.get(Number(where.id)) : undefined
      if (!row || (where.status && row.status !== where.status)) return 0
      Object.assign(row, patch)
      return 1
    })
    return c
  })
}))

/** Enough of ioredis for the hand-off, the run slots and the cancel flag. */
class FakeRedis {
  strings = new Map<string, string>()
  lists = new Map<string, string[]>()
  hashes = new Map<string, Map<string, string>>()
  published: Array<[string, string]> = []
  async get(k: string) {
    return this.strings.get(k) ?? null
  }
  async set(k: string, v: string, ...args: unknown[]) {
    if (args.includes('NX') && this.strings.has(k)) return null
    this.strings.set(k, v)
    return 'OK'
  }
  async setex(k: string, _s: number, v: string) {
    this.strings.set(k, v)
    return 'OK'
  }
  async del(k: string) {
    return this.strings.delete(k) ? 1 : 0
  }
  async eval(_script: string, _n: number, key: string, owner: string) {
    if (this.strings.get(key) === owner) return this.del(key)
    return 0
  }
  async rpush(k: string, v: string) {
    const l = this.lists.get(k) ?? []
    l.push(v)
    this.lists.set(k, l)
    return l.length
  }
  async lpop(k: string) {
    return this.lists.get(k)?.shift() ?? null
  }
  async lrange(k: string, a: number, b: number) {
    const l = this.lists.get(k) ?? []
    return l.slice(a, b < 0 ? undefined : b + 1)
  }
  async lrem(k: string, _n: number, v: string) {
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
    const h = this.hashes.get(k) ?? new Map()
    h.set(f, v)
    this.hashes.set(k, h)
    return 1
  }
  async hget(k: string, f: string) {
    return this.hashes.get(k)?.get(f) ?? null
  }
  async hgetall(k: string) {
    return Object.fromEntries(this.hashes.get(k) ?? new Map())
  }
  async hdel(k: string, f: string) {
    return this.hashes.get(k)?.delete(f) ? 1 : 0
  }
}

import { exportPresetRoutes } from '../../../routes/export-presets.js'
import { exportRunsRoutes } from '../../../routes/export-runs.js'
import { __resetBackgroundRuns } from '../../../services/background-runs.js'
import {
  beatExportWorker,
  claimExport,
  exportClaimedKey,
  exportDrainMode,
  exportHandoffEnabled,
  exportPlacement,
  exportQueueKey,
  LOST_EXPORT_NOTE,
  parseExportJob,
  queuedExportEntry
} from '../../../services/export-handoff.js'
import { drainExportsTick } from '../../../services/export-worker.js'

const ENV_KEYS = [
  'NIVARO_ROLE',
  'EXPORT_HANDOFF',
  'CLOUD_META_DB_URL',
  'IMPORT_WORKER',
  'CRON_TICKS'
]
const saved: Record<string, string | undefined> = {}
let redis: FakeRedis
let web: FastifyInstance
let work: string
const OPEN = JSON.stringify([{ field: 'status', op: 'eq', value: 'open' }])
const paul = { 'x-user': 'u-paul' }

/** A process seen as the import worker (NIVARO_ROLE=importer) for the duration of `fn`. */
async function asImporter<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env.NIVARO_ROLE
  process.env.NIVARO_ROLE = 'importer'
  try {
    return await fn()
  } finally {
    process.env.NIVARO_ROLE = before
  }
}
const importerApp = () =>
  ({ redis, log: { info() {}, warn() {}, error() {} } }) as unknown as FastifyInstance

async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
  // This test process is a web process: it never drains exports itself.
  process.env.NIVARO_ROLE = 'web'
  work = await mkdtemp(join(tmpdir(), 'nvr-export-handoff-'))
  process.env.EXPORT_WORK_DIR = work
  state.uploads.length = 0
  state.notices.length = 0
  state.tray.length = 0
  state.reads.length = 0
  state.runs.clear()
  state.users.clear()
  state.roles.clear()
  state.users.set('u-paul', { id: 'u-paul', status: 'active', role: 'r-approver' })
  state.roles.set('r-approver', { id: 'r-approver', admin_access: false, app_access: true })
  __resetBackgroundRuns()
  redis = new FakeRedis()
  web = Fastify({ logger: false })
  web.decorate('redis', redis as never)
  await web.register(exportPresetRoutes, { prefix: '/export-presets' })
  await web.register(exportRunsRoutes, { prefix: '/export-runs' })
})
afterEach(async () => {
  await web.close()
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  delete process.env.EXPORT_WORK_DIR
  vi.useRealTimers()
})

async function beatImporter() {
  await beatExportWorker(redis as never, {
    role: 'importer',
    instance: 'imp-1',
    name: 'efp_importer',
    version: 'test',
    at: new Date().toISOString()
  })
}

async function startBackground() {
  const res = await web.inject({
    method: 'POST',
    url: '/export-presets/5/run-async',
    headers: paul,
    payload: { conditions: OPEN, background: 'always' }
  })
  expect(res.statusCode).toBe(202)
  return res.json().data as { run_id: number; key: string; cancel_path: string }
}

describe('who drains, where an export runs', () => {
  it('the importer drains; web never; EXPORT_HANDOFF=off and cloud mode turn it off', () => {
    expect(exportDrainMode({ NIVARO_ROLE: 'importer' })).toBe('importer')
    expect(exportDrainMode({ NIVARO_ROLE: 'web' })).toBe('off')
    expect(exportDrainMode({ NIVARO_ROLE: 'importer', EXPORT_HANDOFF: 'off' })).toBe('off')
    expect(exportHandoffEnabled({ CLOUD_META_DB_URL: 'x' })).toBe(false)
    expect(exportDrainMode({ NIVARO_ROLE: 'importer', CLOUD_META_DB_URL: 'x' })).toBe('off')
  })

  it('hands off only while a drainer beats', async () => {
    expect(await exportPlacement(redis as never)).toBe('here')
    await beatImporter()
    expect(await exportPlacement(redis as never)).toBe('handoff')
    process.env.EXPORT_HANDOFF = 'off'
    expect(await exportPlacement(redis as never)).toBe('here')
  })
})

describe('a handed-off export', () => {
  it('is a serializable job the importer runs as the person: same file, tray, notice', async () => {
    const sync = await web.inject({
      method: 'GET',
      url: `/export-presets/5/run?conditions=${encodeURIComponent(OPEN)}`,
      headers: paul
    })
    state.reads.length = 0
    await beatImporter()
    const data = await startBackground()

    // Nothing ran on the web process: the job waits on the list, serializable.
    const listed = await queuedExportEntry(redis as never, data.run_id)
    expect(listed).not.toBeNull()
    expect(parseExportJob(listed!.raw)).toMatchObject({
      kind: 'preset',
      subject: '5',
      user_id: 'u-paul',
      params: { filters: { conditions: OPEN } }
    })
    // Only the start's count ran here (limit 1); no page of the export.
    expect(state.reads).toHaveLength(1)
    expect(redis.published.some(([, m]) => m === String(data.run_id))).toBe(true)
    expect(JSON.parse(String(state.runs.get(data.run_id)!.progress)).phase).toBe(
      'Waiting for the export worker'
    )

    await asImporter(() => drainExportsTick(importerApp()))
    await until(() => state.runs.get(data.run_id)!.status !== 'running')

    expect(state.runs.get(data.run_id)!.status).toBe('completed')
    expect(state.uploads).toHaveLength(1)
    expect(state.uploads[0]).toMatchObject({ user: 'u-paul', private: true, name: 'Open work.csv' })
    expect(state.uploads[0].text).toBe(sync.body)
    // Every read ran as Paul, with the filters captured when he started it.
    expect(new Set(state.reads.map((r) => r.user))).toEqual(new Set(['u-paul']))
    expect(new Set(state.reads.map((r) => r.conditions))).toEqual(new Set([OPEN]))
    expect(state.notices).toEqual([{ user: 'u-paul', subject: 'Your export is ready' }])
    expect(String(state.runs.get(data.run_id)!.outcome)).toMatch(/→ file f0000000-/)
    // The claim is gone, the list is empty, no temp file is left.
    await until(() => (redis.hashes.get(exportClaimedKey())?.size ?? 0) === 0)
    expect(redis.lists.get(exportQueueKey())).toEqual([])
    expect(await readdir(work)).toEqual([])
  })

  it('a person who can no longer sign in gets no file', async () => {
    await beatImporter()
    const data = await startBackground()
    state.users.get('u-paul')!.status = 'suspended'
    await asImporter(() => drainExportsTick(importerApp()))
    await until(() => state.runs.get(data.run_id)!.status !== 'running')
    expect(state.runs.get(data.run_id)!.status).toBe('error')
    expect(String(state.runs.get(data.run_id)!.error)).toMatch(/can no longer sign in/)
    expect(state.uploads).toHaveLength(0)
    expect(state.reads).toHaveLength(1) // the start's count only
  })

  it('Cancel while it waits takes it off the list and closes it at once', async () => {
    await beatImporter()
    const data = await startBackground()
    const res = await web.inject({
      method: 'POST',
      url: `/export-runs/${data.run_id}/cancel`,
      headers: paul
    })
    expect(res.json().data.outcome).toBe('stopped')
    expect(state.runs.get(data.run_id)).toMatchObject({ status: 'completed', outcome: 'Cancelled' })
    expect(state.tray.some((t) => t.ev.key === data.key && t.ev.status === 'canceled')).toBe(true)
    expect(redis.lists.get(exportQueueKey())).toEqual([])
    // The slot is free again: Paul may start the full five at once.
    for (let i = 0; i < 5; i++) await startBackground()
  })

  it('Cancel while the importer runs it reaches it through the Redis flag', async () => {
    await beatImporter()
    const data = await startBackground()
    // The flag is set before the importer picks the job up: it stops before reading a row.
    await redis.setex(`nvr:export-cancel:-:${data.run_id}`, 60, '1')
    const rows = state.reads.length
    await asImporter(() => drainExportsTick(importerApp()))
    await until(() => state.runs.get(data.run_id)!.status !== 'running')
    expect(state.runs.get(data.run_id)!.outcome).toBe('Cancelled')
    expect(state.reads.length).toBe(rows)
    expect(state.uploads).toHaveLength(0)
  })

  it('the starter takes it back and runs it itself once no drainer beats', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await beatImporter()
    const data = await startBackground()
    await vi.advanceTimersByTimeAsync(15_000)
    // The importer still beats: the job keeps waiting for it.
    expect(await queuedExportEntry(redis as never, data.run_id)).not.toBeNull()
    redis.strings.clear() // the importer's beat expired
    await vi.advanceTimersByTimeAsync(15_000)
    await until(() => state.runs.get(data.run_id)!.status !== 'running')
    expect(state.runs.get(data.run_id)!.status).toBe('completed')
    expect(state.uploads).toHaveLength(1)
    expect(await queuedExportEntry(redis as never, data.run_id)).toBeNull()
  })

  it('a claimed job whose drainer died fails with a sentence', async () => {
    await beatImporter()
    const data = await startBackground()
    const listed = await queuedExportEntry(redis as never, data.run_id)
    redis.lists.set(exportQueueKey(), [])
    await claimExport(redis as never, parseExportJob(listed!.raw)!, 'dead-process')
    // Its lease ran out.
    for (const k of [...redis.strings.keys()]) if (k.includes(':lease:')) redis.strings.delete(k)
    await asImporter(() => drainExportsTick(importerApp()))
    expect(state.runs.get(data.run_id)).toMatchObject({ status: 'error', error: LOST_EXPORT_NOTE })
    expect(
      state.tray.some(
        (t) => t.ev.key === data.key && t.ev.status === 'error' && t.ev.error === LOST_EXPORT_NOTE
      )
    ).toBe(true)
    expect(redis.hashes.get(exportClaimedKey())?.size ?? 0).toBe(0)
  })
})
