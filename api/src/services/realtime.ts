import type { Server as SocketIOServer } from 'socket.io'
import { journaledEmit } from './event-journal.js'
import { publishItemEvent } from './item-events.js'
import { publishSseEvent } from './sse-hub.js'
import { noteCollectionChanged } from './traffic-actions/temp-cache.js'
import { noteWrite } from './traffic-map.js'
import { currentTrafficSource } from './traffic-source.js'

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
  extra?: {
    action?: 'create' | 'update' | 'delete'
    changed_fields?: string[]
    /** #1875 — 'raw' when a procedure, import or script made the write; 'import' (#1826)
     *  when a staged import run wrote it through the items service. */
    source?: 'raw' | 'import'
    /** #1875 — with item '*': how many records the raw write touched. */
    bulk?: number
  }
): void {
  void io // kept for signature compat — journaledEmit resolves io globally
  // #2273 — a Traffic Map temporary cache on this collection (or one related to it) drops its
  // answers now, before anyone can read the old ones (other replicas hear the record event).
  noteCollectionChanged(collection)
  if (extra?.action) {
    noteWrite({
      collection,
      item,
      action: extra.action,
      changedFields: extra.changed_fields?.slice(0, 50) ?? [],
      at: Date.now()
    })
  }
  // SSE mirror (#602): /events/stream consumers get the same minimal payload.
  publishSseEvent({
    collection,
    item,
    action: extra?.action,
    changed_fields: extra?.changed_fields?.slice(0, 50)
  })
  // #1826 — a staged import run writing through the items service says so, so a form open on
  // the record can warn "an import is updating this record" instead of looking like a person.
  const source = extra?.source ?? (currentTrafficSource()?.kind === 'import' ? 'import' : undefined)
  const journaled = journaledEmit(`collection:${collection}`, 'collection:update', {
    collection,
    item,
    ...(extra?.action ? { action: extra.action } : {}),
    ...(extra?.changed_fields?.length ? { changed_fields: extra.changed_fields.slice(0, 50) } : {}),
    ...(source ? { source } : {}),
    ...(extra?.bulk != null ? { bulk: extra.bulk } : {})
  })
  // GraphQL subscriptions hear the same minimal event, once it has its journal position: the
  // SSE transport sends that as the event id, so a reconnect resumes from it (#1749).
  if (extra?.action) {
    const ev = {
      collection,
      item: String(item),
      action: extra.action,
      changed_fields: extra.changed_fields?.slice(0, 50) ?? []
    }
    void journaled.then(
      (r) => publishItemEvent(r.seq == null ? ev : { ...ev, seq: r.seq }),
      () => publishItemEvent(ev)
    )
  }
}
