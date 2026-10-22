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
import { markConfigRead } from '../services/config-live.js'
import {
  afterConfigWrite,
  applyRestore,
  applyTablePlans,
  loadForeignKeys,
  loadLiveColumns,
  planTable,
  previewRestore,
  RESTORE_EXCLUDED,
  RestoreError,
  RestoreOpError
} from '../services/config-restore.js'
import {
  diffSinceSnapshot,
  listConfigSnapshots,
  snapshotAtOrBefore,
  takeConfigSnapshot
} from '../services/config-snapshots.js'
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
/** Identity and credential tables an uploaded snapshot never writes. */
const CREDENTIAL_TABLES = new Set(['nivaro_users', 'nivaro_sso_providers'])

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

  // #523 — the stored nightly snapshots and "what drifted since".
  app.get('/config-diff/history', { preHandler: requireAdmin }, async () => ({
    data: await listConfigSnapshots()
  }))
  /**
   * Store a snapshot now. Body (optional): `{ trigger: 'manual' | 'pre-deploy', version?, note? }`.
   * The deploy script sends `{ trigger: 'pre-deploy', version: '<new version>' }` before it rolls
   * the stack (#2803). 'cron', 'pre-migration' and 'pre-restore' are taken by the server itself.
   */
  app.post('/config-diff/history', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { trigger?: unknown; version?: unknown; note?: unknown }
    const trigger = body.trigger == null || body.trigger === '' ? 'manual' : body.trigger
    if (trigger !== 'manual' && trigger !== 'pre-deploy') {
      return reply.code(400).send({ error: "trigger must be 'manual' or 'pre-deploy'" })
    }
    const version = body.version == null || body.version === '' ? null : body.version
    if (version !== null && (typeof version !== 'string' || !/^[\w.+-]{1,40}$/.test(version))) {
      return reply.code(400).send({ error: 'version must be up to 40 letters, digits or . _ + -' })
    }
    if (body.note != null && typeof body.note !== 'string') {
      return reply.code(400).send({ error: 'note must be text' })
    }
    const extra = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : ''
    const note =
      trigger === 'pre-deploy'
        ? [`Before deploying ${version ?? 'a new version'}`, extra].filter(Boolean).join(' — ')
        : extra || null
    const meta = await takeConfigSnapshot(trigger, {
      userId: req.user?.id ?? null,
      note,
      targetVersion: version
    })
    if (!note) {
      await logActivity({
        action: 'config-snapshot-store',
        user: req.user?.id ?? null,
        collection: 'nivaro_config_snapshots',
        item: String(meta.id),
        req
      })
    }
    return { data: meta }
  })

  /**
   * #2803 — restore config to a stored snapshot. Body `{ mode: 'preview' | 'apply',
   * plan_hash?, tables? }`. Preview writes nothing and returns per-table insert/update/delete
   * counts, row diffs and a plan hash; apply needs that hash and answers 409 STALE with a fresh
   * preview when live config moved since. Before writing, a 'pre-restore' snapshot of the
   * touched tables is stored — restoring it undoes the restore.
   */
  app.post('/config-diff/history/:id/restore', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Bad snapshot id' })
    const body = (req.body ?? {}) as { mode?: unknown; plan_hash?: unknown; tables?: unknown }
    const mode = body.mode === 'apply' ? 'apply' : body.mode === 'preview' ? 'preview' : null
    if (!mode) return reply.code(400).send({ error: "mode must be 'preview' or 'apply'" })
    let tables: string[] | null = null
    if (body.tables != null) {
      if (
        !Array.isArray(body.tables) ||
        body.tables.length > 500 ||
        !body.tables.every((t) => typeof t === 'string' && /^nivaro_[a-z0-9_]+$/i.test(t))
      ) {
        return reply.code(400).send({ error: 'tables must be a list of nivaro_* table names' })
      }
      tables = body.tables as string[]
    }
    try {
      if (mode === 'preview') {
        markConfigRead(req)
        return { data: await previewRestore(id, tables) }
      }
      const hash = String(body.plan_hash ?? '')
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        return reply.code(400).send({ error: 'plan_hash from the preview is required' })
      }
      const result = await applyRestore(id, {
        planHash: hash,
        tables,
        userId: req.user?.id ?? null,
        req
      })
      return { data: result }
    } catch (err) {
      if (err instanceof RestoreError) {
        return reply.code(err.status).send({ error: err.message, code: err.code, ...err.extra })
      }
      throw err
    }
  })
  app.get('/config-diff/since', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { id?: string; at?: string }
    let id = q.id ? Number(q.id) : null
    if (!id) {
      const at = q.at ? new Date(q.at) : new Date(Date.now() - 7 * 86_400_000)
      if (Number.isNaN(at.getTime())) return reply.code(400).send({ error: 'at must be a date' })
      id = await snapshotAtOrBefore(at)
    }
    if (!id)
      return reply.code(404).send({
        error: 'No stored snapshot yet — the nightly job stores one at 04:40, or store one now.'
      })
    const d = await diffSinceSnapshot(id)
    if (!d) return reply.code(404).send({ error: 'Snapshot not found' })
    return { data: d }
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
   * - The engine is services/config-restore.ts (shared with the stored-snapshot
   *   restore); the table applies in one transaction — all of it or none.
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
      if (CREDENTIAL_TABLES.has(table)) {
        return reply.code(400).send({ error: `${table}: ${RESTORE_EXCLUDED[table]}` })
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
      const columns = await loadLiveColumns([table])
      const plan = planTable(
        table,
        theirRows,
        mine.tables[table] ?? {},
        columns.get(table) ?? new Map(),
        {
          deletes: false,
          keys: Array.isArray(body?.keys) ? new Set(body.keys.map(String)) : null
        }
      )
      const inserts = plan.ops.filter((o) => o.op === 'insert').map((o) => o.key)
      const updates = plan.ops.filter((o) => o.op === 'update').map((o) => o.key)

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
            unchanged: plan.unchanged,
            skipped_keyless: plan.skipped_keyless,
            insert_keys: inserts.slice(0, 50),
            update_keys: updates.slice(0, 50)
          }
        })
      }

      // One transaction for the table (#2803): a failing row rolls the table back instead of
      // leaving half of it applied.
      let inserted = 0
      let updated = 0
      const errors: Array<{ key: string; error: string }> = []
      if (planned > 0) {
        try {
          const fks = await loadForeignKeys()
          const [counts] = await db.transaction((trx) =>
            applyTablePlans(trx, [plan], theirs.tables, mine.tables, columns, fks)
          )
          inserted = counts?.inserted ?? 0
          updated = counts?.updated ?? 0
          await afterConfigWrite([table])
        } catch (err) {
          errors.push({
            key: err instanceof RestoreOpError ? err.key : '',
            error: err instanceof Error ? err.message.slice(0, 300) : 'failed'
          })
        }
      }

      await logActivity({
        action: 'config-apply',
        user: req.user?.id,
        collection: table,
        comment: `applied from snapshot (${theirs.instance?.environment ?? '?'} ${theirs.instance?.version ?? ''}): ${inserted} inserted, ${updated} updated${errors.length ? ' — failed, rolled back' : ''}`,
        req
      })
      return reply.send({
        data: {
          table,
          inserted,
          updated,
          skipped_keyless: plan.skipped_keyless,
          errors,
          rolled_back: errors.length > 0
        }
      })
    }
  )
}
