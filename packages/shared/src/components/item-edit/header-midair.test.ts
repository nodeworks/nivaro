import { describe, expect, it } from 'vitest'
import { conflictsNeedingPerson, resolveHeaderCollision, saveIsEcho } from './header-midair'

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

describe('conflictsNeedingPerson / saveIsEcho (army5 b01-N1, REVIEW-R5 M4)', () => {
  it('drops an echo (the record already holds what this save carries)', () => {
    const conflicts = [{ field: 'description', current_value: 'X' }]
    expect(
      conflictsNeedingPerson({ conflicts, payload: { description: 'X' }, decided: new Map() })
    ).toEqual([])
    expect(saveIsEcho({ conflicts, payload: { description: 'X', _base_revision: 3 } })).toBe(true)
  })

  it('numeric strings compare like the form does', () => {
    const conflicts = [{ field: 'qty', current_value: '5' }]
    expect(conflictsNeedingPerson({ conflicts, payload: { qty: 5 }, decided: new Map() })).toEqual(
      []
    )
  })

  it('drops a decided field only while the record still holds the value decided against', () => {
    const decided = new Map<string, unknown>([['description', 'THEIRS']])
    const payload = { description: 'MINE', title: 'T2' }
    expect(
      conflictsNeedingPerson({
        conflicts: [{ field: 'description', current_value: 'THEIRS' }],
        payload,
        decided
      })
    ).toEqual([])
    // Someone saved it AGAIN after the decision: ask again.
    expect(
      conflictsNeedingPerson({
        conflicts: [{ field: 'description', current_value: 'NEWER' }],
        payload,
        decided
      })
    ).toEqual([{ field: 'description', current_value: 'NEWER' }])
  })

  it('keeps an undecided stale field', () => {
    const out = conflictsNeedingPerson({
      conflicts: [
        { field: 'description', current_value: 'THEIRS' },
        { field: 'title', current_value: 'T B5' }
      ],
      payload: { description: 'MINE', title: 'T S3' },
      decided: new Map([['description', 'THEIRS']])
    })
    expect(out).toEqual([{ field: 'title', current_value: 'T B5' }])
  })

  it('a save with a field the 409 did not echo is not an echo (it still has to be written)', () => {
    expect(
      saveIsEcho({
        conflicts: [{ field: 'description', current_value: 'X' }],
        payload: { description: 'X', title: 'T2' }
      })
    ).toBe(false)
    expect(saveIsEcho({ conflicts: [], payload: { _base_revision: 3 } })).toBe(false)
  })
})
