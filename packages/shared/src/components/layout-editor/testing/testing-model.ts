import { TABLE_FORM_GROUP_KEYS } from '../../../lib/layout-ops'
import { matchesVisibleWhen, parseVisibleWhen } from '../../../lib/visible-when'
import { SYSTEM_FIELDS } from '../../item-edit/helpers'
import { deferredSections } from '../../item-edit/lazy-sections'
import type { ActiveLayoutData, FieldGroup } from '../../item-edit/types'
import { fieldAccessForRole, type RoleAccessInput } from '../preview/preview-model'

// Pure logic behind the editor's checks: test records pinned to a layout
// (#2646), what a save changes for them (#2647), the new-record walkthrough
// (#2648) and the form cost estimate (#2649). The server answers which form a
// record resolves to (the live resolver) and what its role may do; these
// functions lay the draft's own rules over that.

// ─── Stored settings: conditions.testing ────────────────────────────────────

export interface PinnedRecord {
  item: string
  /** Test as this role; null = as an administrator. */
  role_id: string | null
}

export interface TestingConfig {
  records: PinnedRecord[]
  /** Warn above this many requests on open; null = DEFAULT_COST_LIMIT. */
  cost_limit: number | null
}

export const MAX_PINNED = 5
export const DEFAULT_COST_LIMIT = 40

function asObject(raw: unknown): Record<string, unknown> | null {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** The layout's pinned test records and cost limit (conditions.testing). */
export function readTesting(conditions: unknown): TestingConfig {
  const t = asObject(asObject(conditions)?.testing)
  const records: PinnedRecord[] = []
  if (Array.isArray(t?.records))
    for (const r of t.records as Array<{ item?: unknown; role_id?: unknown }>) {
      if (r?.item == null || r.item === '') continue
      const pin = { item: String(r.item), role_id: r.role_id ? String(r.role_id) : null }
      if (!records.some((x) => samePin(x, pin))) records.push(pin)
    }
  const limit = Number(t?.cost_limit)
  return {
    records: records.slice(0, MAX_PINNED),
    cost_limit: Number.isFinite(limit) && limit > 0 ? Math.round(limit) : null
  }
}

export const samePin = (a: PinnedRecord, b: PinnedRecord) =>
  a.item === b.item && (a.role_id ?? '').toUpperCase() === (b.role_id ?? '').toUpperCase()

/** Layout `conditions`: the role list plus, here, `testing`. */
export type LayoutConditions = ({ role_ids?: string[] } & Record<string, unknown>) | null

function conditionsWith(conditions: unknown, key: string, value: unknown): LayoutConditions {
  const next: Record<string, unknown> = { ...(asObject(conditions) ?? {}) }
  if (value == null) delete next[key]
  else next[key] = value
  return Object.keys(next).length > 0 ? next : null
}

/** The `conditions` patch that stores `testing`, keeping the role list. */
export function testingPatch(conditions: unknown, next: TestingConfig) {
  const empty = next.records.length === 0 && next.cost_limit == null
  return {
    conditions: conditionsWith(
      conditions,
      'testing',
      empty
        ? null
        : {
            records: next.records.slice(0, MAX_PINNED),
            ...(next.cost_limit != null ? { cost_limit: next.cost_limit } : {})
          }
    )
  }
}

/** The `conditions` patch that sets who gets the form, keeping the test records. */
export function roleIdsPatch(conditions: unknown, ids: string[]) {
  return { conditions: conditionsWith(conditions, 'role_ids', ids.length ? ids : null) }
}

// ─── What a record sees on a form (#2646) ───────────────────────────────────

export type SeenAccess = 'editable' | 'readonly'

const groupsByKey = (layout: ActiveLayoutData) => new Map(layout.groups.map((g) => [g.key, g]))

function roleListed(raw: unknown, roleId: string | null): boolean {
  if (!roleId || raw == null || raw === '') return false
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(v) && v.some((r) => String(r).toUpperCase() === roleId.toUpperCase())
  } catch {
    return false
  }
}

const roleRule = (g: FieldGroup | undefined, k: 'hidden_for_roles' | 'locked_for_roles') =>
  (g as Record<string, unknown> | undefined)?.[k]

/**
 * Does this group show for these values? The form honours visibility
 * conditions on its top-level tabs / steps only (#139): a group shows unless
 * it is, or sits inside, a top-level tab whose conditions fail.
 */
