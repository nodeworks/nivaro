/**
 * A pipeline template's outline for a list view: its states (for the state
 * filter) and the transitions the caller may run by hand (for the bulk
 * transition bar). Served by GET /pipelines/:id/outline to any signed-in
 * person — GET /pipelines/:id is the admin editor's whole template (owner
 * dimensions, actions, skip criteria) and answers non-admins 403.
 *
 * Never more than the record panel offers a non-admin: automatic transitions
 * are left out, and a transition with required_roles only reaches a caller
 * holding one of those roles (the same case-insensitive test as
 * GET /pipelines/instance/:collection/:item). Per-record gates (from-state,
 * condition rules, owner-only) still run when a transition is executed.
 */

export interface OutlineStateRow {
  id: string
  key: string
  label: string
  color: string | null
  sort: number | null
  is_initial: boolean | number | null
  is_terminal: boolean | number | null
}

export interface OutlineTransitionRow {
  id: string
  label: string
  from_state: string | null
  to_state: string
  color: string | null
  sort: number | null
  group_label: string | null
  required_roles: string | null
  auto_trigger: boolean | number | null
  require_owner?: boolean | number | null
  allow_creator?: boolean | number | null
}

const bool = (v: unknown): boolean => v === true || v === 1 || v === '1'

function parseRoles(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map((r) => String(r)) : []
  } catch {
    return []
  }
}

/** Whether a caller with this role may run a transition with these required roles. */
export function roleMayRun(
  requiredRoles: string | null,
  caller: { isAdmin: boolean; role: string | null }
): boolean {
  if (caller.isAdmin) return true
  const roles = parseRoles(requiredRoles)
  if (roles.length === 0) return true
  const mine = caller.role ? String(caller.role).toUpperCase() : null
  return mine !== null && roles.some((r) => r.toUpperCase() === mine)
}

export function pipelineOutline(
  states: OutlineStateRow[],
  transitions: OutlineTransitionRow[],
  caller: { isAdmin: boolean; role: string | null }
) {
  return {
    states: states.map((s) => ({
      id: s.id,
      key: s.key,
      label: s.label,
      color: s.color ?? null,
      sort: s.sort ?? null,
      is_initial: bool(s.is_initial),
      is_terminal: bool(s.is_terminal)
    })),
    transitions: transitions
      .filter((t) => !bool(t.auto_trigger) && roleMayRun(t.required_roles, caller))
      .map((t) => ({
        id: t.id,
        label: t.label,
        from_state: t.from_state ?? null,
        to_state: t.to_state,
        color: t.color ?? null,
        sort: t.sort ?? null,
        group_label: t.group_label ?? null,
        require_owner: bool(t.require_owner),
        allow_creator: bool(t.allow_creator)
      }))
  }
}
