import { describe, expect, it } from 'vitest'
import { type CascadeRelation, cascadeFilter } from './quick-filter-cascade'

const RELS: CascadeRelation[] = [
  {
    many_collection: 'regions',
    many_field: 'division',
    one_collection: 'divisions',
    one_field: 'regions'
  },
  // Reverse link: a division's office region — must never narrow regions.
  { many_collection: 'divisions', many_field: 'division_region', one_collection: 'regions' },
  {
    many_collection: 'location_regions_junction',
    many_field: 'region',
    one_collection: 'regions',
    junction_field: 'location'
  }
]

describe('cascadeFilter', () => {
  it('narrows regions by the picked zones through regions.division', () => {
    expect(
      cascadeFilter('regions', RELS, [{ collection: 'divisions', field: 'id', values: [2] }])
    ).toEqual({ division: { _in: [2] } })
  })

  it('narrows by display values through the related field', () => {
    expect(
      cascadeFilter('regions', RELS, [
        { collection: 'divisions', field: 'short_name', values: ['Zone 1'] }
      ])
    ).toEqual({ division: { short_name: { _in: ['Zone 1'] } } })
  })

  it('never follows the office link against the declared hierarchy, nor a junction', () => {
    expect(
      cascadeFilter('divisions', RELS, [{ collection: 'regions', field: 'id', values: [1] }])
    ).toBeNull()
    // Without the declared children list, a one-way link still narrows.
    expect(
      cascadeFilter('divisions', RELS.slice(1), [
        { collection: 'regions', field: 'id', values: [1] }
      ])
    ).toEqual({ division_region: { _in: [1] } })
    expect(
      cascadeFilter('regions', RELS, [{ collection: 'locations', field: 'id', values: [1] }])
    ).toBeNull()
  })

  it('is null with no picks and combines several sources with _and', () => {
    expect(
      cascadeFilter('regions', RELS, [{ collection: 'divisions', field: 'id', values: [] }])
    ).toBeNull()
    const rels = [
      ...RELS,
      { many_collection: 'regions', many_field: 'market', one_collection: 'markets' }
    ]
    expect(
      cascadeFilter('regions', rels, [
        { collection: 'divisions', field: 'id', values: [2] },
        { collection: 'markets', field: 'id', values: [7] }
      ])
    ).toEqual({ _and: [{ division: { _in: [2] } }, { market: { _in: [7] } }] })
  })
})
