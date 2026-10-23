import type { ServerResponse } from 'node:http'
import type { FastifyInstance } from 'fastify'
import { hooks } from '../hooks/registry.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { type JournalListenerEntry, onJournalEntry } from '../services/journal-listeners.js'
import { scopeAllows } from '../services/permissions.js'
import { trackSse } from '../services/traffic-taps/realtime.js'

/**
 * Server-Sent Events stream of item mutations (admin only).
 *
 * GET /api/stream → emits `data: {"type","collection","id","timestamp"}`
 * events for every create/update/delete across all collections.
 * Heartbeat comment every 25s keeps proxies from closing idle connections.
 *
 * Fed by this process's after-hooks (its own writes) and — post-mortem 3.3 — by the record
 * changes the other processes journal (the event stream), so a stream opened on any replica
 * hears every replica's writes. The two feeds differ where the journal and the hooks do: a
 * collection whose live updates are switched off journals nothing (its writes on other
 * processes do not show here), and a trash restore journals a create without running the hooks
 * (it shows from other processes, not from the one that restored). Raw writes (procedures,
 * imports) reach neither.
 *
 * An admin API key narrowed to named collections sees only those collections' events.
 */

/** Open streams → the collection scopes of the API key that opened them (null = none). */
const clients = new Map<ServerResponse, Array<{ collection: string; actions: string[] }> | null>()
let hooksRegistered = false

function broadcast(event: {
  type: string
  collection: string
  id: string | null
  timestamp: string
}) {
  if (clients.size === 0) return
  const frame = `data: ${JSON.stringify(event)}\n\n`
  for (const [res, scopes] of clients) {
    if (scopes && !scopeAllows(scopes, 'read', event.collection)) continue
    try {
      res.write(frame)
    } catch {
      clients.delete(res)
    }
  }
}

function registerStreamHooks() {
  if (hooksRegistered) return
  hooksRegistered = true

  // Other processes' writes (their own streams heard them from their hooks). Self-hosted only:
  // the hook feed above is not tenant-filtered either, and cloud keeps it per process.
  if (!process.env.CLOUD_META_DB_URL)
    onJournalEntry((entry, origin, at) => {
      if (origin !== 'remote' || clients.size === 0) return
      for (const ev of streamEventsOf(entry, at)) broadcast(ev)
    })

  for (const action of ['create', 'update', 'delete'] as const) {
    hooks.after('*', action, async (ctx) => {
      broadcast({
        type: action,
        collection: ctx.collection,
        id: ctx.keys?.[0] != null ? String(ctx.keys[0]) : null,
        timestamp: new Date().toISOString()
      })
    })
  }
}

const ACTIONS = new Set(['create', 'update', 'delete'])

/**
 * Exported for tests: the admin stream events a journaled record change stands for — one per
 * record (a batched-mode entry lists several); none for a raw bulk write (`*`, no action), which
 * the writing process's own hooks never saw either.
 */
export function streamEventsOf(
  entry: JournalListenerEntry,
  /** When the writing process journaled it (ms); default now. */
  at?: number
): Array<{
  type: string
  collection: string
  id: string | null
  timestamp: string
}> {
  if (entry.event !== 'collection:update') return []
  const m = /^(?:t:[^:]+:)?collection:(.+)$/.exec(entry.room)
  if (!m) return []
  const p = entry.payload ?? {}
  if (typeof p.action !== 'string' || !ACTIONS.has(p.action)) return []
  // Raw writes (procedures, imports through SQL) never ran the hooks on the writer either.
  if (p.source === 'raw') return []
  const collection = typeof p.collection === 'string' ? p.collection : m[1]
  const ids =
    p.batched === true && Array.isArray(p.items)
      ? (p.items as unknown[])
      : p.item != null
        ? [p.item]
        : []
  const timestamp = new Date(typeof at === 'number' && at > 0 ? at : Date.now()).toISOString()
  return ids
    .filter((id) => id != null && String(id) !== '*')
    .map((id) => ({ type: p.action as string, collection, id: String(id), timestamp }))
}

export async function streamRoutes(app: FastifyInstance) {
  registerStreamHooks()

  app.get('/stream', { preHandler: requireAdmin }, async (req, reply) => {
    const res = reply.raw
    reply.hijack()

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    trackSse(res, 'admin-sse')
    res.write('retry: 5000\n\n')
    res.write(': connected\n\n')

    // An admin key narrowed to named collections keeps to them here too.
    clients.set(res, req.user?.api_key_scopes ?? null)

    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n')
      } catch {
        cleanup()
      }
    }, 25_000)

    function cleanup() {
      clearInterval(heartbeat)
      clients.delete(res)
      try {
        res.end()
      } catch {
        // already closed
      }
    }

    req.raw.on('close', cleanup)
    res.on('close', cleanup)
  })

  // Drop all connections on server shutdown — in preClose, before the HTTP
  // server waits for them to end.
  app.addHook('preClose', async () => {
    for (const res of clients.keys()) {
      try {
        res.end()
      } catch {
        // ignore
      }
    }
    clients.clear()
  })
}
