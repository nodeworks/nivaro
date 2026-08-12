import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import type { HookContext } from './registry.js'
import { hooks } from './registry.js'

// Store app reference for logging after startup (mirrors hooks/field-watches.ts).
let _app: FastifyInstance | null = null

export function setApp(app: FastifyInstance) {
  _app = app
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type CrossTriggerOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'null'
  | 'nnull'

export interface CrossTriggerCondition {
  field: string
  op: CrossTriggerOp
  value?: unknown
}

/**
 * Storage contract: nivaro_rules rows where the `actions` JSON column contains
 * (an object, or an array containing) an action of shape:
 *   { type: 'cross_collection', target_collection, operation: 'create' | 'update',
 *     field_map: { targetField: 'template {{source_field}}' }, match_field? }
 * `collection` = source collection, `trigger` = 'create' | 'update' | 'delete',
 * `conditions` = CrossTriggerCondition[] (AND semantics), `enabled` = active flag.
 */
export interface ExecProcedureAction {
  type: 'exec_procedure'
  /** Stored procedure name — plain identifier, no schema prefix. */
  procedure: string
  /** Named args: @key = rendered template value. Omitted/empty-rendered args are skipped. */
  args?: Record<string, string>
}

export interface CrossTriggerAction {
  type: 'cross_collection'
  target_collection: string
  operation: 'create' | 'update'
  field_map: Record<string, string>
  match_field?: string
  // Multi-field match for updates: { targetColumn: 'template {{source_field}}' }.
  // All must match (AND). Wins over match_field when present.
  match_map?: Record<string, string>
}

interface RuleRow {
  id: number
  name: string
  collection: string
  trigger: string
  conditions: string | null
  actions: string | null
  enabled: boolean
}

interface ParsedRule {
  id: number
  name: string
  trigger: string
  conditions: CrossTriggerCondition[]
  actions: Array<CrossTriggerAction | ExecProcedureAction>
}

// ─── Rule cache (60s per source collection) ──────────────────────────────────

const CACHE_TTL_MS = 60_000
const ruleCache = new Map<string, { rules: ParsedRule[]; ts: number }>()

export function invalidateCrossTriggerCache() {
  ruleCache.clear()
}

function parseJson<T = unknown>(val: string | null | undefined): T | null {
  if (val == null) return null
  if (typeof val !== 'string') return val as T
  try {
    return JSON.parse(val) as T
  } catch {
    return null
  }
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function extractCrossActions(raw: string | null): Array<CrossTriggerAction | ExecProcedureAction> {
  const parsed = parseJson<unknown>(raw)
  if (!parsed) return []
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.filter((a): a is CrossTriggerAction | ExecProcedureAction => {
    if (!a || typeof a !== 'object') return false
    const t = (a as { type?: string }).type
    if (t === 'cross_collection') {
      return (
        typeof (a as { target_collection?: unknown }).target_collection === 'string' &&
        !!(a as { field_map?: unknown }).field_map
      )
    }
    if (t === 'exec_procedure') {
      const proc = (a as { procedure?: unknown }).procedure
      return typeof proc === 'string' && IDENT_RE.test(proc)
    }
    return false
  })
}

async function getRules(collection: string): Promise<ParsedRule[]> {
  const cached = ruleCache.get(collection)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.rules

  const rows = (await db('nivaro_rules')
    .where({ collection, enabled: true })
    .select('*')) as RuleRow[]

  const rules: ParsedRule[] = []
  for (const row of rows) {
    const actions = extractCrossActions(row.actions)
    if (actions.length === 0) continue
    const conditions = parseJson<CrossTriggerCondition[]>(row.conditions) ?? []
    rules.push({
      id: row.id,
      name: row.name,
      trigger: row.trigger,
      conditions: Array.isArray(conditions) ? conditions : [],
      actions
    })
  }

  ruleCache.set(collection, { rules, ts: Date.now() })
  return rules
}

// ─── Condition evaluation (AND semantics) ─────────────────────────────────────

function evaluateConditions(
  conditions: CrossTriggerCondition[],
  data: Record<string, unknown>
): boolean {
  for (const c of conditions) {
    if (!c?.field || !c.op) return false
    const actual = data[c.field]
    const expected = c.value
    let ok: boolean
    switch (c.op) {
      case 'eq':
        ok = String(actual ?? '') === String(expected ?? '')
        break
      case 'neq':
        ok = String(actual ?? '') !== String(expected ?? '')
        break
      case 'gt':
        ok = Number(actual) > Number(expected)
        break
      case 'gte':
        ok = Number(actual) >= Number(expected)
        break
      case 'lt':
        ok = Number(actual) < Number(expected)
        break
      case 'lte':
        ok = Number(actual) <= Number(expected)
        break
      case 'contains':
        ok = String(actual ?? '')
          .toLowerCase()
          .includes(String(expected ?? '').toLowerCase())
        break
      case 'null':
        ok = actual === null || actual === undefined || actual === ''
        break
      case 'nnull':
        ok = actual !== null && actual !== undefined && actual !== ''
        break
      default:
        ok = false
    }
    if (!ok) return false
  }
  return true
}

// ─── Template substitution: "Ticket {{title}}" → "Ticket Foo" ────────────────

function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, field: string) => {
    const val = data[field]
    if (val === null || val === undefined) return ''
    if (val instanceof Date) return val.toISOString()
    if (typeof val === 'object') return JSON.stringify(val)
    return String(val)
  })
}

