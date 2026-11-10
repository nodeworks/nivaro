import { describe, expect, it, vi } from 'vitest'
import {
  type BulkScopeDeps,
  planScopeChange,
  runBulkScopeChange
} from '../../../services/user-scopes-bulk.js'

// Rob 2026-11-10: bulk add / remove a person's RESTRICTED zones.
const ZONES: Record<string, string> = {
  '1': 'Zone 3',
  '2': 'Zone 1',
  '3': 'Zone 2',
  '4': 'National'
}

describe('planScopeChange', () => {
  it('add = union, keeping the stored order and type', () => {
    expect(planScopeChange([1, 2], 'add', [3, '2'], { noun: 'zone' })).toEqual({
      after: [1, 2, 3],
      status: 'change'
    })
  })
  it('remove = difference', () => {
    expect(planScopeChange([1, 2, 3], 'remove', ['3'], { noun: 'zone' })).toEqual({
      after: [1, 2],
      status: 'change'
    })
  })
  it('nothing to add / nothing to remove is unchanged', () => {
    expect(planScopeChange([1, 2], 'add', [2], { noun: 'zone' }).status).toBe('unchanged')
    expect(planScopeChange([1, 2], 'remove', [4], { noun: 'zone' }).status).toBe('unchanged')
  })
  it('a person with no restriction is never narrowed by add, nor touched by remove', () => {
    const add = planScopeChange([], 'add', [1], { noun: 'zone' })
    expect(add).toMatchObject({ status: 'unchanged', after: [] })
    expect(add.reason).toMatch(/already sees every zone/)
    expect(planScopeChange([], 'remove', [1], { noun: 'zone' }).status).toBe('unchanged')
  })
  it('removing the last restricted value is refused unless allowed (it would widen to everything)', () => {
    const r = planScopeChange([2], 'remove', [2], { noun: 'zone' })
    expect(r).toMatchObject({ status: 'refused', after: [2] })
    expect(r.reason).toMatch(/last restricted zone/)
    expect(planScopeChange([2], 'remove', [2], { noun: 'zone', allowEmpty: true })).toEqual({
      after: [],
      status: 'change'
    })
  })
})

function deps(over: Partial<BulkScopeDeps> = {}) {
  const writes: Array<[string, string, unknown[]]> = []
  const d: BulkScopeDeps = {
    users: async (ids) =>
      new Map(ids.filter((i) => i !== 'ghost').map((i) => [i, `Person ${i}`] as const)),
    restricted: async () =>
      new Map<string, Array<string | number>>([
        ['a', [1, 2]],
        ['b', [2]],
        ['c', []]
      ]),
    labels: async (values) =>
      new Map(
        values
          .filter((v) => ZONES[String(v)])
          .map((v) => [String(v).toLowerCase(), ZONES[String(v)]])
      ),
    write: async (id, dim, values) => {
      writes.push([id, dim, values])
    },
    ...over
  }
  return { d, writes }
}

const base = {
  userIds: ['a', 'b', 'c', 'ghost'],
  dimension: 'division',
  noun: 'zone',
  values: [3],
  preview: false,
  allowEmpty: false
}

describe('runBulkScopeChange', () => {
  it('preview writes nothing and answers before → after per person', async () => {
    const { d, writes } = deps()
    const r = await runBulkScopeChange({ ...base, op: 'add', preview: true }, d)
    expect(writes).toEqual([])
    expect(r.rows.map((x) => [x.user_id, x.status, x.after_labels.join(',')])).toEqual([
      ['a', 'change', 'Zone 3,Zone 1,Zone 2'],
      ['b', 'change', 'Zone 1,Zone 2'],
      ['c', 'unchanged', ''],
      ['ghost', 'not_found', '']
    ])
    expect(r.counts).toMatchObject({ change: 2, unchanged: 1, not_found: 1 })
  })

  it('the real run writes only the people that change, only this dimension', async () => {
    const { d, writes } = deps()
    await runBulkScopeChange({ ...base, op: 'add' }, d)
    expect(writes).toEqual([
      ['a', 'division', [1, 2, 3]],
      ['b', 'division', [2, 3]]
    ])
  })

  it('remove refuses a last value by default and writes the rest', async () => {
    const { d, writes } = deps()
    const r = await runBulkScopeChange({ ...base, op: 'remove', values: [2] }, d)
    expect(writes).toEqual([['a', 'division', [1]]])
    expect(r.rows.find((x) => x.user_id === 'b')?.status).toBe('refused')
    const { d: d2, writes: w2 } = deps()
    await runBulkScopeChange({ ...base, op: 'remove', values: [2], allowEmpty: true }, d2)
    expect(w2).toEqual([
      ['a', 'division', [1]],
      ['b', 'division', []]
    ])
  })

  it('an unknown value stops the whole run before anything is read or written', async () => {
    const { d, writes } = deps({ users: vi.fn(async () => new Map()) })
    const r = await runBulkScopeChange({ ...base, op: 'add', values: [99] }, d)
    expect(r.unknown_values).toEqual([99])
    expect(r.rows).toEqual([])
    expect(d.users).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('one failed write is reported; the others still run', async () => {
    const { d } = deps({
      write: async (id) => {
        if (id === 'a') throw new Error('deadlock')
      }
    })
    const r = await runBulkScopeChange({ ...base, op: 'add' }, d)
    expect(r.rows.find((x) => x.user_id === 'a')?.error).toBe('deadlock')
    expect(r.counts).toMatchObject({ failed: 1, change: 1 })
  })
})
