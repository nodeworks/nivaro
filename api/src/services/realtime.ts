import type { Server as SocketIOServer } from 'socket.io'
import {
  isQuietPresenceWrite,
  type LiveMode,
  liveModeNow,
  liveModeOf,
  noteLiveSuppressed,
  queueBatched
} from './collection-live-mode.js'
import { type EmitResult, journaledEmit } from './event-journal.js'
import { publishCollectionTouched, publishItemEvent } from './item-events.js'
import { noteCollectionWrite, readCachesActive } from './read-caches.js'
import { publishSseEvent } from './sse-hub.js'
import { noteCollectionChanged, tempCacheActive } from './traffic-actions/temp-cache.js'
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
 *
 * Known and accepted (security audit 2026-10-27, Low): a `collection:<name>` room is gated by
 * collection read permission only, so a member narrowed by a row filter or User Scopes still
 * hears the id and the changed field NAMES of rows outside their scope (never values; reading
 * the row answers 404). Routing every event per record per viewer would cost a permission
 * query per socket per write. Anything that must not reveal even a row's existence belongs in
 * a record room (`record:<collection>:<id>`, joined through canSeeRecordRoom), not here.
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
  // #2443 / #2444 — cached list totals and display-label rows of this collection go too.
  noteCollectionWrite(collection)
  if (extra?.action) {
    noteWrite({
      collection,
      item,
      action: extra.action,
      changedFields: extra.changed_fields?.slice(0, 50) ?? [],
      at: Date.now()
    })
  }
  // #1826 — a staged import run writing through the items service says so, so a form open on
  // the record can warn "an import is updating this record" instead of looking like a person.
  const source = extra?.source ?? (currentTrafficSource()?.kind === 'import' ? 'import' : undefined)
  const payload = {
    collection,
    item,
    ...(extra?.action ? { action: extra.action } : {}),
    ...(extra?.changed_fields?.length ? { changed_fields: extra.changed_fields.slice(0, 50) } : {}),
    ...(source ? { source } : {}),
    ...(extra?.bulk != null ? { bulk: extra.bulk } : {})
  }
  // #2490 — the collection's realtime switch: every write live (default), one batched id list
  // per window, or nothing live at all (lists on it poll).
  const deliver = (mode: LiveMode): Promise<EmitResult | null> => {
    if (mode === 'off') {
      noteLiveSuppressed()
      return Promise.resolve(null)
    }
    // SSE mirror (#602): /events/stream consumers get the same minimal payload.
    publishSseEvent({
      collection,
      item,
      action: extra?.action,
      changed_fields: extra?.changed_fields?.slice(0, 50)
    })
    if (mode === 'batched') {
      queueBatched(collection, payload)
      return Promise.resolve(null)
    }
    return journaledEmit(`collection:${collection}`, 'collection:update', payload)
  }
  // Not read yet in this process: this write goes out live as before while the mode loads.
  // A presence heartbeat is `off` whatever the collection says (presence:changed covers it).
  const known: LiveMode | null = isQuietPresenceWrite(collection, extra)
    ? 'off'
    : liveModeNow(collection)
  if (!known) void liveModeOf(collection).catch(() => {})
  const journaled = deliver(known ?? 'on')
  // GraphQL subscriptions hear the same minimal event, once it has its journal position: the
  // SSE transport sends that as the event id, so a reconnect resumes from it (#1749).
  if (extra?.action && known !== 'off') {
    const ev = {
      collection,
      item: String(item),
      action: extra.action,
      changed_fields: extra.changed_fields?.slice(0, 50) ?? []
    }
    void journaled.then(
      (r) => {
        // A collection switched off sends nothing; a temporary or list read cache elsewhere
        // still hears it.
        if (r == null && liveModeNow(collection) === 'off') {
          if (tempCacheActive() || readCachesActive()) publishCollectionTouched(collection)
          return
        }
        publishItemEvent(r?.seq == null ? ev : { ...ev, seq: r.seq })
      },
      () => publishItemEvent(ev)
    )
  } else if (tempCacheActive() || readCachesActive()) {
    // #2273 — no itemMutated event (a record aspect, a raw write, a collection switched off):
    // other replicas' temporary caches (and list read caches, #2443/#2444) still have to hear
    // it. Only while one holds something; subscriptions see nothing new.
    publishCollectionTouched(collection)
  }
}
