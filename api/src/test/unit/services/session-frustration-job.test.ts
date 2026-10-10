import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({
  db: Object.assign(vi.fn(), { transaction: vi.fn(), raw: vi.fn() })
}))

import { db } from '../../../db/index.js'
import { frustrationForDay, runFrustrationScoring } from '../../../services/session-frustration.js'

type Calls = Array<[string, unknown[]]>

function chain(rows: unknown[], first?: unknown) {
  const calls: Calls = []
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          const p = Promise.resolve(rows)
          return p.then.bind(p)
        }
        if (prop === 'first')
          return (...a: unknown[]) => {
            calls.push(['first', a])
            return Promise.resolve(first)
          }
        return (...a: unknown[]) => {
          calls.push([prop, a])
          return proxy
        }
      }
    }
  )
  return { proxy, calls }
}

const USER = '7A0411F3-C687-40E5-ADF5-614157CF88EC'
const REC = '264BEE7B-87D3-4452-81C9-CE6FBF672DE5'

afterEach(() => vi.clearAllMocks())

describe('runFrustrationScoring', () => {
  it('rescores the last two UTC days from every source and replaces those days', async () => {
    const tables = {
      nivaro_admin_journeys: chain([
        {
          session_id: 'sock-1',
          user: USER,
          path: '/queues',
          entered_at: new Date('2026-10-09T10:00:00.000Z'),
          duration_seconds: 120
        }
      ]),
      nivaro_rum_events: chain([
        { user: USER.toLowerCase(), kind: 'rage', created_at: new Date('2026-10-09T10:01:00.000Z') }
      ]),
      nivaro_issues: chain([
        {
          raised_by: USER,
          created_at: new Date('2026-09-01T00:00:00.000Z'),
          last_seen_at: new Date('2026-10-09T10:01:30.000Z')
        }
      ]),
      nivaro_api_logs: chain([]),
      nivaro_session_recordings: chain([
        {
          id: REC,
          user: USER,
          started_at: new Date('2026-10-09T09:59:00.000Z'),
          ended_at: null,
          last_event_at: new Date('2026-10-09T10:30:00.000Z')
        }
      ]),
      nivaro_settings: chain([], { frustration_weights: null }),
      nivaro_session_scores: chain([])
    }
    const fn = ((t: keyof typeof tables) => tables[t].proxy) as never
    vi.mocked(db).mockImplementation(fn)
    vi.mocked(db.transaction).mockImplementation((async (cb: (trx: unknown) => unknown) =>
      cb(fn)) as never)

    const now = new Date('2026-10-10T02:25:00.000Z')
    const summary = await runFrustrationScoring({ now })
    expect(summary).toBe('1 session(s) scored over 2026-10-09, 2026-10-10 (1 above zero)')

    const sc = tables.nivaro_session_scores.calls
    expect(sc).toContainEqual(['whereIn', ['day', ['2026-10-09', '2026-10-10']]])
    const insert = sc.find(([m]) => m === 'insert')?.[1][0] as Array<Record<string, unknown>>
    expect(insert).toHaveLength(1)
    expect(insert[0]).toMatchObject({
      session_id: 'sock-1',
      user: USER,
      day: '2026-10-09',
      top_route: '/queues',
      recording_id: REC
    })
    const comp = JSON.parse(insert[0].components as string)
    expect(comp.counts).toMatchObject({ rage_clicks: 1, client_errors: 1 })
    expect(insert[0].score).toBe(Math.round(100 * (1 - Math.exp(-(6 + 8) / 25))))
    // Retention: 90 days of scores.
    expect(sc).toContainEqual(['where', ['day', '<', '2026-07-12']])
    // The window starts at UTC midnight of yesterday.
    expect(tables.nivaro_admin_journeys.calls).toContainEqual([
      'where',
      ['entered_at', '>=', new Date('2026-10-09T00:00:00.000Z')]
    ])
  })

  it('a missing source loses its component, not the run', async () => {
    const tables: Record<string, { proxy: unknown }> = {
      nivaro_admin_journeys: chain([
        {
          session_id: 's',
          user: USER,
          path: '/x',
          entered_at: new Date('2026-10-10T01:00:00.000Z'),
          duration_seconds: 5
        }
      ]),
      nivaro_settings: chain([], undefined),
      nivaro_session_scores: chain([]),
      nivaro_session_recordings: chain([])
    }
    vi.mocked(db).mockImplementation(((t: string) => {
      if (t === 'nivaro_rum_events' || t === 'nivaro_issues' || t === 'nivaro_api_logs')
        throw new Error('no such table')
      return tables[t].proxy
    }) as never)
    vi.mocked(db.transaction).mockImplementation((async (cb: (trx: unknown) => unknown) =>
      cb((t: string) => tables[t].proxy)) as never)
    const summary = await runFrustrationScoring({ now: new Date('2026-10-10T02:00:00.000Z') })
    expect(summary).toMatch(/^1 session\(s\) scored/)
  })
})

describe('frustrationForDay', () => {
  it('answers the worst overlapping session and the count, or null', async () => {
    const scores = chain([
      {
        session_id: 'a',
        day: '2026-10-09',
        session_start: new Date('2026-10-09T10:00:00.000Z'),
        session_end: new Date('2026-10-09T11:00:00.000Z'),
        score: 70,
        components: '{"counts":{"loops":2}}',
        top_route: '/queues',
        recording_id: REC
      },
      { session_id: 'b', score: 10 }
    ])
    vi.mocked(db).mockImplementation(((t: string) =>
      t === 'nivaro_session_scores' ? scores.proxy : chain([]).proxy) as never)
    const start = new Date('2026-10-09T04:00:00.000Z')
    const end = new Date('2026-10-10T04:00:00.000Z')
    const f = await frustrationForDay(USER, start, end)
    expect(f).toMatchObject({
      score: 70,
      sessions: 2,
      worst: { session_id: 'a', components: { counts: { loops: 2 } }, recording_id: null }
    })
    expect(scores.calls).toContainEqual(['where', ['session_start', '<', end]])
    expect(scores.calls).toContainEqual(['where', ['session_end', '>=', start]])

    vi.mocked(db).mockImplementation((() => chain([]).proxy) as never)
    expect(await frustrationForDay(USER, start, end)).toBeNull()
  })
})
