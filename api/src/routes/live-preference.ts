import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  isRoleId,
  liveDefaultForRole,
  loadLiveRoleDefaults,
  parseLiveMode,
  saveLiveRoleDefaults,
  withRoleDefault
} from '../services/live-preference.js'
import { announcePrefsChanged } from '../services/user-sync.js'

/**
 * /api/live-preference — the role defaults behind Profile → Display → Live updates
 * (services/live-preference.ts). A person's own choice is PATCH /users/me/preferences
 * `live_mode`; these routes only serve the role layer.
 */
export async function livePreferenceRoutes(app: FastifyInstance) {
  /** The caller's OWN role's default (never another role's); null = Normal. */
  app.get('/default', { preHandler: requireAuth }, async (req, reply) => {
    const map = await loadLiveRoleDefaults()
    return reply.send({ data: { mode: liveDefaultForRole(map, req.user?.role) } })
  })

  /** Every role's default (admin). */
  app.get('/roles', { preHandler: requireAdmin }, async (_req, reply) => {
    return reply.send({ data: await loadLiveRoleDefaults() })
  })

  /** Set or clear (mode: null) one role's default (admin). */
  app.put<{ Params: { roleId: string }; Body: { mode?: unknown } }>(
    '/roles/:roleId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const roleId = req.params.roleId
      if (!isRoleId(roleId)) return reply.code(400).send({ error: 'Not a role id' })
      const raw = req.body?.mode ?? null
      const mode = raw === null ? null : parseLiveMode(raw)
      if (raw !== null && !mode)
        return reply.code(400).send({ error: 'mode must be calm, normal, off or null' })
      const role = await db('nivaro_roles').where({ id: roleId }).first('id')
      if (!role) return reply.code(404).send({ error: 'Role not found' })
      const next = withRoleDefault(await loadLiveRoleDefaults(), roleId, mode)
      await saveLiveRoleDefaults(next)
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_extension_settings',
        item: 'nivaro-core:live_mode_role_defaults',
        comment: mode
          ? `live updates default set to ${mode} for role ${roleId.toUpperCase()}`
          : `live updates default cleared for role ${roleId.toUpperCase()}`,
        req
      })
      // The role's people pick it up now (a key name only — each tab re-reads its own default).
      try {
        const people = (await db('nivaro_users').where({ role: roleId }).select('id')) as Array<{
          id: string
        }>
        for (const p of people.slice(0, 5000)) announcePrefsChanged(p.id, ['live_mode'])
      } catch {
        /* they read it on their next page load */
      }
      return reply.send({ data: { mode } })
    }
  )
}
