import { db } from '../db/index.js'
import { resolveLayout, roleAllows } from '../routes/collection-layouts.js'
import {
  formatLayoutFieldRows,
  hiddenByVisibilityRules,
  lockedByLockCondition,
  normalizeLayoutAssignment
} from '../routes/field-config.js'
import type { User } from '../types.js'
import type { RoleRef } from './ai-design/layout-explain-field.js'
import { type LayoutFacts, loadLayoutFacts } from './ai-design/layout-facts.js'
import { mergeInherited } from './layout-lint.js'
import { HEADER_GROUP_KEY, UNGROUPED_KEY } from './layout-ops-apply.js'
import { isSystemCollection } from './system-collections.js'
import { applyValidationRule, type ValidationRule } from './validation-rules.js'
import { matchesVisibleWhen } from './visible-when.js'

/**
 * Form state (#3218): for a collection, an optional record and layout and
 * some field values, which fields the resolved form shows, requires and
 * locks — and why. Nothing here is a new rule: the form is picked by the
 * live resolver (resolveLayout, the caller's ResolveContext, the values laid
 * over the record for record rules), the field rows come from the same
 * formatter GET /field-config answers (formatLayoutFieldRows: layout
 * overrides, computed fields), field-level show/hide and lock rules from the
 * evaluators behind /field-config/:c/evaluate-visibility and evaluate-lock,
 * section rules from the visible-when twin the record form uses, required
 * from the validation evaluator the write path enforces, and value rules
 * (nivaro_field_rules) from the engine POST /field-rules/evaluate runs.
 *
 * Judged AS THE CALLER (their permissions, User Scopes, record access), or —
 * administrators only — as a role, through a synthetic member of it (the
 * preview-as-role precedent). Record values never leave here except the
 * values the form's own rules would fill in (`derived`), and only fields
 * the judged principal may read.
 */

type Obj = Record<string, unknown>

const SYNTHETIC_USER_ID = '00000000-0000-0000-0000-000000000000'
const MAX_VALUES = 300
const MAX_TRIGGERS = 25

export class FormStateError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message)
  }
}

export type HiddenReason =
  | 'permission'
  | 'off_on_form'
  | 'field_hidden'
  | 'field_rule'
  | 'section_role'
  | 'section_rule'

export type LockReason =
  | 'record'
  | 'permission'
  | 'readonly'
  | 'computed'
  | 'role_rule'
  | 'state_rule'
  | 'section_role'
  | 'field_rule'

export interface FormFieldState {
  field: string
  label: string
  group_key: string | null
  section: string | null
  visible: boolean
  required: boolean
  locked: boolean
  /** Visible, required and empty: the save (or the next step) refuses it. */
  missing?: true
  hidden_by?: HiddenReason
  locked_by?: LockReason
  why?: string
}

export interface FormGroupState {
  key: string
  label: string
  type: string
  parent_key: string | null
  visible: boolean
  locked: boolean
  why?: string
}

export interface FormState {
  collection: string
  record: string | null
  as: { role: string | null; admin: boolean; preview: boolean }
  layout: { id: number; name: string; why: string | null } | null
  can_update: boolean
  /** Values the form's field rules would fill in from the given values. */
  derived: Obj
  groups: FormGroupState[]
  fields: FormFieldState[]
  summary: {
    visible: number
    hidden: number
    required: string[]
    locked: string[]
    missing: string[]
  }
  note?: string
}

/** One field-config row as formatLayoutFieldRows answers it (the keys read here). */
export interface FormFieldRow {
  field: string
  label?: string | null
  group_key?: string | null
  hidden?: boolean | null
  readonly?: boolean | null
  required?: boolean | null
  is_visible?: boolean | number | null
  layout_assigned?: boolean
  computed_type?: string | null
  interface?: string | null
  visibility_rules?: unknown
  lock_condition?: unknown
  validation_rules?: unknown
  lock_conditions?: string | null
  label_override?: string | null
  type?: string | null
  options?: Obj | null
  _overrides?: Obj | null
}

export interface FormGroupRow {
  key: string
  label?: string | null
  type?: string | null
  sort?: number
  parent_key: string | null
  visible_when?: unknown
  hidden_for_roles?: unknown
  locked_for_roles?: unknown
}

