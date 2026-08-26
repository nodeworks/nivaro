import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { startJobRun } from '../services/job-runs.js'
import { geocodeAddress } from '../services/office-geocode.js'

/**
 * Collection geocoding backfill (#645) — resolve an address column into
 * lat/lng columns for existing rows (the Units Map / BaseMap consumers need
 * coordinates, and imported data almost never has them).
 *
 * POST /geocode/backfill {collection, address_field, lat_field, lng_field,
 * limit?} — admin only, fire-and-forget (job run 'geocode-backfill' carries
 * progress). Rows with a non-empty address and a NULL lat are processed
 * oldest-id-first; Nominatim politeness = 1.1s between remote lookups
 * (known-locations street matches are free), capped 500 rows per run so a
 * 100k-row table is backfilled in deliberate passes, not one multi-day job.
 *
 * Writes are RAW by design (system-derived enrichment, same posture as stored
 * rollups): no revisions, no hooks, never fails the row's other data.
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_ROWS_PER_RUN = 500

let running = false

export async function geocodeBackfillRoutes(app: FastifyInstance) {
  app.post('/backfill', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      collection?: string
      address_field?: string
      lat_field?: string
      lng_field?: string
      limit?: number
    }
    const { collection, address_field, lat_field, lng_field } = body
    for (const [name, v] of Object.entries({ collection, address_field, lat_field, lng_field })) {
      if (!v || !IDENT_RE.test(v)) return reply.code(400).send({ error: `${name} required` })
    }
    if (/^(nivaro|directus)_/i.test(collection!)) {
      return reply.code(400).send({ error: 'Business collections only' })
    }
    const registered = await db('nivaro_collections').where({ collection }).first('collection')
    if (!registered) return reply.code(404).send({ error: 'Unknown collection' })
    // Every named column must physically exist — a typo'd column name would
    // otherwise fail 500 rows one by one inside the job.
    const cols = (await db('information_schema.columns')
      .where({ table_name: collection })
      .pluck('column_name')) as string[]
    const colSet = new Set(cols.map((c) => c.toLowerCase()))
    for (const f of [address_field!, lat_field!, lng_field!]) {
      if (!colSet.has(f.toLowerCase())) {
        return reply.code(400).send({ error: `Column "${f}" does not exist on ${collection}` })
      }
    }
    if (running) return reply.code(409).send({ error: 'A geocode backfill is already running' })

    const limit = Math.min(Math.max(Number(body.limit) || MAX_ROWS_PER_RUN, 1), MAX_ROWS_PER_RUN)
    const pending = (await db(collection!)
      .whereNull(lat_field!)
      .whereNotNull(address_field!)
      .whereRaw(`LTRIM(RTRIM(CAST(?? AS NVARCHAR(500)))) <> ''`, [address_field!])
      .orderBy('id', 'asc')
      .limit(limit)
      .select('id', address_field!)) as Array<Record<string, unknown>>

    await logActivity({
      action: 'geocode-backfill',
      user: req.user?.id,
      collection: 'nivaro_collections',
      item: collection,
      comment: `${pending.length} rows queued (${address_field} → ${lat_field}/${lng_field})`,
      req
    })

    if (pending.length === 0) return reply.send({ data: { queued: 0, message: 'Nothing to geocode' } })

    running = true
    void (async () => {
      const run = await startJobRun('backfill', 'geocode-backfill', {
        label: `${collection}.${address_field} → ${lat_field}/${lng_field}`,
        triggeredBy: req.user?.id ?? null
      })
      let resolved = 0
      let missed = 0
      try {
        for (let i = 0; i < pending.length; i++) {
          const row = pending[i]
          const addr = String(row[address_field!] ?? '').trim()
          const hit = await geocodeAddress(addr)
          if (hit) {
            await db(collection!)
              .where({ id: row.id })
              .update({ [lat_field!]: hit.lat, [lng_field!]: hit.lng })
              .catch(() => {
                missed++
              })
            resolved++
          } else {
            missed++
          }
          if (i % 20 === 0) run.progress({ done: i + 1, total: pending.length, resolved, missed })
          // Nominatim usage policy: max 1 req/s. Known-location matches don't
          // hit the network but the loop stays uniformly paced for simplicity.
          await new Promise((r) => setTimeout(r, 1100))
        }
        await run.complete(`${resolved} resolved, ${missed} unresolved of ${pending.length}`)
      } catch (err) {
        await run.fail(err)
      } finally {
        running = false
      }
    })()

    return reply.code(202).send({
      data: { queued: pending.length, message: 'Backfill started — watch Background Jobs' }
    })
  })

  /** How much is left to geocode — powers the TableEditor card's counter. */
  app.get('/backfill/pending', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { collection?: string; address_field?: string; lat_field?: string }
    const { collection, address_field, lat_field } = q
    for (const v of [collection, address_field, lat_field]) {
      if (!v || !IDENT_RE.test(v)) return reply.code(400).send({ error: 'collection, address_field, lat_field required' })
    }
    if (/^(nivaro|directus)_/i.test(collection!)) {
      return reply.code(400).send({ error: 'Business collections only' })
    }
    try {
      const cnt = (await db(collection!)
        .whereNull(lat_field!)
        .whereNotNull(address_field!)
        .count<{ c: number }[]>('* as c')) as Array<{ c: number }>
      return reply.send({ data: { pending: Number(cnt[0]?.c ?? 0), running } })
    } catch {
      return reply.code(400).send({ error: 'Could not inspect columns' })
    }
  })
}
