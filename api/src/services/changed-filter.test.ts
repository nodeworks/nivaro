import knex from 'knex'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const k = knex({ client: 'mssql' })
const state = vi.hoisted(() => ({
  rows: [] as Array<{ item: unknown }>,
  keyType: 'integer' as string | null,
  prefs: null as unknown,
  written: null as unknown
}))

vi.mock('../db/index.js', async () => {
  const real = (await import('knex')).default({ client: 'mssql' })
  const db = ((table: string) => {
    if (table === 'nivaro_users') {
      return {
        where: () => ({
          first: async () => ({ preferences: state.prefs }),
          update: async (v: { preferences: string }) => {
            state.written = JSON.parse(v.preferences)
            return 1
          }
        })
      }
    }
    // The window read: answer the queued rows whatever the query says.
    const qb = real(table)
    return Object.assign(qb, {
      // biome-ignore lint/suspicious/noThenProperty: a thenable query builder stand-in
      then: (res: (v: unknown) => unknown) => Promise.resolve(state.rows).then(res)
    })
  }) as unknown as Record<string, unknown>
  db.raw = real.raw.bind(real)
  return { db }
})
vi.mock('./collections.js', () => ({
  getFields: async () => [{ field: 'id', type: state.keyType }]
}))

import {
  applyChangedFilter,
  CHANGED_ID_CAP,
  CHANGED_MAX_SPAN_MS,
  changedIdsQuery,
  changedItemIds,
  idsForKey,
  markViewOpened,
  parseChangedFilter,
  parseViewOpened,
  resolveChangedCondition,
  stampViewOpened,
  VIEW_OPENED_MAX
} from './changed-filter.js'

const NOW = new Date('2026-11-14T15:00:00.000Z')
const ME = '11111111-2222-3333-4444-555555555555'

beforeEach(() => {
  state.rows = []
  state.keyType = 'integer'
  state.prefs = null
  state.written = null
})

describe('parseChangedFilter', () => {
  it('reads the rolling windows relative to now', () => {
    const cases: Array<[string, number]> = [
      ['1h', 1],
      ['24h', 24],
      ['2d', 48],
      ['5d', 120],
      ['7d', 168]
    ]
    for (const [window, hours] of cases) {
      const f = parseChangedFilter({ window }, '_eq', NOW)
      expect(f?.since.toISOString()).toBe(new Date(NOW.getTime() - hours * 3_600_000).toISOString())
      expect(f?.until).toBeNull()
      expect(f?.include).toBe(true)
      expect(f?.others).toBe(true)
    }
    expect(parseChangedFilter('1h', undefined, NOW)?.since.getTime()).toBe(
      NOW.getTime() - 3_600_000
    )
  })

  it('reads a fixed range, and NOT through the operator', () => {
    const f = parseChangedFilter(
      { since: '2026-11-12T09:00:00Z', until: '2026-11-13T17:00:00Z' },
      '_neq',
      NOW
    )
    expect(f?.since.toISOString()).toBe('2026-11-12T09:00:00.000Z')
    expect(f?.until?.toISOString()).toBe('2026-11-13T17:00:00.000Z')
    expect(f?.include).toBe(false)
  })

  it('bounds a long custom range to its newest 31 days', () => {
    const f = parseChangedFilter({ since: '2025-01-01T00:00:00Z' }, '_eq', NOW)
    expect(NOW.getTime() - (f?.since.getTime() ?? 0)).toBe(CHANGED_MAX_SPAN_MS)
  })

  it('narrows to nothing rather than widening on anything it cannot read', () => {
    expect(parseChangedFilter(null, '_eq', NOW)).toBeNull()
    expect(parseChangedFilter({ window: 'forever' }, '_eq', NOW)).toBeNull()
    expect(parseChangedFilter({ since: 'nope' }, '_eq', NOW)).toBeNull()
    expect(parseChangedFilter({ window: '24h' }, '_contains', NOW)).toBeNull()
    expect(
      parseChangedFilter({ since: '2026-11-13T00:00:00Z', until: '2026-11-12T00:00:00Z' }, '', NOW)
    ).toBeNull()
  })
})

