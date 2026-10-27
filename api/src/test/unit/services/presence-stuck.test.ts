import { beforeEach, describe, expect, it, vi } from 'vitest'

// knex-shaped fake: records builder calls per table, resolves queued rows.
const state = vi.hoisted(() => ({
  calls: [] as Array<[string, string, unknown[]]>,
  rows: new Map<string, unknown[][]>()
}))

function chain(table: string): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          const rows = (state.rows.get(table) ?? []).shift() ?? []
          return (res: (v: unknown) => void) => res(rows)
        }
        return (...args: unknown[]) => {
          state.calls.push([table, prop, args])
          if (typeof args[0] === 'function') (args[0] as (q: unknown) => void)(proxy)
          return proxy
        }
      }
    }
  )
  return proxy
}

vi.mock('../../../db/index.js', () => ({ db: (t: string) => chain(t) }))

import {
  classifyPresence,
  isChangeRequest,
  isRecordPagePath,
  lastSearchChange,
  presenceRowIdle,
  STUCK_AFTER_MS,
  stuckLabel,
  stuckMinutes
} from '../../../services/presence-stuck.js'

const NOW = Date.parse('2026-10-10T12:00:00Z')
const min = (m: number) => NOW - m * 60_000

beforeEach(() => {
  state.calls = []
  state.rows = new Map()
})

describe('classifyPresence', () => {
  it('idle wins over everything', () => {
    expect(
      classifyPresence({
        now: NOW,
        idle: true,
        lastActive: min(1),
        routeSince: min(30),
        lastChangeAt: null
      }).state
    ).toBe('idle')
  })

  it('is stuck: input in the last 5m, same route and no change for 10m', () => {
    expect(
      classifyPresence({
        now: NOW,
        idle: false,
        lastActive: min(1),
        routeSince: min(12),
        lastChangeAt: min(20)
      })
    ).toEqual({ state: 'stuck', stuck_minutes: 12 })
    // minutes count from the later of the route change and the last save
    expect(
      classifyPresence({
        now: NOW,
        idle: false,
        lastActive: min(0),
        routeSince: min(40),
        lastChangeAt: min(15)
      })
    ).toEqual({ state: 'stuck', stuck_minutes: 15 })
  })

  it('is active when something moved within ten minutes', () => {
    const base = { now: NOW, idle: false, lastActive: min(1) }
    expect(classifyPresence({ ...base, routeSince: min(9), lastChangeAt: null }).state).toBe(
      'active'
    )
    expect(classifyPresence({ ...base, routeSince: min(30), lastChangeAt: min(3) }).state).toBe(
      'active'
    )
    expect(classifyPresence({ ...base, routeSince: null, lastChangeAt: null }).state).toBe('active')
  })

  it('needs input in the last five minutes (no input → not stuck)', () => {
    expect(
      classifyPresence({
        now: NOW,
        idle: false,
        lastActive: min(6),
        routeSince: min(30),
        lastChangeAt: null
      }).state
    ).toBe('active')
    expect(
      classifyPresence({
        now: NOW,
        idle: false,
        lastActive: null,
        routeSince: min(30),
        lastChangeAt: null
      }).state
    ).toBe('active')
  })
})

describe('what counts as changing something', () => {
  it('is a successful write that is not the page talking to itself', () => {
    expect(isChangeRequest('PATCH', '/api/items/orders/5', 200)).toBe(true)
    expect(isChangeRequest('POST', '/api/workflows/transition', 204)).toBe(true)
    expect(isChangeRequest('GET', '/api/items/orders', 200)).toBe(false)
    expect(isChangeRequest('PATCH', '/api/items/orders/5', 422)).toBe(false)
    expect(isChangeRequest('PATCH', '/api/items/user_presence/9', 200)).toBe(false)
    expect(isChangeRequest('POST', '/api/session-recordings/x/events', 200)).toBe(false)
    expect(isChangeRequest('POST', '/api/rum', 200)).toBe(false)
  })
})

describe('presenceRowIdle', () => {
  it('weighs the client flag against last_active', () => {
    const fresh = new Date(NOW - 60_000).toISOString()
    const stale = new Date(NOW - 6 * 60_000).toISOString()
    expect(presenceRowIdle({ is_idle: false, last_active: fresh }, false, NOW)).toBe(false)
    expect(presenceRowIdle({ is_idle: false, last_active: stale }, false, NOW)).toBe(true)
    expect(presenceRowIdle({ is_idle: true, last_active: fresh }, false, NOW)).toBe(false)
    expect(presenceRowIdle({ is_idle: 1 }, false, NOW)).toBe(true)
    expect(presenceRowIdle({ is_idle: false, last_active: fresh }, true, NOW)).toBe(true)
  })
})

