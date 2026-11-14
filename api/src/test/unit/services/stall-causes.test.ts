import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { causesForState, noticeText } from '../../../services/ops-monitors.js'
import { judgeEventLoop, type NodeSignals, SignalBook } from '../../../services/ops-signals.js'
import { beginTrace } from '../../../services/request-trace.js'
import {
  causeFromDetail,
  fmtStallMs,
  pageWords,
  routeAction,
  type StallLabels
} from '../../../services/stall-cause-words.js'
import { rankCulprits, StallBook } from '../../../services/stall-causes.js'
import {
  attachInflightQueries,
  type InflightStallRaw,
  inflightEnd,
  inflightStallCandidates,
  inflightStart,
  resetInflight
} from '../../../services/traffic-inflight.js'

const T0 = Date.UTC(2026, 10, 13, 19, 0, 0) // 2:00 PM ET
const MIN = 60_000
const SAM = '7f3c2a10-0000-4000-8000-00000000abcd'
const JANE = '1b2c3d40-0000-4000-8000-00000000ef01'

const LABELS: StallLabels = {
  users: new Map([
    [SAM.toUpperCase(), 'Sam Rivera'],
    [JANE.toUpperCase(), 'Jane Doe']
  ]),
  collections: new Map([['deployment_part_types', 'Unit Types']]),
  zone: 'America/New_York'
}

function raw(p: Partial<InflightStallRaw> & { id: string; startedAt: number }): InflightStallRaw {
  return {
    method: 'GET',
    route: '/api/presence/online',
    endedAt: null,
    userId: null,
    app: null,
    page: null,
    collection: null,
    sqlSince: null,
    lastSettle: null,
    ...p
  }
}

/** The 2026-11-13 production shape: resolve-paths runs code for 61 s, others wait behind it. */
function productionStall(): { book: StallBook; inflight: InflightStallRaw[]; end: number } {
  const stallStart = T0 + 2 * MIN + 5_000
  const end = stallStart + 61_000
  const inflight = [
    // Loaded its rows, then worked through them synchronously.
    raw({
      id: 'req-resolve',
      route: '/api/items/:collection/resolve-paths',
      collection: 'deployment_part_types',
      userId: SAM,
      app: 'admin',
      page: '/collections/deployment_part_types',
      startedAt: stallStart - 2_000,
      lastSettle: stallStart - 30
    }),
    // Waiting on the database the whole time.
    raw({
      id: 'req-list',
      route: '/api/items/:collection',
      collection: 'workflows',
      userId: JANE,
      page: '/collections/workflows',
      startedAt: stallStart - 500,
      sqlSince: stallStart - 400
    }),
    // Arrived as the stall ended: covers nothing.
    raw({ id: 'req-late', startedAt: end - 5 })
  ]
  const book = new StallBook(() => inflight)
  return { book, inflight, end }
}

function stalledNode(book: StallBook, now: number): NodeSignals {
  const sb = new SignalBook(T0)
  for (const s of book.list(now)) sb.noteLag(s.ms, s.at)
  // A second minute over the threshold so the default 3-of-5 rule fails on this node.
  sb.noteLag(4_000, T0 + 4 * MIN + 10_000)
  return { ...sb.summary(now, book.list(now)), node: 'prod · web-2', role: 'web' }
}

describe('rankCulprits', () => {
  it('puts the request that ran code through the whole stall first', () => {
    const { inflight, end } = productionStall()
    const ranked = rankCulprits(inflight, end - 61_000, end)
    expect(ranked.map((c) => c.id)).toEqual(['req-resolve', 'req-list', 'req-late'])
    expect(ranked[0].share).toBe(1)
    expect(ranked[0].waiting_sql).toBe(false)
    expect(ranked[1].waiting_sql).toBe(true)
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score)
    expect(ranked[2].share).toBeLessThan(0.01)
  })

  it('drops requests that finished before the stall began', () => {
    const r = rankCulprits(
      [raw({ id: 'done', startedAt: T0, endedAt: T0 + 1000 })],
      T0 + 2000,
      T0 + 5000
    )
    expect(r).toEqual([])
  })
})

