import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryDb } from '../../helpers/memory-db.js'

// Collection imports run on the import worker (EFP prod 2026-11-19: an 86,575-row import ran in
// a web replica and could not be stopped). The same drainers as staged imports claim pending
// jobs; a job left `processing` by a dead process is put back once only when it wrote nothing,
// else failed and its creator told; a job queued and cancelled is never started.

const h = vi.hoisted(() => ({
  mem: null as unknown as MemoryDb,
  ran: [] as string[],
  /** A run lasts until this settles (a real run is a long row loop). */
  gate: Promise.resolve() as Promise<void>,
  notified: [] as Array<{ to: string; subject: string; message: string }>
}))

vi.mock('../../../db/index.js', async () => {
  const { makeMemoryDb } = await import('../../helpers/memory-db.js')
  h.mem = makeMemoryDb()
  return { db: h.mem }
})
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(async (_app: unknown, to: string, o: { subject: string; message: string }) => {
    h.notified.push({ to, subject: o.subject, message: o.message })
    return { id: 1 }
  })
}))
// The real claim (a guarded update on the row); the run itself is recorded, not executed.
vi.mock('../../../routes/imports.js', async () => {
  const { db } = await import('../../../db/index.js')
  return {
    claimImportJob: async (id: string) =>
      Number(
        await db('nivaro_import_jobs')
          .where({ id, status: 'pending' })
          .update({ status: 'processing', started_at: new Date() })
      ) === 1,
    runClaimedImportJob: async (id: string) => {
      h.ran.push(id)
      await h.gate
    }
  }
})

const worker = await import('../../../services/collection-import-worker.js')
const handoff = await import('../../../services/import-handoff.js')

const app = { log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } as unknown as FastifyInstance

function fakeRedis() {
  const lists = new Map<string, string[]>()
  const strings = new Map<string, string>()
  const hashes = new Map<string, Map<string, number>>()
  const published: Array<[string, string]> = []
  const r = {
    rpush: async (k: string, v: string) => {
      const l = lists.get(k) ?? []
      l.push(v)
      lists.set(k, l)
      return l.length
    },
    lrange: async (k: string, a: number, b: number) => (lists.get(k) ?? []).slice(a, b + 1),
    lrem: async (k: string, _n: number, v: string) => {
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
      strings.set(k, v)
      return 'OK'
    },
    get: async (k: string) => strings.get(k) ?? null,
    hget: async (k: string, f: string) => {
      const v = hashes.get(k)?.get(f)
      return v == null ? null : String(v)
    },
    hincrby: async (k: string, f: string, by: number) => {
      const m = hashes.get(k) ?? new Map<string, number>()
      m.set(f, (m.get(f) ?? 0) + by)
      hashes.set(k, m)
      return m.get(f) as number
    },
    hdel: async (k: string, f: string) => hashes.get(k)?.delete(f)
  }
  return { r, lists, strings, hashes, published }
}

const NOW = Date.parse('2026-11-19T15:00:00Z')
const minutesAgo = (m: number) => new Date(NOW - m * 60_000)
const jobs = () => h.mem.rows('nivaro_import_jobs')
const row = (id: string) => jobs().find((j) => j.id === id)

beforeEach(() => {
  worker.forgetLeaseSuspects()
  h.mem.reset()
  h.ran.length = 0
  h.notified.length = 0
})

describe('enqueueImportJob / forgetImportJob / pruneFinishedJobEntries', () => {
  it('queues a uuid on its own list (never the staged-run list) and kicks the drainers', async () => {
    const { r, lists, published } = fakeRedis()
    expect(await handoff.enqueueImportJob(r, 'job-1')).toBe(true)
    expect(lists.get(handoff.importJobQueueKey())?.map((e) => JSON.parse(e).id)).toEqual(['job-1'])
    expect(lists.get(handoff.importQueueKey())).toBeUndefined()
    expect(published).toEqual([[handoff.importKickChannel(), 'job:job-1']])
    await handoff.forgetImportJob(r, 'job-1')
    expect(lists.get(handoff.importJobQueueKey())).toEqual([])
  })

  it('nothing queues without Redis or in cloud mode', async () => {
    expect(await handoff.enqueueImportJob(null, 'x')).toBe(false)
    process.env.CLOUD_META_DB_URL = 'm'
    try {
      expect(await handoff.enqueueImportJob(fakeRedis().r, 'x')).toBe(false)
    } finally {
      delete process.env.CLOUD_META_DB_URL
    }
  })

  it('prunes the entries of finished, cancelled or deleted jobs and keeps the rest', async () => {
    const { r, lists } = fakeRedis()
    for (const id of ['a', 'b', 'c', 'd', 'gone']) await handoff.enqueueImportJob(r, id)
    const status = new Map([
      ['a', 'pending'],
      ['b', 'processing'],
      ['c', 'complete'],
      ['d', 'cancelled']
    ])
    const removed = await handoff.pruneFinishedJobEntries(r, async () => status)
    expect(removed).toBe(3)
    expect(lists.get(handoff.importJobQueueKey())?.map((e) => JSON.parse(e).id)).toEqual(['a', 'b'])
  })
})

