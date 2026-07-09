import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { enqueueQueueMaterializationBackfill } from '../functions/queue-materialization-jobs.js'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { parseJson, toJsonStr } from '../services/pipeline-engine.js'
import type { QueueRow, QueueScope, QueueSourceRow, QueueSourceType } from '../services/queues.js'
import {
  computeAvailableExtraFields,
  computeExtraFieldMeta,
  fetchQueueItems,
  fetchQueueWorkload,
  isDisplayOnlySourceChange,
  normalizeDisplayConfig,
  parsePaginationParams,
  validateAggregates,
  validateColumnFormats
} from '../services/queues.js'
import { broadcastCollectionUpdate } from '../services/realtime.js'

// Format-only validation for extra_fields entries used as SQL column identifiers in
// resolveCollectionSource's .select(['id', ...extraFieldNames]) — mirrors
// api/src/routes/widget.ts's FIELD_NAME_RE/validateFields exactly. Declared locally
// rather than imported from widget.ts to avoid a circular import (widget.ts already
// imports canReadQueue from this file).
const FIELD_NAME_RE = /^[a-zA-Z0-9_]+$/

function formatQueue(row: QueueRow) {
  return {
    ...row,
    is_shared: !!row.is_shared,
    is_active: !!row.is_active,
    materialized: !!row.materialized,
    claims_enabled: !!row.claims_enabled,
    column_aliases: parseJson(row.column_aliases) ?? {},
    display_config: normalizeDisplayConfig(parseJson(row.display_config))
  }
}

function formatSource(row: QueueSourceRow) {
  return {
    ...row,
    filters: parseJson(row.filters),
    state_values: parseJson(row.state_values),
    extra_fields: parseJson(row.extra_fields),
    drilldown: parseJson(row.drilldown) ?? {},
    column_formats: parseJson(row.column_formats) ?? {},
    aggregates: parseJson(row.aggregates) ?? {}
  }
}

/**
 * Read visibility for a single queue: admin, owner, or a shared queue whose
 * role_id is either unset (shared with everyone) or matches the viewer's
 * role. Mirrors the GET / list query's WHERE clause exactly — GET /:id and
 * GET /:id/items must never be reachable for a queue the list endpoint
 * would have excluded (role-scoped shared queues are not "public to any
 * authenticated user" just because is_shared=true).
 */
export function canReadQueue(queue: QueueRow, req: FastifyRequest): boolean {
  if (req.isAdmin) return true
  if (queue.owner === req.user!.id) return true
  if (!queue.is_shared) return false
  const userRole = req.user!.role ?? null
  return queue.role_id === null || queue.role_id === userRole
}

const SOURCE_TYPES: QueueSourceType[] = ['collection', 'tasks', 'approvals', 'owned_by_me']
const MAX_SOURCES_PER_QUEUE = 10

