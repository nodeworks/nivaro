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
  // record room → socketId → viewer (presence v2)
  const recordViewers = new Map<string, Map<string, { id: string; name: string }>>()
  // socketId → where in the admin that user is right now (presence map;
  // per-node like recordViewers — same accepted Redis-adapter limitation)
  const pagePresence = new Map<
    string,
    { user: { id: string; name: string }; path: string; since: number }
  >()

  function presenceSnapshot() {
    return [...pagePresence.values()]
  }

  // Journey trail — last persisted journey row per socket, so the next ping
  // (or disconnect) can stamp how long the user stayed on the page.
  const journeyTail = new Map<string, { rowId: number; enteredAt: number }>()

  async function closeJourneyRow(socketId: string) {
    const tail = journeyTail.get(socketId)
    if (!tail) return
    journeyTail.delete(socketId)
    const seconds = Math.round((Date.now() - tail.enteredAt) / 1000)
    try {
      await db('nivaro_admin_journeys')
        .where({ id: tail.rowId })
        .update({ duration_seconds: Math.min(seconds, 8 * 3600) })
    } catch {
      /* journey bookkeeping never breaks sockets */
    }
  }

  async function openJourneyRow(socketId: string, userId: string, path: string) {
    try {
      const [row] = await db('nivaro_admin_journeys')
        .insert({
          user: userId,
          session_id: socketId,
          path,
          entered_at: new Date()
        })
        .returning('id')
      const rowId = typeof row === 'object' ? (row as { id: number }).id : row
      journeyTail.set(socketId, { rowId: Number(rowId), enteredAt: Date.now() })
    } catch {
      /* table may not exist mid-migration — skip silently */
    }
  }


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
    // ── Record presence v2 — viewer avatars + field editing indicators ──────
    // Room per record; viewer lists live in a module-level map (single-node
    // fidelity — with the Redis adapter, cross-node lists degrade gracefully
    // to per-node views, same accepted limitation as presence:join rooms).
    let joinedRecordRoom: string | null = null
    const displayName = (u: User) =>
      [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email

    const broadcastViewers = (room: string) => {
      const viewers = [...(recordViewers.get(room)?.values() ?? [])]
      io.to(room).emit('record:viewers', { viewers })
    }
    const leaveRecordRoom = () => {
      if (!joinedRecordRoom) return
      const room = joinedRecordRoom
      joinedRecordRoom = null
      socket.leave(room)
      const map = recordViewers.get(room)
      if (map) {
        map.delete(socket.id)
        if (map.size === 0) recordViewers.delete(room)
      }
      broadcastViewers(room)
    }

    socket.on('record:join', async (payload: { collection?: string; item?: string }) => {
      const { collection, item } = payload ?? {}
      const user = authenticatedUser
      if (!user || typeof collection !== 'string' || !collection || item == null) return
      try {
        if (!(await can(user, 'read', collection))) return
      } catch {
        return
      }
      leaveRecordRoom()
      const room = `record:${collection}:${String(item)}`
      joinedRecordRoom = room
      socket.join(room)
      let map = recordViewers.get(room)
      if (!map) {
        map = new Map()
        recordViewers.set(room, map)
      }
      map.set(socket.id, { id: user.id, name: displayName(user) })
      broadcastViewers(room)
    })
    socket.on('record:leave', () => leaveRecordRoom())

    // Mission-control pulse — admin-only live activity stream
    socket.on('pulse:join', async () => {
      const user = authenticatedUser
      if (!user?.role) return
      try {
        const role = await db('nivaro_roles').where({ id: user.role }).first()
        if (role?.admin_access) socket.join('pulse')
      } catch {
        /* silent, same style as other joins */
      }
    })
    socket.on('pulse:leave', () => socket.leave('pulse'))

    // ── Presence map — who's on which admin page right now ──────────────────
    socket.on('page:at', (payload: { path?: string }) => {
      const user = authenticatedUser
      if (!user || typeof payload?.path !== 'string') return
      const path = payload.path.slice(0, 200)
      const existing = pagePresence.get(socket.id)
      const changed = existing?.path !== path
      pagePresence.set(socket.id, {
        user: { id: user.id, name: displayName(user) },
        path,
        since: changed ? Date.now() : existing.since
      })
      if (changed) {
        void closeJourneyRow(socket.id).then(() => openJourneyRow(socket.id, user.id, path))
      }
      io.to('presence-map').emit('presence-map:update', presenceSnapshot())
    })
    socket.on('presence-map:join', async () => {
      const user = authenticatedUser
      if (!user?.role) return
      try {
        const role = await db('nivaro_roles').where({ id: user.role }).first()
        if (role?.admin_access) {
          socket.join('presence-map')
          socket.emit('presence-map:update', presenceSnapshot())
        }
      } catch {
        /* silent */
      }
    })
    socket.on('presence-map:leave', () => socket.leave('presence-map'))

    // Field editing indicator — fan out inside the record room only.
    socket.on('field:focus', (payload: { field?: string }) => {
      const user = authenticatedUser
      if (!user || !joinedRecordRoom || typeof payload?.field !== 'string') return
      socket.to(joinedRecordRoom).emit('field:editing', {
        field: payload.field,
        user: { id: user.id, name: displayName(user) }
      })
    })
    // Live co-editing v3 — relay value keystrokes inside the record room.
    // Preview-only on the receiving side; persistence still goes through the
    // normal save path with all its validation.
    socket.on('field:change', (payload: { field?: string; value?: unknown }) => {
      const user = authenticatedUser
      if (!user || !joinedRecordRoom || typeof payload?.field !== 'string') return
      const value = typeof payload.value === 'string' ? payload.value.slice(0, 300) : payload.value
      socket.to(joinedRecordRoom).emit('field:changed', {
        field: payload.field,
        value,
        user: { id: user.id, name: displayName(user) }
      })
    })

    socket.on('field:blur', (payload: { field?: string }) => {
      const user = authenticatedUser
      if (!user || !joinedRecordRoom || typeof payload?.field !== 'string') return
      socket.to(joinedRecordRoom).emit('field:editing', { field: payload.field, user: null })
    })

    socket.on('disconnect', () => {
      leaveRecordRoom()
      void closeJourneyRow(socket.id)
      if (pagePresence.delete(socket.id)) {
        io.to('presence-map').emit('presence-map:update', presenceSnapshot())
      }
      app.log.debug({ socketId: socket.id }, 'Socket disconnected')
    })
  })

  app.decorate('io', io)
  app.addHook('onClose', async () => {
    io.close()
  })
})
