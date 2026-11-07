import { describe, expect, it } from 'vitest'
import { warmPageLookups } from './cbv-page-warm'

const relations = [
  { many_collection: 'workflows', many_field: 'billing_location', one_collection: 'locations' },
  { many_collection: 'workflows', many_field: 'creator', one_collection: 'nivaro_users' },
  { many_collection: 'workflows', many_field: 'legacy_user', one_collection: 'directus_users' }
]

function fakeQc() {
  const keys: unknown[][] = []
  return {
    keys,
    prefetchQuery: (o: { queryKey: readonly unknown[] }) => {
      keys.push([...o.queryKey])
      return Promise.resolve()
    }
  }
}

describe('warmPageLookups', () => {
  it('warms the per-page lookups a list row renders with, under the cells own keys', () => {
    const qc = fakeQc()
    warmPageLookups({
      qc,
      collection: 'workflows',
      rows: [
        { id: 1, billing_location: 10, creator: 'u-1', legacy_user: 'd-1', name: 'a' },
        { id: 2, billing_location: null, creator: 'u-2', name: 'b' },
        { id: 3, billing_location: 10, creator: '', name: 'c' }
      ],
      columns: ['name', 'billing_location', 'creator', 'legacy_user', 'project.name'],
      relations,
      resolveList: ['project.name'],
      isResolvedCol: (k) => k.includes('.'),
      fetchResolved: async () => ({}),
      fetchRelation: async () => null,
      userCardQuery: (id) => ({ queryKey: ['user-card', id], queryFn: async () => null })
    })
    expect(qc.keys).toEqual([
      ['cbv-resolved', 'workflows', '1,2,3', 'project.name'],
      ['cbv-relation-item', 'locations', '10'],
      ['user-card', 'u-1'],
      ['user-card', 'u-2']
    ])
  })

  it('does nothing for an empty page', () => {
    const qc = fakeQc()
    warmPageLookups({
      qc,
      collection: 'workflows',
      rows: [],
      columns: ['billing_location'],
      relations,
      resolveList: ['project.name'],
      isResolvedCol: () => false,
      fetchResolved: async () => ({}),
      fetchRelation: async () => null,
      userCardQuery: (id) => ({ queryKey: ['user-card', id], queryFn: async () => null })
    })
    expect(qc.keys).toEqual([])
  })
})
