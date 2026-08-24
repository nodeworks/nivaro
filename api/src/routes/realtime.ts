import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { getRealtimeStats, getRecordViewerSnapshot } from '../plugins/socketio.js'
import { logActivity } from '../services/activity.js'
import { currentSeq } from '../services/event-journal.js'

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
      for (const p of pairs) {
        if (!p?.collection || p.item_id == null) continue
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

  app.get('/stats', async () => {
    const stats = getRealtimeStats()
    return {
      data: {
        node_scope: 'this API process only (Redis adapter fans out across nodes)',
        journal_seq: await currentSeq(),
        socket_count: stats.sockets.length,
        sockets: stats.sockets.map((s) => ({
          id: s.id,
          user:
            s.user && typeof s.user === 'object'
              ? ((s.user as { name?: string; id?: string }).name ??
                (s.user as { id?: string }).id ??
                null)
              : ((s.user as string | null) ?? null),
          app: s.app,
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
  // then reloads. For the deploy that must land NOW.
  app.post<{ Body: { seconds?: number; message?: string } }>('/force-refresh', async (req) => {
    const seconds = Math.min(300, Math.max(5, Number(req.body?.seconds) || 30))
    const message = String(req.body?.message ?? '').slice(0, 300)
    app.io.emit('client:force-refresh', { seconds, message })
    await logActivity({
      action: 'client-force-refresh',
      user: req.user?.id,
      comment: `${seconds}s${message ? ` — ${message}` : ''}`,
      req
    })
    return { data: { sent: true, seconds } }
  })
}
