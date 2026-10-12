import { createContext, useContext } from 'react'

/**
 * Realtime sprint client contract. A HOST (admin, a portal app) owns the actual
 * Socket.io connection and provides this to shared components; components
 * that render without it degrade to polling exactly as before — the context
 * is always optional.
 */

export interface CollectionUpdateEvent {
  collection: string
  item: string | number
  action?: 'create' | 'update' | 'delete'
  changed_fields?: string[]
  /** 'raw' — a procedure, import or script made the write (#1875); 'import' — a staged import
   *  run wrote it through the items service (#1826). */
  source?: 'raw' | 'import'
  /** With item '*': a raw write touched this many records of the collection. */
  bulk?: number
  _seq?: number
}

export interface RealtimeAdapter {
  /** Subscribe to collection:update for the named collections. Returns unsubscribe. */
  subscribeCollections(collections: string[], cb: (ev: CollectionUpdateEvent) => void): () => void
  /** Listen to an arbitrary socket event (lock:requested, record:uploading…). */
  on(event: string, cb: (payload: any) => void): () => void
  /** Emit an event to the server (record:uploading, record:join…). */
  emit(event: string, payload?: any): void
}

export const RealtimeContext = createContext<RealtimeAdapter | null>(null)

export function useOptionalRealtime(): RealtimeAdapter | null {
  return useContext(RealtimeContext)
}
