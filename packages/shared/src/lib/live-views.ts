import { type QueryKey, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveCollection, useLiveEvent, useLiveWatchRoom } from './live'
import { createCoalescer } from './live-counts'
import { type SettledRow, useLiveFade, useSettledRows } from './live-screen'

/**
 * Time-based screens that follow the data quietly (realtime program 2026-11-14, ideas 20-22):
 * calendars, timelines and run lists.
 *
 * - `useBackgroundArm` — the key `useLiveFade` wants: 0 on the first answer, then the time of
 *   each background refresh. A first load, a month change or a filter the person chose is a new
 *   query key (no data yet) and never arms the fade.
 * - `useLiveCalendar` — a month/week grid over a collection: other people's adds, moves and
 *   reschedules refresh the grid once per quiet window; an entry that left (moved to another
 *   day, rescheduled out of the range) stays where it was, calmly, until the person moves on.
 * - `useLiveJobs` — run lists and run timelines: a run starting or finishing refreshes the named
 *   queries once per burst, progress reports never refetch (they only reach `onProgress`).
 *
 * Nothing here reads a payload value. Every refresh goes through the viewer's own route.
 */

// ── Fade arm ──────────────────────────────────────────────────────────────

/**
 * The arm key for `useLiveFade`: `updatedAt` once a SECOND answer for the same view arrived,
 * 0 before. Pass `resetKey` (the view's own key) so a view change starts over.
 */
export function backgroundArm(
  prev: { resetKey: string; first: number | null },
  updatedAt: number,
  resetKey: string
): { arm: number; state: { resetKey: string; first: number | null } } {
  if (!updatedAt) return { arm: 0, state: prev }
  if (prev.resetKey !== resetKey || prev.first == null)
    return { arm: 0, state: { resetKey, first: updatedAt } }
  return { arm: updatedAt === prev.first ? 0 : updatedAt, state: prev }
}

export function useBackgroundArm(updatedAt: number | undefined, resetKey = ''): number {
  const ref = useRef<{ resetKey: string; first: number | null }>({ resetKey, first: null })
  const { arm, state } = backgroundArm(ref.current, updatedAt ?? 0, resetKey)
  ref.current = state
  return arm
}

// ── Calendar ──────────────────────────────────────────────────────────────

export interface LiveCalendarOptions<T> {
  collection: string | null | undefined
  /** Query keys (prefixes) re-read when the collection moves. */
  keys: QueryKey[]
  /** The rows the query answered (undefined while loading). */
  items: readonly T[] | undefined
  keyOf: (row: T) => string
  /** react-query `dataUpdatedAt` of the main query. */
  updatedAt?: number
  /** The person's own view (month, date field, filter): a change shows the new answer as it is. */
  resetKey: string
  /** Only writes naming one of these fields refresh the grid (default: any non-aspect write). */
  fields?: string[]
  quietMs?: number
  maxWaitMs?: number
  enabled?: boolean
}

export interface LiveCalendar<T> {
  /** Entries to draw; `departed` ones are no longer in the server's answer. */
  entries: SettledRow<T>[]
  /** Put on the element that contains the grid (pointer / focus inside it holds the order). */
  ref: (el: HTMLElement | null) => void
}

/** Whether a live batch can change what a calendar draws (pure; exported for tests). */
export function calendarBatchMatters(
  batch: { aspectsOnly: boolean; changedFields: string[] | null; own?: boolean },
  fields?: string[]
): boolean {
  if (batch.aspectsOnly) return false
  if (!fields || fields.length === 0 || batch.changedFields === null) return true
  return batch.changedFields.some((f) => fields.includes(f))
}

export function useLiveCalendar<T>(opts: LiveCalendarOptions<T>): LiveCalendar<T> {
  const qc = useQueryClient()
  const enabled = opts.enabled !== false
  const keysRef = useRef(opts.keys)
  keysRef.current = opts.keys
  const fieldsRef = useRef(opts.fields)
  fieldsRef.current = opts.fields
  const quietMs = Math.max(1000, opts.quietMs ?? 1500)
  const maxWaitMs = opts.maxWaitMs ?? 8000
  const coRef = useRef<ReturnType<typeof createCoalescer> | null>(null)

  useEffect(() => {
    if (!enabled) return
    const co = createCoalescer(
      () => {
        for (const queryKey of keysRef.current)
          void qc.invalidateQueries({ queryKey, refetchType: 'active' })
      },
      { quietMs, maxWaitMs }
    )
    coRef.current = co
    const onVis = () => co.resume()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      co.cancel()
      coRef.current = null
    }
  }, [qc, enabled, quietMs, maxWaitMs])

  useLiveCollection(
    opts.collection,
    (batch) => {
      if (!calendarBatchMatters(batch, fieldsRef.current)) return
      coRef.current?.poke()
    },
    { debounceMs: 300, enabled, focusable: true }
  )

  const settled = useSettledRows(opts.items, opts.keyOf, { enabled, resetKey: opts.resetKey })
  const fade = useLiveFade(useBackgroundArm(opts.updatedAt, opts.resetKey), { enabled })
  const ref = useCallback(
    (el: HTMLElement | null) => {
      settled.containerRef(el)
      fade(el)
    },
    [settled.containerRef, fade]
  )
  return { entries: settled.rows, ref }
}

// ── Runs ──────────────────────────────────────────────────────────────────

/** A `job:update` that says a run started or finished (a progress report names `progress`). */
export function isJobBoundary(p: { progress?: unknown } | null | undefined): boolean {
  return !!p && p.progress == null
}

export interface LiveJobsOptions {
  /** Query keys (prefixes) re-read when a run starts or finishes. */
  keys: QueryKey[]
  /** A progress report (never refetches). */
  onProgress?: (p: { id?: number; progress: Record<string, unknown> }) => void
  quietMs?: number
  maxWaitMs?: number
  enabled?: boolean
}

/**
 * Join the admin `jobs` watch room and re-read `keys` once per quiet window after a run
 * starts or finishes. Returns whether events can arrive (hosts keep a slow poll as the net).
 */
export function useLiveJobs(opts: LiveJobsOptions): boolean {
  const qc = useQueryClient()
  const enabled = opts.enabled !== false
  const live = useLiveWatchRoom('jobs', enabled)
  const keysRef = useRef(opts.keys)
  keysRef.current = opts.keys
  const progressRef = useRef(opts.onProgress)
  progressRef.current = opts.onProgress
  const quietMs = opts.quietMs ?? 1000
  const maxWaitMs = opts.maxWaitMs ?? 5000
  const coRef = useRef<ReturnType<typeof createCoalescer> | null>(null)

  useEffect(() => {
    if (!enabled) return
    const co = createCoalescer(
      () => {
        for (const queryKey of keysRef.current)
          void qc.invalidateQueries({ queryKey, refetchType: 'active' })
      },
      { quietMs, maxWaitMs }
    )
    coRef.current = co
    const onVis = () => co.resume()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      co.cancel()
      coRef.current = null
    }
  }, [qc, enabled, quietMs, maxWaitMs])

  useLiveEvent(
    'job:update',
    (p: { id?: number; progress?: Record<string, unknown> }) => {
      if (isJobBoundary(p)) coRef.current?.poke()
      else if (p.progress) progressRef.current?.({ id: p.id, progress: p.progress })
    },
    { includeOwn: true, enabled }
  )
  return live
}

/** A "now" that ticks (countdowns and "ago" labels move without a refetch). */
export function useNowTick(everyMs = 30_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs, enabled])
  return now
}
