import { matchesVisibleWhen, parseVisibleWhen } from '../../../lib/visible-when'
import type { ActiveLayoutData } from '../../item-edit/types'
import type { DesignMark, DesignTarget } from '../design-context'

// Pure logic behind the canvas preview modes (#2579 roles side by side,
// #2580 who sees each field, #2599 by workflow state, #2600 device width,
// #2601 what if). The form renders each mode for real; these functions only
// say what changed, for the tags and the summary strip.

// ─── Device width (#2600) ───────────────────────────────────────────────────

/** `all` = desktop, tablet and phone side by side (#3187). */
export type PreviewDevice = 'desktop' | 'tablet' | 'phone' | 'all'

/** One real screen size (everything but `all`). */
export type FrameDevice = Exclude<PreviewDevice, 'all'>

/** Canvas width per device; null = the full canvas. The form measures its own
 *  width (resolveColSpan), so a narrower frame wraps columns as a device does. */
export const DEVICE_WIDTH: Record<FrameDevice, number | null> = {
  desktop: null,
  tablet: 768,
  phone: 390
}

/** Widths when every device shows at once: desktop needs a width of its own there. */
export const ALL_DEVICE_WIDTH: Record<FrameDevice, number> = {
  desktop: 1024,
  tablet: 768,
  phone: 390
}

export const DEVICE_ORDER: FrameDevice[] = ['desktop', 'tablet', 'phone']

export const DEVICE_LABEL: Record<FrameDevice, string> = {
  desktop: 'Desktop',
  tablet: 'Tablet',
  phone: 'Phone'
}

/** Gap between side-by-side device panes and the row's padding (px). */
export const ALL_DEVICE_GAP = 16

/**
 * How wide the preview canvas is at 100% when that is fixed (a device frame,
 * every device side by side, two roles at a device width); null when it
 * takes the pane's width — it then already fits. Fit to screen (#3188)
 * divides the pane by this.
 */
export function previewNaturalWidth(
  device: PreviewDevice | undefined,
  panes: 1 | 2 = 1
): number | null {
  if (device === 'all') {
    if (panes === 2) return null
    const sum = DEVICE_ORDER.reduce((s, d) => s + ALL_DEVICE_WIDTH[d], 0)
    // Gaps between the three, padding either side, and each frame's 1 px borders.
    return sum + ALL_DEVICE_GAP * 4 + DEVICE_ORDER.length * 2
  }
  const w = DEVICE_WIDTH[device ?? 'desktop']
  return w == null ? null : (w + 2) * panes
}

// ─── Role access (#2579, #2580) ─────────────────────────────────────────────

export type FieldAccess = 'hidden' | 'readonly' | 'editable'

/** A role's field permissions (GET /collection-layouts/preview-as-role and
 *  /field-access answer this shape). */
