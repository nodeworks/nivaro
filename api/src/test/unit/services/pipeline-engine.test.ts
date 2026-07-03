import { describe, expect, it, vi } from 'vitest'
import {
  buildDelegationSubstitutions,
  type OwnerGroup,
  pickWinningGroups,
  resolveStateOwnersBatch
} from '../../../services/pipeline-engine.js'

function group(overrides: Partial<OwnerGroup> = {}): OwnerGroup {
  return {
    id: 'g1',
    template: 't1',
    state: 's1',
    name: null,
    filters: null,
    sort: 0,
    is_default: false,
    priority: 0,
    max_wip: null,
    ...overrides
  }
}

describe('pickWinningGroups', () => {
  it('returns the default groups when no non-default group matches', () => {
    const defaultGroup = group({ id: 'default', is_default: true })
    expect(pickWinningGroups([defaultGroup], {}, [])).toEqual([defaultGroup])
  })

  it('returns a matching non-default group over the default', () => {
    const defaultGroup = group({ id: 'default', is_default: true })
    const matching = group({
      id: 'matching',
      filters: JSON.stringify([{ field: 'priority', op: 'eq', value: 'high' }])
    })
    const result = pickWinningGroups([defaultGroup, matching], { priority: 'high' }, [])
    expect(result).toEqual([matching])
  })

  it('picks the group with more matching filters when multiple match (specificity)', () => {
    const broad = group({
      id: 'broad',
      filters: JSON.stringify([{ field: 'priority', op: 'eq', value: 'high' }])
    })
    const specific = group({
      id: 'specific',
      filters: JSON.stringify([
        { field: 'priority', op: 'eq', value: 'high' },
        { field: 'region', op: 'eq', value: 'east' }
      ])
    })
    const result = pickWinningGroups([broad, specific], { priority: 'high', region: 'east' }, [])
    expect(result).toEqual([specific])
  })

  it('breaks a specificity tie using priority ascending', () => {
    const lowPriority = group({
      id: 'low',
      priority: 5,
      filters: JSON.stringify([{ field: 'priority', op: 'eq', value: 'high' }])
    })
    const highPriority = group({
      id: 'high',
      priority: 1,
      filters: JSON.stringify([{ field: 'priority', op: 'eq', value: 'high' }])
    })
    const result = pickWinningGroups([lowPriority, highPriority], { priority: 'high' }, [])
    expect(result).toEqual([highPriority])
  })

  it('ignores a non-default group with no filters configured', () => {
    const noFilters = group({ id: 'no-filters', filters: null })
    const defaultGroup = group({ id: 'default', is_default: true })
    const result = pickWinningGroups([noFilters, defaultGroup], {}, [])
    expect(result).toEqual([defaultGroup])
  })

  it('resolves a dotted field via an m2o relation using id_value', () => {
    const matching = group({
      id: 'matching',
      filters: JSON.stringify([{ field: 'project.owner', op: 'eq', id_value: 'u1' }])
    })
    const relations = [
      { many_collection: 'tasks', many_field: 'project', one_collection: 'projects' }
    ]
    const result = pickWinningGroups([matching], { project: 'u1' }, relations)
    expect(result).toEqual([matching])
  })

  it('returns an empty array when nothing matches and there are no defaults', () => {
    const nonMatching = group({
      id: 'g1',
      filters: JSON.stringify([{ field: 'priority', op: 'eq', value: 'high' }])
    })
    const result = pickWinningGroups([nonMatching], { priority: 'low' }, [])
    expect(result).toEqual([])
  })
})

function makeFakeDb(tables: Record<string, unknown[]>) {
  return vi.fn((table: string) => ({
    whereIn: (_col: string, ids: string[]) => ({
      select: async () => (tables[table] ?? []).filter((r: any) => ids.includes(r.id))
    })
  })) as unknown as typeof import('../../../db/index.js').db
}

describe('buildDelegationSubstitutions', () => {
  it('returns an empty map for no owner ids without querying', async () => {
    const database = vi.fn()
    const result = await buildDelegationSubstitutions([], database as any)
    expect(result.size).toBe(0)
    expect(database).not.toHaveBeenCalled()
  })

  it('maps an out-of-office owner with a non-expired delegate to the delegate record', async () => {
    const database = makeFakeDb({
      nivaro_users: [
        {
          id: 'u1',
          delegate_id: 'u2',
          delegate_expires_at: null,
          is_out_of_office: true,
          email: 'u1@x.com',
          first_name: 'U1',
          last_name: null
        },
        { id: 'u2', email: 'u2@x.com', first_name: 'U2', last_name: null }
      ]
    })
    const result = await buildDelegationSubstitutions(['u1'], database)
    expect(result.get('u1')).toEqual({
      id: 'u2',
      email: 'u2@x.com',
      first_name: 'U2',
      last_name: null
    })
  })

  it('does not substitute an owner who is not out of office', async () => {
    const database = makeFakeDb({
      nivaro_users: [
        { id: 'u1', delegate_id: 'u2', delegate_expires_at: null, is_out_of_office: false }
      ]
    })
    const result = await buildDelegationSubstitutions(['u1'], database)
    expect(result.has('u1')).toBe(false)
  })

  it('does not substitute when the delegation has expired', async () => {
    const database = makeFakeDb({
      nivaro_users: [
        {
          id: 'u1',
          delegate_id: 'u2',
          delegate_expires_at: new Date('2000-01-01'),
          is_out_of_office: true
        }
      ]
    })
    const result = await buildDelegationSubstitutions(['u1'], database)
    expect(result.has('u1')).toBe(false)
  })
})

