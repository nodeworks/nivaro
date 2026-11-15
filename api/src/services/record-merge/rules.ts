/**
 * Merge records (Rob 2026-11-14) — the pure half: the per-collection switch, which fields
 * a merge shows, which relations point at a record (and what "move" means for each), the
 * survivor's patch and the stored undo log. IO lives in plan.ts / apply.ts / undo.ts.
 *
 * "A true merge, not just choose one or the other": the person sees one column per record,
 * picks each field's value from ANY record (or types a new one, or combines long text and
 * sets), chooses which record SURVIVES (keeps its id, number and history) and which are
 * DISCARDED (soft-deleted through the trash, restorable), and per relation whether the
 * lines, links, files, comments and tasks hanging off a discarded record move to the
 * survivor or stay where they are.
 *
 * `nivaro_collections.browser_config.merge_records`:
 *
 *   { mode?: 'on' | 'off' }    missing = ON for every registered non-system collection.
 *
 * Independent of the duplicate warning: a collection may turn duplicate warnings off
 * because near-duplicates are normal there and still want merging.
 */

export const SYSTEM_COLLECTION = /^(nivaro_|directus_)/i
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** Records in one merge (survivor + the others). */
export const MAX_MERGE_RECORDS = 5
/** Rows of one relation that move through the items service in one merge. */
export const MOVE_ROW_CAP = 500
/** How long a merge can be undone. */
export const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000

export interface MergeSetting {
  allowed: boolean
  /** 'configured' = set on the collection; 'default' = not set (on). */
  source: 'configured' | 'default'
}

function parseObj(raw: unknown): Record<string, unknown> | null {
  let v: unknown = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** The "Allow merging" switch: its own value when set, else on. */
export function mergeSettingOf(collection: string, browserConfig: unknown): MergeSetting {
  if (SYSTEM_COLLECTION.test(collection)) return { allowed: false, source: 'configured' }
  const bc = parseObj(browserConfig)
  const own = parseObj(bc?.merge_records)
  if (own && (own.mode === 'on' || own.mode === 'off'))
    return { allowed: own.mode === 'on', source: 'configured' }
  return { allowed: true, source: 'default' }
}

// ─── Fields ─────────────────────────────────────────────────────────────────

export interface MergeFieldMeta {
  field: string
  type?: string | null
  interface?: string | null
  hidden?: boolean | null
  readonly?: boolean | null
  special?: string[] | null
  options?: Record<string, unknown> | null
  computed_type?: string | null
  computed_formula?: string | null
  name?: string | null
}

const AUDIT_SPECIALS = new Set(['user-created', 'date-created', 'user-updated', 'date-updated'])
const SERVER_NAMES = new Set([
  'id',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
  'date_created',
  'date_updated',
  'user_created',
  'user_updated',
  'sort'
])

export const fieldTitle = (f: string, meta?: { name?: string | null } | null) =>
  String(meta?.name ?? '').trim() ||
  f
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bId\b/g, 'ID')

/**
 * Whether a field takes part in a merge at all: a stored value the person could pick
 * (not the id, stamps, generated numbers, computed values or relation aliases — those are
 * the survivor's, or relations shown in their own section).
 */
export function isMergeField(f: MergeFieldMeta, aliases: ReadonlySet<string>): boolean {
  if (!IDENT.test(f.field) || f.field.startsWith('$')) return false
  if (SERVER_NAMES.has(f.field)) return false
  if (aliases.has(f.field)) return false
  if (String(f.type ?? '').toLowerCase() === 'alias') return false
  if ((f.special ?? []).some((s) => AUDIT_SPECIALS.has(s) || s === 'alias' || s === 'o2m'))
    return false
  if (f.computed_type || f.computed_formula) return false
  const opts = f.options
  if (opts && typeof opts === 'object' && (opts as { auto_id?: unknown }).auto_id) return false
  return true
}

// ─── Relations ──────────────────────────────────────────────────────────────

