import { describe, expect, it } from 'vitest'
import {
  explicitAllUrlParams,
  filterSelectionToSearch,
  initialFilterSelection
} from './query-filter-seed'

const now = new Date('2026-09-28T12:00:00Z')
const filters = [
  { param: 'funding_years', value_field: 'id', default_values: ['$current_year'], url_param: 'fy' },
  { param: 'divisions', value_field: 'short_name', url_param: 'zone' },
  { param: 'project_types', value_field: 'name' }
]

describe('initialFilterSelection', () => {
  it('uses default_values when the query string is silent', () => {
    expect(initialFilterSelection(filters, '', now)).toEqual({ funding_years: [{ id: 2026 }] })
  })

  it('lets a URL param beat default_values and splits comma lists', () => {
    expect(initialFilterSelection(filters, '?fy=2025&zone=Zone%201,Zone%202', now)).toEqual({
      funding_years: [{ id: '2025' }],
      divisions: [{ short_name: 'Zone 1' }, { short_name: 'Zone 2' }]
    })
  })

  it('ignores keys no filter names, and empty values', () => {
    expect(initialFilterSelection(filters, '?zone=&tab=overview&project_types=x', now)).toEqual({
      funding_years: [{ id: 2026 }]
    })
  })

  it('defaults value_field to id', () => {
    expect(initialFilterSelection([{ param: 'p', url_param: 'p' }], '?p=7', now)).toEqual({
      p: [{ id: '7' }]
    })
  })
})

describe('filters in the page address', () => {
  it('an emptied key means "All" on purpose: no default refills it', () => {
    expect(initialFilterSelection(filters, '?fy=', now)).toEqual({})
    expect([...explicitAllUrlParams(filters, '?fy=&zone=Zone%201&tab=x')]).toEqual([
      'funding_years'
    ])
  })

  it('a single filter keeps one value from the address or its defaults', () => {
    const single = [{ param: 'year', url_param: 'fy', single: true, default_values: [2026, 2025] }]
    expect(initialFilterSelection(single, '?fy=2025,2024', now)).toEqual({ year: [{ id: '2025' }] })
    expect(initialFilterSelection(single, '', now)).toEqual({ year: [{ id: 2026 }] })
  })

  it('writes every url_param filter, keeps other keys, and round-trips', () => {
    const search = filterSelectionToSearch(
      filters,
      {
        funding_years: [{ id: 2025 }],
        divisions: [{ short_name: 'Zone 1' }, { short_name: 'Zone 2' }]
      },
      '?tab=forecasting'
    )
    expect(search).toBe('?tab=forecasting&fy=2025&zone=Zone+1%2CZone+2')
    expect(initialFilterSelection(filters, search, now)).toEqual({
      funding_years: [{ id: '2025' }],
      divisions: [{ short_name: 'Zone 1' }, { short_name: 'Zone 2' }]
    })
    expect(filterSelectionToSearch(filters, {}, '')).toBe('?fy=&zone=')
  })
})
