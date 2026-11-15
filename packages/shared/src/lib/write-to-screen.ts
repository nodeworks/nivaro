import type { Query, QueryCacheNotifyEvent, QueryClient } from '@tanstack/react-query'
import { getLiveMode, type LiveMode } from './live-preference'
import { isOwnWrite } from './own-writes'
import { screenRefreshClient } from './screen-refresh'
import { serverNow } from './server-clock'

/**
 * Write-to-screen time (realtime round 5, item 25): how long a change saved by someone else
 * takes to show on THIS tab's screen.
 *
 * Rides the delivery acknowledgements (#2477): a small sample of live events carries `_st`, the
 * server time the event left right after the write committed. When such a `collection:update`
 * reaches a screen (the shared realtime tap and the admin adapter call
 * `noteWriteToScreenEvent`), this tab notes the arrival, then watches the app's react-query
 * cache: the reads the event sets off (a list's coalesced refetch, the record's re-read) must
 * start within START_WINDOW_MS and settle, then two painted frames later the change is on
 * screen. That moment and the arrival go to the server on the server clock, in a batched
 * telemetry beacon (POST /api/rum/screen-timing) — sequence, stamp, times, screen pattern and
 * collection only, never values or record ids.
 *
 * Quiet by design: one measurement at a time, only while the tab is visible, only in Live
 * updates "Normal" (Calm holds list order on purpose and Off shows nothing live — both would
 * measure the setting, not the app), never for this tab's own write, and nothing at all until
 * the host's RUM starts it.
 */

export const START_WINDOW_MS = 2500
export const MAX_MEASURE_MS = 20_000
export const MIN_GAP_MS = 2000
export const FLUSH_AT = 5
export const FLUSH_EVERY_MS = 30_000

export interface W2SSample {
  seq: number
  st: number
  rx: number
  done: number
  screen: string
  collection: string
}

