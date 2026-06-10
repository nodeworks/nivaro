import { db } from '../db/index.js'
import { getAncestors, getTreeConfig } from '../lib/tree.js'
import type { Role, User } from '../types.js'
import { isPathMaintained } from './tree-path.js'

/**
 * Tree-scoped permissions (nivaro_tree_permissions).
 *
 * Semantics:
 * - A row grants/denies a role an action on a node AND all of its descendants.
 * - The nearest matching ancestor (deepest node in the item's chain) wins; an
 *   explicit row on the item itself beats anything inherited.
 * - On the same node, an action-specific rule beats a '*' rule; remaining ties
 *   resolve to deny (allow=false wins).
 * - Tree permissions only further RESTRICT access on top of nivaro_policies —
 *   they never grant access a policy did not already allow. Callers must only
 *   act on an explicit `false` result.
 * - No rules for a collection (or no tree config) → feature inactive, callers
 *   see `null` and behave exactly as before.
 */

export type TreePermissionAction = 'read' | 'update' | 'delete'

interface TreePermissionRow {
  id: number
  collection: string
  node_id: string
  role: string
  action: string
  allow: boolean | number
}

// 60s TTL cache on the "does this collection have any tree permission rules"
// check — keeps the hot item read/update/delete paths at zero extra queries
// for the (common) collections without tree permissions.
const rulesExistCache = new Map<string, { exists: boolean; at: number }>()
const RULES_EXIST_TTL_MS = 60_000

/** Invalidate the rules-exist cache (called by the admin CRUD routes). */
export function clearTreePermissionCache(collection?: string): void {
  if (collection) rulesExistCache.delete(collection)
  else rulesExistCache.clear()
}

async function rulesExist(collection: string): Promise<boolean> {
  const hit = rulesExistCache.get(collection)
  if (hit && Date.now() - hit.at < RULES_EXIST_TTL_MS) return hit.exists
  let exists = false
  try {
    const row = await db('nivaro_tree_permissions').where({ collection }).first('id')
    exists = !!row
  } catch {
    // Table may not exist before migration 059 runs — feature inactive.
    exists = false
  }
  rulesExistCache.set(collection, { exists, at: Date.now() })
  return exists
}

function toBool(v: boolean | number): boolean {
  return v === true || v === 1
}

/**
 * Resolve the effective tree permission for a user + action on one item.
 *
 * Returns:
 * - `null`  — feature inactive for this collection (no tree config, no rules,
 *             admin user, or item/ancestry unresolvable). Caller behavior must
 *             be unchanged.
 * - `true`  — the winning rule allows. NOTE: this never grants beyond
 *             nivaro_policies; treat it the same as `null`.
 * - `false` — the winning rule denies → caller should reject.
 */
export async function getTreePermission(
  user: User,
  action: TreePermissionAction,
  collection: string,
  itemId: string | number
): Promise<boolean | null> {
  if (!user?.role) return null

  // Admin bypass — admins are never tree-restricted.
  try {
    const role = await db<Role>('nivaro_roles').where({ id: user.role }).first()
    if (!role || role.admin_access) return null
  } catch {
    return null
  }

  // Cheap cached gate first: most collections have no rules at all.
  if (!(await rulesExist(collection))) return null

  const config = await getTreeConfig(collection)
  if (!config) return null

  // Build the node chain root-first, item itself last.
  let chain: string[] | null = null

  if (isPathMaintained(config)) {
    try {
      const row = (await db(collection).where({ id: itemId }).first()) as
        | Record<string, unknown>
        | undefined
      const p = row?.path
      if (typeof p === 'string' && p.startsWith('/')) {
        chain = p.split('/').filter(Boolean)
      }
    } catch {
      chain = null
    }
  }

  if (!chain) {
    // Recursive-CTE fallback (OPTION (MAXRECURSION 100) inside getAncestors).
    try {
      const ancestors = await getAncestors(config, itemId)
      chain = ancestors.map((n) => String(n.id))
    } catch {
      return null
    }
  }

  if (!chain.length) return null

  const rules = (await db('nivaro_tree_permissions')
    .where({ collection, role: user.role })
    .whereIn('action', [action, '*'])
    .whereIn('node_id', chain)) as TreePermissionRow[]

  if (!rules.length) return null

  return resolveWinner(chain, rules)
}

