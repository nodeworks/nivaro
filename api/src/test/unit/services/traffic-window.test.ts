// api/src/test/unit/services/traffic-window.test.ts — #1160 / #1128 / #1159 / #1168 pure helpers
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../config.js', () => ({
  config: {
    PUBLIC_URL: 'http://localhost:3055',
    ADMIN_URL: 'http://localhost:3056',
    DB_HOST: 'db.internal'
  }
}))

import { entityMatcher } from '../../../services/traffic-ai.js'
import { digestFacts, digestSectionOf } from '../../../services/traffic-digest.js'
import type { HistoryRow } from '../../../services/traffic-history.js'
import {
  callerFilter,
  hostOf,
  planReplay,
  replayableQuery,
  replayRefusal
} from '../../../services/traffic-replay.js'
import { compareWindows, summarizeWindow, validWindow } from '../../../services/traffic-window.js'

const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, s))
const row = (over: Partial<HistoryRow> = {}): HistoryRow => ({
  method: 'GET',
  path: '/api/items/workflows',
  status: 200,
  latency_ms: 50,
  auth: 'session',
  api_key_id: null,
  user: 'u1',
  graphql_operation: null,
  graphql_kind: null,
  created_at: at(0),
  ...over
})

describe('summarizeWindow', () => {
  it('classifies like the live map and counts callers', () => {
    const w = summarizeWindow(
      [
        row(),
        row({ status: 500 }),
        row({ method: 'PATCH', path: '/api/items/workflows/3' }),
        row({ path: '/api/items/forecasts', auth: 'api_key', api_key_id: 4, user: 'x' }),
        row({ path: '/not-api' })
      ],
      at(0),
      at(60)
    )
    expect(w.totals).toMatchObject({ req: 4, read: 2, write: 1, error: 1 })
    expect(w.entities[0]).toMatchObject({ key: 'items/workflows', req: 3, error: 1, write: 1 })
    expect(w.entities[0].callers).toEqual([{ key: 'uU1', n: 3 }])
    expect(w.callers.map((c) => c.key)).toEqual(['uU1', 'k4'])
    expect(w.callers[1].top).toEqual([{ key: 'items/forecasts', n: 1 }])
  })
  it('weights grouped rows by n and skips their latency', () => {
    const w = summarizeWindow(
      [{ ...row({ latency_ms: null as unknown as number }), n: 40 } as HistoryRow],
      at(0),
      at(60)
    )
    expect(w.totals.req).toBe(40)
    expect(w.entities[0].p95).toBe(0)
  })
})

describe('compareWindows', () => {
  it('normalises to requests per minute and flags one-sided entities', () => {
    const a = summarizeWindow([row(), row(), row({ path: '/api/items/a' })], at(0), at(60))
    const b = summarizeWindow(
      [row(), row(), row(), row(), row({ path: '/api/items/b' })],
      at(0),
      new Date(at(0).getTime() + 120_000)
    )
    const rows = compareWindows(a, b)
    const wf = rows.find((r) => r.key === 'items/workflows')
    expect(wf).toMatchObject({ a_rpm: 2, b_rpm: 2, delta_rpm: 0, delta_pct: 0, only: null })
    expect(rows.find((r) => r.key === 'items/a')?.only).toBe('a')
    expect(rows.find((r) => r.key === 'items/b')).toMatchObject({ only: 'b', delta_pct: null })
  })
  it('validWindow', () => {
    const now = at(0).getTime()
    expect(validWindow(null, at(1), now)).toMatch(/ISO/)
    expect(validWindow(at(5), at(1), now)).toMatch(/before/)
    expect(validWindow(at(0), new Date(now + 25 * 3600_000), now)).toMatch(/24 hours/)
    expect(
      validWindow(new Date(now - 20 * 86_400_000), new Date(now - 19 * 86_400_000), now)
    ).toMatch(/14 days/)
    expect(validWindow(at(0), at(30), now)).toBeNull()
  })
})

