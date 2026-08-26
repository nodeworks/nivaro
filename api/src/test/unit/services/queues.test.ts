import { describe, expect, it } from 'vitest'
import {
  applyColumnFilters,
  applyQueueConditions,
  applyScopeFilter,
  attachClaims,
  type ConditionBuilder,
  classifyRelationSegment,
  computeAvailableExtraFields,
  computeAvailableValues,
  computeExtraFieldMeta,
  computePriorityScore,
  computeStats,
  computeStatsFromIdMeta,
  DEFAULT_DISPLAY_CONFIG,
  filterBySlaStatus,
  formatMultiValueCell,
  groupByOwner,
  isDisplayOnlySourceChange,
  mergeSourceResults,
  normalizeDisplayConfig,
  paginateItems,
  parsePaginationParams,
  type QueueItem,
  type QueueScope,
  type QueueSourceRow,
  sortItems,
  stateFilterKeep,
  validateAggregates,
  validateColumnFormats
} from '../../../services/queues.js'
import type { CMSRelation } from '../../../types.js'

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
      unowned: 2,
      sla_warning: 0,
      sla_breached: 0,
      at_risk: 0,
      aging: { d1: 0, d3: 0, d7: 0, over: 0 }
    })
  })

  it('buckets a null state under "none"', () => {
    expect(computeStats([item({ state: null })])).toEqual({
      total: 1,
      by_state: { none: 1 },
      unowned: 1,
      sla_warning: 0,
      sla_breached: 0,
      at_risk: 0,
      aging: { d1: 0, d3: 0, d7: 0, over: 0 }
    })
  })

  it('returns zeroed stats for an empty list', () => {
    expect(computeStats([])).toEqual({
      total: 0,
      by_state: {},
      unowned: 0,
      sla_warning: 0,
      sla_breached: 0,
      at_risk: 0,
      aging: { d1: 0, d3: 0, d7: 0, over: 0 }
    })
  })

  it('counts SLA warning, SLA breached, and at-risk items', () => {
    const items = [
      item({ item_id: '1', sla_status: 'warning' }),
      item({ item_id: '2', sla_status: 'breached', at_risk: true }),
      item({ item_id: '3', sla_status: 'breached' }),
      item({ item_id: '4', sla_status: 'ok', at_risk: true }),
      item({ item_id: '5' })
    ]
    const stats = computeStats(items)
    expect(stats.sla_warning).toBe(1)
    expect(stats.sla_breached).toBe(2)
    expect(stats.at_risk).toBe(2)
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
    const items = [item({ item_id: '1', owners: [alice] }), item({ item_id: '2', owners: [alice] })]
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

describe('classifyRelationSegment', () => {
  function rel(overrides: Partial<CMSRelation> = {}): CMSRelation {
    return {
      id: 1,
      many_collection: '',
      many_field: '',
      one_collection: null,
      one_field: null,
      one_collection_field: null,
      one_allowed_collections: null,
      junction_field: null,
      sort_field: null,
      one_deselect_action: 'nullify',
      ...overrides
    }
  }

  it('classifies a direct M2O field', () => {
    const relations = [
      rel({ many_collection: 'workflows', many_field: 'project', one_collection: 'projects' })
    ]
    expect(classifyRelationSegment('workflows', 'project', relations)).toEqual({
      type: 'm2o',
      relatedCollection: 'projects'
    })
  })

  it('classifies an O2M field (viewed from the one side)', () => {
    const relations = [
      rel({
        many_collection: 'tasks',
        many_field: 'project',
        one_collection: 'projects',
        one_field: 'tasks'
      })
    ]
    expect(classifyRelationSegment('projects', 'tasks', relations)).toEqual({
      type: 'o2m',
      relatedCollection: 'tasks',
      manyField: 'project'
    })
  })

  it('classifies an M2M field via its junction table', () => {
    const relations = [
      rel({
        many_collection: 'projects_tags',
        many_field: 'project_id',
        one_collection: 'projects',
        one_field: 'tags',
        junction_field: 'tag_id'
      }),
      rel({ many_collection: 'projects_tags', many_field: 'tag_id', one_collection: 'tags' })
    ]
    expect(classifyRelationSegment('projects', 'tags', relations)).toEqual({
      type: 'm2m',
      relatedCollection: 'tags',
      junction: 'projects_tags',
      junctionFkToParent: 'project_id',
      junctionFkToOther: 'tag_id'
    })
  })

  it('returns null for a plain scalar field with no matching relation', () => {
    expect(classifyRelationSegment('projects', 'name', [])).toBeNull()
  })
})

describe('formatMultiValueCell', () => {
  it('joins values with no suffix when the total fits under the cap', () => {
    expect(formatMultiValueCell(['A', 'B'], 2)).toBe('A, B')
  })

  it('appends a +N more suffix when the total exceeds the cap', () => {
    expect(formatMultiValueCell(['A', 'B', 'C'], 5)).toBe('A, B, C +2 more')
  })

  it('returns an empty string for zero total', () => {
    expect(formatMultiValueCell([], 0)).toBe('')
  })

  it('respects a custom cap', () => {
    expect(formatMultiValueCell(['A', 'B'], 3, 1)).toBe('A +2 more')
  })
})

describe('applyColumnFilters', () => {
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
      extra: {},
      url: '/collections/articles/1',
      ...overrides
    }
  }

  it('returns all items when filters is empty', () => {
    const items = [item(), item({ item_id: '2' })]
    expect(applyColumnFilters(items, {})).toEqual(items)
  })

  it('filters by exact collection match', () => {
    const items = [item({ collection: 'articles' }), item({ collection: 'tickets' })]
    expect(applyColumnFilters(items, { collection: 'tickets' })).toHaveLength(1)
  })

  it('filters by exact state match', () => {
    const items = [item({ state: 'draft' }), item({ state: 'review' })]
    expect(applyColumnFilters(items, { state: 'review' })).toHaveLength(1)
  })

  it('filters by exact sla_status match', () => {
    const items = [item({ sla_status: 'ok' }), item({ sla_status: 'breached' })]
    expect(applyColumnFilters(items, { sla_status: 'breached' })).toHaveLength(1)
  })

  it('filters by at_risk boolean via "yes"/"no" string', () => {
    const items = [item({ at_risk: true }), item({ at_risk: false })]
    expect(applyColumnFilters(items, { at_risk: 'yes' })).toHaveLength(1)
  })

  it('filters aging_hours by a min/max range object', () => {
    const items = [item({ aging_hours: 5 }), item({ aging_hours: 50 }), item({ aging_hours: 500 })]
    expect(applyColumnFilters(items, { aging_hours: { min: 10, max: 100 } })).toHaveLength(1)
  })

  it('filters label by case-insensitive substring', () => {
    const items = [item({ label: 'Node Splits' }), item({ label: 'Other Thing' })]
    expect(applyColumnFilters(items, { label: 'node' })).toHaveLength(1)
  })

  it('filters owners by case-insensitive substring across all owner names', () => {
    const items = [
      item({ owners: [{ id: 'u1', name: 'Ada Lovelace' }] }),
      item({ owners: [{ id: 'u2', name: 'Grace Hopper' }] })
    ]
    expect(applyColumnFilters(items, { owners: 'ada' })).toHaveLength(1)
  })

  it('filters an extra.<path> key by case-insensitive substring against the resolved value', () => {
    const items = [
      item({ extra: { 'project.owner.name': 'Ada Lovelace' } }),
      item({ extra: { 'project.owner.name': 'Grace Hopper' } })
    ]
    expect(applyColumnFilters(items, { 'extra.project.owner.name': 'grace' })).toHaveLength(1)
  })

  it('combines multiple active filters with AND semantics', () => {
    const items = [
      item({ collection: 'articles', state: 'draft' }),
      item({ collection: 'articles', state: 'review' }),
      item({ collection: 'tickets', state: 'draft' })
    ]
    expect(applyColumnFilters(items, { collection: 'articles', state: 'draft' })).toHaveLength(1)
  })

  it('ignores a filter key whose value is empty string or null', () => {
    const items = [item(), item({ item_id: '2' })]
    expect(applyColumnFilters(items, { collection: '', state: null })).toEqual(items)
  })
})

