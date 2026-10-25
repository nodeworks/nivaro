import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can, getAllowedFields } from '../services/permissions.js'

function parseJsonSafe(val: unknown): unknown {
  if (typeof val !== 'string') return val
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}

/** Fields of `collection` the caller may read (null = every field); null for
 *  a record they cannot open (readOne as the caller: row filter, User Scopes). */
async function readableFields(
  req: FastifyRequest,
  collection: string,
  itemId: string
): Promise<{ has: (f: string) => boolean } | null> {
  const { readOne } = await import('../services/items.js')
  const row = await readOne(req.user!, collection, itemId, req.workspaceId ?? undefined, [
    'id'
  ]).catch(() => null)
  if (!row) return null
  const allowed = req.isAdmin ? null : await getAllowedFields(req.user!, 'read', collection)
  const all = allowed === null || allowed.includes('*')
  return { has: (f) => all || (allowed ?? []).includes(f) }
}

/**
 * The gates a PATCH of the record itself runs, for changing its
 * translations: visible, updatable (canUpdateItem), not edit-locked, and
 * only registered fields the caller may update. Sends the refusal and
 * answers false.
 */
async function mayWriteTranslations(
  req: FastifyRequest,
  reply: FastifyReply,
  collection: string,
  itemId: string,
  fields: string[]
): Promise<boolean> {
  if (/^(nivaro|directus)_/i.test(collection) && !req.isAdmin) {
    reply.code(403).send({ error: 'Forbidden' })
    return false
  }
  if (!(await can(req.user!, 'update', collection))) {
    reply.code(403).send({ error: 'Forbidden' })
    return false
  }
  if (!(await readableFields(req, collection, itemId))) {
    reply.code(404).send({ error: 'Not found' })
    return false
  }
  const known = new Set(
    (
      (await db('nivaro_fields').where({ collection }).select('field')) as Array<{ field: string }>
    ).map((f) => f.field)
  )
  const unknown = fields.find((f) => !known.has(f))
  if (unknown) {
    reply.code(400).send({ error: `Unknown field: ${unknown}` })
    return false
  }
  if (!req.isAdmin) {
    const { canUpdateItem } = await import('../services/items.js')
    if (!(await canUpdateItem(req.user!, collection, itemId, req.workspaceId ?? undefined))) {
      reply.code(403).send({ error: 'You cannot change this record' })
      return false
    }
    const allowed = await getAllowedFields(req.user!, 'update', collection)
    const blocked =
      allowed === null || allowed.includes('*')
        ? undefined
        : fields.find((f) => !allowed.includes(f))
    if (blocked) {
      reply.code(403).send({ error: `You cannot change ${blocked}` })
      return false
    }
  }
  const { assertNotEditLocked, EditLockedError, EDIT_LOCKED } = await import(
    '../services/edit-lock.js'
  )
  try {
    await assertNotEditLocked(req.user, collection, { ids: [itemId] }, req)
  } catch (e) {
    const message =
      e instanceof EditLockedError
        ? e.message
        : 'Could not confirm you may change this record while it waits.'
    reply.code(403).send({ error: message, code: EDIT_LOCKED })
    return false
  }
  return true
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
    const readable = await readableFields(req, collection, itemId)
    if (!readable) return reply.code(404).send({ error: 'Not found' })

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
      if (!readable.has(row.field)) continue
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
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'Body must be { [field]: { [locale]: value } }' })
    }
    if (!(await mayWriteTranslations(req, reply, collection, itemId, Object.keys(body)))) return

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
    const readable = await readableFields(req, collection, itemId)
    if (!readable || !readable.has(field)) return reply.code(404).send({ error: 'Not found' })

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
    if (!(await mayWriteTranslations(req, reply, collection, itemId, [field]))) return

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
