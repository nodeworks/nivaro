import {
  type PickReason,
  parseConditions,
  parseRecordConditions,
  type RecordConditionRule
} from '../routes/collection-layouts.js'

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
  const grouped = ordered.filter(isGrouped)

  const rulesOf = new Map<number, RecordConditionRule[]>()
  for (const l of grouped) {
    const rules = parseRecordConditions(l.record_conditions)
    if (rules) rulesOf.set(l.id, rules)
  }

  // Record-rule forms in pick order: most rules first, ties in candidate order.
  const ruleRows = grouped
    .filter((l) => rulesOf.has(l.id))
    .map((l, i) => ({ l, i }))
    .sort(
      (a, b) => (rulesOf.get(b.l.id)?.length ?? 0) - (rulesOf.get(a.l.id)?.length ?? 0) || a.i - b.i
    )
    .map((x) => x.l)

  const pool = grouped.filter((l) => !rulesOf.has(l.id))
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
      warnings: []
    }
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
