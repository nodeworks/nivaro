// Type-only from the route: the route imports this module, so a value import back would be a
// cycle (TDZ at boot). The parsers live in services/layout-patch.
import type { PickReason } from '../routes/collection-layouts.js'
import { liveVariants } from './layout-ab.js'
import { parseConditions, parseRecordConditions, type RecordConditionRule } from './layout-patch.js'
import {
  activeFreeze,
  activeWindowOf,
  phoneOf,
  screenVersionOf,
  tabletOf,
  todayInInstance,
  windowState,
  windowWords
} from './layout-resolve-rules.js'

/**
 * "Which form does each kind of record get?" — the Layouts overview. One row
 * per layout, sorted and sectioned exactly as GET /collection-layouts/active
 * checks them (pickBestLayout): record-rule forms (most rules first, then DB
 * order), role-preference forms (more roles first), the default, then the
 * forms only a link or a reference reaches, the other layout types, and
 * layouts nothing reaches. Pure: the route loads layouts, references, roles.
 */

export type OverviewSection = 'forms' | 'link_only' | 'other_views' | 'unused'

export interface OverviewReference {
  kind: string
  id: string | number
  label: string
}

export interface OverviewRow {
  layout_id: number
  name: string
  layout_type: string
  slug: string | null
  section: OverviewSection
  reason: PickReason
  is_default: boolean
  new_menu: { label: string; hidden: boolean } | null
  /** groups = plain sections (not tabs/steps or their containers); fields =
   *  distinct visible real fields (slots and sentinels excluded). */
  shape: {
    groups: number
    steps_or_tabs: number
    fields: number
    container_mode: 'tabs' | 'steps' | null
  }
  references: OverviewReference[]
  warnings: string[]
  /** Forms only: the sections (with their show-when rules) and where each field
   *  sits — the editor's rule-loop check (#2642) runs on it client-side. */
  rule_shape?: RuleShape
  /** #2714: the days the form resolves on, and where today falls. */
  active_window?: { from: string | null; until: string | null; state: 'before' | 'open' | 'after' }
  /** #2715: this form's phone version (desktop rows) / the form it is the phone version of. */
  phone_version?: { layout_id: number; name: string } | null
  phone_of?: number | null
  /** #3183: this form's tablet version (desktop rows) / the form it is the tablet version of. */
  tablet_version?: { layout_id: number; name: string } | null
  tablet_of?: number | null
  /** #2717: edits refused until this day (today inside the freeze). */
  frozen?: { until: string; reason: string } | null
}

export interface RuleShape {
  groups: Array<{
    key: string
    label: string | null
    parent_key: string | null
    visible_when: string | null
  }>
  placements: Array<{ field: string; group_key: string | null }>
}

export interface OverviewLayoutInput {
  id: number
  name: string
  layout_type?: string | null
  slug?: string | null
  is_active?: unknown
  sort?: number | null
  conditions?: unknown
  record_conditions?: unknown
  create_label?: string | null
  create_hidden?: unknown
  tab_mode?: string | null
  groups?: Array<{
    id?: number
    key: string
    type?: string | null
    container_id?: number | null
    tab_mode?: string | null
    label?: string | null
    visible_when?: string | null
  }>
  assignments?: Array<{ field: string; group_key?: string | null; is_visible?: unknown }>
}

const SENTINEL_RE = /^__.+__$/

/** One plain line per non-form layout type, as the overview shows it. */
function typeUse(l: OverviewLayoutInput): string {
  switch (l.layout_type) {
    case 'summary':
      return l.is_active ? 'Read mode for the record' : 'Read mode (not turned on)'
    case 'detail':
      return 'Drill-down panel'
    case 'file':
      return l.is_active ? 'PDF — a button on the record' : 'PDF — no button on the record'
    case 'addendum':
      return 'Addendum form'
    case 'table':
      return 'Grid columns'
    default:
      return String(l.layout_type ?? 'grouped')
  }
}

function roleIdsOf(l: OverviewLayoutInput): string[] {
  const ids = parseConditions(l.conditions)?.role_ids
  return Array.isArray(ids) ? ids.map(String) : []
}

