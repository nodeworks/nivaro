import { describe, expect, it } from 'vitest'
import { activityParams, cleanFilters, sameFilters } from './activity-search'

/** #10 — the Activity page's filter set → GET /api/activity params. */

describe('activityParams', () => {
  it('joins lists and prefers a relative range over dates', () => {
    expect(
      activityParams({
        user: 'u1',
        actions: ['delete', 'update'],
        collections: ['invoices'],
        exclude_actions: ['login'],
        range: 'last_week',
        from: '2026-01-01',
        q: 'refund'
      })
    ).toEqual({
      user: 'u1',
      action: 'delete,update',
      exclude_actions: 'login',
      collection: 'invoices',
      item: undefined,
      range: 'last_week',
      from: undefined,
      to: undefined,
      q: 'refund'
    })
  })
})

describe('cleanFilters / sameFilters', () => {
  it('drops empty keys so a saved view and the same chips compare equal', () => {
    expect(cleanFilters({ user: null, actions: [], q: '', item: '7' })).toEqual({ item: '7' })
    expect(sameFilters({ q: 'x', actions: ['a'] }, { actions: ['a'], q: 'x', user: null })).toBe(
      true
    )
    expect(sameFilters({ q: 'x' }, { q: 'y' })).toBe(false)
  })
})
