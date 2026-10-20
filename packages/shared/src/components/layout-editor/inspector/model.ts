/**
 * Pure helpers the inspector uses to read a selected placement / group and to
 * turn one setting change into layout ops. No React, no requests.
 */
import {
  type GroupPatch,
  type GroupRow,
  HEADER_GROUP_KEY,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  type LayoutRow,
  PLACEMENT_PATCH_KEYS,
  type PlacementKey,
  type PlacementPatch,
  type PlacementRow
} from '../../../lib/layout-ops'
import { titleCase } from '../../../lib/utils'

export type Obj = Record<string, unknown>
export type RelKind = 'M2O' | 'M2M' | 'O2M' | null

/** The columns of a nivaro_fields row the inspector reads (GET /collections/:c). */
export interface GlobalFieldRow {
  field: string
  type?: string | null
  interface?: string | null
  label?: string | null
  note?: string | null
  hidden?: boolean | null
  options?: unknown
  dependency_config?: unknown
  computed_type?: string | null
  deprecated_at?: string | null
  deprecation_note?: string | null
}

export interface RelationRow {
  one_collection?: string | null
  one_field?: string | null
  many_collection?: string | null
  many_field?: string | null
  junction_field?: string | null
}

export interface FieldInfo {
  field: string
  /** What the admin sees: this form's label, else the field's label, else the key in words. */
  label: string
  /** nivaro_fields.type; 'alias' for relation aliases without a row. */
  type: string
  /** 'm2o' | 'm2m' | 'o2m' for relations, else the stored type. */
  abstractType: string
  relKind: RelKind
  relatedCollection: string | null
  /** Interface on this form: the override, else the field's own. */
  iface: string | null
  computedType: string | null
  global: GlobalFieldRow | null
  /** A dotted relation path (a.b.c), rendered read-only by the form. */
  isPath: boolean
}

/** JSON text or an already-parsed value → value; bad JSON → null. */
export function parseJsonish<T = unknown>(v: unknown): T | null {
  let cur = v
  for (let i = 0; i < 3 && typeof cur === 'string'; i++) {
    const t = cur.trim()
    if (!t) return null
    try {
      cur = JSON.parse(t)
    } catch {
      return null
    }
  }
  return (cur ?? null) as T | null
}

export function asObject(v: unknown): Obj {
  const p = parseJsonish<unknown>(v)
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Obj) : {}
}

export function asArray<T = unknown>(v: unknown): T[] {
  const p = parseJsonish<unknown>(v)
  return Array.isArray(p) ? (p as T[]) : []
}

export function relKindOf(field: string, relations: RelationRow[]): RelKind {
  const m2m = relations.find(
    (r) =>
      r.junction_field != null &&
      ((r.one_field && r.one_field !== 'id' && r.one_field === field) ||
        ((!r.one_field || r.one_field === 'id') && r.many_collection === field))
  )
  if (m2m) return 'M2M'
  const o2m = relations.find(
    (r) => r.junction_field == null && (r.one_field === field || r.many_collection === field)
  )
  if (o2m) return 'O2M'
  const m2o = relations.find((r) => r.many_field === field)
  return m2o?.one_collection ? 'M2O' : null
}

export function relatedCollectionOf(field: string, relations: RelationRow[]): string | null {
  const kind = relKindOf(field, relations)
  if (kind === 'M2O') return relations.find((r) => r.many_field === field)?.one_collection ?? null
  if (kind === 'M2M') {
    const junction = relations.find(
      (r) =>
        r.junction_field != null &&
        (r.one_field === field ||
          ((!r.one_field || r.one_field === 'id') && r.many_collection === field))
    )
    if (!junction) return null
    return (
      relations.find(
        (r) =>
          r.many_collection === junction.many_collection &&
          r.many_field === junction.junction_field &&
          r.one_field !== field
      )?.one_collection ?? null
    )
  }
  if (kind === 'O2M') {
    const rel = relations.find(
      (r) =>
        !r.junction_field &&
        (r.one_field === field || (r.one_field === 'id' && r.many_collection === field))
    )
    return rel?.many_collection ?? null
  }
  return null
}

export function readOverrides(p: PlacementRow | null | undefined): Obj {
  return p ? asObject(p.overrides) : {}
}

export function readOptions(p: PlacementRow | null | undefined): Obj {
  return asObject(readOverrides(p).options)
}