describe('sortItems', () => {
  function item(overrides: Partial<QueueItem> = {}): QueueItem {
    return {
      collection: 'articles',
      item_id: '1',
      label: 'B',
      state: null,
      state_color: null,
      owners: [],
      sla_status: null,
      at_risk: false,
      aging_hours: null,
      claimed_by: null,
      extra: {},
      url: '/collections/articles/1',
      ...overrides
    }
  }

  it('returns items unchanged when sort is empty', () => {
    const items = [item({ label: 'B' }), item({ label: 'A' })]
    expect(sortItems(items, '')).toEqual(items)
  })

  it('sorts ascending by a plain field name', () => {
    const items = [item({ label: 'B' }), item({ label: 'A' })]
    expect(sortItems(items, 'label').map((i) => i.label)).toEqual(['A', 'B'])
  })

  it('sorts descending with a -prefixed field name', () => {
    const items = [item({ label: 'A' }), item({ label: 'B' })]
    expect(sortItems(items, '-label').map((i) => i.label)).toEqual(['B', 'A'])
  })

  it('sorts numerically by aging_hours, nulls last', () => {
    const items = [item({ aging_hours: null }), item({ aging_hours: 5 }), item({ aging_hours: 1 })]
    expect(sortItems(items, 'aging_hours').map((i) => i.aging_hours)).toEqual([1, 5, null])
  })

  it('sorts numerically descending by aging_hours, nulls still last (not first)', () => {
    const items = [item({ aging_hours: null }), item({ aging_hours: 5 }), item({ aging_hours: 1 })]
    expect(sortItems(items, '-aging_hours').map((i) => i.aging_hours)).toEqual([5, 1, null])
  })

  it('sorts sla_status by severity ordinal (ok < warning < breached), not alphabetically', () => {
    const items = [
      item({ sla_status: 'breached' }),
      item({ sla_status: 'ok' }),
      item({ sla_status: 'warning' })
    ]
    expect(sortItems(items, 'sla_status').map((i) => i.sla_status)).toEqual([
      'ok',
      'warning',
      'breached'
    ])
  })

  it('sorts by an extra.<path> key against the resolved value', () => {
    const items = [item({ extra: { priority: 'Low' } }), item({ extra: { priority: 'High' } })]
    expect(sortItems(items, 'extra.priority').map((i) => i.extra?.priority)).toEqual([
      'High',
      'Low'
    ])
  })
})

