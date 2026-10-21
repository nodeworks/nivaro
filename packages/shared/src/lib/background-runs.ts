import { type QueryKey, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOptionalNivaroClient } from '../context'
import { get, post } from './commands'
import { useLiveEvent } from './live'

/**
 * "Run in background" for slow reads (#2759) — the client half of /api/background-runs.
 *
 * A custom query, report widget, page widget or dashboard widget that is still loading after a
 * moment asks the server how long it usually takes. Known-slow (or still loading after
 * OFFER_ANYWAY_MS) → the page offers to hand it to the server. The server replays the SAME
 * request as the signed-in person on its background pool; the page shows elapsed time against
 * the usual time, the Jobs tray carries the run if they leave, and when it is ready the result
 * drops into the page's own query cache — the normal refetch replaces it as usual.
 *
 * A run is remembered per request in sessionStorage, so coming back to the page (or a remount)
 * picks it up instead of offering again.
 */

export interface BackgroundRequest {
  method: 'GET' | 'POST'
  /** API path without the /api prefix, e.g. `/custom-queries/pub-health/execute`. */
  url: string
  body?: unknown
}

export type BackgroundPhase = 'idle' | 'offer' | 'starting' | 'running' | 'done' | 'error'

export interface BackgroundRunView {
  id: string
  status: 'running' | 'completed' | 'error'
  started_at: string
  finished_at: string | null
  expected_ms: number | null
  error: string | null
  result_kept: boolean
}

/** Ask the server about a read once it has been loading this long. */
export const OFFER_AFTER_MS = 2500
/** Offer anyway once a read has been loading this long, known or not. */
export const OFFER_ANYWAY_MS = 8000
const POLL_MS = 4000
const STORE_PREFIX = 'nvr:bgrun:'

export function requestSignature(r: BackgroundRequest): string {
  return `${r.method} ${r.url} ${r.body === undefined ? '' : JSON.stringify(r.body)}`
}

/** Small stable hash for the storage key (the signature itself can be long). */
export function signatureKey(sig: string): string {
  let h = 5381
  for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) | 0
  return `${STORE_PREFIX}${(h >>> 0).toString(36)}:${sig.length}`
}

function remembered(sig: string): string | null {
  try {
    return sessionStorage.getItem(signatureKey(sig))
  } catch {
    return null
  }
}
function remember(sig: string, id: string | null): void {
  try {
    if (id) sessionStorage.setItem(signatureKey(sig), id)
    else sessionStorage.removeItem(signatureKey(sig))
  } catch {
    /* private window: the run still finishes, the page just won't pick it up after a reload */
  }
}

/**
 * Should the page offer a background run yet? `waitedMs` = how long the read has been loading;
 * `estimate` = what the server said (undefined = not asked yet).
 */
export function shouldOffer(
  waitedMs: number,
  estimate: { slow: boolean } | null | undefined
): boolean {
  if (waitedMs >= OFFER_ANYWAY_MS) return true
  return waitedMs >= OFFER_AFTER_MS && !!estimate?.slow
}

/** 0..1 — elapsed against the usual time, held under 95% until the server says it is done. */
export function runProgress(
  elapsedMs: number,
  expectedMs: number | null | undefined
): number | null {
  if (!expectedMs || expectedMs <= 0) return null
  return Math.max(0, Math.min(0.95, elapsedMs / expectedMs))
}

/** "0:14", "1:05", "12:30" */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export interface UseBackgroundRunOptions {
  /** True while the page's own read is still loading. */
  pending: boolean
  /** The read the page is making; null = nothing to offer. */
  request: BackgroundRequest | null
  /** What the person will see in the Jobs tray. */
  label: string
  /** The page's query to fill when the run is ready (setQueryData with `select(body)`). */
  queryKey?: QueryKey
  /** Response body → the query's data. Default: the body itself. */
  select?: (body: unknown) => unknown
  /** For pages that keep the read in their own state: the finished response body. */
  onResult?: (body: unknown) => void
  /** The result was not kept (too big / expired): read again — the route's cache answers. */
  onGone?: () => void
}

export interface UseBackgroundRun {
  phase: BackgroundPhase
  /** The usual duration the server knows, ms. */
  typicalMs: number | null
  run: BackgroundRunView | null
  error: string | null
  start: () => void
}

