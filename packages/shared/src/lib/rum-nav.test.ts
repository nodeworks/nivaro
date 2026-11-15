import { describe, expect, it } from 'vitest'
import { navKindOf, POPSTATE_WINDOW_MS, routeNavKind } from './rum'

describe('RUM navigation type (idea 15)', () => {
  it('maps a navigation entry type to one of four kinds', () => {
    expect(navKindOf('reload')).toBe('reload')
    expect(navKindOf('back_forward')).toBe('back_forward')
    expect(navKindOf('prerender')).toBe('prerender')
    expect(navKindOf('navigate')).toBe('navigate')
    expect(navKindOf(undefined)).toBe('navigate')
    expect(navKindOf('other')).toBe('navigate')
  })

  it('an SPA route change right after popstate is Back/Forward', () => {
    expect(routeNavKind(1000, 900)).toBe('back_forward')
    expect(routeNavKind(1000 + POPSTATE_WINDOW_MS, 1000)).toBe('navigate')
    expect(routeNavKind(1000, null)).toBe('navigate')
    expect(routeNavKind(1000, 1500)).toBe('navigate')
  })
})
