import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  bustScopeDimensionCache,
  bustScopePathCache,
  bustUserScopeCache,
  describeUserScopes,
  describeHops,
  listScopeDimensions,
  scopeHopsFor
} from '../services/user-scopes.js'

/**
 * User Scopes routes.
 *
 * /scope-dimensions        — admin CRUD for the dimension registry
 * /scope-dimensions/:id/coverage — live auto-resolution preview per collection
 * /users/me/scopes         — the caller's defaults + restrictions (+ dimension list)
 * PUT /users/me/scopes/:dimension        — self-edit DEFAULT values only
 * GET/PUT /user-scopes/:userId           — admin: both modes for any user
 */

const MODE = new Set(['default', 'restrict'])

function sanitizeValues(raw: unknown): Array<string | number> {
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, 100)
    .map((v) => (typeof v === 'number' ? v : String(v).slice(0, 200)))
    .filter((v) => v !== '')
}

export async function userScopesRoutes(app: FastifyInstance) {
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
        const status = !hops
          ? 'unreachable'
          : override && override.length > 0
            ? 'override'
            : 'auto'
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

  app.get('/users/me/scopes', { preHandler: requireAuth }, async (req) => {
    return { data: await describeUserScopes(req.user!.id) }
  })

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
      bustUserScopeCache(req.user!.id)
      return reply.send({ data: { saved: true, values } })
    }
  )

  // ── Admin: any user, both modes ─────────────────────────────────────────────

  app.get<{ Params: { userId: string } }>(
    '/user-scopes/:userId',
    { preHandler: requireAdmin },
    async (req) => {
      return { data: await describeUserScopes(req.params.userId) }
    }
  )

  /** Blast radius for a proposed restrict-scope change: row counts on the
   *  biggest routed collections, current allowance vs proposed. The number an
   *  admin needs BEFORE saving — a wrong scope is a quiet total denial. */
  app.post<{
    Params: { userId: string }
    Body: { dimension?: string; values?: unknown }
  }>('/user-scopes/:userId/impact', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body ?? {}
    const dims = await listScopeDimensions(false)
    const dim = dims.find((d) => d.name === b.dimension)
    if (!dim) return reply.code(404).send({ error: 'Unknown dimension' })
    const proposed = sanitizeValues(b.values)

    const { scopeHopsFor, applyScopeHops, getUserScopes } = await import('../services/user-scopes.js')
    // Current restrict allowance for this dimension (if any).
    const currentRow = (await getUserScopes(req.params.userId)).find(
      (r) => r.dimension === dim.name && r.mode === 'restrict'
    )
    const current: Array<string | number> = currentRow?.values ?? []

    // Candidate collections: the biggest business tables that actually route
    // to this dimension — where the change will be FELT.
    const counts = (await db.raw(`
      SELECT t.name AS table_name, SUM(p.row_count) AS rows
      FROM sys.tables t
      JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
      WHERE t.name NOT LIKE 'nivaro[_]%' AND t.name NOT LIKE 'directus[_]%' AND t.name NOT LIKE 'staging[_]%'
      GROUP BY t.name
      ORDER BY SUM(p.row_count) DESC
    `)) as Array<{ table_name: string; rows: number }>
    const registered = new Set(
      ((await db('nivaro_collections').select('collection')) as Array<{ collection: string }>).map(
        (c) => c.collection.toLowerCase()
      )
    )
    // Workflow-bound collections lead — they're the units admins think in —
    // then the biggest remaining tables fill out the picture.
    const bound = (await db('nivaro_workflow_bindings').distinct('collection')) as Array<{
      collection: string
    }>
    const countByName = new Map(counts.map((c) => [c.table_name.toLowerCase(), Number(c.rows)]))
    const ordered: Array<{ table_name: string; rows: number }> = []
    const seenTables = new Set<string>()
    for (const bc of bound) {
      const key = bc.collection.toLowerCase()
      if (seenTables.has(key) || !countByName.has(key)) continue
      seenTables.add(key)
      ordered.push({ table_name: bc.collection, rows: countByName.get(key) ?? 0 })
    }
    for (const c of counts) {
      if (seenTables.has(c.table_name.toLowerCase())) continue
      seenTables.add(c.table_name.toLowerCase())
      ordered.push(c)
    }
    const impact: Array<{ collection: string; total: number; current: number; proposed: number }> = []
    for (const c of ordered) {
      if (impact.length >= 5) break
      if (!registered.has(c.table_name.toLowerCase())) continue
      const hops = await scopeHopsFor(dim, c.table_name)
      if (hops === null) continue
      const countWith = async (allowed: Array<string | number>): Promise<number> => {
        if (allowed.length === 0) return Number(c.rows) // no restriction = everything
        const q = db(c.table_name).count({ n: '*' })
        applyScopeHops(q, c.table_name, hops, allowed)
        const row = (await q.first()) as { n?: number } | undefined
        return Number(row?.n ?? 0)
      }
      try {
        impact.push({
          collection: c.table_name,
          total: Number(c.rows),
          current: await countWith(current),
          proposed: await countWith(proposed)
        })
      } catch {
        // a collection whose hops fail to compile is skipped, not fatal
      }
    }
    return { data: { dimension: dim.name, current_values: current, proposed_values: proposed, impact } }
  })

  app.put<{
    Params: { userId: string }
    Body: { dimension?: string; mode?: string; values?: unknown }
  }>('/user-scopes/:userId', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body ?? {}
    const mode = String(b.mode ?? '')
    if (!MODE.has(mode)) return reply.code(400).send({ error: "mode must be 'default' or 'restrict'" })
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
    await logActivity({
      action: 'update',
      collection: 'nivaro_user_scopes',
      item: `${req.params.userId}:${dim.name}:${mode}`,
      user: req.user?.id,
      req
    })
    return reply.send({ data: { saved: true, values } })
  })
}
