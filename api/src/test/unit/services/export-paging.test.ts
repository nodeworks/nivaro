import { describe, expect, it } from 'vitest'
import {
  afterIdFilter,
  ExportPager,
  keysetSort,
  lastNumericId,
  pkIsIntegerId,
  projectsId
} from '../../../services/export-paging.js'

// Export paging (fix round 1): keyset on id for the default order (no OFFSET skipping every
// earlier row again, no skipped or repeated rows when rows change while it runs).

describe('export paging', () => {
  it('keyset only for an id-only ascending order with id in the projection', () => {
    expect(keysetSort(['id'])).toBe(true)
    expect(keysetSort(['-id'])).toBe(false)
    expect(keysetSort(['name', 'id'])).toBe(false)
    expect(projectsId(undefined)).toBe(true)
    expect(projectsId(['*'])).toBe(true)
    expect(projectsId(['name'])).toBe(false)
  })

  it('ANDs `id > last` onto the caller’s filter', () => {
    expect(afterIdFilter(undefined, 5)).toEqual({ id: { _gt: 5 } })
    expect(afterIdFilter({ a: { _eq: 1 } }, 5)).toEqual({
      _and: [{ a: { _eq: 1 } }, { id: { _gt: 5 } }]
    })
    expect(afterIdFilter({ a: 1 }, null)).toEqual({ a: 1 })
    expect(lastNumericId([{ id: 3 }, { id: '17' }])).toBe(17)
    expect(lastNumericId([{ id: 'a-uuid' }])).toBeNull()
  })

  it('pages by keyset, and falls back to OFFSET for non-numeric or non-advancing ids', () => {
    const p = new ExportPager(['id'], undefined, { s: 1 }, true)
    expect(p.page(0)).toEqual({ offset: 0, filter: { s: 1 } })
    p.saw([{ id: 10 }, { id: 20 }])
    expect(p.page(2)).toEqual({ offset: 0, filter: { _and: [{ s: 1 }, { id: { _gt: 20 } }] } })
    p.saw([{ id: 20 }])
    expect(p.usesKeyset).toBe(false)
    expect(p.page(3)).toEqual({ offset: 3, filter: { s: 1 } })
    const u = new ExportPager(['id'], undefined, undefined, true)
    u.saw([{ id: 'b7f0…' }])
    expect(u.page(1000)).toEqual({ offset: 1000, filter: undefined })
    const sorted = new ExportPager(['-name', 'id'], undefined, undefined, true)
    sorted.saw([{ id: 1 }])
    expect(sorted.page(1000).offset).toBe(1000)
  })
})

describe('keysetEligible (fix round 2)', () => {
  it('only a single integer primary key named id', () => {
    expect(pkIsIntegerId([{ col: 'id', type: 'int' }])).toBe(true)
    expect(pkIsIntegerId([{ col: 'ID', type: 'bigint' }])).toBe(true)
    // Digits in text sort as text: `_gt` would skip rows.
    expect(pkIsIntegerId([{ col: 'id', type: 'nvarchar' }])).toBe(false)
    expect(pkIsIntegerId([{ col: 'id', type: 'uniqueidentifier' }])).toBe(false)
    // No primary key at all (a view, a virtual collection) or a composite one.
    expect(pkIsIntegerId([])).toBe(false)
    expect(
      pkIsIntegerId([
        { col: 'id', type: 'int' },
        { col: 'line', type: 'int' }
      ])
    ).toBe(false)
    expect(pkIsIntegerId([{ col: 'code', type: 'int' }])).toBe(false)
  })
})