export interface RoleAccessInput {
  role: { id?: string; name: string; admin_access: boolean }
  can_read: boolean
  can_update: boolean
  hidden_fields: string[]
  readonly_fields: string[]
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

function lockRoleIds(raw: unknown): string[] {
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

/**
 * What one role gets on each field of the form: its field permissions, then
 * the layout's own role rules — a section hidden for the role hides its
 * fields, a section locked for it (or a role lock on the field) makes them
 * read-only. Administrators are exempt from section rules, as on /active.
 * Only real fields (not slots or widgets) are answered.
 */
export function fieldAccessForRole(
  access: RoleAccessInput,
  layout: ActiveLayoutData
): Map<string, FieldAccess> {
  const roleId = String(access.role.id ?? '').toUpperCase()
  const admin = access.role.admin_access
  const hidden = new Set(access.hidden_fields)
  const readonly = new Set(access.readonly_fields)
  const groupRule = new Map<string, 'hidden' | 'locked'>()
  if (!admin)
    for (const g of layout.groups) {
      const row = g as { key: string; hidden_for_roles?: unknown; locked_for_roles?: unknown }
      if (roleList(row.hidden_for_roles).includes(roleId)) groupRule.set(row.key, 'hidden')
      else if (roleList(row.locked_for_roles).includes(roleId)) groupRule.set(row.key, 'locked')
    }
  const out = new Map<string, FieldAccess>()
  for (const a of layout.assignments) {
    if (a.field.startsWith('__')) continue
    const rule = a.group_key ? groupRule.get(a.group_key) : undefined
    let v: FieldAccess
    if (!access.can_read || hidden.has(a.field) || rule === 'hidden') v = 'hidden'
    else if (
      !access.can_update ||
      readonly.has(a.field) ||
      rule === 'locked' ||
      lockRoleIds(a.lock_conditions).includes(roleId)
    )
      v = 'readonly'
    else v = 'editable'
    // A field placed twice: the most open placement wins.
    const cur = out.get(a.field)
    if (!cur || rank(v) > rank(cur)) out.set(a.field, v)
  }
  return out
}

const rank = (a: FieldAccess) => (a === 'editable' ? 2 : a === 'readonly' ? 1 : 0)

const ACCESS_WORD: Record<FieldAccess, string> = {
  hidden: 'hidden',
  readonly: 'read-only',
  editable: 'can edit'
}

/**
 * Two roles side by side: a "Differs" tag on every field the two roles get
 * differently, and on sections one of them does not see. Same answer on both
 * panes; the per-role Hidden / Read-only tags say which side is which.
 */
export function compareMarks(
  layout: ActiveLayoutData,
  a: RoleAccessInput,
  b: RoleAccessInput
): (t: DesignTarget) => DesignMark[] {
  const fa = fieldAccessForRole(a, layout)
  const fb = fieldAccessForRole(b, layout)
  const groupHidden = (r: RoleAccessInput, raw: unknown) =>
    !r.role.admin_access && roleList(raw).includes(String(r.role.id ?? '').toUpperCase())
  const groupDiff = new Map<string, string>()
  for (const g of layout.groups) {
    const raw = (g as { hidden_for_roles?: unknown }).hidden_for_roles
    const ha = groupHidden(a, raw)
    const hb = groupHidden(b, raw)
    if (ha !== hb)
      groupDiff.set(g.key, `${ha ? a.role.name : b.role.name} does not see this section`)
  }
  return (t) => {
    if (t.kind === 'group') {
      const tip = groupDiff.get(t.key)
      return tip ? [{ text: 'Differs', tone: 'violet', tip, highlight: true }] : []
    }
    if (t.kind !== 'field' && t.kind !== 'header') return []
    const x = fa.get(t.field)
    const y = fb.get(t.field)
    if (!x || !y || x === y) return []
    return [
      {
        text: 'Differs',
        tone: 'violet',
        tip: `${a.role.name}: ${ACCESS_WORD[x]} · ${b.role.name}: ${ACCESS_WORD[y]}`,
        highlight: true
      }
    ]
  }
}

export interface FieldWho {
  edit: string[]
  read: string[]
  hidden: string[]
}

/** Per field: which roles can edit it, only read it, or never see it. */
export function whoSeesFields(
  roles: RoleAccessInput[],
  layout: ActiveLayoutData
): Map<string, FieldWho> {
  const out = new Map<string, FieldWho>()
  for (const r of roles) {
    for (const [field, v] of fieldAccessForRole(r, layout)) {
      const cur = out.get(field) ?? { edit: [], read: [], hidden: [] }
      if (v === 'editable') cur.edit.push(r.role.name)
      else if (v === 'readonly') cur.read.push(r.role.name)
      else cur.hidden.push(r.role.name)
      out.set(field, cur)
    }
  }
  return out
}

/** Tint step for the overlay: how much of the role list sees the field. */
export function whoTint(who: FieldWho): 'none' | 'few' | 'some' | 'most' | 'all' {
  const total = who.edit.length + who.read.length + who.hidden.length
  const sees = who.edit.length + who.read.length
  if (total === 0 || sees === 0) return 'none'
  if (sees === total) return 'all'
  const share = sees / total
  return share < 1 / 3 ? 'few' : share < 2 / 3 ? 'some' : 'most'
}

// ─── Workflow state (#2599) ─────────────────────────────────────────────────

/** Fields whose lock conditions lock them in `stateKey` (the form shows the locks). */
export function fieldsLockedInState(layout: ActiveLayoutData, stateKey: string): string[] {
  const out: string[] = []
  for (const a of layout.assignments) {
    if (!a.lock_conditions) continue
    try {
      const conds = JSON.parse(a.lock_conditions) as Array<{ type?: string; state_keys?: string[] }>
      if (
        Array.isArray(conds) &&
        conds.some((c) => c?.type === 'pipeline_state' && c.state_keys?.includes(stateKey))
      )
        out.push(a.field)
    } catch {
      /* unreadable lock config: the form ignores it too */
    }
  }
  return [...new Set(out)]
}

export interface PipelineTransition {
  label: string
  from_state: string | null
  requirements?: Array<{ type?: string; collection?: unknown; fields?: unknown }> | null
}

/**
 * What leaving a state asks for: each move out of it (or from any state)
 * with the fields its requirements name. Only moves that require something.
 */
export function leavingNeeds(
  transitions: PipelineTransition[],
  stateId: string
): Array<{ label: string; fields: string[]; collection: string | null }> {
  const out: Array<{ label: string; fields: string[]; collection: string | null }> = []
  for (const t of transitions) {
    if (t.from_state != null && t.from_state !== stateId) continue
    for (const r of t.requirements ?? []) {
      const fields = Array.isArray(r?.fields) ? r.fields.map(String) : []
      if (fields.length === 0) continue
      out.push({
        label: t.label,
        fields,
        collection: typeof r.collection === 'string' && r.collection ? r.collection : null
      })
    }
  }
  return out
}

// ─── What if (#2601) ────────────────────────────────────────────────────────

export interface DrivingField {
  field: string
  /** Values the conditions compare against — quick picks for the explorer. */
  values: string[]
  /** Labels of the steps/sections whose visibility the field drives. */
  drives: string[]
}

/** Fields the form's visibility conditions read, with the values they test. */
export function drivingFields(layout: ActiveLayoutData): DrivingField[] {
  const by = new Map<string, DrivingField>()
  for (const g of layout.groups) {
    const rules = parseVisibleWhen((g as { visible_when?: unknown }).visible_when)
    for (const r of rules) {
      if (!r.field) continue
      const cur = by.get(r.field) ?? { field: r.field, values: [], drives: [] }
      if (r.op === 'in')
        for (const v of String(r.value ?? '').split(','))
          if (v.trim() && !cur.values.includes(v.trim())) cur.values.push(v.trim())
      if ((r.op ?? 'eq') === 'eq' || r.op === 'neq') {
        const v = String(r.value ?? '')
        if (v && !cur.values.includes(v)) cur.values.push(v)
      }
      const label = g.label || g.key
      if (!cur.drives.includes(label)) cur.drives.push(label)
      by.set(r.field, cur)
    }
  }
  return [...by.values()].sort((a, b) => a.field.localeCompare(b.field))
}

/** Groups whose visibility conditions flip between two sets of values. */
export function visibilityChanges(
  layout: ActiveLayoutData,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): { shown: string[]; hidden: string[] } {
  const shown: string[] = []
  const hidden: string[] = []
  for (const g of layout.groups) {
    const raw = (g as { visible_when?: unknown }).visible_when
    if (parseVisibleWhen(raw).length === 0) continue
    const was = matchesVisibleWhen(raw, before)
    const now = matchesVisibleWhen(raw, after)
    if (was === now) continue
    ;(now ? shown : hidden).push(g.key)
  }
  return { shown, hidden }
}
