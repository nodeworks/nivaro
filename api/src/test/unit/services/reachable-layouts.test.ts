import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { isReachableGroupedLayout } from '../../../services/reachable-layouts.js'

const layout = (over: Record<string, unknown>) => ({
  id: 1,
  name: 'L',
  is_active: false,
  slug: null,
  create_hidden: false,
  ...over
})

describe('isReachableGroupedLayout', () => {
  it('the active layout is reachable, whatever else it carries', () => {
    expect(isReachableGroupedLayout(layout({ is_active: true }))).toBe(true)
    expect(isReachableGroupedLayout(layout({ is_active: 1, create_hidden: true }))).toBe(true)
  })

  it('a slugged variant is reachable unless it is a hidden sub-form', () => {
    expect(isReachableGroupedLayout(layout({ slug: 'pub' }))).toBe(true)
    expect(isReachableGroupedLayout(layout({ slug: 'pub', create_hidden: 1 }))).toBe(false)
  })

  it('an inactive layout with no slug is unreachable', () => {
    expect(isReachableGroupedLayout(layout({}))).toBe(false)
  })
})
