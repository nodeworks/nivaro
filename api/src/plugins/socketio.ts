import { createAdapter } from '@socket.io/redis-adapter'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { Redis } from 'ioredis'
import { Server as SocketIOServer } from 'socket.io'
import { db } from '../db/index.js'

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

    // Authenticate the socket via the user's static token and join their
    // personal room so real-time notifications can be targeted to them.
    socket.on('auth', async (payload: { token?: string }) => {
      const token = payload?.token?.trim()
      if (!token) return
      try {
        const user = await db('nivaro_users')
          .where({ static_token: token, status: 'active' })
          .first('id')
        if (user) {
          socket.join(`user:${user.id}`)
          socket.emit('auth:ok', { userId: user.id })
        }
      } catch (err) {
        app.log.warn({ err }, 'Socket auth failed')
      }
    })

    socket.on('presence:join', (roomId: string) => {
      socket.join(`presence:${roomId}`)
    })
    socket.on('presence:leave', (roomId: string) => {
      socket.leave(`presence:${roomId}`)
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
