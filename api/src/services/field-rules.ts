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

/**
 * Column types that cannot hold a list. A dynamic rule resolves to an ARRAY
 * because that is right for an M2M/O2M target (divisions → regions), but the
 * same machinery also fills scalar columns (billing_location → org_code, an
 * int) — and handing knex `[14]` for an int column fails the INSERT outright:
 * "Conversion failed when converting the nvarchar value '[14]' to data type
 * int", which surfaces as a 500 on save with nothing pointing at the rule.
 *
 * Text/JSON columns are deliberately absent: a physical nvarchar column CAN
 * legitimately store a JSON array (repeater fields do), so narrowing there
 * would corrupt real values.
 */
const ARRAY_HOSTILE_TYPES = new Set([
  'int',
  'bigint',
  'smallint',
  'tinyint',
  'decimal',
  'numeric',
  'float',
  'real',
  'money',
  'smallmoney',
  'bit',
  'date',
  'datetime',
  'datetime2',
  'smalldatetime',
  'time',
  'uniqueidentifier'
])

/**
 * Narrow a resolved list to a single value when the target column cannot hold
 * a list. More than one match means the lookup was ambiguous — take the first,
 * which is what a "default this field from that one" rule means, and say so.
 */
async function scalarizeForColumn(
  database: Knex,
  collection: string,
  field: string,
  value: unknown,
  logger: Logger
): Promise<unknown> {
  if (!Array.isArray(value)) return value
  let type: string | undefined
  try {
    const row = (await database('information_schema.columns')
      .where({ table_name: collection, column_name: field })
      .first('data_type')) as { data_type?: string } | undefined
    type = row?.data_type?.toLowerCase()
  } catch {
    return value
  }
  // No physical column = an alias target (M2M/O2M); the array is the answer.
  if (!type || !ARRAY_HOSTILE_TYPES.has(type)) return value
  if (value.length === 0) return null
  if (value.length > 1) {
    logger.warn(
      { collection, field, matches: value.length },
      'field-rules: lookup matched several rows for a single-value column — using the first'
    )
  }
  return value[0]
}

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
      if (resolved !== undefined)
        updates[rule.target_field] = await scalarizeForColumn(
          database,
          collection,
          rule.target_field,
          resolved,
          logger
        )
    } else if (rule.target_type === 'set_from_trigger') {
      const resolved = await resolveSetFromTrigger(
        database,
        collection,
        triggerField,
        triggerValue,
        rule,
        logger
      )
      if (resolved !== undefined)
        updates[rule.target_field] = await scalarizeForColumn(
          database,
          collection,
          rule.target_field,
          resolved,
          logger
        )
    }
  }
  return updates
}

// ─── Layout row rules (grid autofill) ─────────────────────────────────────────
//
// The per-row autofill rules configured on an inline-grid layout assignment
// (`options.row_rules` — oracle category from the picked CIFA, task via the
// project-type-filtered cifa_tasks/category_tasks precedence chain, line_type
// from the parent's workflow_type, …). This logic lived inline in
// POST /field-rules/evaluate, which meant it ONLY ran when a browser asked:
// a child row created straight through the items API got none of it. It is a
// service now so createOne can run the same rules with the same semantics —
// one evaluator, two callers, no drift.

export interface RowRuleSource {
  source_type: string
  source_field: string
  source_related_field: string
  source_hop?: string
  o2m_collection?: string
  filter_field?: string
  filter_value?: string
  source_one_collection?: string
}

export interface RowRule {
  trigger_field?: string | null
  trigger_fields?: string[] | null
  trigger_related_field?: string | null
  trigger_op?: string
  trigger_value?: string | null
  target_field: string
  /** 'lock' = when triggered, target_field is read-only for this row (the
   *  grid shows it as display-only and the items service drops caller
   *  writes to it). Evaluated on every pass regardless of changedField. */
  target_type: 'set' | 'clear' | 'relation_field' | 'precedence' | 'pick' | 'lock'
  target_value?: string | null
  sources?: RowRuleSource[]
  only_if_empty?: boolean
  sort?: number
}

/**
 * Evaluate a set of layout row rules against a child-row draft. Mutates and
 * returns `working`. `$parent.<field>` trigger fields and value templates
 * resolve from `parentContext`. `changedField`, when set, restricts rules to
 * those triggered by that field (the live-edit path); the create path leaves
 * it unset so every rule gets its chance.
 */
export interface RowRuleEvalOptions {
  /** Collects the target fields of triggered 'lock' rules. */
  locks?: Set<string>
  /** Evaluate ONLY lock rules — used when a row editor opens, so 'set' rules
   *  don't re-fire over values the user already has. */
  locksOnly?: boolean
}

