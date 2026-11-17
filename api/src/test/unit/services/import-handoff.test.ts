import { afterEach, describe, expect, it } from 'vitest'
import { cronTicksEnabled } from '../../../services/cron-ticks.js'
import {
  enqueueImportRun,
  forgetRun,
  type ImportRedis,
  importAttemptsKey,
  importDrainMode,
  importerServes,
  importKickChannel,
  importQueueKey,
  importWorkerKey,
  judgeImportWorker,
  judgeLeases,
  pruneFinishedEntries,
  shouldDrainNow
} from '../../../services/import-handoff.js'

// Staged imports run on their own process (NIVARO_ROLE=importer) after EFP prod 2026-11-16: a
// 30 MB invoices CSV held a web process for 17 s and its event loop for up to 13.4 s.

function fakeRedis() {
  const lists = new Map<string, string[]>()
  const hashes = new Map<string, Map<string, number>>()
  const strings = new Map<string, string>()
  const published: Array<[string, string]> = []
  const r: ImportRedis = {
    rpush: async (k, v) => {
      const l = lists.get(k) ?? []
      l.push(v)
      lists.set(k, l)
      return l.length
    },
    lrange: async (k, a, b) => (lists.get(k) ?? []).slice(a, b + 1),
    lrem: async (k, _n, v) => {
      const l = lists.get(k) ?? []
      const i = l.indexOf(v)
      if (i >= 0) l.splice(i, 1)
      return i >= 0 ? 1 : 0
    },
    llen: async (k) => (lists.get(k) ?? []).length,
    publish: async (c, m) => {
      published.push([c, m])
      return 1
    },
    set: async (k, v) => {
      strings.set(k, v)
      return 'OK'
    },
    get: async (k) => strings.get(k) ?? null,
    hincrby: async (k, f, by) => {
      const h = hashes.get(k) ?? new Map<string, number>()
      h.set(f, (h.get(f) ?? 0) + by)
      hashes.set(k, h)
      return h.get(f) as number
    },
    hdel: async (k, f) => hashes.get(k)?.delete(f)
  }
  return { r, lists, hashes, strings, published }
}

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

describe('who drains the import queue', () => {
  const mode = (env: Record<string, string>) =>
    importDrainMode({ NODE_ENV: 'production', ...env } as NodeJS.ProcessEnv)

  it('the importer always; web, realtime and canary never; IMPORT_WORKER overrides', () => {
    expect(mode({ NIVARO_ROLE: 'importer' })).toBe('importer')
    expect(mode({ NIVARO_ROLE: 'importer', IMPORT_WORKER: 'off' })).toBe('off')
    expect(mode({ NIVARO_ROLE: 'web' })).toBe('off')
    expect(mode({ NIVARO_ROLE: 'realtime' })).toBe('off')
    expect(mode({ NIVARO_ROLE: 'canary' })).toBe('off')
    expect(mode({ NIVARO_ROLE: 'web', IMPORT_WORKER: 'on' })).toBe('enabled')
    expect(mode({ NIVARO_ROLE: 'importer', CLOUD_META_DB_URL: 'x' })).toBe('off')
  })

  it('the cron worker is the fallback; a single process drains itself; dev without ticks never', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.CRON_TICKS
    expect(mode({ NIVARO_ROLE: 'worker' })).toBe('fallback')
    expect(mode({})).toBe('inline')
    process.env.CRON_TICKS = 'off'
    expect(mode({ NIVARO_ROLE: 'worker' })).toBe('off')
    expect(mode({})).toBe('off')
  })

  it('an importer ticks no crons, whatever CRON_TICKS says', () => {
    process.env.CRON_TICKS = 'on'
    process.env.NIVARO_ROLE = 'importer'
    expect(cronTicksEnabled()).toBe(false)
    process.env.NIVARO_ROLE = 'worker'
    expect(cronTicksEnabled()).toBe(true)
  })

  it('the fallback stands down while an importer beats', async () => {
    const { r } = fakeRedis()
    expect(await shouldDrainNow('fallback', r)).toBe(true)
    await r.set(
      importWorkerKey(),
      JSON.stringify({
        role: 'importer',
        instance: 'i',
        name: null,
        version: 'v',
        at: new Date().toISOString()
      }),
      'EX',
      90
    )
    expect(await shouldDrainNow('fallback', r)).toBe(false)
    expect(await shouldDrainNow('importer', r)).toBe(true)
    expect(await shouldDrainNow('off', r)).toBe(false)
  })

  it('an importer answers only health, readiness, version and metrics', () => {
    for (const p of ['/api/version', '/api/ready?x=1', '/api/health', '/api/metrics'])
      expect(importerServes(p)).toBe(true)
    for (const p of ['/api/items/workflows', '/api/staged-imports', '/', '/socket.io/'])
      expect(importerServes(p)).toBe(false)
  })
})

