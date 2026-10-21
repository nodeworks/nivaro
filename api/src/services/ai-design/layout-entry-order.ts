import {
  applyLayoutOps,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow
} from '../layout-ops-apply.js'
import {
  type AssistContext,
  groupLabel,
  isFieldPlacement,
  isShown,
  placementLabel
} from './layout-assist-context.js'
import { normalizedBundle } from './layout-split.js'
import { type AiComplete, asArray, cleanText, parseJsonLoose } from './model.js'

/**
 * Natural entry order (#2688): the model suggests an order inside each
 * section or step that follows how a person fills the form in (who, what,
 * where, when, how much, then notes), and a deterministic pass makes sure a
 * driver field (one another field's picker filters by, or whose value its
 * show / hide conditions read) comes before the fields it controls.
 *
 * Only visible fields move; hidden fields, widgets and slots keep their
 * positions. Each section's proposal is a list of move ops built on the
 * bundle and checked with the ops twin; Apply all is one batch in the
 * editor's draft (one undo step).
 */

const MAX_SECTIONS = 15
const MAX_FIELDS = 150
const MIN_FIELDS = 3

export interface EntryOrderChangeSet {
  kind: 'entry_order'
  title: string
  steps: string[]
  ops: LayoutOp[]
  base_rev: string
  group_key: string
  why: string | null
  source: 'ai'
}

export interface OrderSection {
  key: string
  label: string
  /** Visible real fields in their current order. */
  fields: string[]
}

/** Members of a group in order, the way the ops twin indexes them. */
function zoneMembers(bundle: LayoutBundle, key: string): PlacementRow[] {
  return bundle.placements
    .filter((p) => p.group_key === key && !isCanvasSlot(p))
    .sort((a, b) => a.sort - b.sort)
}

const movable = (p: PlacementRow) => isFieldPlacement(p) && isShown(p)

export function orderSections(bundle: LayoutBundle): OrderSection[] {
  const out: OrderSection[] = []
  let total = 0
  for (const g of bundle.groups) {
    if (g.type !== 'section' && g.type !== 'tab') continue
    const fields = zoneMembers(bundle, g.key)
      .filter(movable)
      .map((p) => p.field)
    if (fields.length < MIN_FIELDS) continue
    if (total + fields.length > MAX_FIELDS) break
    total += fields.length
    out.push({ key: g.key, label: groupLabel(bundle, g.key), fields })
    if (out.length >= MAX_SECTIONS) break
  }
  return out
}

/** field → the fields in the same list that drive it. */
export function driverMap(fields: string[], ctx: AssistContext): Map<string, string[]> {
  const inList = new Set(fields)
  const out = new Map<string, string[]>()
  for (const f of fields) {
    const drivers = (ctx.fields.get(f)?.drivers ?? []).filter((d) => d !== f && inList.has(d))
    if (drivers.length) out.set(f, drivers)
  }
  return out
}

/**
 * Drivers before what they drive: a field placed before one of its drivers
 * moves to just after the last of them. Stable otherwise; a cycle is left as
 * it is (bounded passes).
 */
export function driversFirst(order: string[], drivers: Map<string, string[]>): string[] {
  const out = [...order]
  for (let pass = 0; pass < out.length + 1; pass++) {
    let moved = false
    for (let i = 0; i < out.length; i++) {
      const f = out[i]
      const ds = drivers.get(f)
      if (!ds) continue
      const last = Math.max(...ds.map((d) => out.indexOf(d)))
      if (last > i) {
        out.splice(i, 1)
        out.splice(last, 0, f) // `last` shifted down by one: lands right after it
        moved = true
        break
      }
    }
    if (!moved) break
  }
  return out
}

/**
 * The model's order for one section checked against its fields: unknown
 * names dropped, repeats dropped, fields it left out keep their relative
 * order at the end. Null when it covered under half of the section.
 */
export function validateOrder(raw: unknown, fields: string[]): string[] | null {
  if (!Array.isArray(raw)) return null
  const want = new Set(fields)
  const seen = new Set<string>()
  const out: string[] = []
  for (const f of raw) {
    if (typeof f !== 'string' || !want.has(f) || seen.has(f)) continue
    seen.add(f)
    out.push(f)
  }
  if (out.length * 2 < fields.length) return null
  for (const f of fields) if (!seen.has(f)) out.push(f)
  return out
}

/**
 * Move ops that turn the section's visible order into `target`; everything
 * that does not move (hidden fields, widgets) keeps its slot. Index i of each
 * op is in the zone after the moved row is taken out, so filling slots left
 * to right never disturbs the part already in place.
 */
export function orderOps(bundle: LayoutBundle, key: string, target: string[]): LayoutOp[] {
  const members = zoneMembers(bundle, key)
  const slots = members.map((p, i) => (movable(p) ? i : -1)).filter((i) => i >= 0)
  if (slots.length !== target.length) return []
  const goal = members.map((p) => p.field)
  slots.forEach((slot, i) => {
    goal[slot] = target[i]
  })
  const cur = members.map((p) => p.field)
  const ops: LayoutOp[] = []
  for (let i = 0; i < goal.length; i++) {
    if (cur[i] === goal[i]) continue
    const from = cur.indexOf(goal[i])
    cur.splice(from, 1)
    cur.splice(i, 0, goal[i])
    ops.push({ op: 'move', from: { field: goal[i], group_key: key }, to_group_key: key, index: i })
  }
  return ops
}