describe('stuckMinutes', () => {
  it('reads routes for active people only, requests for candidates only', async () => {
    state.rows.set('nivaro_admin_journeys', [
      [
        { user: 'aaaa', since: new Date(min(14)) },
        { user: 'BBBB', since: new Date(min(3)) }
      ],
      [{ user: 'aaaa', path: '/records/orders/5', entered_at: new Date(min(14)) }]
    ])
    state.rows.set('nivaro_api_logs', [[{ user: 'AAAA', at: new Date(min(11)) }], []])
    const out = await stuckMinutes(
      [
        { id: 'AAAA', idle: false, lastActive: min(1) },
        { id: 'BBBB', idle: false, lastActive: min(1) },
        { id: 'CCCC', idle: true, lastActive: min(1) },
        { id: 'DDDD', idle: false, lastActive: min(9) }
      ],
      NOW
    )
    expect([...out]).toEqual([['AAAA', 11]])
    const journeyIds = state.calls.find(
      ([t, m]) => t === 'nivaro_admin_journeys' && m === 'whereIn'
    )
    expect(journeyIds?.[2]).toEqual(['user', ['AAAA', 'BBBB']])
    const logIds = state.calls.find(
      ([t, m, a]) => t === 'nivaro_api_logs' && m === 'whereIn' && a[0] === 'user'
    )
    expect(logIds?.[2]).toEqual(['user', ['AAAA']])
    // background writes are excluded in SQL
    expect(state.calls).toContainEqual([
      'nivaro_api_logs',
      'whereNot',
      ['path', 'like', '/api/items/user_presence%']
    ])
  })

  it('skips the request read when nobody has sat on a route for ten minutes', async () => {
    state.rows.set('nivaro_admin_journeys', [
      [{ user: 'AAAA', since: new Date(NOW - STUCK_AFTER_MS + 1) }]
    ])
    const out = await stuckMinutes([{ id: 'AAAA', idle: false, lastActive: min(1) }], NOW)
    expect(out.size).toBe(0)
    expect(state.calls.some(([t]) => t === 'nivaro_api_logs')).toBe(false)
  })

  it('never flags a list page — reading and filtering there is the work', async () => {
    state.rows.set('nivaro_admin_journeys', [
      [{ user: 'AAAA', since: new Date(min(30)) }],
      [{ user: 'AAAA', path: '/records/workflows', entered_at: new Date(min(30)) }]
    ])
    const out = await stuckMinutes([{ id: 'AAAA', idle: false, lastActive: min(1) }], NOW)
    expect(out.size).toBe(0)
    expect(state.calls.some(([t]) => t === 'nivaro_api_logs')).toBe(false)
  })

  it('judges the newest page when the person moved since the oldest arrival read', async () => {
    state.rows.set('nivaro_admin_journeys', [
      [
        { user: 'AAAA', since: new Date(min(20)) },
        { user: 'BBBB', since: new Date(min(15)) }
      ],
      [
        { user: 'AAAA', path: '/records/orders/5', entered_at: new Date(min(20)) },
        { user: 'BBBB', path: '/records/orders', entered_at: new Date(min(15)) }
      ]
    ])
    state.rows.set('nivaro_api_logs', [[], []])
    const out = await stuckMinutes(
      [
        { id: 'AAAA', idle: false, lastActive: min(1) },
        { id: 'BBBB', idle: false, lastActive: min(1) }
      ],
      NOW
    )
    expect([...out]).toEqual([['AAAA', 20]])
  })

  it('a new search or filter on the record page is progress; a re-poll is not', async () => {
    const journeys = () => [
      [{ user: 'AAAA', since: new Date(min(30)) }],
      [{ user: 'AAAA', path: '/collections/orders/5', entered_at: new Date(min(30)) }]
    ]
    const poll = [0, 10, 20].map((m) => ({
      user: 'AAAA',
      path: '/api/items/order_lines',
      query: 'filter=%7B%22order%22%3A5%7D',
      created_at: new Date(min(30) + m * 60_000 + 2_000)
    }))
    state.rows.set('nivaro_admin_journeys', journeys())
    state.rows.set('nivaro_api_logs', [[], poll])
    expect([
      ...(await stuckMinutes([{ id: 'AAAA', idle: false, lastActive: min(1) }], NOW))
    ]).toEqual([['AAAA', 30]])

    state.rows.set('nivaro_admin_journeys', journeys())
    state.rows.set('nivaro_api_logs', [
      [],
      [
        ...poll,
        {
          user: 'AAAA',
          path: '/api/items/vendors',
          query: 'search=acme',
          created_at: new Date(min(4))
        }
      ]
    ])
    expect((await stuckMinutes([{ id: 'AAAA', idle: false, lastActive: min(1) }], NOW)).size).toBe(
      0
    )
  })
})

describe('isRecordPagePath', () => {
  it('is a record page or a new-record form in either app', () => {
    expect(isRecordPagePath('/records/workflows/123')).toBe(true)
    expect(isRecordPagePath('/collections/orders/new')).toBe(true)
    expect(isRecordPagePath('/records/workflows')).toBe(false)
    expect(isRecordPagePath('/records/workflows?search=x')).toBe(false)
    expect(isRecordPagePath('/queues/4')).toBe(false)
    expect(isRecordPagePath(null)).toBe(false)
  })
})

describe('lastSearchChange', () => {
  const start = min(30)
  const row = (path: string, query: string | null, at: number) => ({ path, query, at })
  it('ignores the page load and repeats, keeps the newest new query', () => {
    expect(
      lastSearchChange(
        [
          row('/api/items/a', 'filter=1', start + 1_000),
          row('/api/items/a', 'filter=1', min(20)),
          row('/api/items/b', 'search=x', min(15)),
          row('/api/items/b', 'search=xy', min(14)),
          row('/api/items/a', 'filter=1', min(2))
        ],
        start
      )
    ).toBe(min(14))
    expect(lastSearchChange([row('/api/items/a', 'filter=1', start + 1_000)], start)).toBeNull()
    expect(lastSearchChange([row('/api/items/a', 'filter=1', start - 1_000)], start)).toBeNull()
  })
})

describe('stuckLabel', () => {
  it('names the record by its friendly id, else the page text the presence line shows', () => {
    const labels = new Map([['claims:42', 'CM26-80332']])
    expect(stuckLabel('/records/claims/42?tab=2', labels)).toBe('CM26-80332')
    expect(stuckLabel('/collections/claims/7', labels)).toBe('Claims')
    expect(stuckLabel('/records/workflows/new', labels)).toBe('Workflows › New')
    expect(stuckLabel('/portal/upload/', labels)).toBe('Portal')
    expect(stuckLabel(null, labels)).toBeNull()
  })
})
