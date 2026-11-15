import { describe, expect, it } from 'vitest'
import {
  addPin,
  DOCK_WIDTH_MAX,
  markSeen,
  normalizeDock,
  normalizeWatchList,
  pinnable,
  removePin,
  reorderPins,
  seenAt,
  WATCH_PINS_MAX
} from './store.js'

const empty = () => normalizeWatchList(undefined)
const T0 = new Date('2026-11-14T10:00:00Z')

describe('watch list store', () => {
  it('reads any stored shape as a valid list', () => {
    const l = normalizeWatchList({
      pins: [
        { c: 'orders', id: '5', at: '2026-11-01T00:00:00Z' },
        { c: 'orders', id: '5', at: '2026-11-02T00:00:00Z' },
        { c: 'nivaro_users', id: 'x' },
        { c: 'orders', id: 'bad id!' },
        'junk'
      ],
      seen: { 'orders:5': '2026-11-03T00:00:00Z', 'gone:1': '2026-11-03T00:00:00Z' },
      dock: { state: 'weird', width: 9999, tab: 'mentions' }
    })
    expect(l.pins.map((p) => `${p.c}:${p.id}`)).toEqual(['orders:5'])
    expect(Object.keys(l.seen)).toEqual(['orders:5'])
    expect(l.dock).toEqual({ state: 'open', width: DOCK_WIDTH_MAX, tab: 'mentions', sort: 'mine' })
  })

  it('pins a record to the top, once, and counts it as seen now', () => {
    const a = addPin(empty(), 'orders', '1', T0)
    expect(a.ok && a.changed).toBe(true)
    if (!a.ok) return
    const b = addPin(a.list, 'orders', '2', T0)
    if (!b.ok) throw new Error('refused')
    expect(b.list.pins.map((p) => p.id)).toEqual(['2', '1'])
    expect(b.list.seen['orders:2']).toBe(T0.toISOString())
    const again = addPin(b.list, 'orders', '1', T0)
    expect(again.ok && !again.changed).toBe(true)
  })

  it('refuses system tables and a full list', () => {
    expect(pinnable('nivaro_users', '1')).toBe(false)
    expect(addPin(empty(), 'directus_files', '1').ok).toBe(false)
    let l = empty()
    for (let i = 0; i < WATCH_PINS_MAX; i++) {
      const r = addPin(l, 'orders', String(i))
      if (!r.ok) throw new Error('refused early')
      l = r.list
    }
    const full = addPin(l, 'orders', 'one-more')
    expect(full.ok).toBe(false)
    if (!full.ok) expect(full.code).toBe('WATCH_LIST_FULL')
  })

  it('unpins and forgets the seen mark', () => {
    const a = addPin(empty(), 'orders', '1', T0)
    if (!a.ok) throw new Error('refused')
    const r = removePin(a.list, 'orders', '1')
    expect(r.changed).toBe(true)
    expect(r.list.pins).toEqual([])
    expect(r.list.seen).toEqual({})
    expect(removePin(r.list, 'orders', '1').changed).toBe(false)
  })

  it('reorders by the keys given and keeps pins it did not name', () => {
    let l = empty()
    for (const id of ['1', '2', '3']) {
      const r = addPin(l, 'orders', id, T0)
      if (r.ok) l = r.list
    }
    // pins are [3, 2, 1]; a tab that only knew 1 and 2 reorders them
    const next = reorderPins(l, ['orders:1', 'orders:2', 'orders:nope'])
    expect(next.pins.map((p) => p.id)).toEqual(['1', '2', '3'])
  })

  it('marks seen forward only, all or some', () => {
    const a = addPin(empty(), 'orders', '1', T0)
    if (!a.ok) throw new Error('refused')
    const later = new Date('2026-11-14T12:00:00Z')
    const s = markSeen(a.list, null, later)
    expect(s.changed).toBe(true)
    expect(seenAt(s.list, s.list.pins[0])).toBe(later.toISOString())
    expect(markSeen(s.list, ['orders:1'], T0).changed).toBe(false)
  })

  it('keeps dock values inside their bounds', () => {
    expect(normalizeDock({ width: 10, state: 'minimized', sort: 'due' })).toMatchObject({
      width: 280,
      state: 'minimized',
      sort: 'due'
    })
  })
})
