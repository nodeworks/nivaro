import { readOnlinePresence } from '@nivaro/sdk'
import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../context'
import { usePresenceOnlinePoll } from './presence-live'

/**
 * Online-user set for presence dots in user pickers (#284); consumers get a
 * Set of upper-cased user ids. Shares the chat's ['presence-online'] entry —
 * same endpoint, same client, same raw `{ data, config }` body, narrowed here
 * with `select` — so a page with chat and pickers holds one presence read.
 * Fails to an empty set — a picker must never break on presence.
 */
export function useOnlineUsers(enabled = true): Set<string> {
  const client = useNivaroClient()
  // presence:changed refreshes the shared entry (one listener per tab); the poll is a backstop.
  const poll = usePresenceOnlinePoll(30_000, enabled)
  const { data } = useQuery({
    queryKey: ['presence-online'],
    queryFn: () => client.request(readOnlinePresence()),
    select: (res) =>
      (res?.data ?? []).map((r) => String(r.user_id ?? '').toUpperCase()).filter(Boolean),
    enabled,
    refetchInterval: poll,
    staleTime: 25_000,
    retry: false
  })
  return new Set(data ?? [])
}

export type PresenceState = 'online' | 'idle'

/**
 * Who is online right now AND whether they are idle or set to away, from the same shared
 * ['presence-online'] read (one request per tab). The server already answers per viewer — only
 * people this viewer may see as present are in it — so a person missing here simply has no dot.
 * Used for the dot beside a name in people pickers and the mention list (rt4 #22): a dot only,
 * never a reason to reorder a list. Upper-cased user id → state.
 */
export function usePresenceStates(enabled = true): Map<string, PresenceState> {
  const client = useNivaroClient()
  const poll = usePresenceOnlinePoll(30_000, enabled)
  const { data } = useQuery({
    queryKey: ['presence-online'],
    queryFn: () => client.request(readOnlinePresence()),
    select: (res) => {
      const m = new Map<string, PresenceState>()
      for (const r of (res?.data ?? []) as Array<{
        user_id?: unknown
        is_idle?: boolean
        away?: boolean
      }>) {
        const id = String(r.user_id ?? '').toUpperCase()
        if (id) m.set(id, r.is_idle || r.away ? 'idle' : 'online')
      }
      return m
    },
    enabled,
    refetchInterval: poll,
    staleTime: 25_000,
    retry: false
  })
  return data ?? EMPTY
}

const EMPTY: Map<string, PresenceState> = new Map()