describe('computeAvailableValues', () => {
  function item(overrides: Partial<QueueItem> = {}): QueueItem {
    return {
      collection: 'articles',
      item_id: '1',
      label: 'Test',
      state: 'draft',
      state_color: null,
      owners: [],
      sla_status: null,
      at_risk: false,
      aging_hours: null,
      claimed_by: null,
      extra: {},
      url: '/collections/articles/1',
      ...overrides
    }
  }

  it('returns the distinct, sorted collection and state values across items', () => {
    const items = [
      item({ collection: 'articles', state: 'draft' }),
      item({ collection: 'tickets', state: 'review' }),
      item({ collection: 'articles', state: 'draft' })
    ]
    expect(computeAvailableValues(items)).toEqual({
      collection: ['articles', 'tickets'],
      state: ['draft', 'review'],
      owners: []
    })
  })

  it('excludes null states, returns empty arrays for no items', () => {
    expect(computeAvailableValues([item({ state: null })])).toEqual({
      collection: ['articles'],
      state: [],
      owners: []
    })
    expect(computeAvailableValues([])).toEqual({ collection: [], state: [], owners: [] })
  })

  it('collects distinct owners across items, sorted by name', () => {
    const items = [
      item({ owners: [{ id: 'u2', name: 'Zed Alpha' }] }),
      item({
        owners: [
          { id: 'u1', name: 'Amy Beta' },
          { id: 'u2', name: 'Zed Alpha' }
        ]
      })
    ]
    expect(computeAvailableValues(items).owners).toEqual([
      { id: 'u1', name: 'Amy Beta' },
      { id: 'u2', name: 'Zed Alpha' }
    ])
  })
})

describe('paginateItems', () => {
  const five = [1, 2, 3, 4, 5]

  it('returns all items unchanged and total = length when page/limit are omitted', () => {
    expect(paginateItems(five)).toEqual({ items: five, total: 5 })
  })

  it('returns the first page', () => {
    expect(paginateItems(five, 1, 2)).toEqual({ items: [1, 2], total: 5 })
  })

  it('returns the second page', () => {
    expect(paginateItems(five, 2, 2)).toEqual({ items: [3, 4], total: 5 })
  })

  it('returns a partial last page', () => {
    expect(paginateItems(five, 3, 2)).toEqual({ items: [5], total: 5 })
  })

  it('returns an empty array (not an error) for a page beyond the last one, total still accurate', () => {
    expect(paginateItems(five, 10, 2)).toEqual({ items: [], total: 5 })
  })

  it('returns everything when only page is given but not limit', () => {
    expect(paginateItems(five, 2)).toEqual({ items: five, total: 5 })
  })
})

