import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECORD_QUERY_HEADS } from '../components/item-edit/RecordLiveSync'
import {
  createLiveQueryBridge,
  LIVE_RECONCILE_HEADS,
  type LiveQueryMeta,
  liveEventsMatch,
  liveQueryMeta,
  liveRefetchInterval
} from './live-queries'
import type { CollectionUpdateEvent, RealtimeAdapter, RealtimeStatus } from './realtime'

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
let calls: Record<string, number>
const unsubs: Array<() => void> = []

/** An ACTIVE query (one observer) whose fetches are counted under `name`. */
function watch(name: string, meta?: LiveQueryMeta, queryKey: unknown[] = [name]) {
  calls[name] = 0
  const obs = new QueryObserver(qc, {
    queryKey,
    queryFn: async () => {
      calls[name] = (calls[name] ?? 0) + 1
      return calls[name]
    },
    staleTime: Number.POSITIVE_INFINITY,
    ...(meta ? { meta: liveQueryMeta(meta) } : {})
  })
  const off = obs.subscribe(() => {})
  unsubs.push(off)
  return off
}

/** Let microtasks (room sync, fetches) run under fake timers. */
async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  calls = {}
})

afterEach(() => {
  for (const off of unsubs.splice(0)) off()
  qc.clear()
  vi.useRealTimers()
})

const bridgeOpts = (extra = {}) => ({
  doc: fakeDoc(),
  win: fakeWin(),
  isOwn: () => false,
  random: () => 0,
  ...extra
})

describe('liveEventsMatch', () => {
  const ev = (p: Partial<CollectionUpdateEvent> & { own?: boolean }) => ({
    collection: 'orders',
    item: '1',
    own: false,
    ...p
  })
  it('a record query hears only its own id or a bulk write', () => {
    const meta = { record: { collection: 'orders', id: 7 } }
    expect(liveEventsMatch(meta, 'orders', [ev({ item: '1', changed_fields: ['x'] })])).toBe(false)
    expect(liveEventsMatch(meta, 'orders', [ev({ item: '7', changed_fields: ['x'] })])).toBe(true)
    expect(liveEventsMatch(meta, 'orders', [ev({ item: '*' })])).toBe(true)
  })
  it('skips own writes for records, keeps them for collection reads', () => {
    const own = [ev({ item: '7', changed_fields: ['x'], own: true })]
    expect(liveEventsMatch({ record: { collection: 'orders', id: '7' } }, 'orders', own)).toBe(
      false
    )
    expect(liveEventsMatch({ reads: ['orders'] }, 'orders', own)).toBe(true)
    expect(liveEventsMatch({ reads: ['orders'], includeOwn: false }, 'orders', own)).toBe(false)
  })
  it('narrows by field names, but creates, deletes and unnamed writes always count', () => {
    const meta = { reads: ['orders'], fields: ['status'] }
    expect(liveEventsMatch(meta, 'orders', [ev({ changed_fields: ['notes'] })])).toBe(false)
    expect(liveEventsMatch(meta, 'orders', [ev({ changed_fields: ['status'] })])).toBe(true)
    expect(liveEventsMatch(meta, 'orders', [ev({ action: 'create' })])).toBe(true)
    expect(
      liveEventsMatch(meta, 'orders', [ev({ action: 'delete', changed_fields: ['notes'] })])
    ).toBe(true)
    expect(liveEventsMatch(meta, 'orders', [ev({ changed_fields: [] })])).toBe(true)
  })
  it('aspect notices count only for queries that list the aspect', () => {
    const aspect = [ev({ changed_fields: ['$state'] })]
    expect(liveEventsMatch({ reads: ['orders'] }, 'orders', aspect)).toBe(false)
    expect(liveEventsMatch({ reads: ['orders'], aspects: ['$state'] }, 'orders', aspect)).toBe(true)
  })
  it('ignores other collections and reconcile-only queries', () => {
    expect(liveEventsMatch({ reads: ['orders'] }, 'invoices', [ev({})])).toBe(false)
    expect(liveEventsMatch({ reads: ['orders'], reconcileOnly: true }, 'orders', [ev({})])).toBe(
      false
    )
  })
})

