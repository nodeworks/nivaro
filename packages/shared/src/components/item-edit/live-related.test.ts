import { describe, expect, it } from 'vitest'
import { fileQueryOfRecord, relatedQueryOfRecord, wideSpreadDelay } from './live-related'
import { diffFileIds } from './file-live'

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
