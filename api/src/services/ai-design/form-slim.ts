import { db } from '../../db/index.js'
import type { LayoutBundle, PlacementRow } from '../layout-ops-apply.js'
import { countDeltaFields, isPersonField } from '../layout-usage.js'
import { withReadGate } from '../read-gate.js'

/**
 * A lighter version of a form for one role (#2671): a CHILD layout
 * (parent_layout_id) shown to that role, keeping the fields that role's
 * people actually changed — mined from revisions of the last 180 days — and
 * hiding the rest.
 *
 * Why hide instead of leave out: a child inherits every parent placement it
 * does not define itself (collection-layouts /active, #424), so a field is
 * dropped by giving the child its own hidden placement of it, and a section
 * whose fields are all dropped by a child copy of the section hidden for the
 * role. Everything kept keeps following the parent.
 *
 * This file only reads and plans. The editor builds the ops
 * (ai-forms/slim.ts in packages/shared) and applies them to the new layout
 * through its draft once the admin confirmed — nothing is written here.
 */

export const SLIM_DAYS = 180
export const SLIM_MIN_REVISIONS = 5
const SLIM_ROW_CAP = 5000

export interface RoleChanges {
  revisions: number
  people: number
  /** field → revisions by this role's people that changed it */
  counts: Record<string, number>
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000)

/** Revisions of the collection made by people holding the role (capped, newest first). */
export async function roleFieldChanges(
  collection: string,
  roleId: string,
  who: string | null | undefined,
  days = SLIM_DAYS
): Promise<RoleChanges> {
  const rows = await withReadGate(
    who,
    () =>
      db('nivaro_revisions as r')
        .join('nivaro_activity as a', 'r.activity', 'a.id')
        .join('nivaro_users as u', 'u.id', 'a.user')
        .where('r.collection', collection)
        .where('u.role', roleId)
        .whereIn('a.action', ['update', 'create'])
        .where('a.timestamp', '>=', daysAgo(days))
        .orderBy('r.id', 'desc')
        .limit(SLIM_ROW_CAP)
        .select('r.delta', 'a.user') as Promise<Array<{ delta: string | null; user: unknown }>>,
    { label: 'ai-slim-layout' }
  )
  const counts: Record<string, number> = {}
  for (const c of countDeltaFields(rows.map((r) => r.delta))) counts[c.field] = c.changes
  return {
    revisions: rows.length,
    people: new Set(rows.map((r) => String(r.user ?? ''))).size,
    counts
  }
}

export interface SlimKeep {
  field: string
  label: string
  changes: number
  why: 'changed' | 'required'
}

export interface SlimDrop {
  field: string
  label: string
  group_key: string | null
  group_label: string | null
}

export interface SlimPlan {
  keep: SlimKeep[]
  drop: SlimDrop[]
  /** Sections / steps (top level) every field of which is dropped. */
  hide_groups: Array<{ key: string; label: string }>
  /** A field counts as used from this many changes. */
  min_changes: number
}

function overridesOf(p: PlacementRow): Record<string, unknown> {
  let v: unknown = p.overrides
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    try {
      v = JSON.parse(v)
    } catch {
      return {}
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

const isBodyField = (p: PlacementRow) =>
  !p.field.startsWith('__') &&
  p.widget_id == null &&
  p.group_key !== '__header__' &&
  !(p.group_key ?? '').startsWith('__') &&
  isPersonField(p.field)

/**
 * Which placed fields stay: those the role changed at least `min_changes`
 * times (1 % of its revisions, at least once), plus fields the form or the
 * field itself requires (hiding them would make the form unsaveable).
 */
export function planSlim(
  parent: LayoutBundle,
  changes: RoleChanges,
  opts: { labelOf: (field: string) => string; required: Set<string> }
): SlimPlan {
  const minChanges = Math.max(1, Math.round(changes.revisions * 0.01))
  const keep: SlimKeep[] = []
  const drop: SlimDrop[] = []
  const seen = new Set<string>()
  const groupLabel = new Map(parent.groups.map((g) => [g.key, g.label]))
  const visible = parent.placements
    .filter(isBodyField)
    .filter((p) => p.is_visible !== false && overridesOf(p).hidden !== true)
  const keptFields = new Set<string>()
  for (const p of visible) {
    if (seen.has(p.field)) continue
    seen.add(p.field)
    const n = changes.counts[p.field] ?? 0
    const label = opts.labelOf(p.field)
    if (n >= minChanges) {
      keep.push({ field: p.field, label, changes: n, why: 'changed' })
      keptFields.add(p.field)
    } else if (opts.required.has(p.field) || overridesOf(p).required === true) {
      keep.push({ field: p.field, label, changes: n, why: 'required' })
      keptFields.add(p.field)
    } else
      drop.push({
        field: p.field,
        label,
        group_key: p.group_key,
        group_label: p.group_key ? (groupLabel.get(p.group_key) ?? null) : null
      })
  }
  keep.sort((a, b) => b.changes - a.changes || a.label.localeCompare(b.label))
  const hide_groups = parent.groups
    .filter((g) => g.parent_key === null && (g.type === 'section' || g.type === 'tab'))
    .filter((g) => !parent.groups.some((c) => c.parent_key === g.key))
    .filter((g) => {
      const inside = visible.filter((p) => p.group_key === g.key)
      return inside.length > 0 && inside.every((p) => !keptFields.has(p.field))
    })
    .map((g) => ({ key: g.key, label: g.label }))
  return { keep, drop, hide_groups, min_changes: minChanges }
}
