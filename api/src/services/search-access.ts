/**
 * Access-aware candidate statements for global search (army 11 Q2-3).
 *
 * Every search pass takes the TOP n matching ids per collection and then reads them
 * AS THE CALLER (confirmRows → readItems). When the n best matches all sit outside a
 * person's User Scopes (the newest HN26 workflows are National; CJ sees Zones 1-3),
 * the read drops all of them and the answer says "Nothing matches" although the person
 * can read five other HN26 workflows. The fix is to judge access BEFORE the TOP: each
 * candidate statement carries `[id] IN (<the ids the caller may read>)`, built from
 * exactly the gates readItems applies on a read — the role's read row filter
 * (getRowFilter, none for administrators) and the restrict-mode User Scopes
 * (getUserScopeEnforcement, which binds administrators and API-key restrictions too).
 *
 * The clause only ever narrows candidates; confirmRows still reads every survivor as
 * the caller, so a clause that is wider than the real gate costs a row, never a leak.
 * Nothing to apply (no row filter, no scope) = no clause: the statement is unchanged.
 */
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { applyRowFilter, getRowFilter } from './permissions.js'
import { applyScopeEnforcement, getUserScopeEnforcement } from './user-scopes.js'

export interface AccessClause {
  /** A predicate on the outer row's id column (`?` bindings, in order). */
  sql: string
  bindings: unknown[]
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The clause that keeps only rows `user` may read, on `idExpr` (`[id]`, `t.[id]`).
 *  Null = nothing restricts this person here (the statement needs no clause). */
export async function searchAccessClause(
  user: User,
  collection: string,
  idExpr = '[id]'
): Promise<AccessClause | null> {
  if (!IDENT_RE.test(collection)) return null
  const [rowFilter, enforcement] = await Promise.all([
    getRowFilter(user, 'read', collection).catch(() => null),
    getUserScopeEnforcement(user, collection).catch(() => null)
  ])
  if (enforcement?.deny) return { sql: '1 = 0', bindings: [] }
  const scoped = (enforcement?.filters.length ?? 0) > 0
  if (!rowFilter && !scoped) return null
  try {
    const q = db(collection).select(`${collection}.id`)
    if (rowFilter) applyRowFilter(q, rowFilter, user)
    if (enforcement && scoped) applyScopeEnforcement(q, collection, enforcement)
    const built = q.toSQL()
    const dialect = String(
      (q as unknown as { client?: { config?: { client?: unknown } } }).client?.config?.client ?? ''
    )
    const { sql, bindings } = /mssql/i.test(dialect)
      ? jsonInLists(built.sql, [...built.bindings])
      : { sql: built.sql, bindings: [...built.bindings] }
    return { sql: `${idExpr} IN (${sql})`, bindings }
  } catch {
    // A gate that cannot compile here is still applied by the caller's read.
    return null
  }
}

/**
 * Every `in (?, ?, …)` list of two or more values → `IN (SELECT [value] FROM OPENJSON(?))`
 * with ONE bound JSON array (the whereInList pattern, services/db-batch.ts). The clause
 * rides in every collection's arm of one statement: a project-level scope of a few
 * hundred values bound value by value would pass SQL Server's ~2,100-parameter cap and
 * that whole pass would answer nothing (army 11 rev #6). Each value converts to the
 * column's type exactly as a bound parameter does. Exported for tests.
 */
export function jsonInLists(sql: string, bindings: unknown[]): AccessClause {
  const out: unknown[] = []
  let at = 0
  let text = ''
  let last = 0
  const re = /\?|\bin \((\?(?:, \?)+)\)/gi
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    if (m[0] === '?') {
      out.push(bindings[at++])
      continue
    }
    const n = (m[1].match(/\?/g) ?? []).length
    const values = bindings.slice(at, at + n)
    at += n
    text += `${sql.slice(last, m.index)}IN (SELECT [value] FROM OPENJSON(?))`
    last = m.index + m[0].length
    out.push(JSON.stringify(values.filter((v) => v != null).map(String)))
  }
  return { sql: text + sql.slice(last), bindings: out }
}

/** One clause per collection (in parallel; the gates are cached per person). */
export async function searchAccessClauses(
  user: User,
  collections: string[]
): Promise<Map<string, AccessClause | null>> {
  const out = new Map<string, AccessClause | null>()
  await Promise.all(
    collections.map(async (c) => {
      out.set(c, await searchAccessClause(user, c).catch(() => null))
    })
  )
  return out
}

/** `clause` re-pointed at another id expression (the typo pass reads `t.[id]`). */
export function onIdExpr(clause: AccessClause | null | undefined, idExpr: string) {
  if (!clause) return null
  return clause.sql.startsWith('[id] IN (')
    ? { sql: `${idExpr}${clause.sql.slice('[id]'.length)}`, bindings: clause.bindings }
    : clause
}

/** ` AND <clause>` for a WHERE, plus its bindings (both empty without a clause). */
export function andAccess(clause: AccessClause | null | undefined): {
  sql: string
  bindings: unknown[]
} {
  return clause
    ? { sql: ` AND ${clause.sql}`, bindings: clause.bindings }
    : { sql: '', bindings: [] }
}
