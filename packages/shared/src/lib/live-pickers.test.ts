import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLiveQueryBridge } from './live-queries'
import { pickerOptionsMeta } from './live-pickers'
import type { CollectionUpdateEvent, RealtimeAdapter, RealtimeStatus } from './realtime'

// Realtime idea 4 (2026-11-14): a picker's option list goes stale when someone else creates,
// changes or deletes a record of its collection — and re-reads only on the next open, so an
// OPEN dropdown never reshuffles.

/** A RealtimeAdapter stand-in: records joins/leaves, lets the test push events and status. */
function fakeRealtime() {
  const subs = new Map<string, Set<(ev: CollectionUpdateEvent) => void>>()
  const statusCbs = new Set<(s: RealtimeStatus) => void>()
  const log: string[] = []
  let status: RealtimeStatus = { state: 'live', transport: 'websocket' }
  const rt: RealtimeAdapter & {
    log: string[]
    push: (ev: CollectionUpdateEvent) => void
    setStatus: (s: RealtimeStatus) => void
    held: () => string[]
  } = {
    log,
    subscribeCollections(names, cb) {
      for (const n of names) {
        if (!subs.has(n)) subs.set(n, new Set())
        subs.get(n)?.add(cb)
        log.push(`join:${n}`)
      }
      return () => {
        for (const n of names) {
          subs.get(n)?.delete(cb)
          if (subs.get(n)?.size === 0) subs.delete(n)
          log.push(`leave:${n}`)
        }
      }
    },
    on: () => () => {},
    emit: () => {},
    status: () => status,
    onStatus(cb) {
      statusCbs.add(cb)
      return () => statusCbs.delete(cb)
    },
    push(ev) {
      for (const cb of subs.get(ev.collection) ?? []) cb(ev)
    },
    setStatus(s) {
      status = s
      for (const cb of statusCbs) cb(s)
    },
    held: () => [...subs.keys()]
  }
  return rt
}

function fakeDoc() {
  const cbs = new Set<() => void>()
  const d = {
    hidden: false,
    addEventListener: (_: string, cb: () => void) => {
      cbs.add(cb)
    },
    removeEventListener: (_: string, cb: () => void) => {
      cbs.delete(cb)
    },
    set(hidden: boolean) {
      d.hidden = hidden
      for (const cb of cbs) cb()
    }
  }
  return d
}

function fakeWin() {
  const cbs = new Map<string, Set<() => void>>()
  return {
    addEventListener: (e: string, cb: () => void) => {
      if (!cbs.has(e)) cbs.set(e, new Set())
      cbs.get(e)?.add(cb)
    },
    removeEventListener: (e: string, cb: () => void) => {
      cbs.get(e)?.delete(cb)
    },
    fire: (e: string) => {
      for (const cb of cbs.get(e) ?? []) cb()
    }
  }
}

let qc: QueryClient
let fetches: number

/** A picker's option list: enabled while `open`, like RelationCombobox / M2MCombobox. */
function picker(open: boolean) {
  const obs = new QueryObserver(qc, {
    queryKey: ['relation-opts', 'vendors', ''],
    queryFn: async () => {
      fetches++
      return Array.from({ length: fetches }, (_, i) => ({ id: i }))
    },
    enabled: open,
    staleTime: 30_000,
    meta: pickerOptionsMeta('vendors')
  })
  const off = obs.subscribe(() => {})
  return { obs, off, setOpen: (o: boolean) => obs.setOptions({ ...obs.options, enabled: o }) }
}

const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms)
const opts = () => ({ doc: fakeDoc(), win: fakeWin(), isOwn: () => false, random: () => 0 })
const create = { collection: 'vendors', item: '9', action: 'create' as const }

beforeEach(() => {
  vi.useFakeTimers()
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  fetches = 0
})
afterEach(() => {
  qc.clear()
  vi.useRealTimers()
})

describe('picker option lists (live-pickers.ts)', () => {
  it('a picker nobody opened listens to nothing', async () => {
    const rt = fakeRealtime()
    const bridge = createLiveQueryBridge(qc, rt, opts())
    const p = picker(false)
    await settle()
    expect(rt.held()).toEqual([])
    p.off()
    bridge.dispose()
  })

  it('an OPEN dropdown is marked stale, not re-read; the next open reads the new record', async () => {
    const rt = fakeRealtime()
    const bridge = createLiveQueryBridge(qc, rt, opts())
    const p = picker(true)
    await settle()
    expect(fetches).toBe(1)
    expect(rt.held()).toEqual(['vendors'])
    rt.push(create)
    await settle(400)
    // Still open: the list on screen does not move.
    expect(fetches).toBe(1)
    expect(p.obs.getCurrentResult().data).toHaveLength(1)
    expect(qc.getQueryState(['relation-opts', 'vendors', ''])?.isInvalidated).toBe(true)
    // Close, reopen: one fresh read (as the viewer, through the picker's own request).
    p.setOpen(false)
    await settle()
    p.setOpen(true)
    await settle()
    expect(fetches).toBe(2)
    expect(p.obs.getCurrentResult().data).toHaveLength(2)
    p.off()
    bridge.dispose()
  })

  it('a closed picker that already loaded goes stale and re-reads on open, inside its staleTime', async () => {
    const rt = fakeRealtime()
    const bridge = createLiveQueryBridge(qc, rt, opts())
    const p = picker(true)
    await settle()
    p.setOpen(false)
    await settle()
    // Without an event the 30 s staleTime holds: reopening reuses the list.
    p.setOpen(true)
    await settle()
    expect(fetches).toBe(1)
    p.setOpen(false)
    rt.push({ collection: 'vendors', item: '3', changed_fields: ['name'] })
    await settle(400)
    expect(fetches).toBe(1)
    p.setOpen(true)
    await settle()
    expect(fetches).toBe(2)
    p.off()
    bridge.dispose()
  })

  it('aspect notices ($related, $comments) never touch option lists', async () => {
    const rt = fakeRealtime()
    const bridge = createLiveQueryBridge(qc, rt, opts())
    const p = picker(true)
    await settle()
    rt.push({ collection: 'vendors', item: '3', changed_fields: ['$related'] })
    await settle(400)
    expect(qc.getQueryState(['relation-opts', 'vendors', ''])?.isInvalidated).toBe(false)
    p.off()
    bridge.dispose()
  })

  it('a reconcile marks option lists stale without re-reading an open one', async () => {
    const rt = fakeRealtime()
    const bridge = createLiveQueryBridge(qc, rt, opts())
    const p = picker(true)
    await settle()
    bridge.reconcile('test')
    await settle()
    expect(fetches).toBe(1)
    expect(qc.getQueryState(['relation-opts', 'vendors', ''])?.isInvalidated).toBe(true)
    p.off()
    bridge.dispose()
  })
})
