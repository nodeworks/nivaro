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
    const many = Array.from({ length: MAX_PATHS + 4 }, (_, i) => `rel${i}.name`)
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

  describe('the person directory (a record known by a person on it)', () => {
    const CONTACT: SearchHop = { kind: 'm2o', to: 'nivaro_users', column: 'contact' }
    const WATCHERS: SearchHop = {
      kind: 'm2m',
      to: 'nivaro_users',
      column: 'watchers',
      junction: 'project_watchers',
      fkToParent: 'project',
      fkToOther: 'user'
    }
    const MANAGER: SearchHop = { kind: 'm2o', to: 'nivaro_users', column: 'manager_id' }
    const people = (over: Partial<SearchRelationDeps> = {}) =>
      deps({
        hop: async (c, seg) =>
          c === 'projects' && seg === 'contact'
            ? CONTACT
            : c === 'projects' && seg === 'watchers'
              ? WATCHERS
              : c === 'nivaro_users' && seg === 'manager_id'
                ? MANAGER
                : c === 'projects' && seg === 'log'
                  ? { kind: 'm2o', to: 'nivaro_activity', column: 'log' }
                  : null,
        isTextColumn: async (c) => c === 'nivaro_users' || c === 'nivaro_activity',
        ...over
      })

    it('a to-one hop may end on a person’s first or last name', async () => {
      const out = await judgeSearchRelations(
        'projects',
        [
          ['contact', 'first_name'],
          ['contact', 'last_name']
        ],
        null,
        people()
      )
      expect(out.map((o) => o.segments.join('.'))).toEqual([
        'contact.first_name',
        'contact.last_name'
      ])
      expect(groupSearchRelations(out)).toEqual([
        { hops: [CONTACT], fields: ['first_name', 'last_name'] }
      ])
    })

    it('never any other column of the directory, whatever the caller may read', async () => {
      for (const field of ['email', 'static_token', 'password_hash', 'title', 'preferences'])
        expect(
          await judgeSearchRelations('projects', [['contact', field]], null, people())
        ).toEqual([])
    })

    it('only as the last hop, only to-one, and no other system table', async () => {
      // On from a person (their manager), through a junction, into another system table.
      expect(
        await judgeSearchRelations(
          'projects',
          [['contact', 'manager_id', 'last_name']],
          null,
          people()
        )
      ).toEqual([])
      expect(
        await judgeSearchRelations('projects', [['watchers', 'last_name']], null, people())
      ).toEqual([])
      expect(await judgeSearchRelations('projects', [['log', 'comment']], null, people())).toEqual(
        []
      )
    })

    it('still judged as the caller: the FK and the name must be readable to them', async () => {
      const p = [['contact', 'last_name']]
      expect(await judgeSearchRelations('projects', p, ['id', 'name'], people())).toEqual([])
      expect(
        await judgeSearchRelations(
          'projects',
          p,
          null,
          people({ allowedFields: async () => ['id', 'email'] })
        )
      ).toEqual([])
      expect(
        await judgeSearchRelations('projects', p, null, people({ canRead: async () => false }))
      ).toEqual([])
    })
  })

  it('asks who may read what once per collection, for every collection reached at once', async () => {
    // Judged one await after another, each new path cost a scoped person two more round
    // trips before the search itself began (measured on a workflows list, 2026-11-12).
    let inFlight = 0
    let most = 0
    const asked: string[] = []
    const slow = async <T>(c: string, kind: string, v: T): Promise<T> => {
      asked.push(`${kind}:${c}`)
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return v
    }
    const out = await judgeSearchRelations(
      'projects',
      [
        ['regions', 'name'],
        ['regions', 'short_name'],
        ['division', 'region', 'name']
      ],
      null,
      deps({
        canRead: (c) => slow(c, 'can', true),
        allowedFields: (c) => slow(c, 'fields', null)
      })
    )
    expect(out).toHaveLength(3)
    expect([...asked].sort()).toEqual(
      ['can:divisions', 'can:regions', 'fields:divisions', 'fields:regions'].sort()
    )
    // All four were in flight together: one round trip, not four.
    expect(most).toBe(4)
  })

  it('never asks about a system table it will not reach', async () => {
    const asked: string[] = []
    await judgeSearchRelations(
      'projects',
      [['log', 'comment']],
      null,
      deps({
        hop: async () => ({ kind: 'm2o', to: 'nivaro_activity', column: 'log' }),
        canRead: async (c) => {
          asked.push(c)
          return true
        }
      })
    )
    expect(asked).toEqual([])
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
