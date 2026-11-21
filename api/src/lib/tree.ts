import { db } from '../db/index.js'
import { rawRows } from '../db/raw-rows.js'
import { qi, sqlDialect } from '../db/sql-dialect.js'
import { withBooleanColumns } from '../services/boolean-filter.js'

export interface TreeConfig {
  id: number
  collection: string
  parent_field: string
  label_field: string
  order_field: string | null
}

export interface FlatNode extends Record<string, unknown> {
  id: unknown
  depth: number
  label: string
}

export interface NestedNode extends FlatNode {
  children: NestedNode[]
}

/** Validate an identifier is safe to embed in raw SQL and return it bracket-quoted. */
export function safeIdent(s: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(s)) {
    throw Object.assign(new Error('Invalid identifier'), { statusCode: 400 })
  }
  return `[${s}]`
}

/** A depth cap that reaches raw SQL: a whole number 0–100, else a 400 (never `< NaN`). */
export function parseMaxDepth(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 100) {
    throw Object.assign(new Error('maxDepth must be a whole number from 0 to 100'), {
      statusCode: 400
    })
  }
  return n
}

/** SQL Server keeps its exact statements (brackets, OPTION (MAXRECURSION 100)); Postgres, MySQL,
 *  MariaDB and SQLite run the same recursive CTE with their own quoting, WITH RECURSIVE, and a
 *  depth stop at 100 in the recursive member instead of MAXRECURSION (a cycle in the data would
 *  otherwise recurse for ever on Postgres / SQLite). */
function treeSql() {
  const mssql = sqlDialect(db) === 'mssql'
  const id = (name: string) => (mssql ? safeIdent(name) : qi(db, checkedIdent(name)))
  return {
    mssql,
    id,
    depth: mssql ? '[__depth]' : qi(db, '__depth'),
    with: mssql ? 'WITH' : 'WITH RECURSIVE',
    option: mssql ? 'OPTION (MAXRECURSION 100)' : '',
    /** Off SQL Server: ` AND <alias>.__depth < 100` / `> -100` in the recursive member. */
    cap: (alias: string, up = false) =>
      mssql ? '' : ` AND ${alias}.${qi(db, '__depth')} ${up ? '> -100' : '< 100'}`
  }
}

function checkedIdent(s: string): string {
  safeIdent(s)
  return s
}

function depthClause(maxDepth: number | undefined, depth = '[__depth]'): string {
  const n = parseMaxDepth(maxDepth)
  return n != null ? `AND t.${depth} < ${n}` : ''
}

/** Fetch the tree config for a collection, or null if not found. */
export async function getTreeConfig(collection: string): Promise<TreeConfig | null> {
  const row = await db('nivaro_tree_configs').where({ collection }).first<TreeConfig>()
  return row ?? null
}

function toFlatNode(row: Record<string, unknown>, labelField: string): FlatNode {
  const node: FlatNode = {
    ...row,
    id: row.id,
    depth: Number(row.__depth ?? 0),
    label: String(row[labelField] ?? '')
  }
  return node
}

/**
 * Return a flat list of nodes via a recursive CTE.
 * Each node gets `depth` and `label` fields added.
 */
export async function getNodes(
  config: TreeConfig,
  opts?: { rootId?: unknown; maxDepth?: number }
): Promise<FlatNode[]> {
  const q = treeSql()
  const tbl = q.id(config.collection)
  const parentCol = q.id(config.parent_field)
  const dep = q.depth

  const bindings: (string | number)[] = []

  let anchorWhere: string
  if (opts?.rootId != null) {
    anchorWhere = 'WHERE id = ?'
    bindings.push(opts.rootId as string | number)
  } else {
    anchorWhere = `WHERE ${parentCol} IS NULL`
  }

  const depthFilter = depthClause(opts?.maxDepth, dep)

  const sql = `
    ${q.with} tree AS (
      SELECT *, 0 AS ${dep}
      FROM ${tbl}
      ${anchorWhere}
      UNION ALL
      SELECT c.*, t.${dep} + 1
      FROM ${tbl} c
      INNER JOIN tree t ON c.${parentCol} = t.id${q.cap('t')}
      ${depthFilter}
    )
    SELECT * FROM tree
    ORDER BY ${dep}, id
    ${q.option}
  `

  const rows = await withBooleanColumns(
    config.collection,
    rawRows<Record<string, unknown>>(await db.raw(sql, bindings))
  )

  return rows.map((row) => toFlatNode(row, config.label_field))
}

/** Convert a flat node list (from getNodes) into a nested tree. */
export function nestNodes(flat: FlatNode[], parentField: string): NestedNode[] {
  const map = new Map<unknown, NestedNode>()
  const roots: NestedNode[] = []

  for (const node of flat) {
    map.set(node.id, { ...node, children: [] })
  }

  for (const node of flat) {
    const nested = map.get(node.id)!
    const parentId = node[parentField]

    if (parentId == null || !map.has(parentId)) {
      roots.push(nested)
    } else {
      const parent = map.get(parentId)
      if (parent) {
        parent.children.push(nested)
      } else {
        roots.push(nested)
      }
    }
  }

  return roots
}

