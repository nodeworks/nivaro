import { describe, expect, it } from 'vitest'
import { tabTitlePrefix, withTitlePrefix } from './tab-attention'

describe('tab attention', () => {
  it('prefixes the count, caps at 99+ and shows nothing at zero', () => {
    expect(tabTitlePrefix(0)).toBe('')
    expect(tabTitlePrefix(-2)).toBe('')
    expect(tabTitlePrefix(3)).toBe('(3) ')
    expect(tabTitlePrefix(140)).toBe('(99+) ')
  })

  it('swaps an existing prefix instead of stacking one', () => {
    expect(withTitlePrefix('CR26-76773 · Nivaro', 2)).toBe('(2) CR26-76773 · Nivaro')
    expect(withTitlePrefix('(2) CR26-76773 · Nivaro', 5)).toBe('(5) CR26-76773 · Nivaro')
    expect(withTitlePrefix('(99+) Queues · Nivaro', 0)).toBe('Queues · Nivaro')
  })

  it('leaves a title that only looks like a count elsewhere alone', () => {
    expect(withTitlePrefix('Budget (2026) · Nivaro', 1)).toBe('(1) Budget (2026) · Nivaro')
  })
})
