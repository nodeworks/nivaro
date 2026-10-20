import {
  type GroupRow,
  type LayoutBundle,
  type PlacementRow,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import type { ActiveLayoutData, FieldGroup, LayoutMeta, SlotAssignment } from '../item-edit/types'
import { type DesignTarget, targetKey } from './design-context'

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

function placementTarget(p: PlacementRow): DesignTarget {
  if (p.group_key === '__header__') return { kind: 'header', field: p.field }
  return {
    kind: p.field.startsWith('__') ? 'slot' : 'field',
    field: p.field,
    group_key: p.group_key
  }
}

/**
 * The draft as ActiveLayoutData. With `parent` (the layout this one extends),
 * parent placements fill in for fields the child does not place and parent
 * groups ride along unless the child has the same key — exactly what /active
 * merges — and are reported in `inherited`.
 */
export function bundleToActiveLayout(
  bundle: LayoutBundle,
  parent?: LayoutBundle | null
): CanvasLayout {
  const inherited = new Map<string, string>()
  let groups = bundle.groups
  let placements = bundle.placements
  if (parent) {
    const parentName = String(parent.layout.name ?? 'the parent layout')
    const childFields = new Set(placements.map((p) => p.field))
    const childKeys = new Set(groups.map((g) => g.key))
    const extraPlacements = parent.placements.filter((p) => !childFields.has(p.field))
    const extraGroups = parent.groups.filter(
      (g) => g.key !== UNGROUPED_KEY && !childKeys.has(g.key)
    )
    for (const p of extraPlacements) inherited.set(targetKey(placementTarget(p)), parentName)
    for (const g of extraGroups) inherited.set(targetKey({ kind: 'group', key: g.key }), parentName)
    groups = [...groups, ...extraGroups]
    placements = [...placements, ...extraPlacements]
  }

  const ungrouped = groups.find((g) => g.key === UNGROUPED_KEY)
  const real = groups.filter((g) => g.key !== UNGROUPED_KEY)
  const ids = groupIds(real)
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
      groups: real.map((g) => toGroup(g, ids)),
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