export type MergeRelationKind = 'lines' | 'links' | 'm2m' | 'files'

export interface RelationMeta {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

export interface InboundRelation {
  key: string
  kind: MergeRelationKind
  /** The table whose rows point at the record. */
  collection: string
  /** The column holding the record's id. */
  field: string
  /** The alias on the merged collection (lines / m2m), when there is one. */
  alias: string | null
  /** m2m / files: the junction's other leg (pairs that already exist on the survivor). */
  other_field: string | null
  /** m2m / files: what the other leg points at. */
  target: string | null
  /** A physical foreign key no registered relation describes (moved raw, admins only). */
  raw: boolean
}

const FILE_COLLECTIONS = new Set(['nivaro_files', 'directus_files'])

/**
 * Every relation whose rows point at a record of `collection`: lines (one-to-many with an
 * alias here), links (a plain link from another collection), many-to-many junction rows
 * (files when the other side is the files table), plus physical foreign keys no relation
 * describes. System tables never take part (their rows are not records).
 */
export function inboundRelations(
  collection: string,
  relations: RelationMeta[],
  physical: Array<{ table: string; column: string }> = []
): InboundRelation[] {
  const out: InboundRelation[] = []
  const seen = new Set<string>()
  const lower = (s: string) => s.toLowerCase()
  for (const r of relations) {
    if (r.one_collection !== collection) continue
    const table = String(r.many_collection ?? '')
    const column = String(r.many_field ?? '')
    if (!IDENT.test(table) || !IDENT.test(column)) continue
    if (SYSTEM_COLLECTION.test(table)) continue
    const key = `${table}.${column}`
    if (seen.has(lower(key))) continue
    seen.add(lower(key))
    if (r.junction_field) {
      const other = relations.find(
        (x) => x.many_collection === table && x.many_field === r.junction_field
      )
      const target = other?.one_collection ?? null
      out.push({
        key,
        kind: target && FILE_COLLECTIONS.has(target) ? 'files' : 'm2m',
        collection: table,
        field: column,
        alias: r.one_field ?? null,
        other_field: r.junction_field,
        target,
        raw: false
      })
    } else {
      out.push({
        key,
        kind: r.one_field ? 'lines' : 'links',
        collection: table,
        field: column,
        alias: r.one_field ?? null,
        other_field: null,
        target: null,
        raw: false
      })
    }
  }
  for (const p of physical) {
    if (!IDENT.test(p.table) || !IDENT.test(p.column)) continue
    if (SYSTEM_COLLECTION.test(p.table)) continue
    if (lower(p.table) === lower(collection) && p.column === 'id') continue
    const key = `${p.table}.${p.column}`
    if (seen.has(lower(key))) continue
    seen.add(lower(key))
    out.push({
      key,
      kind: 'links',
      collection: p.table,
      field: p.column,
      alias: null,
      other_field: null,
      target: null,
      raw: true
    })
  }
  return out
}

/** The record-attached system rows a merge offers to move, beside the relations. */
export type MergeAttachedKind = 'comments' | 'tasks' | 'record_links'
export const ATTACHED_KINDS: MergeAttachedKind[] = ['comments', 'tasks', 'record_links']

export type MoveChoice = 'move' | 'leave'

// ─── The survivor's patch ───────────────────────────────────────────────────

const norm = (v: unknown): string => {
  if (v == null || v === '') return ''
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    const id = (v as { id?: unknown }).id
    if (id != null && !Array.isArray(v)) return String(id)
    return JSON.stringify(v)
  }
  return String(v)
}

/** Two stored values the same for a merge (null = empty, an object with an id = that id). */
export const sameMergeValue = (a: unknown, b: unknown) => norm(a) === norm(b)

export interface PatchVerdict {
  patch: Record<string, unknown>
  /** Fields the request wants changed that the person may not write. */
  refused: string[]
  /** Fields the request names that are not merge fields of this collection. */
  unknown: string[]
}

