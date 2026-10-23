import knex from 'knex'
import { describe, expect, it } from 'vitest'
import {
  mergeUserNames,
  parseReportDate,
  SUMMARY_DEFAULT_DAYS,
  summaryQueries,
  summaryWindow
} from './activity-report.js'

const k = knex({ client: 'mssql' })
const NOW = new Date('2026-10-23T15:00:00.000Z')

describe('parseReportDate', () => {
  it('reads a bare to-date as the end of that day and a from-date as its start', () => {
    expect(parseReportDate('2025-12-31', 'end')).toEqual(new Date('2025-12-31T23:59:59.999Z'))
    expect(parseReportDate('2025-12-31', 'start')).toEqual(new Date('2025-12-31T00:00:00.000Z'))
  })

  it('keeps full timestamps as sent, treats blank as absent and flags garbage', () => {
    expect(parseReportDate('2025-06-01T10:30:00Z', 'end')).toEqual(new Date('2025-06-01T10:30:00Z'))
    expect(parseReportDate('', 'start')).toBeNull()
    expect(parseReportDate(undefined, 'end')).toBeNull()
    expect(parseReportDate('not-a-date', 'start')).toBe('invalid')
  })
})

describe('summaryWindow', () => {
  it('defaults to the last 30 days when no range is sent', () => {
    const w = summaryWindow({}, NOW)
    expect(w).toEqual({
      from: new Date(NOW.getTime() - SUMMARY_DEFAULT_DAYS * 86400000),
      to: null,
      defaulted: true
    })
  })

  it('anchors the default window on `to` when only `to` is sent', () => {
    const w = summaryWindow({ to: '2025-12-31' }, NOW)
    if ('error' in w) throw new Error(w.error)
    expect(w.defaulted).toBe(true)
    expect(w.to).toEqual(new Date('2025-12-31T23:59:59.999Z'))
    expect(w.from.getTime()).toBe((w.to as Date).getTime() - SUMMARY_DEFAULT_DAYS * 86400000)
  })

  it('honours an explicit range', () => {
    expect(summaryWindow({ from: '2025-01-01', to: '2025-01-31' }, NOW)).toEqual({
      from: new Date('2025-01-01T00:00:00.000Z'),
      to: new Date('2025-01-31T23:59:59.999Z'),
      defaulted: false
    })
  })

  it('rejects unparseable dates', () => {
    expect(summaryWindow({ from: 'yesterday-ish' }, NOW)).toEqual({
      error: '`from` is not a valid date'
    })
  })
})

describe('summaryQueries', () => {
  const win = { from: new Date('2026-09-23T00:00:00Z'), to: null }
  const q = summaryQueries(k, win)

  it('windows every aggregate on timestamp', () => {
    for (const b of [q.byAction, q.byCollection, q.byUser, q.total]) {
      const { sql, bindings } = b.toSQL()
      expect(sql).toContain('[a].[timestamp] >= ?')
      expect(bindings).toContain(win.from)
    }
  })

  it('groups activity by user alone — no join to nivaro_users inside the aggregate', () => {
    const { sql } = q.byUser.toSQL()
    expect(sql).not.toMatch(/join/i)
    expect(sql).not.toContain('nivaro_users')
    expect(sql).toMatch(/group by \[a\]\.\[user\]$|group by \[a\]\.\[user\] order by/)
  })

  it('adds the upper bound when `to` is set', () => {
    const to = new Date('2026-10-01T23:59:59.999Z')
    const { sql, bindings } = summaryQueries(k, { from: win.from, to }).total.toSQL()
    expect(sql).toContain('[a].[timestamp] <= ?')
    expect(bindings).toContain(to)
  })
})

describe('mergeUserNames', () => {
  it('attaches names case-insensitively, keeps count order and null groups', () => {
    const rows = mergeUserNames(
      [
        { user_id: 'AAAA-1', count: '5' },
        { user_id: null, count: 3 },
        { user_id: 'gone', count: 1 }
      ],
      [{ id: 'aaaa-1', first_name: 'Ann', last_name: 'Lee', email: 'ann@x.test' }]
    )
    expect(rows).toEqual([
      { user_id: 'AAAA-1', first_name: 'Ann', last_name: 'Lee', email: 'ann@x.test', count: 5 },
      { user_id: null, first_name: null, last_name: null, email: null, count: 3 },
      { user_id: 'gone', first_name: null, last_name: null, email: null, count: 1 }
    ])
  })
})
