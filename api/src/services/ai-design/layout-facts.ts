import { db } from '../../db/index.js'
import { cachedLintContext } from '../layout-analysis.js'
import { type LintContext, type LintFinding, lintLayout, mergeInherited } from '../layout-lint.js'
import { loadLayoutBundle } from '../layout-ops.js'
import {
  type GroupRow,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow,
  UNGROUPED_KEY
} from '../layout-ops-apply.js'
import { parseConditions, parseRecordConditions } from '../layout-patch.js'
import { titleCase } from './model.js'

/**
 * What the layout AI helpers (#2694 MCP tools, #2695 ask about this form,
 * #2693 why two forms differ) know about a layout: the bundle the editor
 * edits (or the editor's unsaved draft of it), its parent, the collection's
 * field labels and flags, and the roles. Everything here is CONFIG — layout
 * structure, labels, role names — never a stored value of a record.
 */

type Obj = Record<string, unknown>

export interface LayoutFacts {
  bundle: LayoutBundle
  parent: LayoutBundle | null
  /** The collection's lint context: field flags + labels, roles and who may write what. */
  ctx: LintContext
  /** field → its own label (the field's, not a placement override). */
  labels: Map<string, string>
  /** role id (upper case) → name. */
  roleNames: Map<string, string>
  /** True when `bundle` is the editor's unsaved draft rather than the saved layout. */
  draft: boolean
}

const MAX_DRAFT_ROWS = 3000

/**
 * The editor's draft of `layoutId`, when the body carries a usable one: same
 * layout id, groups and placements as arrays of rows naming a key / field.
 * Anything else is ignored (the saved layout answers instead).
 */
export function draftBundleOf(raw: unknown, layoutId: number): LayoutBundle | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Obj
  const layout = b.layout as Obj | undefined
  if (!layout || Number(layout.id) !== layoutId) return null
  if (!Array.isArray(b.groups) || !Array.isArray(b.placements)) return null
  if (b.groups.length + b.placements.length > MAX_DRAFT_ROWS) return null
  if (!b.groups.every((g) => g && typeof (g as Obj).key === 'string')) return null
  if (!b.placements.every((p) => p && typeof (p as Obj).field === 'string')) return null
  return {
    layout: layout as LayoutBundle['layout'],
    groups: b.groups as GroupRow[],
    placements: b.placements as PlacementRow[],
    rev: typeof b.rev === 'string' ? b.rev : ''
  }
}

export async function loadLayoutFacts(
  layoutId: number,
  opts: { draft?: unknown } = {}
): Promise<LayoutFacts | null> {
  const saved = await loadLayoutBundle(db, layoutId)
  if (!saved) return null
  const draft = draftBundleOf(opts.draft, layoutId)
  const bundle = draft && draft.layout.collection === saved.layout.collection ? draft : saved
  const parentId = bundle.layout.parent_layout_id
  const [parent, ctx] = await Promise.all([
    parentId != null && Number(parentId) !== layoutId
      ? loadLayoutBundle(db, Number(parentId))
      : Promise.resolve(null),
    cachedLintContext(String(bundle.layout.collection))
  ])
  return {
    bundle,
    parent,
    ctx,
    labels: new Map(ctx.fields.map((f) => [f.field, f.label || titleCase(f.field)])),
    roleNames: new Map(ctx.roles.map((r) => [r.id.toUpperCase(), r.name])),
    draft: bundle !== saved
  }
}

// ── Small readers ────────────────────────────────────────────────────────────

export function overridesOf(p: { overrides?: unknown }): Obj {
  let v: unknown = p.overrides
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    try {
      v = JSON.parse(v)
    } catch {
      return {}
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
}

export function jsonList(v: unknown): unknown[] {
  let x: unknown = v
  for (let i = 0; i < 3 && typeof x === 'string'; i++) {
    try {
      x = JSON.parse(x)
    } catch {
      return []
    }
  }
  return Array.isArray(x) ? x : []
}

export const roleIdsOf = (v: unknown): string[] => jsonList(v).map((r) => String(r).toUpperCase())

export const isRealField = (p: PlacementRow) =>
  !p.field.startsWith('__') && p.widget_id == null && p.group_key !== HEADER_GROUP_KEY

export function fieldLabel(facts: Pick<LayoutFacts, 'labels'>, field: string): string {
  return facts.labels.get(field) ?? titleCase(field)
}

export function placementLabel(facts: Pick<LayoutFacts, 'labels'>, p: PlacementRow): string {
  const ov = overridesOf(p)
  const own = typeof ov.label === 'string' && ov.label.trim() ? ov.label.trim() : null
  return own || p.label_override || fieldLabel(facts, p.field)
}

export function groupName(bundle: Pick<LayoutBundle, 'groups'>, key: string | null): string {
  if (key == null || key === UNGROUPED_KEY) return 'Ungrouped'
  if (key === HEADER_GROUP_KEY) return 'the header strip'
  const g = bundle.groups.find((x) => x.key === key)
  return g?.label?.trim() || titleCase(key)
}

export function roleNamesOf(facts: Pick<LayoutFacts, 'roleNames'>, ids: string[]): string[] {
  return ids.map((id) => facts.roleNames.get(id.toUpperCase()) ?? id)
}

const OP_WORDS: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  nnull: 'is filled',
  null: 'is empty',
  _eq: 'is',
  _neq: 'is not',
  _in: 'is one of',
  _nin: 'is none of',
  _null: 'is empty',
  _nnull: 'is filled',
  _gt: 'is more than',
  _lt: 'is less than',
  _contains: 'contains'
}

