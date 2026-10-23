import type { User } from '../types.js'
import { explainAccess } from './access-explain.js'

/**
 * Create scope guard (default OFF; CREATE_SCOPE_GUARD=on).
 *
 * A User-Scoped person could create a record that falls outside their own
 * scope — a workflow with no Zone, or a Zone they do not have — and then could
 * not open it (2026-10-23, staging). With the guard on, such a create is
 * refused with 422 OUT_OF_SCOPE naming the dimension ("Choose a Zone you have
 * access to") and nothing is kept: the items service checks right after the
 * row and its many-to-many links are written (the links are usually what
 * places the record in a scope) and before any child set, hook or outbound
 * effect, then takes the row back out.
 *
 * Only a User Scope the person can satisfy refuses. A caller with no scopes
 * (integrations, API keys, unscoped people) is never judged; a record hidden
 * only by a role's row filter, or by a strict scope on a collection that has
 * no link to that dimension, keeps today's answer (created, `readable: false`).
 */
export function createScopeGuardOn(): boolean {
  return /^(on|true|1|yes)$/i.test((process.env.CREATE_SCOPE_GUARD ?? '').trim())
}

export class OutOfScopeCreateError extends Error {
  statusCode = 422
  code = 'OUT_OF_SCOPE'
  /** The scope dimension that would hide the record (e.g. `division`). */
  dimension: string | null
  constructor(message: string, dimension: string | null) {
    super(message)
    this.dimension = dimension
  }
}

/**
 * The refusal for a just-written row its creator could not read back because
 * of a User Scope; null when no scope hides it (visible, or hidden by
 * something else). Never throws — an explain that fails lets the create stand.
 */
export async function outOfScopeRefusal(
  user: User,
  actingAdmin: boolean,
  collection: string,
  id: string | number
): Promise<OutOfScopeCreateError | null> {
  let reasons: Awaited<ReturnType<typeof explainAccess>>['reasons']
  try {
    reasons = (await explainAccess(user, actingAdmin, collection, String(id))).reasons
  } catch {
    return null
  }
  // Only a choice the person can fix: a strict scope on a collection with no
  // link to that dimension hides every record, whatever is entered.
  const scope = reasons.find((r) => r.type === 'scope')
  if (!scope) return null
  const label = scope.dimension_label ?? 'access'
  const allowed = (scope.allowed_values ?? []).slice(0, 10)
  const yours = allowed.length > 0 ? ` (yours: ${allowed.join(', ')})` : ''
  const as =
    (scope.record_values ?? []).length === 0
      ? `it has no ${label}`
      : `its ${label} is not one of yours`
  return new OutOfScopeCreateError(
    `Choose a ${label} you have access to${yours} — as entered, ${as}, so you could not open it. Nothing was created.`,
    scope.dimension ?? null
  )
}