describe('parsePaginationParams', () => {
  it('defaults to page 1, limit 25 when both are undefined', () => {
    expect(parsePaginationParams(undefined, undefined)).toEqual({ page: 1, limit: 25 })
  })

  it('parses valid numeric strings', () => {
    expect(parsePaginationParams('3', '50')).toEqual({ page: 3, limit: 50 })
  })

  it('floors fractional values', () => {
    expect(parsePaginationParams('2.9', '10.9')).toEqual({ page: 2, limit: 10 })
  })

  it('falls back to defaults for non-numeric strings', () => {
    expect(parsePaginationParams('abc', 'xyz')).toEqual({ page: 1, limit: 25 })
  })

  it('falls back to defaults for zero or negative values', () => {
    expect(parsePaginationParams('0', '-5')).toEqual({ page: 1, limit: 25 })
  })

  it('clamps limit to a maximum of 100', () => {
    expect(parsePaginationParams('1', '500')).toEqual({ page: 1, limit: 100 })
  })
})

describe('computePriorityScore', () => {
  it('gives strict band precedence: any breached item outranks any non-breached item', () => {
    const breachedFresh = item({ sla_status: 'breached', aging_hours: 0 })
    const warningOldRisky = item({ sla_status: 'warning', at_risk: true, aging_hours: 4000 })
    expect(computePriorityScore(breachedFresh)).toBeGreaterThan(
      computePriorityScore(warningOldRisky)
    )
  })

  it('caps aging at 499 so age never crosses a band boundary', () => {
    const okAncient = item({ sla_status: 'ok', aging_hours: 100000 })
    const warningFresh = item({ sla_status: 'warning', aging_hours: 0 })
    expect(computePriorityScore(okAncient)).toBe(499)
    expect(computePriorityScore(warningFresh)).toBe(1000)
  })

  it('adds 500 for at-risk within the same SLA band', () => {
    const risky = item({ sla_status: 'warning', at_risk: true, aging_hours: 10 })
    const calm = item({ sla_status: 'warning', at_risk: false, aging_hours: 10 })
    expect(computePriorityScore(risky) - computePriorityScore(calm)).toBe(500)
  })

  it('degrades to aging order when SLA and risk are absent', () => {
    expect(computePriorityScore(item({ aging_hours: 30 }))).toBe(30)
    expect(computePriorityScore(item({ aging_hours: null }))).toBe(0)
  })
})

describe('sortItems — priority key', () => {
  it('-priority puts the most urgent item first', () => {
    const items = [
      item({ item_id: 'calm', sla_status: 'ok', aging_hours: 5 }),
      item({ item_id: 'breached', sla_status: 'breached', aging_hours: 1 }),
      item({ item_id: 'risky', sla_status: null, at_risk: true, aging_hours: 200 }),
      item({ item_id: 'warning', sla_status: 'warning', aging_hours: 50 })
    ]
    const sorted = sortItems(items, '-priority')
    expect(sorted.map((i) => i.item_id)).toEqual(['breached', 'warning', 'risky', 'calm'])
  })

  it('older items rank higher within the same band', () => {
    const items = [
      item({ item_id: 'young', sla_status: 'breached', aging_hours: 2 }),
      item({ item_id: 'old', sla_status: 'breached', aging_hours: 90 })
    ]
    expect(sortItems(items, '-priority').map((i) => i.item_id)).toEqual(['old', 'young'])
  })
})

describe('stateFilterKeep', () => {
  it('include mode keeps only listed states and drops stateless items', () => {
    expect(stateFilterKeep('draft', ['draft'], 'include')).toBe(true)
    expect(stateFilterKeep('completed', ['draft'], 'include')).toBe(false)
    expect(stateFilterKeep(null, ['draft'], 'include')).toBe(false)
  })

  it('exclude mode drops listed states and keeps stateless items', () => {
    expect(stateFilterKeep('completed', ['completed'], 'exclude')).toBe(false)
    expect(stateFilterKeep('draft', ['completed'], 'exclude')).toBe(true)
    expect(stateFilterKeep(null, ['completed'], 'exclude')).toBe(true)
  })

  it('the __none__ sentinel matches stateless items', () => {
    // include: sentinel keeps stateless items (alone or alongside real states)
    expect(stateFilterKeep(null, ['__none__'], 'include')).toBe(true)
    expect(stateFilterKeep(null, ['draft', '__none__'], 'include')).toBe(true)
    expect(stateFilterKeep('draft', ['draft', '__none__'], 'include')).toBe(true)
    expect(stateFilterKeep('completed', ['__none__'], 'include')).toBe(false)
    // exclude: sentinel drops stateless items
    expect(stateFilterKeep(null, ['__none__'], 'exclude')).toBe(false)
    expect(stateFilterKeep(null, ['completed', '__none__'], 'exclude')).toBe(false)
    expect(stateFilterKeep('draft', ['__none__'], 'exclude')).toBe(true)
  })
})

