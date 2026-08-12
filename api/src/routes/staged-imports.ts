import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { uploadFileBuffer } from '../services/files.js'
import {
  getImportDefinition,
  listImportDefinitions,
  parseImportFile
} from '../services/staged-imports.js'

/**
 * Staged imports (`/api/staged-imports`) — queue + definition registry for
 * file loads that land in a staging table and optionally run a procedure.
 *
 * Distinct from `/api/imports`, the generic CSV→items importer. These execute
 * deployment-configured SQL against shared staging tables, so queueing and
 * definition management are admin-only.
 */
export async function stagedImportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // ─── Definitions ──────────────────────────────────────────────────────────

  app.get('/definitions', async (req) => {
    const all = (req.query as { all?: string })?.all === 'true'
    return { data: await listImportDefinitions(!all) }
  })

  app.post('/definitions', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body as {
      key?: string
      label?: string
      description?: string
      staging_table?: string
      procedure?: string
      loader?: 'bulk' | 'insert'
      sort?: number
    }
    const key = String(b.key ?? '').trim()
    if (!key) return reply.code(400).send({ error: 'key is required' })
    if (await getImportDefinition(key)) {
      return reply.code(409).send({ error: `An import named "${key}" already exists` })
    }
    await db('nivaro_import_definitions').insert({
      key,
      label: b.label ?? null,
      description: b.description ?? null,
      staging_table: b.staging_table ?? null,
      procedure: b.procedure ?? null,
      loader: b.loader ?? null,
      sort: Number(b.sort ?? 0),
      is_active: true
    })
    await logActivity({
      action: 'import-definition-create',
      user: req.user?.id,
      collection: 'nivaro_import_definitions',
      item: key,
      req
    })
    return reply.code(201).send({ data: await getImportDefinition(key) })
  })

  app.patch<{ Params: { id: string } }>(
    '/definitions/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = await db('nivaro_import_definitions').where('id', req.params.id).first()
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const b = req.body as Record<string, unknown>
      const patch: Record<string, unknown> = {}
      for (const f of ['label', 'description', 'staging_table', 'procedure', 'loader', 'sort']) {
        if (b[f] !== undefined) patch[f] = b[f]
      }
      if (b.is_active !== undefined) patch.is_active = !!b.is_active
      if (Object.keys(patch).length > 0) {
        await db('nivaro_import_definitions').where('id', row.id).update(patch)
      }
      await logActivity({
        action: 'import-definition-update',
        user: req.user?.id,
        collection: 'nivaro_import_definitions',
        item: String(row.key),
        req
      })
      return { data: await getImportDefinition(String(row.key)) }
    }
  )

  // ─── Queue ────────────────────────────────────────────────────────────────

  /** A run row carries what an operator needs to read it without a second
   *  lookup: the file's original name, who queued it, and the definition's
   *  target table + procedure — i.e. what this run actually ran. */
  const RUN_COLUMNS = [
    'q.id',
    'q.definition',
    'q.import_key',
    'q.status',
    'q.sort',
    'q.file',
    'q.row_count',
    'q.duration',
    'q.logs',
    'q.started_at',
    'q.finished_at',
    'q.created_by',
    'q.created_at',
    'q.updated_at',
    'q.legacy_id',
    'd.label as definition_label',
    'd.staging_table',
    'd.procedure',
    'd.loader',
    'd.is_active as definition_active',
    'f.filename_download as file_name',
    'f.filesize as file_size',
    'u.first_name as created_by_first_name',
    'u.last_name as created_by_last_name',
    'u.email as created_by_email'
  ]

  function runQuery() {
    return db('nivaro_import_queue as q')
      .leftJoin('nivaro_import_definitions as d', 'd.id', 'q.definition')
      .leftJoin('nivaro_files as f', 'f.id', 'q.file')
      .leftJoin('nivaro_users as u', 'u.id', 'q.created_by')
  }

  /** LIKE wildcards in a user's search string are literal characters, not
   *  operators — an unescaped `%` would silently match everything. */
  function likeTerm(raw: string): string {
    return `%${raw.replace(/[[\]%_]/g, (c) => `[${c}]`)}%`
  }

  function applyRunFilters(
    qb: Knex.QueryBuilder,
    q: { status?: string; key?: string; search?: string; days?: string }
  ) {
    // Same window the stats use, so the counts above a table always describe
    // the rows inside it. `days=0` (or absent) means all time.
    const days = Math.max(0, Math.min(Number(q.days ?? 0) || 0, 3650))
    if (days > 0) qb.where('q.created_at', '>=', new Date(Date.now() - days * 86_400_000))
    if (q.status) qb.whereIn('q.status', q.status.split(',').filter(Boolean))
    if (q.key) qb.where('q.import_key', q.key)
    const search = q.search?.trim()
    if (search) {
      const term = likeTerm(search)
      qb.where((w) => {
        w.where('q.import_key', 'like', term)
          .orWhere('d.label', 'like', term)
          .orWhere('f.filename_download', 'like', term)
          .orWhereRaw('CAST(q.id AS NVARCHAR(20)) LIKE ?', [term])
      })
    }
  }

  app.get('/', async (req) => {
    const q = req.query as {
      limit?: string
      page?: string
      status?: string
      key?: string
      search?: string
      days?: string
    }
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200)
    const page = Math.max(1, Number(q.page ?? 1) || 1)

    const rows = await runQuery()
      .select(RUN_COLUMNS)
      .modify((qb) => applyRunFilters(qb, q))
      .orderBy('q.id', 'desc')
      .offset((page - 1) * limit)
      .limit(limit)

    const counted = await runQuery()
      .modify((qb) => applyRunFilters(qb, q))
      .count({ c: 'q.id' })
      .first()

    return { data: rows, total: Number(counted?.c ?? 0), page, limit }
  })

  /**
   * Aggregates over the whole history, not the page the table happens to be
   * showing — a success rate computed from 50 visible rows is a different
   * number than the one an operator is actually asking for.
   *
   * `days=0` means all time. Medians are computed in JS rather than
   * PERCENTILE_CONT so this stays dialect-neutral; the input is one integer
   * column over a bounded window.
   */
  app.get('/stats', async (req) => {
    const days = Math.max(0, Math.min(Number((req.query as { days?: string }).days ?? 30) || 0, 3650))
    const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : null
    const inWindow = (qb: Knex.QueryBuilder) => {
      if (since) qb.where('created_at', '>=', since)
    }

    const [byStatus, totals, durations, running, startOfToday, allTime, byKey] = await Promise.all([
      db('nivaro_import_queue').modify(inWindow).select('status').count({ c: '*' }).groupBy('status'),
      db('nivaro_import_queue').modify(inWindow).sum({ rows: 'row_count' }).first(),
      db('nivaro_import_queue')
        .modify(inWindow)
        .whereNotNull('duration')
        .where('status', 'completed')
        .pluck('duration'),
      // Live queue depth is never windowed — a run queued weeks ago and still
      // waiting is exactly the thing an operator needs to see.
      db('nivaro_import_queue')
        .whereIn('status', ['queued', 'running'])
        .orderBy('status')
        .orderBy('sort')
        .orderBy('id')
        .select('id', 'import_key', 'status', 'started_at', 'created_at', 'row_count'),
      (() => {
        const d = new Date()
        d.setHours(0, 0, 0, 0)
        return db('nivaro_import_queue').where('created_at', '>=', d).count({ c: '*' }).first()
      })(),
      // Unwindowed, so the console can tell "nothing has ever run here" (teach
      // the feature) apart from "nothing ran in the last 30 days" (widen it).
      db('nivaro_import_queue').count({ c: '*' }).first(),
      // Also unwindowed: how often each import has ever run is a property of
      // the definition, not of whatever window the runs table is showing.
      db('nivaro_import_queue').select('import_key').count({ c: '*' }).groupBy('import_key')
    ])

    const counts: Record<string, number> = {}
    for (const r of byStatus as Array<{ status: string; c: number }>) {
      counts[r.status] = Number(r.c)
    }
    const sorted = (durations as number[]).slice().sort((a, b) => a - b)
    const median = sorted.length
      ? sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]
        : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
      : null

    const finished = (counts.completed ?? 0) + (counts.error ?? 0)
    return {
      data: {
        window_days: days,
        by_status: counts,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        all_time_total: Number(allTime?.c ?? 0),
        by_key: Object.fromEntries(
          (byKey as Array<{ import_key: string; c: number }>).map((r) => [r.import_key, Number(r.c)])
        ),
        rows_imported: Number(totals?.rows ?? 0),
        median_duration: median,
        success_rate: finished > 0 ? (counts.completed ?? 0) / finished : null,
        runs_today: Number(startOfToday?.c ?? 0),
        active: running
      }
    }
  })

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await runQuery().select(RUN_COLUMNS).where('q.id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return { data: row }
  })

  /**
   * Parse a file the way the worker will, without queueing anything.
   *
   * Uses the same `parseImportFile` (so the row cleaning and the derive-columns-
   * from-all-rows behaviour are the ones that will actually apply) and diffs the
   * result against the staging table's current shape. A file with the wrong
   * columns otherwise only surfaces minutes later, inside the procedure.
   */
  app.post('/preview', { preHandler: requireAdmin }, async (req, reply) => {
    const multipart = await req.file()
    if (!multipart) return reply.code(400).send({ error: 'A file upload is required' })

    const fields = multipart.fields as Record<string, { value?: unknown }> | undefined
    const key = String(fields?.import_key?.value ?? '').trim()
    const definition = key ? await getImportDefinition(key) : null
    if (key && !definition) return reply.code(400).send({ error: `No import definition for "${key}"` })

    let rows: Array<Record<string, string>>
    try {
      rows = parseImportFile(await multipart.toBuffer())
    } catch (err) {
      return reply
        .code(400)
        .send({ error: `That file could not be read: ${(err as Error).message}` })
    }
    if (rows.length === 0) {
      return reply.code(400).send({ error: 'That file contained no rows' })
    }

    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== 'id')

    // The staging table may not exist yet — the worker creates it on first run,
    // which is a valid state, not a problem to report.
    let stagingColumns: string[] | null = null
    const table = definition?.staging_table || (definition ? `staging_${definition.key}` : null)
    if (table && /^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      const existing = (await db('information_schema.columns')
        .where('table_name', table)
        .pluck('column_name')) as string[]
      if (existing.length > 0) stagingColumns = existing.filter((c) => c !== 'id')
    }

    return {
      data: {
        row_count: rows.length,
        columns,
        rows: rows.slice(0, 20),
        file_name: multipart.filename,
        staging_table: table,
        staging_columns: stagingColumns,
        unknown_columns: stagingColumns ? columns.filter((c) => !stagingColumns.includes(c)) : [],
        missing_columns: stagingColumns ? stagingColumns.filter((c) => !columns.includes(c)) : []
      }
    }
  })

  /** Upload a file and queue it. The worker picks it up within 10s. */
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const multipart = await req.file()
    if (!multipart) return reply.code(400).send({ error: 'A file upload is required' })

    const fields = multipart.fields as Record<string, { value?: unknown }> | undefined
    const key = String(fields?.import_key?.value ?? '').trim()
    if (!key) return reply.code(400).send({ error: 'import_key is required' })

    // Reject unknown/inactive imports here rather than failing the job minutes
    // later — the uploader is still on the page to correct it.
    const definition = await getImportDefinition(key)
    if (!definition) return reply.code(400).send({ error: `No import definition for "${key}"` })
    if (!definition.is_active) return reply.code(400).send({ error: `"${key}" is inactive` })

    const stored = await uploadFileBuffer(
      req.user!,
      await multipart.toBuffer(),
      multipart.filename,
      multipart.mimetype
    )

    const [inserted] = await db('nivaro_import_queue')
      .insert({
        definition: definition.id,
        import_key: key,
        status: 'queued',
        file: stored.id,
        sort: Number(fields?.sort?.value ?? 0),
        created_by: req.user?.id ?? null,
        created_at: new Date()
      })
      .returning('id')
    const id =
      typeof inserted === 'object' && inserted !== null
        ? (inserted as { id: number }).id
        : (inserted as number)

    await logActivity({
      action: 'import-queue',
      user: req.user?.id,
      collection: 'nivaro_import_queue',
      item: String(id),
      comment: `${key} (${multipart.filename})`,
      req
    })
    return reply.code(201).send({ data: { id, import_key: key, status: 'queued' } })
  })

  /** Re-queue a finished or failed run without re-uploading its file. */
  app.post<{ Params: { id: string } }>(
    '/:id/requeue',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = await db('nivaro_import_queue').where('id', req.params.id).first()
      if (!row) return reply.code(404).send({ error: 'Not found' })
      if (row.status === 'running') {
        return reply.code(409).send({ error: 'That import is currently running' })
      }
      if (!row.file) return reply.code(400).send({ error: 'That run has no file to re-import' })
      await db('nivaro_import_queue').where('id', row.id).update({
        status: 'queued',
        logs: null,
        started_at: null,
        finished_at: null,
        duration: null,
        updated_at: new Date()
      })
      await logActivity({
        action: 'import-requeue',
        user: req.user?.id,
        collection: 'nivaro_import_queue',
        item: String(row.id),
        req
      })
      return { data: { id: row.id, status: 'queued' } }
    }
  )

  /** Stop a run that hasn't started, or clear one wedged in `running`. */
  app.post<{ Params: { id: string } }>(
    '/:id/cancel',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = await db('nivaro_import_queue').where('id', req.params.id).first()
      if (!row) return reply.code(404).send({ error: 'Not found' })
      if (row.status === 'completed') {
        return reply.code(409).send({ error: 'That import already completed' })
      }
      await db('nivaro_import_queue')
        .where('id', row.id)
        .update({ status: 'canceled', finished_at: new Date(), updated_at: new Date() })
      await logActivity({
        action: 'import-cancel',
        user: req.user?.id,
        collection: 'nivaro_import_queue',
        item: String(row.id),
        req
      })
      return { data: { id: row.id, status: 'canceled' } }
    }
  )
}
