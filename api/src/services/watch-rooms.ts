/** Watch rooms that are per tenant in cloud mode (#1132): one tenant's admin never sees another's. */
export const TENANT_SCOPED_WATCH_ROOMS = new Set(['traffic-map', 'ai-calls'])

/** The socket.io room name for a watch room; `store` is the tenant store id (cloud) or null. */
export function watchRoomId(room: string, store: string | null, cloud: boolean): string | null {
  if (!cloud || !TENANT_SCOPED_WATCH_ROOMS.has(room)) return `watch:${room}`
  return store ? `watch:${room}:${store}` : null
}
