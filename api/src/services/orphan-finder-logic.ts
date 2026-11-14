// api/src/services/orphan-finder-logic.ts
/**
 * Orphan finder (Data Integrity → Orphans): rows whose links point at records that no
 * longer exist. Pure half: no database, no clock. orphan-finder.ts reads the facts in and
 * runs the statements built here.
 *
 * `nivaro_relations` is a claim, not truth: every check is built only after its tables
 * and columns are seen in the live schema, and every identifier that reaches SQL comes
 * from that schema read (never from a request). One check = one link column:
 *
 *   m2o       a plain many-to-one field whose target record is gone
 *   o2m       the same, seen from the parent: child rows whose parent is gone
 *   junction  a link-table leg (many-to-many) whose side is gone
 *   file      a file field (by relation, or by interface with no relation) whose file is gone
 *
 * A link the database itself enforces (a trusted, enabled foreign key) cannot dangle, so it
 * is listed but never scanned. The older nightly detector (services/fk-integrity.ts, DB
 * Health "Dangling foreign keys") covers plain business M2O fields only; this covers the
 * rest and adds repair through the items service.
 */
import { createHash } from 'node:crypto'

export type OrphanKind = 'm2o' | 'o2m' | 'junction' | 'file'
export type CompareMode = 'plain' | 'cast_bigint' | 'cast_guid'

export interface RelationFact {
  many_collection: string | null
  many_field: string | null
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}
export interface FieldFact {
  collection: string
  field: string
  interface: string | null
  special: string | null
  db_column: string | null
}
export interface ColumnFact {
  type: string
  nullable: boolean
}
export interface SchemaFacts {
  /** table (exact case) → column (exact case) → type/nullability. Base tables only. */
  tables: Map<string, Map<string, ColumnFact>>
  /** table → its single-column primary key (tables with a composite key are absent). */
  pk: Map<string, string>
  /** Foreign keys the database enforces (enabled and trusted): `table.column` lower-cased. */
  enforced: Set<string>
  /** table → `other.column` entries of foreign keys that point INTO it. */
  referencedBy: Map<string, string[]>
  /** The engine can TRY_CAST (SQL Server). */
  mssql: boolean
}

export interface OrphanCheck {
  /** Stable id: `child.fk>parent` (as the schema spells them). */
  key: string
  kind: OrphanKind
  child: string
  /** The link column on the child (a field's db_column when it has one). */
  fk: string
  /** The field name the admin sees (differs from fk only with a db_column). */
  field: string
  parent: string
  parent_key: string
  child_pk: string
  fk_nullable: boolean
  /** The database enforces this link: it cannot dangle, so it is not scanned. */
  enforced: boolean
  compare: CompareMode
  /** String link columns: an empty string means "no link", never an orphan. */
  text_fk: boolean
  /** Physical foreign keys into the child table (rows here may not be deleted blindly). */
  referenced_by: string[]
  /** Junction only: the other leg's column. */
  other_leg: string | null
}

export interface SkippedLink {
  label: string
  reason: string
}

const IDENT = /^[A-Za-z_][\w]{0,127}$/
const SYSTEM = /^(nivaro|directus)_/i
const FILE_TABLES = ['nivaro_files', 'directus_files']
const USER_TABLES = ['nivaro_users', 'directus_users']
const FILE_INTERFACES = new Set(['file', 'file-image', 'image', 'file-interface'])

const NUM = new Set(['int', 'bigint', 'smallint', 'tinyint', 'numeric', 'decimal', 'integer'])
const STR = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext', 'character varying'])
const GUID = new Set(['uniqueidentifier', 'uuid'])

function family(type: string): 'num' | 'str' | 'guid' | 'other' {
  const t = type.toLowerCase()
  if (NUM.has(t)) return 'num'
  if (STR.has(t)) return 'str'
  if (GUID.has(t)) return 'guid'
  return 'other'
}

/**
 * How the child's link value is compared with the parent's key, or null when it cannot be
 * compared safely. The parent side never gets a cast (its key stays seekable); a cast on the
 * child side is TRY_CAST, so a value that is no key at all reads as an orphan, not an error.
 */
export function compareMode(fkType: string, keyType: string, mssql: boolean): CompareMode | null {
  const a = family(fkType)
  const b = family(keyType)
  if (a === 'other' || b === 'other') return null
  if (a === b) return 'plain'
  if (!mssql) return null
  if (a === 'str' && b === 'num') return 'cast_bigint'
  if (a === 'str' && b === 'guid') return 'cast_guid'
  // num → str, guid → str: the implicit conversion would run on the parent's key column
  // (and throw on a key that is not a number); not worth a scan.
  return null
}