/** "Status is closed and Region is filled" — rule lists as words (values are config, not data). */
export function conditionWords(
  facts: Pick<LayoutFacts, 'labels'>,
  rules: unknown[],
  joiner = 'and'
): string {
  const parts: string[] = []
  for (const r of rules.slice(0, 8)) {
    const o = (r ?? {}) as Obj
    if (typeof o.field !== 'string') continue
    const op = OP_WORDS[String(o.op ?? 'eq')] ?? String(o.op ?? 'is')
    const val =
      o.value === undefined || /null$/.test(String(o.op))
        ? ''
        : ` ${Array.isArray(o.value) ? o.value.map(String).join(', ') : String(o.value)}`
    parts.push(`${fieldLabel(facts, o.field)} ${op}${val}`.trim())
  }
  return parts.join(` ${joiner} `)
}

export function widthWords(span: number | null | undefined): string | null {
  if (span == null) return null
  if (span >= 12) return 'full width'
  if (span === 6) return 'half width'
  if (span === 4) return 'a third'
  if (span === 3) return 'a quarter'
  if (span === 8) return 'two thirds'
  if (span === 9) return 'three quarters'
  return `${span}/12 wide`
}

// ── describe_layout ──────────────────────────────────────────────────────────

/** Boolean layout settings worth naming when they are on. */
const SETTING_FLAGS: Array<[string, string]> = [
  ['disable_comments', 'comments are off'],
  ['disable_tasks', 'tasks are off'],
  ['disable_revisions', 'revision history is off'],
  ['disable_clone', 'cloning is off'],
  ['disable_delete', 'deleting is off'],
  ['validate_before_next', 'each step is checked before Next'],
  ['summary_enabled', 'opens in Summary mode'],
  ['accordion_mode', 'sections open one at a time'],
  ['ai_enabled', 'AI help is on'],
  ['allow_schedule', 'people may schedule changes'],
  ['allow_disable_pickers', 'people may turn pickers off'],
  ['create_hidden', 'hidden from the New menu'],
  ['changes_tray', 'the changes tray is on'],
  ['dossier_enabled', 'the dossier is on'],
  ['hide_empty', 'empty fields are hidden in read mode']
]

const MAX_DESCRIBED_FIELDS = 300

export interface DescribedField {
  field: string
  label: string
  width?: string
  required?: true
  readonly?: true
  hidden?: true
  inherited?: true
}

export interface DescribedGroup {
  key: string
  label: string
  type: string
  parent: string | null
  collapsed?: true
  shows_when?: string
  hidden_for?: string[]
  read_only_for?: string[]
  fields: DescribedField[]
}

export interface LayoutDescription {
  id: number
  name: string
  collection: string
  kind: string
  slug: string | null
  default: boolean
  who: string
  record_rule: string | null
  parent_layout_id: number | null
  settings_on: string[]
  groups: DescribedGroup[]
  /** Fields on the layout (own + inherited) — the canvas count. */
  field_count: number
  /** Collection fields this layout does not show at all. */
  not_on_layout: Array<{ field: string; label: string }>
  draft: boolean
  truncated?: true
}

