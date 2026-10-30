import { type NivaroClient, withSignal } from '@nivaro/sdk'
import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import { useOptionalNivaroClient } from '../context'
import { get } from './commands'

/**
 * Prefetch on intent (#2448).
 *
 * When the pointer rests on a list row or a record link, the record (readOne) AND its layout are
 * fetched into the same query keys the record page reads, so opening it paints at once; while the
 * browser is idle a list fetches its next page; resting on a nav link loads the next screen's code
 * chunk. A prefetched copy is at most a few seconds old and the page's normal refetch replaces
 * it. Every API prefetch spends one token of a per-tab, per-minute budget, so a fast mouse
 * sweeping a table never floods the API; a copy already in the cache and still fresh costs
 * nothing. Nothing prefetches when the browser asks to save data.
 *
 * #3230 — at most MAX_PREFETCH_IN_FLIGHT prefetches run at once (the rest queue, newest kept);
 * the pointer leaving (or focus moving off) a link it prefetched for cancels what has not
 * started and aborts what nobody has picked up yet; a slow connection (2g) skips like
 * save-data. Prefetches are reads only: a record's readOne + layout, a list's collection
 * metadata (the list's own page query depends on its saved view, so it is not guessed), and a
 * screen's code chunk. Reads behind the heavy-read gate (queues, custom queries, widgets) are
 * never prefetched.
 */

/** API prefetches one tab may make in any rolling minute. */
export const PREFETCH_PER_MINUTE = 30
/** How long a pointer must rest before it counts as intent. */
export const INTENT_DWELL_MS = 80
/** Prefetch requests one tab runs at once; the rest wait their turn. */
export const MAX_PREFETCH_IN_FLIGHT = 2
/** Waiting prefetches kept; older intents are dropped first. */
export const MAX_PREFETCH_QUEUED = 6
/** Prefetched copies count as fresh this long (the page's own staleTime decides after). */
export const PREFETCH_STALE_MS = 30_000

let stamps: number[] = []

/** Spend one prefetch token; false = the minute's budget is used up. */
export function takePrefetchToken(now = Date.now(), cap = PREFETCH_PER_MINUTE): boolean {
  stamps = stamps.filter((t) => now - t < 60_000)
  if (stamps.length >= cap) return false
  stamps.push(now)
  return true
}

/** Test seam. */
export function __resetPrefetchBudget(): void {
  stamps = []
}

interface NetInfo {
  saveData?: boolean
  effectiveType?: string
}

/** Pure: may this connection prefetch? Not when it asks to save data or is 2g-slow. */
export function connectionAllowsPrefetch(c: NetInfo | null | undefined): boolean {
  if (!c) return true
  if (c.saveData) return false
  return c.effectiveType !== 'slow-2g' && c.effectiveType !== '2g'
}

function saveData(): boolean {
  if (typeof navigator === 'undefined') return false
  return !connectionAllowsPrefetch((navigator as { connection?: NetInfo }).connection)
}

// ── #3230: bounded concurrency + cancel ──────────────────────────────────────

export interface PrefetchJob {
  /** Dedupe key (the query key). */
  id: string
  /** What the intent was for (a link path) — leaving it cancels the group. */
  group?: string | null
  run: () => Promise<unknown>
  /** Abort a started job (it decides whether anyone needs the answer by now). */
  cancel?: () => void
}

export interface PrefetchLimiter {
  /** Queue a job; false = already queued or running. */
  add(job: PrefetchJob): boolean
  has(id: string): boolean
  /** Drop the group's waiting jobs and cancel its running ones. */
  cancelGroup(group: string): void
  readonly inFlight: number
  readonly queued: number
}

/** At most `max` jobs run at once; at most `maxQueued` wait (oldest dropped first). */
export function createPrefetchLimiter(
  max = MAX_PREFETCH_IN_FLIGHT,
  maxQueued = MAX_PREFETCH_QUEUED
): PrefetchLimiter {
  const queue: PrefetchJob[] = []
  const running = new Map<string, PrefetchJob>()
  const pump = () => {
    while (running.size < max && queue.length > 0) {
      const job = queue.shift() as PrefetchJob
      running.set(job.id, job)
      Promise.resolve()
        .then(job.run)
        .catch(() => {})
        .finally(() => {
          if (running.get(job.id) === job) running.delete(job.id)
          pump()
        })
    }
  }
  return {
    add(job) {
      if (running.has(job.id) || queue.some((q) => q.id === job.id)) return false
      queue.push(job)
      while (queue.length > maxQueued) queue.shift()
      pump()
      return true
    },
    has(id) {
      return running.has(id) || queue.some((q) => q.id === id)
    },
    cancelGroup(group) {
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].group === group) queue.splice(i, 1)
      for (const job of running.values()) {
        if (job.group !== group) continue
        try {
          job.cancel?.()
        } catch {
          /* decoration */
        }
      }
    },
    get inFlight() {
      return running.size
    },
    get queued() {
      return queue.length
    }
  }
}

