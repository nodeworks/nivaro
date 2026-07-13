import { Readable } from 'node:stream'
import { createGzip } from 'node:zlib'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Logical backup export — DB-agnostic gzip NDJSON stream.
 *
 * Line 1 is a meta record; every following line is {"table","row"}. Restores
 * are deliberately out of scope (import into a live instance is a destructive
 * operation that deserves its own reviewed design) — this is the "get my data
 * out on demand / on schedule" half.
 *
 * Business tables come from nivaro_collections (physical only). With
 * ?include_system=true the nivaro_* configuration tables ride along, minus
 * volatile/derived ones (sessions, logs, caches, vectors) that are
 * regenerable and can dwarf the real data.
 */

const SYSTEM_EXCLUDE = new Set([
  'nivaro_sessions',
  'nivaro_api_logs',
  'nivaro_page_views',
  'nivaro_embeddings',
  'nivaro_migrations',
  'nivaro_queue_items', // materialized cache — rebuilt by backfill
  'nivaro_queue_item_owners'
])

const PAGE = 1000

async function* exportLines(includeSystem: boolean): AsyncGenerator<string> {
  const collections = (await db('nivaro_collections')
    .where((qb) => qb.where('is_virtual', 0).orWhereNull('is_virtual'))
    .select('collection')) as Array<{ collection: string }>
  const businessTables = collections
    .map((c) => c.collection)
    .filter((c) => !c.startsWith('nivaro_') && !c.startsWith('directus_'))

  let systemTables: string[] = []
  if (includeSystem) {
    const rows = (await db.raw(
      `SELECT TABLE_NAME AS name FROM information_schema.tables
       WHERE TABLE_NAME LIKE 'nivaro_%' AND TABLE_TYPE = 'BASE TABLE'`
    )) as Array<{ name: string }>
    systemTables = rows.map((r) => r.name).filter((n) => !SYSTEM_EXCLUDE.has(n))
  }

  const tables = [...businessTables, ...systemTables]

  yield `${JSON.stringify({
    type: 'nivaro-backup',
    version: 1,
    exported_at: new Date().toISOString(),
    include_system: includeSystem,
    tables
  })}\n`

  for (const table of tables) {
    let offset = 0
    for (;;) {
      let rows: Array<Record<string, unknown>>
      try {
        // ORDER BY (SELECT NULL): MSSQL requires an ORDER BY for OFFSET/FETCH
        rows = (await db.raw(
          `SELECT * FROM [${table}] ORDER BY (SELECT NULL)
           OFFSET ${offset} ROWS FETCH NEXT ${PAGE} ROWS ONLY`
        )) as Array<Record<string, unknown>>
      } catch {
        yield `${JSON.stringify({ table, error: 'read failed — skipped' })}\n`
        break
      }
      for (const row of rows) {
        yield `${JSON.stringify({ table, row })}\n`
      }
      if (rows.length < PAGE) break
      offset += PAGE
    }
  }
}

export async function backupsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // List what an export would include (drives the Settings card)
  app.get('/manifest', async (req, reply) => {
    const includeSystem = (req.query as { include_system?: string }).include_system === 'true'
    const collections = (await db('nivaro_collections')
      .where((qb) => qb.where('is_virtual', 0).orWhereNull('is_virtual'))
      .select('collection')) as Array<{ collection: string }>
    const business = collections
      .map((c) => c.collection)
      .filter((c) => !c.startsWith('nivaro_') && !c.startsWith('directus_'))
    let system: string[] = []
    if (includeSystem) {
      const rows = (await db.raw(
        `SELECT TABLE_NAME AS name FROM information_schema.tables
         WHERE TABLE_NAME LIKE 'nivaro_%' AND TABLE_TYPE = 'BASE TABLE'`
      )) as Array<{ name: string }>
      system = rows.map((r) => r.name).filter((n) => !SYSTEM_EXCLUDE.has(n))
    }
    return reply.send({ data: { business, system, excluded: [...SYSTEM_EXCLUDE] } })
  })

  app.get('/export', async (req, reply) => {
    const includeSystem = (req.query as { include_system?: string }).include_system === 'true'

    await logActivity({
      action: 'backup-export',
      collection: 'nivaro_settings',
      item: '1',
      user: req.user?.id,
      comment: includeSystem ? 'business + system tables' : 'business tables',
      req
    })

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const stream = Readable.from(exportLines(includeSystem)).pipe(createGzip())
    return reply
      .header('Content-Type', 'application/gzip')
      .header('Content-Disposition', `attachment; filename="nivaro-backup-${stamp}.ndjson.gz"`)
      .send(stream)
  })
}
