import { createServer } from 'node:http'
import { createAdapter } from '@socket.io/redis-adapter'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { Redis } from 'ioredis'
import type { Knex } from 'knex'
import { Server as SocketIOServer } from 'socket.io'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { userHasSocket } from '../services/ai-stream-delivery.js'
import { chaosRedisClient, chaosRedisSubscriber } from '../services/chaos/redis-hook.js'
import { canSeeRoom } from '../services/chat.js'
import { type ClientVersion, clientVersionFromHello } from '../services/client-version.js'
import {
  CLIENT_DATA_KEY,
  type ClientData,
  groupClientVersions,
  listClusterClients,
  listClusterClientsCached,
  makeBuildJudge,
  olderClientIds,
  type StaleBuild,
  staleBuildsByUser,
  type VersionGroup
} from '../services/client-versions-cluster.js'
import { fullHuddleDeps, registerHuddle } from '../services/huddle.js'
import { defaultHuddleCollabDeps, registerHuddleCollab } from '../services/huddle-collab.js'
import { INSTANCE_ID } from '../services/instance-roster.js'
import { touchMasqueradeMarker } from '../services/masquerade-marker.js'
import { opsRoom, opsTopicGate } from '../services/ops-live.js'
import { parsePageAt } from '../services/page-at.js'
import { can } from '../services/permissions.js'
import { createPresenceChangedCoalescer } from '../services/presence-changed.js'
import {
  distinctViewerIds,
  PRESENCE_WATCH_MAX,
  parseWatchItems,
  rowsRoomName
} from '../services/presence-rows.js'
import {
  addPresenceSocket,
  hasPresenceSocket,
  isPresenceRefreshOwner,
  PRESENCE_OFFLINE_GRACE_MS,
  PRESENCE_ONLINE_WINDOW_MS,
  PRESENCE_REFRESH_MS,
  removePresenceSocket
} from '../services/presence-sockets.js'
import {
  addTopicViewer,
  cleanSelectionKey,
  cleanSignalState,
  isPresenceTopic,
  isSelectionTopic,
  RECORD_SIGNAL_KINDS,
  removeSocketFromTopics,
  removeTopicViewer,
  setTopicViewerSelection,
  TOPIC_SIGNAL_KINDS,
  topicViewers
} from '../services/presence-topics.js'
import { socketsServed } from '../services/process-role.js'
import { emitToTenant } from '../services/record-events.js'
import { registerReplayWatch } from '../services/replay-watch.js'
import {
  canJoinTicketTopic,
  canSeeRecordRoom,
  isKnownCollection,
  masqRoom,
  parseWsTokenValue,
  RECHECK_EVENT,
  type RecheckTarget,
  runLocalRecheck,
  type SocketAccessHooks,
  type SocketBind,
  sessionRoom,
  sha,
  sweepSockets,
  userWithApiKey,
  visibleRecordIds
} from '../services/socket-access.js'
import {
  type EngineConnLike,
  instrumentHandlers,
  markResync,
  noteRoomGap,
  type SocketBuffer,
  startSocketHealth,
  takeResync,
  trackSocket
} from '../services/socket-health.js'
import { inSocketTenant, socketTenant, socketTrafficStore } from '../services/socket-tenant.js'
import {
  type Coalescer,
  collectionUpdateOf,
  createCoalescer,
  encodeEvent,
  eventNameOf,
  isCredentialRoom,
  isInspected,
  noteCoalesced,
  noteInspected,
  noteInspectedHandler,
  noteTenantSocket,
  recordOutbound,
  splitTenantRoom
} from '../services/socket-transport.js'
import { attachSocketVerification } from '../services/socket-verify.js'
import { currentTenantKey, tenantScopedRoom } from '../services/tenant-rooms.js'
import { registerWidgetLive } from '../services/widget-live.js'

let pagePresenceReader:
  | ((path: string) => Array<{ id: string; name: string; since: number }>)
  | null = null
/** Users whose latest page ping is `path` (this replica's sockets). */
export function usersOnPath(path: string): Array<{ id: string; name: string; since: number }> {
  return pagePresenceReader ? pagePresenceReader(path) : []
}

let pagePrefixReader: ((prefixes: string[]) => string[]) | null = null
/**
 * #1371 — users whose latest page ping sits under any of `prefixes` (this
 * replica's sockets): who an auto-record signal about a route reaches.
 */
export function usersOnPathPrefix(prefixes: string[]): string[] {
  return pagePrefixReader ? pagePrefixReader(prefixes) : []
}

import { noteSocket } from '../services/traffic-map.js'
import {
  noteRoomBroadcast,
  noteRoomDelivery,
  noteSocketApp,
  noteSocketClose,
  noteSocketOpen,
  noteSocketTransport
} from '../services/traffic-taps/realtime.js'
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
  // Cloud: record rooms are per tenant — the caller's tenant (its request context).
  const map = recordViewers.get(tenantScopedRoom(`record:${collection}:${item}`))
  if (!map) return false
  for (const v of map.values()) if (v.id === userId) return true
  return false
}

/** Per-socket connection metadata for the realtime diagnostics page (#270). */
export interface SocketMeta {
  user: { id: string; name: string } | null
  connectedAt: number
  rtt: number | null
  reconnects: number
  app: string | null
  /** #1048 — the build this tab runs (from client:hello); null = not reported. */
  version: ClientVersion | null
  /** #1672 — the engine transport right now: 'websocket' or 'polling' (the fallback). */
  transport: string | null
  /** #1681 — the client said it understands coalesced collection:update messages. */
  coalesce: boolean
  /** #2475 — the connection is a browser's shared worker, carrying every tab of that app. */
  shared_worker: boolean
}
const socketMeta = new Map<string, SocketMeta>()
let _ioRef: SocketIOServer | null = null

/** The person a socket authenticated as on THIS node (null before auth or elsewhere). */
export function socketUserOf(socketId: string): { id: string; name: string } | null {
  return socketMeta.get(socketId)?.user ?? null
}

/**
 * Remote client reload (#285, targeted 2026-09-25): tell every connected
 * client — or only the named people, or only one app's clients, or only tabs
 * on an older build — to show a countdown and reload. Unfiltered and
 * people-only sends ride rooms (`user:<id>`, the tenant's all-room), which the
 * Redis adapter fans out across nodes. App and version filters read each
 * socket's client:hello report, which every replica publishes on socket.data,
 * so those reach matching sockets on every replica too (#1048 follow-up);
 * `partial` says another replica did not answer and only this one's were
 * reached.
 */
export async function emitForceRefresh(
  target: { userIds?: string[]; app?: string | null; older?: boolean },
  payload: { seconds: number; message: string }
): Promise<{
  sockets: number
  users: number
  nodes: number
  partial: boolean
  settling: Record<string, string>
}> {
  const io = _ioRef
  if (!io) return { sockets: 0, users: 0, nodes: 0, partial: false, settling: {} }
  const userIds = (target.userIds ?? []).map((u) => String(u).toUpperCase())
  const app = target.app ? String(target.app).slice(0, 50) : null
  const older = target.older === true
  const wanted = new Set(userIds)
  // Cloud: an administrator refreshes their own tenant's tabs only (the caller's context).
  const tenant = process.env.CLOUD_META_DB_URL ? currentTenantKey() || '-' : null
  const cluster = await listClusterClients(io, tenant)
  // #1048 — "older" is judged across the whole cluster, deploy-aware (makeBuildJudge): an app
  // whose deploy is still rolling is settling and none of its tabs are reloaded.
  const judge = makeBuildJudge(cluster.clients, { roster: cluster.roster })
  const olderIds = older ? olderClientIds(cluster.clients, judge) : null
  const filtered = !!app || older
  let sockets = 0
  const users = new Set<string>()
  for (const c of cluster.clients) {
    const uid = String(c.user!.id).toUpperCase()
    if (wanted.size && !wanted.has(uid)) continue
    if (app && c.app !== app) continue
    if (olderIds && !olderIds.has(c.id)) continue
    sockets++
    users.add(uid)
    // Filtered sends go to each matching socket (local or remote); the others use rooms
    // below, so skip the direct emit to avoid double delivery.
    if (filtered) c.emit('client:force-refresh', payload)
  }
  if (!filtered) {
    if (wanted.size)
      for (const u of userIds) io.to(`user:${u}`).emit('client:force-refresh', payload)
    else if (tenant != null) io.to(tenantSocketsRoom(tenant)).emit('client:force-refresh', payload)
    else io.emit('client:force-refresh', payload)
  }
  return {
    sockets,
    users: users.size,
    nodes: cluster.nodes,
    partial: cluster.partial,
    settling: older ? Object.fromEntries(judge.settling) : {}
  }
}

/** Cloud: every signed-in socket of a tenant sits in this room (record-events.ts
 *  TENANT_ALL_ROOM, joined at sign-in), on every replica — force refresh rides it. */
