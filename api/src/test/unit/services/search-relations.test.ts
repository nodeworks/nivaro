import { describe, expect, it } from 'vitest'
import {
  groupSearchRelations,
  judgeSearchRelations,
  MAX_PATHS,
  parseSearchRelations,
  type SearchHop,
  type SearchRelationDeps,
  searchRelationCollections
} from '../../../services/search-relations.js'

describe('parseSearchRelations', () => {
  it('reads dotted paths from JSON text or an object, deduplicated', () => {
    expect(
      parseSearchRelations(
        '{"search_relations":["regions.name","Regions.Name","division.region.name"]}'
      )
    ).toEqual([
      ['regions', 'name'],
      ['division', 'region', 'name']
    ])
    expect(parseSearchRelations({ search_relations: ['regions.short_name'] })).toEqual([
      ['regions', 'short_name']
    ])
  })

  it('drops a bare column, a path too deep, unsafe names; unset / malformed = null', () => {
    expect(
      parseSearchRelations({ search_relations: ['name', 'a.b.c.d.e', 'x;drop.y', 'a..b'] })
    ).toBe(null)
    expect(parseSearchRelations(null)).toBe(null)
    expect(parseSearchRelations('{not json')).toBe(null)
    expect(parseSearchRelations({ search_relations: 'regions.name' })).toBe(null)
  })

  it('keeps at most MAX_PATHS paths', () => {
    const many = Array.from({ length: 10 }, (_, i) => `rel${i}.name`)
    expect(parseSearchRelations({ search_relations: many })?.length).toBe(MAX_PATHS)
  })
})

describe('judgeSearchRelations (as the caller, hop by hop)', () => {
  const REGIONS: SearchHop = {
    kind: 'm2m',
    to: 'regions',
    column: 'regions',
    junction: 'project_regions',
    fkToParent: 'project',
    fkToOther: 'region'
  }
  const DIVISION: SearchHop = { kind: 'm2o', to: 'divisions', column: 'division_id' }
  const REGION: SearchHop = { kind: 'm2o', to: 'regions', column: 'region' }
  const PARENT: SearchHop = { kind: 'm2o', to: 'projects', column: 'parent' }
  const deps = (over: Partial<SearchRelationDeps> = {}): SearchRelationDeps => ({
    hop: async (c, seg) =>
      c === 'projects' && seg === 'regions'
        ? REGIONS
        : c === 'projects' && seg === 'division'
          ? DIVISION
          : c === 'divisions' && seg === 'region'
            ? REGION
            : c === 'projects' && seg === 'parent'
              ? PARENT
              : null,
    isTextColumn: async (c, f) => c === 'regions' && (f === 'name' || f === 'short_name'),
    canRead: async () => true,
    allowedFields: async () => null,
    isSystem: (c) => c.startsWith('nivaro_'),
    ...over
  })

  it('accepts a readable M2M and a two-hop M2O path, naming the collections reached', async () => {
    const out = await judgeSearchRelations(
      'projects',
      [
        ['regions', 'name'],
        ['division', 'region', 'name']
      ],
      null,
      deps()
    )
    expect(out).toEqual([
      { segments: ['regions', 'name'], hops: [REGIONS], field: 'name' },
      { segments: ['division', 'region', 'name'], hops: [DIVISION, REGION], field: 'name' }
    ])
  })

  it('refuses a path that names a table twice (self-relation, unaliased EXISTS chain)', async () => {
    expect(await judgeSearchRelations('projects', [['parent', 'name']], null, deps())).toEqual([])
  })

  it('groups paths taking the same hops into one EXISTS and names every collection reached', async () => {
    const out = await judgeSearchRelations(
      'projects',
      [
        ['regions', 'name'],
        ['regions', 'short_name'],
        ['division', 'region', 'name']
      ],
      null,
      deps()
    )
    const groups = groupSearchRelations(out)
    expect(groups).toEqual([
      { hops: [REGIONS], fields: ['name', 'short_name'] },
      { hops: [DIVISION, REGION], fields: ['name'] }
    ])
    expect(searchRelationCollections(groups).sort()).toEqual(['divisions', 'regions'])
  })

  it('an M2O FK listed by its column name counts as readable', async () => {
    const out = await judgeSearchRelations(
      'projects',
      [['division', 'region', 'name']],
      ['id', 'division_id'],
      deps({ allowedFields: async (c) => (c === 'divisions' ? ['region'] : ['name']) })
    )
    expect(out).toHaveLength(1)
  })

  it('refuses a middle hop field the caller cannot read', async () => {
    const out = await judgeSearchRelations(
      'projects',
      [['division', 'region', 'name']],
      null,
      deps({ allowedFields: async (c) => (c === 'divisions' ? ['id', 'name'] : null) })
    )
    expect(out).toEqual([])
  })

  it('refuses a far field outside the caller field list, a non-text field, an unreadable or system collection', async () => {
    const p = [['regions', 'name']]
    expect(
      await judgeSearchRelations('projects', p, null, deps({ allowedFields: async () => ['id'] }))
    ).toEqual([])
    expect(await judgeSearchRelations('projects', [['regions', 'id']], null, deps())).toEqual([])
    expect(
      await judgeSearchRelations('projects', p, null, deps({ canRead: async () => false }))
    ).toEqual([])
    expect(await judgeSearchRelations('projects', p, null, deps({ isSystem: () => true }))).toEqual(
      []
    )
    // no read policy on the related collection = nothing readable there
    expect(
      await judgeSearchRelations('projects', p, null, deps({ allowedFields: async () => [] }))
    ).toEqual([])
  })

  it('refuses an O2M / unknown hop and a failing lookup (fails closed)', async () => {
    expect(await judgeSearchRelations('projects', [['workflows', 'name']], null, deps())).toEqual(
      []
    )
    expect(
      await judgeSearchRelations(
        'projects',
        [['regions', 'name']],
        null,
        deps({
          canRead: async () => {
            throw new Error('db down')
          }
        })
      )
    ).toEqual([])
  })
})