/**
 * Deepest node wins; action-specific beats '*'; deny wins remaining ties.
 * Returns null when no rule sits on the chain.
 */
function resolveWinner(chain: string[], rules: TreePermissionRow[]): boolean | null {
  const depthOf = new Map<string, number>(chain.map((id, i) => [id, i]))
  let winner: TreePermissionRow | null = null
  for (const rule of rules) {
    const d = depthOf.get(String(rule.node_id))
    if (d === undefined) continue
    if (!winner) {
      winner = rule
      continue
    }
    const wd = depthOf.get(String(winner.node_id)) ?? -1
    if (d > wd) {
      winner = rule
    } else if (d === wd) {
      const ruleSpecific = rule.action !== '*'
      const winnerSpecific = winner.action !== '*'
      if (ruleSpecific && !winnerSpecific) winner = rule
      else if (ruleSpecific === winnerSpecific && !toBool(rule.allow)) winner = rule
    }
  }
  if (!winner) return null
  return toBool(winner.allow)
}

// Cap for loading a whole tree's parent pairs in one query when paths are not
// maintained. Beyond this, list-read enforcement falls back to per-row CTEs.
const PARENT_MAP_CAP = 10_000

/**
 * Batch tree-permission filter for LIST reads — drops rows the user's role is
 * denied on. Mirrors getTreePermission semantics with one rules query and one
 * ancestry resolution pass for the whole page instead of per-row walks.
 * Returns the input array unchanged when the feature is inactive.
 */
export async function filterRowsByTreePermissions(
  user: User,
  collection: string,
  rows: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  if (!rows.length || !user?.role) return rows

  try {
    const role = await db<Role>('nivaro_roles').where({ id: user.role }).first()
    if (!role || role.admin_access) return rows
  } catch {
    return rows
  }

  if (!(await rulesExist(collection))) return rows
  const config = await getTreeConfig(collection)
  if (!config) return rows

  const rules = (await db('nivaro_tree_permissions')
    .where({ collection, role: user.role })
    .whereIn('action', ['read', '*'])) as TreePermissionRow[]
  if (!rules.length) return rows

  // Resolve a root-first ancestor chain (item last) for every row.
  const chains = new Map<string, string[]>()
  const ids = rows.map((r) => String(r.id))

  if (isPathMaintained(config)) {
    // Prefer paths already on the rows; fetch the rest in one query.
    const missing: string[] = []
    for (const r of rows) {
      const p = r.path
      if (typeof p === 'string' && p.startsWith('/')) {
        chains.set(String(r.id), p.split('/').filter(Boolean))
      } else {
        missing.push(String(r.id))
      }
    }
    if (missing.length) {
      const fetched = (await db(collection).whereIn('id', missing).select('id', 'path')) as Array<{
        id: string | number
        path: string | null
      }>
      for (const f of fetched) {
        if (typeof f.path === 'string' && f.path.startsWith('/')) {
          chains.set(String(f.id), f.path.split('/').filter(Boolean))
        }
      }
    }
  } else {
    // Build chains from a single parent-map query (small/medium trees).
    const parentField = (config as { parent_field: string }).parent_field
    const pairs = (await db(collection)
      .select('id', parentField)
      .limit(PARENT_MAP_CAP + 1)) as Array<Record<string, unknown>>
    if (pairs.length > PARENT_MAP_CAP) {
      // Too large to map in memory — enforce per-row only for typical page sizes.
      if (rows.length <= 100) {
        const results = await Promise.all(
          rows.map((r) => getTreePermission(user, 'read', collection, r.id as string | number))
        )
        return rows.filter((_, i) => results[i] !== false)
      }
      return rows // documented limitation: huge tree + huge page skips enforcement
    }
    const parentOf = new Map<string, string | null>()
    for (const p of pairs) {
      const pv = p[parentField]
      parentOf.set(String(p.id), pv == null ? null : String(pv))
    }
    for (const id of ids) {
      const chain: string[] = []
      let cur: string | null = id
      let guard = 0
      while (cur && guard++ < 100) {
        chain.unshift(cur)
        cur = parentOf.get(cur) ?? null
      }
      chains.set(id, chain)
    }
  }

  return rows.filter((r) => {
    const chain = chains.get(String(r.id))
    if (!chain?.length) return true // unresolvable ancestry → unchanged behavior
    return resolveWinner(chain, rules) !== false
  })
}
