import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { authenticate, requireAuth } from '../middleware/authenticate.js'
import { can } from '../services/permissions.js'
import { type SseEvent, subscribeSse } from '../services/sse-hub.js'

// ─── SSE event stream (#602) ─────────────────────────────────────────────────
// GET /events/stream — server-sent events of collection changes, fed by the
// same broadcastCollectionUpdate every Socket.io consumer rides. Payloads are
// minimal by the documented RLS rule (names, never values): a consumer that
// wants the new data fetches the row through /items, where RBAC applies.
//
// Auth: normal Bearer/session via `authenticate`. EventSource cannot set
// headers, so header-less consumers first call the authenticated
// GET /events/ticket and connect with `?ticket=` — a one-shot Redis token
// (60s TTL, deleted on first use, ws-token precedent). A long-lived
// credential NEVER rides the query string, where the api logger would
// persist it.

const HEARTBEAT_MS = 25_000
const MAX_FILTER_COLLECTIONS = 50

export async function eventsStreamRoutes(app: FastifyInstance) {
  /** Mint a one-shot connect ticket (ws-token precedent) — the ONLY way a
   *  credential-less EventSource may authenticate; 60s TTL, single use. */
  app.get('/ticket', { preHandler: [authenticate, requireAuth] }, async (req) => {
    const ticket = randomUUID()
    await app.redis.setex(`sse:ticket:${ticket}`, 60, String(req.user!.id))
    return { data: { ticket, expires_in: 60 } }
  })

  app.get('/stream', async (req, reply) => {
    const q = req.query as { ticket?: string; collections?: string }

    // One-shot ticket exchange for header-less EventSource consumers: GETDEL
    // makes replay impossible, the 60s TTL bounds exposure, and the resolved
    // identity is the ticket minter's own.
    if (q.ticket && /^[a-f0-9-]{36}$/i.test(q.ticket) && !req.headers.authorization) {
      const userId = (await app.redis.getdel(`sse:ticket:${q.ticket}`).catch(() => null)) as
        | string
        | null
      if (userId) {
        const { db } = await import('../db/index.js')
        const row = await db('nivaro_users').where({ id: userId }).first()
        if (row && row.status !== 'suspended') req.user = row as never
      }
    }
    if (!req.user) {
      await authenticate(req, reply)
    }
    const user = req.user
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })

    // Per-connection collection filter. Unauthorized collections are dropped
    // SILENTLY (a 403 here would let a caller probe which collections exist).
    // No filter = all collections, permission-checked lazily per collection
    // on first event and cached for the connection's lifetime.
    let allowed: Set<string> | null = null
    if (q.collections?.trim()) {
      const wanted = [
        ...new Set(
          q.collections
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean)
        )
      ].slice(0, MAX_FILTER_COLLECTIONS)
      const checks = await Promise.all(
        wanted.map(async (c) => ((await can(user, 'read', c).catch(() => false)) ? c : null))
      )
      allowed = new Set(checks.filter((c): c is string => c != null))
    }

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    raw.write(': connected\n\n')

    let closed = false
    const lazyCan = new Map<string, Promise<boolean>>()

    const deliver = async (ev: SseEvent): Promise<void> => {
      if (closed) return
      if (allowed) {
        if (!allowed.has(ev.collection)) return
      } else {
        let check = lazyCan.get(ev.collection)
        if (check === undefined) {
          check = can(user, 'read', ev.collection).catch(() => false)
          lazyCan.set(ev.collection, check)
        }
        if (!(await check)) return
        if (closed) return
      }
      try {
        raw.write(`event: collection.update\ndata: ${JSON.stringify(ev)}\n\n`)
      } catch {
        cleanup()
      }
    }

    const unsubscribe = subscribeSse((ev) => {
      void deliver(ev)
    })

    const heartbeat = setInterval(() => {
      if (closed) return
      try {
        raw.write(': hb\n\n')
      } catch {
        cleanup()
      }
    }, HEARTBEAT_MS)
    heartbeat.unref()

    function cleanup(): void {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
      try {
        raw.end()
      } catch {
        /* already gone */
      }
    }

    req.raw.on('close', cleanup)
    req.raw.on('error', cleanup)
  })
}
