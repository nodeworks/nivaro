import { useLiveEvent, useLiveOps } from '@nivaro/shared'
import { type QueryKey, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

/**
 * Overview sections that follow the data (realtime gaps 2026-11-17, "Also seen, minor"):
 * Needs you, Following and People waiting re-read through their own route when an ops topic
 * or a person-room notice says something moved — at most once per `gapMs`, and never while the
 * tab is hidden (it owes one re-read for when it is shown again). The notices carry no rows;
 * the answer is always the server's.
 */

export interface GapRefresher {
  poke: () => void
  /** The tab was shown again: re-read now if one is owed. */
  resume: () => void
  cancel: () => void
}

function tabVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/** Pure scheduler: the first poke after a quiet `gapMs` runs at once, later ones wait out the gap. */
export function createGapRefresher(
  fn: () => void,
  opts: { gapMs: number; now?: () => number; isVisible?: () => boolean }
): GapRefresher {
  const now = opts.now ?? (() => Date.now())
  const visible = opts.isVisible ?? tabVisible
  let last = Number.NEGATIVE_INFINITY
  let timer: ReturnType<typeof setTimeout> | null = null
  let owed = false
  const run = () => {
    timer = null
    if (!visible()) {
      owed = true
      return
    }
    owed = false
    last = now()
    fn()
  }
  return {
    poke() {
      if (timer) return
      const wait = last + opts.gapMs - now()
      if (wait <= 0) run()
      else timer = setTimeout(run, wait)
    },
    resume() {
      if (!timer && owed && visible()) run()
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      owed = false
    }
  }
}

export function useOverviewLiveRefresh(opts: {
  queryKey: QueryKey
  gapMs: number
  /** Ops topic (`ops:changed`) that pokes it. */
  topic?: string
  /** Named person/tenant notices that poke it. */
  events?: string[]
  enabled?: boolean
}): void {
  const qc = useQueryClient()
  const enabled = opts.enabled !== false
  const keyJson = JSON.stringify(opts.queryKey)
  const ref = useRef<GapRefresher | null>(null)

  useEffect(() => {
    if (!enabled) return
    const queryKey = JSON.parse(keyJson) as QueryKey
    // cancelRefetch:false — a second hook on the same key (Dashboard + its section) joins the
    // read already in flight instead of restarting it.
    const r = createGapRefresher(
      () =>
        void qc.invalidateQueries({ queryKey, refetchType: 'active' }, { cancelRefetch: false }),
      { gapMs: opts.gapMs }
    )
    ref.current = r
    const onVis = () => r.resume()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      r.cancel()
      ref.current = null
    }
  }, [qc, keyJson, opts.gapMs, enabled])

  const poke = () => ref.current?.poke()
  useLiveOps(opts.topic ?? null, poke, { debounceMs: 1500, enabled: enabled && !!opts.topic })
  useLiveEvent(opts.events ?? [], poke, {
    debounceMs: 1500,
    includeOwn: true,
    enabled: enabled && !!opts.events?.length
  })
}
