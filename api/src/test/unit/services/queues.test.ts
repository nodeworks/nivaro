import { describe, expect, it } from 'vitest'
import {
  applyQueueConditions,
  applyScopeFilter,
  attachClaims,
  computeAvailableExtraFields,
  type ConditionBuilder,
  computeStats,
  filterBySlaStatus,
  groupByOwner,
  mergeSourceResults,
  type QueueItem,
  type QueueScope,
  type QueueSourceRow
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
    claimed_by: null,
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

describe('filterBySlaStatus', () => {
  const slaMap = {
    '1': { status: 'breached' },
    '2': { status: 'warning' },
    '3': { status: 'ok' }
  }

  it('returns all ids unchanged when filter is null', () => {
    expect(filterBySlaStatus(['1', '2', '3'], slaMap, null)).toEqual(['1', '2', '3'])
  })

  it('narrows to only breached ids when filter is "breached"', () => {
    expect(filterBySlaStatus(['1', '2', '3'], slaMap, 'breached')).toEqual(['1'])
  })

  it('narrows to only warning ids when filter is "warning"', () => {
    expect(filterBySlaStatus(['1', '2', '3'], slaMap, 'warning')).toEqual(['2'])
  })

  it('excludes ids with no SLA entry at all (no active rule for that state)', () => {
    expect(filterBySlaStatus(['1', '4'], slaMap, 'breached')).toEqual(['1'])
  })

  it('returns an empty array when nothing matches', () => {
    expect(filterBySlaStatus(['3'], slaMap, 'breached')).toEqual([])
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

describe('attachClaims', () => {
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
      claimed_by: null,
      url: '/collections/articles/1',
      ...overrides
    }
  }

  it('attaches a claim when the key matches', () => {
    const claims = new Map([['articles:1', { id: 'u1', name: 'Alice' }]])
    const [result] = attachClaims([item()], claims)
    expect(result.claimed_by).toEqual({ id: 'u1', name: 'Alice' })
  })

  it('leaves claimed_by null when no claim matches', () => {
    const claims = new Map([['articles:2', { id: 'u1', name: 'Alice' }]])
    const [result] = attachClaims([item()], claims)
    expect(result.claimed_by).toBeNull()
  })

  it('handles an empty claims map', () => {
    const [result] = attachClaims([item()], new Map())
    expect(result.claimed_by).toBeNull()
  })

  it('keys by collection:item_id, not item_id alone', () => {
    const claims = new Map([['tasks:1', { id: 'u1', name: 'Alice' }]])
    const [result] = attachClaims([item({ collection: 'articles', item_id: '1' })], claims)
    expect(result.claimed_by).toBeNull()
  })
})

describe('applyScopeFilter — claimed scope', () => {
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
      claimed_by: null,
      url: '/collections/articles/1',
      ...overrides
    }
  }

  it('scope=claimed returns only items claimed by the given user', () => {
    const mine = item({ item_id: '1', claimed_by: { id: 'u1', name: 'Alice' } })
    const others = item({ item_id: '2', claimed_by: { id: 'u2', name: 'Bob' } })
    const unclaimed = item({ item_id: '3', claimed_by: null })
    expect(applyScopeFilter([mine, others, unclaimed], 'claimed', 'u1')).toEqual([mine])
  })

  it('scope=claimed returns empty when the user claimed nothing', () => {
    const others = item({ item_id: '2', claimed_by: { id: 'u2', name: 'Bob' } })
    expect(applyScopeFilter([others], 'claimed', 'u1')).toEqual([])
  })
})

describe('QueueScope whitelist parity', () => {
  it('documents the exact set of valid scope values the route must accept', () => {
    // If this list changes, the whitelist in GET /queues/:id/items
    // (api/src/routes/queues.ts) must be updated to match, or new scopes
    // will silently 400 at the route layer despite being supported here.
    const validScopes: QueueScope[] = ['mine', 'unowned', 'all', 'claimed']
    expect(validScopes).toHaveLength(4)
  })
})

describe('groupByOwner', () => {
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
      claimed_by: null,
      url: '/collections/articles/1',
      ...overrides
    }
  }

  it('groups items under each of their owners', () => {
    const alice = { id: 'u1', name: 'Alice' }
    const items = [
      item({ item_id: '1', owners: [alice] }),
      item({ item_id: '2', owners: [alice] })
    ]
    const groups = groupByOwner(items)
    expect(groups.get('u1')).toEqual({ owner: alice, count: 2 })
  })

  it('counts an item once per owner when it has multiple owners', () => {
    const alice = { id: 'u1', name: 'Alice' }
    const bob = { id: 'u2', name: 'Bob' }
    const groups = groupByOwner([item({ owners: [alice, bob] })])
    expect(groups.get('u1')).toEqual({ owner: alice, count: 1 })
    expect(groups.get('u2')).toEqual({ owner: bob, count: 1 })
  })

  it('buckets unowned items under a sentinel key with a null owner', () => {
    const groups = groupByOwner([item({ owners: [] })])
    expect(groups.get('__unassigned__')).toEqual({ owner: null, count: 1 })
  })

  it('returns an empty map for no items', () => {
    expect(groupByOwner([]).size).toBe(0)
  })
})

describe('computeAvailableExtraFields', () => {
  function source(overrides: Partial<QueueSourceRow> = {}): QueueSourceRow {
    return {
      id: 1,
      queue_id: 'q1',
      type: 'collection',
      collection: 'articles',
      filters: null,
      state_values: null,
      sla_filter: null,
      extra_fields: null,
      sort: 0,
      ...overrides
    }
  }

  it('returns the union of extra_fields across collection sources, in source order', () => {
    const sources = [
      source({ id: 1, extra_fields: JSON.stringify(['author', 'wordCount']) }),
      source({ id: 2, extra_fields: JSON.stringify(['priority']) })
    ]
    expect(computeAvailableExtraFields(sources)).toEqual(['author', 'wordCount', 'priority'])
  })

  it('dedupes a field configured on multiple sources', () => {
    const sources = [
      source({ id: 1, extra_fields: JSON.stringify(['priority']) }),
      source({ id: 2, extra_fields: JSON.stringify(['priority', 'customer']) })
    ]
    expect(computeAvailableExtraFields(sources)).toEqual(['priority', 'customer'])
  })

  it('ignores non-collection sources entirely', () => {
    const sources = [
      source({ type: 'tasks', collection: null, extra_fields: JSON.stringify(['whatever']) })
    ]
    expect(computeAvailableExtraFields(sources)).toEqual([])
  })

  it('returns an empty array when no source configures extra_fields', () => {
    expect(computeAvailableExtraFields([source()])).toEqual([])
  })
})
