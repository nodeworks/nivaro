import { describe, expect, it } from 'vitest'
import { diffWindow } from './text-diff-window'

describe('diffWindow', () => {
  it('keeps short values whole', () => {
    expect(diffWindow('Draft', 'Approved')).toEqual({
      before: 'Draft',
      after: 'Approved',
      trimmed: false
    })
  })

  it('shows the part past a long common head', () => {
    const a = 'Fiber splice kits and enclosures for Nashville CNF, delivered Friday to the dock'
    const b = 'Fiber splice kits and enclosures for Nashville CNF, delivered Monday to the dock'
    const w = diffWindow(a, b)
    expect(w.before).toContain('Friday')
    expect(w.after).toContain('Monday')
    expect(w.before.startsWith('…')).toBe(true)
  })

  it('never reads the same for a change at the very end', () => {
    const a = `${'word '.repeat(20)}CNF`
    const b = `${'word '.repeat(20)}CNF, dock 4`
    const w = diffWindow(a, b)
    expect(w.before).not.toBe(w.after)
    expect(w.after).toContain('dock 4')
  })
})