describe('drainCollectionImportJobs', () => {
  it('claims pending jobs oldest first, up to the per-process cap', async () => {
    jobs().push(
      { id: 'j2', collection: 'b', status: 'pending', created_at: minutesAgo(2) },
      { id: 'j1', collection: 'a', status: 'pending', created_at: minutesAgo(3) },
      { id: 'j3', collection: 'c', status: 'pending', created_at: minutesAgo(1) },
      { id: 'done', collection: 'a', status: 'complete', created_at: minutesAgo(9) }
    )
    let release = () => {}
    h.gate = new Promise<void>((res) => {
      release = res
    })
    const started = await worker.drainCollectionImportJobs(app, NOW)
    expect(started).toEqual(['j1', 'j2'].slice(0, worker.MAX_PARALLEL_JOBS))
    for (const id of started) expect(row(id)?.status).toBe('processing')
    expect(row('j3')?.status).toBe('pending')
    // While both run, a second pass starts nothing; once they finish, j3 goes.
    expect(await worker.drainCollectionImportJobs(app, NOW)).toEqual([])
    release()
    await vi.waitFor(() => expect(worker.jobsRunningHere().size).toBe(0))
    h.gate = Promise.resolve()
    expect(await worker.drainCollectionImportJobs(app, NOW)).toEqual(['j3'])
    await vi.waitFor(() => expect(h.ran).toEqual([...started, 'j3']))
  })

  it('one job per collection at a time, whichever process runs the other', async () => {
    jobs().push(
      {
        id: 'busy',
        collection: 'warehouse_inventory',
        status: 'processing',
        started_at: minutesAgo(1)
      },
      { id: 'w1', collection: 'warehouse_inventory', status: 'pending', created_at: minutesAgo(3) },
      { id: 'u1', collection: 'units', status: 'pending', created_at: minutesAgo(2) },
      { id: 'u2', collection: 'units', status: 'pending', created_at: minutesAgo(1) }
    )
    expect(await worker.drainCollectionImportJobs(app, NOW)).toEqual(['u1'])
    expect(row('w1')?.status).toBe('pending')
    expect(row('u2')?.status).toBe('pending')
  })

  it('a job cancelled while it waited is never started', async () => {
    jobs().push({ id: 'c', status: 'cancelled', created_at: minutesAgo(1) })
    expect(await worker.drainCollectionImportJobs(app, NOW)).toEqual([])
    expect(row('c')?.status).toBe('cancelled')
  })

  it('a job that waited past the retry window fails with a sentence instead of running', async () => {
    jobs().push({
      id: 'old',
      status: 'pending',
      created_at: new Date(NOW - handoff.RETRY_WINDOW_MS - 60_000),
      created_by: 'u1',
      file_name: 'stock.csv'
    })
    expect(await worker.drainCollectionImportJobs(app, NOW)).toEqual([])
    expect(row('old')?.status).toBe('failed')
    expect(JSON.parse(String(row('old')?.errors))[0].error).toBe(worker.STALE_PENDING_NOTE)
    expect(h.notified).toEqual([
      { to: 'u1', subject: 'stock.csv import failed', message: worker.STALE_PENDING_NOTE }
    ])
  })
})

