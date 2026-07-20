import type { FastifyBaseLogger } from 'fastify'
import type { Knex } from 'knex'
import { getActualColumns } from './items.js'

// ─── Field rules — cascading auto-fill engine ─────────────────────────────────
//
// Shared resolution used by both the write path (applyFieldRules, on item
// create/update) and the read-only POST /field-rules/evaluate endpoint used
// by ItemEditForm for live cascades. See
// docs/superpowers/specs/2026-07-20-dynamic-field-rules-design.md.

export type Logger = Pick<FastifyBaseLogger, 'warn'>

// Mirrors the logger fallback idiom in transition-requirements.ts / review-list.ts —
// callers without a Fastify request logger fall back to console.
export const consoleLogger: Logger = {
  warn: ((...args: unknown[]) => {
    console.warn(...args)
  }) as unknown as Logger['warn']
}

export const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export const VALID_OPS = new Set(['eq', 'neq', 'null', 'nnull', 'in', 'contains'])
export const VALID_TARGET_TYPES = new Set(['set', 'clear', 'set_lookup', 'set_from_trigger'])
export const DYNAMIC_TARGET_TYPES = new Set(['set_lookup', 'set_from_trigger'])

// Cap on rows/ids resolved by a single dynamic rule — a rule is admin-authored
// but its result set size depends on live data.
const LOOKUP_CAP = 500

export interface FieldRuleRow {
  id: number
  collection: string
  trigger_field: string
  trigger_op: string
  trigger_value: string | null
  target_field: string
  target_type: string
  target_value: string | null
  only_when_empty: boolean | number
  dynamic_config: string | null
  sort: number
  is_active: boolean | number
}

// Emptiness for only_when_empty: null/undefined/''/empty-array are empty;
// 0 and false are NOT empty. Mirrors applyLayoutDefaults semantics.
export function isEmptyValue(v: unknown): boolean {
  if (v == null || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  return false
}

/** Pure trigger-condition matcher — identical semantics to the legacy inline evaluator. */
export function matchesTrigger(op: string, val: unknown, triggerValue: string | null): boolean {
  switch (op) {
    case 'eq':
      return String(val) === String(triggerValue ?? '')
    case 'neq':
      return String(val) !== String(triggerValue ?? '')
    case 'null':
      return val == null
    case 'nnull':
      return val != null
    case 'in': {
      let list: string[]
      try {
        const parsed = JSON.parse(triggerValue ?? '[]')
        list = Array.isArray(parsed) ? parsed.map(String) : []
      } catch {
        list = (triggerValue ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      }
      return list.includes(String(val))
    }
    case 'contains':
      return String(val).includes(String(triggerValue ?? ''))
    default:
      return false
  }
}

// ─── dynamic_config validation (POST/PATCH) ───────────────────────────────────

/**
 * Validate a rule's dynamic_config against its target_type. Returns an error
 * string naming the offending key, or null when valid. dynamic_config is
 * required (and shape-checked) for set_lookup/set_from_trigger, forbidden
 * (must be absent) for set/clear.
 */
export function validateDynamicConfig(targetType: string, dynamicConfig: unknown): string | null {
  if (!DYNAMIC_TARGET_TYPES.has(targetType)) {
    if (dynamicConfig != null)
      return `dynamic_config is not allowed for target_type "${targetType}"`
    return null
  }

  if (dynamicConfig == null) return `dynamic_config is required for target_type "${targetType}"`

  let cfg: Record<string, unknown>
  if (typeof dynamicConfig === 'string') {
    try {
      const parsed = JSON.parse(dynamicConfig)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return 'dynamic_config must be a JSON object'
      }
      cfg = parsed as Record<string, unknown>
    } catch {
      return 'dynamic_config must be valid JSON'
    }
  } else if (typeof dynamicConfig === 'object' && !Array.isArray(dynamicConfig)) {
    cfg = dynamicConfig as Record<string, unknown>
  } else {
    return 'dynamic_config must be an object'
  }

  if (targetType === 'set_lookup') {
    if (typeof cfg.collection !== 'string' || !IDENTIFIER_RE.test(cfg.collection)) {
      return 'dynamic_config.collection must be a valid identifier'
    }
    if (typeof cfg.filter_field !== 'string' || !IDENTIFIER_RE.test(cfg.filter_field)) {
      return 'dynamic_config.filter_field must be a valid identifier'
    }
    if (cfg.filter_op !== 'in' && cfg.filter_op !== 'eq') {
      return 'dynamic_config.filter_op must be "in" or "eq"'
    }
    if (typeof cfg.select !== 'string' || !IDENTIFIER_RE.test(cfg.select)) {
      return 'dynamic_config.select must be a valid identifier'
    }
    return null
  }

  // set_from_trigger
  if (typeof cfg.field !== 'string' || !IDENTIFIER_RE.test(cfg.field)) {
    return 'dynamic_config.field must be a valid identifier'
  }
  if (
    cfg.map !== undefined &&
    cfg.map !== null &&
    (typeof cfg.map !== 'string' || !IDENTIFIER_RE.test(cfg.map))
  ) {
    return 'dynamic_config.map must be a valid identifier'
  }
  return null
}

// ─── set_lookup ────────────────────────────────────────────────────────────────

interface SetLookupConfig {
  collection: string
  filter_field: string
  filter_op: 'in' | 'eq'
  select: string
}

function parseSetLookupConfig(raw: string | null): SetLookupConfig | null {
  if (!raw) return null
  try {
    const cfg = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof cfg.collection === 'string' &&
      IDENTIFIER_RE.test(cfg.collection) &&
      typeof cfg.filter_field === 'string' &&
      IDENTIFIER_RE.test(cfg.filter_field) &&
      (cfg.filter_op === 'in' || cfg.filter_op === 'eq') &&
      typeof cfg.select === 'string' &&
      IDENTIFIER_RE.test(cfg.select)
    ) {
      return cfg as unknown as SetLookupConfig
    }
    return null
  } catch {
    return null
  }
}

