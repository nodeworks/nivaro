import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { can } from '../services/permissions.js'

const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'null', 'nnull'] as const
type Op = (typeof OPS)[number]

const EVALUATE_CAP = 500
const SUMMARY_SCAN_CAP = 1000

interface AtRiskCondition {
  field: string
  op: Op
  value?: unknown
}

interface AtRiskRuleRow {
  id: number
  collection: string
  name: string
  conditions: string // JSON text
  highlight_color: 'red' | 'amber' | null
  is_active: boolean | number
  created_by: string
  created_at: Date
}

// Cross-field reference: "{{other_field}}" optionally followed by "* <num>" or "+ <num>"
// e.g. "{{budget}} * 0.9" or "{{baseline}} + 10"
const FIELD_REF_RE = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}(?:\s*([*+])\s*(-?\d+(?:\.\d+)?))?$/

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function parseConditions(raw: unknown): AtRiskCondition[] | null {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  return parsed as AtRiskCondition[]
}

/** Validate a conditions payload. Returns an error string, or null when valid. */
function validateConditions(raw: unknown): string | null {
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'conditions must be a non-empty array of {field, op, value}'
  }
  for (const c of raw as AtRiskCondition[]) {
    if (c === null || typeof c !== 'object') return 'each condition must be an object'
    if (typeof c.field !== 'string' || !IDENTIFIER_RE.test(c.field)) {
      return `invalid condition field: ${String(c.field)}`
    }
    if (!(OPS as readonly string[]).includes(c.op)) {
      return `invalid condition op: ${String(c.op)} (allowed: ${OPS.join(', ')})`
    }
    if (c.op !== 'null' && c.op !== 'nnull') {
      if (c.value === undefined || c.value === null || c.value === '') {
        return `condition on "${c.field}" with op "${c.op}" requires a value`
      }
      if (typeof c.value === 'string') {
        const trimmed = c.value.trim()
        // If it looks like a field reference, it must parse fully
        if (trimmed.startsWith('{{') && !FIELD_REF_RE.test(trimmed)) {
          return `invalid field reference in value: "${c.value}" — expected {{field}} optionally followed by * <num> or + <num>`
        }
      }
    }
  }
  return null
}

/** All column names a set of conditions reads (condition fields + {{refs}} in values). */
function referencedFields(conditions: AtRiskCondition[]): string[] {
  const fields = new Set<string>()
  for (const c of conditions) {
    if (typeof c.field === 'string' && IDENTIFIER_RE.test(c.field)) fields.add(c.field)
    if (typeof c.value === 'string') {
      const m = FIELD_REF_RE.exec(c.value.trim())
      if (m) fields.add(m[1])
    }
  }
  return [...fields]
}

const NO_VALUE = Symbol('no-value')

/** Resolve a condition value against a row — substitutes {{field}} refs (+ scale/offset). */
function resolveValue(value: unknown, row: Record<string, unknown>): unknown {
  if (typeof value !== 'string') return value
  const m = FIELD_REF_RE.exec(value.trim())
  if (!m) return value
  const base = row[m[1]]
  if (!m[2]) return base
  const num = toNumber(base)
  if (num === null) return NO_VALUE
  const operand = parseFloat(m[3])
  return m[2] === '*' ? num * operand : num + operand
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isNaN(n) ? null : n
  }
  return null
}

