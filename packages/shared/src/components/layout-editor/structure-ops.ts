import { withGroupStructure } from '../../lib/form-structure'
import {
  applyLayoutOps,
  GROUP_PATCH_KEYS,
  type GroupPatch,
  type GroupRow,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  type PlacementPatch,
  type PlacementRow,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { titleCase } from '../../lib/utils'
import { newGroupKey } from './add-target'
import type { DesignTarget } from './design-context'
import {
  FIELD_HOLDERS,
  inPageOrder,
  moveToZoneOps,
  normalizedBundle,
  plural,
  selectedPlacements,
  zoneItems
} from './field-zones'
import { asArray, placementPatchOf, readOverrides, withKey } from './inspector/model'
import {
  isPinned,
  isPlacementPinned,
  placementOf,
  unpinnedPatch,
  withPin,
  withPlacementPin
} from './pin'
import { humanizeOpError } from './useLayoutDraft'

// Structure actions on the canvas (#2623 #2624 #2625 #2628 #2643 #2630):
// duplicate, wrap / unwrap, convert a container, pin, copy rules, find and
// replace. Pure: each returns ONE ops batch for draft.apply (one undo step),
// checked against the ops twin before it is offered, or the reason it can't.

export type StructurePlan =
  | {
      ok: true
      ops: LayoutOp[]
      /** The undo step's name. */
      label: string
      /** What else happens, in plain words (shown before applying, or as a toast). */
      notes: string[]
      /** What to select afterwards. */
      select?: DesignTarget
    }
  | { ok: false; reason: string }

export const refuse = (reason: string): StructurePlan => ({ ok: false, reason })

/** The plan, or a refusal naming what the save would refuse. */
export function checked(
  bundle: LayoutBundle,
  plan: Extract<StructurePlan, { ok: true }>
): StructurePlan {
  if (plan.ops.length === 0) return refuse('Nothing would change')
  try {
    applyLayoutOps(bundle, plan.ops)
    return plan
  } catch (e) {
    return refuse(humanizeOpError((e as Error).message))
  }
}

export const groupName = (g: Pick<GroupRow, 'label' | 'key'>) => g.label || titleCase(g.key)

const findGroup = (b: LayoutBundle, key: string) => b.groups.find((g) => g.key === key) ?? null
const childrenOf = (b: LayoutBundle, key: string) =>
  b.groups.filter((g) => g.parent_key === key).sort((a, c) => a.sort - c.sort)

/** The mode a tab shows in: its holder's, or the form's for tabs at the top of the form. */
function tabModeOf(b: LayoutBundle, g: GroupRow): 'tabs' | 'steps' {
  const holder = g.parent_key ? findGroup(b, g.parent_key) : null
  const mode = holder ? holder.tab_mode : b.layout.tab_mode
  return mode === 'steps' ? 'steps' : 'tabs'
}

/** "section", "tab", "step", "tabs holder" — what the group is, in words. */
export function kindWord(b: LayoutBundle, g: GroupRow): string {
  if (g.type === 'tab') return tabModeOf(b, g) === 'steps' ? 'step' : 'tab'
  if (g.type === 'container') return g.tab_mode === 'steps' ? 'steps holder' : 'tabs holder'
  if (g.type === 'content') return 'text block'
  if (g.type === 'metadata') return 'record info section'
  return 'section'
}

// ── Pin (#2628) ─────────────────────────────────────────────────────────────

export {
  isPinned,
  isPlacementPinned,
  PIN_KEY,
  pinLocked,
  pinnedZone,
  withPin,
  withPlacementPin
} from './pin'

export function pinPlan(bundle: LayoutBundle, key: string, on: boolean): StructurePlan {
  const g = findGroup(bundle, key)
  if (!g) return refuse('That section is no longer on this form')
  if (isPinned(g) === on) return refuse(on ? 'Already pinned' : 'Not pinned')
  return checked(bundle, {
    ok: true,
    ops: [{ op: 'group_update', key, patch: { swap_config: withPin(g.swap_config, on) } }],
    label: `${on ? 'Pin' : 'Unpin'} ${groupName(g)}`,
    notes: []
  })
}

/** Why this field, panel or header tile cannot be pinned or unpinned (null: it can). */
export function fieldPinBlocked(bundle: LayoutBundle, t: DesignTarget | null): string | null {
  if (!t || t.kind === 'group') return 'Select a field first'
  if (!placementOf(bundle, t)) return 'This comes from the parent form: override it here first'
  return null
}

/** Pin one field's spot in the editor (#3203), or unpin it: its placement's overrides only. */
export function fieldPinPlan(
  bundle: LayoutBundle,
  t: DesignTarget | null,
  on: boolean
): StructurePlan {
  const blocked = fieldPinBlocked(bundle, t)
  if (blocked || !t || t.kind === 'group') return refuse(blocked ?? 'Select a field first')
  const row = placementOf(bundle, t) as PlacementRow
  if (isPlacementPinned(row) === on) return refuse(on ? 'Already pinned' : 'Not pinned')
  const name = row.label_override || titleCase(t.field.replace(/^__|__$/g, ''))
  return checked(bundle, {
    ok: true,
    ops: [
      {
        op: 'update_placement',
        at: { field: row.field, group_key: row.group_key },
        patch: { overrides: withPlacementPin(row.overrides, on) }
      }
    ],
    label: `${on ? 'Pin' : 'Unpin'} ${name}`,
    notes: []
  })
}

// ── Duplicate in place (#2623) ──────────────────────────────────────────────

/** Every stored setting of a group but its label, ready for a group_create patch. */
function groupSettings(g: GroupRow): GroupPatch {
  const out: Record<string, unknown> = {}
  for (const k of GROUP_PATCH_KEYS) if (k !== 'label') out[k] = g[k]
  return out as GroupPatch
}

/** Why something cannot be duplicated in place (null: it can). */
export function duplicateBlocked(bundle: LayoutBundle, t: DesignTarget | null): string | null {
  if (!t) return 'Select a section or field first'
  if (t.kind === 'header') return 'A header tile shows once in the header strip'
  if (t.kind === 'slot' && isCanvasSlot(t)) return 'This panel shows once on a form'
  if (t.kind === 'field' || t.kind === 'slot')
    return 'A field shows once per section. Duplicate its section, or add the field to another section from Add'
  if (t.key === UNGROUPED_KEY) return 'Ungrouped is not a section'
  if (!findGroup(bundle, t.key)) return 'This comes from the parent form: override it here first'
  return null
}

/**
 * The selected section (tab, step, holder, text block) copied right after
 * itself with every setting and every placement's settings (label, width,
 * rules, overrides); a holder brings its tabs. The copy is never pinned. A
 * field shows once per section, so the copies of fields are new placements
 * of the same fields: they show in both sections.
 */
export function duplicatePlan(bundle: LayoutBundle, t: DesignTarget | null): StructurePlan {
  const blocked = duplicateBlocked(bundle, t)
  if (blocked) return refuse(blocked)
  const b = normalizedBundle(bundle)
  const g = findGroup(b, (t as { key: string }).key) as GroupRow
  const used = new Set(b.groups.map((x) => x.key))
  const ops: LayoutOp[] = []
  let fields = 0
  const copy = (src: GroupRow, parentKey: string | null, index: number, label: string) => {
    let key = `${src.key}_copy`
    for (let n = 2; used.has(key); n++) key = `${src.key}_copy_${n}`
    used.add(key)
    const patch = groupSettings(src)
    // The copy is never pinned, nor sticky: one sticky section per form (#2699).
    patch.swap_config = withGroupStructure(withPin(src.swap_config, false), { sticky: false })
    ops.push({
      op: 'group_create',
      key,
      label,
      group_type: src.type,
      parent_key: parentKey,
      index,
      patch
    })
    zoneItems(b, src.key).forEach((p, i) => {
      if (!p.field.startsWith('__')) fields++
      ops.push({
        op: 'place',
        field: p.field,
        group_key: key,
        index: i,
        patch: unpinnedPatch(placementPatchOf(p))
      })
    })
    childrenOf(b, src.key).forEach((c, i) => {
      copy(c, key, i, c.label)
    })
    return key
  }
  const key = copy(g, g.parent_key, g.sort + 1, `${groupName(g)} (copy)`)
  const notes = fields
    ? [`Its ${plural(fields, 'field')} now ${fields === 1 ? 'shows' : 'show'} in both copies`]
    : []
  return checked(bundle, {
    ok: true,
    ops,
    label: `Duplicate ${groupName(g)}`,
    notes,
    select: { kind: 'group', key }
  })
}

// ── Wrap and unwrap (#2624) ─────────────────────────────────────────────────

/** The selected fields (and in-section panels) in a new section, where the first one was. */
export function wrapPlan(bundle: LayoutBundle, selection: DesignTarget[]): StructurePlan {
  const b = normalizedBundle(bundle)
  if (b.layout.layout_type === 'table') return refuse('Table layouts have no sections')
  const rows = inPageOrder(b, selectedPlacements(b, selection))
  if (rows.length === 0) return refuse('Select one or more fields first')
  const first = rows[0]
  const home = first.group_key ? findGroup(b, first.group_key) : null
  if (first.group_key && !home) return refuse('Those fields are not in a section of this form')
  // A section cannot sit in a holder: fields in a tab get a new tab beside it.
  const asTab = home?.type === 'tab'
  const parentKey = home?.parent_key ?? null
  const mode = home && asTab ? tabModeOf(b, home) : null
  const kind = mode === 'steps' ? 'step' : mode === 'tabs' ? 'tab' : 'section'
  const anchor = home ?? findGroup(b, UNGROUPED_KEY)
  const index = anchor ? anchor.sort + 1 : Number.MAX_SAFE_INTEGER
  const key = newGroupKey(b, kind)
  const create: LayoutOp = {
    op: 'group_create',
    key,
    label: `New ${kind}`,
    group_type: asTab ? 'tab' : 'section',
    parent_key: parentKey,
    index
  }
  const after = applyLayoutOps(b, [create])
  const move = moveToZoneOps(after, rows, key)
  const notes: string[] = []
  const twins = rows.length - move.ops.length
  if (twins > 0)
    notes.push(`${plural(twins, 'field')} placed twice ${twins === 1 ? 'goes' : 'go'} in once`)
  return checked(bundle, {
    ok: true,
    ops: [create, ...move.ops],
    label: `Wrap ${plural(move.ops.length, 'field')} in a new ${kind}`,
    notes,
    select: { kind: 'group', key }
  })
}

/** Why a group cannot be unwrapped (null: it can). */
export function unwrapBlocked(bundle: LayoutBundle, key: string): string | null {
  if (key === UNGROUPED_KEY) return 'Ungrouped is not a section'
  const g = findGroup(bundle, key)
  if (!g) return 'This comes from the parent form: override it here first'
  if (g.type === 'container') return 'Use Convert to turn its tabs into sections'
  if (!FIELD_HOLDERS.has(g.type)) return 'Only sections, tabs and steps hold fields'
  return null
}

/**
 * Dissolve a section and keep its fields: they join the Ungrouped zone (a
 * field already there keeps that one placement). When the zone holds no
 * fields yet it first moves into the section's place, so a top-level
 * section's fields stay where they were on the page.
 */
export function unwrapPlan(bundle: LayoutBundle, key: string): StructurePlan {
  const blocked = unwrapBlocked(bundle, key)
  if (blocked) return refuse(blocked)
  const b = normalizedBundle(bundle)
  const g = findGroup(b, key) as GroupRow
  const fields = zoneItems(b, key)
  const ungroupedFields = new Set(zoneItems(b, null).map((p) => p.field))
  const ops: LayoutOp[] = []
  const notes: string[] = []
  const inPlace =
    g.parent_key === null && ungroupedFields.size === 0 && !!findGroup(b, UNGROUPED_KEY)
  if (inPlace && fields.length > 0)
    ops.push({ op: 'group_move', key: UNGROUPED_KEY, parent_key: null, index: g.sort })
  ops.push({ op: 'group_remove', key, placements: 'ungroup' })
  if (fields.length === 0) notes.push('It holds no fields')
  else if (inPlace) notes.push('Its fields stay where they are, as ungrouped fields')
  else notes.push(`Its ${plural(fields.length, 'field')} move to the end of Ungrouped`)
  const twins = fields.filter((p) => ungroupedFields.has(p.field)).length
  if (twins > 0)
    notes.push(
      `${plural(twins, 'field')} already in Ungrouped ${twins === 1 ? 'stays' : 'stay'} once`
    )
  return checked(bundle, {
    ok: true,
    ops,
    label: `Unwrap ${groupName(g)}`,
    notes,
    select: { kind: 'group', key: UNGROUPED_KEY }
  })
}

// ── Convert container type (#2625) ──────────────────────────────────────────

export type ConvertTo = 'section' | 'tab' | 'step' | 'tabs' | 'steps' | 'sections'

export interface ConvertChoice {
  to: ConvertTo
  /** The menu row: "Make it a step". */
  title: string
  plan: StructurePlan
}

/** Settings a section has that a tab ignores, and the reverse — kept, but unused. */
function lostOnTab(g: GroupRow): string[] {
  const out: string[] = []
  if (g.is_collapsed) out.push('“Starts collapsed” does not apply to tabs or steps (kept, unused)')
  if (asArray(g.summary_fields).length)
    out.push('The collapsed summary does not apply to tabs or steps (kept, unused)')
  return out
}
function lostOnSection(g: GroupRow): string[] {
  const out: string[] = []
  if (asArray(g.visible_when).length)
    out.push('Its “Only when” rule works on steps and tabs only (kept, unused)')
  if (asArray(g.skip_if_filled).length)
    out.push('“Skip when filled” works on steps only (kept, unused)')
  return out
}

/** A top-level section made a tab or step: joins the holder just above it when it shows that way, else gets a new holder in its place. */
function sectionToTab(b: LayoutBundle, g: GroupRow, mode: 'tabs' | 'steps'): StructurePlan {
  const word = mode === 'steps' ? 'step' : 'tab'
  const top = b.groups.filter((x) => x.parent_key === null).sort((a, c) => a.sort - c.sort)
  const above = top[top.indexOf(g) - 1]
  const notes = lostOnTab(g)
  const ops: LayoutOp[] = [{ op: 'group_update', key: g.key, patch: { type: 'tab' } }]
  if (
    above?.type === 'container' &&
    (above.tab_mode === 'steps' ? 'steps' : 'tabs') === mode &&
    !isPinned(above)
  ) {
    ops.push({
      op: 'group_move',
      key: g.key,
      parent_key: above.key,
      index: childrenOf(b, above.key).length
    })
    notes.unshift(`Joins ${groupName(above)} as its last ${word}`)
  } else {
    const holder = newGroupKey(b, mode)
    ops.unshift({
      op: 'group_create',
      key: holder,
      label: mode === 'steps' ? 'Steps' : 'Tabs',
      group_type: 'container',
      parent_key: null,
      index: g.sort,
      patch: { tab_mode: mode }
    })
    ops.push({ op: 'group_move', key: g.key, parent_key: holder, index: 0 })
    notes.unshift(`A new ${mode} holder takes its place, with it as the first ${word}`)
  }
  return checked(b, {
    ok: true,
    ops,
    label: `Make ${groupName(g)} a ${word}`,
    notes,
    select: { kind: 'group', key: g.key }
  })
}

/** Tabs of a holder moved out after it as sections; the holder goes. */
function tabsToSections(b: LayoutBundle, holder: GroupRow, only?: GroupRow): StructurePlan {
  const tabs = childrenOf(b, holder.key)
  const moving = only ? [only] : tabs
  const ops: LayoutOp[] = []
  moving.forEach((t, i) => {
    ops.push({ op: 'group_move', key: t.key, parent_key: null, index: holder.sort + 1 + i })
    ops.push({ op: 'group_update', key: t.key, patch: { type: 'section' } })
  })
  const notes = moving.flatMap((t) =>
    lostOnSection(t).map((n) => (moving.length > 1 ? `${groupName(t)}: ${n}` : n))
  )
  const empties = moving.length === tabs.length
  if (empties) {
    ops.push({ op: 'group_remove', key: holder.key, placements: 'ungroup' })
    notes.unshift(`${groupName(holder)} is removed: it would be empty`)
  }
  if (only) notes.unshift(`Moves out of ${groupName(holder)}, just below it`)
  else notes.unshift(`${plural(tabs.length, 'tab')} become sections below one another`)
  const label = only
    ? `Make ${groupName(only)} a section`
    : `Turn the ${tabModeOf(b, tabs[0] ?? holder) === 'steps' ? 'steps' : 'tabs'} of ${groupName(holder)} into sections`
  return checked(b, {
    ok: true,
    ops,
    label,
    notes,
    select: { kind: 'group', key: (only ?? tabs[0] ?? holder).key }
  })
}

/** A holder (or the form's own top-level tabs) shown the other way. */
function switchMode(
  b: LayoutBundle,
  g: GroupRow,
  holder: GroupRow | null,
  mode: 'tabs' | 'steps'
): StructurePlan {
  const word = mode === 'steps' ? 'steps' : 'tabs'
  const siblings = holder
    ? childrenOf(b, holder.key)
    : b.groups.filter((x) => x.parent_key === null && x.type === 'tab')
  const others = siblings.filter((s) => s.key !== g.key).length
  const notes: string[] = []
  if (g.type === 'tab' && others > 0)
    notes.push(
      holder
        ? `All ${siblings.length} tabs of ${groupName(holder)} become ${word}: a holder shows its tabs one way`
        : `All ${siblings.length} tabs at the top of the form become ${word}: the form shows them one way`
    )
  else if (siblings.length > 0) notes.push(`${plural(siblings.length, 'tab')} show as ${word}`)
  if (mode === 'steps' && b.layout.validate_before_next)
    notes.push('People must complete each step before the next')
  const ops: LayoutOp[] = holder
    ? [{ op: 'group_update', key: holder.key, patch: { tab_mode: mode } }]
    : [{ op: 'layout_update', patch: { tab_mode: mode } }]
  const name = g.type === 'tab' ? groupName(g) : groupName(holder ?? g)
  return checked(b, {
    ok: true,
    ops,
    label: g.type === 'tab' ? `Make ${name} a ${word.slice(0, -1)}` : `Show ${name} as ${word}`,
    notes,
    select: { kind: 'group', key: g.key }
  })
}

/**
 * What the selected group can turn into, each with its checked plan. The
 * nesting rules are the ops twin's: fields sit in sections, tabs and steps;
 * only tabs sit in a holder and a holder shows all its tabs one way, so a
 * single tab becomes a step only with its siblings. Sections, tabs, steps
 * and holders convert; record info and text blocks do not.
 */
export function convertChoices(bundle: LayoutBundle, key: string): ConvertChoice[] {
  const b = normalizedBundle(bundle)
  const g = findGroup(b, key)
  if (!g) return []
  const holder = g.parent_key ? findGroup(b, g.parent_key) : null
  const out: ConvertChoice[] = []
  if (g.type === 'section' && g.parent_key === null) {
    out.push({ to: 'tab', title: 'Make it a tab', plan: sectionToTab(b, g, 'tabs') })
    out.push({ to: 'step', title: 'Make it a step', plan: sectionToTab(b, g, 'steps') })
  } else if (g.type === 'tab') {
    const mode = tabModeOf(b, g)
    out.push({
      to: 'section',
      title: 'Make it a section',
      plan: holder
        ? tabsToSections(b, holder, g)
        : checked(b, {
            ok: true,
            ops: [{ op: 'group_update', key: g.key, patch: { type: 'section' } }],
            label: `Make ${groupName(g)} a section`,
            notes: lostOnSection(g),
            select: { kind: 'group', key: g.key }
          })
    })
    out.push(
      mode === 'tabs'
        ? { to: 'step', title: 'Make it a step', plan: switchMode(b, g, holder, 'steps') }
        : { to: 'tab', title: 'Make it a tab', plan: switchMode(b, g, holder, 'tabs') }
    )
  } else if (g.type === 'container') {
    const mode = g.tab_mode === 'steps' ? 'steps' : 'tabs'
    out.push(
      mode === 'tabs'
        ? { to: 'steps', title: 'Turn its tabs into steps', plan: switchMode(b, g, g, 'steps') }
        : { to: 'tabs', title: 'Turn its steps into tabs', plan: switchMode(b, g, g, 'tabs') }
    )
    out.push({
      to: 'sections',
      title: `Turn its ${mode} into sections`,
      plan: childrenOf(b, g.key).length ? tabsToSections(b, g) : refuse(`It holds no ${mode}`)
    })
  }
  return out
}

// ── Copy rules to other sections (#2643) ────────────────────────────────────

export const RULE_KEYS = ['visible_when', 'hidden_for_roles', 'locked_for_roles'] as const
export type RuleKey = (typeof RULE_KEYS)[number]

export const RULE_LABELS: Record<RuleKey, string> = {
  visible_when: 'Only when (step conditions)',
  hidden_for_roles: 'Hidden for roles',
  locked_for_roles: 'Read-only for roles'
}

const SECTION_LIKE = new Set(['section', 'metadata', 'tab'])

/** Is the rule set (a non-empty JSON list)? */
export const ruleSet = (g: GroupRow, k: RuleKey) => asArray(g[k]).length > 0
const ruleSig = (v: string | null) => JSON.stringify(asArray(v))

/** Rules this group can give: role rules on any section, step conditions on tabs and steps. */
export function rulesOf(g: GroupRow): RuleKey[] {
  if (!SECTION_LIKE.has(g.type)) return []
  return RULE_KEYS.filter((k) => k !== 'visible_when' || g.type === 'tab')
}

/** Sections, tabs and steps the rules can be pasted onto, in page order. */
export function ruleTargets(bundle: LayoutBundle, fromKey: string): GroupRow[] {
  return groupsInPageOrder(normalizedBundle(bundle)).filter(
    (g) => g.key !== fromKey && SECTION_LIKE.has(g.type)
  )
}

/** One group_update per target that would change; step conditions only onto tabs and steps. */
export function copyRulesPlan(
  bundle: LayoutBundle,
  fromKey: string,
  toKeys: string[],
  rules: RuleKey[]
): StructurePlan {
  const from = findGroup(bundle, fromKey)
  if (!from) return refuse('That section is no longer on this form')
  if (rules.length === 0) return refuse('Pick at least one rule')
  if (toKeys.length === 0) return refuse('Pick the sections to copy onto')
  const ops: LayoutOp[] = []
  const notes: string[] = []
  let same = 0
  let noSteps = 0
  for (const key of toKeys) {
    const to = findGroup(bundle, key)
    if (!to) continue
    const patch: GroupPatch = {}
    for (const k of rules) {
      if (k === 'visible_when' && to.type !== 'tab') {
        noSteps++
        continue
      }
      if (ruleSig(to[k]) !== ruleSig(from[k])) patch[k] = from[k]
    }
    if (Object.keys(patch).length) ops.push({ op: 'group_update', key, patch })
    else same++
  }
  if (noSteps)
    notes.push(
      `Step conditions skipped on ${plural(noSteps, 'section')}: they work on steps and tabs only`
    )
  if (same)
    notes.push(`${plural(same, 'section')} already ${same === 1 ? 'has' : 'have'} these rules`)
  return checked(bundle, {
    ok: true,
    ops,
    label: `Copy the rules of ${groupName(from)} to ${plural(ops.length, 'section')}`,
    notes
  })
}

// ── Find and replace in labels (#2630) ──────────────────────────────────────

export type HitKind =
  | 'group_label'
  | 'text_block'
  | 'label'
  | 'label_override'
  | 'help'
  | 'field_label'
  | 'field_help'

export const HIT_KIND_LABELS: Record<HitKind, string> = {
  group_label: 'Section name',
  text_block: 'Text block',
  label: 'Field label on this form',
  label_override: 'Field label on this form',
  help: 'Help text on this form',
  field_label: 'Field label (sets this form’s own)',
  field_help: 'Help text (sets this form’s own)'
}

export interface ReplaceHit {
  id: string
  kind: HitKind
  /** The group key, or the placement (field + group). */
  group?: string
  at?: { field: string; group_key: string | null }
  /** Where it is, for the list: "Basic information", "PO number · Details". */
  where: string
  before: string
  after: string
  /** Matches in this text. */
  count: number
}

export interface GlobalFieldText {
  field: string
  label?: string | null
  note?: string | null
}

export interface FindOptions {
  matchCase?: boolean
  /** The collection's own field labels and help text (only used where this form sets none). */
  globals?: GlobalFieldText[]
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function matcher(find: string, matchCase: boolean): RegExp | null {
  return find ? new RegExp(escapeRe(find), matchCase ? 'g' : 'gi') : null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** Every place `find` occurs in this form's labels, section names and help text, replaced. */
export function findHits(
  bundle: LayoutBundle,
  find: string,
  replace: string,
  opts: FindOptions = {}
): ReplaceHit[] {
  const re = matcher(find, !!opts.matchCase)
  if (!re) return []
  const b = normalizedBundle(bundle)
  const hits: ReplaceHit[] = []
  const hit = (base: Omit<ReplaceHit, 'after' | 'count'>) => {
    const count = base.before.match(re)?.length ?? 0
    if (count === 0) return
    // A function replacement: `$&` in what the admin typed stays literal.
    hits.push({ ...base, after: base.before.replace(re, () => replace), count })
  }
  for (const g of groupsInPageOrder(b)) {
    hit({
      id: `group:${g.key}`,
      kind: 'group_label',
      group: g.key,
      where: kindTitle(b, g),
      before: g.label
    })
    if (g.type === 'content' && str(g.content))
      hit({
        id: `content:${g.key}`,
        kind: 'text_block',
        group: g.key,
        where: groupName(g),
        before: g.content as string
      })
  }
  const globals = new Map((opts.globals ?? []).map((f) => [f.field, f]))
  const sectionOf = (key: string | null) => {
    if (key === null) return 'Ungrouped'
    if (key === '__header__') return 'Header strip'
    const g = findGroup(b, key)
    return g ? groupName(g) : titleCase(key)
  }
  for (const p of inPageOrder(
    b,
    b.placements.filter((x) => !isCanvasSlot(x))
  )) {
    const ov = readOverrides(p)
    const global = globals.get(p.field)
    const name = str(ov.label) ?? str(p.label_override) ?? str(global?.label) ?? titleCase(p.field)
    const where = `${name} · ${sectionOf(p.group_key)}`
    const at = { field: p.field, group_key: p.group_key }
    const id = (k: string) => `${k}:${p.field}:${p.group_key ?? ''}`
    if (str(ov.label))
      hit({ id: id('label'), kind: 'label', at, where, before: ov.label as string })
    else if (str(p.label_override))
      hit({
        id: id('label_override'),
        kind: 'label_override',
        at,
        where,
        before: p.label_override as string
      })
    else if (str(global?.label) && !p.field.startsWith('__'))
      hit({
        id: id('field_label'),
        kind: 'field_label',
        at,
        where,
        before: global?.label as string
      })
    if (str(ov.note)) hit({ id: id('help'), kind: 'help', at, where, before: ov.note as string })
    else if (str(global?.note) && !p.field.startsWith('__'))
      hit({ id: id('field_help'), kind: 'field_help', at, where, before: global?.note as string })
  }
  return hits
}

// Every group in page order (holders, then their tabs), the Ungrouped zone left out.
export function groupsInPageOrder(b: LayoutBundle): GroupRow[] {
  const top = b.groups
    .filter((g) => g.parent_key === null && g.key !== UNGROUPED_KEY)
    .sort((a, c) => a.sort - c.sort)
  return top.flatMap((g) => [g, ...childrenOf(b, g.key)])
}

function kindTitle(b: LayoutBundle, g: GroupRow): string {
  const w = kindWord(b, g)
  return `${w[0].toUpperCase()}${w.slice(1)}`
}

/** The chosen hits as one batch: one op per section or placement. */
export function replacePlan(bundle: LayoutBundle, hits: ReplaceHit[]): StructurePlan {
  if (hits.length === 0) return refuse('Pick at least one match')
  const groupPatches = new Map<string, GroupPatch>()
  const placementHits = new Map<string, ReplaceHit[]>()
  for (const h of hits) {
    if (h.group) {
      const patch = groupPatches.get(h.group) ?? {}
      if (h.kind === 'group_label') patch.label = h.after
      else patch.content = h.after
      groupPatches.set(h.group, patch)
    } else if (h.at) {
      const k = `${h.at.field}\u0000${h.at.group_key ?? ''}`
      placementHits.set(k, [...(placementHits.get(k) ?? []), h])
    }
  }
  const ops: LayoutOp[] = []
  for (const [key, patch] of groupPatches) ops.push({ op: 'group_update', key, patch })
  for (const list of placementHits.values()) {
    const at = list[0].at as { field: string; group_key: string | null }
    const row = bundle.placements.find(
      (p) => p.field === at.field && p.group_key === at.group_key
    ) as PlacementRow | undefined
    if (!row) continue
    let ov: Record<string, unknown> | null = readOverrides(row)
    const patch: PlacementPatch = {}
    let ovChanged = false
    for (const h of list) {
      if (h.kind === 'label_override') patch.label_override = h.after
      else {
        const k = h.kind === 'label' || h.kind === 'field_label' ? 'label' : 'note'
        ov = withKey(ov ?? {}, k, h.after === '' ? undefined : h.after)
        ovChanged = true
      }
    }
    if (ovChanged) patch.overrides = ov
    ops.push({ op: 'update_placement', at, patch })
  }
  const n = hits.reduce((s, h) => s + h.count, 0)
  return checked(bundle, {
    ok: true,
    ops,
    label: `Replace ${plural(n, 'match', 'matches')} in labels`,
    notes: []
  })
}
