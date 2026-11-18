import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Realtime gaps 2026-11-17 (B4 presence): the record tab's away signal (P1), people-not-sockets
 * viewer lists, and chat typing as a TTL'd socket signal (P2/P10).
 */

const dom = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>()
  const target = {
    addEventListener: (ev: string, fn: () => void) => {
      const set = listeners.get(ev) ?? new Set()
      set.add(fn)
      listeners.set(ev, set)
    },
    removeEventListener: (ev: string, fn: () => void) => listeners.get(ev)?.delete(fn)
  }
  const doc = {
    ...target,
    visibilityState: 'visible' as 'visible' | 'hidden',
    documentElement: { setAttribute: () => {}, removeAttribute: () => {} }
  }
  ;(globalThis as Record<string, unknown>).document = doc
  ;(globalThis as Record<string, unknown>).window = target
  return {
    doc,
    fire: (ev: string) => {
      for (const fn of listeners.get(ev) ?? []) fn()
    }
  }
})

import { applyTypingEvent, TYPING_TTL_MS, typingSentence } from '../components/chat/chat-typing'
import {
  __resetRecordTabAway,
  distinctOtherViewers,
  onRecordTabAway,
  recordTabAway,
  recordVisibilityPayload,
  rowPresenceUpdates
} from './presence-hooks'

afterEach(() => {
  dom.doc.visibilityState = 'visible'
  dom.fire('visibilitychange')
  __resetRecordTabAway()
})

describe('record tab away (P1)', () => {
  it('reports hidden with how long, and visible again, to every subscriber', () => {
    const seen: boolean[] = []
    const off = onRecordTabAway((away) => seen.push(away))
    expect(recordTabAway()).toBe(false)
    expect(recordVisibilityPayload('orders', 7)).toEqual({
      collection: 'orders',
      item: '7',
      hidden: false
    })
    dom.doc.visibilityState = 'hidden'
    dom.fire('visibilitychange')
    expect(seen).toEqual([true])
    expect(recordTabAway()).toBe(true)
    const p = recordVisibilityPayload('orders', '7', Date.now() + 4_000)
    expect(p).toMatchObject({ collection: 'orders', item: '7', hidden: true })
    expect(p.hidden_ms).toBeGreaterThanOrEqual(4_000)
    // A second hidden event is no change.
    dom.fire('visibilitychange')
    expect(seen).toEqual([true])
    dom.doc.visibilityState = 'visible'
    dom.fire('visibilitychange')
    expect(seen).toEqual([true, false])
    off()
    dom.doc.visibilityState = 'hidden'
    dom.fire('visibilitychange')
    expect(seen).toEqual([true, false])
  })
})

describe('viewer strips count people, not sockets', () => {
  it("one face per person, case-insensitive, never the viewer's own", () => {
    expect(
      distinctOtherViewers(
        [
          { id: 'ab', name: 'Ann' },
          { id: 'AB', name: 'Ann' },
          { id: 'me', name: 'Me' },
          { id: 'cd', name: 'Cy' }
        ],
        'ME'
      )
    ).toEqual([
      { id: 'ab', name: 'Ann' },
      { id: 'cd', name: 'Cy' }
    ])
    expect(distinctOtherViewers(null, 'x')).toEqual([])
  })
})

describe('chat typing over the socket (P2 / P10)', () => {
  it('adds on start, drops on stop, ignores other rooms and the viewer', () => {
    const now = 1_000
    let peers = applyTypingEvent(
      new Map(),
      { room: 'dm:A:B', state: 'start', user: { id: 'b', name: 'Bo' } },
      'dm:A:B',
      'a',
      now
    )
    expect(peers && typingSentence(peers, now)).toBe('Bo is typing…')
    expect(
      applyTypingEvent(peers!, { room: 'other', state: 'start', user: { id: 'c' } }, 'dm:A:B', 'a')
    ).toBeNull()
    expect(
      applyTypingEvent(peers!, { room: 'dm:A:B', state: 'start', user: { id: 'A' } }, 'dm:A:B', 'a')
    ).toBeNull()
    peers = applyTypingEvent(
      peers!,
      { room: 'dm:A:B', state: 'stop', user: { id: 'B' } },
      'dm:A:B',
      'a',
      now
    )
    expect(peers && typingSentence(peers, now)).toBeNull()
  })

  it("a name lapses on its own when its tab stops sending (a dead tab doesn't stick)", () => {
    const now = 5_000
    const peers = applyTypingEvent(
      new Map(),
      { room: 'g', state: 'start', user: { id: 'b', name: 'Bo' } },
      'g',
      null,
      now
    )!
    expect(typingSentence(peers, now + TYPING_TTL_MS - 1)).toBe('Bo is typing…')
    expect(typingSentence(peers, now + TYPING_TTL_MS)).toBeNull()
  })
})

describe('presence:rows — a change names one row, a watch answer every row', () => {
  it('reads both shapes; an empty list clears', () => {
    expect(rowPresenceUpdates({ collection: 'orders', item: 7, user_ids: ['a'] })).toEqual([
      ['orders:7', ['a']]
    ])
    expect(
      rowPresenceUpdates({ collection: 'orders', rows: { '7': ['a', 'b'], '8': [] } })
    ).toEqual([
      ['orders:7', ['a', 'b']],
      ['orders:8', []]
    ])
    expect(rowPresenceUpdates({ collection: 'orders' })).toEqual([])
    expect(rowPresenceUpdates(null)).toEqual([])
  })
})
