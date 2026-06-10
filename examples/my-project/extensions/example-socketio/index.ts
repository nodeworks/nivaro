// @ts-nocheck

// Socket.io extension example
//
// The extension loader imports `index.js` from each folder — compile this file
// with `tsc` or copy the compiled output alongside it.
//
// How Socket.io works in Nivaro:
//   - The Socket.io server is started inside the Fastify process by socketioPlugin.
//   - It is accessible as `app.io` anywhere you have the Fastify instance.
//   - The Redis pub/sub adapter means events emitted on one API replica reach
//     clients connected to any replica.
//
// Pattern for emitting after a data mutation:
//   In a route handler: app.io.emit('collection:updated', { collection, id })
//   In a hook:          ctx.req?.server.io.emit(...)  (req.server is the Fastify instance)

import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import type { Server as SocketIOServer } from 'socket.io'

declare module 'fastify' {
  interface FastifyInstance {
    io: SocketIOServer
  }
}

interface ExtensionContext {
  app: FastifyInstance
  database: Knex
  logger: FastifyInstance['log']
  hooks: {
    before(
      collection: string | '*',
      action: string | '*',
      fn: (...args: unknown[]) => unknown
    ): void
    after(collection: string | '*', action: string | '*', fn: (...args: unknown[]) => unknown): void
  }
  cron: {
    schedule(id: string, expression: string, fn: () => void | Promise<void>): void
    unschedule(id: string): void
  }
  callExternalApi(nameOrId: string | number, options?: Record<string, unknown>): Promise<unknown>
  flows: {
    registerOperation(op: {
      type: string
      label: string
      description?: string
      color?: string
      fields?: Array<{
        key: string
        label: string
        type: 'string' | 'number' | 'boolean' | 'select' | 'textarea' | 'json'
        options?: Array<{ value: string; label: string }>
        placeholder?: string
        required?: boolean
        description?: string
        defaultValue?: unknown
      }>
      handler(
        opts: Record<string, unknown>,
        data: Record<string, unknown>,
        ctx: {
          flowId: string
          flowName: string
          trigger: string
          payload: Record<string, unknown>
          log: FastifyInstance['log']
          userId?: string
        }
      ): Promise<{ status: 'resolve' | 'reject'; output: Record<string, unknown> }>
    }): void
    registerTrigger(trigger: {
      type: string
      label: string
      description?: string
      fields?: Array<{
        key: string
        label: string
        type: 'string' | 'number' | 'boolean' | 'select' | 'textarea' | 'json'
        options?: Array<{ value: string; label: string }>
        placeholder?: string
        required?: boolean
        description?: string
        defaultValue?: unknown
      }>
    }): void
    emit(triggerType: string, payload: Record<string, unknown>): void
  }
}

interface Extension {
  id: string
  register(ctx: ExtensionContext): void | Promise<void>
}

const plugin: Extension = {
  id: 'example-socketio',

  async register({ app, logger }) {
    // ─── Listen for new client connections ──────────────────────────────────────
    // app.io is the Socket.io Server instance decorated by socketioPlugin.
    app.io.on('connection', (socket) => {
      logger.info({ socketId: socket.id }, '[example-socketio] client connected')

      // ─── Join a named room ───────────────────────────────────────────────────
      // Clients send this event to subscribe to updates for a specific resource.
      // Rooms are cheap — a client can be in many rooms simultaneously.
      socket.on('subscribe', (roomId: string) => {
        socket.join(roomId)
        logger.info({ socketId: socket.id, roomId }, '[example-socketio] joined room')
      })

      // ─── Leave a room ────────────────────────────────────────────────────────
      socket.on('unsubscribe', (roomId: string) => {
        socket.leave(roomId)
      })

      socket.on('disconnect', () => {
        logger.info({ socketId: socket.id }, '[example-socketio] client disconnected')
      })
    })

    // ─── Custom Fastify route that emits after a write ───────────────────────────
    // This shows the pattern for broadcasting a change to all connected clients
    // from inside a route handler.
    app.register(async (fastify) => {
      fastify.post('/example/broadcast', async (req, reply) => {
        const body = req.body as { message: string; room?: string }

        if (body.room) {
          // Emit only to clients in a specific room
          fastify.io.to(body.room).emit('example:message', { message: body.message })
        } else {
          // Broadcast to ALL connected clients
          fastify.io.emit('example:message', { message: body.message })
        }

        return reply.send({ ok: true })
      })
    })

    // ─── Server-initiated emit (e.g. from a background job or hook) ─────────────
    // You can emit at any time — not just in response to a request.
    // Here we emit a heartbeat every 30 seconds as a trivial example.
    const heartbeat = setInterval(() => {
      app.io.emit('server:heartbeat', { ts: Date.now() })
    }, 30_000)

    // Clean up the interval when the server shuts down
    app.addHook('onClose', async () => {
      clearInterval(heartbeat)
    })

    logger.info('[example-socketio] registered')
  }
}

export default plugin
