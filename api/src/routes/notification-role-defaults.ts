import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  forgetRoleNotificationDefaults,
  getRoleDefaults,
  ROLE_DEFAULTS_TABLE,
  saveRoleDefaults
} from '../services/notification-role-defaults.js'

/**
 * Default notification rules by role (#3077) — admin only. The rules are the same shape a
 * person stores under Profile → Notification rules; people follow them for every value they
 * never set themselves, resolved at decide time (nothing is copied onto people).
 *
 *   GET    /api/notifications/role-defaults/:roleId   → { role, rules, updated_at, updated_by, members }
 *   PUT    /api/notifications/role-defaults/:roleId   { rules }
 *   DELETE /api/notifications/role-defaults/:roleId   → back to the system defaults
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function findRole(roleId: string): Promise<{ id: string; name: string } | null> {
  if (!UUID.test(roleId)) return null
  const row = (await db('nivaro_roles').where({ id: roleId }).first('id', 'name')) as
    | { id: string; name: string }
    | undefined
  return row ?? null
}

export async function notificationRoleDefaultsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/:roleId', async (req, reply) => {
    const { roleId } = req.params as { roleId: string }
    const role = await findRole(roleId)
    if (!role) return reply.code(404).send({ error: 'Role not found' })
    const [row, members] = await Promise.all([
      getRoleDefaults(role.id),
      (
        db('nivaro_users').where({ role: role.id }).count({ c: '*' }).first() as Promise<
          { c?: number | string } | undefined
        >
      ).catch(() => ({ c: 0 }))
    ])
    return {
      data: {
        role: { id: role.id, name: role.name },
        rules: row?.rules ?? {},
        updated_at: row?.updated_at ?? null,
        updated_by: row?.updated_by ?? null,
        members: Number(members?.c ?? 0)
      }
    }
  })

  app.put('/:roleId', async (req, reply) => {
    const { roleId } = req.params as { roleId: string }
    const role = await findRole(roleId)
    if (!role) return reply.code(404).send({ error: 'Role not found' })
    const raw = (req.body as { rules?: unknown } | null)?.rules
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
      return reply.code(400).send({ error: 'rules must be an object' })
    if (!(await db.schema.hasTable(ROLE_DEFAULTS_TABLE)))
      return reply.code(503).send({ error: 'Role notification defaults need migration 513' })
    const saved = await saveRoleDefaults(role.id, raw, req.user?.id ?? null)
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: ROLE_DEFAULTS_TABLE,
      item: role.id,
      comment: `Notification defaults for role "${role.name}"`,
      req
    })
    return {
      data: {
        role: { id: role.id, name: role.name },
        rules: saved.rules,
        updated_at: saved.updated_at,
        updated_by: saved.updated_by
      }
    }
  })

  app.delete('/:roleId', async (req, reply) => {
    const { roleId } = req.params as { roleId: string }
    const role = await findRole(roleId)
    if (!role) return reply.code(404).send({ error: 'Role not found' })
    await forgetRoleNotificationDefaults(role.id)
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: ROLE_DEFAULTS_TABLE,
      item: role.id,
      comment: `Notification defaults for role "${role.name}" cleared`,
      req
    })
    return reply.code(204).send()
  })
}
