import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { ccIsAdmin, ccReadAuth, ccWriteAuth } from '../services/command-center/auth.js'
import { type CcConfig, readCcConfig, writeCcConfig } from '../services/command-center/config.js'
import { geoPins, readGeoFilters, validGeoCollection } from '../services/command-center/geo.js'
import {
  LAYER_KINDS,
  type LayerKind,
  mapLayer,
  messageableUserIds
} from '../services/command-center/layers.js'
import { peekRecord } from '../services/command-center/peek.js'
import {
  bustRegionCaches,
  detectPlacement,
  readableName,
  readableRegions,
  regionCentroids,
  resolveGeoCollections,
  resolveRegionSource
} from '../services/command-center/regions.js'
import { readCcScope } from '../services/command-center/scope.js'
import { can } from '../services/permissions.js'

/**
 * Command Center — map & place (program slice 1): board config (map collections, region source,
 * stuck days), the record peek, extra map layers and "message these people". Registered under
 * /command-center beside routes/command-center.ts; /geo and /people-geo live there and call the
 * same services (services/command-center/geo.ts, regions.ts).
 */

const NO_KIOSK = { config: { ccNoKiosk: true } }

/**
 * The one map collection a wallboard link may read: the link's own map collection when it is a
 * configured geo collection, else the first configured one. Null = none configured.
 */
export async function kioskMapCollection(
  meta: { map_collection: string | null },
  geo?: Array<{ key: string }>
): Promise<string | null> {
  const list = geo ?? (await resolveGeoCollections().catch(() => []))
  if (meta.map_collection && list.some((g) => g.key === meta.map_collection))
    return meta.map_collection
  return list[0]?.key ?? null
}

export const MESSAGE_MAX_PEOPLE = 50
const MESSAGE_MAX_CHARS = 1000

