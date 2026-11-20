import { db } from '../db/index.js'
import { qi, sqlDialect } from '../db/sql-dialect.js'
import { safeIdent as safeMssqlIdent, type TreeConfig } from '../lib/tree.js'

/** A validated identifier, quoted for the database this API runs on. */
function safeIdent(s: string): string {
  safeMssqlIdent(s)
  return qi(db, s)
}

/**
 * Breadcrumb path maintenance for same-collection trees.
 *
 * When a tree config has `maintain_path=true`, the target collection table gets
 * two physical columns:
 *   - `path`  nvarchar(900) — id-based materialized path: `/rootId/parentId/selfId`
 *   - `depth` int           — 0 for roots, +1 per level
 *
 * Paths are built from IDs (not labels) so renames never rewrite subtrees.
 */

/** Tree config row including the migration-059 flag (lib/tree.ts type predates it). */
export interface PathTreeConfig extends TreeConfig {
  maintain_path?: boolean | number | null
}

/** Normalize the MSSQL bit / boolean round-trip. */
export function isPathMaintained(config: PathTreeConfig | TreeConfig | null | undefined): boolean {
  if (!config) return false
  const v = (config as PathTreeConfig).maintain_path
  return v === true || v === 1
}

/**
 * Add `path` + `depth` columns to the collection table when missing.
 * Separate ALTER statements (MSSQL does not support multiple ADDs reliably
 * across drivers, and we only run the ones actually needed).
 */
export async function ensurePathColumns(collection: string): Promise<void> {
  const tbl = safeIdent(collection)
  const info = await db(collection).columnInfo()
  if (sqlDialect(db) !== 'mssql') {
    if (!('path' in info))
      await db.schema.alterTable(collection, (t) => {
        t.string('path', 900).nullable()
      })
    if (!('depth' in info))
      await db.schema.alterTable(collection, (t) => {
        t.integer('depth').nullable()
      })
    return
  }
  if (!('path' in info)) {
    await db.raw(`ALTER TABLE ${tbl} ADD [path] nvarchar(900) NULL`)
  }
  if (!('depth' in info)) {
    await db.raw(`ALTER TABLE ${tbl} ADD [depth] int NULL`)
  }
}

/**
 * Full rebuild: recompute `path` + `depth` for every row from the roots down.
 * Stale values are cleared first so orphaned/cyclic rows end up NULL instead of
 * keeping outdated paths. Uses an MSSQL UPDATE-from-CTE, guarded by
 * OPTION (MAXRECURSION 100).
 */
export async function rebuildPaths(collection: string, config: TreeConfig): Promise<void> {
  const tbl = safeIdent(collection)
  const parentCol = safeIdent(config.parent_field)

  const dialect = sqlDialect(db)
  await db.raw(`UPDATE ${tbl} SET ${qi(db, 'path')} = NULL, ${qi(db, 'depth')} = NULL`)

  if (dialect !== 'mssql') {
    await db.raw(recursivePathSql(dialect, tbl, parentCol, 'roots'))
    return
  }

  const sql = `
    WITH tree AS (
      SELECT id,
             CAST('/' + CAST(id AS nvarchar(100)) AS nvarchar(900)) AS [__path],
             0 AS [__depth]
      FROM ${tbl}
      WHERE ${parentCol} IS NULL
      UNION ALL
      SELECT c.id,
             CAST(t.[__path] + '/' + CAST(c.id AS nvarchar(100)) AS nvarchar(900)),
             t.[__depth] + 1
      FROM ${tbl} c
      INNER JOIN tree t ON c.${parentCol} = t.id
    )
    UPDATE x
    SET x.[path] = t.[__path], x.[depth] = t.[__depth]
    FROM ${tbl} x
    INNER JOIN tree t ON x.id = t.id
    OPTION (MAXRECURSION 100)
  `
  await db.raw(sql)
}

/**
 * Recompute `path` + `depth` for a node and all its descendants after a
 * reparent. Computes the node's new path from its (already updated) parent,
 * then does the classic prefix-replace UPDATE:
 *   path = newPrefix + SUBSTRING(path, LEN(oldPrefix)+1, ...)
 *   WHERE path = oldPrefix OR path LIKE oldPrefix + '/%'
 * Falls back to an anchored recursive CTE when the node has no stored path
 * yet, and to a full rebuild when the parent chain is missing path data.
 *
 * Note: the LIKE prefix is safe unescaped because paths are built from ids
 * (ints/uuids) which never contain LIKE wildcard characters.
 */