function shapeOf(l: OverviewLayoutInput): OverviewRow['shape'] {
  const groups = l.groups ?? []
  const topTabs = groups.filter((g) => g.type === 'tab' && g.container_id == null)
  const container = groups.find((g) => g.type === 'container')
  let steps_or_tabs = 0
  let container_mode: 'tabs' | 'steps' | null = null
  if (topTabs.length > 0) {
    steps_or_tabs = topTabs.length
    // The renderer treats only tab_mode 'steps' as steps; anything else is tabs.
    container_mode = l.tab_mode === 'steps' ? 'steps' : 'tabs'
  } else if (container) {
    steps_or_tabs = groups.filter((g) => g.type === 'tab' && g.container_id === container.id).length
    container_mode = container.tab_mode === 'steps' ? 'steps' : 'tabs'
  }
  const sections = groups.filter(
    (g) => g.type !== 'tab' && g.type !== 'container' && g.type !== 'content'
  ).length
  const fields = new Set(
    (l.assignments ?? [])
      .filter((a) => !SENTINEL_RE.test(a.field) && a.is_visible !== false && a.is_visible !== 0)
      .map((a) => a.field)
  ).size
  return { groups: sections, steps_or_tabs, fields, container_mode }
}

function ruleShapeOf(l: OverviewLayoutInput): RuleShape {
  const groups = l.groups ?? []
  const keyOfId = new Map(groups.map((g) => [Number(g.id), g.key]))
  return {
    groups: groups.map((g) => ({
      key: g.key,
      label: g.label ?? null,
      parent_key: g.container_id == null ? null : (keyOfId.get(Number(g.container_id)) ?? null),
      visible_when: g.visible_when ? String(g.visible_when) : null
    })),
    placements: (l.assignments ?? [])
      .filter((a) => !SENTINEL_RE.test(a.field))
      .map((a) => ({ field: a.field, group_key: a.group_key ?? null }))
  }
}

// String(value) exactly as matchesRecordConditions compares it: `eq null`
// ('null') and `eq ''` (also matches NULL) are different rules.
const ruleKey = (r: RecordConditionRule) => `${r.field}|${r.op}|${String(r.value)}`

/** Does every record that satisfies `rules` also satisfy `rule`? Identical
 *  rules, `nnull` under a non-empty `eq`, and `neq v` under `eq w` (w ≠ v). */
function implied(rule: RecordConditionRule, rules: RecordConditionRule[]): boolean {
  return rules.some((r) => {
    if (r.field !== rule.field) return false
    if (ruleKey(r) === ruleKey(rule)) return true
    if (r.op !== 'eq') return false
    if (rule.op === 'nnull') return String(r.value) !== ''
    if (rule.op === 'neq') return String(r.value) !== String(rule.value)
    return false
  })
}

/** Is everyone who may open `a` also allowed to open `b`? (roleAllows: case-insensitive). */
function rolesCover(b: string[], a: string[]): boolean {
  if (b.length === 0) return true
  if (a.length === 0) return false
  const bs = new Set(b.map((r) => r.toUpperCase()))
  return a.every((r) => bs.has(r.toUpperCase()))
}

