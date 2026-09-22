import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { _staticDb, db, dbRead } from '../db/index.js'
import {
  attachQueryTracing,
  beginTrace,
  finishTrace,
  setWideTables
} from '../services/request-trace.js'

/**
 * Scopes a phase-timing context to every /api/* request. Pairs with
 * services/request-trace.ts, which decides whether the finished trace is worth
 * keeping (only requests over the slow threshold are).
 *
 * Registered FIRST, before auth and route handlers, so a span opened anywhere
 * downstream — including inside the items service and hook registry — finds a
 * context. Non-/api paths (the admin SPA, static assets) are left alone.
 */
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
    if (!path.startsWith('/api/')) return
    // Tracing the trace reader would be circular and would evict real traces
    // from the ring buffer every time the page polled.
    if (path.startsWith('/api/traces')) return
    beginTrace(path)
  })

  app.addHook('onResponse', async (req, reply) => {
    const path = (req.raw.url ?? req.url).split('?')[0]
    if (!path.startsWith('/api/') || path.startsWith('/api/traces')) return
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
