/**
 * SSE fan-out hub (#602). broadcastCollectionUpdate publishes every collection
 * change here with one call; each open /events/stream connection registers a
 * listener. Deliberately tiny and process-local: the Socket.io journal owns
 * multi-replica replay semantics — SSE is the "curl-able" consumption surface,
 * and a per-process monotonically increasing `_seq` is enough for a client to
 * dedupe/order within one connection's lifetime.
 *
 * publish() is a no-op sync loop when nobody is connected, so the hook call in
 * realtime.ts costs nothing on an instance with no SSE consumers.
 */

import { collectionChangeOf, onJournalEntry } from './journal-listeners.js'
import { currentTenantKey } from './tenant-rooms.js'

export interface SseEvent {
  collection: string
  item: string | number
  action?: 'create' | 'update' | 'delete'
  changed_fields?: string[]
  /** Per-process sequence — ordering/dedupe within one stream, not global. */
  _seq: number
  /** Cloud: the tenant whose write this was ('' self-hosted). Streams deliver only their own. */
  tenant?: string
}

type SseListener = (ev: SseEvent) => void

const listeners = new Set<SseListener>()
let seq = 0

/** Register a listener; returns the unsubscribe function. */
export function subscribeSse(fn: SseListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Fan a collection change out to every connected SSE stream. Never throws —
 *  a broken listener must not affect the write path that published. */
export function publishSseEvent(ev: Omit<SseEvent, '_seq'>): void {
  if (listeners.size === 0) return
  // Listeners are process-global; in cloud mode one process serves several tenants, so the
  // event carries the tenant of the write (the request's context) and each stream filters on it.
  const full: SseEvent = { ...ev, tenant: ev.tenant ?? currentTenantKey(), _seq: ++seq }
  for (const fn of listeners) {
    try {
      fn(full)
    } catch {
      /* listener errors never propagate to the publisher */
    }
  }
}

/**
 * What a stream opened under `tenant` may write for `ev`: the event without its tenant stamp,
 * or null when the event belongs to another tenant ('' = self-hosted, which matches itself).
 */
export function sseEventForTenant(ev: SseEvent, tenant: string): Omit<SseEvent, 'tenant'> | null {
  if ((ev.tenant ?? '') !== tenant) return null
  const { tenant: _tenant, ...payload } = ev
  return payload
}

/** Diagnostics — how many streams are attached to this process. */
export function sseListenerCount(): number {
  return listeners.size
}

let bridgeOff: (() => void) | null = null

/**
 * Post-mortem 3.3 — record changes written on OTHER replicas, for this process's streams. The
 * writing process publishes its own changes (broadcastCollectionUpdate); without this a stream
 * heard only writes made on the process it happened to connect to, and a realtime process
 * (which makes no writes) heard nothing. Fed by the event stream reader (REALTIME_EVENT_STREAM);
 * a collection set to batched live mode sends no per-record entry, so other replicas' streams
 * miss those. Idempotent.
 */
export function startSseRemoteBridge(): void {
  if (bridgeOff) return
  bridgeOff = onJournalEntry((entry, origin) => {
    if (origin !== 'remote' || listeners.size === 0) return
    const c = collectionChangeOf(entry)
    if (!c) return
    const raw = entry.payload?.item
    publishSseEvent({
      collection: c.collection,
      item: typeof raw === 'number' ? raw : c.item,
      action: c.action ?? undefined,
      changed_fields: c.changed_fields ?? undefined,
      tenant: c.tenant
    })
  })
}

/** Tests. */
export function stopSseRemoteBridge(): void {
  bridgeOff?.()
  bridgeOff = null
}