export function groupShown(
  g: FieldGroup,
  layout: ActiveLayoutData,
  values: Record<string, unknown>
): boolean {
  const byId = new Map(layout.groups.map((x) => [x.id, x]))
  let cur: FieldGroup | undefined = g
  const seen = new Set<number>()
  while (cur) {
    if (cur.type === 'tab' && cur.container_id == null)
      return matchesVisibleWhen((cur as { visible_when?: unknown }).visible_when, values)
    if (cur.container_id == null || seen.has(cur.id)) return true
    seen.add(cur.id)
    cur = byId.get(cur.container_id)
  }
  return true
}

/**
 * The fields a record opened on this form shows, and whether its role can
 * edit each: placements left visible, in sections whose conditions hold for
 * the record's values, through the role's field permissions and the form's
 * role rules (fieldAccessForRole). `access` null = an administrator.
 * Pipeline-state locks are not judged (they depend on the workflow).
 */
export function formView(
  layout: ActiveLayoutData,
  values: Record<string, unknown>,
  access: RoleAccessInput | null
): Map<string, SeenAccess> {
  const groups = groupsByKey(layout)
  const roleAccess = access && !access.role.admin_access ? fieldAccessForRole(access, layout) : null
  const out = new Map<string, SeenAccess>()
  for (const a of layout.assignments) {
    if (a.field.startsWith('__')) continue
    if (a.is_visible === false || a.is_visible === 0 || overrideHidden(a.overrides)) continue
    const gk = a.group_key ?? null
    if (gk != null && gk !== '__header__') {
      if (TABLE_FORM_GROUP_KEYS.includes(gk)) continue
      const g = groups.get(gk)
      if (!g || !groupShown(g, layout, values)) continue
    }
    let v: SeenAccess | 'hidden' = 'editable'
    if (access && !access.role.admin_access) v = roleAccess?.get(a.field) ?? 'hidden'
    if (v === 'hidden') continue
    if (out.get(a.field) !== 'editable') out.set(a.field, v)
  }
  return out
}

/** The inspector's Hidden: the placement's overrides say hidden (the form then leaves it off). */
function overrideHidden(raw: unknown): boolean {
  if (raw == null || raw === '') return false
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return !!v && typeof v === 'object' && (v as { hidden?: unknown }).hidden === true
  } catch {
    return false
  }
}

/** Fields the form's step conditions read (top-level tabs only, as the form) — what a check asks the record for. */
export function conditionFields(...layouts: Array<ActiveLayoutData | null | undefined>): string[] {
  const out = new Set<string>()
  for (const l of layouts)
    for (const g of l?.groups ?? [])
      if (g.type === 'tab' && g.container_id == null)
        for (const r of parseVisibleWhen((g as { visible_when?: unknown }).visible_when))
          if (r.field && /^[A-Za-z_][A-Za-z0-9_]*$/.test(r.field)) out.add(r.field)
  return [...out]
}

// ─── Comparing two outcomes (#2646, #2647) ──────────────────────────────────

export interface FormRef {
  layout_id: number
  name: string
}

export interface RecordOutcome {
  /** The form the record opens on; null = none. */
  form: FormRef | null
  /** The fields it shows when that form is this one; null otherwise. */
  view: Map<string, SeenAccess> | null
}

export interface OutcomeChange {
  kind: 'form' | 'lost' | 'gained' | 'readonly' | 'editable'
  text: string
  fields?: string[]
}

