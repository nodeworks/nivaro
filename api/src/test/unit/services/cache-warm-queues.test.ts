import { afterEach, describe, expect, it, vi } from 'vitest'

// Table → what `await db(table)…` and `.first()` resolve to (default deps' run).
const tables: Record<string, unknown> = {}
function chain(table: string) {
  const rows = tables[table]
  const p = Promise.resolve(rows)
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === 'then') return p.then.bind(p)
        if (k === 'catch') return p.catch.bind(p)
        if (k === 'first') return async () => (Array.isArray(rows) ? rows[0] : rows)
        return () => proxy
      }
    }
  )
  return proxy
}
vi.mock('../../../db/index.js', () => ({ db: vi.fn((t: string) => chain(t)) }))
vi.mock('../../../services/queues.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/queues.js')>()),
  fetchQueueItems: vi.fn(async () => ({ items: [], total: 0 }))
}))

import { runCacheWarm } from '../../../services/cache-warm.js'
import {
  firstPageRequest,
  pickQueueWarmTargets,
  type QueueUsageRow,
  type QueueWarmTarget,
  queueAccessSignature,
  queueUsageFromLog,
  runQueueTargets
} from '../../../services/cache-warm-queues.js'
import type { WarmViewer } from '../../../services/cache-warm-viewers.js'
import { fetchQueueItems, parseQueueItemsQuery } from '../../../services/queues.js'

const Q1 = '98F98B3A-F07A-4EF4-9016-0005AD2FC8C5'
const Q2 = '241FC3F9-C3C2-4BDB-B8B1-9E7BD12D5412'

const parse = (q: Record<string, string>) => {
  const r = parseQueueItemsQuery(q)
  return r.ok ? r.value : null
}
const V = (id: string, role: string | null, signature = '', isAdmin = false): WarmViewer => ({
  id,
  role,
  signature: isAdmin ? 'admin' : signature,
  isAdmin
})
const use = (queueId: string, query: string, user: string, n: number): QueueUsageRow => ({
  queueId,
  query,
  user,
  n
})

afterEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(tables)) delete tables[k]
})

describe('queueUsageFromLog', () => {
  it('keeps item reads of a queue, upper-cases the id and drops anonymous rows', () => {
    expect(
      queueUsageFromLog([
        {
          path: `/api/queues/${Q1.toLowerCase()}/items`,
          query: 'scope=mine&limit=5',
          user: 'u1',
          n: '4'
        },
        { path: `/api/queues/${Q1}/items`, query: null, user: null, n: 9 },
        { path: `/api/queues/${Q1}/workload`, query: null, user: 'u1', n: 3 },
        { path: '/api/custom-queries/x/execute', query: null, user: 'u1', n: 3 }
      ])
    ).toEqual([{ queueId: Q1, query: 'scope=mine&limit=5', user: 'u1', n: 4 }])
  })
})

describe('firstPageRequest', () => {
  it('parses a first page exactly as the route does', () => {
    expect(firstPageRequest('scope=mine&limit=5', parse)).toEqual({
      scope: 'mine',
      sort: '',
      filters: {},
      page: 1,
      limit: 5
    })
    expect(firstPageRequest('', parse)).toEqual({ scope: 'all', sort: '', filters: {} })
    expect(firstPageRequest('page=1&limit=25&sort=-priority', parse)).toMatchObject({
      page: 1,
      limit: 25,
      sort: '-priority'
    })
  })

  it('drops later pages, masked values, repeated keys and what the route would refuse', () => {
    expect(firstPageRequest('page=2&limit=25', parse)).toBeNull()
    expect(firstPageRequest(`filters=${encodeURIComponent('{"x":"••••••"}')}`, parse)).toBeNull()
    expect(firstPageRequest('scope=all&scope=mine', parse)).toBeNull()
    expect(firstPageRequest('scope=everyone', parse)).toBeNull()
    expect(firstPageRequest('filters=%7Bnot-json', parse)).toBeNull()
    expect(firstPageRequest('group_by=nope', parse)).toBeNull()
  })
})

