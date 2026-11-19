import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { activitySourceOf, normalizeActivityFilters } from '../services/activity-filters.js'
import {
  changedFieldsFor,
  fieldChanges,
  parseTableQuery,
  readableSnapshot,
  readFacets,
  readTablePage,
  relatedIds,
  requestsFor,
  revisionFor
} from '../services/activity-table.js'
import { withReadGate } from '../services/read-gate.js'
import { isStatementTimeout } from '../services/request-trace.js'
import { pageRows } from './activity.js'

/**
 * The Activity log's Table view (administrators — the same audience as GET /api/activity):
 *
 *   GET /activity/table?<filters>&sort=&limit=&offset=&fold=&group_key=
 *        one row per entry (bursts folded to their newest entry unless fold=0), each with its
 *        changed field names, actor kind, source and the request that wrote it.
 *        → {data, total, has_more, limit, offset, sort, window_from?}
 *   GET /activity/table/facets?<filters>
 *        counts per action / collection / person / actor kind / source, each over the OTHER
 *        filters. → {data: {facets, from, defaulted}}
 *   GET /activity/:id/detail
 *        one entry to the last leaf: every field change old → new, the record snapshot, the
 *        request, the person, and the related entries (same request, same burst, the record's
 *        entry before and after).
 *
 * The filters are GET /api/activity's (services/activity-filters.ts) — saved views, the
 * natural-language search and the audit CSV speak the same shape. Reads go through the read
 * gate; a statement timeout is "too broad right now" (503 ACTIVITY_BUSY), never a 500.
 */
export async function activityTableRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate)

  app.get('/table', { preHandler: requireAdmin }, async (req, reply) => {
    const raw = req.query as Record<string, unknown>
    const { query, errors } = parseTableQuery(raw)
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') })
    try {
      const page = await withReadGate(req.user?.id, () => readTablePage(query), {
        label: 'activity-table'
      })
      const [rows, fields, requests] = await Promise.all([
        pageRows(page.ids),
        changedFieldsFor(page.ids),
        requestsFor(page.ids)
      ])
      const data = rows.map((r) => {
        const id = Number(r.id)
        const gk = r.group_key ? String(r.group_key) : null
        return {
          ...r,
          source: activitySourceOf(r),
          fields_changed: fields.get(id) ?? [],
          group_count: gk ? (page.groupCounts.get(gk) ?? null) : null,
          request: requests.get(id) ?? null
        }
      })
      return reply.send({
        data,
        total: page.total,
        has_more: page.hasMore,
        limit: query.limit,
        offset: query.offset,
        sort: `${query.sort.dir === 'desc' ? '-' : ''}${query.sort.key}`,
        ...(page.defaultedFrom ? { window_from: page.defaultedFrom.toISOString() } : {})
      })
    } catch (err) {
      if (!isStatementTimeout(err)) throw err
      req.log.warn({ err }, 'activity table: statement timed out')
      return reply.code(503).send({
        error: 'The activity log took too long to read with these filters.',
        hint: 'Add a date range, a person or a collection to narrow it, then try again.',
        code: 'ACTIVITY_BUSY'
      })
    }
  })

  app.get('/table/facets', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = normalizeActivityFilters(req.query)
    if (parsed.errors.length) return reply.code(400).send({ error: parsed.errors.join('; ') })
    const data = await withReadGate(req.user?.id, () => readFacets(parsed.filters), {
      label: 'activity-facets'
    })
    return reply.send({ data })
  })

  app.get('/:id/detail', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!/^[0-9]{1,15}$/.test(id)) return reply.code(404).send({ error: 'Not found' })
    const n = Number(id)
    const [rows, ua] = await Promise.all([
      pageRows([n]),
      db('nivaro_activity').where('id', n).first('user_agent') as Promise<
        { user_agent?: string | null } | undefined
      >
    ])
    const entry = rows[0]
    if (!entry) return reply.code(404).send({ error: 'Not found' })
    const collection = entry.collection ? String(entry.collection) : null
    const item = entry.item != null ? String(entry.item) : null
    const [revision, related, requests, fields] = await Promise.all([
      revisionFor(n, collection, item).catch(() => null),
      relatedIds({
        id: n,
        collection,
        item,
        group_key: entry.group_key ? String(entry.group_key) : null
      }).catch(() => null),
      requestsFor([n]),
      changedFieldsFor([n])
    ])
    // Administrators read every field (the route is theirs); secrets are withheld regardless.
    const allowed: string[] | null = null
    const ids = related
      ? [
          ...related.sameRequest,
          ...related.sameGroup.ids,
          ...(related.before ? [related.before] : []),
          ...(related.after ? [related.after] : [])
        ]
      : []
    const relatedRows = new Map((await pageRows([...new Set(ids)])).map((r) => [Number(r.id), r]))
    const pick = (list: number[]) =>
      list.map((x) => relatedRows.get(x)).filter((r): r is Record<string, unknown> => !!r)
    let person: Record<string, unknown> | null = null
    if (entry.user) {
      const u = (await db('nivaro_users as u')
        .leftJoin('nivaro_roles as r', 'r.id', 'u.role')
        .where('u.id', String(entry.user))
        .first('u.id', 'u.first_name', 'u.last_name', 'u.email', 'u.status', 'r.name as role')) as
        | Record<string, unknown>
        | undefined
      if (u)
        person = {
          id: String(u.id),
          name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email || null,
          email: u.email ?? null,
          status: u.status ?? null,
          role: u.role ?? null
        }
    }
    return reply.send({
      data: {
        entry: {
          ...entry,
          user_agent: ua?.user_agent ?? null,
          source: activitySourceOf(entry),
          fields_changed: fields.get(n) ?? [],
          request: requests.get(n) ?? null
        },
        changes: revision ? fieldChanges(revision.delta, revision.previous_data, allowed) : [],
        revision: revision ? { id: revision.id, previous_id: revision.previous_id } : null,
        snapshot: revision ? readableSnapshot(revision.data, allowed) : null,
        person,
        related: related
          ? {
              same_request: pick(related.sameRequest),
              same_group: { count: related.sameGroup.count, rows: pick(related.sameGroup.ids) },
              before: related.before ? (relatedRows.get(related.before) ?? null) : null,
              after: related.after ? (relatedRows.get(related.after) ?? null) : null,
              on_record: related.onRecord
            }
          : null
      }
    })
  })
}
