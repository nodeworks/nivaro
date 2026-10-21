import {
  applyLayoutOps,
  type GroupRow,
  HEADER_GROUP_KEY,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  type PlacementPatch,
  type PlacementRow,
  TABLE_FORM_GROUP_KEYS
} from '../../../lib/layout-ops'
import { titleCase } from '../../../lib/utils'
import { asObject, readOverrides, withKey } from '../inspector/model'
import { humanizeOpError } from '../useLayoutDraft'

/**
 * Command palette intents (#2586): what one typed (or AI-read) command means,
 * in names the layout already has — never raw ops. `intentsToOps` turns them
 * into ONE ops batch against the draft, checking each step with the ops twin,
 * plus a plain sentence per change for the preview.
 *
 * MIRROR: api/src/services/ai-design/layout-command.ts CommandIntent (the AI
 * half answers in this vocabulary).
 */
export type CommandIntent =
  | { kind: 'move_field'; field: string; to_group: string | null; before?: string; after?: string }
  | { kind: 'move_group'; group: string; before?: string; after?: string }
  | {
      kind: 'set_field'
      field: string
      required?: boolean
      readonly?: boolean
      hidden?: boolean
      label?: string | null
      width?: 12 | 6 | 4 | 3
      help?: string | null
      /** Role id named with "required for <role>": a note, since required is per form. */
      role?: string
    }
  | { kind: 'add_field'; field: string; to_group: string | null }
  | { kind: 'remove_field'; field: string }
  | { kind: 'add_group'; label: string; group_type: 'section' | 'tab'; after?: string }
  | { kind: 'update_group'; group: string; label?: string; collapsed?: boolean }

export interface CommandEnv {
  bundle: LayoutBundle
  /** The collection's fields (GET /field-config/:collection). */
  fields: Array<{ field: string; label?: string | null }>
  roles: Array<{ id: string; name: string }>
}

export interface CommandPlan {
  ops: LayoutOp[]
  /** One plain sentence per change, in order. */
  steps: string[]
  /** Things the admin should know before applying (e.g. required is per form, not per role). */
  notes: string[]
}

export type PlanResult = ({ ok: true } & CommandPlan) | { ok: false; error: string }

export const WIDTH_WORDS: Record<number, string> = { 12: 'full', 6: '½', 4: '⅓', 3: '¼' }

const isFieldZone = (key: string | null) =>
  key !== HEADER_GROUP_KEY && !(key !== null && TABLE_FORM_GROUP_KEYS.includes(key))

/** Where a field sits on the form (the header strip and table forms aside). */
export function placementOf(bundle: LayoutBundle, field: string): PlacementRow | null {
  return (
    bundle.placements.find(
      (p) => p.field === field && isFieldZone(p.group_key) && !isCanvasSlot(p)
    ) ?? null
  )
}

/** Fields the form shows: real fields (no slots, widgets or relation paths' internals). */
export function placedFields(bundle: LayoutBundle): PlacementRow[] {
  return bundle.placements.filter(
    (p) =>
      !p.field.startsWith('__') &&
      p.widget_id == null &&
      isFieldZone(p.group_key) &&
      !isCanvasSlot(p)
  )
}

/** Groups a command can name (no pseudo groups such as Ungrouped). */
export function namedGroups(bundle: LayoutBundle): GroupRow[] {
  return bundle.groups.filter((g) => !g.key.startsWith('__'))
}

export function fieldLabel(env: Pick<CommandEnv, 'fields'>, p: PlacementRow | string): string {
  const field = typeof p === 'string' ? p : p.field
  if (typeof p !== 'string') {
    const ov = readOverrides(p)
    if (typeof ov.label === 'string' && ov.label.trim()) return ov.label.trim()
    if (p.label_override) return p.label_override
  }
  const own = env.fields.find((f) => f.field === field)?.label
  return own || titleCase(field.split('.').pop() ?? field)
}

