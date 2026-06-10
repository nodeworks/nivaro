import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

const RULE_TYPES = ['not_null', 'regex', 'range', 'unique', 'formula'] as const
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
const ROW_CAP = 50000
const SAMPLE_CAP = 20

type RuleType = (typeof RULE_TYPES)[number]

interface DqRule {
  id: number
  collection: string
  name: string
  rule_type: RuleType
  field: string | null
  config: string | null
  severity: string
  is_active: boolean
  created_at: Date
}

interface FormulaCondition {
  field: string
  op: string
  value?: unknown
}

interface RuleResult {
  rule_id: number
  name: string
  severity: string
  rule_type: string
  field: string | null
  failed_count: number
  sample_ids: (string | number)[]
  error?: string
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function formatRule(row: DqRule) {
  return {
    ...row,
    is_active: !!row.is_active,
    config: parseJson<Record<string, unknown>>(row.config)
  }
}

function applyCondition(q: ReturnType<typeof db>, cond: FormulaCondition): ReturnType<typeof db> {
  switch (cond.op) {
    case 'eq':
      return q.where(cond.field, cond.value as never)
    case 'neq':
      return q.whereNot(cond.field, cond.value as never)
    case 'gt':
      return q.where(cond.field, '>', cond.value as never)
    case 'gte':
      return q.where(cond.field, '>=', cond.value as never)
    case 'lt':
      return q.where(cond.field, '<', cond.value as never)
    case 'lte':
      return q.where(cond.field, '<=', cond.value as never)
    case 'contains':
      return q.where(cond.field, 'like', `%${cond.value}%`)
    case 'null':
      return q.whereNull(cond.field)
    case 'nnull':
      return q.whereNotNull(cond.field)
    default:
      throw new Error(`Unknown formula operator: ${cond.op}`)
  }
}

async function runRule(collection: string, rule: DqRule): Promise<RuleResult> {
  const base: RuleResult = {
    rule_id: rule.id,
    name: rule.name,
    severity: rule.severity,
    rule_type: rule.rule_type,
    field: rule.field,
    failed_count: 0,
    sample_ids: []
  }
  const config = parseJson<Record<string, unknown>>(rule.config) ?? {}

  try {
    switch (rule.rule_type) {
      case 'not_null': {
        if (!rule.field) throw new Error('Rule has no field configured')
        const field = rule.field
        const failQuery = () =>
          db(collection).where((b) => {
            b.whereNull(field).orWhereRaw("CAST(?? AS NVARCHAR(MAX)) = ''", [field])
          })
        const countRow = await failQuery().count('* as c').first()
        base.failed_count = Number(countRow?.c ?? 0)
        const samples = await failQuery().select('id').limit(SAMPLE_CAP)
        base.sample_ids = samples.map((r) => r.id)
        break
      }

      case 'regex': {
        if (!rule.field) throw new Error('Rule has no field configured')
        const pattern = config.pattern
        if (typeof pattern !== 'string' || !pattern) {
          throw new Error('Regex rule requires config.pattern')
        }
        const re = new RegExp(pattern)
        const rows = await db(collection)
          .select('id', rule.field)
          .whereNotNull(rule.field)
          .limit(ROW_CAP)
        const failures = rows.filter((r) => !re.test(String(r[rule.field as string])))
        base.failed_count = failures.length
        base.sample_ids = failures.slice(0, SAMPLE_CAP).map((r) => r.id)
        break
      }

      case 'range': {
        if (!rule.field) throw new Error('Rule has no field configured')
        const field = rule.field
        const min = config.min
        const max = config.max
        if (min == null && max == null) {
          throw new Error('Range rule requires config.min and/or config.max')
        }
        const failQuery = () =>
          db(collection)
            .whereNotNull(field)
            .where((b) => {
              if (min != null) b.orWhere(field, '<', Number(min))
              if (max != null) b.orWhere(field, '>', Number(max))
            })
        const countRow = await failQuery().count('* as c').first()
        base.failed_count = Number(countRow?.c ?? 0)
        const samples = await failQuery().select('id').limit(SAMPLE_CAP)
        base.sample_ids = samples.map((r) => r.id)
        break
      }

      case 'unique': {
        if (!rule.field) throw new Error('Rule has no field configured')
        const field = rule.field
        const dupes = (await db(collection)
          .select(field)
          .count('* as c')
          .whereNotNull(field)
          .groupBy(field)
          .havingRaw('COUNT(*) > 1')
          .limit(ROW_CAP)) as Record<string, unknown>[]
        base.failed_count = dupes.reduce((sum, r) => sum + Number(r.c ?? 0), 0)
        const dupValues = dupes.slice(0, SAMPLE_CAP).map((r) => r[field])
        if (dupValues.length > 0) {
          const samples = await db(collection)
            .select('id')
            .whereIn(field, dupValues as never[])
            .limit(SAMPLE_CAP)
          base.sample_ids = samples.map((r) => r.id)
        }
        break
      }

      case 'formula': {
        const conditions = config.conditions as FormulaCondition[] | undefined
        if (!Array.isArray(conditions) || conditions.length === 0) {
          throw new Error('Formula rule requires config.conditions array')
        }
        // Rows MATCHING all conditions fail
        const failQuery = () => {
          let q = db(collection)
          for (const cond of conditions) {
            if (!cond.field || !cond.op) throw new Error('Each condition needs field + op')
            q = applyCondition(q, cond)
          }
          return q
        }
        const countRow = await failQuery().count('* as c').first()
        base.failed_count = Number(countRow?.c ?? 0)
        const samples = await failQuery().select('id').limit(SAMPLE_CAP)
        base.sample_ids = samples.map((r) => r.id)
        break
      }

      default:
        throw new Error(`Unknown rule type: ${rule.rule_type}`)
    }
  } catch (err) {
    base.error = err instanceof Error ? err.message : 'Rule execution failed'
  }

  return base
}

export async function dataQualityRoutes(app: FastifyInstance) {
  // ─── Rules CRUD ──────────────────────────────────────────────────────────────

  // GET /data-quality/rules?collection=
  app.get('/rules', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.query as { collection?: string }
    let query = db<DqRule>('nivaro_dq_rules').orderBy('id')
    if (collection) query = query.where({ collection })
    const rows = await query
    return reply.send({ data: rows.map(formatRule) })
  })

