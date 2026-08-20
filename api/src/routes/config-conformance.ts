import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { compileChecks, runConformance } from '../services/config-conformance.js'

/** Config conformance runs — admin-only, access-audit execution model:
 *  fire-and-forget run, pollable status, findings paged per run. */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export async function configConformanceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  /** Which collections have anything to check, with per-kind counts — the
   *  picker only offers collections where a run can find something. */
  app.get('/collections', async () => {
    const rows = (await db('nivaro_collections')
      .whereRaw("collection NOT LIKE 'nivaro\\_%' ESCAPE '\\'")
      .whereRaw("collection NOT LIKE 'directus\\_%' ESCAPE '\\'")
      .select('collection', 'display_name')) as Array<{
      collection: string
      display_name: string | null
    }>
    const out: Array<{
      collection: string
      display_name: string | null
      required: number
      validation: number
      cascade: number
      skipped: number
    }> = []
    for (const r of rows) {
      if (!IDENT.test(r.collection)) continue
      try {
        const checks = await compileChecks(r.collection)
        const total =
          checks.requiredFields.length + checks.validation.length + checks.cascades.length
        if (total === 0) continue
        out.push({
          collection: r.collection,
          display_name: r.display_name,
          required: checks.requiredFields.length,
          validation: checks.validation.length,
          cascade: checks.cascades.length,
          skipped: checks.skipped.length
        })
      } catch {
        /* a broken collection's config must not hide the rest */
      }
    }
    return { data: out }
  })

  app.get('/runs', async (req) => {
    const q = req.query as { collection?: string; limit?: string }
    const rows = await db('nivaro_conformance_runs')
      .modify((qb) => {
        if (q.collection) qb.where('collection', q.collection)
      })
      .orderBy('id', 'desc')
      .limit(Math.min(Number(q.limit ?? 20) || 20, 100))
    return { data: rows }
  })

  app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const run = await db('nivaro_conformance_runs').where('id', req.params.id).first()
    if (!run) return reply.code(404).send({ error: 'Not found' })
    const q = req.query as { page?: string; limit?: string; rule?: string; field?: string }
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200)
    const page = Math.max(1, Number(q.page ?? 1) || 1)
    const base = () =>
      db('nivaro_conformance_findings')
        .where('run', run.id)
        .modify((qb) => {
          if (q.rule) qb.where('rule', q.rule)
          if (q.field) qb.where('field', q.field)
        })
    const findings = await base()
      .orderBy('id', 'asc')
      .offset((page - 1) * limit)
      .limit(limit)
    const counted = await base().count({ c: '*' }).first()
    // Facets for the filter chips.
    const byRule = await db('nivaro_conformance_findings')
      .where('run', run.id)
      .groupBy('rule')
      .count({ c: '*' })
      .select('rule')
    const byField = await db('nivaro_conformance_findings')
      .where('run', run.id)
      .groupBy('field')
      .count({ c: '*' })
      .select('field')
    return {
      data: {
        run,
        findings,
        total: Number(counted?.c ?? 0),
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
    const limit = Math.min(Number((req.body as { limit?: number })?.limit ?? 5000) || 5000, 50000)
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
