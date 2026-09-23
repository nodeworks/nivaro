import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { propagateSubmissionStatus } from '../services/erp-submission-status.js'
import { callExternalApi } from '../services/external-apis.js'
import { can } from '../services/permissions.js'
import { detectBodyAcceptance, serializeResponseBody } from '../services/workflow-actions.js'

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
  response: string | null
  obligation_id: number | null
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
    response: parseJson(row.response) ?? row.response ?? null,
    obligation_id: row.obligation_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

// ─── Response interpretation ────────────────────────────────────────────────

interface SendOutcome {
  status: ErpStatus
  external_ref: string | null
  error: string | null
  response: unknown
  // #628 — the raw HTTP status this outcome came from, `null` when the
  // request never got a response at all (a thrown network failure). Carried
  // through so `classifyError` (integration-remediation.ts) can tell a 404
  // apart from a 500 apart from a refused socket — the three read very
  // differently for "would sending this again help?". Optional-safe for any
  // older caller building a SendOutcome-shaped object by hand.
  http_status?: number | null
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
      if (
        b.accepted === true ||
        bodyStatus === 'accepted' ||
        bodyStatus === 'acknowledged' ||
        detectBodyAcceptance(null, body)
      ) {
        status = 'accepted'
      } else if (bodyStatus === 'rejected') {
        status = 'rejected'
      }
      const refCandidate = b.external_ref ?? b.reference ?? b.ref ?? b.id
      if (typeof refCandidate === 'string' || typeof refCandidate === 'number') {
        ref = String(refCandidate)
      }
    }
    return { status, external_ref: ref, error: null, response: body, http_status: httpStatus }
  }
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body ?? null)
  return {
    status: 'failed',
    external_ref: null,
    error: `HTTP ${httpStatus}${bodyStr ? `: ${bodyStr.slice(0, 500)}` : ''}`,
    response: body,
    http_status: httpStatus
  }
}

