import { describe, expect, it } from 'vitest'
import { addendumViewGone } from './addendum-view'

// 2026-11-16: deleting the addendum on screen left the form (and efp-new's ?addendum= /
// the record tab's state dot) pointing at an addendum that no longer existed.
describe('addendumViewGone', () => {
  const list = [{ id: 'a1' }, { id: 'a2' }]

  it('is gone when the viewed addendum is not in the settled list', () => {
    expect(addendumViewGone('a3', list, true)).toBe(true)
    expect(addendumViewGone('a1', [], true)).toBe(true)
  })

  it('stays while the addendum exists', () => {
    expect(addendumViewGone('a2', list, true)).toBe(false)
  })

  it('never judges the original or an unsettled list', () => {
    expect(addendumViewGone('original', [], true)).toBe(false)
    expect(addendumViewGone('a3', list, false)).toBe(false)
  })
})