function makeOwnerBatchFakeDb(fixtures: {
  groups: OwnerGroup[]
  records: Record<string, Record<string, unknown>>
  groupUsers: Array<{
    group: string
    id: string
    email: string
    first_name: string | null
    last_name: string | null
  }>
  instanceOwners: Array<{
    instance: string
    state: string | null
    id: string
    email: string
    first_name: string | null
    last_name: string | null
  }>
  users: Array<{
    id: string
    delegate_id: string | null
    delegate_expires_at: Date | null
    is_out_of_office: boolean
  }>
  delegateUsers: Array<{
    id: string
    email: string
    first_name: string | null
    last_name: string | null
  }>
}) {
  const tableCalls: string[] = []
  const database = vi.fn((table: string) => {
    tableCalls.push(table)
    if (table === 'nivaro_pipeline_owner_groups') {
      return {
        whereIn: (_col: string, states: string[]) => ({
          orderBy: () => ({
            orderBy: async () => fixtures.groups.filter((g) => states.includes(g.state))
          })
        })
      }
    }
    if (table === 'nivaro_relations') {
      return { where: () => ({ select: async () => [] }) }
    }
    if (table === 'nivaro_pipeline_owner_group_users as ogu') {
      return {
        join: () => ({
          whereIn: (_col: string, ids: string[]) => ({
            select: async () => fixtures.groupUsers.filter((r) => ids.includes(r.group))
          })
        })
      }
    }
    if (table === 'nivaro_pipeline_instance_owners as io') {
      return {
        join: () => ({
          whereIn: (_col: string, ids: string[]) => ({
            select: async () => fixtures.instanceOwners.filter((r) => ids.includes(r.instance))
          })
        })
      }
    }
    if (table === 'nivaro_users') {
      return {
        whereIn: (_col: string, ids: string[]) => ({
          select: async (...cols: string[]) =>
            cols.includes('delegate_id')
              ? fixtures.users.filter((u) => ids.includes(u.id))
              : fixtures.delegateUsers.filter((u) => ids.includes(u.id))
        })
      }
    }
    // Item collection tables (e.g. 'articles')
    return {
      whereIn: (_col: string, ids: string[]) => ({
        select: async () => ids.map((id) => fixtures.records[`${table}:${id}`]).filter(Boolean)
      })
    }
  })
  return { database: database as unknown as typeof import('../../../db/index.js').db, tableCalls }
}

describe('resolveStateOwnersBatch', () => {
  it('returns an empty map for no requests', async () => {
    const result = await resolveStateOwnersBatch([])
    expect(result.size).toBe(0)
  })

  it('resolves owners for multiple items, applies delegation only to items whose state has groups', async () => {
    const { database, tableCalls } = makeOwnerBatchFakeDb({
      groups: [
        {
          id: 'g1',
          template: 't',
          state: 's1',
          name: null,
          filters: JSON.stringify([{ field: 'priority', op: 'eq', value: 'high' }]),
          sort: 0,
          is_default: false,
          priority: 0,
          max_wip: null
        }
      ],
      records: { 'articles:1': { id: '1', priority: 'high' } },
      groupUsers: [{ group: 'g1', id: 'u1', email: 'u1@x.com', first_name: 'U1', last_name: null }],
      instanceOwners: [
        {
          instance: 'inst-a',
          state: 's1',
          id: 'u2',
          email: 'u2@x.com',
          first_name: 'U2',
          last_name: null
        },
        {
          instance: 'inst-b',
          state: null,
          id: 'u3',
          email: 'u3@x.com',
          first_name: 'U3',
          last_name: null
        }
      ],
      users: [
        { id: 'u1', delegate_id: 'u1-delegate', delegate_expires_at: null, is_out_of_office: true },
        { id: 'u2', delegate_id: null, delegate_expires_at: null, is_out_of_office: false },
        { id: 'u3', delegate_id: 'u3-delegate', delegate_expires_at: null, is_out_of_office: true }
      ],
      delegateUsers: [
        { id: 'u1-delegate', email: 'delegate1@x.com', first_name: 'Delegate1', last_name: null },
        { id: 'u3-delegate', email: 'delegate3@x.com', first_name: 'Delegate3', last_name: null }
      ]
    })

    const result = await resolveStateOwnersBatch(
      [
        { key: 'A', stateId: 's1', instanceId: 'inst-a', collection: 'articles', itemId: '1' },
        { key: 'B', stateId: 's2', instanceId: 'inst-b', collection: 'articles', itemId: '2' }
      ],
      database
    )

    // req A: state s1 has groups → g1 matches (priority='high') → base owner u1,
    // plus instance owner u2 (state matches 's1') → delegation applies → u1 substituted, u2 untouched.
    expect(result.get('A')).toEqual([
      { id: 'u1-delegate', email: 'delegate1@x.com', first_name: 'Delegate1', last_name: null },
      { id: 'u2', email: 'u2@x.com', first_name: 'U2', last_name: null }
    ])

    // req B: state s2 has NO groups → instance owner u3 only (state null matches any) →
    // NO delegation applied even though u3 has an active delegate — preserves existing asymmetry.
    expect(result.get('B')).toEqual([
      { id: 'u3', email: 'u3@x.com', first_name: 'U3', last_name: null }
    ])

    // Groups fetched once for the whole batch, not once per request.
    expect(tableCalls.filter((t) => t === 'nivaro_pipeline_owner_groups')).toHaveLength(1)
  })
})
