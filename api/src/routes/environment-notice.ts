import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { appEnvironment } from '../services/app-info-environment.js'
import {
  getNoticeSettings,
  noticeEnv,
  resolveNotice,
  saveNoticeSettings
} from '../services/environment-notice.js'
import { instanceKey } from '../services/instance-key.js'

/**
 * GET/PATCH /api/environment-notice (admin) — this instance's "this is staging" notice
 * (services/environment-notice.ts). The public answer is `environment_notice` on GET /api/app-info.
 */
export async function environmentNoticeRoutes(app: FastifyInstance) {
  const answer = async () => {
    const settings = await getNoticeSettings()
    return {
      settings,
      instance_key: instanceKey(),
      environment: appEnvironment(),
      env_switch: noticeEnv(),
      shown: resolveNotice(settings)
    }
  }
  app.get('/environment-notice', { preHandler: requireAdmin }, async (_req, reply) =>
    reply.send({ data: await answer() })
  )
  app.patch('/environment-notice', { preHandler: requireAdmin }, async (req, reply) => {
    const next = await saveNoticeSettings(req.body ?? {})
    await logActivity({
      action: 'environment-notice-settings',
      user: req.user?.id,
      collection: 'nivaro_settings_overrides',
      item: instanceKey(),
      comment: JSON.stringify(next).slice(0, 300),
      req
    })
    return reply.send({ data: await answer() })
  })
}