export async function updateSubtreePaths(
  collection: string,
  config: TreeConfig,
  nodeId: string | number
): Promise<void> {
  const tbl = safeIdent(collection)
  const parentCol = safeIdent(config.parent_field)

  await ensurePathColumns(collection)

  const node = (await db(collection).where({ id: nodeId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!node) return

  const parentId = node[config.parent_field]
  let newPath: string
  let newDepth: number

  if (parentId == null) {
    newPath = `/${nodeId}`
    newDepth = 0
  } else {
    const parent = (await db(collection).where({ id: parentId }).first()) as
      | Record<string, unknown>
      | undefined
    if (!parent) return
    if (parent.path == null || parent.depth == null) {
      // Parent chain has no path data — repair everything in one pass.
      await rebuildPaths(collection, config)
      return
    }
    newPath = `${parent.path}/${nodeId}`
    newDepth = Number(parent.depth) + 1
  }

  const oldPath = typeof node.path === 'string' ? node.path : null

  if (oldPath) {
    const oldDepth = Number(node.depth ?? 0)
    const dialect = sqlDialect(db)
    if (dialect !== 'mssql') {
      const p = qi(db, 'path')
      const d = qi(db, 'depth')
      const concatQ = dialect === 'mysql' ? "CONCAT(?, '/%')" : "(CAST(? AS TEXT) || '/%')"
      const head = dialect === 'mysql' ? '?' : 'CAST(? AS TEXT)'
      const setPath =
        dialect === 'mysql'
          ? `${p} = CONCAT(?, SUBSTRING(${p}, ?, 900))`
          : `${p} = (${head} || SUBSTRING(${p}, CAST(? AS INTEGER), 900))`
      await db.raw(
        `UPDATE ${tbl}
       SET ${setPath},
           ${d} = ${d} - ? + ?
       WHERE ${p} = ? OR ${p} LIKE ${concatQ}`,
        [newPath, oldPath.length + 1, oldDepth, newDepth, oldPath, oldPath]
      )
      return
    }
    await db.raw(
      `UPDATE ${tbl}
       SET [path] = ? + SUBSTRING([path], ?, 900),
           [depth] = [depth] - ? + ?
       WHERE [path] = ? OR [path] LIKE ? + '/%'`,
      [newPath, oldPath.length + 1, oldDepth, newDepth, oldPath, oldPath]
    )
    return
  }

  // Node never had a path — compute the subtree from scratch, anchored at it.
  const anchorDialect = sqlDialect(db)
  if (anchorDialect !== 'mssql') {
    await db.raw(recursivePathSql(anchorDialect, tbl, parentCol, 'anchor'), [
      newPath,
      newDepth,
      nodeId
    ])
    return
  }
  const sql = `
    WITH tree AS (
      SELECT id, CAST(? AS nvarchar(900)) AS [__path], CAST(? AS int) AS [__depth]
      FROM ${tbl}
      WHERE id = ?
      UNION ALL
      SELECT c.id,
             CAST(t.[__path] + '/' + CAST(c.id AS nvarchar(100)) AS nvarchar(900)),
             t.[__depth] + 1
      FROM ${tbl} c
      INNER JOIN tree t ON c.${parentCol} = t.id
    )
    UPDATE x
    SET x.[path] = t.[__path], x.[depth] = t.[__depth]
    FROM ${tbl} x
    INNER JOIN tree t ON x.id = t.id
    OPTION (MAXRECURSION 100)
  `
  await db.raw(sql, [newPath, newDepth, nodeId])
}

/**
 * Postgres / MySQL form of the path rebuild: a recursive CTE walked from the roots (or from one
 * anchored node, with its path + depth bound), written back with the dialect's UPDATE-join.
 * Depth is capped at 100 like SQL Server's MAXRECURSION.
 */
function recursivePathSql(
  dialect: 'pg' | 'mysql',
  tbl: string,
  parentCol: string,
  mode: 'roots' | 'anchor'
): string {
  const p = (c: string) => (dialect === 'pg' ? `"${c}"` : `\`${c}\``)
  const seed =
    mode === 'roots'
      ? dialect === 'pg'
        ? `SELECT id, CAST('/' || CAST(id AS VARCHAR(100)) AS VARCHAR(900)) AS ${p('__path')}, 0 AS ${p('__depth')} FROM ${tbl} WHERE ${parentCol} IS NULL`
        : `SELECT id, CAST(CONCAT('/', id) AS CHAR(900)) AS ${p('__path')}, 0 AS ${p('__depth')} FROM ${tbl} WHERE ${parentCol} IS NULL`
      : dialect === 'pg'
        ? `SELECT id, CAST(? AS VARCHAR(900)) AS ${p('__path')}, CAST(? AS INTEGER) AS ${p('__depth')} FROM ${tbl} WHERE id = ?`
        : `SELECT id, CAST(? AS CHAR(900)) AS ${p('__path')}, CAST(? AS SIGNED) AS ${p('__depth')} FROM ${tbl} WHERE id = ?`
  const step =
    dialect === 'pg'
      ? `CAST(t.${p('__path')} || '/' || CAST(c.id AS VARCHAR(100)) AS VARCHAR(900))`
      : `CAST(CONCAT(t.${p('__path')}, '/', c.id) AS CHAR(900))`
  const cte = `WITH RECURSIVE tree AS (
      ${seed}
      UNION ALL
      SELECT c.id, ${step}, t.${p('__depth')} + 1
      FROM ${tbl} c
      INNER JOIN tree t ON c.${parentCol} = t.id
      WHERE t.${p('__depth')} < 100
    )`
  const path = p('path')
  const depth = p('depth')
  if (dialect === 'pg')
    return `${cte}
    UPDATE ${tbl} AS x
    SET ${path} = t.${p('__path')}, ${depth} = t.${p('__depth')}
    FROM tree t
    WHERE x.id = t.id`
  return `${cte}
    UPDATE ${tbl} x
    INNER JOIN tree t ON x.id = t.id
    SET x.${path} = t.${p('__path')}, x.${depth} = t.${p('__depth')}`
}
