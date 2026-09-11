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
  /** Optional gate: the source only yields a candidate when the row (or the
   *  parent, via a `$parent.<field>` field) matches. `related_field` compares
   *  a field of the M2O record the row field points at (dot-hops; `__id__` /
   *  `__entity__` = the last FK id), exactly like a rule trigger. This is how
   *  one precedence chain can hold "services default for labor lines, goods
   *  default for the rest, P2 default when the workflow is P2". */
  when?: {
    field: string
    op?: 'eq' | 'neq' | 'in' | 'null' | 'nnull' | 'contains'
    value?: string | null
    related_field?: string | null
  }
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
  /** The target is an INPUT the rule merely seeds when empty (a project's
   *  default category / CIFA for a new line): re-derivation passes never
   *  blank it, drift sweeps never judge it, and it always behaves as
   *  only_if_empty. Without this, a "default" rule would turn a hand-picked
   *  input into a target that "re-run rules" wipes and re-derives. */
  seed_only?: boolean
  sort?: number
  /** Re-run this rule on API UPDATES when one of its trigger fields is in
   *  the PATCH (createOne always runs every rule; caller-sent targets still
   *  win). ON unless explicitly `false` — the form already re-derives on
   *  every edit, so an API update behaving differently was the surprise. */
  on_update?: boolean
  /** Skip this rule for admins (role admin_access) — "view only except for
   *  admins" locks. Honoured by every pass that knows the acting user: the
   *  grid's evaluate route and the items service's lock check. */
  except_admin?: boolean
  /** Lock rules: the sentence the grid shows instead of deriving one from the
   *  trigger ("Set by the rules — ask an admin to change it"). */
  reason?: string | null
}

/** One line of an explain trace — what a rule did on one pass and why. */
export interface RowRuleTraceEntry {
  index: number
  target_field: string
  target_type: RowRule['target_type']
  trigger_field: string | null
  /** The value the trigger resolved to (after trigger_related_field hops). */
  trigger_value: unknown
  /** wrote | not-triggered | lock | skipped:<reason> */
  outcome: string
  /** Value written to the target (when outcome = wrote). */
  value?: unknown
  ms: number
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
  /** Per locked target: the trigger that locked it (for "why is this locked"). */
  lockReasons?: Map<
    string,
    {
      field: string | null
      related_field: string | null
      op: string
      value: string | null
      reason?: string | null
    }
  >
  /** The acting user is an admin — rules flagged `except_admin` are skipped. */
  isAdmin?: boolean
  /** Evaluate ONLY lock rules — used when a row editor opens, so 'set' rules
   *  don't re-fire over values the user already has. */
  locksOnly?: boolean
  /** Per-pass lookup cache. Created automatically when absent; pass one to
   *  share relation/record lookups across several evaluate passes in the
   *  same request (import prefill evaluates many lines). */
  cache?: RowRuleLookupCache
  /** Only rules whose target_field is in this list run (reset-to-auto for one
   *  field, update-time re-runs for the rules a PATCH touched). */
  targetFields?: string[]
  /** Only rules passing this predicate run (update-time re-runs). */
  ruleFilter?: (rule: RowRule) => boolean
  /** When given, one entry per rule is appended describing what it did. */
  explain?: RowRuleTraceEntry[]
}

/**
 * Memoizes the lookups a rule pass repeats: the same `nivaro_relations` row
 * and the same related record (the picked category, the picked CIFA) are
 * resolved by most of the rules on a grid, and every one of them used to be a
 * separate ~40ms round trip. Promises are memoized so concurrent sources
 * dedupe too; a rejected lookup is forgotten so a transient error is not
 * pinned for the rest of the pass. Scoped to ONE pass by construction — never
 * hoist to module level (relations change in Data Model).
 */
export class RowRuleLookupCache {
  private readonly rels = new Map<string, Promise<Record<string, unknown> | undefined>>()
  private readonly recs = new Map<string, Promise<Record<string, unknown> | undefined>>()
  /** Round trips actually issued through this cache (memo hits excluded). */
  queries = 0
  constructor(readonly database: Knex) {}

  private memo(
    map: Map<string, Promise<Record<string, unknown> | undefined>>,
    key: string,
    run: () => Promise<Record<string, unknown> | undefined>
  ): Promise<Record<string, unknown> | undefined> {
    const hit = map.get(key)
    if (hit) return hit
    this.queries += 1
    const p = run().catch((err) => {
      map.delete(key)
      throw err
    })
    map.set(key, p)
    return p
  }