export interface JudgeInput {
  groups: FormGroupRow[]
  rows: FormFieldRow[]
  values: Obj
  /** The judged principal's role id (any case), null without one. */
  roleId: string | null
  isAdmin: boolean
  /** Fields the principal may read / update; null = every field. */
  readable: string[] | null
  updatable: string[] | null
  /** May the principal change this record (or create one, for a new record)? */
  canUpdate: boolean
  /** The record's pipeline step key, null when none or new. */
  stateKey: string | null
}

const up = (v: unknown) => String(v ?? '').toUpperCase()
const titleOf = (key: string) => key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

function list(raw: unknown): unknown[] {
  let v = raw
  for (let i = 0; i < 3 && typeof v === 'string'; i++) {
    try {
      v = JSON.parse(v)
    } catch {
      return []
    }
  }
  return Array.isArray(v) ? v : []
}

function isEmpty(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    (typeof v === 'string' && v.trim() === '') ||
    (Array.isArray(v) && v.length === 0)
  )
}

/** The placement-level lock rules ([{type:'role'|'pipeline_state', …}]) — the record form's own test. */
function placementLock(
  raw: string | null | undefined,
  roleId: string | null,
  stateKey: string | null
): 'role_rule' | 'state_rule' | null {
  if (!raw) return null
  const conds = list(raw) as Array<{ type?: string; state_keys?: unknown; role_ids?: unknown }>
  for (const c of conds) {
    if (c?.type === 'pipeline_state') {
      const keys = list(c.state_keys).map(String)
      if (keys.length && stateKey != null && keys.includes(stateKey)) return 'state_rule'
    }
  }
  for (const c of conds) {
    if (c?.type === 'role') {
      const ids = list(c.role_ids).map(up)
      if (ids.length && roleId && ids.includes(up(roleId))) return 'role_rule'
    }
  }
  return null
}

/**
 * The pure half: given the form's sections and field rows, the values and
 * who is looking, what each field and section does. Exported for tests.
 */