/** The tab's one limiter (every prefetch shares it). */
export const prefetchLimiter: PrefetchLimiter = createPrefetchLimiter()

/** Abort a prefetch only when nothing has started watching it — checked a beat later, so a
 *  click that navigated (and mounted the page reading the same key) keeps its answer. */
function cancelIfUnwatched(qc: QueryClient, key: QueryKey): void {
  setTimeout(() => {
    const q = qc.getQueryCache().find({ queryKey: key, exact: true })
    if (!q || q.getObserversCount() > 0 || q.state.fetchStatus !== 'fetching') return
    void qc.cancelQueries({ queryKey: key, exact: true })
  }, 120)
}

/** The query keys the record page reads (ItemEditForm / admin ItemEdit share them). */
export function recordQueryKeys(collection: string, id: string | number) {
  return {
    item: ['item', collection, String(id)] as QueryKey,
    layout: ['active-layout', collection, null, String(id)] as QueryKey
  }
}

function fresh(qc: QueryClient, key: QueryKey, now: number): boolean {
  const st = qc.getQueryState(key)
  if (!st) return false
  if (st.fetchStatus === 'fetching') return true
  return st.dataUpdatedAt > 0 && now - st.dataUpdatedAt < PREFETCH_STALE_MS
}

/**
 * Prefetch one key when it is not already fresh and the budget allows. It runs through the
 * tab's limiter (at most MAX_PREFETCH_IN_FLIGHT at once); `group` ties it to an intent that can
 * be cancelled. `queryFn` gets the query's AbortSignal.
 */
export function prefetchKey(
  qc: QueryClient,
  key: QueryKey,
  queryFn: (signal?: AbortSignal) => Promise<unknown>,
  now = Date.now(),
  group?: string | null
): boolean {
  if (saveData() || fresh(qc, key, now)) return false
  const id = JSON.stringify(key)
  if (prefetchLimiter.has(id)) return false
  if (!takePrefetchToken(now)) return false
  return prefetchLimiter.add({
    id,
    group: group ?? null,
    run: () =>
      // Fresh by now (the page itself fetched it while this waited) = nothing to do.
      fresh(qc, key, Date.now())
        ? Promise.resolve()
        : qc.prefetchQuery({
            queryKey: key,
            queryFn: ({ signal }) => queryFn(signal),
            staleTime: PREFETCH_STALE_MS
          }),
    cancel: () => cancelIfUnwatched(qc, key)
  })
}

/**
 * Warm a record page: its readOne and the layout it will open with. Returns how many requests
 * were queued (0 when both were fresh or the budget was spent).
 */
export function prefetchRecord(
  qc: QueryClient,
  client: NivaroClient,
  collection: string,
  id: string | number,
  opts: { layout?: boolean; group?: string | null } = {}
): number {
  if (!collection || id == null || id === '' || id === 'new') return 0
  const keys = recordQueryKeys(collection, id)
  const group = opts.group ?? `record:${collection}:${id}`
  let sent = 0
  if (
    prefetchKey(
      qc,
      keys.item,
      (signal) =>
        client
          .request<{ data: Record<string, unknown> }>(
            withSignal(get(`/items/${collection}/${id}`), signal)
          )
          .then((r) => r.data),
      Date.now(),
      group
    )
  )
    sent++
  if (
    opts.layout !== false &&
    prefetchKey(
      qc,
      keys.layout,
      (signal) =>
        client
          .request<{ data: unknown }>(
            withSignal(get('/collection-layouts/active', { collection, item: String(id) }), signal)
          )
          .then((r) => r.data ?? null),
      Date.now(),
      group
    )
  )
    sent++
  return sent
}

/** The query key a collection list (CollectionBrowserView) reads its metadata under. */
export function listQueryKeys(collection: string) {
  return { meta: ['cbv-collection-meta', collection] as QueryKey }
}

/**
 * Warm a collection list: its metadata (fields, relations, browse config) — what the list waits
 * on before it can ask for rows, and what shapes its loading skeleton. The rows themselves
 * depend on the person's saved view, sort and filters, so they are not guessed.
 */
