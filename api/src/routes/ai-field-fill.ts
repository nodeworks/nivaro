import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  AI_FILL_KEY,
  buildFieldFillPrompt,
  cleanFieldValue,
  FIELD_FILL_SYSTEM,
  promptTokens,
  readAiFill,
  renderPrompt,
  takeFieldFillSlot
} from '../services/ai-design/field-fill.js'
import { AiUnavailableError, defaultComplete, titleCase } from '../services/ai-design/model.js'
import { canUpdateItem, readOne } from '../services/items.js'
import { parseRecordConditions, roleAllows } from '../services/layout-patch.js'
import { can, getAllowedFields } from '../services/permissions.js'
import { isSystemCollection } from '../services/system-collections.js'
import { matchesRecordConditions } from './collection-layouts.js'

/**
 * POST /ai/field-fill (#2692) — the AI button a layout turns on for one field.
 *
 * Unlike POST /ai/generate (admins, the whole record as context) this is open
 * to everyone who may write the field, and sends only what the admin's prompt
 * template names. Gates, in order: a non-system collection; a record form of
 * this collection the caller's role may open, whose record rules (if any)
 * match the record; a placement of the field on that form (or the form it
 * inherits from) with `ai_generate.enabled`; the record visible to the caller
 * (readOne null = 404) and updatable by them (canUpdateItem), or create
 * permission for a new record (never on a form with record rules); the field
 * in the caller's writable fields (`*` = all); a per-person rate limit
 * (cluster-wide). Token values are read as the caller and only from
 * fields they may read (encrypted fields never). The answer is a proposal the
 * form puts in the draft — nothing is saved here.
 */

const MAX_PARENT_HOPS = 3

/** getAllowedFields semantics: null = every field; a literal `*` in the list too. */
const fieldAllowed = (list: string[] | null, field: string) =>
  list == null || list.includes('*') || list.includes(field)

async function placementOverrides(layoutId: number, field: string): Promise<unknown | null> {
  let id: number | null = layoutId
  for (let hop = 0; id != null && hop <= MAX_PARENT_HOPS; hop++) {
    const rows = (await db('nivaro_layout_field_assignments')
      .where({ layout_id: id, field })
      .select('overrides')) as Array<{ overrides: unknown }>
    const withSetting = rows.find((r) => readAiFill(r.overrides) != null)
    if (withSetting) return withSetting.overrides
    if (rows.length > 0) return rows[0].overrides
    const layout = (await db('nivaro_collection_layouts')
      .where({ id })
      .first('parent_layout_id')) as { parent_layout_id: number | null } | undefined
    id = layout?.parent_layout_id != null ? Number(layout.parent_layout_id) : null
  }
  return null
}