describe('recoverLostCollectionJobs', () => {
  const lease = handoff.importLeaseMs()

  it('a live lease or a young run is left alone', async () => {
    const { r, strings } = fakeRedis()
    jobs().push(
      { id: 'live', status: 'processing', started_at: minutesAgo(60), processed_rows: 10 },
      { id: 'young', status: 'processing', started_at: new Date(NOW - lease / 2) }
    )
    strings.set(handoff.importJobLeaseKey('live'), String(NOW))
    expect(await worker.recoverLostCollectionJobs(app, r, NOW)).toEqual([])
    expect(row('live')?.status).toBe('processing')
    expect(row('young')?.status).toBe('processing')
  })

  // A missing key is judged only on a second look more than LEASE_RENEW_MS later.
  const twoLooks = async (r: ReturnType<typeof fakeRedis>['r'], at = NOW) => {
    expect(await worker.recoverLostCollectionJobs(app, r, at)).toEqual([])
    return worker.recoverLostCollectionJobs(app, r, at + handoff.LEASE_RENEW_MS + 1_000)
  }

  it('a lost run that never reached its rows goes back to the queue once, then fails', async () => {
    const { r, lists } = fakeRedis()
    jobs().push({
      id: 'lost',
      status: 'processing',
      started_at: new Date(NOW - lease - 60_000),
      processed_rows: 0,
      total_rows: null,
      created_by: 'u1',
      file_name: 'a.csv'
    })
    expect(await twoLooks(r)).toEqual([{ id: 'lost', action: 'retry' }])
    expect(row('lost')).toMatchObject({ status: 'pending', started_at: null })
    expect(lists.get(handoff.importJobQueueKey())?.map((e) => JSON.parse(e).id)).toEqual(['lost'])

    // Claimed again, and lost again: this time it fails.
    row('lost')!.status = 'processing'
    row('lost')!.started_at = new Date(NOW - lease - 60_000)
    expect(await twoLooks(r, NOW + 600_000)).toEqual([{ id: 'lost', action: 'fail' }])
    expect(row('lost')?.status).toBe('failed')
    expect(h.notified[0]).toMatchObject({ to: 'u1', message: handoff.LEASE_FAIL_NOTE })
  })

  it('a lost run that already wrote rows is never re-run: it fails, keeping its errors', async () => {
    const { r } = fakeRedis()
    jobs().push({
      id: 'half',
      status: 'processing',
      started_at: new Date(NOW - lease - 60_000),
      processed_rows: 4000,
      total_rows: 86575,
      errors: JSON.stringify([{ row: 7, error: 'bad qty' }]),
      created_by: 'u1',
      file_name: 'a.csv'
    })
    expect(await twoLooks(r)).toEqual([{ id: 'half', action: 'fail' }])
    expect(JSON.parse(String(row('half')?.errors))).toEqual([
      { row: 0, error: handoff.LEASE_FAIL_NOTE },
      { row: 7, error: 'bad qty' }
    ])
  })

  it('a run that reached its rows is never re-run, even before its first progress write', async () => {
    const { r } = fakeRedis()
    // total_rows is written before row 1: row 1 may be in the table though processed_rows is 0.
    jobs().push({
      id: 'r1',
      status: 'processing',
      started_at: new Date(NOW - lease - 60_000),
      processed_rows: 0,
      total_rows: 120,
      created_by: 'u1',
      file_name: 'a.csv'
    })
    expect(await twoLooks(r)).toEqual([{ id: 'r1', action: 'fail' }])
  })

  it('a missing key is not a dead process: Redis lost its keys, the run renews and moves on', async () => {
    const { r, strings } = fakeRedis()
    jobs().push({
      id: 'alive',
      status: 'processing',
      started_at: new Date(NOW - lease - 60_000),
      processed_rows: 500,
      total_rows: 86575
    })
    // Look 1: no key (Redis restarted). Too soon for look 2.
    expect(await worker.recoverLostCollectionJobs(app, r, NOW)).toEqual([])
    expect(await worker.recoverLostCollectionJobs(app, r, NOW + 5_000)).toEqual([])
    // The run kept going: rows moved, so the clock starts again.
    row('alive')!.processed_rows = 900
    expect(
      await worker.recoverLostCollectionJobs(app, r, NOW + handoff.LEASE_RENEW_MS + 5_000)
    ).toEqual([])
    // It renewed its key: never judged.
    strings.set(handoff.importJobLeaseKey('alive'), String(NOW))
    expect(
      await worker.recoverLostCollectionJobs(app, r, NOW + 3 * handoff.LEASE_RENEW_MS)
    ).toEqual([])
    expect(row('alive')?.status).toBe('processing')
  })

  it('without Redis nothing is judged (a person can still cancel)', async () => {
    jobs().push({ id: 'x', status: 'processing', started_at: minutesAgo(600), processed_rows: 0 })
    expect(await worker.recoverLostCollectionJobs(app, null, NOW)).toEqual([])
    expect(row('x')?.status).toBe('processing')
  })
})
