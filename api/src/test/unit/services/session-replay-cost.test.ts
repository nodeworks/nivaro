import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Recording cost (#1368): route attribution, sampling rules, the daily cap and
 * the per-day counters.
 */

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  daily: null as Record<string, unknown> | null,
  updates: [] as Array<{ table: string; where: unknown; set: Record<string, unknown> }>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  updateResult: 1,
  failWrites: false
}))

vi.mock('../../../db/index.js', () => {
  const db = vi.fn((table: string) => {
    let where: unknown = null
    const chain: Record<string, unknown> = {}
    chain.where = vi.fn((w: unknown) => {
      where = w
      return chain
    })
    chain.first = vi.fn(async () => (table === 'nivaro_settings' ? h.settings : h.daily))
    chain.update = vi.fn(async (set: Record<string, unknown>) => {
      if (h.failWrites) throw new Error('db down')
      h.updates.push({ table, where, set })
      return h.updateResult
    })
    chain.insert = vi.fn(async (row: Record<string, unknown>) => {
      if (h.failWrites) throw new Error('db down')
      h.inserts.push({ table, row })
      return [1]
    })
    return chain
  })
  ;(db as unknown as Record<string, unknown>).raw = vi.fn((sql: string, b?: unknown[]) => ({
    sql,
    b
  }))
  return { db }
})

import {
  chunkMeta,
  dailyCapStatus,
  flushReplayUsage,
  noteChunk,
  parseReplaySampling,
  resetReplayCostState,
  samplingRateFor,
  sanitizeReplayBuild,
  sanitizeReplayRoute,
  validateDailyCapMb,
  validateReplaySampling
} from '../../../services/session-replay-cost.js'

const NOW = new Date('2026-10-10T12:00:00Z')
const MB = 1_048_576

beforeEach(() => {
  resetReplayCostState()
  h.settings = {}
  h.daily = null
  h.updates = []
  h.inserts = []
  h.updateResult = 1
  h.failWrites = false
})

describe('route attribution', () => {
  it('keeps a route pattern and turns id-shaped segments into :id', () => {
    expect(sanitizeReplayRoute('/content/orders/:id')).toBe('/content/orders/:id')
    expect(sanitizeReplayRoute('/content/Orders/1042?tab=x')).toBe('/content/orders/:id')
    expect(
      sanitizeReplayRoute('/users/jane@example.com/6f1c2b3a-1234-4abc-9def-0123456789ab')
    ).toBe('/users/:id')
    expect(sanitizeReplayRoute('content/orders')).toBe('')
    expect(sanitizeReplayRoute(42)).toBe('')
    expect(sanitizeReplayRoute(`/${'a'.repeat(30)}/`.repeat(20)).length).toBeLessThanOrEqual(140)
  })

  it('reads route, build and retries off an events body', () => {
    expect(
      chunkMeta({ seq: 1, events: [], route: '/home/7', build: '0.2.35', retries: 3 })
    ).toEqual({ route: '/home/:id', build: '0.2.35', retries: 3 })
    expect(chunkMeta({ build: 'bad build!', retries: -2 })).toEqual({
      route: '',
      build: '',
      retries: 0
    })
    expect(sanitizeReplayBuild('nivaro-react@0.2.26')).toBe('nivaro-react@0.2.26')
  })
})

describe('sampling rules', () => {
  it('parses shares per route and falls back to recording everything', () => {
    expect(parseReplaySampling(null)).toEqual({ default: 1, routes: {} })
    expect(
      parseReplaySampling(
        '{"default":0.5,"routes":{"/Reports/*":0,"/content/orders/12":0.25,"x":1}}'
      )
    ).toEqual({ default: 0.5, routes: { '/reports/*': 0, '/content/orders/:id': 0.25 } })
  })

  it('picks the exact pattern, then the longest prefix, then the default', () => {
    const s = parseReplaySampling({
      default: 0.5,
      routes: { '/reports/*': 0, '/reports/daily/*': 1, '/content/orders/:id': 0.25 }
    })
    expect(samplingRateFor(s, '/content/orders/:id')).toBe(0.25)
    expect(samplingRateFor(s, '/reports/daily/x')).toBe(1)
    expect(samplingRateFor(s, '/reports')).toBe(0)
    expect(samplingRateFor(s, '/home')).toBe(0.5)
  })

  it('validates a settings patch', () => {
    expect(validateReplaySampling({ default: 1.5 })).toHaveProperty('error')
    expect(validateReplaySampling({ routes: { '/x': 'half' } })).toHaveProperty('error')
    expect(validateReplaySampling({ routes: { nope: 1 } })).toHaveProperty('error')
    expect(validateReplaySampling({ default: 0.2, routes: { '/x/*': 0 } })).toEqual({
      value: JSON.stringify({ default: 0.2, routes: { '/x/*': 0 } })
    })
    expect(validateReplaySampling(null)).toEqual({ value: null })
  })

  it('validates the daily cap', () => {
    expect(validateDailyCapMb('')).toEqual({ value: null })
    expect(validateDailyCapMb(0)).toEqual({ value: null })
    expect(validateDailyCapMb('500')).toEqual({ value: 500 })
    expect(validateDailyCapMb(1.5)).toHaveProperty('error')
    expect(validateDailyCapMb(-1)).toHaveProperty('error')
  })
})

