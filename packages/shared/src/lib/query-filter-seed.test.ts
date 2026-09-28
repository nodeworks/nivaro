import { describe, expect, it } from 'vitest'
import { initialFilterSelection } from './query-filter-seed'

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
