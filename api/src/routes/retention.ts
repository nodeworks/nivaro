import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  CANDIDATE_LIST_MAX,
  DEFAULT_REDACT_FIELDS,
  type RetentionPolicy,
  runRetentionPolicy
} from '../services/retention.js'
import { resyncAfterWrites } from '../services/row-schedules.js'

function parseJson<T>(val: unknown): T {
  if (!val) return [] as unknown as T
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T
    } catch {
      return [] as unknown as T
    }
  }
  return val as T
}

function toJson(val: unknown): string {
  if (!val) return '[]'
  if (typeof val === 'string') return val
  return JSON.stringify(val)
}

function format(row: Record<string, unknown>) {
  return {
    ...row,
    redact_fields: parseJson(row.redact_fields),
    exclusion_emails: parseJson(row.exclusion_emails),
    exclusion_roles: parseJson(row.exclusion_roles),
    // Migration 524 — false on a database that has not run it yet.
    require_directory_gone: row.require_directory_gone === true || row.require_directory_gone === 1
  }
}

const bool = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

export async function retentionRoutes(app: FastifyInstance) {
  // A saved, edited or removed schedule takes effect at once, on every process.
  resyncAfterWrites(app, 'retention')
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireAdmin)

  app.get('/', async (_req, reply) => {
    const rows = await db('nivaro_retention_policies').orderBy('created_at', 'asc')
    return reply.send({ data: rows.map(format) })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await db('nivaro_retention_policies').where({ id }).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: format(row) })
  })

  app.post('/', async (req, reply) => {
    const b = req.body as Record<string, unknown>
    const inserted = await db('nivaro_retention_policies')
      .insert({
        name: b.name,
        inactivity_threshold_months: b.inactivity_threshold_months ?? 36,
        action: b.action ?? 'redact',
        redact_fields: toJson(b.redact_fields ?? DEFAULT_REDACT_FIELDS),
        redact_value_template: b.redact_value_template ?? 'Redacted_{{id}}',
        exclusion_emails: toJson(b.exclusion_emails ?? []),
        exclusion_roles: toJson(b.exclusion_roles ?? []),
        cron_schedule: b.cron_schedule ?? null,
        is_active: b.is_active ?? true,
        dry_run_mode: b.dry_run_mode ?? false,
        ...((await hasColumn('nivaro_retention_policies', 'require_directory_gone'))
          ? { require_directory_gone: bool(b.require_directory_gone) }
          : {}),
        created_by: req.user?.id ?? null
        // MSSQL/tedious returns row count on bare insert — OUTPUT the identity
      })
      .returning('id')
    const id = typeof inserted[0] === 'object' ? (inserted[0] as { id: number }).id : inserted[0]
    const row = await db('nivaro_retention_policies').where({ id }).first()
    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_retention_policies',
      item: String(id),
      comment: String(b.name ?? ''),
      req
    })
    return reply.code(201).send({ data: format(row) })
  })

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const b = req.body as Record<string, unknown>
    const u: Record<string, unknown> = {}
    const str = (k: string) => {
      if (b[k] !== undefined) u[k] = b[k]
    }
    const json = (k: string) => {
      if (b[k] !== undefined) u[k] = toJson(b[k])
    }
    str('name')
    str('inactivity_threshold_months')
    str('action')
    str('redact_value_template')
    str('cron_schedule')
    str('is_active')
    str('dry_run_mode')
    json('redact_fields')
    json('exclusion_emails')
    json('exclusion_roles')
    if (
      b.require_directory_gone !== undefined &&
      (await hasColumn('nivaro_retention_policies', 'require_directory_gone'))
    ) {
      u.require_directory_gone = bool(b.require_directory_gone)
    }
    if (Object.keys(u).length) {
      await db('nivaro_retention_policies').where({ id }).update(u)
      await logActivity({
        action: 'update',
        user: req.user?.id,
        collection: 'nivaro_retention_policies',
        item: id,
        comment: Object.keys(u).join(', '),
        req
      })
    }
    const row = await db('nivaro_retention_policies').where({ id }).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: format(row) })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const removed = await db('nivaro_retention_policies').where({ id }).delete()
    if (removed > 0) {
      await logActivity({
        action: 'delete',
        user: req.user?.id,
        collection: 'nivaro_retention_policies',
        item: id,
        req
      })
    }
    return reply.code(204).send()
  })

  app.post('/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string }
    const isDryRun = (req.query as { dry_run?: string }).dry_run === 'true'
    const row = await db('nivaro_retention_policies').where({ id }).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })

    // Records the run (nivaro_retention_runs) and its activity row itself —
    // the policy's own schedule goes through the same function.
    const result = await runRetentionPolicy(format(row) as unknown as RetentionPolicy, {
      triggeredBy: req.user?.id,
      dryRun: isDryRun,
      source: 'manual',
      req
    })

    // Snake_case to match the admin RunResult shape (and GET /:id/runs)
    return reply.send({
      data: {
        affected_count: result.affectedCount,
        affected_ids: result.affectedIds,
        errors: result.errors,
        // What actually happened: a policy in dry-run mode never writes.
        dry_run: result.dryRun,
        refused: result.refused ?? null,
        cutoff: result.cutoff,
        candidates: result.candidates,
        candidates_truncated: result.affectedCount > CANDIDATE_LIST_MAX,
        skipped: result.skipped
      }
    })
  })

  app.get('/:id/runs', async (req, reply) => {
    const { id } = req.params as { id: string }
    const runs = await db('nivaro_retention_runs')
      .where({ policy_id: id })
      .orderBy('started_at', 'desc')
      .limit(50)
    return reply.send({
      data: runs.map((r: Record<string, unknown>) => ({
        ...r,
        errors: parseJson(r.errors),
        affected_ids: parseJson(r.affected_ids)
      }))
    })
  })
}
