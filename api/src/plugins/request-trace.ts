import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { _backgroundDb, _staticDb, db, dbRead } from '../db/index.js'
import { instanceKey } from '../services/instance-key.js'
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
import { maskUrlQuery } from '../services/secret-mask.js'
import { flushTraceExport, setTraceExportInstance } from '../services/trace-export.js'
import {
  attachInflightQueries,
  inflightClientGone,
  inflightEnd,
  inflightStart
} from '../services/traffic-inflight.js'

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
  setTraceExportInstance(instanceKey().slice(0, 60))
  const flushTimer = setInterval(() => void flushTraceExport(), 5000)
  flushTimer.unref()
  app.addHook('onClose', async () => {
    clearInterval(flushTimer)
    await flushTraceExport().catch(() => {})
  })
  // Round-trip accounting (#506/#507/#483): every statement a traced request
  // runs is counted and timed off knex's query events. Every pool — the
  // replica shares the request context, so its statements count too, and the
  // background pool (#1321) carries the work a request hands to it.
  const clients = new Set<unknown>()
  for (const k of [_staticDb, _backgroundDb, dbRead]) {
    const client = (k as unknown as { client?: { on?: unknown } } | null)?.client
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

  app.addHook('onRequest', async (req, reply) => {
    const path = (req.raw.url ?? req.url).split('?')[0]
    // Tracing the trace reader would be circular and would evict real traces
    // from the ring buffer every time the page polled.
    if (!path.startsWith('/api/') || path.startsWith('/api/traces')) {
      // beginTrace uses enterWith, so a previous request's trace can still be the store on a
      // keep-alive socket — an untraced request must not inherit its id (public-page events).
      clearTrace()
      return
    }
    beginTrace(path, req, req.id)
    // The trace id IS the request id: the API log row, the Traffic Map events, the trace ring
    // and the response header all carry it, so one id joins them.
    req.requestId = currentTraceMeta()?.id
    inflightStart(req)
    // A client that leaves after its whole body arrived gets neither onRequestAbort nor
    // onResponse: the response's own close (before it finished) is the only signal.
    const res = reply.raw
    res.once('close', () => {
      if (!res.writableFinished) inflightClientGone(req, reply.sent)
    })
  })

  // A client that went away mid-body never gets an onResponse — the in-flight entry ends here.
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
    // The handler replied after the client left: no onResponse will follow.
    if (reply.raw.destroyed) inflightEnd(req)
    // Lets the browser's own network tab correlate a call with its trace / log row.
    if (req.requestId) reply.header(REQUEST_ID_HEADER, req.requestId)
    done(null, payload)
  })

  app.addHook('onResponse', async (req, reply) => {
    const path = (req.raw.url ?? req.url).split('?')[0]
    if (!path.startsWith('/api/') || path.startsWith('/api/traces')) return
    inflightEnd(req)
    try {
      const exported = finishTrace({
        method: req.method,
        // routerPath collapses ids into the pattern (/api/items/:collection/:id),
        // so traces for the same endpoint group instead of fragmenting per record.
        route: (req as { routeOptions?: { url?: string } }).routeOptions?.url ?? path,
        // Credentials riding the query (?kiosk=, ?token=…) never reach the trace ring.
        url: maskUrlQuery(req.raw.url ?? req.url).slice(0, 500),
        status: reply.statusCode,
        user: req.user?.id ?? null
      })
      // The access line (api-logger, later in the same onResponse chain) links to the trace.
      if (exported) (req as unknown as { __nvrTraceExported?: boolean }).__nvrTraceExported = true
    } catch (err) {
      // A diagnostic must never take down the response it is describing.
      app.log.warn({ err }, 'Failed to record request trace')
    }
  })

  app.log.info('Request tracing ready')
})