/** Case-insensitive lookup that returns the schema's own spelling. */
function findName<T>(map: Map<string, T>, name: string): string | null {
  if (map.has(name)) return name
  const lower = name.toLowerCase()
  for (const k of map.keys()) if (k.toLowerCase() === lower) return k
  return null
}

/** directus_files / directus_users were dropped on most databases: their links now point at the
 *  nivaro_ twin, so a claim naming a missing directus_ table is read as the nivaro_ one. */
function resolveParent(name: string, tables: SchemaFacts['tables']): string | null {
  const direct = findName(tables, name)
  if (direct) return direct
  const lower = name.toLowerCase()
  if (lower === 'directus_files') return findName(tables, 'nivaro_files')
  if (lower === 'directus_users') return findName(tables, 'nivaro_users')
  return null
}

export function checkKey(child: string, fk: string, parent: string): string {
  return `${child}.${fk}>${parent}`
}

interface Candidate {
  kind: OrphanKind
  child: string
  field: string
  parent: string
  other_leg: string | null
}

/** Every link column the metadata claims, judged against the live schema. */
export function buildOrphanChecks(
  relations: RelationFact[],
  fields: FieldFact[],
  facts: SchemaFacts
): { checks: OrphanCheck[]; skipped: SkippedLink[] } {
  const candidates: Candidate[] = []
  const claimed = new Set<string>()
  for (const r of relations) {
    if (!r.many_collection || !r.many_field) continue
    const label = `${r.many_collection}.${r.many_field}`
    if (!r.one_collection) {
      // Many-to-any: the target table is per row, named by a discriminator column.
      claimed.add(label.toLowerCase())
      candidates.push({
        kind: 'm2o',
        child: r.many_collection,
        field: r.many_field,
        parent: '',
        other_leg: null
      })
      continue
    }
    claimed.add(label.toLowerCase())
    const isFile = FILE_TABLES.includes(r.one_collection.toLowerCase())
    candidates.push({
      kind: r.junction_field ? 'junction' : isFile ? 'file' : r.one_field ? 'o2m' : 'm2o',
      child: r.many_collection,
      field: r.many_field,
      parent: r.one_collection,
      other_leg: r.junction_field
    })
  }
  // File fields that hold a file id with no relation row behind them.
  for (const f of fields) {
    const iface = String(f.interface ?? '').toLowerCase()
    const special = String(f.special ?? '').toLowerCase()
    if (!FILE_INTERFACES.has(iface) && !/(^|,)\s*file\s*(,|$)/.test(special)) continue
    if (claimed.has(`${f.collection}.${f.field}`.toLowerCase())) continue
    claimed.add(`${f.collection}.${f.field}`.toLowerCase())
    candidates.push({
      kind: 'file',
      child: f.collection,
      field: f.field,
      parent: 'nivaro_files',
      other_leg: null
    })
  }

  const dbColumn = new Map<string, string>()
  for (const f of fields) {
    if (f.db_column && f.db_column !== f.field)
      dbColumn.set(`${f.collection}.${f.field}`.toLowerCase(), f.db_column)
  }

  const checks: OrphanCheck[] = []
  const skipped: SkippedLink[] = []
  const seen = new Set<string>()
  for (const c of candidates) {
    const label = `${c.child}.${c.field}${c.parent ? ` → ${c.parent}` : ''}`
    const skip = (reason: string) => skipped.push({ label, reason })
    if (!c.parent) {
      skip('Links to any of several tables (many-to-any) are not checked')
      continue
    }
    if (SYSTEM.test(c.child)) continue // system tables keep their own integrity
    const parentIsSystem = SYSTEM.test(c.parent)
    const parentLower = c.parent.toLowerCase()
    if (
      parentIsSystem &&
      !FILE_TABLES.includes(parentLower) &&
      !USER_TABLES.includes(parentLower)
    ) {
      skip('Links into system tables other than people and files are not checked')
      continue
    }
    if (!IDENT.test(c.child) || !IDENT.test(c.field) || !IDENT.test(c.parent)) {
      skip('Name is not a plain table or column name')
      continue
    }
    const child = findName(facts.tables, c.child)
    if (!child) {
      skip(`Table ${c.child} does not exist`)
      continue
    }
    const parent = resolveParent(c.parent, facts.tables)
    if (!parent) {
      skip(`Table ${c.parent} does not exist`)
      continue
    }
    const cols = facts.tables.get(child) as Map<string, ColumnFact>
    const wanted = dbColumn.get(`${c.child}.${c.field}`.toLowerCase()) ?? c.field
    const fk = findName(cols, wanted)
    if (!fk || !IDENT.test(fk)) {
      skip(`Column ${child}.${wanted} does not exist`)
      continue
    }
    const childPk = facts.pk.get(child)
    if (!childPk) {
      skip(`${child} has no single-column key, so its rows cannot be named`)
      continue
    }
    const parentKey = facts.pk.get(parent) ?? findName(facts.tables.get(parent)!, 'id')
    if (!parentKey) {
      skip(`${parent} has no key to point at`)
      continue
    }
    const key = checkKey(child, fk, parent)
    if (seen.has(key)) continue
    seen.add(key)
    const fkCol = cols.get(fk) as ColumnFact
    const keyCol = facts.tables.get(parent)?.get(parentKey)
    const compare = keyCol ? compareMode(fkCol.type, keyCol.type, facts.mssql) : null
    if (!compare) {
      skip(`${child}.${fk} (${fkCol.type}) cannot be compared with ${parent}.${parentKey}`)
      continue
    }
    const kind: OrphanKind =
      c.kind !== 'junction' && FILE_TABLES.includes(parent.toLowerCase()) ? 'file' : c.kind
    checks.push({
      key,
      kind,
      child,
      fk,
      field: c.field,
      parent,
      parent_key: parentKey,
      child_pk: childPk,
      fk_nullable: fkCol.nullable,
      enforced: facts.enforced.has(`${child}.${fk}`.toLowerCase()),
      compare,
      text_fk: family(fkCol.type) === 'str',
      referenced_by: facts.referencedBy.get(child) ?? [],
      other_leg: c.other_leg
    })
  }
  checks.sort((a, b) => a.child.localeCompare(b.child) || a.fk.localeCompare(b.fk))
  return { checks, skipped }
}