function toComparable(v: unknown): number | null {
  const n = toNumber(v)
  if (n !== null) return n
  // fall back to date parsing for ISO strings etc.
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

function evalCondition(row: Record<string, unknown>, cond: AtRiskCondition): boolean {
  const actual = row[cond.field]

  if (cond.op === 'null') return actual === null || actual === undefined
  if (cond.op === 'nnull') return actual !== null && actual !== undefined

  const expected = resolveValue(cond.value, row)
  if (expected === NO_VALUE) return false

  switch (cond.op) {
    case 'eq':
    case 'neq': {
      let equal: boolean
      const aNum = toNumber(actual)
      const eNum = toNumber(expected)
      if (aNum !== null && eNum !== null) {
        equal = aNum === eNum
      } else if (actual === null || actual === undefined || expected === null) {
        equal = (actual ?? null) === (expected ?? null)
      } else {
        equal = String(actual) === String(expected)
      }
      return cond.op === 'eq' ? equal : !equal
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toComparable(actual)
      const e = toComparable(expected)
      if (a === null || e === null) return false
      if (cond.op === 'gt') return a > e
      if (cond.op === 'gte') return a >= e
      if (cond.op === 'lt') return a < e
      return a <= e
    }
    case 'contains': {
      if (actual === null || actual === undefined) return false
      return String(actual).toLowerCase().includes(String(expected).toLowerCase())
    }
    default:
      return false
  }
}

/** A rule matches when ALL of its conditions hold (AND). */
function ruleMatches(row: Record<string, unknown>, conditions: AtRiskCondition[]): boolean {
  return conditions.every((c) => evalCondition(row, c))
}

function formatRule(row: AtRiskRuleRow) {
  return {
    ...row,
    conditions: parseConditions(row.conditions) ?? [],
    highlight_color: row.highlight_color ?? 'red',
    is_active: !!row.is_active
  }
}

interface ParsedRule {
  id: number
  name: string
  color: 'red' | 'amber'
  conditions: AtRiskCondition[]
}

function parseActiveRules(rows: AtRiskRuleRow[]): ParsedRule[] {
  const rules: ParsedRule[] = []
  for (const row of rows) {
    const conditions = parseConditions(row.conditions)
    if (!conditions) continue
    rules.push({
      id: row.id,
      name: row.name,
      color: row.highlight_color === 'amber' ? 'amber' : 'red',
      conditions
    })
  }
  return rules
}

/** Evaluate rows against rules — returns map of id → first matching rule result. */
function evaluateRows(
  rows: Record<string, unknown>[],
  rules: ParsedRule[]
): Record<string, { at_risk: true; rule: string; color: 'red' | 'amber' }> {
  const result: Record<string, { at_risk: true; rule: string; color: 'red' | 'amber' }> = {}
  for (const row of rows) {
    const id = row.id
    if (id === null || id === undefined) continue
    for (const rule of rules) {
      if (ruleMatches(row, rule.conditions)) {
        result[String(id)] = { at_risk: true, rule: rule.name, color: rule.color }
        break // ANY rule matching flags the row; first match wins for display
      }
    }
  }
  return result
}

export async function atRiskRoutes(app: FastifyInstance) {
  // ─── Admin CRUD ─────────────────────────────────────────────────────────────

  // GET /at-risk/rules?collection= — list rules (admin)
  app.get('/rules', { preHandler: requireAdmin }, async (req, reply) => {
    const { collection } = req.query as { collection?: string }

    let query = db<AtRiskRuleRow>('nivaro_at_risk_rules').orderBy('id')
    if (collection) query = query.where({ collection })

    const rows = await query
    return reply.send({ data: rows.map(formatRule) })
  })

  // POST /at-risk/rules — create rule (admin)
  app.post('/rules', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body as {
      collection?: string
      name?: string
      conditions?: unknown
      highlight_color?: string | null
      is_active?: boolean
    }

    if (!body.collection || !body.name) {
      return reply.code(400).send({ error: 'collection and name are required' })
    }
    if (body.collection.startsWith('nivaro_')) {
      return reply.code(400).send({ error: 'System collections cannot have at-risk rules' })
    }
    const condErr = validateConditions(body.conditions)
    if (condErr) return reply.code(400).send({ error: condErr })
    if (
      body.highlight_color !== undefined &&
      body.highlight_color !== null &&
      body.highlight_color !== 'red' &&
      body.highlight_color !== 'amber'
    ) {
      return reply.code(400).send({ error: 'highlight_color must be "red", "amber", or null' })
    }

    const [row] = await db('nivaro_at_risk_rules')
      .insert({
        collection: body.collection,
        name: body.name,
        conditions: JSON.stringify(body.conditions),
        highlight_color: body.highlight_color ?? null,
        is_active: body.is_active !== false ? 1 : 0,
        created_by: req.user!.id,
        created_at: new Date()
      })
      .returning('id')

    const insertedId = typeof row === 'object' ? (row as { id: number }).id : row
    const created = await db<AtRiskRuleRow>('nivaro_at_risk_rules')
      .where({ id: insertedId })
      .first()

    await logActivity({
      action: 'create',
      user: req.user?.id,
      collection: 'nivaro_at_risk_rules',
      item: String(insertedId),
      req
    })

    return reply.code(201).send({ data: formatRule(created!) })
  })

  // PATCH /at-risk/rules/:id — update rule (admin)
  app.patch('/rules/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db<AtRiskRuleRow>('nivaro_at_risk_rules').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body as Partial<{
      collection: string
      name: string
      conditions: unknown
      highlight_color: string | null
      is_active: boolean
    }>

    const patch: Record<string, unknown> = {}
    if (body.collection !== undefined) {
      if (!body.collection || body.collection.startsWith('nivaro_')) {
        return reply.code(400).send({ error: 'Invalid collection' })
      }
      patch.collection = body.collection
    }
    if (body.name !== undefined) {
      if (!body.name) return reply.code(400).send({ error: 'name cannot be empty' })
      patch.name = body.name
    }
    if (body.conditions !== undefined) {
      const condErr = validateConditions(body.conditions)
      if (condErr) return reply.code(400).send({ error: condErr })
      patch.conditions = JSON.stringify(body.conditions)
    }
    if ('highlight_color' in body) {
      if (
        body.highlight_color !== null &&
        body.highlight_color !== 'red' &&
        body.highlight_color !== 'amber'
      ) {
        return reply.code(400).send({ error: 'highlight_color must be "red", "amber", or null' })
      }
      patch.highlight_color = body.highlight_color
    }
    if (body.is_active !== undefined) patch.is_active = body.is_active ? 1 : 0

    if (Object.keys(patch).length > 0) {
      await db('nivaro_at_risk_rules').where({ id }).update(patch)
    }
    const updated = await db<AtRiskRuleRow>('nivaro_at_risk_rules').where({ id }).first()

    await logActivity({
      action: 'update',
      user: req.user?.id,
      collection: 'nivaro_at_risk_rules',
      item: id,
      req
    })

    return reply.send({ data: formatRule(updated!) })
  })

  // DELETE /at-risk/rules/:id — delete rule (admin)
  app.delete('/rules/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await db<AtRiskRuleRow>('nivaro_at_risk_rules').where({ id }).first()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    await db('nivaro_at_risk_rules').where({ id }).delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_at_risk_rules',
      item: id,
      req
    })

    return reply.code(204).send()
  })

  // ─── Read endpoints (authenticated, non-admin) ──────────────────────────────

  // GET /at-risk/rules/active?collection= — active rules for a collection,
  // readable by any user who can read the collection (browser highlight needs this)
  app.get('/rules/active', { preHandler: requireAuth }, async (req, reply) => {
    const { collection } = req.query as { collection?: string }
    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    if (collection.startsWith('nivaro_')) return reply.send({ data: [] })

    const allowed = await can(req.user!, 'read', collection)
    if (!allowed) return reply.code(403).send({ error: 'Forbidden' })

    const rows = await db<AtRiskRuleRow>('nivaro_at_risk_rules')
      .where({ collection, is_active: true })
      .orderBy('id')
    return reply.send({ data: rows.map(formatRule) })
  })

  // POST /at-risk/evaluate — {collection, ids[]} → {data: {[id]: {at_risk, rule, color}}}
  app.post('/evaluate', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { collection?: string; ids?: unknown }

    if (!body.collection || !Array.isArray(body.ids)) {
      return reply.code(400).send({ error: 'collection and ids[] are required' })
    }
    if (body.collection.startsWith('nivaro_')) {
      return reply.code(400).send({ error: 'System collections cannot be evaluated' })
    }

    const allowed = await can(req.user!, 'read', body.collection)
    if (!allowed) return reply.code(403).send({ error: 'Forbidden' })

    const ids = body.ids
      .slice(0, EVALUATE_CAP)
      .map((v) => String(v))
      .filter(Boolean)
    if (ids.length === 0) return reply.send({ data: {} })

    const ruleRows = await db<AtRiskRuleRow>('nivaro_at_risk_rules')
      .where({ collection: body.collection, is_active: true })
      .orderBy('id')
    const rules = parseActiveRules(ruleRows)
    if (rules.length === 0) return reply.send({ data: {} }) // fast path — no rules

    const fields = new Set<string>(['id'])
    for (const rule of rules) {
      for (const f of referencedFields(rule.conditions)) fields.add(f)
    }

    let rows: Record<string, unknown>[]
    try {
      rows = (await db(body.collection)
        .whereIn('id', ids)
        .select([...fields])) as Record<string, unknown>[]
    } catch {
      return reply.code(400).send({ error: 'Failed to query collection — check rule field names' })
    }

    return reply.send({ data: evaluateRows(rows, rules) })
  })

  // GET /at-risk/summary — per-collection at-risk counts across all active rules
  app.get('/summary', { preHandler: requireAuth }, async (req, reply) => {
    const ruleRows = await db<AtRiskRuleRow>('nivaro_at_risk_rules')
      .where({ is_active: true })
      .orderBy('id')

    const byCollection = new Map<string, AtRiskRuleRow[]>()
    for (const row of ruleRows) {
      if (row.collection.startsWith('nivaro_')) continue
      const list = byCollection.get(row.collection) ?? []
      list.push(row)
      byCollection.set(row.collection, list)
    }

    const summary: { collection: string; at_risk_count: number; scanned: number }[] = []

    for (const [collection, collectionRules] of byCollection) {
      const allowed = await can(req.user!, 'read', collection)
      if (!allowed) continue

      const rules = parseActiveRules(collectionRules)
      if (rules.length === 0) continue

      const fields = new Set<string>(['id'])
      for (const rule of rules) {
        for (const f of referencedFields(rule.conditions)) fields.add(f)
      }

      let rows: Record<string, unknown>[]
      try {
        rows = (await db(collection)
          .select([...fields])
          .orderBy('id')
          .limit(SUMMARY_SCAN_CAP)) as Record<string, unknown>[]
      } catch {
        continue // stale rule referencing dropped column/table — skip
      }

      const flagged = evaluateRows(rows, rules)
      summary.push({
        collection,
        at_risk_count: Object.keys(flagged).length,
        scanned: rows.length
      })
    }

    return reply.send({ data: summary })
  })
}
