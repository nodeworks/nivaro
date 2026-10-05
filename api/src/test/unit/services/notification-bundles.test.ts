import { describe, expect, it } from 'vitest'
import {
  bundleKeyOf,
  bundleNotifications,
  mostUrgentLane
} from '../../../services/notification-bundles.js'

const row = (
  id: number,
  collection: string | null,
  item: string | null,
  extra: Partial<{ read: boolean; lane: 'critical' | 'needs_you' | 'fyi'; category: string }> = {}
) => ({
  id,
  collection,
  item,
  read: extra.read ?? false,
  lane: extra.lane ?? null,
  category: extra.category ?? null,
  created_at: new Date(2026, 9, 1, 12, 0, id).toISOString()
})

describe('mostUrgentLane', () => {
  it('ranks critical over needs-you over fyi; a missing lane reads as needs-you', () => {
    expect(mostUrgentLane(['fyi', 'needs_you'])).toBe('needs_you')
    expect(mostUrgentLane(['fyi', 'critical', 'needs_you'])).toBe('critical')
    expect(mostUrgentLane(['fyi', null])).toBe('needs_you')
    expect(mostUrgentLane(['fyi'])).toBe('fyi')
    expect(mostUrgentLane([])).toBe('fyi')
  })
})

describe('bundleKeyOf', () => {
  it('keys on collection + item and ignores pseudo-collections', () => {
    expect(bundleKeyOf(row(1, 'workflows', '42'))).toBe('workflows:42')
    expect(bundleKeyOf(row(1, '__chat__', 'dm:A:B'))).toBeNull()
    expect(bundleKeyOf(row(1, 'workflows', null))).toBeNull()
    expect(bundleKeyOf(row(1, null, '42'))).toBeNull()
  })
})

describe('bundleNotifications', () => {
  it('folds two or more rows on one record into a bundle and leaves singles alone', () => {
    const rows = [
      row(5, 'workflows', '42', { category: 'workflow', lane: 'fyi' }),
      row(4, 'projects', '7'),
      row(3, 'workflows', '42', { category: 'mentions', lane: 'needs_you' }),
      row(2, null, null),
      row(1, 'workflows', '42', { category: 'workflow', lane: 'fyi', read: true })
    ]
    const { rows: singles, bundles } = bundleNotifications(rows)
    expect(singles.map((r) => r.id)).toEqual([4, 2])
    expect(bundles).toHaveLength(1)
    const b = bundles[0]
    expect(b.collection).toBe('workflows')
    expect(b.item).toBe('42')
    expect(b.count).toBe(3)
    expect(b.unread).toBe(2)
    expect(b.ids).toEqual([5, 3, 1])
    expect(b.categories).toEqual(['workflow', 'mentions'])
    expect(b.lane).toBe('needs_you')
    expect(b.newest).toBe(rows[0].created_at)
    expect(b.rows.map((r) => r.id)).toEqual([5, 3, 1])
  })

  it('judges the lane on unread rows while any remain', () => {
    const rows = [
      row(2, 'workflows', '1', { lane: 'critical', read: true }),
      row(1, 'workflows', '1', { lane: 'fyi' })
    ]
    expect(bundleNotifications(rows).bundles[0].lane).toBe('fyi')
    const allRead = rows.map((r) => ({ ...r, read: true }))
    expect(bundleNotifications(allRead).bundles[0].lane).toBe('critical')
  })

  it('orders bundles newest first', () => {
    const rows = [
      row(9, 'projects', '1'),
      row(8, 'workflows', '2'),
      row(7, 'workflows', '2'),
      row(1, 'projects', '1')
    ]
    const { bundles } = bundleNotifications(rows)
    expect(bundles.map((b) => `${b.collection}:${b.item}`)).toEqual(['projects:1', 'workflows:2'])
  })

  it('leaves a page with no record rows untouched', () => {
    const rows = [row(2, null, null), row(1, '__chat__', 'global')]
    const out = bundleNotifications(rows)
    expect(out.bundles).toEqual([])
    expect(out.rows).toEqual(rows)
  })
})
