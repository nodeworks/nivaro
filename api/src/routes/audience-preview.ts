import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  AudienceSettingsError,
  getAudienceSettings,
  previewAudience,
  saveAudienceSettings
} from '../services/audience-gate.js'
import { AUDIENCE_KINDS, type AudienceKind } from '../services/audience-preview.js'
import { markConfigRead } from '../services/config-live.js'

/**
 * Audience preview before sending (#3080) — /api/audience-preview, admin only.
 *
 *   POST /           {kind, id?, draft} → who the draft would reach + whether saving asks first
 *   GET  /settings   the instance's confirm threshold
 *   PATCH /settings  {threshold}
 *
 * The preview is read-only. With `id` the draft is merged over the stored row, so an editor
 * that sends only its form sees the same answer the save route will give.
 */

const TABLE_BY_KIND: Record<AudienceKind, string> = {
  alert: 'nivaro_alert_definitions',
  rule: 'nivaro_rules',
  flow: 'nivaro_flows',
  flow_operation: 'nivaro_flow_operations',
  field_watch: 'nivaro_field_watches',
  broadcast: 'nivaro_announcements'
}

/** The stored row a draft is merged over (null when the id names nothing). */
export async function storedConfig(
  kind: AudienceKind,
  id: string
): Promise<Record<string, unknown> | null> {
  const numeric = kind !== 'flow' && kind !== 'flow_operation'
  if (numeric && !/^\d+$/.test(id)) return null
  if (!numeric && !/^[0-9a-f-]{36}$/i.test(id)) return null
  const row = (await db(TABLE_BY_KIND[kind])
    .where({ id: numeric ? Number(id) : id })
    .first()
    .catch(() => undefined)) as Record<string, unknown> | undefined
  return row ?? null
}

export async function audiencePreviewRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.post<{ Body: { kind?: string; id?: string | number | null; draft?: unknown } }>(
    '/',
    async (req, reply) => {
      markConfigRead(req)
      const b = req.body ?? {}
      const kind = AUDIENCE_KINDS.find((k) => k === b.kind)
      if (!kind)
        return reply.code(400).send({ error: `kind must be one of ${AUDIENCE_KINDS.join(', ')}` })
      const draft =
        b.draft && typeof b.draft === 'object' && !Array.isArray(b.draft)
          ? (b.draft as Record<string, unknown>)
          : {}
      let merged: Record<string, unknown> = { ...draft }
      if (b.id != null && b.id !== '') {
        const stored = await storedConfig(kind, String(b.id))
        if (!stored) return reply.code(404).send({ error: 'Not found' })
        merged = { ...stored, ...draft, id: stored.id }
      }
      const { preview } = await previewAudience(kind, merged)
      return { data: preview }
    }
  )

  app.get('/settings', async () => ({ data: await getAudienceSettings() }))

  app.patch('/settings', async (req, reply) => {
    try {
      const next = await saveAudienceSettings(req.body)
      await logActivity({
        action: 'audience-confirm-settings',
        user: req.user?.id ?? null,
        collection: 'nivaro_settings_overrides',
        comment: JSON.stringify(next),
        req
      })
      return { data: next }
    } catch (err) {
      if (err instanceof AudienceSettingsError) return reply.code(400).send({ error: err.message })
      throw err
    }
  })
}
