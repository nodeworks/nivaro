import { describe, expect, it } from 'vitest'
import { isAdminOnlyWidget, visiblePageWidgets } from './page-widget-access'

const targets = { id: 't', config: { admin_only: true, display: 'drawer' } }
const grid = { id: 'g', config: { query_slug: 'project-type-allocations' } }
const bare = { id: 'b' }
const all: Array<{ id: string; config?: Record<string, unknown> }> = [targets, grid, bare]

describe('visiblePageWidgets', () => {
  it('hides admin-only widgets from non-admins', () => {
    expect(visiblePageWidgets(all, false).map((w) => w.id)).toEqual(['g', 'b'])
  })

  it('keeps every widget for admins', () => {
    expect(visiblePageWidgets(all, true).map((w) => w.id)).toEqual(['t', 'g', 'b'])
  })

  it('only a literal true marks a widget admin-only', () => {
    expect(isAdminOnlyWidget({ config: { admin_only: 'true' } })).toBe(false)
    expect(isAdminOnlyWidget({ config: { admin_only: false } })).toBe(false)
    expect(isAdminOnlyWidget({ config: null })).toBe(false)
    expect(isAdminOnlyWidget(targets)).toBe(true)
  })
})
