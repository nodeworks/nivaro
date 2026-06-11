import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { DEFAULT_REDACT_FIELDS, executeRetentionPolicy } from '../services/retention.js'

function parseJson<T>(val: unknown): T {
  if (!val) return [] as unknown as T
  if (typeof val === 'string') { try { return JSON.parse(val) as T } catch { return [] as unknown as T } }
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
    exclusion_roles: parseJson(row.exclusion_roles)
  }
}

export async function retentionRoutes(app: FastifyInstance) {
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
    const [id] = await db('nivaro_retention_policies').insert({
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
      created_by: req.user?.id ?? null
    })
    const row = await db('nivaro_retention_policies').where({ id }).first()
    return reply.code(201).send({ data: format(row) })
  })

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const b = req.body as Record<string, unknown>
    const u: Record<string, unknown> = {}
    const str = (k: string) => { if (b[k] !== undefined) u[k] = b[k] }
    const json = (k: string) => { if (b[k] !== undefined) u[k] = toJson(b[k]) }
    str('name'); str('inactivity_threshold_months'); str('action')
    str('redact_value_template'); str('cron_schedule'); str('is_active'); str('dry_run_mode')
    json('redact_fields'); json('exclusion_emails'); json('exclusion_roles')
    if (Object.keys(u).length) await db('nivaro_retention_policies').where({ id }).update(u)
    const row = await db('nivaro_retention_policies').where({ id }).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return reply.send({ data: format(row) })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    await db('nivaro_retention_policies').where({ id }).delete()
    return reply.code(204).send()
  })

  app.post('/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string }
    const isDryRun = (req.query as { dry_run?: string }).dry_run === 'true'
    const row = await db('nivaro_retention_policies').where({ id }).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })

    const started = new Date()
    const result = await executeRetentionPolicy(format(row) as Parameters<typeof executeRetentionPolicy>[0], req.user?.id, isDryRun)

    await db('nivaro_retention_runs').insert({
      policy_id: Number(id),
      started_at: started,
      finished_at: new Date(),
      affected_count: result.affectedCount,
      dry_run: isDryRun,
      errors: result.errors.length ? JSON.stringify(result.errors) : null,
      affected_ids: result.affectedIds.length ? JSON.stringify(result.affectedIds) : null,
      triggered_by: req.user?.id ?? null
    })

    return reply.send({ data: { ...result, dry_run: isDryRun } })
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
