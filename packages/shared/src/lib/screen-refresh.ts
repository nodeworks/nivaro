import type { Query, QueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { forgetSettledReads } from './request-gate'

/**
 * Refresh the data on this screen, never the page (realtime idea 12).
 *
 * People reloaded a page to be sure what they saw was current (prod, a week to 2026-11-14:
 * ~1,050 same-page reloads). A reload costs them their scroll, open panels, selection and any
 * half-typed edit. This refetches what the screen shows, in place:
 *
 * - every ACTIVE react-query read (`refetchQueries({type: 'active'})`, reads already in flight are
 *   kept, not restarted), while inactive cached reads are only marked stale so the next screen
 *   that mounts them asks again;
 * - every loader a screen registered for data it keeps outside react-query
 *   (`useScreenLoader(fn)` / `registerScreenLoader(fn)`);
 * - the `nvr:screen-refresh` window event, for anything else that wants to listen.
 *
 * What stays: unsaved edits (the record form merges a refetch into its draft field by field —
 * the same path a live write by someone else takes, so a touched field keeps the person's value),
 * scroll position, open sheets and popovers, selection. Nothing remounts.
 *
 * A query opts out with `meta: { screenRefresh: false }` (a read that must not repeat — a one-off
 * export, a run that costs money).
 *
 * One refresh at a time: a second call while one runs gets the same promise. Automatic callers
 * (the idle resync, idea 13) are coalesced to one per second.
 */

export type ScreenRefreshPhase = 'idle' | 'running' | 'done' | 'partial'

export interface ScreenRefreshState {
  phase: ScreenRefreshPhase
  /** When the phase last changed (ms). */
  at: number
  /** What asked for the last refresh ('button', 'palette', 'idle-…'). */
  reason: string | null
}

export interface ScreenRefreshResult {
  /** Active reads refetched. */
  queries: number
  /** Registered loaders run. */
  loaders: number
  /** Reads or loaders that answered with an error. */
  failed: number
  ms: number
  /** True when this call was folded into one already running or just finished. */
  coalesced?: boolean
}

/** How long the quiet "done" mark stays before the button goes back to rest. */
export const SCREEN_REFRESH_DONE_MS = 1600
/** Automatic refreshes closer together than this are one refresh. */
export const SCREEN_REFRESH_MIN_GAP_MS = 1000
/** A loader that has not answered by now counts as failed (the refresh does not wait forever). */
export const SCREEN_LOADER_TIMEOUT_MS = 20_000

type Loader = () => unknown

let boundClient: QueryClient | null = null
const loaders = new Map<number, Loader>()
let nextLoaderId = 1
let running: Promise<ScreenRefreshResult> | null = null
let lastFinishedAt = 0
let lastResult: ScreenRefreshResult | null = null
let state: ScreenRefreshState = { phase: 'idle', at: 0, reason: null }
const listeners = new Set<() => void>()
let restTimer: ReturnType<typeof setTimeout> | null = null

function setState(next: ScreenRefreshState): void {
  state = next
  for (const l of [...listeners]) l()
}

/** The app's QueryClient (mounted once by the host's live bridge or the refresh button). */
export function setScreenRefreshClient(qc: QueryClient | null): void {
  boundClient = qc
}

export function screenRefreshClient(): QueryClient | null {
  return boundClient
}

/**
 * A screen that keeps data outside react-query (its own fetch + useState) registers how to load
 * it again. Returns the unregister function.
 */
export function registerScreenLoader(run: Loader): () => void {
  const id = nextLoaderId++
  loaders.set(id, run)
  return () => {
    loaders.delete(id)
  }
}

/** Hook form: the latest `run` is called on every screen refresh while mounted. */
export function useScreenLoader(run: Loader, enabled = true): void {
  const ref = useRef(run)
  ref.current = run
  useEffect(() => {
    if (!enabled) return
    return registerScreenLoader(() => ref.current())
  }, [enabled])
}

type AnyQuery = Query<unknown, Error, unknown, readonly unknown[]>

/** May the refresh touch this query? (`meta.screenRefresh === false` opts out.) */
export function screenRefreshAllowed(q: { meta?: unknown }): boolean {
  const m = q.meta as { screenRefresh?: unknown } | undefined
  return m?.screenRefresh !== false
}

function withTimeout(p: unknown, ms: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

async function runRefresh(qc: QueryClient | null, reason: string): Promise<ScreenRefreshResult> {
  const started = Date.now()
  // Config reads are reused for 3 s after settling (request-gate): this refresh must really ask.
  forgetSettledReads()
  let queries = 0
  let failed = 0
  const targets: AnyQuery[] = []
  if (qc) {
    for (const q of qc.getQueryCache().getAll() as AnyQuery[]) {
      if (q.getObserversCount() > 0 && !q.isDisabled() && screenRefreshAllowed(q)) targets.push(q)
    }
    queries = targets.length
    const set = new Set(targets)
    // Inactive reads: stale only, so the next screen that mounts them asks again.
    void qc.invalidateQueries({
      type: 'inactive',
      refetchType: 'none',
      predicate: (q) => screenRefreshAllowed(q)
    })
    // Active reads: refetch now; one already in flight is kept (it is at least as fresh).
    await qc.refetchQueries(
      { predicate: (q) => set.has(q as AnyQuery) },
      { cancelRefetch: false, throwOnError: false }
    )
    failed += targets.filter((q) => q.state.status === 'error').length
  }
  const runs = [...loaders.values()]
  const settled = await Promise.allSettled(
    runs.map((run) => {
      try {
        return withTimeout(run(), SCREEN_LOADER_TIMEOUT_MS)
      } catch (err) {
        return Promise.reject(err)
      }
    })
  )
  failed += settled.filter((s) => s.status === 'rejected').length
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('nvr:screen-refresh', { detail: { reason } }))
    } catch {
      /* an old browser without CustomEvent: the reads above already ran */
    }
  }
  return { queries, loaders: runs.length, failed, ms: Date.now() - started }
}

