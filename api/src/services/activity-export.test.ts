import { describe, expect, it } from 'vitest'
import { activityCsv, csvCell, groupActivityByDay, safeTimeZone } from './activity-export.js'

/** #13 — the person page's day → collection grouping and the CSV. */

describe('groupActivityByDay', () => {
  const rows = [
    { timestamp: '2026-10-29T02:00:00.000Z', collection: 'invoices', action: 'update' },
    { timestamp: '2026-10-29T03:00:00.000Z', collection: 'invoices', action: 'delete' },
    { timestamp: '2026-10-29T14:00:00.000Z', collection: 'vendors', action: 'create' },
    { timestamp: '2026-10-28T14:00:00.000Z', collection: null, action: 'login' }
  ]

  it('groups by day, newest first, then by collection busiest first', () => {
    const g = groupActivityByDay(rows, 'UTC')
    expect(g.map((d) => d.day)).toEqual(['2026-10-29', '2026-10-28'])
    expect(g[0].total).toBe(3)
    expect(g[0].collections[0]).toEqual({
      collection: 'invoices',
      count: 2,
      actions: { update: 1, delete: 1 }
    })
    expect(g[1].collections[0].collection).toBeNull()
  })

  it('uses the viewer’s time zone for the day', () => {
    const g = groupActivityByDay(rows, 'America/New_York')
    // 02:00 and 03:00 UTC on the 29th are the evening of the 28th in New York.
    expect(g.find((d) => d.day === '2026-10-28')?.total).toBe(3)
    expect(safeTimeZone('Mars/Olympus')).toBe('UTC')
  })
})

describe('CSV', () => {
  it('quotes and neutralises cells', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell(null)).toBe('')
    const csv = activityCsv([
      {
        id: 1,
        action: 'update',
        user: 'u',
        timestamp: '2026-10-29T02:00:00.000Z',
        collection: 'invoices',
        item: '3',
        comment: 'line 1\nline 2',
        first_name: 'Sam',
        last_name: 'Lee',
        user_email: 'sam@x.io'
      }
    ])
    expect(csv).toContain(
      '2026-10-29T02:00:00.000Z,Sam Lee,sam@x.io,update,invoices,3,"line 1\nline 2"'
    )
  })
})
