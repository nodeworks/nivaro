// api/src/routes/traffic-map-extras/snapshots.ts
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { getRealtimeStats } from '../../plugins/socketio.js'
import { logActivity } from '../../services/activity.js'
import { INSTANCE_ID } from '../../services/instance-roster.js'
import { trafficClusterRelay } from '../../services/traffic-cluster.js'
import { buildSnapshot, type TrafficSnapshot } from '../../services/traffic-map.js'
import { mergeSnapshots } from '../../services/traffic-merge.js'
import { currentStoreId } from '../../services/traffic-taps.js'

/**
 * #1097 — shareable incident snapshots. POST freezes the map (server-built snapshot of the
 * window — every node merged when asked — plus the page's labels, filters and selection) into
 * nivaro_traffic_snapshots; GET /snapshots/:id serves it to the read-only view
 * (/traffic-map?snapshot=<id>). A note also lands on the Ops Console incident timeline (an
 * activity row on nivaro_traffic_snapshots, which the timeline reads). Store-scoped (#1132).
 */
const TABLE = 'nivaro_traffic_snapshots'
const WINDOWS = new Set([60, 300, 900])
const NAME_MAX = 200
const NOTE_MAX = 2000
const JSON_MAX = 256 * 1024
const LIST_LIMIT = 30
const ID_RE = /^[0-9a-f-]{36}$/i

function socketCounts(): { sockets: number; users: number } {
  const stats = getRealtimeStats()
  const users = new Set<string>()
  for (const s of stats.sockets) {
    const u = s.user as { id?: string } | string | null
    const id = typeof u === 'string' ? u : u?.id
    if (id) users.add(id)
  }
  return { sockets: stats.sockets.length, users: users.size }
}

