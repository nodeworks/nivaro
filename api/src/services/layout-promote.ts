import {
  applyLayoutOps,
  GROUP_PATCH_KEYS,
  type GroupRow,
  isCanvasSlot,
  LAYOUT_PATCH_KEYS,
  type LayoutBundle,
  type LayoutOp,
  LayoutOpError,
  PLACEMENT_PATCH_KEYS,
  type PlacementRow,
  UNGROUPED_KEY
} from './layout-ops-apply.js'

/**
 * Promote one layout between environments (#2593) — the pure half.
 *
 * `planLayoutPromotion(mine, theirs)` answers "what would make this layout
 * look like the other environment's copy" as a list of plain-word changes and
 * the layout ops that make them, so applying goes through the editor's own
 * save path (runLayoutOps: atomic, versioned, rev-checked). Matching is by
 * group key and by (field, group key) — ids differ between environments.
 *
 * Kept as they are here: which layout is the default (is_active) and the
 * layout's place in the list (sort) — both are this environment's decisions.
 * Settings the caller says cannot be carried (a referenced template or layout
 * missing here, a name another layout here already has) are listed as skipped.
 */

export const PROMOTE_KEPT_KEYS = ['is_active', 'sort'] as const

/** Settings that point at another row by id: carried only when that row exists here. */
export const PROMOTE_REFERENCE_KEYS = [
  'parent_layout_id',
  'addendum_layout_id',
  'pdf_template_id',
  'workflow_template_id'
] as const

export type PromoteChangeKind = 'setting' | 'section' | 'field' | 'order'

export interface PromoteChange {
  kind: PromoteChangeKind
  action: 'add' | 'remove' | 'change' | 'skip'
  /** What it is: a setting key, a group key or a field name. */
  target: string
  /** Where (a field's group), when it matters. */
  where?: string | null
  /** Plain words. */
  text: string
  from?: unknown
  to?: unknown
}

export interface PromotePlan {
  ops: LayoutOp[]
  changes: PromoteChange[]
  /** Applying the ops to `mine` gives exactly `theirs` (minus kept / skipped settings). */
  exact: boolean
}

