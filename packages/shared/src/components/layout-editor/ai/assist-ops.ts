import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import type { DraftStatus } from '../useLayoutDraft'

/**
 * Pure helpers for the layout editor's AI assists (#2684 #2686 #2689).
 *
 * An AI proposal is built on the layout as the server last read it; the
 * editor's draft may have moved on (manual Save keeps changes local). Two
 * kinds of op would then undo the admin's own unsaved edits if applied as
 * sent, so they are re-based on the draft at apply time:
 *   - update_placement with `overrides` (a help text rewrite): the new keys
 *     merge into the placement's overrides as they are NOW;
 *   - group_update with `hidden_for_roles` (hide a section from roles): the
 *     roles join the section's list as it is NOW.
 * Every other op passes through unchanged.
 */

function parse(v: unknown): unknown {
  let cur = v
  for (let i = 0; i < 4 && typeof cur === 'string'; i++) {
    try {
      cur = JSON.parse(cur)
    } catch {
      return null
    }
  }
  return cur
}

const asObject = (v: unknown): Record<string, unknown> => {
  const p = parse(v)
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {}
}

const asIds = (v: unknown): string[] => {
  const p = parse(v)
  return Array.isArray(p) ? p.map(String).filter(Boolean) : []
}

export function rebaseAssistOps(ops: LayoutOp[], bundle: LayoutBundle): LayoutOp[] {
  return ops.map((op) => {
    if (op.op === 'update_placement' && op.patch && typeof op.patch.overrides === 'object') {
      const row = bundle.placements.find(
        (p) => p.field === op.at.field && p.group_key === (op.at.group_key ?? null)
      )
      if (!row) return op
      return {
        ...op,
        patch: {
          ...op.patch,
          overrides: { ...asObject(row.overrides), ...asObject(op.patch.overrides) }
        }
      }
    }
    if (op.op === 'group_update' && typeof op.patch?.hidden_for_roles === 'string') {
      const g = bundle.groups.find((x) => x.key === op.key)
      if (!g) return op
      const now = asIds(g.hidden_for_roles)
      const have = new Set(now.map((id) => id.toUpperCase()))
      const add = asIds(op.patch.hidden_for_roles).filter((id) => !have.has(id.toUpperCase()))
      return { ...op, patch: { ...op.patch, hidden_for_roles: JSON.stringify([...now, ...add]) } }
    }
    return op
  })
}

/**
 * Did a manual Save just send the unsaved changes? True on the render where
 * the unsaved count drops to 0 while a save is out or done — Discard drops it
 * too but leaves the draft idle, and autosave never has unsaved steps.
 */
export function savedJustNow(
  prevUnsaved: number,
  unsaved: number,
  status: DraftStatus,
  autosave: boolean
): boolean {
  return (
    !autosave && prevUnsaved > 0 && unsaved === 0 && (status === 'saving' || status === 'saved')
  )
}

/** A bundle cut to what the change check reads (keeps the request small). */
export function slimBundle(b: LayoutBundle) {
  return {
    rev: b.rev,
    layout: {
      conditions: b.layout.conditions ?? null,
      record_conditions: b.layout.record_conditions ?? null,
      default_values: b.layout.default_values ?? null
    },
    groups: b.groups.map((g) => ({
      key: g.key,
      parent_key: g.parent_key,
      sort: g.sort,
      label: g.label,
      type: g.type,
      is_collapsed: g.is_collapsed,
      visible_when: g.visible_when,
      hidden_for_roles: g.hidden_for_roles,
      locked_for_roles: g.locked_for_roles
    })),
    placements: b.placements.map((p) => ({
      field: p.field,
      group_key: p.group_key,
      sort: p.sort,
      label_override: p.label_override,
      is_visible: p.is_visible,
      overrides: p.overrides,
      lock_conditions: p.lock_conditions,
      widget_id: p.widget_id
    }))
  }
}
