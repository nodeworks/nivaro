import { describe, expect, it } from 'vitest'
import { moveBlockedAfterSave, newFieldError, unsavedBeforeMove } from './move-guard'

describe('unsavedBeforeMove (army11 f1 / a1 F-3)', () => {
  it('saves first when only a line edit is staged (dirty flag clean)', () => {
    expect(unsavedBeforeMove({ isDirty: false, staged: { total: 1 } })).toBe(true)
  })
  it('saves first when a header field is dirty', () => {
    expect(unsavedBeforeMove({ isDirty: true, staged: { total: 0 } })).toBe(true)
  })
  it('moves at once when nothing is unsaved', () => {
    expect(unsavedBeforeMove({ isDirty: false, staged: { total: 0 } })).toBe(false)
    expect(unsavedBeforeMove({ isDirty: false, staged: null })).toBe(false)
  })
})

describe('moveBlockedAfterSave (army11 review #3)', () => {
  it('a line that met a newer save stops the move until the chooser is answered', () => {
    expect(moveBlockedAfterSave({ childRefused: false, lineConflicts: 1 })).toBe(true)
    expect(moveBlockedAfterSave({ childRefused: false, chooserOpen: true })).toBe(true)
  })
  it('a refused line or a change waiting on its reason stops it too', () => {
    expect(moveBlockedAfterSave({ childRefused: true })).toBe(true)
    expect(moveBlockedAfterSave({ childRefused: false, reasonWaiting: true })).toBe(true)
  })
  it('a clean save lets the record move', () => {
    expect(moveBlockedAfterSave({ childRefused: false, lineConflicts: 0 })).toBe(false)
  })
})

describe('newFieldError (army11 review #7: live errors were silent)', () => {
  it('names the error that just appeared', () => {
    expect(newFieldError({}, { end: 'End must be on or after Start' })).toEqual({
      field: 'end',
      message: 'End must be on or after Start'
    })
    expect(newFieldError({ a: 'x' }, { a: 'x' })).toBeNull()
    expect(newFieldError({ a: 'x' }, {})).toBeNull()
  })
})
