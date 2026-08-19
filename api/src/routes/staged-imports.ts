import { createHash } from 'node:crypto'
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
import {
  parseStagingColumns,
  parseValidationConfig,
  validateStagedRows
} from '../services/staged-import-validation.js'

/**
 * Staged imports (`/api/staged-imports`) — queue + definition registry for
 * file loads that land in a staging table and optionally run a procedure.
 *
 * Distinct from `/api/imports`, the generic CSV→items importer. These execute
 * deployment-configured SQL against shared staging tables, so queueing and
 * definition management are admin-only.
 */
/** Snapshot the whole definition (proc body + schema + validation together)
 *  so a bad edit is one click from undone. Content-deduped, pruned to 30. */
async function snapshotDefinition(key: string, note: string, userId: string | null): Promise<void> {
  try {
    const row = await db('nivaro_import_definitions').where({ key }).first()
    if (!row) return
    const snapshot = JSON.stringify(row)
    const latest = await db('nivaro_import_definition_versions')
      .where('definition', row.id)
      .orderBy('version', 'desc')
      .first()
    if (latest && latest.snapshot === snapshot) return
    await db('nivaro_import_definition_versions').insert({
      definition: row.id,
      version: (Number(latest?.version) || 0) + 1,
      snapshot,
      note: note.slice(0, 255),
      created_by: userId,
      created_at: new Date()
    })
    const versions = await db('nivaro_import_definition_versions')
      .where('definition', row.id)
      .orderBy('version', 'desc')
      .select('id')
    if (versions.length > 30) {
      await db('nivaro_import_definition_versions')
        .whereIn('id', versions.slice(30).map((v) => v.id))
        .del()
    }
  } catch {
    // Version capture must never block the edit it protects.
  }
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export async function stagedImportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // ─── Procedure management ─────────────────────────────────────────────────

  /** The LIVE body from SQL Server — for taking over an externally-managed
   *  procedure, or comparing against the stored one. */
  app.get<{ Params: { id: string } }>(
    '/definitions/:id/procedure',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = await db('nivaro_import_definitions').where('id', req.params.id).first()
      if (!row) return reply.code(404).send({ error: 'Not found' })
      if (!row.procedure || !IDENT_RE.test(String(row.procedure))) {
        return reply.code(400).send({ error: 'This definition has no procedure' })
      }
      const mod = (await db.raw(
        `SELECT m.definition FROM sys.sql_modules m WHERE m.object_id = OBJECT_ID(?)`,
        [String(row.procedure)]
      )) as Array<{ definition: string | null }>
      const live = Array.isArray(mod) && mod[0]?.definition ? String(mod[0].definition) : null
      return {
        data: {
          procedure: row.procedure,
          live_body: live,
          stored_body: row.procedure_body ?? null,
          deployed_hash: row.procedure_hash ?? null,
          stored_hash: row.procedure_body
            ? createHash('sha256').update(String(row.procedure_body)).digest('hex')
            : null
        }
      }
    }
  )

  /** Deploy the stored body via CREATE OR ALTER. Explicit — the worker never
   *  deploys DDL mid-run. The body must target the definition's own procedure
   *  so a deploy can't smuggle unrelated DDL under another name. */
  app.post<{ Params: { id: string } }>(
    '/definitions/:id/deploy',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = await db('nivaro_import_definitions').where('id', req.params.id).first()
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const body = String(row.procedure_body ?? '').trim()
      const proc = String(row.procedure ?? '')
      if (!body) return reply.code(400).send({ error: 'This definition has no stored procedure body' })
      if (!IDENT_RE.test(proc)) return reply.code(400).send({ error: 'Definition has no valid procedure name' })
      const targetsOwn = new RegExp(
        `create\\s+or\\s+alter\\s+proc(edure)?\\s+(\\[?dbo\\]?\\.)?\\[?${proc}\\]?\\b`,
        'i'
      )
      if (!targetsOwn.test(body)) {
        return reply.code(400).send({
          error: `The body must start with CREATE OR ALTER PROCEDURE ${proc} — deploys are scoped to this definition's own procedure.`
        })
      }
      try {
        await db.raw(body)
      } catch (err) {
        return reply.code(400).send({ error: `Deploy failed: ${(err as Error).message}` })
      }
      const hash = createHash('sha256').update(body).digest('hex')
      await db('nivaro_import_definitions')
        .where('id', row.id)
        .update({ procedure_hash: hash, procedure_deployed_at: new Date() })
      await logActivity({
        action: 'import-procedure-deploy',
        user: req.user?.id,
        collection: 'nivaro_import_definitions',
        item: String(row.key),
        comment: `CREATE OR ALTER ${proc}`,
        req
      })
      return { data: { deployed: true, hash } }
    }
  )

  // ─── Definition versions ──────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>(
    '/definitions/:id/versions',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = await db('nivaro_import_definitions').where('id', req.params.id).first()
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const versions = await db('nivaro_import_definition_versions')
        .where('definition', row.id)
        .orderBy('version', 'desc')
        .select('id', 'version', 'note', 'created_by', 'created_at')
      return { data: versions }
    }
  )

  app.post<{ Params: { id: string; versionId: string } }>(
    '/definitions/:id/versions/:versionId/restore',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = await db('nivaro_import_definitions').where('id', req.params.id).first()
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const v = await db('nivaro_import_definition_versions')
        .where({ definition: row.id, id: req.params.versionId })
        .first()
      if (!v) return reply.code(404).send({ error: 'Version not found' })
      let snap: Record<string, unknown>
      try {
        snap = JSON.parse(String(v.snapshot))
      } catch {
        return reply.code(400).send({ error: 'Snapshot is unreadable' })
      }
      // Restores are reversible: capture current state first.
      await snapshotDefinition(String(row.key), `before restore of v${v.version}`, req.user?.id ?? null)
      const patch: Record<string, unknown> = {}
      for (const f of [
        'label', 'description', 'staging_table', 'procedure', 'loader', 'sort',
        'is_active', 'staging_columns', 'validation', 'procedure_body'
      ]) {
        if (f in snap) patch[f] = snap[f]
      }
      await db('nivaro_import_definitions').where('id', row.id).update(patch)
      await logActivity({
        action: 'import-definition-restore',
        user: req.user?.id,
        collection: 'nivaro_import_definitions',
        item: String(row.key),
        comment: `restored v${v.version}`,
        req
      })
      return { data: await getImportDefinition(String(row.key)) }
    }
  )

  /** Regex-mine the LIVE procedure body for join/merge patterns and prefill a
   *  validation config for human review. An assistant, never the authority —
   *  the returned suggestion is not saved. */
  app.post<{ Params: { id: string } }>(
    '/definitions/:id/suggest-validation',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = await db('nivaro_import_definitions').where('id', req.params.id).first()
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const proc = String(row.procedure ?? '')
      if (!IDENT_RE.test(proc)) return reply.code(400).send({ error: 'Definition has no procedure to read' })
      const mod = (await db.raw(
        `SELECT m.definition FROM sys.sql_modules m WHERE m.object_id = OBJECT_ID(?)`,
        [proc]
      )) as Array<{ definition: string | null }>
      const body = Array.isArray(mod) && mod[0]?.definition ? String(mod[0].definition) : null
      if (!body) return reply.code(404).send({ error: `Procedure ${proc} not found in the database` })

      const stagingTable = String(row.staging_table || `staging_${row.key}`).toLowerCase()

      // Aliases assigned to the staging table (FROM/JOIN staging_x st).
      const stagingAliases = new Set<string>([stagingTable])
      for (const m of body.matchAll(/(?:from|join)\s+\[?(\w+)\]?\s+(?:as\s+)?(\w+)\b/gi)) {
        if (m[1].toLowerCase() === stagingTable) stagingAliases.add(m[2].toLowerCase())
      }

      // JOIN other ON other.col = st.col → lookup {column: st col, collection, match_field}
      const lookups: Array<{ column: string; collection: string; match_field: string }> = []
      const seen = new Set<string>()
      for (const m of body.matchAll(
        /join\s+\[?(\w+)\]?\s+(?:as\s+)?(\w+)\s+on\s+\[?(\w+)\]?\.\[?(\w+)\]?\s*=\s*\[?(\w+)\]?\.\[?(\w+)\]?/gi
      )) {
        const [, table, alias, leftA, leftC, rightA, rightC] = m
        if (table.toLowerCase() === stagingTable) continue
        let stagingCol: string | null = null
        let matchField: string | null = null
        if (stagingAliases.has(leftA.toLowerCase()) && rightA.toLowerCase() === alias.toLowerCase()) {
          stagingCol = leftC
          matchField = rightC
        } else if (stagingAliases.has(rightA.toLowerCase()) && leftA.toLowerCase() === alias.toLowerCase()) {
          stagingCol = rightC
          matchField = leftC
        }
        if (!stagingCol || !matchField) continue
        const k = `${stagingCol}|${table}|${matchField}`.toLowerCase()
        if (seen.has(k)) continue
        seen.add(k)
        if (!/^nivaro_/i.test(table)) {
          lookups.push({ column: stagingCol, collection: table, match_field: matchField })
        }
      }

      // Target table guess: the first INSERT INTO / MERGE (INTO) real table.
      // Bare UPDATE is skipped — MERGE's "WHEN MATCHED THEN UPDATE SET" makes
      // it match the keyword SET, and alias-form UPDATEs match aliases.
      const RESERVED = new Set(['set', 'statistics', 'target', 'source'])
      let target: string | null = null
      for (const m of body.matchAll(/(?:insert\s+into|merge\s+(?:into\s+)?)\s*\[?(\w+)\]?/gi)) {
        const t = m[1]
        const lower = t.toLowerCase()
        if (lower === stagingTable || stagingAliases.has(lower)) continue
        if (/^(#|@)/.test(t) || /^nivaro_/i.test(t) || RESERVED.has(lower)) continue
        target = t
        break
      }

      // Merge keys: pairs inside a MERGE ... ON (...) clause only — mining every
      // equality in the body reports plain join columns as identity, which is
      // worse than an empty suggestion the admin fills in.
      const keyCols = new Set<string>()
      // Both ON shapes appear in the real proc set: parenthesized `ON (...)` and
      // bare `ON a.x = b.x AND ...` running until the first WHEN clause.
      const onClauses = [
        ...body.matchAll(/merge[\s\S]{0,2500}?\bon\s*\(([\s\S]*?)\)/gi),
        ...body.matchAll(/merge[\s\S]{0,2500}?\bon\s+([\s\S]*?)\bwhen\b/gi)
      ]
      for (const on of onClauses) {
        for (const m of on[1].matchAll(/\[?(\w+)\]?\.\[?(\w+)\]?\s*=\s*\[?(\w+)\]?\.\[?(\w+)\]?/gi)) {
          const [, la, lc, ra, rc] = m
          if (stagingAliases.has(la.toLowerCase()) && !stagingAliases.has(ra.toLowerCase())) keyCols.add(lc)
          else if (stagingAliases.has(ra.toLowerCase()) && !stagingAliases.has(la.toLowerCase())) keyCols.add(rc)
          else if (la.toLowerCase() === 'source') keyCols.add(lc)
          else if (ra.toLowerCase() === 'source') keyCols.add(rc)
        }
      }

      return {
        data: {
          suggestion: {
            key_columns: [...keyCols].slice(0, 4),
            ...(target ? { target_table: target } : {}),
            lookups
          },
          procedure: proc,
          note: 'Regex-mined from the live procedure — review before saving; the config is the authority, not the procedure scan.'
        }
      }
    }
  )

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
    await snapshotDefinition(key, 'created', req.user?.id ?? null)
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
      // Config fields arrive as objects or JSON strings; both normalize to a
      // stored JSON string (or null to clear). Bad JSON is a 400, not a save.
      for (const f of ['staging_columns', 'validation'] as const) {
        if (b[f] === undefined) continue
        if (b[f] === null || b[f] === '') {
          patch[f] = null
          continue
        }
        const parsed =
          f === 'staging_columns' ? parseStagingColumns(b[f]) : parseValidationConfig(b[f])
        if (!parsed) return reply.code(400).send({ error: `${f} is not valid` })
        patch[f] = JSON.stringify(parsed)
      }
      if (b.procedure_body !== undefined) {
        patch.procedure_body =
          b.procedure_body === null || b.procedure_body === '' ? null : String(b.procedure_body)
      }
      if (b.is_active !== undefined) patch.is_active = !!b.is_active
      if (Object.keys(patch).length > 0) {
        await snapshotDefinition(String(row.key), 'before update', req.user?.id ?? null)
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

    // Pre-flight validation: file-keyed checks (duplicates, required, numeric,
    // declared-schema coverage) plus target/lookup checks against live tables.
    // The procedure never runs; a definition with no config reports clean.
    const validation = definition
      ? await validateStagedRows(definition, rows)
      : { errors: [], warnings: [], stats: {}, truncated: false }

    return {
      data: {
        row_count: rows.length,
        columns,
        rows: rows.slice(0, 20),
        file_name: multipart.filename,
        staging_table: table,
        staging_columns: stagingColumns,
        unknown_columns: stagingColumns ? columns.filter((c) => !stagingColumns.includes(c)) : [],
        missing_columns: stagingColumns ? stagingColumns.filter((c) => !columns.includes(c)) : [],
        validation
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

    const buffer = await multipart.toBuffer()

    // The preview's report is UX; THIS is the boundary. Hard errors are all
    // file-derived (missing declared columns, duplicate keys, bad values), so
    // blocking here can't strand an import on stale table state.
    try {
      const validation = await validateStagedRows(definition, parseImportFile(buffer))
      if (validation.errors.length > 0) {
        return reply.code(422).send({
          error: `That file fails validation: ${validation.errors.map((e) => e.message).join(' · ')}`,
          validation
        })
      }
    } catch {
      // The validator itself failing must never block the pipeline.
    }

    const stored = await uploadFileBuffer(
      req.user!,
      buffer,
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