export function prefetchCollectionList(
  qc: QueryClient,
  client: NivaroClient,
  collection: string,
  opts: { group?: string | null } = {}
): number {
  if (!collection || /^(nivaro|directus)_/i.test(collection)) return 0
  const keys = listQueryKeys(collection)
  return prefetchKey(
    qc,
    keys.meta,
    (signal) =>
      client
        .request<{ data: unknown }>(withSignal(get(`/collections/${collection}`), signal))
        .then((r) => r.data),
    Date.now(),
    opts.group ?? `list:${collection}`
  )
    ? 1
    : 0
}

/** Run `fn` when the browser is idle (or after a short delay where idle callbacks don't exist). */
export function whenIdle(fn: () => void, timeout = 2000): () => void {
  if (typeof window === 'undefined') return () => {}
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (w.requestIdleCallback) {
    const h = w.requestIdleCallback(fn, { timeout })
    return () => w.cancelIdleCallback?.(h)
  }
  const t = setTimeout(fn, 300)
  return () => clearTimeout(t)
}

/**
 * Idle next page: once a list page has loaded and more pages exist, fetch the next one into its
 * own key while the browser has nothing better to do.
 */
export function useIdleNextPage(opts: {
  enabled: boolean
  queryKey: QueryKey
  queryFn: () => Promise<unknown>
  qc: QueryClient
}): void {
  const ref = useRef(opts)
  ref.current = opts
  const sig = JSON.stringify(opts.queryKey)
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm when the next page's key changes
  useEffect(() => {
    if (!opts.enabled) return
    return whenIdle(() => {
      const o = ref.current
      prefetchKey(o.qc, o.queryKey, o.queryFn)
    })
  }, [opts.enabled, sig])
}

export interface RecordTarget {
  collection: string
  id: string
}

export interface IntentPrefetchOptions {
  qc: QueryClient
  client: NivaroClient | null
  /** A link's same-origin path → the record it opens, or null. */
  matchRecord?: (path: string) => RecordTarget | null
  /** A link's same-origin path → the collection list it opens, or null (#3230). */
  matchList?: (path: string) => string | null
  /** Load the code for the screen a same-origin path opens. */
  preloadRoute?: (path: string) => void
  /** Only links inside this element (default: the whole document). */
  root?: HTMLElement | Document
}

/** Same-origin path of a link, or null (other origins, downloads, new-window links, hashes). */
export function linkPath(a: HTMLAnchorElement, origin: string): string | null {
  const raw = a.getAttribute('href')
  if (!raw || raw.startsWith('#') || a.hasAttribute('download')) return null
  if (a.target && a.target !== '_self') return null
  try {
    const u = new URL(raw, origin)
    if (u.origin !== origin) return null
    return u.pathname + u.search
  } catch {
    return null
  }
}

/**
 * Document-level intent listener: resting on (or keyboard-focusing) a same-origin link preloads
 * its screen's code; a record link also warms the record, a list link the list's metadata.
 * Leaving the link before pressing it cancels what it started. Returns the uninstaller.
 */
