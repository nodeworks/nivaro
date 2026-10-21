import {
  applyLayoutOps,
  GROUP_PATCH_KEYS,
  type GroupRow,
  HEADER_GROUP_KEY,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  type LayoutPatch,
  PLACEMENT_PATCH_KEYS,
  type PlacementRow,
  UNGROUPED_KEY
} from './layout-ops-apply.js'
import { parseConditions, parseRecordConditions, type RecordConditionRule } from './layout-patch.js'

/**
 * Merge two forms (#2661) — the pure half. One form is KEPT, the other is
 * FOLDED into it: what only the folded form has is added to the kept one,
 * the differences between the two become section rules (show-when rules on
 * record values, hidden-for-roles on roles), the kept form takes over who the
 * folded one opened for (record rules, roles, the default, its link name),
 * and the folded form stops being picked by anything. Both forms change
 * through the layout editor's own ops, so each gets a History entry.
 *
 * Fields are matched by name over each form's EFFECTIVE placements (its own,
 * then its parent's for fields it lacks), sections by key, else by label
 * under the same parent. Only grouped (record) forms merge.
 */

const SENTINEL_RE = /^__.+__$/
const isSentinel = (f: string) => SENTINEL_RE.test(f)
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export interface MergeSide {
  bundle: LayoutBundle
  parent: LayoutBundle | null
}

/** A show-when rule as the record form reads it (packages/shared visible-when.ts). */
export interface VisibleRule {
  field: string
  op: 'eq' | 'neq' | 'null' | 'nnull'
  value?: unknown
}

export interface MergeContext {
  /** What the record form resolves to for an admin (the default, else the first plain form). */
  defaultId: number | null
  /** Every role, for "hidden for every role but …" and for names. */
  roles: Array<{ id: string; name: string }>
  /** A field's label; the key in words when the collection has none. */
  label: (field: string) => string
  /** Every layout name of the collection (lower-cased), for the folded form's new name. */
  names: Set<string>
  /** The highest `sort` of the collection's layouts: the folded form goes after it. */
  maxSort: number
}

export type ReachKind = 'rules' | 'roles' | 'default' | 'link'

export interface Reach {
  kind: ReachKind
  rules: RecordConditionRule[] | null
  roles: string[]
  isDefault: boolean
  slug: string | null
}

export interface MergedAssignment {
  record_conditions: RecordConditionRule[] | null
  role_ids: string[]
  is_active: boolean
  slug: string | null
}

export interface MergePlan {
  keep_ops: LayoutOp[]
  fold_ops: LayoutOp[]
  /** What the kept form gains or how it is rearranged, in sentences. */
  changes: string[]
  /** Who opens the merged form, in sentences. */
  assignment: string[]
  /** What happens to the folded form. */
  retire: string[]
  /** What the merge cannot carry, or carries only approximately. */
  notes: string[]
  counts: {
    sections_added: number
    fields_added: number
    fields_moved: number
    rules_added: number
    differing: number
  }
  merged: MergedAssignment
  fold_name: string
}

// ── Effective view of one form ───────────────────────────────────────────────

interface View {
  name: string
  /** Effective groups by key (own, then the parent's keys it lacks); no Ungrouped pseudo group. */
  groups: Map<string, GroupRow>
  own: Set<string>
  /** field → its first placement (own over parent). */
  placements: Map<string, PlacementRow>
  ownPlacement: Set<string>
}

function viewOf(side: MergeSide): View {
  const groups = new Map<string, GroupRow>()
  const own = new Set<string>()
  for (const g of side.bundle.groups) {
    if (g.key === UNGROUPED_KEY) continue
    groups.set(g.key, g)
    own.add(g.key)
  }
  for (const g of side.parent?.groups ?? [])
    if (g.key !== UNGROUPED_KEY && !groups.has(g.key)) groups.set(g.key, g)
  const placements = new Map<string, PlacementRow>()
  const ownPlacement = new Set<string>()
  for (const p of side.bundle.placements)
    if (!placements.has(p.field)) {
      placements.set(p.field, p)
      ownPlacement.add(p.field)
    }
  for (const p of side.parent?.placements ?? [])
    if (!placements.has(p.field)) placements.set(p.field, p)
  return { name: String(side.bundle.layout.name ?? ''), groups, own, placements, ownPlacement }
}

