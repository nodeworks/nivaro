import { describe, expect, it } from 'vitest'
import { glideMoves, movingRowTitle, planGroupHold } from './live-groups'

const A = { key: 'Open', rows: ['1', '2', '3'] }
const B = { key: 'Closed', rows: ['4', '5'] }

describe('planGroupHold', () => {
  it('draws the new arrangement when nobody points at the list', () => {
    const next = [
      { key: 'Open', rows: ['1', '3'] },
      { key: 'Closed', rows: ['2', '4', '5'] }
    ]
    const plan = planGroupHold([A, B], next, [null, null])
    expect(plan.held).toBe(false)
    expect(plan.groups).toBe(next)
  })

  it('moves nothing when everything at or above the pointer stays the same', () => {
    // Pointer on row 1; row 5 (below) changes group order — nothing above it moved.
    const next = [
      { key: 'Open', rows: ['1', '2', '3', '5'] },
      { key: 'Closed', rows: ['4'] }
    ]
    const plan = planGroupHold([A, B], next, ['1'])
    expect(plan.held).toBe(false)
  })

  it('holds a row above the pointer that moved to another group, saying where it goes', () => {
    // Row 2 moved to Closed; the pointer rests on row 4 (below it).
    const next = [
      { key: 'Open', rows: ['1', '3'] },
      { key: 'Closed', rows: ['2', '4', '5'] }
    ]
    const plan = planGroupHold([A, B], next, ['4'])
    expect(plan.held).toBe(true)
    expect(plan.groups).toEqual([A, B])
    expect(plan.moving.get('2')).toBe('Closed')
    expect(plan.gone).toEqual([])
  })

  it('keeps a row that left the list as gone, and lets new rows wait', () => {
    const next = [
      { key: 'Open', rows: ['9', '1', '3'] },
      { key: 'Closed', rows: ['4', '5'] }
    ]
    const plan = planGroupHold([A, B], next, ['3'])
    expect(plan.held).toBe(true)
    expect(plan.gone).toEqual(['2'])
    expect(plan.groups[0].rows).toEqual(['1', '2', '3'])
  })

  it('treats a group header under the pointer as an anchor', () => {
    const next = [{ key: 'Closed', rows: ['4', '5', '1', '2', '3'] }]
    const plan = planGroupHold([A, B], next, ['§Closed'])
    expect(plan.held).toBe(true)
    expect(plan.moving.get('1')).toBe('Closed')
  })

  it('a row in a collapsed group of the new arrangement is gone from view, not lost', () => {
    const next = [
      { key: 'Open', rows: ['1', '3'] },
      { key: 'Closed', rows: [] }
    ]
    const plan = planGroupHold([A, B], next, ['5'])
    expect(plan.held).toBe(true)
    expect(plan.gone.sort()).toEqual(['2', '4', '5'])
  })
})

describe('glideMoves', () => {
  it('animates only rows that moved, from where they were', () => {
    const before = new Map([
      ['1', 0],
      ['2', 32],
      ['3', 64]
    ])
    const after = new Map([
      ['1', 0],
      ['3', 32],
      ['2', 96],
      ['9', 128]
    ])
    expect(glideMoves(before, after)).toEqual([
      { key: '3', dy: 32 },
      { key: '2', dy: -64 }
    ])
  })

  it('a big re-sort does not glide at all', () => {
    const before = new Map<string, number>()
    const after = new Map<string, number>()
    for (let i = 0; i < 10; i++) {
      before.set(String(i), i * 10)
      after.set(String(i), (9 - i) * 10)
    }
    expect(glideMoves(before, after, 5)).toEqual([])
  })
})

describe('movingRowTitle', () => {
  it('names the group in plain words', () => {
    expect(movingRowTitle('Closed')).toMatch(/^Now in Closed/)
  })
})
