import type { FastifyInstance } from 'fastify'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  EXPORT_LIMIT_DEFS,
  ExportLimitError,
  effectiveExportLimits,
  exportLimitValues,
  readExportLimit,
  saveExportLimits
} from '../services/export-limits.js'
import { instanceKey } from '../services/instance-key.js'

/**
 * Export limits for THIS instance (services/export-limits.ts):
 *   GET   /api/export-limits           signed in — the values the apps cap their own exports at
 *   GET   /api/export-limits/settings  admin — every limit with its value and source
 *   PATCH /api/export-limits/settings  admin — `{ settings: { file_rows: 100000, form_records: null } }`
 * Env still wins where set.
 */
export async function exportLimitsRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: authenticate }, async (_req, reply) => {
    await readExportLimit(EXPORT_LIMIT_DEFS[0].key)
    return reply.send({ data: exportLimitValues() })
  })

  app.get('/settings', { preHandler: requireAdmin }, async (_req, reply) => {
    await readExportLimit(EXPORT_LIMIT_DEFS[0].key)
    return reply.send({
      data: effectiveExportLimits(),
      instance: instanceKey(),
      cloud: !!process.env.CLOUD_META_DB_URL
    })
  })

  app.patch('/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const settings = ((req.body ?? {}) as { settings?: unknown }).settings
    if (!settings || typeof settings !== 'object' || Array.isArray(settings))
      return reply.code(400).send({ error: 'settings must be an object', code: 'INVALID_BODY' })
    try {
      const data = await saveExportLimits(settings as Record<string, unknown>)
      await logActivity({
        action: 'export-limits-update',
        user: req.user?.id,
        comment: `${instanceKey()}: ${Object.entries(settings)
          .map(([k, v]) => `${k}=${v === null ? 'cleared' : String(v)}`)
          .join(', ')}`.slice(0, 500),
        req
      })
      return reply.send({ data, instance: instanceKey() })
    } catch (err) {
      if (err instanceof ExportLimitError)
        return reply
          .code(400)
          .send({ error: err.message, code: 'INVALID_EXPORT_LIMIT', field: err.field })
      throw err
    }
  })
}