/** The predicate "this row's link points at nothing", over alias `c`, with knex `??` bindings. */
export function orphanPredicate(check: OrphanCheck): { sql: string; bindings: string[] } {
  const value =
    check.compare === 'cast_bigint'
      ? 'TRY_CAST(c.?? AS BIGINT)'
      : check.compare === 'cast_guid'
        ? 'TRY_CAST(c.?? AS UNIQUEIDENTIFIER)'
        : 'c.??'
  const empty = check.text_fk ? " AND c.?? <> ''" : ''
  return {
    sql: `c.?? IS NOT NULL${empty} AND NOT EXISTS (SELECT 1 FROM ?? p WHERE p.?? = ${value})`,
    bindings: [
      check.fk,
      ...(check.text_fk ? [check.fk] : []),
      check.parent,
      check.parent_key,
      check.fk
    ]
  }
}

export function countSql(check: OrphanCheck): { sql: string; bindings: string[] } {
  const p = orphanPredicate(check)
  return {
    sql: `SELECT COUNT(*) AS n FROM ?? c WHERE ${p.sql}`,
    bindings: [check.child, ...p.bindings]
  }
}

export function sampleSql(
  check: OrphanCheck,
  limit: number,
  mssql: boolean
): { sql: string; bindings: Array<string | number> } {
  const p = orphanPredicate(check)
  const n = Math.max(1, Math.min(500, Math.floor(limit)))
  const top = mssql ? `TOP ${n} ` : ''
  const tail = mssql ? '' : ` LIMIT ${n}`
  return {
    sql: `SELECT ${top}c.?? AS row_id, c.?? AS fk_value FROM ?? c WHERE ${p.sql} ORDER BY c.?? DESC${tail}`,
    bindings: [check.child_pk, check.fk, check.child, ...p.bindings, check.child_pk]
  }
}

export type OrphanAction = 'clear' | 'delete'

/** Why an action may not run on a check, or null when it may. */
export function actionRefusal(check: OrphanCheck, action: OrphanAction): string | null {
  if (action === 'clear') {
    if (check.kind === 'junction')
      return 'A link-table row with one side missing is removed, not cleared'
    if (!check.fk_nullable) return `${check.child}.${check.fk} cannot be empty in the database`
    return null
  }
  if (check.kind !== 'junction') return 'Only link-table rows are deleted here'
  if (check.referenced_by.length > 0)
    return `Other tables point at these rows (${check.referenced_by.slice(0, 3).join(', ')}), so they are not deleted here`
  return null
}

/** The preview's fingerprint: apply runs only on exactly what was previewed. */
export function planHash(key: string, action: OrphanAction, ids: string[]): string {
  const sorted = [...new Set(ids.map(String))].sort()
  return createHash('sha256')
    .update(`${key}|${action}|${sorted.join(',')}`)
    .digest('hex')
    .slice(0, 32)
}

export const KIND_LABEL: Record<OrphanKind, string> = {
  m2o: 'Link to a missing record',
  o2m: 'Child whose parent is gone',
  junction: 'Link-table row with a side gone',
  file: 'File that no longer exists'
}
