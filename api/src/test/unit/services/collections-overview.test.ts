import { describe, expect, it } from 'vitest'
import {
  fieldLabel,
  filterSummaryFields,
  junctionCollections,
  mapRelations,
  mergeStats,
  parseServiceConfigCollection
} from '../../../services/collections-overview.js'
import type { CMSField, CMSRelation } from '../../../types.js'

const f = (field: string, extra: Partial<CMSField> = {}) =>
  ({ collection: 'a', field, type: 'string', special: null, sort: null, ...extra }) as CMSField
const rel = (extra: Partial<CMSRelation>) =>
  ({ id: 1, junction_field: null, one_collection: null, ...extra }) as CMSRelation

describe('collections-overview helpers', () => {
  it('parses service_config safely', () => {
    expect(parseServiceConfigCollection('{"collection":"x"}')).toBe('x')
    expect(parseServiceConfigCollection('nope')).toBeNull()
    expect(parseServiceConfigCollection(null)).toBeNull()
    expect(parseServiceConfigCollection('[1]')).toBeNull()
  })

  it('labels fields', () => {
    expect(fieldLabel('date_of_birth')).toBe('Date of birth')
  })

  it('filters alias and system fields and sorts', () => {
    const out = filterSummaryFields(
      [
        f('id'),
        f('b', { sort: 2 }),
        f('a', { sort: 1 }),
        f('lines', { special: ['o2m'] }),
        f('kids'),
        f('date_created')
      ],
      [rel({ one_collection: 'a', one_field: 'kids', many_collection: 'k', many_field: 'p' })]
    )
    expect(out.map((x) => x.field)).toEqual(['a', 'b'])
  })

  it('maps relations out and in, deduped', () => {
    const r = mapRelations('a', [
      rel({ many_collection: 'a', many_field: 'owner', one_collection: 'u' }),
      rel({ many_collection: 'a', many_field: 'owner', one_collection: 'u' }),
      rel({ many_collection: 'a', many_field: 'j', one_collection: 'x', junction_field: 'y' }),
      rel({ many_collection: 'c', many_field: 'a_id', one_collection: 'a' })
    ])
    expect(r.out).toEqual([{ field: 'owner', collection: 'u' }])
    expect(r.in).toEqual([{ collection: 'c', field: 'a_id' }])
  })

  it('merges stats case-insensitively and handles virtual', () => {
    const out = mergeStats({
      collections: [
        { collection: 'Items' },
        { collection: 'v', is_virtual: 1 },
        { collection: 'j' }
      ],
      rowCounts: new Map([
        ['items', 5],
        ['v', 9]
      ]),
      changed: new Map([['items', '2026-01-01T00:00:00Z']]),
      pipelines: new Map([['Items', 'P']]),
      forms: new Map([['Items', 2]]),
      jobImports: new Map([['Items', 1]]),
      defImports: new Map([['Items', 2]]),
      junctions: junctionCollections([rel({ many_collection: 'j', junction_field: 'x' })])
    })
    expect(out.Items).toMatchObject({
      rows: 5,
      changed_at: '2026-01-01T00:00:00.000Z',
      pipeline: 'P',
      forms: 2,
      imports: 3,
      link: false,
      virtual: false
    })
    expect(out.v).toMatchObject({ rows: null, virtual: true })
    expect(out.j).toMatchObject({ rows: null, link: true })
  })
})
