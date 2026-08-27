import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { listUsers } from '../services/users.js'

function parseJson(val: unknown): unknown {
  if (val == null) return null
  if (typeof val !== 'string') return val
  try {
    return JSON.parse(val)
  } catch {
    return null
  }
}

/** team_id → { dimension: values[] } for a set of teams, one query. */
async function loadTeamScopes(teamIds: number[]): Promise<Map<number, Record<string, unknown[]>>> {
  const out = new Map<number, Record<string, unknown[]>>()
  if (teamIds.length === 0) return out
  const rows = (await db('nivaro_team_scopes').whereIn('team_id', teamIds).select(
    'team_id',
    'dimension',
    'values'
  )) as Array<{ team_id: number; dimension: string; values: string }>
  for (const r of rows) {
    const vals = parseJson(r.values)
    if (!Array.isArray(vals) || vals.length === 0) continue
    const entry = out.get(r.team_id) ?? {}
    entry[r.dimension] = vals
    out.set(r.team_id, entry)
  }
  return out
}

/**
 * User groups (#682) — named user sets (migration 278: nivaro_user_groups +
 * nivaro_user_group_members). Groups are mentionable in comments by slug
 * ("@field-techs" — see resolveMentions in routes/comments.ts, group beats
 * role on a handle collision) and admin-managed at /user-groups.
 */

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200)
}

interface GroupRow {
  id: number
  name: string
  slug: string
  description: string | null
  created_by: string | null
  created_at: Date | string | null
}

