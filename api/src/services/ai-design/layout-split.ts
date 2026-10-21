import {
  applyLayoutOps,
  type GroupRow,
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow
} from '../layout-ops-apply.js'
import { type LayoutFinding, SECTION_FIELD_LIMIT, STEP_FIELD_LIMIT } from './layout-review.js'

/**
 * Restructure change sets (#2587): a crowded step or section split into
 * several, proposed as ONE reviewable batch of layout ops.
 *
 * The plan is built against the layout bundle the editor edits (the same
 * ops the draft applies) and checked with the ops twin before it is offered:
 * a change set that would not apply is never shown. The editor applies it
 * through its draft, so the whole split is one undo step; without a draft
 * the route runs it through runLayoutOps (one batch, one version).
 *
 * Who names the parts: the model, when the review asked it (related fields
 * together, every field exactly once); otherwise the rules — equal runs in
 * the current order, named "<label> (2)", "<label> (3)".
 */

export const MAX_SPLIT_PARTS = 6
const PART_LABEL_MAX = 40
const PREVIEW_NAMES = 4

export interface SplitPart {
  label: string
  fields: string[]
}

export interface LayoutChangeSet {
  kind: 'split'
  /** "Split into 3 steps" — the button. */
  title: string
  /** Plain sentences, one per change, for the preview. */
  steps: string[]
  ops: LayoutOp[]
  base_rev: string
  group_key: string
  parts: number
  source: 'rules' | 'ai'
}

type Obj = Record<string, unknown>

function overridesOf(p: PlacementRow): Obj {
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

/** Renumbered copy: after any op every container's sort runs 0..n-1, so a row's sort is its index. */
export function normalizedBundle(bundle: LayoutBundle): LayoutBundle {
  return applyLayoutOps(bundle, [{ op: 'layout_update', patch: {} }])
}

/** Placements of a group the form shows, in order (hidden ones stay where they are). */
export function visiblePlacements(bundle: LayoutBundle, groupKey: string): PlacementRow[] {
  return bundle.placements
    .filter((p) => p.group_key === groupKey && p.is_visible !== false)
    .filter((p) => overridesOf(p).hidden !== true)
    .sort((a, b) => a.sort - b.sort)
}

export function splitPartCount(count: number, limit: number): number {
  return Math.max(2, Math.min(MAX_SPLIT_PARTS, Math.ceil(count / limit)))
}

/** Equal runs in the current order; the first part keeps the group's name. */
export function ruleSplit(label: string, fields: string[], parts: number): SplitPart[] {
  const n = Math.max(2, Math.min(parts, fields.length))
  const out: SplitPart[] = []
  let at = 0
  for (let i = 0; i < n; i++) {
    const size = Math.floor(fields.length / n) + (i < fields.length % n ? 1 : 0)
    out.push({
      label: i === 0 ? label : `${label} (${i + 1})`,
      fields: fields.slice(at, at + size)
    })
    at += size
  }
  return out
}

/**
 * A model's split checked against the group: 2..MAX parts, every visible
 * field exactly once, each part named and non-empty. Anything else → null
 * (the rules split is used instead — never a partial plan).
 */
export function validateSplit(raw: unknown, fields: string[]): SplitPart[] | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_SPLIT_PARTS) return null
  const want = new Set(fields)
  const seen = new Set<string>()
  const out: SplitPart[] = []
  for (const r of raw) {
    const o = r as { label?: unknown; fields?: unknown }
    const label =
      typeof o?.label === 'string'
        ? o.label.replace(/\s+/g, ' ').trim().slice(0, PART_LABEL_MAX)
        : ''
    if (!label || !Array.isArray(o.fields) || o.fields.length === 0) return null
    const list: string[] = []
    for (const f of o.fields) {
      if (typeof f !== 'string' || !want.has(f) || seen.has(f)) return null
      seen.add(f)
      list.push(f)
    }
    out.push({ label, fields: list })
  }
  if (seen.size !== want.size) return null
  // Keep the form's own order inside each part.
  const order = new Map(fields.map((f, i) => [f, i]))
  for (const p of out) p.fields.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  return out
}

function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

function uniqueKey(base: string, taken: Set<string>): string {
  const root = base && !base.startsWith('__') ? base : 'section'
  let key = root
  for (let i = 2; taken.has(key); i++) key = `${root}_${i}`
  taken.add(key)
  return key
}