function tenantSocketsRoom(tenant: string): string {
  return tenantScopedRoom('all', tenant)
}

export function getRealtimeStats(): {
  sockets: Array<SocketMeta & { id: string; tenant: string | null; rooms: string[] }>
  rooms: Array<{ room: string; size: number }>
} {
  const io = _ioRef
  const sockets: Array<SocketMeta & { id: string; tenant: string | null; rooms: string[] }> = []
  if (io) {
    for (const [id, sock] of io.sockets.sockets) {
      const meta = socketMeta.get(id) ?? {
        user: null,
        connectedAt: Date.now(),
        rtt: null,
        reconnects: 0,
        app: null,
        version: null,
        transport: null,
        coalesce: false,
        shared_worker: false
      }
      sockets.push({
        id,
        ...meta,
        tenant: (sock.data?.nvrTenantKey as string | undefined) ?? null,
        rooms: [...sock.rooms].filter((r) => r !== id && !isCredentialRoom(r))
      })
    }
  }
  const rooms: Array<{ room: string; size: number }> = []
  if (io) {
    for (const [room, set] of io.sockets.adapter.rooms) {
      if (!io.sockets.sockets.has(room) && !isCredentialRoom(room))
        rooms.push({ room, size: set.size })
    }
    rooms.sort((a, b) => b.size - a.size)
  }
  return { sockets, rooms: rooms.slice(0, 100) }
}

/**
 * #1048 — this node's open tabs grouped by the build they run (services/client-versions-cluster
 * groupClientVersions). /realtime reads getClusterClientVersionGroups instead; this stays for a
 * caller that wants one process only.
 */
export function getClientVersionGroups(
  tenant: string | null = null,
  // Test seam: the node's socket metadata and how a socket id maps to its tenant.
  deps: {
    metas: Map<string, SocketMeta>
    tenantOf: (socketId: string) => string | null
  } = { metas: socketMeta, tenantOf: socketTenantKey }
): VersionGroup[] {
  // Cloud: only the caller's tenant's tabs. The "current build" is judged from those tabs too.
  const metas = [...deps.metas.entries()]
    .filter(([id]) => tenant == null || deps.tenantOf(id) === tenant)
    .map(([, m]) => m)
  return groupClientVersions(metas)
}

/**
 * #1048 — open tabs by build on EVERY replica (socket.data via the Redis adapter). `nodes` =
 * API processes with signed-in sockets; `partial` = another replica did not answer, so only
 * this process's tabs are counted.
 */
export async function getClusterClientVersionGroups(tenant: string | null): Promise<{
  groups: VersionGroup[]
  nodes: number
  partial: boolean
  roster: string[]
  settling: Record<string, string>
}> {
  const cluster = await listClusterClients(_ioRef, tenant)
  const judge = makeBuildJudge(cluster.clients, { roster: cluster.roster })
  return {
    groups: groupClientVersions(cluster.clients, judge),
    nodes: cluster.nodes,
    partial: cluster.partial,
    roster: cluster.roster,
    settling: Object.fromEntries(judge.settling)
  }
}

/**
 * Per person (upper-cased id), the apps they have open on an old build, across the cluster.
 * For the admin-only presence badge; cached a few seconds per tenant.
 */
export async function getClusterStaleBuilds(
  tenant: string | null
): Promise<Map<string, StaleBuild[]>> {
  const cluster = await listClusterClientsCached(_ioRef, tenant)
  return staleBuildsByUser(
    cluster.clients,
    makeBuildJudge(cluster.clients, { roster: cluster.roster })
  )
}

/** The tenant key a socket on this node resolved to (cloud), or null. */
function socketTenantKey(socketId: string): string | null {
  const key = _ioRef?.sockets.sockets.get(socketId)?.data?.nvrTenantKey
  return typeof key === 'string' ? key : null
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
  const out: Array<{
    collection: string
    item: string
    viewers: Array<{ id: string; name: string }>
  }> = []
  // Cloud: only the caller's tenant's record rooms (viewer names must not cross tenants).
  const tenant = currentTenantKey()
  for (const [scoped, map] of recordViewers) {
    const { tenant: roomTenant, room } = splitTenantRoom(scoped)
    if (roomTenant !== tenant) continue
    const m = room.match(/^record:([^:]+):(.+)$/)
    if (m) out.push({ collection: m[1], item: m[2], viewers: [...map.values()] })
  }
  return out
}

// Watch rooms admins may join via admin:join (traffic feed, job progress,
// monitor flips). Allowlisted — a socket can't invent a privileged room name.
const WATCH_ROOMS = new Set([
  'traffic',
  'jobs',
  'monitors',
  'firehose',
  'flows',
  'traffic-map',
  'conformance',
  'imports',
  // #2016 — incident mode on/off (payload-free; the banner re-reads the admin route)
  'ops',
  'ai-calls',
  // #2827 — chaos runs and their events (the console's cockpit)
  'chaos'
])

/**
 * Per-socket join/leave ordering for watch rooms. `admin:join` awaits a role lookup while
 * `admin:leave` is synchronous, so a quick join + leave would otherwise land the join AFTER
 * the leave and keep the socket in the room forever. Every join/leave bumps the room's
 * generation; a join whose generation moved during its await is dropped.
 */
export function createWatchRoomGate(): {
  join(room: string, allowed: () => Promise<boolean>, doJoin: () => void): Promise<boolean>
  leave(room: string, doLeave: () => void): void
} {
  const gen = new Map<string, number>()
  const bump = (room: string) => {
    const g = (gen.get(room) ?? 0) + 1
    gen.set(room, g)
    return g
  }
  return {
    async join(room, allowed, doJoin) {
      const g = bump(room)
      let ok = false
      try {
        ok = await allowed()
      } catch {
        ok = false
      }
      if (!ok || gen.get(room) !== g) return false
      doJoin()
      return true
    },
    leave(room, doLeave) {
      bump(room)
      doLeave()
    }
  }
}

/**
 * #1672 — whether clients may fall back to HTTP long-polling when the websocket upgrade is
 * blocked. Polling needs sticky sessions behind a load balancer (each poll must reach the
 * process holding the session); `SOCKET_POLLING=off` turns it off where the balancer is not
 * sticky, and clients then fall back to the read-only SSE stream instead.
 */
export function socketPollingAllowed(): boolean {
  return (process.env.SOCKET_POLLING ?? 'on').toLowerCase() !== 'off'
}

/** #1730 — per-message deflate for frames over 1 KB; `SOCKET_COMPRESSION=off` disables it. */
export function socketCompressionOn(): boolean {
  return (process.env.SOCKET_COMPRESSION ?? 'on').toLowerCase() !== 'off'
}

/** The room a broadcast is being written for (set around adapter.apply; null = direct emit). */
let broadcastRoom: string | null = null

function roomsLabel(rooms: unknown): string | null {
  if (!(rooms instanceof Set) || rooms.size === 0) return 'all'
  return String([...rooms][0])
}

