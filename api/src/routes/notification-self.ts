import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { getNotifyPrefsLayered } from '../services/notification-channels.js'

/**
 * The signed-in person's own notification extras, mounted beside notificationsRoutes under
 * /api/notifications. Every route here answers for req.user only — no route takes a user id.
 *
 *   GET /my-rule-defaults — #3077: the person's role and that role's default rules, so
 *       Profile → Notification rules can say which values come from the role.
 */
export async function notificationSelfRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  app.get('/my-rule-defaults', async (req) => {
    const layered = await getNotifyPrefsLayered(req.user!.id)
    return {
      data: {
        role: layered.role ? { id: layered.role.id, name: layered.role.name } : null,
        rules: layered.role?.rules ?? {}
      }
    }
  })
}
