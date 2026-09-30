import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { bulkActionRegistry } from '../extensions/bulk-actions.js'
import { authenticate, requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  accessAllows,
  BUILTIN_KEYS,
  BULK_ACTION_KINDS,
  type BulkActionKind,
  builtinAllowed,
  formatRow,
  KEY_RE,
  listAllForCollection,
  listAvailable,
  listBuiltins,
  listDefinitions,
  normalizeAccess,
  normalizeGuard,
  runDefinition,
  setBuiltin,
  transitionLabelsFor
} from '../services/bulk-actions.js'
import { BULK_PUSH_MAX, retryFailedPushes, runItemActionOver } from '../services/bulk-push.js'
import { can } from '../services/permissions.js'
import type { User } from '../types.js'

/**
 * Bulk actions: admin-defined (nivaro_bulk_actions) + extension-registered.
 * See services/bulk-actions.ts for the semantics. Surfaces call
 * GET /bulk-actions/available then POST /bulk-actions/run.
 */
export async function bulkActionsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // ── Extension-registered actions (legacy shape, kept for callers) ────────
  app.get('/bulk-actions/registered', { preHandler: [requireAuth] }, async (req) => {
    const collection = (req.query as Record<string, string>).collection
    const actions = bulkActionRegistry.list(collection)
    return {
      data: actions
        .filter((a) => accessAllows(normalizeAccess(a.access), req))
        .map(({ execute: _x, ...rest }) => rest)
    }
  })

  app.post<{
    Params: { id: string }
    Body: {
      collection: string
      ids: (string | number)[]
      payload?: Record<string, unknown>
      reason?: string | null
    }
  }>('/bulk-actions/:id/execute', { preHandler: [requireAuth] }, async (req, reply) => {
    const action = bulkActionRegistry.get(req.params.id)
    if (!action) return reply.status(404).send({ error: 'Bulk action not found' })

    const { collection, ids, payload, reason } = req.body
    if (!collection || !Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ error: 'collection and ids are required' })
    }
    if (!accessAllows(normalizeAccess(action.access), req))
      return reply.status(403).send({ error: 'You cannot run this action' })
    if (!req.isAdmin && !(await can(req.user as User, 'update', collection)))
      return reply.status(403).send({ error: 'Forbidden' })
    if (action.require_reason && !String(reason ?? '').trim())
      return reply.status(400).send({ error: 'A reason is required for this action' })

    try {
      const result = await action.execute({
        collection,
        ids,
        payload,
        reason: reason ?? null,
        userId: req.user?.id
      })
      // The mutation itself lives in extension code — log the invocation.
      await logActivity({
        action: 'bulk-action-execute',
        user: req.user?.id,
        collection,
        comment: `${req.params.id} on ${ids.length} item(s)${reason ? ` — "${reason}"` : ''}`,
        req
      })
      return { data: result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Action failed'
      return reply.status(500).send({ error: msg })
    }
  })

  // ── What the bars render: active + allowed for the caller ────────────────
  app.get<{ Querystring: { collection?: string } }>(
    '/bulk-actions/available',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const collection = String(req.query.collection ?? '').trim()
      if (!collection) return reply.code(400).send({ error: 'collection is required' })
      return { data: await listAvailable(collection, req) }
    }
  )

  /** Editor pickers: every active action for the collection, no access filter
   *  (a queue builder must be able to enable an admin-only action). */
  app.get<{ Querystring: { collection?: string } }>(
    '/bulk-actions/catalog',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const collection = String(req.query.collection ?? '').trim()
      if (!collection) return reply.code(400).send({ error: 'collection is required' })
      return { data: await listAllForCollection(collection) }
    }
  )

  app.get<{ Querystring: { collection?: string } }>(
    '/bulk-actions/transition-labels',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const collection = String(req.query.collection ?? '').trim()
      if (!collection) return reply.code(400).send({ error: 'collection is required' })
      return { data: await transitionLabelsFor(collection) }
    }
  )

  // ── Run ───────────────────────────────────────────────────────────────────
  app.post<{
    Body: {
      collection?: string
      key?: string
      ids?: Array<string | number>
      reason?: string | null
    }
  }>('/bulk-actions/run', { preHandler: [requireAuth] }, async (req, reply) => {
    const collection = String(req.body?.collection ?? '').trim()
    const key = String(req.body?.key ?? '').trim()
    const ids = Array.isArray(req.body?.ids) ? req.body!.ids!.slice(0, 2000) : []
    const reason = String(req.body?.reason ?? '').trim() || null
    if (!collection || !key)
      return reply.code(400).send({ error: 'collection and key are required' })
    if (ids.length === 0) return reply.code(400).send({ error: 'ids are required' })
    if (!req.isAdmin && !(await can(req.user as User, 'update', collection)))
      return reply.code(403).send({ error: 'Forbidden' })

    const row = await db('nivaro_bulk_actions')
      .where({ collection, key, is_active: true })
      .whereNot({ kind: 'builtin' })
      .first()
    if (!row) return reply.code(404).send({ error: 'Bulk action not found' })
    const def = formatRow(row as Record<string, unknown>)
    if (!accessAllows(def.access, req))
      return reply.code(403).send({ error: 'You cannot run this action' })
    if (def.require_reason && !reason)
      return reply.code(400).send({ error: 'A reason is required for this action' })

    let result: Awaited<ReturnType<typeof runDefinition>>
    try {
      result = await runDefinition(def, ids, reason, req)
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
    await logActivity({
      action: 'bulk-action-execute',
      user: req.user?.id,
      collection,
      comment: `${def.label} (${key}) on ${ids.length} item(s): ${result.succeeded} done, ${result.skipped} skipped, ${result.failed} failed${reason ? ` — "${reason}"` : ''}`,
      req
    })
    return { data: result }
  })

  // #1/#18 — dry run: the same guards, already-there checks and transition
  // matching as /run, nothing written. Feeds the bar's "5 of 10 would change".
  app.post<{
    Body: { collection?: string; key?: string; ids?: Array<string | number> }
  }>('/bulk-actions/preview', { preHandler: [requireAuth] }, async (req, reply) => {
    const collection = String(req.body?.collection ?? '').trim()
    const key = String(req.body?.key ?? '').trim()
    const ids = Array.isArray(req.body?.ids) ? req.body!.ids!.slice(0, 2000) : []
    if (!collection || !key)
      return reply.code(400).send({ error: 'collection and key are required' })
    if (ids.length === 0) return reply.code(400).send({ error: 'ids are required' })
    if (!req.isAdmin && !(await can(req.user as User, 'update', collection)))
      return reply.code(403).send({ error: 'Forbidden' })
    const row = await db('nivaro_bulk_actions')
      .where({ collection, key, is_active: true })
      .whereNot({ kind: 'builtin' })
      .first()
    if (!row) return reply.code(404).send({ error: 'Bulk action not found' })
    const def = formatRow(row as Record<string, unknown>)
    if (!accessAllows(def.access, req))
      return reply.code(403).send({ error: 'You cannot run this action' })
    try {
      const result = await runDefinition(def, ids, null, req, { dryRun: true })
      return {
        data: {
          would_change: result.succeeded,
          skipped: result.skipped,
          failed: result.failed,
          outcomes: result.outcomes
        }
      }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── Integration pushes (#620 bars, #622 row menu) ─────────────────────────
  // Built-ins 'push' / 'retry-push': the switch + access rule, update
  // permission, then per-record gates inside services/bulk-push.ts. Sends are
  // sequential and capped — every record is a real partner request.
  const pushGate = async (
    req: FastifyRequest,
    reply: FastifyReply,
    key: 'push' | 'retry-push'
  ): Promise<{ collection: string; ids: string[]; dryRun: boolean } | null> => {
    const body = (req.body ?? {}) as { collection?: string; ids?: unknown; dry_run?: unknown }
    const collection = String(body.collection ?? '').trim()
    const ids = (Array.isArray(body.ids) ? body.ids : [])
      .map((v) => String(v ?? '').trim())
      .filter(Boolean)
    if (!collection) {
      reply.code(400).send({ error: 'collection is required' })
      return null
    }
    if (ids.length === 0) {
      reply.code(400).send({ error: 'ids are required' })
      return null
    }
    if (ids.length > BULK_PUSH_MAX) {
      reply.code(400).send({
        error: `At most ${BULK_PUSH_MAX} records per run — every one is a partner request`
      })
      return null
    }
    if (!(await builtinAllowed(collection, key, req))) {
      reply.code(403).send({ error: 'This action is not available to you here' })
      return null
    }
    if (!req.isAdmin && !(await can(req.user as User, 'update', collection))) {
      reply.code(403).send({ error: 'Forbidden' })
      return null
    }
    return { collection, ids, dryRun: body.dry_run === true }
  }

  app.post<{
    Body: {
      collection?: string
      action_id?: string
      ids?: Array<string | number>
      payload?: Record<string, unknown> | null
      dry_run?: boolean
    }
  }>('/bulk-actions/push', { preHandler: [requireAuth] }, async (req, reply) => {
    const g = await pushGate(req, reply, 'push')
    if (!g) return
    const actionId = String(req.body?.action_id ?? '').trim()
    if (!actionId) return reply.code(400).send({ error: 'action_id is required' })
    const payload =
      req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : null
    let result: Awaited<ReturnType<typeof runItemActionOver>>
    try {
      result = await runItemActionOver({
        actionId,
        collection: g.collection,
        ids: g.ids,
        payload,
        req,
        dryRun: g.dryRun
      })
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode ?? 400
      return reply.code(code).send({ error: err instanceof Error ? err.message : String(err) })
    }
    if (!g.dryRun)
      await logActivity({
        action: 'bulk-action-execute',
        user: req.user?.id,
        collection: g.collection,
        comment: `push ${actionId} on ${g.ids.length} item(s): ${result.succeeded} done, ${result.skipped} skipped, ${result.failed} failed`,
        req
      })
    return { data: result }
  })

  app.post<{
    Body: { collection?: string; ids?: Array<string | number>; dry_run?: boolean }
  }>('/bulk-actions/retry-push', { preHandler: [requireAuth] }, async (req, reply) => {
    const g = await pushGate(req, reply, 'retry-push')
    if (!g) return
    const result = await retryFailedPushes({
      collection: g.collection,
      ids: g.ids,
      req,
      dryRun: g.dryRun
    })
    if (!g.dryRun)
      await logActivity({
        action: 'bulk-action-execute',
        user: req.user?.id,
        collection: g.collection,
        comment: `retry-push on ${g.ids.length} item(s): ${result.succeeded} landed, ${result.skipped} skipped, ${result.failed} failed`,
        req
      })
    return { data: result }
  })

  // ── Built-ins (override state per collection) ─────────────────────────────
  app.get<{ Querystring: { collection?: string } }>(
    '/bulk-actions/builtins',
    { preHandler: [requireAdmin] },
    async (req, reply) => {
      const collection = String(req.query.collection ?? '').trim()
      if (!collection) return reply.code(400).send({ error: 'collection is required' })
      return { data: await listBuiltins(collection) }
    }
  )

  app.put<{ Params: { collection: string; key: string } }>(
    '/bulk-actions/builtins/:collection/:key',
    { preHandler: [requireAdmin] },
    async (req, reply) => {
      const { collection, key } = req.params
      if (!BUILTIN_KEYS.has(key)) return reply.code(404).send({ error: 'Unknown built-in action' })
      const b = (req.body ?? {}) as { access?: unknown; is_active?: unknown }
      const state = await setBuiltin(collection, key, b, req.user?.id ?? null)
      await logActivity({
        action: 'bulk-action-update',
        user: req.user?.id,
        collection,
        comment: `built-in ${key}: ${state.is_active ? 'on' : 'off'}, ${state.access.mode}`,
        req
      })
      return { data: state }
    }
  )

  // ── Admin CRUD ────────────────────────────────────────────────────────────
  app.get<{ Querystring: { collection?: string } }>(
    '/bulk-actions/defs',
    { preHandler: [requireAdmin] },
    async (req) => {
      const collection = String(req.query.collection ?? '').trim()
      if (collection) return { data: await listDefinitions(collection) }
      const rows = await db('nivaro_bulk_actions').orderBy(['collection', 'sort', 'id']).select('*')
      return { data: rows.map((r) => formatRow(r as Record<string, unknown>)) }
    }
  )

  const validate = (b: Record<string, unknown>, partial: boolean) => {
    const out: Record<string, unknown> = {}
    const errs: string[] = []
    if (!partial || 'label' in b) {
      const label = String(b.label ?? '').trim()
      if (!label) errs.push('label is required')
      out.label = label.slice(0, 120)
    }
    if (!partial || 'key' in b) {
      const key = String(b.key ?? '')
        .trim()
        .toLowerCase()
      if (!KEY_RE.test(key)) errs.push('key must be a slug (a-z, 0-9, -, _)')
      else if (BUILTIN_KEYS.has(key)) errs.push(`"${key}" is a built-in action's key`)
      out.key = key
    }
    if (!partial || 'kind' in b) {
      const kind = String(b.kind ?? '') as BulkActionKind
      if (!BULK_ACTION_KINDS.includes(kind)) errs.push('kind must be update_fields or transition')
      out.kind = kind
    }
    if (!partial || 'config' in b) {
      const cfg = (b.config && typeof b.config === 'object' ? b.config : null) as Record<
        string,
        unknown
      > | null
      const kind = (out.kind ?? b.kind) as string
      if (!cfg) errs.push('config is required')
      else if (kind === 'transition') {
        if (!String(cfg.transition_label ?? '').trim())
          errs.push('config.transition_label is required')
        out.config = JSON.stringify({ transition_label: String(cfg.transition_label).trim() })
      } else if (kind === 'update_fields') {
        const set =
          cfg.set && typeof cfg.set === 'object' ? (cfg.set as Record<string, unknown>) : null
        if (!set || Object.keys(set).length === 0) errs.push('config.set needs at least one field')
        out.config = JSON.stringify({ set: set ?? {} })
      }
    }
    if ('guard' in b)
      out.guard = b.guard == null ? null : JSON.stringify(normalizeGuard(b.guard) ?? [])
    if ('access' in b) out.access = JSON.stringify(normalizeAccess(b.access))
    if ('require_reason' in b) out.require_reason = b.require_reason === true
    if ('confirm_text' in b)
      out.confirm_text =
        String(b.confirm_text ?? '')
          .trim()
          .slice(0, 500) || null
    if ('icon' in b)
      out.icon =
        String(b.icon ?? '')
          .trim()
          .slice(0, 60) || null
    if ('variant' in b) out.variant = b.variant === 'danger' ? 'danger' : 'default'
    if ('is_active' in b) out.is_active = b.is_active !== false
    if ('sort' in b) out.sort = Number.isFinite(Number(b.sort)) ? Number(b.sort) : 0
    return { out, errs }
  }

  app.post('/bulk-actions/defs', { preHandler: [requireAdmin] }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>
    const collection = String(b.collection ?? '').trim()
    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    const { out, errs } = validate(b, false)
    if (errs.length) return reply.code(400).send({ error: errs.join('; ') })
    const dupe = await db('nivaro_bulk_actions').where({ collection, key: out.key }).first('id')
    if (dupe)
      return reply.code(409).send({ error: `An action with key "${out.key}" already exists` })
    const maxSort = await db('nivaro_bulk_actions').where({ collection }).max('sort as m').first()
    const sort = 'sort' in out ? Number(out.sort) : Number(maxSort?.m ?? -1) + 1
    await db('nivaro_bulk_actions').insert({
      collection,
      ...out,
      sort,
      access: out.access ?? JSON.stringify({ mode: 'everyone' }),
      created_by: req.user?.id ?? null
    })
    const row = await db('nivaro_bulk_actions').where({ collection, key: out.key }).first()
    await logActivity({
      action: 'bulk-action-create',
      user: req.user?.id,
      collection,
      comment: `${out.label} (${out.key})`,
      req
    })
    return reply.code(201).send({ data: formatRow(row as Record<string, unknown>) })
  })

  app.patch<{ Params: { id: string } }>(
    '/bulk-actions/defs/:id',
    { preHandler: [requireAdmin] },
    async (req, reply) => {
      const existing = await db('nivaro_bulk_actions').where({ id: req.params.id }).first()
      if (!existing || existing.kind === 'builtin')
        return reply.code(404).send({ error: 'Not found' })
      const b = (req.body ?? {}) as Record<string, unknown>
      // config validation needs the kind — fall back to the stored one
      const { out, errs } = validate({ ...b, kind: b.kind ?? existing.kind }, true)
      if (!('kind' in b)) delete out.kind
      if (errs.length) return reply.code(400).send({ error: errs.join('; ') })
      if (out.key && out.key !== existing.key) {
        const dupe = await db('nivaro_bulk_actions')
          .where({ collection: existing.collection, key: out.key })
          .first('id')
        if (dupe)
          return reply.code(409).send({ error: `An action with key "${out.key}" already exists` })
      }
      if (Object.keys(out).length > 0)
        await db('nivaro_bulk_actions').where({ id: req.params.id }).update(out)
      const row = await db('nivaro_bulk_actions').where({ id: req.params.id }).first()
      await logActivity({
        action: 'bulk-action-update',
        user: req.user?.id,
        collection: String(existing.collection),
        comment: `${row?.label} (${row?.key}): ${Object.keys(out).join(', ')}`,
        req
      })
      return { data: formatRow(row as Record<string, unknown>) }
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/bulk-actions/defs/:id',
    { preHandler: [requireAdmin] },
    async (req, reply) => {
      const existing = await db('nivaro_bulk_actions').where({ id: req.params.id }).first()
      if (!existing || existing.kind === 'builtin')
        return reply.code(404).send({ error: 'Not found' })
      await db('nivaro_bulk_actions').where({ id: req.params.id }).del()
      await logActivity({
        action: 'bulk-action-delete',
        user: req.user?.id,
        collection: String(existing.collection),
        comment: `${existing.label} (${existing.key})`,
        req
      })
      return { data: { ok: true } }
    }
  )
}
