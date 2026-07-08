import { describe, expect, it } from 'vitest'
import {
  filterAndOrderNarrowRows,
  type NarrowScanRow,
  requiresLiveResolveFallback,
  statsFromNarrowRows
} from '../../../services/queue-materialization-read.js'
import { computePriorityScore, type QueueItem } from '../../../services/queues.js'

describe('requiresLiveResolveFallback', () => {
  it('serves extra-field sorts from the cache (JSON_VALUE pushdown)', () => {
    expect(requiresLiveResolveFallback('extra.owner.name', {})).toBe(false)
  })

  it('serves extra-field column filters from the cache (JSON_VALUE pushdown)', () => {
    expect(requiresLiveResolveFallback('', { 'extra.priority': 'High' })).toBe(false)
  })

  it('serves sla_status filters from the cache (narrow-scan JS path)', () => {
    expect(requiresLiveResolveFallback('', { sla_status: 'breached' })).toBe(false)
  })

  it('serves aging_hours filters from the cache (narrow-scan JS path)', () => {
    expect(requiresLiveResolveFallback('', { aging_hours: { min: 1, max: 10 } })).toBe(false)
  })

  it('serves priority sorts from the cache (narrow-scan JS path)', () => {
    expect(requiresLiveResolveFallback('-priority', {})).toBe(false)
  })

  it('returns true when sort is owners', () => {
    expect(requiresLiveResolveFallback('owners', {})).toBe(true)
  })

  it('returns true when sort is -owners (descending)', () => {
    expect(requiresLiveResolveFallback('-owners', {})).toBe(true)
  })

  it('returns false when neither sort nor filters reference any fallback-triggering field', () => {
    expect(requiresLiveResolveFallback('-aging_hours', { state: 'review' })).toBe(false)
  })

  it('returns false for empty sort and filters', () => {
    expect(requiresLiveResolveFallback('', {})).toBe(false)
  })
})

function narrow(overrides: Partial<NarrowScanRow> = {}): NarrowScanRow {
  return {
    id: 1,
    label: 'Item',
    state: 'review',
    collection: 'articles',
    at_risk: false,
    has_owner: true,
    sla_status: null,
    aging_hours: null,
    sort_val: null,
    ...overrides
  }
}

describe('filterAndOrderNarrowRows', () => {
  it('filters by sla_status equality', () => {
    const rows = [
      narrow({ id: 1, sla_status: 'breached' }),
      narrow({ id: 2, sla_status: 'ok' }),
      narrow({ id: 3, sla_status: null })
    ]
    expect(filterAndOrderNarrowRows(rows, { sla_status: 'breached' }, '').map((r) => r.id)).toEqual(
      [1]
    )
  })

  it('filters by aging_hours range and drops null aging', () => {
    const rows = [
      narrow({ id: 1, aging_hours: 5 }),
      narrow({ id: 2, aging_hours: 50 }),
      narrow({ id: 3, aging_hours: null })
    ]
    expect(
      filterAndOrderNarrowRows(rows, { aging_hours: { min: 10, max: 100 } }, '').map((r) => r.id)
    ).toEqual([2])
  })

  it('-priority orders by the same score as computePriorityScore', () => {
    const rows = [
      narrow({ id: 1, sla_status: 'ok', aging_hours: 3 }),
      narrow({ id: 2, sla_status: 'breached', aging_hours: 100 }),
      narrow({ id: 3, sla_status: 'warning', at_risk: true, aging_hours: 10 }),
      narrow({ id: 4, sla_status: null, aging_hours: 9999 })
    ]
    const ordered = filterAndOrderNarrowRows(rows, {}, '-priority').map((r) => r.id)
    const expected = [...rows]
      .sort((a, b) => {
        const toItem = (r: NarrowScanRow): QueueItem => ({
          collection: r.collection,
          item_id: String(r.id),
          label: r.label,
          state: r.state,
          state_color: null,
          owners: [],
          sla_status: r.sla_status,
          at_risk: r.at_risk,
          aging_hours: r.aging_hours,
          claimed_by: null,
          url: ''
        })
        return computePriorityScore(toItem(b)) - computePriorityScore(toItem(a))
      })
      .map((r) => r.id)
    expect(ordered).toEqual(expected)
  })

  it('sorts nulls last regardless of direction', () => {
    const rows = [
      narrow({ id: 1, aging_hours: null }),
      narrow({ id: 2, aging_hours: 5 }),
      narrow({ id: 3, aging_hours: 50 })
    ]
    expect(filterAndOrderNarrowRows(rows, {}, '-aging_hours').map((r) => r.id)).toEqual([3, 2, 1])
    expect(filterAndOrderNarrowRows(rows, {}, 'aging_hours').map((r) => r.id)).toEqual([2, 3, 1])
  })

  it('sorts by extra.* via sort_val', () => {
    const rows = [
      narrow({ id: 1, sort_val: 'beta' }),
      narrow({ id: 2, sort_val: 'alpha' }),
      narrow({ id: 3, sort_val: null })
    ]
    expect(filterAndOrderNarrowRows(rows, {}, 'extra.name').map((r) => r.id)).toEqual([2, 1, 3])
  })
})

describe('statsFromNarrowRows', () => {
  it('buckets states and counts unowned/sla/at-risk', () => {
    const rows = [
      narrow({ id: 1, state: 'review', sla_status: 'breached', has_owner: false }),
      narrow({ id: 2, state: 'review', sla_status: 'warning', at_risk: true }),
      narrow({ id: 3, state: null })
    ]
    expect(statsFromNarrowRows(rows)).toEqual({
      total: 3,
      by_state: { review: 2, none: 1 },
      unowned: 1,
      sla_warning: 1,
      sla_breached: 1,
      at_risk: 1
    })
  })
})
