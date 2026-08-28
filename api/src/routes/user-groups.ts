import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { resolveStateOwnersBatch, type OwnerResolutionRequest } from '../services/pipeline-engine.js'
import { computeStatusBatch } from './sla.js'
import { getLabels } from '../services/queues.js'
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

  // ─── Team overview: ownership footprint, roster health, throughput ────────
  app.get<{ Params: { id: string } }>(
    '/:id/overview',
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = Number(req.params.id)
      const team = await db('nivaro_user_groups').where({ id }).first()
      if (!team) return reply.code(404).send({ error: 'Team not found' })

      const memberRows = (await db('nivaro_user_group_members as m')
        .join('nivaro_users as u', 'u.id', 'm.user')
        .where('m.group_id', id)
        .select(
          'u.id',
          'u.first_name',
          'u.last_name',
          'u.email',
          'u.title',
          'u.department',
          'u.status',
          'u.is_out_of_office'
        )) as Array<{
        id: string
        first_name: string | null
        last_name: string | null
        email: string
        title: string | null
        department: string | null
        status: string | null
        is_out_of_office: boolean | number | null
      }>
      const rosterIds = memberRows.map((m) => m.id)

      // Linked owner-group cells, grouped by template+state with dimension coverage
      const cellRows = (await db('nivaro_pipeline_owner_group_teams as gt')
        .join('nivaro_pipeline_owner_groups as g', 'g.id', 'gt.group')
        .join('nivaro_workflow_states as s', 's.id', 'g.state')
        .join('nivaro_workflow_templates as t', 't.id', 'g.template')
        .where('gt.team_id', id)
        .select(
          'g.id as gid',
          'g.filters',
          's.id as state_id',
          's.key as state_key',
          's.label as state_label',
          's.sort as state_sort',
          't.id as template_id',
          't.name as template_name'
        )) as Array<{
        gid: string
        filters: string | null
        state_id: string
        state_key: string
        state_label: string
        state_sort: number
        template_id: string
        template_name: string
      }>
      // Legacy owner groups key filters POSITIONALLY, current ones by dimension
      // id — the two collide, so the dims table alone mislabels. Infer the
      // dimension from the VALUE domain first; the table is the fallback.
      const dimRows = (await db('nivaro_pipeline_owner_dimensions').select('id', 'label')) as Array<{
        id: number
        label: string
      }>
      const dimLabel = new Map(dimRows.map((d) => [String(d.id), d.label]))
      const [zoneNames, regionNames, ptNames] = await Promise.all([
        db('divisions').pluck('short_name').catch(() => [] as string[]),
        db('regions').pluck('short_name').catch(() => [] as string[]),
        db('project_types').pluck('name').catch(() => [] as string[])
      ])
      const zoneSet = new Set((zoneNames as string[]).map(String))
      const regionSet = new Set((regionNames as string[]).map(String))
      const ptSet = new Set((ptNames as string[]).map(String))
      const inferDim = (values: Set<string>): string | null => {
        const arr = [...values]
        if (arr.length === 0) return null
        const frac = (set: Set<string>) => arr.filter((v) => set.has(v)).length / arr.length
        if (frac(zoneSet) >= 0.8) return 'Zone'
        if (frac(regionSet) >= 0.8) return 'Region'
        if (frac(ptSet) >= 0.8) return 'Project Type'
        if (arr.filter((v) => /^\d{5,7}$/.test(v) || /^[A-Z0-9 _-]*\d[A-Z0-9 _-]*$/.test(v)).length / arr.length >= 0.8)
          return 'Project'
        return null
      }
      const cellAgg = new Map<
        string,
        {
          template_id: string
          template_name: string
          state_id: string
          state_key: string
          state_label: string
          state_sort: number
          count: number
          dims: Map<string, Set<string>>
        }
      >()
      for (const c of cellRows) {
        const key = `${c.template_id}:${c.state_id}`
        let agg = cellAgg.get(key)
        if (!agg) {
          agg = {
            template_id: c.template_id,
            template_name: c.template_name,
            state_id: c.state_id,
            state_key: c.state_key,
            state_label: c.state_label,
            state_sort: c.state_sort,
            count: 0,
            dims: new Map()
          }
          cellAgg.set(key, agg)
        }
        agg.count += 1
        const filters = (parseJson(c.filters) ?? {}) as Record<string, unknown>
        for (const [k, v] of Object.entries(filters)) {
          const raw = v !== null && typeof v === 'object' ? (v as { value?: unknown }).value : v
          if (raw == null || raw === '') continue
          const label = dimLabel.get(String(k)) ?? `Dimension ${k}`
          if (!agg.dims.has(label)) agg.dims.set(label, new Set())
          agg.dims.get(label)!.add(String(raw))
        }
      }
      const cells = [...cellAgg.values()]
        .sort((a, b) => b.count - a.count)
        .map((a) => {
          // Re-key each dim bucket by its inferred name, merging collisions.
          const rekeyed = new Map<string, Set<string>>()
          for (const [label, vals] of a.dims.entries()) {
            const inferred = inferDim(vals) ?? label
            if (!rekeyed.has(inferred)) rekeyed.set(inferred, new Set())
            for (const v of vals) rekeyed.get(inferred)!.add(v)
          }
          a.dims = rekeyed
          return a
        })
        .map((a) => ({
          template_id: a.template_id,
          template_name: a.template_name,
          state_id: a.state_id,
          state_key: a.state_key,
          state_label: a.state_label,
          state_sort: a.state_sort,
          count: a.count,
          dims: Object.fromEntries(
            [...a.dims.entries()].map(([k, vals]) => [k, [...vals].sort().slice(0, 30)])
          )
        }))

      // Throughput: workflow-history actions by roster members
      let weekly: Array<{ week_start: string; count: number }> = []
      const perMember: Record<string, { actions_30d: number; last_action_at: string | null }> = {}
      let total30 = 0
      let total90 = 0
      let sendbacks30 = 0
      if (rosterIds.length > 0) {
        const since90 = new Date(Date.now() - 90 * 86400_000)
        const since30 = new Date(Date.now() - 30 * 86400_000)
        const hist = (await db('nivaro_workflow_history as h')
          .leftJoin('nivaro_workflow_states as sf', 'sf.id', 'h.from_state')
          .leftJoin('nivaro_workflow_states as st', 'st.id', 'h.to_state')
          .whereIn('h.user', rosterIds)
          .where('h.timestamp', '>', since90)
          .select(
            'h.user',
            'h.timestamp',
            'sf.sort as from_sort',
            'st.sort as to_sort'
          )) as Array<{
          user: string
          timestamp: Date | string
          from_sort: number | null
          to_sort: number | null
        }>
        total90 = hist.length
        const weekMap = new Map<string, number>()
        for (const h of hist) {
          const ts = new Date(h.timestamp)
          const isRecent = ts >= since30
          if (isRecent) {
            total30 += 1
            const uid = String(h.user).toUpperCase()
            perMember[uid] ??= { actions_30d: 0, last_action_at: null }
            perMember[uid].actions_30d += 1
            if (
              h.from_sort != null &&
              h.to_sort != null &&
              h.to_sort < h.from_sort
            )
              sendbacks30 += 1
          }
          // Week bucket (Monday-start, UTC)
          const d = new Date(Date.UTC(ts.getUTCFullYear(), ts.getUTCMonth(), ts.getUTCDate()))
          const dow = (d.getUTCDay() + 6) % 7
          d.setUTCDate(d.getUTCDate() - dow)
          const wk = d.toISOString().slice(0, 10)
          weekMap.set(wk, (weekMap.get(wk) ?? 0) + 1)
        }
        // Last action per member (all-time) in one query
        const lastRows = (await db('nivaro_workflow_history')
          .whereIn('user', rosterIds)
          .groupBy('user')
          .select('user')
          .max('timestamp as last_at')) as Array<{ user: string; last_at: Date | string | null }>
        for (const r of lastRows) {
          const uid = String(r.user).toUpperCase()
          perMember[uid] ??= { actions_30d: 0, last_action_at: null }
          perMember[uid].last_action_at = r.last_at ? new Date(r.last_at).toISOString() : null
        }
        weekly = [...weekMap.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([week_start, count]) => ({ week_start, count }))
      }

      return reply.send({
        data: {
          team: { id: team.id, name: team.name, description: team.description ?? null },
          roster: memberRows.map((m) => {
            const stats = perMember[String(m.id).toUpperCase()]
            return {
              ...m,
              is_out_of_office: !!m.is_out_of_office,
              actions_30d: stats?.actions_30d ?? 0,
              last_action_at: stats?.last_action_at ?? null
            }
          }),
          cells: { total: cellRows.length, states: cells },
          throughput: {
            weekly,
            total_30d: total30,
            total_90d: total90,
            sendbacks_30d: sendbacks30
          }
        }
      })
    }
  )

  // ─── Team workload: open records currently waiting on this team ───────────
  // Live resolution through resolveStateOwnersBatch, same cost profile as
  // /my-work and /coverage-gaps — a few seconds, never persisted.
  app.get<{ Params: { id: string } }>(
    '/:id/workload',
    { preHandler: requireAuth },
    async (req, reply) => {
      const id = Number(req.params.id)
      const team = await db('nivaro_user_groups').where({ id }).first()
      if (!team) return reply.code(404).send({ error: 'Team not found' })
      const rosterIds = new Set(
        ((await db('nivaro_user_group_members').where('group_id', id).pluck('user')) as string[]).map(
          (u) => String(u).toUpperCase()
        )
      )
      if (rosterIds.size === 0)
        return reply.send({ data: { total: 0, by_state: [], members: [], records: [] } })

      const linked = (await db('nivaro_pipeline_owner_group_teams as gt')
        .join('nivaro_pipeline_owner_groups as g', 'g.id', 'gt.group')
        .where('gt.team_id', id)
        .distinct('g.template', 'g.state')) as Array<{ template: string; state: string }>
      if (linked.length === 0)
        return reply.send({ data: { total: 0, by_state: [], members: [], records: [] } })

      const stateIds = [...new Set(linked.map((l) => l.state))]
      const stateMeta = (await db('nivaro_workflow_states as s')
        .join('nivaro_workflow_templates as t', 't.id', 's.template')
        .whereIn('s.id', stateIds)
        .select('s.id', 's.label', 't.name as template_name')) as Array<{
        id: string
        label: string
        template_name: string
      }>
      const stateById = new Map(stateMeta.map((s) => [String(s.id).toUpperCase(), s]))

      const CAP = 4000
      const instances = (await db('nivaro_workflow_instances')
        .whereIn('current_state', stateIds)
        .whereNull('completed_at')
        .orderBy('started_at', 'desc')
        .limit(CAP)
        .select('id', 'collection', 'item', 'current_state', 'started_at')) as Array<{
        id: string
        collection: string
        item: string
        current_state: string
        started_at: Date | string | null
      }>

      const requests: OwnerResolutionRequest[] = instances.map((i) => ({
        key: `${i.collection}:${i.item}`,
        stateId: i.current_state,
        instanceId: i.id,
        collection: i.collection,
        itemId: String(i.item)
      }))
      const resolved = await resolveStateOwnersBatch(requests)

      const kept: Array<{
        collection: string
        item: string
        state_id: string
        started_at: string | null
        owners: string[]
      }> = []
      const memberCounts = new Map<string, number>()
      for (const i of instances) {
        const owners = resolved.get(`${i.collection}:${i.item}`) ?? []
        const teamOwners = owners.filter((o) => rosterIds.has(String(o.id).toUpperCase()))
        if (teamOwners.length === 0) continue
        for (const o of teamOwners) {
          const k = String(o.id).toUpperCase()
          memberCounts.set(k, (memberCounts.get(k) ?? 0) + 1)
        }
        kept.push({
          collection: i.collection,
          item: String(i.item),
          state_id: String(i.current_state).toUpperCase(),
          started_at: i.started_at ? new Date(i.started_at).toISOString() : null,
          owners: teamOwners.map((o) =>
            `${o.first_name ?? ''} ${o.last_name ?? ''}`.trim() || o.email
          )
        })
      }

      // SLA per collection over kept records
      const byCollection = new Map<string, string[]>()
      for (const k of kept) {
        if (!byCollection.has(k.collection)) byCollection.set(k.collection, [])
        byCollection.get(k.collection)!.push(k.item)
      }
      const slaByKey = new Map<string, string | null>()
      for (const [collection, ids] of byCollection) {
        try {
          const sla = await computeStatusBatch(collection, ids)
          for (const [itemId, entry] of Object.entries(sla)) {
            slaByKey.set(`${collection}:${itemId}`, (entry as { status?: string | null })?.status ?? null)
          }
        } catch {
          /* SLA optional — a failing rule must not take the workload down */
        }
      }

      const byState = new Map<
        string,
        { state_label: string; template_name: string; count: number; sla_warning: number; sla_breached: number }
      >()
      for (const k of kept) {
        const meta = stateById.get(k.state_id)
        const key = k.state_id
        let e = byState.get(key)
        if (!e) {
          e = {
            state_label: meta?.label ?? k.state_id,
            template_name: meta?.template_name ?? '',
            count: 0,
            sla_warning: 0,
            sla_breached: 0
          }
          byState.set(key, e)
        }
        e.count += 1
        const sla = slaByKey.get(`${k.collection}:${k.item}`)
        if (sla === 'warning') e.sla_warning += 1
        if (sla === 'breached') e.sla_breached += 1
      }

      // Labels for the record list (oldest waiting first — those need eyes)
      const list = [...kept].sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? '')).slice(0, 25)
      const labelReq = new Map<string, Set<string>>()
      for (const k of list) {
        if (!labelReq.has(k.collection)) labelReq.set(k.collection, new Set())
        labelReq.get(k.collection)!.add(k.item)
      }
      let labels: Record<string, string> = {}
      try {
        labels = await getLabels(labelReq)
      } catch {
        /* label failure → ids shown */
      }

      const memberNames = (await db('nivaro_users')
        .whereIn(
          'id',
          [...memberCounts.keys()]
        )
        .select('id', 'first_name', 'last_name')) as Array<{
        id: string
        first_name: string | null
        last_name: string | null
      }>

      return reply.send({
        data: {
          total: kept.length,
          truncated: instances.length >= CAP,
          by_state: [...byState.values()].sort((a, b) => b.count - a.count),
          members: memberNames
            .map((m) => ({
              id: m.id,
              name: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim(),
              count: memberCounts.get(String(m.id).toUpperCase()) ?? 0
            }))
            .sort((a, b) => b.count - a.count),
          records: list.map((k) => ({
            collection: k.collection,
            item_id: k.item,
            label: labels[`${k.collection}:${k.item}`] ?? `#${k.item}`,
            state_label: stateById.get(k.state_id)?.label ?? '',
            sla_status: slaByKey.get(`${k.collection}:${k.item}`) ?? null,
            started_at: k.started_at,
            owners: k.owners
          }))
        }
      })
    }
  )
}