const depthOf = (groups: Map<string, GroupRow>, g: GroupRow) => {
  let d = 0
  let cur: GroupRow | undefined = g
  while (cur?.parent_key && d < 10) {
    cur = groups.get(cur.parent_key)
    d++
  }
  return d
}

/** Groups parents first, each level in its stored order. */
function ordered(groups: Map<string, GroupRow>): GroupRow[] {
  return [...groups.values()].sort(
    (a, b) =>
      depthOf(groups, a) - depthOf(groups, b) || a.sort - b.sort || a.key.localeCompare(b.key)
  )
}

const normLabel = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

/** B section key → A section key: same key and type, else same label and type under the matched parent. */
export function matchGroups(a: View, b: View): Map<string, string> {
  const out = new Map<string, string>()
  const taken = new Set<string>()
  for (const g of ordered(b.groups)) {
    const parent = g.parent_key == null ? null : (out.get(g.parent_key) ?? undefined)
    const same = a.groups.get(g.key)
    if (same && same.type === g.type && !taken.has(same.key)) {
      out.set(g.key, same.key)
      taken.add(same.key)
      continue
    }
    // A parent that did not match: its children cannot match by label either.
    if (parent === undefined) continue
    const label = normLabel(g.label)
    if (!label) continue
    const hit = [...a.groups.values()].find(
      (x) =>
        !taken.has(x.key) &&
        x.type === g.type &&
        (x.parent_key ?? null) === parent &&
        normLabel(x.label) === label
    )
    if (hit) {
      out.set(g.key, hit.key)
      taken.add(hit.key)
    }
  }
  return out
}

// ── Who opens each form ──────────────────────────────────────────────────────

export function reachOf(bundle: LayoutBundle, defaultId: number | null): Reach {
  const l = bundle.layout
  const rules = parseRecordConditions(l.record_conditions)
  const ids = parseConditions(l.conditions)?.role_ids
  const roles = Array.isArray(ids) ? ids.map(String) : []
  const isDefault = !!l.is_active || Number(l.id) === defaultId
  const kind: ReachKind = rules ? 'rules' : roles.length ? 'roles' : isDefault ? 'default' : 'link'
  const slug = typeof l.slug === 'string' && l.slug ? l.slug : null
  return { kind, rules, roles, isDefault, slug }
}

const ruleKey = (r: { field: string; op: string; value?: unknown }) =>
  `${r.field}|${r.op}|${r.op === 'nnull' || r.op === 'null' ? '' : String(r.value)}`
const upper = (ids: string[]) => new Set(ids.map((r) => r.toUpperCase()))
const unionRoles = (a: string[], b: string[]) => {
  const seen = upper(a)
  return [...a, ...b.filter((r) => !seen.has(r.toUpperCase()))]
}

/**
 * The merged form's assignment. Record rules beat roles beat the default in
 * the pick (pickBestLayout); a form opened only by its link name is reached by
 * no rule at all. The union of two reaches is not always one assignment: when
 * it is not, the kept form keeps its own and a note says what moves.
 */
