import { createAdapter } from '@socket.io/redis-adapter'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { Redis } from 'ioredis'
import { Server as SocketIOServer } from 'socket.io'
import { db } from '../db/index.js'
import { canSeeRoom } from '../services/chat.js'
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

  /**
   * Live connections per user. Presence is derived from these rather than from
   * a heartbeat timestamp: the socket knows exactly when someone arrives and
   * leaves, where a timestamp can only be compared against a window — which is
   * why closing a tab used to leave someone "online" for a minute and a
   * backgrounded tab (whose timers the browser throttles) dropped off while
   * still open.
   *
   * A SET of socket ids, not a count, because multiple tabs are normal and one
   * closing must not report the person gone.
   */
  const liveSockets = new Map<string, Set<string>>()

  /** Presence writes must never take down a socket. */
  const writePresence = async (userId: string, patch: Record<string, unknown>) => {
    try {
      const updated = await db('user_presence').where({ user_id: userId }).update(patch)
      if (updated === 0) {
        await db('user_presence')
          .insert({ user_id: userId, ...patch })
          .catch(() => {
            // UNIQUE(user_id): another tab won the insert, so update instead.
            return db('user_presence').where({ user_id: userId }).update(patch)
          })
      }
      // Tell every viewer rather than making them poll. This is the whole
      // reason the list can feel instant instead of up to a minute stale.
      io.emit('presence:changed', { user_id: userId })
    } catch (err) {
      app.log.debug({ err, userId }, 'presence write failed')
    }
  }

  const markOnline = async (userId: string, socketId: string) => {
    const set = liveSockets.get(userId) ?? new Set<string>()
    set.add(socketId)
    liveSockets.set(userId, set)
    const now = new Date()
    // Connecting IS activity: it takes a real interaction to open the app.
    await writePresence(userId, {
      is_online: true,
      is_idle: false,
      last_seen: now,
      last_active: now
    })
  }

  const markOffline = async (userId: string, socketId: string) => {
    const set = liveSockets.get(userId)
    if (!set) return
    set.delete(socketId)
    if (set.size > 0) return // other tabs still open
    liveSockets.delete(userId)
    await writePresence(userId, { is_online: false, last_seen: new Date() })
  }

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
            void markOnline(user.id, socket.id)
          }
          return
        }

        // Masquerade token (nvm_) — resolves to the target user; NOT one-time,
        // lives as long as the Redis masq:<token> entry the auth route minted.
        if (token.startsWith('nvm_')) {
          const raw = await app.redis.get(`masq:${token}`)
          if (!raw) return
          const payloadIds = JSON.parse(raw) as { user_id?: string }
          const user = await db<User>('nivaro_users')
            .where({ id: payloadIds.user_id, status: 'active' })
            .first()
          if (user) {
            authenticatedUser = user
            socket.join(`user:${user.id}`)
            socket.emit('auth:ok', { userId: user.id })
            void markOnline(user.id, socket.id)
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

    /**
     * Idle flips arrive as they happen instead of riding the next heartbeat,
     * so going idle and coming back are both seen within a second rather than
     * up to half a minute later — the lag is most of what made this feel
     * inconsistent. Gated on auth: presence is an identity claim.
     */
    socket.on('presence:idle', (payload: { idle?: boolean }) => {
      if (!authenticatedUser) return
      const idle = payload?.idle === true
      const now = new Date()
      void writePresence(authenticatedUser.id, {
        is_idle: idle,
        last_seen: now,
        // Coming back IS the activity; going idle must not stamp it, or the
        // server's own staleness check would read the person as just-active.
        ...(idle ? {} : { last_active: now })
      })
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
    // Chat rooms are joined individually and gated by the SAME canSeeRoom the
    // REST routes use — a socket must not become a way to observe a room you
    // cannot read. Rejects silently, matching collection:join's posture.
    socket.on('chat:join', async (payload: { room?: string }) => {
      const room = payload?.room
      if (typeof room !== 'string' || room.length === 0) return
      const user = authenticatedUser
      if (!user) return
      try {
        if (await canSeeRoom(user, room)) socket.join(`chat:${room}`)
      } catch (err) {
        app.log.warn({ err, room }, 'chat:join visibility check failed')
      }
    })

    socket.on('chat:leave', (payload: { room?: string }) => {
      const room = payload?.room
      if (typeof room === 'string' && room) socket.leave(`chat:${room}`)
    })

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
      // Same-origin absolute path only — never persist something that could
      // later render as a javascript:/protocol-relative link in the admin.
      if (!/^\/(?!\/)[A-Za-z0-9/_\-?=&.%~]*$/.test(payload.path)) return
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
      if (authenticatedUser) void markOffline(authenticatedUser.id, socket.id)
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