describe('computeStatsFromIdMeta', () => {
  const meta = (
    collection: string,
    item_id: string,
    state: string | null = null,
    sla: 'ok' | 'warning' | 'breached' | null = null
  ) => ({
    collection,
    item_id,
    state,
    sla_status: sla
  })

  it('counts total/by_state/sla across the full meta set, deduped across sources', () => {
    const stats = computeStatsFromIdMeta(
      [
        [meta('a', '1', 'draft', 'breached'), meta('a', '2', 'draft', 'warning')],
        [meta('a', '1', 'draft', 'breached'), meta('b', '1', null, 'ok')]
      ],
      []
    )
    expect(stats.total).toBe(3)
    expect(stats.by_state).toEqual({ draft: 2, none: 1 })
    expect(stats.sla_breached).toBe(1)
    expect(stats.sla_warning).toBe(1)
  })

  it('takes unowned and at_risk from the hydrated subset', () => {
    const stats = computeStatsFromIdMeta(
      [[meta('a', '1'), meta('a', '2')]],
      [
        item({ item_id: '1', owners: [], at_risk: true }),
        item({ item_id: '2', owners: [{ id: 'u1', name: 'Alice' }] })
      ]
    )
    expect(stats.total).toBe(2)
    expect(stats.unowned).toBe(1)
    expect(stats.at_risk).toBe(1)
  })
})

describe('applyColumnFilters — multiselect arrays', () => {
  const rows = [
    item({ item_id: '1', collection: 'a', state: 'draft', extra: { 'divisions.name': 'Zone 1' } }),
    item({ item_id: '2', collection: 'b', state: 'review', extra: { 'divisions.name': 'Zone 2' } }),
    item({ item_id: '3', collection: 'c', state: 'done', extra: { 'divisions.name': 'Zone 3' } })
  ]

  it('matches ANY of the values for collection/state arrays', () => {
    expect(applyColumnFilters(rows, { collection: ['a', 'c'] }).map((r) => r.item_id)).toEqual([
      '1',
      '3'
    ])
    expect(applyColumnFilters(rows, { state: ['draft', 'review'] }).map((r) => r.item_id)).toEqual([
      '1',
      '2'
    ])
  })

  it('matches ANY of the values for extra.* arrays (contains semantics)', () => {
    expect(
      applyColumnFilters(rows, { 'extra.divisions.name': ['Zone 1', 'Zone 3'] }).map(
        (r) => r.item_id
      )
    ).toEqual(['1', '3'])
  })

  it('empty arrays are ignored like empty strings', () => {
    expect(applyColumnFilters(rows, { collection: [] })).toHaveLength(3)
  })

  it('single string values keep working unchanged', () => {
    expect(applyColumnFilters(rows, { collection: 'b' }).map((r) => r.item_id)).toEqual(['2'])
  })
})

describe('applyColumnFilters — label arrays', () => {
  const rows = [
    item({ item_id: '1', label: 'MMCAR-8479' }),
    item({ item_id: '2', label: 'GECAR-14433' }),
    item({ item_id: '3', label: 'GECAR-11546' })
  ]

  it('label matches ANY of the selected labels', () => {
    expect(
      applyColumnFilters(rows, { label: ['MMCAR-8479', 'GECAR-11546'] }).map((r) => r.item_id)
    ).toEqual(['1', '3'])
  })

  it('single string label keeps contains semantics', () => {
    expect(applyColumnFilters(rows, { label: 'gecar' }).map((r) => r.item_id)).toEqual(['2', '3'])
  })
})

