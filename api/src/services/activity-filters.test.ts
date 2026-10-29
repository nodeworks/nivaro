import knex from 'knex'
import { describe, expect, it } from 'vitest'
import {
  activityWindow,
  applyActivityFilters,
  hasActivityFilter,
  likeContains,
  normalizeActivityFilters,
  resolveRange
} from './activity-filters.js'

/** #10 — the one filter shape behind GET /api/activity, saved views and the NL search. */

const k = knex({ client: 'mssql' })
const NOW = new Date('2026-10-29T15:00:00.000Z') // a Thursday
const UID = '11111111-2222-3333-4444-555555555555'

describe('normalizeActivityFilters', () => {
  it('reads repeated, bracketed and comma-separated lists', () => {
    const { filters, errors } = normalizeActivityFilters({
      'action[]': ['create', 'update'],
      action: 'delete',
      collection: 'invoices,nivaro_roles',
      user: UID,
      q: '  refund ',
      range: 'last_week'
    })
    expect(errors).toEqual([])
    expect(filters).toEqual({
      user: UID,
      actions: ['delete', 'create', 'update'],
      collections: ['invoices', 'nivaro_roles'],
      q: 'refund',
      range: 'last_week'
    })
  })

  it('names what it drops', () => {
    const { filters, errors } = normalizeActivityFilters({
      user: 'sam',
      collection: 'x; drop',
      from: 'soon',
      range: 'forever'
    })
    expect(filters).toEqual({})
    expect(errors).toHaveLength(4)
  })
})

describe('windows', () => {
  it('resolves relative ranges in UTC, weeks from Monday', () => {
    expect(resolveRange('this_week', NOW).from.toISOString()).toBe('2026-10-26T00:00:00.000Z')
    const lw = resolveRange('last_week', NOW)
    expect(lw.from.toISOString()).toBe('2026-10-19T00:00:00.000Z')
    expect(lw.to?.toISOString()).toBe('2026-10-25T23:59:59.999Z')
    expect(resolveRange('last_month', NOW).from.toISOString()).toBe('2026-09-01T00:00:00.000Z')
  })

  it('bounds text search to 90 days when no window is given', () => {
    const w = activityWindow({ q: 'x' }, NOW)
    expect(w.defaulted).toBe(true)
    expect(w.from?.toISOString()).toBe('2026-07-31T15:00:00.000Z')
    expect(activityWindow({ q: 'x', from: '2026-01-01' }, NOW).defaulted).toBe(false)
  })
})

describe('applyActivityFilters', () => {
  it('binds every value (no model or user text in the SQL)', () => {
    const qb = k('nivaro_activity as a').select('a.id')
    applyActivityFilters(
      qb,
      {
        user: UID,
        actions: ['delete'],
        exclude_actions: ['login'],
        collections: ['invoices', 'bills'],
        item: '7',
        from: '2026-10-01',
        to: '2026-10-02',
        q: "50%'; drop"
      },
      { mssql: true, now: NOW }
    )
    const { sql, bindings } = qb.toSQL()
    expect(sql).not.toContain('drop')
    expect(sql).toContain('[a].[action] in (?)')
    expect(sql).toContain('[a].[action] not in (?)')
    expect(sql).toContain('[a].[collection] in (?, ?)')
    expect(sql).toContain('select [id] from [nivaro_users]')
    expect(bindings).toContain("%50[%]'; drop%")
    expect(bindings).toContain(UID)
  })

  it('treats no filters as unfiltered', () => {
    expect(hasActivityFilter({})).toBe(false)
    expect(hasActivityFilter({ exclude_actions: ['login'] })).toBe(true)
  })

  it('escapes LIKE wildcards per dialect', () => {
    expect(likeContains('a_b[c', true)).toBe('%a[_]b[[]c%')
    expect(likeContains('a_b', false)).toBe('%a\\_b%')
  })
})
