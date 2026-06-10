import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { assertSafeUrl } from '../lib/ssrf.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { dispatchWebhook, fireWebhooks } from '../services/webhook-dispatch.js'

// ─── Types ──────────────────────────────────────────────────────────────────

interface WebhookRow {
  id: number
  name: string
  collections: string | null
  events: string | null
  url: string
  method: string
  headers: string | null
  secret: string | null
  signing_secret: string | null
  enabled: boolean
  created_at: Date
  updated_at: Date
}

interface DeliveryRow {
  id: number
  webhook: number
  event: string
  status_code: number | null
  request_body: string | null
  response_body: string | null
  latency_ms: number | null
  success: boolean
  attempt: number
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

const MASK = '••••••'

function maskWebhook(w: WebhookRow) {
  return {
    id: w.id,
    name: w.name,
    collections: parseJson<string[]>(w.collections) ?? [],
    events: parseJson<string[]>(w.events) ?? [],
    url: w.url,
    method: w.method,
    headers: parseJson<Record<string, string>>(w.headers),
    secret: w.secret ? MASK : null,
    signing_secret: w.signing_secret ? MASK : null,
    enabled: !!w.enabled,
    created_at: w.created_at,
    updated_at: w.updated_at
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function webhooksRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // List all
  app.get('/', async () => {
    const rows = (await db('nivaro_webhooks').orderBy('name', 'asc')) as WebhookRow[]
    return { data: rows.map(maskWebhook) }
  })

  // Single
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = (await db('nivaro_webhooks')
      .where({ id: Number(req.params.id) })
      .first()) as WebhookRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return { data: maskWebhook(row) }
  })

  // Create
  app.post<{
    Body: {
      name: string
      collections?: string[] | null
      events?: string[] | null
      url: string
      method?: string
      headers?: Record<string, string> | null
      secret?: string | null
      signing_secret?: string | null
      enabled?: boolean
    }
  }>('/', async (req, reply) => {
    const body = req.body
    if (!body?.name || !body?.url) {
      return reply.code(400).send({ error: 'name and url are required' })
    }
    const now = new Date()
    const [inserted] = await db('nivaro_webhooks')
      .insert({
        name: body.name,
        collections: toJsonStr(body.collections ?? []),
        events: toJsonStr(body.events ?? null),
        url: body.url,
        method: (body.method ?? 'POST').toUpperCase(),
        headers: toJsonStr(body.headers ?? null),
        secret: body.secret ?? null,
        signing_secret: body.signing_secret ?? null,
        enabled: body.enabled ?? true,
        created_at: now,
        updated_at: now
      })
      .returning('*')

    const row =
      inserted && typeof inserted === 'object'
        ? (inserted as WebhookRow)
        : ((await db('nivaro_webhooks')
            .where({ id: inserted as number })
            .first()) as WebhookRow)

    await logActivity({
      action: 'create',
      collection: 'nivaro_webhooks',
      item: String(row.id),
      user: req.user?.id,
      req
    })
    return reply.code(201).send({ data: maskWebhook(row) })
  })

