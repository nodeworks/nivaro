import type { JournalEntry } from './event-journal.js'

/**
 * In-process listeners for journaled events (#1675, #1680).
 *
 * Pushed dashboard widgets and the saved-view change stream need every record change the
 * sockets hear, on every replica, with its journal sequence (the resume cursor). Two places
 * hand entries here: journaledEmit, for writes this process made, and the Redis stream reader
 * (event-stream.ts), for entries written by OTHER replicas. A replica whose stream is off
 * (REALTIME_EVENT_STREAM=off, Redis down) hears only its own writes.
 *
 * `seq` is null when Redis could not number the event (it was emitted unjournaled). Listeners
 * run synchronously and must return quickly — a throw never reaches the emit.
 */

export type JournalListenerEntry = Omit<JournalEntry, 'seq'> & { seq: number | null }
/** 'local' = a write this process made (journaledEmit); 'remote' = another replica's (stream). */
export type JournalOrigin = 'local' | 'remote'
/** `at`: when the writing process made the entry (ms), when the transport carries it. */
type JournalListener = (entry: JournalListenerEntry, origin: JournalOrigin, at?: number) => void

const listeners = new Set<JournalListener>()

export function onJournalEntry(fn: JournalListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function notifyJournalListeners(
  entry: JournalListenerEntry,
  origin: JournalOrigin = 'local',
  at?: number
): void {
  if (listeners.size === 0) return
  for (const fn of listeners) {
    try {
      fn(entry, origin, at)
    } catch {
      /* a listener never affects delivery */
    }
  }
}

export interface CollectionChange {
  seq: number | null
  /** '' self-hosted; the cloud tenant key the room carried otherwise. */
  tenant: string
  collection: string
  /** A record id, or '*' for a raw bulk write (#1875). */
  item: string
  action: 'create' | 'update' | 'delete' | null
  changed_fields: string[] | null
}

const TENANT_ROOM = /^t:([^:]+):(.+)$/

/** The record change a journal entry announces, or null for any other event. */
export function collectionChangeOf(entry: JournalListenerEntry): CollectionChange | null {
  if (entry.event !== 'collection:update') return null
  const m = TENANT_ROOM.exec(entry.room)
  const tenant = m ? m[1] : ''
  const room = m ? m[2] : entry.room
  if (!room.startsWith('collection:')) return null
  const p = entry.payload ?? {}
  const collection = typeof p.collection === 'string' ? p.collection : room.slice(11)
  if (!collection || p.item == null) return null
  const action =
    p.action === 'create' || p.action === 'update' || p.action === 'delete' ? p.action : null
  return {
    seq: entry.seq,
    tenant,
    collection,
    item: String(p.item),
    action,
    changed_fields: Array.isArray(p.changed_fields) ? p.changed_fields.map(String) : null
  }
}

/** Diagnostics / tests. */
export function journalListenerCount(): number {
  return listeners.size
}