export interface W2SDeps {
  now: () => number
  serverNow: () => number
  client: () => QueryClient | null
  visible: () => boolean
  liveMode: () => LiveMode
  frame: (cb: () => void) => void
  setTimer: (cb: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
  screen: () => string
  send: (samples: W2SSample[]) => void
}

interface Measuring {
  seq: number
  st: number
  rx: number
  t0: number
  collection: string
  screen: string
  tracked: Set<Query>
  settleGen: number
  unsub: () => void
  startTimer: unknown
  capTimer: unknown
}

export interface W2SSampler {
  note(ev: unknown): boolean
  flush(): void
  pending(): number
  measuring(): boolean
  stop(): void
}

/** The ids a stamped event names this tab's own write (then this tab is not "another" tab). */
function ownWrite(ev: Record<string, unknown>, collection: string): boolean {
  const fields = Array.isArray(ev.changed_fields) ? (ev.changed_fields as string[]) : null
  const ids = Array.isArray(ev.items) ? (ev.items as Array<string | number>) : [ev.item]
  return ids.some(
    (id) =>
      id != null && id !== '*' && isOwnWrite(collection, id as string | number, fields ?? undefined)
  )
}

export function createWriteToScreenSampler(deps: W2SDeps): W2SSampler {
  const queue: W2SSample[] = []
  const seen = new Set<number>()
  let current: Measuring | null = null
  let lastStartAt = Number.NEGATIVE_INFINITY
  let flushTimer: unknown = null

  const flush = () => {
    if (flushTimer != null) deps.clearTimer(flushTimer)
    flushTimer = null
    if (queue.length === 0) return
    deps.send(queue.splice(0, queue.length))
  }
  const enqueue = (s: W2SSample) => {
    queue.push(s)
    if (queue.length >= FLUSH_AT) flush()
    else if (flushTimer == null) flushTimer = deps.setTimer(flush, FLUSH_EVERY_MS)
  }

  const end = () => {
    const m = current
    if (!m) return
    current = null
    m.unsub()
    deps.clearTimer(m.startTimer)
    deps.clearTimer(m.capTimer)
  }

  const relevant = (m: Measuring): Query[] => {
    const all = [...m.tracked]
    const needle = JSON.stringify(m.collection)
    const named = all.filter((q) => {
      try {
        return JSON.stringify(q.queryKey).includes(needle)
      } catch {
        return false
      }
    })
    return named.length > 0 ? named : all
  }

  const settled = (m: Measuring) =>
    m.tracked.size > 0 && relevant(m).every((q) => q.state.fetchStatus === 'idle')

  const checkSettle = (m: Measuring) => {
    if (current !== m || !settled(m)) return
    const gen = ++m.settleGen
    // Two frames: the first runs before the next paint, the second after it.
    deps.frame(() =>
      deps.frame(() => {
        if (current !== m || m.settleGen !== gen || !settled(m)) return
        if (!deps.visible()) return end()
        const done = deps.serverNow()
        end()
        enqueue({
          seq: m.seq,
          st: m.st,
          rx: m.rx,
          done,
          screen: m.screen,
          collection: m.collection
        })
      })
    )
  }

  const note = (raw: unknown): boolean => {
    if (!raw || typeof raw !== 'object') return false
    const ev = raw as Record<string, unknown>
    const seq = ev._seq
    const st = ev._st
    const collection = ev.collection
    if (typeof seq !== 'number' || typeof st !== 'number' || typeof collection !== 'string')
      return false
    if (seen.has(seq)) return false
    seen.add(seq)
    if (seen.size > 200) seen.delete(seen.values().next().value as number)
    if (current || deps.liveMode() !== 'normal' || !deps.visible()) return false
    const t0 = deps.now()
    if (t0 - lastStartAt < MIN_GAP_MS) return false
    if (ownWrite(ev, collection)) return false
    const qc = deps.client()
    if (!qc) return false
    lastStartAt = t0
    const m: Measuring = {
      seq,
      st,
      rx: deps.serverNow(),
      t0,
      collection,
      screen: deps.screen(),
      tracked: new Set(),
      settleGen: 0,
      unsub: () => {},
      startTimer: null,
      capTimer: null
    }
    current = m
    m.unsub = qc.getQueryCache().subscribe((e: QueryCacheNotifyEvent) => {
      if (current !== m || e.type !== 'updated') return
      const action = (e as { action?: { type?: string } }).action?.type
      if (action === 'fetch' && deps.now() - m.t0 <= START_WINDOW_MS) {
        m.tracked.add(e.query)
        m.settleGen++
        return
      }
      if (m.tracked.has(e.query)) checkSettle(m)
    })
    // Nothing on this screen re-read for it: the event changed nothing shown here.
    m.startTimer = deps.setTimer(() => {
      if (current === m && m.tracked.size === 0) end()
    }, START_WINDOW_MS)
    m.capTimer = deps.setTimer(() => {
      if (current === m) end()
    }, MAX_MEASURE_MS)
    return true
  }

  return {
    note,
    flush,
    pending: () => queue.length,
    measuring: () => current != null,
    stop: () => {
      end()
      flush()
    }
  }
}

// ─── The app's one sampler ──────────────────────────────────────────────────────

let sampler: W2SSampler | null = null

/** Started once by the host's RUM (lib/rum.ts startRum); a no-op before that. */
export function startWriteToScreen(opts: {
  screen: () => string
  send: (samples: W2SSample[]) => void
}): void {
  if (sampler || typeof window === 'undefined' || typeof document === 'undefined') return
  sampler = createWriteToScreenSampler({
    now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    serverNow,
    client: screenRefreshClient,
    visible: () => document.visibilityState !== 'hidden',
    liveMode: getLiveMode,
    frame: (cb) => requestAnimationFrame(() => cb()),
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (t) => {
      if (t != null) clearTimeout(t as ReturnType<typeof setTimeout>)
    },
    screen: opts.screen,
    send: opts.send
  })
  const s = sampler
  window.addEventListener('pagehide', () => s.flush())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') s.flush()
  })
}

/** Every adapter calls this for a `collection:update` a screen receives (cheap; deduped). */
export function noteWriteToScreenEvent(ev: unknown): void {
  try {
    sampler?.note(ev)
  } catch {
    /* telemetry never breaks a live update */
  }
}

export function __resetWriteToScreenForTests(): void {
  sampler?.stop()
  sampler = null
}
