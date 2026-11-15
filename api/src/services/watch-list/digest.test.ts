import { describe, expect, it } from 'vitest'
import { DIGEST_WINDOW_MS, digestDue, digestItems, localClock, windowList } from './digest.js'
import type { WatchRow } from './rows.js'
import { normalizeWatchList } from './store.js'

const NOW = new Date('2026-11-14T12:00:00')

const row = (over: Partial<WatchRow>): WatchRow => ({
  key: 'orders:1',
  collection: 'orders',
  collection_label: 'Order',
  id: '1',
  pinned_at: '2026-11-01T00:00:00Z',
  available: true,
  title: 'Order 1',
  state: { key: 'review', label: 'Review', color: null },
  owners: [],
  figures: [],
  sla: null,
  timing: null,
  change: null,
  updated_at: null,
  ...over
})

describe('daily watch-list email', () => {
  it('reads the last day as "unseen"', () => {
    const l = normalizeWatchList({ pins: [{ c: 'orders', id: '1', at: '2026-10-01T00:00:00Z' }] })
    const w = windowList(l, NOW)
    expect(new Date(w.seen['orders:1']).getTime()).toBe(NOW.getTime() - DIGEST_WINDOW_MS)
  })

  it('lists only records someone else changed, newest first', () => {
    const items = digestItems([
      row({
        key: 'orders:1',
        change: {
          kind: 'moved',
          at: '2026-11-14T08:00:00Z',
          by: { id: 'b', name: 'Beth', self: false },
          text: 'Moved to Approved',
          changed: true,
          unseen: 1
        }
      }),
      row({
        key: 'orders:2',
        title: 'Order 2',
        change: {
          kind: 'edited',
          at: '2026-11-14T09:00:00Z',
          by: { id: 'b', name: 'Beth', self: false },
          text: 'Changed Amount',
          changed: true,
          unseen: 1
        }
      }),
      row({
        key: 'orders:3',
        change: {
          kind: 'edited',
          at: '2026-11-14T10:00:00Z',
          by: { id: 'me', name: 'You', self: true },
          text: 'Changed Amount',
          changed: false,
          unseen: 0
        }
      }),
      row({ key: 'orders:4', available: false })
    ])
    expect(items.map((i) => i.key)).toEqual(['orders:2', 'orders:1'])
    expect(items[1]).toMatchObject({ text: 'Moved to Approved', by: 'Beth', step: 'Review' })
  })

  it('is due at the person’s own hour in their zone, else 7 AM Eastern, once a day', () => {
    const on = normalizeWatchList({ settings: { digest: true }, pins: [{ c: 'orders', id: '1' }] })
    // 12:00 UTC = 7 AM in New York (EST) = 4 AM in Los Angeles.
    const noonUtc = new Date('2026-11-14T12:00:00Z')
    expect(digestDue(on, {}, noonUtc)).toEqual({ due: true, day: '2026-11-14' })
    expect(digestDue(on, { timezone: 'America/Los_Angeles' }, noonUtc).due).toBe(false)
    expect(digestDue(on, { timezone: 'America/Los_Angeles', digest_hour: 4 }, noonUtc).due).toBe(
      true
    )
    expect(digestDue(on, { timezone: 'Not/AZone' }, noonUtc).due).toBe(true)
    expect(digestDue({ ...on, digest_sent_on: '2026-11-14' }, {}, noonUtc).due).toBe(false)
    expect(digestDue(normalizeWatchList({ settings: { digest: true } }), {}, noonUtc).due).toBe(
      false
    )
    expect(
      digestDue(normalizeWatchList({ pins: [{ c: 'orders', id: '1' }] }), {}, noonUtc).due
    ).toBe(false)
  })

  it('reads the local day across midnight', () => {
    expect(localClock(new Date('2026-11-15T03:30:00Z'), 'America/New_York')).toEqual({
      day: '2026-11-14',
      hour: 22
    })
  })
})
