import type { NivaroClient } from '@nivaro/sdk'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
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
 */

/** API prefetches one tab may make in any rolling minute. */
export const PREFETCH_PER_MINUTE = 30
/** How long a pointer must rest before it counts as intent. */
export const INTENT_DWELL_MS = 150
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

function saveData(): boolean {
  if (typeof navigator === 'undefined') return false
  const c = (navigator as { connection?: { saveData?: boolean } }).connection
  return !!c?.saveData
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

/** Prefetch one key when it is not already fresh and the budget allows. */
export function prefetchKey(
  qc: QueryClient,
  key: QueryKey,
  queryFn: () => Promise<unknown>,
  now = Date.now()
): boolean {
  if (saveData() || fresh(qc, key, now)) return false
  if (!takePrefetchToken(now)) return false
  void qc.prefetchQuery({ queryKey: key, queryFn, staleTime: PREFETCH_STALE_MS })
  return true
}

/**
 * Warm a record page: its readOne and the layout it will open with. Returns how many requests
 * went out (0 when both were fresh or the budget was spent).
 */
export function prefetchRecord(
  qc: QueryClient,
  client: NivaroClient,
  collection: string,
  id: string | number,
  opts: { layout?: boolean } = {}
): number {
  if (!collection || id == null || id === '' || id === 'new') return 0
  const keys = recordQueryKeys(collection, id)
  let sent = 0
  if (
    prefetchKey(qc, keys.item, () =>
      client
        .request<{ data: Record<string, unknown> }>(get(`/items/${collection}/${id}`))
        .then((r) => r.data)
    )
  )
    sent++
  if (
    opts.layout !== false &&
    prefetchKey(qc, keys.layout, () =>
      client
        .request<{ data: unknown }>(
          get('/collection-layouts/active', { collection, item: String(id) })
        )
        .then((r) => r.data ?? null)
    )
  )
    sent++
  return sent
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
 * Document-level intent listener: resting on (or keyboard-focusing) a same-origin link
 * preloads its screen's code, and a record link also warms the record. Returns the uninstaller.
 */
export function installIntentPrefetch(opts: IntentPrefetchOptions): () => void {
  if (typeof document === 'undefined') return () => {}
  const root = opts.root ?? document
  const origin = window.location.origin
  let timer: ReturnType<typeof setTimeout> | null = null
  let current: HTMLAnchorElement | null = null
  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
    current = null
  }
  const act = (a: HTMLAnchorElement) => {
    const path = linkPath(a, origin)
    if (!path) return
    try {
      opts.preloadRoute?.(path)
    } catch {
      /* a chunk preload is decoration */
    }
    const rec = opts.matchRecord?.(path.split('?')[0])
    if (rec && opts.client) prefetchRecord(opts.qc, opts.client, rec.collection, rec.id)
  }
  const onOver = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a || a === current) return
    cancel()
    current = a
    timer = setTimeout(() => {
      timer = null
      act(a)
    }, INTENT_DWELL_MS)
  }
  const onOut = (e: Event) => {
    const to = (e as PointerEvent).relatedTarget as Node | null
    if (current && to && current.contains(to)) return
    cancel()
  }
  const onFocus = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (a) act(a)
  }
  root.addEventListener('pointerover', onOver, { passive: true })
  root.addEventListener('pointerout', onOut, { passive: true })
  root.addEventListener('focusin', onFocus)
  return () => {
    cancel()
    root.removeEventListener('pointerover', onOver)
    root.removeEventListener('pointerout', onOut)
    root.removeEventListener('focusin', onFocus)
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
      preloadRoute: (p) => ref.current.preloadRoute?.(p),
      root: ref.current.root
    })
  }, [enabled])
}
