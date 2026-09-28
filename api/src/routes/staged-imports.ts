import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { parseServiceConfig, runServiceImport, type ServiceImportSummary } from '../services/staged-import-service.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { uploadFileBuffer } from '../services/files.js'
import {
  hasRunReports,
  parseRunReport,
  rebuildRunReport
} from '../services/import-run-report.js'
import { executeRevert, planRevert } from '../services/import-run-revert.js'
import {
  getImportProcessor,
  isProcessorKey,
  listImportProcessors,
  runImportProcessor
} from '../services/import-processors.js'
import {
  parseStagingColumns,
  parseValidationConfig,
  validateStagedRows
} from '../services/staged-import-validation.js'
import {
  getImportDefinition,
  listImportDefinitions,
  mapRowsToDeclared,
  parseImportFile,
  parsePostRunFlows
} from '../services/staged-imports.js'

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
        .whereIn(
          'id',
          versions.slice(30).map((v) => v.id)
        )
        .del()
    }
  } catch {
    // Version capture must never block the edit it protects.
  }
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `{enabled: boolean}` (object or JSON string); anything else = off. */
function parseReceipt(v: unknown): { enabled: boolean } | null {
  let o: unknown = v
  if (typeof v === 'string') {
    try {
      o = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!o || typeof o !== 'object') return null
  return { enabled: (o as { enabled?: unknown }).enabled === true }
}

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
      if (!body)
        return reply.code(400).send({ error: 'This definition has no stored procedure body' })
      if (!IDENT_RE.test(proc))
        return reply.code(400).send({ error: 'Definition has no valid procedure name' })
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
      await snapshotDefinition(
        String(row.key),
        `before restore of v${v.version}`,
        req.user?.id ?? null
      )
      const patch: Record<string, unknown> = {}
      for (const f of [
        'label',
        'description',
        'staging_table',
        'procedure',
        'loader',
        'sort',
        'is_active',
        'staging_columns',
        'validation',
        'procedure_body'
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
      if (!IDENT_RE.test(proc))
        return reply.code(400).send({ error: 'Definition has no procedure to read' })
      const mod = (await db.raw(
        `SELECT m.definition FROM sys.sql_modules m WHERE m.object_id = OBJECT_ID(?)`,
        [proc]
      )) as Array<{ definition: string | null }>
      const body = Array.isArray(mod) && mod[0]?.definition ? String(mod[0].definition) : null
      if (!body)
        return reply.code(404).send({ error: `Procedure ${proc} not found in the database` })

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
        if (
          stagingAliases.has(leftA.toLowerCase()) &&
          rightA.toLowerCase() === alias.toLowerCase()
        ) {
          stagingCol = leftC
          matchField = rightC
        } else if (
          stagingAliases.has(rightA.toLowerCase()) &&
          leftA.toLowerCase() === alias.toLowerCase()
        ) {
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
        for (const m of on[1].matchAll(
          /\[?(\w+)\]?\.\[?(\w+)\]?\s*=\s*\[?(\w+)\]?\.\[?(\w+)\]?/gi
        )) {
          const [, la, lc, ra, rc] = m
          if (stagingAliases.has(la.toLowerCase()) && !stagingAliases.has(ra.toLowerCase()))
            keyCols.add(lc)
          else if (stagingAliases.has(ra.toLowerCase()) && !stagingAliases.has(la.toLowerCase()))
            keyCols.add(rc)
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

  /** Processors registered by extensions on this instance. */
  app.get('/processors', { preHandler: requireAdmin }, async () => ({
    data: listImportProcessors()
  }))

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
      post_run_flows?: unknown
      receipt?: unknown
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
      is_active: true,
      post_run_flows:
        b.post_run_flows === undefined ? null : JSON.stringify(parsePostRunFlows(b.post_run_flows)),
      receipt:
        b.receipt === undefined
          ? null
          : (() => {
              const rc = parseReceipt(b.receipt)
              return rc ? JSON.stringify(rc) : null
            })()
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
      // Post-run flows: array (or JSON string) of flow ids; unknown/malformed
      // ids are dropped, an empty list clears the column.
      if (b.post_run_flows !== undefined) {
        const ids = parsePostRunFlows(b.post_run_flows)
        if (ids.length > 0) {
          const known = (await db('nivaro_flows').whereIn('id', ids).pluck('id')) as string[]
          const knownSet = new Set(known.map((k) => String(k).toUpperCase()))
          const missing = ids.filter((id) => !knownSet.has(id))
          if (missing.length > 0) {
            return reply.code(400).send({ error: `Unknown flow id(s): ${missing.join(', ')}` })
          }
        }
        patch.post_run_flows = ids.length > 0 ? JSON.stringify(ids) : null
      }
      if (b.procedure_body !== undefined) {
        patch.procedure_body =
          b.procedure_body === null || b.procedure_body === '' ? null : String(b.procedure_body)
      }
      // Post-run receipt (#25): { enabled } — OFF unless enabled.
      if (b.receipt !== undefined) {
        const rc = parseReceipt(b.receipt)
        patch.receipt = rc ? JSON.stringify(rc) : null
      }
      // Processor mode: null/'proc' = staging table + stored procedure,
      // 'service' = items-service writes (requires a valid service_config —
      // either already stored or arriving in the same PATCH).
      if (b.processor !== undefined) {
        const v =
          b.processor === null || b.processor === '' || b.processor === 'proc'
            ? null
            : String(b.processor)
        if (v !== null && v !== 'service') {
          // '<extension>:<name>' must be registered on THIS instance — a typo
          // would otherwise fall back to the procedure on every run.
          if (!isProcessorKey(v) || !getImportProcessor(v)) {
            const known = listImportProcessors().map((p) => p.key)
            return reply.code(400).send({
              error: `Unknown processor "${v}"${known.length ? ` — registered: ${known.join(', ')}` : ''}`
            })
          }
        }
        patch.processor = v
      }
      if (b.service_config !== undefined) {
        if (b.service_config === null || b.service_config === '') {
          patch.service_config = null
        } else {
          const parsed = parseServiceConfig(b.service_config)
          if (!parsed) return reply.code(400).send({ error: 'service_config is not valid' })
          patch.service_config = JSON.stringify(parsed)
        }
      }
      const effProcessor = patch.processor !== undefined ? patch.processor : row.processor
      const effServiceConfig =
        patch.service_config !== undefined ? patch.service_config : row.service_config
      if (effProcessor === 'service' && !parseServiceConfig(effServiceConfig)) {
        return reply.code(400).send({
          error:
            'Processor "service" requires a valid service_config (collection, match_by, columns)'
        })
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
    'q.ran_via',
    'q.reverted_at',
    'd.label as definition_label',
    'd.staging_table',
    'd.procedure',
    'd.processor',
    'd.loader',
    'd.is_active as definition_active',
    'f.filename_download as file_name',
    'f.filesize as file_size',
    'u.first_name as created_by_first_name',
    'u.last_name as created_by_last_name',
    'u.email as created_by_email'
  ]

  function runQuery() {
    return (
      db('nivaro_import_queue as q')
        // Join on the denormalised key, never the definition FK: rows carried
        // over from the legacy queue hold ids from the OLD definitions table's
        // id space, so the id join labelled runs with the wrong import.
        .leftJoin('nivaro_import_definitions as d', 'd.key', 'q.import_key')
        .leftJoin('nivaro_files as f', 'f.id', 'q.file')
        .leftJoin('nivaro_users as u', 'u.id', 'q.created_by')
    )
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
    const days = Math.max(
      0,
      Math.min(Number((req.query as { days?: string }).days ?? 30) || 0, 3650)
    )
    const since = days > 0 ? new Date(Date.now() - days * 86_400_000) : null
    const inWindow = (qb: Knex.QueryBuilder) => {
      if (since) qb.where('created_at', '>=', since)
    }

    const [byStatus, totals, durations, running, startOfToday, allTime, byKey] = await Promise.all([
      db('nivaro_import_queue')
        .modify(inWindow)
        .select('status')
        .count({ c: '*' })
        .groupBy('status'),
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
          (byKey as Array<{ import_key: string; c: number }>).map((r) => [
            r.import_key,
            Number(r.c)
          ])
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
    const row = await runQuery()
      .select([...RUN_COLUMNS, 'q.report'])
      .where('q.id', req.params.id)
      .first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return { data: { ...row, report: parseRunReport(row.report) } }
  })

  // ─── What a run did ───────────────────────────────────────────────────────

  /** Collections of this run's items the caller may read. Admins: all. */
  async function readableCollections(
    runId: number,
    req: { user?: unknown; isAdmin?: boolean }
  ): Promise<{ all: boolean; names: string[] }> {
    if (req.isAdmin) return { all: true, names: [] }
    const { can } = await import('../services/permissions.js')
    const rows = (await db('nivaro_import_run_items')
      .where('run', runId)
      .whereNotNull('collection')
      .distinct('collection')) as Array<{ collection: string }>
    const names: string[] = []
    for (const r of rows) {
      if (await can(req.user as never, 'read', String(r.collection))) names.push(String(r.collection))
    }
    return { all: false, names }
  }

  const ITEM_KINDS = new Set(['created', 'updated', 'skipped', 'failed'])

  function itemsQuery(
    runId: number,
    q: { kind?: string; collection?: string; search?: string; reverted?: string },
    access: { all: boolean; names: string[] }
  ) {
    const kinds = String(q.kind ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter((k) => ITEM_KINDS.has(k))
    return db('nivaro_import_run_items')
      .where('run', runId)
      .modify((qb) => {
        if (kinds.length) qb.whereIn('kind', kinds)
        if (q.collection) qb.where('collection', q.collection)
        if (q.reverted === '1') qb.whereNotNull('reverted_at')
        // Rows the run left out quote the file; only records the caller may
        // read are shown to anyone but an admin.
        if (!access.all) qb.whereIn('collection', access.names.length ? access.names : ['__none__'])
        const term = String(q.search ?? '').trim()
        if (term) {
          const like = `%${term.replace(/[\\%_[]/g, (m) => `\\${m}`)}%`
          qb.where((b) =>
            b
              .whereRaw("label LIKE ? ESCAPE '\\'", [like])
              .orWhereRaw("item_id LIKE ? ESCAPE '\\'", [like])
              .orWhereRaw("message LIKE ? ESCAPE '\\'", [like])
              .orWhereRaw("changes LIKE ? ESCAPE '\\'", [like])
          )
        }
      })
  }

  type StoredItem = {
    id: number
    kind: string
    collection: string | null
    item_id: string | null
    label: string | null
    file_row: number | null
    message: string | null
    changes: string | null
    reverted_at: Date | null
    revert_note: string | null
  }

  /** Field names become labels and relation ids become the names people use. */
  async function presentItems(rows: StoredItem[]) {
    const { labelledChanges } = await import('../services/mail-types.js')
    const { getLabels } = await import('../services/queues.js')
    const cache = new Map()
    const want = new Map<string, Set<string>>()
    for (const r of rows) {
      if (!r.collection || !r.item_id || (r.label ?? '').trim()) continue
      want.set(r.collection, (want.get(r.collection) ?? new Set<string>()).add(String(r.item_id)))
    }
    const names = want.size ? await getLabels(want).catch(() => ({}) as Record<string, string>) : {}
    return Promise.all(
      rows.map(async (r) => {
        let raw: Array<{ field: string; from?: unknown; to: unknown }> = []
        try {
          raw = r.changes ? JSON.parse(r.changes) : []
        } catch {
          raw = []
        }
        const delta: Record<string, unknown> = {}
        const previous: Record<string, unknown> = {}
        for (const c of raw) {
          delta[c.field] = c.to
          if (c.from !== undefined) previous[c.field] = c.from
        }
        const labelled = r.collection
          ? await labelledChanges(r.collection, delta, previous, 60, cache).catch(() => [])
          : []
        const byField = new Map(labelled.map((l) => [l.field, l]))
        return {
          id: Number(r.id),
          kind: r.kind,
          collection: r.collection,
          item_id: r.item_id,
          label:
            (r.label ?? '').trim() ||
            (r.collection && r.item_id ? names[`${r.collection}:${r.item_id}`] : '') ||
            (r.item_id ? `#${r.item_id}` : 'File row'),
          row: r.file_row,
          message: r.message,
          reverted_at: r.reverted_at,
          revert_note: r.revert_note,
          changes: raw.map((c) => {
            const l = byField.get(c.field)
            return {
              field: c.field,
              label: l?.label ?? c.field,
              from: c.from === undefined ? null : (l?.old ?? String(c.from ?? '')),
              to: l?.new ?? String(c.to ?? ''),
              from_known: c.from !== undefined
            }
          })
        }
      })
    )
  }

  app.get<{ Params: { id: string } }>('/:id/items', async (req, reply) => {
    if (!(await hasRunReports())) return { data: [], total: 0, page: 1, limit: 50, facets: {} }
    const runId = Number(req.params.id)
    if (!Number.isInteger(runId)) return reply.code(400).send({ error: 'Bad run id' })
    const q = req.query as {
      kind?: string
      collection?: string
      search?: string
      reverted?: string
      page?: string
      limit?: string
    }
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200)
    const page = Math.max(1, Number(q.page ?? 1) || 1)
    const access = await readableCollections(runId, req)

    const [rows, counted, facets] = await Promise.all([
      itemsQuery(runId, q, access)
        .orderBy('id', 'asc')
        .offset((page - 1) * limit)
        .limit(limit)
        .select(
          'id',
          'kind',
          'collection',
          'item_id',
          'label',
          'file_row',
          'message',
          'changes',
          'reverted_at',
          'revert_note'
        ) as Promise<StoredItem[]>,
      itemsQuery(runId, q, access).count({ c: '*' }).first(),
      // Facets ignore the kind / collection filter, so choosing one never
      // hides the alternatives.
      itemsQuery(runId, { search: q.search }, access)
        .select('kind', 'collection')
        .count({ c: '*' })
        .groupBy('kind', 'collection') as Promise<
        Array<{ kind: string; collection: string | null; c: number }>
      >
    ])
    const byKind: Record<string, number> = {}
    const byCollection: Record<string, number> = {}
    for (const f of facets) {
      byKind[f.kind] = (byKind[f.kind] ?? 0) + Number(f.c)
      if (f.collection) byCollection[f.collection] = (byCollection[f.collection] ?? 0) + Number(f.c)
    }
    return {
      data: await presentItems(rows),
      total: Number(counted?.c ?? 0),
      page,
      limit,
      facets: { kind: byKind, collection: byCollection }
    }
  })

  const csvCell = (v: unknown) => {
    const s = v == null ? '' : String(v)
    // A cell that starts like a formula is text, not a formula.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }

  /** The run's items as a sheet: one line per changed field. */
  app.get<{ Params: { id: string } }>(
    '/:id/items.csv',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const runId = Number(req.params.id)
      if (!Number.isInteger(runId)) return reply.code(400).send({ error: 'Bad run id' })
      const q = req.query as { kind?: string; collection?: string; search?: string }
      const rows = (await itemsQuery(runId, q, { all: true, names: [] })
        .orderBy('id', 'asc')
        .limit(50_000)
        .select(
          'id',
          'kind',
          'collection',
          'item_id',
          'label',
          'file_row',
          'message',
          'changes',
          'reverted_at',
          'revert_note'
        )) as StoredItem[]
      const out: string[] = [
        ['what happened', 'record', 'collection', 'record id', 'file row', 'field', 'before', 'after', 'note']
          .map(csvCell)
          .join(',')
      ]
      for (let i = 0; i < rows.length; i += 500) {
        for (const it of await presentItems(rows.slice(i, i + 500))) {
          const head = [it.kind, it.label, it.collection, it.item_id, it.row]
          if (it.changes.length === 0) {
            out.push([...head, '', '', '', it.message ?? it.revert_note ?? ''].map(csvCell).join(','))
            continue
          }
          for (const c of it.changes) {
            out.push(
              [...head, c.label, c.from_known ? c.from : '(not kept)', c.to, it.message ?? it.revert_note ?? '']
                .map(csvCell)
                .join(',')
            )
          }
        }
      }
      await logActivity({
        action: 'import-run-export',
        user: req.user?.id,
        collection: 'nivaro_import_queue',
        item: String(runId),
        comment: `${rows.length} item(s)${q.kind ? ` · ${q.kind}` : ''}`,
        req
      })
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="import-run-${runId}${q.kind ? `-${q.kind}` : ''}.csv"`)
        .send(`\uFEFF${out.join('\r\n')}`)
    }
  )

  /** Reference values in the file that matched nothing, as a sheet. */
  app.get<{ Params: { id: string } }>(
    '/:id/unmatched.csv',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = await db('nivaro_import_queue').where('id', req.params.id).select('report').first()
      const report = parseRunReport(row?.report)
      if (!report) return reply.code(404).send({ error: 'This run kept no report' })
      const out = [['column', 'value in the file', 'what the import did'].map(csvCell).join(',')]
      for (const u of report.unmatched) {
        for (const v of u.values) out.push([u.label, v, u.effect].map(csvCell).join(','))
      }
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="import-run-${req.params.id}-unmatched.csv"`)
        .send(`\uFEFF${out.join('\r\n')}`)
    }
  )

  /** Read the run's items back from the changes it recorded. */
  app.post<{ Params: { id: string } }>(
    '/:id/report/rebuild',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const runId = Number(req.params.id)
      const row = await db('nivaro_import_queue').where('id', runId).select('id', 'report').first()
      if (!row) return reply.code(404).send({ error: 'Not found' })
      if (parseRunReport(row.report)?.phases?.length) {
        return reply.code(409).send({ error: 'This run already has its own report' })
      }
      const out = await rebuildRunReport(runId)
      if (!out) return reply.code(409).send({ error: 'Run reports are not available on this database yet' })
      if (out.items === 0) {
        return reply.code(404).send({
          error:
            'This run left no recorded changes. A run of a stored procedure writes outside the items service, so there is nothing to read back.'
        })
      }
      return { data: out }
    }
  )

  // ─── Reverting ────────────────────────────────────────────────────────────

  const revertSummary = (plan: Awaited<ReturnType<typeof planRevert>>) => ({
    run: plan.run,
    total: plan.total,
    remove: plan.remove,
    restore: plan.restore,
    partly: plan.partly,
    left_alone: plan.left_alone,
    already_reverted: plan.already_reverted,
    not_applicable: plan.not_applicable,
    // what stays, and why — the part worth reading before confirming
    left: plan.items
      .filter((i) => ['changed-since', 'gone', 'nothing-recorded', 'partly'].includes(i.verdict))
      .slice(0, 50)
      .map((i) => ({ id: i.id, label: i.label, collection: i.collection, item_id: i.item_id, note: i.note }))
  })

  /** What a revert would do. Writes nothing. */
  app.post<{ Params: { id: string } }>(
    '/:id/revert/preview',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const runId = Number(req.params.id)
      if (!Number.isInteger(runId)) return reply.code(400).send({ error: 'Bad run id' })
      if (!(await hasRunReports())) return reply.code(409).send({ error: 'Run reports are not available on this database yet' })
      const ids = Array.isArray((req.body as { item_ids?: unknown })?.item_ids)
        ? ((req.body as { item_ids: unknown[] }).item_ids.map(Number).filter(Number.isInteger) as number[])
        : undefined
      return { data: revertSummary(await planRevert(runId, ids)) }
    }
  )

  app.post<{ Params: { id: string } }>(
    '/:id/revert',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const runId = Number(req.params.id)
      if (!Number.isInteger(runId)) return reply.code(400).send({ error: 'Bad run id' })
      if (!(await hasRunReports())) return reply.code(409).send({ error: 'Run reports are not available on this database yet' })
      const run = await runQuery().select(RUN_COLUMNS).where('q.id', runId).first()
      if (!run) return reply.code(404).send({ error: 'Not found' })
      if (run.status === 'running' || run.status === 'queued') {
        return reply.code(409).send({ error: 'That import has not finished' })
      }
      const ids = Array.isArray((req.body as { item_ids?: unknown })?.item_ids)
        ? ((req.body as { item_ids: unknown[] }).item_ids.map(Number).filter(Number.isInteger) as number[])
        : undefined
      const plan = await planRevert(runId, ids)
      const work = plan.remove + plan.restore + plan.partly
      if (work === 0) {
        return reply.code(409).send({
          error: 'Nothing can be reverted: every record was already reverted, changed again since the import, or kept no earlier values.',
          data: revertSummary(plan)
        })
      }
      const user = req.user!
      const label = String(run.definition_label || run.import_key)
      await logActivity({
        action: 'import-revert',
        user: user.id,
        collection: 'nivaro_import_queue',
        item: String(runId),
        comment: `${ids ? `${ids.length} selected record(s)` : 'whole run'}: ${plan.remove} to remove, ${plan.restore + plan.partly} to restore, ${plan.left_alone} left alone`,
        req
      })
      const finish = async (o: Awaited<ReturnType<typeof executeRevert>>) => {
        await db('nivaro_import_queue')
          .where('id', runId)
          .update({ reverted_at: new Date(), reverted_by: user.id, updated_at: new Date() })
        return `${o.removed} removed, ${o.restored} restored, ${o.left_alone} left alone${o.failed ? `, ${o.failed} failed` : ''}`
      }
      // A handful lands inside the request; a whole run is a background job.
      if (work <= 25) {
        const outcome = await executeRevert(plan, { user, label })
        await finish(outcome)
        return { data: { done: true, ...outcome } }
      }
      const { startJobRun } = await import('../services/job-runs.js')
      const { isCancelled, clearCancel } = await import('../services/job-cancel.js')
      const job = await startJobRun('bulk', `import-revert:${runId}`, {
        label: `Revert ${label} import #${runId}`,
        triggeredBy: user.id
      })
      void (async () => {
        try {
          const outcome = await executeRevert(plan, {
            user,
            label,
            onProgress: (done, total) => job.progress({ done, total }),
            cancelled: () => job.id != null && isCancelled(job.id)
          })
          if (job.id != null) clearCancel(job.id)
          const summary = await finish(outcome)
          if (outcome.failed > 0 && outcome.removed + outcome.restored === 0) await job.fail(summary)
          else await job.complete(summary)
        } catch (err) {
          await job.fail(err)
        }
      })()
      return reply.code(202).send({ data: { done: false, job_run_id: job.id, queued: work } })
    }
  )

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
    if (key && !definition)
      return reply.code(400).send({ error: `No import definition for "${key}"` })

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

    // Service-mode definitions can say EXACTLY what a run would do — the same
    // code path as the worker with nothing written: creates, field-level
    // updates, unchanged, and every skipped row with the reason that dropped it.
    let dryRun: ServiceImportSummary | null = null
    if (definition?.processor === 'service') {
      const cfg = parseServiceConfig(definition.service_config)
      if (cfg) {
        try {
          dryRun = await runServiceImport({
            config: cfg,
            rows: mapRowsToDeclared(definition, rows),
            createdBy: req.user?.id ?? null,
            dryRun: true
          })
        } catch (err) {
          dryRun = { created: 0, updated: 0, unchanged: 0, skipped: {}, failed: 1, log: `Dry run failed: ${(err as Error).message}` }
        }
      }
    }

    // A registered processor answers the same question for files that span
    // several collections.
    const processor = getImportProcessor(definition?.processor)
    if (definition && processor) {
      try {
        const r = await runImportProcessor({
          processor,
          definition,
          rows: mapRowsToDeclared(definition, rows),
          createdBy: req.user?.id ?? null,
          dryRun: true
        })
        dryRun = {
          created: r.created,
          updated: r.updated,
          unchanged: r.unchanged,
          skipped: r.skipped,
          failed: r.failed,
          log: r.log,
          samples: r.samples
        }
      } catch (err) {
        dryRun = { created: 0, updated: 0, unchanged: 0, skipped: {}, failed: 1, log: `Dry run failed: ${(err as Error).message}` }
      }
    }

    // A declared schema decides which columns load, and the validation report
    // above already names what the file lacks or carries beyond it. Comparing
    // the file with the physical staging table as well would report columns
    // nothing reads (left there by older files) as missing.
    const declaredSchema = definition ? parseStagingColumns(definition.staging_columns) : null
    const compareWithTable = !!stagingColumns && !declaredSchema

    return {
      data: {
        row_count: rows.length,
        columns,
        rows: rows.slice(0, 20),
        file_name: multipart.filename,
        staging_table: table,
        staging_columns: stagingColumns,
        unknown_columns:
          compareWithTable && stagingColumns ? columns.filter((c) => !stagingColumns.includes(c)) : [],
        missing_columns:
          compareWithTable && stagingColumns ? stagingColumns.filter((c) => !columns.includes(c)) : [],
        validation,
        dry_run: dryRun
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

    const stored = await uploadFileBuffer(req.user!, buffer, multipart.filename, multipart.mimetype)

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
