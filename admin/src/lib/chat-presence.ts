import { createNivaro, readOnlinePresence } from '@nivaro/sdk'
import {
  idleState,
  onIdleChange,
  PRESENCE_ONLINE_KEY,
  trackActivity,
  usePresenceOnlinePoll
} from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useLocation } from 'react-router'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { getSocket } from '@/lib/socket'

/**
 * Chat presence: this tab writes its own `user_presence` row (heartbeat every 25 s) and reads
 * who is online from GET /presence/online — the server's shared, cached answer, never the raw
 * table. Distinct from the socket-based page presence (`use-page-presence.ts`, the admin
 * journey feed): this one is what the chat Online tab and typing indicators read.
 */

/** The SDK client the admin chat surfaces share (team-chat's NivaroProvider uses it too). */
export const chatClient = createNivaro(
  typeof window !== 'undefined' ? window.location.origin : '',
  {
    timeoutMs: 90_000
  }
)

const HEARTBEAT_MS = 25_000

/** A /presence/online row, as the chat surfaces read it. */
export interface OnlineUser {
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
    // 'API' — what people call this console. Headless frontends send nothing,
    // so the ordinary case stays unlabelled.
    app: 'API',
    // Re-asserted every beat: the socket's disconnect bookkeeping is
    // per-process, so a server restart strands is_online=false/true bits —
    // a live tab must keep saying so itself.
    is_online: true,
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
    // Clean exits flip offline INSTANTLY: keepalive survives page teardown,
    // and the server treats is_online=false as gone even inside the window.
    const goOffline = () => {
      if (presenceRowId == null) return
      try {
        void fetch(`/api/items/user_presence/${presenceRowId}`, {
          method: 'PATCH',
          keepalive: true,
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ is_online: false, is_idle: true })
        })
      } catch {
        // The 70s window still catches it.
      }
    }
    if (!user) return
    window.addEventListener('pagehide', goOffline)
    const name =
      [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email || 'Unknown'
    void beat(user.id, name, pathname, roleName)
    const t = setInterval(
      () => void beat(user.id, name, window.location.pathname, roleName),
      HEARTBEAT_MS
    )
    return () => {
      clearInterval(t)
      window.removeEventListener('pagehide', goOffline)
    }
  }, [user, pathname, roleName])
}

export function useOnlineUsers(): { users: OnlineUser[]; loading: boolean } {
  const { user } = useAuth()
  // One presence:changed listener per tab (packages/shared presence-live.ts): your own change
  // refreshes at once, anyone else's at most every 10–12 s per tab; the poll is a backstop.
  // The list used to read /items/user_presence and refetch on every user_presence row update,
  // so every heartbeat made every open admin tab scan the table — those reads deadlocked with
  // the heartbeat writes under load (staging load test 2026-10-24: 500s, one web pool 20/20).
  const poll = usePresenceOnlinePoll(HEARTBEAT_MS)
  // ['presence-online'] holds the raw { data, config } body, shared with ChatPanel's reader.
  const { data, isLoading } = useQuery({
    queryKey: [...PRESENCE_ONLINE_KEY],
    queryFn: () => chatClient.request(readOnlinePresence()),
    refetchInterval: poll,
    staleTime: 2_000
  })
  const users = ((data?.data ?? []) as unknown as OnlineUser[]).filter(
    (u) => u.user_id?.toLowerCase() !== user?.id?.toLowerCase()
  )
  return { users, loading: isLoading }
}
