import knex from 'knex'
import { describe, expect, it } from 'vitest'
import { largestBurstOf, summaryQueries } from './activity-report.js'
import {
  applyReportFilters,
  hasReportFilterParams,
  reportFilters
} from './activity-report-filters.js'

const k = knex({ client: 'mssql' })
const NOW = new Date('2026-10-29T15:00:00.000Z')
const DAY = 86_400_000

describe('Audit report summary filters', () => {
  it('only treats the activity filter keys as a filtered summary', () => {
    expect(hasReportFilterParams({ from: '2026-01-01', to: '2026-02-01' })).toBe(false)
    expect(hasReportFilterParams({ exclude_actions: 'read' })).toBe(true)
    expect(hasReportFilterParams({ range: 'last_7_days' })).toBe(true)
    expect(hasReportFilterParams({ user: '' })).toBe(false)
  })

  it('resolves a relative range and keeps the rest of the filters', () => {
    const r = reportFilters(
      { range: 'last_7_days', action: 'update,delete', collection: 'workflows' },
      NOW
    )
    if ('error' in r) throw new Error(r.error)
    expect(r.win).toEqual({ from: new Date(NOW.getTime() - 7 * DAY), to: null, defaulted: false })
    expect(r.filters).toEqual({ actions: ['update', 'delete'], collections: ['workflows'] })
    expect(r.range).toBe('last_7_days')
  })

  it('falls back to the 30-day window with no dates, and answers bad input with an error', () => {
    const r = reportFilters({ exclude_actions: 'read' }, NOW)
    if ('error' in r) throw new Error(r.error)
    expect(r.win.defaulted).toBe(true)
    expect(r.win.from).toEqual(new Date(NOW.getTime() - 30 * DAY))
    expect(reportFilters({ user: 'pat@example.com' }, NOW)).toHaveProperty('error')
  })

  it('pins the window so a text search adds no 90-day default of its own', () => {
    const r = reportFilters({ q: 'refund', from: '2025-01-01', to: '2025-01-31' }, NOW)
    if ('error' in r) throw new Error(r.error)
    const sql = applyReportFilters(k('nivaro_activity as a').select('a.id'), r, {
      mssql: true,
      now: NOW
    }).toSQL()
    expect(sql.bindings).toContainEqual(new Date('2025-01-01T00:00:00.000Z'))
    expect(sql.bindings).not.toContainEqual(new Date(NOW.getTime() - 90 * DAY))
  })

  it('narrows every summary aggregate and adds the largest burst when the column exists', () => {
    const r = reportFilters({ exclude_actions: 'read', range: 'last_7_days' }, NOW)
    if ('error' in r) throw new Error(r.error)
    const q = summaryQueries(k, r.win, {
      apply: (qb) => void applyReportFilters(qb, r, { mssql: true, now: NOW }),
      groupKey: true
    })
    for (const part of [q.byAction, q.byCollection, q.byUser, q.total]) {
      expect(part.toSQL().sql).toContain('not in')
    }
    expect(q.largestBurst?.toSQL().sql).toContain('group by [a].[group_key]')
    expect(summaryQueries(k, r.win).largestBurst).toBeNull()
  })
})

describe('largestBurstOf', () => {
  it('names the shared action and collection, and ignores bursts of one', () => {
    expect(
      largestBurstOf([
        {
          group_key: 'import_run:7',
          count: '40',
          action: 'update',
          action_max: 'update',
          collection: 'workflows',
          collection_max: 'invoices'
        }
      ])
    ).toEqual({ group_key: 'import_run:7', count: 40, action: 'update', collection: null })
    expect(largestBurstOf([{ group_key: 'x', count: 1 }])).toBeNull()
    expect(largestBurstOf([])).toBeNull()
    expect(largestBurstOf(null)).toBeNull()
  })
})
