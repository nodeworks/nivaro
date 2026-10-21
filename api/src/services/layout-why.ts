/**
 * #2596 — "Why can't I edit this?" on the record page. The form already
 * explains a locked field in general words ("Locked for your role"); this
 * names the exact rule behind it: which form the record opened with and why
 * (the same resolution as /active and the overview's explain), the role or
 * pipeline step a lock rule lists, the section that locks it, or the role's
 * field permissions. For administrators it also lists the fields rules hide
 * on this record's form (step rules, sections hidden from roles, fields
 * turned off on the form).
 *
 * Only names leave the server: role names, step labels, section and form
 * names — never other people's data. A non-admin hears only about rules that
 * apply to their own role.
 */

export interface WhyGroup {
  key: string
  label: string | null
  /** The parent group's key (a section inside a tab or step). */
  parent_key: string | null
  visible_when: string | null
  hidden_for_roles: string | null
  locked_for_roles: string | null
}

export interface WhyPlacement {
  field: string
  group_key: string | null
  is_visible: boolean
  lock_conditions: string | null
}

export interface WhyInput {
  layoutName: string
  groups: WhyGroup[]
  placements: WhyPlacement[]
  /** The viewer's role id (upper or lower case), null without one. */
  roleId: string | null
  roleName: string | null
  isAdmin: boolean
  /** Role id (upper case) → name. */
  roleNames: Map<string, string>
  /** Step key → label. */
  stateLabels: Map<string, string>
  /** The record's current step key, null when it has none or is new. */
  currentState: string | null
  /** Fields the role may update; null = every field (admin, or a `*` policy). */
  updatable: string[] | null
  /** Fields the role may read; null = every field. */
  readable: string[] | null
}

export type LockKind = 'role' | 'state' | 'section' | 'permission'

export interface FieldLock {
  kind: LockKind
  text: string
}

export type HiddenKind = 'step_rule' | 'section_roles' | 'off'

export interface HiddenField {
  field: string
  kind: HiddenKind
  /** The section or step whose rule hides it. */
  section: string | null
  section_label: string | null
  /** step_rule: the rule, as stored ([{field, op, value}], all must match). */
  rules?: Array<{ field?: string; op?: string; value?: unknown }>
  /** section_roles: who it is hidden from. */
  roles?: string[]
  text: string
}

const up = (v: unknown) => String(v ?? '').toUpperCase()

function parseList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

function parseConds(
  raw: string | null
): Array<{ type?: string; state_keys?: string[]; role_ids?: string[] }> {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** "A", "A or B", "A, B or C". */
export function orList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}

const quoted = (s: string) => `“${s}”`
const titleOf = (key: string) => key.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

/** Every field placed in `key` or in a group nested under it. */
function fieldsUnder(key: string, groups: WhyGroup[], placements: WhyPlacement[]): string[] {
  const keys = new Set([key])
  let grew = true
  while (grew) {
    grew = false
    for (const g of groups)
      if (g.parent_key && keys.has(g.parent_key) && !keys.has(g.key)) {
        keys.add(g.key)
        grew = true
      }
  }
  return placements
    .filter((p) => p.group_key && keys.has(p.group_key) && !p.field.startsWith('__'))
    .map((p) => p.field)
}

/** Is group `key` (or a group it sits in) hidden from `role`? */
function hiddenFromRole(key: string | null, groups: WhyGroup[], role: string): boolean {
  const byKey = new Map(groups.map((g) => [g.key, g]))
  const seen = new Set<string>()
  for (let k = key; k && !seen.has(k); k = byKey.get(k)?.parent_key ?? null) {
    seen.add(k)
    if (parseList(byKey.get(k)?.hidden_for_roles ?? null).some((r) => up(r) === role)) return true
  }
  return false
}

