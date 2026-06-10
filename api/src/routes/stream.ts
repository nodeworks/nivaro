import type { ServerResponse } from 'node:http'
import type { FastifyInstance } from 'fastify'
import { hooks } from '../hooks/registry.js'
import { requireAdmin } from '../middleware/authenticate.js'

/**
 * Server-Sent Events stream of item mutations (admin only).
 *
 * GET /api/stream → emits `data: {"type","collection","id","timestamp"}`
 * events for every create/update/delete across all collections.
 * Heartbeat comment every 25s keeps proxies from closing idle connections.
 */

const clients = new Set<ServerResponse>()
let hooksRegistered = false

function broadcast(event: {
  type: string
  collection: string
  id: string | null
  timestamp: string
}) {
  if (clients.size === 0) return
  const frame = `data: ${JSON.stringify(event)}\n\n`
  for (const res of clients) {
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
    res.write('retry: 5000\n\n')
    res.write(': connected\n\n')

    clients.add(res)

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

  // Drop all connections on server shutdown.
  app.addHook('onClose', async () => {
    for (const res of clients) {
      try {
        res.end()
      } catch {
        // ignore
      }
    }
    clients.clear()
  })
}
