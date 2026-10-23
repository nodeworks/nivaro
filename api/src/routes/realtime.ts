import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { getTenantId, getTenantSlug } from '../db/tenant-context.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import {
  emitForceRefresh,
  getClusterClientVersionGroups,
  getRealtimeStats,
  getRecordViewerSnapshot,
  socketCompressionOn,
  socketPollingAllowed
} from '../plugins/socketio.js'
import { logActivity } from '../services/activity.js'
import { currentSeq } from '../services/event-journal.js'
import { boardReaderOn } from '../services/realtime-board.js'
import { visibleRecordIds } from '../services/socket-access.js'
import { readSocketHealth, socketBufferState } from '../services/socket-health.js'
import {
  INSPECT_RING,
  inspectedEvents,
  resetTransportStats,
  scopeRealtimeStats,
  startInspect,
  stopInspect,
  transportStats
} from '../services/socket-transport.js'
import { sseListenerCount } from '../services/sse-hub.js'
import type { User } from '../types.js'
import { NIVARO_VERSION } from '../version.js'

/**
 * Realtime observability + control (#270 diagnostics, #273 now-editing,
 * #275 concurrency history, #285 force refresh). Stats are per-node with the
 * Redis adapter — honest about it in the payload rather than pretending.
 */
/**
 * Record-viewer counts (#272): how many people have each record open RIGHT NOW
 * (this node's record rooms). Authenticated — viewer counts are presence-tier
 * data, not admin telemetry; names are deliberately NOT returned here.
 */
export async function recordViewersRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth)
  app.post<{ Body: { pairs?: Array<{ collection?: string; item_id?: string }> } }>(
    '/record-viewers',
    async (req) => {
      const pairs = (req.body?.pairs ?? []).slice(0, 200)
      const snapshot = getRecordViewerSnapshot()
      const out: Record<string, number> = {}
      // Only records the caller may read (the record-room gate, one batched read per
      // collection): a count for any other record would say it exists and is being worked on.
      const byCollection = new Map<string, Set<string>>()
      for (const p of pairs) {
        if (!p?.collection || p.item_id == null) continue
        const hit = snapshot.find(
          (v) => v.collection === p.collection && String(v.item) === String(p.item_id)
        )
        if (!hit?.viewers.length) continue
        let ids = byCollection.get(p.collection)
        if (!ids) {
          ids = new Set()
          byCollection.set(p.collection, ids)
        }
        ids.add(String(p.item_id))
      }
      const readable = new Set<string>()
      const user = req.user as User
      for (const [collection, ids] of byCollection)
        for (const id of await visibleRecordIds(user, collection, [...ids], req.isAdmin))
          readable.add(`${collection}:${id}`)
      for (const p of pairs) {
        if (!p?.collection || p.item_id == null) continue
        if (!readable.has(`${p.collection}:${p.item_id}`)) continue
        const hit = snapshot.find(
          (v) => v.collection === p.collection && String(v.item) === String(p.item_id)
        )
        if (hit && hit.viewers.length > 0) out[`${p.collection}:${p.item_id}`] = hit.viewers.length
      }
      return { data: out }
    }
  )
}