/** "Zone", "Zone and Region", "Zone, Region and 3 more". */
export function nameList(names: string[], max = 3): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`
}

const quote = (f: FormRef | null) => (f ? `“${f.name}”` : 'no form')

/**
 * What changes for one record between two outcomes, as plain sentences
 * without the subject ("loses the Zone field", "lands on another form: “X”").
 */
export function compareOutcomes(
  before: RecordOutcome,
  after: RecordOutcome,
  label: (field: string) => string
): OutcomeChange[] {
  const out: OutcomeChange[] = []
  const was = before.form?.layout_id ?? null
  const now = after.form?.layout_id ?? null
  if (was !== now) {
    if (before.view && !after.view)
      out.push({ kind: 'form', text: `lands on another form: ${quote(after.form)}` })
    else if (!before.view && after.view)
      out.push({ kind: 'form', text: `now opens on this form (was ${quote(before.form)})` })
    else
      out.push({
        kind: 'form',
        text: `moves from ${quote(before.form)} to ${quote(after.form)}`
      })
    return out
  }
  if (!before.view || !after.view) return out
  const lost: string[] = []
  const gained: string[] = []
  const toReadonly: string[] = []
  const toEditable: string[] = []
  for (const [f, v] of before.view) {
    const n = after.view.get(f)
    if (!n) lost.push(f)
    else if (v === 'editable' && n === 'readonly') toReadonly.push(f)
    else if (v === 'readonly' && n === 'editable') toEditable.push(f)
  }
  for (const f of after.view.keys()) if (!before.view.has(f)) gained.push(f)
  const names = (fs: string[]) => nameList(fs.map(label))
  if (lost.length)
    out.push({
      kind: 'lost',
      fields: lost,
      text: lost.length === 1 ? `loses the ${names(lost)} field` : `loses ${names(lost)} fields`
    })
  if (gained.length)
    out.push({
      kind: 'gained',
      fields: gained,
      text:
        gained.length === 1 ? `gains the ${names(gained)} field` : `gains ${names(gained)} fields`
    })
  if (toReadonly.length)
    out.push({
      kind: 'readonly',
      fields: toReadonly,
      text: `can no longer edit ${names(toReadonly)}`
    })
  if (toEditable.length)
    out.push({ kind: 'editable', fields: toEditable, text: `can now edit ${names(toEditable)}` })
  return out
}

// ─── New-record walkthrough (#2648) ─────────────────────────────────────────

/** One placement as the form formats it (POST /field-config/:c/project). */
export interface FormFieldRow {
  field: string
  label?: string | null
  type?: string | null
  interface?: string | null
  required?: boolean
  readonly?: boolean
  hidden?: boolean
  group_key?: string | null
  layout_assigned?: boolean
  default_formula?: string | null
  computed_type?: string | null
  remote_options_config?: unknown
}

/** POST /collection-layouts/:id/walkthrough-access. */
export interface WalkAccess {
  role: { id: string; name: string; admin_access: boolean } | null
  role_may_open: boolean
  can_create: boolean
  /** null = every field */
  create_fields: string[] | null
  hidden_fields: string[]
  new_record_form: (FormRef & { why?: string | null }) | null
  column_defaults: string[]
}

export type WalkStatus = 'fill' | 'prefilled' | 'blocked' | 'skipped'

export interface WalkField {
  field: string
  label: string
  status: WalkStatus
  reason?: string
}

export interface WalkStep {
  key: string
  label: string
  /** Hidden for these values: the person never sees it. */
  hidden: boolean
  fields: WalkField[]
}

export interface WalkBlocker {
  /** Index into steps; -1 = before the form opens; steps.length = at Save. */
  step: number
  where: string
  field?: string
  reason: string
}

export interface WalkResult {
  steps: WalkStep[]
  /** The first point the record cannot get past; null = it saves. */
  blocker: WalkBlocker | null
  /** Required fields the form never asks for: the record saves without them. */
  skipped: WalkField[]
  notes: string[]
}

const filled = (v: unknown) =>
  v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)

/**
 * Act out creating a record on this form as a role, step by step: which
 * required fields each step asks for and whether the role can fill them. A
 * required field the role cannot fill (read-only, locked, or in a step or
 * section hidden for these values) stops the walk where the form would stop
 * the person: at Next when the form validates before moving on, else at Save.
 * Required fields the form never shows (hidden, not placed, out of the role's
 * sight) are skipped by the form's own validation: the record saves without
 * them, listed in `skipped`. Nothing is written.
 */
export function walkthrough(input: {
  layout: ActiveLayoutData
  rows: FormFieldRow[]
  access: WalkAccess
  /** Values the person would have entered, laid over the defaults. */
  values?: Record<string, unknown>
  thisLayoutId: number
  /** Field labels (the collection's field config); default: the row's label, else the name. */
  label?: (field: string) => string
}): WalkResult {
  const { layout, rows, access, thisLayoutId } = input
  const meta = layout.layout
  const roleId = access.role && !access.role.admin_access ? access.role.id : null
  const notes: string[] = []
  const skipped: WalkField[] = []
  const steps: WalkStep[] = []

  const label = (f: string) => {
    const r = rows.find((x) => x.field === f)
    return r?.label || input.label?.(f) || f
  }
  const values: Record<string, unknown> = {}
  const layoutDefaults = (meta as { default_values?: Record<string, unknown> | null } | null)
    ?.default_values
  for (const [k, v] of Object.entries(layoutDefaults ?? {})) values[k] = v
  for (const [k, v] of Object.entries(input.values ?? {})) values[k] = v
  const prefilled = (r: FormFieldRow) =>
    filled(values[r.field]) ||
    !!r.default_formula ||
    access.column_defaults.some((c) => c.toLowerCase() === r.field.toLowerCase())

  if (access.new_record_form && access.new_record_form.layout_id !== thisLayoutId)
    notes.push(
      `New records open on “${access.new_record_form.name}” for ${access.role?.name ?? 'administrators'} unless they pick this form.`
    )
  if (!access.role_may_open)
    return {
      steps,
      skipped,
      notes,
      blocker: {
        step: -1,
        where: 'Opening the form',
        reason: `${access.role?.name ?? 'This role'} is not on this form’s role list, so it never opens it.`
      }
    }
  if (!access.can_create)
    return {
      steps,
      skipped,
      notes,
      blocker: {
        step: -1,
        where: 'Opening the form',
        reason: `${access.role?.name ?? 'This role'} may not create records in this collection.`
      }
    }

  const groups = groupsByKey(layout)
  const hiddenRead = new Set(access.hidden_fields)
  const createSet = access.create_fields ? new Set(access.create_fields) : null

  // The steps, as the form builds them: "General" (fields outside any tab),
  // then each container's tabs and the top-level tabs in order. Only the
  // top-level tabs in steps mode validate on Next (validate before next).
  const bySort = (a: FieldGroup, b: FieldGroup) => a.sort - b.sort
  const byId = new Map(layout.groups.map((x) => [x.id, x]))
  const legacyTabs = layout.groups
    .filter((g) => g.type === 'tab' && g.container_id == null)
    .sort(bySort)
  const containerTabs = layout.groups
    .filter((g) => g.type === 'container')
    .sort(bySort)
    .flatMap((c) =>
      layout.groups.filter((g) => g.type === 'tab' && g.container_id === c.id).sort(bySort)
    )
  const stepsMode = legacyTabs.length > 0 && meta?.tab_mode === 'steps'
  const validateNext = stepsMode && !!meta?.validate_before_next
  const tabOf = (gk: string | null | undefined): string | null => {
    let g = gk ? groups.get(gk) : undefined
    const seen = new Set<number>()
    while (g) {
      if (g.type === 'tab') return g.key
      if (g.container_id == null || seen.has(g.id)) return null
      seen.add(g.id)
      g = byId.get(g.container_id)
    }
    return null
  }

  type Slot = { key: string; label: string; group: FieldGroup | null; validates: boolean }
  const anyTabs = legacyTabs.length + containerTabs.length > 0
  const slots: Slot[] = anyTabs
    ? [
        { key: '__general__', label: 'General', group: null, validates: validateNext },
        ...containerTabs.map((t) => ({
          key: t.key,
          label: t.label || t.key,
          group: t,
          validates: false
        })),
        ...legacyTabs.map((t) => ({
          key: t.key,
          label: t.label || t.key,
          group: t,
          validates: validateNext
        }))
      ]
    : [{ key: '__form__', label: 'The form', group: null, validates: false }]
  // In steps mode the sections float beside every step: checked at Save.
  const FLOAT = '__float__'
  const slotOf = (gk: string | null | undefined): string => {
    if (!anyTabs) return '__form__'
    const tab = tabOf(gk)
    if (tab) return tab
    if (!gk || gk === '__header__') return '__general__'
    return stepsMode ? FLOAT : '__general__'
  }

  const atSave: WalkField[] = []
  const seen = new Set<string>()
  const judge = (r: FormFieldRow): WalkField | null => {
    if (!r.required || SYSTEM_FIELDS.has(r.field) || r.field.startsWith('__')) return null
    const base = { field: r.field, label: label(r.field) }
    const g = r.group_key ? groups.get(r.group_key) : undefined
    if (r.hidden) return { ...base, status: 'skipped', reason: 'hidden on this form' }
    if (hiddenRead.has(r.field) || roleListed(roleRule(g, 'hidden_for_roles'), roleId))
      return {
        ...base,
        status: 'skipped',
        reason: `${access.role?.name ?? 'the role'} cannot see it`
      }
    if (g && !groupShown(g, layout, values))
      return {
        ...base,
        status: 'blocked',
        reason: `its section “${g.label || g.key}” is hidden for these values`
      }
    if (prefilled(r)) return { ...base, status: 'prefilled' }
    if (createSet && !createSet.has(r.field))
      return { ...base, status: 'blocked', reason: `${access.role?.name} may not write it` }
    if (roleListed(roleRule(g, 'locked_for_roles'), roleId))
      return {
        ...base,
        status: 'blocked',
        reason: `its section is locked for ${access.role?.name}`
      }
    const placement = layout.assignments.find(
      (a) => a.field === r.field && (a.group_key ?? null) === (r.group_key ?? null)
    )
    if (roleId && lockRoles(placement?.lock_conditions).includes(roleId.toUpperCase()))
      return { ...base, status: 'blocked', reason: `it is locked for ${access.role?.name}` }
    if (r.readonly) return { ...base, status: 'blocked', reason: 'it is read-only on this form' }
    return { ...base, status: 'fill' }
  }

  const bySlot = new Map<string, WalkField[]>()
  for (const r of rows) {
    if (r.layout_assigned === false) {
      if (r.required && !r.hidden && !SYSTEM_FIELDS.has(r.field) && !r.field.startsWith('__'))
        skipped.push({
          field: r.field,
          label: label(r.field),
          status: 'skipped',
          reason: 'not on this form'
        })
      continue
    }
    const key = `${r.field}\u0000${r.group_key ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const j = judge(r)
    if (!j) continue
    if (j.status === 'skipped') {
      if (!skipped.some((s) => s.field === j.field)) skipped.push(j)
      continue
    }
    const slot = slotOf(r.group_key)
    if (slot === FLOAT) atSave.push(j)
    else bySlot.set(slot, [...(bySlot.get(slot) ?? []), j])
  }
  // A field placed twice is fillable when any of its placements is.
  const fillable = new Set(
    [...bySlot.values(), atSave]
      .flat()
      .filter((f) => f.status !== 'blocked')
      .map((f) => f.field)
  )

  const slotUsed = new Set(
    layout.assignments
      .filter((a) => !a.field.startsWith('__') && a.is_visible !== false && a.is_visible !== 0)
      .map((a) => slotOf(a.group_key))
  )
  const validating = new Set<string>()
  for (const s of slots) {
    const hidden = s.group ? !groupShown(s.group, layout, values) : false
    const fields = (bySlot.get(s.key) ?? []).map((f) =>
      f.status === 'blocked' && fillable.has(f.field)
        ? { ...f, status: 'fill' as const, reason: undefined }
        : hidden && f.status !== 'prefilled'
          ? {
              ...f,
              status: 'blocked' as const,
              reason: `its step “${s.label}” is hidden for these values`
            }
          : f
    )
    if (s.key === '__general__' && !slotUsed.has(s.key)) continue
    steps.push({ key: s.key, label: s.label, hidden, fields })
    if (s.validates) validating.add(s.key)
  }

  // Walk: Next validates only on top-level steps with validate-before-next on.
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    if (s.hidden) continue
    const stop = s.fields.find((f) => f.status === 'blocked')
    if (stop && validating.has(s.key) && i < steps.length - 1)
      return {
        steps,
        skipped,
        notes,
        blocker: {
          step: i,
          where: `Next on “${s.label}”`,
          field: stop.field,
          reason: `${stop.label} is required, but ${stop.reason}.`
        }
      }
  }
  const saveBlock =
    [...steps.flatMap((s) => s.fields), ...atSave].find(
      (f) => f.status === 'blocked' && !fillable.has(f.field)
    ) ?? null
  if (saveBlock)
    return {
      steps,
      skipped,
      notes,
      blocker: {
        step: steps.length,
        where: 'Save',
        field: saveBlock.field,
        reason: `${saveBlock.label} is required, but ${saveBlock.reason}.`
      }
    }
  return { steps, skipped, notes, blocker: null }
}

