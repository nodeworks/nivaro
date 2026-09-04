import type { FastifyInstance, FastifyReply } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { resolveWorkspace } from '../middleware/workspace.js'
import { logActivity } from '../services/activity.js'
import {
  type AutoIdToken,
  autoIdFieldsFor,
  dbLookups,
  extractSuffix,
  parseAutoIdPattern,
  resolveAutoIdPattern,
  resolveAutoIdTokensDetailed,
  validateAutoIdPattern
} from '../services/auto-ids.js'
import {
  CollectionNotFoundError,
  createOne,
  deleteOne,
  ForbiddenError,
  readItems,
  readOne,
  updateOne
} from '../services/items.js'
import { can } from '../services/permissions.js'
import {
  coerceBool,
  parseJson,
  resolveTransitionTarget,
  type WorkflowTransition
} from '../services/pipeline-engine.js'
import { evaluateTransitionRequirements } from '../services/transition-requirements.js'
import type { ItemsQuery, User } from '../types.js'

function handleError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof CollectionNotFoundError) {
    return reply.code(404).send({ error: err.message })
  } else if (err instanceof ForbiddenError) {
    return reply.code(403).send({ error: 'Forbidden' })
  }
  throw err
}

// ─── CSV helpers (no external dependency) ─────────────────────────────────────

function toCsv(rows: Record<string, unknown>[], fields: string[]): string {
  const escapeCsv = (v: unknown): string => {
    if (v == null) return ''
    const s = String(v)
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }
  const header = fields.map(escapeCsv).join(',')
  const lines = rows.map((r) => fields.map((f) => escapeCsv(r[f])).join(','))
  return [header, ...lines].join('\r\n')
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''))
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''))
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']))
  })
}