/**
 * What the survivor's row must change to: every chosen value that differs from what the
 * survivor holds now. A chosen value equal to the survivor's is not written (no empty
 * revision); a differing one on a field the person may not write is refused, never dropped
 * quietly.
 */
export function survivorPatch(
  current: Record<string, unknown>,
  chosen: Record<string, unknown> | null | undefined,
  mergeFields: ReadonlySet<string>,
  writable: ReadonlySet<string>
): PatchVerdict {
  const patch: Record<string, unknown> = {}
  const refused: string[] = []
  const unknown: string[] = []
  for (const [field, value] of Object.entries(chosen ?? {})) {
    if (!mergeFields.has(field)) {
      unknown.push(field)
      continue
    }
    if (sameMergeValue(current[field], value)) continue
    if (!writable.has(field)) {
      refused.push(field)
      continue
    }
    patch[field] =
      value && typeof value === 'object' && !Array.isArray(value) && 'id' in value
        ? (value as { id: unknown }).id
        : value
  }
  return { patch, refused, unknown }
}

// ─── The undo log ───────────────────────────────────────────────────────────

/** One row a merge repointed (through the items service, or raw for an admin). */
export interface MovedRow {
  collection: string
  field: string
  id: string
  from: string
  raw?: boolean
}

export interface MergeUndoLog {
  v: 1
  merge_id: string
  collection: string
  survivor: string
  discarded: string[]
  kept: string[]
  user: string
  at: string
  /** Discarded records actually deleted so far (a failed merge puts back only these). */
  deleted: string[]
  /** Survivor fields: what they were before and what the merge wrote. */
  before: Record<string, unknown>
  after: Record<string, unknown>
  moved: MovedRow[]
  /** Junction rows deleted because the survivor already had the same pair (trashed). */
  junction_deleted: Array<{ collection: string; id: string }>
  comments: Array<{ id: string; from: string }>
  tasks_moved: Array<{ id: number; from: string }>
  tasks_closed: number[]
  record_links: Array<{ id: number; side: 'from' | 'to'; from: string }>
  approvals: Array<{ id: number; from: string }>
  labels: Record<string, string>
  undone_at?: string | null
  undone_by?: string | null
}

export function emptyUndoLog(args: {
  merge_id: string
  collection: string
  survivor: string
  discarded: string[]
  kept: string[]
  user: string
}): MergeUndoLog {
  return {
    v: 1,
    ...args,
    at: new Date().toISOString(),
    deleted: [],
    before: {},
    after: {},
    moved: [],
    junction_deleted: [],
    comments: [],
    tasks_moved: [],
    tasks_closed: [],
    record_links: [],
    approvals: [],
    labels: {},
    undone_at: null,
    undone_by: null
  }
}

/** Why an undo is not offered (null = it is). */
export function undoRefusal(
  log: MergeUndoLog | null,
  me: { id: string; isAdmin: boolean },
  now = Date.now()
): string | null {
  if (!log) return 'This merge is not known here.'
  if (log.undone_at) return 'This merge was already undone.'
  if (now - Date.parse(log.at) > UNDO_WINDOW_MS)
    return 'A merge can be undone for 24 hours. This one is older — restore the records from the trash instead.'
  if (!me.isAdmin && String(log.user).toLowerCase() !== String(me.id).toLowerCase())
    return 'Only the person who merged these records, or an administrator, can undo it.'
  return null
}

/** "Deployment Part Types" → "Deployment Part Type" (the last word; plain English plurals). */
export function singularOf(name: string): string {
  return name.replace(/([A-Za-z]+)$/, (w) => {
    if (/ies$/i.test(w) && w.length > 4) return `${w.slice(0, -3)}y`
    if (/(ss|us|is)$/i.test(w)) return w
    if (/(xes|ches|shes|sses)$/i.test(w)) return w.slice(0, -2)
    if (/s$/i.test(w) && w.length > 2) return w.slice(0, -1)
    return w
  })
}

/** "A, B and C" */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