  // POST /data-quality/rules
  app.post('/rules', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      collection: string
      name: string
      rule_type: RuleType
      field?: string | null
      config?: Record<string, unknown> | null
      severity?: string
      is_active?: boolean
    }

    if (!body.collection || !body.name || !body.rule_type) {
      return reply.code(400).send({ error: 'collection, name, and rule_type are required' })
    }
    if (!RULE_TYPES.includes(body.rule_type)) {
      return reply.code(400).send({ error: `rule_type must be one of ${RULE_TYPES.join(', ')}` })
    }
    if (body.severity && !SEVERITIES.includes(body.severity as never)) {
      return reply.code(400).send({ error: `severity must be one of ${SEVERITIES.join(', ')}` })
    }
    if (body.collection.startsWith('nivaro_')) {
      return reply.code(400).send({ error: 'System collections cannot have data quality rules' })
    }

    const [row] = await db('nivaro_dq_rules')
      .insert({
        collection: body.collection,
        name: body.name,
        rule_type: body.rule_type,
        field: body.field ?? null,
        config: body.config ? JSON.stringify(body.config) : null,
        severity: body.severity ?? 'medium',
        is_active: body.is_active !== false ? 1 : 0,
        created_at: new Date()
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row
    const created = await db<DqRule>('nivaro_dq_rules').where({ id: insertedId }).first()

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_dq_rules',
      item: String(insertedId),
      req
    })