export function useBackgroundRun(opts: UseBackgroundRunOptions): UseBackgroundRun {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  const sig = opts.request ? requestSignature(opts.request) : null
  const reqRef = useRef(opts)
  reqRef.current = opts

  const [waited, setWaited] = useState(0)
  const [estimate, setEstimate] = useState<{ slow: boolean; typical_ms: number | null } | null>(
    null
  )
  const [run, setRun] = useState<BackgroundRunView | null>(null)
  const [phase, setPhase] = useState<BackgroundPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const asked = useRef<string | null>(null)

  // A different read starts over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the request identity only
  useEffect(() => {
    setWaited(0)
    setEstimate(null)
    setRun(null)
    setError(null)
    setPhase('idle')
    asked.current = null
  }, [sig])

  // How long the read has been loading (only while nothing is running for it).
  useEffect(() => {
    if (!opts.pending || !sig || run) return
    const t0 = Date.now()
    const timer = setInterval(() => setWaited(Date.now() - t0), 500)
    return () => {
      clearInterval(timer)
      setWaited(0)
    }
  }, [opts.pending, sig, run])

  // Once it has waited a moment, ask once whether this read is known to be slow.
  useEffect(() => {
    if (!client || !sig || !opts.request || waited < OFFER_AFTER_MS || asked.current === sig) return
    asked.current = sig
    client
      .request<{ data: { slow: boolean; typical_ms: number | null } }>(
        get('/background-runs/estimate', {
          method: opts.request.method,
          url: opts.request.url
        })
      )
      .then((r) => setEstimate(r.data))
      .catch(() => setEstimate({ slow: false, typical_ms: null }))
  }, [client, sig, waited, opts.request])

  useEffect(() => {
    if (phase !== 'idle' || run || !opts.pending) return
    if (shouldOffer(waited, estimate)) setPhase('offer')
  }, [phase, run, opts.pending, waited, estimate])

  // The page's own read finished first: nothing to offer any more.
  useEffect(() => {
    if (!opts.pending && phase === 'offer') setPhase('idle')
  }, [opts.pending, phase])

  const finish = useCallback(
    async (view: BackgroundRunView) => {
      if (!client || !sig) return
      remember(sig, null)
      if (view.status === 'error') {
        setError(view.error ?? 'The run failed')
        setPhase('error')
        return
      }
      const { queryKey, select, onResult, onGone } = reqRef.current
      try {
        const body = await client.request<unknown>(get(`/background-runs/${view.id}/result`))
        if (queryKey) qc.setQueryData(queryKey, select ? select(body) : body)
        onResult?.(body)
      } catch {
        // Too big to keep, or expired: the route's own cache answers a fresh read.
        if (queryKey) void qc.invalidateQueries({ queryKey })
        onGone?.()
      }
      setPhase('done')
    },
    [client, sig, qc]
  )

  // Pick up a run this page already started (navigated away and back, remount).
  useEffect(() => {
    if (!client || !sig) return
    const id = remembered(sig)
    if (!id) return
    let gone = false
    client
      .request<{ data: BackgroundRunView }>(get(`/background-runs/${id}`))
      .then((r) => {
        if (gone) return
        setRun(r.data)
        if (r.data.status === 'running') setPhase('running')
        else void finish(r.data)
      })
      .catch(() => remember(sig, null))
    return () => {
      gone = true
    }
  }, [client, sig, finish])

  const start = useCallback(() => {
    const { request, label } = reqRef.current
    if (!client || !request || !sig) return
    setPhase('starting')
    setError(null)
    const href =
      typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}` : null
    client
      .request<{ data: BackgroundRunView }>(
        post('/background-runs', {
          method: request.method,
          url: request.url,
          ...(request.body !== undefined ? { body: request.body } : {}),
          label,
          href
        })
      )
      .then((r) => {
        remember(sig, r.data.id)
        setRun(r.data)
        setPhase('running')
      })
      .catch((err: { message?: string }) => {
        setError(err?.message || 'Could not start the run')
        setPhase('error')
      })
  }, [client, sig])

  const runId = run?.id ?? null
  const refresh = useCallback(async () => {
    if (!client || !runId) return
    try {
      const r = await client.request<{ data: BackgroundRunView }>(get(`/background-runs/${runId}`))
      setRun(r.data)
      if (r.data.status !== 'running') await finish(r.data)
    } catch {
      /* the next tick tries again */
    }
  }, [client, runId, finish])
  // Live: the Jobs tray event names the run; the poll is the net under the socket.
  useLiveEvent(
    'job:progress',
    (p: { key?: string; status?: string }) => {
      if (!runId || p?.key !== `bgrun:${runId}`) return
      if (p.status === 'completed' || p.status === 'error') void refresh()
    },
    { includeOwn: true, enabled: !!runId && phase === 'running' }
  )
  useEffect(() => {
    if (!runId || phase !== 'running') return
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [runId, phase, refresh])

  return useMemo(
    () => ({
      phase,
      typicalMs: run?.expected_ms ?? estimate?.typical_ms ?? null,
      run,
      error,
      start
    }),
    [phase, run, estimate, error, start]
  )
}
