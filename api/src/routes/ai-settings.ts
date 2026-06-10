import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import {
  AI_SETTINGS_DEFAULTS,
  type AiCollectionSettings,
  invalidateAiSettingsCache
} from '../hooks/ai-validation.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

// Per-collection AI feature configuration (content validation + duplicate detection).
// Registered under /api/ai-settings; admin only.

function parseRules(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string') : []
  } catch {
    return []
  }
}

function formatRow(collection: string, row: Record<string, unknown> | undefined | null) {
  if (!row) return { collection, ...AI_SETTINGS_DEFAULTS }
  return {
    collection,
    validation_enabled: row.validation_enabled === true || row.validation_enabled === 1,
    validation_mode: row.validation_mode === 'hard' ? 'hard' : 'soft',
    validation_rules: parseRules(row.validation_rules),
    duplicate_detection_enabled:
      row.duplicate_detection_enabled === true || row.duplicate_detection_enabled === 1,
    duplicate_threshold: Number(row.duplicate_threshold) || 0.85
  } satisfies AiCollectionSettings
}

export async function aiSettingsRoutes(app: FastifyInstance) {
  app.get<{ Params: { collection: string } }>(
    '/:collection',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { collection } = req.params
      const row = await db('nivaro_ai_collection_settings').where({ collection }).first()
      return reply.send({ data: formatRow(collection, row) })
    }
  )

  app.patch<{ Params: { collection: string } }>(
    '/:collection',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { collection } = req.params
      if (collection.startsWith('nivaro_')) {
        return reply.code(403).send({ error: 'AI features cannot be enabled on system tables' })
      }

      const body = req.body as Partial<{
        validation_enabled: boolean
        validation_mode: string
        validation_rules: unknown
        duplicate_detection_enabled: boolean
        duplicate_threshold: number
      }>

      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (body.validation_enabled != null) {
        patch.validation_enabled = body.validation_enabled ? 1 : 0
      }
      if (body.validation_mode != null) {
        if (body.validation_mode !== 'soft' && body.validation_mode !== 'hard') {
          return reply.code(400).send({ error: "validation_mode must be 'soft' or 'hard'" })
        }
        patch.validation_mode = body.validation_mode
      }
      if ('validation_rules' in body) {
        if (body.validation_rules != null && !Array.isArray(body.validation_rules)) {
          return reply.code(400).send({ error: 'validation_rules must be an array of strings' })
        }
        const rules = (body.validation_rules ?? [])
          .map((r) => String(r).trim())
          .filter((r) => r.length > 0)
        patch.validation_rules = JSON.stringify(rules)
      }
      if (body.duplicate_detection_enabled != null) {
        patch.duplicate_detection_enabled = body.duplicate_detection_enabled ? 1 : 0
      }
      if (body.duplicate_threshold != null) {
        const t = Number(body.duplicate_threshold)
        if (Number.isNaN(t) || t < 0.5 || t > 0.99) {
          return reply.code(400).send({ error: 'duplicate_threshold must be between 0.5 and 0.99' })
        }
        patch.duplicate_threshold = t
      }

      const existing = await db('nivaro_ai_collection_settings').where({ collection }).first()
      if (existing) {
        await db('nivaro_ai_collection_settings').where({ collection }).update(patch)
      } else {
        await db('nivaro_ai_collection_settings').insert({
          collection,
          validation_enabled: 0,
          validation_mode: 'soft',
          validation_rules: JSON.stringify([]),
          duplicate_detection_enabled: 0,
          duplicate_threshold: 0.85,
          created_at: new Date(),
          ...patch
        })
      }

      invalidateAiSettingsCache(collection)

      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_ai_collection_settings',
        item: collection,
        req
      })

      const row = await db('nivaro_ai_collection_settings').where({ collection }).first()
      return reply.send({ data: formatRow(collection, row) })
    }
  )
}