describe('counting', () => {
  const meta = { route: '/home', build: 'dev', retries: 0 }

  it('adds accepted bytes per day × route × build and outcomes per day', async () => {
    noteChunk('accepted', meta, 1000, NOW)
    noteChunk('accepted', meta, 500, NOW)
    noteChunk('accepted', { ...meta, route: '/reports' }, 200, NOW)
    noteChunk('duplicate', meta, 0, NOW)
    noteChunk('too_large', { ...meta, retries: 2 }, 0, NOW)
    await flushReplayUsage()
    const daily = h.updates.find((u) => u.table === 'nivaro_session_replay_daily')!
    expect(daily.where).toEqual({ day: '2026-10-10' })
    expect(daily.set).toMatchObject({
      accepted: { sql: 'accepted + ?', b: [3] },
      duplicates: { sql: 'duplicates + ?', b: [1] },
      rejected_too_large: { sql: 'rejected_too_large + ?', b: [1] },
      client_failures: { sql: 'client_failures + ?', b: [2] },
      bytes: { sql: 'bytes + ?', b: [1700] }
    })
    // zero deltas are not written
    expect(daily.set).not.toHaveProperty('rejected_closed')
    const usage = h.updates.filter((u) => u.table === 'nivaro_session_replay_usage')
    expect(usage.map((u) => [u.where, u.set.bytes, u.set.chunks])).toEqual([
      [
        { day: '2026-10-10', route: '/home', build: 'dev' },
        { sql: 'bytes + ?', b: [1500] },
        { sql: 'chunks + ?', b: [2] }
      ],
      [
        { day: '2026-10-10', route: '/reports', build: 'dev' },
        { sql: 'bytes + ?', b: [200] },
        { sql: 'chunks + ?', b: [1] }
      ]
    ])
  })

  it('inserts the row when the day has none yet', async () => {
    h.updateResult = 0
    noteChunk('accepted', meta, 10, NOW)
    await flushReplayUsage()
    expect(h.inserts.map((i) => i.table)).toEqual([
      'nivaro_session_replay_daily',
      'nivaro_session_replay_usage'
    ])
    expect(h.inserts[1].row).toEqual({
      day: '2026-10-10',
      route: '/home',
      build: 'dev',
      bytes: 10,
      chunks: 1
    })
  })

  it('keeps the counts for the next flush when the write fails', async () => {
    noteChunk('accepted', meta, 10, NOW)
    h.failWrites = true
    await flushReplayUsage()
    h.failWrites = false
    noteChunk('accepted', meta, 5, NOW)
    await flushReplayUsage()
    const daily = h.updates.find((u) => u.table === 'nivaro_session_replay_daily')!
    expect(daily.set.bytes).toEqual({ sql: 'bytes + ?', b: [15] })
  })
})

describe('daily cap', () => {
  it('is never reached without a cap', async () => {
    h.daily = { bytes: 10 * MB }
    expect(await dailyCapStatus(NOW)).toEqual({ cap_bytes: null, used_bytes: 0, reached: false })
  })

  it('counts stored bytes plus what this replica has not flushed yet', async () => {
    h.settings = { replay_daily_cap_mb: 2 }
    h.daily = { bytes: MB, cap_hit_at: null }
    expect((await dailyCapStatus(NOW)).reached).toBe(false)
    noteChunk('accepted', { route: '/home', build: '', retries: 0 }, MB, NOW)
    const s = await dailyCapStatus(NOW)
    expect(s).toEqual({ cap_bytes: 2 * MB, used_bytes: 2 * MB, reached: true })
  })

  it('stamps cap_hit_at on the day the first time the cap is reached', async () => {
    h.settings = { replay_daily_cap_mb: 1 }
    h.daily = { bytes: 2 * MB, cap_hit_at: null }
    expect((await dailyCapStatus(NOW)).reached).toBe(true)
    await flushReplayUsage()
    const daily = h.updates.find((u) => u.table === 'nivaro_session_replay_daily')!
    expect(daily.set.cap_hit_at).toEqual({ sql: 'COALESCE(cap_hit_at, ?)', b: [NOW] })
  })
})