/** Return a nested tree, optionally rooted at a specific node. */
export async function getNestedTree(
  config: TreeConfig,
  opts?: { rootId?: unknown }
): Promise<NestedNode[]> {
  const flat = await getNodes(config, opts)
  return nestNodes(flat, config.parent_field)
}

/**
 * Return the ancestor chain for an item, root-first.
 * Uses a bottom-up CTE (negative depth), then sorts ascending.
 */
export async function getAncestors(config: TreeConfig, itemId: unknown): Promise<FlatNode[]> {
  const q = treeSql()
  const tbl = q.id(config.collection)
  const parentCol = q.id(config.parent_field)
  const dep = q.depth

  const sql = `
    ${q.with} ancestors AS (
      SELECT *, 0 AS ${dep}
      FROM ${tbl}
      WHERE id = ?
      UNION ALL
      SELECT p.*, a.${dep} - 1
      FROM ${tbl} p
      INNER JOIN ancestors a ON p.id = a.${parentCol}${q.cap('a', true)}
    )
    SELECT * FROM ancestors
    ORDER BY ${dep} ASC
    ${q.option}
  `

  const rows = await withBooleanColumns(
    config.collection,
    rawRows<Record<string, unknown>>(await db.raw(sql, [itemId] as (string | number)[]))
  )

  const mapped = rows.map((row) => toFlatNode(row, config.label_field))

  // Rows are ordered by __depth ASC; most negative = root is already first
  mapped.sort((a, b) => (a.depth as number) - (b.depth as number))

  return mapped
}

/**
 * Return all descendants of an item (excluding the item itself).
 * Optionally limited to maxDepth levels below the item.
 */
export async function getDescendants(
  config: TreeConfig,
  itemId: unknown,
  opts?: { maxDepth?: number }
): Promise<FlatNode[]> {
  const q = treeSql()
  const tbl = q.id(config.collection)
  const parentCol = q.id(config.parent_field)
  const dep = q.depth

  const depthFilter = depthClause(opts?.maxDepth, dep)

  const sql = `
    ${q.with} descendants AS (
      SELECT *, 0 AS ${dep}
      FROM ${tbl}
      WHERE id = ?
      UNION ALL
      SELECT c.*, t.${dep} + 1
      FROM ${tbl} c
      INNER JOIN descendants t ON c.${parentCol} = t.id${q.cap('t')}
      ${depthFilter}
    )
    SELECT * FROM descendants
    WHERE ${dep} > 0
    ORDER BY ${dep}, id
    ${q.option}
  `

  const rows = await withBooleanColumns(
    config.collection,
    rawRows<Record<string, unknown>>(await db.raw(sql, [itemId] as (string | number)[]))
  )

  return rows.map((row) => toFlatNode(row, config.label_field))
}

/** Return the direct children of a node (or root-level nodes if parentId is null). */
export async function getChildren(config: TreeConfig, parentId: unknown): Promise<FlatNode[]> {
  const parentCol = config.parent_field

  let query = db(config.collection)
  if (parentId == null) {
    query = query.whereNull(parentCol)
  } else {
    query = query.where({ [parentCol]: parentId })
  }

  const rows = (await query) as Record<string, unknown>[]

  return rows.map((row) => ({
    ...row,
    id: row.id,
    depth: 0,
    label: String(row[config.label_field] ?? '')
  }))
}

/** Check whether targetId is a descendant of potentialAncestorId (for cycle detection). */
export async function isDescendantOf(
  config: TreeConfig,
  targetId: unknown,
  potentialAncestorId: unknown
): Promise<boolean> {
  const ancestors = await getAncestors(config, targetId)
  return ancestors.some((n) => String(n.id) === String(potentialAncestorId))
}

/**
 * Move a node to a new parent.
 * Prevents cycles and self-parenting.
 */
export async function moveNode(
  config: TreeConfig,
  itemId: unknown,
  newParentId: unknown | null,
  /** How the parent field is written — routes pass the items service as the caller. */
  write: (id: unknown, patch: Record<string, unknown>) => Promise<unknown> = (id, patch) =>
    db(config.collection).where({ id }).update(patch)
): Promise<void> {
  if (newParentId != null && String(itemId) === String(newParentId)) {
    throw Object.assign(new Error('A node cannot be its own parent'), { statusCode: 400 })
  }

  if (newParentId != null) {
    const cycle = await isDescendantOf(config, newParentId, itemId)
    if (cycle) {
      throw Object.assign(new Error('Cannot move a node to one of its own descendants'), {
        statusCode: 400
      })
    }
  }

  await write(itemId, { [config.parent_field]: newParentId ?? null })
}
