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
import type { User } from '../types.js'
import { autoIdFieldsFor } from './auto-ids.js'
import { getCollection, getFields, getRelations } from './collections.js'
import { getAllowedFields } from './permissions.js'

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

// ─── Many-to-many link sets (Zone, Project Sub Type, funding years…) ─────────

/** At most this many links per list follow a copy. */
export const COPY_MAX_LINKS = 500

export interface LinkRelation {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  one_collection_field?: string | null
  one_allowed_collections?: unknown
  junction_field: string | null
}

export interface LinkPlan {
  /** The alias field on the record (`regions`). */
  field: string
  junction: string
  parentFk: string
  relatedFk: string
  /** M2A: the junction column naming the target collection. */
  discriminator: string | null
}

interface LinkRuleContext {
  neverCopy: ReadonlySet<string>
  mayRead: (field: string) => boolean
}

/**
 * Why a many-to-many list does NOT follow the copy, or null when it does: the
 * same rule as plain fields minus the "list" reason itself — files never copy,
 * nor a list that is hidden, read-only, "do not duplicate", on the collection's
 * never-copy list, or one the caller may not read. Pure.
 */
export function linkSkipReason(
  f: CopyFieldMeta | undefined,
  alias: string,
  ctx: LinkRuleContext,
  target: string | null,
  junction: string
): string | null {
  if (ctx.neverCopy.has(alias)) return 'never-copy'
  if (!ctx.mayRead(alias)) return 'no-read'
  const special = specialsOf(f?.special)
  if (special.includes('files') || special.includes('file')) return 'files'
  if (/_files$/i.test(junction) || target === 'nivaro_files' || target === 'directus_files')
    return 'files'
  if (f?.hidden) return 'hidden'
  if (f?.readonly) return 'read-only'
  if (objectOf(f?.options)?.no_duplicate) return 'do-not-duplicate'
  return null
}

/** The junction legs of `collection`'s many-to-many lists that may follow a copy. Pure. */
export function linkPlans(
  collection: string,
  rels: LinkRelation[],
  fields: CopyFieldMeta[],
  ctx: LinkRuleContext
): LinkPlan[] {
  const byName = new Map(fields.map((f) => [f.field, f]))
  const out: LinkPlan[] = []
  for (const r of rels) {
    if (r.one_collection !== collection || !r.one_field || r.junction_field == null) continue
    const jf = String(r.junction_field)
    if (!IDENT.test(r.many_collection) || !IDENT.test(r.many_field) || !IDENT.test(jf)) continue
    if (out.some((p) => p.field === r.one_field)) continue
    const companion = rels.find(
      (c) => c !== r && c.many_collection === r.many_collection && c.many_field === jf
    )
    const target = companion?.one_collection ?? null
    if (linkSkipReason(byName.get(r.one_field), r.one_field, ctx, target, r.many_collection))
      continue
    const polymorphic = !!(r.one_allowed_collections || companion?.one_allowed_collections)
    const discriminator = polymorphic
      ? String(r.one_collection_field || companion?.one_collection_field || 'collection')
      : null
    if (discriminator && !IDENT.test(discriminator)) continue
    out.push({
      field: r.one_field,
      junction: r.many_collection,
      parentFk: r.many_field,
      relatedFk: jf,
      discriminator
    })
  }
  return out
}

/**
 * The link sets record `id` holds, as the alias payload a create writes
 * (`{regions: [2, 5]}`; M2A `{collection, id}` pairs). The original was read as
 * the caller before this. Each link is then written by the create through the
 * items service AS THE CALLER, so a link they may not make is refused there and
 * named in the create's link failures.
 */
export async function linkSetsToCopy(
  user: User,
  collection: string,
  id: string | number
): Promise<Record<string, unknown>> {
  const [col, fields, own, readable] = await Promise.all([
    getCollection(collection).catch(() => null),
    getFields(collection).catch(() => []),
    getRelations(collection).catch(() => []),
    getAllowedFields(user, 'read', collection).catch(() => null)
  ])
  const junctions = [
    ...new Set(
      (own as LinkRelation[])
        .filter((r) => r.one_collection === collection && r.junction_field)
        .map((r) => r.many_collection)
    )
  ]
  const legs = (await Promise.all(junctions.map((j) => getRelations(j).catch(() => [])))).flat()
  const plans = linkPlans(
    collection,
    [...(own as LinkRelation[]), ...(legs as LinkRelation[])],
    fields as CopyFieldMeta[],
    {
      neverCopy: new Set(
        parseNeverCopy((col as { browser_config?: unknown } | null)?.browser_config)
      ),
      mayRead: (f) => !readable || readable.includes('*') || readable.includes(f)
    }
  )
  const out: Record<string, unknown> = {}
  for (const p of plans) {
    try {
      const cols = p.discriminator ? [p.relatedFk, p.discriminator] : [p.relatedFk]
      const rows = (await db(p.junction)
        .where(p.parentFk, id)
        .whereNotNull(p.relatedFk)
        .limit(COPY_MAX_LINKS)
        .select(cols)) as Array<Record<string, unknown>>
      if (rows.length === 0) continue
      const disc = p.discriminator
      out[p.field] = disc
        ? rows.map((x) => ({ collection: String(x[disc] ?? ''), id: x[p.relatedFk] }))
        : rows.map((x) => x[p.relatedFk])
    } catch {
      /* a link table that cannot be read just does not copy */
    }
  }
  return out
}