describe('normalizeDisplayConfig', () => {
  it('returns full defaults for null/undefined/non-object', () => {
    for (const raw of [null, undefined, 'junk', 42]) {
      expect(normalizeDisplayConfig(raw)).toEqual(DEFAULT_DISPLAY_CONFIG)
    }
  })

  it('equals DEFAULT_DISPLAY_CONFIG for empty object', () => {
    expect(normalizeDisplayConfig({})).toEqual(DEFAULT_DISPLAY_CONFIG)
  })

  it('forces table into views and keeps canonical order', () => {
    expect(normalizeDisplayConfig({ views: ['workload', 'kanban'] }).views).toEqual([
      'table',
      'kanban',
      'workload'
    ])
  })

  it('drops unknown view names', () => {
    expect(normalizeDisplayConfig({ views: ['table', 'gantt'] }).views).toEqual(['table'])
  })

  it('coerces default_view outside views to table', () => {
    const dc = normalizeDisplayConfig({ views: ['table'], default_view: 'kanban' })
    expect(dc.default_view).toBe('table')
  })

  it('keeps a valid default_view', () => {
    const dc = normalizeDisplayConfig({ views: ['table', 'kanban'], default_view: 'kanban' })
    expect(dc.default_view).toBe('kanban')
  })

  it('coerces invalid default_scope to all', () => {
    expect(normalizeDisplayConfig({ default_scope: 'claimed' }).default_scope).toBe('all')
    expect(normalizeDisplayConfig({ default_scope: 'mine' }).default_scope).toBe('mine')
  })

  it('coerces work_next / bulk_actions to booleans (only literal false disables)', () => {
    expect(normalizeDisplayConfig({ work_next: false }).work_next).toBe(false)
    expect(normalizeDisplayConfig({ work_next: 0 }).work_next).toBe(true)
    expect(normalizeDisplayConfig({ bulk_actions: false }).bulk_actions).toBe(false)
  })

  it('drops unknown keys', () => {
    const dc = normalizeDisplayConfig({ extra_key: 1 }) as unknown as Record<string, unknown>
    expect(dc.extra_key).toBeUndefined()
  })

  it('coerces row_click (preview/layout/full, else preview)', () => {
    expect(normalizeDisplayConfig({ row_click: 'full' }).row_click).toBe('full')
    expect(normalizeDisplayConfig({ row_click: 'layout' }).row_click).toBe('layout')
    expect(normalizeDisplayConfig({ row_click: 'preview' }).row_click).toBe('preview')
    expect(normalizeDisplayConfig({ row_click: 'sidebar' }).row_click).toBe('preview')
    expect(normalizeDisplayConfig({}).row_click).toBe('preview')
  })

  it('trims item_layout, empty/non-string → null', () => {
    expect(normalizeDisplayConfig({ item_layout: ' invoice-view ' }).item_layout).toBe(
      'invoice-view'
    )
    expect(normalizeDisplayConfig({ item_layout: '' }).item_layout).toBeNull()
    expect(normalizeDisplayConfig({ item_layout: 42 }).item_layout).toBeNull()
    expect(normalizeDisplayConfig({}).item_layout).toBeNull()
  })

  it('normalizes sheet_width: px clamps, percent clamps, garbage → null', () => {
    expect(normalizeDisplayConfig({ sheet_width: 640 }).sheet_width).toBe(640)
    expect(normalizeDisplayConfig({ sheet_width: 100 }).sheet_width).toBe(280)
    expect(normalizeDisplayConfig({ sheet_width: 5000 }).sheet_width).toBe(2000)
    expect(normalizeDisplayConfig({ sheet_width: '800px' }).sheet_width).toBe(800)
    expect(normalizeDisplayConfig({ sheet_width: '55%' }).sheet_width).toBe('55%')
    expect(normalizeDisplayConfig({ sheet_width: '200%' }).sheet_width).toBe('96%')
    expect(normalizeDisplayConfig({ sheet_width: 'wide' }).sheet_width).toBeNull()
    expect(normalizeDisplayConfig({}).sheet_width).toBeNull()
  })
})

describe('applyColumnFilters — owners multiselect', () => {
  const base: QueueItem = {
    collection: 'articles',
    item_id: '1',
    label: 'Test',
    state: 'draft',
    state_color: null,
    owners: [],
    sla_status: null,
    at_risk: false,
    aging_hours: null,
    claimed_by: null,
    extra: {},
    url: '/collections/articles/1'
  }
  const rows: QueueItem[] = [
    { ...base, item_id: '1', owners: [{ id: 'u1', name: 'Amy Beta' }] },
    {
      ...base,
      item_id: '2',
      owners: [
        { id: 'u2', name: 'Zed Alpha' },
        { id: 'u3', name: 'Cal Gamma' }
      ]
    },
    { ...base, item_id: '3', owners: [] }
  ]

  it('array value matches items owned by ANY selected user id', () => {
    expect(applyColumnFilters(rows, { owners: ['u1', 'u3'] }).map((r) => r.item_id)).toEqual([
      '1',
      '2'
    ])
  })

  it('empty array is a no-op', () => {
    expect(applyColumnFilters(rows, { owners: [] })).toHaveLength(3)
  })

  it('string value keeps legacy substring-on-names behavior', () => {
    expect(applyColumnFilters(rows, { owners: 'zed' }).map((r) => r.item_id)).toEqual(['2'])
  })
})

