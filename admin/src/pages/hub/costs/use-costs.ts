import { useLiveOps } from '@nivaro/shared'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/lib/auth'
import {
  costKeys,
  estimateCreate,
  estimateProvider,
  estimateStack,
  fetchLiveCosts,
  type LiveCosts,
  type LiveSeries,
  type ProviderEstimateBody
} from './cost-api'

/** How long a form waits after the last keystroke before asking for a new figure. */
export const ESTIMATE_DEBOUNCE_MS = 400

/** `value`, settled for `ms` (the same reference until it changes; compared as JSON). */
export function useDebounced<T>(value: T, ms = ESTIMATE_DEBOUNCE_MS): T {
  const json = JSON.stringify(value)
  const [settled, setSettled] = useState(value)
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the JSON, not the object
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [json, ms])
  return settled
}

const ESTIMATE_STALE_MS = 60_000

/**
 * A provider resource's estimate while its form is open: asked 400 ms after the last change,
 * the last figure kept while the next one loads (`isPlaceholderData`). null body = do not ask.
 */
export function useProviderEstimate(body: ProviderEstimateBody | null) {
  const settled = useDebounced(body)
  return useQuery({
    queryKey: costKeys.estimate('provider', settled),
    queryFn: ({ signal }) => estimateProvider(settled as ProviderEstimateBody, signal),
    enabled: settled != null,
    placeholderData: keepPreviousData,
    staleTime: ESTIMATE_STALE_MS,
    retry: false
  })
}

export function useStackEstimate(envId: number, body: { size?: string } | null) {
  const settled = useDebounced(body)
  return useQuery({
    queryKey: costKeys.estimate(`stack-${envId}`, settled),
    queryFn: ({ signal }) => estimateStack(envId, settled ?? {}, signal),
    enabled: settled != null,
    placeholderData: keepPreviousData,
    staleTime: ESTIMATE_STALE_MS,
    retry: false
  })
}

export function useCreateEstimate(body: unknown | null) {
  const settled = useDebounced(body)
  return useQuery({
    queryKey: costKeys.estimate('create', settled),
    queryFn: ({ signal }) => estimateCreate(settled, signal),
    enabled: settled != null,
    placeholderData: keepPreviousData,
    staleTime: ESTIMATE_STALE_MS,
    retry: false
  })
}

/**
 * The live run-rate (GET /costs/live): one app, or every app the caller may see (null). The
 * `hub:costs` topic re-reads it after each run-rate sample (every 15 minutes), no reload.
 */
export function useLiveCosts(appId: number | null, opts: { enabled?: boolean } = {}) {
  const { user } = useAuth()
  const enabled = opts.enabled !== false && !!user
  useCostsLiveSync(enabled)
  return useQuery({
    queryKey: costKeys.live(appId),
    queryFn: () => fetchLiveCosts(appId),
    enabled,
    staleTime: 60_000,
    retry: false
  })
}

/** Re-read every live cost figure on screen when the Hub writes a run-rate sample. */
export function useCostsLiveSync(enabled = true): void {
  const qc = useQueryClient()
  const refresh = useCallback(() => {
    void qc.invalidateQueries({
      predicate: (q) => q.queryKey[0] === 'hub-costs' && q.queryKey[1] === 'live',
      refetchType: 'active'
    })
  }, [qc])
  useLiveOps('hub:costs', refresh, { enabled, debounceMs: 1000 })
}

/** The run-rate of one resource in a live answer, or null when it has no row. */
export function resourceSeries(live: LiveCosts | undefined, resourceId: number): LiveSeries | null {
  return live?.series.find((s) => s.kind === 'resource' && s.resource_id === resourceId) ?? null
}

/** An environment's run-rate in a live answer (its stack + its resources), null with no rows. */
export function environmentNow(
  live: LiveCosts | undefined,
  envId: number
): { nowCents: number; unknown: number } | null {
  const rows = live?.series.filter((s) => s.environment_id === envId) ?? []
  if (!rows.length) return null
  return {
    nowCents: rows.reduce((n, s) => n + s.nowCents, 0),
    unknown: rows.filter((s) => s.confidence === 'unknown').length
  }
}
