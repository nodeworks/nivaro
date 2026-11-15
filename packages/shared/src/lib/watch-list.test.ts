import { describe, expect, it } from 'vitest'
import {
  changedKeys,
  sortWatchRows,
  spanText,
  type WatchRowData,
  withLocalSeen
} from './watch-list'

const row = (key: string, over: Partial<WatchRowData> = {}): WatchRowData => ({
  key,
  collection: 'orders',
  collection_label: 'Order',
  id: key.split(':')[1],
  pinned_at: '2026-11-01T00:00:00Z',
  available: true,
  title: key,
  state: null,
  owners: [],
  figures: [],
  sla: null,
  timing: null,
  change: null,
  updated_at: null,
  ...over
})

describe('watch list (client)', () => {
  it('sorts by last change and by due, unavailable rows last', () => {
    const rows = [
      row('orders:1', {
        change: {
          kind: 'edited',
          at: '2026-11-10T00:00:00Z',
          by: null,
          text: '',
          changed: false,
          unseen: 0
        }
      }),
      row('orders:2', { available: false }),
      row('orders:3', {
        change: {
          kind: 'moved',
          at: '2026-11-12T00:00:00Z',
          by: null,
          text: '',
          changed: true,
          unseen: 1
        }
      }),
      row('orders:4', {
        sla: { status: 'warning', warning_at: null, due_at: '2026-11-20T00:00:00Z' }
      })
    ]
    expect(sortWatchRows(rows, 'mine').map((r) => r.key)).toEqual(rows.map((r) => r.key))
    expect(sortWatchRows(rows, 'changed').map((r) => r.key)).toEqual([
      'orders:3',
      'orders:1',
      'orders:4',
      'orders:2'
    ])
    expect(sortWatchRows(rows, 'due')[0].key).toBe('orders:4')
    expect(sortWatchRows(rows, 'due').at(-1)?.key).toBe('orders:2')
  })

  it('counts the server’s changed pins plus live marks, only for pins still pinned', () => {
    const pinned = new Set(['orders:1', 'orders:2'])
    expect(
      changedKeys(['orders:1', 'orders:9'], new Set(['orders:2', 'orders:1']), pinned)
    ).toEqual(['orders:1', 'orders:2'])
  })

  it('a pin marked seen here stays quiet until something newer happens', () => {
    const seenAt = new Date('2026-11-12T00:00:00Z').getTime()
    const changed = (at: string) =>
      row('orders:1', {
        change: { kind: 'edited', at, by: null, text: '', changed: true, unseen: 1 }
      })
    expect(
      withLocalSeen([changed('2026-11-11T00:00:00Z')], new Map([['orders:1', seenAt]]))[0].change
        ?.changed
    ).toBe(false)
    expect(
      withLocalSeen([changed('2026-11-13T00:00:00Z')], new Map([['orders:1', seenAt]]))[0].change
        ?.changed
    ).toBe(true)
  })

  it('words a span shortly', () => {
    expect(spanText(30)).toBe('1 m')
    expect(spanText(7200)).toBe('2 h')
    expect(spanText(3 * 86_400)).toBe('3 d')
  })
})