/**
 * Query the configured collection for rows matching the trigger's current
 * value (array → whereIn, scalar → where) and return the configured `select`
 * column's values. All identifiers come from the stored rule, never the
 * caller. Dead collection/column → undefined (rule skipped) + logger.warn.
 */
async function resolveSetLookup(
  database: Knex,
  rule: FieldRuleRow,
  triggerValue: unknown,
  logger: Logger
): Promise<unknown> {
  const cfg = parseSetLookupConfig(rule.dynamic_config)
  if (!cfg) {
    logger.warn(
      { ruleId: rule.id },
      'field-rules: set_lookup rule has invalid dynamic_config, skipping'
    )
    return undefined
  }
  if (isEmptyValue(triggerValue)) return undefined

  try {
    const q = database(cfg.collection).select(cfg.select).limit(LOOKUP_CAP)
    if (Array.isArray(triggerValue)) {
      q.whereIn(cfg.filter_field, triggerValue as Knex.Value[])
    } else {
      q.where(cfg.filter_field, triggerValue as Knex.Value)
    }
    const rows = (await q) as Record<string, unknown>[]
    return rows.map((r) => r[cfg.select])
  } catch (err) {
    logger.warn(
      { ruleId: rule.id, err },
      'field-rules: set_lookup query failed (dead collection/column), skipping'
    )
    return undefined
  }
}

// ─── set_from_trigger ──────────────────────────────────────────────────────────

interface SetFromTriggerConfig {
  field: string
  map?: string
}

function parseSetFromTriggerConfig(raw: string | null): SetFromTriggerConfig | null {
  if (!raw) return null
  try {
    const cfg = JSON.parse(raw) as Record<string, unknown>
    if (typeof cfg.field !== 'string' || !IDENTIFIER_RE.test(cfg.field)) return null
    if (cfg.map !== undefined && cfg.map !== null) {
      if (typeof cfg.map !== 'string' || !IDENTIFIER_RE.test(cfg.map)) return null
      return { field: cfg.field, map: cfg.map }
    }
    return { field: cfg.field }
  } catch {
    return null
  }
}

/**
 * Load the trigger field's selected related record (via the M2O relation for
 * `triggerField` on `collection`) and read the configured field: a plain
 * column on the related record, or an O2M/M2M alias — resolved through
 * nivaro_relations — whose values are taken directly (O2M) or via the
 * configured `map` column on the junction rows (M2M). Cap 500. Dead
 * collection/column → undefined (rule skipped) + logger.warn.
 */
