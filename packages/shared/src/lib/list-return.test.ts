// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AWAY_MAX_EVENTS,
  AWAY_MAX_MS,
  changedRowIds,
  LIST_RETURN_KEY,
  listNeighbors,
  listReturnFor,
  noteListOpen,
  peekListAway,
  planListReturn,
  readListReturn,
  resetListAwayForTests,
  returnRowFor,
  standbyListAway,
  stepListReturn,
  takeListAway
} from './list-return'
import { clearOwnWrites, noteOwnWrite } from './own-writes'
import type { CollectionUpdateEvent, RealtimeAdapter, RealtimeStatus } from './realtime'

function fakeRealtime(withStatus = true) {
  const listeners = new Set<{ names: string[]; cb: (ev: CollectionUpdateEvent) => void }>()
  const statusCbs = new Set<(s: RealtimeStatus) => void>()
  const adapter: RealtimeAdapter = {
    subscribeCollections(names, cb) {
      const l = { names, cb }
      listeners.add(l)
      return () => listeners.delete(l)
    },
    on: () => () => {},
    emit: () => {},
    ...(withStatus
      ? {
          status: () => ({ state: 'live', transport: 'websocket' }) as RealtimeStatus,
          onStatus: (cb: (s: RealtimeStatus) => void) => {
            statusCbs.add(cb)
            return () => statusCbs.delete(cb)
          }
        }
      : {})
  }
  return {
    adapter,
    send(ev: CollectionUpdateEvent & Record<string, unknown>) {
      for (const l of listeners) if (l.names.includes(ev.collection)) l.cb(ev)
    },
    status(s: RealtimeStatus) {
      for (const cb of statusCbs) cb(s)
    },
    count: () => listeners.size
  }
}

describe('list return stash (Previous / Next in list)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    window.history.replaceState({ idx: 4, key: 'listkey' }, '')
  })

  it('keeps the rows in order, de-duplicated, and the opened row', () => {
    noteListOpen({
      list: 'cbv:workflows',
      label: 'Workflows',
      path: '/collections/workflows?x=1',
      rows: [
        { collection: 'workflows', id: '1' },
        { collection: 'workflows', id: '2' },
        { collection: 'workflows', id: '2' },
        { collection: 'workflows', id: '3' }
      ],
      opened: { collection: 'workflows', id: '2' },
      entry: 'listkey'
    })
    const s = readListReturn()
    expect(s?.rows.map((r) => r.id)).toEqual(['1', '2', '3'])
    expect(s?.current).toEqual({ collection: 'workflows', id: '2' })
    // The record page is the NEXT history entry.
    expect(s?.idx).toBe(5)
    expect(listNeighbors(s, { collection: 'workflows', id: '2' })).toEqual({
      index: 2,
      total: 3,
      prev: { collection: 'workflows', id: '1' },
      next: { collection: 'workflows', id: '3' }
    })
    expect(listNeighbors(s, { collection: 'workflows', id: '1' })?.prev).toBeNull()
    expect(listNeighbors(s, { collection: 'workflows', id: '3' })?.next).toBeNull()
    expect(listNeighbors(s, { collection: 'workflows', id: '9' })).toBeNull()
  })

  it('belongs only to the record it opened, on the entry it opened it on', () => {
    noteListOpen({
      list: 'cbv:workflows',
      rows: [
        { collection: 'workflows', id: '1' },
        { collection: 'workflows', id: '2' }
      ],
      opened: { collection: 'workflows', id: '1' }
    })
    window.history.replaceState({ idx: 5, key: 'rec' }, '')
    expect(listReturnFor({ collection: 'workflows', id: '1' })).not.toBeNull()
    // Another record (reached from a search) is not "in the list".
    expect(listReturnFor({ collection: 'workflows', id: '2' })).toBeNull()
    // Walking with Next keeps the same entry (replace) and moves `current`.
    stepListReturn({ collection: 'workflows', id: '2' })
    expect(listReturnFor({ collection: 'workflows', id: '2' })).not.toBeNull()
    expect(returnRowFor('cbv:workflows')).toEqual({ collection: 'workflows', id: '2' })
    expect(returnRowFor('cbv:other')).toBeNull()
    // The same record opened later on another entry.
    window.history.replaceState({ idx: 9, key: 'later' }, '')
    expect(listReturnFor({ collection: 'workflows', id: '2' })).toBeNull()
  })

  it('ignores a stale or garbled stash', () => {
    sessionStorage.setItem(LIST_RETURN_KEY, '{nope')
    expect(readListReturn()).toBeNull()
    noteListOpen({
      list: 'cbv:a',
      rows: [{ collection: 'a', id: '1' }],
      opened: { collection: 'a', id: '1' }
    })
    expect(readListReturn(Date.now() + 7 * 60 * 60 * 1000)).toBeNull()
  })
})