export function describeField(
  field: string,
  globals: GlobalFieldRow[],
  relations: RelationRow[],
  placement: PlacementRow | null
): FieldInfo {
  const global = globals.find((f) => f.field === field) ?? null
  const ov = readOverrides(placement)
  const relKind = relKindOf(field, relations)
  const type = global?.type ?? (relKind === 'O2M' || relKind === 'M2M' ? 'alias' : 'string')
  const abstractType = relKind ? relKind.toLowerCase() : type
  const ovLabel = typeof ov.label === 'string' && ov.label !== '' ? ov.label : null
  const iface =
    typeof ov.interface === 'string' && ov.interface ? ov.interface : (global?.interface ?? null)
  return {
    field,
    label: ovLabel ?? global?.label ?? titleCase(field.split('.').pop() ?? field),
    type,
    abstractType,
    relKind,
    relatedCollection: relatedCollectionOf(field, relations),
    iface,
    computedType: global?.computed_type ?? null,
    global,
    isPath: field.includes('.') && !field.startsWith('__')
  }
}

export const NUMERIC_TYPES = new Set([
  'integer',
  'bigInteger',
  'decimal',
  'float',
  'money',
  'smallmoney',
  'tinyint',
  'smallint',
  'bigint'
])

/** One key set (value) or removed (undefined) in an object; empty → null. */
export function withKey(obj: Obj, key: string, value: unknown): Obj | null {
  const next = { ...obj }
  if (value === undefined) delete next[key]
  else next[key] = value
  return Object.keys(next).length ? next : null
}

/** The placement's overrides with one top-level key set or removed. */
export function withOverride(p: PlacementRow, key: string, value: unknown): Obj | null {
  return withKey(readOverrides(p), key, value)
}

/** The placement's overrides with one `options` key set or removed. */
export function withOption(p: PlacementRow, key: string, value: unknown): Obj | null {
  const ov = readOverrides(p)
  return withKey(ov, 'options', withKey(asObject(ov.options), key, value) ?? undefined)
}

export function placementAt(p: { field: string; group_key: string | null }): PlacementKey {
  return { field: p.field, group_key: p.group_key }
}

export function findPlacement(
  bundle: LayoutBundle,
  field: string,
  groupKey: string | null
): PlacementRow | null {
  return bundle.placements.find((p) => p.field === field && p.group_key === groupKey) ?? null
}

/** Row rules, row lints, picker enforcement, max values and line SLA are
 *  enforced by the server only from the active grouped layout (spec §9.12). */
export function isDefaultForm(layout: LayoutRow): boolean {
  const type = (layout.layout_type as string | null | undefined) ?? 'grouped'
  return !!layout.is_active && type === 'grouped'
}

export function layoutTypeOf(layout: LayoutRow): string {
  return (layout.layout_type as string | null | undefined) || 'grouped'
}

// ── Lock conditions (assignment column, JSON text) ──────────────────────────

export interface LockCondition {
  type: 'pipeline_state' | 'role'
  pipeline_id?: string
  state_keys?: string[]
  role_ids?: string[]
}

export function lockConditionsOf(p: PlacementRow | null): LockCondition[] {
  return p ? asArray<LockCondition>(p.lock_conditions) : []
}

export function lockConditionsColumn(list: LockCondition[]): string | null {
  return list.length ? JSON.stringify(list) : null
}

// ── input_bindings (inline display, header meta, subtitle, widget inputs) ───

export interface Binding {
  key: string
  binding_type: string
  binding_value: unknown
}

export function bindingsOf(p: PlacementRow | null): Binding[] {
  if (!p) return []
  const raw = parseJsonish<unknown>(p.input_bindings)
  if (Array.isArray(raw)) return raw.filter((b): b is Binding => !!b && typeof b === 'object')
  // Legacy object form { key: value }
  if (raw && typeof raw === 'object')
    return Object.entries(raw as Obj).map(([key, v]) => ({
      key,
      binding_type: 'static',
      binding_value: v
    }))
  return []
}

export function bindingValue(p: PlacementRow | null, key: string): unknown {
  return bindingsOf(p).find((b) => b.key === key)?.binding_value
}

/** The bindings with one static key set (value) or removed (null/undefined/''). */
export function withStaticBinding(p: PlacementRow, key: string, value: unknown): Binding[] | null {
  const rest = bindingsOf(p).filter((b) => b.key !== key)
  const next =
    value === undefined || value === null || value === ''
      ? rest
      : [...rest, { key, binding_type: 'static', binding_value: value }]
  return next.length ? next : null
}

