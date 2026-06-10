import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

// ─── Predefined scopes ────────────────────────────────────────────────────────

export const BLACKOUT_SCOPES = ['mdsi', 'flows', 'pipeline', 'workflow'] as const
export type BlackoutScope = (typeof BLACKOUT_SCOPES)[number]

// ─── Types ──────────────────────────────────────────────────────────────────

interface BlackoutDateRow {
  id: number
  date: string | Date
  label: string | null
  scope: string | null // JSON array stored as text (null = applies to all)
  created_at: Date
}

// ─── JSON helpers ───────────────────────────────────────────────────────────

function parseJson<T = unknown>(val: string | null | undefined): T | null {
  if (val == null) return null
  if (typeof val !== 'string') return val as T
  try {
    return JSON.parse(val) as T
  } catch {
    return null
  }
}

function toJsonStr(val: unknown): string | null {
  if (val == null) return null
  if (typeof val === 'string') return val
  return JSON.stringify(val)
}

// Normalize a date value to YYYY-MM-DD for comparison/serialization.
function toDateStr(val: string | Date): string {
  if (val instanceof Date) return val.toISOString().slice(0, 10)
  return String(val).slice(0, 10)
}

function isValidDate(val: unknown): val is string {
  if (typeof val !== 'string') return false
  const d = new Date(val)
  return !Number.isNaN(d.getTime())
}

function serializeRow(row: BlackoutDateRow) {
  return {
    id: row.id,
    date: toDateStr(row.date),
    label: row.label,
    scope: parseJson<string[]>(row.scope),
    created_at: row.created_at
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function blackoutDatesRoutes(app: FastifyInstance) {
  // Predefined scope list (no auth required).
  app.get('/scopes', async () => {
    return { data: BLACKOUT_SCOPES }
  })

  // List (auth).
  app.get('/', { preHandler: requireAuth }, async () => {
    const rows = (await db('nivaro_blackout_dates')
      .orderBy('date', 'asc')
      .select('*')) as BlackoutDateRow[]
    return { data: rows.map(serializeRow) }
  })

  // Check (auth) — is a given date a blackout for any of the given scopes?
  app.get<{ Querystring: { date?: string; scopes?: string } }>(
    '/check',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { date } = req.query
      if (!isValidDate(date)) {
        return reply.code(400).send({ error: 'A valid date is required' })
      }
      const target = toDateStr(date)
      const requestedScopes = (req.query.scopes ?? '').split(',').filter(Boolean)

      const blackouts = (await db('nivaro_blackout_dates')
        .whereRaw('CAST(date AS DATE) = ?', [target])
        .select('*')) as BlackoutDateRow[]

      let matched: BlackoutDateRow | undefined
      for (const b of blackouts) {
        const scopes = parseJson<string[]>(b.scope)
        if (!scopes || scopes.length === 0) {
          // No scopes set = applies to all.
          matched = b
          break
        }
        if (requestedScopes.length === 0) {
          // No filter = any scope matches.
          matched = b
          break
        }
        if (scopes.some((s) => requestedScopes.includes(s))) {
          matched = b
          break
        }
      }

      return {
        data: { isBlackout: !!matched, label: matched?.label ?? null }
      }
    }
  )

  // Create (admin)
  app.post<{ Body: { date: string; label?: string | null; scope?: string[] | null } }>(
    '/',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const body = req.body
      if (!isValidDate(body?.date)) {
        return reply.code(400).send({ error: 'A valid date is required' })
      }
      const [inserted] = await db('nivaro_blackout_dates')
        .insert({
          date: toDateStr(body.date),
          label: body.label ?? null,
          scope: body.scope != null ? toJsonStr(body.scope) : null,
          created_at: new Date()
        })
        .returning('*')

      const row =
        inserted && typeof inserted === 'object'
          ? (inserted as BlackoutDateRow)
          : ((await db('nivaro_blackout_dates')
              .where({ id: inserted as number })
              .first()) as BlackoutDateRow)

      await logActivity({
        action: 'create',
        user: req.user?.id,
        collection: 'nivaro_blackout_dates',
        item: String(row.id),
        req
      })
      return reply.code(201).send({ data: serializeRow(row) })
    }
  )

  // Update (admin)
  app.patch<{
    Params: { id: string }
    Body: Partial<{ date: string; label: string | null; scope: string[] | null }>
  }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_blackout_dates').where({ id }).first()) as
      | BlackoutDateRow
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body ?? {}
    const patch: Record<string, unknown> = {}

    if (body.date !== undefined) {
      if (!isValidDate(body.date)) {
        return reply.code(400).send({ error: 'A valid date is required' })
      }
      patch.date = toDateStr(body.date)
    }
    if (body.label !== undefined) patch.label = body.label
    if (body.scope !== undefined) patch.scope = body.scope != null ? toJsonStr(body.scope) : null

    if (Object.keys(patch).length > 0) {
      await db('nivaro_blackout_dates').where({ id }).update(patch)
    }
    const row = (await db('nivaro_blackout_dates').where({ id }).first()) as BlackoutDateRow
    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_blackout_dates',
      item: String(id),
      req
    })
    return { data: serializeRow(row) }
  })

  // Delete (admin)
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const deleted = await db('nivaro_blackout_dates')
        .where({ id: Number(req.params.id) })
        .delete()
      if (!deleted) return reply.code(404).send({ error: 'Not found' })
      await logActivity({
        action: 'delete',
        user: req.user?.id,
        collection: 'nivaro_blackout_dates',
        item: String(req.params.id),
        req
      })
      return reply.code(204).send()
    }
  )
}
