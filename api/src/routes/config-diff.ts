import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  buildConfigSnapshot,
  type ConfigSnapshot,
  classifyTables,
  diffSnapshots
} from '../services/config-inventory.js'
import { NIVARO_VERSION } from '../version.js'

/**
 * Environment configuration diff.
 *
 * Comparison is EXPORT-AND-UPLOAD, not instance-to-instance fetch: the two
 * environments being compared are routinely on different networks, and having
 * production reach out to an operator-supplied URL would add an SSRF surface
 * to answer a question a file already answers. The operator downloads a
 * snapshot from one instance and uploads it to the other.
 *
 * Admin-only, and the export is activity-logged — a config snapshot is a
 * meaningful egress of how an instance is configured, even with secrets
 * stripped (see REDACTED in config-inventory.ts).
 */
export async function configDiffRoutes(app: FastifyInstance) {
  /** What this instance considers configuration, without shipping any of it. */
  app.get('/config-diff/inventory', { preHandler: requireAdmin }, async (_req, reply) => {
    const rows = (await db.raw(
      `SELECT name FROM sys.tables WHERE name LIKE 'nivaro[_]%'`
    )) as Array<{
      name: string
    }>
    const classification = classifyTables(rows.map((r) => r.name))

    // Row counts make the inventory page useful on its own — an operator can
    // see the shape of the instance before deciding to export anything.
    //
    // One query over the partition stats rather than 86 COUNT(*)s: at this
    // server's ~37ms round trip that loop took over three seconds and the page
    // rendered its stat tiles empty while it ran. These counts come from index
    // metadata, so they can lag a very recent write by moments — fine for "how
    // big is this instance", and the snapshot itself always reads real rows.
    const counts: Record<string, number> = {}
    try {
      const countRows = (await db.raw(
        `SELECT t.name AS name, SUM(p.row_count) AS row_count
           FROM sys.tables t
           JOIN sys.dm_db_partition_stats p
             ON p.object_id = t.object_id AND p.index_id IN (0, 1)
          WHERE t.name LIKE 'nivaro[_]%'
          GROUP BY t.name`
      )) as Array<{ name: string; row_count: number | string }>
      const configSet = new Set(classification.config)
      for (const r of countRows) {
        if (configSet.has(r.name)) counts[r.name] = Number(r.row_count ?? 0)
      }
    } catch {
      // Counts are decoration; the classification below is the real payload.
    }

    return reply.send({
      data: {
        instance: {
          version: NIVARO_VERSION,
          environment: config.NODE_ENV,
          database: config.DB_DATABASE
        },
        classification,
        counts
      }
    })
  })

  app.get('/config-diff/snapshot', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { label?: string; tables?: string }
    const snapshot = await buildConfigSnapshot({
      label: q.label,
      tables: q.tables
        ? q.tables
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      version: NIVARO_VERSION,
      environment: config.NODE_ENV
    })

    await logActivity({
      action: 'config-snapshot-export',
      user: req.user?.id ?? null,
      comment: `${Object.keys(snapshot.tables).length} config tables`
    })

    return reply
      .header(
        'content-disposition',
        `attachment; filename="nivaro-config-${snapshot.instance.database}-${snapshot.generated_at.slice(0, 10)}.json"`
      )
      .send({ data: snapshot })
  })

  /**
   * Compare an uploaded snapshot against this instance's live configuration.
   * The uploaded side is always `theirs`; this instance is always `mine`.
   */
  app.post(
    '/config-diff/compare',
    {
      preHandler: requireAdmin,
      // A real snapshot is the whole config layer — tens of thousands of rows,
      // routinely far past Fastify's 1MB default, which rejected the first
      // genuine upload with a bare 413. Raised only for this route.
      bodyLimit: 128 * 1024 * 1024
    },
    async (req, reply) => {
      const body = req.body as { snapshot?: ConfigSnapshot } | ConfigSnapshot | undefined
      const theirs = (body && 'snapshot' in body ? body.snapshot : body) as
        | ConfigSnapshot
        | undefined

      if (!theirs || typeof theirs !== 'object' || !theirs.tables) {
        return reply.code(400).send({ error: 'Body must be a config snapshot (or {snapshot})' })
      }
      if (theirs.format !== 1) {
        return reply
          .code(400)
          .send({ error: `Unsupported snapshot format: ${String(theirs.format)}` })
      }

      // Only build the tables the uploaded snapshot actually carries — comparing
      // against tables it never captured would report every row as "added here",
      // which is drift the operator did not create and cannot act on.
      const mine = await buildConfigSnapshot({
        tables: Object.keys(theirs.tables),
        version: NIVARO_VERSION,
        environment: config.NODE_ENV
      })

      return reply.send({ data: diffSnapshots(mine, theirs) })
    }
  )
}
