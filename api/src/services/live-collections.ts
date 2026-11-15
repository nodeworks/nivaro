import { splitTenantRoom } from './socket-transport.js'

/**
 * The collections someone is watching live right now, from socket room names: a list or queue
 * subscribed to `collection:<c>`, an open record sitting in `record:<c>:<id>`. Background
 * passes that only matter to an open page (the SLA flip pass, services/sla-flips.ts) use it to
 * skip collections nobody has on screen. Tenant prefixes are dropped (self-hosted only).
 */
export function liveCollectionsFrom(rooms: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const scoped of rooms) {
    const room = splitTenantRoom(scoped).room
    if (room.startsWith('collection:')) {
      const c = room.slice('collection:'.length)
      if (c) out.add(c)
      continue
    }
    const m = /^record:(.+):[^:]+$/.exec(room)
    if (m?.[1]) out.add(m[1])
  }
  return out
}
