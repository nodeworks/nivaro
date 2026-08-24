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

// record room → socketId → viewer (presence v2). Module scope so services
// (notification suppression #269) can ask "is this user viewing this record"
// without a plugin reference. Per-node, same accepted Redis-adapter limitation.
const recordViewers = new Map<string, Map<string, { id: string; name: string }>>()

/** Presence-aware suppression (#269): is the user actively viewing the record
 *  RIGHT NOW (joined its record room on this node)? */
export function isUserViewing(collection: string, item: string, userId: string): boolean {
  const map = recordViewers.get(`record:${collection}:${item}`)
  if (!map) return false
  for (const v of map.values()) if (v.id === userId) return true
  return false
}

/** Per-socket connection metadata for the realtime diagnostics page (#270). */
interface SocketMeta {
  user: { id: string; name: string } | null
  connectedAt: number
  rtt: number | null
  reconnects: number
  app: string | null
}
const socketMeta = new Map<string, SocketMeta>()
let _ioRef: SocketIOServer | null = null

export function getRealtimeStats(): {
  sockets: Array<SocketMeta & { id: string; rooms: string[] }>
  rooms: Array<{ room: string; size: number }>
} {
  const io = _ioRef
  const sockets: Array<SocketMeta & { id: string; rooms: string[] }> = []
  if (io) {
    for (const [id, sock] of io.sockets.sockets) {
      const meta = socketMeta.get(id) ?? {
        user: null,
        connectedAt: Date.now(),
        rtt: null,
        reconnects: 0,
        app: null
      }
      sockets.push({ id, ...meta, rooms: [...sock.rooms].filter((r) => r !== id) })
    }
  }
  const rooms: Array<{ room: string; size: number }> = []
  if (io) {
    for (const [room, set] of io.sockets.adapter.rooms) {
      if (!io.sockets.sockets.has(room)) rooms.push({ room, size: set.size })
    }
    rooms.sort((a, b) => b.size - a.size)
  }
  return { sockets, rooms: rooms.slice(0, 100) }
}

/** Local concurrency snapshot for the sampling cron (#275). */
export function getLocalConcurrency(): { sockets: number; users: number } {
  const users = new Set<string>()
  for (const m of socketMeta.values()) if (m.user) users.add(m.user.id)
  return { sockets: _ioRef?.engine?.clientsCount ?? socketMeta.size, users: users.size }
}

/** Now-editing pulse (#273): per-node record-room viewers snapshot. */
export function getRecordViewerSnapshot(): Array<{
  collection: string
  item: string
  viewers: Array<{ id: string; name: string }>
}> {
  const out: Array<{ collection: string; item: string; viewers: Array<{ id: string; name: string }> }> = []
  for (const [room, map] of recordViewers) {
    const m = room.match(/^record:([^:]+):(.+)$/)
    if (m) out.push({ collection: m[1], item: m[2], viewers: [...map.values()] })
  }
  return out
}

// Watch rooms admins may join via admin:join (traffic feed, job progress,
// monitor flips). Allowlisted — a socket can't invent a privileged room name.
const WATCH_ROOMS = new Set(['traffic', 'jobs', 'monitors', 'firehose', 'flows'])

