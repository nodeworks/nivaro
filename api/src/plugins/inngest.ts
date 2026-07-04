import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { Inngest } from 'inngest'
import { serve } from 'inngest/fastify'
import { config } from '../config.js'

declare module 'fastify' {
  interface FastifyInstance {
    inngest: Inngest
  }
}

export const inngest = new Inngest({
  id: 'nivaro-cms',
  eventKey: config.INNGEST_EVENT_KEY,
  // In development, point at the local Inngest Dev Server (localhost:8288).
  // If the dev server isn't running, inngest.send() will still fail gracefully
  // because callers catch and log the error rather than letting it propagate.
  isDev: config.NODE_ENV === 'development'
})

export const inngestPlugin = fp(async (app: FastifyInstance) => {
  app.decorate('inngest', inngest)

  // Function modules call `inngest.createFunction(...)` at their own module top
  // level, so importing them here at THIS module's top level would create a
  // circular import (this file would need to finish initializing `inngest` before
  // the function module's top-level code could use it, but the function module is
  // pulled in first as a dependency of this one) — same shape as the
  // registry<->executor circular dep in flows/registry.ts, same fix: defer the
  // import until this plugin actually registers, well after both modules have
  // finished loading.
  const { queueMaterializationBackfill } = await import(
    '../functions/queue-materialization-jobs.js'
  )
  const functions: Parameters<typeof serve>[0]['functions'] = [queueMaterializationBackfill]

  const handler = serve({ client: inngest, functions })

  // inngest/fastify returns a Fastify-compatible route handler
  app.route({
    method: ['GET', 'POST', 'PUT'],
    url: '/api/inngest',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: handler as any
  })

  app.log.info('Inngest registered at /api/inngest')
})
