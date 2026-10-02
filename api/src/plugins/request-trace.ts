import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { _staticDb, db, dbRead } from '../db/index.js'
import {
  attachQueryTracing,
  beginTrace,
  clearTrace,
  currentTraceMeta,
  finishTrace,
  markSerializeEnd,
  markSerializeStart,
  setWideTables
} from '../services/request-trace.js'
import { attachInflightQueries, inflightEnd, inflightStart } from '../services/traffic-inflight.js'

/**
 * Scopes a phase-timing context to every /api/* request. Pairs with
 * services/request-trace.ts, which decides whether the finished trace is worth
 * keeping (only requests over the slow threshold are).
 *
 * Registered FIRST, before auth and route handlers, so a span opened anywhere
 * downstream — including inside the items service and hook registry — finds a
 * context. Non-/api paths (the admin SPA, static assets) are left alone.
 */
/** Response header carrying the request id on every traced /api response. */
export const REQUEST_ID_HEADER = 'x-nivaro-request-id'

export const requestTracePlugin = fp(async (app: FastifyInstance) => {
  // Round-trip accounting (#506/#507/#483): every statement a traced request
  // runs is counted and timed off knex's query events. Both pools — the
  // replica shares the request context, so its statements count too.
  const clients = new Set<unknown>()
  for (const k of [_staticDb, dbRead]) {
    const client = (k as unknown as { client?: { on?: unknown } }).client
    if (client && typeof client.on === 'function' && !clients.has(client)) {
      clients.add(client)
      attachQueryTracing(client as Parameters<typeof attachQueryTracing>[0])
      // Traffic Map in-flight list (#1147): the statement each open request is running.
      attachInflightQueries(client as Parameters<typeof attachInflightQueries>[0])
    }
  }

  // Which tables carry an nvarchar(max) column — a `select *` on one of those
  // drags the blob across the wire whether or not the caller reads it (the
  // owner-group `filters` JSON is the case that motivated #483). Refreshed
  // every ten minutes; a schema without such columns just yields no flags.
  async function loadWideTables(): Promise<void> {
    try {
      const rows = (await db.raw(`
        SELECT DISTINCT t.name AS name
          FROM sys.columns c
          JOIN sys.tables t ON t.object_id = c.object_id
          JOIN sys.types ty ON ty.user_type_id = c.user_type_id
         WHERE c.max_length = -1 AND ty.name IN ('nvarchar', 'varchar', 'varbinary')
      `)) as Array<{ name: string }> | undefined
      if (Array.isArray(rows)) setWideTables(rows.map((r) => r.name))
    } catch {
      /* not mssql, or no catalog access — the lint simply stays quiet */
    }
  }
  app.addHook('onReady', async () => {
    void loadWideTables()
    const t = setInterval(() => void loadWideTables(), 10 * 60_000)
    t.unref()
    app.addHook('onClose', async () => clearInterval(t))
  })

  app.addHook('onRequest', async (req) => {
    const path = (req.raw.url ?? req.url).split('?')[0]
    // Tracing the trace reader would be circular and would evict real traces
    // from the ring buffer every time the page polled.
    if (!path.startsWith('/api/') || path.startsWith('/api/traces')) {
      // beginTrace uses enterWith, so a previous request's trace can still be the store on a
      // keep-alive socket — an untraced request must not inherit its id (public-page events).
      clearTrace()
      return
    }
    beginTrace(path, req)
    // The trace id IS the request id: the API log row, the Traffic Map events, the trace ring
    // and the response header all carry it, so one id joins them.
    req.requestId = currentTraceMeta()?.id
    inflightStart(req)
  })

  // A client that went away never gets an onResponse — the in-flight entry ends here instead.
  app.addHook('onRequestAbort', async (req) => {
    inflightEnd(req)
  })

  // Serialization window (Traffic Map latency split, #1151): preSerialization only runs for
  // object payloads, so a handler that sends a string reads 0. Callback hooks — no promise per
  // request — and both are a WeakMap lookup that does nothing for an untraced request.
  app.addHook('preSerialization', (req, _reply, payload, done) => {
    markSerializeStart(req)
    done(null, payload)
  })
  app.addHook('onSend', (req, reply, payload, done) => {
    markSerializeEnd(req)
    // Lets the browser's own network tab correlate a call with its trace / log row.
    if (req.requestId) reply.header(REQUEST_ID_HEADER, req.requestId)
    done(null, payload)
  })

  app.addHook('onResponse', async (req, reply) => {
    const path = (req.raw.url ?? req.url).split('?')[0]
    if (!path.startsWith('/api/') || path.startsWith('/api/traces')) return
    inflightEnd(req)
    try {
      finishTrace({
        method: req.method,
        // routerPath collapses ids into the pattern (/api/items/:collection/:id),
        // so traces for the same endpoint group instead of fragmenting per record.
        route: (req as { routeOptions?: { url?: string } }).routeOptions?.url ?? path,
        url: (req.raw.url ?? req.url).slice(0, 500),
        status: reply.statusCode,
        user: req.user?.id ?? null
      })
    } catch (err) {
      // A diagnostic must never take down the response it is describing.
      app.log.warn({ err }, 'Failed to record request trace')
    }
  })

  app.log.info('Request tracing ready')
})
