// api/src/services/traffic-map-presence.ts
/**
 * #1164 — other admins on the Traffic Map. Stateless on the server: a page that watches the map
 * says "I am here, this is what I have selected" (`traffic-map:presence`) every few seconds and on
 * every selection change; the server stamps WHO said it (the socket's authenticated person — never
 * trusted from the payload) and repeats it to the Traffic Map watch room only. Every viewer keeps a
 * short-lived list; a socket that leaves the room or disconnects is announced gone.
 *
 * The watch room is per tenant in cloud mode (`watch:traffic-map:<store>`), and a socket only
 * speaks into the room it actually joined (admin:join checked admin_access), so a selection never
 * leaves its tenant. Works across API nodes through the Redis adapter.
 */
import type { Socket, Server as SocketIOServer } from 'socket.io'
import { socketUserOf } from '../plugins/socketio.js'

export const PRESENCE_EVENT = 'traffic-map:presence'
export const BYE_EVENT = 'traffic-map:bye'
export const VIEWER_EVENT = 'traffic-map:viewer'
const SEL_KINDS = new Set(['entity', 'lane', 'caller', 'down'])
const TAB_RE = /^[A-Za-z0-9_-]{4,40}$/

export interface PresenceSelection {
  kind: string
  id: string
}

/** The Traffic Map watch room this socket joined, or null (not an admin / not watching). */
export function trafficRoomOf(rooms: Iterable<string>): string | null {
  for (const r of rooms)
    if (r === 'watch:traffic-map' || r.startsWith('watch:traffic-map:')) return r
  return null
}

/** A selection from the (untrusted) payload, or null. */
export function cleanSelection(raw: unknown): PresenceSelection | null {
  const s = raw as { kind?: unknown; id?: unknown } | null
  if (!s || typeof s !== 'object') return null
  if (typeof s.kind !== 'string' || !SEL_KINDS.has(s.kind)) return null
  if (typeof s.id !== 'string' || !s.id || s.id.length > 200) return null
  return { kind: s.kind, id: s.id }
}

export function attachTrafficPresence(io: SocketIOServer): void {
  io.on('connection', (socket: Socket) => {
    const announce = (payload: Record<string, unknown>) => {
      const room = trafficRoomOf(socket.rooms)
      if (!room) return null
      io.to(room).emit(VIEWER_EVENT, { sid: socket.id, ...payload, at: Date.now() })
      return room
    }
    socket.on(PRESENCE_EVENT, (p: { tab?: unknown; selection?: unknown }) => {
      const user = socketUserOf(socket.id)
      if (!user) return
      const tab = typeof p?.tab === 'string' && TAB_RE.test(p.tab) ? p.tab : null
      if (!tab) return
      announce({
        tab,
        user: { id: user.id, name: user.name },
        selection: cleanSelection(p?.selection)
      })
    })
    socket.on(BYE_EVENT, (p: { tab?: unknown }) => {
      const tab = typeof p?.tab === 'string' && TAB_RE.test(p.tab) ? p.tab : null
      if (tab) announce({ tab, gone: true })
    })
    // rooms are still readable while disconnecting (they are gone at 'disconnect')
    socket.on('disconnecting', () => {
      announce({ gone: true })
    })
  })
}
