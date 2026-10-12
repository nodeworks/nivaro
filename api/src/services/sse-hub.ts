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