/** Booleans stored as bits, empty strings and JSON text compare by meaning. */
export function normValue(v: unknown): unknown {
  if (v === undefined || v === '') return null
  if (typeof v === 'string') {
    const t = v.trim()
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return normValue(JSON.parse(t))
      } catch {
        return v
      }
    }
    return v
  }
  if (Array.isArray(v)) return v.map(normValue)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as object).sort())
      out[k] = normValue((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

const BOOL_LAYOUT_KEYS = new Set([
  'create_hidden',
  'is_active',
  'disable_comments',
  'disable_tasks',
  'validate_before_next',
  'summary_enabled',
  'summary_hide_empty',
  'ai_enabled',
  'accordion_mode',
  'disable_revisions',
  'disable_clone',
  'disable_delete',
  'pdf_cover_enabled',
  'pdf_show_logo',
  'allow_schedule',
  'allow_disable_pickers',
  'single_active_addendum',
  'addendum_default_view',
  'hide_integrity_banner',
  'hide_sla_banner',
  'changes_tray',
  'dossier_enabled',
  'hide_empty'
])

function layoutValue(key: string, v: unknown): unknown {
  if (BOOL_LAYOUT_KEYS.has(key)) return v === true || v === 1 || v === '1' || v === 'true'
  return normValue(v)
}

export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(normValue(a)) === JSON.stringify(normValue(b))

const fieldKey = (p: { field: string; group_key: string | null }) =>
  `${p.field}\u0000${p.group_key ?? ''}`

const groupName = (g: GroupRow | undefined, key: string | null) =>
  key == null ? 'Ungrouped' : g?.label ? `“${g.label}”` : key

/** Members of one container in their order (after renumbering every sort is unique). */
function topMembers(b: LayoutBundle, parentKey: string | null): string[] {
  const rows: Array<{ k: string; s: number }> = b.groups
    .filter((g) => g.parent_key === parentKey)
    .map((g) => ({ k: `g:${g.key}`, s: g.sort }))
  if (parentKey === null)
    for (const p of b.placements) if (isCanvasSlot(p)) rows.push({ k: `s:${p.field}`, s: p.sort })
  return rows.sort((a, c) => a.s - c.s).map((r) => r.k)
}

function zoneOrder(b: LayoutBundle, groupKey: string | null): string[] {
  return b.placements
    .filter((p) => p.group_key === groupKey && !isCanvasSlot(p))
    .sort((a, c) => a.sort - c.sort)
    .map((p) => p.field)
}

/** Every sort renumbered 0..n-1 per container, exactly as the record page reads the order. */
export function normalizeBundle(b: LayoutBundle): LayoutBundle {
  // applyLayoutOps renumbers after each op, not for an empty list: an empty
  // settings op is the one that changes nothing and still renumbers.
  return applyLayoutOps(b, [{ op: 'layout_update', patch: {} }])
}

/**
 * The ops (and plain-word changes) that turn `mine` into `theirs`.
 * `skip` names layout settings not to carry, with the reason shown.
 */
export function planLayoutPromotion(
  mineIn: LayoutBundle,
  theirsIn: LayoutBundle,
  skip: Record<string, string> = {}
): PromotePlan {
  const theirs = normalizeBundle(theirsIn)
  let cur = normalizeBundle(mineIn)
  const ops: LayoutOp[] = []
  const changes: PromoteChange[] = []
  // One op at a time on a working copy: each next op is planned against the
  // state the previous ones leave. An op the rules refuse is listed, not fatal.
  const push = (op: LayoutOp): boolean => {
    try {
      cur = applyLayoutOps(cur, [op])
    } catch (err) {
      if (!(err instanceof LayoutOpError)) throw err
      changes.push({
        kind: 'order',
        action: 'skip',
        target: op.op,
        text: `Not carried: ${err.message}`
      })
      return false
    }
    ops.push(op)
    return true
  }

  // 1. Settings first: the layout's kind decides where fields may go (table forms).
  const patch: Record<string, unknown> = {}
  for (const key of LAYOUT_PATCH_KEYS) {
    if ((PROMOTE_KEPT_KEYS as readonly string[]).includes(key)) continue
    if (!(key in theirs.layout)) continue
    const from = cur.layout[key]
    const to = theirs.layout[key]
    if (JSON.stringify(layoutValue(key, from)) === JSON.stringify(layoutValue(key, to))) continue
    if (skip[key]) {
      changes.push({ kind: 'setting', action: 'skip', target: key, text: skip[key], from, to })
      continue
    }
    patch[key] = to === undefined ? null : to
    changes.push({ kind: 'setting', action: 'change', target: key, text: key, from, to })
  }
  if (Object.keys(patch).length) push({ op: 'layout_update', patch: patch as never })

  const theirGroups = new Map(
    theirs.groups.filter((g) => g.key !== UNGROUPED_KEY).map((g) => [g.key, g])
  )
  const theirPlacements = new Map(theirs.placements.map((p) => [fieldKey(p), p]))

  // 2. Placements that are not there: removed first, so a section can change kind.
  for (const p of [...cur.placements]) {
    if (theirPlacements.has(fieldKey(p))) continue
    push({ op: 'remove', at: { field: p.field, group_key: p.group_key } })
    const g = cur.groups.find((x) => x.key === p.group_key)
    changes.push({
      kind: 'field',
      action: 'remove',
      target: p.field,
      where: p.group_key,
      text: `Remove ${p.field} from ${groupName(g, p.group_key)}`
    })
  }

  // 3. Sections that are not there.
  for (const g of [...cur.groups]) {
    if (g.key === UNGROUPED_KEY || theirGroups.has(g.key)) continue
    if (!cur.groups.some((x) => x.key === g.key)) continue
    push({ op: 'group_remove', key: g.key, placements: 'delete' })
    changes.push({
      kind: 'section',
      action: 'remove',
      target: g.key,
      text: `Remove ${g.type === 'tab' ? 'tab' : 'section'} “${g.label}”`
    })
  }

  // 4. Sections whose parent differs go to the top level first (always allowed),
  //    then take the other copy's settings (kind included), then new ones are made.
  for (const g of cur.groups) {
    const t = theirGroups.get(g.key)
    if (t && (t.parent_key ?? null) !== (g.parent_key ?? null) && g.parent_key !== null)
      push({ op: 'group_move', key: g.key, parent_key: null, index: 9999 })
  }
  for (const g of [...cur.groups]) {
    const t = theirGroups.get(g.key)
    if (!t) continue
    const gp: Record<string, unknown> = {}
    for (const k of GROUP_PATCH_KEYS) if (!sameValue(g[k], t[k])) gp[k] = t[k]
    if (!Object.keys(gp).length) continue
    if (!push({ op: 'group_update', key: g.key, patch: gp as never })) continue
    changes.push({
      kind: 'section',
      action: 'change',
      target: g.key,
      text: `Change ${Object.keys(gp).join(', ')} of “${t.label}”`
    })
  }
  const depth = (g: GroupRow): number => {
    let d = 0
    let p = g.parent_key
    while (p && d < 10) {
      d++
      p = theirGroups.get(p)?.parent_key ?? null
    }
    return d
  }
  const missing = [...theirGroups.values()]
    .filter((t) => !t.key.startsWith('__') && !cur.groups.some((g) => g.key === t.key))
    .sort((a, b) => depth(a) - depth(b) || a.sort - b.sort)
  for (const t of missing) {
    const gp: Record<string, unknown> = {}
    for (const k of GROUP_PATCH_KEYS) if (k !== 'label' && k !== 'type') gp[k] = t[k]
    const parentHere = t.parent_key && cur.groups.some((g) => g.key === t.parent_key)
    const made = push({
      op: 'group_create',
      key: t.key,
      label: t.label,
      group_type: t.type,
      parent_key: parentHere ? t.parent_key : null,
      index: 9999,
      patch: gp as never
    })
    if (!made) continue
    changes.push({
      kind: 'section',
      action: 'add',
      target: t.key,
      text: `Add ${t.type === 'tab' ? 'tab' : t.type === 'content' ? 'text block' : 'section'} “${t.label}”`
    })
  }

  // 5. Placements: new ones, then settings of the ones both copies have.
  for (const t of theirs.placements) {
    const here = cur.placements.find((p) => fieldKey(p) === fieldKey(t))
    const tg = theirGroups.get(t.group_key ?? '')
    if (!here) {
      const pp: Record<string, unknown> = {}
      for (const k of PLACEMENT_PATCH_KEYS) pp[k] = t[k]
      if (
        !push({
          op: 'place',
          field: t.field,
          group_key: t.group_key,
          index: 9999,
          patch: pp as never
        })
      )
        continue
      changes.push({
        kind: 'field',
        action: 'add',
        target: t.field,
        where: t.group_key,
        text: `Add ${t.field} to ${groupName(tg, t.group_key)}`
      })
      continue
    }
    const pp: Record<string, unknown> = {}
    for (const k of PLACEMENT_PATCH_KEYS) if (!sameValue(here[k], t[k])) pp[k] = t[k]
    if (!Object.keys(pp).length) continue
    if (
      !push({
        op: 'update_placement',
        at: { field: t.field, group_key: t.group_key },
        patch: pp as never
      })
    )
      continue
    changes.push({
      kind: 'field',
      action: 'change',
      target: t.field,
      where: t.group_key,
      text: `Change ${Object.keys(pp).join(', ')} of ${t.field} in ${groupName(tg, t.group_key)}`
    })
  }

  // 6. Order: every container, parents before children, as the other copy has it.
  let reordered = 0
  const parents: Array<string | null> = [null]
  for (const g of [...theirGroups.values()].sort((a, b) => depth(a) - depth(b)))
    if (g.type === 'container') parents.push(g.key)
  for (const parent of parents) {
    const want = topMembers(theirs, parent)
    let moved = false
    for (let i = 0; i < want.length; i++) {
      const have = topMembers(cur, parent)
      if (have[i] === want[i]) continue
      const [kind, key] = [want[i].slice(0, 1), want[i].slice(2)]
      if (kind === 'g' && !cur.groups.some((g) => g.key === key)) continue
      if (push({ op: 'group_move', key, parent_key: parent, index: i })) moved = true
    }
    if (moved) reordered++
  }
  const zones = new Set<string | null>()
  for (const p of theirs.placements) if (!isCanvasSlot(p)) zones.add(p.group_key)
  for (const zone of zones) {
    const want = zoneOrder(theirs, zone)
    let moved = false
    for (let i = 0; i < want.length; i++) {
      const have = zoneOrder(cur, zone)
      if (have[i] === want[i]) continue
      if (
        push({
          op: 'move',
          from: { field: want[i], group_key: zone },
          to_group_key: zone,
          index: i
        })
      )
        moved = true
    }
    if (moved) reordered++
  }
  if (reordered)
    changes.push({
      kind: 'order',
      action: 'change',
      target: 'order',
      text: `Reorder ${reordered} ${reordered === 1 ? 'part' : 'parts'} of the form`
    })

  return { ops, changes, exact: sameShape(cur, theirs, skip) }
}

/** Whether two bundles show the same form (ids and kept / skipped settings aside). */
export function sameShape(
  a: LayoutBundle,
  b: LayoutBundle,
  skip: Record<string, string> = {}
): boolean {
  const na = normalizeBundle(a)
  const nb = normalizeBundle(b)
  for (const key of LAYOUT_PATCH_KEYS) {
    if ((PROMOTE_KEPT_KEYS as readonly string[]).includes(key) || skip[key]) continue
    if (!(key in nb.layout)) continue
    if (
      JSON.stringify(layoutValue(key, na.layout[key])) !==
      JSON.stringify(layoutValue(key, nb.layout[key]))
    )
      return false
  }
  const gShape = (g: GroupRow) =>
    JSON.stringify([
      g.key,
      g.parent_key ?? null,
      g.sort,
      ...GROUP_PATCH_KEYS.map((k) => normValue(g[k]))
    ])
  const pShape = (p: PlacementRow) =>
    JSON.stringify([
      p.field,
      p.group_key ?? null,
      p.sort,
      ...PLACEMENT_PATCH_KEYS.map((k) => normValue(p[k]))
    ])
  const gs = (x: LayoutBundle) => x.groups.map(gShape).sort().join('\n')
  const ps = (x: LayoutBundle) => x.placements.map(pShape).sort().join('\n')
  return gs(na) === gs(nb) && ps(na) === ps(nb)
}

// ─── Portable file ──────────────────────────────────────────────────────────

export interface LayoutExportFile {
  format: 'nivaro-layout'
  version: 1
  exported_at: string
  instance: { version: string; environment: string; database?: string }
  bundle: LayoutBundle
}

export function isLayoutExportFile(v: unknown): v is LayoutExportFile {
  const f = v as LayoutExportFile | null
  return (
    !!f &&
    typeof f === 'object' &&
    f.format === 'nivaro-layout' &&
    f.version === 1 &&
    !!f.bundle &&
    typeof f.bundle === 'object' &&
    !!f.bundle.layout &&
    Array.isArray(f.bundle.groups) &&
    Array.isArray(f.bundle.placements)
  )
}

/** The layout another copy is matched to: same link name, else same name, in the same collection. */
export function matchLayout<T extends { id: number; name?: unknown; slug?: unknown }>(
  mine: { name?: unknown; slug?: unknown },
  candidates: T[]
): T | null {
  const lc = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
  const slug = lc(mine.slug)
  if (slug) {
    const bySlug = candidates.find((c) => lc(c.slug) === slug)
    if (bySlug) return bySlug
  }
  const name = lc(mine.name)
  return (name && candidates.find((c) => lc(c.name) === name)) || null
}