/** A small JSON value from the client (filters, selection, labels), or null when too big / bad. */
export function clientJson(v: unknown, max = JSON_MAX): string | null {
  if (v == null) return null
  try {
    const s = JSON.stringify(v)
    return s.length <= max ? s : null
  } catch {
    return null
  }
}
function parse<T>(s: unknown): T | null {
  if (typeof s !== 'string' || !s) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

export function defaultSnapshotName(at: Date): string {
  return `Traffic ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export async function snapshotRoutes(app: FastifyInstance): Promise<void> {
  const opts = { config: { trafficTenantAware: true } }

  app.post<{
    Body: {
      window?: number
      name?: string
      note?: string
      scope?: string
      node?: string
      filters?: unknown
      selection?: unknown
      catalog?: unknown
    }
  }>('/snapshots', opts, async (req, reply) => {
    const b = req.body ?? {}
    const window = Number(b.window ?? 60)
    if (!WINDOWS.has(window)) {
      return reply
        .code(400)
        .send({ error: 'window must be 60, 300 or 900', code: 'WINDOW_INVALID' })
    }
    const name =
      String(b.name ?? '')
        .trim()
        .slice(0, NAME_MAX) || defaultSnapshotName(new Date())
    const note =
      String(b.note ?? '')
        .trim()
        .slice(0, NOTE_MAX) || null
    const store = currentStoreId()
    const relay = trafficClusterRelay()
    const scope = b.scope === 'cluster' && relay ? 'cluster' : 'node'
    let snap: TrafficSnapshot
    let node: string | null = INSTANCE_ID
    if (scope === 'cluster' && relay) {
      const all = await relay.collect(store, window)
      if (b.node) {
        const one = all.get(String(b.node))
        if (!one) {
          return reply
            .code(404)
            .send({ error: 'That API process did not answer', code: 'NODE_NOT_FOUND' })
        }
        snap = one
        node = String(b.node)
      } else {
        snap = mergeSnapshots([...all.values()])
        node = null
      }
    } else {
      const { sockets, users } = socketCounts()
      snap = buildSnapshot(window as 60 | 300 | 900, { sockets, users, journalSeq: null })
    }
    const id = randomUUID()
    await db(TABLE).insert({
      id,
      store,
      name,
      note,
      window_s: window,
      scope,
      node,
      instance: snap.instance,
      filters: clientJson(b.filters, 8 * 1024),
      selection: clientJson(b.selection, 2 * 1024),
      snapshot: JSON.stringify(snap),
      catalog: clientJson(b.catalog),
      created_by: req.user?.id ?? null,
      created_at: new Date()
    })
    if (note) {
      await logActivity({
        action: 'traffic-snapshot',
        user: req.user?.id ?? null,
        collection: TABLE,
        item: id,
        comment: `Traffic snapshot "${name}": ${note}`.slice(0, 2000),
        req
      })
    }
    return reply.code(201).send({ data: { id, name, url: `/traffic-map?snapshot=${id}` } })
  })

  app.get('/snapshots', opts, async () => {
    const rows = (await db(`${TABLE} as s`)
      .leftJoin('nivaro_users as u', 'u.id', 's.created_by')
      .where('s.store', currentStoreId())
      .orderBy('s.created_at', 'desc')
      .limit(LIST_LIMIT)
      .select(
        's.id',
        's.name',
        's.note',
        's.window_s',
        's.scope',
        's.node',
        's.created_at',
        's.created_by',
        'u.first_name',
        'u.last_name',
        'u.email'
      )) as Array<Record<string, unknown>>
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        note: r.note ?? null,
        window_s: r.window_s,
        scope: r.scope,
        node: r.node ?? null,
        created_at: new Date(r.created_at as string).toISOString(),
        created_by: r.created_by ?? null,
        created_by_name:
          `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() ||
          (typeof r.email === 'string' ? r.email.split('@')[0] : null)
      }))
    }
  })

  app.get<{ Params: { id: string } }>('/snapshots/:id', opts, async (req, reply) => {
    if (!ID_RE.test(req.params.id))
      return reply.code(404).send({ error: 'Snapshot not found', code: 'SNAPSHOT_NOT_FOUND' })
    const r = (await db(`${TABLE} as s`)
      .leftJoin('nivaro_users as u', 'u.id', 's.created_by')
      .where('s.id', req.params.id)
      .where('s.store', currentStoreId())
      .first('s.*', 'u.first_name', 'u.last_name', 'u.email')) as
      | Record<string, unknown>
      | undefined
    if (!r) return reply.code(404).send({ error: 'Snapshot not found', code: 'SNAPSHOT_NOT_FOUND' })
    const snapshot = parse<TrafficSnapshot>(r.snapshot)
    if (!snapshot)
      return reply
        .code(422)
        .send({ error: 'This snapshot could not be read', code: 'SNAPSHOT_UNREADABLE' })
    return {
      data: {
        id: r.id,
        name: r.name,
        note: r.note ?? null,
        window_s: r.window_s,
        scope: r.scope,
        node: r.node ?? null,
        created_at: new Date(r.created_at as string).toISOString(),
        created_by_name:
          `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() ||
          (typeof r.email === 'string' ? r.email.split('@')[0] : null),
        filters: parse(r.filters),
        selection: parse(r.selection),
        catalog: parse(r.catalog),
        snapshot
      }
    }
  })

  app.delete<{ Params: { id: string } }>('/snapshots/:id', opts, async (req, reply) => {
    if (!ID_RE.test(req.params.id))
      return reply.code(404).send({ error: 'Snapshot not found', code: 'SNAPSHOT_NOT_FOUND' })
    const n = await db(TABLE).where({ id: req.params.id, store: currentStoreId() }).del()
    if (!n) return reply.code(404).send({ error: 'Snapshot not found', code: 'SNAPSHOT_NOT_FOUND' })
    await logActivity({
      action: 'traffic-snapshot-delete',
      user: req.user?.id ?? null,
      collection: TABLE,
      item: req.params.id,
      req
    })
    return reply.code(204).send()
  })
}