export function groupNoun(g: { type: string } | null | undefined): string {
  if (!g) return 'section'
  if (g.type === 'tab') return 'step'
  if (g.type === 'container') return 'tab group'
  if (g.type === 'content') return 'text block'
  return 'section'
}

function groupLabel(bundle: LayoutBundle, key: string | null): string {
  if (key === null) return 'Ungrouped'
  const g = bundle.groups.find((x) => x.key === key)
  return g ? g.label || titleCase(g.key) : key
}

/** Members of a container in their order: groups (and, at the top, slot cards). */
function siblingsOf(bundle: LayoutBundle, parent: string | null): Array<{ key: string }> {
  const rows: Array<{ key: string; sort: number }> = bundle.groups
    .filter((g) => g.parent_key === parent)
    .map((g) => ({ key: g.key, sort: g.sort }))
  if (parent === null)
    for (const p of bundle.placements)
      if (isCanvasSlot(p)) rows.push({ key: p.field, sort: p.sort })
  return rows.sort((a, b) => a.sort - b.sort)
}

function zoneOf(bundle: LayoutBundle, key: string | null, without?: PlacementRow): PlacementRow[] {
  return bundle.placements
    .filter((p) => p.group_key === key && !isCanvasSlot(p) && p !== without)
    .sort((a, b) => a.sort - b.sort)
}

function slugKey(label: string, bundle: LayoutBundle): string {
  const root =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'section'
  const taken = new Set(bundle.groups.map((g) => g.key))
  let key = root
  for (let i = 2; taken.has(key); i++) key = `${root}_${i}`
  return key
}

function layoutRoleIds(bundle: LayoutBundle): string[] {
  const c = asObject(bundle.layout.conditions)
  return Array.isArray(c.role_ids) ? c.role_ids.map(String) : []
}

class PlanError extends Error {}

/** After any op the twin renumbers every container 0..n-1: a row's sort is its index. */
function normalize(bundle: LayoutBundle): LayoutBundle {
  return applyLayoutOps(bundle, [{ op: 'layout_update', patch: {} }])
}

