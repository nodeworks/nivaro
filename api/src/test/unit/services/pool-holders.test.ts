import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Database → Connections (#pool-holders): who holds a pool connection, captured at the acquire
// (pool-attribution.ts + pool-holder-context.ts) and read only when an admin looks.

/** A tarn-shaped pool: events fire like tarn's (acquireRequest synchronously in acquire(),
 *  acquireSuccess / acquireFail on the acquire promise), `used` holds { resource }. */
class FakeTarn {
  emitter = new EventEmitter()
  used: Array<{ resource: object }> = []
  queue: Array<{ id: number; resolve: (r: object) => void; reject: (e: Error) => void }> = []
  max = 2
  private eventId = 1
  on(ev: string, fn: (...a: unknown[]) => void) {
    this.emitter.on(ev, fn)
  }
  numUsed() {
    return this.used.length
  }
  numFree() {
    return Math.max(0, this.max - this.used.length)
  }
  numPendingAcquires() {
    return this.queue.length
  }
  numPendingCreates() {
    return 0
  }
  acquire(): { promise: Promise<object>; id: number } {
    const id = this.eventId++
    this.emitter.emit('acquireRequest', id)
    let resolve!: (r: object) => void
    let reject!: (e: Error) => void
    const promise = new Promise<object>((res, rej) => {
      resolve = res
      reject = rej
    }).then(
      (r) => {
        this.emitter.emit('acquireSuccess', id, r)
        return r
      },
      (e) => {
        this.emitter.emit('acquireFail', id, e)
        throw e
      }
    )
    if (this.used.length < this.max) {
      const r = { n: id }
      this.used.push({ resource: r })
      resolve(r)
    } else this.queue.push({ id, resolve, reject })
    return { promise, id }
  }
  /** A queued acquire times out (knex's acquireConnectionTimeout). */
  timeoutOldest() {
    const q = this.queue.shift()
    q?.reject(new Error('Knex: Timeout acquiring a connection'))
  }
  release(r: object) {
    this.emitter.emit('release', r)
    this.used = this.used.filter((u) => u.resource !== r)
    const next = this.queue.shift()
    if (next) {
      const nr = { n: next.id }
      this.used.push({ resource: nr })
      next.resolve(nr)
    }
  }
}

const h = vi.hoisted(() => ({ pool: null as unknown }))

vi.mock('../../../db/index.js', () => {
  const staticDb = {
    get client() {
      return { pool: h.pool }
    }
  }
  return { _staticDb: staticDb, _backgroundDb: null, db: staticDb }
})

import { runInBackgroundPool } from '../../../db/pool-context.js'
import {
  heldConnections,
  heldNow,
  resetPoolAttributionForTests,
  startPoolAttribution,
  waitingNow
} from '../../../services/pool-attribution.js'
import { withPoolFeature } from '../../../services/pool-holder-context.js'
import {
  describeHolder,
  freshNodes,
  HOG_MS,
  localSnapshot,
  mergeSnapshots,
  type NodeSnapshot,
  noteSample,
  overShare,
  resetPoolHoldersForTests
} from '../../../services/pool-holders.js'
import { beginTrace, clearTrace, setTraceUser } from '../../../services/request-trace.js'
import { withTrafficSource } from '../../../services/traffic-source.js'

const USER = '0f3c2a8e-1111-4c4c-9a9a-123456789abc'

/** Run `fn` inside a traced request, as Fastify's onRequest hook + authenticate would. */
async function inRequest<T>(req: Record<string, unknown>, userId: string | null, fn: () => T) {
  await Promise.resolve()
  beginTrace(String(req.url ?? '/api/x'), req, randomUUID())
  if (userId) setTraceUser(userId)
  return fn()
}

let pool: FakeTarn

beforeEach(() => {
  resetPoolAttributionForTests()
  resetPoolHoldersForTests()
  pool = new FakeTarn()
  h.pool = pool
  startPoolAttribution()
})
afterEach(() => {
  resetPoolAttributionForTests()
  resetPoolHoldersForTests()
})

describe('connection accounting', () => {
  it('tracks a held connection from acquire to release', async () => {
    const r = await pool.acquire().promise
    expect(heldNow('main')).toHaveLength(1)
    pool.release(r)
    expect(heldNow('main')).toHaveLength(0)
  })

  it('a timed-out acquire leaves no waiter and no holder behind', async () => {
    const a = await pool.acquire().promise
    const b = await pool.acquire().promise
    const queued = pool.acquire().promise.catch((e) => e)
    expect(waitingNow('main')).toHaveLength(1)
    pool.timeoutOldest()
    expect(await queued).toBeInstanceOf(Error)
    expect(waitingNow('main')).toHaveLength(0)
    expect(heldNow('main')).toHaveLength(2)
    pool.release(a)
    pool.release(b)
    expect(heldNow('main')).toHaveLength(0)
  })

  it('a destroyed connection (broken socket) is dropped', async () => {
    const r = await pool.acquire().promise
    pool.emitter.emit('destroySuccess', 99, r)
    expect(heldNow('main')).toHaveLength(0)
  })

  it('an entry tarn no longer counts as used is never shown (no leak on a missed event)', async () => {
    const r = await pool.acquire().promise
    await pool.acquire().promise
    // tarn forgets one without an event (an aborted request's connection torn down elsewhere).
    pool.used = pool.used.filter((u) => u.resource !== r)
    expect(heldNow('main')).toHaveLength(1)
  })

  it('a queued acquire is credited to the WAITER, not to whoever released the connection', async () => {
    const releaser = { method: 'GET', url: '/api/items/a', routeOptions: { url: '/api/items/:c' } }
    const waiter = {
      method: 'POST',
      url: '/api/reports/run',
      routeOptions: { url: '/api/reports/run' }
    }
    const [a, b] = await inRequest(releaser, USER, () =>
      Promise.all([pool.acquire().promise, pool.acquire().promise])
    )
    const queued = inRequest(waiter, null, () => pool.acquire().promise)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(waitingNow('main').map((w) => describeHolder(w.ctx, 'main').feature.label)).toEqual([
      'POST /api/reports/run'
    ])
    await inRequest(releaser, USER, () => pool.release(a))
    await queued
    const features = heldNow('main').map((x) => describeHolder(x.ctx, 'main').feature.label)
    expect(features.sort()).toEqual(['GET /api/items/:c', 'POST /api/reports/run'])
    pool.release(b)
  })

  it('heldConnections keeps its old shape (URL hint read lazily)', async () => {
    await inRequest({ method: 'GET', url: '/api/items/x' }, null, () => pool.acquire().promise)
    const rows = heldConnections('main')
    expect(rows).toEqual([]) // under 1 s: not a leak yet
  })
})

describe('attribution', () => {
  it('a signed-in request: person (name off the request) + route template + request id', async () => {
    const req = {
      method: 'GET',
      url: '/api/items/workflows/12',
      routeOptions: { url: '/api/items/:collection/:id' },
      authMethod: 'session',
      user: { id: USER, first_name: 'Ada', last_name: 'Lovelace' }
    }
    await inRequest(req, USER, () => pool.acquire().promise)
    const d = describeHolder(heldNow('main')[0].ctx, 'main')
    expect(d.person).toMatchObject({ kind: 'person', label: 'Ada Lovelace', user_id: USER })
    expect(d.person.key).toBe(`u${USER.toUpperCase()}`)
    expect(d.feature).toMatchObject({ kind: 'route', label: 'GET /api/items/:collection/:id' })
    expect(d.request_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('the person authenticate stamps AFTER the acquire still shows', async () => {
    const req = { method: 'GET', url: '/api/me', routeOptions: { url: '/api/me' } }
    await inRequest(req, null, async () => {
      await pool.acquire().promise
      setTraceUser(USER)
    })
    expect(describeHolder(heldNow('main')[0].ctx, 'main').person.kind).toBe('person')
  })

  it('an API key and an MCP client are their own callers', async () => {
    await inRequest(
      {
        method: 'GET',
        url: '/api/items/x',
        authMethod: 'api_key',
        apiKeyId: 7,
        apiKeyName: 'Nightly sync'
      },
      null,
      () => pool.acquire().promise
    )
    await inRequest(
      { method: 'POST', url: '/api/mcp', authMethod: 'oauth', mcpCall: { client: 'Claude_Code' } },
      USER,
      () => pool.acquire().promise
    )
    const people = heldNow('main').map((x) => describeHolder(x.ctx, 'main').person)
    expect(people).toEqual([
      { key: 'k7', kind: 'api_key', label: 'Nightly sync', user_id: null },
      { key: 'm:Claude_Code', kind: 'mcp', label: 'MCP: Claude Code', user_id: USER }
    ])
  })

  it('a cron job is System + the job; a labelled feature names itself; bare background work says so', async () => {
    clearTrace() // an earlier test's enterWith trace must not ride along
    await withTrafficSource(
      { id: 'cron:rollup-sweep', label: 'rollup-sweep', kind: 'cron' },
      () => pool.acquire().promise
    )
    const job = describeHolder(heldNow('main')[0].ctx, 'main')
    expect(job.person.kind).toBe('system')
    expect(job.feature).toEqual({
      key: 'cron:rollup-sweep',
      kind: 'job',
      label: 'Job: rollup-sweep'
    })
    expect(job.request_id).toBeNull()

    pool.max = 5
    await withPoolFeature('Cache warm', () => pool.acquire().promise)
    await runInBackgroundPool(() => pool.acquire().promise)
    const rest = heldNow('main')
      .slice(1)
      .map((x) => describeHolder(x.ctx, 'background').feature.label)
    expect(rest).toEqual(['Cache warm', 'Background work (unlabelled)'])
  })

  it('localSnapshot never carries SQL text or bound values', async () => {
    await inRequest(
      { method: 'GET', url: '/api/items/x?secret=hunter2', routeOptions: { url: '/api/items/:c' } },
      USER,
      () => pool.acquire().promise
    )
    const snap = localSnapshot()
    expect(snap.pools[0]).toMatchObject({ name: 'main', max: 2, used: 1, holding: 1, waiting: 0 })
    expect(JSON.stringify(snap)).not.toContain('hunter2')
  })
})

function snap(node: string, at: number, over: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    node,
    host: `host-${node}`,
    pid: 1,
    role: 'web',
    at,
    pools: [
      {
        name: 'main',
        max: 10,
        used: 4,
        free: 6,
        pending_acquires: 1,
        pending_creates: 0,
        holding: 4,
        waiting: 1,
        wait_p95_ms: 0,
        saturated_pct: 0
      }
    ],
    rows: [],
    read_gate: { active: 1, queued: 0, limit: 8, overflow_running: 0 },
    hogs: [],
    ...over
  }
}

function row(
  node: string,
  person: string,
  feature: string,
  since: number,
  state: 'holding' | 'waiting' = 'holding'
) {
  return {
    node,
    pool: 'main' as const,
    state,
    since,
    person: { key: person, kind: 'person' as const, label: person.toUpperCase(), user_id: null },
    feature: { key: feature, kind: 'route' as const, label: feature },
    request_id: `${node}-${since}`,
    read_gate: false
  }
}

describe('cross-process merge', () => {
  const now = 1_000_000

  it('names a process in the roster that did not answer and marks the answer partial', () => {
    const a = snap('aaaa', now, {
      rows: [
        row('aaaa', 'ua', 'GET /x', now - 5000),
        row('aaaa', 'ua', 'GET /x', now - 100),
        row('aaaa', 'ub', 'GET /y', now - 50, 'waiting')
      ]
    })
    const b = snap('bbbb', now - 1000, { rows: [row('bbbb', 'ub', 'GET /y', now - 9000)] })
    const stale = snap('cccc', now - 60_000)
    const view = mergeSnapshots(
      [a, b, stale],
      [{ id: 'aaaa' }, { id: 'bbbb' }, { id: 'cccc', host: 'h3', role: 'worker' }, { id: 'dddd' }],
      now,
      'aaaa'
    )
    expect(view.partial).toBe(true)
    expect(view.missing.map((m) => m.node)).toEqual(['cccc', 'dddd'])
    expect(view.nodes.map((n) => n.node)).toEqual(['aaaa', 'bbbb'])
    expect(view.totals).toEqual([
      { name: 'main', max: 20, used: 8, free: 12, holding: 8, waiting: 2 }
    ])
    expect(view.longest.map((r) => r.request_id)).toEqual([
      'bbbb-991000',
      'aaaa-995000',
      'aaaa-999900'
    ])
    expect(view.waiters).toHaveLength(1)
    const ua = view.by_person.find((g) => g.key === 'ua')
    expect(ua).toMatchObject({
      holding: 2,
      waiting: 0,
      max_share: 0.2,
      hot: false,
      oldest_ms: 5000
    })
    const ub = view.by_person.find((g) => g.key === 'ub')
    expect(ub).toMatchObject({ holding: 1, waiting: 1 })
    expect(view.read_gate).toEqual({ active: 2, queued: 0, overflow_running: 0 })
  })

  it('every process answering = not partial; over a quarter of ONE process pool is hot', () => {
    const rows = [1, 2, 3].map((i) => row('aaaa', 'ua', 'POST /api/reports/run', now - i))
    const view = mergeSnapshots([snap('aaaa', now, { rows })], [{ id: 'aaaa' }], now, 'aaaa')
    expect(view.partial).toBe(false)
    expect(view.by_feature[0]).toMatchObject({
      key: 'POST /api/reports/run',
      holding: 3,
      hot: true,
      max_share_node: 'aaaa'
    })
  })

  it('keeps one payload per node and always keeps this process', () => {
    const out = freshNodes(
      [snap('aaaa', 0), snap('bbbb', now), snap('bbbb', now - 10)],
      now,
      'aaaa'
    )
    expect(out.map((n) => n.node)).toEqual(['aaaa', 'bbbb'])
  })
})

describe('hog watch', () => {
  it('records once when one person holds more than half a pool for 30 s', async () => {
    pool.max = 4
    const req = {
      method: 'GET',
      url: '/api/reports/x',
      routeOptions: { url: '/api/reports/:id' },
      authMethod: 'session',
      user: { first_name: 'Hog' }
    }
    await inRequest(req, USER, () => Promise.all([1, 2, 3].map(() => pool.acquire().promise)))
    const t0 = 5_000_000
    noteSample('main', 3, 4, t0)
    expect(localSnapshot().hogs).toHaveLength(0)
    noteSample('main', 3, 4, t0 + HOG_MS)
    noteSample('main', 3, 4, t0 + HOG_MS + 5000)
    const hogs = localSnapshot().hogs
    expect(hogs.map((e) => e.dimension).sort()).toEqual(['feature', 'person'])
    expect(hogs.find((e) => e.dimension === 'person')).toMatchObject({
      label: 'Hog',
      held: 3,
      max: 4
    })
  })

  it('a dip below half starts the clock again', async () => {
    pool.max = 4
    await inRequest({ method: 'GET', url: '/a' }, USER, () =>
      Promise.all([1, 2, 3].map(() => pool.acquire().promise))
    )
    noteSample('main', 3, 4, 0)
    noteSample('main', 1, 4, 20_000)
    noteSample('main', 3, 4, 25_000)
    noteSample('main', 3, 4, 40_000)
    expect(localSnapshot().hogs).toHaveLength(0)
  })

  it('overShare is strict', () => {
    const rows = [row('a', 'ua', 'f', 0), row('a', 'ua', 'f', 0)]
    expect(overShare(rows, 4, 0.5)).toEqual([])
    expect(overShare(rows, 3, 0.5).map((o) => o.dimension)).toEqual(['person', 'feature'])
  })
})
