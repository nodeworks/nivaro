import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { writeRevision } from '../services/revisions.js'

interface SavedViewRow {
  id: number
  collection: string
  name: string
  filters: string | null
  sort: string | null
  columns: string | null
  user: string
  is_shared: boolean | number
  is_default: boolean | number
  role: string | null
  default_for_role?: string | null
  created_at: Date
}

function parseJson<T>(value: unknown): T | null {
  if (value == null) return null
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function toJsonStr(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return JSON.stringify(value)
}

function formatView(row: SavedViewRow) {
  return {
    ...row,
    filters: parseJson(row.filters),
    sort: parseJson(row.sort),
    columns: parseJson(row.columns),
    is_shared: !!row.is_shared,
    is_default: !!row.is_default,
    default_for_role: row.default_for_role ?? null
  }
}

const sameId = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toUpperCase() === String(b).toUpperCase()

/**
 * #672 — a role-level default. Setting it makes the view shared (members of
 * the role must be able to see it) and clears any other view holding the
 * same role's default on this collection. Admin only. Returns an error
 * message, or null when the value is acceptable.
 */
async function claimRoleDefault(
  collection: string,
  roleId: string | null,
  exceptId: number | null
): Promise<string | null> {
  if (!roleId) return null
  const role = await db('nivaro_roles').where({ id: roleId }).first('id')
  if (!role) return 'Role not found'
  const q = db('nivaro_saved_views').where({ collection }).where('default_for_role', roleId)
  if (exceptId != null) q.whereNot('id', exceptId)
  await q.update({ default_for_role: null })
  return null
}

export async function savedViewsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // GET /?collection= — own views + shared views (optionally role-matched)
  app.get('/', async (req, reply) => {
    const { collection } = req.query as { collection?: string }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })

    const userId = req.user!.id
    const userRole = req.user!.role ?? null

    const rows = (await db<SavedViewRow>('nivaro_saved_views')
      .where({ collection })
      .where((qb) => {
        qb.where({ user: userId }).orWhere((shared) => {
          shared.where('is_shared', true).andWhere((roleQb) => {
            roleQb.whereNull('role')
            if (userRole) roleQb.orWhere('role', userRole)
          })
        })
      })
      .orderBy('created_at', 'asc')) as SavedViewRow[]

    // Name the role a view is the default for, and say whether that default
    // is the caller's (the browser applies it before the collection default).
    const roleIds = [...new Set(rows.map((r) => r.default_for_role).filter(Boolean))] as string[]
    const roleNames = new Map<string, string>()
    if (roleIds.length) {
      for (const r of (await db('nivaro_roles')
        .whereIn('id', roleIds)
        .select('id', 'name')) as Array<{
        id: string
        name: string
      }>)
        roleNames.set(String(r.id).toUpperCase(), r.name)
    }
    return reply.send({
      data: rows.map((r) => ({
        ...formatView(r),
        default_for_role_name: r.default_for_role
          ? (roleNames.get(String(r.default_for_role).toUpperCase()) ?? null)
          : null,
        role_default: sameId(r.default_for_role, userRole)
      }))
    })
  })

  // POST / — create a view owned by the current user
  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as {
      collection?: string
      name?: string
      filters?: unknown
      sort?: unknown
      columns?: unknown
      is_shared?: boolean
      is_default?: boolean
      role?: string | null
      default_for_role?: string | null
    }

    const { collection, name } = body
    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    if (!name?.trim()) return reply.code(400).send({ error: 'name is required' })
    // The collection default is a shared, admin-controlled concept.
    const wantsDefault = !!body.is_default
    if (wantsDefault && !req.isAdmin) {
      return reply.code(403).send({ error: 'Only admins can set the default view' })
    }
    if (wantsDefault) {
      await db('nivaro_saved_views').where({ collection }).update({ is_default: false })
    }
    const roleDefault = body.default_for_role || null
    if (roleDefault) {
      if (!req.isAdmin)
        return reply.code(403).send({ error: 'Only admins can set a role default view' })
      const err = await claimRoleDefault(collection, roleDefault, null)
      if (err) return reply.code(400).send({ error: err })
    }

    const [row] = (await db('nivaro_saved_views')
      .insert({
        collection,
        name: name.trim(),
        filters: toJsonStr(body.filters),
        sort: toJsonStr(body.sort),
        columns: toJsonStr(body.columns),
        user: req.user!.id,
        is_shared: wantsDefault || roleDefault ? true : !!body.is_shared,
        is_default: wantsDefault,
        role: roleDefault ? null : (body.role ?? null),
        default_for_role: roleDefault,
        created_at: new Date()
      })
      .returning('*')) as unknown as [SavedViewRow]

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_saved_views',
      item: String(row.id),
      comment: collection,
      req
    })

    return reply.code(201).send({ data: formatView(row) })
  })

  // PATCH /:id — update (owner or admin)
  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const view = (await db<SavedViewRow>('nivaro_saved_views')
      .where({ id: Number(id) })
      .first()) as SavedViewRow | undefined

    if (!view) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && view.user !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const body = (req.body ?? {}) as {
      name?: string
      filters?: unknown
      sort?: unknown
      columns?: unknown
      is_shared?: boolean
      is_default?: boolean
      role?: string | null
      default_for_role?: string | null
    }

    const update: Record<string, unknown> = {}
    if (body.default_for_role !== undefined) {
      if (!req.isAdmin)
        return reply.code(403).send({ error: 'Only admins can set a role default view' })
      const roleDefault = body.default_for_role || null
      const err = await claimRoleDefault(view.collection, roleDefault, view.id)
      if (err) return reply.code(400).send({ error: err })
      update.default_for_role = roleDefault
      if (roleDefault) {
        // Members of the role must be able to see their default.
        update.is_shared = true
        update.role = null
      }
    }
    if (body.is_default !== undefined) {
      if (!req.isAdmin) {
        return reply.code(403).send({ error: 'Only admins can set the default view' })
      }
      if (body.is_default) {
        await db('nivaro_saved_views')
          .where({ collection: view.collection })
          .update({ is_default: false })
        update.is_default = true
        update.is_shared = true
      } else {
        update.is_default = false
      }
    }
    if (body.name !== undefined) {
      if (!body.name.trim()) return reply.code(400).send({ error: 'name cannot be empty' })
      update.name = body.name.trim()
    }
    if (body.filters !== undefined) update.filters = toJsonStr(body.filters)
    if (body.sort !== undefined) update.sort = toJsonStr(body.sort)
    if (body.columns !== undefined) update.columns = toJsonStr(body.columns)
    if (body.is_shared !== undefined) update.is_shared = !!body.is_shared
    if (body.role !== undefined && update.role === undefined) update.role = body.role ?? null

    if (Object.keys(update).length === 0) {
      return reply.send({ data: formatView(view) })
    }

    await db('nivaro_saved_views')
      .where({ id: Number(id) })
      .update(update)
    const updated = (await db<SavedViewRow>('nivaro_saved_views')
      .where({ id: Number(id) })
      .first()) as SavedViewRow

    // Saved views are raw-knex rows (never through the items service), so
    // snapshot them here — a deleted collection default was unrecoverable
    // before this (2026-09-03, workflows).
    const updateActivity = await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_saved_views',
      item: String(id),
      req
    })
    await writeRevision({
      activity: updateActivity,
      collection: 'nivaro_saved_views',
      item: String(id),
      data: formatView(updated) as unknown as Record<string, unknown>,
      delta: Object.fromEntries(
        Object.keys(update).map((k) => [k, (formatView(updated) as Record<string, unknown>)[k]])
      )
    })

    return reply.send({ data: formatView(updated) })
  })

  // DELETE /:id — delete (owner or admin)
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const view = (await db<SavedViewRow>('nivaro_saved_views')
      .where({ id: Number(id) })
      .first()) as SavedViewRow | undefined

    if (!view) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && view.user !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_saved_views')
      .where({ id: Number(id) })
      .delete()
    // Full snapshot rides the delete activity so the view can be rebuilt
    // (columns, filters, sort, default flag) from revision history.
    const deleteActivity = await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_saved_views',
      item: String(id),
      comment: `${view.collection} · ${view.name}${view.is_default ? ' (collection default)' : ''}`,
      req
    })
    await writeRevision({
      activity: deleteActivity,
      collection: 'nivaro_saved_views',
      item: String(id),
      data: formatView(view) as unknown as Record<string, unknown>,
      delta: null
    })
    return reply.code(204).send()
  })
}
