import { describe, expect, it } from 'vitest'
import {
  normalizeNavLayout,
  parseNavRoleDefaults,
  starterForRole
} from '../../../services/nav-layout.js'

describe('normalizeNavLayout — rail of main sections', () => {
  it('keeps a rail-only layout: order and hidden by section id', () => {
    const n = normalizeNavLayout({ v: 1, rail: { order: ['data', 'home', 'data'], hidden: ['ops', 'bad id!'] } })
    expect(n.layout).toEqual({ v: 1, categories: {}, rail: { order: ['data', 'home'], hidden: ['ops'] } })
  })

  it('drops an empty rail and refuses a malformed one', () => {
    expect(normalizeNavLayout({ v: 1, rail: { order: [], hidden: [] } }).layout).toBeNull()
    expect(normalizeNavLayout({ v: 1, rail: 'home' }).error).toMatch(/rail/)
    expect(normalizeNavLayout({ v: 1, rail: { order: 'home' } }).error).toMatch(/rail/)
  })

  it('keeps categories and rail together', () => {
    const n = normalizeNavLayout({ v: 1, categories: { home: { hidden: ['/x'] } }, rail: { hidden: ['data'] } })
    expect(n.layout).toEqual({ v: 1, categories: { home: { hidden: ['/x'] } }, rail: { hidden: ['data'] } })
  })
})

describe('normalizeNavLayout', () => {
  it('treats null / empty as no layout', () => {
    expect(normalizeNavLayout(null)).toEqual({ layout: null })
    expect(normalizeNavLayout({ v: 1, categories: {} })).toEqual({ layout: null })
    expect(normalizeNavLayout({ v: 1, categories: { home: {} } })).toEqual({ layout: null })
  })

  it('keeps clean paths, drops junk and duplicates', () => {
    const n = normalizeNavLayout({
      v: 1,
      categories: {
        home: { pinned: ['/tasks', '/tasks', 'tasks', '//evil.example', 5], hidden: ['/ideas'] },
        'bad id!': { pinned: ['/x'] }
      },
      extra: true
    })
    expect(n.error).toBeUndefined()
    expect(n.layout).toEqual({
      v: 1,
      categories: { home: { pinned: ['/tasks'], hidden: ['/ideas'] } }
    })
  })

  it('refuses a malformed shape', () => {
    expect(normalizeNavLayout([]).error).toBeTruthy()
    expect(normalizeNavLayout({ categories: [] }).error).toBeTruthy()
    expect(normalizeNavLayout({ categories: { home: { order: '/x' } } }).error).toBeTruthy()
    expect(normalizeNavLayout('{not json').error).toBeTruthy()
  })

  it('caps pinned at 20', () => {
    const pinned = Array.from({ length: 30 }, (_, i) => `/p${i}`)
    const n = normalizeNavLayout({ categories: { home: { pinned } } })
    expect(n.layout?.categories.home.pinned).toHaveLength(20)
  })
})

describe('role defaults', () => {
  const role = 'a1b2c3d4-0000-4000-8000-000000000001'
  it('keys by upper-case role uuid and finds the caller role case-insensitively', () => {
    const map = parseNavRoleDefaults(
      JSON.stringify({ [role]: { v: 1, categories: { home: { hidden: ['/ideas'] } } }, nope: {} })
    )
    expect(Object.keys(map)).toEqual([role.toUpperCase()])
    expect(starterForRole(map, role)?.categories.home.hidden).toEqual(['/ideas'])
    expect(starterForRole(map, null)).toBeNull()
    expect(starterForRole(map, 'B1B2C3D4-0000-4000-8000-000000000001')).toBeNull()
  })
})