describe('createLiveQueryBridge', () => {
  it('joins the rooms active tagged queries read, and leaves after the linger', async () => {
    const rt = fakeRealtime()
    const bridge = createLiveQueryBridge(qc, rt, bridgeOpts({ lingerMs: 1000 }))
    const off = watch('open-orders', { reads: ['orders'] })
    watch('plain')
    await settle()
    expect(bridge.collections()).toEqual(['orders'])
    off()
    await settle(500)
    expect(rt.held()).toEqual(['orders'])
    await settle(600)
    expect(rt.held()).toEqual([])
    bridge.dispose()
  })

  it('coalesces a burst into one refetch of the matching query', async () => {
    const rt = fakeRealtime()
    const bridge = createLiveQueryBridge(qc, rt, bridgeOpts({ windowMs: 300 }))
    watch('rec', { record: { collection: 'orders', id: '5' } })
    watch('other-rec', { record: { collection: 'orders', id: '6' } })
    await settle()
    expect(calls).toEqual({ rec: 1, 'other-rec': 1 })
    for (let i = 0; i < 20; i++) rt.push({ collection: 'orders', item: '5', changed_fields: ['x'] })
    await settle(299)
    expect(calls.rec).toBe(1)
    await settle(10)
    expect(calls).toEqual({ rec: 2, 'other-rec': 1 })
    bridge.dispose()
  })

  it('expands a coalesced burst message into its ids', async () => {
    const rt = fakeRealtime()
    const bridge = createLiveQueryBridge(qc, rt, bridgeOpts())
    watch('rec', { record: { collection: 'orders', id: '9' } })
    await settle()
    rt.push({ collection: 'orders', item: null, coalesced: true, items: ['8', '9'] })
    await settle(400)
    expect(calls.rec).toBe(2)
    bridge.dispose()
  })

  it('refetches only active queries; inactive ones are marked stale', async () => {
    const rt = fakeRealtime()
    const bridge = createLiveQueryBridge(qc, rt, bridgeOpts({ readsGapMs: 0 }))
    watch('active', { reads: ['orders'] })
    const off = watch('gone', { reads: ['orders'] })
    await settle()
    off()
    rt.push({ collection: 'orders', item: '1', action: 'create' })
    await settle(400)
    expect(calls).toEqual({ active: 2, gone: 1 })
    expect(qc.getQueryState(['gone'])?.isInvalidated).toBe(true)
    bridge.dispose()
  })

  it('ignores events for collections nothing reads', async () => {
    const rt = fakeRealtime()
    const bridge = createLiveQueryBridge(qc, rt, bridgeOpts())
    watch('orders', { reads: ['orders'] })
    await settle()
    rt.push({ collection: 'invoices', item: '1', action: 'create' })
    await settle(400)
    expect(calls.orders).toBe(1)
    expect(bridge.stats().events).toBe(0)
    bridge.dispose()
  })

  it('keeps a min gap per query with a trailing refetch', async () => {
    const rt = fakeRealtime()
    const bridge = createLiveQueryBridge(qc, rt, bridgeOpts({ readsGapMs: 10_000 }))
    watch('count', { reads: ['orders'] })
    await settle()
    rt.push({ collection: 'orders', item: '1', changed_fields: ['x'] })
    await settle(400)
    expect(calls.count).toBe(2)
    rt.push({ collection: 'orders', item: '2', changed_fields: ['x'] })
    await settle(400)
    rt.push({ collection: 'orders', item: '3', changed_fields: ['x'] })
    await settle(400)
    expect(calls.count).toBe(2)
    await settle(10_000)
    expect(calls.count).toBe(3)
    bridge.dispose()
  })

  it('a hidden tab marks stale and refetches when shown', async () => {
    const rt = fakeRealtime()
    const doc = fakeDoc()
    const bridge = createLiveQueryBridge(qc, rt, bridgeOpts({ doc, readsGapMs: 0 }))
    watch('list', { reads: ['orders'] })
    await settle()
    doc.set(true)
    rt.push({ collection: 'orders', item: '1', changed_fields: ['x'] })
    await settle(400)
    expect(calls.list).toBe(1)
    doc.set(false)
    await settle()
    expect(calls.list).toBe(2)
    bridge.dispose()
  })

  it('reconciles once after a long hidden spell — tagged queries and live record heads', async () => {
    const rt = fakeRealtime()
    const doc = fakeDoc()
    const bridge = createLiveQueryBridge(qc, rt, bridgeOpts({ doc, hiddenReconcileMs: 60_000 }))
    watch('list', { reads: ['orders'] })
    watch('record-page', undefined, ['item', 'orders', '5'])
    watch('untracked')
    await settle()
    doc.set(true)
    await settle(61_000)
    doc.set(false)
    await settle()
    expect(calls).toEqual({ list: 2, 'record-page': 2, untracked: 1 })
    expect(bridge.stats().reconciles).toBe(1)
    bridge.dispose()
  })

  it('reconciles on a reconnect that could not replay, not on one that did', async () => {
    const rt = fakeRealtime()
    const bridge = createLiveQueryBridge(qc, rt, bridgeOpts())
    watch('list', { reads: ['orders'] })
    await settle()
    rt.setStatus({ state: 'reconnecting', transport: null })
    rt.setStatus({ state: 'live', transport: 'websocket', resumed: 'replayed' })
    await settle(10)
    expect(calls.list).toBe(1)
    rt.setStatus({ state: 'reconnecting', transport: null })
    rt.setStatus({ state: 'live', transport: 'websocket', resumed: 'unverified' })
    await settle(10)
    expect(calls.list).toBe(2)
    // An adapter that does not say how it resumed: reconcile.
    rt.setStatus({ state: 'reconnecting', transport: null })
    rt.setStatus({ state: 'live', transport: 'websocket' })
    await settle(10)
    expect(calls.list).toBe(3)
    bridge.dispose()
  })

  it('reconciles on nvr:catchup-full', async () => {
    const rt = fakeRealtime()
    const win = fakeWin()
    const bridge = createLiveQueryBridge(qc, rt, bridgeOpts({ win }))
    watch('list', { reads: ['orders'] })
    await settle()
    win.fire('nvr:catchup-full')
    await settle(10)
    expect(calls.list).toBe(2)
    bridge.dispose()
  })

  it('dispose leaves every room and stops listening', async () => {
    const rt = fakeRealtime()
    const bridge = createLiveQueryBridge(qc, rt, bridgeOpts())
    watch('list', { reads: ['orders', 'invoices'] })
    await settle()
    expect(rt.held().sort()).toEqual(['invoices', 'orders'])
    bridge.dispose()
    expect(rt.held()).toEqual([])
  })

  it('freshness: a write is on screen within the burst window', async () => {
    const rt = fakeRealtime()
    const bridge = createLiveQueryBridge(qc, rt, bridgeOpts({ windowMs: 300 }))
    watch('rec', { record: { collection: 'orders', id: '5' } })
    await settle()
    const t0 = Date.now()
    rt.push({ collection: 'orders', item: '5', action: 'update', changed_fields: ['total'] })
    while (calls.rec < 2) await settle(10)
    expect(Date.now() - t0).toBeLessThanOrEqual(310)
    bridge.dispose()
  })
})

describe('reconcile heads', () => {
  it('cover every record-page query head', () => {
    for (const h of RECORD_QUERY_HEADS) expect(LIVE_RECONCILE_HEADS).toContain(h)
  })
})

describe('liveRefetchInterval', () => {
  it('slows to the safety poll only while live', () => {
    expect(liveRefetchInterval(false, 60_000)).toBe(60_000)
    expect(liveRefetchInterval(true, 60_000)).toBe(300_000)
    expect(liveRefetchInterval(true, 600_000)).toBe(600_000)
    expect(liveRefetchInterval(true, false)).toBe(false)
    expect(liveRefetchInterval(true, undefined)).toBe(undefined)
  })
})
