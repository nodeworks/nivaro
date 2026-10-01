import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useTrafficMap } from '../context'
import { callerLabel } from '../EventTicker'

/**
 * Display names for caller keys: the catalog first, then GET /traffic-map/people for person keys
 * (`u<ID>`) the catalog has not met (someone who exported but never called the API this
 * session, a person picked to follow).
 */
export function usePeopleNames(keys: string[]): (key: string) => string {
  const { catalog } = useTrafficMap()
  const missing = [...new Set(keys)]
    .filter((k) => /^u[0-9A-Fa-f-]{36}$/.test(k) && !catalog?.callers[k])
    .sort()
    .slice(0, 50)
  const q = useQuery({
    queryKey: ['traffic-map', 'people', missing.join(',')],
    queryFn: async () => {
      const res = await api.get(`/traffic-map/people?ids=${encodeURIComponent(missing.join(','))}`)
      return (res.data.data ?? {}) as Record<string, string>
    },
    enabled: missing.length > 0,
    staleTime: 300_000
  })
  return (key) => catalog?.callers[key]?.label ?? q.data?.[key] ?? callerLabel(catalog, key)
}
