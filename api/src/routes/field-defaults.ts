import type { FastifyInstance, FastifyReply } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import {
  allowedForPerson,
  deleteDefault,
  type FieldDefaultInput,
  FieldDefaultRefusal,
  hasAllowedField,
  listDefaults,
  saveDefault,
  withFormState
} from '../services/field-defaults.js'
import { getUser } from '../services/users.js'
import type { User } from '../types.js'

/**
 * Personal field defaults (spec 2026-10-28-personal-field-defaults-design).
 *
 * GET    /field-defaults/mine?collection=      the caller's own defaults (?on_layout=1 adds
 *                                              on_layout: some form they get still allows it)
 * GET    /field-defaults/mine/allowed          [{collection, label, fields}] they may keep one for
 *                                              (?any=1 → { any: boolean }, stops at the first)
 * PUT    /field-defaults/mine                  { collection, field, value, context } upsert
 * DELETE /field-defaults/mine/:id
 * Admin (validated AS the person, logged as the admin):
 * GET    /field-defaults/users/:userId?collection=   (?on_layout=1 as above)
 * GET    /field-defaults/users/:userId/allowed
 * PUT    /field-defaults/users/:userId
 * DELETE /field-defaults/users/:userId/:id
 */

function bodyOf(raw: unknown): FieldDefaultInput | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  if (typeof b.collection !== 'string' || typeof b.field !== 'string') return null
  const context = b.context ?? {}
  if (typeof context !== 'object' || context === null || Array.isArray(context)) return null
  return {
    collection: b.collection,
    field: b.field,
    value: b.value,
    context: context as Record<string, unknown>
  }
}

function collectionQuery(q: unknown): string | undefined {
  const c = (q as { collection?: unknown } | undefined)?.collection
  return typeof c === 'string' && c.trim() ? c.trim() : undefined
}

function wantsFlag(q: unknown, name: string): boolean {
  const v = (q as Record<string, unknown> | undefined)?.[name]
  return v === '1' || v === 'true'
}

/** The list as answered: on_layout added only when asked (the form's read skips that cost). */
async function listFor(user: User, query: unknown) {
  const rows = await listDefaults(user.id, collectionQuery(query))
  return wantsFlag(query, 'on_layout') ? withFormState(user, rows) : rows
}

function refuse(reply: FastifyReply, err: unknown) {
  if (err instanceof FieldDefaultRefusal)
    return reply.code(err.status).send({ error: err.message, code: err.code })
  throw err
}

export async function fieldDefaultsRoutes(app: FastifyInstance) {
  app.get('/mine', { preHandler: requireAuth }, async (req, reply) => {
    return reply.send({ data: await listFor(req.user!, req.query) })
  })

  app.get('/mine/allowed', { preHandler: requireAuth }, async (req, reply) => {
    // ?any=1: the own profile only needs to know whether the card has anything to offer.
    if (wantsFlag(req.query, 'any'))
      return reply.send({ data: { any: await hasAllowedField(req.user!) } })
    return reply.send({ data: await allowedForPerson(req.user!) })
  })

  app.put('/mine', { preHandler: requireAuth }, async (req, reply) => {
    const input = bodyOf(req.body)
    if (!input)
      return reply.code(400).send({ error: 'collection and field are required', code: 'BAD_BODY' })
    try {
      return reply.send({ data: await saveDefault(req.user!, req.user!, input) })
    } catch (err) {
      return refuse(reply, err)
    }
  })

  app.delete('/mine/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id)
    if (!(await deleteDefault(req.user!.id, id)))
      return reply.code(404).send({ error: 'Default not found', code: 'DEFAULT_NOT_FOUND' })
    return reply.send({ data: { id } })
  })

  // ── Admin: anyone's defaults ───────────────────────────────────────────────

  app.get('/users/:userId', { preHandler: requireAdmin }, async (req, reply) => {
    const target = await getUser((req.params as { userId: string }).userId)
    if (!target) return reply.code(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' })
    return reply.send({ data: await listFor(target, req.query) })
  })

  app.get('/users/:userId/allowed', { preHandler: requireAdmin }, async (req, reply) => {
    const target = await getUser((req.params as { userId: string }).userId)
    if (!target) return reply.code(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' })
    return reply.send({ data: await allowedForPerson(target) })
  })

  app.put('/users/:userId', { preHandler: requireAdmin }, async (req, reply) => {
    const input = bodyOf(req.body)
    if (!input)
      return reply.code(400).send({ error: 'collection and field are required', code: 'BAD_BODY' })
    const target = await getUser((req.params as { userId: string }).userId)
    if (!target) return reply.code(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' })
    try {
      return reply.send({ data: await saveDefault(target, req.user!, input) })
    } catch (err) {
      return refuse(reply, err)
    }
  })

  app.delete('/users/:userId/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const params = req.params as { userId: string; id: string }
    const target = await getUser(params.userId)
    if (!target) return reply.code(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' })
    const id = Number(params.id)
    if (!(await deleteDefault(target.id, id, req.user!)))
      return reply.code(404).send({ error: 'Default not found', code: 'DEFAULT_NOT_FOUND' })
    return reply.send({ data: { id } })
  })
}
