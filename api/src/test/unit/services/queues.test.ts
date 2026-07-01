import { describe, expect, it } from 'vitest'
import {
  applyQueueConditions,
  applyScopeFilter,
  computeStats,
  mergeSourceResults,
  type ConditionBuilder,
  type QueueItem
} from '../../../services/queues.js'

function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    collection: 'articles',
    item_id: '1',
    label: 'Test item',
    state: 'draft',
    state_color: null,
    owners: [],
    sla_status: null,
    at_risk: false,
    aging_hours: null,
    url: '/collections/articles/1',
    ...overrides
  }
}

describe('mergeSourceResults', () => {
  it('flattens multiple source batches into one list', () => {
    const a = [item({ item_id: '1' })]
    const b = [item({ item_id: '2' })]
    expect(mergeSourceResults([a, b])).toHaveLength(2)
  })

  it('dedupes by collection+item_id across sources, keeping the first occurrence', () => {
    const a = [item({ collection: 'articles', item_id: '1' })]
    const b = [item({ collection: 'articles', item_id: '1', label: 'Duplicate' })]
    const merged = mergeSourceResults([a, b])
    expect(merged).toHaveLength(1)
    expect(merged[0].label).toBe('Test item')
  })

  it('keeps items with the same item_id but different collections', () => {
    const a = [item({ collection: 'articles', item_id: '1' })]
    const b = [item({ collection: 'tasks', item_id: '1' })]
    expect(mergeSourceResults([a, b])).toHaveLength(2)
  })

  it('returns an empty array for no sources', () => {
    expect(mergeSourceResults([])).toEqual([])
  })
})

describe('applyScopeFilter', () => {
  const mine = item({ item_id: '1', owners: [{ id: 'u1', name: 'Alice' }] })
  const others = item({ item_id: '2', owners: [{ id: 'u2', name: 'Bob' }] })
  const unowned = item({ item_id: '3', owners: [] })
  const all = [mine, others, unowned]

  it('scope=all returns everything unchanged', () => {
    expect(applyScopeFilter(all, 'all', 'u1')).toEqual(all)
  })

  it('scope=mine returns only items owned by the given user', () => {
    expect(applyScopeFilter(all, 'mine', 'u1')).toEqual([mine])
  })

  it('scope=unowned returns only items with no owners', () => {
    expect(applyScopeFilter(all, 'unowned', 'u1')).toEqual([unowned])
  })

  it('scope=mine returns empty when the user owns nothing in the list', () => {
    expect(applyScopeFilter(all, 'mine', 'u3')).toEqual([])
  })
})

describe('computeStats', () => {
  it('counts total, per-state, and unowned', () => {
    const items = [
      item({ item_id: '1', state: 'draft', owners: [] }),
      item({ item_id: '2', state: 'draft', owners: [{ id: 'u1', name: 'Alice' }] }),
      item({ item_id: '3', state: 'published', owners: [] })
    ]
    expect(computeStats(items)).toEqual({
      total: 3,
      by_state: { draft: 2, published: 1 },
      unowned: 2
    })
  })

  it('buckets a null state under "none"', () => {
    expect(computeStats([item({ state: null })])).toEqual({
      total: 1,
      by_state: { none: 1 },
      unowned: 1
    })
  })

  it('returns zeroed stats for an empty list', () => {
    expect(computeStats([])).toEqual({ total: 0, by_state: {}, unowned: 0 })
  })
})

describe('applyQueueConditions', () => {
  function mockBuilder() {
    const calls: string[] = []
    const builder: ConditionBuilder = {
      where: (...args: unknown[]) => {
        calls.push(`where(${JSON.stringify(args)})`)
        return builder
      },
      whereNot: (...args: unknown[]) => {
        calls.push(`whereNot(${JSON.stringify(args)})`)
        return builder
      },
      whereNull: (field: string) => {
        calls.push(`whereNull(${JSON.stringify([field])})`)
        return builder
      },
      whereNotNull: (field: string) => {
        calls.push(`whereNotNull(${JSON.stringify([field])})`)
        return builder
      }
    }
    return { builder, calls }
  }

  it('applies an eq condition as a 2-arg where', () => {
    const { builder, calls } = mockBuilder()
    applyQueueConditions(builder, [{ field: 'status', op: 'eq', value: 'open' }])
    expect(calls).toEqual(['where(["status","open"])'])
  })

  it('applies a contains condition as a like clause', () => {
    const { builder, calls } = mockBuilder()
    applyQueueConditions(builder, [{ field: 'title', op: 'contains', value: 'urgent' }])
    expect(calls).toEqual(['where(["title","like","%urgent%"])'])
  })

  it('applies null/nnull without a value', () => {
    const { builder, calls } = mockBuilder()
    applyQueueConditions(builder, [
      { field: 'assignee', op: 'null' },
      { field: 'due_date', op: 'nnull' }
    ])
    expect(calls).toEqual(['whereNull(["assignee"])', 'whereNotNull(["due_date"])'])
  })

  it('chains multiple conditions in the order given', () => {
    const { builder, calls } = mockBuilder()
    applyQueueConditions(builder, [
      { field: 'status', op: 'eq', value: 'open' },
      { field: 'priority', op: 'gte', value: 3 }
    ])
    expect(calls).toEqual(['where(["status","open"])', 'where(["priority",">=",3])'])
  })
})