export async function sendPayload(
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
      error: err instanceof Error ? err.message : 'Request failed',
      response: null,
      // No response ever came back — nothing to attribute a status to.
      http_status: null
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
        response: serializeResponseBody(outcome.response),
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
  // #80 — payload archive search: "where did this REQ id go". Text LIKE over
  // the stored payload/response/error/external_ref, admin-only (the bodies
  // carry other records' data). Static path — registered BEFORE /:c/:i.
  // #528 — how much the push log weighs and what the retention pass will blank.
  app.get('/storage', { preHandler: requireAdmin }, async () => {
    const { erpSubmissionStorage } = await import('../services/erp-retention.js')
    return { data: await erpSubmissionStorage() }
  })
  app.post('/storage/prune', { preHandler: requireAdmin }, async (req) => {
    const { pruneErpSubmissionPayloads } = await import('../services/erp-retention.js')
    const r = await pruneErpSubmissionPayloads()
    await logActivity({
      action: 'erp-payload-prune',
      user: req.user?.id,
      collection: 'nivaro_erp_submissions',
      comment: r.days
        ? `${r.blanked} rows older than ${r.days}d blanked${r.more ? ' (more remain)' : ''}`
        : 'retention off — nothing blanked'
    })
    return { data: r }
  })

  app.get('/search', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as {
      q?: string
      status?: string
      external_api?: string
      collection?: string
      days?: string
      limit?: string
    }
    const term = String(q.q ?? '').trim()
    if (term.length < 2) return reply.code(400).send({ error: 'q must be at least 2 characters' })
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50))
    const days = Math.min(365, Math.max(1, Number(q.days) || 90))
    const like = `%${term.replace(/[%_[]/g, (c) => `[${c}]`)}%`
    let query = db('nivaro_erp_submissions as s')
      .leftJoin('nivaro_external_apis as a', 'a.id', 's.external_api')
      .where('s.created_at', '>=', new Date(Date.now() - days * 86_400_000))
      .andWhere((b) => {
        b.where('s.payload', 'like', like)
          .orWhere('s.response', 'like', like)
          .orWhere('s.last_error', 'like', like)
          .orWhere('s.external_ref', 'like', like)
          .orWhere('s.item', 'like', like)
      })
    if (q.status && ERP_STATUSES.has(q.status as ErpStatus))
      query = query.andWhere('s.status', q.status)
    if (q.external_api) query = query.andWhere('s.external_api', Number(q.external_api))
    if (q.collection && /^[A-Za-z_][A-Za-z0-9_]*$/.test(q.collection))
      query = query.andWhere('s.collection', q.collection)
    const rows = (await query
      .orderBy('s.created_at', 'desc')
      .orderBy('s.id', 'desc')
      .limit(limit)
      .select('s.*', 'a.name as external_api_name')) as Array<
      ErpSubmissionRow & { external_api_name: string | null }
    >
    // Where the term sits — payload / response / error — so the row says why it matched.
    const lower = term.toLowerCase()
    const data = rows.map((r) => {
      const matched: string[] = []
      if ((r.payload ?? '').toLowerCase().includes(lower)) matched.push('payload')
      if ((r.response ?? '').toLowerCase().includes(lower)) matched.push('response')
      if ((r.last_error ?? '').toLowerCase().includes(lower)) matched.push('error')
      if ((r.external_ref ?? '').toLowerCase().includes(lower)) matched.push('external_ref')
      if (
        String(r.item ?? '')
          .toLowerCase()
          .includes(lower)
      )
        matched.push('item')
      return { ...serialize(r), external_api_name: r.external_api_name ?? null, matched }
    })
    return reply.send({ data, limit, days })
  })

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
      // Resolve external API display names — ids alone mean nothing to users,
      // and /external-apis is admin-only so the client can't look them up.
      const apiIds = [...new Set(rows.map((r) => r.external_api).filter((v) => v != null))]
      const names = apiIds.length
        ? new Map(
            (
              (await db('nivaro_external_apis')
                .whereIn('id', apiIds as number[])
                .select('id', 'name')) as Array<{ id: number; name: string }>
            ).map((a) => [a.id, a.name])
          )
        : new Map<number, string>()
      return {
        data: rows.map((r) => ({
          ...serialize(r),
          external_api_name: r.external_api != null ? (names.get(r.external_api) ?? null) : null
        }))
      }
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

      // One function for the row update (#628: writes error_class too) so
      // this route can never drift from the bulk sweep or Task 19's own
      // send paths about which columns a retry touches.
      const { applySendOutcome } = await import('../services/erp-submission-status.js')
      await applySendOutcome({
        submissionId: id,
        outcome,
        priorExternalRef: row.external_ref,
        priorAttempts: row.attempts
      })
      await propagateSubmissionStatus({
        submissionId: id,
        status: outcome.status,
        error: outcome.error,
        obligationId: row.obligation_id
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

  // Bulk retry (#79): re-send a batch of FAILED submissions sequentially —
  // parallel retries against the same ERP invite rate-limit trouble. Per-id
  // outcomes come back so the caller can name what recovered.
  app.post<{ Body: { ids?: number[] } }>(
    '/bulk-retry',
    { preHandler: authenticate },
    async (req, reply) => {
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
        .map(Number)
        .filter((n) => Number.isFinite(n))
        .slice(0, 100)
      if (ids.length === 0) return reply.code(400).send({ error: 'No submission ids' })
      const results: Array<{ id: number; status: string; error?: string }> = []
      for (const id of ids) {
        const row = (await db('nivaro_erp_submissions').where({ id }).first()) as
          | ErpSubmissionRow
          | undefined
        if (!row) {
          results.push({ id, status: 'missing' })
          continue
        }
        if (row.status !== 'failed' && row.status !== 'rejected') {
          results.push({ id, status: 'skipped', error: `already ${row.status}` })
          continue
        }
        if (!(await can(req.user!, 'update', row.collection))) {
          results.push({ id, status: 'forbidden' })
          continue
        }
        const stored = parseJson<StoredPayload>(row.payload)
        if (!stored?.endpoint_path) {
          results.push({ id, status: 'skipped', error: 'no stored payload' })
          continue
        }
        try {
          const outcome = await sendPayload(row.external_api, stored, req.user?.id)
          // Same shared function every other writer uses now (#628: writes
          // error_class too), so a bulk-retried failure is no longer
          // invisible to runRetryPass just for having gone through this route.
          const { applySendOutcome } = await import('../services/erp-submission-status.js')
          await applySendOutcome({
            submissionId: id,
            outcome,
            priorExternalRef: row.external_ref,
            priorAttempts: row.attempts
          })
          // A fourth writer of `status`, alongside /retry, the PATCH override
          // and the automatic sweep — moves the obligation the same way they
          // do, so a bulk-recovered submission cannot leave one behind.
          await propagateSubmissionStatus({
            submissionId: id,
            status: outcome.status,
            error: outcome.error,
            obligationId: row.obligation_id
          })
          results.push({ id, status: outcome.status, error: outcome.error ?? undefined })
        } catch (err) {
          results.push({
            id,
            status: 'error',
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
      const recovered = results.filter(
        (r) => r.status === 'pending' || r.status === 'accepted'
      ).length
      await logActivity({
        action: 'erp-bulk-retry',
        user: req.user?.id,
        comment: `${ids.length} retried, ${recovered} landed`,
        req
      })
      return { data: { results, recovered } }
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

    // Same shared function every real send uses — #628: classified from
    // what THIS row already knows (its own stored last_error/response),
    // never from a live call, since this route never reaches a partner at
    // all, it only records what one told us some other way (a webhook).
    const { applySendOutcome } = await import('../services/erp-submission-status.js')
    await applySendOutcome({
      submissionId: id,
      outcome: {
        status,
        external_ref: external_ref ?? null,
        error: row.last_error,
        response: parseJson(row.response) ?? row.response ?? null
      },
      priorExternalRef: row.external_ref,
      priorAttempts: row.attempts,
      // …and for the same reason it is not an ATTEMPT: nothing was sent, so
      // counting one here would silently spend a rung of the retry ladder
      // every time an admin corrected a status.
      attempted: false
    })
    // applySendOutcome's own `?? priorExternalRef` fallback cannot express
    // "clear it to null" — null there reads as "no new info", which is
    // correct for a real send (a response legitimately not mentioning a ref
    // means "unknown", not "erase it"). This route is the one caller that
    // ever needs an EXPLICIT clear, so it is the one extra write, and only
    // when the caller actually asked for it.
    if (external_ref === null) {
      await db('nivaro_erp_submissions').where({ id }).update({ external_ref: null })
    }
    await propagateSubmissionStatus({
      submissionId: id,
      status,
      error: null,
      obligationId: row.obligation_id
    })

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

/**
 * Auto-retry sweep (#469): failed submissions whose external API declares a
 * retry_policy ({max_attempts, backoff_minutes}) retry on a backoff schedule
 * instead of waiting for a human. next_retry_at is stamped after each failed
 * attempt; a landed retry clears it. Manual /retry keeps working regardless.
 */
export async function runErpAutoRetries(): Promise<{ attempted: number; landed: number }> {
  const apis = (await db('nivaro_external_apis')
    .whereNotNull('retry_policy')
    .select('id', 'retry_policy')) as Array<{ id: number; retry_policy: string | null }>
  const policies = new Map<number, { max_attempts: number; backoff_minutes: number }>()
  for (const a of apis) {
    const p = parseJson<{ max_attempts?: number; backoff_minutes?: number }>(a.retry_policy)
    const max = Number(p?.max_attempts)
    const backoff = Number(p?.backoff_minutes)
    if (Number.isFinite(max) && max > 0 && Number.isFinite(backoff) && backoff > 0) {
      policies.set(a.id, { max_attempts: Math.min(10, max), backoff_minutes: backoff })
    }
  }
  if (policies.size === 0) return { attempted: 0, landed: 0 }

  const now = new Date()
  const rows = (await db('nivaro_erp_submissions')
    .where('status', 'failed')
    .whereIn('external_api', [...policies.keys()])
    .where((qb) => qb.whereNull('next_retry_at').orWhere('next_retry_at', '<=', now))
    // #628 — never re-send what repetition cannot fix. NULL passes: rows
    // written before this migration carry no classification and keep their
    // old (retry) behaviour rather than being silently excluded.
    .where((qb) =>
      qb.whereNull('error_class').orWhereNotIn('error_class', ['validation', 'not_found'])
    )
    .orderBy('id', 'asc')
    .limit(25)) as ErpSubmissionRow[]

  let attempted = 0
  let landed = 0
  for (const row of rows) {
    const policy = policies.get(row.external_api)
    if (!policy) continue
    const retries = Number((row as unknown as { retry_count?: number }).retry_count ?? 0)
    if (retries >= policy.max_attempts) continue
    const stored = parseJson<StoredPayload>(row.payload)
    if (!stored?.endpoint_path) continue
    attempted++
    const outcome = await sendPayload(row.external_api, stored, undefined)
    const ok = outcome.status !== 'failed'
    if (ok) landed++
    // ONE write to the row: the shared columns (#628: incl. error_class) plus
    // this sweep's own backoff bookkeeping (retry_count/next_retry_at, which
    // applySendOutcome knows nothing about) merged into the same .update().
    const { applySendOutcome } = await import('../services/erp-submission-status.js')
    await applySendOutcome({
      submissionId: row.id,
      outcome,
      priorExternalRef: row.external_ref,
      priorAttempts: row.attempts,
      extra: {
        retry_count: retries + 1,
        // Exponential-ish backoff: base * 2^retries, capped at a day.
        next_retry_at: ok
          ? null
          : new Date(now.getTime() + Math.min(1440, policy.backoff_minutes * 2 ** retries) * 60_000)
      }
    })
    await propagateSubmissionStatus({
      submissionId: row.id,
      status: outcome.status,
      error: outcome.error,
      obligationId: row.obligation_id
    })
  }
  return { attempted, landed }
}