    return reply.code(201).send({ data: formatRule(created!) })
  })

  // PATCH /data-quality/rules/:id
  app.patch('/rules/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db<DqRule>('nivaro_dq_rules').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as Partial<{
      name: string
      rule_type: RuleType
      field: string | null
      config: Record<string, unknown> | null
      severity: string
      is_active: boolean
    }>

    if (body.rule_type !== undefined && !RULE_TYPES.includes(body.rule_type)) {
      return reply.code(400).send({ error: `rule_type must be one of ${RULE_TYPES.join(', ')}` })
    }
    if (body.severity !== undefined && !SEVERITIES.includes(body.severity as never)) {
      return reply.code(400).send({ error: `severity must be one of ${SEVERITIES.join(', ')}` })
    }

    const patch: Record<string, unknown> = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.rule_type !== undefined) patch.rule_type = body.rule_type
    if ('field' in body) patch.field = body.field ?? null
    if ('config' in body) patch.config = body.config ? JSON.stringify(body.config) : null
    if (body.severity !== undefined) patch.severity = body.severity
    if (body.is_active !== undefined) patch.is_active = body.is_active ? 1 : 0

    if (Object.keys(patch).length > 0) {
      await db('nivaro_dq_rules').where({ id }).update(patch)
    }
    const updated = await db<DqRule>('nivaro_dq_rules').where({ id }).first()

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_dq_rules',
      item: id,
      req
    })

    return reply.send({ data: formatRule(updated!) })
  })

  // DELETE /data-quality/rules/:id
  app.delete('/rules/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db<DqRule>('nivaro_dq_rules').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    await db('nivaro_dq_rules').where({ id }).delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_dq_rules',
      item: id,
      req
    })

    return reply.code(204).send()
  })

  // ─── Inspection runs ─────────────────────────────────────────────────────────

  // POST /data-quality/run/:collection — execute all active rules
  app.post('/run/:collection', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.params as { collection: string }

    if (collection.startsWith('nivaro_')) {
      return reply.code(400).send({ error: 'System collections cannot be inspected' })
    }

    const rules = await db<DqRule>('nivaro_dq_rules').where({ collection, is_active: true })
    if (rules.length === 0) {
      return reply.code(400).send({ error: 'No active rules for this collection' })
    }

    const startedAt = new Date()

    let totalRecords = 0
    try {
      const totalRow = await db(collection).count('* as c').first()
      totalRecords = Number(totalRow?.c ?? 0)
    } catch {
      return reply.code(400).send({ error: `Collection table not found: ${collection}` })
    }

    const results: RuleResult[] = []
    for (const rule of rules) {
      results.push(await runRule(collection, rule))
    }

    const failedRecords = results.reduce((sum, r) => sum + r.failed_count, 0)
    const finishedAt = new Date()

    const [row] = await db('nivaro_dq_runs')
      .insert({
        collection,
        started_at: startedAt,
        finished_at: finishedAt,
        total_records: totalRecords,
        failed_records: failedRecords,
        results: JSON.stringify(results),
        created_by: req.user!.id
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? row.id : row

    return reply.code(201).send({
      data: {
        id: insertedId,
        collection,
        started_at: startedAt,
        finished_at: finishedAt,
        total_records: totalRecords,
        failed_records: failedRecords,
        results,
        created_by: req.user!.id
      }
    })
  })

  // GET /data-quality/runs?collection=
  app.get('/runs', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.query as { collection?: string }
    let query = db('nivaro_dq_runs').orderBy('id', 'desc').limit(50)
    if (collection) query = query.where({ collection })
    const rows = await query
    return reply.send({
      data: rows.map((r) => ({ ...r, results: parseJson<RuleResult[]>(r.results) ?? [] }))
    })
  })

  // GET /data-quality/runs/:id
  app.get('/runs/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const row = await db('nivaro_dq_runs').where({ id }).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return reply.send({
      data: { ...row, results: parseJson<RuleResult[]>(row.results) ?? [] }
    })
  })
}
