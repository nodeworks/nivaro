import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

function toJsonStr(val: unknown): string | null {
  if (val == null) return null
  if (typeof val === 'string') return val
  return JSON.stringify(val)
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const hash = (await scryptAsync(password, salt, 64)) as Buffer
  return `${salt}:${hash.toString('hex')}`
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const hashBuf = Buffer.from(hash, 'hex')
  const derived = (await scryptAsync(password, salt, 64)) as Buffer
  return hashBuf.length === derived.length && timingSafeEqual(hashBuf, derived)
}

function generateToken(): string {
  return randomUUID().replace(/-/g, '').slice(0, 32)
}

function formatForm(row: Record<string, unknown>) {
  return {
    ...row,
    fields: parseJson<string[]>(row.fields as string) ?? [],
    form_config: parseJson<Record<string, unknown>>(row.form_config as string) ?? null,
    is_active: !!row.is_active,
    password_hash: undefined // never expose hashes
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function submissionFormsRoutes(app: FastifyInstance) {
  // ── Admin routes ─────────────────────────────────────────────────────────────

  // GET / — list all forms with submission count
  app.get('/', { preHandler: requireAdmin }, async (_req, reply) => {
    const forms = await db('nivaro_submission_forms as f')
      .leftJoin(
        db('nivaro_submissions').select('form').count('id as cnt').groupBy('form').as('s'),
        's.form',
        'f.id'
      )
      .select('f.*', db.raw('COALESCE(s.cnt, 0) as submission_count'))
      .orderBy('f.created_at', 'desc')

    return reply.send({ data: forms.map(formatForm) })
  })

  // GET /:id — get one form with submission count
  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params
    const row = await db('nivaro_submission_forms as f')
      .leftJoin(
        db('nivaro_submissions').select('form').count('id as cnt').groupBy('form').as('s'),
        's.form',
        'f.id'
      )
      .select('f.*', db.raw('COALESCE(s.cnt, 0) as submission_count'))
      .where('f.id', id)
      .first()

    if (!row) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: formatForm(row as Record<string, unknown>) })
  })

  // POST / — create form
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      name: string
      collection: string
      fields: string[]
      form_config?: Record<string, unknown> | null
      password?: string
      expires_at?: string | null
      rate_limit_per_hour?: number
      is_active?: boolean
      success_message?: string | null
    }

    if (!body.name?.trim()) return reply.code(400).send({ error: 'name is required' })
    if (!body.collection?.trim()) return reply.code(400).send({ error: 'collection is required' })
    if (!Array.isArray(body.fields) || body.fields.length === 0) {
      return reply.code(400).send({ error: 'fields must be a non-empty array' })
    }

    const id = randomUUID()
    const token = generateToken()
    const password_hash = body.password ? await hashPassword(body.password) : null

    await db('nivaro_submission_forms').insert({
      id,
      name: body.name.trim(),
      collection: body.collection.trim(),
      fields: toJsonStr(body.fields),
      form_config: body.form_config != null ? toJsonStr(body.form_config) : null,
      token,
      password_hash,
      expires_at: body.expires_at ? new Date(body.expires_at) : null,
      rate_limit_per_hour: body.rate_limit_per_hour ?? 60,
      is_active: body.is_active !== false ? 1 : 0,
      success_message: body.success_message ?? null,
      created_by: req.user?.id ?? null,
      created_at: new Date(),
      updated_at: new Date()
    })

    const form = await db('nivaro_submission_forms').where({ id }).first()

    await logActivity({
      action: 'create',
      collection: 'nivaro_submission_forms',
      item: id,
      user: req.user?.id,
      req
    })

    return reply.code(201).send({ data: formatForm(form as Record<string, unknown>) })
  })

  // PATCH /:id — update form
  app.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params
      const existing = await db('nivaro_submission_forms').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      const body = req.body as {
        name?: string
        collection?: string
        fields?: string[]
        form_config?: Record<string, unknown> | null
        password?: string
        expires_at?: string | null
        rate_limit_per_hour?: number
        is_active?: boolean
        success_message?: string | null
      }

      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (body.name !== undefined) patch.name = body.name.trim()
      if (body.collection !== undefined) patch.collection = body.collection.trim()
      if (body.fields !== undefined) patch.fields = toJsonStr(body.fields)
      if (body.form_config !== undefined)
        patch.form_config = body.form_config != null ? toJsonStr(body.form_config) : null
      if (body.password !== undefined && body.password !== '') {
        patch.password_hash = await hashPassword(body.password)
      } else if (body.password === '') {
        // Empty string clears the password
        patch.password_hash = null
      }
      if (body.expires_at !== undefined) {
        patch.expires_at = body.expires_at ? new Date(body.expires_at) : null
      }
      if (body.rate_limit_per_hour !== undefined) {
        patch.rate_limit_per_hour = body.rate_limit_per_hour
      }
      if (body.is_active !== undefined) patch.is_active = body.is_active ? 1 : 0
      if (body.success_message !== undefined) patch.success_message = body.success_message

      await db('nivaro_submission_forms').where({ id }).update(patch)
      const updated = await db('nivaro_submission_forms').where({ id }).first()

      await logActivity({
        action: 'update',
        collection: 'nivaro_submission_forms',
        item: id,
        user: req.user?.id,
        req
      })

      return reply.send({ data: formatForm(updated as Record<string, unknown>) })
    }
  )

  // DELETE /:id — delete form + cascade submissions
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params
      const existing = await db('nivaro_submission_forms').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      await db('nivaro_submissions').where({ form: id }).delete()
      await db('nivaro_submission_forms').where({ id }).delete()

      await logActivity({
        action: 'delete',
        collection: 'nivaro_submission_forms',
        item: id,
        user: req.user?.id,
        req
      })

      return reply.code(204).send()
    }
  )

  // GET /:id/submissions — list submissions (paginated)
  app.get<{ Params: { id: string }; Querystring: { page?: string; limit?: string } }>(
    '/:id/submissions',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params
      const page = Math.max(1, Number(req.query.page ?? 1))
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25)))
      const offset = (page - 1) * limit

      const existing = await db('nivaro_submission_forms').where({ id }).first()
      if (!existing) return reply.code(404).send({ error: 'Not found' })

      const [{ total }] = (await db('nivaro_submissions')
        .where({ form: id })
        .count('id as total')) as [{ total: number }]

      const rows = await db('nivaro_submissions')
        .where({ form: id })
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset)

      const submissions = rows.map((r: Record<string, unknown>) => ({
        ...r,
        data: parseJson(r.data as string) ?? {}
      }))

      return reply.send({
        data: submissions,
        total: Number(total),
        page,
        limit
      })
    }
  )

  // DELETE /:id/submissions/:subId — delete a single submission
  app.delete<{ Params: { id: string; subId: string } }>(
    '/:id/submissions/:subId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id, subId } = req.params
      const sub = await db('nivaro_submissions').where({ id: subId, form: id }).first()
      if (!sub) return reply.code(404).send({ error: 'Not found' })

      await db('nivaro_submissions').where({ id: subId }).delete()

      await logActivity({
        action: 'delete',
        collection: 'nivaro_submissions',
        item: subId,
        user: req.user?.id,
        req
      })

      return reply.code(204).send()
    }
  )

  // ── Public routes (no auth) ───────────────────────────────────────────────────

  // GET /public/:token — return form metadata (no password info)
  app.get<{ Params: { token: string } }>('/public/:token', async (req, reply) => {
    const { token } = req.params
    const form = await db('nivaro_submission_forms').where({ token }).first()

    if (!form) return reply.code(404).send({ error: 'Form not found' })
    if (!form.is_active) return reply.code(404).send({ error: 'Form not found' })
    if (form.expires_at && new Date(form.expires_at) < new Date()) {
      return reply.code(404).send({ error: 'Form not found' })
    }

    return reply.send({
      data: {
        name: form.name,
        collection: form.collection,
        fields: parseJson<string[]>(form.fields) ?? [],
        success_message: form.success_message ?? null,
        has_password: !!form.password_hash
      }
    })
  })

  // POST /public/:token — submit the form
  app.post<{ Params: { token: string } }>('/public/:token', async (req, reply) => {
    const { token } = req.params
    const body = req.body as { data?: Record<string, unknown>; password?: string }

    const form = await db('nivaro_submission_forms').where({ token }).first()

    if (!form) return reply.code(404).send({ error: 'Form not found' })
    if (!form.is_active) return reply.code(404).send({ error: 'Form not found' })
    if (form.expires_at && new Date(form.expires_at) < new Date()) {
      return reply.code(410).send({ error: 'This form has expired' })
    }

    // Password check
    if (form.password_hash) {
      if (!body.password) {
        return reply.code(401).send({ error: 'Password required' })
      }
      if (!(await verifyPassword(body.password, form.password_hash))) {
        return reply.code(401).send({ error: 'Incorrect password' })
      }
    }

    // Rate limiting: count submissions from this IP in the last hour
    const ip = req.ip ?? null
    if (ip) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
      const [{ count: recentCount }] = (await db('nivaro_submissions')
        .where({ form: form.id, ip })
        .where('created_at', '>=', oneHourAgo)
        .count('id as count')) as [{ count: number }]

      if (Number(recentCount) >= Number(form.rate_limit_per_hour)) {
        return reply.code(429).send({ error: 'Rate limit exceeded. Please try again later.' })
      }
    }

    // Whitelist submitted data against allowed fields
    const allowedFields = parseJson<string[]>(form.fields) ?? []
    const submittedData = body.data ?? {}
    const filteredData: Record<string, unknown> = {}
    for (const field of allowedFields) {
      if (field in submittedData) {
        filteredData[field] = submittedData[field]
      }
    }

    // Insert into the target collection
    const collectionId = randomUUID()
    await db(form.collection).insert({
      id: collectionId,
      ...filteredData,
      created_at: new Date(),
      updated_at: new Date()
    })

    // Insert submission record
    const submissionId = randomUUID()
    await db('nivaro_submissions').insert({
      id: submissionId,
      form: form.id,
      data: toJsonStr(filteredData),
      ip,
      created_at: new Date()
    })

    return reply.code(201).send({
      data: {
        id: submissionId,
        message: form.success_message || 'Submitted successfully'
      }
    })
  })
}
