/**
 * Layout lint — one deterministic check of a record form (#2592, #2582,
 * #2607, #2612). Pure: the caller hands it the layout (the editor's draft
 * bundle, or the stored bundle on the server) and what the collection knows
 * (field flags, who may edit, transition requirements). Findings name their
 * target and, where one is safe, a fix as layout ops.
 *
 * TWIN FILE: api/src/services/layout-lint.ts and
 * packages/shared/src/lib/layout-lint.ts must stay byte-identical (the API
 * cannot import packages/shared; an API test compares the two files). No
 * imports: the shapes below are structural subsets of LayoutBundle.
 *
 * Categories: required fields hidden from a role that must fill them,
 * picker cascades whose parent field is not on the form, empty sections and
 * steps, sections and fields no record reaches, and accessibility (no label,
 * a required field without its marker, a tab order that doubles back, poor
 * contrast of a chosen colour). The health score reads the findings.
 */

export type LintSeverity = 'error' | 'warn' | 'info'

export type LintRule =
  | 'required-hidden'
  | 'required-hidden-for-role'
  | 'cascade-missing'
  | 'empty-section'
  | 'empty-step'
  | 'unreachable-step'
  | 'unreachable-field'
  | 'a11y-no-label'
  | 'a11y-required-no-marker'
  | 'a11y-tab-order'
  | 'a11y-contrast'

export type LintTarget =
  | { kind: 'field'; field: string; group_key: string | null }
  | { kind: 'group'; key: string }
  | { kind: 'layout' }

export interface LintFix {
  label: string
  /** LayoutOp[] — typed loosely so this file needs no import. */
  ops: Array<Record<string, unknown>>
}

export interface LintFinding {
  id: string
  rule: LintRule
  severity: LintSeverity
  target: LintTarget
  message: string
  fix?: LintFix
}

export interface LintGroupInput {
  key: string
  parent_key: string | null
  sort: number
  label: string
  type: string
  tab_mode?: string | null
  visible_when?: unknown
  hidden_for_roles?: unknown
  locked_for_roles?: unknown
  summary_fields?: unknown
}

export interface LintPlacementInput {
  field: string
  group_key: string | null
  sort: number
  label_override?: string | null
  is_visible?: boolean | number | null
  col_span?: number | null
  overrides?: unknown
  input_bindings?: unknown
  widget_id?: number | null
}

export interface LintLayoutInput {
  layout: Record<string, unknown>
  groups: LintGroupInput[]
  placements: LintPlacementInput[]
  /** What a parent layout supplies (mergeInherited): judged, never fixed here. */
  inherited?: { fields: string[]; groups: string[] }
}

const UNGROUPED_KEY = '__ungrouped__'

/** The layout as the record page renders it: the parent's groups and fields
 *  this layout does not have itself join it (bundleToActiveLayout's rule). */
export function mergeInherited(
  own: LintLayoutInput,
  parent: LintLayoutInput | null | undefined
): LintLayoutInput {
  if (!parent) return own
  const ownFields = new Set(own.placements.map((p) => p.field))
  const ownKeys = new Set(own.groups.map((g) => g.key))
  const groups = parent.groups.filter((g) => g.key !== UNGROUPED_KEY && !ownKeys.has(g.key))
  const placements = parent.placements.filter((p) => !ownFields.has(p.field))
  return {
    ...own,
    groups: [...own.groups, ...groups],
    placements: [...own.placements, ...placements],
    inherited: { fields: placements.map((p) => p.field), groups: groups.map((g) => g.key) }
  }
}

export interface LintFieldMeta {
  field: string
  label?: string | null
  required?: boolean
  hidden?: boolean
  readonly?: boolean
  /** Fields this picker filters its choices by (dependency_config.cascade_filters). */
  cascade_parents?: string[]
  /** options.col_span — the width a placement without its own takes. */
  col_span?: number | null
  /** Field type; 'alias' = a related-records list, which its section titles. */
  type?: string | null
}