describe('StallBook', () => {
  it('captures a stall and finishes a running culprit with its whole duration', () => {
    const { book, end } = productionStall()
    expect(book.noteLag(300, end - 70_000)).toBeNull() // under the capture level
    const rec = book.noteLag(61_000, end)
    expect(rec?.culprits[0].id).toBe('req-resolve')
    expect(rec?.culprits[0].running).toBe(true)
    // It answers 2 s after the stall ended: 63 s in all.
    book.noteEnded(
      raw({
        id: 'req-resolve',
        startedAt: end - 63_000,
        endedAt: end + 2_000
      })
    )
    const [s] = book.list(end + 10_000)
    expect(s.culprits[0].running).toBe(false)
    expect(s.culprits[0].ms).toBe(65_000) // 2 s before, 61 s through, 2 s after
  })

  it('counts a request that finished between the stall and the sample', () => {
    const end = T0 + 10_000
    const book = new StallBook(() => [])
    book.noteEnded(raw({ id: 'quick', startedAt: end - 9_000, endedAt: end - 1 }))
    const rec = book.noteLag(8_000, end)
    expect(rec?.culprits[0].id).toBe('quick')
    expect(rec?.culprits[0].running).toBe(false)
  })
})

describe('freeze alert text', () => {
  it('names the likely cause in plain words', () => {
    const { book, end } = productionStall()
    book.noteLag(61_000, end)
    book.noteEnded(raw({ id: 'req-resolve', startedAt: end - 63_000, endedAt: end + 2_000 }))
    const now = T0 + 6 * MIN
    const v = judgeEventLoop(
      [stalledNode(book, now)],
      { breach_minutes: 2, window_minutes: 5 },
      LABELS
    )
    expect(v.status).toBe('failing')
    const lines = v.detail.split('\n')
    expect(lines[1]).toBe(
      'Most likely cause: GET resolve-paths on Unit Types by Sam Rivera (Unit Types list) — 65 s, on prod · web-2.'
    )
    expect(v.detail).toMatch(/Worst stall on prod · web-2: 61 s at \d{1,2}:\d{2} (PM|AM) EST/)
    expect(v.detail).toContain(
      '1. GET /api/items/:collection/resolve-paths (Unit Types), Sam Rivera, Unit Types list in admin, 65 s, covered the whole stall, request req-resolve'
    )
    expect(v.detail).toContain('Jane Doe')
    expect(v.detail).toContain('was waiting on the database')
    expect(v.causes?.nodes[0].culprits[0].likely).toBe(true)
    expect(v.causes?.nodes[0].culprits[1].likely).toBe(false)
  })

  it('never carries a query string, SQL text or secret from the request', async () => {
    resetInflight()
    const listeners: Record<string, (...a: unknown[]) => void> = {}
    attachInflightQueries({
      on: (ev, fn) => {
        listeners[ev] = fn
      }
    })
    const req = {
      method: 'GET',
      url: '/api/items/deployment_part_types/resolve-paths?token=sk_live_SECRET&q=hunter2',
      raw: { url: '/api/items/deployment_part_types/resolve-paths?token=sk_live_SECRET' },
      routeOptions: { url: '/api/items/:collection/resolve-paths' },
      params: { collection: 'deployment_part_types' },
      headers: {
        'x-nivaro-page': '/collections/deployment_part_types/123?secret=abc',
        'x-nivaro-app': 'admin',
        authorization: 'Bearer nvo_SECRETTOKEN'
      },
      user: { id: SAM }
    }
    beginTrace('/api/items/deployment_part_types/resolve-paths', req as never, 'trace-1')
    inflightStart(req)
    listeners.query({ __knexQueryUid: 'q1', sql: "SELECT * FROM t WHERE pw = 'hunter2'" })
    const book = new StallBook(() => inflightStallCandidates())
    const end = Date.now() + 1
    book.noteLag(5_000, end)
    const node: NodeSignals = {
      ...new SignalBook(end - 10 * MIN).summary(end, book.list(end)),
      node: 'prod · web-1'
    }
    node.lag = [-1, 5000, 5000, 5000, 0, 0, 0, 0, 0, 0]
    const v = judgeEventLoop([node], {}, LABELS)
    expect(v.status).toBe('failing')
    const all = JSON.stringify(v) + JSON.stringify(book.list(end))
    for (const secret of ['sk_live', 'hunter2', 'SECRETTOKEN', 'secret=abc', 'SELECT', '?token'])
      expect(all).not.toContain(secret)
    expect(book.list(end)[0].culprits[0].page).toBe('/collections/deployment_part_types/:id')
    expect(v.detail).toContain('Unit Types record')
    inflightEnd(req)
    resetInflight()
  })

  it('says when no request was running through the stall', () => {
    const book = new StallBook(() => [])
    book.noteLag(3_000, T0 + 3 * MIN)
    const now = T0 + 6 * MIN
    const v = judgeEventLoop([stalledNode(book, now)], { breach_minutes: 2 }, LABELS)
    expect(v.detail.split('\n')[1]).toMatch(
      /^No request was running on prod · web-2 during its 3 s stall — likely background work/
    )
  })

  it('leads the notice with the cause and keeps it under 500 characters', () => {
    const { book, end } = productionStall()
    book.noteLag(61_000, end)
    const v = judgeEventLoop([stalledNode(book, T0 + 6 * MIN)], { breach_minutes: 2 }, LABELS)
    const text = noticeText(v.detail, v.causes)
    expect(text.startsWith('Most likely cause: GET resolve-paths on Unit Types')).toBe(true)
    expect(text.length).toBeLessThanOrEqual(500)
    expect(causeFromDetail(v.detail)).toBe(text.split('\n')[0])
  })

  it('trims stored causes until they fit the state column', () => {
    const { book, end } = productionStall()
    book.noteLag(61_000, end)
    const v = judgeEventLoop([stalledNode(book, T0 + 6 * MIN)], { breach_minutes: 2 }, LABELS)
    const node0 = v.causes?.nodes[0] as any
    const fat = {
      headline: v.causes?.headline ?? null,
      nodes: Array.from({ length: 3 }, (_, i) => ({
        ...node0,
        node: `n${i}`,
        culprits: Array.from({ length: 5 }, () => ({
          ...node0.culprits[0],
          sentence: 'x'.repeat(600)
        }))
      }))
    }
    const kept = causesForState(fat)
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(6000)
    expect(kept?.headline).toBe(fat.headline)
  })
})

