import { describe, expect, it } from 'vitest'
import {
  mergeFilterOptions,
  PAGE_LIMIT,
  REST_LIMIT,
  relationFilterRequests,
  SEARCH_LIMIT
} from './cbv-relation-filter'

describe('relation column filter options — the whole related collection', () => {
  it('asks for the page values AND the rest of the related records', () => {
    const reqs = relationFilterRequests({
      search: '',
      preferIds: [3, 7],
      labelField: 'short_name',
      fields: 'id,short_name'
    })
    expect(reqs).toHaveLength(2)
    expect(reqs[0]).toMatchObject({
      limit: PAGE_LIMIT,
      filter: JSON.stringify({ id: { _in: [3, 7] } }),
      fields: 'id,short_name'
    })
    expect(reqs[0]).not.toHaveProperty('picker')
    expect(reqs[1]).toMatchObject({ limit: REST_LIMIT, sort: '-id', picker: '1' })
    expect(reqs[1]).not.toHaveProperty('filter')
  })

  it('an empty page still lists the related records; a search goes to the whole table', () => {
    expect(relationFilterRequests({ search: '', labelField: 'name' })).toEqual([
      { limit: REST_LIMIT, sort: '-id', picker: '1' }
    ])
    expect(relationFilterRequests({ search: 'kea', preferIds: [1], labelField: 'name' })).toEqual([
      { limit: SEARCH_LIMIT, sort: 'name', search: 'kea', picker: '1' }
    ])
  })

  it('merges page values first, then the rest, each sorted, each value once', () => {
    const page = [
      { value: 4, label: 'KEY' },
      { value: 2, label: 'BLT' }
    ]
    const rest = [
      { value: 9, label: 'WIL' },
      { value: 2, label: 'BLT' },
      { value: 11, label: 'ALB' },
      { value: 12, label: '' }
    ]
    expect(mergeFilterOptions([page, rest]).map((o) => o.label)).toEqual([
      'BLT',
      'KEY',
      'ALB',
      'WIL'
    ])
  })
})