export async function queuesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  // GET / — own queues + shared queues (optionally role-matched)
  app.get('/', async (req, reply) => {
    const userId = req.user!.id
    const userRole = req.user!.role ?? null

    const rows = (await db<QueueRow>('nivaro_queues')
      .where({ is_active: true })
      .andWhere((qb) => {
        qb.where({ owner: userId }).orWhere((shared) => {
          shared.where('is_shared', true).andWhere((roleQb) => {
            roleQb.whereNull('role_id')
            if (userRole) roleQb.orWhere('role_id', userRole)
          })
        })
      })
      .orderBy('created_at', 'asc')) as QueueRow[]

    return reply.send({ data: rows.map(formatQueue) })
  })

  // GET /:id — single queue + its sources
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const sources = (await db<QueueSourceRow>('nivaro_queue_sources')
      .where({ queue_id: id })
      .orderBy('sort')) as QueueSourceRow[]

    return reply.send({
      data: {
        ...formatQueue(queue),
        sources: sources.map(formatSource),
        available_extra_fields: computeAvailableExtraFields(sources),
        extra_field_meta: await computeExtraFieldMeta(sources)
      }
    })
  })

  // POST / — create a queue owned by the current user, seeded with an owned_by_me source
  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as {
      name?: string
      description?: string
      icon?: string
      color?: string
      is_shared?: boolean
      role_id?: string | null
    }

    if (!body.name?.trim()) return reply.code(400).send({ error: 'name is required' })

    const [queue] = (await db('nivaro_queues')
      .insert({
        name: body.name.trim(),
        description: body.description ?? null,
        icon: body.icon ?? null,
        color: body.color ?? null,
        owner: req.user!.id,
        is_shared: !!body.is_shared,
        role_id: body.role_id ?? null,
        is_active: true,
        created_at: new Date()
      })
      .returning('*')) as unknown as [QueueRow]

    await db('nivaro_queue_sources').insert({
      queue_id: queue.id,
      type: 'owned_by_me',
      collection: null,
      filters: toJsonStr(null),
      state_values: toJsonStr(null),
      sort: 0
    })

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_queues',
      item: String(queue.id),
      comment: queue.name,
      req
    })

    return reply.code(201).send({ data: formatQueue(queue) })
  })

  // PATCH /:id — update queue metadata (owner or admin)
  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && queue.owner !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const body = (req.body ?? {}) as {
      name?: string
      description?: string | null
      icon?: string | null
      color?: string | null
      is_shared?: boolean
      role_id?: string | null
      is_active?: boolean
      claims_enabled?: boolean
      column_aliases?: Record<string, string> | null
      display_config?: unknown
    }

    const update: Record<string, unknown> = { updated_at: new Date() }
    if (body.name !== undefined) {
      if (!body.name.trim()) return reply.code(400).send({ error: 'name cannot be empty' })
      update.name = body.name.trim()
    }
    if (body.description !== undefined) update.description = body.description
    if (body.icon !== undefined) update.icon = body.icon
    if (body.color !== undefined) update.color = body.color
    if (body.is_shared !== undefined) update.is_shared = !!body.is_shared
    if (body.role_id !== undefined) update.role_id = body.role_id
    if (body.is_active !== undefined) update.is_active = !!body.is_active
    if (body.claims_enabled !== undefined) update.claims_enabled = !!body.claims_enabled
    if (body.column_aliases !== undefined) {
      // Keep only non-empty string labels; empty map stores as null.
      const cleaned: Record<string, string> = {}
      for (const [k, v] of Object.entries(body.column_aliases ?? {})) {
        if (typeof v === 'string' && v.trim()) cleaned[k] = v.trim().slice(0, 100)
      }
      update.column_aliases = Object.keys(cleaned).length > 0 ? toJsonStr(cleaned) : null
    }
    if (body.display_config !== undefined) {
      // Normalize before write so the stored JSON is always valid/complete.
      update.display_config =
        body.display_config === null ? null : toJsonStr(normalizeDisplayConfig(body.display_config))
    }

    await db('nivaro_queues').where({ id }).update(update)
    const updated = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as QueueRow

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_queues',
      item: String(id),
      req
    })

    return reply.send({ data: formatQueue(updated) })
  })

  // DELETE /:id — delete queue (owner or admin); sources cascade via FK
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && queue.owner !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await db('nivaro_queues').where({ id }).delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_queues',
      item: String(id),
      req
    })
    return reply.code(204).send()
  })

  // PATCH /:id/sources — bulk-replace all sources for this queue
  app.patch('/:id/sources', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && queue.owner !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const body = req.body as {
      sources?: Array<{
        type?: string
        collection?: string | null
        filters?: unknown
        state_values?: unknown
        state_mode?: string | null
        label_template?: string | null
        sla_filter?: string | null
        extra_fields?: unknown
        drilldown?: unknown
        column_formats?: unknown
        aggregates?: unknown
        sort?: number
      }>
    }
    if (!Array.isArray(body.sources) || body.sources.length === 0) {
      return reply.code(400).send({ error: 'sources[] is required and cannot be empty' })
    }
    if (body.sources.length > MAX_SOURCES_PER_QUEUE) {
      return reply
        .code(400)
        .send({ error: `A queue can have at most ${MAX_SOURCES_PER_QUEUE} sources` })
    }
    for (const s of body.sources) {
      if (!s.type || !SOURCE_TYPES.includes(s.type as QueueSourceType)) {
        return reply.code(400).send({ error: `invalid source type: ${s.type}` })
      }
      if (s.type === 'collection' && !s.collection) {
        return reply.code(400).send({ error: 'collection is required for type=collection sources' })
      }
      if (s.sla_filter && s.sla_filter !== 'warning' && s.sla_filter !== 'breached') {
        return reply.code(400).send({ error: `invalid sla_filter: ${s.sla_filter}` })
      }
      if (s.state_mode && s.state_mode !== 'include' && s.state_mode !== 'exclude') {
        return reply.code(400).send({ error: `invalid state_mode: ${s.state_mode}` })
      }
      if (s.extra_fields !== undefined) {
        // No count cap: extra-field values are cached by materialization and
        // resolved in batched queries on the live path, so column count scales —
        // the path shape/segment validation below is the real guard.
        if (!Array.isArray(s.extra_fields)) {
          return reply.code(400).send({ error: 'extra_fields must be an array of field names' })
        }
        for (const f of s.extra_fields) {
          if (typeof f !== 'string') {
            return reply.code(400).send({
              error:
                'extra_fields must contain only valid field names (letters, numbers, underscore)'
            })
          }
          const segments = f.split('.')
          if (segments.length === 0 || segments.length > 3) {
            return reply.code(400).send({ error: `extra_fields path must have 1-3 segments: ${f}` })
          }
          if (segments.some((seg) => !FIELD_NAME_RE.test(seg))) {
            return reply.code(400).send({
              error: `extra_fields must contain only valid field names (letters, numbers, underscore): ${f}`
            })
          }
        }
      }
      const cfError = validateColumnFormats(s.column_formats)
      if (cfError) {
        return reply.code(400).send({ error: cfError })
      }
      const aggError = validateAggregates(s.aggregates)
      if (aggError) {
        return reply.code(400).send({ error: aggError })
      }
    }

    // Display-only edits (drilldown, column_formats — both applied client-side
    // at render, never stored in cached rows) update source rows in place and
    // keep the materialized cache. The teardown path below costs a demote +
    // full rebuild: minutes of live-resolve reads on a large queue, for
    // changes that never touched cached data.
    const existingSources = (await db<QueueSourceRow>('nivaro_queue_sources')
      .where({ queue_id: id })
      .orderBy('sort')) as QueueSourceRow[]
    const displayJson = (v: unknown): string | null =>
      v && typeof v === 'object' && Object.keys(v).length > 0 ? toJsonStr(v) : null

    if (isDisplayOnlySourceChange(existingSources, body.sources)) {
      const ordered = body.sources
        .map((raw, i) => ({ raw, sort: raw.sort ?? i }))
        .sort((a, b) => a.sort - b.sort)
      await db.transaction(async (trx) => {
        for (let i = 0; i < existingSources.length; i++) {
          await trx('nivaro_queue_sources')
            .where({ id: existingSources[i].id })
            .update({
              drilldown: displayJson(ordered[i].raw.drilldown),
              column_formats: displayJson(ordered[i].raw.column_formats)
            })
        }
      })
    } else {
      await db.transaction(async (trx) => {
        // nivaro_queue_items.source_id is a NO ACTION FK to nivaro_queue_sources.id
        // (deliberately, to avoid a different MSSQL multi-cascade-path error) — cached
        // rows must be cleared before their source rows or the DELETE throws an FK
        // violation. This also cascades nivaro_queue_item_owners via its own CASCADE FK
        // to nivaro_queue_items.
        await trx('nivaro_queue_items').where({ queue_id: id }).delete()
        await trx('nivaro_queue_sources').where({ queue_id: id }).delete()
        await trx('nivaro_queue_sources').insert(
          body.sources!.map((s, i) => ({
            queue_id: id,
            type: s.type,
            collection: s.collection ?? null,
            filters: toJsonStr(s.filters),
            state_values: toJsonStr(s.state_values),
            state_mode: s.state_mode === 'exclude' ? 'exclude' : 'include',
            label_template: s.label_template?.trim().slice(0, 500) || null,
            sla_filter: s.sla_filter ?? null,
            extra_fields: toJsonStr(s.extra_fields ?? []),
            drilldown: displayJson(s.drilldown),
            column_formats: displayJson(s.column_formats),
            aggregates: displayJson(s.aggregates),
            sort: s.sort ?? i
          }))
        )
        // Demote materialized to false so reads live-resolve (zero cache rows) until the
        // backfill enqueued below completes and flips it back to true — avoids ever
        // serving an empty/stale materialized cache mid-rebuild.
        if (queue.materialized) {
          await trx('nivaro_queues').where({ id }).update({ materialized: false })
        }
      })

      if (queue.materialized) {
        await enqueueQueueMaterializationBackfill(id)
      }
    }

    const sources = (await db<QueueSourceRow>('nivaro_queue_sources')
      .where({ queue_id: id })
      .orderBy('sort')) as QueueSourceRow[]

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_queues',
      item: String(id),
      comment: 'sources',
      req
    })

    return reply.send({ data: sources.map(formatSource) })
  })

  // GET /collection-states/:collection — workflow states for a collection's binding
  // (builder state include/exclude picker; authenticated, non-admin — personal queues).
  app.get('/collection-states/:collection', async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const binding = (await db('nivaro_workflow_bindings').where({ collection }).first()) as
      | { template: string }
      | undefined
    if (!binding) return reply.send({ data: [] })
    const states = await db('nivaro_workflow_states')
      .where({ template: binding.template })
      .orderBy('sort')
      .select('key', 'label', 'color')
    return reply.send({ data: states })
  })

  // GET /:id/label-suggest?q= — Item-column autocomplete. Materialized queues
  // suggest via SQL DISTINCT/LIKE on the cached label column; small live queues
  // resolve and filter in memory (their reads do that anyway).
  app.get('/:id/label-suggest', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { q } = req.query as { q?: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) return reply.code(403).send({ error: 'Forbidden' })

    const needle = (q ?? '').trim().toLowerCase()
    if (queue.materialized) {
      const query = db('nivaro_queue_items')
        .where({ queue_id: id })
        .whereNotNull('label')
        .distinct('label')
        .orderBy('label')
        .limit(20)
      if (needle) query.whereRaw('LOWER(label) LIKE ?', [`%${needle}%`])
      const rows = (await query) as Array<{ label: string }>
      return reply.send({ data: rows.map((r) => r.label) })
    }

    const { items } = await fetchQueueItems(id, req.user!, 'all')
    const seen = new Set<string>()
    const out: string[] = []
    for (const item of items) {
      if (!item.label) continue
      if (needle && !item.label.toLowerCase().includes(needle)) continue
      if (seen.has(item.label)) continue
      seen.add(item.label)
      out.push(item.label)
      if (out.length >= 20) break
    }
    return reply.send({ data: out.sort() })
  })

  // GET /:id/trends?days=14 — daily stat snapshots for sparklines/deltas (1–90 days)
  app.get('/:id/trends', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) return reply.code(403).send({ error: 'Forbidden' })

    const daysRaw = Number((req.query as { days?: string }).days)
    const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.floor(daysRaw), 1), 90) : 14
    const since = new Date(Date.now() - days * 86_400_000)

    const scope = (req.query as { scope?: string }).scope === 'mine' ? 'mine' : 'all'

    if (scope === 'mine') {
      // Per-owner series for the REQUESTING user (nivaro_queue_owner_snapshots
      // accumulates from deploy — no retroactive backlog history exists).
      const mineRows = (await db('nivaro_queue_owner_snapshots')
        .where({ queue_id: id, user: req.user!.id })
        .where('snapshot_date', '>=', since)
        .orderBy('snapshot_date', 'asc')
        .select('snapshot_date', 'owned', 'sla_warning', 'sla_breached', 'at_risk')) as Array<
        Record<string, unknown>
      >
      return reply.send({
        data: mineRows.map((r) => ({
          snapshot_date: r.snapshot_date,
          total: r.owned,
          unowned: 0,
          sla_warning: r.sla_warning,
          sla_breached: r.sla_breached,
          at_risk: r.at_risk,
          by_state: {}
        }))
      })
    }

    const rows = (await db('nivaro_queue_stat_snapshots')
      .where({ queue_id: id })
      .where('snapshot_date', '>=', since)
      .orderBy('snapshot_date', 'asc')
      .select(
        'snapshot_date',
        'total',
        'unowned',
        'sla_warning',
        'sla_breached',
        'at_risk',
        'by_state'
      )) as Array<Record<string, unknown>>

    return reply.send({
      data: rows.map((r) => ({ ...r, by_state: parseJson(r.by_state as string) ?? {} }))
    })
  })

  // ── Saved queue views ──
  // Visibility mirrors nivaro_saved_views: own views + shared views (role null or
  // matching), all behind canReadQueue for the parent queue.

  // GET /:id/views
  app.get('/:id/views', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) return reply.code(403).send({ error: 'Forbidden' })

    const userId = req.user!.id
    const userRole = req.user!.role ?? null
    const rows = (await db('nivaro_queue_views')
      .where({ queue_id: id })
      .where((qb) => {
        qb.where({ user: userId }).orWhere((shared) => {
          shared.where('is_shared', true).andWhere((roleQb) => {
            roleQb.whereNull('role')
            if (userRole) roleQb.orWhere('role', userRole)
          })
        })
      })
      .orderBy('created_at', 'asc')) as Array<Record<string, unknown>>

    return reply.send({
      data: rows.map((r) => ({
        ...r,
        is_shared: !!r.is_shared,
        state: parseJson(r.state as string)
      }))
    })
  })

  // POST /:id/views
  app.post('/:id/views', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) return reply.code(403).send({ error: 'Forbidden' })

    const body = (req.body ?? {}) as {
      name?: string
      state?: unknown
      is_shared?: boolean
      role?: string | null
    }
    if (!body.name?.trim()) return reply.code(400).send({ error: 'name is required' })

    const [row] = (await db('nivaro_queue_views')
      .insert({
        queue_id: id,
        name: body.name.trim(),
        user: req.user!.id,
        is_shared: !!body.is_shared,
        role: body.role ?? null,
        state: toJsonStr(body.state),
        created_at: new Date()
      })
      .returning('*')) as unknown as [Record<string, unknown>]

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_queue_views',
      item: String(row.id),
      comment: queue.name,
      req
    })

    return reply
      .code(201)
      .send({ data: { ...row, is_shared: !!row.is_shared, state: parseJson(row.state as string) } })
  })

  // DELETE /views/:viewId — owner or admin
  app.delete('/views/:viewId', async (req, reply) => {
    const { viewId } = req.params as { viewId: string }
    const view = (await db('nivaro_queue_views')
      .where({ id: Number(viewId) })
      .first()) as { id: number; user: string } | undefined
    if (!view) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && view.user !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    await db('nivaro_queue_views')
      .where({ id: Number(viewId) })
      .delete()
    // Clear any viewers' default-view pref pointing at the deleted view (no FK,
    // so this is a manual cleanup — a stale id would otherwise just never apply).
    await db('nivaro_queue_column_prefs')
      .where({ default_view_id: Number(viewId) })
      .update({ default_view_id: null })
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_queue_views',
      item: String(viewId),
      req
    })
    return reply.code(204).send()
  })

  // POST /:id/rematerialize — force a full cache rebuild for an already-materialized
  // queue (owner or admin). Needed to refresh caches built before a ceiling/logic
  // change (e.g. the 20k backfill cap) — nothing else re-enqueues a backfill for a
  // queue that is already materialized. Idempotent: chunks delete-then-insert, and
  // the final step re-marks materialized.
  app.post('/:id/rematerialize', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && queue.owner !== req.user!.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    await enqueueQueueMaterializationBackfill(id)
    return reply.send({ data: { enqueued: true } })
  })

  // GET /:id/column-prefs — current user's saved visible-columns for this queue
  app.get('/:id/column-prefs', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) return reply.code(403).send({ error: 'Forbidden' })

    const pref = await db('nivaro_queue_column_prefs')
      .where({ queue_id: id, user: req.user!.id })
      .first()

    return reply.send({
      data: {
        visible_columns: pref ? (parseJson(pref.visible_columns) as string[]) : null,
        default_view_id: pref?.default_view_id ?? null
      }
    })
  })

  // PUT /:id/default-view — set (or clear, view_id=null) the current user's
  // default saved view for this queue. Applied on load; null = general default.
  app.put('/:id/default-view', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) return reply.code(403).send({ error: 'Forbidden' })

    const body = req.body as { view_id?: unknown }
    let viewId: number | null = null
    if (body.view_id != null) {
      if (typeof body.view_id !== 'number' || !Number.isInteger(body.view_id)) {
        return reply.code(400).send({ error: 'view_id must be an integer or null' })
      }
      // The view must exist, belong to this queue, and be readable by the user
      // (own, or shared to everyone / their role) — same visibility as the list.
      const userRole = req.user!.role ?? null
      const view = (await db('nivaro_queue_views')
        .where({ id: body.view_id, queue_id: id })
        .andWhere((qb) => {
          qb.where({ user: req.user!.id }).orWhere((shared) => {
            shared.where('is_shared', true).andWhere((roleQb) => {
              roleQb.whereNull('role')
              if (userRole) roleQb.orWhere('role', userRole)
            })
          })
        })
        .first('id')) as { id: number } | undefined
      if (!view) return reply.code(404).send({ error: 'View not found' })
      viewId = body.view_id
    }

    const existing = await db('nivaro_queue_column_prefs')
      .where({ queue_id: id, user: req.user!.id })
      .first('id')
    if (existing) {
      await db('nivaro_queue_column_prefs')
        .where({ id: existing.id })
        .update({ default_view_id: viewId })
    } else {
      await db('nivaro_queue_column_prefs').insert({
        queue_id: id,
        user: req.user!.id,
        visible_columns: toJsonStr(null),
        default_view_id: viewId
      })
    }

    return reply.send({ data: { default_view_id: viewId } })
  })

  // PUT /:id/column-prefs — upsert current user's visible-columns for this queue
  app.put('/:id/column-prefs', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) return reply.code(403).send({ error: 'Forbidden' })

    const body = req.body as { visible_columns?: unknown }
    if (
      !Array.isArray(body.visible_columns) ||
      body.visible_columns.some((c) => typeof c !== 'string')
    ) {
      return reply.code(400).send({ error: 'visible_columns must be an array of strings' })
    }

    const existing = await db('nivaro_queue_column_prefs')
      .where({ queue_id: id, user: req.user!.id })
      .first('id')

    if (existing) {
      await db('nivaro_queue_column_prefs')
        .where({ id: existing.id })
        .update({ visible_columns: toJsonStr(body.visible_columns) })
    } else {
      await db('nivaro_queue_column_prefs').insert({
        queue_id: id,
        user: req.user!.id,
        visible_columns: toJsonStr(body.visible_columns)
      })
    }

    return reply.send({ data: { visible_columns: body.visible_columns } })
  })

  // GET /:id/items?scope=mine|unowned|all|claimed&sort=&filters=&page=&limit= — fan-out worklist
  app.get('/:id/items', async (req, reply) => {
    const { id } = req.params as { id: string }
    const {
      scope = 'all',
      sort = '',
      filters,
      page: pageRaw,
      limit: limitRaw
    } = req.query as {
      scope?: string
      sort?: string
      filters?: string
      page?: string
      limit?: string
    }
    if (!['mine', 'unowned', 'all', 'claimed'].includes(scope)) {
      return reply.code(400).send({ error: 'scope must be mine, unowned, all, or claimed' })
    }

    let parsedFilters: Record<string, unknown> = {}
    if (filters) {
      try {
        parsedFilters = JSON.parse(filters)
      } catch {
        return reply.code(400).send({ error: 'filters must be valid JSON' })
      }
    }

    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    // Pagination is opt-in: only applied when the caller actually sent a page
    // or limit param. The admin Kanban view shares this same endpoint but
    // needs the full matching set (it renders every item as a card grouped
    // by state), so it omits both params to get everything, same as before
    // this feature existed.
    const paginationRequested = pageRaw !== undefined || limitRaw !== undefined
    const { page, limit } = parsePaginationParams(pageRaw, limitRaw)

    const result = await fetchQueueItems(id, req.user!, scope as QueueScope, {
      sort,
      filters: parsedFilters,
      ...(paginationRequested ? { page, limit } : {})
    })
    return reply.send({
      data: result.items,
      stats: result.stats,
      filtered_stats: result.filteredStats,
      available_values: result.availableValues,
      truncated: result.truncated,
      total: result.total
    })
  })

  // GET /:id/workload — items grouped by owner, with each owner's most
  // restrictive max_wip (MIN across every owner-group they belong to that sets one)
  app.get('/:id/workload', async (req, reply) => {
    const { id } = req.params as { id: string }
    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) return reply.code(403).send({ error: 'Forbidden' })

    const workload = await fetchQueueWorkload(id, req.user!)
    return reply.send({ data: workload })
  })

  // POST /:id/claim — self-assign an item within this queue; write-through to the
  // real pipeline instance-owner table when the item has a live workflow instance.
  app.post('/:id/claim', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { source_collection?: string; item_id?: string }
    if (!body.source_collection || !body.item_id) {
      return reply.code(400).send({ error: 'source_collection and item_id are required' })
    }

    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) return reply.code(403).send({ error: 'Forbidden' })
    if (!queue.claims_enabled) {
      return reply.code(403).send({ error: 'Claiming is disabled for this queue' })
    }

    const { items } = await fetchQueueItems(id, req.user!, 'all')
    const targetKey = `${body.source_collection}:${body.item_id}`
    const found = items.some((i) => `${i.collection}:${i.item_id}` === targetKey)
    if (!found) {
      return reply.code(404).send({ error: 'Item not found in this queue' })
    }

    const existing = await db('nivaro_queue_claims')
      .where({ queue_id: id, source_collection: body.source_collection, item_id: body.item_id })
      .first()
    if (!existing) {
      await db('nivaro_queue_claims').insert({
        queue_id: id,
        source_collection: body.source_collection,
        item_id: body.item_id,
        claimed_by: req.user!.id,
        claimed_at: new Date()
      })
    }

    // Write-through: for sources pointing at a real collection record (everything
    // except 'tasks', whose item_id is a task's own PK, not a business record id),
    // also add the caller as a pipeline instance owner when a live workflow instance
    // exists — same self-add rule the Pipeline Owners panel already uses (POST
    // /pipelines/instance/:collection/:item/owners). Approvals sources point at a
    // real collection+item just like collection sources do, so they get the same
    // treatment, not an exclusion.
    if (body.source_collection !== 'tasks') {
      const instance = await db('nivaro_workflow_instances')
        .where({ collection: body.source_collection, item: body.item_id })
        .first()
      if (instance) {
        const alreadyOwner = await db('nivaro_pipeline_instance_owners')
          .where({ instance: instance.id, user: req.user!.id })
          .first()
        if (!alreadyOwner) {
          await db('nivaro_pipeline_instance_owners').insert({
            instance: instance.id,
            state: null,
            user: req.user!.id,
            added_by: req.user!.id,
            added_at: new Date()
          })
        }
      }
    }

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_queue_claims',
      item: `${body.source_collection}:${body.item_id}`,
      comment: id,
      req
    })

    broadcastCollectionUpdate(app.io, body.source_collection, body.item_id)

    return reply.code(201).send({ data: { claimed: true } })
  })

  // POST /:id/release — undo a claim, removing the write-through owner grant too
  // (only the grant this claim itself added — added_by=self guards against removing
  // ownership that came from an owner group).
  app.post('/:id/release', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { source_collection?: string; item_id?: string }
    if (!body.source_collection || !body.item_id) {
      return reply.code(400).send({ error: 'source_collection and item_id are required' })
    }

    const queue = (await db<QueueRow>('nivaro_queues').where({ id }).first()) as
      | QueueRow
      | undefined
    if (!queue) return reply.code(404).send({ error: 'Not found' })
    if (!canReadQueue(queue, req)) return reply.code(403).send({ error: 'Forbidden' })
    // Deliberately NOT gated on claims_enabled: releasing must stay possible
    // after claiming is turned off, or existing claims (and their
    // pipeline-instance-owner write-through grants) would be stuck forever.

    const { items } = await fetchQueueItems(id, req.user!, 'all')
    const targetKey = `${body.source_collection}:${body.item_id}`
    const found = items.some((i) => `${i.collection}:${i.item_id}` === targetKey)
    if (!found) {
      return reply.code(404).send({ error: 'Item not found in this queue' })
    }

    await db('nivaro_queue_claims')
      .where({
        queue_id: id,
        source_collection: body.source_collection,
        item_id: body.item_id,
        claimed_by: req.user!.id
      })
      .delete()

    // Write-through: remove the write-through owner grant for sources pointing at a
    // real collection record (everything except 'tasks', whose item_id is a task's
    // own PK, not a business record id) — same self-remove rule the Pipeline Owners
    // panel already uses (DELETE /pipelines/instance/:collection/:item/owners).
    // Approvals sources point at a real collection+item just like collection sources
    // do, so they get the same treatment, not an exclusion.
    if (body.source_collection !== 'tasks') {
      const instance = await db('nivaro_workflow_instances')
        .where({ collection: body.source_collection, item: body.item_id })
        .first()
      if (instance) {
        await db('nivaro_pipeline_instance_owners')
          .where({ instance: instance.id, user: req.user!.id, added_by: req.user!.id })
          .delete()
      }
    }

    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_queue_claims',
      item: `${body.source_collection}:${body.item_id}`,
      comment: id,
      req
    })

    broadcastCollectionUpdate(app.io, body.source_collection, body.item_id)

    return reply.code(204).send()
  })
}
