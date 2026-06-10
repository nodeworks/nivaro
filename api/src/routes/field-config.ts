import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'

function parseJsonSafe(val: unknown): unknown {
  if (val === null || val === undefined) return val
  if (typeof val !== 'string') return val
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}

interface FieldRow {
  field: string
  group_key: string | null
  visibility_rules: string | null
  dependency_config: string | null
  validation_rules: string | null
  lock_condition: string | null
  default_formula: string | null
  cross_record_defaults: string | null
  remote_options_config: string | null
  repeater_schema: string | null
  is_translatable: number | boolean | null
}

function formatFieldConfig(row: FieldRow) {
  return {
    field: row.field,
    group_key: row.group_key ?? null,
    visibility_rules: parseJsonSafe(row.visibility_rules),
    dependency_config: parseJsonSafe(row.dependency_config),
    validation_rules: parseJsonSafe(row.validation_rules),
    lock_condition: parseJsonSafe(row.lock_condition),
    default_formula: row.default_formula ?? null,
    cross_record_defaults: parseJsonSafe(row.cross_record_defaults),
    remote_options_config: parseJsonSafe(row.remote_options_config),
    repeater_schema: parseJsonSafe(row.repeater_schema),
    is_translatable: !!row.is_translatable
  }
}

// ─── Simple formula evaluator ─────────────────────────────────────────────────

function evaluateFormula(formula: string, values: Record<string, unknown>): unknown {
  const f = formula.trim()

  if (f === 'TODAY()') {
    return new Date().toISOString().slice(0, 10)
  }

  const upperMatch = f.match(/^UPPER\((\w+)\)$/)
  if (upperMatch) {
    const v = values[upperMatch[1]]
    return typeof v === 'string' ? v.toUpperCase() : v
  }

  const lowerMatch = f.match(/^LOWER\((\w+)\)$/)
  if (lowerMatch) {
    const v = values[lowerMatch[1]]
    return typeof v === 'string' ? v.toLowerCase() : v
  }

  const concatMatch = f.match(/^CONCAT\((.+)\)$/)
  if (concatMatch) {
    const parts = concatMatch[1].split(',').map((p) => p.trim())
    return parts
      .map((p) => {
        if (p.startsWith("'") && p.endsWith("'")) return p.slice(1, -1)
        if (p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1)
        return String(values[p] ?? '')
      })
      .join('')
  }

  return undefined
}

// ─── Visibility rule evaluator ────────────────────────────────────────────────

type Condition = { field: string; operator: string; value: unknown }
type VisibilityRules = { show_when?: Condition[]; hide_when?: Condition[] }

function evaluateCondition(cond: Condition, values: Record<string, unknown>): boolean {
  const actual = values[cond.field]
  switch (cond.operator) {
    case 'eq':
      return actual === cond.value
    case 'neq':
      return actual !== cond.value
    case 'null':
      return actual == null
    case 'nnull':
      return actual != null
    case 'in':
      return Array.isArray(cond.value) && cond.value.includes(actual)
    case 'nin':
      return Array.isArray(cond.value) && !cond.value.includes(actual)
    case 'gt':
      return Number(actual) > Number(cond.value)
    case 'lt':
      return Number(actual) < Number(cond.value)
    default:
      return false
  }
}

