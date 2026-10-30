import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  isRoleId,
  type NavLayout,
  normalizeNavLayout,
  parseNavRoleDefaults,
  starterForRole
} from '../services/nav-layout.js'

/**
 * #3227 — role starter sidebar layouts. A person's own layout lives on their
 * preferences (PATCH /users/me/preferences `nav_layout`); this route only
 * serves and stores the per-role starters in `nivaro_settings.nav_role_defaults`
 * (migration 520). The column may be missing on a database that has not run
 * 520 yet — reads answer "no starter" and writes 503.
 */
async function readRoleDefaults(): Promise<Record<string, NavLayout> | null> {
  try {
    const row = (await db('nivaro_settings').orderBy('id', 'asc').first('nav_role_defaults')) as
      | { nav_role_defaults?: unknown }
      | undefined
    return parseNavRoleDefaults(row?.nav_role_defaults ?? null)
  } catch {
    return null
  }
}

export async function navLayoutRoutes(app: FastifyInstance) {
  /** The caller's OWN role's starter (never another role's). */
  app.get('/starter', { preHandler: requireAuth }, async (req, reply) => {
    const map = (await readRoleDefaults()) ?? {}
    return reply.send({ data: { layout: starterForRole(map, req.user?.role) } })
  })

  /** Every role's starter (admin). */
  app.get('/roles', { preHandler: requireAdmin }, async (_req, reply) => {
    const map = await readRoleDefaults()
    return reply.send({ data: map ?? {}, available: map !== null })
  })

  /** Set or clear (layout: null) one role's starter (admin). */
  app.put<{ Params: { roleId: string }; Body: { layout?: unknown } }>(
    '/roles/:roleId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const roleId = req.params.roleId
      if (!isRoleId(roleId)) return reply.code(400).send({ error: 'Not a role id' })
      const role = await db('nivaro_roles').where({ id: roleId }).first('id')
      if (!role) return reply.code(404).send({ error: 'Role not found' })
      const n = normalizeNavLayout(req.body?.layout ?? null)
      if (n.error) return reply.code(400).send({ error: n.error })
      const settings = (await db('nivaro_settings').orderBy('id', 'asc').first('id')) as
        | { id: number }
        | undefined
      if (!settings) return reply.code(503).send({ error: 'Settings row missing' })
      const map = await readRoleDefaults()
      if (map === null) {
        return reply.code(503).send({
          error: 'Role sidebar layouts need migration 520',
          code: 'NAV_LAYOUT_UNAVAILABLE'
        })
      }
      const key = roleId.toUpperCase()
      if (n.layout) map[key] = n.layout
      else delete map[key]
      await db('nivaro_settings')
        .where({ id: settings.id })
        .update({
          nav_role_defaults: Object.keys(map).length ? JSON.stringify(map) : null,
          updated_at: new Date()
        })
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_settings',
        item: String(settings.id),
        comment: n.layout
          ? `sidebar starter set for role ${key}`
          : `sidebar starter cleared for role ${key}`,
        req
      })
      return reply.send({ data: { layout: n.layout } })
    }
  )
}