async function resolveSetFromTrigger(
  database: Knex,
  collection: string,
  triggerField: string,
  triggerValue: unknown,
  rule: FieldRuleRow,
  logger: Logger
): Promise<unknown> {
  const cfg = parseSetFromTriggerConfig(rule.dynamic_config)
  if (!cfg) {
    logger.warn(
      { ruleId: rule.id },
      'field-rules: set_from_trigger rule has invalid dynamic_config, skipping'
    )
    return undefined
  }
  if (isEmptyValue(triggerValue)) return undefined
  const fkId = Array.isArray(triggerValue) ? triggerValue[0] : triggerValue

  try {
    const triggerRel = (await database('nivaro_relations')
      .where({ many_collection: collection, many_field: triggerField })
      .whereNull('junction_field')
      .first()) as { one_collection: string } | undefined
    if (!triggerRel?.one_collection) {
      logger.warn(
        { ruleId: rule.id, triggerField },
        'field-rules: set_from_trigger trigger field has no M2O relation, skipping'
      )
      return undefined
    }
    const oneCollection = triggerRel.one_collection

    // Only project cfg.field when it's a real column — for an O2M/M2M alias
    // it isn't one, and selecting it would error, so the existence check
    // must run before the projected fetch, not after.
    const oneColumns = await getActualColumns(oneCollection)
    const isPlainColumn = oneColumns.has(cfg.field)
    const record = (await database(oneCollection)
      .where({ id: fkId })
      .select(isPlainColumn ? ['id', cfg.field] : ['id'])
      .first()) as Record<string, unknown> | undefined
    if (!record) return undefined

    // Plain column on the related record.
    if (isPlainColumn) {
      return record[cfg.field] ?? undefined
    }

    // O2M/M2M alias on the related collection.
    const aliasRel = (await database('nivaro_relations')
      .where({ one_collection: oneCollection, one_field: cfg.field })
      .first()) as
      | { many_collection: string; many_field: string; junction_field: string | null }
      | undefined
    if (!aliasRel) {
      logger.warn(
        { ruleId: rule.id, field: cfg.field, oneCollection },
        'field-rules: set_from_trigger field is not a column or known relation alias, skipping'
      )
      return undefined
    }

    if (aliasRel.junction_field) {
      // M2M — values come from the configured `map` column on junction rows.
      if (!cfg.map) {
        logger.warn(
          { ruleId: rule.id, field: cfg.field },
          'field-rules: set_from_trigger M2M alias requires "map", skipping'
        )
        return undefined
      }
      const junctionColumns = await getActualColumns(aliasRel.many_collection)
      if (!junctionColumns.has(cfg.map)) {
        logger.warn(
          { ruleId: rule.id, map: cfg.map, junction: aliasRel.many_collection },
          'field-rules: set_from_trigger map column not found, skipping'
        )
        return undefined
      }
      const rows = (await database(aliasRel.many_collection)
        .where({ [aliasRel.many_field]: fkId })
        .select(cfg.map)
        .limit(LOOKUP_CAP)) as Record<string, unknown>[]
      return rows.map((r) => r[cfg.map as string])
    }

    // O2M (no junction) — read the configured column (default 'id') straight off the child rows.
    const col = cfg.map ?? 'id'
    const manyColumns = await getActualColumns(aliasRel.many_collection)
    if (!manyColumns.has(col)) {
      logger.warn(
        { ruleId: rule.id, map: col, collection: aliasRel.many_collection },
        'field-rules: set_from_trigger map column not found, skipping'
      )
      return undefined
    }
    const rows = (await database(aliasRel.many_collection)
      .where({ [aliasRel.many_field]: fkId })
      .select(col)
      .limit(LOOKUP_CAP)) as Record<string, unknown>[]
    return rows.map((r) => r[col])
  } catch (err) {
    logger.warn(
      { ruleId: rule.id, err },
      'field-rules: set_from_trigger query failed (dead collection/column), skipping'
    )
    return undefined
  }
}

// ─── Shared resolution entry point ─────────────────────────────────────────────

/**
 * Evaluate all active rules for (collection, triggerField) against
 * `triggerValue`, honoring only_when_empty against `draft`'s current values
 * (including any updates already resolved earlier in this same pass), and
 * return the target-field updates that fired. Used by both applyFieldRules
 * (write path) and POST /field-rules/evaluate (live client cascades).
 */
export async function evaluateRulesForTrigger(
  database: Knex,
  collection: string,
  triggerField: string,
  triggerValue: unknown,
  draft: Record<string, unknown>,
  logger: Logger = consoleLogger
): Promise<Record<string, unknown>> {
  let rules: FieldRuleRow[]
  try {
    rules = (await database('nivaro_field_rules')
      .where({ collection, trigger_field: triggerField, is_active: true })
      .orderBy('sort')
      .select('*')) as FieldRuleRow[]
  } catch {
    // Table may not exist yet before migration runs — non-fatal.
    return {}
  }

  const updates: Record<string, unknown> = {}
  for (const rule of rules) {
    if (!matchesTrigger(rule.trigger_op, triggerValue, rule.trigger_value)) continue

    const onlyWhenEmpty = rule.only_when_empty === true || rule.only_when_empty === 1
    if (onlyWhenEmpty) {
      const current =
        rule.target_field in updates ? updates[rule.target_field] : draft[rule.target_field]
      if (!isEmptyValue(current)) continue
    }

    if (rule.target_type === 'clear') {
      updates[rule.target_field] = null
    } else if (rule.target_type === 'set') {
      if (rule.target_value !== null) updates[rule.target_field] = rule.target_value
    } else if (rule.target_type === 'set_lookup') {
      const resolved = await resolveSetLookup(database, rule, triggerValue, logger)
      if (resolved !== undefined) updates[rule.target_field] = resolved
    } else if (rule.target_type === 'set_from_trigger') {
      const resolved = await resolveSetFromTrigger(
        database,
        collection,
        triggerField,
        triggerValue,
        rule,
        logger
      )
      if (resolved !== undefined) updates[rule.target_field] = resolved
    }
  }
  return updates
}
