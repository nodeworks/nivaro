/**
 * Which fields of a record never follow it into a copy — the ONE rule every
 * clone path uses (Rob 2026-11-14: a duplicated record carried the original's
 * progress). Paths: POST /items/:c/:id/clone (admin Clone dialog), More →
 * Duplicate (shared ItemEditForm, admin + efp-new), Save as template, and the
 * per-line copies Duplicate makes of a grid's child rows. The client paths
 * read this rule through GET /api/copy-rules/:collection.
 *
 * A copy is a NEW record: it goes through the normal create, so its pipeline
 * auto-starts at the binding's start state, owners resolve fresh, SLA clocks
 * start fresh and no history or approval carries over. What must not come
 * along is anything that says how far the ORIGINAL got or ties it to a partner:
 *   - audit / identity columns (id, creator, stamps, last state change),
 *   - the pipeline's state field (the binding's `state_field` mirror),
 *   - generated ids (auto-ids regenerate), calculated values, stored rollups
 *     (and a yes/no switch a rollup's parent filter reads),
 *   - read-only fields (written by the system: totals, partner statuses),
 *   - hidden fields (integration and system state: external ids, triggers),
 *   - fields marked "do not duplicate" (`options.no_duplicate`),
 *   - the collection's own list (`browser_config.never_copy`, Table Editor →
 *     Settings → Collection Browser → Never copied when duplicating).
 *
 * Child rows (a grid's lines) copy hidden columns (a line's own sort / kind
 * keep the grid working), so `childRowSkip` leaves out the 'hidden' reason.
 */
import { db } from '../db/index.js'
import { autoIdFieldsFor } from './auto-ids.js'
import { getCollection, getFields } from './collections.js'

export type CopySkipReason =
  | 'audit'
  | 'pipeline-state'
  | 'never-copy'
  | 'list'
  | 'hidden'
  | 'read-only'
  | 'calculated'
  | 'generated'
  | 'rollup'
  | 'rollup-switch'
  | 'do-not-duplicate'

/** Audit / identity columns a copy never carries, whatever their metadata says. */
export const COPY_AUDIT_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
  'user_created',
  'date_created',
  'user_updated',
  'date_updated',
  'created',
  'changed',
  'creator',
  'last_state_change',
  '_status',
  'workspace_id',
  'is_redacted'
])

const AUDIT_SPECIAL = /^(user|date)-(created|updated)$/
const LIST_SPECIALS = new Set(['o2m', 'm2m', 'm2a', 'files', 'file', 'alias', 'translations'])
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface CopyFieldMeta {
  field: string
  type?: string | null
  hidden?: boolean | null
  readonly?: boolean | null
  special?: unknown
  options?: unknown
  computed_type?: string | null
  computed_formula?: string | null
}

export interface CopyRuleContext {
  /** The pipeline binding's state field(s) for this collection. */
  stateFields: ReadonlySet<string>
  /** Auto-id fields (also read from options.auto_id). */
  autoIds: ReadonlySet<string>
  /** The collection's own stored rollups (a copy has none of the original's children). */
  rollups: ReadonlySet<string>
  /** Fields a stored rollup's parent_filter reads. Only a yes/no switch among them
   *  (projects.pub_amount_follows_cars) stays behind: it says the record follows
   *  children the copy does not have. A type or category (workflow_type) copies. */
  rollupFilters?: ReadonlySet<string>
  /** The collection's own "never copied" list. */
  neverCopy: ReadonlySet<string>
}

function objectOf(raw: unknown): Record<string, unknown> | null {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function specialsOf(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === 'string')
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  return []
}

/** `browser_config.never_copy` — the collection's own extra list (field names). */
export function parseNeverCopy(browserConfig: unknown): string[] {
  const bc = objectOf(browserConfig)
  const raw = bc?.never_copy
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.map((f) => String(f ?? '').trim()).filter((f) => IDENT.test(f)))]
}