function translate(
  cur: LayoutBundle,
  env: CommandEnv,
  intent: CommandIntent
): { ops: LayoutOp[]; steps: string[]; notes: string[] } {
  const fail = (m: string): never => {
    throw new PlanError(m)
  }
  const placed = (field: string) =>
    placementOf(cur, field) ?? fail(`${fieldLabel(env, field)} is not on this form`)
  const group = (key: string) =>
    cur.groups.find((g) => g.key === key) ?? fail(`There is no section "${key}" on this form`)

  switch (intent.kind) {
    case 'move_field': {
      const row = placed(intent.field)
      const name = fieldLabel(env, row)
      const anchor = intent.before ?? intent.after
      let to = intent.to_group
      if (anchor) {
        if (anchor === intent.field) fail(`${name} cannot move next to itself`)
        to = placed(anchor).group_key
      } else if (to !== null) group(to)
      const zone = zoneOf(cur, to, row)
      let index = zone.length
      if (anchor) {
        const at = zone.findIndex((p) => p.field === anchor)
        index = intent.before ? at : at + 1
      }
      const where = anchor
        ? `${intent.before ? 'before' : 'after'} ${fieldLabel(env, placed(anchor))}`
        : `to ${groupLabel(cur, to)}`
      return {
        ops: [
          {
            op: 'move',
            from: { field: row.field, group_key: row.group_key },
            to_group_key: to,
            index
          }
        ],
        steps: [`Move ${name} ${where}`],
        notes: []
      }
    }
    case 'move_group': {
      const g = group(intent.group)
      const anchorKey = intent.before ?? intent.after ?? fail('Say where the section goes')
      const anchor = group(anchorKey)
      if (anchor.key === g.key) fail(`${g.label} cannot move next to itself`)
      const members = siblingsOf(cur, anchor.parent_key).filter((m) => m.key !== g.key)
      const at = members.findIndex((m) => m.key === anchor.key)
      return {
        ops: [
          {
            op: 'group_move',
            key: g.key,
            parent_key: anchor.parent_key,
            index: intent.before ? at : at + 1
          }
        ],
        steps: [
          `Move ${groupNoun(g)} ${g.label} ${intent.before ? 'before' : 'after'} ${anchor.label}`
        ],
        notes: []
      }
    }
    case 'set_field': {
      const row = placed(intent.field)
      const name = fieldLabel(env, row)
      let ov: Record<string, unknown> = readOverrides(row)
      const put = (k: string, v: unknown) => {
        ov = withKey(ov, k, v) ?? {}
      }
      const patch: PlacementPatch = {}
      const steps: string[] = []
      const notes: string[] = []
      if (intent.required !== undefined) {
        put('required', intent.required ? true : undefined)
        steps.push(`Make ${name} ${intent.required ? 'required' : 'optional'}`)
        if (intent.role) {
          const role = env.roles.find((r) => r.id === intent.role)
          const roleName = role?.name ?? 'that role'
          const ids = layoutRoleIds(cur)
          if (ids.length > 0 && ids.every((id) => id === intent.role))
            notes.push(`This form is only for ${roleName}, so this applies to ${roleName} alone.`)
          else
            notes.push(
              `Required is set per form, not per role. This form is ${ids.length ? 'also used by other roles' : 'used by everyone it reaches'}, so ${name} becomes ${intent.required ? 'required' : 'optional'} for them too. To limit it to ${roleName}, give ${roleName} its own form (Who gets this form) and run the command there.`
            )
        }
      }
      if (intent.readonly !== undefined) {
        put('readonly', intent.readonly ? true : undefined)
        steps.push(`Make ${name} ${intent.readonly ? 'read-only' : 'editable'}`)
      }
      if (intent.hidden !== undefined) {
        put('hidden', intent.hidden ? true : undefined)
        if (!intent.hidden && row.is_visible === false) patch.is_visible = true
        steps.push(`${intent.hidden ? 'Hide' : 'Show'} ${name}`)
      }
      if (intent.label !== undefined) {
        put('label', intent.label ?? undefined)
        steps.push(
          intent.label
            ? `Rename ${name} to "${intent.label}"`
            : `Use the field's own label for ${name}`
        )
      }
      if (intent.help !== undefined) {
        put('note', intent.help ?? undefined)
        steps.push(intent.help ? `Set the help text of ${name}` : `Remove the help text of ${name}`)
      }
      if (intent.width !== undefined) {
        patch.col_span = intent.width === 12 ? null : intent.width
        steps.push(`Set the width of ${name} to ${WIDTH_WORDS[intent.width]}`)
      }
      if (steps.length === 0) fail(`Nothing to change on ${name}`)
      const before = JSON.stringify(readOverrides(row))
      if (JSON.stringify(ov) !== before) patch.overrides = Object.keys(ov).length ? ov : null
      if (Object.keys(patch).length === 0) fail(`${name} is already like that`)
      return {
        ops: [
          { op: 'update_placement', at: { field: row.field, group_key: row.group_key }, patch }
        ],
        steps,
        notes
      }
    }
    case 'add_field': {
      const name = fieldLabel(env, intent.field)
      const there = placementOf(cur, intent.field)
      if (there)
        fail(`${name} is already on this form (in ${groupLabel(cur, there.group_key)}) — use move`)
      if (!env.fields.some((f) => f.field === intent.field))
        fail(`${name} is not a field of this collection`)
      if (intent.to_group !== null) group(intent.to_group)
      return {
        ops: [
          {
            op: 'place',
            field: intent.field,
            group_key: intent.to_group,
            index: zoneOf(cur, intent.to_group).length
          }
        ],
        steps: [`Add ${name} to ${groupLabel(cur, intent.to_group)}`],
        notes: []
      }
    }
    case 'remove_field': {
      const row = placed(intent.field)
      return {
        ops: [{ op: 'remove', at: { field: row.field, group_key: row.group_key } }],
        steps: [`Take ${fieldLabel(env, row)} off this form (its data is kept)`],
        notes: []
      }
    }
    case 'add_group': {
      const label = intent.label.trim()
      if (!label) fail('Give the new section a name')
      const type = intent.group_type
      let parent: string | null = null
      let index: number
      if (intent.after) {
        let a = group(intent.after)
        // Only tabs sit in a tab group: a section named after a tab goes after its group.
        if (type !== 'tab' && a.parent_key !== null) a = group(a.parent_key)
        parent = a.parent_key
        index = siblingsOf(cur, parent).findIndex((m) => m.key === a.key) + 1
      } else {
        const same = namedGroups(cur).filter((g) => g.type === type)
        if (type === 'tab' && same.length) parent = same[same.length - 1].parent_key
        const members = siblingsOf(cur, parent)
        const last =
          same.filter((g) => g.parent_key === parent).pop() ??
          namedGroups(cur)
            .filter((g) => g.parent_key === parent)
            .pop()
        index = last ? members.findIndex((m) => m.key === last.key) + 1 : 0
      }
      const key = slugKey(label, cur)
      const after = intent.after ? ` after ${groupLabel(cur, intent.after)}` : ''
      return {
        ops: [{ op: 'group_create', key, label, group_type: type, parent_key: parent, index }],
        steps: [`Add ${type === 'tab' ? 'step' : 'section'} "${label}"${after}`],
        notes: []
      }
    }
    case 'update_group': {
      const g = group(intent.group)
      const patch: { label?: string; is_collapsed?: boolean } = {}
      const steps: string[] = []
      if (intent.label?.trim() && intent.label.trim() !== g.label) {
        patch.label = intent.label.trim()
        steps.push(`Rename ${groupNoun(g)} ${g.label} to "${patch.label}"`)
      }
      if (intent.collapsed !== undefined && intent.collapsed !== g.is_collapsed) {
        if (g.type !== 'section') fail(`Only sections can start collapsed`)
        patch.is_collapsed = intent.collapsed
        steps.push(`${g.label} starts ${intent.collapsed ? 'collapsed' : 'open'}`)
      }
      if (steps.length === 0) fail(`${g.label} is already like that`)
      return { ops: [{ op: 'group_update', key: g.key, patch }], steps, notes: [] }
    }
    default:
      return fail('Unknown command')
  }
}