/** The layout as an admin would read it: who gets it, its settings, sections and fields. */
export function describeLayout(facts: LayoutFacts): LayoutDescription {
  const { bundle, parent } = facts
  const layout = bundle.layout as Obj
  const merged = mergeInherited(bundle, parent)
  const inherited = new Set(merged.inherited?.fields ?? [])
  const roleIds = (parseConditions(layout.conditions)?.role_ids ?? []).map(String)
  const rules = parseRecordConditions(layout.record_conditions) ?? []
  const groups = [...bundle.groups, ...(parent?.groups ?? [])].filter(
    (g, i, all) => all.findIndex((x) => x.key === g.key) === i
  )
  const placements = merged.placements as PlacementRow[]
  let budget = MAX_DESCRIBED_FIELDS
  let truncated = false
  const fieldOf = (p: PlacementRow): DescribedField => {
    const ov = overridesOf(p)
    return {
      field: p.field,
      label: placementLabel(facts, p),
      ...(widthWords(p.col_span) ? { width: widthWords(p.col_span) as string } : {}),
      ...(ov.required === true ? { required: true as const } : {}),
      ...(ov.readonly === true ? { readonly: true as const } : {}),
      ...(ov.hidden === true || p.is_visible === false ? { hidden: true as const } : {}),
      ...(inherited.has(p.field) ? { inherited: true as const } : {})
    }
  }
  const described: DescribedGroup[] = []
  const keys = [...groups.map((g) => g.key)]
  if (!keys.includes(UNGROUPED_KEY)) keys.push(UNGROUPED_KEY)
  for (const key of keys) {
    const g = groups.find((x) => x.key === key)
    const own = placements.filter(
      (p) => (p.group_key ?? UNGROUPED_KEY) === key && isRealField(p) && !p.field.startsWith('__')
    )
    if (key === UNGROUPED_KEY && own.length === 0) continue
    const take = own.slice(0, Math.max(0, budget))
    budget -= take.length
    if (take.length < own.length) truncated = true
    const vw = jsonList(g?.visible_when)
    const hidden = roleIdsOf(g?.hidden_for_roles)
    const locked = roleIdsOf(g?.locked_for_roles)
    described.push({
      key,
      label: groupName({ groups }, key),
      type: g?.type ?? 'section',
      parent: g?.parent_key ?? null,
      ...(g?.is_collapsed ? { collapsed: true as const } : {}),
      ...(vw.length ? { shows_when: conditionWords(facts, vw) } : {}),
      ...(hidden.length ? { hidden_for: roleNamesOf(facts, hidden) } : {}),
      ...(locked.length ? { read_only_for: roleNamesOf(facts, locked) } : {}),
      fields: take.map(fieldOf)
    })
  }
  const onLayout = new Set(placements.map((p) => p.field))
  const notOn = facts.ctx.fields
    .filter((f) => !onLayout.has(f.field) && !f.field.startsWith('__') && f.type !== 'alias')
    .slice(0, 150)
    .map((f) => ({ field: f.field, label: fieldLabel(facts, f.field) }))
  return {
    id: Number(layout.id),
    name: String(layout.name ?? ''),
    collection: String(layout.collection),
    kind: String(layout.layout_type ?? 'grouped'),
    slug: (layout.slug as string | null) ?? null,
    default: !!layout.is_active,
    who: roleIds.length
      ? `Only ${roleNamesOf(facts, roleIds).join(', ')}`
      : 'Every role that may open the collection',
    record_rule: rules.length ? conditionWords(facts, rules) : null,
    parent_layout_id: layout.parent_layout_id == null ? null : Number(layout.parent_layout_id),
    settings_on: SETTING_FLAGS.filter(([k]) => layout[k] === true || layout[k] === 1).map(
      ([, w]) => w
    ),
    groups: described,
    field_count: placements.filter(isRealField).length,
    not_on_layout: notOn,
    draft: facts.draft,
    ...(truncated ? { truncated: true as const } : {})
  }
}

// ── Lint ─────────────────────────────────────────────────────────────────────

export function lintFacts(facts: LayoutFacts): LintFinding[] {
  return lintLayout(mergeInherited(facts.bundle, facts.parent), facts.ctx)
}

// ── Ops in plain words ───────────────────────────────────────────────────────

const PATCH_WORDS: Record<string, string> = {
  label_override: 'label',
  is_visible: 'shown',
  default_expanded: 'opens expanded',
  col_span: 'width',
  show_row_revisions: 'row history',
  allow_revision_restore: 'restore from history',
  lock_conditions: 'lock rules',
  input_bindings: 'filled from',
  widget_id: 'widget',
  show_approval_chain: 'approval chain',
  is_collapsed: 'starts collapsed',
  hidden_for_roles: 'hidden for roles',
  locked_for_roles: 'read-only for roles',
  visible_when: 'shows when'
}

const keyWords = (k: string) => PATCH_WORDS[k] ?? k.replace(/_/g, ' ')

function valueWords(facts: Pick<LayoutFacts, 'labels' | 'roleNames'>, k: string, v: unknown) {
  if (v === true) return 'on'
  if (v === false) return 'off'
  if (v == null || v === '') return 'cleared'
  if (k === 'col_span') return widthWords(Number(v)) ?? String(v)
  if (k === 'hidden_for_roles' || k === 'locked_for_roles') {
    const ids = roleIdsOf(v)
    return ids.length ? roleNamesOf(facts as LayoutFacts, ids).join(', ') : 'nobody'
  }
  if (k === 'visible_when') {
    const rules = jsonList(v)
    return rules.length ? conditionWords(facts, rules) : 'always'
  }
  if (k === 'conditions') {
    const ids = (parseConditions(v)?.role_ids ?? []).map(String)
    return ids.length ? `only ${roleNamesOf(facts as LayoutFacts, ids).join(', ')}` : 'every role'
  }
  if (k === 'record_conditions') {
    const rules = parseRecordConditions(v) ?? []
    return rules.length ? `records where ${conditionWords(facts, rules)}` : 'no record rule'
  }
  if (typeof v === 'string') return `“${v.length > 60 ? `${v.slice(0, 57)}…` : v}”`
  if (typeof v === 'number') return String(v)
  return 'changed'
}