export async function aiFieldFillRoutes(app: FastifyInstance) {
  app.post<{
    Body: {
      collection?: string
      layout_id?: number | string
      field?: string
      item_id?: string | number | null
      values?: Record<string, unknown>
    }
  }>('/field-fill', { preHandler: authenticate }, async (req, reply) => {
    const user = req.user
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    const b = req.body ?? {}
    const collection = typeof b.collection === 'string' ? b.collection : ''
    const field = typeof b.field === 'string' ? b.field : ''
    const layoutId = Number(b.layout_id)
    const itemId =
      b.item_id != null && b.item_id !== '' && b.item_id !== 'new' ? String(b.item_id) : null
    if (!collection || !field || !Number.isFinite(layoutId))
      return reply.code(400).send({ error: 'collection, layout_id and field are required' })
    const denied = () => reply.code(403).send({ error: 'AI fill is not available on this field' })
    if (isSystemCollection(collection)) return denied()

    const layout = (await db('nivaro_collection_layouts')
      .where({ id: layoutId, collection })
      .first()) as Record<string, unknown> | undefined
    if (!layout) return reply.code(404).send({ error: 'Layout not found' })
    const type = layout.layout_type == null ? 'grouped' : String(layout.layout_type)
    if (type !== 'grouped' || !roleAllows(layout, user.role ?? null, !!req.isAdmin)) return denied()

    const config = readAiFill(await placementOverrides(layoutId, field))
    if (!config?.enabled || !config.prompt) return denied()

    const workspaceId = req.workspaceId ?? undefined
    let record: Record<string, unknown> | null = null
    if (itemId) {
      record = (await readOne(user, collection, itemId, workspaceId).catch(() => null)) as Record<
        string,
        unknown
      > | null
      if (!record) return reply.code(404).send({ error: 'Not found' })
      if (!(await canUpdateItem(user, collection, itemId, workspaceId))) return denied()
      // A record form with record rules is only this record's form when they match.
      const rules = parseRecordConditions(layout.record_conditions)
      if (rules && !req.isAdmin) {
        const cols = [...new Set(rules.map((r) => r.field).filter((f) => typeof f === 'string'))]
        const raw = (await db(collection)
          .where({ id: itemId })
          .first(cols.length ? cols : ['id'])
          .catch(() => null)) as Record<string, unknown> | null
        if (!raw || !matchesRecordConditions(rules, raw)) return denied()
      }
    } else {
      if (!(await can(user, 'create', collection))) return denied()
      // A form with record rules is never a new record's form (layout resolution needs a
      // saved record to test them), so it offers no AI fill before the record exists.
      if (parseRecordConditions(layout.record_conditions) && !req.isAdmin) return denied()
    }

    const writable = await getAllowedFields(user, itemId ? 'update' : 'create', collection)
    if (!fieldAllowed(writable, field)) return denied()

    if (!(await takeFieldFillSlot(app.redis, String(user.id))))
      return reply
        .code(429)
        .send({ error: 'Too many AI fills in a few minutes — try again shortly' })

    const complete = await defaultComplete('generate')
    if (!complete) return reply.code(503).send({ error: new AiUnavailableError().message })

    const fieldRows = (await db('nivaro_fields')
      .where({ collection })
      .whereIn('field', [...new Set([field, ...promptTokens(config.prompt)])])
      .select('*')) as Array<Record<string, unknown>>
    const byName = new Map(fieldRows.map((r) => [String(r.field), r]))
    const readFields = await getAllowedFields(user, 'read', collection)
    const readable = (name: string) => {
      const row = byName.get(name)
      if (!row || row.is_encrypted === true || row.is_encrypted === 1) return false
      return fieldAllowed(readFields, name)
    }
    // The draft wins over the stored record: the person may have typed since.
    const draft =
      b.values && typeof b.values === 'object' && !Array.isArray(b.values) ? b.values : {}
    const values: Record<string, unknown> = { ...(record ?? {}) }
    for (const name of promptTokens(config.prompt)) if (name in draft) values[name] = draft[name]
    const { text, missing } = renderPrompt(config.prompt, values, readable)

    const meta = byName.get(field)
    const fieldType = meta?.type == null ? null : String(meta.type)
    const maxLength = fieldType === 'string' ? 255 : null
    let answer: string
    try {
      answer = await complete({
        system: FIELD_FILL_SYSTEM,
        user: buildFieldFillPrompt({
          instructions: text,
          label: String(meta?.label || titleCase(field)),
          type: fieldType,
          maxLength
        }),
        maxTokens: fieldType === 'string' ? 200 : 1200
      })
    } catch (err) {
      return reply.code(502).send({
        error: `The AI could not fill this field: ${(err as Error).message}`.slice(0, 400)
      })
    }
    const value = cleanFieldValue(answer, maxLength)
    await logActivity({
      action: 'ai-generate',
      user: user.id,
      collection,
      item: itemId ?? undefined,
      comment: `${field} (${AI_FILL_KEY}, layout ${layoutId})`,
      req
    })
    return reply.send({ data: { value, missing } })
  })
}