export const socketioPlugin = fp(async (app: FastifyInstance) => {
  // Post-mortem 3.3 — SOCKETS=off (a web process beside a realtime tier): bound to an HTTP
  // server that never listens, so this process serves no /socket.io, while what it emits still
  // reaches the realtime processes' clients through the Redis adapter and the event stream.
  const io = new SocketIOServer(socketsServed() ? app.server : createServer(), {
    cors: { origin: '*', credentials: true },
    transports: socketPollingAllowed() ? ['websocket', 'polling'] : ['websocket'],
    perMessageDeflate: socketCompressionOn() ? { threshold: 1024 } : false
  })
  _ioRef = io
  // #2460 / #2488 / #2779 / #2462 — buffer growth samples and this process's figures for the
  // Realtime console, published to Redis every 10 s so every replica's view merges.
  startSocketHealth(app.redis ?? null)

  const pubClient = new Redis(app.redis.options)
  const subClient = new Redis(app.redis.options)
  // Without listeners ioredis prints "missing 'error' handler" on every reconnect attempt
  // while Redis is away (seen during a staging deploy); log once a minute per client.
  for (const [name, client] of [
    ['pub', pubClient],
    ['sub', subClient]
  ] as const) {
    let lastLog = 0
    client.on('error', (err: Error) => {
      if (Date.now() - lastLog < 60_000) return
      lastLog = Date.now()
      app.log.warn({ err, client: name }, 'Socket.io Redis adapter client error')
    })
  }
  // #2832 / #2838 — the Redis fault seam: latency on the publisher, a partition cuts both.
  chaosRedisClient(pubClient)
  chaosRedisSubscriber(subClient)

  // Redis pub/sub channels ignore the db index, so two APIs on one Redis
  // (pnpm dev:db beside the dev API) would deliver each other's room events.
  // REDIS_CHANNEL_PREFIX keeps them apart; unset = the historic channel names.
  io.adapter(
    createAdapter(pubClient, subClient, {
      key: `${process.env.REDIS_CHANNEL_PREFIX ?? ''}socket.io`
    })
  )
  // #1730 — byte accounting per room: every broadcast (local or relayed from another replica)
  // writes to its sockets inside adapter.apply, so the room in flight is known there.
  {
    const adapter = io.of('/').adapter as unknown as {
      apply(opts: { rooms?: unknown }, cb: (s: unknown) => void): unknown
    }
    const origApply = adapter.apply.bind(adapter)
    adapter.apply = (opts, cb) => {
      const prev = broadcastRoom
      broadcastRoom = roomsLabel(opts?.rooms)
      noteRoomBroadcast(broadcastRoom)
      try {
        return origApply(opts, cb)
      } finally {
        broadcastRoom = prev
      }
    }
  }
  // presence:changed goes out at most once per window per tenant, carrying every changed id
  // (services/presence-changed.ts); the first change of a quiet tenant still goes out at once.
  const presenceChanged = createPresenceChangedCoalescer((tenant, payload) =>
    emitToTenant(tenant, 'presence:changed', payload as unknown as Record<string, unknown>)
  )

  // socketId → where in the admin that user is right now (presence map;
  // per-node like recordViewers — same accepted Redis-adapter limitation)
  // Cloud: each entry carries its socket's tenant ('' self-hosted); every reader and every
  // presence-map broadcast sees one tenant's people only.
  const pagePresence = new Map<
    string,
    {
      user: { id: string; name: string }
      path: string
      since: number
      app?: string | null
      tenant: string
    }
  >()

  function presenceSnapshot(tenant: string) {
    return [...pagePresence.values()]
      .filter((p) => p.tenant === tenant)
      .map(({ tenant: _tenant, ...p }) => p)
  }
  /** The tenant's presence-map room, with that tenant's snapshot. */
  function broadcastPresenceMap(tenant: string) {
    io.to(tenantScopedRoom('presence-map', tenant)).emit(
      'presence-map:update',
      presenceSnapshot(tenant)
    )
  }
  // #42 — who else is on this admin page right now (per replica; the caller's tenant).
  pagePresenceReader = (path: string) => {
    const tenant = currentTenantKey()
    const seen = new Map<string, { id: string; name: string; since: number }>()
    for (const p of pagePresence.values()) {
      if (p.path !== path || p.tenant !== tenant) continue
      const cur = seen.get(p.user.id)
      if (!cur || p.since < cur.since) seen.set(p.user.id, { ...p.user, since: p.since })
    }
    return [...seen.values()]
  }

  pagePrefixReader = (prefixes: string[]) => {
    const tenant = currentTenantKey()
    const ids = new Set<string>()
    for (const p of pagePresence.values()) {
      if (p.tenant !== tenant) continue
      if (
        prefixes.some(
          (x) => p.path === x || p.path.startsWith(`${x}/`) || p.path.startsWith(`${x}?`)
        )
      )
        ids.add(p.user.id)
    }
    return [...ids]
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

  async function openJourneyRow(
    socketId: string,
    userId: string,
    path: string,
    app: string | null
  ) {
    try {
      // #1391 — which front end (admin / a portal); skipped until migration 425 lands.
      const withApp = app && (await hasColumn('nivaro_admin_journeys', 'app')) ? { app } : {}
      const [row] = await db('nivaro_admin_journeys')
        .insert({
          user: userId,
          session_id: socketId,
          path,
          entered_at: new Date(),
          ...withApp
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
    // #1104: every inbound event is a counter bump on the Traffic Map's socket lane (no event
    // object, no emit) — the map stays free while nobody watches it.
    noteSocket('connect')
    socket.use((packet, next) => {
      noteSocket(typeof packet?.[0] === 'string' ? packet[0] : 'other')
      next()
    })
    socketMeta.set(socket.id, {
      user: null,
      connectedAt: Date.now(),
      rtt: null,
      reconnects: 0,
      app: null,
      version: null,
      transport: socket.conn?.transport?.name ?? null,
      coalesce: false,
      shared_worker: false
    })
    // #1048 — the build report on socket.data too, which fetchSockets() returns from every
    // replica (services/client-versions-cluster.ts): the versions list and "Old versions"
    // refresh read the whole cluster, not this process's tabs only.
    const publishClient = () => {
      const m = socketMeta.get(socket.id)
      if (!m) return
      const data: ClientData = { app: m.app, version: m.version, user: m.user, node: INSTANCE_ID }
      socket.data[CLIENT_DATA_KEY] = data
    }
    socket.conn?.on?.('upgrade', (t: { name?: string }) => {
      const meta = socketMeta.get(socket.id)
      if (meta) meta.transport = t?.name ?? meta.transport
      noteSocketTransport(socket.id, t?.name)
    })
    // Traffic Map (#2263): what the server can see of this connection, for the long-polling list.
    noteSocketOpen(
      socket.id,
      socket.handshake?.headers as Record<string, unknown> | undefined,
      socket.handshake?.address,
      socket.conn?.transport?.name
    )
    socket.once('disconnect', () => noteSocketClose(socket.id))

    // #1732 — which tenant this socket belongs to (cloud), for per-tenant counters.
    let tenantKey: string | null = null
    if (process.env.CLOUD_META_DB_URL) {
      void socketTenant(socket).then((t) => {
        if (!t || !socket.connected) return
        tenantKey = String(t.tenantId || t.slug)
        socket.data.nvrTenantKey = tenantKey
        socket.data.nvrTenantNames = [t.tenantId, t.slug].filter(Boolean).map(String)
        noteTenantSocket(tenantKey, 1, t.slug)
      })
    }
    // #2779 — every inbound event handler registered on this socket from here on is timed
    // (total and event-loop time); an inspected socket also records each call in its ring.
    instrumentHandlers(
      socket,
      () => tenantKey,
      (handler, ms) => {
        if (isInspected(socket.id)) noteInspectedHandler(socket.id, handler, ms)
      }
    )

    // Cloud: shared room names (chat, pulse, presence, watch) are per tenant (tenant-rooms.ts,
    // `t:<tenant>:`). `scopedRoom` resolves the socket's tenant first (null = none: join
    // nothing); `scopedRoomNow` is for leaves and broadcasts after a join resolved it.
    const cloud = !!process.env.CLOUD_META_DB_URL
    const scopedRoom = async (room: string): Promise<string | null> => {
      if (!cloud) return room
      const t = await socketTenant(socket)
      return t ? tenantScopedRoom(room, String(t.tenantId || t.slug)) : null
    }
    // Before the tenant resolves (cloud) these are null: nothing was joined under a tenant yet,
    // so there is nothing to leave or broadcast — never a shared placeholder room (N6).
    const tenantNow = (): string | null => {
      if (!cloud) return ''
      const key = socket.data.nvrTenantKey
      return typeof key === 'string' && key ? key : null
    }
    const scopedRoomNow = (room: string): string | null => {
      const tenant = tenantNow()
      return tenant == null ? null : tenantScopedRoom(room, tenant)
    }
    const leaveScoped = (room: string) => {
      const name = scopedRoomNow(room)
      if (name) socket.leave(name)
    }

    // #1730 byte accounting + #1681 burst coalescing, at the one place every packet to this
    // socket passes: the client's writeToEngine (broadcasts and direct emits alike).
    const client = socket.client as unknown as {
      writeToEngine(encoded: unknown, opts: Record<string, unknown>): void
    }
    // #2463 chaos, #2760 leak audit, #2477 acks, #2478 replay rooms (services/socket-verify.ts).
    const origWrite = attachSocketVerification(socket, client.writeToEngine.bind(client), {
      rtt: () => socketMeta.get(socket.id)?.rtt ?? null,
      room: () => broadcastRoom
    })
    const sizeOf = (p: unknown) =>
      typeof p === 'string'
        ? Buffer.byteLength(p)
        : p instanceof Uint8Array || p instanceof ArrayBuffer
          ? p.byteLength
          : 0
    let coalescer: Coalescer | null = null
    // #2460 — slow-consumer handling: over the soft limit this socket's room broadcasts are held
    // (one `realtime:stale` names the rooms once it caught up); past the hard limit it is closed
    // with its backlog dropped and its tab reloads on reconnect instead of replaying.
    const buffer: SocketBuffer = trackSocket({
      id: socket.id,
      conn: socket.conn as unknown as EngineConnLike,
      tenant: () => tenantKey,
      info: () => {
        const meta = socketMeta.get(socket.id)
        return {
          user: meta?.user?.name ?? null,
          app: meta?.app ?? null,
          transport: meta?.transport ?? null,
          rooms: socket.rooms
        }
      },
      sendRaw: (encoded) => origWrite(encoded, {}),
      drop: () => {
        try {
          const transport = (
            socket.conn as unknown as {
              transport?: { name?: string; socket?: { terminate?: () => void } }
            }
          ).transport
          if (transport?.name === 'websocket' && transport.socket?.terminate)
            transport.socket.terminate()
          else (socket.conn as unknown as { close(discard?: boolean): void }).close(true)
        } catch {
          socket.disconnect(true)
        }
      },
      onHardLimit: (waiting) => {
        const meta = socketMeta.get(socket.id)
        app.log.warn(
          { socketId: socket.id, waiting, app: meta?.app ?? null },
          'Socket closed: too far behind (slow consumer)'
        )
        void markResync(meta?.user?.id ?? null, meta?.version?.tab ?? null)
      }
    })
    const sendCoalesced = (payload: Record<string, unknown>) => {
      const encoded = encodeEvent('collection:update', payload)
      if (buffer.intercept(encoded, `collection:${String(payload.collection ?? '')}`, false)) return
      recordOutbound(
        'collection:update',
        `collection:${String(payload.collection ?? '')}`,
        sizeOf(encoded),
        tenantKey
      )
      noteRoomDelivery(
        `collection:${String(payload.collection ?? '')}`,
        'collection:update',
        sizeOf(encoded)
      )
      if (isInspected(socket.id))
        noteInspected(
          socket.id,
          'collection:update',
          `collection:${String(payload.collection ?? '')}`,
          sizeOf(encoded)
        )
      origWrite(encoded, {})
      buffer.check()
    }
    client.writeToEngine = (encoded, opts) => {
      const list = Array.isArray(encoded) ? encoded : [encoded]
      const room = broadcastRoom
      for (const p of list) {
        if (buffer.intercept(p, room, !!opts?.volatile)) continue
        if (typeof p === 'string') {
          if (coalescer && !opts?.volatile) {
            const payload = collectionUpdateOf(p)
            if (payload) {
              coalescer.push(payload)
              continue
            }
          }
          recordOutbound(eventNameOf(p) ?? `packet:${p[0] ?? '?'}`, room, sizeOf(p), tenantKey)
          noteRoomDelivery(room, eventNameOf(p) ?? `packet:${p[0] ?? '?'}`, sizeOf(p))
          if (isInspected(socket.id))
            noteInspected(socket.id, eventNameOf(p) ?? `packet:${p[0] ?? '?'}`, room, sizeOf(p))
        } else {
          recordOutbound('binary', room, sizeOf(p), tenantKey)
          noteRoomDelivery(room, 'binary', sizeOf(p))
          if (isInspected(socket.id)) noteInspected(socket.id, 'binary', room, sizeOf(p))
        }
        origWrite(p, opts)
      }
      buffer.check()
    }

    // Zombie socket reaper (#310): a connection that never authenticates is
    // holding a slot for nothing — drop it after 45s. Legit clients auth
    // within the first second of connecting.
    const zombieTimer = setTimeout(() => {
      if (socket.connected && !socketMeta.get(socket.id)?.user) {
        app.log.debug({ socketId: socket.id }, 'Dropping unauthenticated socket')
        socket.disconnect(true)
      }
    }, 45_000)
    zombieTimer.unref?.()
    socket.once('disconnect', () => clearTimeout(zombieTimer))

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
    // Client self-report: reconnect count + which app (admin/headless host).
    // #1048 — and which build the tab runs (build / api / tab / loaded, see client-version).
    socket.on(
      'client:hello',
      (payload: {
        reconnects?: number
        app?: string
        features?: unknown
        transport?: string
        shared_worker?: boolean
      }) => {
        const meta = socketMeta.get(socket.id)
        if (!meta) return
        if (typeof payload?.reconnects === 'number') meta.reconnects = payload.reconnects
        if (payload?.shared_worker === true) meta.shared_worker = true
        if (typeof payload?.app === 'string') meta.app = payload.app.slice(0, 50)
        noteSocketApp(socket.id, payload?.app)
        // #1681 — opt-in: only a client that understands merged messages gets them, so an older
        // client (a portal on a pinned package) keeps one message per change.
        if (
          Array.isArray(payload?.features) &&
          payload.features.includes('coalesce') &&
          !coalescer
        ) {
          meta.coalesce = true
          coalescer = createCoalescer({
            send: sendCoalesced,
            onCollapse: (n) => noteCoalesced(n, tenantKey)
          })
        }
        const version = clientVersionFromHello(payload)
        if (version.build || version.api || version.tab) meta.version = version
        publishClient()
        // #2460 — this tab was closed for falling too far behind: reload, never replay.
        if (meta.user && version.tab) {
          void takeResync(meta.user.id, version.tab).then((owed) => {
            if (!owed || !socket.connected) return
            socket.data.nvrResync = true
            socket.emit('catchup:full', { reason: 'slow-consumer' })
          })
        }
      }
    )

    // #2132 — clock sync: the client stamps its send time, the server answers with its own
    // clock, and the client takes the offset from the midpoint of the round trip.
    socket.on(
      'time:sync',
      (payload: { c?: number }, ack?: (r: { s: number; c: number | null }) => void) => {
        if (typeof ack !== 'function') return
        ack({ s: Date.now(), c: typeof payload?.c === 'number' ? payload.c : null })
      }
    )

    // Missed-event catch-up (#266): client sends its last-seen sequence after
    // (re)joining its rooms; we replay what it missed, or tell it honestly
    // that the window is gone and it should refetch.
    // Cloud: replay runs in the socket's tenant (its journal table), and the
    // socket's rooms are tenant-prefixed, so only its tenant's events return.
    socket.on(
      'catchup',
      inSocketTenant(socket, async (payload: { cursor?: number }) => {
        const cursor = Number(payload?.cursor)
        if (!Number.isFinite(cursor) || cursor < 0) return
        // #2460 — already told to reload (closed as a slow consumer): no replay on top.
        if (socket.data.nvrResync) {
          socket.data.nvrResync = false
          socket.emit('catchup:full', { reason: 'slow-consumer' })
          return
        }
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
    )

    // #2462 — a connected client saw one room's sequence skip: replay that room alone from the
    // last position it had there. Only a room this socket is in; a few per 10 s per socket.
    let roomCatchups = { since: Date.now(), n: 0 }
    socket.on(
      'catchup:room',
      inSocketTenant(
        socket,
        async (payload: { room?: unknown; cursor?: unknown; missed?: unknown }) => {
          const room = typeof payload?.room === 'string' ? payload.room.slice(0, 300) : ''
          const cursor = Number(payload?.cursor)
          if (!room || !Number.isFinite(cursor) || cursor < 0) return
          const now = Date.now()
          if (now - roomCatchups.since > 10_000) roomCatchups = { since: now, n: 0 }
          if (++roomCatchups.n > 10) return
          const scoped = cloud ? scopedRoomNow(room) : room
          if (!scoped || !socket.rooms.has(scoped)) return
          try {
            const { replaySince } = await import('../services/event-journal.js')
            const result = await replaySince(cursor, new Set([scoped]))
            noteRoomGap(
              tenantKey,
              scoped,
              Number(payload?.missed),
              result.full ? 'full' : 'replayed'
            )
            socket.emit('catchup:room:events', { room, full: result.full, events: result.events })
          } catch (err) {
            app.log.debug({ err }, 'room catch-up failed')
            noteRoomGap(tenantKey, scoped, Number(payload?.missed), 'full')
            socket.emit('catchup:room:events', { room, full: true, events: [] })
          }
        }
      )
    )

    // Admin watch rooms (#271 jobs, #276 traffic, #279 monitors).
    const watchGate = createWatchRoomGate()
    // Cloud: every watch room is per tenant. The Traffic Map keeps its store-keyed name
    // (#1132, `watch:traffic-map:<store>`); the others are `t:<tenant>:watch:<room>`
    // (tenant-rooms.ts), the name their emitters use from the tenant's context.
    const watchRoomName = async (room: string): Promise<string | null> => {
      if (!cloud) return `watch:${room}`
      if (room === 'traffic-map') {
        const store = await socketTrafficStore(socket)
        return store ? `watch:traffic-map:${store}` : null
      }
      return scopedRoom(`watch:${room}`)
    }
    const onAdminJoin = async (payload: { room?: string; frames?: unknown }) => {
      const room = payload?.room
      const user = authenticatedUser
      if (!user?.role || typeof room !== 'string' || !WATCH_ROOMS.has(room)) return
      // Self-hosted: no await before the gate, so a quick join + leave keeps its order.
      const name = !cloud ? `watch:${room}` : await watchRoomName(room)
      if (!name) return
      await watchGate.join(
        room,
        async () => {
          const role = await db('nivaro_roles').where({ id: user.role }).first()
          return !!role?.admin_access
        },
        () => {
          // Post-mortem 3.1: a Traffic Map page that reads `traffic-map:batch` says so on join
          // (traffic-map-batch.ts); one without the flag keeps per-frame events.
          if (room === 'traffic-map') socket.data.trafficMapBatch = payload?.frames === 'batch'
          socket.join(name)
        }
      )
    }
    socket.on('admin:join', inSocketTenant(socket, onAdminJoin))
    const onAdminLeave = (payload: { room?: string }) => {
      const room = payload?.room
      if (typeof room !== 'string' || !WATCH_ROOMS.has(room)) return
      if (!cloud) {
        watchGate.leave(room, () => socket.leave(`watch:${room}`))
        return
      }
      void watchRoomName(room).then((name) => {
        if (name) watchGate.leave(room, () => socket.leave(name))
      })
    }
    // In the socket's tenant: a tenant-prefixed watch room is named from the tenant context.
    socket.on('admin:leave', inSocketTenant(socket, onAdminLeave))

    // Set once `auth` succeeds below; gates authenticated-only handlers
    // (e.g. collection:join) for the lifetime of this socket connection.
    let authenticatedUser: User | null = null
    /** Cloud: an authenticated socket joins its tenant's `all` room, where
     *  tenant-wide notices (owners:changed, access:changed — record-events.ts)
     *  go instead of io.emit (TENANT_ALL_ROOM there). Self-hosted: nothing to join. */
    const joinTenantAllRoom = async () => {
      if (!process.env.CLOUD_META_DB_URL) return
      const t = await socketTenant(socket).catch(() => null)
      if (t) socket.join(tenantScopedRoom('all', t.tenantId || t.slug))
    }

    /** Sign the socket in as `user`, bound to what signed it in (#1719). */
    const signIn = (user: User, bind: SocketBind) => {
      authenticatedUser = user
      socket.data.nvrBind = bind
      const meta = socketMeta.get(socket.id)
      if (meta)
        meta.user = {
          id: user.id,
          name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email
        }
      publishClient()
      socket.join(`user:${user.id}`)
      // A revoke publishes to these rooms, which reach the socket on every replica.
      if (bind.kind === 'session') socket.join(sessionRoom(bind.sid))
      else if (bind.kind === 'masq') socket.join(masqRoom(bind.token))
      void joinTenantAllRoom()
      socket.emit('auth:ok', { userId: user.id })
      // #2450 — the journal position now, so the client's first reconnect can replay from it
      // even when no journaled event reached this socket (a quiet tab had no cursor and missed
      // the gap). The client adopts it only while it holds no cursor of its own.
      void import('../services/event-journal.js')
        .then(({ currentSeq }) => currentSeq())
        .then((seq) => {
          if (seq != null && seq > 0 && socket.connected) socket.emit('catchup:cursor', { seq })
        })
        .catch(() => {})
    }

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
     * closing must not report the person gone. The set is process-wide
     * (services/presence-sockets.ts); another replica's sockets are asked for on
     * the way out (userHasSocket).
     */

    /**
     * Presence writes must never take down a socket.
     *
     * `changedWhen` narrows the first update to rows whose visible state this write changes;
     * when it matches nothing the row already said so (a second tab, a reconnect inside the
     * online window) — the write still lands (last_seen) but nobody is told.
     */
    const writePresence = async (
      userId: string,
      patch: Record<string, unknown>,
      changedWhen?: (qb: Knex.QueryBuilder) => void
    ) => {
      try {
        let changed = true
        let updated = 0
        if (changedWhen) {
          updated = await db('user_presence')
            .where({ user_id: userId })
            .where((qb) => void changedWhen(qb))
            .update(patch)
          if (updated === 0) {
            changed = false
            updated = await db('user_presence').where({ user_id: userId }).update(patch)
          }
        } else {
          updated = await db('user_presence').where({ user_id: userId }).update(patch)
        }
        if (updated === 0) {
          changed = true
          await db('user_presence')
            .insert({ user_id: userId, ...patch })
            .catch(() => {
              // UNIQUE(user_id): another tab won the insert, so update instead.
              return db('user_presence').where({ user_id: userId }).update(patch)
            })
        }
        if (!changed) return
        // Tell every viewer rather than making them poll. This is the whole
        // reason the list can feel instant instead of up to a minute stale.
        // Cloud: the socket's own tenant only (its `all` room); self-hosted: everyone.
        // Coalesced per tenant: a burst of connects is one event with every id.
        const tenant = tenantNow()
        if (tenant != null) presenceChanged.note(tenant, userId)
      } catch (err) {
        app.log.debug({ err, userId }, 'presence write failed')
      }
    }

    const markOnline = async (userId: string, socketId: string) => {
      addPresenceSocket(userId, socketId)
      const now = new Date()
      // A connection asserts ONLINE-ness only. It must not stamp activity: the
      // socket reconnects on its own (network blips, laptop wake), and treating
      // each reconnect as input reset the idle clock — people flipped from
      // "Idle · 12m" back to bare "Idle" every reconnect. The client's own
      // beats carry is_idle/last_active, the actual input claims.
      // Announced only when the row did not already read as online (offline, or outside the
      // window /presence/online uses) — a reconnect blip inside it tells nobody.
      const onlineSince = new Date(now.getTime() - PRESENCE_ONLINE_WINDOW_MS)
      await writePresence(
        userId,
        {
          is_online: true,
          last_seen: now
        },
        (qb) =>
          void qb
            .where('is_online', false)
            .orWhereNull('last_seen')
            .orWhere('last_seen', '<', onlineSince)
      )
    }

    const markOffline = async (userId: string, socketId: string) => {
      if (!removePresenceSocket(userId, socketId)) return // other tabs still open here
      // A reconnect (network blip, laptop wake, deploy) usually lands within a few seconds:
      // wait that long before saying they left, so a blip writes nothing and tells nobody —
      // otherwise every reconnect cost an offline AND an online presence:changed.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, PRESENCE_OFFLINE_GRACE_MS)
        ;(t as { unref?: () => void }).unref?.()
      })
      if (hasPresenceSocket(userId)) return // back on this process
      // A tab on another replica still counts (this socket already left its rooms).
      if (await userHasSocket(io, userId)) return
      await writePresence(userId, { is_online: false, last_seen: new Date() })
    }

    // A live socket keeps last_seen fresh itself. The tab's own beat runs on a
    // page timer, and a hidden idle tab's timers are throttled to about one wake a
    // minute — staging logged 72-73 s gaps against the 70 s online window, so idle
    // people dropped off and came back every minute or two. Server timers are not
    // throttled, and a frozen or closed tab loses its socket (ping timeout), which
    // stops this. Quiet on purpose: last_seen moving changes nobody's list, so no
    // presence:changed broadcast; is_idle/last_active stay the tab's own claims.
    const presenceRefreshTimer = setInterval(
      inSocketTenant(socket, async () => {
        const user = authenticatedUser
        if (!user || !socket.connected || !isPresenceRefreshOwner(user.id, socket.id)) return
        try {
          await db('user_presence')
            .where({ user_id: user.id })
            .update({ is_online: true, last_seen: new Date() })
        } catch (err) {
          app.log.debug({ err, userId: user.id }, 'presence refresh failed')
        }
      }),
      PRESENCE_REFRESH_MS
    )
    presenceRefreshTimer.unref?.()

    const onAuth = async (payload: { token?: string }) => {
      const token = payload?.token?.trim()
      if (!token) return
      try {
        const wsValue = await app.redis.get(`ws:token:${token}`)
        if (wsValue) {
          await app.redis.del(`ws:token:${token}`) // one-time use
          // Bound to what signed in the request that minted it: the session, the View-as, the
          // static token or the named API key. A token with no bind (an older API's bare user
          // id) signs nothing in — the client asks for a new one on its next connect.
          const minted = parseWsTokenValue(wsValue)
          if (!minted.userId || !minted.bind) return
          const bind = minted.bind
          let user = (await db<User>('nivaro_users')
            .where({ id: minted.userId, status: 'active' })
            .first()) as User | undefined
          // An API-key socket carries the key's scopes and row restrictions, like its requests.
          if (user && bind.kind === 'apikey')
            user = (await userWithApiKey(user, bind.id)) ?? undefined
          if (user) {
            signIn(user, bind)
            void markOnline(user.id, socket.id)
          }
          return
        }

        // Masquerade token (nvm_) — resolves to the target user; NOT one-time,
        // lives as long as the Redis masq:<token> entry the auth route minted.
        if (token.startsWith('nvm_')) {
          const raw = await app.redis.get(`masq:${token}`)
          if (!raw) return
          const payloadIds = JSON.parse(raw) as { user_id?: string; admin_id?: string }
          const user = await db<User>('nivaro_users')
            .where({ id: payloadIds.user_id, status: 'active' })
            .first()
          if (user) {
            touchMasqueradeMarker(app.redis, String(user.id), payloadIds.admin_id)
            signIn(user, { kind: 'masq', token })
            void markOnline(user.id, socket.id)
          }
          return
        }

        const user = await db<User>('nivaro_users')
          .where({ static_token: token, status: 'active' })
          .first()
        if (user) signIn(user, { kind: 'token', tokenHash: sha(token) })
      } catch (err) {
        app.log.warn({ err }, 'Socket auth failed')
      }
    }
    // Cloud: auth runs in the socket's tenant context (#1132); self-hosted: unchanged.
    socket.on('auth', inSocketTenant(socket, onAuth))

    // Cloud: only the tenant this socket's host resolved to (any other tenant's room would
    // hand this socket that tenant's broadcasts); self-hosted there are no tenants to cross.
    socket.on('tenant:join', async (tenantId: string) => {
      if (typeof tenantId !== 'string' || tenantId.length === 0) return
      if (process.env.CLOUD_META_DB_URL) {
        const t = await socketTenant(socket)
        if (!t || ![t.tenantId, t.slug].map(String).includes(tenantId)) return
      }
      socket.join(`tenant:${tenantId}`)
      socket.emit('tenant:joined', { tenantId })
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

    // Signed-in sockets only: an anonymous connection must not sit in any room.
    // `presence:admin` carries every session row (IP, device) — administrators only.
    socket.on(
      'presence:join',
      inSocketTenant(socket, async (roomId: string) => {
        const user = authenticatedUser
        if (!user || typeof roomId !== 'string' || !roomId) return
        if (roomId === 'admin') {
          const role = user.role
            ? await db('nivaro_roles')
                .where({ id: user.role })
                .first('admin_access')
                .catch(() => null)
            : null
          if (!role?.admin_access || authenticatedUser !== user) return
        }
        const name = await scopedRoom(`presence:${roomId.slice(0, 200)}`)
        if (name) socket.join(name)
      })
    )
    socket.on('presence:leave', (roomId: string) => {
      if (typeof roomId === 'string') leaveScoped(`presence:${roomId}`)
    })
    // Requires an authenticated socket (via `auth` above) AND read access to
    // the specific collection — mirrors the `can(user, 'read', collection)`
    // check every REST/GraphQL/items read path already enforces. Rejects
    // silently (no error emit) to match this handler's existing minimal-
    // feedback style; the client just never receives collection:update events.
    // Chat rooms are joined individually and gated by the SAME canSeeRoom the
    // REST routes use — a socket must not become a way to observe a room you
    // cannot read. Rejects silently, matching collection:join's posture.
    // Cloud: in the socket's tenant (its chat tables), into the tenant's room name.
    socket.on(
      'chat:join',
      inSocketTenant(socket, async (payload: { room?: string }) => {
        const room = payload?.room
        if (typeof room !== 'string' || room.length === 0) return
        const user = authenticatedUser
        if (!user) return
        try {
          if (!(await canSeeRoom(user, room))) return
          const name = await scopedRoom(`chat:${room}`)
          if (name) socket.join(name)
        } catch (err) {
          app.log.warn({ err, room }, 'chat:join visibility check failed')
        }
      })
    )

    socket.on('chat:leave', (payload: { room?: string }) => {
      const room = payload?.room
      if (typeof room === 'string' && room) leaveScoped(`chat:${room}`)
    })

    // #2457 — huddles: WebRTC signalling in a chat room, gated by canSeeRoom on every signal.
    registerHuddle(
      io,
      socket,
      () => authenticatedUser,
      { scopedRoom, scopedRoomNow, tenantNow },
      fullHuddleDeps(app)
    )
    // #2854 #2855 — huddle notes and Follow me, beside the signalling.
    registerHuddleCollab(
      io,
      socket,
      () => authenticatedUser,
      { scopedRoom, scopedRoomNow, tenantNow },
      defaultHuddleCollabDeps(app)
    )
    // #1399 — watch a session replay together (admin-only replay:<key> rooms).
    registerReplayWatch(io, socket, () => authenticatedUser)
    // #1675 — pushed dashboard/report widgets, computed as this socket's sign-in, sent to it alone.
    registerWidgetLive(socket, () => authenticatedUser)

    /** Cloud: collection rooms are per tenant (tenant-rooms.ts) — journaled
     *  events from a tenant's context go to `t:<tenant>:collection:<c>`. A cloud
     *  socket with no resolvable tenant joins nothing. Self-hosted: unchanged. */
    const collectionRoom = async (collection: string): Promise<string | null> => {
      if (!process.env.CLOUD_META_DB_URL) return `collection:${collection}`
      const t = await socketTenant(socket)
      return t ? tenantScopedRoom(`collection:${collection}`, t.tenantId || t.slug) : null
    }
    socket.on(
      'collection:join',
      inSocketTenant(socket, async (payload: { collection?: string }) => {
        const collection = payload?.collection
        if (typeof collection !== 'string' || collection.length === 0) return
        const user = authenticatedUser
        if (!user) return
        // A real collection name only: `orders:5` would name another room kind.
        if (!(await isKnownCollection(collection))) return
        try {
          const allowed = await can(user, 'read', collection)
          const room = allowed ? await collectionRoom(collection) : null
          if (room) socket.join(room)
        } catch (err) {
          app.log.warn({ err, collection }, 'collection:join permission check failed')
        }
      })
    )
    socket.on('collection:leave', async (payload: { collection?: string }) => {
      const collection = payload?.collection
      if (typeof collection !== 'string' || collection.length === 0) return
      // Self-hosted: leave at once (no await), as before.
      if (!process.env.CLOUD_META_DB_URL) socket.leave(`collection:${collection}`)
      else {
        const room = await collectionRoom(collection)
        if (room) socket.leave(room)
      }
    })
    // ── Live operations pages (services/ops-live.ts) ────────────────────────
    // `ops:join {topic}` — an allowlisted topic, gated like the route that serves the
    // same page (admin topics check the role at join, through the same ordered gate the
    // watch rooms use so a quick join + leave cannot leave a socket behind).
    const opsRoomOf = async (topic: string): Promise<string | null> => {
      if (!process.env.CLOUD_META_DB_URL) return opsRoom(topic, '')
      const t = await socketTenant(socket)
      return t ? opsRoom(topic, t.tenantId || t.slug) : null
    }
    const displayName = (u: User) =>
      [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
    const broadcastTopicViewers = (topic: string, room: string) => {
      io.to(room).emit('ops:changed', { topic, viewers: topicViewers(room), at: Date.now() })
    }
    socket.on(
      'ops:join',
      inSocketTenant(socket, async (payload: { topic?: string }) => {
        const spec = opsTopicGate(payload?.topic)
        const user = authenticatedUser
        if (!spec || !user) return
        try {
          const room = await opsRoomOf(spec.topic)
          if (!room) return
          await watchGate.join(
            `ops:${spec.topic}`,
            async () => {
              if (spec.gate === 'auth') return true
              if (!user.role) return false
              const role = await db('nivaro_roles').where({ id: user.role }).first()
              const isAdmin = !!role?.admin_access
              if (spec.gate === 'ticket')
                return await canJoinTicketTopic(user, Number(spec.topic.split(':')[1]), isAdmin)
              return isAdmin
            },
            () => {
              socket.join(room)
              if (isPresenceTopic(spec.topic)) {
                addTopicViewer(room, socket.id, { id: user.id, name: displayName(user) })
                broadcastTopicViewers(spec.topic, room)
              }
            }
          )
        } catch (err) {
          app.log.warn({ err, topic: spec.topic }, 'ops:join check failed')
        }
      })
    )
    socket.on('ops:leave', (payload: { topic?: string }) => {
      const spec = opsTopicGate(payload?.topic)
      if (!spec) return
      const leaveTopic = (room: string) => {
        socket.leave(room)
        if (removeTopicViewer(room, socket.id)) broadcastTopicViewers(spec.topic, room)
      }
      if (!process.env.CLOUD_META_DB_URL) {
        // Self-hosted: no await, so a quick join + leave keeps its order.
        watchGate.leave(`ops:${spec.topic}`, () => leaveTopic(opsRoom(spec.topic, '')))
        return
      }
      void opsRoomOf(spec.topic).then((room) => {
        if (room) watchGate.leave(`ops:${spec.topic}`, () => leaveTopic(room))
      })
    })
    // Who is on a ticket or issue page (names only), and who is replying. The sender must
    // already sit in the topic's room, so a signal reaches only people who passed its gate.
    type OpsSignalPayload = { topic?: string; kind?: string; state?: string; target?: unknown }
    socket.on(
      'ops:signal',
      inSocketTenant(socket, async (payload: OpsSignalPayload) => {
        const spec = opsTopicGate(payload?.topic)
        const user = authenticatedUser
        const state = cleanSignalState(payload?.state)
        if (!spec || !user || !state || !isPresenceTopic(spec.topic)) return
        // Layout editor (#2651): what this person has selected rides their viewer entry,
        // so a late joiner gets everyone's selection with the viewer list.
        if (payload?.kind === 'select' && isSelectionTopic(spec.topic)) {
          const room = await opsRoomOf(spec.topic)
          if (!room || !socket.rooms.has(room)) return
          const target = state === 'start' ? cleanSelectionKey(payload.target) : null
          if (setTopicViewerSelection(room, socket.id, target))
            broadcastTopicViewers(spec.topic, room)
          return
        }
        if (!TOPIC_SIGNAL_KINDS.has(String(payload?.kind))) return
        const room = await opsRoomOf(spec.topic)
        if (!room || !socket.rooms.has(room)) return
        socket.to(room).emit('ops:changed', {
          topic: spec.topic,
          signal: { kind: payload.kind, state, user: { id: user.id, name: displayName(user) } },
          at: Date.now()
        })
      })
    )
    // ── Record presence v2 — viewer avatars + field editing indicators ──────
    // Room per record; viewer lists live in a module-level map (single-node
    // fidelity — with the Redis adapter, cross-node lists degrade gracefully
    // to per-node views, same accepted limitation as presence:join rooms).
    // A socket may sit in SEVERAL record rooms at once (a frontend with a
    // record tab strip keeps every open record mounted). `joinedRecordRoom`
    // is the most recent join — the fallback target for clients that don't
    // say which record an event belongs to; `joinedRecordRooms` is the full
    // set, and events that name their record route to that room.
    let joinedRecordRoom: string | null = null
    const joinedRecordRooms = new Set<string>()
    // Cloud: record rooms are `t:<tenant>:record:<c>:<id>` (tenant-rooms.ts) — record ids
    // repeat across tenants' databases. Set by the first record:join (its tenant resolved);
    // '' self-hosted, where room names are unchanged.
    let recordTenant = ''
    const recordRoom = (collection: string, item: unknown) =>
      tenantScopedRoom(`record:${collection}:${String(item)}`, recordTenant)
    /** The room an event targets: the named record when the socket is in it,
     *  else the last joined room. Null = not in any record room. */
    const roomFor = (payload?: { collection?: string; item?: unknown }): string | null => {
      if (payload && typeof payload.collection === 'string' && payload.item != null) {
        const named = recordRoom(payload.collection, payload.item)
        if (joinedRecordRooms.has(named)) return named
      }
      return joinedRecordRoom
    }

    // The payload names its record: a client with several record tabs mounted
    // (a host that keeps every open tab alive) sits in several rooms at once,
    // and a bare `{viewers}` was applied by EVERY tab's hook — two people
    // sharing one background tab each saw the other "also viewing" the record
    // they actually had open (2026-09-14).
    const broadcastViewers = (room: string) => {
      const viewers = [...(recordViewers.get(room)?.values() ?? [])]
      const m = /^record:(.+):([^:]+)$/.exec(splitTenantRoom(room).room)
      io.to(room).emit('record:viewers', {
        collection: m?.[1] ?? null,
        item: m?.[2] ?? null,
        viewers
      })
      // #2486 — lists watching this row (ids only; names come from /presence/people).
      if (m)
        io.to(rowsRoomName(room)).emit('presence:rows', {
          collection: m[1],
          item: m[2],
          user_ids: distinctViewerIds(viewers)
        })
    }
    /** `{collection, item}` of a record room, so a record-room event names its record and a
     *  client holding several records on one socket (#2475) can route it. */
    const recordOf = (room: string | null): { collection: string | null; item: string | null } => {
      const m = room ? /^record:(.+):([^:]+)$/.exec(splitTenantRoom(room).room) : null
      return { collection: m?.[1] ?? null, item: m?.[2] ?? null }
    }
    const leaveOneRoom = (room: string) => {
      joinedRecordRooms.delete(room)
      if (joinedRecordRoom === room) joinedRecordRoom = [...joinedRecordRooms].pop() ?? null
      socket.leave(room)
      const map = recordViewers.get(room)
      if (map) {
        map.delete(socket.id)
        if (map.size === 0) recordViewers.delete(room)
      }
      broadcastViewers(room)
    }
    /** No payload (legacy clients, disconnect) = leave every record room. A
     *  named record leaves only that one, so a closed tab doesn't drop the
     *  tabs still open. */
    const leaveRecordRoom = (payload?: { collection?: string; item?: unknown }) => {
      if (payload && typeof payload.collection === 'string' && payload.item != null) {
        const named = recordRoom(payload.collection, payload.item)
        if (joinedRecordRooms.has(named)) leaveOneRoom(named)
        return
      }
      for (const room of [...joinedRecordRooms]) leaveOneRoom(room)
    }

    // Comment typing (#263): "X is writing a note…" relayed to co-viewers of
    // the same record. Ephemeral — no persistence, room members only. The name is the
    // signed-in person's own, never the client's claim. Older clients send this; newer ones
    // send `record:signal` kind 'note', which the same relay serves.
    socket.on('comment:typing', (payload: { collection?: string; item?: string }) => {
      const { collection, item } = payload ?? {}
      if (!collection || !item || !authenticatedUser) return
      // Only a co-viewer may say they are typing: the sender must sit in the record's room.
      const room = recordRoom(collection, item)
      if (!joinedRecordRooms.has(room)) return
      const name = displayName(authenticatedUser).slice(0, 80)
      socket.to(room).emit('record:comment-typing', { collection, item, user_name: name })
      socket.to(room).emit('record:signal', {
        collection,
        item: String(item),
        kind: 'note',
        state: 'start',
        user: { id: authenticatedUser.id, name }
      })
    })
    // Signals on a record (a note being written #1721, a transition dialog open #1722):
    // names only, to sockets already admitted to the record's room by the read gate.
    socket.on(
      'record:signal',
      (payload: { collection?: string; item?: unknown; kind?: string; state?: string }) => {
        const { collection, item } = payload ?? {}
        const state = cleanSignalState(payload?.state)
        if (!collection || item == null || !authenticatedUser || !state) return
        if (!RECORD_SIGNAL_KINDS.has(String(payload?.kind))) return
        const room = recordRoom(collection, item)
        if (!joinedRecordRooms.has(room)) return
        socket.to(room).emit('record:signal', {
          collection,
          item: String(item),
          kind: payload.kind,
          state,
          user: { id: authenticatedUser.id, name: displayName(authenticatedUser).slice(0, 80) }
        })
      }
    )
    const onRecordJoin = async (payload: { collection?: string; item?: string }) => {
      const { collection, item } = payload ?? {}
      const user = authenticatedUser
      if (!user || typeof collection !== 'string' || !collection || item == null) return
      // The record read gate (role, row filter, user scopes) — the same answer GET /items gives:
      // a record the person cannot open is not a room they may sit in (#1720).
      if (!(await canSeeRecordRoom(user, collection, String(item)))) return
      if (process.env.CLOUD_META_DB_URL) {
        const t = await socketTenant(socket)
        if (!t) return
        recordTenant = t.tenantId || t.slug
      }
      const room = recordRoom(collection, item)
      joinedRecordRoom = room
      joinedRecordRooms.add(room)
      socket.join(room)
      let map = recordViewers.get(room)
      if (!map) {
        map = new Map()
        recordViewers.set(room, map)
      }
      map.set(socket.id, { id: user.id, name: displayName(user) })
      broadcastViewers(room)
    }
    // Cloud: in the socket's tenant, so the gate reads that tenant's database.
    socket.on('record:join', inSocketTenant(socket, onRecordJoin))
    socket.on('record:leave', (payload?: { collection?: string; item?: unknown }) =>
      leaveRecordRoom(payload)
    )

    // ── Presence on list rows (#2486) ───────────────────────────────────────
    // A list watches the rows on its page; viewer changes arrive as `presence:rows` instead
    // of a 30 s count poll. Gated per RECORD by the record read gate (role, row filter, user
    // scopes — the record:join answer, one batched read per message), so guessed ids of rows
    // the person cannot open are never watched; capped per socket; ids only.
    const watchedRows = new Set<string>()
    let watcherIsAdmin: Promise<boolean> | null = null
    const onPresenceWatch = async (payload: { collection?: string; items?: unknown }) => {
      const user = authenticatedUser
      const collection = payload?.collection
      if (!user || typeof collection !== 'string' || !collection) return
      const asked = parseWatchItems(payload?.items)
      if (asked.length === 0 || watchedRows.size + asked.length > PRESENCE_WATCH_MAX) return
      watcherIsAdmin ??= db('nivaro_roles')
        .where({ id: user.role })
        .first('admin_access')
        .then((role) => !!role?.admin_access)
        .catch(() => false)
      const items = await visibleRecordIds(user, collection, asked, await watcherIsAdmin)
      if (items.length === 0) return
      if (process.env.CLOUD_META_DB_URL && !recordTenant) {
        const t = await socketTenant(socket)
        if (!t) return
        recordTenant = t.tenantId || t.slug
      }
      for (const item of items) {
        const room = recordRoom(collection, item)
        const watch = rowsRoomName(room)
        if (!watchedRows.has(watch)) {
          watchedRows.add(watch)
          socket.join(watch)
        }
        // The current state, so a page shows who is there without waiting for a change.
        const ids = distinctViewerIds(recordViewers.get(room)?.values())
        if (ids.length > 0) socket.emit('presence:rows', { collection, item, user_ids: ids })
      }
    }
    socket.on('presence:watch', inSocketTenant(socket, onPresenceWatch))
    socket.on('presence:unwatch', (payload?: { collection?: string; items?: unknown }) => {
      const collection = payload?.collection
      if (typeof collection !== 'string' || !collection) {
        for (const watch of watchedRows) socket.leave(watch)
        watchedRows.clear()
        return
      }
      const items = parseWatchItems(payload?.items)
      for (const item of items) {
        const watch = rowsRoomName(recordRoom(collection, item))
        if (watchedRows.delete(watch)) socket.leave(watch)
      }
    })

    // Mission-control pulse — admin-only live activity stream
    socket.on(
      'pulse:join',
      inSocketTenant(socket, async () => {
        const user = authenticatedUser
        if (!user?.role) return
        try {
          const role = await db('nivaro_roles').where({ id: user.role }).first()
          if (!role?.admin_access) return
          const name = await scopedRoom('pulse')
          if (name) socket.join(name)
        } catch {
          /* silent, same style as other joins */
        }
      })
    )
    socket.on('pulse:leave', () => leaveScoped('pulse'))

    // ── Presence map — who's on which admin page right now ──────────────────
    // #1391 — the portal (@nivaro/react usePageAt) pings too, labelled with its app.
    // Cloud: in the socket's tenant (journey rows are its tables); a ping before the tenant
    // resolves is ignored — the client pings again on its next page.
    const onPageAt = (payload: { path?: string; app?: string }) => {
      const user = authenticatedUser
      const tenant = tenantNow()
      if (!user || tenant == null) return
      const ping = parsePageAt(payload, socketMeta.get(socket.id)?.app)
      if (!ping) return
      const { path, app: pageApp } = ping
      const existing = pagePresence.get(socket.id)
      const changed = existing?.path !== path
      pagePresence.set(socket.id, {
        user: { id: user.id, name: displayName(user) },
        path,
        since: changed ? Date.now() : existing.since,
        app: pageApp,
        tenant
      })
      if (changed) {
        void closeJourneyRow(socket.id).then(() =>
          openJourneyRow(socket.id, user.id, path, pageApp)
        )
      }
      broadcastPresenceMap(tenant)
    }
    socket.on('page:at', inSocketTenant(socket, onPageAt))
    socket.on(
      'presence-map:join',
      inSocketTenant(socket, async () => {
        const user = authenticatedUser
        if (!user?.role) return
        try {
          const role = await db('nivaro_roles').where({ id: user.role }).first()
          if (!role?.admin_access) return
          const name = await scopedRoom('presence-map')
          if (!name) return
          socket.join(name)
          socket.emit('presence-map:update', presenceSnapshot(tenantNow() ?? ''))
        } catch {
          /* silent */
        }
      })
    )
    socket.on('presence-map:leave', () => leaveScoped('presence-map'))

    // Field editing indicator — fan out inside the record room only.
    socket.on('field:focus', (payload: { field?: string; collection?: string; item?: unknown }) => {
      const user = authenticatedUser
      const room = roomFor(payload)
      if (!user || !room || typeof payload?.field !== 'string') return
      socket.to(room).emit('field:editing', {
        ...recordOf(room),
        field: payload.field,
        user: { id: user.id, name: displayName(user) }
      })
    })
    // Live co-editing v3 — relay value keystrokes inside the record room.
    // Preview-only on the receiving side; persistence still goes through the
    // normal save path with all its validation.
    socket.on(
      'field:change',
      (payload: { field?: string; value?: unknown; collection?: string; item?: unknown }) => {
        const user = authenticatedUser
        const room = roomFor(payload)
        if (!user || !room || typeof payload?.field !== 'string') return
        const value =
          typeof payload.value === 'string' ? payload.value.slice(0, 300) : payload.value
        socket.to(room).emit('field:changed', {
          ...recordOf(room),
          field: payload.field,
          value,
          user: { id: user.id, name: displayName(user) }
        })
      }
    )

    socket.on('field:blur', (payload: { field?: string; collection?: string; item?: unknown }) => {
      const user = authenticatedUser
      const room = roomFor(payload)
      if (!user || !room || typeof payload?.field !== 'string') return
      socket.to(room).emit('field:editing', { ...recordOf(room), field: payload.field, user: null })
    })

    // Upload presence (#282): "Beth is uploading quote.pdf" chips for
    // co-viewers. Start/done only — fetch-based uploads have no progress.
    socket.on('record:uploading', (payload: { name?: string; state?: string }) => {
      const user = authenticatedUser
      if (!user || !joinedRecordRoom) return
      const state = payload?.state === 'done' ? 'done' : 'start'
      const [, roomCollection, ...roomItem] = splitTenantRoom(joinedRecordRoom).room.split(':')
      socket.to(joinedRecordRoom).emit('record:uploading', {
        collection: roomCollection,
        item: roomItem.join(':'),
        user: user.id,
        user_name: displayName(user),
        name: String(payload?.name ?? 'a file').slice(0, 200),
        state
      })
    })

    // #1720 — what socket-access needs from this closure: the signed-in user, a way to swap
    // in a fresh row (role changed), and a room leave that keeps the record viewer list right.
    const accessHooks: SocketAccessHooks = {
      user: () => authenticatedUser,
      applyUser: (u) => {
        authenticatedUser = u
      },
      leaveRoom: (room) => {
        if (joinedRecordRooms.has(room)) leaveOneRoom(room)
        else {
          socket.leave(room)
          if (removeTopicViewer(room, socket.id))
            io.to(room).emit('ops:changed', {
              topic: splitTenantRoom(room).room.slice(4),
              viewers: topicViewers(room),
              at: Date.now()
            })
        }
      }
    }
    socket.data.nvrAccess = accessHooks

    socket.on('disconnect', () => {
      noteSocket('disconnect')
      coalescer?.dispose()
      buffer.dispose()
      if (tenantKey) noteTenantSocket(tenantKey, -1)
      clearInterval(rttTimer)
      clearInterval(presenceRefreshTimer)
      socketMeta.delete(socket.id)
      if (authenticatedUser) void markOffline(authenticatedUser.id, socket.id)
      leaveRecordRoom()
      for (const room of removeSocketFromTopics(socket.id)) {
        const topic = splitTenantRoom(room).room.slice(4)
        io.to(room).emit('ops:changed', { topic, viewers: topicViewers(room), at: Date.now() })
      }
      void closeJourneyRow(socket.id)
      const gone = pagePresence.get(socket.id)
      if (gone && pagePresence.delete(socket.id)) broadcastPresenceMap(gone.tenant)
      app.log.debug({ socketId: socket.id }, 'Socket disconnected')
    })
  })

  // #1720 — another replica asked for a room re-check; run this node's share.
  io.on(RECHECK_EVENT, (target: RecheckTarget) => {
    void runLocalRecheck(io, target ?? { all: true })
  })

  // #1719 — sweep this node's signed-in sockets: an ended session, masquerade or token, or an
  // account no longer active, closes the socket even when nothing announced it.
  const sweepMs = Math.max(5_000, Number(process.env.SOCKET_SWEEP_MS) || 30_000)
  const sweepTimer = setInterval(() => {
    void sweepSockets(io, {
      redis: app.redis,
      judge: async (role, stamps) => {
        const { getSessionPolicy, limitsFor, judgeSession } = await import(
          '../services/session-policy.js'
        )
        const policy = await getSessionPolicy()
        if (!policy) return 'ok'
        return judgeSession(limitsFor(policy, role), stamps, Date.now()).ok ? 'ok' : 'expired'
      }
    }).catch((err) => app.log.debug({ err }, 'socket sweep failed'))
  }, sweepMs)
  sweepTimer.unref?.()

  app.decorate('io', io)
  // Fastify closes the HTTP server BEFORE it runs onClose hooks, and the
  // server closes only once every connection has ended. An open websocket
  // never ends on its own, so io.close() below waited on the very close that
  // was waiting on it: every deploy sat out the shutdown deadline, then
  // Docker's SIGKILL (10 s). End the clients first.
  //
  // Close the TRANSPORTS only — never io.disconnectSockets(): that sends each
  // client socket.io's disconnect packet ("41"), which clients treat as "the
  // server kicked you" and never reconnect from. With the graceful drain
  // (SHUTDOWN_DRAIN_DELAY_MS) the packet always arrived, and every open tab sat
  // on "Live updates paused" after a rolling deploy. A transport close is an
  // ordinary drop: clients reconnect straight away, to a task that is serving.
  app.addHook('preClose', async () => {
    io.engine.close()
  })
  app.addHook('onClose', async () => {
    clearInterval(sweepTimer)
    io.close()
  })
})
