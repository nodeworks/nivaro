import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { can } from '../services/permissions.js'

/**
 * Command Center (/command): one aggregator over data the platform already
 * computes — nothing here derives new state, it composes existing services
 * into a live ops board. Every sub-block is independently try/caught so one
 * broken source degrades to an empty pane, never a dead board.
 *
 * Reads honor the caller: record-level payloads (map pins) go through the
 * items service (RBAC/RLS/scopes); aggregate counts are gated on collection
 * read permission; the system-health block is admin-only.
 */

interface GeoPin {
  id: string
  lat: number
  lng: number
  label: string
  state: string | null
  state_color: string | null
  sla: 'ok' | 'warning' | 'breached' | null
}

/** 10-min cache of region centroids — AVG of each region's geocoded linked
 *  locations. Regions with zero geocoded locations are honestly absent. */
let centroidCache: { at: number; rows: Array<{ id: number; label: string; lat: number; lng: number }> } | null = null

async function regionCentroids(): Promise<Array<{ id: number; label: string; lat: number; lng: number }>> {
  if (centroidCache && Date.now() - centroidCache.at < 10 * 60_000) return centroidCache.rows
  let rows: Array<{ id: number; label: string; lat: number; lng: number }> = []
  try {
    rows = (
      (await db.raw(`
        SELECT r.id, COALESCE(r.short_name, CAST(r.id AS nvarchar(20))) AS label,
               AVG(CAST(l.latitude AS float)) AS lat, AVG(CAST(l.longitude AS float)) AS lng
        FROM regions r
        JOIN location_regions_junction j ON j.region = r.id
        JOIN locations l ON l.id = j.location
        WHERE l.latitude IS NOT NULL AND l.latitude <> 0 AND l.longitude IS NOT NULL AND l.longitude <> 0
        GROUP BY r.id, r.short_name
        HAVING COUNT(*) >= 2
      `)) as Array<{ id: number; label: string; lat: number; lng: number }>
    ).filter((r) => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng)))
  } catch {
    rows = []
  }
  centroidCache = { at: Date.now(), rows }
  return rows
}