export interface InlineDisplay {
  entries: Array<{
    field: string
    label: string | null
    format: string | null
    line_break?: boolean
  }>
  separator: string | null
}

export function inlineDisplayOf(p: PlacementRow | null): InlineDisplay {
  const raw = parseJsonish<unknown>(bindingValue(p, '__inline_display__'))
  if (Array.isArray(raw)) return { entries: raw as InlineDisplay['entries'], separator: null }
  if (raw && typeof raw === 'object') {
    const o = raw as { fields?: unknown; separator?: unknown }
    return {
      entries: Array.isArray(o.fields) ? (o.fields as InlineDisplay['entries']) : [],
      separator: typeof o.separator === 'string' ? o.separator : null
    }
  }
  return { entries: [], separator: null }
}

export function withInlineDisplay(p: PlacementRow, cfg: InlineDisplay): Binding[] | null {
  const value =
    cfg.entries.length || cfg.separator !== null
      ? JSON.stringify({ fields: cfg.entries, separator: cfg.separator })
      : null
  return withStaticBinding(p, '__inline_display__', value)
}

// ── Subtitle (`__subtitle__` row) ───────────────────────────────────────────

export const SUBTITLE_FIELD = '__subtitle__'

export interface SubtitleItem {
  field: string
  label: string | null
  color?: string
  weight?: string
  display_as?: string
}
export interface SubtitleConfig {
  fields: SubtitleItem[]
  separator: string
}

export function subtitleOf(bundle: LayoutBundle): SubtitleConfig | null {
  const row = bundle.placements.find((p) => p.field === SUBTITLE_FIELD)
  if (!row) return null
  const cfg = asObject(bindingValue(row, '__subtitle_config__'))
  return {
    fields: Array.isArray(cfg.fields) ? (cfg.fields as SubtitleItem[]) : [],
    separator: typeof cfg.separator === 'string' ? cfg.separator : ' | '
  }
}

export function subtitleBindings(cfg: SubtitleConfig): Binding[] {
  return [
    { key: '__subtitle_config__', binding_type: 'static', binding_value: JSON.stringify(cfg) }
  ]
}

// ── Layout default values ───────────────────────────────────────────────────

export function defaultValuesOf(layout: LayoutRow): Obj {
  return asObject(layout.default_values)
}

export function withDefaultValue(layout: LayoutRow, field: string, value: unknown): Obj | null {
  const empty =
    value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)
  return withKey(defaultValuesOf(layout), field, empty ? undefined : value)
}

// ── Grids on this layout (for "Apply to lines") ─────────────────────────────