export function judgeFormState(input: JudgeInput): {
  groups: FormGroupState[]
  fields: FormFieldState[]
} {
  const role = input.roleId ? up(input.roleId) : null
  const byKey = new Map(input.groups.map((g) => [g.key, g]))
  const readSet = input.readable ? new Set(input.readable) : null
  const writeSet = input.updatable ? new Set(input.updatable) : null
  const mayRead = (f: string) =>
    input.isAdmin || !readSet || readSet.has('*') || readSet.has(f.split('.')[0] as string)
  const mayWrite = (f: string) =>
    input.isAdmin || !writeSet || writeSet.has('*') || writeSet.has(f.split('.')[0] as string)

  // A section is hidden when it, or a container above it, is hidden from the role
  // or its "shows when" rule does not match the values.
  const groupMemo = new Map<string, FormGroupState>()
  const judgeGroup = (key: string, depth = 0): FormGroupState | null => {
    const hit = groupMemo.get(key)
    if (hit) return hit
    const g = byKey.get(key)
    if (!g || depth > 8) return null
    const label = g.label?.trim() || titleOf(key)
    const parent = g.parent_key ? judgeGroup(g.parent_key, depth + 1) : null
    let visible = true
    let why: string | undefined
    if (parent && !parent.visible) {
      visible = false
      why = `It sits in “${parent.label}”, which is hidden`
    } else if (!input.isAdmin && role && list(g.hidden_for_roles).map(up).includes(role)) {
      visible = false
      why = `“${label}” is hidden for this role`
    } else if (!matchesVisibleWhen(g.visible_when, input.values)) {
      visible = false
      why = `“${label}” shows only when its rule matches, and these values do not`
    }
    const locked = !input.isAdmin && !!role && list(g.locked_for_roles).map(up).includes(role)
    const out: FormGroupState = {
      key,
      label,
      type: String(g.type ?? 'section'),
      parent_key: g.parent_key,
      visible,
      locked,
      ...(why ? { why } : locked ? { why: `“${label}” is read-only for this role` } : {})
    }
    groupMemo.set(key, out)
    return out
  }
  const groups = input.groups
    .filter((g) => g.key !== UNGROUPED_KEY)
    .map((g) => judgeGroup(g.key))
    .filter((g): g is FormGroupState => !!g)

  const fields: FormFieldState[] = []
  for (const r of input.rows) {
    if (r.layout_assigned === false) continue
    if (r.field.startsWith('__')) continue
    const ov = r._overrides ?? null
    const label =
      (typeof ov?.label === 'string' && ov.label.trim()) ||
      r.label_override?.trim() ||
      r.label?.trim() ||
      titleOf(r.field)
    const groupKey = r.group_key ?? null
    const group =
      groupKey && groupKey !== UNGROUPED_KEY && groupKey !== HEADER_GROUP_KEY
        ? judgeGroup(groupKey)
        : null
    const section = groupKey === HEADER_GROUP_KEY ? 'Header' : group ? group.label : null

    // ── Shown? (first reason wins, in the order the record page decides) ──
    let hidden: HiddenReason | null = null
    let why: string | undefined
    if (!mayRead(r.field)) {
      hidden = 'permission'
      why = 'The role’s read permission leaves this field out'
    } else if (r.is_visible === false || r.is_visible === 0) {
      hidden = 'off_on_form'
      why = 'Turned off on this form'
    } else if (r.hidden) {
      hidden = 'field_hidden'
      why = ov?.hidden === true ? 'Hidden on this form' : 'Marked hidden on the field (Data Model)'
    } else if (hiddenByVisibilityRules(r.visibility_rules, input.values)) {
      hidden = 'field_rule'
      why = 'The field’s show/hide rule hides it for these values'
    } else if (group && !group.visible) {
      hidden = group.why?.includes('hidden for this role') ? 'section_role' : 'section_rule'
      why = group.why
    }

    // ── Locked? ──
    let locked: LockReason | null = null
    let lockWhy: string | undefined
    if (!input.canUpdate) {
      locked = 'record'
      lockWhy = 'The record cannot be changed by this role'
    } else if (r.computed_type === 'rollup' || r.computed_type === 'write') {
      if (r.readonly) {
        locked = 'computed'
        lockWhy = 'Calculated — change its inputs, not the field'
      }
    } else if (r.interface === 'relation-path') {
      locked = 'computed'
      lockWhy = 'A value from a related record — edit it there'
    }
    if (!locked && input.canUpdate) {
      const rule = placementLock(r.lock_conditions, input.roleId, input.stateKey)
      if (rule === 'state_rule') {
        locked = 'state_rule'
        lockWhy = 'Locked while the record is in its current step'
      } else if (rule === 'role_rule') {
        locked = 'role_rule'
        lockWhy = 'Locked for this role by a rule on the form'
      } else if (group?.locked) {
        // The section the field sits in directly (the record form's rule; admins exempt).
        locked = 'section_role'
        lockWhy = group.why
      } else if (r.readonly) {
        locked = 'readonly'
        lockWhy = ov?.readonly === true ? 'Read-only on this form' : 'Read-only field'
      } else if (lockedByLockCondition(r.lock_condition, input.values)) {
        locked = 'field_rule'
        lockWhy = 'The field’s lock rule locks it for these values'
      } else if (!mayWrite(r.field)) {
        locked = 'permission'
        lockWhy = 'The role may read this field but not change it'
      }
    }

    // ── Required? (the field, the form's override, then validation rules) ──
    let required = !!r.required
    if (!required) {
      for (const rule of list(r.validation_rules) as ValidationRule[]) {
        if (!rule || typeof rule !== 'object') continue
        if (rule.type === 'required') required = true
        else if (
          rule.type === 'required_if' &&
          applyValidationRule(rule, null, label, input.values) !== null
        )
          required = true
        if (required) break
      }
    }

    const visible = hidden === null
    const out: FormFieldState = {
      field: r.field,
      label,
      group_key: groupKey,
      section,
      visible,
      required,
      locked: locked !== null
    }
    if (visible && required && !locked && isEmpty(input.values[r.field])) out.missing = true
    if (hidden) out.hidden_by = hidden
    if (locked) out.locked_by = locked
    const reason = hidden ? why : lockWhy
    if (reason) out.why = reason
    fields.push(out)
  }
  return { groups, fields }
}

/** Cleans caller values: a plain object, field-name keys, bounded. */
export function cleanValues(raw: unknown): Obj {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Obj = {}
  for (const [k, v] of Object.entries(raw as Obj).slice(0, MAX_VALUES)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)) continue
    out[k] = v
  }
  return out
}