describe('validateColumnFormats', () => {
  it('accepts undefined and empty object', () => {
    expect(validateColumnFormats(undefined)).toBeNull()
    expect(validateColumnFormats({})).toBeNull()
  })

  it('accepts a valid datetime format', () => {
    expect(
      validateColumnFormats({ due_date: { type: 'datetime', template: 'DD/MM/YYYY HH:mm' } })
    ).toBeNull()
  })

  it('accepts the relative datetime template', () => {
    expect(
      validateColumnFormats({ due_date: { type: 'datetime', template: 'relative' } })
    ).toBeNull()
  })

  it('accepts a valid number format', () => {
    expect(
      validateColumnFormats({
        amount: { type: 'number', decimals: 2, thousands: true, prefix: '£', suffix: '' }
      })
    ).toBeNull()
  })

  it('accepts a valid boolean format', () => {
    expect(
      validateColumnFormats({ active: { type: 'boolean', true_label: 'Yes', false_label: 'No' } })
    ).toBeNull()
  })

  it('rejects non-object input', () => {
    expect(validateColumnFormats('nope')).toMatch(/must be an object/)
    expect(validateColumnFormats([1])).toMatch(/must be an object/)
  })

  it('rejects unknown type', () => {
    expect(validateColumnFormats({ f: { type: 'currency' } })).toMatch(/invalid format type/)
  })

  it('rejects datetime without template or over 50 chars', () => {
    expect(validateColumnFormats({ f: { type: 'datetime' } })).toMatch(/template/)
    expect(validateColumnFormats({ f: { type: 'datetime', template: 'Y'.repeat(51) } })).toMatch(
      /template/
    )
  })

  it('rejects number decimals out of range', () => {
    expect(validateColumnFormats({ f: { type: 'number', decimals: 11 } })).toMatch(/decimals/)
    expect(validateColumnFormats({ f: { type: 'number', decimals: -1 } })).toMatch(/decimals/)
  })

  it('rejects oversized prefix/suffix/labels', () => {
    const long = 'x'.repeat(31)
    expect(validateColumnFormats({ f: { type: 'number', prefix: long } })).toMatch(/30/)
    expect(validateColumnFormats({ f: { type: 'number', suffix: long } })).toMatch(/30/)
    expect(
      validateColumnFormats({ f: { type: 'boolean', true_label: long, false_label: 'No' } })
    ).toMatch(/30/)
  })

  it('rejects boolean missing labels', () => {
    expect(validateColumnFormats({ f: { type: 'boolean', true_label: 'Yes' } })).toMatch(/label/)
  })
})

describe('validateAggregates', () => {
  it('accepts null/undefined and valid maps', () => {
    expect(validateAggregates(null)).toBeNull()
    expect(validateAggregates(undefined)).toBeNull()
    expect(validateAggregates({ 'purchase_orders.amount': 'sum' })).toBeNull()
    expect(
      validateAggregates({ 'purchase_orders.amount': 'avg', 'funding_years.id': 'count' })
    ).toBeNull()
  })

  it('rejects non-objects and unknown functions', () => {
    expect(validateAggregates([])).toMatch(/object/)
    expect(validateAggregates('sum')).toMatch(/object/)
    expect(validateAggregates({ 'purchase_orders.amount': 'total' })).toMatch(
      /sum, avg, min, max, count/
    )
  })

  it('rejects single-segment paths except for count', () => {
    expect(validateAggregates({ amount: 'sum' })).toMatch(/one relation hop/)
    expect(validateAggregates({ purchase_orders: 'count' })).toBeNull()
  })

  it('rejects multi-hop paths — aggregates support exactly one relation hop', () => {
    expect(validateAggregates({ 'line_items.category.amount': 'sum' })).toMatch(/one relation hop/)
    expect(validateAggregates({ 'a.b.c': 'count' })).toMatch(/one relation hop/)
  })
})