export async function commandCenterPlaceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', ccReadAuth)

  // ── Board config the caller may use ──────────────────────────────────────
  app.get('/config', async (req, reply) => {
    const user = req.user!
    const isAdmin = ccIsAdmin(req)
    const [cfg, geo, source] = await Promise.all([
      readCcConfig(),
      resolveGeoCollections().catch(() => []),
      resolveRegionSource().catch(() => null)
    ])
    const readableGeo: Array<{ key: string; label: string }> = []
    const kioskMap = req.ccKiosk ? await kioskMapCollection(req.ccKiosk.meta, geo) : null
    for (const g of geo) {
      if (req.ccKiosk && g.key !== kioskMap) continue
      if (await can(user, 'read', g.key)) readableGeo.push({ key: g.key, label: g.label })
    }
    const [regions, centroids] = await Promise.all([
      readableRegions(user, source).catch(() => []),
      regionCentroids(source).catch(() => [])
    ])
    const centroidOf = new Map(centroids.map((c) => [c.id, c]))
    // A wallboard sees only the region its link opens on (read-only), never the whole list.
    const shownRegions = req.ccKiosk
      ? regions.filter((r) => r.id.toUpperCase() === (req.ccKiosk?.meta.region ?? '').toUpperCase())
      : regions
    let regionLabel: string | null = null
    if (source) {
      const det = await detectPlacement().catch(() => null)
      const dim = det?.meta.dimensions.find((d) => d.name === source.scope_dimension)
      const col = det?.meta.collections.find((c) => c.collection === source.collection)
      regionLabel = dim?.label ?? readableName(source.collection, col?.display_name)
    }
    return reply.send({
      data: {
        geo_collections: readableGeo,
        regions: shownRegions.map((r) => ({
          id: r.id,
          label: r.label,
          lat: centroidOf.get(r.id)?.lat ?? null,
          lng: centroidOf.get(r.id)?.lng ?? null
        })),
        region_label: shownRegions.length > 0 ? regionLabel : null,
        stuck_days: cfg.stuck_days,
        can_configure: isAdmin
      }
    })
  })

  // ── Admin: what detection found, for the Board settings sheet ────────────
  app.get('/config/candidates', { preHandler: requireAdmin }, async (_req, reply) => {
    const [cfg, det] = await Promise.all([readCcConfig(), detectPlacement()])
    return reply.send({
      data: {
        config: {
          geo_collections: cfg.geo_collections,
          region: cfg.region,
          stuck_days: cfg.stuck_days
        },
        geo: det.geo.map((g) => ({
          key: g.key,
          label: g.label,
          lat_field: g.lat_field,
          lng_field: g.lng_field
        })),
        regions: det.regions.map((r) => ({
          source: r.source,
          label: r.label,
          description: r.description,
          suggested: det.suggested === r
        }))
      }
    })
  })

  // ── Admin: save map collections / region source / stuck days ─────────────
  app.put<{
    Body: Partial<Pick<CcConfig, 'geo_collections' | 'region' | 'stuck_days'>>
  }>('/config', { preHandler: [ccWriteAuth, requireAdmin] }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    try {
      const next = await writeCcConfig((cur) => ({
        ...cur,
        ...('geo_collections' in b ? { geo_collections: b.geo_collections as string[] } : {}),
        ...('region' in b ? { region: b.region as CcConfig['region'] } : {}),
        ...('stuck_days' in b ? { stuck_days: Number(b.stuck_days) } : {})
      }))
      bustRegionCaches()
      return reply.send({
        data: {
          geo_collections: next.geo_collections,
          region: next.region,
          stuck_days: next.stuck_days
        }
      })
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message?: string }
      if (e.statusCode === 409)
        return reply
          .code(409)
          .send({ error: e.message ?? 'Not ready', code: e.code ?? 'MIGRATION_PENDING' })
      throw err
    }
  })

  // ── Peek: one record, read as the caller ─────────────────────────────────
  app.get<{ Querystring: { collection?: string; id?: string } }>(
    '/peek',
    NO_KIOSK,
    async (req, reply) => {
      const { collection, id } = req.query
      if (
        !validGeoCollection(collection) ||
        typeof id !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,64}$/.test(id)
      )
        return reply.code(400).send({ error: 'Name a record to peek at' })
      const out = await peekRecord(req.user!, ccIsAdmin(req), collection, id)
      if (!out) return reply.code(404).send({ error: 'Record not found' })
      return reply.send({ data: out })
    }
  )

  // ── Map layers ───────────────────────────────────────────────────────────
  app.get<{ Querystring: { kind?: string; collection?: string } }>(
    '/layers',
    async (req, reply) => {
      const kind = String(req.query.kind ?? '') as LayerKind
      if (!LAYER_KINDS.includes(kind)) return reply.code(400).send({ error: 'Unknown layer' })
      // Who is out names people: not for a wallboard.
      if (kind === 'out_today' && req.ccKiosk)
        return reply
          .code(403)
          .send({ error: 'A wallboard link cannot open this', code: 'KIOSK_NOT_ALLOWED' })
      let collection: string | null = null
      if (kind !== 'out_today') {
        const asked = req.query.collection
        if (asked !== undefined && !validGeoCollection(asked))
          return reply.code(400).send({ error: 'Invalid collection' })
        if (req.ccKiosk) {
          const only = await kioskMapCollection(req.ccKiosk.meta)
          if (asked !== undefined && asked !== only)
            return reply
              .code(403)
              .send({ error: 'A wallboard link cannot open this', code: 'KIOSK_NOT_ALLOWED' })
          collection = only
        } else collection = asked ?? (await resolveGeoCollections())[0]?.key ?? null
        if (collection && !(await can(req.user!, 'read', collection)))
          return reply.code(403).send({ error: 'No read access to that collection' })
      }
      const scope = readCcScope(req.query)
      return reply.send({
        data: await mapLayer(req.user!, ccIsAdmin(req), kind, collection, scope)
      })
    }
  )

  // ── Admin: one in-app message to each person in a group ──────────────────
  app.post<{ Body: { user_ids?: unknown; message?: unknown } }>(
    '/people/message',
    { preHandler: [ccWriteAuth, requireAdmin] },
    async (req, reply) => {
      const ids = Array.isArray(req.body?.user_ids)
        ? [...new Set(req.body.user_ids.map(String).filter((s) => /^[A-Za-z0-9-]{1,64}$/.test(s)))]
        : []
      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
      if (ids.length === 0) return reply.code(400).send({ error: 'Pick who to message' })
      if (ids.length > MESSAGE_MAX_PEOPLE)
        return reply
          .code(400)
          .send({ error: `At most ${MESSAGE_MAX_PEOPLE} people at once`, code: 'TOO_MANY' })
      if (!message) return reply.code(400).send({ error: 'Write a message' })
      if (message.length > MESSAGE_MAX_CHARS)
        return reply.code(400).send({ error: `Keep it under ${MESSAGE_MAX_CHARS} characters` })
      const targets = await messageableUserIds(ids)
      const { notifyUser } = await import('../services/notification-channels.js')
      const me = req.user!
      const from = [me.first_name, me.last_name].filter(Boolean).join(' ') || 'An administrator'
      let sent = 0
      for (const uid of targets) {
        try {
          const r = await notifyUser(app, uid, {
            subject: `Message from ${from}`,
            message,
            category: 'other',
            sender: me.id,
            always_inbox: true,
            source: { kind: 'command-center', label: 'Command Center' },
            why: 'An administrator messaged a group from the Command Center.'
          })
          if (r.id != null || !r.decision.dropped) sent++
        } catch (err) {
          req.log.warn({ err, uid }, 'command center message failed')
        }
      }
      const { logActivity } = await import('../services/activity.js')
      await logActivity({
        action: 'command-center-message',
        user: me.id,
        comment: `messaged ${sent} of ${ids.length} people`,
        req
      })
      return reply.send({ data: { sent, skipped: ids.length - sent } })
    }
  )
}

/** /geo handler body (called from routes/command-center.ts). */
export async function geoRoute(
  req: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply
) {
  const q = (req.query ?? {}) as Record<string, unknown>
  const asked = typeof q.collection === 'string' && q.collection ? q.collection : null
  let collection: string | null
  if (req.ccKiosk) {
    // A wallboard reads its link's map collection and nothing else.
    const only = await kioskMapCollection(req.ccKiosk.meta)
    if (asked !== null && asked !== only)
      return reply
        .code(403)
        .send({ error: 'A wallboard link cannot open this', code: 'KIOSK_NOT_ALLOWED' })
    collection = only
  } else collection = asked ?? (await resolveGeoCollections())[0]?.key ?? null
  if (!collection)
    return reply.send({ data: { pins: [], truncated: false, region_applies: false, no_geo: true } })
  if (!validGeoCollection(collection)) return reply.code(400).send({ error: 'Invalid collection' })
  if (!(await can(req.user!, 'read', collection)))
    return reply.code(403).send({ error: 'No read access to that collection' })
  const ans = await geoPins(
    req.user!,
    collection,
    readCcScope(req.query),
    readGeoFilters(req.query)
  )
  return reply.send({ data: ans })
}

/** /people-geo handler body: region centres the caller may read. */
export async function peopleGeoRoute(
  req: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply
) {
  const source = await resolveRegionSource()
  const [regions, centroids] = await Promise.all([
    readableRegions(req.user!, source).catch(() => []),
    regionCentroids(source).catch(() => [])
  ])
  const readable = new Set(regions.map((r) => r.id))
  return reply.send({ data: centroids.filter((c) => readable.has(c.id)) })
}