/** Why a field does NOT copy onto a new record, or null when it does. Pure. */
export function copySkipReason(f: CopyFieldMeta, ctx: CopyRuleContext): CopySkipReason | null {
  const special = specialsOf(f.special)
  if (COPY_AUDIT_FIELDS.has(f.field) || special.some((s) => AUDIT_SPECIAL.test(s))) return 'audit'
  if (ctx.stateFields.has(f.field)) return 'pipeline-state'
  if (ctx.neverCopy.has(f.field)) return 'never-copy'
  if (special.some((s) => LIST_SPECIALS.has(s)) || f.type === 'alias') return 'list'
  const opts = objectOf(f.options) ?? {}
  if (ctx.autoIds.has(f.field) || opts.auto_id) return 'generated'
  if (f.computed_type === 'rollup') return 'rollup'
  if (f.computed_type || f.computed_formula) return 'calculated'
  if (ctx.rollups.has(f.field)) return 'rollup'
  if (ctx.rollupFilters?.has(f.field) && f.type === 'boolean') return 'rollup-switch'
  if (f.readonly) return 'read-only'
  if (opts.no_duplicate) return 'do-not-duplicate'
  if (f.hidden) return 'hidden'
  return null
}

/** Every field of `fields` that does not copy, with its reason. Pure. */
export function copySkipMap(
  fields: CopyFieldMeta[],
  ctx: CopyRuleContext
): Map<string, CopySkipReason> {
  const out = new Map<string, CopySkipReason>()
  for (const name of COPY_AUDIT_FIELDS) out.set(name, 'audit')
  for (const name of ctx.stateFields) out.set(name, 'pipeline-state')
  for (const name of ctx.neverCopy) out.set(name, 'never-copy')
  for (const name of ctx.autoIds) out.set(name, 'generated')
  for (const name of ctx.rollups) out.set(name, 'rollup')
  for (const f of fields) {
    const why = copySkipReason(f, ctx)
    if (why) out.set(f.field, why)
  }
  return out
}

/** The copy of `row`: only fields that copy, plain values only. Pure. */
export function copyableValues(
  row: Record<string, unknown>,
  skip: ReadonlyMap<string, CopySkipReason>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (skip.has(k) || k.includes('.') || k.startsWith('$') || k.startsWith('__')) continue
    out[k] = v
  }
  return out
}

/** Reasons that keep a CHILD row's column off the copied line (hidden columns copy). */
export function childRowSkip(skip: ReadonlyMap<string, CopySkipReason>): string[] {
  return [...skip].filter(([, why]) => why !== 'hidden' && why !== 'list').map(([f]) => f)
}

async function bindingStateFields(collection: string): Promise<string[]> {
  try {
    const rows = (await db('nivaro_workflow_bindings')
      .where({ collection })
      .select('state_field')) as Array<{ state_field: string | null }>
    return rows.map((r) => r.state_field).filter((f): f is string => !!f)
  } catch {
    return []
  }
}

async function rollupFields(collection: string): Promise<{ totals: string[]; filters: string[] }> {
  try {
    const { cloneDerivedFields, ownParentFilterRollups } = await import('./rollups.js')
    const [all, own] = await Promise.all([
      cloneDerivedFields(collection),
      ownParentFilterRollups(collection)
    ])
    const filters = new Set(own.flatMap((r) => r.filterFields))
    const totals = new Set(own.map((r) => r.field))
    return {
      totals: all.filter((f) => totals.has(f) || !filters.has(f)),
      filters: [...filters].filter((f) => !totals.has(f))
    }
  } catch {
    return { totals: [], filters: [] }
  }
}

/** The copy rule of one collection: field → reason it never copies. */
export async function copyRulesFor(collection: string): Promise<Map<string, CopySkipReason>> {
  const [col, fields, stateFields, autoIds, rollups] = await Promise.all([
    getCollection(collection).catch(() => null),
    getFields(collection).catch(() => []),
    bindingStateFields(collection),
    autoIdFieldsFor(db, collection)
      .then((r) => r.map((f) => f.field))
      .catch(() => [] as string[]),
    rollupFields(collection)
  ])
  return copySkipMap(fields as CopyFieldMeta[], {
    stateFields: new Set(stateFields),
    autoIds: new Set(autoIds),
    rollups: new Set(rollups.totals),
    rollupFilters: new Set(rollups.filters),
    neverCopy: new Set(parseNeverCopy((col as { browser_config?: unknown } | null)?.browser_config))
  })
}