export const socketioPlugin = fp(async (app: FastifyInstance) => {
  const io = new SocketIOServer(app.server, {
    cors: { origin: '*', credentials: true },
    transports: ['websocket', 'polling']
  })
  _ioRef = io

  const pubClient = new Redis(app.redis.options)
  const subClient = new Redis(app.redis.options)

  io.adapter(createAdapter(pubClient, subClient))
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
    socketMeta.set(socket.id, {
      user: null,
      connectedAt: Date.now(),
      rtt: null,
      reconnects: 0,
      app: null
    })
    // RTT sampling for the diagnostics page (#270): app-level ping so we
    // measure the full path our own events travel.
    const rttTimer = setInterval(() => {
      socket.emit('nvr:ping', { t: Date.now() })
    }, 25_000)
    socket.emit('nvr:ping', { t: Date.now() })
    socket.on('nvr:pong', (payload: { t?: number }) => {
      const meta = socketMeta.get(socket.id)
      if (meta && typeof payload?.t === 'number') meta.rtt = Date.now() - payload.t
    })
    // Client self-report: reconnect count + which app (admin/efp-new).
    socket.on('client:hello', (payload: { reconnects?: number; app?: string }) => {
      const meta = socketMeta.get(socket.id)
      if (!meta) return
      if (typeof payload?.reconnects === 'number') meta.reconnects = payload.reconnects
      if (typeof payload?.app === 'string') meta.app = payload.app.slice(0, 50)
    })

    // Missed-event catch-up (#266): client sends its last-seen sequence after
    // (re)joining its rooms; we replay what it missed, or tell it honestly
    // that the window is gone and it should refetch.
    socket.on('catchup', async (payload: { cursor?: number }) => {
      const cursor = Number(payload?.cursor)
      if (!Number.isFinite(cursor) || cursor < 0) return
      try {
        const { replaySince } = await import('../services/event-journal.js')
        const rooms = new Set([...socket.rooms].filter((r) => r !== socket.id))
        const result = await replaySince(cursor, rooms)
        if (result.full) socket.emit('catchup:full', {})
        else socket.emit('catchup:events', { events: result.events })
      } catch (err) {
        app.log.debug({ err }, 'catchup failed')
        socket.emit('catchup:full', {})
      }
    })

    // Admin watch rooms (#271 jobs, #276 traffic, #279 monitors).
    socket.on('admin:join', async (payload: { room?: string }) => {
      const room = payload?.room
      const user = authenticatedUser
      if (!user?.role || typeof room !== 'string' || !WATCH_ROOMS.has(room)) return
      try {
        const role = await db('nivaro_roles').where({ id: user.role }).first()
        if (role?.admin_access) socket.join(`watch:${room}`)
      } catch {
        /* silent */
      }
    })
    socket.on('admin:leave', (payload: { room?: string }) => {
      const room = payload?.room
      if (typeof room === 'string' && WATCH_ROOMS.has(room)) socket.leave(`watch:${room}`)
    })

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
    // A connection asserts ONLINE-ness only. It must not stamp activity: the
    // socket reconnects on its own (network blips, laptop wake), and treating
    // each reconnect as input reset the idle clock — people flipped from
    // "Idle · 12m" back to bare "Idle" every reconnect. The client's own
    // beats carry is_idle/last_active, the actual input claims.
    await writePresence(userId, {
      is_online: true,
      last_seen: now
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
            const meta = socketMeta.get(socket.id)
            if (meta)
              meta.user = {
                id: user.id,
                name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email
              }
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
            const meta = socketMeta.get(socket.id)
            if (meta)
              meta.user = {
                id: user.id,
                name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email
              }
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
          const meta = socketMeta.get(socket.id)
          if (meta)
            meta.user = {
              id: user.id,
              name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email
            }
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

    // Comment typing (#263): "X is writing a note…" relayed to co-viewers of
    // the same record. Ephemeral — no persistence, room members only.
    socket.on(
      'comment:typing',
      (payload: { collection?: string; item?: string; user_name?: string }) => {
        const { collection, item, user_name } = payload ?? {}
        if (!collection || !item) return
        socket
          .to(`record:${collection}:${String(item)}`)
          .emit('record:comment-typing', { collection, item, user_name: String(user_name ?? '').slice(0, 80) })
      }
    )
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

    // Upload presence (#282): "Beth is uploading quote.pdf" chips for
    // co-viewers. Start/done only — fetch-based uploads have no progress.
    socket.on('record:uploading', (payload: { name?: string; state?: string }) => {
      const user = authenticatedUser
      if (!user || !joinedRecordRoom) return
      const state = payload?.state === 'done' ? 'done' : 'start'
      const [, roomCollection, ...roomItem] = joinedRecordRoom.split(':')
      socket.to(joinedRecordRoom).emit('record:uploading', {
        collection: roomCollection,
        item: roomItem.join(':'),
        user: user.id,
        user_name: displayName(user),
        name: String(payload?.name ?? 'a file').slice(0, 200),
        state
      })
    })

    socket.on('disconnect', () => {
      clearInterval(rttTimer)
      socketMeta.delete(socket.id)
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