/**
 * Refetch what this screen shows, in place. `reason` is for diagnostics ('button', 'palette',
 * 'idle-replay-window'…). Automatic reasons (anything but 'button' / 'palette' / 'shortcut')
 * inside SCREEN_REFRESH_MIN_GAP_MS of the last refresh are folded into it.
 */
export function refreshScreenData(
  opts: { reason?: string; qc?: QueryClient | null; now?: () => number } = {}
): Promise<ScreenRefreshResult> {
  const reason = opts.reason ?? 'button'
  if (running) return running.then((r) => ({ ...r, coalesced: true }))
  const now = opts.now ?? Date.now
  const manual = reason === 'button' || reason === 'palette' || reason === 'shortcut'
  if (!manual && lastResult && now() - lastFinishedAt < SCREEN_REFRESH_MIN_GAP_MS)
    return Promise.resolve({ ...lastResult, coalesced: true })
  const qc = opts.qc === undefined ? boundClient : opts.qc
  if (restTimer) clearTimeout(restTimer)
  setState({ phase: 'running', at: now(), reason })
  const p = runRefresh(qc, reason)
    .catch((): ScreenRefreshResult => ({ queries: 0, loaders: 0, failed: 1, ms: 0 }))
    .then((r) => {
      running = null
      lastFinishedAt = now()
      lastResult = r
      setState({ phase: r.failed > 0 ? 'partial' : 'done', at: now(), reason })
      restTimer = setTimeout(() => {
        restTimer = null
        if (state.phase !== 'running') setState({ phase: 'idle', at: Date.now(), reason })
      }, SCREEN_REFRESH_DONE_MS)
      ;(restTimer as { unref?: () => void }).unref?.()
      return r
    })
  running = p
  return p
}

export function screenRefreshState(): ScreenRefreshState {
  return state
}

export function subscribeScreenRefresh(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** The refresh state for a button or a status line. */
export function useScreenRefreshState(): ScreenRefreshState {
  return useSyncExternalStore(subscribeScreenRefresh, screenRefreshState, screenRefreshState)
}

export function __resetScreenRefreshForTests(): void {
  boundClient = null
  loaders.clear()
  running = null
  lastFinishedAt = 0
  lastResult = null
  if (restTimer) clearTimeout(restTimer)
  restTimer = null
  state = { phase: 'idle', at: 0, reason: null }
  listeners.clear()
  pageButtons = 0
}

const PALETTE_WORDS = ['refresh', 'reload', 'update', 'data', 'fresh', 'stale']

/** Pure: does a command-palette query ask for "Refresh this page's data"? (both apps' palettes) */
export function screenRefreshMatches(query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return false
  const words = q.split(/\s+/)
  return words.every((w) => PALETTE_WORDS.some((p) => p.startsWith(w)) || 'this page'.includes(w))
}

// ─── One ↻ per screen ────────────────────────────────────────────────────────
// A page that shows its own refresh button (the record header's) registers it; the app-wide
// one (admin sidebar footer, portal top bar) renders nothing meanwhile, so a screen never shows
// two.

let pageButtons = 0
const pageButtonListeners = new Set<() => void>()

/** A page-level ↻ is on screen. Returns the unregister function. */
export function registerPageRefreshButton(): () => void {
  pageButtons++
  for (const l of [...pageButtonListeners]) l()
  let done = false
  return () => {
    if (done) return
    done = true
    pageButtons = Math.max(0, pageButtons - 1)
    for (const l of [...pageButtonListeners]) l()
  }
}

export function pageRefreshButtonShown(): boolean {
  return pageButtons > 0
}

function subscribePageButtons(cb: () => void): () => void {
  pageButtonListeners.add(cb)
  return () => {
    pageButtonListeners.delete(cb)
  }
}

/** True while some page shows its own ↻ (the app-wide one hides). */
export function usePageRefreshButtonShown(): boolean {
  return useSyncExternalStore(subscribePageButtons, pageRefreshButtonShown, () => false)
}
