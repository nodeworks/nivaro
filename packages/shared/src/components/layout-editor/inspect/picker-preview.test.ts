import { describe, expect, it } from 'vitest'
import { m2mParents, previewNarrowing } from './picker-preview'

const labelOf = (f: string) => f.toUpperCase()

describe('previewNarrowing', () => {
  it('compiles cascades and the option filter off the sample record', () => {
    const n = previewNarrowing({
      target: 'projects',
      rules: [
        { parent_field: 'zone', filter_column: 'zone' },
        { parent_field: 'year', filter_column: 'funding_year' }
      ],
      optionFilter: { status: { _eq: 'open' }, owner: { _eq: '$parent.owner' } },
      record: { zone: 4, year: null, owner: 'u1' },
      itemId: '12',
      labelOf
    })
    expect(n.steps).toEqual([
      { key: 'cascade', label: 'Cascade filters (ZONE)', filter: { zone: { _eq: 4 } } },
      {
        key: 'option_filter',
        label: 'Option filter',
        filter: { status: { _eq: 'open' }, owner: { _eq: 'u1' } }
      }
    ])
    expect(n.satisfied).toEqual(['zone'])
    expect(n.waitsFor).toBeNull()
  })

  it('reads many-to-many parents from the linked ids and names a required empty parent', () => {
    const n = previewNarrowing({
      target: 'regions',
      rules: [
        { parent_field: 'zones', filter_column: 'zone' },
        { parent_field: 'site', filter_column: 'site', show_all_if_no_parent: false }
      ],
      optionFilter: null,
      record: { zones: [] },
      linked: { zones: [1, 2] },
      itemId: '5',
      labelOf
    })
    expect(n.steps[0].filter).toEqual({ zone: { _in: ['1', '2'] } })
    expect(n.waitsFor).toBe('site')
  })

  it('drops an option filter whose token cannot resolve, and narrows people pickers', () => {
    const n = previewNarrowing({
      target: 'nivaro_users',
      rules: [],
      optionFilter: { team: { _eq: '$parent.team' } },
      record: {},
      itemId: '5',
      labelOf
    })
    expect(n.steps.map((s) => s.key)).toEqual(['people', 'option_filter'])
    expect(n.steps[1].filter).toBeNull()
  })
})

describe('m2mParents', () => {
  it('finds the junction behind an alias parent', () => {
    const rels = [
      {
        many_collection: 'orders_zones',
        many_field: 'orders_id',
        one_collection: 'orders',
        one_field: 'zones',
        junction_field: 'zones_id'
      },
      {
        many_collection: 'orders_zones',
        many_field: 'zones_id',
        one_collection: 'zones',
        one_field: null,
        junction_field: 'orders_id'
      }
    ]
    expect(m2mParents([{ parent_field: 'zones', filter_column: 'zone' }], 'orders', rels)).toEqual([
      { parent: 'zones', junction: 'orders_zones', parentFk: 'orders_id', targetFk: 'zones_id' }
    ])
    expect(m2mParents([{ parent_field: 'site', filter_column: 'site' }], 'orders', rels)).toEqual(
      []
    )
  })
})
