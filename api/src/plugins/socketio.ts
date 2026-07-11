import { createAdapter } from '@socket.io/redis-adapter'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { Redis } from 'ioredis'
import { Server as SocketIOServer } from 'socket.io'
import { db } from '../db/index.js'
import { can } from '../services/permissions.js'
import type { User } from '../types.js'

declare module 'fastify' {
  interface FastifyInstance {
    io: SocketIOServer
  }
}

/**
 * Emit a real-time notification to a specific user's room.
 * Producers (routes, hooks, extensions) call this with the Fastify `app.io` server.
 */
export function emitNotification(io: SocketIOServer, userId: string, notification: object): void {
  io.to(`user:${userId}`).emit('notification:new', notification)
}

export const socketioPlugin = fp(async (app: FastifyInstance) => {
  const io = new SocketIOServer(app.server, {
    cors: { origin: '*', credentials: true },
    transports: ['websocket', 'polling']
  })

  const pubClient = new Redis(app.redis.options)
  const subClient = new Redis(app.redis.options)

  io.adapter(createAdapter(pubClient, subClient))

  io.on('connection', (socket) => {
    app.log.debug({ socketId: socket.id }, 'Socket connected')

    // Set once `auth` succeeds below; gates authenticated-only handlers
    // (e.g. collection:join) for the lifetime of this socket connection.
    let authenticatedUser: User | null = null

    // Authenticate the socket via the user's static token, or a short-lived
    // one-time WS token minted by GET /api/auth/ws-token (session-cookie users
    // whose cookie can't ride the cross-origin WS connection). Joins their
    // personal room so real-time notifications can be targeted to them.
    socket.on('auth', async (payload: { token?: string }) => {
      const token = payload?.token?.trim()
      if (!token) return
      try {
        const wsUserId = await app.redis.get(`ws:token:${token}`)
        if (wsUserId) {
          await app.redis.del(`ws:token:${token}`) // one-time use
          const user = await db<User>('nivaro_users')
            .where({ id: wsUserId, status: 'active' })
            .first()
          if (user) {
            authenticatedUser = user
            socket.join(`user:${user.id}`)
            socket.emit('auth:ok', { userId: user.id })
          }
          return
        }

        const user = await db<User>('nivaro_users')
          .where({ static_token: token, status: 'active' })
          .first()
        if (user) {
          authenticatedUser = user
          socket.join(`user:${user.id}`)
          socket.emit('auth:ok', { userId: user.id })
        }
      } catch (err) {
        app.log.warn({ err }, 'Socket auth failed')
      }
    })

    socket.on('tenant:join', (tenantId: string) => {
      if (typeof tenantId === 'string' && tenantId.length > 0) {
        socket.join(`tenant:${tenantId}`)
        socket.emit('tenant:joined', { tenantId })
      }
    })

    socket.on('presence:join', (roomId: string) => {
      socket.join(`presence:${roomId}`)
    })
    socket.on('presence:leave', (roomId: string) => {
      socket.leave(`presence:${roomId}`)
    })
    // Requires an authenticated socket (via `auth` above) AND read access to
    // the specific collection — mirrors the `can(user, 'read', collection)`
    // check every REST/GraphQL/items read path already enforces. Rejects
    // silently (no error emit) to match this handler's existing minimal-
    // feedback style; the client just never receives collection:update events.
    socket.on('collection:join', async (payload: { collection?: string }) => {
      const collection = payload?.collection
      if (typeof collection !== 'string' || collection.length === 0) return
      const user = authenticatedUser
      if (!user) return
      try {
        const allowed = await can(user, 'read', collection)
        if (allowed) {
          socket.join(`collection:${collection}`)
        }
      } catch (err) {
        app.log.warn({ err, collection }, 'collection:join permission check failed')
      }
    })
    socket.on('collection:leave', (payload: { collection?: string }) => {
      const collection = payload?.collection
      if (typeof collection === 'string' && collection.length > 0) {
        socket.leave(`collection:${collection}`)
      }
    })
    socket.on('disconnect', () => {
      app.log.debug({ socketId: socket.id }, 'Socket disconnected')
    })
  })

  app.decorate('io', io)
  app.addHook('onClose', async () => {
    io.close()
  })
})