describe('the hand-off list', () => {
  it('an upload pushes the run id and kicks the importer', async () => {
    const { r, lists, published } = fakeRedis()
    expect(await enqueueImportRun(r, 77)).toBe(true)
    expect(JSON.parse(lists.get(importQueueKey())?.[0] ?? '{}').id).toBe(77)
    expect(published).toEqual([[importKickChannel(), '77']])
  })

  it('an entry goes only when its run is final or gone, never while queued or running', async () => {
    const { r, lists, hashes } = fakeRedis()
    for (const id of [1, 2, 3, 4, 5]) await enqueueImportRun(r, id)
    await r.rpush(importQueueKey(), 'not json')
    await r.hincrby(importAttemptsKey(), '3', 1)
    const status = new Map<number, string>([
      [1, 'queued'],
      [2, 'running'],
      [3, 'completed'],
      [4, 'error']
    ]) // 5: the row is gone
    const removed = await pruneFinishedEntries(r, async () => status)
    expect(removed).toBe(4)
    expect((lists.get(importQueueKey()) ?? []).map((e) => JSON.parse(e).id)).toEqual([1, 2])
    expect(hashes.get(importAttemptsKey())?.has('3')).toBe(false)
  })

  it('forgetRun drops a finished run and its attempt count', async () => {
    const { r, lists, hashes } = fakeRedis()
    await enqueueImportRun(r, 9)
    await enqueueImportRun(r, 10)
    await r.hincrby(importAttemptsKey(), '9', 1)
    await forgetRun(r, 9)
    expect((lists.get(importQueueKey()) ?? []).map((e) => JSON.parse(e).id)).toEqual([10])
    expect(hashes.get(importAttemptsKey())?.has('9')).toBe(false)
  })
})

describe('runs whose process died', () => {
  const now = Date.parse('2026-11-17T12:00:00Z')
  const ago = (ms: number) => new Date(now - ms)
  const LEASE = 10 * 60_000

  it('a renewed lease is left alone; an expired one is retried once, then failed', () => {
    const rows = [
      { id: 1, started_at: ago(30 * 60_000), updated_at: ago(20_000) },
      { id: 2, started_at: ago(30 * 60_000), updated_at: ago(LEASE + 1) },
      { id: 3, started_at: ago(30 * 60_000), updated_at: ago(LEASE + 1) }
    ]
    expect(judgeLeases(rows, new Map([[3, 1]]), now, LEASE)).toEqual([
      { id: 2, action: 'retry' },
      { id: 3, action: 'fail' }
    ])
  })

  it('a run that started long ago is failed, never replayed over newer data', () => {
    const rows = [{ id: 4, started_at: ago(7 * 3_600_000), updated_at: ago(7 * 3_600_000) }]
    expect(judgeLeases(rows, new Map(), now, LEASE)).toEqual([{ id: 4, action: 'fail' }])
  })
})

describe('readiness: is something draining the import queue', () => {
  const beat = {
    role: 'importer' as const,
    instance: 'i1',
    name: 'importer',
    version: '0.3.168',
    at: '',
    age_ms: 5000
  }
  const base = { cloud: false, redis: true, importer: null, fallback: null, self: 'off' as const }

  it('warns when runs wait past two minutes and nobody beats', () => {
    const v = judgeImportWorker({ ...base, queued: 2, stuck: 1, oldestQueuedMs: 300_000 })
    expect(v.status).toBe('warn')
    expect(v.summary).toMatch(/nothing is running them/)
  })

  it('passes with an importer, with the fallback worker, or with nothing waiting', () => {
    expect(judgeImportWorker({ ...base, importer: beat, queued: 3, stuck: 3 }).status).toBe('ok')
    expect(
      judgeImportWorker({ ...base, fallback: { ...beat, role: 'fallback' }, queued: 3, stuck: 3 })
        .status
    ).toBe('ok')
    expect(judgeImportWorker({ ...base, queued: 1, stuck: 0 }).status).toBe('ok')
    expect(judgeImportWorker({ ...base, self: 'inline', queued: 5, stuck: 5 }).status).toBe('ok')
  })
})
