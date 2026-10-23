// api/src/routes/traffic-map-extras/map-data.ts
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { logActivity } from '../../services/activity.js'
import { getIo } from '../../services/io-holder.js'
import { roomListeners } from '../../services/realtime-board.js'
import { mapEnvironment } from '../../services/traffic-environment.js'
import { estimateMapBytes, trafficRoomFor, trafficStoreIds } from '../../services/traffic-map.js'
import {
  bustMapSettings,
  loadMapSettings,
  MapSettingsError,
  onMapSettings,
  saveMapSettings
} from '../../services/traffic-map-settings.js'
import {
  describeNode,
  KINDS,
  type NodeInfoKind,
  overrideKey
} from '../../services/traffic-node-info.js'
import { overheadReport, setSampleThreshold } from '../../services/traffic-overhead.js'
import {
  diffSnapshots,
  mapDataUsage,
  nearestSnapshot,
  SNAPSHOT_TABLE,
  type StoredSnapshot,
  thumbOf
} from '../../services/traffic-snapshots.js'
import { currentStoreId, DEFAULT_STORE, withTrafficStore } from '../../services/traffic-taps.js'

/**
 * Snapshot comparison and thumbnails, map data settings and retention, environment banner, node
 * descriptions and the map's own overhead (#2174, #2181, #2177, #2242, #2245, #2178). Admin
 * only like every Traffic Map route; the snapshot reads are store-scoped and tenant-aware, the
 * rest answers 404 in cloud mode (settings are instance-wide).
 */
const ID_RE = /^[0-9a-f-]{36}$/i
const NEAR_MS = 60 * 60_000
const AT_MAX = 40
const THUMB_CACHE_MAX = 60

function parseSnap(text: unknown): StoredSnapshot | null {
  if (typeof text !== 'string' || !text) return null
  try {
    return JSON.parse(text) as StoredSnapshot
  } catch {
    return null
  }
}

/** Snapshots never change once stored, so a small cache of their thumbnails is always right. */
const thumbCache = new Map<string, ReturnType<typeof thumbOf>>()
function cacheThumb(id: string, t: ReturnType<typeof thumbOf>): void {
  if (thumbCache.size >= THUMB_CACHE_MAX)
    thumbCache.delete(thumbCache.keys().next().value as string)
  thumbCache.set(id, t)
}

