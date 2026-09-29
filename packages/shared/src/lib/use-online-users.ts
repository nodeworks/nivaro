import { readOnlinePresence } from '@nivaro/sdk'
import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../context'

/**
 * Online-user set for presence dots in user pickers (#284); consumers get a
 * Set of upper-cased user ids. Shares the chat's ['presence-online'] entry —
 * same endpoint, same client, same raw `{ data, config }` body, narrowed here
 * with `select` — so a page with chat and pickers holds one presence read.
 * Fails to an empty set — a picker must never break on presence.
 */
export function useOnlineUsers(enabled = true): Set<string> {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['presence-online'],
    queryFn: () => client.request(readOnlinePresence()),
    select: (res) =>
      (res?.data ?? []).map((r) => String(r.user_id ?? '').toUpperCase()).filter(Boolean),
    enabled,
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: false
  })
  return new Set(data ?? [])
}
