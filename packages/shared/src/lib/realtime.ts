import { createContext, useContext, useEffect, useState } from 'react'

/**
 * Realtime sprint client contract. A HOST (admin, a portal app) owns the actual
 * Socket.io connection and provides this to shared components; components
 * that render without it degrade to polling exactly as before — the context
 * is always optional.
 */

export interface CollectionUpdateEvent {
  collection: string
  /** The record that changed; null on a coalesced message (#1681), whose ids are in `items`. */
  item: string | number | null
  action?: 'create' | 'update' | 'delete'
  changed_fields?: string[]
  /** 'raw' — a procedure, import or script made the write (#1875). */
  source?: 'raw'
  /** With item '*': a raw write touched this many records of the collection. */
  bulk?: number
  _seq?: number
  /**
   * #1681 — a burst merged into one message (only for hosts that opted in with the
   * `coalesce` feature): the ids it covers, or null with `many` when there were too many.
   */
  coalesced?: boolean
  items?: Array<string | number> | null
  many?: boolean
  count?: number
}

/** The ids an update covers: one, a coalesced list, or null = "too many — refresh it all". */
export function updateItemIds(ev: CollectionUpdateEvent): Array<string | number> | null {
  if (ev.coalesced) return ev.many ? null : (ev.items ?? [])
  return ev.item == null ? null : [ev.item]
}

/** Whether an update may touch record `id` (a `many` burst touches everything). */
export function updateTouches(ev: CollectionUpdateEvent, id: string | number): boolean {
  const ids = updateItemIds(ev)
  if (ids === null) return true
  const want = String(id)
  return ids.some((i) => String(i) === want)
}

/**
 * #1725 / #1672 — the live connection's state, for the reconnect banner and the stale mark on
 * lists and queues. `transport` is how events arrive: the websocket, HTTP long-polling when the
 * upgrade was blocked, or the read-only SSE stream when polling is off too.
 */
export interface RealtimeStatus {
  state: 'live' | 'reconnecting'
  transport: 'websocket' | 'polling' | 'sse' | null
  /** Set once after a reconnect whose catch-up had to reload: what was refreshed. */
  refreshed?: string | null
}

export interface RealtimeAdapter {
  /** Subscribe to collection:update for the named collections. Returns unsubscribe. */
  subscribeCollections(collections: string[], cb: (ev: CollectionUpdateEvent) => void): () => void
  /** Listen to an arbitrary socket event (lock:requested, record:uploading…). */
  on(event: string, cb: (payload: any) => void): () => void
  /** Emit an event to the server (record:uploading, record:join…). */
  emit(event: string, payload?: any): void
  /** Optional (#1725): the connection's current state. Hosts without it are treated as live. */
  status?(): RealtimeStatus
  /** Optional (#1725): called on every state change. Returns unsubscribe. */
  onStatus?(cb: (s: RealtimeStatus) => void): () => void
}

export const RealtimeContext = createContext<RealtimeAdapter | null>(null)

export function useOptionalRealtime(): RealtimeAdapter | null {
  return useContext(RealtimeContext)
}

/** The host's connection state, or null when the host gives none (no realtime, or no status). */
export function useRealtimeStatus(): RealtimeStatus | null {
  const realtime = useOptionalRealtime()
  const [status, setStatus] = useState<RealtimeStatus | null>(() => realtime?.status?.() ?? null)
  useEffect(() => {
    if (!realtime?.onStatus) {
      setStatus(null)
      return
    }
    setStatus(realtime.status?.() ?? null)
    return realtime.onStatus(setStatus)
  }, [realtime])
  return status
}
