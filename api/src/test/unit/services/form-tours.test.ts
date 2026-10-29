import { describe, expect, it } from 'vitest'
import { appendFormTourDone, FORM_TOURS_MAX } from '../../../services/form-tours.js'

describe('form tours done (#3192)', () => {
  it('adds a layout id once, newest last', () => {
    expect(appendFormTourDone(undefined, 7)).toEqual([7])
    expect(appendFormTourDone([3, 7, 9], 7)).toEqual([3, 9, 7])
    expect(appendFormTourDone([3, 'x', -1, 2.5], '4')).toEqual([3, 4])
  })

  it('refuses what is not a layout id', () => {
    expect(appendFormTourDone([], 0)).toBeNull()
    expect(appendFormTourDone([], 'abc')).toBeNull()
    expect(appendFormTourDone([], null)).toBeNull()
  })

  it('keeps the newest ids under the cap', () => {
    const many = Array.from({ length: FORM_TOURS_MAX }, (_, i) => i + 1)
    const next = appendFormTourDone(many, 9999) as number[]
    expect(next).toHaveLength(FORM_TOURS_MAX)
    expect(next[0]).toBe(2)
    expect(next.at(-1)).toBe(9999)
  })
})