describe('away log', () => {
  beforeEach(() => {
    resetListAwayForTests()
    clearOwnWrites()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('records nothing while the list is on screen; a first visit plans fresh', () => {
    const rt = fakeRealtime()
    standbyListAway(rt.adapter, 'cbv:w', ['w'])
    rt.send({ collection: 'w', item: '1', action: 'update', changed_fields: ['name'] })
    expect(peekListAway('cbv:w')).toBeNull()
    expect(planListReturn(null)).toBe('fresh')
  })

  it('records changes while away and keeps the cache when nothing changed', () => {
    const rt = fakeRealtime()
    const leave = standbyListAway(rt.adapter, 'cbv:w', ['w'])
    leave()
    const quiet = peekListAway('cbv:w')
    expect(quiet?.complete).toBe(true)
    expect(planListReturn(quiet)).toBe('keep')
    rt.send({ collection: 'w', item: '7', action: 'update', changed_fields: ['name'] })
    rt.send({ collection: 'other', item: '8', action: 'update' })
    const log = takeListAway('cbv:w')
    expect(log?.events).toEqual([
      { collection: 'w', item: '7', action: 'update', changed_fields: ['name'], own: false }
    ])
    expect(planListReturn(log)).toBe('replay')
    // Taken: the subscription is gone and a second take finds nothing.
    expect(rt.count()).toBe(0)
    expect(takeListAway('cbv:w')).toBeNull()
  })

  it('marks the viewer’s own save on the record page as own', () => {
    const rt = fakeRealtime()
    standbyListAway(rt.adapter, 'cbv:w', ['w'])()
    noteOwnWrite('w', '7', undefined, ['name'])
    rt.send({ collection: 'w', item: '7', action: 'update', changed_fields: ['name'] })
    expect(takeListAway('cbv:w')?.events[0].own).toBe(true)
  })

  it('expands a coalesced burst and gives up on a bulk write', () => {
    const rt = fakeRealtime()
    standbyListAway(rt.adapter, 'cbv:w', ['w'])()
    rt.send({ collection: 'w', item: null, action: 'update', coalesced: true, items: ['1', '2'] })
    expect(peekListAway('cbv:w')?.events.map((e) => e.item)).toEqual(['1', '2'])
    rt.send({ collection: 'w', item: null, coalesced: true, many: true, count: 900 })
    const log = takeListAway('cbv:w')
    expect(log?.complete).toBe(false)
    expect(log?.reason).toBe('bulk')
    expect(planListReturn(log)).toBe('refetch')
  })

  it('gives up past the event cap or too many rows to re-read one by one', () => {
    const rt = fakeRealtime()
    standbyListAway(rt.adapter, 'cbv:w', ['w'])()
    for (let i = 0; i < 41; i++) rt.send({ collection: 'w', item: String(i), action: 'update' })
    expect(planListReturn(peekListAway('cbv:w'))).toBe('refetch')
    expect(planListReturn(peekListAway('cbv:w'), { maxRows: 100 })).toBe('replay')
    for (let i = 0; i < AWAY_MAX_EVENTS; i++)
      rt.send({ collection: 'w', item: '1', action: 'update' })
    expect(peekListAway('cbv:w')?.reason).toBe('overflow')
  })

  it('a reconnect that replayed stays whole; one that could not is a re-read', () => {
    const rt = fakeRealtime()
    standbyListAway(rt.adapter, 'cbv:w', ['w'])()
    rt.status({ state: 'reconnecting', transport: null })
    rt.status({ state: 'live', transport: 'websocket', resumed: 'replayed' })
    expect(peekListAway('cbv:w')?.complete).toBe(true)
    rt.status({ state: 'reconnecting', transport: null })
    rt.status({ state: 'live', transport: 'websocket', resumed: 'unverified' })
    expect(peekListAway('cbv:w')?.reason).toBe('reconnect')
  })

  it('a catch-up the journal could not cover is a re-read', () => {
    const rt = fakeRealtime()
    standbyListAway(rt.adapter, 'cbv:w', ['w'])()
    window.dispatchEvent(new Event('nvr:catchup-full'))
    expect(planListReturn(takeListAway('cbv:w'))).toBe('refetch')
  })

  it('stops listening after the away window', () => {
    vi.useFakeTimers()
    const rt = fakeRealtime()
    standbyListAway(rt.adapter, 'cbv:w', ['w'])()
    vi.advanceTimersByTime(AWAY_MAX_MS + 1)
    expect(rt.count()).toBe(0)
    const log = takeListAway('cbv:w')
    expect(log?.complete).toBe(false)
    expect(planListReturn(log)).toBe('refetch')
  })

  it('a second mount of the same list replaces the first watch', () => {
    const rt = fakeRealtime()
    const leaveA = standbyListAway(rt.adapter, 'cbv:w', ['w'])
    leaveA()
    expect(takeListAway('cbv:w')).not.toBeNull()
    const leaveB = standbyListAway(rt.adapter, 'cbv:w', ['w'])
    leaveB()
    expect(rt.count()).toBe(1)
  })

  it('without a realtime adapter there is no log (behaves as before)', () => {
    standbyListAway(null, 'cbv:w', ['w'])()
    expect(peekListAway('cbv:w')).toBeNull()
  })
})

describe('changedRowIds', () => {
  it('names only the rows whose values differ', () => {
    const before = [
      { id: 1, name: 'a', tags: ['x'] },
      { id: 2, name: 'b', owner: { id: 'u1' } },
      { id: 3, name: 'c' }
    ]
    const after = [
      { id: 1, name: 'a', tags: ['x'] },
      { id: 2, name: 'b', owner: { id: 'u2' } },
      { id: 3, name: 'C' },
      { id: 4, name: 'new' }
    ]
    expect(changedRowIds(before, after)).toEqual(['2', '3'])
    expect(changedRowIds(null, after)).toEqual([])
  })
})
