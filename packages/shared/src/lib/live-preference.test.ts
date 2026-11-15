import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetLivePreferenceForTests,
  getLiveMode,
  liveCollectionEventPasses,
  liveEventQuiet,
  liveMotionAllowed,
  livePausedAt,
  livePreferenceOf,
  parseLiveMode,
  resolveLiveMode,
  setLiveMode,
  subscribeLiveMode
} from './live-preference'
import { clearOwnWrites, noteOwnWrite } from './own-writes'
import { type RealtimeAdapter, withLiveSeenTap } from './realtime'

afterEach(() => {
  __resetLivePreferenceForTests()
  clearOwnWrites()
})

describe('resolveLiveMode', () => {
  it('own choice wins over the role default', () => {
    expect(resolveLiveMode('off', 'calm')).toEqual({ mode: 'off', source: 'own' })
  })
  it('falls back to the role default, then normal', () => {
    expect(resolveLiveMode(null, 'calm')).toEqual({ mode: 'calm', source: 'role' })
    expect(resolveLiveMode(undefined, null)).toEqual({ mode: 'normal', source: 'default' })
  })
  it('ignores junk', () => {
    expect(parseLiveMode('loud')).toBeNull()
    expect(resolveLiveMode('loud', 'nope')).toEqual({ mode: 'normal', source: 'default' })
  })
})

describe('liveEventQuiet', () => {
  it('normal quiets nothing', () => {
    expect(liveEventQuiet('record:viewers', 'normal')).toBe(false)
    expect(liveEventQuiet('record:comment', 'normal')).toBe(false)
  })
  it('calm quiets presence and typing only', () => {
    expect(liveEventQuiet('record:viewers', 'calm')).toBe(true)
    expect(liveEventQuiet('record:signal', 'calm')).toBe(true)
    expect(liveEventQuiet('field:editing', 'calm')).toBe(true)
    expect(liveEventQuiet('presence:rows', 'calm')).toBe(true)
    expect(liveEventQuiet('record:comment', 'calm')).toBe(false)
    expect(liveEventQuiet('widget:data', 'calm')).toBe(false)
  })
  it('off also quiets data notices but never sync, notifications or locks', () => {
    expect(liveEventQuiet('record:comment', 'off')).toBe(true)
    expect(liveEventQuiet('widget:data', 'off')).toBe(true)
    expect(liveEventQuiet('record:viewers', 'off')).toBe(true)
    for (const ev of [
      'prefs:changed',
      'access:changed',
      'read:changed',
      'notification:new',
      'lock:requested',
      'job:progress',
      'force-refresh'
    ])
      expect(liveEventQuiet(ev, 'off')).toBe(false)
  })
})

describe('liveCollectionEventPasses', () => {
  it('everything passes outside Off', () => {
    expect(liveCollectionEventPasses({ collection: 'orders', item: 1 }, 'calm')).toBe(true)
  })
  it('Off drops others writes and keeps this tab own', () => {
    noteOwnWrite('orders', 7, 6000, ['status'])
    expect(
      liveCollectionEventPasses(
        { collection: 'orders', item: 7, changed_fields: ['status'] },
        'off'
      )
    ).toBe(true)
    expect(
      liveCollectionEventPasses(
        { collection: 'orders', item: 8, changed_fields: ['status'] },
        'off'
      )
    ).toBe(false)
    expect(liveCollectionEventPasses({ collection: 'orders', item: '*' }, 'off')).toBe(false)
  })
  it('Off keeps a coalesced burst that lists an own write', () => {
    noteOwnWrite('orders', 3)
    expect(liveCollectionEventPasses({ collection: 'orders', items: [2, 3] }, 'off')).toBe(true)
    expect(liveCollectionEventPasses({ collection: 'orders', items: [4, 5] }, 'off')).toBe(false)
  })
})

describe('the store', () => {
  it('starts normal, notifies on change, and motion follows it', () => {
    expect(getLiveMode()).toBe('normal')
    const seen = vi.fn()
    const off = subscribeLiveMode(seen)
    setLiveMode('calm')
    expect(getLiveMode()).toBe('calm')
    expect(seen).toHaveBeenCalledTimes(1)
    expect(liveMotionAllowed()).toBe(false)
    setLiveMode('calm')
    expect(seen).toHaveBeenCalledTimes(1)
    off()
    __resetLivePreferenceForTests()
    expect(livePreferenceOf({ mode: 'off', source: 'role' })).toMatchObject({
      off: true,
      quiet: true,
      normal: false
    })
  })
  it('paused means still for the whole window', () => {
    expect(livePausedAt(10_000, 8_000, 3000)).toBe(false)
    expect(livePausedAt(11_000, 8_000, 3000)).toBe(true)
  })
})

describe('the transport tap honours the setting', () => {
  function fakeAdapter() {
    const coll: Array<(ev: any) => void> = []
    const named = new Map<string, Array<(p: any) => void>>()
    const adapter: RealtimeAdapter = {
      subscribeCollections: (_c, cb) => {
        coll.push(cb)
        return () => {}
      },
      on: (event, cb) => {
        named.set(event, [...(named.get(event) ?? []), cb])
        return () => {}
      },
      emit: () => {}
    }
    return {
      adapter,
      fireCollection: (ev: any) => {
        for (const cb of coll) cb(ev)
      },
      fire: (event: string, p: any) => {
        for (const cb of named.get(event) ?? []) cb(p)
      }
    }
  }

  it('Off stops others writes and data notices, Calm only presence', () => {
    const f = fakeAdapter()
    const tapped = withLiveSeenTap(f.adapter)
    const rows = vi.fn()
    const viewers = vi.fn()
    const comments = vi.fn()
    const prefs = vi.fn()
    tapped.subscribeCollections(['orders'], rows)
    tapped.on('record:viewers', viewers)
    tapped.on('record:comment', comments)
    tapped.on('prefs:changed', prefs)

    f.fireCollection({ collection: 'orders', item: 1 })
    f.fire('record:viewers', { viewers: [] })
    expect(rows).toHaveBeenCalledTimes(1)
    expect(viewers).toHaveBeenCalledTimes(1)

    setLiveMode('calm')
    f.fireCollection({ collection: 'orders', item: 1 })
    f.fire('record:viewers', { viewers: [] })
    f.fire('record:comment', {})
    expect(rows).toHaveBeenCalledTimes(2)
    expect(viewers).toHaveBeenCalledTimes(1)
    expect(comments).toHaveBeenCalledTimes(1)

    setLiveMode('off')
    f.fireCollection({ collection: 'orders', item: 1 })
    f.fire('record:comment', {})
    f.fire('prefs:changed', { keys: ['live_mode'] })
    expect(rows).toHaveBeenCalledTimes(2)
    expect(comments).toHaveBeenCalledTimes(1)
    expect(prefs).toHaveBeenCalledTimes(1)

    noteOwnWrite('orders', 1)
    f.fireCollection({ collection: 'orders', item: 1 })
    expect(rows).toHaveBeenCalledTimes(3)
  })
})