  /** Plain M2O relation row: `manyCollection.manyField` → one_collection. */
  m2oRel(manyCollection: string, manyField: string) {
    return this.memo(this.rels, `m2o|${manyCollection}|${manyField}`, () =>
      this.database('nivaro_relations')
        .where({ many_collection: manyCollection, many_field: manyField })
        .whereNull('junction_field')
        .first()
    ) as Promise<{ one_collection: string } | undefined>
  }

  /** O2M alias relation row: `oneCollection.oneField` → many_collection/many_field. */
  o2mRel(oneCollection: string, oneField: string) {
    return this.memo(this.rels, `o2m|${oneCollection}|${oneField}`, () =>
      this.database('nivaro_relations')
        .where({ one_collection: oneCollection, one_field: oneField })
        .whereNull('junction_field')
        .first()
    ) as Promise<{ many_collection: string; many_field: string } | undefined>
  }

  /** The FK column on `manyCollection` that points at `oneCollection`. */
  fkRel(manyCollection: string, oneCollection: string) {
    return this.memo(this.rels, `fk|${manyCollection}|${oneCollection}`, () =>
      this.database('nivaro_relations')
        .where({ many_collection: manyCollection, one_collection: oneCollection })
        .whereNull('junction_field')
        .first()
    ) as Promise<{ many_field: string } | undefined>
  }

  /** One record by id. */
  record(collection: string, id: unknown) {
    return this.memo(this.recs, `${collection}|${String(id)}`, () =>
      this.database(collection)
        .where({ id: String(id) })
        .first()
    )
  }

  /** First row of `collection` matching `where` (id ascending). Memoized on
   *  the where-clause — precedence sources like "cifa_tasks for this cifa +
   *  project type" repeat across every line sharing the pair, and a sweep
   *  over thousands of lines would otherwise pay one round trip each. */
  firstWhere(collection: string, where: Record<string, string>) {
    const key = `first|${collection}|${Object.keys(where)
      .sort()
      .map((k) => `${k}=${where[k]}`)
      .join('&')}`
    return this.memo(this.recs, key, () =>
      this.database(collection).where(where).orderBy('id', 'asc').first()
    )
  }
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

