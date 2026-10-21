import { describe, expect, it, vi } from 'vitest'
import { down, up } from '../db/migrations/461_layout_usage.js'
import {
  coChangePairs,
  countDeltaFields,
  mergeStepStats,
  parseStepStats,
  rollUpFriction,
  sanitizeUsageEvent,
  type UsageEvent
} from './layout-usage.js'

const ev = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  layout_id: 7,
  collection: 'orders',
  item: '12',
  open: true,
  saved: false,
  abandoned_step: null,
  steps: {},
  ...over
})

describe('sanitizeUsageEvent', () => {
  it('keeps a valid event and clamps step time', () => {
    const out = sanitizeUsageEvent({
      layout_id: '7',
      collection: 'orders',
      item: 12,
      open: true,
      saved: true,
      steps: { basics: 1500.4, review: 99_999_999, bad$: 10, neg: -5 }
    })
    expect(out).toEqual({
      layout_id: 7,
      collection: 'orders',
      item: '12',
      open: true,
      saved: true,
      abandoned_step: null,
      steps: { basics: 1500, review: 7_200_000 }
    })
  })

  it('refuses bad layout ids and collections', () => {
    expect(sanitizeUsageEvent({ layout_id: 0, collection: 'orders' })).toBeNull()
    expect(sanitizeUsageEvent({ layout_id: 3, collection: 'drop table' })).toBeNull()
    expect(sanitizeUsageEvent(null)).toBeNull()
  })

  it('counts an abandon only for an unsaved new record', () => {
    expect(
      sanitizeUsageEvent({ layout_id: 1, collection: 'a', item: 'new', abandoned_step: 's1' })
        ?.abandoned_step
    ).toBe('s1')
    expect(
      sanitizeUsageEvent({ layout_id: 1, collection: 'a', item: '5', abandoned_step: 's1' })
        ?.abandoned_step
    ).toBeNull()
    expect(
      sanitizeUsageEvent({ layout_id: 1, collection: 'a', saved: true, abandoned_step: 's1' })
        ?.abandoned_step
    ).toBeNull()
  })
})

describe('step stats', () => {
  it('merges time, sessions and abandons into the stored JSON', () => {
    const first = mergeStepStats(null, ev({ steps: { a: 1000, b: 500 } }))
    const second = mergeStepStats(first, ev({ steps: { a: 3000 }, abandoned_step: 'a' }))
    expect(parseStepStats(second)).toEqual({
      a: { ms: 4000, n: 2, a: 1 },
      b: { ms: 500, n: 1, a: 0 }
    })
    expect(parseStepStats('not json')).toEqual({})
  })

  it('rolls days up into averages, slowest first', () => {
    const r = rollUpFriction([
      {
        opens: 2,
        saves: 1,
        abandons: 1,
        step_stats: JSON.stringify({ a: { ms: 4000, n: 2, a: 1 } })
      },
      {
        opens: 1,
        saves: 1,
        abandons: 0,
        step_stats: JSON.stringify({ a: { ms: 2000, n: 1, a: 0 }, b: { ms: 9000, n: 1, a: 0 } })
      }
    ])
    expect(r.opens).toBe(3)
    expect(r.saves).toBe(2)
    expect(r.abandons).toBe(1)
    expect(r.steps).toEqual([
      { key: 'b', avg_ms: 9000, sessions: 1, abandons: 0 },
      { key: 'a', avg_ms: 2000, sessions: 3, abandons: 1 }
    ])
  })
})

describe('revision mining', () => {
  it('counts person fields only', () => {
    const out = countDeltaFields([
      JSON.stringify({ status: 1, updated_at: 'x', _meta: 1 }),
      JSON.stringify({ status: 2, amount: 3 }),
      null,
      'garbage'
    ])
    expect(out).toEqual([
      { field: 'status', changes: 2 },
      { field: 'amount', changes: 1 }
    ])
  })

  it('finds fields changed together (Jaccard), skipping bulk edits', () => {
    const d = (o: Record<string, number>) => JSON.stringify(o)
    const deltas = [
      ...Array.from({ length: 6 }, () => d({ street: 1, city: 1, zip: 1 })),
      ...Array.from({ length: 2 }, () => d({ street: 1 })),
      ...Array.from({ length: 6 }, () => d({ notes: 1 })),
      d(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, 1])))
    ]
    const out = coChangePairs(deltas, { minTogether: 5, minJaccard: 0.5 })
    expect(out.revisions).toBe(14)
    expect(out.pairs.map((p) => `${p.a}+${p.b}`)).toEqual(['city+zip', 'city+street', 'street+zip'])
    expect(out.pairs[0]).toMatchObject({ together: 6, jaccard: 1 })
    expect(out.pairs[1].jaccard).toBe(0.75)
  })
})

describe('migration 461', () => {
  function fakeKnex(existing: string[]) {
    const created: string[] = []
    const dropped: string[] = []
    const t = new Proxy(
      {},
      {
        get: () =>
          vi.fn(() => {
            const chain: Record<string, unknown> = {}
            for (const m of ['notNullable', 'nullable', 'defaultTo']) chain[m] = () => chain
            return chain
          })
      }
    )
    const knex = Object.assign(() => ({}), {
      raw: vi.fn(() => 'raw'),
      fn: { now: () => 'now' },
      client: { config: { client: 'mssql' } },
      schema: {
        hasTable: vi.fn(async (name: string) => existing.includes(name)),
        createTable: vi.fn(async (name: string, cb: (t: unknown) => void) => {
          cb(t)
          created.push(name)
        }),
        dropTable: vi.fn(async (name: string) => {
          dropped.push(name)
        })
      }
    })
    return { knex, created, dropped }
  }

  it('creates both tables, and nothing that already exists', async () => {
    const a = fakeKnex([])
    await up(a.knex as never)
    expect(a.created).toEqual(['nivaro_layout_usage_daily', 'nivaro_layout_usage_seen'])
    const b = fakeKnex(['nivaro_layout_usage_daily', 'nivaro_layout_usage_seen'])
    await up(b.knex as never)
    expect(b.created).toEqual([])
  })

  it('down drops only what exists', async () => {
    const a = fakeKnex(['nivaro_layout_usage_seen'])
    await down(a.knex as never)
    expect(a.dropped).toEqual(['nivaro_layout_usage_seen'])
  })
})
