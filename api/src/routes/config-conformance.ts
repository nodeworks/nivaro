import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { runConformance, summarizeAllCollections } from '../services/config-conformance.js'

/** Config conformance runs — admin-only, access-audit execution model:
 *  fire-and-forget run, pollable status, findings paged per run. */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export async function configConformanceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  /** Which collections have anything to check, with per-kind counts — the
   *  picker only offers collections where a run can find something. */
  app.get('/collections', async () => {
    const [rows, summaries] = await Promise.all([
      db('nivaro_collections')
        .whereRaw("collection NOT LIKE 'nivaro\\_%' ESCAPE '\\'")
        .whereRaw("collection NOT LIKE 'directus\\_%' ESCAPE '\\'")
        .select('collection', 'display_name') as Promise<
        Array<{ collection: string; display_name: string | null }>
      >,
      summarizeAllCollections()
    ])
    const out = rows
      .filter((r) => IDENT.test(r.collection))
      .map((r) => {
        const s = summaries.get(r.collection)
        if (!s || s.required + s.validation + s.cascade === 0) return null
        return { display_name: r.display_name, ...s }
      })
      .filter(Boolean)
      .sort((a, b) => String(a?.collection).localeCompare(String(b?.collection)))
    return { data: out }
  })

  app.get('/runs', async (req) => {
    const q = req.query as { collection?: string; limit?: string }
    const rows = await db('nivaro_conformance_runs as r')
      .leftJoin('nivaro_users as u', 'u.id', 'r.triggered_by')
      .modify((qb) => {
        if (q.collection) qb.where('r.collection', q.collection)
      })
      .orderBy('r.id', 'desc')
      .limit(Math.min(Number(q.limit ?? 20) || 20, 100))
      .select('r.*', 'u.first_name as triggered_by_first', 'u.last_name as triggered_by_last')
    return {
      data: rows.map((r: Record<string, unknown>) => ({
        ...r,
        triggered_by_name:
          [r.triggered_by_first, r.triggered_by_last].filter(Boolean).join(' ') || null
      }))
    }
  })

  app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const run = await db('nivaro_conformance_runs').where('id', req.params.id).first()
    if (!run) return reply.code(404).send({ error: 'Not found' })
    const q = req.query as {
      page?: string
      limit?: string
      rule?: string
      field?: string
      group?: string
    }
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200)
    const page = Math.max(1, Number(q.page ?? 1) || 1)
    const base = () =>
      db('nivaro_conformance_findings')
        .where('run', run.id)
        .modify((qb) => {
          if (q.rule) qb.where('rule', q.rule)
          if (q.field) qb.where('field', q.field)
        })
    let findings: unknown[]
    let counted: { c?: unknown } | undefined
    if (q.group === 'record') {
      // Grouped mode: page over RECORDS (worst first), then fetch each page
      // record's full finding set — a record's issues must never split
      // across pages.
      const items = (await base()
        .groupBy('item_id')
        .count({ c: '*' })
        .select('item_id')
        .orderByRaw('count(*) desc, item_id asc')
        .offset((page - 1) * limit)
        .limit(limit)) as Array<{ item_id: string; c: number }>
      const itemIds = items.map((i) => i.item_id)
      const rows =
        itemIds.length === 0
          ? []
          : await base().whereIn('item_id', itemIds).orderBy('id', 'asc')
      findings = itemIds.map((id) => ({
        item_id: id,
        item_label: rows.find((r: { item_id: string }) => r.item_id === id)?.item_label ?? null,
        count: Number(items.find((i) => i.item_id === id)?.c ?? 0),
        findings: rows.filter((r: { item_id: string }) => r.item_id === id)
      }))
      const groupCount = (await base()
        .countDistinct({ c: 'item_id' })
        .first()) as { c?: unknown } | undefined
      counted = groupCount
    } else {
      findings = await base()
        .orderBy('id', 'asc')
        .offset((page - 1) * limit)
        .limit(limit)
      counted = (await base().count({ c: '*' }).first()) as { c?: unknown } | undefined
    }
    const stored = await db('nivaro_conformance_findings')
      .where('run', run.id)
      .count({ c: '*' })
      .first()
    // Facet chips come from the run's FULL totals (counted in memory over
    // every violation) — the stored findings rows are only a browsable
    // sample once the cap hits, and chips built from them under-reported.
    const parse = (raw: unknown): Record<string, number> => {
      try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw
        return v && typeof v === 'object' ? (v as Record<string, number>) : {}
      } catch {
        return {}
      }
    }
    const ruleTotals = parse(run.rule_counts)
    const fieldTotals = parse(run.field_counts)
    const byRule = Object.keys(ruleTotals).length
      ? Object.entries(ruleTotals).map(([rule, c]) => ({ rule, c }))
      : await db('nivaro_conformance_findings')
          .where('run', run.id)
          .groupBy('rule')
          .count({ c: '*' })
          .select('rule')
    const byField = Object.keys(fieldTotals).length
      ? Object.entries(fieldTotals)
          .map(([field, c]) => ({ field, c }))
          .sort((a, b) => Number(b.c) - Number(a.c))
      : await db('nivaro_conformance_findings')
          .where('run', run.id)
          .groupBy('field')
          .count({ c: '*' })
          .select('field')
    return {
      data: {
        run,
        findings,
        total: Number(counted?.c ?? 0),
        stored_total: Number(stored?.c ?? 0),
        page,
        limit,
        by_rule: byRule,
        by_field: byField
      }
    }
  })

  app.post<{ Params: { collection: string } }>('/:collection/run', async (req, reply) => {
    const { collection } = req.params
    if (!IDENT.test(collection) || /^nivaro_|^directus_/i.test(collection)) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    const registered = await db('nivaro_collections').where({ collection }).first('id')
    if (!registered) return reply.code(404).send({ error: 'Collection not registered' })
    const running = await db('nivaro_conformance_runs')
      .where({ collection, status: 'running' })
      .first('id')
    if (running) {
      return reply.code(409).send({ error: 'A run is already in progress for this collection' })
    }
    // limit 0 = the whole collection (long run — fire-and-forget + progress
    // polling make that fine); otherwise clamp to 50k.
    const rawLimit = Number((req.body as { limit?: number })?.limit ?? 5000)
    const limit = rawLimit === 0 ? Number.MAX_SAFE_INTEGER : Math.min(rawLimit || 5000, 50000)
    const [inserted] = await db('nivaro_conformance_runs')
      .insert({
        collection,
        status: 'running',
        triggered_by: req.user?.id ?? null,
        // Explicit JS UTC — the access-audit lesson: a GETDATE() default is
        // LOCAL time and makes every duration read hours long.
        started_at: new Date()
      })
      .returning('id')
    const runId = typeof inserted === 'object' ? (inserted as { id: number }).id : inserted
    await logActivity({
      action: 'conformance-run',
      user: req.user?.id,
      collection: 'nivaro_conformance_runs',
      item: String(runId),
      comment: collection,
      req
    })
    // Fire and forget — the UI polls the run row.
    void runConformance(Number(runId), collection, limit)
    return reply.code(202).send({ data: { id: runId, status: 'running' } })
  })
}
