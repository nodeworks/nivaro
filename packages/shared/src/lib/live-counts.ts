import { type QueryKey, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useLiveOps } from './live-ops'

/**
 * Counts that follow the data — quietly (realtime program 2026-11-14, ideas 9 + 19).
 *
 * A count (a tab total, a view pill, a badge) is a read the viewer's own permissions answer,
 * so a live event can only ever say "this may have moved"; the number is then re-read through
 * its normal route. What this file adds is the discipline around that re-read:
 *
 * - `createCoalescer` turns any number of pokes into ONE call: it waits until the pokes have
 *   been quiet for `quietMs` (default 2 s), but never later than `maxWaitMs` after the first
 *   poke of a burst, so a steady stream still refreshes. A hidden tab does not call; it owes
 *   one call for when it is shown again.
 * - `useLiveRefresh` hangs that on an ops topic and/or a list of query keys: one refresh per
 *   quiet window for every count that names the same keys, however many components ask.
 * - `LiveCount` shows the number and cross-fades when it changes (no bounce, no movement;
 *   reduced motion just swaps).
 */

export interface CoalescerOptions {
  /** Call once pokes have stopped for this long (default 2000). */
  quietMs?: number
  /** …but never later than this after the first poke of a burst (default 15000). */
  maxWaitMs?: number
  /** Whether the tab is on screen (default: `document.visibilityState !== 'hidden'`). */
  isVisible?: () => boolean
  now?: () => number
}

export interface Coalescer {
  /** Something moved: schedule (or push back) the call. */
  poke: () => void
  /** The tab came back to the front: make the call now if one is owed. */
  resume: () => void
  /** Drop anything scheduled. */
  cancel: () => void
  /** A call is scheduled or owed (tests). */
  pending: () => boolean
}

function tabVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

export const COUNT_QUIET_MS = 2000
export const COUNT_MAX_WAIT_MS = 15_000

export function createCoalescer(fn: () => void, opts: CoalescerOptions = {}): Coalescer {
  const quietMs = Math.max(0, opts.quietMs ?? COUNT_QUIET_MS)
  const maxWaitMs = Math.max(quietMs, opts.maxWaitMs ?? COUNT_MAX_WAIT_MS)
  const visible = opts.isVisible ?? tabVisible
  const now = opts.now ?? (() => Date.now())
  let timer: ReturnType<typeof setTimeout> | null = null
  let burstStart: number | null = null
  let owed = false

  const fire = () => {
    timer = null
    burstStart = null
    if (!visible()) {
      owed = true
      return
    }
    owed = false
    fn()
  }

  return {
    poke() {
      const t = now()
      if (burstStart === null) burstStart = t
      const due = Math.min(t + quietMs, burstStart + maxWaitMs)
      if (timer) clearTimeout(timer)
      timer = setTimeout(fire, Math.max(0, due - t))
    },
    resume() {
      if (timer || !owed || !visible()) return
      owed = false
      fn()
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      burstStart = null
      owed = false
    },
    pending: () => timer != null || owed
  }
}

export interface LiveRefreshOptions {
  /** Ops topic to listen on (`useLiveOps`); the page is only told THAT something moved. */
  topic?: string | null
  /** Query keys (prefixes) to re-read. */
  keys: ReadonlyArray<QueryKey>
  /** Quiet window before the re-read (default 2 s, never lower than 2 s). */
  quietMs?: number
  maxWaitMs?: number
  enabled?: boolean
  /** Extra poke source: call `poke` from your own live subscription. */
  onReady?: (poke: () => void) => (() => void) | undefined
}

/** Shared per QueryClient + key set + timing, so N counts naming the same keys share ONE re-read. */
const shared = new Map<string, { co: Coalescer; users: number; stopVis: () => void }>()
const clientIds = new WeakMap<object, number>()
let nextClientId = 1

export function refreshSignature(
  qcId: number,
  keys: ReadonlyArray<QueryKey>,
  quietMs: number,
  maxWaitMs?: number
) {
  return `${qcId}|${quietMs}|${maxWaitMs ?? ''}|${JSON.stringify(keys)}`
}

/**
 * Re-read `keys` through their normal routes when `topic` pokes (or `onReady`'s source does),
 * at most once per quiet window per tab. Only mounted (active) queries refetch; the rest are
 * marked stale. Without a realtime adapter nothing is poked and the queries keep their own poll.
 */
export function useLiveRefresh(opts: LiveRefreshOptions): void {
  const qc = useQueryClient()
  const enabled = opts.enabled !== false
  const quietMs = Math.max(COUNT_QUIET_MS, opts.quietMs ?? COUNT_QUIET_MS)
  const maxWaitMs = opts.maxWaitMs
  const keysJson = JSON.stringify(opts.keys)
  const pokeRef = useRef<() => void>(() => {})
  const readyRef = useRef(opts.onReady)
  readyRef.current = opts.onReady

  useEffect(() => {
    if (!enabled) return
    let id = clientIds.get(qc)
    if (id == null) {
      id = nextClientId++
      clientIds.set(qc, id)
    }
    const keys = JSON.parse(keysJson) as QueryKey[]
    const sig = refreshSignature(id, keys, quietMs, maxWaitMs)
    let entry = shared.get(sig)
    if (!entry) {
      const co = createCoalescer(
        () => {
          for (const queryKey of keys)
            void qc.invalidateQueries({ queryKey, refetchType: 'active' })
        },
        { quietMs, maxWaitMs }
      )
      const onVis = () => co.resume()
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
      entry = {
        co,
        users: 0,
        stopVis: () => {
          if (typeof document !== 'undefined')
            document.removeEventListener('visibilitychange', onVis)
        }
      }
      shared.set(sig, entry)
    }
    entry.users += 1
    const held = entry
    pokeRef.current = () => held.co.poke()
    const off = readyRef.current?.(() => held.co.poke())
    return () => {
      off?.()
      pokeRef.current = () => {}
      held.users -= 1
      if (held.users <= 0) {
        held.co.cancel()
        held.stopVis()
        shared.delete(sig)
      }
    }
  }, [qc, enabled, keysJson, quietMs, maxWaitMs])

  useLiveOps(opts.topic ?? null, () => pokeRef.current(), {
    enabled: enabled && !!opts.topic,
    // The coalescer is the real wait; the ops hook only forwards.
    debounceMs: 0
  })
}

/** Tests only: forget every shared refresher. */
export function _resetLiveRefreshForTests(): void {
  for (const e of shared.values()) {
    e.co.cancel()
    e.stopVis()
  }
  shared.clear()
}
