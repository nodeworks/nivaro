import { describe, expect, it } from 'vitest'
import {
  bucketsFromOffsets,
  DAY_MS,
  distinctRecords,
  HOUR_MS,
  hourlyBuckets,
  isAppPath,
  normalizeLayout,
  normalizePinnedActions,
  normalizePrefs,
  normalizeRoleDefaults,
  openIssuesBefore,
  overviewWindows,
  parseDayStart,
  rollVisit
} from './model.js'

const NOW = new Date('2026-10-29T22:30:00.000Z')

describe('parseDayStart', () => {
  it('takes the viewer midnight when it is recent', () => {
    expect(parseDayStart('2026-10-29T04:00:00.000Z', NOW).toISOString()).toBe(
      '2026-10-29T04:00:00.000Z'
    )
  })
  it('falls back to UTC midnight for junk, future or stale values', () => {
    for (const v of ['nope', '2026-10-30T04:00:00.000Z', '2026-10-20T04:00:00.000Z', null]) {
      expect(parseDayStart(v, NOW).toISOString()).toBe('2026-10-29T00:00:00.000Z')
    }
  })
})

describe('overviewWindows', () => {
  it('compares today with yesterday up to the same time', () => {
    const w = overviewWindows(new Date('2026-10-29T04:00:00.000Z'), NOW)
    expect(w.sameTimeYesterday.from.toISOString()).toBe('2026-10-28T04:00:00.000Z')
    expect(w.sameTimeYesterday.to.toISOString()).toBe('2026-10-28T22:30:00.000Z')
    expect(w.previous24.from.getTime()).toBe(NOW.getTime() - 2 * DAY_MS)
    expect(w.span.from.getTime()).toBe(w.sameTimeYesterday.from.getTime())
  })
})

describe('hour buckets', () => {
  it('puts each time in its hour, oldest first, and ignores times outside', () => {
    const b = hourlyBuckets(
      [
        new Date(NOW.getTime() - 10 * 60_000),
        new Date(NOW.getTime() - 20 * 60_000),
        new Date(NOW.getTime() - 23.5 * HOUR_MS),
        new Date(NOW.getTime() - 30 * HOUR_MS),
        'garbage'
      ],
      NOW
    )
    expect(b).toHaveLength(24)
    expect(b[23]).toBe(2)
    expect(b[0]).toBe(1)
    expect(b.reduce((a, n) => a + n, 0)).toBe(3)
  })
  it('reads SQL hour offsets the same way', () => {
    const b = bucketsFromOffsets([
      { h: 0, n: 2 },
      { h: '23', n: '5' },
      { h: 24, n: 9 },
      { h: null, n: 1 }
    ])
    expect(b[0]).toBe(2)
    expect(b[23]).toBe(5)
    expect(b.reduce((a, n) => a + n, 0)).toBe(7)
  })
})

describe('distinctRecords', () => {
  it('counts each record once inside the window', () => {
    const w = { from: new Date(NOW.getTime() - HOUR_MS), to: NOW }
    const at = new Date(NOW.getTime() - 60_000)
    expect(
      distinctRecords(
        [
          { collection: 'orders', item: '1', timestamp: at },
          { collection: 'orders', item: '1', timestamp: at },
          { collection: 'orders', item: '2', timestamp: at },
          { collection: 'people', item: '1', timestamp: at },
          { collection: 'orders', item: '3', timestamp: new Date(NOW.getTime() - 2 * HOUR_MS) },
          { collection: null, item: '4', timestamp: at }
        ],
        w
      )
    ).toBe(3)
  })
})

describe('openIssuesBefore', () => {
  it('backs out the last day', () => {
    expect(openIssuesBefore(10, 3, 1)).toBe(8)
    expect(openIssuesBefore(1, 5, 0)).toBe(0)
  })
})

describe('preferences', () => {
  it('keeps only drawable layouts and in-app paths', () => {
    expect(
      normalizeLayout({ order: ['stats', 'Bad Key', 'stats'], hidden: ['x'], shown: ['x', 'y'] })
    ).toEqual({
      order: ['stats'],
      hidden: ['x'],
      shown: ['y']
    })
    expect(normalizeLayout('nope')).toBeNull()
    expect(isAppPath('/flows')).toBe(true)
    expect(isAppPath('//evil.example')).toBe(false)
    expect(isAppPath('javascript:alert(1)')).toBe(false)
    expect(
      normalizePinnedActions([
        { path: '/flows', label: 'Flows' },
        { path: '/flows', label: 'Again' },
        { path: 'https://x', label: 'Out' },
        { path: '/jobs', label: '' }
      ])
    ).toEqual([{ path: '/flows', label: 'Flows' }])
  })
  it('reads junk as empty', () => {
    expect(normalizePrefs(null).pinned_widgets).toEqual([])
    expect(normalizePrefs({ pinned_widgets: ['a-1', 'a-1', '<x>'] }).pinned_widgets).toEqual([
      'a-1'
    ])
  })
  it('role defaults key by upper-case role id', () => {
    const id = '0f3c2b1a-1111-2222-3333-444455556666'
    const out = normalizeRoleDefaults(JSON.stringify({ [id]: { order: ['stats'] }, nope: {} }))
    expect(Object.keys(out)).toEqual([id.toUpperCase()])
    expect(normalizeRoleDefaults('{bad')).toEqual({})
  })
})

describe('rollVisit', () => {
  const base = normalizePrefs({})
  it('moves the baseline forward after a break', () => {
    const first = rollVisit(base, NOW, '0.3.56')
    expect(first.prev_visit_at).toBeNull()
    const later = rollVisit(first, new Date(NOW.getTime() + 2 * HOUR_MS), '0.3.57')
    expect(later.prev_visit_at).toBe(NOW.toISOString())
    expect(later.prev_visit_version).toBe('0.3.56')
    expect(later.last_visit_version).toBe('0.3.57')
  })
  it('keeps the baseline inside one sitting', () => {
    const first = rollVisit(rollVisit(base, NOW, 'a'), new Date(NOW.getTime() + 2 * HOUR_MS), 'a')
    const reload = rollVisit(first, new Date(NOW.getTime() + 2 * HOUR_MS + 60_000), 'a')
    expect(reload.prev_visit_at).toBe(first.prev_visit_at)
  })
})