export async function itemsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', resolveWorkspace)

  app.get('/:collection', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const q = req.query as Record<string, string>

    let parsedFilter: Record<string, unknown> | undefined
    if (q.filter) {
      try {
        parsedFilter = JSON.parse(q.filter) as Record<string, unknown>
      } catch {
        return reply.code(400).send({ error: 'Invalid filter: must be valid JSON' })
      }
    }

    const query: ItemsQuery = {
      fields: q.fields?.split(','),
      sort: q.sort?.split(','),
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
      page: q.page ? Number(q.page) : undefined,
      search: q.search,
      filter: parsedFilter
    }
    try {
      const result = await readItems(
        req.user!,
        collection,
        query,
        req,
        req.workspaceId ?? undefined
      )
      return reply.send(result)
    } catch (err) {
      return handleError(err, reply)
    }
  })

  // Export — must be registered before /:collection/:id so "export" isn't read as an id
  app.get('/:collection/export', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const q = req.query as { format?: string; fields?: string; filter?: string; sort?: string }
    const format = q.format === 'json' ? 'json' : 'csv'

    let parsedFilter: Record<string, unknown> | undefined
    if (q.filter) {
      try {
        parsedFilter = JSON.parse(q.filter) as Record<string, unknown>
      } catch {
        return reply.code(400).send({ error: 'Invalid filter: must be valid JSON' })
      }
    }

    const query: ItemsQuery = {
      fields: q.fields?.split(','),
      sort: q.sort?.split(','),
      limit: 10000,
      offset: 0,
      filter: parsedFilter
    }

    try {
      const result = await readItems(
        req.user!,
        collection,
        query,
        req,
        req.workspaceId ?? undefined
      )
      const rows = result.data as Record<string, unknown>[]

      // Determine field set: explicit query fields, else union of keys from the rows
      let fields: string[]
      if (q.fields) {
        fields = q.fields.split(',').filter((f) => f && f !== '*')
      } else {
        const keySet = new Set<string>()
        for (const r of rows) {
          for (const k of Object.keys(r)) keySet.add(k)
        }
        fields = [...keySet]
      }

      if (format === 'json') {
        return reply
          .header('Content-Type', 'application/json')
          .header('Content-Disposition', `attachment; filename="${collection}-export.json"`)
          .send({ data: rows })
      }

      const csv = toCsv(rows, fields)
      return reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', `attachment; filename="${collection}-export.csv"`)
        .send(csv)
    } catch (err) {
      return handleError(err, reply)
    }
  })

  // Import — multipart CSV upload
  app.post('/:collection/import', async (req, reply) => {
    const { collection } = req.params as { collection: string }

    const multipart = await req.file()
    if (!multipart) return reply.code(400).send({ error: 'No file provided' })

    const buffer = await multipart.toBuffer()
    const text = buffer.toString('utf-8')
    const records = parseCsv(text)

    let imported = 0
    const errors: Array<{ row: number; error: string }> = []

    for (let i = 0; i < records.length; i++) {
      try {
        await createOne(
          req.user!,
          collection,
          records[i] as Record<string, unknown>,
          req,
          req.workspaceId ?? undefined
        )
        imported++
      } catch (err) {
        if (err instanceof CollectionNotFoundError) {
          // Whole collection invalid — abort with a clear error.
          return reply.code(404).send({ error: err.message })
        }
        if (err instanceof ForbiddenError) {
          return reply.code(403).send({ error: 'Forbidden' })
        }
        errors.push({ row: i + 1, error: String(err) })
      }
    }

    return reply.send({ imported, errors })
  })

  // ─── Bulk actions ─────────────────────────────────────────────────────────

  app.post('/:collection/bulk-delete', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { ids } = req.body as { ids: string[] }
    if (!Array.isArray(ids) || ids.length === 0)
      return reply.code(400).send({ error: 'ids array required' })
    let deleted = 0
    for (const id of ids) {
      try {
        await deleteOne(req.user!, collection, id, req, req.workspaceId ?? undefined)
        deleted++
      } catch {
        // skip permission/not-found errors per item
      }
    }
    return reply.send({ deleted })
  })

  app.post('/:collection/bulk-update', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { ids, data } = req.body as { ids: string[]; data: Record<string, unknown> }
    if (!Array.isArray(ids) || ids.length === 0)
      return reply.code(400).send({ error: 'ids array required' })
    if (!data || typeof data !== 'object')
      return reply.code(400).send({ error: 'data object required' })
    let updated = 0
    for (const id of ids) {
      try {
        await updateOne(req.user!, collection, id, data, req, req.workspaceId ?? undefined)
        updated++
      } catch {
        // skip permission/not-found errors per item
      }
    }
    return reply.send({ updated })
  })

  app.post('/:collection/bulk-transition', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { ids, transition_id } = req.body as { ids: string[]; transition_id: string }
    if (!Array.isArray(ids) || ids.length === 0)
      return reply.code(400).send({ error: 'ids array required' })
    if (!transition_id) return reply.code(400).send({ error: 'transition_id required' })

    const transition = await db<WorkflowTransition>('nivaro_workflow_transitions')
      .where({ id: transition_id })
      .first()
    if (!transition) return reply.code(404).send({ error: 'Transition not found' })

    // Check role permission once (applies to all items)
    const isAdmin = req.isAdmin ?? false
    if (!isAdmin && transition.required_roles) {
      const roles = parseJson(transition.required_roles) as string[] | null
      if (roles && roles.length > 0) {
        const userRole = req.user?.role ?? null
        if (!userRole || !roles.includes(userRole)) {
          return reply.code(403).send({ error: 'You do not have permission for this transition' })
        }
      }
    }

    const binding = await db('nivaro_workflow_bindings').where({ collection }).first()

    let succeeded = 0
    let failed = 0
    const errors: Array<{ item: string; error: string }> = []
    for (const item of ids) {
      try {
        const instance = await db('nivaro_workflow_instances').where({ collection, item }).first()
        if (!instance || instance.completed_at) {
          failed++
          continue
        }

        const fromOk =
          transition.from_state === null || transition.from_state === instance.current_state
        if (!fromOk) {
          failed++
          continue
        }

        // Transition requirements gate — mirrors the single-item transition
        // route so bulk actions can't bypass incomplete child-row data.
        if (transition.requirements) {
          const blocking = await evaluateTransitionRequirements(
            db,
            transition.requirements,
            String(item),
            req.log,
            collection
          )
          if (blocking) {
            failed++
            errors.push({ item: String(item), error: 'TRANSITION_REQUIREMENTS' })
            continue
          }
        }

        const resolvedTarget = await resolveTransitionTarget(
          transition.to_state,
          instance.template,
          collection,
          item,
          instance.id,
          db
        )
        const newStateId = resolvedTarget?.id ?? transition.to_state
        const newStateObj =
          resolvedTarget ?? (await db('nivaro_workflow_states').where({ id: newStateId }).first())

        await db('nivaro_workflow_instances')
          .where({ id: instance.id })
          .update({
            current_state: newStateId,
            completed_at: newStateObj && coerceBool(newStateObj.is_terminal) ? new Date() : null
          })

        await db('nivaro_workflow_history').insert({
          instance: instance.id,
          transition: transition.id,
          from_state: instance.current_state,
          to_state: newStateId,
          user: req.user?.id ?? null,
          comment: null,
          timestamp: new Date()
        })

        if (binding?.state_field && newStateObj) {
          try {
            await db(collection)
              .where({ id: item })
              .update({ [binding.state_field]: newStateObj.key })
          } catch {
            /* non-fatal */
          }
        }

        await logActivity({
          action: 'pipeline-transition',
          collection,
          item: String(item),
          user: req.user?.id,
          req,
          comment: `bulk: ${transition.label} → ${newStateObj?.label ?? newStateId}`
        })

        succeeded++
      } catch {
        failed++
      }
    }
    return reply.send({ succeeded, failed, errors })
  })

  // POST /items/:collection/auto-id-preview — render an auto_id pattern against
  // draft form values (and, when editing, the record's own persisted suffix) so
  // the admin UI can show a live preview before the value is actually generated.
  app.post('/:collection/auto-id-preview', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const body = (req.body ?? {}) as {
      field?: string
      values?: Record<string, unknown>
      record_id?: string | number
    }
    const user = req.user as User
    if (!(await can(user, 'read', collection))) return reply.code(403).send({ error: 'Forbidden' })
    if (!body.field) return reply.code(400).send({ error: 'field is required' })

    const fields = await autoIdFieldsFor(db, collection)
    const target = fields.find((f) => f.field === body.field)
    if (!target) return reply.code(400).send({ error: 'Field has no auto_id config' })
    const chosen = resolveAutoIdPattern(target.config, body.values ?? {})
    const err = validateAutoIdPattern(chosen)
    if (err) return reply.code(400).send({ error: err })

    const parsed = parseAutoIdPattern(chosen)
    const seqToken = parsed.tokens[parsed.tokens.length - 1] as Extract<
      AutoIdToken,
      { kind: 'seq' }
    >
    const width = Math.max(
      4,
      target.config.padding ?? 0,
      seqToken.name === 'seq6' ? 6 : seqToken.name === 'seq4' ? 4 : 0
    )
    let seqValue = '#'.repeat(width)
    if (body.record_id != null) {
      const row = (await db(collection).where({ id: body.record_id }).first(body.field)) as
        | Record<string, unknown>
        | undefined
      const current = row?.[body.field]
      if (typeof current === 'string' && current) {
        seqValue = extractSuffix(parsed, current) ?? seqValue
      }
    }
    const { rendered, complete } = await resolveAutoIdTokensDetailed(parsed, {
      collection,
      values: body.values ?? {},
      recordId: body.record_id,
      lookups: dbLookups(db),
      seqValue
    })
    return reply.send({ preview: rendered, complete })
  })

  // ─────────────────────────────────────────────────────────────────────────

  app.get('/:collection/:id', async (req, reply) => {
    const { collection, id } = req.params as { collection: string; id: string }
    const q = req.query as Record<string, string>
    const fields = q.fields?.split(',')
    try {
      const item = await readOne(req.user!, collection, id, req.workspaceId ?? undefined, fields)
      if (!item) return reply.code(404).send({ error: 'Not found' })
      return reply.send({ data: item })
    } catch (err) {
      return handleError(err, reply)
    }
  })

  // #619: pretty record URLs — resolve a record by its configured slug column
  // (nivaro_collections.slug_field, migration 278). The raw lookup only finds
  // the id; the record itself is served through readOne so RBAC / RLS / user
  // scopes apply exactly as on GET /:collection/:id. Case-insensitive, first
  // match by id for determinism. 404 when the collection has no slug_field.
  // Human record URLs resolve through ONE engine: url_alias_fields
  // (resolveAliasId — case-insensitive, multi-field, lowest-id-deterministic).
  // The legacy per-collection slug_field is honored as a fallback so configs
  // made before the merge keep working; the admin card offers a migrate.
  app.get('/:collection/by-slug/:slug', async (req, reply) => {
    const { collection, slug } = req.params as { collection: string; slug: string }
    const q = req.query as Record<string, string>
    const fields = q.fields?.split(',')
    try {
      const { getCollection } = await import('../services/collections.js')
      const col = await getCollection(collection)
      if (!col) return reply.code(404).send({ error: 'Not found' })
      const { resolveAliasId } = await import('../services/items.js')
      let resolvedId: string | number | null = await resolveAliasId(collection, slug)
      const slugField = (col as { slug_field?: string | null }).slug_field
      if (resolvedId == null && slugField && /^[A-Za-z_][A-Za-z0-9_]*$/.test(slugField)) {
        try {
          const row = (await db(collection)
            .whereRaw('LOWER(CAST(?? AS NVARCHAR(400))) = ?', [slugField, slug.toLowerCase()])
            .orderBy('id', 'asc')
            .first('id')) as { id: unknown } | undefined
          resolvedId = (row?.id as string | number | undefined) ?? null
        } catch {
          resolvedId = null
        }
      }
      if (resolvedId == null) return reply.code(404).send({ error: 'Not found' })
      const row = { id: resolvedId }
      const item = await readOne(
        req.user!,
        collection,
        String(row.id),
        req.workspaceId ?? undefined,
        fields
      )
      if (!item) return reply.code(404).send({ error: 'Not found' })
      return reply.send({ data: item })
    } catch (err) {
      return handleError(err, reply)
    }
  })

  // Every hop of a dotted path must be a collection the requester can read —
  // otherwise resolve-paths would leak related-collection data (e.g. a
  // line_items reader pulling vendors or nivaro_users values) past RBAC.
  async function pathHopsReadable(
    user: import('../types.js').User,
    baseCollection: string,
    segments: string[]
  ): Promise<{ readable: boolean; target: string | null }> {
    const { classifyRelationSegment } = await import('../services/queues.js')
    const { getRelations } = await import('../services/collections.js')
    let current = baseCollection
    let target: string | null = null
    for (const seg of segments) {
      const relations = await getRelations(current)
      const info = classifyRelationSegment(current, seg, relations)
      if (!info) return { readable: true, target } // plain column leaf — no further hop
      const hop = info.relatedCollection
      if (!hop) return { readable: false, target: null }
      if (hop.startsWith('nivaro_') && hop !== 'nivaro_users')
        return { readable: false, target: null }
      if (!(await can(user, 'read', hop))) return { readable: false, target: null }
      current = hop
      target = hop
    }
    return { readable: true, target }
  }

  // GET /items/:collection/distinct?field=<col>&limit=200 — distinct non-null
  // values of one PHYSICAL column, for column-filter dropdowns. Read-gated;
  // registered as a static segment so it wins over GET /:collection/:id.
  app.get('/:collection/distinct', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { field, limit } = req.query as { field?: string; limit?: string }
    if (collection.startsWith('nivaro_')) return reply.code(403).send({ error: 'Forbidden' })
    if (!/^[a-zA-Z0-9_]+$/.test(collection))
      return reply.code(400).send({ error: 'Invalid collection' })
    if (!(await can(req.user!, 'read', collection)))
      return reply.code(403).send({ error: 'Forbidden' })
    if (!field || !/^[a-zA-Z0-9_]+$/.test(field))
      return reply.code(400).send({ error: 'Invalid field' })
    const colCheck = (await db.raw(
      'SELECT 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME = ?',
      [collection, field]
    )) as unknown as Array<{ ok: number }>
    if (!colCheck?.length) return reply.code(400).send({ error: 'Unknown column' })
    const cap = Math.min(Math.max(Number(limit) || 200, 1), 500)
    try {
      const rows = (await db(collection)
        .distinct(field)
        .whereNotNull(field)
        .orderBy(field, 'asc')
        .limit(cap)) as Array<Record<string, unknown>>
      return reply.send({ data: rows.map((r) => r[field]) })
    } catch (err) {
      return handleError(err, reply)
    }
  })

  // GET /items/:collection/resolve-paths?ids=1,2&paths=a.b.c — bulk variant for
  // inline tables (one call per table, all rows × all dotted columns).
  // Registered as a static segment so it wins over GET /:collection/:id.
  app.get('/:collection/resolve-paths', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { ids, paths } = req.query as { ids?: string; paths?: string }
    if (collection.startsWith('nivaro_')) return reply.code(403).send({ error: 'Forbidden' })
    if (!(await can(req.user!, 'read', collection)))
      return reply.code(403).send({ error: 'Forbidden' })
    const requestedIds = (ids ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 500)
    const pathList = (paths ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p && p.includes('.') && /^[a-zA-Z0-9_.]+$/.test(p))
      .slice(0, 20)
    if (!requestedIds.length || !pathList.length) return reply.send({ data: {} })

    // Row-level security on the base ids: keep only rows the items service
    // would let this user read (policies + row_filter applied by readItems).
    let idList: string[]
    try {
      const visible = await readItems(
        req.user!,
        collection,
        {
          filter: { id: { _in: requestedIds } },
          fields: ['id'],
          limit: requestedIds.length
        } as ItemsQuery,
        req,
        req.workspaceId ?? undefined
      )
      const visibleIds = new Set(visible.data.map((r) => String((r as { id?: unknown }).id)))
      idList = requestedIds.filter((id) => visibleIds.has(id))
    } catch (err) {
      return handleError(err, reply)
    }
    if (!idList.length) return reply.send({ data: {} })

    const { resolvePathValues } = await import('../services/queues.js')
    const relationsCache = new Map<string, import('../types.js').CMSRelation[]>()
    const rowsOut: Record<string, Record<string, { value: string; ids: string[] }>> = {}
    const targets: Record<string, string | null> = {}
    await Promise.all(
      pathList.map(async (path) => {
        try {
          const segments = path.split('.')
          const hops = await pathHopsReadable(req.user!, collection, segments)
          if (!hops.readable) return
          targets[path] = hops.target
          const byRow = await resolvePathValues(collection, idList, segments, relationsCache)
          for (const [rowId, pv] of byRow) {
            ;(rowsOut[rowId] ??= {})[path] = { value: pv.value, ids: pv.ids }
          }
        } catch {
          // skip broken path
        }
      })
    )
    return reply.send({ data: { rows: rowsOut, targets } })
  })

  // GET /items/:collection/:id/resolve-paths?paths=a.b.c,d.e — resolve dotted
  // relation paths for one record (layout relation-path fields). Read access to
  // the base record is required; values resolve via the same machinery queue
  // extra-field columns use (M2O chains, M2M/O2M leaf as "A, B +N more").
  app.get('/:collection/:id/resolve-paths', async (req, reply) => {
    const { collection, id } = req.params as { collection: string; id: string }
    const { paths } = req.query as { paths?: string }
    if (collection.startsWith('nivaro_')) return reply.code(403).send({ error: 'Forbidden' })
    if (!paths) return reply.send({ data: {} })
    const pathList = paths
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p && p.includes('.') && /^[a-zA-Z0-9_.]+$/.test(p))
      .slice(0, 20)
    if (pathList.length === 0) return reply.send({ data: {} })

    try {
      const item = await readOne(req.user!, collection, id, req.workspaceId ?? undefined, ['id'])
      if (!item) return reply.code(404).send({ error: 'Not found' })
    } catch (err) {
      return handleError(err, reply)
    }

    const { resolvePathValues } = await import('../services/queues.js')
    const relationsCache = new Map<string, import('../types.js').CMSRelation[]>()
    const out: Record<string, { value: string; ids: string[]; target_collection: string | null }> =
      {}
    await Promise.all(
      pathList.map(async (path) => {
        try {
          const segments = path.split('.')
          const hops = await pathHopsReadable(req.user!, collection, segments)
          if (!hops.readable) return
          const byRow = await resolvePathValues(collection, [String(id)], segments, relationsCache)
          const pv = byRow.get(String(id))
          if (pv) out[path] = { ...pv, target_collection: hops.target }
        } catch {
          // Stale/deleted path config — skip this path, resolve the rest.
        }
      })
    )
    return reply.send({ data: out })
  })

  // ── REST batch endpoint (#165) ────────────────────────────────────────────
  // Create/update many in one call, per-row results. Every row goes through
  // the FULL items service (RBAC, validation, hooks, revisions) — this is a
  // round-trip saver, never a fast path around the rules. Cap 100 rows.
  app.post('/:collection/batch', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    if (req.user?.api_key_sandbox) {
      return reply.code(403).send({ error: 'Sandbox keys cannot batch-write' })
    }
    const body = req.body as {
      create?: Array<Record<string, unknown>>
      update?: Array<Record<string, unknown> & { id?: string | number }>
    }
    const creates = Array.isArray(body?.create) ? body.create : []
    const updates = Array.isArray(body?.update) ? body.update : []
    if (creates.length + updates.length === 0)
      return reply.code(400).send({ error: 'Provide create[] and/or update[] rows' })
    if (creates.length + updates.length > 100)
      return reply.code(422).send({ error: 'Batch cap is 100 rows per call' })
    const results: Array<{
      op: 'create' | 'update'
      index: number
      ok: boolean
      id?: unknown
      data?: unknown
      error?: string
    }> = []
    for (const [i, row] of creates.entries()) {
      try {
        const item = (await createOne(
          req.user!,
          collection,
          row,
          req,
          req.workspaceId ?? undefined
        )) as Record<string, unknown>
        results.push({ op: 'create', index: i, ok: true, id: item.id, data: item })
      } catch (err) {
        results.push({
          op: 'create',
          index: i,
          ok: false,
          error: err instanceof Error ? err.message : 'failed'
        })
      }
    }
    for (const [i, row] of updates.entries()) {
      const rowId = row.id
      if (rowId == null) {
        results.push({ op: 'update', index: i, ok: false, error: 'row missing id' })
        continue
      }
      const { id: _id, ...patch } = row
      try {
        const item = (await updateOne(
          req.user!,
          collection,
          String(rowId),
          patch,
          req,
          req.workspaceId ?? undefined
        )) as Record<string, unknown>
        results.push({ op: 'update', index: i, ok: true, id: rowId, data: item })
      } catch (err) {
        results.push({
          op: 'update',
          index: i,
          ok: false,
          error: err instanceof Error ? err.message : 'failed'
        })
      }
    }
    const failed = results.filter((r) => !r.ok).length
    return reply.code(failed === results.length ? 422 : 200).send({
      data: { results, ok: results.length - failed, failed }
    })
  })

  app.post('/:collection', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const q = req.query as Record<string, string>
    const parentCollection = q.parent_collection ?? null
    const parentId = q.parent_id ?? null
    // Sandbox key (#166): the write is permission-checked and shaped like a
    // real response, but NOTHING persists — integration test traffic against
    // production stays side-effect free.
    if (req.user?.api_key_sandbox) {
      const sim = await simulateSandboxWrite(req, collection, 'create', null)
      return reply.code(sim.code).send(sim.body)
    }
    try {
      const item = await createOne(
        req.user!,
        collection,
        req.body as Record<string, unknown>,
        req,
        req.workspaceId ?? undefined
      )
      if (parentCollection && parentId) {
        await logActivity({
          action: 'o2m-create',
          user: req.user!.id,
          collection: parentCollection,
          item: parentId,
          comment: JSON.stringify({
            child_collection: collection,
            child_id: String((item as Record<string, unknown>).id),
            snapshot: item
          }),
          req
        })
      }
      return reply.code(201).send({ data: item })
    } catch (err) {
      return handleError(err, reply)
    }
  })

  app.patch('/:collection/:id', async (req, reply) => {
    const { collection, id } = req.params as { collection: string; id: string }
    const q = req.query as Record<string, string>
    const parentCollection = q.parent_collection ?? null
    const parentId = q.parent_id ?? null
    if (req.user?.api_key_sandbox) {
      const sim = await simulateSandboxWrite(req, collection, 'update', id)
      return reply.code(sim.code).send(sim.body)
    }
    try {
      const item = await updateOne(
        req.user!,
        collection,
        id,
        req.body as Record<string, unknown>,
        req,
        req.workspaceId ?? undefined
      )
      if (parentCollection && parentId) {
        await logActivity({
          action: 'o2m-update',
          user: req.user!.id,
          collection: parentCollection,
          item: parentId,
          comment: JSON.stringify({ child_collection: collection, child_id: id, snapshot: item }),
          req
        })
      }
      return reply.send({ data: item })
    } catch (err) {
      return handleError(err, reply)
    }
  })

  app.delete('/:collection/:id', async (req, reply) => {
    const { collection, id } = req.params as { collection: string; id: string }
    const q = req.query as Record<string, string>
    const parentCollection = q.parent_collection ?? null
    const parentId = q.parent_id ?? null
    if (req.user?.api_key_sandbox) {
      const sim = await simulateSandboxWrite(req, collection, 'delete', id)
      return reply.code(sim.code).send(sim.body)
    }
    // capture snapshot before deletion so we can store it in parent activity
    let childSnapshot: Record<string, unknown> | null = null
    if (parentCollection && parentId) {
      childSnapshot =
        (await db(collection)
          .where({ id })
          .first()
          .catch(() => null)) ?? null
    }
    try {
      await deleteOne(req.user!, collection, id, req, req.workspaceId ?? undefined)
      if (parentCollection && parentId) {
        await logActivity({
          action: 'o2m-delete',
          user: req.user!.id,
          collection: parentCollection,
          item: parentId,
          comment: JSON.stringify({
            child_collection: collection,
            child_id: id,
            snapshot: childSnapshot
          }),
          req
        })
      }
      return reply.code(204).send()
    } catch (err) {
      return handleError(err, reply)
    }
  })

  // POST /items/:collection/:id/clone — clone an item
  app.post('/:collection/:id/clone', async (req, reply) => {
    const { collection, id } = req.params as { collection: string; id: string }

    const body = (req.body ?? {}) as {
      field_overrides?: Record<string, unknown>
      exclude_fields?: string[]
      include_sub_rows?: string[]
    }

    try {
      const original = (await db(collection).where({ id }).first()) as
        | Record<string, unknown>
        | undefined
      if (!original) return reply.code(404).send({ error: 'Not found' })

      // Build clone: omit the id field
      const clone = { ...original }
      delete clone.id

      // Apply caller-supplied field overrides — restricted to registered CMS fields only.
      // Never allow overwriting system/protected columns.
      const PROTECTED_FIELDS = new Set([
        'id',
        'created_at',
        'created_by',
        'updated_at',
        'updated_by',
        '_status',
        'workspace_id',
        'is_redacted'
      ])
      if (body.field_overrides) {
        const allowedFields = (await db('nivaro_fields')
          .where({ collection })
          .pluck('field')) as string[]
        const allowedSet = new Set(allowedFields)
        for (const [field, value] of Object.entries(body.field_overrides)) {
          if (allowedSet.has(field) && !PROTECTED_FIELDS.has(field)) {
            clone[field] = value
          }
        }
      }

      // Drop excluded fields — guard against removing id or other protected columns
      if (body.exclude_fields) {
        for (const field of body.exclude_fields) {
          if (!PROTECTED_FIELDS.has(field)) delete clone[field]
        }
      }

      // If collection has draft_publish_enabled, set _status to draft
      const colMeta = await db('nivaro_collections').where({ collection }).first()
      if (colMeta?.draft_publish_enabled) {
        clone._status = 'draft'
      }

      const [row] = await db(collection).insert(clone).returning('id')
      const newId = typeof row === 'object' ? (row as { id: unknown }).id : row

      // Clone sub-rows for requested fields
      if (body.include_sub_rows?.length) {
        for (const field of body.include_sub_rows) {
          const subRows = (await db('nivaro_sub_rows')
            .where({ collection, item_id: String(id), field })
            .orderBy('sort', 'asc')) as Record<string, unknown>[]

          for (const sr of subRows) {
            await db('nivaro_sub_rows').insert({
              collection,
              item_id: String(newId),
              field,
              sort: sr.sort,
              data: sr.data,
              created_at: new Date(),
              updated_at: new Date()
            })
          }
        }
      }

      await logActivity({
        action: 'clone',
        user: req.user!.id,
        collection,
        item: String(newId),
        comment: JSON.stringify({ source_id: id }),
        req
      })

      return reply.code(201).send({ data: { id: newId } })
    } catch (err) {
      return handleError(err, reply)
    }
  })

  // GET /items/:collection/:id/field-history/:field — field change history
  app.get('/:collection/:id/field-history/:field', async (req, reply) => {
    const { collection, id, field } = req.params as {
      collection: string
      id: string
      field: string
    }

    const rows = (await db('nivaro_revisions as r')
      .join('nivaro_activity as a', 'r.activity', 'a.id')
      .where('a.collection', collection)
      .where('a.item', id)
      .whereIn('a.action', ['update', 'create'])
      .orderBy('a.timestamp', 'desc')
      .limit(50)
      .select('r.id as revision_id', 'a.timestamp', 'r.data', 'a.user as user_id')) as Array<{
      revision_id: number
      timestamp: Date
      data: string | Record<string, unknown>
      user_id: string | null
    }>

    const history = rows.map((row) => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed =
          typeof row.data === 'string'
            ? (JSON.parse(row.data) as Record<string, unknown>)
            : (row.data as Record<string, unknown>)
      } catch {
        parsed = {}
      }
      return {
        revision_id: row.revision_id,
        timestamp: row.timestamp,
        value: parsed[field] ?? null,
        user_id: row.user_id
      }
    })

    return reply.send({ data: history })
  })
}

