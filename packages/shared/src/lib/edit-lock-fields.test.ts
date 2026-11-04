import { describe, expect, it } from 'vitest'
import { editLockLockedFields } from './edit-lock-fields'

describe('editLockLockedFields', () => {
  it('locks every field that is not open', () => {
    expect(editLockLockedFields(['a', 'b', 'hold'], new Set(['hold']))).toEqual(['a', 'b'])
  })
  it('leaves open fields unlocked', () => {
    expect(editLockLockedFields(['hold'], ['hold'])).toEqual([])
  })
  it('adds nothing when no field is open (not partial mode)', () => {
    expect(editLockLockedFields(['a', 'b'], new Set())).toEqual([])
  })
})
