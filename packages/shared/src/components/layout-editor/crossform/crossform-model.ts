import type { GroupRow, LayoutBundle, LayoutOp, PlacementRow } from '../../../lib/layout-ops'
import { titleCase } from '../../../lib/utils'
import type { DesignMark, DesignTarget } from '../design-context'
import { WIDTH_LABELS, widthOf } from '../field-zones'
import { asObject, withKey } from '../inspector/model'
import { slotName } from '../slot-names'

// Pure helpers for the across-forms tools: unify a field's label on other
// forms (#2631), link a near copy to its parent (#2660) and compare two forms
// side by side (#2659).

const SENTINEL_RE = /^__.+__$/
const isSentinel = (field: string) => SENTINEL_RE.test(field)

/** The label a placement shows: overrides.label, else label_override, else the field's. null = hidden. */
export function placementLabel(p: PlacementRow, fieldLabel: string): string | null {
  const ov = asObject(p.overrides)
  if (typeof ov.label === 'string') return ov.label === '' ? null : ov.label.trim() || fieldLabel
  if (p.label_override?.trim()) return p.label_override.trim()
  return fieldLabel
}

/**
 * Ops giving `field` the label `target` on this layout. The field's own label
 * clears the override; a hidden label (and a missing placement) stays as is.
 */
export function unifyLabelOps(
  bundle: LayoutBundle,
  field: string,
  target: string,
  fieldLabel: string
): LayoutOp[] {
  const ops: LayoutOp[] = []
  for (const p of bundle.placements) {
    if (p.field !== field) continue
    const shown = placementLabel(p, fieldLabel)
    if (shown == null) continue
    const ov = asObject(p.overrides)
    const nextLabel = target === fieldLabel ? undefined : target
    if (shown === target && p.label_override == null && ov.label === nextLabel) continue
    ops.push({
      op: 'update_placement',
      at: { field: p.field, group_key: p.group_key },
      patch: { label_override: null, overrides: withKey(ov, 'label', nextLabel) }
    })
  }
  return ops
}

/** Make `parentId` the parent of this layout, unless something already changed that. */
export function linkParentOps(bundle: LayoutBundle, parentId: number): LayoutOp[] {
  if (bundle.layout.parent_layout_id != null) return []
  return [{ op: 'layout_update', patch: { parent_layout_id: parentId } }]
}

// ── Compare two forms ────────────────────────────────────────────────────────

export type CompareStatus = 'same' | 'only_a' | 'only_b' | 'differs'

export interface CompareEntry {
  field: string
  label: string
  status: CompareStatus
  /** What differs, in words ("Width: Full → ½"). */
  diffs: string[]
}

export interface CompareSide {
  bundle: LayoutBundle
  parent: LayoutBundle | null
}

interface Placed {
  p: PlacementRow
  section: string
  groups: GroupRow[]
}

/** The form's placements as the record page merges them: its own, then the parent's for fields it lacks. */
export function effectivePlacements(side: CompareSide): Map<string, Placed> {
  const own = side.bundle.groups
  const keys = new Set(own.map((g) => g.key))
  const groups = [...own, ...(side.parent?.groups ?? []).filter((g) => !keys.has(g.key))]
  const out = new Map<string, Placed>()
  const add = (p: PlacementRow) => {
    if (p.field === '__ungrouped_pos__' || out.has(p.field)) return
    out.set(p.field, { p, section: sectionPath(groups, p.group_key), groups })
  }
  for (const p of side.bundle.placements) add(p)
  for (const p of side.parent?.placements ?? []) add(p)
  return out
}

export function sectionPath(groups: GroupRow[], key: string | null): string {
  if (key == null) return 'No section'
  const g = groups.find((x) => x.key === key)
  if (!g) return key
  const parent = g.parent_key == null ? null : groups.find((x) => x.key === g.parent_key)
  const own = g.label || g.key
  return parent ? `${parent.label || parent.key} › ${own}` : own
}

/** Everything but the label: settings two copies of a field should share. */
function otherSettings(p: PlacementRow): string {
  const ov = { ...asObject(p.overrides) }
  delete ov.label
  return JSON.stringify([
    ov,
    p.lock_conditions ?? null,
    asObject(p.input_bindings),
    p.default_expanded,
    p.widget_id ?? null,
    p.show_row_revisions,
    p.show_approval_chain
  ])
}

