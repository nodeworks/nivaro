import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveCollection } from './live'
import { flashRows } from './live-list'

/**
 * Live search results (realtime program 2026-11-14, item 14).
 *
 * The open results page follows other people's writes without anyone pressing reload:
 *
 * - a result whose record changed updates in place (same position, a short fade);
 * - a result that STOPS matching dims and stays where it is (nothing leaves under the
 *   pointer) — it is gone on the next refresh;
 * - a record that newly matches is only COUNTED ("2 new matches · Show"); Show re-runs the
 *   page's own query as the viewer. The client never works out matching itself.
 *
 * How it learns what changed: a `collection:update` for a collection on the page schedules ONE
 * re-ask (`fetchFresh`, the page's own permission-checked search, run as the viewer) — at most
 * one per `minGapMs`, none while the tab is hidden. Only records the events NAMED can dim or
 * count as new, so a result that merely moves down the ranking is neither.
 */

export interface SearchRow {
  collection: string
  id: string | number
}

/** The one key a result row and an event agree on: `collection:ID` (ids compare upper-case). */
export function searchRowKey(r: SearchRow): string {
  return `${r.collection}:${String(r.id).toUpperCase()}`
}

export interface SearchReconcile<T> {
  /** Rows on the page that are still results but read differently now (key → new row). */
  updated: Map<string, T>
  /** Rows the events named that the fresh answer no longer contains. */
  gone: Set<string>
  /** Rows in the fresh answer that the page does not show, among the ones the events named. */
  added: Map<string, T>
}

/**
 * What a re-asked search says about the rows on the page. `touched` is the set of row keys the
 * events named, or `'any'` after a bulk write that named no records (then nothing dims — it
 * cannot be told what moved — and every unseen row counts as new).
 */
export function reconcileSearch<T extends SearchRow>(
  shown: T[],
  fresh: T[],
  touched: Set<string> | 'any',
  /** `fresh` only covers the first N shown rows (a page of a longer list): later rows are left alone. */
  windowSize?: number
): SearchReconcile<T> {
  const freshByKey = new Map(fresh.map((r) => [searchRowKey(r), r]))
  const shownKeys = new Set(shown.map(searchRowKey))
  const updated = new Map<string, T>()
  const gone = new Set<string>()
  for (const r of windowSize != null ? shown.slice(0, windowSize) : shown) {
    const key = searchRowKey(r)
    const next = freshByKey.get(key)
    if (next) {
      if (JSON.stringify(next) !== JSON.stringify(r)) updated.set(key, next)
    } else if (touched !== 'any' && touched.has(key)) {
      gone.add(key)
    }
  }
  const added = new Map<string, T>()
  for (const [key, r] of freshByKey) {
    if (shownKeys.has(key)) continue
    if (touched === 'any' || touched.has(key)) added.set(key, r)
  }
  return { updated, gone, added }
}

/** "1 new match" / "3 new matches". */
export function newMatchesText(count: number): string {
  return `${count} new ${count === 1 ? 'match' : 'matches'}`
}

export interface LiveSearchOptions<T extends SearchRow> {
  /** The rows exactly as the page's query returned them. */
  rows: T[]
  /** Collections whose writes matter (the page's result collections). */
  collections: string[]
  /** The page's own search, run again as the viewer, bypassing any short cache. */
  fetchFresh: () => Promise<T[]>
  /** Changes whenever the page's query shows a new answer (query text, tab, page, refetch). */
  resetKey: string
  /** The page's normal refetch — what Show runs. */
  onShow: () => void
  enabled?: boolean
  /** Count newly matching records (off past the first page: a later page cannot say). */
  detectNew?: boolean
  /** Put on the element that contains the rows (`data-row-key` = searchRowKey) for the fade. */
  rootRef?: RefObject<HTMLElement | null>
  /** Least time between two re-asks. */
  minGapMs?: number
  /** `fetchFresh` answers only the first N rows (a longer, paged list): later rows are left alone. */
  windowSize?: number
}

export interface LiveSearchState<T extends SearchRow> {
  /** `rows` with in-place updates applied (same order, same length). */
  rows: T[]
  /** Keys (searchRowKey) of rows that no longer match. */
  dimmed: ReadonlySet<string>
  newCount: number
  /** Re-run the page's query (shows the new matches, drops the dimmed rows). */
  show: () => void
}

const MAX_TOUCHED = 500

