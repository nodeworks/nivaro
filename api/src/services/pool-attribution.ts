import { db } from '../db/index.js'
import { currentRequestHint } from './request-trace.js'

/**
 * Pool leak attribution (#304): tarn (knex's pool) emits acquire/release
 * events — each acquired connection is stamped with when and for WHICH request
 * (the trace ALS's URL hint; crons show as null). Connections held past 30s
 * are reported with their holder, which turns "the pool is exhausted" into
 * "these two routes are holding connections".
 */

interface Held {
  at: number
  hint: string | null
}

const held = new Map<unknown, Held>()

export function startPoolAttribution(): void {
  const pool = (
    db.client as unknown as {
      pool?: { on: (ev: string, fn: (...a: unknown[]) => void) => void }
    }
  ).pool
  if (!pool || typeof pool.on !== 'function') return
  pool.on('acquireSuccess', (_eventId: unknown, resource: unknown) => {
    held.set(resource, { at: Date.now(), hint: currentRequestHint() })
  })
  pool.on('release', (resource: unknown) => {
    held.delete(resource)
  })
  pool.on('destroySuccess', (_eventId: unknown, resource: unknown) => {
    held.delete(resource)
  })
}

export function heldConnections(): Array<{ held_ms: number; hint: string | null }> {
  const now = Date.now()
  return [...held.values()]
    .map((h) => ({ held_ms: now - h.at, hint: h.hint }))
    .filter((h) => h.held_ms > 1000)
    .sort((a, b) => b.held_ms - a.held_ms)
    .slice(0, 50)
}
