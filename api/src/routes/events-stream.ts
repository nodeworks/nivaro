import type { FastifyInstance } from 'fastify'
import { authenticate, requireAuth } from '../middleware/authenticate.js'
import { can } from '../services/permissions.js'
import { bindFromRequest, type SocketBind } from '../services/socket-access.js'
import { type SseEvent, sseEventForTenant, subscribeSse } from '../services/sse-hub.js'
import {
  loadStreamIdentity,
  mintStreamTicket,
  recheckStreamIdentity,
  redeemStreamTicket,
  type StreamIdentity
} from '../services/stream-ticket.js'
import { captureTenant } from '../services/tenant-capture.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { trackSse } from '../services/traffic-taps/realtime.js'

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

/** The collections of `wanted` the user may read (unreadable ones dropped silently). */
async function readableOf(
  user: NonNullable<import('fastify').FastifyRequest['user']>,
  wanted: string[]
): Promise<Set<string>> {
  const checks = await Promise.all(
    wanted.map(async (c) => ((await can(user, 'read', c).catch(() => false)) ? c : null))
  )
  return new Set(checks.filter((c): c is string => c != null))
}

export async function eventsStreamRoutes(app: FastifyInstance) {
  /** Mint a one-shot connect ticket (ws-token precedent) — the ONLY way a
   *  credential-less EventSource may authenticate; 60s TTL, single use. */
  app.get('/ticket', { preHandler: [authenticate, requireAuth] }, async (req) => {
    // The ticket remembers what signed this request in (#1719, H1): the stream it opens ends
    // with that session, View-as, token or API key, and acts as the key when it is one.
    // The same ticket opens /events/stream, /graphql/stream and a graphql-ws connection (#1749).
    const ticket = await mintStreamTicket(app.redis, req)
    if (!ticket)
      throw Object.assign(new Error('This sign-in cannot open a stream'), { statusCode: 403 })
    return { data: { ticket, expires_in: 60 } }
  })

  app.get('/stream', async (req, reply) => {
    const q = req.query as { ticket?: string; collections?: string }

    // One-shot ticket exchange for header-less EventSource consumers: GETDEL
    // makes replay impossible, the 60s TTL bounds exposure, and the resolved
    // identity is the ticket minter's own.
    let bind: SocketBind | null = null
    if (q.ticket && !req.headers.authorization) {
      // A ticket with no bind (an older API's bare user id) or from another tenant opens nothing.
      const minted = await redeemStreamTicket(app.redis, q.ticket)
      const identity = minted ? await loadStreamIdentity(minted.userId, minted.bind) : null
      if (minted && identity) {
        req.user = identity.user as never
        bind = minted.bind
      }
    }
    if (!req.user) {
      await authenticate(req, reply)
      bind = bindFromRequest(req)
    }
    const signedIn = req.user
    // #1719 — the stream is the read-only fallback for a blocked websocket, so it ends with the
    // sign-in like a socket does (session gone or revoked, View-as ended, token rotated, API key
    // revoked or expired, account no longer active) at the next heartbeat. A sign-in with
    // nothing to bind to opens no stream.
    if (!signedIn || !bind) return reply.code(401).send({ error: 'Unauthorized' })
    let user = signedIn

    // Per-connection collection filter. Unauthorized collections are dropped
    // SILENTLY (a 403 here would let a caller probe which collections exist).
    // No filter = all collections, permission-checked lazily per collection
    // on first event and cached for the connection's lifetime.
    let allowed: Set<string> | null = null
    let wanted: string[] = []
    if (q.collections?.trim()) {
      wanted = [
        ...new Set(
          q.collections
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean)
        )
      ].slice(0, MAX_FILTER_COLLECTIONS)
      allowed = await readableOf(user, wanted)
    }

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    trackSse(raw, 'events-sse')
    raw.write(': connected\n\n')

    let closed = false
    const lazyCan = new Map<string, Promise<boolean>>()

    // Cloud: the hub is process-global and serves several tenants — this stream takes only the
    // events of the tenant it was opened under (the request's tenant context, captured here).
    const tenant = currentTenantKey()

    const deliver = async (ev: SseEvent): Promise<void> => {
      if (closed) return
      const payload = sseEventForTenant(ev, tenant)
      if (!payload) return
      if (allowed) {
        if (!allowed.has(ev.collection)) return
      } else {
        let check = lazyCan.get(ev.collection)
        if (check === undefined) {
          const reader = user
          check = can(reader, 'read', ev.collection).catch(() => false)
          lazyCan.set(ev.collection, check)
        }
        if (!(await check)) return
        if (closed) return
      }
      try {
        raw.write(`event: collection.update\ndata: ${JSON.stringify(payload)}\n\n`)
      } catch {
        cleanup()
      }
    }

    const unsubscribe = subscribeSse((ev) => {
      void deliver(ev)
    })

    const streamBind = bind
    const userId = String(user.id)
    const inTenant = captureTenant()
    let last: StreamIdentity = { user, isAdmin: req.isAdmin ?? false }
    // Every heartbeat re-reads the identity (sign-in, account, role, API key narrowing); the
    // per-collection read answers are dropped then, so a role or policy change applies to this
    // stream within one heartbeat instead of lasting as long as the connection.
    const stillSignedIn = async (): Promise<boolean> => {
      try {
        const r = await inTenant(() => recheckStreamIdentity(app.redis, userId, streamBind, last))
        if (!r.identity) return false
        if (r.identity !== last) {
          last = r.identity
          user = r.identity.user
          lazyCan.clear()
          if (allowed) {
            const reader = user
            allowed = await inTenant(() => readableOf(reader, wanted))
          }
        }
        return true
      } catch {
        return true // a failed check never ends a stream; the next heartbeat asks again
      }
    }

    const heartbeat = setInterval(() => {
      if (closed) return
      void stillSignedIn().then((ok) => {
        if (closed) return
        try {
          if (ok) raw.write(': hb\n\n')
          else {
            raw.write('event: session.ended\ndata: {"reason":"signed_out"}\n\n')
            cleanup()
          }
        } catch {
          cleanup()
        }
      })
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
