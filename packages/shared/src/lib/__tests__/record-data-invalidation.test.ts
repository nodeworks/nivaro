import { describe, expect, it } from 'vitest'
import { invalidateRecordData } from '../../components/item-edit/RecordInsights'

type Call = { queryKey?: unknown[]; predicate?: (q: { queryKey: readonly unknown[] }) => boolean }

describe('invalidateRecordData', () => {
  it('refreshes the record header and only the O2M grids keyed on that record', () => {
    const calls: Call[] = []
    invalidateRecordData(
      { invalidateQueries: (o: Call) => calls.push(o) },
      'inventory_requests',
      '32842'
    )

    expect(calls.map((c) => c.queryKey).filter(Boolean)).toEqual([
      ['item', 'inventory_requests', '32842'],
      ['child-summary', 'inventory_requests', '32842'],
      ['last-touch', 'inventory_requests', '32842']
    ])

    const predicate = calls.find((c) => c.predicate)?.predicate
    expect(predicate).toBeTypeOf('function')
    // The catalog picker / inline table key; numeric parent ids match too.
    expect(
      predicate!({
        queryKey: ['o2m-rows', 'inventory_request_materials', 'inventory_request', 32842]
      })
    ).toBe(true)
    expect(
      predicate!({
        queryKey: [
          'o2m-rows',
          'inventory_request_materials',
          'inventory_request',
          '32842',
          'summary-members',
          'cifa',
          'h'
        ]
      })
    ).toBe(true)
    // Another record's grid stays cached.
    expect(
      predicate!({
        queryKey: ['o2m-rows', 'inventory_request_materials', 'inventory_request', '32841']
      })
    ).toBe(false)
    expect(predicate!({ queryKey: ['item', 'inventory_requests', '32842'] })).toBe(false)
  })
})
