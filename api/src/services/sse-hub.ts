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

export interface SseEvent {
  collection: string
  item: string | number
  action?: 'create' | 'update' | 'delete'
  changed_fields?: string[]
  /** Per-process sequence — ordering/dedupe within one stream, not global. */
  _seq: number
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
  const full: SseEvent = { ...ev, _seq: ++seq }
  for (const fn of listeners) {
    try {
      fn(full)
    } catch {
      /* listener errors never propagate to the publisher */
    }
  }
}

/** Diagnostics — how many streams are attached to this process. */
export function sseListenerCount(): number {
  return listeners.size
}