function patchWords(
  facts: Pick<LayoutFacts, 'labels' | 'roleNames'>,
  patch: Obj | undefined
): string {
  if (!patch) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'overrides') {
      const ov = overridesOf({ overrides: v })
      for (const [ok, ovv] of Object.entries(ov)) {
        if (ok === 'required') parts.push(ovv ? 'required' : 'optional')
        else if (ok === 'readonly') parts.push(ovv ? 'read-only' : 'editable')
        else if (ok === 'hidden') parts.push(ovv ? 'hidden' : 'shown')
        else if (ok === 'label') parts.push(`label ${valueWords(facts, ok, ovv)}`)
        else if (ok === 'note' || ok === 'help')
          parts.push(`help text ${valueWords(facts, ok, ovv)}`)
        else parts.push(`${keyWords(ok)} ${valueWords(facts, ok, ovv)}`)
      }
      continue
    }
    if (k === 'is_visible') {
      parts.push(v === false ? 'hidden' : 'shown')
      continue
    }
    if (k === 'col_span') {
      parts.push(v == null ? 'default width' : (widthWords(Number(v)) ?? `width ${String(v)}`))
      continue
    }
    if (k === 'label_override') {
      parts.push(v ? `label ${valueWords(facts, k, v)}` : 'own label cleared')
      continue
    }
    parts.push(`${keyWords(k)} ${valueWords(facts, k, v)}`)
  }
  return parts.join(', ')
}

/**
 * One plain sentence per layout op, read against the layout before the batch
 * (`bundle`) so group keys and fields come out as their labels.
 */
export function describeLayoutOps(
  facts: Pick<LayoutFacts, 'labels' | 'roleNames'>,
  bundle: Pick<LayoutBundle, 'groups'>,
  ops: LayoutOp[]
): string[] {
  // Groups the batch creates are named by their label from then on.
  const groups = [...bundle.groups]
  const label = (field: string) => fieldLabel(facts, field)
  const out: string[] = []
  for (const op of ops) {
    switch (op.op) {
      case 'place': {
        const extra = patchWords(facts, op.patch as Obj | undefined)
        out.push(
          `Add ${label(op.field)} to ${groupName({ groups }, op.group_key)}${extra ? ` (${extra})` : ''}`
        )
        break
      }
      case 'move':
        out.push(
          (op.from.group_key ?? UNGROUPED_KEY) === (op.to_group_key ?? UNGROUPED_KEY)
            ? `Reorder ${label(op.from.field)} within ${groupName({ groups }, op.to_group_key)}`
            : `Move ${label(op.from.field)} from ${groupName({ groups }, op.from.group_key)} to ${groupName({ groups }, op.to_group_key)}`
        )
        break
      case 'update_placement': {
        const words = patchWords(facts, op.patch as Obj)
        out.push(`${label(op.at.field)}: ${words || 'settings change'}`)
        break
      }
      case 'remove':
        out.push(`Remove ${label(op.at.field)} from ${groupName({ groups }, op.at.group_key)}`)
        break
      case 'group_create': {
        const kind = op.group_type === 'tab' ? 'step' : op.group_type
        out.push(
          `Add ${kind} “${op.label}”${op.parent_key ? ` inside ${groupName({ groups }, op.parent_key)}` : ''}`
        )
        groups.push({ key: op.key, label: op.label } as GroupRow)
        break
      }
      case 'group_update': {
        const p = op.patch as Obj
        const name = groupName({ groups }, op.key)
        if (typeof p.label === 'string' && Object.keys(p).length === 1)
          out.push(`Rename ${name} to “${p.label}”`)
        else out.push(`${name}: ${patchWords(facts, p) || 'settings change'}`)
        break
      }
      case 'group_move':
        out.push(
          `Move ${groupName({ groups }, op.key)} to position ${op.index + 1}${op.parent_key ? ` in ${groupName({ groups }, op.parent_key)}` : ''}`
        )
        break
      case 'group_remove':
        out.push(
          `Remove ${groupName({ groups }, op.key)}${op.placements === 'delete' ? ' and the fields in it' : ' (its fields move to Ungrouped)'}`
        )
        break
      case 'layout_update':
        out.push(`Form settings: ${patchWords(facts, op.patch as Obj) || 'no change'}`)
        break
    }
  }
  return out
}