export const ORDER_SYSTEM = `You order the fields of each section of a data-entry form the way a person fills it in: who (requester, contact, owner), what (item, description, category), where, when (dates), how much (quantity, price, cost, totals), then notes and attachments. A field listed under "controls" must come before the fields it controls.
Answer with ONE JSON object and nothing else:
{"sections":[{"section":"<section key>","order":["<field key>", ...],"why":"<one short sentence>"}]}
Rules: list every field of a section exactly once, only keys from the input. Leave out sections whose order already flows — an empty list is fine. Do not move fields between sections.`

export function buildOrderPrompt(
  collection: string,
  sections: OrderSection[],
  bundle: LayoutBundle,
  ctx: AssistContext
): string {
  const byField = new Map(bundle.placements.filter(isFieldPlacement).map((p) => [p.field, p]))
  return JSON.stringify({
    collection,
    sections: sections.map((s) => {
      const drivers = driverMap(s.fields, ctx)
      return {
        section: s.key,
        label: s.label,
        fields: s.fields.map((f) => {
          const controls = [...drivers].filter(([, ds]) => ds.includes(f)).map(([d]) => d)
          const p = byField.get(f)
          return {
            field: f,
            label: p ? placementLabel(p, ctx) : f,
            type: ctx.fields.get(f)?.type ?? 'string',
            ...(controls.length ? { controls } : {})
          }
        })
      }
    })
  })
}

/** Plain sentences for the moves: "Put Requester first", "Put Amount after Needed by". */
function stepsFor(
  bundle: LayoutBundle,
  key: string,
  ops: LayoutOp[],
  ctx: AssistContext
): string[] {
  const members = zoneMembers(bundle, key)
  const label = new Map(members.map((p) => [p.field, placementLabel(p, ctx)]))
  const show = new Set(members.filter(movable).map((p) => p.field))
  const cur = members.map((p) => p.field)
  const out: string[] = []
  for (const op of ops) {
    if (op.op !== 'move') continue
    const f = op.from.field
    cur.splice(cur.indexOf(f), 1)
    cur.splice(op.index, 0, f)
    const before = cur.slice(0, op.index).filter((x) => show.has(x))
    const prev = before[before.length - 1]
    out.push(
      prev ? `Put "${label.get(f)}" after "${label.get(prev)}"` : `Put "${label.get(f)}" first`
    )
  }
  return out
}

export interface EntryOrderResult {
  change_sets: EntryOrderChangeSet[]
  dropped: string[]
  checked: number
}

/** The model's answer turned into checked change sets, one per section that changes. */
export function entryOrderChangeSets(
  text: string,
  bundle: LayoutBundle,
  sections: OrderSection[],
  ctx: AssistContext
): EntryOrderResult {
  const base = normalizedBundle(bundle)
  const parsed = parseJsonLoose(text) ?? {}
  const byKey = new Map(sections.map((s) => [s.key, s]))
  const dropped: string[] = []
  const answered = new Map<string, { order: string[]; why: string | null }>()
  for (const raw of asArray(parsed.sections)) {
    const o = raw as { section?: unknown; order?: unknown; why?: unknown }
    const key = typeof o?.section === 'string' ? o.section : ''
    const s = byKey.get(key)
    if (!s) {
      if (key) dropped.push(`a section "${key.slice(0, 40)}" that is not on this form`)
      continue
    }
    const order = validateOrder(o.order, s.fields)
    if (!order) {
      dropped.push(`an order for "${s.label}" that left out most of its fields`)
      continue
    }
    answered.set(key, { order, why: cleanText(o.why, 160) })
  }
  const out: EntryOrderChangeSet[] = []
  // Every section gets the drivers-first pass, answered by the model or not.
  for (const s of sections) {
    const a = answered.get(s.key)
    const target = driversFirst(a?.order ?? s.fields, driverMap(s.fields, ctx))
    if (target.join('|') === s.fields.join('|')) continue
    const ops = orderOps(base, s.key, target)
    if (!ops.length) continue
    try {
      const after = applyLayoutOps(base, ops)
      const got = zoneMembers(after, s.key)
        .filter(movable)
        .map((p) => p.field)
      if (got.join('|') !== target.join('|')) continue
    } catch {
      continue
    }
    out.push({
      kind: 'entry_order',
      title: `Reorder "${s.label}"`,
      steps: stepsFor(base, s.key, ops, ctx),
      ops,
      base_rev: bundle.rev,
      group_key: s.key,
      why: a?.why ?? (a ? null : 'Fields that drive others come first.'),
      source: 'ai'
    })
  }
  return { change_sets: out, dropped, checked: sections.length }
}

export async function suggestEntryOrder(
  bundle: LayoutBundle,
  ctx: AssistContext,
  complete: AiComplete
): Promise<EntryOrderResult> {
  const base = normalizedBundle(bundle)
  const sections = orderSections(base)
  if (!sections.length) return { change_sets: [], dropped: [], checked: 0 }
  const text = await complete({
    system: ORDER_SYSTEM,
    user: buildOrderPrompt(ctx.collection, sections, base, ctx),
    maxTokens: 3000
  })
  return entryOrderChangeSets(text, base, sections, ctx)
}
