import { describe, expect, it } from 'vitest'
import { planMembershipRows } from './MembershipSetField'

const row = (id: number, value: string | null, value2: string | null = null) => ({
  id,
  value,
  value2
})

describe('planMembershipRows', () => {
  it('first pick re-points the blank row instead of creating one', () => {
    expect(planMembershipRows([row(1, null)], [['z1', null]])).toEqual({
      repoint: [{ id: 1, pair: ['z1', null] }],
      create: [],
      remove: []
    })
  })

  it('clearing the last pick blanks the row (key never drops out)', () => {
    expect(planMembershipRows([row(1, 'z1')], [[null, null]])).toEqual({
      repoint: [{ id: 1, pair: [null, null] }],
      create: [],
      remove: []
    })
  })

  it('second dimension = cross product; leftovers deleted', () => {
    const plan = planMembershipRows(
      [row(1, 'z1'), row(2, 'z3'), row(3, 'z5')],
      [
        ['z1', 'com'],
        ['z3', 'com'],
        ['z1', 'gen'],
        ['z3', 'gen']
      ]
    )
    expect(plan.repoint).toHaveLength(3)
    expect(plan.create).toHaveLength(1)
    expect(plan.remove).toEqual([])
  })

  it('keeps rows already right and removes duplicates', () => {
    expect(planMembershipRows([row(1, 'z1', 'com'), row(2, 'z1', 'com')], [['z1', 'com']])).toEqual(
      {
        repoint: [],
        create: [],
        remove: [2]
      }
    )
  })
})
