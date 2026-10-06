import { describe, expect, it } from 'vitest'
import {
  clusterMemberSets,
  memberSetKey,
  suggestTeamName
} from '../../../services/owner-team-suggestions.js'

const cell = (id: string, members: string[]) => ({ group_id: id, members })

describe('clusterMemberSets', () => {
  it('groups identical member sets regardless of order and case', () => {
    const r = clusterMemberSets([
      cell('g1', ['a', 'b']),
      cell('g2', ['B', 'A']),
      cell('g3', ['b', 'a', 'a']),
      cell('g4', ['a', 'c'])
    ])
    expect(r).toHaveLength(1)
    expect(r[0].members).toEqual(['A', 'B'])
    expect(r[0].group_ids).toEqual(['G1', 'G2', 'G3'])
  })

  it('drops single-person sets and sets below the cell threshold', () => {
    const r = clusterMemberSets(
      [
        cell('g1', ['a']),
        cell('g2', ['a']),
        cell('g3', ['a']),
        cell('g4', ['a', 'b']),
        cell('g5', ['a', 'b'])
      ],
      { minCells: 3 }
    )
    expect(r).toEqual([])
    expect(
      clusterMemberSets([cell('g4', ['a', 'b']), cell('g5', ['a', 'b'])], { minCells: 2 })
    ).toHaveLength(1)
  })

  it('orders by payoff — cells × members', () => {
    const r = clusterMemberSets(
      [
        cell('a1', ['a', 'b']),
        cell('a2', ['a', 'b']),
        cell('a3', ['a', 'b']),
        cell('a4', ['a', 'b']),
        cell('b1', ['x', 'y', 'z']),
        cell('b2', ['x', 'y', 'z']),
        cell('b3', ['x', 'y', 'z'])
      ],
      { minCells: 3 }
    )
    expect(r.map((c) => c.key)).toEqual(['X,Y,Z', 'A,B'])
  })
})

describe('helpers', () => {
  it('memberSetKey is canonical', () => {
    expect(memberSetKey(['b', 'A', 'a'])).toBe('A,B')
  })
  it('suggestTeamName uses first names', () => {
    expect(suggestTeamName(['Beth Ray', 'Kim Lo'])).toBe('Beth, Kim')
    expect(suggestTeamName(['A One', 'B Two', 'C Three', 'D Four', 'E Five'])).toBe('A, B, C +2')
  })
})
