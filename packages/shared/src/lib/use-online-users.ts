import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../context'

/**
 * Online-user set for presence dots in user pickers (#284). One shared
 * 30s-polled query per app (react-query dedupes); consumers get a Set of
 * user ids. Fails to an empty set — a picker must never break on presence.
 */
export function useOnlineUsers(enabled = true): Set<string> {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-online-users'],
    queryFn: async () => {
      const res = (await client.request({
        method: 'GET',
        path: '/presence/online'
      } as any)) as any
      const rows: any[] = res?.data ?? res ?? []
      return rows.map((r) => String(r.user_id ?? r.id ?? '').toUpperCase()).filter(Boolean)
    },
    enabled,
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: false
  })
  return new Set(data ?? [])
}
