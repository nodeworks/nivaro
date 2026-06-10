import { db } from '../db/index.js'

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
  const tbl = safeIdent(config.collection)
  const parentCol = safeIdent(config.parent_field)

  const bindings: (string | number)[] = []

  let anchorWhere: string
  if (opts?.rootId != null) {
    anchorWhere = 'WHERE id = ?'
    bindings.push(opts.rootId as string | number)
  } else {
    anchorWhere = `WHERE ${parentCol} IS NULL`
  }

  const depthFilter = opts?.maxDepth != null ? `AND t.[__depth] < ${Number(opts.maxDepth)}` : ''

  const sql = `
    WITH tree AS (
      SELECT *, 0 AS [__depth]
      FROM ${tbl}
      ${anchorWhere}
      UNION ALL
      SELECT c.*, t.[__depth] + 1
      FROM ${tbl} c
      INNER JOIN tree t ON c.${parentCol} = t.id
      ${depthFilter}
    )
    SELECT * FROM tree
    ORDER BY [__depth], id
    OPTION (MAXRECURSION 100)
  `

  const rows = await db.raw<Record<string, unknown>[]>(sql, bindings)

  return (rows as unknown as Record<string, unknown>[]).map((row) =>
    toFlatNode(row, config.label_field)
  )
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
  const tbl = safeIdent(config.collection)
  const parentCol = safeIdent(config.parent_field)

  const sql = `
    WITH ancestors AS (
      SELECT *, 0 AS [__depth]
      FROM ${tbl}
      WHERE id = ?
      UNION ALL
      SELECT p.*, a.[__depth] - 1
      FROM ${tbl} p
      INNER JOIN ancestors a ON p.id = a.${parentCol}
    )
    SELECT * FROM ancestors
    ORDER BY [__depth] ASC
    OPTION (MAXRECURSION 100)
  `

  const rows = await db.raw<Record<string, unknown>[]>(sql, [itemId] as (string | number)[])

  const mapped = (rows as unknown as Record<string, unknown>[]).map((row) =>
    toFlatNode(row, config.label_field)
  )

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
  const tbl = safeIdent(config.collection)
  const parentCol = safeIdent(config.parent_field)

  const depthFilter = opts?.maxDepth != null ? `AND t.[__depth] < ${Number(opts.maxDepth)}` : ''

  const sql = `
    WITH descendants AS (
      SELECT *, 0 AS [__depth]
      FROM ${tbl}
      WHERE id = ?
      UNION ALL
      SELECT c.*, t.[__depth] + 1
      FROM ${tbl} c
      INNER JOIN descendants t ON c.${parentCol} = t.id
      ${depthFilter}
    )
    SELECT * FROM descendants
    WHERE [__depth] > 0
    ORDER BY [__depth], id
    OPTION (MAXRECURSION 100)
  `

  const rows = await db.raw<Record<string, unknown>[]>(sql, [itemId] as (string | number)[])

  return (rows as unknown as Record<string, unknown>[]).map((row) =>
    toFlatNode(row, config.label_field)
  )
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
  newParentId: unknown | null
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

  await db(config.collection)
    .where({ id: itemId })
    .update({ [config.parent_field]: newParentId ?? null })
}