  const cache = evalOpts?.cache ?? new RowRuleLookupCache(database)
  const sorted = [...rowRules].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  const targetFilter = evalOpts?.targetFields ? new Set(evalOpts.targetFields) : null
  for (let ruleIndex = 0; ruleIndex < sorted.length; ruleIndex++) {
    const rule = sorted[ruleIndex]
    const isLock = rule.target_type === 'lock'
    const triggerField = rule.trigger_field ?? null
    const startedAt = Date.now()
    let traceVal: unknown
    const note = (outcome: string, value?: unknown) => {
      evalOpts?.explain?.push({
        index: ruleIndex,
        target_field: rule.target_field,
        target_type: rule.target_type,
        trigger_field: triggerField,
        trigger_value: traceVal,
        outcome,
        ...(value !== undefined ? { value } : {}),
        ms: Date.now() - startedAt
      })
    }
    if (evalOpts?.locksOnly && !isLock) {
      note('skipped:locks-only')
      continue
    }
    if (targetFilter && !targetFilter.has(rule.target_field)) {
      note('skipped:target-filter')
      continue
    }
    if (evalOpts?.ruleFilter && !evalOpts.ruleFilter(rule)) {
      note('skipped:rule-filter')
      continue
    }
    if (rule.except_admin && evalOpts?.isAdmin) {
      note('skipped:admin')
      continue
    }
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
      if (
        !isLock &&
        changedField &&
        allTriggerFields.length > 0 &&
        !allTriggerFields.includes(changedField)
      ) {
        note('skipped:other-field-changed')
        continue
      }
      if (triggerField && !(triggerField in working)) {
        note('skipped:trigger-absent')
        continue
      }
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
        const trigRel = await cache.m2oRel(collection, triggerField)
        if (trigRel?.one_collection) {
          let currentRecord = await cache.record(trigRel.one_collection, val)
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
            const hopRel = await cache.m2oRel(currentCollection, hop)
            if (!hopRel?.one_collection) {
              currentRecord = undefined
              lastFkId = null
              break
            }
            currentRecord = await cache.record(hopRel.one_collection, fkId)
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

    traceVal = val
    const op = rule.trigger_op ?? 'nnull'
    const rawTriggerValue = subParent(rule.trigger_value)

    // A rule keyed on a RELATED field ("category → sub_category.__entity__")
    // has nothing to compare when the FK itself is empty: null is not
    // "not Labor", it is "no category yet". Comparing it made every
    // category-less line derive the neq branch (PO line type "Goods"), which
    // hid the real problem — the missing category. Only the null/nnull ops
    // are ABOUT emptiness and still run.
    if (
      rule.trigger_related_field &&
      triggerField &&
      !isParentTrigger &&
      (working[triggerField] == null || working[triggerField] === '') &&
      op !== 'null' &&
      op !== 'nnull'
    ) {
      note('skipped:trigger-empty')
      continue
    }

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
      if (triggered) {
        evalOpts?.locks?.add(rule.target_field)
        evalOpts?.lockReasons?.set(rule.target_field, {
          field: rule.trigger_field ?? null,
          related_field: rule.trigger_related_field ?? null,
          op: rule.trigger_op ?? 'eq',
          value: rule.trigger_value ?? null,
          reason: rule.reason ?? null
        })
      }
      note(triggered ? 'lock' : 'not-triggered')
      continue
    }
    if (!triggered) {
      note('not-triggered')
      continue
    }

    if (rule.only_if_empty || rule.seed_only) {
      const existing = working[rule.target_field]
      if (existing != null && existing !== '') {
        // A seed-only target still holding one of the rule's OWN defaults
        // (any source, gates ignored) is still "auto" — it follows the
        // trigger (materials → equipment swaps the default CIFA). Anything
        // else is a hand pick and stays.
        let stillAuto = false
        if (rule.seed_only && rule.target_type === 'precedence') {
          // The pool spans every seed rule for this target (materials AND
          // equipment defaults) — switching category from one to the other
          // must recognise the old default as "still auto".
          const family = sorted.filter(
            (r) => r.seed_only && r.target_field === rule.target_field && Array.isArray(r.sources)
          )
          const pool = await Promise.all(
            family.flatMap((r) =>
              (r.sources ?? []).map((src) =>
                resolvePrecedenceSource(
                  { ...src, when: undefined },
                  collection,
                  working,
                  parentContext,
                  subParent,
                  cache
                ).catch(() => null)
              )
            )
          )
          stillAuto = pool.some((v) => v != null && String(v) === String(existing))
        }
        if (!stillAuto) {
          note('skipped:only-if-empty', existing)
          continue
        }
      }
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
        note('wrote', null)
        continue
      }
      try {
        const rel = await cache.m2oRel(collection, triggerField as string)
        if (!rel?.one_collection) {
          note('skipped:no-relation')
          continue
        }
        const relatedRecord = await cache.record(rel.one_collection, fkId)
        working[rule.target_field] =
          relatedRecord && rule.target_value ? (relatedRecord[rule.target_value] ?? null) : null
      } catch {
        /* non-fatal */
      }
    } else if (rule.target_type === 'precedence' && Array.isArray(rule.sources)) {
      // Every source is resolved concurrently (they only READ `working` and
      // `parentContext`, captured synchronously below), then the FIRST
      // source in configured order with a non-null candidate wins — the
      // same first-match semantics as the old sequential walk, minus the
      // serial round trips. A source that throws simply yields no candidate.
      const candidates = await Promise.all(
        rule.sources.map((src) =>
          resolvePrecedenceSource(src, collection, working, parentContext, subParent, cache).catch(
            () => null
          )
        )
      )
      const picked = candidates.find((c) => c != null) ?? null
      // A seed rule that derives nothing for the new state leaves the value
      // it seeded earlier (a labor line keeps its CIFA rather than losing it).
      if (rule.seed_only && picked == null && working[rule.target_field] != null) {
        note('skipped:seed-no-candidate')
        continue
      }
      working[rule.target_field] = picked
    }
    note('wrote', working[rule.target_field])
  }

  return working
}

/** Walk `path` ("sub_category.__entity__") from the row's M2O `field`. Mirrors
 *  the trigger_related_field resolution in evaluateRowRules. */