export async function evaluateRowRules(
  database: Knex,
  collection: string,
  working: Record<string, unknown>,
  parentContext: Record<string, unknown>,
  rowRules: RowRule[],
  changedField?: string,
  evalOpts?: RowRuleEvalOptions
): Promise<Record<string, unknown>> {
  const subParent = (s: string | null | undefined): string | null => {
    if (s == null) return null
    return s.replace(/\$parent\.(\w+)/g, (_, f) => {
      const v = parentContext[f]
      return v != null ? String(v) : ''
    })
  }

  const sorted = [...rowRules].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  for (const rule of sorted) {
    const isLock = rule.target_type === 'lock'
    if (evalOpts?.locksOnly && !isLock) continue
    const triggerField = rule.trigger_field ?? null
    const isParentTrigger = !!triggerField && triggerField.startsWith('$parent.')
    const extraTriggerFields = Array.isArray(rule.trigger_fields)
      ? rule.trigger_fields.filter(Boolean)
      : []
    const allTriggerFields = triggerField
      ? [triggerField, ...extraTriggerFields]
      : extraTriggerFields

    if (!isParentTrigger) {
      // Lock rules re-evaluate on EVERY pass — a lock follows the row's current
      // state, not only the keystroke that changed its trigger.
      if (!isLock && changedField && allTriggerFields.length > 0 && !allTriggerFields.includes(changedField))
        continue
      if (triggerField && !(triggerField in working)) continue
    }

    let val: unknown
    if (isParentTrigger) {
      const parentKey = (triggerField as string).slice(8)
      val = parentContext[parentKey] ?? null
    } else {
      const activeField =
        changedField && allTriggerFields.includes(changedField) ? changedField : triggerField
      val = activeField ? working[activeField] : null
    }

    // trigger_related_field: resolve the M2O related record and compare that
    // field instead; dot-paths hop, __id__/__entity__ compare the last FK id.
    if (rule.trigger_related_field && triggerField && val != null) {
      try {
        const trigRel = (await database('nivaro_relations')
          .where({ many_collection: collection, many_field: triggerField })
          .whereNull('junction_field')
          .first()) as { one_collection: string } | undefined
        if (trigRel?.one_collection) {
          let currentRecord = (await database(trigRel.one_collection)
            .where({ id: String(val) })
            .first()) as Record<string, unknown> | undefined
          let currentCollection = trigRel.one_collection
          let lastFkId: string | null = String(val)
          const parts = rule.trigger_related_field.split('.')
          for (let i = 0; i < parts.length - 1; i++) {
            const hop = parts[i]
            const fkId = currentRecord?.[hop]
            if (fkId == null) {
              currentRecord = undefined
              lastFkId = null
              break
            }
            lastFkId = String(fkId)
            const hopRel = (await database('nivaro_relations')
              .where({ many_collection: currentCollection, many_field: hop })
              .whereNull('junction_field')
              .first()) as { one_collection: string } | undefined
            if (!hopRel?.one_collection) {
              currentRecord = undefined
              lastFkId = null
              break
            }
            currentRecord = (await database(hopRel.one_collection)
              .where({ id: String(fkId) })
              .first()) as Record<string, unknown> | undefined
            currentCollection = hopRel.one_collection
          }
          const lastPart = parts[parts.length - 1]
          val =
            lastPart === '__id__' || lastPart === '__entity__'
              ? lastFkId
              : (currentRecord?.[lastPart] ?? null)
        } else {
          val = null
        }
      } catch {
        val = null
      }
    }

    const op = rule.trigger_op ?? 'nnull'
    const rawTriggerValue = subParent(rule.trigger_value)

    let triggered = false
    switch (op) {
      case 'eq':
        triggered = String(val) === String(rawTriggerValue ?? '')
        break
      case 'neq':
        triggered = String(val) !== String(rawTriggerValue ?? '')
        break
      case 'null':
        triggered = val == null
        break
      case 'nnull':
        triggered = val != null
        break
      case 'in': {
        let list: string[]
        try {
          const parsed = JSON.parse(rawTriggerValue ?? '[]')
          list = Array.isArray(parsed) ? parsed.map(String) : []
        } catch {
          list = (rawTriggerValue ?? '')
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean)
        }
        triggered = list.includes(String(val))
        break
      }
      case 'contains':
        triggered = String(val).includes(String(rawTriggerValue ?? ''))
        break
      default:
        triggered = triggerField ? val != null : true
    }
    if (isLock) {
      if (triggered) evalOpts?.locks?.add(rule.target_field)
      continue
    }
    if (!triggered) continue

    if (rule.only_if_empty) {
      const existing = working[rule.target_field]
      if (existing != null && existing !== '') continue
    }

    if (rule.target_type === 'clear') {
      working[rule.target_field] = null
    } else if (rule.target_type === 'set' || rule.target_type === 'pick') {
      const rv = subParent(rule.target_value)
      if (rv !== null) working[rule.target_field] = rv
    } else if (rule.target_type === 'relation_field') {
      const fkId = triggerField ? working[triggerField] : null
      if (fkId == null) {
        working[rule.target_field] = null
        continue
      }
      try {
        const rel = (await database('nivaro_relations')
          .where({ many_collection: collection, many_field: triggerField })
          .whereNull('junction_field')
          .first()) as { one_collection: string } | undefined
        if (!rel?.one_collection) continue
        const relatedRecord = (await database(rel.one_collection)
          .where({ id: String(fkId) })
          .first()) as Record<string, unknown> | undefined
        working[rule.target_field] =
          relatedRecord && rule.target_value ? (relatedRecord[rule.target_value] ?? null) : null
      } catch {
        /* non-fatal */
      }
    } else if (rule.target_type === 'precedence' && Array.isArray(rule.sources)) {
      let resolved: unknown = null
      for (const src of rule.sources) {
        if (!src.source_field || !src.source_related_field) continue
        try {
          if (src.source_type === 'relation_field') {
            const fkId = working[src.source_field]
            if (fkId == null) continue
            const rel = (await database('nivaro_relations')
              .where({ many_collection: collection, many_field: src.source_field })
              .whereNull('junction_field')
              .first()) as { one_collection: string } | undefined
            if (!rel?.one_collection) continue
            const relRec = (await database(rel.one_collection)
              .where({ id: String(fkId) })
              .first()) as Record<string, unknown> | undefined
            const candidate = relRec?.[src.source_related_field] ?? null
            if (candidate != null) {
              resolved = candidate
              break
            }
          } else if (src.source_type === 'o2m_first') {
            const rowId = working.id
            if (rowId == null) continue
            const rel = (await database('nivaro_relations')
              .where({ one_collection: collection, one_field: src.source_field })
              .whereNull('junction_field')
              .first()) as { many_collection: string; many_field: string } | undefined
            if (!rel?.many_collection) continue
            const firstRec = (await database(rel.many_collection)
              .where({ [rel.many_field]: String(rowId) })
              .orderBy('id', 'asc')
              .first()) as Record<string, unknown> | undefined
            const candidate = firstRec?.[src.source_related_field] ?? null
            if (candidate != null) {
              resolved = candidate
              break
            }
          } else if (src.source_type === 'o2m_filtered') {
            if (!src.o2m_collection || !src.filter_field) continue
            const hop = src.source_hop ?? 'm2o'
            let intermediateId: string | null = null
            let intermediateCollection: string | null = null
            if (hop === 'm2o') {
              const fkId = working[src.source_field]
              if (fkId == null) continue
              intermediateId = String(fkId)
              const rel = (await database('nivaro_relations')
                .where({ many_collection: collection, many_field: src.source_field })
                .whereNull('junction_field')
                .first()) as { one_collection: string } | undefined
              intermediateCollection = rel?.one_collection ?? null
            } else {
              const rowId = working.id
              if (rowId == null) continue
              const rel = (await database('nivaro_relations')
                .where({ one_collection: collection, one_field: src.source_field })
                .whereNull('junction_field')
                .first()) as { many_collection: string; many_field: string } | undefined
              if (!rel?.many_collection) continue
              const firstRec = (await database(rel.many_collection)
                .where({ [rel.many_field]: String(rowId) })
                .orderBy('id', 'asc')
                .first()) as Record<string, unknown> | undefined
              if (firstRec?.id == null) continue
              intermediateId = String(firstRec.id)
              intermediateCollection = rel.many_collection
            }
            if (!intermediateId || !intermediateCollection) continue
            const fkRel = (await database('nivaro_relations')
              .where({
                many_collection: src.o2m_collection,
                one_collection: intermediateCollection
              })
              .whereNull('junction_field')
              .first()) as { many_field: string } | undefined
            if (!fkRel?.many_field) continue
            const resolvedFilter = subParent(src.filter_value ?? '') ?? ''
            const matchRec = (await database(src.o2m_collection)
              .where({ [fkRel.many_field]: intermediateId, [src.filter_field]: resolvedFilter })
              .orderBy('id', 'asc')
              .first()) as Record<string, unknown> | undefined
            const candidate = matchRec?.[src.source_related_field] ?? null
            if (candidate != null) {
              resolved = candidate
              break
            }
          } else if (src.source_type === 'parent_m2o') {
            if (!src.source_one_collection) continue
            const fkId = parentContext[src.source_field]
            if (fkId == null) continue
            const relRec = (await database(src.source_one_collection)
              .where({ id: String(fkId) })
              .first()) as Record<string, unknown> | undefined
            const candidate = relRec?.[src.source_related_field] ?? null
            if (candidate != null) {
              resolved = candidate
              break
            }
          }
        } catch {
          continue
        }
      }
      working[rule.target_field] = resolved
    }
  }

  return working
}
