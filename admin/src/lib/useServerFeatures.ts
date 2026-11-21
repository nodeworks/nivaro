import { type DataTag, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { api } from './api'

/**
 * The features this server says it has: GET /api/app-info `features` (public; the
 * server adds 'hub' in hub mode). Nav entries and hubs that name a `feature` are shown
 * only when it is listed here.
 *
 * Its own key (one key = one shape, packages/shared lib/query-keys.ts): this entry stores
 * the `features` list only, never the whole app-info body.
 */
export const serverFeaturesKey = () =>
  ['server-features'] as unknown as DataTag<readonly ['server-features'], string[]>

const EMPTY: string[] = []

export function useServerFeaturesQuery() {
  return useQuery({
    queryKey: serverFeaturesKey(),
    queryFn: () =>
      api.get<{ features?: unknown }>('/app-info').then((r) => {
        const list = r.data?.features
        return Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string') : []
      }),
    staleTime: 5 * 60_000
  })
}

export function useServerFeatures(): Set<string> {
  const { data } = useServerFeaturesQuery()
  const list = data ?? EMPTY
  return useMemo(() => new Set(list), [list])
}
