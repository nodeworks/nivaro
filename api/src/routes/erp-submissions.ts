import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { callExternalApi } from '../services/external-apis.js'
import { can } from '../services/permissions.js'

// ─── Types ──────────────────────────────────────────────────────────────────

type ErpStatus = 'submitted' | 'pending' | 'accepted' | 'rejected' | 'failed'

const ERP_STATUSES = new Set<ErpStatus>(['submitted', 'pending', 'accepted', 'rejected', 'failed'])

interface ErpSubmissionRow {
  id: number
  collection: string
  item: string
  external_api: number
  external_ref: string | null
  status: ErpStatus
  attempts: number
  last_error: string | null
  payload: string | null
  created_at: Date
  updated_at: Date
}

/** payload column stores { endpoint_path, body } so retries are self-contained. */
interface StoredPayload {
  endpoint_path: string
  body: Record<string, unknown>
}

function parseJson<T>(v: string | null | undefined): T | null {
  if (!v) return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

function serialize(row: ErpSubmissionRow) {
  const stored = parseJson<StoredPayload>(row.payload)
  return {
    id: row.id,
    collection: row.collection,
    item: row.item,
    external_api: row.external_api,
    external_ref: row.external_ref,
    status: row.status,
    attempts: row.attempts,
    last_error: row.last_error,
    endpoint_path: stored?.endpoint_path ?? null,
    payload: stored?.body ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

// ─── Response interpretation ────────────────────────────────────────────────

interface SendOutcome {
  status: ErpStatus
  external_ref: string | null
  error: string | null
}

/**
 * 2xx → 'pending' (or 'accepted' when the body contains an explicit acceptance);
 * non-2xx / thrown → 'failed' with last_error.
 */
function interpretResponse(httpStatus: number, body: unknown): SendOutcome {
  if (httpStatus >= 200 && httpStatus < 300) {
    let status: ErpStatus = 'pending'
    let ref: string | null = null
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const b = body as Record<string, unknown>
      const bodyStatus = typeof b.status === 'string' ? b.status.toLowerCase() : null
      if (b.accepted === true || bodyStatus === 'accepted' || bodyStatus === 'acknowledged') {
        status = 'accepted'
      } else if (bodyStatus === 'rejected') {
        status = 'rejected'
      }
      const refCandidate = b.external_ref ?? b.reference ?? b.ref ?? b.id
      if (typeof refCandidate === 'string' || typeof refCandidate === 'number') {
        ref = String(refCandidate)
      }
    }
    return { status, external_ref: ref, error: null }
  }
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body ?? null)
  return {
    status: 'failed',
    external_ref: null,
    error: `HTTP ${httpStatus}${bodyStr ? `: ${bodyStr.slice(0, 500)}` : ''}`
  }
}

async function sendPayload(
  externalApi: number,
  stored: StoredPayload,
  userId: string | undefined
): Promise<SendOutcome> {
  try {
    const res = await callExternalApi(externalApi, {
      method: 'POST',
      path: stored.endpoint_path,
      body: stored.body,
      timeoutMs: 30_000,
      _log: { triggeredBy: 'erp-submission', userId }
    })
    return interpretResponse(res.status, res.body)
  } catch (err) {
    return {
      status: 'failed',
      external_ref: null,
      error: err instanceof Error ? err.message : 'Request failed'
    }
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function erpSubmissionsRoutes(app: FastifyInstance) {
  // Submit an item to an external ERP system
  app.post<{
    Body: {
      collection: string
      item: string | number
      external_api: number
      endpoint_path: string
      payload_fields?: string[]
    }
  }>('/', { preHandler: authenticate }, async (req, reply) => {
    const { collection, item, external_api, endpoint_path, payload_fields } = req.body ?? {}
    if (!collection || item == null || !external_api || !endpoint_path) {
      return reply
        .code(400)
        .send({ error: 'collection, item, external_api and endpoint_path are required' })
    }
    if (/^nivaro_/i.test(collection)) {
      return reply.code(400).send({ error: 'System collections cannot be submitted' })
    }
    if (!(await can(req.user!, 'update', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const row = (await db(collection).where({ id: item }).first()) as
      | Record<string, unknown>
      | undefined
    if (!row) return reply.code(404).send({ error: 'Item not found' })

    let body: Record<string, unknown>
    if (Array.isArray(payload_fields) && payload_fields.length > 0) {
      body = {}
      for (const f of payload_fields) {
        if (typeof f === 'string' && f in row) body[f] = row[f]
      }
    } else {
      body = { ...row }
    }

    const stored: StoredPayload = { endpoint_path, body }
    const outcome = await sendPayload(external_api, stored, req.user?.id)

    const now = new Date()
    const [inserted] = await db('nivaro_erp_submissions')
      .insert({
        collection,
        item: String(item),
        external_api,
        external_ref: outcome.external_ref,
        status: outcome.status,
        attempts: 1,
        last_error: outcome.error,
        payload: JSON.stringify(stored),
        created_at: now,
        updated_at: now
      })
      .returning('*')

    const created =
      inserted && typeof inserted === 'object'
        ? (inserted as ErpSubmissionRow)
        : ((await db('nivaro_erp_submissions')
            .where({ id: inserted as number })
            .first()) as ErpSubmissionRow)

    await logActivity({
      action: 'create',
      collection: 'nivaro_erp_submissions',
      item: String(created.id),
      user: req.user?.id,
      req,
      comment: `${collection}/${item} → api:${external_api} (${outcome.status})`
    })

    return reply.code(201).send({ data: serialize(created) })
  })

  // Submission history for an item (latest first)
  app.get<{ Params: { collection: string; item: string } }>(
    '/:collection/:item',
    { preHandler: authenticate },
    async (req, reply) => {
      const { collection, item } = req.params
      if (!(await can(req.user!, 'read', collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }
      const rows = (await db('nivaro_erp_submissions')
        .where({ collection, item })
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')) as ErpSubmissionRow[]
      return { data: rows.map(serialize) }
    }
  )

  // Retry a submission — re-sends the same stored payload
  app.post<{ Params: { id: string } }>(
    '/:id/retry',
    { preHandler: authenticate },
    async (req, reply) => {
      const id = Number(req.params.id)
      const row = (await db('nivaro_erp_submissions').where({ id }).first()) as
        | ErpSubmissionRow
        | undefined
      if (!row) return reply.code(404).send({ error: 'Not found' })
      if (!(await can(req.user!, 'update', row.collection))) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      const stored = parseJson<StoredPayload>(row.payload)
      if (!stored?.endpoint_path) {
        return reply.code(400).send({ error: 'Submission has no stored payload to retry' })
      }

      const outcome = await sendPayload(row.external_api, stored, req.user?.id)

      await db('nivaro_erp_submissions')
        .where({ id })
        .update({
          status: outcome.status,
          external_ref: outcome.external_ref ?? row.external_ref,
          attempts: row.attempts + 1,
          last_error: outcome.error,
          updated_at: new Date()
        })

      const updated = (await db('nivaro_erp_submissions').where({ id }).first()) as ErpSubmissionRow

      await logActivity({
        action: 'update',
        collection: 'nivaro_erp_submissions',
        item: String(id),
        user: req.user?.id,
        req,
        comment: `retry #${updated.attempts} (${outcome.status})`
      })

      return { data: serialize(updated) }
    }
  )

  // Manual status override — for webhook-driven updates from the ERP side
  app.patch<{
    Params: { id: string }
    Body: { status: ErpStatus; external_ref?: string | null }
  }>('/:id/status', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number(req.params.id)
    const { status, external_ref } = req.body ?? {}
    if (!status || !ERP_STATUSES.has(status)) {
      return reply
        .code(400)
        .send({ error: `status must be one of: ${Array.from(ERP_STATUSES).join(', ')}` })
    }

    const row = (await db('nivaro_erp_submissions').where({ id }).first()) as
      | ErpSubmissionRow
      | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })

    const patch: Record<string, unknown> = { status, updated_at: new Date() }
    if (external_ref !== undefined) patch.external_ref = external_ref
    await db('nivaro_erp_submissions').where({ id }).update(patch)

    const updated = (await db('nivaro_erp_submissions').where({ id }).first()) as ErpSubmissionRow

    await logActivity({
      action: 'update',
      collection: 'nivaro_erp_submissions',
      item: String(id),
      user: req.user?.id,
      req,
      comment: `status override → ${status}`
    })

    return { data: serialize(updated) }
  })
}