describe('isDisplayOnlySourceChange', () => {
  const existingSource = (over: Partial<QueueSourceRow> = {}): QueueSourceRow =>
    ({
      id: 1,
      queue_id: 'q1',
      type: 'collection',
      collection: 'workflows',
      filters: '[]',
      state_values: '["started"]',
      state_mode: 'include',
      label_template: null,
      sla_filter: null,
      extra_fields: '["project.name"]',
      drilldown: null,
      column_formats: null,
      aggregates: null,
      sort: 0,
      ...over
    }) as QueueSourceRow

  const incomingSource = (over: Record<string, unknown> = {}) => ({
    type: 'collection',
    collection: 'workflows',
    filters: [],
    state_values: ['started'],
    state_mode: 'include',
    label_template: null,
    sla_filter: null,
    extra_fields: ['project.name'],
    drilldown: null,
    column_formats: null,
    sort: 0,
    ...over
  })

  it('true when only column_formats changed', () => {
    expect(
      isDisplayOnlySourceChange(
        [existingSource()],
        [
          incomingSource({
            column_formats: { created: { type: 'datetime', template: 'MM/DD/YY' } }
          })
        ]
      )
    ).toBe(true)
  })

  it('true when only drilldown changed', () => {
    expect(
      isDisplayOnlySourceChange(
        [existingSource({ drilldown: '{"project.name":{"enabled":true}}' })],
        [incomingSource({ drilldown: { 'project.name': { enabled: false } } })]
      )
    ).toBe(true)
  })

  it('false when filters changed', () => {
    expect(
      isDisplayOnlySourceChange(
        [existingSource()],
        [incomingSource({ filters: [{ field: 'zone', op: 'eq', value: '1' }] })]
      )
    ).toBe(false)
  })

  it('false when extra_fields changed (cache stores them)', () => {
    expect(
      isDisplayOnlySourceChange(
        [existingSource()],
        [incomingSource({ extra_fields: ['project.name', 'vendor.name'] })]
      )
    ).toBe(false)
  })

  it('false when state_values, label_template, or source count changed', () => {
    expect(
      isDisplayOnlySourceChange([existingSource()], [incomingSource({ state_values: [] })])
    ).toBe(false)
    expect(
      isDisplayOnlySourceChange(
        [existingSource()],
        [incomingSource({ label_template: '{{number}}' })]
      )
    ).toBe(false)
    expect(
      isDisplayOnlySourceChange([existingSource()], [incomingSource(), incomingSource({ sort: 1 })])
    ).toBe(false)
  })

  it('false when aggregates changed (cache stores aggregated values)', () => {
    expect(
      isDisplayOnlySourceChange(
        [existingSource()],
        [incomingSource({ aggregates: { 'purchase_orders.amount': 'sum' } })]
      )
    ).toBe(false)
  })

  it('true when identical aggregates ride along a format-only change', () => {
    expect(
      isDisplayOnlySourceChange(
        [existingSource({ aggregates: '{"purchase_orders.amount":"sum"}' })],
        [
          incomingSource({
            aggregates: { 'purchase_orders.amount': 'sum' },
            column_formats: { created: { type: 'datetime', template: 'MM/DD/YY' } }
          })
        ]
      )
    ).toBe(true)
  })

  it('empty aggregates object from the UI matches stored null (fast path preserved)', () => {
    expect(
      isDisplayOnlySourceChange(
        [existingSource({ aggregates: null })],
        [
          incomingSource({
            aggregates: {},
            column_formats: { created: { type: 'datetime', template: 'MM/DD/YY' } }
          })
        ]
      )
    ).toBe(true)
  })

  it('false for an empty existing set (nothing to preserve)', () => {
    expect(isDisplayOnlySourceChange([], [])).toBe(false)
  })

  it('null-vs-absent JSON falls back to rebuild, never the reverse', () => {
    // stored filters null, incoming [] — conservative mismatch
    expect(isDisplayOnlySourceChange([existingSource({ filters: null })], [incomingSource()])).toBe(
      false
    )
  })
})

describe('computeExtraFieldMeta aggregates', () => {
  it('marks aggregated paths with the configured function', async () => {
    const relations = [
      {
        id: 1,
        many_collection: 'wpo_junction',
        many_field: 'workflow_id',
        one_collection: 'workflows',
        one_field: 'purchase_orders',
        junction_field: 'po_id'
      },
      {
        id: 2,
        many_collection: 'wpo_junction',
        many_field: 'po_id',
        one_collection: 'purchase_orders',
        one_field: null,
        junction_field: 'workflow_id'
      }
    ]
    const fakeDb = (() => Promise.resolve(relations)) as never
    const meta = await computeExtraFieldMeta(
      [
        {
          id: 1,
          queue_id: 'q',
          type: 'collection',
          collection: 'workflows',
          filters: null,
          state_values: null,
          sla_filter: null,
          extra_fields: '["purchase_orders.amount"]',
          aggregates: '{"purchase_orders.amount":"sum"}',
          sort: 0
        } as never
      ],
      fakeDb
    )
    expect(meta).toEqual([
      {
        path: 'purchase_orders.amount',
        kind: 'relation',
        relation_type: 'm2m',
        target_collection: 'purchase_orders',
        display_field: 'amount',
        aggregate: 'sum'
      }
    ])
  })
})
