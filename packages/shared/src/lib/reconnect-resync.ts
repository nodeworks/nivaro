import { useEffect, useRef } from 'react'
import { getLiveMode } from './live-preference'
import { type RealtimeAdapter, type RealtimeStatus, useOptionalRealtime } from './realtime'

/**
 * Re-read what a reconnect could not replay (realtime fixes 2026-11-19, area B).
 *
 * Only `collection:update` (and the related-record announce) is journaled, so only those come
 * back in a reconnect's catch-up. Person-room notices (`notification:new`, `read:changed`),
 * ops pokes (`ops:changed` — My Work, Support, Approvals, Tasks, Issues…), `owners:changed`
 * and `chat:message` are sent once and are gone for a socket that was down. So after EVERY
 * reconnect — whatever `resumed` says — and after the machine wakes from sleep, each surface
 * that follows those notices re-reads once through its own route:
 *
 * - one burst per adapter: triggers inside the cooldown fold into one;
 * - a random delay (default up to 2.5 s) spreads a deploy's thousand reconnects;
 * - a hidden tab owes the burst and runs it when it is shown again;
 * - the person's "Live updates: Off" setting skips it (their ↻ is the refresh).
 *
 * `useLiveOps` pokes every held topic once, and the live-query bridge re-reads the active
 * queries named in `LIVE_RESYNC_HEADS` (bell, chat, owners, My Work). A host listens with
 * `onResync(adapter, cb)` / `useResync(cb)`, or the window event `nvr:resync`.
 */

export const RESYNC_WINDOW_EVENT = 'nvr:resync'

export type ResyncReason = 'reconnect' | 'wake'

export interface ResyncDetectorOptions {
  /** Random spread before the burst (default 2500 ms). */
  jitterMs?: number
  /** Triggers this soon after a burst fold into one more burst at its end (default 5000 ms). */
  cooldownMs?: number
  /** Wake check: a timer tick this late means the machine slept (default 150 s; hidden tabs'
   *  timers are throttled to about one a minute, so this stays well above that). */
  wakeGapMs?: number
  /** How often the wake check ticks (default 15 s; 0 = no wake check). */
  wakeTickMs?: number
  doc?: Document | null
  win?: Window | null
  now?: () => number
  random?: () => number
  /** Whether a burst may run at all (default: the person's live mode is not Off). */
  allowed?: () => boolean
}

export interface ResyncDetector {
  subscribe(cb: (reason: ResyncReason) => void): () => void
  /** Ask for a burst (tests, or a host that knows better). */
  trigger(reason: ResyncReason): void
  listeners(): number
  dispose(): void
}

export function createResyncDetector(
  realtime: Pick<RealtimeAdapter, 'status' | 'onStatus'> | null,
  opts: ResyncDetectorOptions = {}
): ResyncDetector {
  const jitterMs = Math.max(0, opts.jitterMs ?? 2500)
  const cooldownMs = Math.max(0, opts.cooldownMs ?? 5000)
  const wakeGapMs = opts.wakeGapMs ?? 150_000
  const wakeTickMs = opts.wakeTickMs ?? 15_000
  const now = opts.now ?? (() => Date.now())
  const random = opts.random ?? Math.random
  const doc =
    opts.doc === undefined ? (typeof document === 'undefined' ? null : document) : opts.doc
  const win = opts.win === undefined ? (typeof window === 'undefined' ? null : window) : opts.win
  const allowed = opts.allowed ?? (() => getLiveMode() !== 'off')
  const cbs = new Set<(reason: ResyncReason) => void>()
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let owed: ResyncReason | null = null
  let lastBurst = Number.NEGATIVE_INFINITY
  let pendingReason: ResyncReason | null = null

  const hidden = () => !!doc && doc.visibilityState === 'hidden'

  const run = (reason: ResyncReason) => {
    if (disposed) return
    if (hidden()) {
      owed = owed ?? reason
      return
    }
    owed = null
    if (!allowed()) return
    lastBurst = now()
    for (const cb of [...cbs]) {
      try {
        cb(reason)
      } catch {
        // one surface failing must not stop the others
      }
    }
    try {
      win?.dispatchEvent(new CustomEvent(RESYNC_WINDOW_EVENT, { detail: { reason } }))
    } catch {
      // no CustomEvent (old test env)
    }
  }

  const trigger = (reason: ResyncReason) => {
    if (disposed) return
    if (timer) {
      // A burst is already on its way: it covers this one too.
      if (reason === 'reconnect') pendingReason = 'reconnect'
      return
    }
    pendingReason = reason
    const sinceLast = now() - lastBurst
    const wait = Math.max(0, cooldownMs - sinceLast) + Math.floor(random() * Math.max(0, jitterMs))
    timer = setTimeout(() => {
      timer = null
      const r = pendingReason ?? reason
      pendingReason = null
      run(r)
    }, wait)
  }

  // Reconnect edge: reconnecting → live. `resumed: null` is a first connection (nothing missed).
  let wasLive = realtime?.status?.().state !== 'reconnecting'
  const offStatus = realtime?.onStatus?.((s: RealtimeStatus) => {
    const live = s.state === 'live'
    if (live && !wasLive && s.resumed !== null) trigger('reconnect')
    wasLive = live
  })

  // Wake: a tick that comes far too late means the machine slept (the socket may not even
  // have noticed yet; its own reconnect, if any, folds into this burst or runs one more).
  let lastTick = now()
  const tick =
    wakeTickMs > 0
      ? setInterval(() => {
          const t = now()
          if (t - lastTick > wakeGapMs) trigger('wake')
          lastTick = t
        }, wakeTickMs)
      : null

  const onVisibility = () => {
    if (!hidden() && owed && !timer) run(owed)
  }
  doc?.addEventListener('visibilitychange', onVisibility)

  return {
    subscribe(cb) {
      cbs.add(cb)
      return () => {
        cbs.delete(cb)
      }
    },
    trigger,
    listeners: () => cbs.size,
    dispose() {
      if (disposed) return
      disposed = true
      offStatus?.()
      if (tick) clearInterval(tick)
      if (timer) clearTimeout(timer)
      timer = null
      doc?.removeEventListener('visibilitychange', onVisibility)
      cbs.clear()
    }
  }
}

/** One detector per adapter, alive while anything listens. */
const detectors = new WeakMap<object, ResyncDetector>()

/** Listen for the adapter's resync bursts. Returns unsubscribe. */
export function onResync(
  realtime: RealtimeAdapter,
  cb: (reason: ResyncReason) => void
): () => void {
  // useOptionalRealtime hands out one stable wrapper per host adapter (withLiveSeenTap), so
  // every caller of one host shares this detector.
  let d = detectors.get(realtime)
  if (!d) {
    d = createResyncDetector(realtime)
    detectors.set(realtime, d)
  }
  const held = d
  const off = held.subscribe(cb)
  return () => {
    off()
    if (held.listeners() === 0) {
      held.dispose()
      if (detectors.get(realtime) === held) detectors.delete(realtime)
    }
  }
}

/** React form of `onResync`; `cb` may change between renders. */
export function useResync(
  cb: (reason: ResyncReason) => void,
  opts: { enabled?: boolean } = {}
): void {
  const realtime = useOptionalRealtime()
  const ref = useRef(cb)
  ref.current = cb
  const enabled = opts.enabled !== false
  useEffect(() => {
    if (!realtime || !enabled) return
    return onResync(realtime, (r) => ref.current(r))
  }, [realtime, enabled])
}