export async function mapDataRoutes(app: FastifyInstance): Promise<void> {
  const tenantAware = { config: { trafficTenantAware: true } }

  // The sampling threshold lives in the settings but is read on the hot path: hold it in the
  // overhead module and refresh it every minute (and whenever the settings are read or saved).
  if (!process.env.CLOUD_META_DB_URL) {
    onMapSettings((s) => setSampleThreshold(s.overhead.sample_above_rps))
    void loadMapSettings()
    const timer = setInterval(() => {
      bustMapSettings()
      void loadMapSettings()
    }, 60_000)
    timer.unref?.()
    app.addHook('onClose', async () => clearInterval(timer))
  }

  // ── #2174 compare two snapshots ──
  app.get<{ Querystring: { a?: string; b?: string } }>(
    '/snapshots/compare',
    tenantAware,
    async (req, reply) => {
      const { a, b } = req.query
      if (!a || !b || !ID_RE.test(a) || !ID_RE.test(b)) {
        return reply
          .code(400)
          .send({ error: 'Pick two snapshots to compare', code: 'COMPARE_IDS_INVALID' })
      }
      const rows = (await db(SNAPSHOT_TABLE)
        .whereIn('id', [a, b])
        .where('store', currentStoreId())
        .select('id', 'name', 'created_at', 'snapshot')) as Array<Record<string, unknown>>
      const ra = rows.find((r) => r.id === a)
      const rb = rows.find((r) => r.id === b)
      const sa = parseSnap(ra?.snapshot)
      const sb = parseSnap(rb?.snapshot)
      if (!ra || !rb || !sa || !sb) {
        return reply.code(404).send({ error: 'Snapshot not found', code: 'SNAPSHOT_NOT_FOUND' })
      }
      const diff = diffSnapshots(sa, sb)
      return {
        data: {
          ...diff,
          a: { ...diff.a, id: a, name: ra.name },
          b: { ...diff.b, id: b, name: rb.name }
        }
      }
    }
  )

  // ── #2181 the map at the moment of a timeline event ──
  app.get<{ Querystring: { at?: string | string[] } }>(
    '/snapshots/near',
    tenantAware,
    async (req) => {
      const list = ([] as string[]).concat(req.query.at ?? []).slice(0, AT_MAX)
      const times = list.map((s) => new Date(s).getTime()).filter((t) => !Number.isNaN(t))
      if (times.length === 0) return { data: [] }
      const store = currentStoreId()
      const rows = (await db(SNAPSHOT_TABLE)
        .where('store', store)
        .whereBetween('created_at', [
          new Date(Math.min(...times) - NEAR_MS),
          new Date(Math.max(...times) + NEAR_MS)
        ])
        .orderBy('created_at', 'asc')
        .limit(500)
        .select('id', 'name', 'created_at')) as Array<{
        id: string
        name: string
        created_at: Date
      }>
      const out: Array<{
        at: string
        id: string | null
        name: string | null
        snapshot_at: string | null
        thumb: ReturnType<typeof thumbOf> | null
      }> = []
      for (const t of times) {
        const hit = nearestSnapshot(rows, t, NEAR_MS)
        let thumb = hit ? (thumbCache.get(hit.id) ?? null) : null
        if (hit && !thumb) {
          const full = (await db(SNAPSHOT_TABLE).where({ id: hit.id, store }).first('snapshot')) as
            | { snapshot?: unknown }
            | undefined
          const snap = parseSnap(full?.snapshot)
          if (snap) {
            thumb = thumbOf(snap)
            cacheThumb(hit.id, thumb)
          }
        }
        out.push({
          at: new Date(t).toISOString(),
          id: hit?.id ?? null,
          name: hit?.name ?? null,
          snapshot_at: hit ? new Date(hit.created_at).toISOString() : null,
          thumb
        })
      }
      return { data: out }
    }
  )

  // ── #2177 settings, retention, storage ──
  app.get('/map-settings', async () => {
    const { migrated, settings } = await loadMapSettings()
    const usage = await mapDataUsage(DEFAULT_STORE).catch(() => null)
    return { data: { migrated, settings, usage } }
  })
  app.patch('/map-settings', async (req, reply) => {
    try {
      const { migrated, settings } = await saveMapSettings(req.body)
      await logActivity({
        action: 'traffic-map-settings',
        user: req.user?.id ?? null,
        collection: SNAPSHOT_TABLE,
        comment: 'Traffic Map settings changed.',
        req
      })
      const usage = await mapDataUsage(DEFAULT_STORE).catch(() => null)
      return { data: { migrated, settings, usage } }
    } catch (e) {
      if (e instanceof MapSettingsError) {
        return reply.code(e.statusCode).send({ error: e.message, code: e.code })
      }
      throw e
    }
  })

  // ── #2242 environment banner ──
  app.get('/environment', async () => ({ data: await mapEnvironment() }))

  // ── #2245 what a node is ──
  app.get<{ Querystring: { kind?: string; id?: string } }>('/node-info', async (req, reply) => {
    const kind = req.query.kind as NodeInfoKind
    const id = String(req.query.id ?? '').slice(0, 200)
    if (!KINDS.includes(kind) || !id) {
      return reply.code(400).send({ error: 'kind and id are required', code: 'NODE_INFO_INVALID' })
    }
    const { settings } = await loadMapSettings()
    return { data: await describeNode(kind, id, settings.descriptions) }
  })
  app.put<{ Body: { kind?: string; id?: string; text?: string | null } }>(
    '/node-info',
    async (req, reply) => {
      const b = req.body ?? {}
      const kind = b.kind as NodeInfoKind
      const id = String(b.id ?? '').slice(0, 160)
      if (!KINDS.includes(kind) || !id) {
        return reply
          .code(400)
          .send({ error: 'kind and id are required', code: 'NODE_INFO_INVALID' })
      }
      const text = typeof b.text === 'string' && b.text.trim() ? b.text.trim() : null
      try {
        const { settings } = await saveMapSettings({
          descriptions: { [overrideKey(kind, id)]: text }
        })
        await logActivity({
          action: 'traffic-node-description',
          user: req.user?.id ?? null,
          collection: SNAPSHOT_TABLE,
          item: overrideKey(kind, id).slice(0, 100),
          comment: text
            ? `Described Traffic Map node ${overrideKey(kind, id)}.`
            : `Removed the description of Traffic Map node ${overrideKey(kind, id)}.`,
          req
        })
        return { data: await describeNode(kind, id, settings.descriptions) }
      } catch (e) {
        if (e instanceof MapSettingsError) {
          return reply.code(e.statusCode).send({ error: e.message, code: e.code })
        }
        throw e
      }
    }
  )

  // ── #2178 the map's own cost ──
  app.get('/overhead', tenantAware, async () => {
    const store = currentStoreId()
    const io = getIo() as unknown as {
      sockets?: { adapter?: { rooms?: Map<string, Set<string>> } }
    } | null
    const watchers = roomListeners(io, trafficRoomFor(store))
    const data = withTrafficStore(store, () => overheadReport(estimateMapBytes(), watchers))
    // One process serves many tenants in cloud mode: its memory and how many stores it holds are
    // instance facts, not this tenant's, so they stay out of a tenant's answer.
    if (process.env.CLOUD_META_DB_URL) {
      const { process_rss: _rss, process_heap_used: _heap, ...memory } = data.memory
      return { data: { ...data, memory } }
    }
    return { data, stores: trafficStoreIds().length }
  })
}
