import { type DrillWindow, DRILL_WINDOWS_KEY } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

export { DrillTag } from '@nivaro/shared'

/**
 * Drill windows (#2847) for admin pages outside a NivaroProvider — same key and shape as the
 * shared `useDrillWindows`, so both read one cache entry. Non-operators (403) get none.
 */
export function useAdminDrillWindows(): DrillWindow[] {
  const { data } = useQuery<DrillWindow[]>({
    queryKey: DRILL_WINDOWS_KEY,
    queryFn: () =>
      api
        .get('/chaos/drill-windows')
        .then((r) => (r.data.data ?? []) as DrillWindow[])
        .catch(() => []),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false
  })
  return data ?? []
}