describe('the window read', () => {
  it('is one bounded range read on (collection, action, timestamp) that leaves my writes out', () => {
    const f = parseChangedFilter({ window: '24h' }, '_eq', NOW)!
    const { sql, bindings } = changedIdsQuery(k, 'orders', f, ME).toSQL()
    expect(sql).toMatch(/select distinct top \(\?\) \[ca\]\.\[item\]/i)
    expect(sql).toMatch(/\[ca\]\.\[collection\] = \?/)
    expect(sql).toMatch(/\[ca\]\.\[action\] in \(\?, \?, \?\)/)
    expect(sql).toMatch(/\[ca\]\.\[timestamp\] >= \?/)
    expect(sql).toMatch(/\[ca\]\.\[user\] is null or not \[ca\]\.\[user\] = \?/)
    expect(bindings).toContain('orders')
    expect(bindings).toContain(ME)
    expect(bindings).toContain(CHANGED_ID_CAP + 1)
    expect(bindings).toEqual(expect.arrayContaining(['create', 'update', 'pipeline-transition']))
  })

  it('counts everyone when the reader asks for their own writes too', () => {
    const f = { ...parseChangedFilter({ window: '1h' }, '_eq', NOW)!, others: false }
    expect(changedIdsQuery(k, 'orders', f, ME).toSQL().sql).not.toMatch(/\[user\]/)
  })

  it('answers ids the key can hold, or null past the cap', async () => {
    const f = parseChangedFilter({ window: '24h' }, '_eq', NOW)!
    state.rows = [{ item: '12' }, { item: '7' }, { item: 'abc' }, { item: null }]
    expect(await changedItemIds('orders', f, ME)).toEqual(['12', '7'])
    state.rows = [{ item: '1' }, { item: '2' }, { item: '3' }]
    expect(await changedItemIds('orders', f, ME, 2)).toBeNull()
  })

  it('keeps uuid keys uuid-shaped and leaves text keys alone', () => {
    const u = 'a1b2c3d4-0000-4000-8000-123456789abc'
    expect(idsForKey([u, '12'], 'uuid')).toEqual([u])
    expect(idsForKey(['A-1', '12'], 'string')).toEqual(['A-1', '12'])
  })
})

describe('applyChangedFilter', () => {
  const f = parseChangedFilter({ window: '24h' }, '_eq', NOW)!

  it('reads the window ids by primary key', () => {
    const q = k('orders')
    applyChangedFilter(q, 'orders', f, ME, ['3', '9'])
    expect(q.toSQL().sql).toMatch(/\[orders\]\.\[id\] in \(\?, \?\)/)
  })

  it('an empty window matches nothing; NOT of it matches everything', () => {
    const q = k('orders')
    applyChangedFilter(q, 'orders', f, ME, [])
    expect(q.toSQL().sql).toMatch(/1 = 0/)
    const notQ = k('orders')
    applyChangedFilter(notQ, 'orders', { ...f, include: false }, ME, [])
    expect(notQ.toSQL().sql).not.toMatch(/where/i)
  })

  it('past the cap, an EXISTS per row on (collection, item, timestamp), my writes left out', () => {
    const q = k('orders')
    applyChangedFilter(q, 'orders', f, ME, null)
    const sql = q.toSQL().sql
    expect(sql).toMatch(/exists \(select 1 from \[nivaro_activity\] as \[ca\]/i)
    expect(sql).toMatch(/ca\.item = CAST\(\[orders\]\.\[id\] AS NVARCHAR\(255\)\)/)
    expect(sql).toMatch(/\[ca\]\.\[user\] is null or not \[ca\]\.\[user\] = \?/)
  })

  it('an unreadable filter narrows to nothing', () => {
    const q = k('orders')
    applyChangedFilter(q, 'orders', null, ME, null)
    expect(q.toSQL().sql).toMatch(/1 = 0/)
  })

  it('the page and its total share one window read', async () => {
    state.rows = [{ item: '4' }]
    const cond = { op: '_eq', value: { window: '1h' } }
    const a = await resolveChangedCondition(cond, 'orders', ME)
    state.rows = [{ item: '5' }]
    const b = await resolveChangedCondition(cond, 'orders', ME)
    expect(a.ids).toEqual(['4'])
    expect(b.ids).toEqual(['4'])
  })
})

describe('saved views: last opened', () => {
  it('keeps only well-formed entries', () => {
    expect(
      parseViewOpened({ '3': '2026-11-14T10:00:00.000Z', x: 'y', '4': 'nope', '5': 1 })
    ).toEqual({
      '3': '2026-11-14T10:00:00.000Z'
    })
    expect(parseViewOpened(null)).toEqual({})
  })

  it('stamps newest last and caps the map', () => {
    const many: Record<string, string> = {}
    for (let i = 1; i <= VIEW_OPENED_MAX; i++)
      many[String(i)] = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
    const next = stampViewOpened(many, 9999, NOW)
    expect(Object.keys(next)).toHaveLength(VIEW_OPENED_MAX)
    expect(next['1']).toBeUndefined()
    expect(next['9999']).toBe(NOW.toISOString())
  })

  it('answers the time before and keeps the other preferences', async () => {
    state.prefs = JSON.stringify({
      theme: 'dark',
      view_opened: { '7': '2026-11-13T08:00:00.000Z' }
    })
    const before = await markViewOpened(ME, 7, NOW)
    expect(before).toBe('2026-11-13T08:00:00.000Z')
    expect(state.written).toEqual({ theme: 'dark', view_opened: { '7': NOW.toISOString() } })
    state.prefs = null
    expect(await markViewOpened(ME, 8, NOW)).toBeNull()
  })
})
