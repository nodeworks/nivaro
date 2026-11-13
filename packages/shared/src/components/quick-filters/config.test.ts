import { describe, expect, it } from 'vitest'
import {
  cleanQuickFilters,
  mergeQuickFilters,
  moveFilter,
  pruneQuickSelection,
  type QuickFilterDef,
  quickFilterProblems,
  quickFiltersEqual,
  slugKey,
  uniqueKey
} from './config'

const FY: QuickFilterDef = {
  key: 'fy',
  label: 'Funding Year',
  path: ['workflow', 'funding_years'],
  collection: 'funding_years',
  label_field: 'year',
  sort: '-year'
}
const ZONE: QuickFilterDef = {
  key: 'zone',
  label: 'Zone',
  path: ['workflow', 'divisions'],
  collection: 'divisions',
  label_field: 'name'
}
const REGION: QuickFilterDef = {
  key: 'region',
  label: 'Region',
  path: ['workflow', 'regions'],
  collection: 'regions',
  label_field: 'name'
}

describe('slugKey / uniqueKey', () => {
  it('turns a label into a key', () => {
    expect(slugKey('  Project Type ')).toBe('project_type')
    expect(slugKey('Sub-Type (CAR)')).toBe('sub_type_car')
  })
  it('never hands out a key already used', () => {
    expect(uniqueKey('zone', [ZONE])).toBe('zone_2')
    expect(uniqueKey('zone', [ZONE, { ...ZONE, key: 'zone_2' }])).toBe('zone_3')
    expect(uniqueKey('region', [ZONE])).toBe('region')
  })
})

describe('quickFilterProblems', () => {
  it('passes a complete filter', () => {
    expect(quickFilterProblems(FY, [FY, ZONE])).toEqual([])
  })
  it('names what a half-built filter is missing', () => {
    const half: QuickFilterDef = { key: '', label: '', path: [], collection: '', label_field: '' }
    expect(quickFilterProblems(half, [half])).toEqual([
      'needs a key',
      'needs a name',
      'needs a field',
      'needs an options source',
      'needs a column to show'
    ])
  })
  it('flags a duplicate key', () => {
    expect(quickFilterProblems(ZONE, [ZONE, { ...REGION, key: 'zone' }])).toContain('duplicate key')
  })
  it('accepts or_paths in place of a path', () => {
    expect(quickFilterProblems({ ...FY, path: [], or_paths: [['a'], ['b', 'c']] }, [])).toEqual([])
  })
})

describe('cleanQuickFilters', () => {
  it('drops incomplete rows and keeps keys this UI does not know about', () => {
    const extra = { ...REGION, cascade_from: 'zone', future_flag: true } as QuickFilterDef
    const out = cleanQuickFilters([
      FY,
      { key: 'x', label: '', path: [], collection: '', label_field: '' },
      extra
    ])
    expect(out).toEqual([FY, extra])
    expect((out[1] as unknown as { future_flag: boolean }).future_flag).toBe(true)
  })
  it('trims text and drops empty optional parts', () => {
    const out = cleanQuickFilters([
      { ...ZONE, label: ' Zone ', value_field: '', sort: '', or_paths: [] }
    ])
    expect(out).toEqual([ZONE])
  })
  it('round-trips a stored list unchanged', () => {
    const stored = [FY, ZONE, REGION]
    expect(cleanQuickFilters(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
  })
})

describe('mergeQuickFilters', () => {
  it('replaces only quick_filters and keeps every other browser setting', () => {
    const bc = { page_size: 50, inline_edit: { enabled: true, fields: ['a'] }, quick_filters: [FY] }
    expect(mergeQuickFilters(bc, [ZONE])).toEqual({
      page_size: 50,
      inline_edit: { enabled: true, fields: ['a'] },
      quick_filters: [ZONE]
    })
  })
  it('removes the key when the bar is emptied, and stores null when nothing is left', () => {
    expect(mergeQuickFilters({ page_size: 50, quick_filters: [FY] }, [])).toEqual({
      page_size: 50
    })
    expect(mergeQuickFilters({ quick_filters: [FY] }, [])).toBeNull()
    expect(mergeQuickFilters(null, [FY])).toEqual({ quick_filters: [FY] })
  })
})

describe('moveFilter', () => {
  it('moves one place and stays inside the list', () => {
    expect(moveFilter([FY, ZONE, REGION], 0, 1).map((f) => f.key)).toEqual(['zone', 'fy', 'region'])
    expect(moveFilter([FY, ZONE], 0, -1)).toEqual([FY, ZONE])
    expect(moveFilter([FY, ZONE], 1, 2)).toEqual([FY, ZONE])
  })
})

describe('quickFiltersEqual', () => {
  it('compares order and content', () => {
    expect(quickFiltersEqual([FY, ZONE], [FY, ZONE])).toBe(true)
    expect(quickFiltersEqual([FY, ZONE], [ZONE, FY])).toBe(false)
    expect(quickFiltersEqual([FY], [{ ...FY, label: 'FY' }])).toBe(false)
  })
})

describe('pruneQuickSelection', () => {
  it('drops picks of a removed filter and keeps the rest', () => {
    const sel = { fy: [2026], zone: [3], region: [] }
    expect(pruneQuickSelection(sel, [FY, ZONE, REGION], [FY, REGION])).toEqual({
      fy: [2026],
      region: []
    })
  })
  it('keeps picks across a rename or a move', () => {
    const sel = { fy: [2026], zone: [3] }
    expect(
      pruneQuickSelection(
        sel,
        [FY, ZONE],
        [
          { ...ZONE, label: 'Zones' },
          { ...FY, sort: 'year' }
        ]
      )
    ).toEqual(sel)
  })
  it('drops picks whose meaning changed (other field, other options)', () => {
    const sel = { fy: [2026], zone: [3] }
    expect(
      pruneQuickSelection(sel, [FY, ZONE], [FY, { ...ZONE, path: ['workflow', 'regions'] }])
    ).toEqual({ fy: [2026] })
    expect(pruneQuickSelection(sel, [FY, ZONE], [FY, { ...ZONE, value_field: 'code' }])).toEqual({
      fy: [2026]
    })
  })
  it('keeps picks for keys it was never told about (a host filter)', () => {
    expect(pruneQuickSelection({ other: [1] }, [FY], [FY])).toEqual({ other: [1] })
  })
})
