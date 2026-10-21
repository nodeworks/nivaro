import type { GroupRow, LayoutOp } from '../../../lib/layout-ops'
import { asArray } from '../inspector/model'

// Role × section matrix (#2645): per section and role, can edit / read-only /
// hidden — the section's hidden_for_roles and locked_for_roles (the Group
// inspector's Who), one group_update per cell. Administrators are exempt from
// both lists (the record page and /active ignore them for admins).

export type RoleAccess = 'edit' | 'readonly' | 'hidden'

export const ROLE_ACCESS: RoleAccess[] = ['edit', 'readonly', 'hidden']

export interface MatrixRole {
  id: string
  name: string
  admin_access?: boolean
}

const has = (raw: unknown, roleId: string) =>
  asArray<unknown>(raw).some((r) => String(r).toUpperCase() === roleId.toUpperCase())

/** Section types with a Who setting (the Group inspector's sectionLike). */
export const ROLE_SECTION_TYPES = new Set(['section', 'metadata', 'tab'])

export function roleAccess(group: GroupRow, roleId: string): RoleAccess {
  if (has(group.hidden_for_roles, roleId)) return 'hidden'
  if (has(group.locked_for_roles, roleId)) return 'readonly'
  return 'edit'
}

const jsonList = (ids: string[]) => (ids.length ? JSON.stringify(ids) : null)

function without(raw: unknown, roleId: string): string[] {
  return asArray<unknown>(raw)
    .map(String)
    .filter((r) => r.toUpperCase() !== roleId.toUpperCase())
}

/** One group_update that gives `roleId` that access to the section (none when it has it). */
export function roleAccessOps(group: GroupRow, roleId: string, to: RoleAccess): LayoutOp[] {
  if (roleAccess(group, roleId) === to) return []
  const hidden = without(group.hidden_for_roles, roleId)
  const locked = without(group.locked_for_roles, roleId)
  if (to === 'hidden') hidden.push(roleId)
  if (to === 'readonly') locked.push(roleId)
  return [
    {
      op: 'group_update',
      key: group.key,
      patch: { hidden_for_roles: jsonList(hidden), locked_for_roles: jsonList(locked) }
    }
  ]
}

export const ACCESS_LABEL: Record<RoleAccess, string> = {
  edit: 'Can edit',
  readonly: 'Read-only',
  hidden: 'Hidden'
}

export function roleAccessLabel(section: string, role: string, to: RoleAccess): string {
  if (to === 'hidden') return `Hide ${section} from ${role}`
  if (to === 'readonly') return `Make ${section} read-only for ${role}`
  return `Let ${role} edit ${section}`
}