export function useLiveSearchResults<T extends SearchRow>(
  opts: LiveSearchOptions<T>
): LiveSearchState<T> {
  const { rows, resetKey, enabled = true, detectNew = true } = opts
  const [overlay, setOverlay] = useState<Map<string, T>>(() => new Map())
  const [dimmed, setDimmed] = useState<ReadonlySet<string>>(() => new Set())
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())

  const touched = useRef(new Set<string>())
  const bulk = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const running = useRef(false)
  const again = useRef(false)
  const lastRun = useRef(0)
  const alive = useRef(true)
  const flashQueue = useRef<string[]>([])
  const scheduleRef = useRef<() => void>(() => {})

  const merged = useMemo(
    () => (overlay.size === 0 ? rows : rows.map((r) => overlay.get(searchRowKey(r)) ?? r)),
    [rows, overlay]
  )
  const mergedRef = useRef(merged)
  mergedRef.current = merged
  const optsRef = useRef(opts)
  optsRef.current = opts

  // A new answer on the page (typed another query, changed tab/page, Show, a refetch) starts clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the trigger
  useEffect(() => {
    setOverlay(new Map())
    setDimmed(new Set())
    setPending(new Set())
    touched.current.clear()
    bulk.current = false
  }, [resetKey])

  const run = useCallback(async () => {
    timer.current = null
    if (running.current) {
      again.current = true
      return
    }
    if (typeof document !== 'undefined' && document.hidden) return // runs on becoming visible
    const named: Set<string> | 'any' = bulk.current ? 'any' : new Set(touched.current)
    touched.current.clear()
    bulk.current = false
    running.current = true
    lastRun.current = Date.now()
    try {
      const fresh = await optsRef.current.fetchFresh()
      if (!alive.current) return
      const r = reconcileSearch(mergedRef.current, fresh, named, optsRef.current.windowSize)
      if (r.updated.size > 0) {
        setOverlay((prev) => {
          const next = new Map(prev)
          for (const [k, v] of r.updated) next.set(k, v)
          return next
        })
        flashQueue.current.push(...r.updated.keys())
      }
      if (r.gone.size > 0) setDimmed((prev) => new Set([...prev, ...r.gone]))
      if (r.added.size > 0 && optsRef.current.detectNew !== false)
        setPending((prev) => new Set([...prev, ...r.added.keys()]))
    } catch {
      /* the page keeps what it shows; the next change asks again */
    } finally {
      running.current = false
      if (again.current && alive.current) {
        again.current = false
        scheduleRef.current()
      }
    }
  }, [])

  const schedule = useCallback(() => {
    if (timer.current) return
    const wait = Math.max(0, lastRun.current + (optsRef.current.minGapMs ?? 4000) - Date.now())
    timer.current = setTimeout(() => void run(), wait)
  }, [run])
  scheduleRef.current = schedule

  // Coalesced: a burst is one batch (debounce), and one re-ask per minGapMs after that.
  const collectionsKey = [...new Set(opts.collections)].sort().join(',')
  useLiveCollection(
    collectionsKey ? collectionsKey.split(',') : null,
    (batch) => {
      if (batch.aspectsOnly) return
      for (const ev of batch.events) {
        if (ev.item === '*') bulk.current = true
        else if (touched.current.size < MAX_TOUCHED)
          touched.current.add(
            searchRowKey({ collection: String(ev.collection), id: String(ev.item) })
          )
        else bulk.current = true
      }
      schedule()
    },
    { debounceMs: 1000, enabled: enabled && collectionsKey !== '', focusable: true }
  )

  // A hidden tab holds its re-ask; coming back runs it once.
  useEffect(() => {
    if (!enabled) return
    const onVisible = () => {
      if (!document.hidden && (touched.current.size > 0 || bulk.current)) schedule()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [enabled, schedule])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  // Fade the rows that changed in place, once they are painted.
  useEffect(() => {
    if (flashQueue.current.length === 0) return
    const ids = flashQueue.current
    flashQueue.current = []
    const raf = requestAnimationFrame(() =>
      flashRows(optsRef.current.rootRef?.current ?? document, ids)
    )
    return () => cancelAnimationFrame(raf)
  })

  const show = useCallback(() => {
    setPending(new Set())
    optsRef.current.onShow()
  }, [])

  return {
    rows: merged,
    dimmed,
    newCount: detectNew ? pending.size : 0,
    show
  }
}
