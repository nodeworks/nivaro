import {
  type GroupRow,
  type LayoutBundle,
  type PlacementRow,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import type { ActiveLayoutData, FieldGroup, LayoutMeta, SlotAssignment } from '../item-edit/types'
import { type DesignTarget, type RoleMark, targetKey } from './design-context'
import type { RolePreview } from './settings/settings-api'

// The editor's draft (LayoutBundle) in the shape GET /collection-layouts/active
// answers, which is what the record form and read view render from.

export interface CanvasLayout {
  active: ActiveLayoutData
  /** targetKey → parent layout name, for everything the parent layout supplies. */
  inherited: Map<string, string>
}

/** Groups not saved yet have no id: give them stable negative ones so tabs can
 *  still point at their container. */
function groupIds(groups: GroupRow[]): Map<string, number> {
  const ids = new Map<string, number>()
  let next = -1
  for (const g of groups) ids.set(g.key, g.id ?? next--)
  return ids
}

function toGroup(g: GroupRow, ids: Map<string, number>): FieldGroup {
  return {
    ...(g as unknown as FieldGroup),
    id: ids.get(g.key) as number,
    container_id: g.parent_key == null ? null : (ids.get(g.parent_key) ?? null)
  }
}

// Same JSON text the stored row carries: the form JSON.parses input_bindings.
const asJsonText = (v: unknown): string | null =>
  v == null ? null : typeof v === 'string' ? v : JSON.stringify(v)

function toAssignment(p: PlacementRow): SlotAssignment {
  return {
    ...(p as unknown as SlotAssignment),
    overrides: (p.overrides ?? null) as SlotAssignment['overrides'],
    input_bindings: asJsonText(p.input_bindings)
  }
}

export function placementTarget(p: PlacementRow): DesignTarget {
  if (p.group_key === '__header__') return { kind: 'header', field: p.field }
  return {
    kind: p.field.startsWith('__') ? 'slot' : 'field',
    field: p.field,
    group_key: p.group_key
  }
}

/**
 * The draft as ActiveLayoutData. With `parent` (the layout this one extends)
 * it merges exactly as GET /collection-layouts/active does, and reports what
 * the parent supplies in `inherited`:
 *
 * - parent placements fill in for fields the child does not place at all;
 * - parent groups ride along unless the child has a group with the same key;
 * - a parent group keeps the parent's container id, as /active sends the
 *   stored rows: when the child overrides the parent's container (same key),
 *   the parent's tabs point at a container id that is not on the form —
 *   on the canvas exactly as on the record page;
 * - the Ungrouped zone's position is the child's. /active falls back to the
 *   parent's stored position only while the child has never stored one, and
 *   the editor's first save stores it (layout-ops writer), so after any edit
 *   the record page agrees with the canvas. The bundle cannot tell a stored
 *   position from the default it fills in, so the canvas cannot show that
 *   pre-save fallback.
 */
export function bundleToActiveLayout(
  bundle: LayoutBundle,
  parent?: LayoutBundle | null
): CanvasLayout {
  const inherited = new Map<string, string>()
  const ungrouped = bundle.groups.find((g) => g.key === UNGROUPED_KEY)
  const own = bundle.groups.filter((g) => g.key !== UNGROUPED_KEY)
  const ownIds = groupIds(own)
  const groups = own.map((g) => toGroup(g, ownIds))
  let placements = bundle.placements
  if (parent) {
    const parentName = String(parent.layout.name ?? 'the parent layout')
    const childFields = new Set(placements.map((p) => p.field))
    const childKeys = new Set(own.map((g) => g.key))
    const parentGroups = parent.groups.filter((g) => g.key !== UNGROUPED_KEY)
    const parentIds = groupIds(parentGroups)
    const extraGroups = parentGroups.filter((g) => !childKeys.has(g.key))
    const extraPlacements = parent.placements.filter((p) => !childFields.has(p.field))
    for (const p of extraPlacements) inherited.set(targetKey(placementTarget(p)), parentName)
    for (const g of extraGroups) inherited.set(targetKey({ kind: 'group', key: g.key }), parentName)
    groups.push(...extraGroups.map((g) => toGroup(g, parentIds)))
    placements = [...placements, ...extraPlacements]
  }

  const row = bundle.layout
  const layout = {
    ...row,
    id: Number(row.id),
    name: String(row.name ?? ''),
    tab_mode: (row.tab_mode as LayoutMeta['tab_mode']) ?? null,
    validate_before_next: !!row.validate_before_next,
    summary_enabled: !!row.summary_enabled,
    summary_show_all: false,
    ai_enabled: !!row.ai_enabled
  } as LayoutMeta

  return {
    active: {
      layout,
      groups,
      assignments: placements.map(toAssignment),
      ungrouped_sort: ungrouped ? ungrouped.sort : null
    },
    inherited
  }
}

function roleList(raw: unknown): string[] {
  if (raw == null || raw === '') return []
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(v) ? v.map((r) => String(r).toUpperCase()) : []
  } catch {
    return []
  }
}

/**
 * "Preview as role": the groups /active would drop for that role
 * (hidden_for_roles) leave the canvas — unless the admin asked to see
 * everything, where they stay selectable.
 */
export function previewForRole(
  active: ActiveLayoutData,
  roleId: string | null,
  showHidden: boolean
): ActiveLayoutData {
  if (!roleId || showHidden) return active
  const role = roleId.toUpperCase()
  const groups = active.groups.filter(
    (g) => !roleList((g as { hidden_for_roles?: unknown }).hidden_for_roles).includes(role)
  )
  return groups.length === active.groups.length ? active : { ...active, groups }
}

/**
 * "Preview as role", field by field: what the role's permissions do to each
 * field on the canvas (GET /collection-layouts/preview-as-role). Hidden ones
 * stay on the canvas, marked; a role that cannot edit the collection at all
 * sees every other field read-only. Slots and widgets are not fields: no mark.
 */
export function roleMarker(
  preview: RolePreview | null
): ((t: DesignTarget) => RoleMark | null) | undefined {
  if (!preview || preview.role.admin_access) return undefined
  const hidden = new Set(preview.hidden_fields)
  const readonly = new Set(preview.readonly_fields)
  const allReadonly = preview.can_read && !preview.can_update
  const role = preview.role.name
  if (!hidden.size && !readonly.size && !allReadonly) return undefined
  return (t) => {
    if (t.kind !== 'field' && t.kind !== 'header') return null
    if (t.field.startsWith('__')) return null
    if (hidden.has(t.field)) return { kind: 'hidden', role }
    if (allReadonly || readonly.has(t.field)) return { kind: 'readonly', role }
    return null
  }
}
