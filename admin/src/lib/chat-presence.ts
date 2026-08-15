import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useLocation } from 'react-router'
import { idleState, onIdleChange, trackActivity } from '@nivaro/shared'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { getSocket, onCollectionUpdate } from '@/lib/socket'

/**
 * Chat presence rides the `user_presence` collection (upserted heartbeat every
 * 30 s), read back with a 5-minute online window — the same model efp-new
 * uses, pure /items so RBAC + live collection:update apply. Distinct from the
 * socket-based page presence (`use-page-presence.ts`, the admin journey feed):
 * this one is what the chat Online tab and typing indicators read.
 */

const HEARTBEAT_MS = 30_000
const ONLINE_WINDOW_MS = 5 * 60_000

export interface OnlineUser {
  id: number
  user_id: string
  display_name: string | null
  role_name: string | null
  current_path: string | null
  last_seen: string
  typing_room?: string | null
  is_idle?: boolean
  last_active?: string | null
}

let presenceRowId: number | null = null


// Idle tracking lives in @nivaro/shared so every host that writes presence
// reports it the same way — admin having its own copy is why a row marked idle
// here never cleared from the other app.
trackActivity()

// Push the flip down the socket the moment it happens — the HTTP heartbeat
// below stays as the fallback for when the socket is not connected, but it is
// no longer what decides how quickly someone reads as back.
onIdleChange((idle) => {
  try {
    getSocket()?.emit('presence:idle', { idle })
  } catch {
    // The heartbeat still carries it.
  }
})

async function findPresenceRow(userId: string): Promise<number | null> {
  const filter = encodeURIComponent(JSON.stringify({ user_id: { _eq: userId } }))
  const res = await api.get<{ data: Array<{ id: number }> }>(
    `/items/user_presence?limit=1&filter=${filter}`
  )
  return res.data.data?.[0]?.id ?? null
}

let beatInFlight = false

async function beat(userId: string, name: string, path: string, roleName: string | null) {
  if (beatInFlight) return
  beatInFlight = true
  const payload = {
    user_id: userId,
    display_name: name,
    current_path: path,
    // Written on every heartbeat so a stale value self-heals (legacy rows can
    // hold a role UUID here, which rendered as the user's subtitle).
    role_name: roleName,
    last_seen: new Date().toISOString(),
    // Names the admin console specifically. efp-new sends nothing, so the
    // ordinary case stays unlabelled.
    app: 'Nivaro',
    ...idleState()
  }
  try {
    presenceRowId ??= await findPresenceRow(userId)
    if (presenceRowId != null) {
      await api.patch(`/items/user_presence/${presenceRowId}`, payload)
    } else {
      try {
        const created = await api.post<{ data: { id: number } }>('/items/user_presence', payload)
        presenceRowId = created.data.data?.id ?? null
      } catch {
        // user_presence has UNIQUE(user_id) — a concurrent beat (StrictMode
        // double-invoke, second tab) can win the insert race. Re-find + PATCH.
        presenceRowId = await findPresenceRow(userId)
        if (presenceRowId != null) await api.patch(`/items/user_presence/${presenceRowId}`, payload)
      }
    }
  } catch {
    // Presence must never break the app.
  } finally {
    beatInFlight = false
  }
}

/** Write my typing state onto my presence row. PATCH-only — if the heartbeat
 *  hasn't created the row yet there is nothing to mark. */
export async function setTypingRoom(userId: string, typingRoom: string | null) {
  try {
    presenceRowId ??= await findPresenceRow(userId)
    if (presenceRowId == null) return
    await api.patch(`/items/user_presence/${presenceRowId}`, { typing_room: typingRoom })
  } catch {
    // Typing state must never break the app.
  }
}

/** Refresh the online list the moment the server says presence moved. */
export function usePresenceLive() {
  const qc = useQueryClient()
  useEffect(() => {
    const s = getSocket()
    const onChanged = () => void qc.invalidateQueries({ queryKey: ['admin-online-users'] })
    s.on('presence:changed', onChanged)
    return () => {
      s.off('presence:changed', onChanged)
    }
  }, [qc])
}

export function usePresenceHeartbeat() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  // /api/roles is admin-only; the chat route's own lightweight list is
  // readable by anyone, so non-admin admin-UI users still get a role label.
  const { data: roles } = useQuery({
    queryKey: ['admin-chat-roles'],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: string; name: string }> }>('/chat/roles')
        .then((r) => r.data.data ?? []),
    enabled: !!user,
    staleTime: 5 * 60_000
  })
  const roleName =
    roles?.find((r) => r.id?.toLowerCase() === user?.role?.toLowerCase())?.name ?? null

  useEffect(() => {
    if (!user) return
    const name =
      [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email || 'Unknown'
    void beat(user.id, name, pathname, roleName)
    const t = setInterval(
      () => void beat(user.id, name, window.location.pathname, roleName),
      HEARTBEAT_MS
    )
    return () => clearInterval(t)
  }, [user, pathname, roleName])
}

export function useOnlineUsers(): { users: OnlineUser[]; loading: boolean } {
  const { user } = useAuth()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['admin-online-users'],
    queryFn: async () => {
      const since = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString()
      const filter = encodeURIComponent(JSON.stringify({ last_seen: { _gte: since } }))
      const res = await api.get<{ data: OnlineUser[] }>(
        `/items/user_presence?limit=200&sort=-last_seen&filter=${filter}`
      )
      return res.data.data ?? []
    },
    // The server broadcasts presence:changed on every connect, disconnect and
    // idle flip, so this poll is only a backstop for a dropped socket rather
    // than how the list keeps up.
    refetchInterval: HEARTBEAT_MS,
    staleTime: 2_000
  })
  useEffect(
    () =>
      onCollectionUpdate('user_presence', () =>
        qc.invalidateQueries({ queryKey: ['admin-online-users'] })
      ),
    [qc]
  )
  const users = (data ?? []).filter((u) => u.user_id?.toLowerCase() !== user?.id?.toLowerCase())
  return { users, loading: isLoading }
}