// ─── Sandbox key simulation (#166) ───────────────────────────────────────────
// Runs the SAME permission gate as a real write, then fabricates a realistic
// response with `sandbox: true` — nothing touches the database. Deliberately
// route-level: hooks/rules/computed fields never run, so no side effect can
// leak from "simulated" work.
async function simulateSandboxWrite(
  req: import('fastify').FastifyRequest,
  collection: string,
  action: 'create' | 'update' | 'delete',
  id: string | null
): Promise<{ code: number; body: unknown }> {
  const { can } = await import('../services/permissions.js')
  if (/^nivaro_/i.test(collection)) {
    return { code: 403, body: { error: 'Sandbox keys cannot write system collections' } }
  }
  const allowed = await can(req.user!, action, collection)
  if (!allowed) {
    return { code: 403, body: { error: `No ${action} permission on ${collection}` } }
  }
  if (action === 'delete') {
    return { code: 200, body: { data: { id, deleted: true }, sandbox: true } }
  }
  const payload = (req.body ?? {}) as Record<string, unknown>
  if (action === 'update') {
    const current = ((await db(collection)
      .where({ id })
      .first()
      .catch(() => null)) ?? null) as Record<string, unknown> | null
    if (!current) return { code: 404, body: { error: 'Not found' } }
    return { code: 200, body: { data: { ...current, ...payload }, sandbox: true } }
  }
  return {
    code: 201,
    body: {
      data: { id: `sandbox-${Date.now().toString(36)}`, ...payload },
      sandbox: true
    }
  }
}