const listNames = (names: string[]) =>
  names.length <= PREVIEW_NAMES
    ? names.join(', ')
    : `${names.slice(0, PREVIEW_NAMES).join(', ')} and ${names.length - PREVIEW_NAMES} more`

/**
 * The ops that split `groupKey` into `parts` (parts[0] stays in the group,
 * renamed when its label differs). Null when the plan does not apply.
 */
export function planSplit(
  bundle: LayoutBundle,
  groupKey: string,
  parts: SplitPart[],
  labelOf: (field: string) => string,
  source: 'rules' | 'ai' = 'rules'
): LayoutChangeSet | null {
  if (parts.length < 2) return null
  let norm: LayoutBundle
  try {
    norm = normalizedBundle(bundle)
  } catch {
    return null
  }
  const g = norm.groups.find((x) => x.key === groupKey) as GroupRow | undefined
  if (!g || (g.type !== 'section' && g.type !== 'tab')) return null
  const noun = g.type === 'tab' ? 'step' : 'section'
  const taken = new Set(norm.groups.map((x) => x.key))
  const ops: LayoutOp[] = []
  const steps: string[] = []

  if (parts[0].label !== g.label) {
    ops.push({ op: 'group_update', key: g.key, patch: { label: parts[0].label } })
    steps.push(`Rename ${noun} "${g.label}" to "${parts[0].label}"`)
  }
  let prev = parts[0].label
  parts.slice(1).forEach((part, i) => {
    const key = uniqueKey(slug(part.label) || `${g.key}_${i + 2}`, taken)
    ops.push({
      op: 'group_create',
      key,
      label: part.label,
      group_type: g.type,
      parent_key: g.parent_key,
      index: g.sort + i + 1
    })
    part.fields.forEach((field, j) => {
      ops.push({ op: 'move', from: { field, group_key: g.key }, to_group_key: key, index: j })
    })
    const n = part.fields.length
    steps.push(
      `Add ${noun} "${part.label}" after "${prev}" with ${n} field${n === 1 ? '' : 's'}: ${listNames(part.fields.map(labelOf))}`
    )
    prev = part.label
  })
  const kept = parts[0].fields.length
  steps.push(`"${parts[0].label}" keeps ${kept} field${kept === 1 ? '' : 's'}`)

  try {
    applyLayoutOps(bundle, ops)
  } catch {
    return null
  }
  return {
    kind: 'split',
    title: `Split into ${parts.length} ${noun}s`,
    steps,
    ops,
    base_rev: bundle.rev,
    group_key: g.key,
    parts: parts.length,
    source
  }
}

/** Fields of each crowded group the model is asked to divide (review prompt). */
export function splitCandidates(
  findings: LayoutFinding[],
  bundle: LayoutBundle | null
): Array<{ group: string; label: string; parts: number; fields: string[] }> {
  if (!bundle) return []
  const out: Array<{ group: string; label: string; parts: number; fields: string[] }> = []
  for (const f of findings) {
    if (f.kind !== 'too_many_fields' || !f.group?.key) continue
    const g = bundle.groups.find((x) => x.key === f.group?.key)
    if (!g || (g.type !== 'section' && g.type !== 'tab')) continue
    const fields = visiblePlacements(bundle, g.key).map((p) => p.field)
    const limit = g.type === 'tab' ? STEP_FIELD_LIMIT : SECTION_FIELD_LIMIT
    if (fields.length <= limit) continue
    out.push({ group: g.key, label: g.label, parts: splitPartCount(fields.length, limit), fields })
    if (out.length >= 3) break
  }
  return out
}

/**
 * Give every crowded-group finding a split change set: the model's parts when
 * they validate, else the rules split.
 */
export function attachSplitChangeSets(
  findings: LayoutFinding[],
  bundle: LayoutBundle | null,
  labelOf: (field: string) => string,
  aiSplits: Map<string, unknown> = new Map()
): Array<LayoutFinding & { change_set?: LayoutChangeSet }> {
  if (!bundle) return findings
  const wanted = new Map(splitCandidates(findings, bundle).map((c) => [c.group, c]))
  return findings.map((f) => {
    const c = f.kind === 'too_many_fields' && f.group?.key ? wanted.get(f.group.key) : undefined
    if (!c) return f
    const ai = validateSplit(aiSplits.get(c.group), c.fields)
    const parts = ai ?? ruleSplit(c.label, c.fields, c.parts)
    const change_set = planSplit(bundle, c.group, parts, labelOf, ai ? 'ai' : 'rules')
    return change_set ? { ...f, change_set } : f
  })
}
