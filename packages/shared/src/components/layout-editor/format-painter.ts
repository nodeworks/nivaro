import {
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp,
  type PlacementPatch,
  type PlacementRow
} from '../../lib/layout-ops'
import { titleCase } from '../../lib/utils'
import { sameValue } from './canvas-diff'
import type { DesignTarget } from './design-context'
import { plural } from './field-zones'
import { asObject } from './inspector/model'
import { checked, refuse, type StructurePlan } from './structure-ops'

/**
 * Format painter (#3202): one field's look and rules — width, visibility,
 * required / read-only / hidden, lock conditions, its interface options when
 * the fields are of one kind — put onto other fields in one undo step. What
 * makes a field itself stays with it: its label, help text, placeholder,
 * translations, display formula, and a widget's or panel's own wiring.
 */

/** Placement columns that are the field's identity, never painted. */
export const IDENTITY_KEYS = ['label_override', 'widget_id', 'input_bindings'] as const
/** Override keys that are the field's own words or wiring, never painted. */
export const IDENTITY_OVERRIDES = [
  'label',
  'note',
  'placeholder',
  'i18n',
  'display_formula',
  'editor_note',
  'help_video'
] as const
/** Override keys that only fit a field of the same kind (same type and interface). */
export const KIND_OVERRIDES = ['interface', 'options'] as const

const PAINT_COLUMNS = [
  'is_visible',
  'default_expanded',
  'col_span',
  'show_row_revisions',
  'allow_revision_restore',
  'lock_conditions',
  'show_approval_chain'
] as const

export interface Look {
  field: string
  group_key: string | null
  /** The painted columns as the source has them. */
  columns: Partial<Record<(typeof PAINT_COLUMNS)[number], unknown>>
  /** The source's overrides minus its identity keys. */
  overrides: Record<string, unknown>
}

type Obj = Record<string, unknown>

/** What a placement's look is: the paintable columns and overrides. */
export function lookOf(row: PlacementRow): Look {
  const columns: Look['columns'] = {}
  const r = row as unknown as Obj
  for (const k of PAINT_COLUMNS) columns[k] = r[k] ?? null
  const ov = { ...asObject(row.overrides) }
  for (const k of IDENTITY_OVERRIDES) delete ov[k]
  return { field: row.field, group_key: row.group_key, columns, overrides: ov }
}

const isPaintable = (f: string) => !f.startsWith('__')

/** Why a target cannot give or take a look (null: it can). */
export function paintBlocked(t: DesignTarget | null): string | null {
  if (!t || t.kind === 'group') return 'Select a field first'
  if (!isPaintable(t.field)) return 'Panels, widgets and formulas keep their own look'
  return null
}

const placementAt = (b: LayoutBundle, t: DesignTarget): PlacementRow | null => {
  if (t.kind === 'group') return null
  const gk = t.kind === 'header' ? HEADER_GROUP_KEY : t.group_key
  return b.placements.find((p) => p.field === t.field && p.group_key === gk) ?? null
}

export function lookFrom(bundle: LayoutBundle, t: DesignTarget): Look | null {
  if (paintBlocked(t)) return null
  const row = placementAt(bundle, t)
  return row ? lookOf(row) : null
}

/**
 * The look put onto each target that differs: one update_placement each, one
 * batch. `sameKind(a, b)` says whether two fields share a type and interface:
 * only then do the interface and its options travel.
 */
export function paintPlan(
  bundle: LayoutBundle,
  look: Look,
  targets: DesignTarget[],
  opts: { sameKind?: (a: string, b: string) => boolean; fieldLabel?: (f: string) => string } = {}
): StructurePlan {
  const name = opts.fieldLabel ?? titleCase
  const ops: LayoutOp[] = []
  const notes: string[] = []
  let panels = 0
  let same = 0
  let otherKind = 0
  const toHeader = look.group_key === HEADER_GROUP_KEY
  let crossZone = 0
  for (const t of targets) {
    if (t.kind === 'group') continue
    if (!isPaintable(t.field)) {
      panels++
      continue
    }
    const row = placementAt(bundle, t)
    if (!row || (row.field === look.field && row.group_key === look.group_key)) continue
    // Header tiles and form fields have different settings: paint like onto like.
    if ((row.group_key === HEADER_GROUP_KEY) !== toHeader) {
      crossZone++
      continue
    }
    const kindOk = row.field === look.field || (opts.sameKind?.(look.field, row.field) ?? false)
    const have = asObject(row.overrides)
    const next: Obj = {}
    for (const k of IDENTITY_OVERRIDES) if (have[k] !== undefined) next[k] = have[k]
    for (const k of KIND_OVERRIDES) {
      const v = kindOk ? look.overrides[k] : have[k]
      if (v !== undefined) next[k] = v
    }
    if (!kindOk && KIND_OVERRIDES.some((k) => look.overrides[k] !== undefined)) otherKind++
    for (const [k, v] of Object.entries(look.overrides))
      if (
        !(IDENTITY_OVERRIDES as readonly string[]).includes(k) &&
        !(KIND_OVERRIDES as readonly string[]).includes(k)
      )
        next[k] = v
    const patch: Obj = {}
    const r = row as unknown as Obj
    for (const k of PAINT_COLUMNS)
      if (!sameValue(r[k] ?? null, look.columns[k] ?? null)) patch[k] = look.columns[k] ?? null
    const ov = Object.keys(next).length ? next : null
    if (!sameValue(have, ov ?? {})) patch.overrides = ov
    if (Object.keys(patch).length === 0) {
      same++
      continue
    }
    ops.push({
      op: 'update_placement',
      at: { field: row.field, group_key: row.group_key },
      patch: patch as PlacementPatch
    })
  }
  if (ops.length === 0) {
    if (same) return refuse(same === 1 ? 'It already looks the same' : 'They already look the same')
    if (crossZone) return refuse('Header tiles and form fields have different settings')
    if (panels) return refuse('Panels, widgets and formulas keep their own look')
    return refuse('Select the fields to paint onto')
  }
  if (same) notes.push(`${plural(same, 'field')} already looked the same`)
  if (panels) notes.push(`${plural(panels, 'panel')} skipped: panels keep their own look`)
  if (crossZone)
    notes.push(`${plural(crossZone, 'field')} skipped: header tiles and form fields differ`)
  if (otherKind)
    notes.push(
      `${plural(otherKind, 'field')} of another kind kept ${otherKind === 1 ? 'its' : 'their'} own input and options`
    )
  return checked(bundle, {
    ok: true,
    ops,
    label: `Paint the look of ${name(look.field)} onto ${plural(ops.length, 'field')}`,
    notes
  })
}
