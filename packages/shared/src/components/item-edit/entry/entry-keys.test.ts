// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { enterIsTaken, entrySequence, firstEmptyRequired, stepField } from './entry-keys'

describe('keyboard-first entry (#2707 #2708)', () => {
  it('follows page order without a tab order', () => {
    expect(entrySequence(['a', 'b', 'c'], undefined)).toEqual(['a', 'b', 'c'])
    expect(entrySequence(['a', 'b'], [])).toEqual(['a', 'b'])
  })

  it('puts the named fields first, the rest after in page order, and skips fields not on screen', () => {
    expect(entrySequence(['a', 'b', 'c', 'd'], ['c', 'gone', 'a'])).toEqual(['c', 'a', 'b', 'd'])
  })

  it('steps forward and back, null at the ends or off the list', () => {
    const seq = ['a', 'b', 'c']
    expect(stepField(seq, 'a', 1)).toBe('b')
    expect(stepField(seq, 'b', -1)).toBe('a')
    expect(stepField(seq, 'c', 1)).toBeNull()
    expect(stepField(seq, 'a', -1)).toBeNull()
    expect(stepField(seq, 'zzz', 1)).toBeNull()
  })

  it('finds the first empty required field in page order', () => {
    const required = new Set(['b', 'c'])
    expect(firstEmptyRequired(['a', 'b', 'c'], required, { b: 'x' })).toBe('c')
    expect(firstEmptyRequired(['a', 'b', 'c'], required, { b: 'x', c: 0 })).toBeNull()
    expect(firstEmptyRequired(['a', 'b'], required, { b: [] })).toBe('b')
    expect(firstEmptyRequired(['a', 'b'], required, { b: '' })).toBe('b')
  })

  it('leaves Enter alone in text areas, buttons, open lists and editors', () => {
    const el = (html: string) => {
      const d = document.createElement('div')
      d.innerHTML = html
      return d.firstElementChild as Element
    }
    expect(enterIsTaken(el('<textarea></textarea>'))).toBe(true)
    expect(enterIsTaken(el('<button>x</button>'))).toBe(true)
    expect(enterIsTaken(el('<input aria-expanded="true">'))).toBe(true)
    expect(enterIsTaken(el('<input type="text">'))).toBe(false)
  })
})