export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  // Cloud mode: the caller's tenant only (one process serves many); self-hosted: the one scope.
  const tenantScope = () =>
    process.env.CLOUD_META_DB_URL ? (getTenantId() ?? getTenantSlug() ?? '-') : null

  app.get('/stats', async () => {
    const stats = scopeRealtimeStats(getRealtimeStats(), tenantScope())
    const versions = await getClusterClientVersionGroups(tenantScope())
    // #1672 — which transport each client is on; the SSE fallback streams are counted apart.
    const transports: Record<string, number> = {}
    for (const s of stats.sockets) {
      const t = s.transport ?? 'unknown'
      transports[t] = (transports[t] ?? 0) + 1
    }
    return {
      data: {
        node_scope: 'this API process only (Redis adapter fans out across nodes)',
        journal_seq: await currentSeq(),
        socket_count: stats.sockets.length,
        // #2475 — how many connections are shared workers (one per browser and app), and how
        // many signed-in people the sockets on this node belong to (sockets ÷ people = tabs or
        // browsers per person).
        shared_worker_count: stats.sockets.filter((s) => s.shared_worker).length,
        people_count: new Set(
          stats.sockets
            .map((s) =>
              s.user && typeof s.user === 'object' ? (s.user as { id?: string }).id : s.user
            )
            .filter(Boolean)
            .map((u) => String(u).toUpperCase())
        ).size,
        transports,
        sse_streams: sseListenerCount(),
        polling_allowed: socketPollingAllowed(),
        compression: socketCompressionOn(),
        // #1730 — bytes per event type and per room kind; #1681 — bursts merged.
        traffic: transportStats(15, tenantScope()),
        // #1048 — open tabs by the build they run, on every replica; `older` groups are what
        // "Reload old tabs" reaches. `versions_scope` says whether every replica answered.
        api_version: NIVARO_VERSION,
        versions: versions.groups,
        versions_scope: {
          nodes: versions.nodes,
          partial: versions.partial,
          // API versions the replicas serve, and apps whose deploy is still rolling (not judged).
          roster: versions.roster,
          settling: versions.settling
        },
        sockets: stats.sockets.map((s) => ({
          id: s.id,
          user:
            s.user && typeof s.user === 'object'
              ? ((s.user as { name?: string; id?: string }).name ??
                (s.user as { id?: string }).id ??
                null)
              : ((s.user as string | null) ?? null),
          app: s.app,
          transport: s.transport,
          coalesce: s.coalesce,
          shared_worker: s.shared_worker,
          build: s.version?.build ?? null,
          api_version: s.version?.api ?? null,
          connected_seconds: Math.round((Date.now() - s.connectedAt) / 1000),
          rtt_ms: s.rtt,
          reconnects: s.reconnects,
          room_count: s.rooms.length,
          rooms: s.rooms.slice(0, 30)
        })),
        rooms: stats.rooms
      }
    }
  })

  /**
   * #1731 — Socket inspector. One connected client's rooms and the last 100 events sent to it
   * (names, sizes, times — never payloads). Recording is OFF until an admin starts it here and
   * switches itself off when nobody reads it for 10 minutes. This node's sockets, the caller's
   * tenant only; sign-in rooms are never listed.
   */
  /** SOCKETS=off: the socket is held by a realtime process, which keeps its inspector ring. */
  const heldElsewhere = (id: string): string | null => {
    if (!boardReaderOn()) return null
    const s = getRealtimeStats().sockets.find((x) => x.id === id) as { node?: unknown } | undefined
    return s ? String(s.node ?? 'unknown') : null
  }
  const inspectTarget = (id: string) => {
    const scope = tenantScope()
    const sock = scopeRealtimeStats(getRealtimeStats(), scope).sockets.find((s) => s.id === id)
    return sock ? { sock, scope } : null
  }
  const inspectView = (id: string) => {
    const hit = inspectTarget(id)
    if (!hit) return null
    const events = inspectedEvents(id, hit.scope)
    return {
      id,
      user:
        hit.sock.user && typeof hit.sock.user === 'object'
          ? ((hit.sock.user as { name?: string }).name ?? null)
          : null,
      app: hit.sock.app,
      transport: hit.sock.transport,
      rooms: hit.sock.rooms,
      recording: events !== null,
      ring: INSPECT_RING,
      events: events ?? [],
      // #2460 / #2488 — bytes waiting to be sent to this client and whether it is held back.
      buffer: socketBufferState(id, hit.scope)
    }
  }

  const refuseElsewhere = (id: string, reply: import('fastify').FastifyReply) => {
    const node = heldElsewhere(id)
    if (!node) return null
    return reply.code(409).send({
      error: `This client is connected to realtime process ${node}; the inspector records on the process that holds the socket.`,
      code: 'SOCKET_ON_REALTIME',
      node
    })
  }

  app.get<{ Params: { id: string } }>('/sockets/:id/inspect', async (req, reply) => {
    const elsewhere = refuseElsewhere(String(req.params.id), reply)
    if (elsewhere) return elsewhere
    const view = inspectView(String(req.params.id))
    if (!view) return reply.code(404).send({ error: 'Client not connected to this node' })
    return { data: view }
  })

  app.post<{ Params: { id: string } }>('/sockets/:id/inspect', async (req, reply) => {
    const id = String(req.params.id)
    const elsewhere = refuseElsewhere(id, reply)
    if (elsewhere) return elsewhere
    const hit = inspectTarget(id)
    if (!hit) return reply.code(404).send({ error: 'Client not connected to this node' })
    if (!startInspect(id, hit.scope))
      return reply.code(429).send({ error: 'Too many clients are being inspected; stop one first' })
    return { data: inspectView(id) }
  })

  app.delete<{ Params: { id: string } }>('/sockets/:id/inspect', async (req, reply) => {
    const id = String(req.params.id)
    const elsewhere = refuseElsewhere(id, reply)
    if (elsewhere) return elsewhere
    if (!inspectTarget(id))
      return reply.code(404).send({ error: 'Client not connected to this node' })
    stopInspect(id)
    return { data: { recording: false } }
  })

  /**
   * Socket health (#2460 slow consumers, #2488 write buffers, #2779 handler timings, #2462
   * room gaps): every replica's figures merged through Redis, the caller's tenant only.
   */
  app.get('/health', async () => {
    const { liveModeStats } = await import('../services/collection-live-mode.js')
    return { data: { ...(await readSocketHealth(tenantScope())), live_modes: liveModeStats() } }
  })

  // #1730 — start the byte counters over (after trimming a heavy broadcast, to see the effect).
  app.post('/traffic/reset', async () => {
    resetTransportStats(tenantScope())
    return { data: { reset: true } }
  })

  /**
   * Event pipeline health (#1673 durable journal, #1737 stream, #1875 raw
   * writes, #1682 delivery probe). Counters are this process's; probe results
   * are shared through Redis so every replica shows the same history.
   */
  app.get('/pipeline', async () => {
    const [{ eventStreamStats }, { durableJournalStats }, { rawWriteStats }, probe] =
      await Promise.all([
        import('../services/event-stream.js'),
        import('../services/event-journal-store.js'),
        import('../services/raw-write-announcer.js'),
        import('../services/realtime-probe.js')
      ])
    return {
      data: {
        journal_seq: await currentSeq(),
        stream: eventStreamStats(),
        durable: durableJournalStats(),
        raw_writes: rawWriteStats(),
        probes: await probe.recentProbeResults(app, 20)
      }
    }
  })

  /** Run the delivery probe now (#1682) — the same check the realtime monitor runs. */
  app.post<{ Body: { threshold_ms?: number } }>('/probe', async (req) => {
    const { runRealtimeProbe } = await import('../services/realtime-probe.js')
    const result = await runRealtimeProbe(app, { thresholdMs: Number(req.body?.threshold_ms) })
    return { data: result }
  })

  // Now-editing pulse (#273): active edit locks (cross-replica truth) + this
  // node's record-room viewers.
  app.get('/now-editing', async () => {
    const locks = (await db('nivaro_item_locks as l')
      .leftJoin('nivaro_users as u', 'u.id', 'l.user')
      .where('l.expires_at', '>', new Date())
      .orderBy('l.locked_at', 'desc')
      .limit(200)
      .select(
        'l.collection',
        'l.item',
        'l.locked_at',
        db.raw("CONCAT(u.first_name, ' ', u.last_name) as editor")
      )) as Array<{ collection: string; item: string; locked_at: Date; editor: string | null }>
    return {
      data: {
        editing: locks.map((l) => ({
          collection: l.collection,
          item: l.item,
          editor: l.editor?.trim() || 'unknown',
          since: l.locked_at
        })),
        viewing: getRecordViewerSnapshot().map((v) => ({
          collection: v.collection,
          item: v.item,
          viewers: v.viewers.map((u) => u.name || u.id)
        }))
      }
    }
  })

  app.get<{ Querystring: { days?: string } }>('/concurrency', async (req) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30))
    const rows = await db('nivaro_concurrency_samples')
      .where('sampled_at', '>=', new Date(Date.now() - days * 86_400_000))
      .orderBy('sampled_at')
      .select('sampled_at', 'instance', 'sockets', 'users')
    return { data: rows }
  })

  // Remote client refresh (#285): every connected client shows a countdown
  // then reloads. For the deploy that must land NOW. Targeted form
  // (2026-09-25): `user_ids` reaches only those people (every open tab, any
  // app), `app` reaches only one client app's sockets on this node —
  // e.g. everyone on the portal after a portal-only fix.
  app.post<{
    Body: {
      seconds?: number
      message?: string
      user_ids?: string[]
      app?: string
      /** #1048 — only tabs on an older build or loaded against an older API (every replica). */
      older?: boolean
    }
  }>('/force-refresh', async (req) => {
    const seconds = Math.min(300, Math.max(5, Number(req.body?.seconds) || 30))
    const message = String(req.body?.message ?? '').slice(0, 300)
    const userIds = Array.isArray(req.body?.user_ids)
      ? req.body.user_ids.map((u) => String(u)).filter((u) => /^[0-9a-f-]{36}$/i.test(u))
      : []
    if (Array.isArray(req.body?.user_ids) && userIds.length === 0)
      throw Object.assign(new Error('user_ids must name at least one user'), { statusCode: 400 })
    const appFilter = req.body?.app ? String(req.body.app).slice(0, 50) : null
    const older = req.body?.older === true
    const hit = await emitForceRefresh({ userIds, app: appFilter, older }, { seconds, message })
    const names = userIds.length
      ? await db('nivaro_users')
          .whereIn('id', userIds)
          .select('first_name', 'last_name', 'email')
          .then((rows) =>
            rows.map((r) => `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email)
          )
      : []
    const who = userIds.length
      ? `to ${names.join(', ')}`
      : appFilter
        ? `to everyone on ${appFilter}`
        : 'to everyone'
    const scope = older ? `${who} on an older version` : who
    await logActivity({
      action: 'client-force-refresh',
      user: req.user?.id,
      comment: `${scope} — ${seconds}s${message ? ` — ${message}` : ''} (${hit.sockets} tabs${hit.partial ? ' on this node only — another replica did not answer' : ''})`,
      req
    })
    return { data: { sent: true, seconds, targets: userIds.length, older, ...hit } }
  })
}