export function installIntentPrefetch(opts: IntentPrefetchOptions): () => void {
  if (typeof document === 'undefined') return () => {}
  const root = opts.root ?? document
  const origin = window.location.origin
  let timer: ReturnType<typeof setTimeout> | null = null
  let current: HTMLAnchorElement | null = null
  /** The group the last act started, until the pointer/focus leaves or the link is pressed. */
  let started: string | null = null
  const disarm = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const leave = () => {
    disarm()
    current = null
    if (started) prefetchLimiter.cancelGroup(started)
    started = null
  }
  const act = (a: HTMLAnchorElement) => {
    const path = linkPath(a, origin)
    if (!path) return
    try {
      opts.preloadRoute?.(path)
    } catch {
      /* a chunk preload is decoration */
    }
    if (!opts.client) return
    const bare = path.split('?')[0]
    const group = `link:${bare}`
    const rec = opts.matchRecord?.(bare)
    if (rec) {
      if (prefetchRecord(opts.qc, opts.client, rec.collection, rec.id, { group }) > 0)
        started = group
      return
    }
    const list = opts.matchList?.(bare)
    if (list && prefetchCollectionList(opts.qc, opts.client, list, { group }) > 0) started = group
  }
  const anchorOf = (e: Event) =>
    (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
  const onOver = (e: Event) => {
    const a = anchorOf(e)
    if (!a || a === current) return
    leave()
    current = a
    timer = setTimeout(() => {
      timer = null
      act(a)
    }, INTENT_DWELL_MS)
  }
  const onOut = (e: Event) => {
    const to = (e as PointerEvent).relatedTarget as Node | null
    if (current && to && current.contains(to)) return
    leave()
  }
  // Pressed: whatever it started is wanted now — never cancel it.
  const commit = () => {
    started = null
  }
  const onKey = (e: Event) => {
    const k = (e as KeyboardEvent).key
    if (k === 'Enter' || k === ' ') commit()
  }
  const onFocus = (e: Event) => {
    const a = anchorOf(e)
    if (!a) return
    leave()
    act(a)
  }
  const onBlur = (e: Event) => {
    if (anchorOf(e)) leave()
  }
  root.addEventListener('pointerover', onOver, { passive: true })
  root.addEventListener('pointerout', onOut, { passive: true })
  root.addEventListener('pointerdown', commit, { passive: true, capture: true })
  root.addEventListener('keydown', onKey, { capture: true })
  root.addEventListener('focusin', onFocus)
  root.addEventListener('focusout', onBlur)
  return () => {
    disarm()
    root.removeEventListener('pointerover', onOver)
    root.removeEventListener('pointerout', onOut)
    root.removeEventListener('pointerdown', commit, { capture: true })
    root.removeEventListener('keydown', onKey, { capture: true })
    root.removeEventListener('focusin', onFocus)
    root.removeEventListener('focusout', onBlur)
  }
}

/** Mount once in an app shell (inside the QueryClientProvider). */
export function useIntentPrefetch(opts: IntentPrefetchOptions & { enabled?: boolean }): void {
  const ref = useRef(opts)
  ref.current = opts
  const enabled = opts.enabled !== false
  useEffect(() => {
    if (!enabled) return
    return installIntentPrefetch({
      qc: ref.current.qc,
      get client() {
        return ref.current.client
      },
      matchRecord: (p) => ref.current.matchRecord?.(p) ?? null,
      matchList: (p) => ref.current.matchList?.(p) ?? null,
      preloadRoute: (p) => ref.current.preloadRoute?.(p),
      root: ref.current.root
    })
  }, [enabled])
}

// ── #3230: intent on elements that are not links (rows, buttons) ─────────────

export interface IntentProps {
  onPointerEnter: () => void
  onPointerLeave: () => void
  onPointerDown: () => void
  onFocus: () => void
  onBlur: () => void
}

const elementTimers = new Map<string, ReturnType<typeof setTimeout>>()
const elementStarted = new Set<string>()

/**
 * Handlers that turn resting on (or focusing) an element into `act()` after INTENT_DWELL_MS,
 * and leaving it into a cancel of what `act` started (unless it was pressed). `group` names the
 * intent (e.g. `record:projects:7`); `act` must start its prefetches under that group.
 */
export function intentProps(group: string, act: () => number | boolean | undefined): IntentProps {
  const start = () => {
    const t = elementTimers.get(group)
    if (t) clearTimeout(t)
    elementTimers.set(
      group,
      setTimeout(() => {
        elementTimers.delete(group)
        if (act()) elementStarted.add(group)
      }, INTENT_DWELL_MS)
    )
  }
  const stop = () => {
    const t = elementTimers.get(group)
    if (t) clearTimeout(t)
    elementTimers.delete(group)
    if (elementStarted.delete(group)) prefetchLimiter.cancelGroup(group)
  }
  return {
    onPointerEnter: start,
    onPointerLeave: stop,
    onPointerDown: () => {
      elementStarted.delete(group)
    },
    onFocus: start,
    onBlur: stop
  }
}

type MaybeIntent = IntentProps | Record<string, never>

/**
 * `const intent = usePrefetchIntent()` → spread `{...intent.record(collection, id)}` on a row or
 * button that opens a record, `{...intent.list(collection)}` on one that opens a list. Inert
 * without a client (nothing to fetch with).
 */
export function usePrefetchIntent(): {
  record: (collection: string, id: string | number) => MaybeIntent
  list: (collection: string) => MaybeIntent
} {
  const qc = useQueryClient()
  const client = useOptionalNivaroClient()
  return useMemo(
    () => ({
      record: (collection: string, id: string | number): MaybeIntent => {
        if (!client || !collection || id == null || id === '' || id === 'new') return {}
        const group = `record:${collection}:${id}`
        return intentProps(group, () => prefetchRecord(qc, client, collection, id, { group }))
      },
      list: (collection: string): MaybeIntent => {
        if (!client || !collection) return {}
        const group = `list:${collection}`
        return intentProps(group, () => prefetchCollectionList(qc, client, collection, { group }))
      }
    }),
    [qc, client]
  )
}