export async function userGroupsRoutes(app: FastifyInstance) {
  // Everyone can see the roster — group names already reach every user via
  // mention autocomplete; management is admin-only below.
  app.get('/', { preHandler: requireAuth }, async (_req, reply) => {
    const rows = (await db('nivaro_user_groups as g')
      .leftJoin('nivaro_user_group_members as m', 'm.group_id', 'g.id')
      .groupBy('g.id', 'g.name', 'g.slug', 'g.description', 'g.created_by', 'g.created_at')
      .orderBy('g.name')
      .select('g.id', 'g.name', 'g.slug', 'g.description', 'g.created_by', 'g.created_at')
      .count('m.id as member_count')) as Array<GroupRow & { member_count: number | string }>
    const scopes = await loadTeamScopes(rows.map((r) => r.id))
    return reply.send({
      data: rows.map((r) => ({
        ...r,
        member_count: Number(r.member_count ?? 0),
        scopes: scopes.get(r.id) ?? {}
      }))
    })
  })

  // ─── Team scopes (scoped teams) ───────────────────────────────────────────
  // Optional per-dimension allowances — dimensions AND together, values OR
  // within one dimension, no row = unrestricted. Advisory only: pickers rank
  // by them, nothing enforces them.
  app.put<{ Params: { id: string }; Body: { scopes?: Record<string, unknown> } }>(
    '/:id/scopes',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const team = await db('nivaro_user_groups').where({ id }).first('id', 'name')
      if (!team) return reply.code(404).send({ error: 'Team not found' })
      const body = req.body?.scopes ?? {}
      if (typeof body !== 'object' || Array.isArray(body)) {
        return reply.code(400).send({ error: 'scopes must be an object of dimension → values[]' })
      }
      const dims = (await db('nivaro_scope_dimensions')
        .where({ is_active: true })
        .pluck('name')) as string[]
      const valid = new Set(dims)
      const clean: Record<string, unknown[]> = {}
      for (const [dim, vals] of Object.entries(body)) {
        if (!valid.has(dim)) {
          return reply.code(400).send({ error: `Unknown scope dimension "${dim}"` })
        }
        if (!Array.isArray(vals)) {
          return reply.code(400).send({ error: `Values for "${dim}" must be an array` })
        }
        const filtered = vals.filter((v) => v !== null && v !== undefined && v !== '')
        if (filtered.length > 0) clean[dim] = filtered.slice(0, 200)
      }
      // Replace-all: rows absent from the payload are deleted (= unrestricted).
      await db('nivaro_team_scopes').where({ team_id: id }).delete()
      for (const [dim, vals] of Object.entries(clean)) {
        await db('nivaro_team_scopes').insert({
          team_id: id,
          dimension: dim,
          values: JSON.stringify(vals)
        })
      }
      await logActivity({
        action: 'user-group-scopes',
        user: req.user!.id,
        collection: 'nivaro_user_groups',
        item: String(id),
        comment:
          Object.keys(clean).length === 0
            ? 'scopes cleared'
            : Object.entries(clean)
                .map(([d, v]) => `${d}: ${v.length} value(s)`)
                .join(', '),
        req
      })
      const scopes = await loadTeamScopes([id])
      return reply.send({ data: { scopes: scopes.get(id) ?? {} } })
    }
  )

  /**
   * Roster candidates ranked by the team's scope: people whose restrict-mode
   * User Scopes OVERLAP the team's values on every scoped dimension rank
   * first, unrestricted people next, mismatches last (still addable — the
   * ranking is advice, not a gate). A user with no restriction on a dimension
   * counts as covering all of it.
   */
  app.get<{ Params: { id: string }; Querystring: { search?: string } }>(
    '/:id/candidates',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const team = await db('nivaro_user_groups').where({ id }).first('id')
      if (!team) return reply.code(404).send({ error: 'Team not found' })
      const search = String(req.query.search ?? '').trim()
      const teamScopes = (await loadTeamScopes([id])).get(id) ?? {}
      const scopedDims = Object.keys(teamScopes)

      const { data: users } = await listUsers({
        limit: scopedDims.length > 0 ? 120 : 50,
        search: search || undefined,
        sort: 'first_name'
      })
      if (scopedDims.length === 0) {
        return reply.send({ data: { ranked: false, users } })
      }

      const dimLabels = new Map(
        ((await db('nivaro_scope_dimensions')
          .whereIn('name', scopedDims)
          .select('name', 'label')) as Array<{ name: string; label: string }>).map((d) => [
          d.name,
          d.label
        ])
      )
      const restrictRows = (await db('nivaro_user_scopes')
        .whereIn(
          'user',
          users.map((u: { id: string }) => u.id)
        )
        .where({ mode: 'restrict' })
        .whereIn('dimension', scopedDims)
        .select('user', 'dimension', 'values')) as Array<{
        user: string
        dimension: string
        values: string
      }>
      const byUser = new Map<string, Map<string, Set<string>>>()
      for (const r of restrictRows) {
        const vals = parseJson(r.values)
        if (!Array.isArray(vals)) continue
        const m = byUser.get(String(r.user).toUpperCase()) ?? new Map<string, Set<string>>()
        m.set(r.dimension, new Set(vals.map(String)))
        byUser.set(String(r.user).toUpperCase(), m)
      }

      type Tier = 'match' | 'unrestricted' | 'mismatch'
      const classified = users.map((u: { id: string }) => {
        const mine = byUser.get(String(u.id).toUpperCase())
        let explicitMatch = false
        const mismatchDims: string[] = []
        for (const dim of scopedDims) {
          const teamVals = new Set((teamScopes[dim] ?? []).map(String))
          const userVals = mine?.get(dim)
          if (!userVals) continue // unrestricted on this dimension = covers it
          const overlap = [...userVals].some((v) => teamVals.has(v))
          if (overlap) explicitMatch = true
          else mismatchDims.push(dimLabels.get(dim) ?? dim)
        }
        const tier: Tier =
          mismatchDims.length > 0 ? 'mismatch' : explicitMatch ? 'match' : 'unrestricted'
        return { ...u, scope_tier: tier, scope_mismatch: mismatchDims }
      })
      const order: Record<Tier, number> = { match: 0, unrestricted: 1, mismatch: 2 }
      classified.sort(
        (a: { scope_tier: Tier }, b: { scope_tier: Tier }) =>
          order[a.scope_tier] - order[b.scope_tier]
      )
      return reply.send({ data: { ranked: true, users: classified.slice(0, 60) } })
    }
  )

  app.post<{ Body: { name?: string; slug?: string; description?: string } }>(
    '/',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const name = String(req.body?.name ?? '').trim()
      if (!name) return reply.code(400).send({ error: 'name is required' })
      const slug = slugify(String(req.body?.slug ?? '').trim() || name)
      if (!slug) return reply.code(400).send({ error: 'Could not derive a slug from that name' })

      const existing = await db('nivaro_user_groups').where({ slug }).first('id')
      if (existing) {
        return reply.code(409).send({ error: `A group with slug "${slug}" already exists` })
      }

      await db('nivaro_user_groups').insert({
        name: name.slice(0, 200),
        slug,
        description: req.body?.description ? String(req.body.description) : null,
        created_by: req.user!.id,
        created_at: new Date()
      })
      // Insert-then-select (MSSQL — .returning('id') yields an object on this stack).
      const row = (await db('nivaro_user_groups').where({ slug }).first()) as GroupRow

      await logActivity({
        action: 'user-group-create',
        user: req.user!.id,
        collection: 'nivaro_user_groups',
        item: String(row.id),
        comment: `${name} (@${slug})`,
        req
      })
      return reply.code(201).send({ data: { ...row, member_count: 0 } })
    }
  )

  app.patch<{
    Params: { id: string }
    Body: { name?: string; slug?: string; description?: string | null }
  }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number(req.params.id)
    const row = (await db('nivaro_user_groups').where({ id }).first()) as GroupRow | undefined
    if (!row) return reply.code(404).send({ error: 'Group not found' })

    const patch: Record<string, unknown> = {}
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim()
      if (!name) return reply.code(400).send({ error: 'name cannot be empty' })
      patch.name = name.slice(0, 200)
    }
    if (req.body?.slug !== undefined) {
      const slug = slugify(String(req.body.slug))
      if (!slug) return reply.code(400).send({ error: 'slug cannot be empty' })
      if (slug !== row.slug) {
        const clash = await db('nivaro_user_groups').where({ slug }).first('id')
        if (clash) {
          return reply.code(409).send({ error: `A group with slug "${slug}" already exists` })
        }
      }
      patch.slug = slug
    }
    if (req.body?.description !== undefined) {
      patch.description = req.body.description ? String(req.body.description) : null
    }
    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: 'Nothing to update' })
    }

    await db('nivaro_user_groups').where({ id }).update(patch)
    const updated = (await db('nivaro_user_groups').where({ id }).first()) as GroupRow
    await logActivity({
      action: 'user-group-update',
      user: req.user!.id,
      collection: 'nivaro_user_groups',
      item: String(id),
      comment: JSON.stringify(Object.keys(patch)),
      req
    })
    return reply.send({ data: updated })
  })

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const row = (await db('nivaro_user_groups').where({ id }).first()) as GroupRow | undefined
      if (!row) return reply.code(404).send({ error: 'Group not found' })
      await db('nivaro_user_groups').where({ id }).del() // members CASCADE
      await logActivity({
        action: 'user-group-delete',
        user: req.user!.id,
        collection: 'nivaro_user_groups',
        item: String(id),
        comment: `${row.name} (@${row.slug})`,
        req
      })
      return reply.send({ data: { deleted: true } })
    }
  )

  // Directory-safe member listing — id/name/email only, mirrors the
  // DIRECTORY_USER_COLS posture of GET /users for non-admins.
  app.get<{ Params: { id: string } }>(
    '/:id/members',
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = Number(req.params.id)
      const row = await db('nivaro_user_groups').where({ id }).first('id')
      if (!row) return reply.code(404).send({ error: 'Group not found' })
      const members = (await db('nivaro_user_group_members as m')
        .join('nivaro_users as u', 'u.id', 'm.user')
        .where('m.group_id', id)
        .where('u.is_redacted', false)
        .orderBy(['u.first_name', 'u.last_name'])
        .select('u.id', 'u.first_name', 'u.last_name', 'u.email')) as Array<{
        id: string
        first_name: string | null
        last_name: string | null
        email: string
      }>
      return reply.send({ data: members })
    }
  )

  app.post<{ Params: { id: string }; Body: { user_ids?: unknown } }>(
    '/:id/members',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const row = (await db('nivaro_user_groups').where({ id }).first()) as GroupRow | undefined
      if (!row) return reply.code(404).send({ error: 'Group not found' })

      const raw = Array.isArray(req.body?.user_ids) ? req.body.user_ids : []
      const userIds = [...new Set(raw.map(String).filter(Boolean))].slice(0, 200)
      if (userIds.length === 0) return reply.code(400).send({ error: 'user_ids is required' })

      const existing = (await db('nivaro_user_group_members')
        .where({ group_id: id })
        .whereIn('user', userIds)
        .pluck('user')) as string[]
      const existingSet = new Set(existing.map(String))
      const validUsers = (await db('nivaro_users').whereIn('id', userIds).pluck('id')) as string[]
      const validSet = new Set(validUsers.map(String))

      let added = 0
      for (const userId of userIds) {
        if (existingSet.has(userId) || !validSet.has(userId)) continue
        try {
          await db('nivaro_user_group_members').insert({ group_id: id, user: userId })
          added++
        } catch {
          // Unique-pair race — already a member, fine.
        }
      }

      await logActivity({
        action: 'user-group-members-add',
        user: req.user!.id,
        collection: 'nivaro_user_groups',
        item: String(id),
        comment: `${added} member(s) added to ${row.name}`,
        req
      })
      return reply.send({ data: { added, skipped: userIds.length - added } })
    }
  )

  app.delete<{ Params: { id: string; userId: string } }>(
    '/:id/members/:userId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      const removed = await db('nivaro_user_group_members')
        .where({ group_id: id, user: req.params.userId })
        .del()
      if (!removed) return reply.code(404).send({ error: 'Membership not found' })
      await logActivity({
        action: 'user-group-members-remove',
        user: req.user!.id,
        collection: 'nivaro_user_groups',
        item: String(id),
        comment: `removed ${req.params.userId}`,
        req
      })
      return reply.send({ data: { removed: true } })
    }
  )
}
