// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  batchTouches,
  type LiveBatch,
  type LiveEvent,
  relayLiveEvent,
  toLiveBatch,
  useLiveRecord,
  useLiveRecordEvent
} from './live'
import { isOwnWrite, noteOwnWrite, noteOwnWriteFromCommand } from './own-writes'
import { type CollectionUpdateEvent, type RealtimeAdapter, RealtimeContext } from './realtime'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ev = (e: Partial<LiveEvent>): LiveEvent => ({
  collection: 'workflows',
  item: '1',
  own: false,
  ...e
})

describe('toLiveBatch / batchTouches', () => {
  it('an aspect-only batch says the columns did not move', () => {
    const b = toLiveBatch([ev({ changed_fields: ['$state'] }), ev({ changed_fields: ['$tasks'] })])
    expect(b.aspectsOnly).toBe(true)
    expect(b.changedFields).toEqual(['$state', '$tasks'])
    expect(batchTouches(b, '$state')).toBe(true)
    expect(batchTouches(b, 'title')).toBe(false)
  })

  it('a batch without field names touches every column but no aspect-only surface', () => {
    const b = toLiveBatch([ev({ action: 'update' })])
    expect(b.changedFields).toBeNull()
    expect(b.aspectsOnly).toBe(false)
    expect(batchTouches(b, 'title')).toBe(true)
  })

  it('a column write mixed with an aspect is not aspect-only', () => {
    const b = toLiveBatch([ev({ changed_fields: ['$state'] }), ev({ changed_fields: ['status'] })])
    expect(b.aspectsOnly).toBe(false)
  })

  it('flags creates, deletes, ids and own', () => {
    const b = toLiveBatch([
      ev({ action: 'delete', item: '1', own: true }),
      ev({ action: 'create', item: '2', own: true })
    ])
    expect(b.deleted).toBe(true)
    expect(b.created).toBe(true)
    expect(b.ids).toEqual(['1', '2'])
    expect(b.own).toBe(true)
  })
})

describe('own writes', () => {
  it('notes item writes, created ids, pipeline + addendum paths and body-named records', () => {
    noteOwnWriteFromCommand('PATCH', '/items/projects/7?fields=id')
    noteOwnWriteFromCommand('POST', '/items/projects', {}, { data: { id: 99 } })
    noteOwnWriteFromCommand('POST', '/pipelines/instance/orders/3/transition')
    noteOwnWriteFromCommand('POST', '/comments', { collection: 'tickets', item: 'abc' })
    expect(isOwnWrite('projects', '7')).toBe(true)
    expect(isOwnWrite('projects', 99)).toBe(true)
    expect(isOwnWrite('orders', '3')).toBe(true)
    expect(isOwnWrite('tickets', 'abc')).toBe(true)
    expect(isOwnWrite('projects', '8')).toBe(false)
  })

  it('ignores reads and batch endpoints', () => {
    noteOwnWriteFromCommand('GET', '/items/reads/1')
    noteOwnWriteFromCommand('POST', '/items/bulkers/batch')
    expect(isOwnWrite('reads', '1')).toBe(false)
    expect(isOwnWrite('bulkers', 'batch')).toBe(false)
  })

  it('expires', () => {
    vi.useFakeTimers()
    noteOwnWrite('short', '1', 1000)
    expect(isOwnWrite('short', '1')).toBe(true)
    vi.advanceTimersByTime(1500)
    expect(isOwnWrite('short', '1')).toBe(false)
    vi.useRealTimers()
  })
})

function fakeAdapter() {
  const subs = new Set<{ names: string[]; cb: (e: CollectionUpdateEvent) => void }>()
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const rt: RealtimeAdapter = {
    subscribeCollections(names, cb) {
      const s = { names, cb }
      subs.add(s)
      return () => subs.delete(s)
    },
    on(event, cb) {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return () => set.delete(cb)
    },
    emit() {}
  }
  const push = (e: CollectionUpdateEvent) => {
    for (const s of subs) if (s.names.includes(e.collection)) s.cb(e)
  }
  const fire = (event: string, payload: unknown) => {
    for (const cb of listeners.get(event) ?? []) cb(payload)
  }
  return { rt, push, fire }
}

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('useLiveRecord', () => {
  it('debounces one record into one batch, skips other records and own writes', () => {
    const { rt, push } = fakeAdapter()
    const batches: LiveBatch[] = []
    function Probe() {
      useLiveRecord('workflows', '5', (b) => batches.push(b))
      return null
    }
    act(() =>
      root.render(createElement(RealtimeContext.Provider, { value: rt }, createElement(Probe)))
    )
    act(() => {
      push({ collection: 'workflows', item: '5', changed_fields: ['title'] })
      push({ collection: 'workflows', item: 5, changed_fields: ['$state'] })
      push({ collection: 'workflows', item: '9', changed_fields: ['title'] })
      push({ collection: 'workflows', item: '*' })
    })
    expect(batches).toHaveLength(0)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(batches).toHaveLength(1)
    expect(batches[0].events).toHaveLength(3)
    expect(batches[0].ids).toEqual(['5', '*'])
  })

  it('drops a write this tab just made', () => {
    const { rt, push } = fakeAdapter()
    const batches: LiveBatch[] = []
    function Probe() {
      useLiveRecord('workflows', '8', (b) => batches.push(b))
      return null
    }
    act(() =>
      root.render(createElement(RealtimeContext.Provider, { value: rt }, createElement(Probe)))
    )
    noteOwnWrite('workflows', '8')
    act(() => {
      push({ collection: 'workflows', item: '8', changed_fields: ['title'] })
      vi.advanceTimersByTime(300)
    })
    expect(batches).toHaveLength(0)
  })

  it('is inert without a realtime adapter', () => {
    const seen: LiveBatch[] = []
    function Probe() {
      useLiveRecord('workflows', '5', (b) => seen.push(b))
      return null
    }
    act(() => root.render(createElement(Probe)))
    expect(seen).toHaveLength(0)
  })
})

describe('useLiveRecordEvent', () => {
  it('hears the adapter and the window relay once, for its record only', () => {
    const { rt, fire } = fakeAdapter()
    const got: unknown[] = []
    function Probe() {
      useLiveRecordEvent('record:integrity', 'workflows', '5', (p) => got.push(p))
      return null
    }
    act(() =>
      root.render(createElement(RealtimeContext.Provider, { value: rt }, createElement(Probe)))
    )
    const payload = { collection: 'workflows', item: '5' }
    act(() => {
      fire('record:integrity', payload)
      relayLiveEvent('record:integrity', payload)
      fire('record:integrity', { collection: 'workflows', item: '6' })
    })
    expect(got).toEqual([payload])
  })
})
