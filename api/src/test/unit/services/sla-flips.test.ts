import { describe, expect, it, vi } from 'vitest'
import { liveCollectionsFrom } from '../../../services/live-collections.js'
import {
  createSlaFlipPass,
  type FlipRow,
  LOOKBACK_MS,
  slaCrossings
} from '../../../services/sla-flips.js'

const MIN = 60_000

describe('slaCrossings', () => {
  const now = 1_000 * MIN
  const row = (over: Partial<FlipRow>): FlipRow => ({
    collection: 'orders',
    item: '7',
    warning_at: null,
    due_at: null,
    ...over
  })

  it('announces a line passed since the last look, once', () => {
    const seen = new Map<string, number>()
    const rows = [row({ warning_at: now - MIN, due_at: now + 60 * MIN })]
    expect(slaCrossings(rows, now, seen)).toEqual([
      { collection: 'orders', item: '7', kind: 'warning', at: now - MIN }
    ])
    expect(slaCrossings(rows, now + MIN, seen)).toEqual([])
  })

  it('ignores lines in the future and lines older than the lookback', () => {
    const seen = new Map<string, number>()
    const rows = [
      row({ item: 'a', due_at: now + 1 }),
      row({ item: 'b', due_at: now - LOOKBACK_MS }),
      row({ item: 'c', due_at: now - LOOKBACK_MS + 1 })
    ]
    expect(slaCrossings(rows, now, seen).map((x) => x.item)).toEqual(['c'])
  })

  it('announces both lines when a record passes both between looks', () => {
    const seen = new Map<string, number>()
    const rows = [row({ warning_at: now - 3 * MIN, due_at: now - MIN })]
    expect(slaCrossings(rows, now, seen).map((x) => x.kind)).toEqual(['warning', 'due'])
  })

  it('a new episode (a different instant) is announced again; old keys are forgotten', () => {
    const seen = new Map<string, number>()
    slaCrossings([row({ due_at: now - MIN })], now, seen)
    expect(slaCrossings([row({ due_at: now - 30_000 })], now, seen)).toHaveLength(1)
    slaCrossings([], now + 3 * LOOKBACK_MS, seen)
    expect(seen.size).toBe(0)
  })
})

describe('createSlaFlipPass', () => {
  const setup = (live: Set<string> | null) => {
    let clock = 10_000 * MIN
    const loads: string[] = []
    const announced: Array<[string, string]> = []
    const deadlines: Record<string, FlipRow[]> = {
      orders: [{ collection: 'orders', item: '1', warning_at: null, due_at: clock + 2 * MIN }],
      tickets: [{ collection: 'tickets', item: '9', warning_at: clock + MIN, due_at: null }]
    }
    const pass = createSlaFlipPass({
      liveCollections: () => live,
      slaCollections: vi.fn(async () => ['orders', 'tickets']),
      loadDeadlines: async (c) => {
        loads.push(c)
        return deadlines[c] ?? []
      },
      announce: (c, i) => announced.push([c, i]),
      now: () => clock
    })
    return {
      pass,
      loads,
      announced,
      tick: (ms: number) => {
        clock += ms
      }
    }
  }

  it('reads only collections someone has open, and flips by arithmetic between reads', async () => {
    const t = setup(new Set(['orders', 'other']))
    expect(await t.pass.run()).toEqual({ collections: 1, announced: 0 })
    expect(t.loads).toEqual(['orders'])
    t.tick(MIN)
    await t.pass.run()
    t.tick(2 * MIN)
    expect(await t.pass.run()).toEqual({ collections: 1, announced: 1 })
    expect(t.announced).toEqual([['orders', '1']])
    // No second database read inside the refresh window.
    expect(t.loads).toEqual(['orders'])
  })

  it('treats every SLA collection as open when it cannot tell', async () => {
    const t = setup(null)
    await t.pass.run()
    t.tick(2 * MIN)
    const r = await t.pass.run()
    expect(r.collections).toBe(2)
    expect(t.announced).toEqual([
      ['orders', '1'],
      ['tickets', '9']
    ])
  })

  it('does nothing when nobody watches an SLA collection', async () => {
    const t = setup(new Set())
    expect(await t.pass.run()).toEqual({ collections: 0, announced: 0 })
    expect(t.loads).toEqual([])
  })
})

describe('liveCollectionsFrom', () => {
  it('reads collection and record rooms, tenant prefix dropped', () => {
    expect([
      ...liveCollectionsFrom([
        'collection:orders',
        'record:workflows:12',
        't:acme:record:inventory_request:3',
        'user:abc',
        'watch:traffic',
        'rows:record:x:1'
      ])
    ]).toEqual(['orders', 'workflows', 'inventory_request'])
  })
})
