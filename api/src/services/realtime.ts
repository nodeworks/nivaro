import type { Server as SocketIOServer } from 'socket.io'
import { journaledEmit } from './event-journal.js'
import { publishSseEvent } from './sse-hub.js'

/**
 * Best-effort broadcast that a record in `collection` changed. Consumers join
 * `collection:${collection}` rooms and react — this function has no knowledge
 * of queues or any other specific consumer.
 *
 * Surgical patches (#267): the payload may carry `action` and `changed_fields`
 * (NAMES only, never values — broadcasting values would side-channel past
 * field permissions/RLS, the documented reason the payload stays minimal).
 * Clients that want the new data fetch the ONE row through /items, where
 * RBAC applies. Events ride the journal (#266) so reconnects can replay.
 */
export function broadcastCollectionUpdate(
  io: SocketIOServer | undefined,
  collection: string,
  item: string | number,
  extra?: { action?: 'create' | 'update' | 'delete'; changed_fields?: string[] }
): void {
  void io // kept for signature compat — journaledEmit resolves io globally
  // SSE mirror (#602): /events/stream consumers get the same minimal payload.
  publishSseEvent({ collection, item, action: extra?.action, changed_fields: extra?.changed_fields?.slice(0, 50) })
  void journaledEmit(`collection:${collection}`, 'collection:update', {
    collection,
    item,
    ...(extra?.action ? { action: extra.action } : {}),
    ...(extra?.changed_fields?.length
      ? { changed_fields: extra.changed_fields.slice(0, 50) }
      : {})
  })
}