describe('SignalBook.noteLag over a long stall', () => {
  afterEach(() => vi.useRealTimers())
  it('marks every minute a 61 s stall covered', () => {
    const b = new SignalBook(T0)
    b.noteLag(61_000, T0 + 2 * MIN + 20_000) // blocked from 1:19 to 2:20
    const s = b.summary(T0 + 3 * MIN + 1000)
    expect(s.lag[1]).toBe(61_000) // the minute it ended in
    expect(s.lag[2]).toBe(41_000) // 41 s of the minute before were blocked
    expect(s.lag[3]).toBe(-1)
  })
})

describe('words', () => {
  it('formats durations, actions and screens', () => {
    expect(fmtStallMs(850)).toBe('850 ms')
    expect(fmtStallMs(1200)).toBe('1.2 s')
    expect(fmtStallMs(63_000)).toBe('63 s')
    expect(fmtStallMs(125_000)).toBe('2 min 5 s')
    expect(routeAction('/api/items/:collection/resolve-paths')).toBe('resolve-paths')
    expect(routeAction('/api/presence/online')).toBe('online')
    expect(routeAction('/api/:x')).toBe('request')
    expect(pageWords('/collections/deployment_part_types', LABELS)).toBe('Unit Types list')
    expect(pageWords('/collections/deployment_part_types/:id', LABELS)).toBe('Unit Types record')
    expect(pageWords('/health/monitors', LABELS)).toBe('Health › Monitors')
    expect(pageWords('/', LABELS)).toBe('Home')
  })
})