export async function commandCenterRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // ── Snapshot: everything except map geometry, one round trip ─────────────
  app.get('/snapshot', async (req, reply) => {
    const isAdmin = !!req.isAdmin
    const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await fn()
      } catch {
        return fallback
      }
    }

    const [flow, risk, people, throughput, health, activity] = await Promise.all([
      // Pipeline flow board: per bound collection, live state counts of OPEN
      // instances. Gated per collection on read permission.
      safe(async () => {
        const bindings = (await db('nivaro_workflow_bindings as b')
          .join('nivaro_workflow_templates as t', 't.id', 'b.template')
          .select('b.collection', 'b.template', 't.name as template_name')) as Array<{
          collection: string
          template: string
          template_name: string
        }>
        const out: Array<{
          collection: string
          template_name: string
          states: Array<{ key: string; label: string; color: string | null; count: number }>
        }> = []
        for (const b of bindings) {
          if (!(await can(req.user!, 'read', b.collection))) continue
          const counts = (await db('nivaro_workflow_instances as i')
            .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
            .where('i.collection', b.collection)
            .where('i.template', b.template)
            .whereNull('i.completed_at')
            .groupBy('s.key', 's.label', 's.color', 's.sort')
            .orderBy('s.sort', 'asc')
            .select('s.key', 's.label', 's.color')
            .count('* as count')) as Array<{ key: string; label: string; color: string | null; count: number }>
          if (counts.length > 0) {
            out.push({
              collection: b.collection,
              template_name: b.template_name,
              states: counts.map((c) => ({ ...c, count: Number(c.count) }))
            })
          }
        }
        return out
      }, [] as Array<{ collection: string; template_name: string; states: Array<{ key: string; label: string; color: string | null; count: number }> }>),

      // Risk strip: SLA warning/breached + at-risk + open issues, cheap counts.
      safe(async () => {
        const since = new Date(Date.now() - 90 * 86_400_000)
        // Materialized queue rows carry SLA verdicts already — the cheapest
        // instance-wide read that exists. Fall back to zeros when no queue is
        // materialized; the strip labels its source honestly.
        const slaRow = (await db('nivaro_queue_items')
          .select(
            db.raw("SUM(CASE WHEN at_risk = 1 THEN 1 ELSE 0 END) as at_risk"),
            db.raw('COUNT(DISTINCT CONCAT(collection, \':\', item_id)) as tracked')
          )
          .first()
          .catch(() => null)) as { at_risk: number; tracked: number } | null
        const openIssues = (await db('nivaro_issues')
          .where('status', 'open')
          .where('last_seen_at', '>', since)
          .count('* as n')
          .first()) as { n: number }
        return {
          at_risk: Number(slaRow?.at_risk ?? 0),
          tracked: Number(slaRow?.tracked ?? 0),
          open_issues: Number(openIssues?.n ?? 0)
        }
      }, { at_risk: 0, tracked: 0, open_issues: 0 }),

      // People: online users per region/zone scope value (ids — the geo route
      // resolves centroids; the pane also lists names).
      safe(async () => {
        const cutoff = new Date(Date.now() - 70_000)
        let online = (await db('user_presence')
          .where('last_seen', '>', cutoff)
          .whereNot('is_online', false)
          .select('user_id', 'display_name', 'is_idle')) as Array<{
          user_id: string
          display_name: string | null
          is_idle: boolean | null
        }>
        // Presence visibility boundary (same rule as /presence/online): a
        // viewer with restrict scopes only sees people whose restrict scopes
        // OVERLAP on EVERY dimension the viewer restricts (self always
        // visible). Without this the board leaked the full online roster to
        // scoped users — security-review finding.
        if (!req.isAdmin) {
          const myRows = (await db('nivaro_user_scopes')
            .where({ user: req.user!.id, mode: 'restrict' })
            .select('dimension', 'values')) as Array<{ dimension: string; values: string | null }>
          const myDims = new Map<string, Set<string>>()
          for (const r of myRows) {
            try {
              const v = JSON.parse(r.values ?? '[]')
              if (Array.isArray(v) && v.length) myDims.set(r.dimension, new Set(v.map(String)))
            } catch {
              /* corrupt row */
            }
          }
          if (myDims.size > 0) {
            const allIds = online.map((o) => String(o.user_id).toUpperCase())
            const theirRows = allIds.length
              ? ((await db('nivaro_user_scopes')
                  .whereIn('dimension', [...myDims.keys()])
                  .where('mode', 'restrict')
                  .whereIn('user', allIds)
                  .select('user', 'dimension', 'values')) as Array<{ user: string; dimension: string; values: string | null }>)
              : []
            const theirs = new Map<string, Map<string, Set<string>>>()
            for (const r of theirRows) {
              const uid = String(r.user).toUpperCase()
              const m = theirs.get(uid) ?? new Map<string, Set<string>>()
              try {
                const v = JSON.parse(r.values ?? '[]')
                if (Array.isArray(v)) m.set(r.dimension, new Set(v.map(String)))
              } catch {
                /* corrupt row */
              }
              theirs.set(uid, m)
            }
            const me = String(req.user!.id).toUpperCase()
            online = online.filter((o) => {
              const uid = String(o.user_id).toUpperCase()
              if (uid === me) return true
              const m = theirs.get(uid)
              if (!m) return false
              return [...myDims.entries()].every(([dim, mine]) => {
                const t = m.get(dim)
                if (!t) return false
                return [...t].some((v) => mine.has(v))
              })
            })
          }
        }

        const ids = online.map((o) => String(o.user_id).toUpperCase())

        // Precise office pins: users whose Graph office_location has been
        // geocoded (migration 276) group into per-office bubbles; only the
        // REMAINDER falls back to region-centroid bubbles, so nobody is
        // counted on the map twice.
        const officeRows = ids.length
          ? ((await db('nivaro_users')
              .whereIn('id', ids)
              .whereNotNull('office_lat')
              .select('id', 'office_lat', 'office_lng', 'office_location')
              .catch(() => [])) as Array<{
              id: string
              office_lat: number
              office_lng: number
              office_location: string | null
            }>)
          : []
        const officeByUser = new Map(officeRows.map((r) => [String(r.id).toUpperCase(), r]))
        const officeGroups = new Map<
          string,
          { lat: number; lng: number; label: string; names: string[] }
        >()
        for (const o of online) {
          const office = officeByUser.get(String(o.user_id).toUpperCase())
          if (!office) continue
          const lat = Number(office.office_lat)
          const lng = Number(office.office_lng)
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
          const key = `${lat.toFixed(4)},${lng.toFixed(4)}`
          const g = officeGroups.get(key) ?? {
            lat,
            lng,
            label: office.office_location ?? 'Office',
            names: []
          }
          g.names.push(o.display_name ?? 'Unknown')
          officeGroups.set(key, g)
        }
        const hasOffice = (uid: string) => officeByUser.has(uid)

        const scopeRows = ids.length
          ? ((await db('nivaro_user_scopes')
              .whereIn('dimension', ['region', 'division'])
              .where('mode', 'restrict')
              .whereIn('user', ids)
              .select('user', 'dimension', 'values')) as Array<{ user: string; dimension: string; values: string | null }>)
          : []
        const regionByUser = new Map<string, number[]>()
        for (const r of scopeRows) {
          if (r.dimension !== 'region') continue
          try {
            const vals = JSON.parse(r.values ?? '[]')
            if (Array.isArray(vals)) regionByUser.set(String(r.user).toUpperCase(), vals.map(Number))
          } catch {
            /* corrupt scope row */
          }
        }
        const byRegion = new Map<number, number>()
        for (const o of online) {
          const uid = String(o.user_id).toUpperCase()
          if (hasOffice(uid)) continue // already pinned at a real office
          for (const rid of regionByUser.get(uid) ?? []) {
            byRegion.set(rid, (byRegion.get(rid) ?? 0) + 1)
          }
        }
        // Group PEOPLE by region so the pane mirrors the map bubbles —
        // "hard to distinguish who is where" (Rob). Users with no region
        // placement land in an honest "No region set" bucket.
        const regionLabels = new Map<number, string>()
        const allRegionIds = [...new Set([...regionByUser.values()].flat())]
        if (allRegionIds.length > 0) {
          try {
            const labels = (await db('regions')
              .whereIn('id', allRegionIds)
              .select('id', 'short_name')) as Array<{ id: number; short_name: string | null }>
            for (const l of labels) regionLabels.set(l.id, l.short_name ?? String(l.id))
          } catch {
            /* labels degrade to ids */
          }
        }
        const grouped = new Map<number | null, string[]>()
        for (const o of online) {
          const regs = regionByUser.get(String(o.user_id).toUpperCase()) ?? []
          const name = o.display_name ?? 'Unknown'
          if (regs.length === 0) {
            grouped.set(null, [...(grouped.get(null) ?? []), name])
          } else {
            for (const rid of regs) grouped.set(rid, [...(grouped.get(rid) ?? []), name])
          }
        }
        return {
          online_count: online.length,
          idle_count: online.filter((o) => o.is_idle).length,
          names: online.slice(0, 40).map((o) => o.display_name ?? 'Unknown'),
          by_region: [...byRegion.entries()].map(([region_id, count]) => ({ region_id, count })),
          offices: [...officeGroups.values()].map((g) => ({
            lat: g.lat,
            lng: g.lng,
            label: g.label,
            count: g.names.length,
            names: g.names.slice(0, 30)
          })),
          regions: [...grouped.entries()]
            .map(([region_id, names]) => ({
              region_id,
              label: region_id === null ? 'No region set' : (regionLabels.get(region_id) ?? String(region_id)),
              count: names.length,
              names: names.slice(0, 30)
            }))
            .sort((a, z) => z.count - a.count)
        }
      }, { online_count: 0, idle_count: 0, names: [] as string[], by_region: [] as Array<{ region_id: number; count: number }>, offices: [] as Array<{ lat: number; lng: number; label: string; count: number; names: string[] }>, regions: [] as Array<{ region_id: number | null; label: string; count: number; names: string[] }> }),

      // Throughput: transitions today vs same window yesterday.
      safe(async () => {
        const now = new Date()
        const todayStart = new Date(now)
        todayStart.setUTCHours(0, 0, 0, 0)
        const yStart = new Date(todayStart.getTime() - 86_400_000)
        const yCut = new Date(now.getTime() - 86_400_000)
        const [today, yesterday] = await Promise.all([
          db('nivaro_workflow_history').where('timestamp', '>', todayStart).count('* as n').first(),
          db('nivaro_workflow_history').whereBetween('timestamp', [yStart, yCut]).count('* as n').first()
        ])
        return {
          transitions_today: Number((today as { n: number })?.n ?? 0),
          transitions_yesterday_same_time: Number((yesterday as { n: number })?.n ?? 0)
        }
      }, { transitions_today: 0, transitions_yesterday_same_time: 0 }),

      // System rail — ADMIN ONLY (names internal jobs and error details).
      isAdmin
        ? safe(async () => {
            const hourAgo = new Date(Date.now() - 3600_000)
            const [errRow, reqRow, running, failedJobs] = await Promise.all([
              db('nivaro_api_logs').where('created_at', '>', hourAgo).where('status', '>=', 500).count('* as n').first(),
              db('nivaro_api_logs').where('created_at', '>', hourAgo).count('* as n').first(),
              db('nivaro_job_runs').where('status', 'running').count('* as n').first(),
              db('nivaro_job_runs').where('status', 'error').where('started_at', '>', hourAgo).count('* as n').first()
            ])
            let dbOk = true
            try {
              await db.raw('SELECT 1')
            } catch {
              dbOk = false
            }
            let redisOk = false
            try {
              const redis = (app as unknown as { redis?: { ping: () => Promise<string> } }).redis
              if (redis) {
                await redis.ping()
                redisOk = true
              }
            } catch {
              redisOk = false
            }
            const { runtimeStats } = await import('../services/runtime-monitor.js')
            const { listInstances } = await import('../services/instance-roster.js')
            return {
              db_ok: dbOk,
              redis_ok: redisOk,
              errors_1h: Number((errRow as { n: number })?.n ?? 0),
              requests_1h: Number((reqRow as { n: number })?.n ?? 0),
              jobs_running: Number((running as { n: number })?.n ?? 0),
              jobs_failed_1h: Number((failedJobs as { n: number })?.n ?? 0),
              runtime: runtimeStats(),
              instances: (await listInstances()).length
            }
          }, null)
        : Promise.resolve(null),

      // Ticker seed: the last 25 business-collection writes with friendly text.
      // Live updates ride the pulse socket (admins) or this poll (everyone).
      safe(async () => {
        const rows = (await db('nivaro_activity as a')
          .leftJoin('nivaro_users as u', 'u.id', 'a.user')
          .whereNot('a.collection', 'like', 'nivaro\\_%')
          .whereIn('a.action', ['create', 'update', 'delete', 'pipeline-transition'])
          .orderBy('a.id', 'desc')
          .limit(25)
          .select(
            'a.id',
            'a.action',
            'a.collection',
            'a.item',
            'a.comment',
            'a.timestamp',
            db.raw("LTRIM(RTRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))) as user_name")
          )) as Array<Record<string, unknown>>
        const readable: Array<Record<string, unknown>> = []
        const checked = new Map<string, boolean>()
        for (const r of rows) {
          const col = String(r.collection ?? '')
          if (!checked.has(col)) checked.set(col, await can(req.user!, 'read', col))
          if (checked.get(col)) readable.push(r)
        }
        return readable
      }, [] as Array<Record<string, unknown>>)
    ])

    return reply.send({ data: { flow, risk, people, throughput, health, activity } })
  })

  // ── Map geometry ─────────────────────────────────────────────────────────
  // Record pins for one geo-bearing collection, THROUGH the items service so
  // RBAC/RLS/User Scopes bind, decorated with workflow state + SLA.
  app.get<{ Querystring: { collection?: string } }>('/geo', async (req, reply) => {
    const collection = String(req.query.collection ?? 'locations')
    if (!/^[A-Za-z0-9_]+$/.test(collection) || /^nivaro_/i.test(collection)) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    if (!(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'No read access to that collection' })
    }
    const { readItems } = await import('../services/items.js')
    // Which lat/lng columns does this collection carry?
    const cols = (await db.raw(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME IN ('latitude','longitude','lat','lng','lon','name','title','label')`,
      [collection]
    )) as Array<{ COLUMN_NAME: string }>
    const names = new Set(cols.map((c) => c.COLUMN_NAME.toLowerCase()))
    const latField = names.has('latitude') ? 'latitude' : names.has('lat') ? 'lat' : null
    const lngField = names.has('longitude') ? 'longitude' : names.has('lng') ? 'lng' : names.has('lon') ? 'lon' : null
    if (!latField || !lngField) {
      return reply.send({ data: [], no_geo: true })
    }
    const labelField = names.has('name') ? 'name' : names.has('title') ? 'title' : names.has('label') ? 'label' : null

    const result = await readItems(req.user!, collection, {
      limit: 500,
      fields: ['id', latField, lngField, ...(labelField ? [labelField] : [])]
    } as never)
    const rows = ((result as { data?: Array<Record<string, unknown>> }).data ?? []).filter(
      (r) => Number(r[latField]) !== 0 && Number.isFinite(Number(r[latField])) && Number.isFinite(Number(r[lngField]))
    )

    // Decorate with state + SLA where a workflow instance exists.
    const ids = rows.map((r) => String(r.id))
    const stateById = new Map<string, { key: string; label: string; color: string | null }>()
    try {
      if (ids.length > 0) {
        const { selectInChunks } = await import('../services/db-batch.js')
        const inst = (await selectInChunks(ids, 2000, (chunk) =>
          db('nivaro_workflow_instances as i')
            .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
            .where('i.collection', collection)
            .whereIn('i.item', chunk)
            .whereNull('i.completed_at')
            .select('i.item', 's.key', 's.label', 's.color')
        )) as Array<{ item: string; key: string; label: string; color: string | null }>
        for (const i of inst) stateById.set(String(i.item), { key: i.key, label: i.label, color: i.color })
      }
    } catch {
      /* unbound collection — pins stay uncolored */
    }
    let slaById: Record<string, { status?: string }> = {}
    try {
      const { computeStatusBatch } = await import('./sla.js')
      slaById = (await computeStatusBatch(collection, ids)) as Record<string, { status?: string }>
    } catch {
      /* no SLA rules */
    }

    const pins: GeoPin[] = rows.map((r) => {
      const id = String(r.id)
      const st = stateById.get(id)
      const sla = slaById[id]?.status
      return {
        id,
        lat: Number(r[latField]),
        lng: Number(r[lngField]),
        label: labelField && r[labelField] != null ? String(r[labelField]) : `#${id}`,
        state: st?.label ?? null,
        state_color: st?.color ?? null,
        sla: sla === 'breached' ? 'breached' : sla === 'warning' ? 'warning' : st ? 'ok' : null
      }
    })
    return reply.send({ data: pins, truncated: ids.length >= 500 })
  })

  // ── People layer: region centroids + online counts ───────────────────────
  app.get('/people-geo', async (_req, reply) => {
    const centroids = await regionCentroids()
    return reply.send({ data: centroids })
  })
}
