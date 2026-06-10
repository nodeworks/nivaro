import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { assertSafeUrl } from '../lib/ssrf.js'
import { authenticate, checkApiKeyScope } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { createOne, readItems, updateOne } from '../services/items.js'
import { can } from '../services/permissions.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

const TRIGGER_EVENTS = ['create', 'update', 'delete'] as const
type TriggerEvent = (typeof TRIGGER_EVENTS)[number]

const ZAPIER_SOURCE_HEADER = 'x-nivaro-source'
const ZAPIER_SOURCE_VALUE = 'zapier'

/** Column names treated as an "updated at" timestamp for update-polling triggers. */
const UPDATED_AT_CANDIDATES = ['updated_at', 'date_updated', 'modified_at', 'last_modified']

function isSystemCollection(collection: string): boolean {
  const lower = collection.toLowerCase()
  return lower.startsWith('nivaro_') || lower.startsWith('cms_')
}

function isValidCollectionName(collection: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(collection)
}

function parseJson<T = unknown>(val: string | null | undefined): T | null {
  if (val == null) return null
  if (typeof val !== 'string') return val as T
  try {
    return JSON.parse(val) as T
  } catch {
    return null
  }
}

async function isRegisteredCollection(collection: string): Promise<boolean> {
  if (!isValidCollectionName(collection) || isSystemCollection(collection)) return false
  const row = await db('nivaro_collections').where({ collection }).first()
  return !!row
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function zapierRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // ── GET /zapier/me — connection test for Zapier auth ──────────────────────
  app.get('/me', async (req) => {
    const user = req.user!
    const name =
      [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email || user.id
    return { data: { id: user.id, email: user.email, name } }
  })

  // ── GET /zapier/collections — readable collections (dynamic dropdowns) ────
  app.get('/collections', async (req) => {
    const rows = (await db('nivaro_collections')
      .whereNot('collection', 'like', 'nivaro\\_%')
      .orderBy('collection', 'asc')) as { collection: string; display_name: string | null }[]

    const visible: { collection: string; display_name: string | null }[] = []
    for (const row of rows) {
      if (isSystemCollection(row.collection)) continue
      if (!checkApiKeyScope(req, 'read', row.collection)) continue
      if (await can(req.user!, 'read', row.collection)) visible.push(row)
    }

    return {
      data: visible.map((r) => ({
        id: r.collection,
        name: r.display_name ?? r.collection
      }))
    }
  })

  // ── GET /zapier/triggers/:event/:collection — polling trigger ─────────────
  app.get<{ Params: { event: string; collection: string } }>(
    '/triggers/:event/:collection',
    async (req, reply) => {
      const { event, collection } = req.params

      if (!TRIGGER_EVENTS.includes(event as TriggerEvent)) {
        return reply
          .code(400)
          .send({ error: `Invalid event — must be one of: ${TRIGGER_EVENTS.join(', ')}` })
      }
      if (!(await isRegisteredCollection(collection))) {
        return reply.code(404).send({ error: 'Collection not found' })
      }
      if (
        !checkApiKeyScope(req, 'read', collection) ||
        !(await can(req.user!, 'read', collection))
      ) {
        return reply.code(403).send({ error: 'You do not have read access to this collection' })
      }

      try {
        let orderColumn = 'id'
        if (event === 'update') {
          const info = await db(collection).columnInfo()
          const updatedCol = UPDATED_AT_CANDIDATES.find((c) => c in info)
          if (updatedCol) orderColumn = updatedCol
        }

        // Route through the items service so permission field sets, row-level
        // security filters, and workspace scoping all apply.
        const sort = orderColumn === 'id' ? ['-id'] : [`-${orderColumn}`, '-id']
        const result = await readItems(
          req.user!,
          collection,
          { limit: 25, sort },
          req,
          req.workspaceId ?? undefined
        )
        return { data: result.data }
      } catch (err) {
        req.log.warn({ err, collection }, 'Zapier trigger poll failed')
        return reply
          .code(400)
          .send({ error: 'Collection table could not be queried — does it exist?' })
      }
    }
  )

  // ── POST /zapier/hooks — REST hook subscribe ──────────────────────────────
  app.post<{ Body: { target_url?: string; event?: string; collection?: string } }>(
    '/hooks',
    async (req, reply) => {
      const { target_url, event, collection } = req.body ?? {}

      if (!target_url || !event || !collection) {
        return reply.code(400).send({ error: 'target_url, event and collection are required' })
      }
      if (!TRIGGER_EVENTS.includes(event as TriggerEvent)) {
        return reply
          .code(400)
          .send({ error: `Invalid event — must be one of: ${TRIGGER_EVENTS.join(', ')}` })
      }
      if (!(await isRegisteredCollection(collection))) {
        return reply.code(404).send({ error: 'Collection not found' })
      }
      if (
        !checkApiKeyScope(req, 'read', collection) ||
        !(await can(req.user!, 'read', collection))
      ) {
        return reply.code(403).send({ error: 'You do not have read access to this collection' })
      }

      try {
        await assertSafeUrl(target_url)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid URL'
        return reply.code(400).send({ error: msg })
      }

      const now = new Date()
      const [inserted] = await db('nivaro_webhooks')
        .insert({
          name: `Zapier: ${collection} ${event}`,
          collections: JSON.stringify([collection]),
          events: JSON.stringify([event]),
          url: target_url,
          method: 'POST',
          headers: JSON.stringify({ [ZAPIER_SOURCE_HEADER]: ZAPIER_SOURCE_VALUE }),
          secret: null,
          signing_secret: null,
          enabled: 1,
          created_at: now,
          updated_at: now
        })
        .returning('id')

      const id =
        inserted && typeof inserted === 'object'
          ? (inserted as { id: number }).id
          : (inserted as number)

      await logActivity({
        action: 'create',
        collection: 'nivaro_webhooks',
        item: String(id),
        user: req.user?.id,
        req,
        comment: 'zapier subscribe'
      })

      return reply.code(201).send({ id })
    }
  )

  // ── DELETE /zapier/hooks/:id — REST hook unsubscribe ──────────────────────
  app.delete<{ Params: { id: string } }>('/hooks/:id', async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Invalid hook id' })

    const row = (await db('nivaro_webhooks').where({ id }).first()) as
      | { id: number; headers: string | null }
      | undefined
    if (!row) return reply.code(404).send({ error: 'Hook not found' })

    // Only hooks created via the Zapier subscribe endpoint may be deleted here
    const headers = parseJson<Record<string, string>>(row.headers)
    if (headers?.[ZAPIER_SOURCE_HEADER] !== ZAPIER_SOURCE_VALUE) {
      return reply.code(404).send({ error: 'Hook not found' })
    }

    await db('nivaro_webhooks').where({ id }).delete()
    await logActivity({
      action: 'delete',
      collection: 'nivaro_webhooks',
      item: String(id),
      user: req.user?.id,
      req,
      comment: 'zapier unsubscribe'
    })

    return reply.code(204).send()
  })

  // ── POST /zapier/actions/create-item ───────────────────────────────────────
  app.post<{ Body: { collection?: string; data?: Record<string, unknown> } }>(
    '/actions/create-item',
    async (req, reply) => {
      const { collection, data } = req.body ?? {}
      if (!collection || !data || typeof data !== 'object' || Array.isArray(data)) {
        return reply.code(400).send({ error: 'collection and data (object) are required' })
      }
      if (!(await isRegisteredCollection(collection))) {
        return reply.code(404).send({ error: 'Collection not found' })
      }
      if (
        !checkApiKeyScope(req, 'create', collection) ||
        !(await can(req.user!, 'create', collection))
      ) {
        return reply.code(403).send({ error: 'You do not have create access to this collection' })
      }

      try {
        // createOne enforces allowed fields, hooks, activity logging, quotas,
        // encryption, and workspace stamping.
        const row = await createOne(req.user!, collection, data, req, req.workspaceId ?? undefined)
        return reply.code(201).send({ data: row })
      } catch (err) {
        req.log.warn({ err, collection }, 'Zapier create-item failed')
        const msg = err instanceof Error ? err.message : 'Insert failed'
        return reply.code(400).send({ error: msg })
      }
    }
  )

  // ── POST /zapier/actions/update-item ───────────────────────────────────────
  app.post<{
    Body: { collection?: string; id?: string | number; data?: Record<string, unknown> }
  }>('/actions/update-item', async (req, reply) => {
    const { collection, id, data } = req.body ?? {}
    if (!collection || id == null || !data || typeof data !== 'object' || Array.isArray(data)) {
      return reply.code(400).send({ error: 'collection, id and data (object) are required' })
    }
    if (!(await isRegisteredCollection(collection))) {
      return reply.code(404).send({ error: 'Collection not found' })
    }
    if (
      !checkApiKeyScope(req, 'update', collection) ||
      !(await can(req.user!, 'update', collection))
    ) {
      return reply.code(403).send({ error: 'You do not have update access to this collection' })
    }

    try {
      // updateOne enforces allowed fields, row-level security, hooks,
      // revisions, and workspace scoping (filtered rows → not-found).
      const row = await updateOne(
        req.user!,
        collection,
        id,
        data,
        req,
        req.workspaceId ?? undefined
      )
      return { data: row }
    } catch (err) {
      req.log.warn({ err, collection }, 'Zapier update-item failed')
      const msg = err instanceof Error ? err.message : 'Update failed'
      return reply.code(400).send({ error: msg })
    }
  })

  // ── GET /zapier/manifest — integration descriptor for app builders ────────
  app.get('/manifest', async () => {
    const base = `${config.PUBLIC_URL.replace(/\/$/, '')}/api/zapier`
    return {
      name: 'Nivaro',
      auth: {
        type: 'bearer',
        test_url: `${base}/me`,
        help: 'Create an API key under Settings → API Keys'
      },
      triggers: TRIGGER_EVENTS.map((event) => ({
        key: `item_${event}`,
        label: `Item ${event[0].toUpperCase()}${event.slice(1)}d`,
        description: `Fires when an item is ${event}d in a collection`,
        polling_url: `${base}/triggers/${event}/{collection}`,
        hook_subscribe_url: `${base}/hooks`,
        hook_unsubscribe_url: `${base}/hooks/{id}`,
        dynamic_dropdown_url: `${base}/collections`
      })),
      actions: [
        {
          key: 'create_item',
          label: 'Create Item',
          description: 'Creates an item in a collection',
          url: `${base}/actions/create-item`
        },
        {
          key: 'update_item',
          label: 'Update Item',
          description: 'Updates an item in a collection',
          url: `${base}/actions/update-item`
        }
      ]
    }
  })
}