function lockRoles(raw: unknown): string[] {
  if (raw == null || raw === '') return []
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!Array.isArray(v)) return []
    return v.flatMap((c: { type?: string; role_ids?: unknown }) =>
      c?.type === 'role' && Array.isArray(c.role_ids)
        ? c.role_ids.map((r) => String(r).toUpperCase())
        : []
    )
  } catch {
    return []
  }
}

// ─── Form cost (#2649) ──────────────────────────────────────────────────────

export type CostKind = 'base' | 'picker' | 'grid' | 'widget' | 'panel' | 'query'

export interface CostItem {
  kind: CostKind
  key: string
  label: string
  requests: number
  /** #2713: in a folded section that loads when opened — asked for on open, not up front. */
  deferred?: boolean
}

export interface FormCost {
  /** Requests on open (deferred items left out). */
  total: number
  /** Requests the sections that load when opened hold back until someone opens them. */
  deferred: number
  items: CostItem[]
  counts: Record<Exclude<CostKind, 'base'>, number>
}

export interface CostRelation {
  many_collection: string | null
  many_field: string | null
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

/** What every record page asks for whatever the form: the record, its form, field config, relations, permissions. */
export const BASE_REQUESTS = 5

const GRID_INTERFACES = new Set(['inline-table', 'inline-grid', 'list-o2m', 'relation-list'])
const PANEL_REQUESTS: Record<string, number> = {
  __pipeline__: 2,
  __tasks__: 1,
  __comments__: 1,
  __addendums__: 1,
  __referenced_by__: 1,
  __related_records__: 1,
  __owners__: 1,
  __pdf__: 0
}
const PANEL_LABELS: Record<string, string> = {
  __pipeline__: 'Workflow',
  __tasks__: 'Tasks',
  __comments__: 'Comments',
  __addendums__: 'Addendums',
  __referenced_by__: 'Referenced by',
  __related_records__: 'Related records',
  __owners__: 'Owners',
  __pdf__: 'PDF'
}

/**
 * Roughly how many requests the form fires when it opens: the record page's
 * own reads, one per picker (its current value's label), three per inline
 * grid (rows, their columns, their field config), one per widget, panel
 * and relation-path or remote-options field. Every visible placement counts,
 * collapsed sections too — except folded sections that load when opened
 * (#2713), whose requests wait for the open and are counted apart. An
 * estimate to compare forms by, not a measurement.
 */
export function formCost(input: {
  layout: ActiveLayoutData
  rows: FormFieldRow[]
  relations: CostRelation[]
  collection: string
}): FormCost {
  const { layout, rows, relations, collection } = input
  const items: CostItem[] = [
    { kind: 'base', key: '__base__', label: 'The record page itself', requests: BASE_REQUESTS }
  ]
  const groups = groupsByKey(layout)
  const rowOf = (field: string, gk: string | null) =>
    rows.find((r) => r.field === field && (r.group_key ?? null) === gk) ??
    rows.find((r) => r.field === field)
  for (const a of layout.assignments) {
    if (a.is_visible === false || a.is_visible === 0) continue
    const gk = a.group_key ?? null
    if (gk && TABLE_FORM_GROUP_KEYS.includes(gk)) continue
    if (gk && gk !== '__header__' && !groups.has(gk)) continue
    const key = `${a.field}\u0000${gk ?? ''}`
    if (a.widget_id != null) {
      items.push({
        kind: 'widget',
        key,
        label: a.label_override || `Widget ${a.widget_id}`,
        requests: 1
      })
      continue
    }
    if (a.field.startsWith('__')) {
      const ext = /^__ext_/.test(a.field)
      const n = ext ? 1 : (PANEL_REQUESTS[a.field] ?? 0)
      if (n > 0)
        items.push({
          kind: ext ? 'widget' : 'panel',
          key,
          label: PANEL_LABELS[a.field] ?? a.field.replace(/^__ext_|__$/g, ''),
          requests: n
        })
      continue
    }
    const r = rowOf(a.field, gk)
    if (r?.hidden || overrideHidden(a.overrides)) continue
    const name = a.label_override || r?.label || a.field
    if (a.field.includes('.')) {
      items.push({ kind: 'query', key, label: name, requests: 1 })
      continue
    }
    const iface = r?.interface ?? ''
    const alias = relations.find((x) => x.one_collection === collection && x.one_field === a.field)
    const m2o = relations.some((x) => x.many_collection === collection && x.many_field === a.field)
    if (GRID_INTERFACES.has(iface) || (alias && !alias.junction_field && iface !== 'files-m2m'))
      items.push({ kind: 'grid', key, label: name, requests: 3 })
    else if (alias || m2o || /user|file|m2o|m2m/.test(iface))
      items.push({ kind: 'picker', key, label: name, requests: 1 })
    else if (r?.remote_options_config) items.push({ kind: 'query', key, label: name, requests: 1 })
  }
  const lazy = deferredSections(layout, new Set()).groups
  if (lazy.size > 0)
    for (const i of items) {
      const gk = i.key.split('\u0000')[1] ?? ''
      if (gk && lazy.has(gk)) i.deferred = true
    }
  const counts = { picker: 0, grid: 0, widget: 0, panel: 0, query: 0 }
  for (const i of items) if (i.kind !== 'base' && !i.deferred) counts[i.kind]++
  const sum = (list: CostItem[]) => list.reduce((s, i) => s + i.requests, 0)
  return {
    total: sum(items.filter((i) => !i.deferred)),
    deferred: sum(items.filter((i) => i.deferred)),
    items,
    counts
  }
}