const shownWord = (v: boolean) => (v ? 'shown' : 'hidden')
const labelWord = (v: string | null) => (v == null ? 'no label' : `“${v}”`)

export function compareLayouts(
  a: CompareSide,
  b: CompareSide,
  fieldLabels: Map<string, string>
): CompareEntry[] {
  const pa = effectivePlacements(a)
  const pb = effectivePlacements(b)
  const labelOf = (field: string) =>
    fieldLabels.get(field) || (isSentinel(field) ? slotName(field) : titleCase(field))
  const out: CompareEntry[] = []
  for (const field of new Set([...pa.keys(), ...pb.keys()])) {
    const x = pa.get(field)
    const y = pb.get(field)
    const label = labelOf(field)
    if (!x || !y) {
      out.push({ field, label, status: x ? 'only_a' : 'only_b', diffs: [] })
      continue
    }
    const diffs: string[] = []
    if (x.section.toLowerCase() !== y.section.toLowerCase())
      diffs.push(`Section: ${x.section} → ${y.section}`)
    const wx = widthOf(x.p)
    const wy = widthOf(y.p)
    if (wx !== wy) diffs.push(`Width: ${WIDTH_LABELS[wx]} → ${WIDTH_LABELS[wy]}`)
    if (!isSentinel(field)) {
      const lx = placementLabel(x.p, label)
      const ly = placementLabel(y.p, label)
      if (lx !== ly) diffs.push(`Label: ${labelWord(lx)} → ${labelWord(ly)}`)
    }
    if (x.p.is_visible !== y.p.is_visible)
      diffs.push(`Visible: ${shownWord(x.p.is_visible)} → ${shownWord(y.p.is_visible)}`)
    if (otherSettings(x.p) !== otherSettings(y.p)) diffs.push('Other settings differ')
    out.push({ field, label, status: diffs.length ? 'differs' : 'same', diffs })
  }
  const rank: Record<CompareStatus, number> = { differs: 0, only_a: 1, only_b: 2, same: 3 }
  return out.sort((m, n) => rank[m.status] - rank[n.status] || m.label.localeCompare(n.label))
}

export function compareCounts(entries: CompareEntry[]): Record<CompareStatus, number> {
  const c: Record<CompareStatus, number> = { same: 0, only_a: 0, only_b: 0, differs: 0 }
  for (const e of entries) c[e.status]++
  return c
}

/**
 * The tags one pane shows: "Only here" on what the other form lacks,
 * "Differs" (with what, in the tip) on fields configured differently, and
 * "Only here" on sections the other form has no section of that name for.
 */
export function compareMarksFor(
  side: 'a' | 'b',
  entries: CompareEntry[],
  own: CompareSide,
  other: CompareSide
): (t: DesignTarget) => DesignMark[] {
  const byField = new Map(entries.map((e) => [e.field, e]))
  const onlyHere: CompareStatus = side === 'a' ? 'only_a' : 'only_b'
  const names = (s: CompareSide) => {
    const groups = [...s.bundle.groups, ...(s.parent?.groups ?? [])]
    return new Set(groups.map((g) => sectionPath(groups, g.key).toLowerCase()))
  }
  const otherNames = names(other)
  const ownGroups = [...own.bundle.groups, ...(own.parent?.groups ?? [])]
  return (t) => {
    if (t.kind === 'group') {
      const path = sectionPath(ownGroups, t.key).toLowerCase()
      return otherNames.has(path)
        ? []
        : [
            {
              text: 'Only here',
              tone: 'emerald',
              tip: 'The other form has no section by this name'
            }
          ]
    }
    const e = byField.get(t.field)
    if (!e) return []
    if (e.status === onlyHere)
      return [
        {
          text: 'Only here',
          tone: 'emerald',
          tip: 'The other form does not place this field',
          highlight: true
        }
      ]
    if (e.status === 'differs')
      return [{ text: 'Differs', tone: 'amber', tip: e.diffs.join(' · '), highlight: true }]
    return []
  }
}