export function explainFieldLocks(input: WhyInput): Record<string, FieldLock> {
  const out: Record<string, FieldLock> = {}
  const myRole = input.roleId ? up(input.roleId) : null
  const roleWords = input.roleName ? `the ${input.roleName} role` : 'your role'
  const form = quoted(input.layoutName)

  // A section locked for the viewer's role (admins are exempt, as on the form). A section
  // hidden from the role is never named: the viewer does not see it.
  if (myRole && !input.isAdmin) {
    for (const g of input.groups) {
      if (!parseList(g.locked_for_roles).some((r) => up(r) === myRole)) continue
      if (hiddenFromRole(g.key, input.groups, myRole)) continue
      const label = g.label || titleOf(g.key)
      for (const f of fieldsUnder(g.key, input.groups, input.placements))
        out[f] = {
          kind: 'section',
          text: `The ${quoted(label)} section is locked for ${roleWords} on the ${form} form`
        }
    }
  }

  // Lock rules on the placement: the step one applies now wins, then the role one.
  for (const p of input.placements) {
    if (p.field.startsWith('__') || out[p.field]) continue
    const conds = parseConds(p.lock_conditions)
    const state = conds.find(
      (c) =>
        c.type === 'pipeline_state' &&
        Array.isArray(c.state_keys) &&
        c.state_keys.length > 0 &&
        (input.currentState == null || c.state_keys.includes(input.currentState))
    )
    if (state) {
      // The step the record is in now names the rule exactly; without one, a short list.
      const keys =
        input.currentState != null ? [input.currentState] : (state.state_keys ?? []).slice(0, 3)
      const more = input.currentState != null ? 0 : (state.state_keys ?? []).length - keys.length
      const steps = keys.map((k) => input.stateLabels.get(k) ?? titleOf(k))
      if (more > 0) steps.push(`${more} other ${more === 1 ? 'step' : 'steps'}`)
      out[p.field] = {
        kind: 'state',
        text: `Locked while the record is in ${orList(steps)}, by a rule on the ${form} form`
      }
      continue
    }
    const role = conds.find(
      (c) =>
        c.type === 'role' &&
        Array.isArray(c.role_ids) &&
        c.role_ids.length > 0 &&
        (input.isAdmin || (myRole != null && c.role_ids.some((r) => up(r) === myRole)))
    )
    if (role) {
      // A non-admin hears about their own role only.
      const names = input.isAdmin
        ? (role.role_ids ?? []).map((r) => input.roleNames.get(up(r)) ?? r)
        : [input.roleName ?? 'your role']
      out[p.field] = {
        kind: 'role',
        text: `Locked for the ${orList(names)} role${names.length > 1 ? 's' : ''} by a rule on the ${form} form`
      }
    }
  }

  // Field permissions: readable but not updatable for this role.
  if (!input.isAdmin && input.updatable !== null) {
    const can = new Set(input.updatable)
    const read = input.readable === null ? null : new Set(input.readable)
    for (const p of input.placements) {
      const top = p.field.split('.')[0]
      if (p.field.startsWith('__') || out[p.field] || can.has(top)) continue
      if (read && !read.has(top)) continue
      out[p.field] = {
        kind: 'permission',
        text: `${input.roleName ? `The ${input.roleName} role` : 'Your role'} can read this field but not change it (role permissions)`
      }
    }
  }

  // A non-admin hears only about fields they can read, outside sections hidden from them.
  if (!input.isAdmin) {
    const read = input.readable === null ? null : new Set(input.readable)
    const groupOf = new Map(input.placements.map((p) => [p.field, p.group_key]))
    for (const f of Object.keys(out)) {
      const unreadable = read != null && !read.has('*') && !read.has(f.split('.')[0])
      const hidden = myRole != null && hiddenFromRole(groupOf.get(f) ?? null, input.groups, myRole)
      if (unreadable || hidden) delete out[f]
    }
  }
  return out
}

/** Fields rules hide on this form — for administrators. */
export function explainHiddenFields(input: WhyInput): HiddenField[] {
  const out: HiddenField[] = []
  const seen = new Set<string>()
  const push = (h: HiddenField) => {
    if (seen.has(h.field)) return
    seen.add(h.field)
    out.push(h)
  }
  for (const g of input.groups) {
    const label = g.label || titleOf(g.key)
    let rules: HiddenField['rules']
    try {
      const v = g.visible_when ? JSON.parse(g.visible_when) : null
      rules = Array.isArray(v) && v.length > 0 ? v : undefined
    } catch {
      rules = undefined
    }
    if (rules)
      for (const f of fieldsUnder(g.key, input.groups, input.placements))
        push({
          field: f,
          kind: 'step_rule',
          section: g.key,
          section_label: label,
          rules,
          text: `${quoted(label)} shows only when its rule matches this record`
        })
  }
  for (const g of input.groups) {
    const roles = parseList(g.hidden_for_roles).map((r) => input.roleNames.get(up(r)) ?? r)
    if (!roles.length) continue
    const label = g.label || titleOf(g.key)
    for (const f of fieldsUnder(g.key, input.groups, input.placements))
      push({
        field: f,
        kind: 'section_roles',
        section: g.key,
        section_label: label,
        roles,
        text: `The ${quoted(label)} section is hidden from ${orList(roles)}`
      })
  }
  for (const p of input.placements) {
    if (p.is_visible || p.field.startsWith('__')) continue
    push({
      field: p.field,
      kind: 'off',
      section: p.group_key,
      section_label: null,
      text: `Turned off on the ${quoted(input.layoutName)} form`
    })
  }
  return out
}