export function mergeAssignment(
  a: Reach,
  b: Reach,
  names: { a: string; b: string }
): { merged: MergedAssignment; notes: string[] } {
  const notes: string[] = []
  const slug = a.slug ?? b.slug
  const keepA = (): MergedAssignment => ({
    record_conditions: a.rules,
    role_ids: a.roles,
    is_active: a.isDefault,
    slug
  })
  if (b.kind === 'link') return { merged: keepA(), notes }
  if (a.kind === 'link')
    return {
      merged: { record_conditions: b.rules, role_ids: b.roles, is_active: b.isDefault, slug },
      notes
    }
  const roles = a.roles.length && b.roles.length ? unionRoles(a.roles, b.roles) : []
  if (a.kind === 'default' || b.kind === 'default') {
    const other = a.kind === 'default' ? b : a
    const otherName = a.kind === 'default' ? names.b : names.a
    if (other.kind === 'rules')
      notes.push(
        `${otherName}'s record rules are dropped: the merged form is the default, and a form with record rules that also matches one of those records would now open before it.`
      )
    return { merged: { record_conditions: null, role_ids: roles, is_active: true, slug }, notes }
  }
  if (a.kind === 'rules' && b.kind === 'rules') {
    const bKeys = new Set((b.rules ?? []).map(ruleKey))
    const common = (a.rules ?? []).filter((r) => bKeys.has(ruleKey(r)))
    if (common.length > 0 || (a.rules ?? []).length === 0 || (b.rules ?? []).length === 0)
      return {
        merged: { record_conditions: common, role_ids: roles, is_active: false, slug },
        notes:
          common.length < Math.max(a.rules?.length ?? 0, b.rules?.length ?? 0)
            ? [
                'The merged form keeps only the record rules both forms share, so it can open for records that matched neither form before: the record check below shows how many.'
              ]
            : []
      }
    notes.push(
      `The two forms' record rules have nothing in common, so the merged form keeps ${names.a}'s. Records ${names.b} opened for go to the next form that fits them.`
    )
    return { merged: keepA(), notes }
  }
  if (a.kind === 'roles' && b.kind === 'roles')
    return {
      merged: {
        record_conditions: null,
        role_ids: unionRoles(a.roles, b.roles),
        is_active: false,
        slug
      },
      notes
    }
  notes.push(
    `${names.a} is picked by ${a.kind === 'rules' ? 'record rules' : 'role'} and ${names.b} by ${b.kind === 'rules' ? 'record rules' : 'role'}: one form cannot be both, so the merged form keeps ${names.a}'s. Whoever ${names.b} opened for goes to the next form that fits.`
  )
  return { merged: keepA(), notes }
}

// ── The rule for what only one side has ─────────────────────────────────────

export interface SideRule {
  when: VisibleRule[]
  hide_roles: string[]
  /** "Type is “Services”" / "hidden for Viewer" — empty when no rule. */
  words: string[]
  /** Why the difference cannot become a rule, when it cannot. */
  gap: string | null
}

function negate(r: RecordConditionRule): VisibleRule | null {
  if (r.op === 'eq') return { field: r.field, op: 'neq', value: r.value }
  if (r.op === 'neq') return { field: r.field, op: 'eq', value: r.value }
  if (r.op === 'nnull') return { field: r.field, op: 'null' }
  return null
}

export function ruleWords(r: VisibleRule, label: (f: string) => string): string {
  const name = label(r.field)
  const v = `“${String(r.value ?? '')}”`
  switch (r.op) {
    case 'eq':
      return `${name} is ${v}`
    case 'neq':
      return `${name} is not ${v}`
    case 'nnull':
      return `${name} is filled in`
    default:
      return `${name} is empty`
  }
}

/**
 * Who used to get side X, within the merged form's reach: X's own record rules
 * the merged form does not already require; else the other side's dropped rule
 * turned around (one rule only); X's roles as "hidden for every other role".
 */
export function sideRule(
  x: Reach,
  y: Reach,
  m: MergedAssignment,
  ctx: { xName: string; yName: string; roles: Array<{ id: string; name: string }> },
  label: (f: string) => string
): SideRule {
  const when: VisibleRule[] = []
  let hide: string[] = []
  let gap: string | null = null
  const mKeys = new Set((m.record_conditions ?? []).map(ruleKey))
  if (x.rules) {
    for (const r of x.rules)
      if (!mKeys.has(ruleKey(r)))
        when.push(r.op === 'nnull' ? { field: r.field, op: 'nnull' } : { ...r })
  } else if (y.rules) {
    const dropped = y.rules.filter((r) => !mKeys.has(ruleKey(r)))
    if (dropped.length === 1) {
      const n = negate(dropped[0])
      if (n) when.push(n)
    } else if (dropped.length > 1)
      gap = `${ctx.yName} is picked by ${dropped.length} record rules together, which cannot be turned around into one rule`
  }
  const mRoles = upper(m.role_ids)
  if (x.roles.length) {
    const universe = m.role_ids.length ? m.role_ids : ctx.roles.map((r) => r.id)
    const mine = upper(x.roles)
    hide = universe.filter((r) => !mine.has(r.toUpperCase()))
  } else if (y.roles.length && !y.rules && mRoles.size === 0) hide = [...y.roles]
  if (x.kind === 'link' && y.kind !== 'link')
    gap = `${ctx.xName} is opened only by its link name, which a rule cannot tell apart`
  const roleName = new Map(ctx.roles.map((r) => [r.id.toUpperCase(), r.name]))
  const words = when.map((r) => ruleWords(r, label))
  if (hide.length)
    words.push(
      `hidden for ${hide
        .map((r) => roleName.get(r.toUpperCase()) ?? r)
        .slice(0, 4)
        .join(', ')}${hide.length > 4 ? ` and ${hide.length - 4} more roles` : ''}`
    )
  // The other form opened only by its link: X was everyone's form, so its extras rightly show to all.
  if (!when.length && !hide.length && !gap && x.kind !== y.kind && y.kind !== 'link')
    gap = `nothing tells ${ctx.xName}'s records apart from ${ctx.yName}'s`
  return { when, hide_roles: hide, words, gap }
}

