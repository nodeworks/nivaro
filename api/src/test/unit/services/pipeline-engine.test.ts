import { vi, describe, expect, it } from 'vitest'
import { pickWinningGroups, buildDelegationSubstitutions, type OwnerGroup } from '../../../services/pipeline-engine.js'

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
    const relations = [{ many_collection: 'tasks', many_field: 'project', one_collection: 'projects' }]
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
        { id: 'u1', delegate_id: 'u2', delegate_expires_at: null, is_out_of_office: true, email: 'u1@x.com', first_name: 'U1', last_name: null },
        { id: 'u2', email: 'u2@x.com', first_name: 'U2', last_name: null }
      ]
    })
    const result = await buildDelegationSubstitutions(['u1'], database)
    expect(result.get('u1')).toEqual({ id: 'u2', email: 'u2@x.com', first_name: 'U2', last_name: null })
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
