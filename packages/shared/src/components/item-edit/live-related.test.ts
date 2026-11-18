import { describe, expect, it } from 'vitest'
import { diffFileIds } from './file-live'
import {
  ADDENDUM_DETAIL_KEYS,
  actionQueryOfRecord,
  fileQueryOfRecord,
  relatedQueryOfRecord,
  resolvedPathQueryOfRecord,
  wideSpreadDelay
} from './live-related'

describe('relatedQueryOfRecord ($related)', () => {
  const is = relatedQueryOfRecord('workflows', '77')
  it('refreshes this record’s grids, links and related panels only', () => {
    expect(is(['o2m-rows', 'workflow_lines', 'workflow', '77', ''])).toBe(true)
    expect(is(['o2m-rows', 'workflow_lines', 'workflow', '78', ''])).toBe(false)
    expect(is(['m2m-items', 'workflows_divisions', 'workflows_id', 77])).toBe(true)
    expect(is(['rrv-related', 'workflows', '77'])).toBe(true)
    expect(is(['rrv-related', 'projects', '77'])).toBe(false)
    expect(is(['record-links', 'workflows', '77'])).toBe(true)
    expect(is(['o2m-compare', '/forecast'])).toBe(true)
    // Never the record's own row: its columns did not move (rollups announce themselves).
    expect(is(['item', 'workflows', '77'])).toBe(false)
  })
  it('spreads a collection-wide notice over a few seconds', () => {
    expect(wideSpreadDelay(() => 0)).toBe(0)
    expect(wideSpreadDelay(() => 0.999)).toBeLessThan(3000)
  })
})

describe('fileQueryOfRecord ($files)', () => {
  const is = fileQueryOfRecord('workflows', '77')
  it('refreshes this record’s file links, usage, downloads and file names', () => {
    expect(is(['m2m-items', 'workflows_files', 'workflows_id', '77'])).toBe(true)
    expect(is(['file-usage', 'workflows', '77', 'f1'])).toBe(true)
    expect(is(['file-usage', 'workflows', '78', 'f1'])).toBe(false)
    expect(is(['file-download-stats', 'workflows', '77'])).toBe(true)
    expect(is(['files-meta', 'f1', 'f2'])).toBe(true)
    expect(is(['o2m-rows', 'x', 'y', '77'])).toBe(false)
  })
})

describe('diffFileIds (Files panel live)', () => {
  it('the first read is the baseline', () => {
    expect(diffFileIds(null, ['a'], new Map())).toEqual({ arrived: [], gone: [] })
  })
  it('names files someone else added and removed, case-insensitively', () => {
    expect(diffFileIds(['A', 'b'], ['a', 'c'], new Map())).toEqual({ arrived: ['c'], gone: ['b'] })
  })
  it('the person’s own adds and removes are theirs (no fade, no ghost)', () => {
    const now = 1_000_000
    const own = new Map([
      ['c', now - 1000],
      ['b', now - 1000]
    ])
    expect(diffFileIds(['a', 'b'], ['a', 'c'], own, now)).toEqual({ arrived: [], gone: [] })
    // An old own change no longer hides someone else's.
    const old = new Map([['c', now - 60_000]])
    expect(diffFileIds(['a'], ['a', 'c'], old, now).arrived).toEqual(['c'])
  })
})

describe('realtime gaps 2026-11-17 (C2, C3, C5, Low shared 1)', () => {
  it('$related reaches "Referenced by" and the Summary many-to-any list', () => {
    const is = relatedQueryOfRecord('workflows', '12')
    expect(is(['referenced-by', 'workflows', 12])).toBe(true)
    expect(is(['referenced-by', 'workflows', 13])).toBe(false)
    expect(is(['summary-m2a-items', 'wf_links', 'workflows_id', '12', 'item'])).toBe(true)
    expect(is(['summary-m2a-items', 'wf_links', 'workflows_id', '99', 'item'])).toBe(false)
  })

  it('a move refreshes the per-state action buttons, header and row menu alike', () => {
    const is = actionQueryOfRecord('workflows', '12')
    expect(is(['item-actions', 'workflows', 12])).toBe(true)
    expect(is(['ext-item-actions', 'workflows', '12'])).toBe(true)
    expect(is(['item-actions', 'workflows', '13'])).toBe(false)
    expect(is(['item-actions', 'invoices', '12'])).toBe(false)
  })

  it('a remote write refreshes the relation-path fields', () => {
    const is = resolvedPathQueryOfRecord('purchase_orders', '5')
    expect(is(['resolve-paths', 'purchase_orders', 5, 'workflow.workflow_id'])).toBe(true)
    expect(is(['resolve-paths', 'purchase_orders', 6, 'workflow.workflow_id'])).toBe(false)
  })

  it('an addendum change refreshes its card workflow block and lines', () => {
    expect(ADDENDUM_DETAIL_KEYS).toContainEqual(['pipeline-instance', 'nivaro_addendums'])
    expect(ADDENDUM_DETAIL_KEYS).toContainEqual(['addendum-lines'])
  })
})
