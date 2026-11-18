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
  reads: [] as Array<{ user: string; offset: number; conditions?: string }>,
  deleted: [] as string[],
  endRunOnUpload: null as Record<string, unknown> | null,
  resumeThrows: false,
  /** When set, the read at this position waits for `release()`. */
  holdAt: null as number | null,
  hold: null as Promise<void> | null,
  release: () => {}
}))

vi.mock('../../../middleware/authenticate.js', () => {
  const auth = async (req: any, reply: any) => {
    const id = req.headers['x-user']
    if (!id) return reply.code(401).send({ error: 'Unauthorized' })
    req.user = { id, role: 'r-approver' }
    req.isAdmin = false
    // A person's own browser session unless the test says it is an API key.
    req.authMethod = 'session'
    const restricted = req.headers['x-key-status']
    if (restricted) {
      req.authMethod = 'api_key'
      req.apiKeyId = 7
      req.user.api_key_scope_restrictions = [{ dimension: 'status', values: [restricted] }]
    }
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
  // Like the real handle with guardRunning: complete / fail write only while the row runs.
  const handle = (id: number) => {
    const row = state.runs.get(id)!
    let lost = false
    return {
      id,
      progress: (p: Record<string, unknown>) => {
        row.progress = JSON.stringify(p)
      },
      log: () => {},
      stillOurs: () => !lost,
      complete: async (outcome: string) => {
        if (row.status !== 'running') {
          lost = true
          return
        }
        row.status = 'completed'
        row.outcome = outcome
      },
      fail: async (err: unknown) => {
        if (row.status !== 'running') {
          lost = true
          return
        }
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
    resumeJobRun: vi.fn((id: number) => {
      if (state.resumeThrows) {
        state.resumeThrows = false
        throw new Error('handle could not be made')
      }
      return handle(id)
    })
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
      const id = `f0000000-0000-0000-0000-00000000000${state.uploads.length}`
      // Another process ends the run while the file uploads.
      if (state.endRunOnUpload)
        Object.assign(state.runs.values().next().value!, state.endRunOnUpload)
      return { id }
    }
  ),
  deleteFile: vi.fn(async (id: string) => {
    state.deleted.push(id)
  })
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
      q: { fields?: string[]; limit?: number; offset?: number; count?: boolean; filter?: any },
      req?: { query?: { conditions?: string } }
    ) => {
      let rows = ROWS.filter((r) => user.id !== 'u-paul' || r.region === 'east')
      // An API key's scope restriction rides the user object (authenticate) and narrows reads.
      for (const x of (user as { api_key_scope_restrictions?: any[] }).api_key_scope_restrictions ??
        [])
        rows = rows.filter((r) => x.values.includes((r as Record<string, unknown>)[x.dimension]))
      const cond = req?.query?.conditions ? JSON.parse(req.query.conditions) : []
      for (const c of cond as Array<{ field: string; value: unknown }>)
        rows = rows.filter((r) => (r as Record<string, unknown>)[c.field] === c.value)
      // Keyset reads (`id > last`) and OFFSET reads both start at a position in the result.
      const gt = (f: any): number | null =>
        f?.id?._gt != null
          ? Number(f.id._gt)
          : Array.isArray(f?._and)
            ? (f._and.map(gt).find((n: number | null) => n != null) ?? null)
            : null
      const after = gt(q.filter)
      const offset =
        (after == null ? 0 : rows.filter((r) => r.id <= after).length) + (q.offset ?? 0)
      state.reads.push({ user: user.id, offset, conditions: req?.query?.conditions })
      if (state.holdAt != null && offset === state.holdAt && state.hold) await state.hold
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
  evals: string[] = []
  ttls = new Map<string, number>()
  /** The scripts the code runs, by what they do. */
  async eval(script: string, _n: number, ...args: string[]) {
    this.evals.push(script)
    // The export scripts, as the Lua in services/export-handoff.ts runs them (the real-Redis
    // test, export-handoff-redis.it.test.ts, runs the scripts themselves).
    if (script.includes('nvr:export-claim')) {
      const [list, claimed, leases, lease] = args
      const raw = await this.lpop(list)
      if (raw == null) return null
      const id = /"run_id":(\d+)/.exec(raw)?.[1]
      let job: any = null
      try {
        job = JSON.parse(raw)
      } catch {
        job = null
      }
      if (
        !id ||
        !job ||
        job.v !== 1 ||
        typeof job.kind !== 'string' ||
        typeof job.user_id !== 'string' ||
        typeof job.params !== 'object'
      )
        return [raw, 'invalid']
      await this.hset(leases, id, lease)
      await this.hset(claimed, id, raw)
      return [raw, 'claimed']
    }
    if (script.includes('nvr:export-renew')) {
      const [leases, id, by, value] = args
      const v = this.hashes.get(leases)?.get(id)
      if (!v?.startsWith(`${by}|`)) return 0
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
    const [key, owner, ttl] = args
    if (this.strings.get(key) !== owner) return 0
    if (script.includes("'expire'")) {
      this.ttls.set(key, Number(ttl))
      return 1
    }
    return this.del(key)
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
  exportCancelKey,
  exportClaimedKey,
  exportDrainMode,
  exportHandoffEnabled,
  exportLeasesKey,
  exportPlacement,
  exportQueueKey,
  exportWorkerKey,
  INVALID_EXPORT_NOTE,
  LOST_EXPORT_NOTE,
  parseExportJob,
  queuedExportEntry,
  releaseExportClaim,
  shouldDrainExportsNow
} from '../../../services/export-handoff.js'
import { exportMayHandOff, SHUTDOWN_EXPORT_NOTE } from '../../../services/export-runs.js'
import {
  __exportRunsHere,
  __resetExportWorker,
  drainExportsTick,
  exportWorkerJudgement,
  stopExportDrainerRuns
} from '../../../services/export-worker.js'

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
  __resetExportWorker()
  state.holdAt = null
  state.hold = null
  state.deleted.length = 0
  state.endRunOnUpload = null
  state.resumeThrows = false
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

async function startBackground(payload: Record<string, unknown> = { conditions: OPEN }) {
  const res = await web.inject({
    method: 'POST',
    url: '/export-presets/5/run-async',
    headers: paul,
    payload: { ...payload, background: 'always' }
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
    expect(await filesUnder(work)).toEqual([])
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
    await redis.setex(exportCancelKey(data.run_id), 60, '1')
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
    redis.hashes.get(exportLeasesKey())!.set(String(data.run_id), 'dead-process|1')
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

// ── Fix round 1 ──────────────────────────────────────────────────────────────

describe('decision A: only a person’s own session is handed off', () => {
  const req = (o: Record<string, unknown>, user: Record<string, unknown> = { id: 'u' }) =>
    ({ user, ...o }) as never

  it('a session hands off; an API key, OAuth/MCP, run-as-key or View-as never', () => {
    expect(exportMayHandOff(req({ authMethod: 'session' }))).toBe(true)
    expect(exportMayHandOff(req({ authMethod: 'api_key', apiKeyId: 3 }))).toBe(false)
    expect(exportMayHandOff(req({ authMethod: 'oauth', oauthScopes: ['mcp'] }))).toBe(false)
    expect(exportMayHandOff(req({ authMethod: 'session', mcpInner: true }))).toBe(false)
    expect(exportMayHandOff(req({ authMethod: 'key_sim', apiKeySimulatedId: 4 }))).toBe(false)
    expect(exportMayHandOff(req({ authMethod: 'masquerade', masqueradeAdminId: 'a' }))).toBe(false)
    expect(exportMayHandOff(req({ authMethod: 'token' }))).toBe(false)
    // Narrowing that rides the user object keeps it here even on a session-shaped request.
    expect(
      exportMayHandOff(
        req(
          { authMethod: 'session' },
          { id: 'u', api_key_scope_restrictions: [{ dimension: 'x', values: [] }] }
        )
      )
    ).toBe(false)
  })

  it('a key with scope restrictions runs where it started, still narrowed', async () => {
    await beatImporter()
    const res = await web.inject({
      method: 'POST',
      url: '/export-presets/5/run-async',
      headers: { ...paul, 'x-key-status': 'open' },
      payload: { background: 'always' }
    })
    expect(res.statusCode).toBe(202)
    const { run_id } = res.json().data
    // Never put on the hand-off list, though the importer beats.
    expect(redis.lists.get(exportQueueKey()) ?? []).toEqual([])
    await until(() => state.runs.get(run_id)!.status !== 'running')
    expect(state.uploads).toHaveLength(1)
    const lines = state.uploads[0].text.replace(/^﻿/, '').split('\n')
    // Paul's rows (east) narrowed by the key to `open` ones only.
    const expected = ROWS.filter((r) => r.region === 'east' && r.status === 'open').length
    expect(lines).toHaveLength(expected + 1)
    expect(lines.slice(1).every((l) => l.endsWith(',open'))).toBe(true)
  })
})

describe('fix round 1: claims, leases, slots, shutdown', () => {
  const holdAt = (position: number) => {
    state.holdAt = position
    state.hold = new Promise<void>((r) => {
      state.release = r
    })
  }

  it('claims atomically: off the list, claimed with its lease, an unreadable entry dropped', async () => {
    await beatImporter()
    const data = await startBackground()
    redis.lists.get(exportQueueKey())!.unshift('not a job')
    holdAt(0)
    await asImporter(() => drainExportsTick(importerApp()))
    expect(redis.evals.some((e) => e.includes('nvr:export-claim'))).toBe(true)
    expect(redis.lists.get(exportQueueKey())).toEqual([])
    const claimed = redis.hashes.get(exportClaimedKey())!.get(String(data.run_id))!
    expect(parseExportJob(claimed)).toMatchObject({ run_id: data.run_id })
    expect(redis.hashes.get(exportLeasesKey())!.get(String(data.run_id))).toMatch(/\|\d+$/)
    state.release()
    await until(() => state.runs.get(data.run_id)!.status !== 'running')
  })

  it('a run ended elsewhere while it was being built stores nothing and keeps that outcome', async () => {
    await beatImporter()
    // Paul's 1,250 rows: a second page at position 1,000.
    const data = await startBackground({})
    holdAt(1000)
    await asImporter(() => drainExportsTick(importerApp()))
    await until(() => state.reads.some((r) => r.offset === 1000))
    // Another drainer judged the lease lost meanwhile.
    Object.assign(state.runs.get(data.run_id)!, { status: 'error', error: LOST_EXPORT_NOTE })
    state.release()
    await until(() => (redis.hashes.get(exportClaimedKey())?.size ?? 0) === 0)
    expect(state.runs.get(data.run_id)).toMatchObject({ status: 'error', error: LOST_EXPORT_NOTE })
    expect(state.uploads).toHaveLength(0)
    expect(state.notices).toHaveLength(0)
  })

  it('a renewal that finds the run ended stops the build at once', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await beatImporter()
    // Paul's 1,250 rows: a second page at position 1,000.
    const data = await startBackground({})
    holdAt(1000)
    await asImporter(() => drainExportsTick(importerApp()))
    await until(() => state.reads.some((r) => r.offset === 1000))
    Object.assign(state.runs.get(data.run_id)!, { status: 'error', error: LOST_EXPORT_NOTE })
    await vi.advanceTimersByTimeAsync(30_000)
    state.release()
    await until(() => (redis.hashes.get(exportClaimedKey())?.size ?? 0) === 0)
    // Stopped after the held page: no later page read, no "Cancelled" overwrite or tray noise.
    expect(state.reads.filter((r) => r.offset > 1000)).toHaveLength(0)
    expect(state.runs.get(data.run_id)!.error).toBe(LOST_EXPORT_NOTE)
    expect(state.tray.some((t) => t.ev.key === data.key && t.ev.status === 'canceled')).toBe(false)
  })

  it('a waiting job renews its per-person slot', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    await beatImporter()
    await startBackground()
    await vi.advanceTimersByTimeAsync(75_000)
    const renewed = [...redis.ttls.keys()].filter((k) => k.startsWith('nvr:bgrun:slot:'))
    expect(renewed).toHaveLength(1)
  })

  it('a job that waited six hours is taken off the list and its run failed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    await beatImporter()
    const data = await startBackground()
    // The importer keeps beating but never takes it.
    for (let i = 0; i < 26; i++) {
      await beatImporter()
      await vi.advanceTimersByTimeAsync(15 * 60_000)
    }
    expect(redis.lists.get(exportQueueKey())).toEqual([])
    expect(state.runs.get(data.run_id)).toMatchObject({ status: 'error' })
    expect(String(state.runs.get(data.run_id)!.error)).toMatch(/waited too long/)
  })

  it('stopping the importer puts back a job that wrote nothing (row and slot untouched)', async () => {
    await beatImporter()
    const data = await startBackground()
    holdAt(0)
    await asImporter(() => drainExportsTick(importerApp()))
    // The build's first page read (the start's count was the first read at 0).
    await until(() => state.reads.filter((r) => r.offset === 0).length >= 2)
    // Another drainer (an exporter) is there to take it.
    await beatExportWorker(redis as never, {
      role: 'exporter',
      instance: 'exp-2',
      name: 'efp_exporter',
      version: 'test',
      at: new Date().toISOString()
    })
    const stopping = stopExportDrainerRuns(importerApp())
    // Let the stop reach the run (it is held mid-read) before the read returns.
    await new Promise((r) => setTimeout(r, 20))
    state.release()
    await stopping
    expect(state.runs.get(data.run_id)!.status).toBe('running')
    expect((await queuedExportEntry(redis as never, data.run_id))?.job.run_id).toBe(data.run_id)
    expect([...redis.strings.keys()].some((k) => k.startsWith('nvr:bgrun:slot:'))).toBe(true)
    expect(state.uploads).toHaveLength(0)
  })

  it('stopping the only drainer fails even an untouched job (nobody would run it)', async () => {
    await beatImporter()
    const data = await startBackground()
    holdAt(0)
    await asImporter(() => drainExportsTick(importerApp()))
    await until(() => state.reads.filter((r) => r.offset === 0).length >= 2)
    const stopping = stopExportDrainerRuns(importerApp())
    // Let the stop reach the run (it is held mid-read) before the read returns.
    await new Promise((r) => setTimeout(r, 20))
    state.release()
    await stopping
    expect(state.runs.get(data.run_id)).toMatchObject({
      status: 'error',
      error: SHUTDOWN_EXPORT_NOTE
    })
    expect(await queuedExportEntry(redis as never, data.run_id)).toBeNull()
  })

  it('stopping the importer fails a job already under way at once, with a sentence', async () => {
    await beatImporter()
    // Paul's 1,250 rows: a second page at position 1,000.
    const data = await startBackground({})
    holdAt(1000)
    await asImporter(() => drainExportsTick(importerApp()))
    await until(() => state.reads.some((r) => r.offset === 1000))
    const stopping = stopExportDrainerRuns(importerApp())
    // Let the stop reach the run (it is held mid-read) before the read returns.
    await new Promise((r) => setTimeout(r, 20))
    state.release()
    await stopping
    expect(state.runs.get(data.run_id)).toMatchObject({
      status: 'error',
      error: SHUTDOWN_EXPORT_NOTE
    })
    expect(await queuedExportEntry(redis as never, data.run_id)).toBeNull()
  })

  it('the cancel flag carries the channel prefix and the database scope', () => {
    process.env.REDIS_CHANNEL_PREFIX = 'stg:'
    try {
      expect(exportCancelKey(9)).toMatch(/^stg:nvr:export-cancel:[^:]+:-:9$/)
    } finally {
      delete process.env.REDIS_CHANNEL_PREFIX
    }
  })
})

// ── Fix round 2 ──────────────────────────────────────────────────────────────

describe('fix round 2: hand-off', () => {
  const holdAt = (position: number) => {
    state.holdAt = position
    state.hold = new Promise<void>((r) => {
      state.release = r
    })
  }

  it('a late release never removes the claim of the drainer that took the job since', async () => {
    const job = {
      v: 1 as const,
      run_id: 77,
      kind: 'items' as const,
      subject: 'a',
      label: 'x',
      user_id: 'u-paul',
      workspace_id: null,
      params: {},
      total: null,
      slot: 0,
      slot_owner: 'o',
      started_at: Date.now()
    }
    await claimExport(redis as never, job, 'new-owner')
    expect(await releaseExportClaim(redis as never, 77, 'old-owner')).toBe(false)
    expect(redis.hashes.get(exportClaimedKey())!.has('77')).toBe(true)
    expect(redis.hashes.get(exportLeasesKey())!.get('77')).toMatch(/^new-owner\|/)
    expect(await releaseExportClaim(redis as never, 77, 'new-owner')).toBe(true)
    expect(redis.hashes.get(exportClaimedKey())!.has('77')).toBe(false)
  })

  it('an entry another version queued is not run: its run fails by id', async () => {
    state.runs.set(500, { id: 500, kind: 'export', job_id: 'bg-export:items:a', status: 'running' })
    redis.lists.set(exportQueueKey(), [JSON.stringify({ v: 2, run_id: 500, spec: {} })])
    await beatImporter()
    await asImporter(() => drainExportsTick(importerApp()))
    expect(state.runs.get(500)).toMatchObject({ status: 'error', error: INVALID_EXPORT_NOTE })
    expect(redis.hashes.get(exportClaimedKey())?.size ?? 0).toBe(0)
    expect(redis.lists.get(exportQueueKey())).toEqual([])
  })

  it('a waiting entry older than six hours is taken off and failed by the drainer', async () => {
    await beatImporter()
    const data = await startBackground()
    // Its starter is gone (no watcher): the entry has waited seven hours.
    const raw = redis.lists.get(exportQueueKey())![0]
    const old = { ...JSON.parse(raw), queued_at: Date.now() - 7 * 3_600_000 }
    redis.lists.set(exportQueueKey(), [JSON.stringify(old)])
    // Another drainer is busy elsewhere: this one only sweeps (no room to claim).
    process.env.EXPORT_WORKER_CONCURRENCY = '1'
    try {
      await asImporter(() => drainExportsTick(importerApp()))
    } finally {
      delete process.env.EXPORT_WORKER_CONCURRENCY
    }
    expect(redis.lists.get(exportQueueKey())).toEqual([])
    expect(state.runs.get(data.run_id)).toMatchObject({ status: 'error' })
    expect(String(state.runs.get(data.run_id)!.error)).toMatch(/waited too long/)
    expect(state.uploads).toHaveLength(0)
  })

  it('a run that cannot even start on the drainer fails instead of staying running', async () => {
    await beatImporter()
    const data = await startBackground()
    state.resumeThrows = true
    await asImporter(() => drainExportsTick(importerApp()))
    await until(() => state.runs.get(data.run_id)!.status !== 'running')
    expect(state.runs.get(data.run_id)).toMatchObject({ status: 'error' })
    expect(String(state.runs.get(data.run_id)!.error)).toMatch(/could not be started/)
    await until(() => (redis.hashes.get(exportClaimedKey())?.size ?? 0) === 0)
  })

  it('a file uploaded for a run ended elsewhere meanwhile is deleted again', async () => {
    await beatImporter()
    const data = await startBackground()
    state.endRunOnUpload = { status: 'error', error: LOST_EXPORT_NOTE }
    await asImporter(() => drainExportsTick(importerApp()))
    await until(() => state.deleted.length > 0)
    expect(state.deleted).toEqual(['f0000000-0000-0000-0000-000000000001'])
    expect(state.runs.get(data.run_id)).toMatchObject({ status: 'error', error: LOST_EXPORT_NOTE })
    expect(state.notices).toHaveLength(0)
  })

  it('a local run whose row was ended elsewhere stops renewing its slot and stops', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    // No drainer beats: the run is local.
    const data = await startBackground({})
    holdAt(1000)
    await until(() => state.reads.some((r) => r.offset === 1000))
    Object.assign(state.runs.get(data.run_id)!, { status: 'error', error: 'ended elsewhere' })
    redis.ttls.clear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect([...redis.ttls.keys()].filter((k) => k.startsWith('nvr:bgrun:slot:'))).toHaveLength(0)
    state.release()
    await until(() => !__exportRunsHere().length)
    await new Promise((r) => setTimeout(r, 20))
    expect(state.reads.filter((r) => r.offset > 1000)).toHaveLength(0)
    expect(state.uploads).toHaveLength(0)
  })
})

describe('the exporter process: who drains exports', () => {
  const env = (o: Record<string, string>) => ({ ...o }) as NodeJS.ProcessEnv
  const beat = (role: 'exporter' | 'importer' | 'fallback', instance: string) =>
    beatExportWorker(redis as never, {
      role,
      instance,
      name: null,
      version: 'test',
      at: new Date().toISOString()
    })

  it('modes: exporter, EXPORT_WORKER on/off, importer, worker, single process, web, cloud', () => {
    expect(exportDrainMode(env({ NIVARO_ROLE: 'exporter' }))).toBe('exporter')
    expect(exportDrainMode(env({ NIVARO_ROLE: 'web', EXPORT_WORKER: 'on' }))).toBe('enabled')
    expect(exportDrainMode(env({ NIVARO_ROLE: 'exporter', EXPORT_WORKER: 'off' }))).toBe('off')
    expect(exportDrainMode(env({ NIVARO_ROLE: 'importer' }))).toBe('importer')
    expect(exportDrainMode(env({ NIVARO_ROLE: 'web' }))).toBe('off')
    expect(exportDrainMode(env({ NIVARO_ROLE: 'realtime' }))).toBe('off')
    expect(exportDrainMode(env({ NIVARO_ROLE: 'canary' }))).toBe('off')
    expect(exportDrainMode(env({ NIVARO_ROLE: 'exporter', CLOUD_META_DB_URL: 'x' }))).toBe('off')
    expect(exportDrainMode(env({ NIVARO_ROLE: 'exporter', EXPORT_HANDOFF: 'off' }))).toBe('off')
    // A worker / a single process: only where crons tick.
    const before = { role: process.env.NIVARO_ROLE, ticks: process.env.CRON_TICKS }
    try {
      process.env.CRON_TICKS = 'on'
      delete process.env.NIVARO_ROLE
      expect(exportDrainMode(env({ NIVARO_ROLE: 'worker' }))).toBe('fallback')
      expect(exportDrainMode(env({}))).toBe('inline')
      process.env.CRON_TICKS = 'off'
      expect(exportDrainMode(env({}))).toBe('off')
    } finally {
      process.env.NIVARO_ROLE = before.role
      if (before.ticks === undefined) delete process.env.CRON_TICKS
      else process.env.CRON_TICKS = before.ticks
    }
  })

  it('exporter alive → the importer leaves exports to it; gone → the importer drains', async () => {
    await beat('exporter', 'exp-1')
    expect(await shouldDrainExportsNow('importer', redis as never)).toBe(false)
    expect(await shouldDrainExportsNow('exporter', redis as never)).toBe(true)
    redis.strings.clear()
    expect(await shouldDrainExportsNow('importer', redis as never)).toBe(true)
  })

  it('neither exporter nor importer → the cron worker drains; a single process always does', async () => {
    expect(await shouldDrainExportsNow('fallback', redis as never)).toBe(true)
    await beat('importer', 'imp-1')
    expect(await shouldDrainExportsNow('fallback', redis as never)).toBe(false)
    redis.strings.clear()
    await beat('exporter', 'exp-1')
    expect(await shouldDrainExportsNow('fallback', redis as never)).toBe(false)
    expect(await shouldDrainExportsNow('inline', redis as never)).toBe(true)
    expect(await shouldDrainExportsNow('off', redis as never)).toBe(false)
  })

  it('the exporter beats as role=exporter on the export-worker key', async () => {
    const before = process.env.NIVARO_ROLE
    process.env.NIVARO_ROLE = 'exporter'
    try {
      await drainExportsTick(importerApp())
    } finally {
      process.env.NIVARO_ROLE = before
    }
    expect(JSON.parse((await redis.get(exportWorkerKey()))!)).toMatchObject({ role: 'exporter' })
  })

  it('readiness warns when exports wait over two minutes with no drainer', async () => {
    await beatImporter()
    await startBackground()
    const raw = redis.lists.get(exportQueueKey())![0]
    redis.lists.set(exportQueueKey(), [
      JSON.stringify({ ...JSON.parse(raw), queued_at: Date.now() - 3 * 60_000 })
    ])
    redis.strings.clear()
    const stuck = await exportWorkerJudgement(redis)
    expect(stuck.status).toBe('warn')
    expect(stuck.summary).toMatch(/NIVARO_ROLE=exporter/)
    await beat('exporter', 'exp-1')
    expect((await exportWorkerJudgement(redis)).status).toBe('ok')
  })
})

/** Every file under `d` (the export work dir has one sub-directory per process). */
async function filesUnder(d: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory())
      for (const f of await filesUnder(join(d, e.name))) out.push(join(e.name, f))
    else out.push(e.name)
  }
  return out
}