  // Update
  app.patch<{
    Params: { id: string }
    Body: Partial<{
      name: string
      collections: string[] | null
      events: string[] | null
      url: string
      method: string
      headers: Record<string, string> | null
      secret: string | null
      signing_secret: string | null
      enabled: boolean
    }>
  }>('/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_webhooks').where({ id }).first()) as WebhookRow | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body ?? {}
    const patch: Record<string, unknown> = { updated_at: new Date() }

    if (body.name !== undefined) patch.name = body.name
    if (body.collections !== undefined) patch.collections = toJsonStr(body.collections ?? [])
    if (body.events !== undefined) patch.events = toJsonStr(body.events)
    if (body.url !== undefined) patch.url = body.url
    if (body.method !== undefined) patch.method = body.method.toUpperCase()
    if (body.headers !== undefined) patch.headers = toJsonStr(body.headers)
    if (body.enabled !== undefined) patch.enabled = body.enabled

    // Preserve existing secrets if the masked value is re-submitted.
    if (body.secret !== undefined && body.secret !== MASK) {
      patch.secret = body.secret
    }
    if (body.signing_secret !== undefined && body.signing_secret !== MASK) {
      patch.signing_secret = body.signing_secret
    }

    await db('nivaro_webhooks').where({ id }).update(patch)
    const row = (await db('nivaro_webhooks').where({ id }).first()) as WebhookRow
    await logActivity({
      action: 'update',
      collection: 'nivaro_webhooks',
      item: String(id),
      user: req.user?.id,
      req
    })
    return { data: maskWebhook(row) }
  })

  // Delete
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const deleted = await db('nivaro_webhooks')
      .where({ id: Number(req.params.id) })
      .delete()
    if (!deleted) return reply.code(404).send({ error: 'Not found' })
    await logActivity({
      action: 'delete',
      collection: 'nivaro_webhooks',
      item: req.params.id,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })

  // Test fire
  app.post<{ Params: { id: string } }>('/:id/test', async (req, reply) => {
    const row = (await db('nivaro_webhooks')
      .where({ id: Number(req.params.id) })
      .first()) as WebhookRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })

    const collections = parseJson<string[]>(row.collections) ?? []
    const payload = {
      event: 'test',
      collection: collections[0] ?? 'test',
      item: null,
      data: {}
    }

    const method = (row.method ?? 'POST').toUpperCase()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(parseJson<Record<string, string>>(row.headers) ?? {})
    }

    try {
      await assertSafeUrl(row.url)

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)

      const init: RequestInit = { method, headers, signal: controller.signal, redirect: 'manual' }
      if (method !== 'GET' && method !== 'HEAD') {
        init.body = JSON.stringify(payload)
      }

      let res: Response
      try {
        res = await fetch(row.url, init)
      } finally {
        clearTimeout(timer)
      }

      // Reject redirects — a 3xx to a private host bypasses the initial check.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location') ?? ''
        try {
          await assertSafeUrl(loc)
        } catch {
          return reply.code(400).send({ error: 'Redirect to unsafe URL blocked' })
        }
      }

      const text = await res.text()
      let body: unknown = text
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('application/json')) {
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
      }

      await logActivity({
        action: 'run',
        collection: 'nivaro_webhooks',
        item: req.params.id,
        user: req.user?.id,
        req,
        comment: 'test'
      })
      return { data: { status: res.status, ok: res.ok, body } }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.name === 'AbortError'
            ? 'Request timed out after 10s'
            : err.message
          : 'Request failed'
      return reply.code(200).send({
        data: { status: 0, ok: false, body: null },
        error: message
      })
    }
  })

  // ── Delivery log (paginated) ───────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>(
    '/:id/deliveries',
    async (req, reply) => {
      const id = Number(req.params.id)
      const webhook = (await db('nivaro_webhooks').where({ id }).first()) as WebhookRow | undefined
      if (!webhook) return reply.code(404).send({ error: 'Not found' })

      const limit = Math.min(Math.max(Number(req.query.limit ?? 25) || 25, 1), 100)
      const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0)

      const [rows, countRow] = await Promise.all([
        db('nivaro_webhook_deliveries')
          .where({ webhook: id })
          .orderBy('id', 'desc')
          .limit(limit)
          .offset(offset) as Promise<DeliveryRow[]>,
        db('nivaro_webhook_deliveries').where({ webhook: id }).count({ total: '*' }).first()
      ])

      return {
        data: rows.map((d) => ({ ...d, success: !!d.success })),
        total: Number((countRow as { total?: number | string } | undefined)?.total ?? 0),
        limit,
        offset
      }
    }
  )

  // ── Retry a delivery ───────────────────────────────────────────────────────
  app.post<{ Params: { deliveryId: string } }>(
    '/deliveries/:deliveryId/retry',
    async (req, reply) => {
      const delivery = (await db('nivaro_webhook_deliveries')
        .where({ id: Number(req.params.deliveryId) })
        .first()) as DeliveryRow | undefined
      if (!delivery) return reply.code(404).send({ error: 'Delivery not found' })

      const webhook = (await db('nivaro_webhooks').where({ id: delivery.webhook }).first()) as
        | WebhookRow
        | undefined
      if (!webhook) return reply.code(404).send({ error: 'Webhook no longer exists' })
      if (!delivery.request_body) {
        return reply.code(400).send({ error: 'Delivery has no stored request body to retry' })
      }

      const result = await dispatchWebhook(
        webhook,
        delivery.event,
        delivery.request_body, // raw string — dispatched as-is, re-signed
        delivery.attempt + 1
      )

      await logActivity({
        action: 'run',
        collection: 'nivaro_webhooks',
        item: String(webhook.id),
        user: req.user?.id,
        req,
        comment: `retry delivery ${delivery.id}`
      })

      return { data: result }
    }
  )

  // ── Replay an activity event — re-fires webhooks + extension flow triggers ─
  app.post<{ Params: { activityId: string } }>('/replay/:activityId', async (req, reply) => {
    const activity = (await db('nivaro_activity')
      .where({ id: Number(req.params.activityId) })
      .first()) as
      | { id: number; action: string; collection: string | null; item: string | null }
      | undefined
    if (!activity) return reply.code(404).send({ error: 'Activity not found' })
    if (!activity.collection) {
      return reply.code(400).send({ error: 'Activity has no collection to replay' })
    }

    const revision = (await db('nivaro_revisions')
      .where({ activity: activity.id })
      .orderBy('id', 'desc')
      .first()) as { data: string | null } | undefined

    const snapshot = parseJson<Record<string, unknown>>(revision?.data) ?? {
      id: activity.item
    }

    // Re-fire matching webhooks through the central dispatcher (logged + signed).
    await fireWebhooks(activity.collection, activity.action, snapshot)

    // Re-fire extension-registered flow triggers matching this action type.
    try {
      const { emitTrigger } = await import('../flows/registry.js')
      emitTrigger(
        activity.action,
        {
          collection: activity.collection,
          item: activity.item,
          data: snapshot,
          replayed_from_activity: activity.id
        },
        req.log,
        req.user?.id
      )
    } catch (err) {
      req.log.warn({ err }, 'Replay: flow trigger emit failed')
    }

    await logActivity({
      action: 'run',
      collection: 'nivaro_webhooks',
      item: String(activity.id),
      user: req.user?.id,
      req,
      comment: `replay activity ${activity.id}`
    })

    return {
      data: {
        replayed: true,
        activity: activity.id,
        collection: activity.collection,
        event: activity.action
      }
    }
  })
}
