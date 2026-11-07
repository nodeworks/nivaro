import { describe, expect, it } from 'vitest'
import { rowFocusTarget, tabStopRowKey } from './row-focus'

// army8 review M9: every list row was a Tab stop (50 before the pager).
describe('list row focus', () => {
  const entries = [
    { kind: 'header', gkey: 'A' },
    { kind: 'row', row: { id: 7 } },
    { kind: 'row', row: { id: 9 } }
  ]

  it('one tab stop: the focused row while listed, else the first row', () => {
    expect(tabStopRowKey(entries, null)).toBe('7')
    expect(tabStopRowKey(entries, '9')).toBe('9')
    expect(tabStopRowKey(entries, '42')).toBe('7')
    expect(tabStopRowKey([{ kind: 'header' }], null)).toBeNull()
  })

  it('arrows, Home and End move between rows and stop at the ends', () => {
    expect(rowFocusTarget(3, 0, 'ArrowDown')).toBe(1)
    expect(rowFocusTarget(3, 2, 'ArrowDown')).toBeNull()
    expect(rowFocusTarget(3, 0, 'ArrowUp')).toBeNull()
    expect(rowFocusTarget(3, 1, 'Home')).toBe(0)
    expect(rowFocusTarget(3, 0, 'End')).toBe(2)
    expect(rowFocusTarget(3, 0, 'Tab')).toBeNull()
  })
})
