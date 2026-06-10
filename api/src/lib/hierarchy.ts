import { db } from '../db/index.js'

export interface HierarchyLevel {
  collection: string
  label_field: string
  // M2O: column on THIS collection pointing to parent level's id. null = root or M2M.
  parent_fk: string | null
  // M2M via junction table (all three must be set together):
  junction_table?: string | null
  junction_child_fk?: string | null // junction col → this level's collection.id
  junction_parent_fk?: string | null // junction col → parent level's collection.id
}

export interface HierarchyConfig {
  id: number
  name: string
  description: string | null
  levels: HierarchyLevel[]
  created_at: Date
  created_by: string | number | null
}

export interface HierarchyNode {
  id: number | string
  collection: string
  label: string
  level_index: number
  parent_id: number | string | null
  parent_collection: string | null
  raw: Record<string, unknown>
  children: HierarchyNode[]
}

export interface FlatHierarchyNode {
  id: number | string
  collection: string
  label: string
  level_index: number
  parent_id: number | string | null
  parent_collection: string | null
  raw: Record<string, unknown>
}

function isM2M(level: HierarchyLevel): boolean {
  return !!(level.junction_table && level.junction_child_fk && level.junction_parent_fk)
}

function parseLevels(value: unknown): HierarchyLevel[] {
  if (Array.isArray(value)) return value as HierarchyLevel[]
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? (parsed as HierarchyLevel[]) : []
    } catch {
      return []
    }
  }
  return []
}

export function parseConfig(row: Record<string, unknown>): HierarchyConfig {
  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    description: (row.description as string | null) ?? null,
    levels: parseLevels(row.levels),
    created_at: row.created_at as Date,
    created_by: (row.created_by as string | number | null) ?? null
  }
}

export async function getHierarchyConfig(id: number): Promise<HierarchyConfig | null> {
  const row = await db('nivaro_hierarchy_configs').where({ id }).first<Record<string, unknown>>()
  return row ? parseConfig(row) : null
}

export async function listHierarchyConfigs(): Promise<HierarchyConfig[]> {
  const rows = await db('nivaro_hierarchy_configs').orderBy('id', 'asc')
  return (rows as Record<string, unknown>[]).map(parseConfig)
}

function levelIndexOf(config: HierarchyConfig, collection: string): number {
  return config.levels.findIndex((l) => l.collection === collection)
}

function toFlatNode(
  row: Record<string, unknown>,
  level: HierarchyLevel,
  levelIndex: number,
  parentCollection: string | null,
  parentIdOverride?: number | string | null
): FlatHierarchyNode {
  // parentIdOverride is used for M2M rows where parent_id comes from the junction row.
  const parentId =
    parentIdOverride !== undefined
      ? parentIdOverride
      : level.parent_fk != null && row[level.parent_fk] != null
        ? (row[level.parent_fk] as number | string)
        : null
  return {
    id: row.id as number | string,
    collection: level.collection,
    label: String(row[level.label_field] ?? ''),
    level_index: levelIndex,
    parent_id: parentId,
    parent_collection: parentId != null ? parentCollection : null,
    raw: row
  }
}

/** Fetch flat nodes for one level. For M2M levels, each junction row produces a separate node entry. */
async function fetchLevelNodes(
  level: HierarchyLevel,
  levelIndex: number,
  parentCollection: string | null
): Promise<FlatHierarchyNode[]> {
  if (isM2M(level)) {
    // JOIN collection with junction; each junction row → one node (duplicates allowed for M2M).
    const jt = level.junction_table as string
    const jcfk = level.junction_child_fk as string
    const jpfk = level.junction_parent_fk as string

    const rows = (await db(level.collection)
      .join(jt, `${level.collection}.id`, `${jt}.${jcfk}`)
      .select(`${level.collection}.*`, db.raw(`${jt}.${jpfk} as __junction_parent_id`))) as Record<
      string,
      unknown
    >[]

    return rows.map((row) => {
      const parentId = row.__junction_parent_id as number | string | null
      // Strip the injected column from raw so it doesn't leak into response
      const { __junction_parent_id, ...rawClean } = row
      void __junction_parent_id
      return toFlatNode(rawClean, level, levelIndex, parentCollection, parentId)
    })
  }

  // M2O or root
  const rows = (await db(level.collection).select('*')) as Record<string, unknown>[]
  return rows.map((row) => toFlatNode(row, level, levelIndex, parentCollection))
}

