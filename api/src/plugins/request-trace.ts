import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { beginTrace, finishTrace } from '../services/request-trace.js'

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