export function layoutGrids(
  bundle: LayoutBundle,
  globals: GlobalFieldRow[],
  relations: RelationRow[]
): Array<{ field: string; label: string; childCollection: string | null }> {
  const seen = new Set<string>()
  const out: Array<{ field: string; label: string; childCollection: string | null }> = []
  for (const p of bundle.placements) {
    if (p.field.startsWith('__') || p.field.includes('.') || seen.has(p.field)) continue
    if (relKindOf(p.field, relations) !== 'O2M') continue
    seen.add(p.field)
    out.push({
      field: p.field,
      label: describeField(p.field, globals, relations, p).label,
      childCollection: relatedCollectionOf(p.field, relations)
    })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

// ── Inheritance (#424) ──────────────────────────────────────────────────────

export function placementPatchOf(row: PlacementRow): PlacementPatch {
  const patch: Obj = {}
  for (const k of PLACEMENT_PATCH_KEYS) patch[k] = row[k]
  return patch as PlacementPatch
}

function groupPatchOf(g: GroupRow): GroupPatch {
  const { id: _id, key: _key, parent_key: _p, sort: _s, label: _l, ...rest } = g
  return rest as GroupPatch
}

/**
 * Ops that copy an inherited placement into the child layout ("Override
 * here"). A group the child does not have yet is copied first (with its
 * container when it sits in one), so the placement keeps its section.
 */
export function overridePlacementOps(
  bundle: LayoutBundle,
  parent: LayoutBundle,
  row: PlacementRow
): LayoutOp[] {
  const ops: LayoutOp[] = []
  let groupKey = row.group_key
  if (groupKey && groupKey !== HEADER_GROUP_KEY && !bundle.groups.some((g) => g.key === groupKey)) {
    const pg = parent.groups.find((g) => g.key === groupKey)
    if (pg) ops.push(...overrideGroupOps(bundle, parent, pg))
    else groupKey = null
  }
  const zone = bundle.placements.filter((p) => p.group_key === groupKey)
  ops.push({
    op: 'place',
    field: row.field,
    group_key: groupKey,
    index: Math.min(row.sort, zone.length),
    patch: placementPatchOf(row)
  })
  return ops
}

/** Ops that copy an inherited group (and its container) into the child. */
export function overrideGroupOps(
  bundle: LayoutBundle,
  parent: LayoutBundle,
  g: GroupRow
): LayoutOp[] {
  if (bundle.groups.some((x) => x.key === g.key)) return []
  const ops: LayoutOp[] = []
  let parentKey = g.parent_key
  if (parentKey && !bundle.groups.some((x) => x.key === parentKey)) {
    const container = parent.groups.find((x) => x.key === parentKey)
    if (container) ops.push(...overrideGroupOps(bundle, parent, container))
    else parentKey = null
  }
  const siblings = bundle.groups.filter((x) => x.parent_key === parentKey)
  ops.push({
    op: 'group_create',
    key: g.key,
    label: g.label,
    group_type: parentKey ? 'tab' : g.type,
    parent_key: parentKey,
    index: Math.min(g.sort, siblings.length),
    patch: { ...groupPatchOf(g), type: parentKey ? 'tab' : g.type }
  })
  return ops
}

/** Field names a group places (for collapsed summary / skip-if-filled pickers). */
export function groupFields(bundle: LayoutBundle, key: string): string[] {
  const keys = new Set([
    key,
    ...bundle.groups.filter((g) => g.parent_key === key).map((g) => g.key)
  ])
  return bundle.placements
    .filter((p) => p.group_key && keys.has(p.group_key) && !p.field.startsWith('__'))
    .map((p) => p.field)
}

/**
 * The record page draws slot cards without a row after every section and slot
 * row, in this order (ItemEditForm renderSectionMode).
 */
export const ROWLESS_SLOT_ORDER = [
  '__pipeline__',
  '__tasks__',
  '__related_records__',
  '__referenced_by__',
  '__comments__',
  '__addendums__'
]

/**
 * Whether the record page draws a slot open when it has no row (ItemEditForm
 * renderSentinel and the rowless panels: Pipeline, Tasks, Comments, Related
 * records and Owners start folded; Referenced by and Addendums start open).
 * A first row writes this, so giving a slot a row never changes how it opens.
 */
export const ROWLESS_SLOT_EXPANDED: Record<string, boolean> = {
  __pipeline__: false,
  __tasks__: false,
  __related_records__: false,
  __referenced_by__: true,
  __comments__: false,
  __addendums__: true,
  __owners__: false
}

export function rowlessExpanded(field: string): boolean {
  return ROWLESS_SLOT_EXPANDED[field] ?? true
}

/**
 * Ops that give a slot without a row its first row, where it is drawn now:
 * after the top-level sections and slot rows, with rows for the rowless slots
 * drawn before it (so renaming Comments does not lift it above Tasks). In a
 * section: the end of that section.
 */
export function placeSlotOps(
  bundle: LayoutBundle,
  field: string,
  groupKey: string | null,
  patch: PlacementPatch
): LayoutOp[] {
  // Panels keep how they open without a row (other slots have no fold).
  const own =
    field in ROWLESS_SLOT_EXPANDED ? { default_expanded: rowlessExpanded(field), ...patch } : patch
  if (groupKey !== null) {
    const n = bundle.placements.filter((p) => p.group_key === groupKey).length
    return [{ op: 'place', field, group_key: groupKey, index: n, patch: own }]
  }
  const top =
    bundle.groups.filter((g) => g.parent_key === null).length +
    bundle.placements.filter(isCanvasSlot).length
  const at = ROWLESS_SLOT_ORDER.indexOf(field)
  // Rowless = no row anywhere: a slot placed in a section is drawn there, not here.
  const before = (at < 0 ? [] : ROWLESS_SLOT_ORDER.slice(0, at)).filter(
    (f) => !bundle.placements.some((p) => p.field === f)
  )
  return [
    ...before.map(
      (f, i): LayoutOp => ({
        op: 'place',
        field: f,
        group_key: null,
        index: top + i,
        patch: { default_expanded: rowlessExpanded(f) }
      })
    ),
    { op: 'place', field, group_key: null, index: top + before.length, patch: own }
  ]
}