describe('queueAccessSignature', () => {
  it('is admin for administrators, else role + restrict scopes', () => {
    expect(queueAccessSignature(V('a', 'R-ADMIN', '', true))).toBe('admin')
    expect(queueAccessSignature(V('b', 'R1', 'region=["N"]'))).toBe('role:r1|region=["N"]')
    expect(queueAccessSignature(V('c', null, ''))).toBe('role:|')
  })
})

describe('pickQueueWarmTargets', () => {
  it('one run per (queue, access signature), most-used first, as the top sender of the top shape', () => {
    const viewers = [
      V('admin1', 'RA', '', true),
      V('n1', 'R1', 'region=["N"]'),
      V('n2', 'R1', 'region=["N"]'),
      V('s1', 'R1', 'region=["S"]'),
      V('other', 'R2', 'region=["N"]')
    ]
    const t = pickQueueWarmTargets({
      usage: [
        use(Q1, 'scope=mine&limit=5', 'n1', 3),
        use(Q1, 'scope=mine&limit=5', 'n2', 7),
        use(Q1, 'scope=all&page=1&limit=25', 'n1', 4),
        use(Q1, 'scope=all&page=2&limit=25', 'n1', 50), // not a first page
        use(Q1, 'scope=mine&limit=5', 's1', 2),
        use(Q1, 'scope=mine&limit=5', 'other', 1),
        use(Q2, 'scope=mine&limit=5', 'admin1', 30),
        use(Q2, 'scope=mine&limit=5', 'gone', 99) // inactive / unknown person
      ],
      viewers,
      parse
    })
    expect(t.map((x) => [x.queueId, x.signature, x.as.id, x.query, x.hits, x.members])).toEqual([
      [Q2, 'admin', 'admin1', 'scope=mine&limit=5', 30, 1],
      [Q1, 'role:r1|region=["N"]', 'n2', 'scope=mine&limit=5', 14, 2],
      [Q1, 'role:r1|region=["S"]', 's1', 'scope=mine&limit=5', 2, 1],
      [Q1, 'role:r2|region=["N"]', 'other', 'scope=mine&limit=5', 1, 1]
    ])
    expect(t[1].parsed).toEqual({ scope: 'mine', sort: '', filters: {}, page: 1, limit: 5 })
  })

  it('caps the runs', () => {
    const viewers = ['a', 'b', 'c'].map((id) => V(id, `R-${id}`))
    const usage = viewers.map((v, i) => use(Q1, 'scope=all', v.id, 10 - i))
    expect(pickQueueWarmTargets({ usage, viewers, parse, cap: 2 }).map((x) => x.as.id)).toEqual([
      'a',
      'b'
    ])
  })
})

function target(id: string): QueueWarmTarget {
  return {
    queueId: Q1,
    query: '',
    parsed: { scope: 'all', sort: '', filters: {} },
    as: V(id, 'R1'),
    signature: `role:r1|${id}`,
    hits: 1,
    members: 1
  }
}

describe('runQueueTargets', () => {
  it('runs one at a time, counts failures and skips, and stops starting once the budget is spent', async () => {
    let clock = 0
    let inFlight = 0
    let maxInFlight = 0
    const run = vi.fn(async (t: QueueWarmTarget) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      clock += 40
      if (t.as.id === 'bad') throw new Error('boom')
      return t.as.id === 'gone' ? ('skipped' as const) : ('ok' as const)
    })
    const s = await runQueueTargets(['a', 'bad', 'gone', 'late'].map(target), {
      deadline: 100,
      now: () => clock,
      run
    })
    expect(maxInFlight).toBe(1)
    expect(run).toHaveBeenCalledTimes(3)
    expect(s).toEqual({
      targets: 4,
      warmed: 1,
      skipped: 2,
      failed: 1,
      signatures: 4,
      budgetSpent: true
    })
  })

  it('aborts the run signal when its time is up', async () => {
    let seen: AbortSignal | null = null
    const s = await runQueueTargets([target('a')], {
      deadline: Date.now() + 60_000,
      now: () => Date.now(),
      runMs: 5,
      run: async (_t, signal) => {
        seen = signal
        await new Promise((r) => setTimeout(r, 30))
        if (signal.aborted) throw new Error('aborted')
        return 'ok'
      }
    })
    expect((seen as AbortSignal | null)?.aborted).toBe(true)
    expect(s.failed).toBe(1)
  })
})