export async function getHierarchyNodes(config: HierarchyConfig): Promise<FlatHierarchyNode[]> {
  const all: FlatHierarchyNode[] = []
  for (let i = 0; i < config.levels.length; i++) {
    const level = config.levels[i]
    const parentCollection = i > 0 ? config.levels[i - 1].collection : null
    const nodes = await fetchLevelNodes(level, i, parentCollection)
    all.push(...nodes)
  }
  return all
}

export async function getHierarchyTree(config: HierarchyConfig): Promise<HierarchyNode[]> {
  if (config.levels.length === 0) return []

  const byLevel: HierarchyNode[][] = []
  for (let i = 0; i < config.levels.length; i++) {
    const level = config.levels[i]
    const parentCollection = i > 0 ? config.levels[i - 1].collection : null
    const flatNodes = await fetchLevelNodes(level, i, parentCollection)
    byLevel[i] = flatNodes.map((n) => ({ ...n, children: [] }))
  }

  // Stitch children to parents. For M2M a child may appear under multiple parents (intentional).
  for (let i = config.levels.length - 1; i > 0; i--) {
    const parentMap = new Map<string, HierarchyNode>()
    for (const parent of byLevel[i - 1]) {
      parentMap.set(String(parent.id), parent)
    }
    for (const node of byLevel[i]) {
      if (node.parent_id == null) continue
      const parent = parentMap.get(String(node.parent_id))
      if (parent) parent.children.push(node)
    }
  }

  return byLevel[0]
}

export async function getNodeChildren(
  config: HierarchyConfig,
  nodeCollection: string,
  nodeId: number | string
): Promise<FlatHierarchyNode[]> {
  const idx = levelIndexOf(config, nodeCollection)
  if (idx === -1) return []
  const childIdx = idx + 1
  if (childIdx >= config.levels.length) return []

  const childLevel = config.levels[childIdx]

  if (isM2M(childLevel)) {
    const jt = childLevel.junction_table as string
    const jcfk = childLevel.junction_child_fk as string
    const jpfk = childLevel.junction_parent_fk as string

    const rows = (await db(childLevel.collection)
      .join(jt, `${childLevel.collection}.id`, `${jt}.${jcfk}`)
      .where(`${jt}.${jpfk}`, nodeId)
      .select(`${childLevel.collection}.*`)) as Record<string, unknown>[]

    return rows.map((row) => toFlatNode(row, childLevel, childIdx, nodeCollection, nodeId))
  }

  if (!childLevel.parent_fk) return []
  const rows = (await db(childLevel.collection)
    .where({ [childLevel.parent_fk]: nodeId })
    .select('*')) as Record<string, unknown>[]

  return rows.map((row) => toFlatNode(row, childLevel, childIdx, nodeCollection))
}

export async function getNodeAncestors(
  config: HierarchyConfig,
  nodeCollection: string,
  nodeId: number | string
): Promise<FlatHierarchyNode[]> {
  let idx = levelIndexOf(config, nodeCollection)
  if (idx <= 0) return []

  const level = config.levels[idx]
  const startRow = (await db(level.collection).where({ id: nodeId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!startRow) return []

  // For M2M: resolve parent_id via junction (first match — breadcrumbs pick one path)
  async function resolveParentId(
    lvl: HierarchyLevel,
    childId: number | string
  ): Promise<number | string | null> {
    if (isM2M(lvl)) {
      const jt = lvl.junction_table as string
      const jcfk = lvl.junction_child_fk as string
      const jpfk = lvl.junction_parent_fk as string
      const jrow = (await db(jt)
        .where({ [jcfk]: childId })
        .first()) as Record<string, unknown> | undefined
      return jrow ? (jrow[jpfk] as number | string) : null
    }
    const row = (await db(lvl.collection).where({ id: childId }).first()) as
      | Record<string, unknown>
      | undefined
    return row && lvl.parent_fk ? (row[lvl.parent_fk] as number | string | null) : null
  }

  const ancestors: FlatHierarchyNode[] = []
  let currentId: number | string = nodeId

  while (idx > 0) {
    const parentId = await resolveParentId(config.levels[idx], currentId)
    if (parentId == null) break

    const parentIdx = idx - 1
    const parentLevel = config.levels[parentIdx]
    const grandparentCollection = parentIdx > 0 ? config.levels[parentIdx - 1].collection : null

    const parentRow = (await db(parentLevel.collection).where({ id: parentId }).first()) as
      | Record<string, unknown>
      | undefined
    if (!parentRow) break

    ancestors.push(toFlatNode(parentRow, parentLevel, parentIdx, grandparentCollection))
    idx = parentIdx
    currentId = parentId
  }

  ancestors.reverse()
  return ancestors
}
