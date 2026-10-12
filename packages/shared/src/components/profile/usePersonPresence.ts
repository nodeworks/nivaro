import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { useLiveEvent } from '../../lib/live'
import { prettyPagePath } from '../../lib/presence-state'
import { PERSON_PROFILE_KEY } from './types'

interface OnlineRow {
  user_id: string
  page?: string | null
  current_path?: string | null
}

/**
 * Where someone is right now, for the people page (#1982). The state (online, idle, away)
 * rides the profile; this adds the page from the same read the chat Online list uses, so
 * the page shows under the same visibility rules and the same configured fields, and
 * refreshes the moment the server says that person's presence moved.
 */
export function usePersonPresence(userId: string | null | undefined): { page: string | null } {
  const client = useNivaroClient()
  const qc = useQueryClient()
  useLiveEvent(
    'presence:changed',
    () => {
      void qc.invalidateQueries({ queryKey: [PERSON_PROFILE_KEY, userId] })
      void qc.invalidateQueries({ queryKey: ['presence-online'] })
    },
    {
      enabled: !!userId,
      debounceMs: 500,
      includeOwn: true,
      match: (p) => String(p?.user_id ?? '').toUpperCase() === String(userId ?? '').toUpperCase()
    }
  )
  const { data } = useQuery({
    queryKey: ['presence-online'],
    queryFn: () =>
      client.request<{ data: OnlineRow[]; config?: { fields?: string[] } }>(
        get('/presence/online')
      ),
    enabled: !!userId,
    refetchInterval: 15_000,
    staleTime: 5_000
  })
  const row = data?.data?.find(
    (r) => String(r.user_id).toUpperCase() === String(userId ?? '').toUpperCase()
  )
  const showPage = (data?.config?.fields ?? ['role', 'page']).includes('page')
  return { page: row && showPage ? (row.page ?? prettyPagePath(row.current_path)) : null }
}

interface CardRow extends OnlineRow {
  away?: boolean
  is_idle?: boolean
  idle_minutes?: number | null
}

/**
 * Presence for a user card (#1982): active, idle or away plus the current page, from the same
 * `/presence/online` read — so a card never shows more than the chat Online list does. Reads
 * only while the card is open. `word` is null when the person is not on the list.
 */
export function useCardPresence(
  userId: string | null | undefined,
  enabled: boolean
): { word: 'online' | 'idle' | 'away' | null; page: string | null; minutes: number | null } {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['presence-online'],
    queryFn: () =>
      client.request<{ data: CardRow[]; config?: { fields?: string[] } }>(get('/presence/online')),
    enabled: enabled && !!userId,
    refetchInterval: enabled ? 15_000 : false,
    staleTime: 5_000
  })
  const row = data?.data?.find(
    (r) => String(r.user_id).toUpperCase() === String(userId ?? '').toUpperCase()
  )
  if (!row) return { word: null, page: null, minutes: null }
  const showPage = (data?.config?.fields ?? ['role', 'page']).includes('page')
  return {
    word: row.away ? 'away' : row.is_idle ? 'idle' : 'online',
    page: showPage ? (row.page ?? prettyPagePath(row.current_path)) : null,
    minutes: row.idle_minutes ?? null
  }
}
