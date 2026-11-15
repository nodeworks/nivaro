import { describe, expect, it } from 'vitest'
import {
  faviconBadgeLayout,
  faviconBadgeText,
  tabTitlePrefix,
  withTitlePrefix
} from './tab-attention'

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

  it('puts the count on the icon: one digit up to 9, then 9+, nothing at zero', () => {
    expect(faviconBadgeText(0)).toBe('')
    expect(faviconBadgeText(-1)).toBe('')
    expect(faviconBadgeText(3)).toBe('3')
    expect(faviconBadgeText(9)).toBe('9')
    expect(faviconBadgeText(10)).toBe('9+')
    expect(faviconBadgeText(250)).toBe('9+')
  })

  it('lays the dot out in the top right corner, inside the icon', () => {
    for (const text of ['3', '9+']) {
      const g = faviconBadgeLayout(text, 64)
      expect(g.cx + g.r + g.ring).toBeLessThanOrEqual(64 + g.ring)
      expect(g.cy - g.r - g.ring).toBeLessThanOrEqual(g.ring)
      expect(g.font).toBeGreaterThan(0)
    }
    // Two characters get a bigger dot than one.
    expect(faviconBadgeLayout('9+', 64).r).toBeGreaterThan(faviconBadgeLayout('3', 64).r)
  })
})
