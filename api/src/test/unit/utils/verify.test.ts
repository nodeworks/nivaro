import { describe, expect, it } from 'vitest'
import {
  assertPostConditions,
  canonicalJson,
  compareKeyed,
  fingerprint,
  PostConditionError,
  VacuousComparisonError
} from '../../../lib/verify.js'

const key = (r: Record<string, unknown>) => r.id as number

describe('compareKeyed', () => {
  it('refuses to call two empty sets the same', () => {
    expect(() => compareKeyed([], [], { label: 'queue', key })).toThrow(VacuousComparisonError)
  })

  it('refuses when only one side is empty', () => {
    expect(() => compareKeyed([{ id: 1 }], [], { label: 'queue', key })).toThrow(/"after" holds 0/)
  })

  it('refuses a non-array, which is what a wrong response path yields', () => {
    const wrong = undefined as unknown as Array<Record<string, unknown>>
    expect(() => compareKeyed(wrong, [{ id: 1 }], { label: 'queue', key })).toThrow(
      /not an array/
    )
  })

  it('refuses rows whose key does not resolve', () => {
    expect(() =>
      compareKeyed([{ item_id: 1 }], [{ item_id: 1 }], { label: 'queue', key })
    ).toThrow(/no key/)
  })

  it('refuses keys that collapse rows together', () => {
    const rows = [{ id: 1 }, { id: 1 }]
    expect(() => compareKeyed(rows, rows, { label: 'queue', key })).toThrow(/distinct keys/)
  })

  it('honours minRows', () => {
    expect(() =>
      compareKeyed([{ id: 1 }], [{ id: 1 }], { label: 'queue', key, minRows: 5 })
    ).toThrow(/fewer than the 5/)
  })

  it('is order-insensitive and ignores object key order', () => {
    const before = [
      { id: 1, owners: { a: 1, b: 2 } },
      { id: 2, owners: null }
    ]
    const after = [
      { id: 2, owners: null },
      { id: 1, owners: { b: 2, a: 1 } }
    ]
    const diff = compareKeyed(before, after, { label: 'queue', key })
    expect(diff.same).toBe(true)
    expect(diff.compared).toBe(2)
  })

  it('names added, removed and changed rows', () => {
    const diff = compareKeyed(
      [
        { id: 1, state: 'a', ms: 10 },
        { id: 2, state: 'b', ms: 10 }
      ],
      [
        { id: 1, state: 'z', ms: 99 },
        { id: 3, state: 'c', ms: 10 }
      ],
      { label: 'queue', key, ignore: ['ms'] }
    )
    expect(diff.same).toBe(false)
    expect(diff.added).toEqual(['3'])
    expect(diff.removed).toEqual(['2'])
    expect(diff.changed.map((c) => [c.key, c.fields])).toEqual([['1', ['state']]])
  })
})

describe('fingerprint', () => {
  it('is stable across key order and Set order', () => {
    expect(fingerprint({ a: 1, b: new Set([2, 1]) })).toBe(fingerprint({ b: new Set([1, 2]), a: 1 }))
  })

  it('moves when a value moves', () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }))
  })

  it('treats undefined as null rather than dropping the key', () => {
    expect(canonicalJson({ a: undefined })).toBe('{"a":null}')
  })
})

describe('assertPostConditions', () => {
  it('passes when every claim holds, to the cent', () => {
    expect(() =>
      assertPostConditions('cleanup', [
        { claim: 'no duplicate groups remain', expected: 0, actual: 0 },
        { claim: 'totals match their lines', expected: 100.1, actual: 100.10000000000001 }
      ])
    ).not.toThrow()
  })

  it('names every failed claim, not just the first', () => {
    expect(() =>
      assertPostConditions('cleanup', [
        { claim: 'no duplicate groups remain', expected: 0, actual: 4 },
        { claim: 'orders recomputed', expected: 103, actual: 0 }
      ])
    ).toThrow(/no duplicate groups remain.*orders recomputed/)
  })

  it('refuses an empty list — nothing verified is not a pass', () => {
    expect(() => assertPostConditions('cleanup', [])).toThrow(PostConditionError)
  })

  it('never passes on NaN', () => {
    expect(() =>
      assertPostConditions('cleanup', [{ claim: 'total', expected: Number.NaN, actual: Number.NaN }])
    ).toThrow(PostConditionError)
  })
})
