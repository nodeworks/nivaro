import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Custom user profile fields (#683) — admin-defined extra fields on people
 * (cost center, skills, office floor, emergency contact…), self-served by
 * each user on their own profile.
 *
 * Storage is the EXISTING generic EAV pair (nivaro_attribute_definitions /
 * nivaro_attribute_values) with collection = 'nivaro_users' — definitions are
 * managed through the pre-existing admin /attribute-definitions CRUD; these
 * routes exist because the generic value routes gate on can(read|update,
 * collection), which non-admins rightly fail for nivaro_users. Here the
 * authority is identity, not policy: you may always read the directory's
 * profile fields and write ONLY your own.
 */

const PROFILE_COLLECTION = 'nivaro_users'

interface DefRow {
  id: number
  key: string
  label: string
  type: string
  options: string | null
  required: boolean | number
  sort: number
}

function parseOptions(raw: unknown): unknown {
  if (raw == null) return null
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return null
  }
}

async function activeDefs(): Promise<DefRow[]> {
  return (await db('nivaro_attribute_definitions')
    .where({ collection: PROFILE_COLLECTION, is_active: true })
    .orderBy('sort')
    .orderBy('id')
    .select('id', 'key', 'label', 'type', 'options', 'required', 'sort')
    .catch(() => [])) as DefRow[]
}

async function valuesFor(userId: string): Promise<Map<string, string | null>> {
  const vals = (await db('nivaro_attribute_values')
    .where({ collection: PROFILE_COLLECTION, item_id: String(userId) })
    .select('attribute_key', 'value')
    .catch(() => [])) as Array<{ attribute_key: string; value: string | null }>
  return new Map(vals.map((v) => [v.attribute_key, v.value]))
}

function serialize(defs: DefRow[], values: Map<string, string | null>) {
  return defs.map((d) => ({
    key: d.key,
    label: d.label,
    type: d.type,
    options: parseOptions(d.options),
    required: d.required === true || d.required === 1,
    value: values.get(d.key) ?? null
  }))
}

export async function profileFieldsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  /** Own profile fields — definitions + this user's values. */
  app.get('/mine', { preHandler: requireAuth }, async (req) => {
    const defs = await activeDefs()
    const values = await valuesFor(String(req.user!.id))
    return { data: serialize(defs, values) }
  })

  /** Another user's profile fields — directory-visible like DIRECTORY_USER_COLS. */
  app.get<{ Params: { id: string } }>('/user/:id', { preHandler: requireAuth }, async (req, reply) => {
    const target = (await db('nivaro_users')
      .where({ id: req.params.id })
      .first('id', 'is_redacted')
      .catch(() => null)) as { id: string; is_redacted?: boolean | number } | null
    if (!target || target.is_redacted === true || target.is_redacted === 1) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const defs = await activeDefs()
    const values = await valuesFor(String(target.id))
    return reply.send({ data: serialize(defs, values) })
  })

  /** Write OWN values only. Keys without an active definition are ignored;
   *  select values must be one of the definition's choices. */
  app.put('/mine', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { values?: Record<string, unknown> }
    if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
      return reply.code(400).send({ error: 'values object required' })
    }
    const defs = await activeDefs()
    const byKey = new Map(defs.map((d) => [d.key, d]))
    const userId = String(req.user!.id)
    let written = 0

    for (const [key, raw] of Object.entries(body.values)) {
      const def = byKey.get(key)
      if (!def) continue
      let value = raw == null || raw === '' ? null : String(raw).slice(0, 2000)
      if (value != null) {
        if (def.type === 'number' && !Number.isFinite(Number(value))) {
          return reply.code(400).send({ error: `"${def.label}" must be a number` })
        }
        if (def.type === 'boolean') value = value === 'true' || value === '1' ? 'true' : 'false'
        if (def.type === 'date' && Number.isNaN(new Date(value).getTime())) {
          return reply.code(400).send({ error: `"${def.label}" must be a date` })
        }
        if (def.type === 'select') {
          const opts = parseOptions(def.options)
          const choices = Array.isArray(opts)
            ? opts.map(String)
            : Array.isArray((opts as { choices?: unknown[] } | null)?.choices)
              ? ((opts as { choices: unknown[] }).choices as unknown[]).map((c) =>
                  typeof c === 'object' && c != null
                    ? String((c as { value?: unknown }).value ?? '')
                    : String(c)
                )
              : []
          if (choices.length > 0 && !choices.includes(value)) {
            return reply.code(400).send({ error: `"${def.label}" must be one of the offered choices` })
          }
        }
      }
      const where = { collection: PROFILE_COLLECTION, item_id: userId, attribute_key: key }
      const existing = await db('nivaro_attribute_values').where(where).first('id')
      if (value == null) {
        if (existing) await db('nivaro_attribute_values').where(where).delete()
      } else if (existing) {
        await db('nivaro_attribute_values').where(where).update({ value })
      } else {
        await db('nivaro_attribute_values').insert({ ...where, value })
      }
      written++
    }

    await logActivity({
      action: 'profile-fields-update',
      user: req.user?.id,
      collection: PROFILE_COLLECTION,
      item: userId,
      comment: `${written} field(s)`,
      req
    })
    const values = await valuesFor(userId)
    return reply.send({ data: serialize(defs, values) })
  })
}