export function buildLayoutOverview(
  layouts: OverviewLayoutInput[],
  refsByLayout: Map<number, OverviewReference[]>,
  roles: Array<{ id: string; name: string }>
): OverviewRow[] {
  const roleName = new Map(roles.map((r) => [String(r.id).toUpperCase(), r.name]))
  const roleNames = (ids: string[]) => ids.map((id) => roleName.get(id.toUpperCase()) ?? id)

  // The /active candidate order: is_active desc, sort asc (id for ties).
  const ordered = [...layouts].sort(
    (a, b) =>
      Number(!!b.is_active) - Number(!!a.is_active) ||
      Number(a.sort ?? 0) - Number(b.sort ?? 0) ||
      Number(a.id) - Number(b.id)
  )
  const isGrouped = (l: OverviewLayoutInput) => !l.layout_type || l.layout_type === 'grouped'
  // A/B test versions (#2614) never win resolution: listed after their original.
  const variants = liveVariants(
    ordered.filter(isGrouped) as unknown as Record<string, unknown>[]
  ) as unknown as Map<OverviewLayoutInput, { control_id: number; role_id: string }>
  const grouped = ordered.filter((l) => isGrouped(l) && !variants.has(l))

  // Phone (#2715) and tablet (#3183) versions never win on their own: listed
  // after their desktop form. `phoneRows` holds both kinds.
  const phoneRows = grouped.filter((l) => screenVersionOf(l.conditions) != null)
  const today = todayInInstance()
  const rulesOf = new Map<number, RecordConditionRule[]>()
  for (const l of grouped) {
    const rules = parseRecordConditions(l.record_conditions)
    if (rules) rulesOf.set(l.id, rules)
  }

  // Record-rule forms in pick order: most rules first, ties in candidate order.
  const ruleRows = grouped
    .filter((l) => rulesOf.has(l.id) && !phoneRows.includes(l))
    .map((l, i) => ({ l, i }))
    .sort(
      (a, b) => (rulesOf.get(b.l.id)?.length ?? 0) - (rulesOf.get(a.l.id)?.length ?? 0) || a.i - b.i
    )
    .map((x) => x.l)

  const pool = grouped.filter((l) => !rulesOf.has(l.id) && !phoneRows.includes(l))
  // What an admin (no role preference) gets: the active one, else the first.
  const defaultRow = pool.find((l) => !!l.is_active) ?? pool[0] ?? null
  // When the default is role-restricted, everyone outside its roles gets the
  // first unrestricted layout instead.
  const unrestricted = pool.filter((l) => roleIdsOf(l).length === 0)
  const fallbackRow =
    defaultRow && roleIdsOf(defaultRow).length > 0
      ? (unrestricted.find((l) => !!l.is_active) ?? unrestricted[0] ?? null)
      : null

  // Role-preference forms: more roles first (pickBestLayout prefers the longer list).
  const roleRows = pool
    .filter((l) => roleIdsOf(l).length > 0)
    .map((l, i) => ({ l, i }))
    .sort((a, b) => roleIdsOf(b.l).length - roleIdsOf(a.l).length || a.i - b.i)
    .map((x) => x.l)

  const rows: OverviewRow[] = []
  const base = (l: OverviewLayoutInput): Omit<OverviewRow, 'section' | 'reason'> => {
    const slug = l.slug ?? null
    let new_menu: OverviewRow['new_menu'] = null
    if (isGrouped(l)) {
      const label = l.create_label || l.name
      // use-new-item-layouts.ts: only layout_type 'grouped' (not legacy NULL)
      // joins the New menu, and then only with a slug and not create_hidden.
      new_menu = l.is_active
        ? { label, hidden: false }
        : { label, hidden: !(l.layout_type === 'grouped' && slug && !l.create_hidden) }
    }
    return {
      layout_id: Number(l.id),
      name: l.name,
      layout_type: l.layout_type ?? 'grouped',
      slug,
      is_default: !!l.is_active && l === defaultRow,
      new_menu,
      shape: shapeOf(l),
      references: refsByLayout.get(Number(l.id)) ?? [],
      warnings: [],
      ...(isGrouped(l) || l.layout_type === 'addendum' ? { rule_shape: ruleShapeOf(l) } : {}),
      ...resolveExtras(l)
    }
  }
  // Active dates, phone version, freeze (#2714 #2715 #2717) — only keys a form has.
  const resolveExtras = (l: OverviewLayoutInput): Partial<OverviewRow> => {
    const out: Partial<OverviewRow> = {}
    const win = activeWindowOf(l.conditions)
    const state = windowState(win, today)
    if (win && state) out.active_window = { ...win, state }
    if (isGrouped(l)) {
      const of = phoneOf(l.conditions)
      const tOf = tabletOf(l.conditions)
      if (of != null) out.phone_of = of
      else if (tOf != null) out.tablet_of = tOf
      else {
        const v = phoneRows.find((p) => phoneOf(p.conditions) === Number(l.id))
        if (v) out.phone_version = { layout_id: Number(v.id), name: v.name }
        const t = phoneRows.find((p) => tabletOf(p.conditions) === Number(l.id))
        if (t) out.tablet_version = { layout_id: Number(t.id), name: t.name }
      }
    }
    const f = activeFreeze(l.conditions, today)
    if (f) out.frozen = { until: f.until, reason: f.reason }
    return out
  }
  const windowWarning = (row: OverviewRow) => {
    const w = row.active_window
    if (!w || w.state === 'open') return
    row.warnings.push(
      w.state === 'before'
        ? `not in use yet: active ${windowWords(w)}`
        : `no longer in use: its active dates (${windowWords(w)}) have passed`
    )
  }
  const withRoles = (reason: PickReason, ids: string[]): PickReason =>
    ids.length ? { ...reason, role_ids: ids, role_names: roleNames(ids) } : reason

  // 1. Record-rule forms.
  ruleRows.forEach((l, idx) => {
    const rules = rulesOf.get(l.id) ?? []
    const row: OverviewRow = {
      ...base(l),
      section: 'forms',
      reason: withRoles({ kind: 'record_rule', rules }, roleIdsOf(l))
    }
    if (rules.length === 0) row.warnings.push('matches every saved record (its rule list is empty)')
    const shadow = ruleRows
      .slice(0, idx)
      .find(
        (b) =>
          (rulesOf.get(b.id) ?? []).every((r) => implied(r, rules)) &&
          rolesCover(roleIdsOf(b), roleIdsOf(l))
      )
    if (shadow) row.warnings.push(`never reached: shadowed by ${shadow.name}`)
    rows.push(row)
  })

  // 2. Role-preference forms (the default too, when it is role-restricted).
  roleRows.forEach((l, idx) => {
    const ids = roleIdsOf(l)
    const row: OverviewRow = {
      ...base(l),
      section: 'forms',
      reason: withRoles({ kind: 'role' }, ids)
    }
    // Every listed role is caught first by a form listing more roles (the
    // preference step compares role ids exactly). Admins still reach the default.
    const earlier = roleRows.slice(0, idx)
    const covered = ids.every((r) => earlier.some((b) => roleIdsOf(b).includes(r)))
    const shadow = earlier.find((b) => ids.some((r) => roleIdsOf(b).includes(r)))
    if (l !== defaultRow && covered && shadow) {
      row.warnings.push(`never reached: shadowed by ${shadow.name}`)
    }
    rows.push(row)
  })

  // 3. The default (unrestricted), then the fallback for roles the default excludes.
  if (defaultRow && roleIdsOf(defaultRow).length === 0) {
    rows.push({
      ...base(defaultRow),
      section: 'forms',
      reason: { kind: defaultRow.is_active ? 'default' : 'fallback' }
    })
  }
  if (fallbackRow)
    rows.push({ ...base(fallbackRow), section: 'forms', reason: { kind: 'fallback' } })

  // Tablet, then phone versions sit right after the form they stand in for.
  const screenOrder = [...phoneRows].sort(
    (a, b) => Number(phoneOf(b.conditions) != null) - Number(phoneOf(a.conditions) != null)
  )
  for (const p of screenOrder) {
    const of = screenVersionOf(p.conditions) as number
    const at = rows.findIndex((r) => r.layout_id === of)
    const desktop = grouped.find((l) => Number(l.id) === of)
    if (at < 0 || !desktop) continue
    rows.splice(at + 1, 0, {
      ...base(p),
      section: 'forms',
      reason:
        phoneOf(p.conditions) != null
          ? { kind: 'phone', phone_of: of, phone_of_name: desktop.name }
          : { kind: 'tablet', tablet_of: of, tablet_of_name: desktop.name }
    })
  }
  for (const r of rows) windowWarning(r)

  // 4. Grouped forms resolution never picks: reached by a link name or a reference.
  const placed = new Set(rows.map((r) => r.layout_id))
  const unreached = grouped.filter((l) => !placed.has(Number(l.id)))
  const unused: OverviewRow[] = []
  for (const l of unreached) {
    const b = base(l)
    if (l.slug) rows.push({ ...b, section: 'link_only', reason: { kind: 'slug' } })
    else if (b.references.length > 0)
      rows.push({
        ...b,
        section: 'link_only',
        reason: { kind: 'type_use', type_use: 'Opened from the places listed' }
      })
    else
      unused.push({
        ...b,
        section: 'unused',
        reason: { kind: 'type_use', type_use: 'Nothing opens it' }
      })
  }

  // 4b. A/B test versions, each right after the form it stands in for.
  for (const [l, t] of variants) {
    const control = ordered.find((c) => Number(c.id) === t.control_id)
    const row: OverviewRow = {
      ...base(l),
      section: 'forms',
      reason: {
        kind: 'ab',
        role_ids: [t.role_id],
        role_names: roleNames([t.role_id]),
        type_use: `A/B test: half of ${roleNames([t.role_id])[0]} get it instead of ${
          control ? `“${control.name}”` : 'its original'
        }`
      }
    }
    const at = rows.findIndex((r) => r.layout_id === t.control_id)
    if (at >= 0) rows.splice(at + 1, 0, row)
    else rows.push(row)
  }

  // 5. Other layout types, then 6. unused.
  for (const l of ordered.filter((x) => !isGrouped(x))) {
    rows.push({
      ...base(l),
      section: 'other_views',
      reason: { kind: 'type_use', type_use: typeUse(l) }
    })
  }
  rows.push(...unused)
  return rows
}