describe('runCacheWarm queue phase', () => {
  const coreDeps = {
    loadQueries: async () => [],
    loadHits: async () => ({ hits: new Map(), ownerLoad: 0 }),
    loadParamSets: async () => [],
    buildFinalParams: (() => ({})) as never,
    exec: vi.fn(async () => []),
    ownerLoad: vi.fn(async () => ({}))
  }
  const viewers = [V('u1', 'R1'), V('u2', 'R2')]
  const usage = [use(Q1, 'scope=mine&limit=5', 'u1', 5), use(Q1, 'scope=all', 'u2', 2)]

  it('reads each first page as its viewer, read-only, on the warm’s gate share', async () => {
    tables.nivaro_users = { id: 'u1', role: 'R1', status: 'active' }
    tables.nivaro_queues = { id: Q1, owner: 'someone', is_shared: true, role_id: null }
    const s = await runCacheWarm({
      cloud: false,
      deps: coreDeps,
      viewers: false,
      warmers: false,
      queues: { loadUsage: async () => usage, loadViewers: async () => viewers }
    })
    expect(s.queues).toMatchObject({ targets: 2, warmed: 2, failed: 0 })
    const calls = vi.mocked(fetchQueueItems).mock.calls
    expect(calls).toHaveLength(2)
    const [queueId, user, scope, opts] = calls[0]
    expect(queueId).toBe(Q1)
    expect(user).toMatchObject({ id: 'u1' })
    expect(scope).toBe('mine')
    expect(opts).toMatchObject({
      sort: '',
      filters: {},
      withUnseen: true,
      page: 1,
      limit: 5,
      readOnly: true,
      readGate: { who: 'cache-warm' }
    })
    expect(opts?.readGate?.signal).toBeInstanceOf(AbortSignal)
    // No page / limit sent = the unpaginated read, as the route does.
    expect(calls[1][3]).not.toHaveProperty('page')
  })

  it('skips a queue the person cannot open (canReadQueue)', async () => {
    tables.nivaro_users = { id: 'u1', role: 'R1', status: 'active' }
    tables.nivaro_queues = { id: Q1, owner: 'someone-else', is_shared: false, role_id: null }
    const s = await runCacheWarm({
      cloud: false,
      deps: coreDeps,
      viewers: false,
      warmers: false,
      queues: { loadUsage: async () => usage, loadViewers: async () => viewers }
    })
    expect(s.queues).toMatchObject({ warmed: 0, skipped: 2 })
    expect(fetchQueueItems).not.toHaveBeenCalled()
  })

  it('never runs in cloud mode or on the warm_daily run', async () => {
    const run = vi.fn(async () => 'ok' as const)
    const q = { loadUsage: async () => usage, loadViewers: async () => viewers, run }
    const cloud = await runCacheWarm({ cloud: true, deps: coreDeps, viewers: false, queues: q })
    const daily = await runCacheWarm({
      only: 'warm_daily',
      cloud: false,
      deps: coreDeps,
      viewers: false,
      queues: q
    })
    expect(cloud.queues).toBeUndefined()
    expect(daily.queues).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })

  it('an unreadable request log means nothing to warm, never a failed warm', async () => {
    const s = await runCacheWarm({
      cloud: false,
      deps: coreDeps,
      viewers: false,
      warmers: false,
      queues: { loadUsage: async () => null, loadViewers: async () => viewers }
    })
    expect(s.queues).toMatchObject({ targets: 0, warmed: 0 })
  })
})
