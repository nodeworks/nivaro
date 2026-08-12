import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { runAccessAudit, type AuditSubject } from '../services/access-audit.js'

// ─── Access audits (admin) ───────────────────────────────────────────────────
// CRUD over audit definitions + fire-and-forget runs (import-job precedent:
// the run executes in the background, the UI polls the run row) + paged
// findings for the results table.

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function sanitizeSubjects(raw: unknown): AuditSubject[] {
  if (!Array.isArray(raw)) return []
  const out: AuditSubject[] = []
  for (const s of raw as Array<Record<string, unknown>>) {
    if (!s || typeof s !== 'object') continue
    if (s.type === 'pipeline_owners') {
      out.push({ type: 'pipeline_owners', label: typeof s.label === 'string' ? s.label.slice(0, 100) : 'Owner' })
    } else if (s.type === 'field' && typeof s.field === 'string' && IDENT_RE.test(s.field)) {
      out.push({
        type: 'field',
        field: s.field,
        label: typeof s.label === 'string' ? s.label.slice(0, 100) : s.field
      })
    }
  }
  return out
}

export async function accessAuditsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async (_req, reply) => {
    const audits = (await db('nivaro_access_audits').orderBy('sort').orderBy('id')) as Array<
      Record<string, unknown>
    >
    // Latest run per audit rides along so the list can show status at a glance.
    const runs = (await db('nivaro_access_audit_runs')
      .whereIn('audit', audits.map((a) => a.id as number))
      .orderBy('id', 'desc')) as Array<Record<string, unknown>>
    const latestByAudit = new Map<number, Record<string, unknown>>()
    for (const r of runs) {
      const a = r.audit as number
      if (!latestByAudit.has(a)) latestByAudit.set(a, r)
    }
    return reply.send({
      data: audits.map((a) => ({
        ...a,
        subjects: JSON.parse(String(a.subjects ?? '[]')),
        latest_run: latestByAudit.get(a.id as number) ?? null
      }))
    })
  })

  app.post('/', async (req, reply) => {
    const body = req.body as { name?: string; collection?: string; subjects?: unknown }
    const collection = String(body.collection ?? '')
    if (!IDENT_RE.test(collection) || /^nivaro_/i.test(collection)) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    const subjects = sanitizeSubjects(body.subjects)
    if (subjects.length === 0) return reply.code(400).send({ error: 'At least one subject is required' })
    const name = String(body.name ?? '').trim() || `${collection} access audit`
    await db('nivaro_access_audits').insert({
      name: name.slice(0, 255),
      collection,
      subjects: JSON.stringify(subjects)
    })
    const row = await db('nivaro_access_audits').orderBy('id', 'desc').first()
    void logActivity({
      action: 'access-audit-create',
      user: req.user?.id ?? null,
      collection,
      comment: `audit "${name.slice(0, 80)}" (${subjects.length} subjects)`
    })
    return reply.code(201).send({ data: row })
  })

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as {
      name?: string
      collection?: string
      subjects?: unknown
      is_active?: boolean
    }
    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (body.name !== undefined) patch.name = String(body.name).slice(0, 255)
    if (body.collection !== undefined) {
      const collection = String(body.collection)
      if (!IDENT_RE.test(collection) || /^nivaro_/i.test(collection)) {
        return reply.code(400).send({ error: 'Invalid collection' })
      }
      patch.collection = collection
    }
    if (body.subjects !== undefined) {
      const subjects = sanitizeSubjects(body.subjects)
      if (subjects.length === 0)
        return reply.code(400).send({ error: 'At least one subject is required' })
      patch.subjects = JSON.stringify(subjects)
    }
    if (body.is_active !== undefined) patch.is_active = body.is_active ? 1 : 0
    await db('nivaro_access_audits').where({ id }).update(patch)
    void logActivity({
      action: 'access-audit-update',
      user: req.user?.id ?? null,
      comment: `audit ${id}: ${Object.keys(patch).filter((k) => k !== 'updated_at').join(', ')}`
    })
    return reply.send({ data: await db('nivaro_access_audits').where({ id }).first() })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    await db('nivaro_access_audits').where({ id }).del()
    void logActivity({
      action: 'access-audit-delete',
      user: req.user?.id ?? null,
      comment: `audit ${id}`
    })
    return reply.send({ data: { deleted: true } })
  })

  app.post('/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string }
    const audit = await db('nivaro_access_audits').where({ id }).first()
    if (!audit) return reply.code(404).send({ error: 'Audit not found' })
    const running = await db('nivaro_access_audit_runs')
      .where({ audit: Number(id), status: 'running' })
      .first('id')
    if (running) return reply.code(409).send({ error: 'A run is already in progress for this audit' })
    await db('nivaro_access_audit_runs').insert({
      audit: Number(id),
      status: 'running',
      triggered_by: req.user?.id ?? null,
      // Explicit UTC — the column default is GETDATE() (LOCAL server time),
      // which made durations read hours long against the JS-written finished_at.
      started_at: new Date()
    })
    const run = (await db('nivaro_access_audit_runs')
      .where({ audit: Number(id) })
      .orderBy('id', 'desc')
      .first()) as { id: number }
    void logActivity({
      action: 'access-audit-run',
      user: req.user?.id ?? null,
      collection: String((audit as Record<string, unknown>).collection),
      comment: `access audit "${(audit as Record<string, unknown>).name}" started (run ${run.id})`
    })
    // Fire-and-forget — the UI polls the run row (import-job precedent).
    void runAccessAudit(Number(id), run.id)
    return reply.code(202).send({ data: run })
  })

  app.get('/:id/runs', async (req, reply) => {
    const { id } = req.params as { id: string }
    const rows = await db('nivaro_access_audit_runs')
      .where({ audit: Number(id) })
      .orderBy('id', 'desc')
      .limit(30)
    return reply.send({ data: rows })
  })

  // Per-person rollup of a run's findings — the "who is locked out of what"
  // browse axis; clicking a person filters the findings list via ?user=.
  app.get('/runs/:runId/by-user', async (req, reply) => {
    const { runId } = req.params as { runId: string }
    const rows = (await db('nivaro_access_audit_findings as f')
      .leftJoin('nivaro_users as u', 'f.user', 'u.id')
      .where('f.run', Number(runId))
      .groupBy('f.user', 'u.email', 'u.first_name', 'u.last_name')
      .orderByRaw('count(*) desc')
      .groupBy('u.last_access')
      .select(
        'f.user',
        'u.email',
        'u.first_name',
        'u.last_name',
        'u.last_access',
        db.raw('count(*) as finding_count')
      )) as Array<Record<string, unknown>>
    return reply.send({ data: rows })
  })

  app.get('/runs/:runId/findings', async (req, reply) => {
    const { runId } = req.params as { runId: string }
    const { page = '1', limit = '50', user, search } = req.query as {
      page?: string
      limit?: string
      user?: string
      search?: string
    }
    const perPage = Math.min(Math.max(Number(limit) || 50, 1), 200)
    const p = Math.max(Number(page) || 1, 1)
    let q = db('nivaro_access_audit_findings as f')
      .leftJoin('nivaro_users as u', 'f.user', 'u.id')
      .where('f.run', Number(runId))
    if (user) q = q.where('f.user', user)
    if (search) {
      const term = `%${String(search).replace(/[%_[]/g, (c) => `[${c}]`)}%`
      q = q.where((qb) =>
        qb
          .whereILike('f.item_label', term)
          .orWhereILike('f.item_id', term)
          .orWhereILike('u.email', term)
      )
    }
    const totalRow = (await q.clone().count('* as c').first()) as { c: number } | undefined
    const rows = (await q
      .orderBy('f.id')
      .offset((p - 1) * perPage)
      .limit(perPage)
      .select(
        'f.id',
        'f.collection',
        'f.item_id',
        'f.item_label',
        'f.user',
        'f.subject',
        'f.reasons',
        'u.email as user_email',
        'u.first_name',
        'u.last_name',
        'u.last_access'
      )) as Array<Record<string, unknown>>
    return reply.send({
      data: rows.map((r) => ({ ...r, reasons: JSON.parse(String(r.reasons ?? '[]')) })),
      total: Number(totalRow?.c ?? 0)
    })
  })
}
