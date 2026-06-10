import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

function parseJsonSafe(val: unknown): unknown {
  if (typeof val !== 'string') return val
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}

export async function fieldTranslationsRoutes(app: FastifyInstance) {
  // GET /field-translations/locales — must be registered BEFORE /:collection/:itemId to avoid conflict
  app.get('/locales', { preHandler: authenticate }, async (_req, reply) => {
    const settings = await db('nivaro_settings').first('available_locales')
    let locales: string[] = ['en']

    if (settings?.available_locales) {
      const parsed = parseJsonSafe(settings.available_locales)
      if (Array.isArray(parsed)) locales = parsed as string[]
    }

    return reply.send({ data: locales })
  })

  // GET /field-translations/:collection/:itemId — get all translations for an item
  app.get('/:collection/:itemId', { preHandler: authenticate }, async (req, reply) => {
    const { collection, itemId } = req.params as { collection: string; itemId: string }

    const rows = (await db('nivaro_field_translations')
      .where({ collection, item_id: itemId })
      .select('field', 'locale', 'value')) as Array<{
      field: string
      locale: string
      value: string
    }>

    // Build nested structure: { [field]: { [locale]: value } }
    const result: Record<string, Record<string, string>> = {}
    for (const row of rows) {
      if (!result[row.field]) result[row.field] = {}
      result[row.field][row.locale] = row.value
    }

    return reply.send({ data: result })
  })

  // PATCH /field-translations/:collection/:itemId — upsert translations
  app.patch('/:collection/:itemId', { preHandler: authenticate }, async (req, reply) => {
    const { collection, itemId } = req.params as { collection: string; itemId: string }
    const body = req.body as Record<string, Record<string, string>>

    if (collection.startsWith('nivaro_')) return reply.code(403).send({ error: 'Forbidden' })
    if (!(await can(req.user!, 'update', collection)))
      return reply.code(403).send({ error: 'Forbidden' })

    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'Body must be { [field]: { [locale]: value } }' })
    }

    const now = new Date()

    for (const [field, localeMap] of Object.entries(body)) {
      if (!localeMap || typeof localeMap !== 'object') continue
      for (const [locale, value] of Object.entries(localeMap)) {
        // MSSQL doesn't support INSERT ... ON CONFLICT; simulate upsert
        const existing = await db('nivaro_field_translations')
          .where({ collection, item_id: itemId, field, locale })
          .first()

        if (existing) {
          await db('nivaro_field_translations')
            .where({ collection, item_id: itemId, field, locale })
            .update({ value, updated_at: now })
        } else {
          await db('nivaro_field_translations').insert({
            collection,
            item_id: itemId,
            field,
            locale,
            value,
            created_at: now,
            updated_at: now
          })
        }
      }
    }

    // Return updated state
    const rows = (await db('nivaro_field_translations')
      .where({ collection, item_id: itemId })
      .select('field', 'locale', 'value')) as Array<{
      field: string
      locale: string
      value: string
    }>

    const result: Record<string, Record<string, string>> = {}
    for (const row of rows) {
      if (!result[row.field]) result[row.field] = {}
      result[row.field][row.locale] = row.value
    }

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection,
      item: String(itemId),
      comment: 'translations',
      req
    })

    return reply.send({ data: result })
  })

  // GET /field-translations/:collection/:itemId/:field — translations for a single field
  app.get('/:collection/:itemId/:field', { preHandler: authenticate }, async (req, reply) => {
    const { collection, itemId, field } = req.params as {
      collection: string
      itemId: string
      field: string
    }

    const rows = (await db('nivaro_field_translations')
      .where({ collection, item_id: itemId, field })
      .select('locale', 'value')) as Array<{ locale: string; value: string }>

    const result: Record<string, string> = {}
    for (const row of rows) {
      result[row.locale] = row.value
    }

    return reply.send({ data: result })
  })

  // DELETE /field-translations/:collection/:itemId/:field — delete all translations for a field
  app.delete('/:collection/:itemId/:field', { preHandler: authenticate }, async (req, reply) => {
    const { collection, itemId, field } = req.params as {
      collection: string
      itemId: string
      field: string
    }

    await db('nivaro_field_translations').where({ collection, item_id: itemId, field }).delete()

    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection,
      item: String(itemId),
      comment: `translations:${field}`,
      req
    })

    return reply.code(204).send()
  })
}
