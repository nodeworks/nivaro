import { describe, expect, it } from 'vitest'
import { resolveHeaderCollision } from './header-midair'

const conflicts = [
  { field: 'description', current_value: 'A B4' },
  { field: 'title', current_value: 'T B4' }
]
const draft = { description: 'A S2', title: 'T S2', zone: 'Z2' }
const initial = { description: 'A', title: 'T', zone: 'Z' }
const mine = { description: 'A S2', title: 'T S2' }

describe('resolveHeaderCollision (army5 b09)', () => {
  it('THEIRS: draft and baseline both take the newer value (nothing to send)', () => {
    const r = resolveHeaderCollision({
      draft,
      initial,
      conflicts,
      mine,
      takeTheirs: new Set(['description', 'title'])
    })
    expect(r.draft.description).toBe('A B4')
    expect(r.initial.description).toBe('A B4')
    expect(r.draft.title).toBe('T B4')
    expect(r.theirs).toEqual(['description', 'title'])
    expect(r.kept).toEqual([])
    // An unrelated edit stays an edit.
    expect(r.draft.zone).toBe('Z2')
    expect(r.initial.zone).toBe('Z')
  })

  it('MINE: draft keeps mine, baseline moves to theirs (so mine is sent)', () => {
    const r = resolveHeaderCollision({ draft, initial, conflicts, mine, takeTheirs: new Set() })
    expect(r.draft.description).toBe('A S2')
    expect(r.initial.description).toBe('A B4')
    expect(r.kept).toEqual(['description', 'title'])
  })

  it('mixed, and never mutates its inputs', () => {
    const d = { ...draft }
    const i = { ...initial }
    const r = resolveHeaderCollision({
      draft: d,
      initial: i,
      conflicts,
      mine,
      takeTheirs: new Set(['title'])
    })
    expect(r.draft).toMatchObject({ description: 'A S2', title: 'T B4' })
    expect(r.initial).toMatchObject({ description: 'A B4', title: 'T B4' })
    expect(d).toEqual(draft)
    expect(i).toEqual(initial)
  })

  it('a MINE value the save did not carry leaves the draft as it is', () => {
    const r = resolveHeaderCollision({
      draft,
      initial,
      conflicts,
      mine: {},
      takeTheirs: new Set()
    })
    expect(r.draft.description).toBe('A S2')
  })
})