// ─── Recursion guard ──────────────────────────────────────────────────────────

const MAX_DEPTH = 3
const inFlight = new Set<string>()

// ─── Core processing ──────────────────────────────────────────────────────────

function logError(err: unknown, context: Record<string, unknown>) {
  if (_app) _app.log.error({ err, ...context }, 'Cross-collection trigger failed')
  else console.error({ err, ...context }, 'Cross-collection trigger failed')
}

async function processCrossTriggers(ctx: HookContext) {
  const { collection, action } = ctx
  if (collection.startsWith('nivaro_')) return

  const rules = (await getRules(collection)).filter((r) => r.trigger === action)
  if (rules.length === 0) return

  // Source data: for deletes use the captured previous row; otherwise the result row.
  const data = (
    action === 'delete'
      ? ctx.previousData
      : ((ctx.result as Record<string, unknown> | undefined) ?? ctx.previousData ?? ctx.payload)
  ) as Record<string, unknown> | undefined
  if (!data) return

  const key = `${collection}:${String(ctx.keys?.[0] ?? '')}`
  if (inFlight.has(key)) return // already processing this record — break cycles
  if (inFlight.size >= MAX_DEPTH) return // chain depth limit
  inFlight.add(key)

  try {
    for (const rule of rules) {
      try {
        if (!evaluateConditions(rule.conditions, data)) continue

        for (const act of rule.actions) {
          if (act.type === 'exec_procedure') {
            // EXEC <proc> @k1 = ?, @k2 = ? — proc + arg names identifier-checked,
            // values rendered from the source row then bound as parameters.
            try {
              const argEntries = Object.entries(act.args ?? {}).filter(([k]) => IDENT_RE.test(k))
              const binds: string[] = []
              const parts: string[] = []
              for (const [k, tpl] of argEntries) {
                const rendered = renderTemplate(String(tpl), data)
                if (rendered === '') continue
                parts.push(`@${k} = ?`)
                binds.push(rendered)
              }
              await db.raw(`EXEC ${act.procedure} ${parts.join(', ')}`, binds)
            } catch (err) {
              logError(err, { rule: rule.id, procedure: act.procedure })
            }
            continue
          }

          const target = act.target_collection
          if (!target || target.startsWith('nivaro_')) {
            logError(new Error('Target collection not allowed'), { rule: rule.id, target })
            continue
          }

          const record: Record<string, unknown> = {}
          for (const [targetField, template] of Object.entries(act.field_map ?? {})) {
            record[targetField] = renderTemplate(String(template), data)
          }
          if (Object.keys(record).length === 0) continue

          if (act.operation === 'update') {
            const where: Record<string, unknown> = {}
            if (act.match_map && Object.keys(act.match_map).length > 0) {
              for (const [col, template] of Object.entries(act.match_map)) {
                where[col] = renderTemplate(String(template), data)
              }
            } else if (act.match_field && record[act.match_field] !== undefined) {
              where[act.match_field] = record[act.match_field]
            }
            if (Object.keys(where).length === 0) {
              logError(new Error('match_field/match_map missing for update operation'), {
                rule: rule.id
              })
              continue
            }
            const patch = { ...record }
            for (const col of Object.keys(where)) delete patch[col]
            if (Object.keys(patch).length === 0) continue
            await db(target).where(where).update(patch)
          } else {
            await db(target).insert(record)
          }
        }
      } catch (err) {
        logError(err, { rule: rule.id, collection, action })
      }
    }
  } finally {
    inFlight.delete(key)
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerCrossTriggerHooks() {
  for (const action of ['create', 'update', 'delete'] as const) {
    hooks.after('*', action, (ctx) => {
      // Fire-and-forget — never block or fail the originating mutation.
      processCrossTriggers(ctx).catch((err) =>
        logError(err, { collection: ctx.collection, action: ctx.action })
      )
    })
  }
}
