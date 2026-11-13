import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { runPersonalConfigWrite } from '../db/config-epoch.js'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { scopeChangeComment } from '../services/person-access-changes.js'
import {
  bustScopeDimensionCache,
  bustScopePathCache,
  bustUserScopeCache,
  describeHops,
  describeUserScopes,
  listScopeDimensions,
  resolveScopeLabelsForUsers,
  scopeHopsFor
} from '../services/user-scopes.js'

/**
 * User Scopes routes.
 *
 * /scope-dimensions        — admin CRUD for the dimension registry
 * /scope-dimensions/:id/coverage — live auto-resolution preview per collection
 * /users/me/scopes         — the caller's defaults + restrictions (+ dimension list)
 *                            (also GET /user-scopes/mine)
 * PUT /users/me/scopes/:dimension        — self-edit DEFAULT values only
 * GET/PUT /user-scopes/:userId           — admin: both modes for any user (uuid, else 400)
 */

const MODE = new Set(['default', 'restrict'])

function sanitizeValues(raw: unknown): Array<string | number> {
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, 100)
    .map((v) => (typeof v === 'number' ? v : String(v).slice(0, 200)))
    .filter((v) => v !== '')
}

let rawSqlCheckRegistered = false

export async function userScopesRoutes(app: FastifyInstance) {
  // #770 — raw SQL that reads scoped tables without carrying the scopes.
  if (!rawSqlCheckRegistered) {
    rawSqlCheckRegistered = true
    const { registerReadinessCheck } = await import('../services/readiness.js')
    registerReadinessCheck({
      id: 'raw-sql-scope-coverage',
      label: 'Raw SQL that people run applies User Scopes',
      group: 'Security',
      description:
        'User Scopes are enforced by the items service; custom queries are raw SQL. A query a page, report or widget runs must carry, in its scope params, every scope dimension that reaches the tables it reads — otherwise a restricted person sees rows outside their scope.',
      run: async () => {
        const { scopeCoverage } = await import('../services/scope-coverage.js')
        const r = await scopeCoverage()
        if (r.dimensions.length === 0)
          return { status: 'skip', detail: 'No active scope dimensions.' }
        const leaks = r.queries.filter((q) => q.status === 'leak')
        const detail = `${r.totals.queries} enabled quer${r.totals.queries === 1 ? 'y' : 'ies'}: ${leaks.length} run by a page or widget without the scopes their tables need, ${r.totals.gaps} more with the same gap that nothing runs; ${r.totals.routes_undeclared} extension read route(s) have not declared whether they apply scopes.`
        if (leaks.length === 0) return { status: 'pass', detail }
        return {
          status: 'warn',
          detail,
          blockers: leaks.slice(0, 20).map(
            (q) =>
              `${q.slug}: add scope params for ${q.missing.map((m) => m.label).join(', ')} (used by ${q.used_by
                .slice(0, 3)
                .map((d) => d.name)
                .join(', ')})`
          )
        }
      }
    })
  }

  // #770 — the report behind the readiness check, for /scope-dimensions.
  app.get<{ Querystring: { fresh?: string } }>(
    '/scope-dimensions/raw-sql-coverage',
    { preHandler: requireAdmin },
    async (req) => {
      const { scopeCoverage } = await import('../services/scope-coverage.js')
      return { data: await scopeCoverage(req.query.fresh === '1') }
    }
  )

  // ── Dimension registry (admin) ──────────────────────────────────────────────

  app.get('/scope-dimensions', { preHandler: requireAuth }, async () => {
    const dims = await listScopeDimensions(false)
    return { data: dims }
  })

  app.post<{
    Body: {
      name?: string
      label?: string
      target_collection?: string
      display_field?: string | null
      options_sort?: string | null
      overrides?: Record<string, string[]> | null
      exclusions?: string[] | null
      strict?: boolean
      is_active?: boolean
    }
  }>('/scope-dimensions', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body ?? {}
    const name = String(b.name ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .slice(0, 60)
    if (!name || !b.target_collection) {
      return reply.code(400).send({ error: 'name and target_collection are required' })
    }
    await db('nivaro_scope_dimensions').insert({
      name,
      label: String(b.label ?? name).slice(0, 120),
      target_collection: String(b.target_collection).slice(0, 255),
      display_field: b.display_field ?? null,
      options_sort: b.options_sort ?? null,
      overrides: b.overrides ? JSON.stringify(b.overrides) : null,
      exclusions: b.exclusions ? JSON.stringify(b.exclusions) : null,
      strict: !!b.strict,
      is_active: b.is_active !== false,
      created_at: new Date()
    })
    bustScopeDimensionCache()
    await logActivity({
      action: 'create',
      collection: 'nivaro_scope_dimensions',
      item: name,
      user: req.user?.id,
      req
    })
    const row = await db('nivaro_scope_dimensions').where({ name }).first()
    return reply.send({ data: row })
  })

  app.patch<{
    Params: { id: string }
    Body: Record<string, unknown>
  }>('/scope-dimensions/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number(req.params.id)
    const existing = await db('nivaro_scope_dimensions').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    const b = req.body ?? {}
    const patch: Record<string, unknown> = {}
    if (b.label !== undefined) patch.label = String(b.label).slice(0, 120)
    if (b.target_collection !== undefined)
      patch.target_collection = String(b.target_collection).slice(0, 255)
    if (b.display_field !== undefined) patch.display_field = b.display_field
    if (b.options_sort !== undefined) patch.options_sort = b.options_sort
    if (b.overrides !== undefined)
      patch.overrides = b.overrides ? JSON.stringify(b.overrides) : null
    if (b.exclusions !== undefined)
      patch.exclusions = b.exclusions ? JSON.stringify(b.exclusions) : null
    if (b.strict !== undefined) patch.strict = !!b.strict
    if (b.is_active !== undefined) patch.is_active = !!b.is_active
    await db('nivaro_scope_dimensions').where({ id }).update(patch)
    bustScopeDimensionCache()
    await logActivity({
      action: 'update',
      collection: 'nivaro_scope_dimensions',
      item: String(id),
      user: req.user?.id,
      req
    })
    return reply.send({ data: await db('nivaro_scope_dimensions').where({ id }).first() })
  })

  app.delete<{ Params: { id: string } }>(
    '/scope-dimensions/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const existing = await db('nivaro_scope_dimensions').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })
      await db('nivaro_scope_dimensions').where({ id }).del()
      await db('nivaro_user_scopes').where({ dimension: existing.name }).del()
      bustScopeDimensionCache()
      bustUserScopeCache()
      await logActivity({
        action: 'delete',
        collection: 'nivaro_scope_dimensions',
        item: String(id),
        user: req.user?.id,
        req
      })
      return reply.send({ data: { deleted: true } })
    }
  )

  // Live coverage preview: how the dimension resolves on every business collection.
  app.get<{ Params: { id: string } }>(
    '/scope-dimensions/:id/coverage',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const dims = await listScopeDimensions(false)
      const dim = dims.find((d) => d.id === id)
      if (!dim) return reply.code(404).send({ error: 'Not found' })
      bustScopePathCache() // preview always reflects live relations
      const collections = (await db('nivaro_collections')
        .whereNot('collection', 'like', 'nivaro\\_%')
        .orderBy('collection')
        .pluck('collection')) as string[]
      const rows = []
      for (const c of collections) {
        if (c === dim.target_collection) {
          rows.push({ collection: c, status: 'self', route: 'own id', hops: [] })
          continue
        }
        if (dim.exclusions?.includes(c)) {
          rows.push({ collection: c, status: 'excluded', route: null, hops: null })
          continue
        }
        const override = dim.overrides?.[c]
        const hops = await scopeHopsFor(dim, c)
        const status = !hops ? 'unreachable' : override && override.length > 0 ? 'override' : 'auto'
        rows.push({
          collection: c,
          status,
          route: hops ? describeHops(hops) : null,
          hops
        })
      }
      return reply.send({ data: rows })
    }
  )

  // ── Own scopes ──────────────────────────────────────────────────────────────

  const ownScopes = async (req: FastifyRequest) => {
    // Read fresh: a self-edit made on another replica does not move the tenant-wide config
    // epoch (below), so this process's 60 s copy of the person's rows may be older than it.
    bustUserScopeCache(req.user!.id)
    const described = await describeUserScopes(req.user!.id)
    // Army 6 D8 / M36: an administrator who also carries a User Scope gets
    // scoped reports, exports and timelines like anyone else — say so. `admin`
    // and `access_scope_label` ("National", "Zone 1, Zone 2") are additive; the
    // label is the restricted values' display names, only worked out for admins.
    const admin = req.isAdmin === true
    let accessScopeLabel: string | null = null
    if (admin) {
      const dims = Object.keys(described.restricted ?? {}).filter(
        (d) => (described.restricted[d] ?? []).length > 0
      )
      if (dims.length > 0) {
        const labels = await resolveScopeLabelsForUsers([req.user!.id], dims).catch(
          () => new Map<string, Map<string, string[]>>()
        )
        const mine = labels.get(String(req.user!.id))
        const names = dims.flatMap((d) => mine?.get(d) ?? [])
        accessScopeLabel = names.length > 0 ? [...new Set(names)].join(', ') : null
      }
    }
    return { data: { ...described, admin, access_scope_label: accessScopeLabel } }
  }
  app.get('/users/me/scopes', { preHandler: requireAuth }, ownScopes)
  // The spelling callers guess (army 5 b11-N9: a service account's GET /user-scopes/mine
  // reached the admin route as userId "mine" and answered 500 with the SQL text). Static,
  // so it wins over /user-scopes/:userId; any signed-in caller reads their own.
  app.get('/user-scopes/mine', { preHandler: requireAuth }, ownScopes)

  // Self-edit is DEFAULTS ONLY — restrictions are admin-set.
  app.put<{ Params: { dimension: string }; Body: { values?: unknown } }>(
    '/users/me/scopes/:dimension',
    { preHandler: requireAuth },
    async (req, reply) => {
      const dims = await listScopeDimensions()
      const dim = dims.find((d) => d.name === req.params.dimension)
      if (!dim) return reply.code(404).send({ error: 'Unknown dimension' })
      const values = sanitizeValues(req.body?.values)
      const where = { user: req.user!.id, dimension: dim.name, mode: 'default' }
      // A person's own DEFAULT filter (never a restriction): it changes nothing anyone else
      // reads, so it does not move the tenant-wide config epoch — which made every replica
      // drop every metadata cache and every open form re-read its definition (19 times in
      // 34 minutes at the 2026-10-28 demo). Their own copies are refreshed here and on the
      // fresh GET above.
      await runPersonalConfigWrite(['nivaro_user_scopes'], async () => {
        const existing = await db('nivaro_user_scopes').where(where).first()
        if (values.length === 0) {
          if (existing) await db('nivaro_user_scopes').where({ id: existing.id }).del()
        } else if (existing) {
          await db('nivaro_user_scopes')
            .where({ id: existing.id })
            .update({ values: JSON.stringify(values), updated_at: new Date() })
        } else {
          await db('nivaro_user_scopes').insert({
            ...where,
            values: JSON.stringify(values),
            updated_at: new Date()
          })
        }
      })
      bustUserScopeCache(req.user!.id)
      return reply.send({ data: { saved: true, values } })
    }
  )

  // ── Admin: any user, both modes ─────────────────────────────────────────────

  /** Admin routes that name a person: an administrator, and a uuid (else 400, b11-N9). */
  const adminUserId = [requireAdmin, requireUuidUserId]

  // Bulk add / remove of RESTRICTED values on one dimension for many people
  // (Rob 2026-11-10, zones). Never touches defaults, other dimensions, or values
  // not named; see services/user-scopes-bulk.ts for the cases it refuses.
  app.post<{
    Body: {
      user_ids?: unknown
      dimension?: string
      op?: string
      values?: unknown
      preview?: boolean
      allow_empty?: boolean
    }
  }>('/user-scopes/bulk', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body ?? {}
    const op = String(b.op ?? '')
    if (op !== 'add' && op !== 'remove')
      return reply.code(400).send({ error: "op must be 'add' or 'remove'" })
    const userIds = Array.isArray(b.user_ids)
      ? b.user_ids.map((u) => String(u).trim()).filter((u) => USER_ID_RE.test(u))
      : []
    if (userIds.length === 0)
      return reply.code(400).send({ error: 'Pick at least one person', code: 'NO_PEOPLE' })
    if (userIds.length > 500)
      return reply.code(400).send({ error: 'At most 500 people at once', code: 'TOO_MANY_PEOPLE' })
    const values = sanitizeValues(b.values)
    if (values.length === 0)
      return reply.code(400).send({ error: 'Pick at least one value', code: 'NO_VALUES' })
    const dims = await listScopeDimensions(false)
    const dim = dims.find((d) => d.name === b.dimension)
    if (!dim) return reply.code(404).send({ error: 'Unknown dimension' })
    const ident = /^[A-Za-z_][A-Za-z0-9_]*$/
    const display = dim.display_field && ident.test(dim.display_field) ? dim.display_field : 'id'
    if (!ident.test(dim.target_collection))
      return reply.code(400).send({ error: 'The dimension’s collection cannot be read' })
    const { runBulkScopeChange } = await import('../services/user-scopes-bulk.js')
    const noun = String(dim.label ?? dim.name).toLowerCase()
    const result = await runBulkScopeChange(
      {
        userIds,
        dimension: dim.name,
        noun,
        op,
        values,
        preview: b.preview === true,
        allowEmpty: b.allow_empty === true
      },
      {
        users: async (ids) => {
          const rows = (await db('nivaro_users')
            .whereIn('id', ids)
            .select('id', 'first_name', 'last_name', 'email')) as Array<{
            id: string
            first_name: string | null
            last_name: string | null
            email: string | null
          }>
          return new Map(
            rows.map((r) => [
              String(r.id),
              `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email || String(r.id)
            ])
          )
        },
        restricted: async (ids, dimension) => {
          const rows = (await db('nivaro_user_scopes')
            .where({ dimension, mode: 'restrict' })
            .whereIn('user', ids)
            .select('user', 'values')) as Array<{ user: string; values: string | null }>
          const out = new Map<string, Array<string | number>>()
          for (const r of rows) {
            let v: unknown = []
            try {
              v = JSON.parse(r.values ?? '[]')
            } catch {
              v = []
            }
            out.set(String(r.user).toLowerCase(), sanitizeValues(v))
          }
          return out
        },
        labels: async (vals) => {
          const rows = (await db(dim.target_collection)
            .whereIn(
              'id',
              vals.map((v) => (typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : v))
            )
            .select('id', ...(display === 'id' ? [] : [display]))) as Array<Record<string, unknown>>
          return new Map(
            rows.map((r) => [String(r.id).toLowerCase(), String(r[display] ?? r.id)] as const)
          )
        },
        write: async (userId, dimension, next, before) => {
          const where = { user: userId, dimension, mode: 'restrict' }
          await db.transaction(async (trx) => {
            const existing = await trx('nivaro_user_scopes').where(where).first('id')
            if (next.length === 0) {
              if (existing) await trx('nivaro_user_scopes').where({ id: existing.id }).del()
            } else if (existing) {
              await trx('nivaro_user_scopes')
                .where({ id: existing.id })
                .update({ values: JSON.stringify(next), updated_at: new Date() })
            } else {
              await trx('nivaro_user_scopes').insert({
                ...where,
                values: JSON.stringify(next),
                updated_at: new Date()
              })
            }
          })
          bustUserScopeCache(userId)
          await logActivity({
            action: 'update',
            collection: 'nivaro_user_scopes',
            item: `${userId}:${dimension}:restrict`,
            user: req.user?.id,
            comment: `Bulk ${op} restricted ${noun}s: [${before.join(', ')}] → [${next.join(', ')}]`,
            req
          })
        }
      }
    )
    if (result.unknown_values.length > 0)
      return reply.code(400).send({
        error: `Not a ${noun}: ${result.unknown_values.join(', ')}`,
        code: 'UNKNOWN_VALUES',
        unknown_values: result.unknown_values
      })
    return {
      data: {
        preview: b.preview === true,
        dimension: dim.name,
        label: dim.label ?? dim.name,
        op,
        ...result
      }
    }
  })

  app.get<{ Params: { userId: string } }>(
    '/user-scopes/:userId',
    { preHandler: adminUserId },
    async (req) => {
      return { data: await describeUserScopes(req.params.userId) }
    }
  )

  /** Blast radius for a proposed restrict-scope change: row counts on the
   *  biggest routed collections, current allowance vs proposed. The number an
   *  admin needs BEFORE saving — a wrong scope is a quiet total denial.
   *  Collections run side by side under one time budget; `partial` names any
   *  the budget cut (services/user-scope-impact.ts). */
  app.post<{
    Params: { userId: string }
    Body: { dimension?: string; values?: unknown }
  }>('/user-scopes/:userId/impact', { preHandler: adminUserId }, async (req, reply) => {
    const b = req.body ?? {}
    const dims = await listScopeDimensions(false)
    const dim = dims.find((d) => d.name === b.dimension)
    if (!dim) return reply.code(404).send({ error: 'Unknown dimension' })
    const { computeScopeImpact } = await import('../services/user-scope-impact.js')
    const { clientGoneSignal } = await import('../services/read-gate.js')
    return {
      data: await computeScopeImpact(req.params.userId, dim, sanitizeValues(b.values), {
        who: req.user?.id ?? null,
        signal: clientGoneSignal(reply.raw)
      })
    }
  })

  app.put<{
    Params: { userId: string }
    Body: { dimension?: string; mode?: string; values?: unknown }
  }>('/user-scopes/:userId', { preHandler: adminUserId }, async (req, reply) => {
    const b = req.body ?? {}
    const mode = String(b.mode ?? '')
    if (!MODE.has(mode))
      return reply.code(400).send({ error: "mode must be 'default' or 'restrict'" })
    const dims = await listScopeDimensions(false)
    const dim = dims.find((d) => d.name === b.dimension)
    if (!dim) return reply.code(404).send({ error: 'Unknown dimension' })
    const values = sanitizeValues(b.values)
    const where = { user: req.params.userId, dimension: dim.name, mode }
    const existing = await db('nivaro_user_scopes').where(where).first()
    if (values.length === 0) {
      if (existing) await db('nivaro_user_scopes').where({ id: existing.id }).del()
    } else if (existing) {
      await db('nivaro_user_scopes')
        .where({ id: existing.id })
        .update({ values: JSON.stringify(values), updated_at: new Date() })
    } else {
      await db('nivaro_user_scopes').insert({
        ...where,
        values: JSON.stringify(values),
        updated_at: new Date()
      })
    }
    bustUserScopeCache(req.params.userId)
    // Say what changed (the person's Activity tab shows it under "Region restriction changed").
    const before = sanitizeValues(
      (() => {
        try {
          return typeof existing?.values === 'string'
            ? JSON.parse(existing.values)
            : existing?.values
        } catch {
          return []
        }
      })()
    )
    const changed = [
      ...values.filter((v) => !before.map(String).includes(String(v))),
      ...before.filter((v) => !values.map(String).includes(String(v)))
    ]
    const labels = new Map<string, string>()
    if (changed.length > 0 && changed.length <= 200) {
      const lf = dim.display_field ?? 'name'
      try {
        const rows = (await db(dim.target_collection)
          .whereIn('id', changed)
          .select('id', lf)) as Array<Record<string, unknown>>
        for (const r of rows) if (r[lf] != null) labels.set(String(r.id), String(r[lf]))
      } catch {
        /* the comment falls back to the ids */
      }
    }
    await logActivity({
      action: 'update',
      collection: 'nivaro_user_scopes',
      item: `${req.params.userId}:${dim.name}:${mode}`,
      user: req.user?.id,
      comment: scopeChangeComment(before, values, labels).slice(0, 1000) || undefined,
      req
    })
    return reply.send({ data: { saved: true, values } })
  })
}

const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A person's id is a uuid: anything else is a 400, never a SQL conversion error (b11-N9). */
async function requireUuidUserId(req: FastifyRequest, reply: FastifyReply) {
  const userId = (req.params as { userId?: string } | undefined)?.userId
  if (!USER_ID_RE.test(String(userId ?? ''))) {
    return reply.code(400).send({ error: 'userId must be a user id', code: 'INVALID_USER_ID' })
  }
}
