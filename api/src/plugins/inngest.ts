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

// Register Inngest functions here as you build them:
// import { myFunction } from '../functions/my-function.js'
// const functions = [myFunction]
const functions: Parameters<typeof serve>[0]['functions'] = []

export const inngestPlugin = fp(async (app: FastifyInstance) => {
  app.decorate('inngest', inngest)

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
