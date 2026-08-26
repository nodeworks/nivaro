import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

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
    return reply.send({
      data: rows.map((r) => ({ ...r, member_count: Number(r.member_count ?? 0) }))
    })
  })

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
