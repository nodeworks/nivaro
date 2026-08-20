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

  /**
   * Apply one table's rows FROM an uploaded snapshot onto this instance —
   * the "fix the drift" half the diff page never had.
   *
   * Semantics, all deliberate:
   * - CONFIG tables only (this instance's classification is the authority).
   *   DERIVED/RUNTIME tables are regenerated or per-instance by definition.
   * - Upsert only, NEVER delete — a row present here but absent in the
   *   snapshot stays (the promotion-route precedent; deletions are a human
   *   decision, not a sync side effect).
   * - Only columns PRESENT in the snapshot row are written, and only ones
   *   that exist on the live table — so redacted secret columns (dropped at
   *   export, not masked) are never nulled out, and a schema mismatch skips
   *   the missing column instead of failing the row.
   * - Rows keyed `#<hash>` (no id column) cannot be upserted by identity and
   *   are reported as skipped.
   * - mode 'preview' computes the exact plan and writes nothing; 'apply'
   *   executes it. The client always previews first, but the server does not
   *   trust it to.
   */
  app.post(
    '/config-diff/apply',
    { preHandler: requireAdmin, bodyLimit: 128 * 1024 * 1024 },
    async (req, reply) => {
      const body = req.body as {
        snapshot?: ConfigSnapshot
        table?: string
        keys?: string[]
        mode?: 'preview' | 'apply'
      }
      const theirs = body?.snapshot
      const table = String(body?.table ?? '')
      const mode = body?.mode === 'apply' ? 'apply' : 'preview'
      if (!theirs || typeof theirs !== 'object' || !theirs.tables || theirs.format !== 1) {
        return reply.code(400).send({ error: 'Body must carry a format-1 config snapshot' })
      }
      if (!/^nivaro_[a-z0-9_]+$/i.test(table)) {
        return reply.code(400).send({ error: 'table must be a nivaro_* table name' })
      }
      const theirRows = theirs.tables[table]
      if (!theirRows) {
        return reply.code(400).send({ error: `The snapshot does not carry ${table}` })
      }
      const presentRows = (await db.raw(
        `SELECT name FROM sys.tables WHERE name LIKE 'nivaro[_]%'`
      )) as Array<{ name: string }>
      const classification = classifyTables(presentRows.map((r) => r.name))
      if (!classification.config.includes(table)) {
        return reply
          .code(400)
          .send({ error: `${table} is not a CONFIG table on this instance — only config applies` })
      }

      // Live side, same redaction/hashing as the snapshot so comparison is honest.
      const mine = await buildConfigSnapshot({
        tables: [table],
        version: NIVARO_VERSION,
        environment: config.NODE_ENV
      })
      const mineRows = mine.tables[table] ?? {}

      const scope =
        Array.isArray(body?.keys) && body.keys.length > 0 ? new Set(body.keys.map(String)) : null
      const inserts: string[] = []
      const updates: string[] = []
      const skippedKeyless: string[] = []
      for (const [key, row] of Object.entries(theirRows)) {
        if (scope && !scope.has(key)) continue
        if (key.startsWith('#')) {
          skippedKeyless.push(key)
          continue
        }
        const current = mineRows[key]
        if (!current) inserts.push(key)
        else if (current.hash !== row.hash) updates.push(key)
      }

      const CAP = 5000
      const planned = inserts.length + updates.length
      if (planned > CAP) {
        return reply.code(400).send({
          error: `${planned} rows planned — the per-apply cap is ${CAP}. Scope with keys[].`
        })
      }

      if (mode === 'preview') {
        return reply.send({
          data: {
            table,
            inserts: inserts.length,
            updates: updates.length,
            unchanged: Object.keys(theirRows).length - planned - skippedKeyless.length,
            skipped_keyless: skippedKeyless.length,
            insert_keys: inserts.slice(0, 50),
            update_keys: updates.slice(0, 50)
          }
        })
      }

      // Live column set — snapshot keys are untrusted; only plain identifiers
      // that exist on the target table reach SQL (the promotion precedent).
      const colRows = (await db.raw(
        `SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE TABLE_NAME = ?`,
        [table]
      )) as Array<{ name: string }>
      const liveCols = new Set(colRows.map((c) => c.name))
      const identRe = /^[A-Za-z_][A-Za-z0-9_]*$/
      const identityRows = (await db.raw(
        `SELECT COLUMN_NAME AS name FROM information_schema.columns
         WHERE TABLE_NAME = ? AND COLUMNPROPERTY(OBJECT_ID(TABLE_NAME), COLUMN_NAME, 'IsIdentity') = 1`,
        [table]
      )) as Array<{ name: string }>
      const hasIdentity = identityRows.some((c) => c.name === 'id')

      const filterCols = (data: Record<string, unknown>) => {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(data)) {
          if (!identRe.test(k) || !liveCols.has(k)) continue
          out[k] = v
        }
        return out
      }

      let inserted = 0
      let updated = 0
      const errors: Array<{ key: string; error: string }> = []
      for (const key of updates) {
        try {
          const patch = filterCols(theirRows[key].data)
          delete patch.id
          if (Object.keys(patch).length === 0) continue
          await db(table).where('id', key).update(patch)
          updated++
        } catch (err) {
          errors.push({ key, error: err instanceof Error ? err.message.slice(0, 200) : 'failed' })
        }
      }
      for (const key of inserts) {
        try {
          const row = filterCols(theirRows[key].data)
          if (hasIdentity && row.id != null) {
            // IDENTITY_INSERT must live inside ONE batch (trash-restore precedent).
            const cols = Object.keys(row)
            await db.raw(
              `SET IDENTITY_INSERT [${table}] ON;
               INSERT INTO [${table}] (${cols.map((c) => `[${c}]`).join(', ')})
               VALUES (${cols.map(() => '?').join(', ')});
               SET IDENTITY_INSERT [${table}] OFF;`,
              cols.map((c) => {
                const v = row[c]
                return v !== null && typeof v === 'object' ? JSON.stringify(v) : (v as never)
              })
            )
          } else {
            await db(table).insert(row)
          }
          inserted++
        } catch (err) {
          errors.push({ key, error: err instanceof Error ? err.message.slice(0, 200) : 'failed' })
        }
      }

      await logActivity({
        action: 'config-apply',
        user: req.user?.id,
        collection: table,
        comment: `applied from snapshot (${theirs.instance?.environment ?? '?'} ${theirs.instance?.version ?? ''}): ${inserted} inserted, ${updated} updated${errors.length ? `, ${errors.length} failed` : ''}`,
        req
      })
      return reply.send({
        data: { table, inserted, updated, skipped_keyless: skippedKeyless.length, errors }
      })
    }
  )
}