export interface ComputeFormStateOptions {
  collection: string
  item?: string | null
  layoutId?: number | null
  values?: Obj
  /** Administrators only: judge as this role instead of themselves. */
  role?: RoleRef | null
  viewport?: 'phone' | null
  workspaceId?: string | null
}

export interface FormStateResult extends FormState {
  /** Loaded alongside, for the form image (never sent as-is). */
  _facts: LayoutFacts | null
  _values: Obj
  _principal: User
  _rows: FormFieldRow[]
  _groups: FormGroupRow[]
}

/**
 * The async half: loads the form, the record (as the caller) and the
 * principal's access, then judges. Throws FormStateError for 400/403/404.
 */
export async function computeFormState(
  caller: User,
  callerIsAdmin: boolean,
  opts: ComputeFormStateOptions
): Promise<FormStateResult> {
  const { can, getAllowedFields } = await import('./permissions.js')
  const items = await import('./items.js')
  const collection = String(opts.collection ?? '')
  if (!/^[A-Za-z0-9_]{1,128}$/.test(collection))
    throw new FormStateError(400, 'collection is required')
  if (isSystemCollection(collection)) throw new FormStateError(400, 'Unknown collection')
  const registered = await db('nivaro_collections').where({ collection }).first('collection')
  if (!registered) throw new FormStateError(400, `Unknown collection "${collection}"`)
  if (opts.role && !callerIsAdmin)
    throw new FormStateError(403, 'Only administrators can look at a form as another role')

  const ws = opts.workspaceId ?? undefined
  const role = opts.role ?? null
  const preview = !!role
  const principal: User = role
    ? ({ id: SYNTHETIC_USER_ID, role: role.id } as unknown as User)
    : caller
  const principalAdmin = role ? role.admin : callerIsAdmin
  const roleId = role ? role.id : ((caller.role as string | null | undefined) ?? null)

  // The record, read AS THE CALLER: a record they cannot read is 404 — like the record itself.
  const item = opts.item != null && String(opts.item) !== '' ? String(opts.item) : null
  let stored: Obj = {}
  if (item) {
    const row = (await items.readOne(caller, collection, item, ws).catch(() => null)) as Obj | null
    if (!row) throw new FormStateError(404, 'Not found')
    stored = row
  } else if (!callerIsAdmin && !(await can(caller, 'read', collection).catch(() => false))) {
    throw new FormStateError(404, 'Not found')
  }
  const given = cleanValues(opts.values)

  // Value rules (nivaro_field_rules) for every field the caller changed: what the form fills in.
  const working: Obj = { ...stored, ...given }
  const derived: Obj = {}
  const triggers = Object.keys(given).slice(0, MAX_TRIGGERS)
  if (triggers.length) {
    const { evaluateRulesForTrigger } = await import('./field-rules.js')
    for (const t of triggers) {
      const updates = await evaluateRulesForTrigger(
        db,
        collection,
        t,
        working[t],
        working,
        undefined,
        {
          user: caller,
          isAdmin: callerIsAdmin,
          workspaceId: ws ?? null
        }
      ).catch(() => ({}) as Obj)
      for (const [k, v] of Object.entries(updates)) {
        if (k in given) continue
        working[k] = v
        derived[k] = v
      }
    }
  }

  // The form: an explicit layout (admins, or one the role may open), else the live resolver.
  let layoutRef: { id: number; name: string; why: string | null } | null = null
  if (opts.layoutId) {
    const row = (await db('nivaro_collection_layouts').where({ id: opts.layoutId }).first()) as
      | Obj
      | undefined
    if (!row || String(row.collection) !== collection)
      throw new FormStateError(404, 'Layout not found')
    if (!callerIsAdmin && !roleAllows(row, roleId, false))
      throw new FormStateError(403, 'That form is for other roles')
    layoutRef = { id: Number(row.id), name: String(row.name ?? row.id), why: 'asked for by id' }
  } else {
    const res = await resolveLayout({
      collection,
      item,
      role: roleId,
      isAdmin: principalAdmin,
      userId: role ? null : caller.id ? String(caller.id) : null,
      viewport: opts.viewport ?? null,
      recordOverride: given
    })
    if (res.row) {
      const why = res.checked.find((c) => c.layout_id === Number(res.row?.id) && c.matched)?.why
      layoutRef = {
        id: Number(res.row.id),
        name: String(res.row.name ?? res.row.id),
        why: why ?? res.reason?.kind ?? null
      }
    }
  }
  const facts = layoutRef ? await loadLayoutFacts(layoutRef.id) : null
  const merged = facts ? mergeInherited(facts.bundle, facts.parent) : null

  // The field rows exactly as GET /field-config answers them for these placements.
  const assignments = (merged?.placements ?? []).map((p) =>
    normalizeLayoutAssignment(p as unknown as Obj)
  )
  const { data } = await formatLayoutFieldRows(collection, assignments)
  let rows = data as FormFieldRow[]
  // No form: every field the collection has, as the plain record page lists them.
  if (!merged) rows = rows.map((r) => ({ ...r, layout_assigned: true, group_key: null }))

  const [canRead, readable, updatable, canUpdate] = await Promise.all([
    principalAdmin ? Promise.resolve(true) : can(principal, 'read', collection).catch(() => false),
    principalAdmin ? Promise.resolve(null) : getAllowedFields(principal, 'read', collection),
    principalAdmin ? Promise.resolve(null) : getAllowedFields(principal, 'update', collection),
    item
      ? principalAdmin
        ? Promise.resolve(true)
        : items.canUpdateItem(principal, collection, item, ws).catch(() => false)
      : principalAdmin
        ? Promise.resolve(true)
        : can(principal, 'create', collection).catch(() => false)
  ])

  // The record's step, only when a placement locks by step.
  let stateKey: string | null = null
  if (item && assignments.some((a) => String(a.lock_conditions ?? '').includes('pipeline_state'))) {
    const st = (await items
      .readOne(caller, collection, item, ws, ['id', '$state'])
      .catch(() => null)) as Obj | null
    const s = st?.$state as { key?: unknown } | null | undefined
    stateKey = s?.key ? String(s.key) : null
  }

  const groups: FormGroupRow[] = (merged?.groups ?? []).map((g) => ({
    key: String(g.key),
    label: (g as { label?: string | null }).label ?? null,
    type: (g as { type?: string | null }).type ?? 'section',
    sort: Number(g.sort ?? 0),
    parent_key: g.parent_key ?? null,
    visible_when: g.visible_when,
    hidden_for_roles: g.hidden_for_roles,
    locked_for_roles: g.locked_for_roles
  }))

  const judged = canRead
    ? judgeFormState({
        groups,
        rows,
        values: working,
        roleId,
        isAdmin: principalAdmin,
        readable,
        updatable,
        canUpdate: !!canUpdate,
        stateKey
      })
    : { groups: [], fields: [] }

  // Derived values the principal may not read never leave.
  const readSet = readable ? new Set(readable) : null
  for (const k of Object.keys(derived))
    if (readSet && !readSet.has('*') && !readSet.has(k)) delete derived[k]

  const roleName = role
    ? role.name
    : roleId
      ? ((
          (await db('nivaro_roles')
            .where({ id: roleId })
            .first('name')
            .catch(() => null)) as {
            name?: string
          } | null
        )?.name ?? null)
      : null

  const visibleFields = judged.fields.filter((f) => f.visible)
  return {
    collection,
    record: item,
    as: { role: roleName, admin: principalAdmin, preview },
    layout: layoutRef,
    can_update: !!canUpdate,
    derived,
    groups: judged.groups,
    fields: judged.fields,
    summary: {
      visible: visibleFields.length,
      hidden: judged.fields.length - visibleFields.length,
      required: visibleFields.filter((f) => f.required).map((f) => f.field),
      locked: visibleFields.filter((f) => f.locked).map((f) => f.field),
      missing: visibleFields.filter((f) => f.missing).map((f) => f.field)
    },
    ...(canRead ? {} : { note: 'This role may not read records of this collection.' }),
    _facts: facts,
    _values: working,
    _principal: principal,
    _rows: rows,
    _groups: groups
  }
}

/** The answer a client gets: the loader's private fields stripped. */
export function publicFormState(s: FormStateResult): FormState {
  const { _facts, _values, _principal, _rows, _groups, ...rest } = s
  return rest
}