describe('digest', () => {
  const day = summarizeWindow(
    [
      row(),
      row({ status: 500 }),
      row({ user: 'new1' }),
      row({ path: '/api/items/forecasts', auth: 'api_key', api_key_id: 7, user: null })
    ],
    at(0),
    at(60)
  )
  it('top, new, hot spots and silent integrations', () => {
    const prior = new Map([
      ['uU1', 100],
      ['k7', 5],
      ['k9', 40],
      ['uPERSON', 3]
    ])
    const f = digestFacts(day, prior, new Set(['k7', 'k9']))
    expect(f.top.map((c) => c.key)).toEqual(['uU1', 'uNEW1', 'k7'])
    expect(f.fresh.map((c) => c.key)).toEqual(['uNEW1'])
    expect(f.hotSpots).toEqual([{ key: 'items/workflows', req: 3, error: 1, pct: 33 }])
    expect(f.silent).toEqual([{ key: 'k9', priorReq: 40 }]) // a person going quiet is not news
    const s = digestSectionOf(f, { uU1: 'Ana', k9: 'Fusion IIP' })
    expect(s?.title).toBe('Traffic in the last day')
    expect(s?.lines.map((l) => l.text).join('\n')).toMatch(/Busiest callers: Ana \(2\)/)
    expect(s?.lines.at(-1)?.text).toMatch(/Silent integrations: Fusion IIP \(40 calls/)
  })
  it('nothing to say = no section', () => {
    const empty = summarizeWindow([], at(0), at(60))
    expect(digestSectionOf(digestFacts(empty, new Map(), new Set()), {})).toBeNull()
  })
})

describe('replay guard and plan', () => {
  const shared = [
    'http://localhost:3055',
    'http://localhost:3056',
    'db.internal',
    'https://staging.example.com'
  ]
  it('refuses outside development and against shared hosts', () => {
    expect(
      replayRefusal('http://localhost:3116', { nodeEnv: 'production', sharedHosts: shared })
    ).toMatch(/development/)
    expect(
      replayRefusal('http://localhost:3055', { nodeEnv: 'development', sharedHosts: shared })
    ).toMatch(/shared host/)
    expect(
      replayRefusal('https://staging.example.com/x', {
        nodeEnv: 'development',
        sharedHosts: shared
      })
    ).toMatch(/shared host/)
    expect(
      replayRefusal('http://db.internal:9000', { nodeEnv: 'development', sharedHosts: shared })
    ).toMatch(/shared host/)
    expect(replayRefusal('ftp://x', { nodeEnv: 'development', sharedHosts: shared })).toMatch(
      /http/
    )
    expect(replayRefusal('nope', { nodeEnv: 'development', sharedHosts: shared })).toMatch(/URL/)
    expect(
      replayRefusal('http://localhost:3116', { nodeEnv: 'development', sharedHosts: shared })
    ).toBeNull()
  })
  it('hostOf', () => {
    expect(hostOf('http://Localhost:3055/x')).toBe('localhost:3055')
    expect(hostOf('db.internal')).toBe('db.internal')
    expect(hostOf('')).toBeNull()
  })
  it('samples evenly, keeps original spacing divided by the multiplier', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      path: `/api/items/a/${i}`,
      query: i === 2 ? 'token=••••••' : i === 4 ? 'fields=id' : null,
      created_at: at(i * 2)
    }))
    const plan = planReplay(rows.reverse(), {
      sample: 5,
      multiplier: 2,
      base: 'http://localhost:3116/'
    })
    expect(plan.map((s) => s.at)).toEqual([0, 2000, 4000, 6000, 8000])
    expect(plan[1].url).toBe('http://localhost:3116/api/items/a/2') // masked query dropped
    expect(plan[2].url).toBe('http://localhost:3116/api/items/a/4?fields=id')
    expect(planReplay([], { sample: 5, multiplier: 1, base: 'x' })).toEqual([])
  })
  it('replayable queries and caller filters', () => {
    expect(replayableQuery('a=1…')).toBeNull()
    expect(replayableQuery('a=1')).toBe('a=1')
    expect(callerFilter('k12')).toEqual({ api_key_id: 12 })
    expect(callerFilter('u3FA85F64-5717-4562-B3FC-2C963F66AFA6')).toEqual({
      user: '3FA85F64-5717-4562-B3FC-2C963F66AFA6'
    })
    expect(callerFilter('cron')).toBeNull()
  })
})

describe('AI tool entity matcher', () => {
  it('matches a bare name or a full key', () => {
    const m = entityMatcher('Forecasts')
    expect(m?.('items/forecasts')).toBe(true)
    expect(m?.('items/forecasts_x')).toBe(false)
    expect(entityMatcher('items/forecasts')?.('items/forecasts')).toBe(true)
    expect(entityMatcher('')).toBeNull()
  })
})