/**
 * Intents → one ops batch. Each intent is planned against the draft as the
 * previous ones left it and checked with the ops twin; the whole batch is
 * checked once more against the draft as it is. Any refusal fails the plan.
 */
export function intentsToOps(intents: CommandIntent[], env: CommandEnv): PlanResult {
  if (intents.length === 0) return { ok: false, error: 'Nothing to do' }
  try {
    let cur = normalize(env.bundle)
    const plan: CommandPlan = { ops: [], steps: [], notes: [] }
    for (const intent of intents) {
      const part = translate(cur, env, intent)
      cur = applyLayoutOps(cur, part.ops)
      plan.ops.push(...part.ops)
      plan.steps.push(...part.steps)
      plan.notes.push(...part.notes)
    }
    applyLayoutOps(env.bundle, plan.ops)
    return { ok: true, ...plan }
  } catch (e) {
    return { ok: false, error: humanizeOpError(e instanceof Error ? e.message : String(e)) }
  }
}

/** The undo / history label for a plan: its one step, or the first and a count. */
export function planLabel(plan: CommandPlan): string {
  const [first, ...rest] = plan.steps
  if (!first) return 'Command'
  return rest.length
    ? `${first} and ${rest.length} more change${rest.length === 1 ? '' : 's'}`
    : first
}
