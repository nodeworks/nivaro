import type { Knex } from 'knex'
import type { User } from '../types.js'
import { applyRowFilter, getRowFilter, type RowCondition } from './permissions.js'
import {
  applyScopeEnforcement,
  getUserScopeEnforcement,
  type ScopeEnforcement
} from './user-scopes.js'

/**
 * Relation sub-filters are judged as the caller (army 6 H12, b15 filter oracle).
 *
 * A filter is a read: `vendors?filter={"workflows":{"_some":{"id":{"_eq":X},
 * "requisition_amount":{"_gt":274000}}}}` answers whether a workflow the caller
 * may not open holds more than 274,000 — a binary search recovered an
 * out-of-scope amount to the cent. Every EXISTS a filter or condition compiles
 * into another collection (M2O target, O2M child, M2M far row, a condition
 * hop) therefore carries that collection's read row filter and the caller's
 * User Scopes, exactly as reading the rows directly would (and as the b15-N1
 * M2O expansion fix does). The root collection is gated by the read itself.
 *
 * The compiler is synchronous, so the gate is primed first (`prime`) for every
 * collection the filter reaches; `apply` then only adds SQL. A collection the
 * gate was never primed for matches NOTHING — a walk that missed a hop fails
 * closed, never open.
 */

export interface FilterScopeGateDeps {
  scope(user: User, collection: string): Promise<ScopeEnforcement>
  rowFilter(user: User, collection: string): Promise<RowCondition[] | null>
}

const defaultDeps: FilterScopeGateDeps = {
  scope: (user, collection) => getUserScopeEnforcement(user, collection),
  rowFilter: (user, collection) => getRowFilter(user, 'read', collection)
}

interface Primed {
  scope: ScopeEnforcement
  rowFilter: RowCondition[] | null
}

/** Whether a primed entry narrows anything (no SQL is added when it does not). */
function restricts(p: Primed): boolean {
  return p.scope.deny || p.scope.filters.length > 0 || (p.rowFilter?.length ?? 0) > 0
}

export interface FilterScopeGate {
  /** Load the caller's gates for these collections (idempotent, cached per gate). */
  prime(collections: Iterable<string>): Promise<void>
  /** Narrow a sub-query over `collection` to the rows the caller may read. */
  apply(q: Knex.QueryBuilder, collection: string): void
  /** True when `collection` was primed and narrows nothing (no EXISTS wrapper needed). */
  isOpen(collection: string): boolean
}

export function createFilterScopeGate(
  user: User,
  deps: FilterScopeGateDeps = defaultDeps
): FilterScopeGate {
  const primed = new Map<string, Primed>()
  const key = (c: string) => c.toLowerCase()
  return {
    async prime(collections) {
      const todo = [...new Set([...collections].filter((c) => c && !primed.has(key(c))))]
      await Promise.all(
        todo.map(async (c) => {
          const [scope, rowFilter] = await Promise.all([
            deps.scope(user, c),
            deps.rowFilter(user, c)
          ])
          primed.set(key(c), { scope, rowFilter })
        })
      )
    },
    apply(q, collection) {
      const p = primed.get(key(collection))
      if (!p) {
        void q.whereRaw('1 = 0')
        return
      }
      if (!restricts(p)) return
      if (p.rowFilter?.length) applyRowFilter(q, p.rowFilter, user)
      applyScopeEnforcement(q, collection, p.scope)
    },
    isOpen(collection) {
      const p = primed.get(key(collection))
      return !!p && !restricts(p)
    }
  }
}

/**
 * A gate that only records which collections the compiler asks about. The
 * compiler runs its EXISTS callbacks when the SQL is built, so a dry compile
 * with this gate names every collection the real compile will gate — the walk
 * can never drift from the compiler.
 */
export function createRecordingGate(): FilterScopeGate & { seen: Set<string> } {
  const seen = new Set<string>()
  return {
    seen,
    async prime() {},
    apply(_q, collection) {
      seen.add(collection)
    },
    isOpen(collection) {
      seen.add(collection)
      return false
    }
  }
}