export interface LintRole {
  id: string
  name: string
  admin?: boolean
  /** May create or update records of the collection. */
  can_write: boolean
  /** Fields the role may write; null = every field. */
  writable_fields: string[] | null
}

/** A transition that cannot run until `field` is filled. */
export interface LintRequirement {
  field: string
  transition: string
  /** Who runs the transition; empty = anyone who may edit. */
  role_ids: string[]
}

export interface LintContext {
  fields: LintFieldMeta[]
  roles: LintRole[]
  requirements: LintRequirement[]
}

export const EMPTY_LINT_CONTEXT: LintContext = { fields: [], roles: [], requirements: [] }

// ── Small readers ────────────────────────────────────────────────────────────

const SENTINEL_RE = /^__.*__$/
const HEADER_KEY = '__header__'
const FIELD_REF_RE = /^\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/

type Obj = Record<string, unknown>

function parse(raw: unknown): unknown {
  let cur = raw
  for (let i = 0; i < 4 && typeof cur === 'string'; i++) {
    const t = cur.trim()
    if (t === '') return null
    try {
      cur = JSON.parse(t)
    } catch {
      return null
    }
  }
  return cur
}

function obj(raw: unknown): Obj {
  const v = parse(raw)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
}

function list(raw: unknown): unknown[] {
  const v = parse(raw)
  return Array.isArray(v) ? v : []
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

function roleIds(raw: unknown): string[] {
  return list(raw).map((r) => String(r).toUpperCase())
}

/** A field the person fills in or reads: not a slot, sentinel or widget. */
function isRealField(p: LintPlacementInput): boolean {
  return !SENTINEL_RE.test(p.field) && p.widget_id == null
}

function bindingValue(p: LintPlacementInput, key: string): unknown {
  const raw = parse(p.input_bindings)
  if (Array.isArray(raw)) {
    const b = raw.find((x) => x && typeof x === 'object' && (x as Obj).key === key) as
      | Obj
      | undefined
    return b?.binding_value
  }
  if (raw && typeof raw === 'object') return (raw as Obj)[key]
  return undefined
}

function names(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? ''
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

const titleCase = (s: string) =>
  s
    .replace(/[_.]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())

// ── Conditions that can never all hold ──────────────────────────────────────

interface Cond {
  field: string
  op: string
  value?: unknown
}

function conds(raw: unknown): Cond[] {
  return list(raw).filter(
    (c): c is Cond =>
      !!c && typeof c === 'object' && typeof (c as Cond).field === 'string' && !!(c as Cond).op
  )
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isNaN(n) ? null : n
  }
  return null
}

function same(a: unknown, b: unknown): boolean {
  const x = num(a)
  const y = num(b)
  if (x !== null && y !== null) return x === y
  return String(a ?? '') === String(b ?? '')
}

/**
 * Do these conditions (ALL must hold) contradict each other? Only the plain
 * cases are judged — a value naming another field ({{x}}) is never judged.
 */
export function conditionsContradict(list0: Cond[]): boolean {
  const byField = new Map<string, Cond[]>()
  for (const c of list0) {
    if (typeof c.value === 'string' && FIELD_REF_RE.test(c.value.trim())) continue
    byField.set(c.field, [...(byField.get(c.field) ?? []), c])
  }
  for (const cs of byField.values()) {
    const isNull = cs.some((c) => c.op === 'null')
    const filled = cs.some(
      (c) =>
        c.op === 'nnull' ||
        c.op === 'contains' ||
        ['gt', 'gte', 'lt', 'lte'].includes(c.op) ||
        (c.op === 'eq' && c.value != null && c.value !== '')
    )
    if (isNull && filled) return true
    const eqs = cs.filter((c) => c.op === 'eq')
    for (let i = 1; i < eqs.length; i++) if (!same(eqs[0].value, eqs[i].value)) return true
    const eq = eqs[0]
    if (eq) {
      if (cs.some((c) => c.op === 'neq' && same(c.value, eq.value))) return true
      if (cs.some((c) => c.op === 'nnull') && (eq.value == null || eq.value === '')) return true
      const v = num(eq.value)
      if (v !== null) {
        for (const c of cs) {
          const w = num(c.value)
          if (w === null) continue
          if (c.op === 'gt' && !(v > w)) return true
          if (c.op === 'gte' && !(v >= w)) return true
          if (c.op === 'lt' && !(v < w)) return true
          if (c.op === 'lte' && !(v <= w)) return true
        }
      }
    }
    let lo = -Infinity
    let loOpen = false
    let hi = Infinity
    let hiOpen = false
    for (const c of cs) {
      const w = num(c.value)
      if (w === null) continue
      if ((c.op === 'gt' || c.op === 'gte') && (w > lo || (w === lo && c.op === 'gt'))) {
        lo = w
        loOpen = c.op === 'gt'
      }
      if ((c.op === 'lt' || c.op === 'lte') && (w < hi || (w === hi && c.op === 'lt'))) {
        hi = w
        hiOpen = c.op === 'lt'
      }
    }
    if (lo > hi || (lo === hi && (loOpen || hiOpen))) return true
  }
  return false
}

/** A layout's record rules as conditions every record it opens satisfies
 *  (its matcher compares String(raw ?? ''): `eq ''` also matches empty). */
function layoutRuleConds(layout: Obj): Cond[] {
  const out: Cond[] = []
  for (const r of conds(layout.record_conditions)) {
    if (r.op === 'eq') out.push(r.value === '' || r.value == null ? { ...r, op: 'null' } : r)
    else if (r.op === 'neq') out.push(r.value === '' ? { field: r.field, op: 'nnull' } : r)
    else if (r.op === 'nnull') out.push(r)
  }
  return out
}

// ── Colour contrast ──────────────────────────────────────────────────────────

/** The colours a chosen colour name renders as: [light mode, dark mode]. */
const NAMED_COLOURS: Record<string, [string, string]> = {
  cyan: ['#00ceff', '#00ceff'],
  blue: ['#2563eb', '#60a5fa'],
  green: ['#059669', '#34d399'],
  amber: ['#d97706', '#fbbf24'],
  red: ['#dc2626', '#f87171'],
  purple: ['#9333ea', '#c084fc']
}
const LIGHT_BG = '#ffffff'
const DARK_BG = '#0f172a'
/** WCAG's floor for large or bold text and UI marks. */
export const CONTRAST_MIN = 3

function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

function luminance([r, g, b]: [number, number, number]): number {
  const ch = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

/** WCAG contrast ratio of two hex colours (1–21); null when either is not hex. */
export function contrastRatio(a: string, b: string): number | null {
  const x = hexRgb(a)
  const y = hexRgb(b)
  if (!x || !y) return null
  const [l1, l2] = [luminance(x), luminance(y)].sort((p, q) => q - p)
  return (l1 + 0.05) / (l2 + 0.05)
}

/** The worst ratio a colour choice gets against the form background, and where. */
export function colourContrast(colour: string): { ratio: number; mode: 'light' | 'dark' } | null {
  const c = colour.trim().toLowerCase()
  const pair = NAMED_COLOURS[c] ?? (hexRgb(c) ? [c, c] : null)
  if (!pair) return null
  const light = contrastRatio(pair[0], LIGHT_BG)
  const dark = contrastRatio(pair[1], DARK_BG)
  if (light == null || dark == null) return null
  return light <= dark ? { ratio: light, mode: 'light' } : { ratio: dark, mode: 'dark' }
}

// ── The lint ─────────────────────────────────────────────────────────────────

const FORM_TYPES = new Set(['grouped', '', 'null', 'undefined'])
const VALID_SPANS = [3, 4, 6, 12]
const SEVERITY_ORDER: Record<LintSeverity, number> = { error: 0, warn: 1, info: 2 }

export function isFormLayout(layout: Obj): boolean {
  return FORM_TYPES.has(String(layout.layout_type ?? ''))
}

export function lintLayout(raw: LintLayoutInput, ctx: LintContext): LintFinding[] {
  if (!isFormLayout(raw.layout)) return []
  // The Ungrouped zone's position row is not a section.
  const input = { ...raw, groups: raw.groups.filter((g) => g.key !== UNGROUPED_KEY) }
  const out: LintFinding[] = []
  const push = (f: Omit<LintFinding, 'id'>) => {
    const t = f.target
    const at =
      t.kind === 'field' ? `${t.group_key ?? ''}/${t.field}` : t.kind === 'group' ? t.key : ''
    out.push({ id: `${f.rule}:${at}`, ...f })
  }

  const meta = new Map(ctx.fields.map((f) => [f.field, f]))
  const groups = new Map(input.groups.map((g) => [g.key, g]))
  const label = (field: string) => {
    const m = meta.get(field)
    return m?.label || titleCase(field.includes('.') ? field.split('.').pop() || field : field)
  }
  const groupName = (g: LintGroupInput) => g.label || titleCase(g.key)
  const stepsMode = String(input.layout.tab_mode ?? '') === 'steps'
  const placements = [...input.placements].sort((a, b) => a.sort - b.sort)
  const real = placements.filter(isRealField)
  const ov = (p: LintPlacementInput) => obj(p.overrides)
  const shown = (p: LintPlacementInput) => {
    if (p.is_visible === false || p.is_visible === 0) return false
    const o = ov(p)
    return !('hidden' in o ? truthy(o.hidden) : !!meta.get(p.field)?.hidden)
  }
  const required = (p: LintPlacementInput) => {
    if (p.field.includes('.')) return false
    const o = ov(p)
    return 'required' in o ? truthy(o.required) : !!meta.get(p.field)?.required
  }
  const ancestors = (key: string | null): LintGroupInput[] => {
    const chain: LintGroupInput[] = []
    const seen = new Set<string>()
    let cur = key ? groups.get(key) : undefined
    while (cur && !seen.has(cur.key)) {
      seen.add(cur.key)
      chain.push(cur)
      cur = cur.parent_key ? groups.get(cur.parent_key) : undefined
    }
    return chain
  }
  const kindOf = (g: LintGroupInput) => {
    if (g.type !== 'tab') return 'section'
    const parent = g.parent_key ? groups.get(g.parent_key) : undefined
    const steps = parent ? String(parent.tab_mode ?? '') === 'steps' : stepsMode
    return steps ? 'step' : 'tab'
  }

  // Which groups no record (or nobody but administrators) ever sees.
  const ruleConds = layoutRuleConds(input.layout)
  const editors = ctx.roles.filter((r) => !r.admin)
  const unreachable = new Map<string, string>()
  const ownWhy = (g: LintGroupInput): string | null => {
    const vw = conds(g.visible_when)
    if (vw.length > 0) {
      if (conditionsContradict(vw)) return 'its show-when rules can never all hold'
      if (ruleConds.length > 0 && conditionsContradict([...ruleConds, ...vw]))
        return 'its show-when rules never hold for the records this form opens'
    }
    const hidden = new Set(roleIds(g.hidden_for_roles))
    if (editors.length > 0 && editors.every((r) => hidden.has(r.id.toUpperCase())))
      return 'it is hidden from every role but administrators'
    return null
  }
  for (const g of input.groups) {
    const chain = ancestors(g.key)
    for (const a of chain) {
      const why = ownWhy(a)
      if (why) {
        unreachable.set(g.key, a === g ? why : `it sits inside ${groupName(a)}, and ${why}`)
        break
      }
    }
  }
  for (const g of input.groups) {
    const why = unreachable.get(g.key)
    if (!why || (g.parent_key && unreachable.has(g.parent_key))) continue
    push({
      rule: 'unreachable-step',
      severity: 'warn',
      target: { kind: 'group', key: g.key },
      message: `${groupName(g)} never shows: ${why}.`
    })
  }

  // Empty sections and steps (text blocks are content on their own).
  for (const g of input.groups) {
    if (g.type === 'content') continue
    const children = input.groups.filter((c) => c.parent_key === g.key)
    const held = placements.filter((p) => p.group_key === g.key)
    if (held.length > 0 || children.length > 0) continue
    const kind = g.type === 'container' ? 'tabs holder' : kindOf(g)
    push({
      rule: g.type === 'tab' ? 'empty-step' : 'empty-section',
      severity: 'warn',
      target: { kind: 'group', key: g.key },
      message:
        g.type === 'container'
          ? `${groupName(g)} is a tabs holder with no tabs.`
          : `The ${kind} ${groupName(g)} holds nothing, so it shows as an empty ${kind}.`,
      fix: {
        label: `Remove ${groupName(g)}`,
        ops: [{ op: 'group_remove', key: g.key, placements: 'ungroup' }]
      }
    })
  }

  // Per field: where it sits and whether anyone can see it there.
  const byField = new Map<string, LintPlacementInput[]>()
  for (const p of real) byField.set(p.field, [...(byField.get(p.field) ?? []), p])
  const reachable = (p: LintPlacementInput) => !(p.group_key && unreachable.has(p.group_key))
  const visibleSomewhere = (field: string) =>
    (byField.get(field) ?? []).some((p) => shown(p) && reachable(p))

  // Who must fill each field: every editing role when the field is required,
  // and the roles that run a transition needing it.
  const mustFill = new Map<string, Map<string, string>>()
  const note = (field: string, roleId: string, why: string) => {
    const m = mustFill.get(field) ?? new Map<string, string>()
    if (!m.has(roleId)) m.set(roleId, why)
    mustFill.set(field, m)
  }
  const mayWrite = (r: LintRole, field: string) =>
    r.can_write && (r.writable_fields == null || r.writable_fields.includes(field))
  for (const [field, ps] of byField) {
    if (!ps.some(required)) continue
    for (const r of editors) if (mayWrite(r, field)) note(field, r.id, 'required')
  }
  for (const q of ctx.requirements) {
    if (!byField.has(q.field)) continue
    const ids = q.role_ids.length ? q.role_ids.map((x) => x.toUpperCase()) : null
    for (const r of editors) {
      if (ids && !ids.includes(r.id.toUpperCase())) continue
      if (mayWrite(r, q.field)) note(q.field, r.id, `to ${q.transition}`)
    }
  }
  const roleName = new Map(ctx.roles.map((r) => [r.id.toUpperCase(), r.name]))

  for (const [field, ps] of byField) {
    const first = ps[0]
    const target: LintTarget = { kind: 'field', field, group_key: first.group_key }
    const name = label(field)
    const isRequired = ps.some(required)

    // Required, but hidden wherever it is placed.
    if (isRequired && !ps.some(shown)) {
      const off = ps.find((p) => p.is_visible === false || p.is_visible === 0)
      push({
        rule: 'required-hidden',
        severity: 'error',
        target,
        message: `${name} is required, but this form hides it — nobody can fill it here.`,
        fix: off
          ? {
              label: `Show ${name}`,
              ops: [
                {
                  op: 'update_placement',
                  at: { field, group_key: off.group_key },
                  patch: { is_visible: true }
                }
              ]
            }
          : undefined
      })
    }

    // Required (or needed by a transition), but a section hides or locks it for a role.
    const who = mustFill.get(field)
    if (who && ps.some(shown)) {
      const blocked = new Map<string, { group: LintGroupInput; how: 'hidden' | 'locked' }>()
      for (const roleId of who.keys()) {
        const role = roleId.toUpperCase()
        let block: { group: LintGroupInput; how: 'hidden' | 'locked' } | null = null
        let open = false
        for (const p of ps.filter(shown)) {
          const chain = ancestors(p.group_key)
          const hid = chain.find((g) => roleIds(g.hidden_for_roles).includes(role))
          const direct = p.group_key ? groups.get(p.group_key) : undefined
          const locked =
            direct && roleIds(direct.locked_for_roles).includes(role) ? direct : undefined
          if (hid) block ??= { group: hid, how: 'hidden' }
          else if (locked) block ??= { group: locked, how: 'locked' }
          else {
            open = true
            break
          }
        }
        if (!open && block) blocked.set(roleId, block)
      }
      const byBlock = new Map<string, { group: LintGroupInput; how: string; roles: string[] }>()
      for (const [roleId, b] of blocked) {
        const k = `${b.how}|${b.group.key}`
        const e = byBlock.get(k) ?? { ...b, roles: [] }
        e.roles.push(roleId)
        byBlock.set(k, e)
      }
      for (const b of byBlock.values()) {
        const roleNames = b.roles.map((id) => roleName.get(id.toUpperCase()) ?? id)
        const reasons = [...new Set(b.roles.map((id) => who.get(id) ?? 'required'))]
        const transition = reasons.find((x) => x.startsWith('to '))
        const need = transition
          ? `${names(roleNames)} must fill ${name} ${transition}`
          : `${name} is required and ${names(roleNames)} can edit these records`
        const col = b.how === 'hidden' ? 'hidden_for_roles' : 'locked_for_roles'
        const drop = new Set(b.roles.map((r) => r.toUpperCase()))
        const rest = list(b.group[col as 'hidden_for_roles']).filter(
          (r) => !drop.has(String(r).toUpperCase())
        )
        push({
          rule: 'required-hidden-for-role',
          severity: 'error',
          target: { kind: 'field', field, group_key: first.group_key },
          message: `${need}, but ${groupName(b.group)} is ${b.how} for ${
            roleNames.length === 1 ? 'that role' : 'those roles'
          }.`,
          fix: {
            label: `${b.how === 'hidden' ? 'Show' : 'Unlock'} ${groupName(b.group)} for ${names(roleNames)}`,
            ops: [
              {
                op: 'group_update',
                key: b.group.key,
                patch: { [col]: rest.length ? JSON.stringify(rest) : null }
              }
            ]
          }
        })
      }
    }

    // Picker cascade whose parent is not on the form.
    if (ps.some(shown)) {
      for (const parent of meta.get(field)?.cascade_parents ?? []) {
        if (!parent || parent === field || visibleSomewhere(parent)) continue
        const placedHidden = byField.has(parent)
        const at = ps.find(shown) ?? first
        const index = placements
          .filter((p) => p.group_key === at.group_key)
          .findIndex((p) => p.field === field)
        push({
          rule: 'cascade-missing',
          severity: 'warn',
          target: { kind: 'field', field, group_key: at.group_key },
          message: placedHidden
            ? `${name} narrows its choices by ${label(parent)}, which is hidden on this form.`
            : `${name} narrows its choices by ${label(parent)}, which is not on this form.`,
          fix: placedHidden
            ? undefined
            : {
                label: `Add ${label(parent)} before ${name}`,
                ops: [
                  {
                    op: 'place',
                    field: parent,
                    group_key: at.group_key,
                    index: Math.max(0, index)
                  }
                ]
              }
        })
      }
    }

    // Placed, but no record ever shows it.
    if (!isRequired) {
      if (!ps.some(shown)) {
        push({
          rule: 'unreachable-field',
          severity: 'info',
          target,
          message: `${name} is hidden everywhere it is placed, so nobody sees it on this form.`
        })
      } else if (!ps.some((p) => shown(p) && reachable(p))) {
        const g = groups.get(ps.find(shown)?.group_key ?? '')
        push({
          rule: 'unreachable-field',
          severity: 'info',
          target,
          message: `${name} only sits in ${g ? groupName(g) : 'a part of the form'}, which never shows.`
        })
      }
    }

    // Accessibility: a label people (and screen readers) can find. A list of
    // related records, or the only field of its section, is named by the
    // section title instead.
    const visible = ps.filter(shown)
    const titled = (p: LintPlacementInput) =>
      meta.get(field)?.type === 'alias' ||
      (p.group_key != null && real.filter((q) => q.group_key === p.group_key).length === 1)
    if (visible.length > 0 && visible.every((p) => ov(p).label === '') && !visible.some(titled)) {
      const p = visible[0]
      const { label: _drop, ...rest } = ov(p)
      push({
        rule: isRequired ? 'a11y-required-no-marker' : 'a11y-no-label',
        severity: 'warn',
        target: { kind: 'field', field, group_key: p.group_key },
        message: isRequired
          ? `${name} is required, but its label is hidden — so is the required mark.`
          : `${name} shows no label; people and screen readers cannot tell what it asks for.`,
        fix: {
          label: `Show the label of ${name}`,
          ops: [
            {
              op: 'update_placement',
              at: { field, group_key: p.group_key },
              patch: { overrides: Object.keys(rest).length ? rest : null }
            }
          ]
        }
      })
    }
  }

  // Tab order: a row left half-empty while a field that would fit beside it
  // comes after a wider one — keyboard order runs down past the wide field
  // and back up to finish the pair.
  const span = (p: LintPlacementInput) => {
    const s = p.col_span ?? meta.get(p.field)?.col_span ?? 12
    return VALID_SPANS.includes(Number(s)) ? Number(s) : 12
  }
  const zones = new Map<string | null, LintPlacementInput[]>()
  for (const p of real) {
    if (p.group_key === HEADER_KEY || !shown(p)) continue
    zones.set(p.group_key, [...(zones.get(p.group_key) ?? []), p])
  }
  for (const [key, ps] of zones) {
    const rows: Array<{ items: LintPlacementInput[]; free: number }> = []
    for (const p of ps) {
      const s = span(p)
      const last = rows[rows.length - 1]
      if (last && last.free >= s) {
        last.items.push(p)
        last.free -= s
      } else rows.push({ items: [p], free: 12 - s })
    }
    for (let i = 0; i + 1 < rows.length; i++) {
      const row = rows[i]
      if (row.free <= 0) continue
      const later = rows.slice(i + 1, i + 3).flatMap((r) => r.items)
      const fit = later.slice(1).find((p) => span(p) <= row.free)
      if (!fit) continue
      const lastInRow = row.items[row.items.length - 1]
      const index = ps.indexOf(lastInRow) + 1
      push({
        rule: 'a11y-tab-order',
        severity: 'info',
        target: { kind: 'field', field: fit.field, group_key: key },
        message: `${label(fit.field)} would fit beside ${label(lastInRow.field)}, but comes after ${label(later[0].field)} — the keyboard order runs down, then back up.`,
        fix: {
          label: `Move ${label(fit.field)} beside ${label(lastInRow.field)}`,
          ops: [
            {
              op: 'move',
              from: { field: fit.field, group_key: key },
              to_group_key: key,
              index
            }
          ]
        }
      })
      break
    }
  }

  // Contrast of the colours this form chooses (header values, thresholds,
  // subtitle parts, collapsed-section summaries).
  const colourFinding = (colour: unknown, where: string, target: LintTarget, idPart: string) => {
    if (typeof colour !== 'string' || !colour) return
    const c = colourContrast(colour)
    if (!c || c.ratio >= CONTRAST_MIN) return
    out.push({
      id: `a11y-contrast:${idPart}:${colour}`,
      rule: 'a11y-contrast',
      severity: 'warn',
      target,
      message: `${where} uses ${colour}, which reads at ${c.ratio.toFixed(1)}:1 on the ${c.mode} background (${CONTRAST_MIN}:1 is the least).`
    })
  }
  for (const p of placements) {
    const t: LintTarget = { kind: 'field', field: p.field, group_key: p.group_key }
    const nm = SENTINEL_RE.test(p.field) ? 'The subtitle' : label(p.field)
    colourFinding(bindingValue(p, '__color__'), nm, t, `${p.group_key}/${p.field}`)
    for (const th of list(bindingValue(p, '__threshold__')))
      colourFinding((th as Obj)?.color, `A threshold on ${nm}`, t, `${p.group_key}/${p.field}`)
    for (const sf of list(obj(bindingValue(p, '__subtitle_config__')).fields))
      colourFinding(
        (sf as Obj)?.color,
        `The subtitle part ${label(String((sf as Obj)?.field ?? ''))}`,
        t,
        `subtitle/${String((sf as Obj)?.field ?? '')}`
      )
  }
  for (const g of input.groups)
    for (const sf of list(g.summary_fields))
      colourFinding(
        (sf as Obj)?.color,
        `The summary of ${groupName(g)}`,
        { kind: 'group', key: g.key },
        `summary/${g.key}`
      )

  // One finding per id (a field placed twice reports once). A finding on
  // something the parent layout supplies is fixed there, not here.
  const seen = new Set<string>()
  const fromParent = (t: LintTarget) =>
    (t.kind === 'field' && !!raw.inherited?.fields.includes(t.field)) ||
    (t.kind === 'group' && !!raw.inherited?.groups.includes(t.key))
  return out
    .filter((f) => {
      if (seen.has(f.id)) return false
      seen.add(f.id)
      return true
    })
    .map((f) => (f.fix && fromParent(f.target) ? { ...f, fix: undefined } : f))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

// ── Health score ─────────────────────────────────────────────────────────────

export interface HealthCost {
  label: string
  points: number
}

export interface LayoutHealth {
  score: number
  costs: HealthCost[]
}

export const HEALTH_FIELD_LIMIT = 30
export const HEALTH_STEP_LIMIT = 7

/** Distinct real fields the form shows, and its steps or tabs. */
export function layoutShape(input: LintLayoutInput): { fields: number; steps: number } {
  const fields = new Set(
    input.placements
      .filter((p) => isRealField(p) && p.is_visible !== false && p.is_visible !== 0)
      .map((p) => p.field)
  ).size
  const keys = new Set(input.groups.map((g) => g.key))
  const containers = input.groups.filter((g) => g.type === 'container').map((g) => g.key)
  const steps = input.groups.filter(
    (g) =>
      g.type === 'tab' &&
      (g.parent_key == null || !keys.has(g.parent_key) || containers.includes(g.parent_key))
  ).length
  return { fields, steps }
}

/**
 * 0–100 per form: 100 less what costs points — too many fields, too many
 * steps, fields nobody sees, and lint findings by severity. Every cost is
 * listed so the tooltip can say why.
 */
export function layoutHealth(input: LintLayoutInput, findings: LintFinding[]): LayoutHealth {
  const { fields, steps } = layoutShape(input)
  const costs: HealthCost[] = []
  if (fields > HEALTH_FIELD_LIMIT)
    costs.push({
      label: `${fields} fields on one form`,
      points: Math.min(20, Math.ceil((fields - HEALTH_FIELD_LIMIT) / 3))
    })
  if (steps > HEALTH_STEP_LIMIT)
    costs.push({
      label: `${steps} steps or tabs`,
      points: Math.min(10, (steps - HEALTH_STEP_LIMIT) * 2)
    })
  const unused = findings.filter((f) => f.rule === 'unreachable-field').length
  if (unused > 0)
    costs.push({
      label: `${unused} ${unused === 1 ? 'field' : 'fields'} nobody sees`,
      points: Math.min(20, unused * 2)
    })
  const rest = findings.filter((f) => f.rule !== 'unreachable-field')
  const count = (s: LintSeverity) => rest.filter((f) => f.severity === s).length
  const weights: Array<[LintSeverity, number, string, string]> = [
    ['error', 10, 'problem', 'problems'],
    ['warn', 4, 'warning', 'warnings'],
    ['info', 1, 'suggestion', 'suggestions']
  ]
  let lintPoints = 0
  for (const [sev, w, one, many] of weights) {
    const n = count(sev)
    if (n === 0) continue
    const pts = Math.min(50 - lintPoints, n * w)
    if (pts <= 0) continue
    lintPoints += pts
    costs.push({ label: `${n} ${n === 1 ? one : many}`, points: pts })
  }
  const score = Math.max(0, 100 - costs.reduce((s, c) => s + c.points, 0))
  return { score, costs }
}