export async function fieldConfigRoutes(app: FastifyInstance) {
  // GET /field-config/:collection — get all field configs for a collection
  app.get('/:collection', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }

    const rows = (await db('nivaro_fields')
      .where({ collection })
      .select(
        'field',
        'group_key',
        'visibility_rules',
        'dependency_config',
        'validation_rules',
        'lock_condition',
        'default_formula',
        'cross_record_defaults',
        'remote_options_config',
        'repeater_schema',
        'is_translatable'
      )
      .orderBy('sort', 'asc')) as FieldRow[]

    return reply.send({ data: rows.map(formatFieldConfig) })
  })

  // PATCH /field-config/:collection/:field — update field config
  app.patch('/:collection/:field', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection, field } = req.params as { collection: string; field: string }

    const existing = await db('nivaro_fields').where({ collection, field }).first()
    if (!existing) return reply.code(404).send({ error: 'Field not found' })

    const body = req.body as Partial<{
      group_key: string | null
      visibility_rules: unknown
      dependency_config: unknown
      validation_rules: unknown
      lock_condition: unknown
      default_formula: string | null
      cross_record_defaults: unknown
      remote_options_config: unknown
      repeater_schema: unknown
      is_translatable: boolean
    }>

    const patch: Record<string, unknown> = { updated_at: new Date() }

    if ('group_key' in body) patch.group_key = body.group_key ?? null
    if ('visibility_rules' in body)
      patch.visibility_rules =
        body.visibility_rules != null ? JSON.stringify(body.visibility_rules) : null
    if ('dependency_config' in body)
      patch.dependency_config =
        body.dependency_config != null ? JSON.stringify(body.dependency_config) : null
    if ('validation_rules' in body)
      patch.validation_rules =
        body.validation_rules != null ? JSON.stringify(body.validation_rules) : null
    if ('lock_condition' in body)
      patch.lock_condition =
        body.lock_condition != null ? JSON.stringify(body.lock_condition) : null
    if ('default_formula' in body) patch.default_formula = body.default_formula ?? null
    if ('cross_record_defaults' in body)
      patch.cross_record_defaults =
        body.cross_record_defaults != null ? JSON.stringify(body.cross_record_defaults) : null
    if ('remote_options_config' in body)
      patch.remote_options_config =
        body.remote_options_config != null ? JSON.stringify(body.remote_options_config) : null
    if ('repeater_schema' in body)
      patch.repeater_schema =
        body.repeater_schema != null ? JSON.stringify(body.repeater_schema) : null
    if ('is_translatable' in body) patch.is_translatable = body.is_translatable ? 1 : 0

    await db('nivaro_fields').where({ collection, field }).update(patch)

    const updated = (await db('nivaro_fields')
      .where({ collection, field })
      .select(
        'field',
        'group_key',
        'visibility_rules',
        'dependency_config',
        'validation_rules',
        'lock_condition',
        'default_formula',
        'cross_record_defaults',
        'remote_options_config',
        'repeater_schema',
        'is_translatable'
      )
      .first()) as FieldRow

    return reply.send({ data: formatFieldConfig(updated) })
  })

  // POST /field-config/:collection/evaluate-visibility
  app.post('/:collection/evaluate-visibility', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { values } = req.body as { values: Record<string, unknown> }

    const rows = (await db('nivaro_fields')
      .where({ collection })
      .select('field', 'visibility_rules')) as Array<{
      field: string
      visibility_rules: string | null
    }>

    const hidden_fields: string[] = []

    for (const row of rows) {
      if (!row.visibility_rules) continue
      const rules = parseJsonSafe(row.visibility_rules) as VisibilityRules | null
      if (!rules) continue

      let isVisible = true

      // hide_when: if any condition matches, hide the field
      if (rules.hide_when && rules.hide_when.length > 0) {
        const shouldHide = rules.hide_when.some((c) => evaluateCondition(c, values))
        if (shouldHide) isVisible = false
      }

      // show_when: field is only shown if at least one condition matches
      if (isVisible && rules.show_when && rules.show_when.length > 0) {
        const shouldShow = rules.show_when.some((c) => evaluateCondition(c, values))
        if (!shouldShow) isVisible = false
      }

      if (!isVisible) hidden_fields.push(row.field)
    }

    return reply.send({ hidden_fields })
  })

  // POST /field-config/:collection/evaluate-defaults
  app.post('/:collection/evaluate-defaults', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { trigger_field, values } = req.body as {
      trigger_field: string
      values: Record<string, unknown>
    }

    const rows = (await db('nivaro_fields')
      .where({ collection })
      .whereNotNull('default_formula')
      .select('field', 'default_formula')) as Array<{
      field: string
      default_formula: string
    }>

    const updates: Record<string, unknown> = {}

    for (const row of rows) {
      const formula = row.default_formula
      // Only evaluate if the formula references the trigger field
      if (!formula.includes(trigger_field) && formula !== 'TODAY()') continue
      const result = evaluateFormula(formula, values)
      if (result !== undefined) {
        updates[row.field] = result
      }
    }

    return reply.send({ updates })
  })

  // POST /field-config/:collection/evaluate-lock
  app.post('/:collection/evaluate-lock', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { values } = req.body as { values: Record<string, unknown> }

    const rows = (await db('nivaro_fields')
      .where({ collection })
      .whereNotNull('lock_condition')
      .select('field', 'lock_condition')) as Array<{
      field: string
      lock_condition: string
    }>

    const locked_fields: string[] = []

    for (const row of rows) {
      const condition = parseJsonSafe(row.lock_condition) as Condition | null
      if (!condition) continue
      if (evaluateCondition(condition, values)) {
        locked_fields.push(row.field)
      }
    }

    return reply.send({ locked_fields })
  })

  // POST /field-config/:collection/cascade
  app.post('/:collection/cascade', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }
    const { changed_field, values } = req.body as {
      changed_field: string
      values: Record<string, unknown>
    }

    const rows = (await db('nivaro_fields')
      .where({ collection })
      .whereNotNull('dependency_config')
      .select('field', 'dependency_config')) as Array<{
      field: string
      dependency_config: string
    }>

    const updates: Record<string, unknown> = {}
    const option_filters: Record<string, unknown> = {}

    for (const row of rows) {
      const config = parseJsonSafe(row.dependency_config) as {
        depends_on?: string
        filter_by?: string
        clear_on_change?: boolean
        option_filter?: Record<string, unknown>
      } | null
      if (!config) continue
      if (config.depends_on !== changed_field && config.filter_by !== changed_field) continue

      if (config.clear_on_change) {
        updates[row.field] = null
      }

      if (config.option_filter) {
        const filterValue = values[changed_field]
        option_filters[row.field] = {
          ...config.option_filter,
          _parent_value: filterValue
        }
      }
    }

    return reply.send({ updates, option_filters })
  })
}