const hasRule = (r: SideRule) => r.when.length > 0 || r.hide_roles.length > 0

function parseList(raw: unknown): unknown[] {
  if (raw == null || raw === '') return []
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** A group's rules with the side rule added (AND for show-when, union for roles). */
function withRule(g: Pick<GroupRow, 'visible_when' | 'hidden_for_roles'>, rule: SideRule) {
  const patch: { visible_when?: string; hidden_for_roles?: string } = {}
  if (rule.when.length) {
    const cur = parseList(g.visible_when) as VisibleRule[]
    const keys = new Set(cur.map((r) => ruleKey(r)))
    patch.visible_when = JSON.stringify([...cur, ...rule.when.filter((r) => !keys.has(ruleKey(r)))])
  }
  if (rule.hide_roles.length) {
    const cur = parseList(g.hidden_for_roles).map(String)
    patch.hidden_for_roles = JSON.stringify(unionRoles(cur, rule.hide_roles))
  }
  return patch
}

// ── The plan ─────────────────────────────────────────────────────────────────

function groupPatchOf(g: GroupRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of GROUP_PATCH_KEYS) {
    if (k === 'label' || k === 'type') continue
    const v = (g as unknown as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

function placementPatchOf(p: PlacementRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of PLACEMENT_PATCH_KEYS) {
    const v = (p as unknown as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

const sameSetup = (x: PlacementRow, y: PlacementRow) =>
  JSON.stringify(placementPatchOf(x)) === JSON.stringify(placementPatchOf(y))

const keyBase = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'section'

const listOf = (items: string[], max = 4) =>
  items.length > max
    ? `${items.slice(0, max).join(', ')} and ${items.length - max} more`
    : items.join(', ')

function retiredName(name: string, keepName: string, names: Set<string>): string {
  const base = truncate(`${name} (merged into ${keepName})`, 110)
  if (!names.has(base.toLowerCase())) return base
  for (let i = 2; i < 100; i++) {
    const n = `${base} ${i}`
    if (!names.has(n.toLowerCase())) return n
  }
  return `${base} ${Date.now()}`
}

/** Keys of g and every group under it. */
function subtree(V: View, key: string): Set<string> {
  const keys = new Set([key])
  let grew = true
  while (grew) {
    grew = false
    for (const g of V.groups.values())
      if (g.parent_key && keys.has(g.parent_key) && !keys.has(g.key)) {
        keys.add(g.key)
        grew = true
      }
  }
  return keys
}

/**
 * Plan the merge of `fold` into `keep`. Pure: the caller loads both sides,
 * their parents and the context. Every op is applied to a working copy of the
 * kept form as it is planned, so a plan the ops cannot carry throws here
 * (LayoutOpError), never half-way through the write.
 */
export function planMerge(keep: MergeSide, fold: MergeSide, ctx: MergeContext): MergePlan {
  const A = viewOf(keep)
  const B = viewOf(fold)
  const L = ctx.label
  const fieldName = (f: string) =>
    isSentinel(f) ? f.replace(/^__|__$/g, '').replace(/_/g, ' ') : L(f)
  const reachA = reachOf(keep.bundle, ctx.defaultId)
  const reachB = reachOf(fold.bundle, ctx.defaultId)
  const { merged, notes } = mergeAssignment(reachA, reachB, { a: A.name, b: B.name })
  const ruleB = sideRule(
    reachB,
    reachA,
    merged,
    { xName: B.name, yName: A.name, roles: ctx.roles },
    L
  )
  const ruleA = sideRule(
    reachA,
    reachB,
    merged,
    { xName: A.name, yName: B.name, roles: ctx.roles },
    L
  )
  const describe = (r: SideRule) => r.words.join(' and ')

  const changes: string[] = []
  const counts = {
    sections_added: 0,
    fields_added: 0,
    fields_moved: 0,
    rules_added: 0,
    differing: 0
  }
  const ops: LayoutOp[] = []
  let work: LayoutBundle = keep.bundle
  const push = (op: LayoutOp) => {
    work = applyLayoutOps(work, [op])
    ops.push(op)
  }
  const usedKeys = new Set([
    ...A.groups.keys(),
    ...(keep.parent?.groups ?? []).map((g) => g.key),
    UNGROUPED_KEY
  ])
  const freshKey = (base: string) => {
    let k = keyBase(base)
    if (/^\d/.test(k)) k = `s_${k}`
    let n = k
    for (let i = 2; usedKeys.has(n); i++) n = `${k}_${i}`
    usedKeys.add(n)
    return n
  }
  /** The index right after `anchor` among its siblings on the working copy (renumbered: sort = index). */
  const afterIndex = (anchor: string | null, parent: string | null) => {
    if (anchor == null) return 100_000
    const g = work.groups.find(
      (x) => x.key === anchor && (anchor === UNGROUPED_KEY || (x.parent_key ?? null) === parent)
    )
    return g ? g.sort + 1 : 100_000
  }
  const fieldIndexAfter = (groupKey: string | null, prevField: string | null) => {
    if (prevField == null) return 0
    const p = work.placements.find((x) => x.field === prevField && x.group_key === groupKey)
    return p ? p.sort + 1 : 100_000
  }
  const onA = (field: string) => A.placements.has(field)
  const onB = (field: string) => B.placements.has(field)
  const match = matchGroups(A, B)
  const matchedA = new Set(match.values())

  // ── 1. The folded form's sections and fields onto the kept form ──
  const bOrder = ordered(B.groups)
  const bOnly = (key: string) =>
    [...B.placements.values()].some((p) => p.group_key === key && !onA(p.field) && !isCanvasSlot(p))
  const willCreateMemo = new Map<string, boolean>()
  const willCreate = (g: GroupRow): boolean => {
    const hit = willCreateMemo.get(g.key)
    if (hit !== undefined) return hit
    willCreateMemo.set(g.key, false)
    const yes =
      !match.has(g.key) &&
      (g.type === 'content' ||
        bOnly(g.key) ||
        bOrder.some((c) => c.parent_key === g.key && willCreate(c)))
    willCreateMemo.set(g.key, yes)
    return yes
  }
  const created = new Map<string, string>() // B key → new key on the kept form
  const covered = new Set<string>() // new keys the rule already reaches (own or an ancestor's)
  const mapB = (key: string) => match.get(key) ?? created.get(key) ?? null
  const siblingsB = (parent: string | null) =>
    bOrder.filter((g) => (g.parent_key ?? null) === parent).sort((x, y) => x.sort - y.sort)

  const ruledNew: string[] = []
  for (const g of bOrder) {
    if (!willCreate(g)) {
      if (!match.has(g.key) && g.type !== 'container') {
        const under = [...subtree(B, g.key)]
        if (under.length === 1 && [...B.placements.values()].some((p) => p.group_key === g.key))
          changes.push(
            `“${g.label || g.key}” is not added: every field in it is already on ${A.name}`
          )
      }
      continue
    }
    const parentB = g.parent_key ?? null
    const parentA = parentB == null ? null : mapB(parentB)
    if (parentB != null && parentA == null) continue
    const sibs = siblingsB(parentB)
    const at = sibs.indexOf(g)
    let anchor: string | null = null
    for (let i = at - 1; i >= 0 && !anchor; i--) anchor = mapB(sibs[i].key)
    const index = anchor ? afterIndex(anchor, parentA) : at <= 0 ? 0 : 100_000
    const key = freshKey(g.key)
    const patch = groupPatchOf(g)
    if (parentA != null && covered.has(parentA)) covered.add(key)
    // A container's rule goes on its tabs: the record form reads show-when rules on tabs and sections.
    else if (hasRule(ruleB) && g.type !== 'container') {
      Object.assign(patch, withRule(g, ruleB))
      covered.add(key)
      counts.rules_added++
    }
    push({
      op: 'group_create',
      key,
      label: g.label,
      group_type: g.type,
      parent_key: parentA,
      index,
      patch: patch as never
    })
    created.set(g.key, key)
    counts.sections_added++
    const what = g.type === 'tab' ? 'tab' : g.type === 'content' ? 'text block' : 'section'
    if (covered.has(key) && !(parentA != null && covered.has(parentA)))
      ruledNew.push(g.label || g.key)
    changes.push(`Adds the ${what} “${g.label || g.key}” from ${B.name}`)
  }
  if (ruledNew.length)
    changes.push(
      `${ruledNew.length === 1 ? `“${ruledNew[0]}” is` : `These ${ruledNew.length} are`} shown when ${describe(ruleB)}`
    )

  // Fields the folded form has and the kept one lacks, zone by zone in the folded form's order.
  const createdKeys = new Set(created.values())
  const splitFor = new Map<string, string>() // host key (or Ungrouped) → section for B's extras
  const addedTo = new Map<string | null, string[]>()
  const skippedSlots: string[] = []
  const skippedHeader: string[] = []
  const bZones = new Map<string | null, PlacementRow[]>()
  for (const p of [...B.placements.values()].sort((x, y) => x.sort - y.sort)) {
    const list = bZones.get(p.group_key) ?? []
    list.push(p)
    bZones.set(p.group_key, list)
  }
  for (const [zone, rows] of bZones) {
    let prev: string | null = null
    for (const p of rows) {
      if (onA(p.field)) {
        prev = p.field
        continue
      }
      if (zone === HEADER_GROUP_KEY) {
        if (hasRule(ruleB)) {
          skippedHeader.push(fieldName(p.field))
          continue
        }
        push({
          op: 'place',
          field: p.field,
          group_key: HEADER_GROUP_KEY,
          index: fieldIndexAfter(HEADER_GROUP_KEY, prev),
          patch: placementPatchOf(p) as never
        })
        prev = p.field
        counts.fields_added++
        addedTo.set(HEADER_GROUP_KEY, [
          ...(addedTo.get(HEADER_GROUP_KEY) ?? []),
          fieldName(p.field)
        ])
        continue
      }
      if (isCanvasSlot(p)) {
        if (hasRule(ruleB)) {
          skippedSlots.push(fieldName(p.field))
          continue
        }
        push({
          op: 'place',
          field: p.field,
          group_key: null,
          index: 100_000,
          patch: placementPatchOf(p) as never
        })
        counts.fields_added++
        changes.push(`Adds the ${fieldName(p.field)} card from ${B.name}`)
        continue
      }
      const target = zone == null ? null : mapB(zone)
      if (zone != null && target == null) continue // its section was not carried
      let groupKey = target
      if (!(target != null && createdKeys.has(target)) && hasRule(ruleB)) {
        // A section both forms have: the extras go in a section of their own beside it.
        const host = target ?? UNGROUPED_KEY
        let split = splitFor.get(host)
        if (!split) {
          const hostRow = target == null ? null : work.groups.find((g) => g.key === target)
          const parent = hostRow?.parent_key ?? null
          split = freshKey(`${target ?? 'fields'}_${B.name}`)
          push({
            op: 'group_create',
            key: split,
            label: truncate(`${hostRow?.label || 'Fields'} (${B.name})`, 120),
            group_type: hostRow?.type === 'tab' ? 'tab' : 'section',
            parent_key: parent,
            index: afterIndex(host, parent),
            patch: withRule({ visible_when: null, hidden_for_roles: null }, ruleB) as never
          })
          splitFor.set(host, split)
          counts.sections_added++
          counts.rules_added++
        }
        groupKey = split
      }
      push({
        op: 'place',
        field: p.field,
        group_key: groupKey,
        index: groupKey === target ? fieldIndexAfter(groupKey, prev) : 100_000,
        patch: placementPatchOf(p) as never
      })
      if (groupKey === target) prev = p.field
      counts.fields_added++
      if (groupKey == null || !createdKeys.has(groupKey))
        addedTo.set(groupKey, [...(addedTo.get(groupKey) ?? []), fieldName(p.field)])
    }
  }
  const splitKeys = new Set(splitFor.values())
  for (const [where, fields] of addedTo) {
    const g = where == null ? null : work.groups.find((x) => x.key === where)
    if (where != null && splitKeys.has(where))
      changes.push(
        `Adds ${listOf(fields)} from ${B.name} in a new ${g?.type === 'tab' ? 'tab' : 'section'} “${g?.label}”, shown when ${describe(ruleB)}`
      )
    else
      changes.push(
        `Adds ${listOf(fields)} from ${B.name} to ${where == null ? 'the fields outside any section' : where === HEADER_GROUP_KEY ? 'the header' : `“${g?.label || where}”`}`
      )
  }

  // ── 2. What only the kept form has: shown only to whoever used to get it ──
  const aOnlyFields = [...A.placements.values()].filter(
    (p) => !onB(p.field) && !isSentinel(p.field) && p.group_key !== HEADER_GROUP_KEY
  )
  if (hasRule(ruleA) && aOnlyFields.length) {
    const ruledA = new Set<string>()
    const inherited: string[] = []
    const underRuled = (key: string | null) => {
      let cur = key ? A.groups.get(key) : undefined
      for (let i = 0; cur && i < 10; i++) {
        if (ruledA.has(cur.key)) return true
        cur = cur.parent_key ? A.groups.get(cur.parent_key) : undefined
      }
      return false
    }
    for (const g of ordered(A.groups)) {
      if (matchedA.has(g.key) || underRuled(g.key)) continue
      const keys = subtree(A, g.key)
      if ([...keys].some((k) => matchedA.has(k))) continue
      const fields = [...A.placements.values()].filter(
        (p) => p.group_key != null && keys.has(p.group_key)
      )
      if (g.type !== 'content' && fields.length === 0) continue
      if (fields.some((p) => onB(p.field))) continue
      if (g.type === 'container') continue // its tabs take the rule
      if (!A.own.has(g.key)) {
        inherited.push(g.label || g.key)
        continue
      }
      const row = work.groups.find((x) => x.key === g.key)
      if (!row) continue
      push({ op: 'group_update', key: g.key, patch: withRule(row, ruleA) as never })
      ruledA.add(g.key)
      counts.rules_added++
      changes.push(
        `The ${g.type === 'tab' ? 'tab' : 'section'} “${g.label || g.key}” is only on ${A.name}: shown when ${describe(ruleA)}`
      )
    }
    const splitA = new Map<string, string>()
    const moved: string[] = []
    for (const p of aOnlyFields.sort((x, y) => x.sort - y.sort)) {
      if (isCanvasSlot(p) || underRuled(p.group_key)) continue
      if (!A.ownPlacement.has(p.field)) {
        inherited.push(fieldName(p.field))
        continue
      }
      const hostRow = p.group_key == null ? null : work.groups.find((g) => g.key === p.group_key)
      if (p.group_key != null && !hostRow) continue
      const host = p.group_key ?? UNGROUPED_KEY
      let split = splitA.get(host)
      if (!split) {
        const parent = hostRow?.parent_key ?? null
        split = freshKey(`${p.group_key ?? 'fields'}_${A.name}`)
        push({
          op: 'group_create',
          key: split,
          label: truncate(`${hostRow?.label || 'Fields'} (${A.name})`, 120),
          group_type: hostRow?.type === 'tab' ? 'tab' : 'section',
          parent_key: parent,
          index: afterIndex(host, parent),
          patch: withRule({ visible_when: null, hidden_for_roles: null }, ruleA) as never
        })
        splitA.set(host, split)
        counts.sections_added++
        counts.rules_added++
      }
      push({
        op: 'move',
        from: { field: p.field, group_key: p.group_key },
        to_group_key: split,
        index: 100_000
      })
      counts.fields_moved++
      moved.push(fieldName(p.field))
    }
    if (moved.length)
      changes.push(
        `Moves ${listOf(moved)} (only on ${A.name}) into ${splitA.size === 1 ? 'a section' : 'sections'} of their own, shown when ${describe(ruleA)}`
      )
    if (inherited.length)
      notes.push(
        `${listOf(inherited)} ${inherited.length === 1 ? 'comes' : 'come'} from ${A.name}'s parent form and ${inherited.length === 1 ? 'stays' : 'stay'} shown to every record: change ${inherited.length === 1 ? 'it' : 'them'} on the parent.`
      )
  } else if (aOnlyFields.length && ruleA.gap)
    notes.push(
      `What only ${A.name} has stays shown to every record that opens the merged form: ${ruleA.gap}.`
    )
  if (!hasRule(ruleB) && ruleB.gap && counts.fields_added + counts.sections_added > 0)
    notes.push(
      `What ${B.name} adds is shown to every record that opens the merged form: ${ruleB.gap}.`
    )

  // Placed on both but set up differently: the kept form's setup stays.
  const differing: string[] = []
  for (const [field, pa] of A.placements) {
    const pb = B.placements.get(field)
    if (pb && !isSentinel(field) && !sameSetup(pa, pb)) differing.push(fieldName(field))
  }
  counts.differing = differing.length
  if (differing.length)
    notes.push(
      `${differing.length === 1 ? '1 field is' : `${differing.length} fields are`} set up differently on the two forms (${listOf(differing)}): ${A.name}'s setup is kept.`
    )
  if (skippedSlots.length)
    notes.push(
      `${listOf(skippedSlots)}: ${skippedSlots.length === 1 ? 'a card' : 'cards'} only ${B.name} has, not added because page cards cannot take a rule. Add ${skippedSlots.length === 1 ? 'it' : 'them'} in the editor if wanted.`
    )
  if (skippedHeader.length)
    notes.push(
      `${listOf(skippedHeader)} in ${B.name}'s header ${skippedHeader.length === 1 ? 'is' : 'are'} not added: the header cannot take a rule.`
    )

  // ── 3. The kept form takes over who the folded form opened for ──
  const assignment: string[] = []
  const layoutPatch: LayoutPatch = {}
  if (JSON.stringify(reachA.rules ?? null) !== JSON.stringify(merged.record_conditions ?? null))
    layoutPatch.record_conditions = merged.record_conditions
  if (JSON.stringify(reachA.roles) !== JSON.stringify(merged.role_ids))
    layoutPatch.conditions = merged.role_ids.length ? { role_ids: merged.role_ids } : null
  if (merged.is_active && !keep.bundle.layout.is_active) layoutPatch.is_active = true
  const slugMoves = !reachA.slug && !!reachB.slug
  if (slugMoves) layoutPatch.slug = reachB.slug
  if (Object.keys(layoutPatch).length) push({ op: 'layout_update', patch: layoutPatch })

  const roleName = new Map(ctx.roles.map((r) => [r.id.toUpperCase(), r.name]))
  const rules = merged.record_conditions
  if (rules?.length)
    assignment.push(
      `Opens for records where ${rules.map((r) => ruleWords(r as VisibleRule, L)).join(' and ')}`
    )
  else if (rules) assignment.push('Opens for every saved record no form with more rules takes')
  if (merged.role_ids.length)
    assignment.push(
      `For ${merged.role_ids.map((r) => roleName.get(r.toUpperCase()) ?? r).join(', ')} only`
    )
  if (merged.is_active) assignment.push('The default form of this collection')
  if (!rules && !merged.role_ids.length && !merged.is_active)
    assignment.push(
      merged.slug
        ? `Opened by its link name “${merged.slug}”`
        : 'Opened only from the places that link to it'
    )
  if (slugMoves)
    assignment.push(
      `Takes over ${B.name}'s link name “${reachB.slug}”, so links to it open the merged form`
    )
  else if (reachA.slug && reachB.slug)
    notes.push(
      `Both forms have a link name: links to “${reachB.slug}” keep opening ${B.name} as it is now. Point them at “${reachA.slug}” to use the merged form.`
    )

  // ── 4. The folded form: kept as it is (History, child forms, links by id), picked by nothing ──
  const foldName = retiredName(B.name, A.name, ctx.names)
  const foldPatch: LayoutPatch = { name: foldName, sort: ctx.maxSort + 1 }
  if (reachB.rules) foldPatch.record_conditions = null
  if (reachB.roles.length) foldPatch.conditions = null
  if (fold.bundle.layout.is_active) foldPatch.is_active = false
  if (slugMoves) foldPatch.slug = null
  const fold_ops: LayoutOp[] = [{ op: 'layout_update', patch: foldPatch }]
  applyLayoutOps(fold.bundle, fold_ops)
  const retire = [
    `${B.name} is renamed “${foldName}” and no form pick chooses it any more${reachB.slug && !slugMoves ? ` (links to “${reachB.slug}” still open it)` : ''}`,
    'Its sections and fields stay as they are, so a place that opens it by id keeps working, and History can put it back'
  ]

  return {
    keep_ops: ops,
    fold_ops,
    changes,
    assignment,
    retire,
    notes,
    counts,
    merged,
    fold_name: foldName
  }
}
