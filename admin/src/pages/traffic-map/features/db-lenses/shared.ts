import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useTrafficMap } from '../../context'
import type { TrafficModel } from '../../model'

/**
 * Plumbing the database lenses share: one admin read of a `/traffic-map/db-lens/*` route that
 * refreshes while the page is live, and the newest frame value a tap sent.
 */
export function useDbLens<T>(
  path: string,
  opts: { params?: Record<string, string | number>; every?: number; enabled?: boolean } = {}
): { data: T | null; loading: boolean; error: boolean; refetch: () => void } {
  const { paused, ready } = useTrafficMap()
  const q = useQuery({
    queryKey: ['traffic-map', 'db-lens', path, opts.params ?? null],
    queryFn: async () => {
      const res = await api.get(`/traffic-map/db-lens/${path}`, { params: opts.params })
      return ((res?.data as { data?: T })?.data ?? null) as T | null
    },
    enabled: ready && opts.enabled !== false,
    refetchInterval: paused ? false : (opts.every ?? 10_000),
    staleTime: Math.max(1000, (opts.every ?? 10_000) - 1000)
  })
  return {
    data: q.data ?? null,
    loading: q.isLoading,
    error: q.isError,
    refetch: () => void q.refetch()
  }
}

/** The newest value tap `tapId` sent in a frame within `maxAgeS` seconds of the model's clock. */
export function latestFrameValue<T>(m: TrafficModel, tapId: string, maxAgeS: number): T | null {
  const log = m.frameExtLog ?? []
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]
    if (m.now - e.sec > maxAgeS) break
    const v = e.ext?.[tapId]
    if (v !== undefined) return v as T
  }
  return null
}