async function resolveRelatedValue(
  collection: string,
  working: Record<string, unknown>,
  field: string,
  path: string,
  cache: RowRuleLookupCache
): Promise<unknown> {
  const fkId = working[field]
  if (fkId == null || fkId === '') return null
  const rel = await cache.m2oRel(collection, field)
  if (!rel?.one_collection) return null
  let currentRecord = await cache.record(rel.one_collection, fkId)
  let currentCollection = rel.one_collection
  let lastFkId: string | null = String(fkId)
  const parts = path.split('.')
  for (let i = 0; i < parts.length - 1; i++) {
    const hop = parts[i]
    const hopId = currentRecord?.[hop]
    if (hopId == null) return null
    lastFkId = String(hopId)
    const hopRel = await cache.m2oRel(currentCollection, hop)
    if (!hopRel?.one_collection) return null
    currentRecord = await cache.record(hopRel.one_collection, hopId)
    currentCollection = hopRel.one_collection
  }
  const last = parts[parts.length - 1]
  return last === '__id__' || last === '__entity__' ? lastFkId : (currentRecord?.[last] ?? null)
}

async function sourceGateOpen(
  src: RowRuleSource,
  collection: string,
  working: Record<string, unknown>,
  parentContext: Record<string, unknown>,
  subParent: (s: string | null | undefined) => string | null,
  cache: RowRuleLookupCache
): Promise<boolean> {
  const w = src.when
  if (!w?.field) return true
  const op = w.op ?? 'nnull'
  let val: unknown
  if (w.field.startsWith('$parent.')) {
    val = parentContext[w.field.slice(8)] ?? null
  } else if (w.related_field) {
    // An empty FK has nothing to compare (the trigger-empty rule) — closed
    // unless the op is about emptiness.
    if ((working[w.field] == null || working[w.field] === '') && op !== 'null' && op !== 'nnull')
      return false
    val = await resolveRelatedValue(collection, working, w.field, w.related_field, cache)
  } else {
    val = working[w.field] ?? null
  }
  return matchesTrigger(op, val, subParent(w.value ?? null))
}

async function resolvePrecedenceSource(
  src: RowRuleSource,
  collection: string,
  working: Record<string, unknown>,
  parentContext: Record<string, unknown>,
  subParent: (s: string | null | undefined) => string | null,
  cache: RowRuleLookupCache
): Promise<unknown> {
  if (!src.source_field || !src.source_related_field) return null
  if (!(await sourceGateOpen(src, collection, working, parentContext, subParent, cache)))
    return null
  if (src.source_type === 'relation_field') {
    const fkId = working[src.source_field]
    if (fkId == null) return null
    const rel = await cache.m2oRel(collection, src.source_field)
    if (!rel?.one_collection) return null
    const relRec = await cache.record(rel.one_collection, fkId)
    return relRec?.[src.source_related_field] ?? null
  }
  if (src.source_type === 'o2m_first') {
    const rowId = working.id
    if (rowId == null) return null
    const rel = await cache.o2mRel(collection, src.source_field)
    if (!rel?.many_collection) return null
    const firstRec = await cache.firstWhere(rel.many_collection, {
      [rel.many_field]: String(rowId)
    })
    return firstRec?.[src.source_related_field] ?? null
  }
  if (src.source_type === 'o2m_filtered') {
    if (!src.o2m_collection || !src.filter_field) return null
    const hop = src.source_hop ?? 'm2o'
    let intermediateId: string | null = null
    let intermediateCollection: string | null = null
    if (hop === 'm2o') {
      const fkId = working[src.source_field]
      if (fkId == null) return null
      intermediateId = String(fkId)
      const rel = await cache.m2oRel(collection, src.source_field)
      intermediateCollection = rel?.one_collection ?? null
    } else {
      const rowId = working.id
      if (rowId == null) return null
      const rel = await cache.o2mRel(collection, src.source_field)
      if (!rel?.many_collection) return null
      const firstRec = await cache.firstWhere(rel.many_collection, {
        [rel.many_field]: String(rowId)
      })
      if (firstRec?.id == null) return null
      intermediateId = String(firstRec.id)
      intermediateCollection = rel.many_collection
    }
    if (!intermediateId || !intermediateCollection) return null
    const fkRel = await cache.fkRel(src.o2m_collection, intermediateCollection)
    if (!fkRel?.many_field) return null
    const resolvedFilter = subParent(src.filter_value ?? '') ?? ''
    const matchRec = await cache.firstWhere(src.o2m_collection, {
      [fkRel.many_field]: intermediateId,
      [src.filter_field]: resolvedFilter
    })
    return matchRec?.[src.source_related_field] ?? null
  }
  if (src.source_type === 'parent_m2o') {
    if (!src.source_one_collection) return null
    const fkId = parentContext[src.source_field]
    if (fkId == null) return null
    const relRec = await cache.record(src.source_one_collection, fkId)
    return relRec?.[src.source_related_field] ?? null
  }
  return null
}
