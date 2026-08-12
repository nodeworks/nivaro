import { io, type Socket } from 'socket.io-client'
import { api } from '@/lib/api'

/**
 * One shared authenticated socket for chat + collection feeds. The admin's
 * older features (notification bell, page presence) each open their own
 * socket — this module is the go-forward shared instance; new features should
 * use it rather than adding another `io()` call.
 *
 * Nivaro contract: emit `auth {token}` after connect, join collection rooms
 * via `join 'collection:<name>'`, chat rooms via `chat:join {room}` (gated
 * server-side by the same visibility check as the REST routes). Session-cookie
 * users mint a one-time ws token via GET /auth/ws-token on every (re)connect.
 */

const API_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3055'

let socket: Socket | null = null
const joinedCollections = new Set<string>()

async function authToken(): Promise<string | null> {
  try {
    const r = await api.get<{ data?: { token?: string }; token?: string }>('/auth/ws-token')
    return r.data.data?.token ?? r.data.token ?? null
  } catch {
    return null
  }
}

export function getSocket(): Socket {
  if (socket) return socket
  socket = io(API_URL, {
    transports: ['websocket', 'polling'],
    withCredentials: true,
    reconnection: true,
    reconnectionDelay: 2000
  })
  socket.on('connect', () => {
    void authToken().then((token) => {
      if (token) socket?.emit('auth', { token })
    })
  })
  socket.on('auth:ok', () => {
    for (const room of joinedCollections) socket?.emit('join', room)
  })
  return socket
}

/** Subscribe to live updates for a collection; returns an unsubscribe. */
export function onCollectionUpdate(
  collection: string,
  handler: (payload?: { collection?: string; item?: string | number }) => void
): () => void {
  const s = getSocket()
  const room = `collection:${collection}`
  joinedCollections.add(room)
  if (s.connected) s.emit('join', room)
  const listener = (payload: { collection?: string; item?: string | number }) => {
    if (payload?.collection === collection) handler(payload)
  }
  s.on('collection:update', listener)
  return () => {
    s.off('collection:update', listener)
  }
}

/**
 * Chat delivery. The server emits `chat:message` only to `chat:<room>`, and
 * joining one is gated server-side by the room-visibility check — so this
 * subscribes per room rather than listening to every chat_messages write.
 */
export function subscribeChatRooms<T>(rooms: string[], handler: (msg: T) => void): () => void {
  const s = getSocket()
  const joinAll = () => {
    for (const room of rooms) s.emit('chat:join', { room })
  }
  if (s.connected) joinAll()
  s.on('auth:ok', joinAll)
  const listener = (payload: unknown) => handler(payload as T)
  s.on('chat:message', listener)
  return () => {
    for (const room of rooms) s.emit('chat:leave', { room })
    s.off('chat:message', listener)
    s.off('auth:ok', joinAll)
  }
}
