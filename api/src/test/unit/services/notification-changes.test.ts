import { describe, expect, it } from 'vitest'
import {
  buildChanges,
  plainText,
  revisionChangedKeys,
  shortTextDiff
} from '../../../services/notification-changes.js'

// #3079 — the pure half of "what changed": which keys a revision moved, the short text diff
// and the visible-fields filter.

describe('revisionChangedKeys', () => {
  it('uses the delta, minus housekeeping stamps and values equal to the revision before', () => {
    expect(
      revisionChangedKeys(
        { data: null, delta: { a: 1, b: '2', updated_at: 'x', id: 3 } },
        { data: { a: 1, b: 3 } }
      )
    ).toEqual(['b'])
  })
  it('without a delta, diffs the two snapshots', () => {
    expect(
      revisionChangedKeys({ data: { a: 1, b: 2, c: null }, delta: null }, { data: { a: 1, b: 3 } })
    ).toEqual(['b'])
  })
  it('a first revision with no delta has nothing to compare', () => {
    expect(revisionChangedKeys({ data: { a: 1 }, delta: null }, null)).toEqual([])
  })
})

describe('shortTextDiff', () => {
  it('keeps only the moved part with context', () => {
    const d = shortTextDiff(`${'x'.repeat(100)} cat sat`, `${'x'.repeat(100)} dog sat`)
    expect(d.removed).toBe('cat')
    expect(d.added).toBe('dog')
    expect(d.lead.startsWith('…')).toBe(true)
    expect(d.trail).toBe(' sat')
  })
  it('rich text is compared as text', () => {
    expect(plainText('<p>Hello&nbsp;<b>there</b></p>')).toBe('Hello there')
  })
})

describe('buildChanges', () => {
  it('drops fields not visible to the reader', () => {
    const out = buildChanges({
      rev: { id: 2, at: null, data: null, delta: { a: 'new', hidden: 'secret' } },
      prev: { id: 1, at: null, delta: null, data: { a: 'old', hidden: 'before' } },
      visible: new Map([['a', { field: 'a', label: 'A', type: 'string', m2o: null }]])
    })
    expect(out).toEqual([{ field: 'a', label: 'A', type: 'string', old: 'old', new: 'new' }])
  })
})
