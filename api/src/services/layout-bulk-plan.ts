import {
  applyLayoutOps,
  type GroupPatch,
  type GroupRow,
  HEADER_GROUP_KEY,
  isCanvasSlot,
  LAYOUT_PATCH_KEYS,
  type LayoutBundle,
  type LayoutOp,
  LayoutOpError,
  type LayoutPatch,
  type PlacementPatch,
  type PlacementRow,
  TABLE_FORM_GROUP_KEYS,
  UNGROUPED_KEY
} from './layout-ops-apply.js'

/**
 * One change on many layouts (#2639 retire a field, #2662 one change on every
 * form, #2663 replay a recorded macro). Pure: given a layout's bundle and the
 * action, says what would happen on that form and which ops do it. The caller
 * (services/layout-bulk.ts) applies the ops through runLayoutOps, so every
 * form gets its own version and History entry.
 *
 * Fields are matched by name and sections by label (then key) on every form,
 * so one action reads the same everywhere even though group keys differ.
 */

export type BulkFlag = 'required' | 'readonly' | 'hidden'

export type BulkChange =
  | { type: 'place_after' | 'place_before'; field: string; anchor: string }
  | { type: 'set_width'; field: string; width: number }
  | { type: 'set_flag'; field: string; flag: BulkFlag; on: boolean }
  | { type: 'remove'; field: string }

/** A section, Ungrouped zone or page card as recorded: matched by label, then key. */
export interface GroupRef {
  key: string
  label: string
}

/** One recorded editor op with every position made relative (shared twin: macro-record.ts). */
export type MacroStep =
  | {
      op: 'place'
      field: string
      group: GroupRef | null
      after: string | null
      patch?: PlacementPatch
    }
  | { op: 'move'; field: string; from: GroupRef | null; to: GroupRef | null; after: string | null }
  | { op: 'update_placement'; field: string; group: GroupRef | null; patch: PlacementPatch }
  | { op: 'remove'; field: string; group: GroupRef | null }
  | {
      op: 'group_create'
      group: GroupRef
      group_type: string
      parent: GroupRef | null
      after: GroupRef | null
      patch?: GroupPatch
    }
  | { op: 'group_update'; group: GroupRef; patch: GroupPatch }
  | { op: 'group_move'; group: GroupRef; parent: GroupRef | null; after: GroupRef | null }
  | { op: 'group_remove'; group: GroupRef; placements: 'ungroup' | 'delete' }
  | { op: 'layout_update'; patch: LayoutPatch }

export type BulkAction =
  | { kind: 'retire'; field: string }
  | { kind: 'change'; change: BulkChange }
  | { kind: 'macro'; name: string; steps: MacroStep[] }

export interface FormPlan {
  /** change: ops to apply · same: nothing to do · skip: cannot be applied here */
  status: 'change' | 'same' | 'skip'
  reason: string | null
  /** What applying does, one plain sentence each. */
  changes: string[]
  /** Warnings and skipped macro steps. */
  notes: string[]
  ops: LayoutOp[]
}

export type LabelOf = (field: string) => string

export const GRID_WIDTHS = [12, 6, 4, 3] as const
const WIDTH_NAMES: Record<number, string> = {
  12: 'full width',
  6: 'half',
  4: 'a third',
  3: 'a quarter'
}
const FLAG_WORDS: Record<BulkFlag, [string, string]> = {
  required: ['required', 'optional'],
  readonly: ['read-only', 'editable'],
  hidden: ['hidden', 'shown']
}

/** Macro caps: what one saved macro may hold. */
export const MACRO_MAX_STEPS = 200

/** Layout settings a macro never carries to another form: they name or place the form itself. */
const PER_FORM_KEYS = new Set([
  'name',
  'slug',
  'sort',
  'is_active',
  'layout_type',
  'parent_layout_id',
  'addendum_layout_id',
  'create_label',
  'create_hidden'
])

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.$-]{0,127}$/
const isFieldName = (v: unknown): v is string =>
  typeof v === 'string' && FIELD_RE.test(v) && !v.startsWith('__')

// ─── Parsing ────────────────────────────────────────────────────────────────

/** Validate a request body's action; never trusts shapes from the client. */
export function parseBulkAction(raw: unknown): { action: BulkAction } | { error: string } {
  const a = raw as Record<string, unknown> | null
  if (!a || typeof a !== 'object') return { error: 'action required' }
  if (a.kind === 'retire') {
    if (!isFieldName(a.field)) return { error: 'Pick a field to retire' }
    return { action: { kind: 'retire', field: a.field } }
  }
  if (a.kind === 'change') {
    const c = a.change as Record<string, unknown> | null
    if (!c || typeof c !== 'object') return { error: 'change required' }
    if (!isFieldName(c.field)) return { error: 'Pick a field' }
    const field = c.field
    switch (c.type) {
      case 'place_after':
      case 'place_before':
        if (!isFieldName(c.anchor)) return { error: 'Pick the field to place it next to' }
        if (c.anchor === field) return { error: 'Pick a different field to place it next to' }
        return { action: { kind: 'change', change: { type: c.type, field, anchor: c.anchor } } }
      case 'set_width':
        if (!(GRID_WIDTHS as readonly unknown[]).includes(c.width))
          return { error: 'width must be 12, 6, 4 or 3' }
        return {
          action: { kind: 'change', change: { type: 'set_width', field, width: c.width as number } }
        }
      case 'set_flag':
        if (c.flag !== 'required' && c.flag !== 'readonly' && c.flag !== 'hidden')
          return { error: "flag must be 'required', 'readonly' or 'hidden'" }
        if (typeof c.on !== 'boolean') return { error: 'on must be true or false' }
        return {
          action: { kind: 'change', change: { type: 'set_flag', field, flag: c.flag, on: c.on } }
        }
      case 'remove':
        return { action: { kind: 'change', change: { type: 'remove', field } } }
      default:
        return { error: 'Unknown change' }
    }
  }
  if (a.kind === 'macro') {
    const steps = parseMacroSteps(a.steps)
    if ('error' in steps) return steps
    const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 80) : 'Macro'
    return { action: { kind: 'macro', name, steps: steps.steps } }
  }
  return { error: 'Unknown action' }
}

function parseRef(v: unknown, nullable: boolean): GroupRef | null | undefined {
  if (v == null) return nullable ? null : undefined
  const r = v as Record<string, unknown>
  if (typeof r !== 'object' || typeof r.key !== 'string' || !r.key) return undefined
  return {
    key: r.key.slice(0, 120),
    label: typeof r.label === 'string' ? r.label.slice(0, 200) : ''
  }
}

const asPatch = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/** Steps as stored or sent: unknown ops and malformed steps refuse the whole list. */
export function parseMacroSteps(raw: unknown): { steps: MacroStep[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'A macro needs at least one step' }
  if (raw.length > MACRO_MAX_STEPS)
    return { error: `A macro holds at most ${MACRO_MAX_STEPS} steps` }
  const out: MacroStep[] = []
  for (const [i, s] of raw.entries()) {
    const bad = { error: `Step ${i + 1} is not a layout change` }
    if (!s || typeof s !== 'object') return bad
    const x = s as Record<string, unknown>
    const after = typeof x.after === 'string' ? x.after : null
    switch (x.op) {
      case 'place': {
        const group = parseRef(x.group, true)
        if (typeof x.field !== 'string' || group === undefined) return bad
        out.push({ op: 'place', field: x.field, group, after, patch: asPatch(x.patch) })
        break
      }
      case 'move': {
        const from = parseRef(x.from, true)
        const to = parseRef(x.to, true)
        if (typeof x.field !== 'string' || from === undefined || to === undefined) return bad
        out.push({ op: 'move', field: x.field, from, to, after })
        break
      }
      case 'update_placement':
      case 'remove': {
        const group = parseRef(x.group, true)
        if (typeof x.field !== 'string' || group === undefined) return bad
        if (x.op === 'remove') out.push({ op: 'remove', field: x.field, group })
        else {
          const patch = asPatch(x.patch)
          if (!patch) return bad
          out.push({ op: 'update_placement', field: x.field, group, patch })
        }
        break
      }
      case 'group_create': {
        const group = parseRef(x.group, false)
        const parent = parseRef(x.parent, true)
        const afterRef = parseRef(x.after, true)
        if (!group || parent === undefined || afterRef === undefined) return bad
        if (typeof x.group_type !== 'string') return bad
        out.push({
          op: 'group_create',
          group,
          group_type: x.group_type,
          parent,
          after: afterRef,
          patch: asPatch(x.patch)
        })
        break
      }
      case 'group_update': {
        const group = parseRef(x.group, false)
        const patch = asPatch(x.patch)
        if (!group || !patch) return bad
        out.push({ op: 'group_update', group, patch })
        break
      }
      case 'group_move': {
        const group = parseRef(x.group, false)
        const parent = parseRef(x.parent, true)
        const afterRef = parseRef(x.after, true)
        if (!group || parent === undefined || afterRef === undefined) return bad
        out.push({ op: 'group_move', group, parent, after: afterRef })
        break
      }
      case 'group_remove': {
        const group = parseRef(x.group, false)
        if (!group || (x.placements !== 'ungroup' && x.placements !== 'delete')) return bad
        out.push({ op: 'group_remove', group, placements: x.placements })
        break
      }
      case 'layout_update': {
        const patch = asPatch(x.patch)
        if (!patch) return bad
        out.push({ op: 'layout_update', patch })
        break
      }
      default:
        return bad
    }
  }
  return { steps: out }
}

// ─── Reading a bundle ───────────────────────────────────────────────────────

type Member = { key: string; sort: number; group: GroupRow | null; slot: PlacementRow | null }

/** Renumbered, so sorts are unique per container and array order is page order. */
const normalized = (b: LayoutBundle) => applyLayoutOps(b, [])

const isBodyZone = (gk: string | null) =>
  gk !== HEADER_GROUP_KEY && !TABLE_FORM_GROUP_KEYS.includes(gk ?? '')

export function zoneOf(b: LayoutBundle, gk: string | null): PlacementRow[] {
  return b.placements
    .filter((p) => p.group_key === gk && !isCanvasSlot(p))
    .sort((x, y) => x.sort - y.sort)
}

export function membersOf(b: LayoutBundle, parent: string | null): Member[] {
  const out: Member[] = b.groups
    .filter((g) => g.parent_key === parent)
    .map((g) => ({ key: g.key, sort: g.sort, group: g, slot: null }))
  if (parent === null)
    for (const p of b.placements)
      if (isCanvasSlot(p)) out.push({ key: p.field, sort: p.sort, group: null, slot: p })
  return out.sort((x, y) => x.sort - y.sort)
}

/** Every placement in the order the record page shows them (header strip first). */
export function pageOrder(b: LayoutBundle): PlacementRow[] {
  const out: PlacementRow[] = [...zoneOf(b, HEADER_GROUP_KEY)]
  const seen = new Set<string>()
  const visit = (parent: string | null) => {
    for (const m of membersOf(b, parent)) {
      if (seen.has(m.key)) continue
      seen.add(m.key)
      if (m.slot) out.push(m.slot)
      else if (m.key === UNGROUPED_KEY) out.push(...zoneOf(b, null))
      else {
        out.push(...zoneOf(b, m.key))
        visit(m.key)
      }
    }
  }
  visit(null)
  // Table forms and any placement whose group is gone, last.
  const listed = new Set(out)
  for (const p of b.placements) if (!listed.has(p)) out.push(p)
  return out
}

const bodyPlacements = (b: LayoutBundle, field: string) =>
  pageOrder(b).filter((p) => p.field === field && isBodyZone(p.group_key))

function zoneName(b: LayoutBundle, gk: string | null): string {
  if (gk === null) return 'Ungrouped'
  if (gk === HEADER_GROUP_KEY) return 'the header'
  if (gk === '__apply_values__') return 'Apply values'
  if (gk === '__create_with_defaults__') return 'Create with defaults'
  const g = b.groups.find((x) => x.key === gk)
  return g?.label ? `"${g.label}"` : `"${gk}"`
}

const sameBundle = (a: LayoutBundle, b: LayoutBundle) =>
  JSON.stringify([a.layout, a.groups, a.placements]) ===
  JSON.stringify([b.layout, b.groups, b.placements])

function readOverrides(p: PlacementRow): Record<string, unknown> {
  let v: unknown = p.overrides
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      v = null
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v)
    ? { ...(v as Record<string, unknown>) }
    : {}
}

function parseList(v: unknown): unknown[] {
  let cur = v
  if (typeof cur === 'string') {
    try {
      cur = JSON.parse(cur)
    } catch {
      return []
    }
  }
  return Array.isArray(cur) ? cur : []
}

function parseObject(v: unknown): Record<string, unknown> | null {
  let cur = v
  if (typeof cur === 'string') {
    try {
      cur = JSON.parse(cur)
    } catch {
      return null
    }
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur)
    ? (cur as Record<string, unknown>)
    : null
}

// ─── Planning ───────────────────────────────────────────────────────────────

/** The action in a few words — the version note and the activity comment. */
export function actionLabel(action: BulkAction, L: LabelOf): string {
  if (action.kind === 'retire') return `Retire ${L(action.field)} from every form`
  if (action.kind === 'macro') return `Macro "${action.name}"`
  const c = action.change
  switch (c.type) {
    case 'place_after':
      return `Place ${L(c.field)} after ${L(c.anchor)}`
    case 'place_before':
      return `Place ${L(c.field)} before ${L(c.anchor)}`
    case 'set_width':
      return `Make ${L(c.field)} ${WIDTH_NAMES[c.width]}`
    case 'set_flag':
      return c.flag === 'hidden'
        ? `${c.on ? 'Hide' : 'Show'} ${L(c.field)}`
        : `Make ${L(c.field)} ${FLAG_WORDS[c.flag][c.on ? 0 : 1]}`
    case 'remove':
      return `Remove ${L(c.field)} from every form`
  }
}

/** What the action does on one layout. */
export function planForm(bundle: LayoutBundle, action: BulkAction, L: LabelOf): FormPlan {
  let plan: FormPlan
  try {
    plan =
      action.kind === 'retire'
        ? planRetire(bundle, action.field, L)
        : action.kind === 'change'
          ? planChange(bundle, action.change, L)
          : planMacro(bundle, action.steps, L)
  } catch (err) {
    if (!(err instanceof LayoutOpError)) throw err
    return { status: 'skip', reason: err.message, changes: [], notes: [], ops: [] }
  }
  if (plan.status !== 'change') return plan
  // The batch must apply as one, and must change something.
  try {
    const after = applyLayoutOps(bundle, plan.ops)
    if (sameBundle(normalized(bundle), after))
      return { ...plan, status: 'same', reason: 'Already like that', changes: [], ops: [] }
  } catch (err) {
    if (!(err instanceof LayoutOpError)) throw err
    return { ...plan, status: 'skip', reason: err.message, changes: [], ops: [] }
  }
  return plan
}

const nothing = (reason: string, notes: string[] = []): FormPlan => ({
  status: 'same',
  reason,
  changes: [],
  notes,
  ops: []
})
const cannot = (reason: string, notes: string[] = []): FormPlan => ({
  status: 'skip',
  reason,
  changes: [],
  notes,
  ops: []
})

function notOnForm(bundle: LayoutBundle, field: string, L: LabelOf): FormPlan {
  const inherits = bundle.layout.parent_layout_id != null
  return nothing(
    `${L(field)} is not on this form`,
    inherits ? ['This form takes the rest of its fields from its parent form'] : []
  )
}

function planChange(bundle: LayoutBundle, c: BulkChange, L: LabelOf): FormPlan {
  const b = normalized(bundle)
  const field = c.field
  switch (c.type) {
    case 'place_after':
    case 'place_before': {
      const anchor = bodyPlacements(b, c.anchor)[0]
      if (!anchor) return cannot(`${L(c.anchor)} is not on this form`)
      const gk = anchor.group_key
      const own =
        b.placements.find((p) => p.field === field && p.group_key === gk) ??
        bodyPlacements(b, field)[0] ??
        null
      const list = zoneOf(b, gk).filter((p) => p !== own)
      const at = list.indexOf(anchor) + (c.type === 'place_after' ? 1 : 0)
      const where = `${c.type === 'place_after' ? 'after' : 'before'} ${L(c.anchor)}`
      if (!own)
        return {
          status: 'change',
          reason: null,
          changes: [`Adds ${L(field)} ${where} in ${zoneName(b, gk)}`],
          notes: [],
          ops: [{ op: 'place', field, group_key: gk, index: at }]
        }
      return {
        status: 'change',
        reason: null,
        changes: [
          own.group_key === gk
            ? `Moves ${L(field)} ${where}`
            : `Moves ${L(field)} from ${zoneName(b, own.group_key)} to ${where} in ${zoneName(b, gk)}`
        ],
        notes: [],
        ops: [
          {
            op: 'move',
            from: { field, group_key: own.group_key },
            to_group_key: gk,
            index: at
          }
        ]
      }
    }
    case 'set_width': {
      const rows = bodyPlacements(b, field)
      if (rows.length === 0) return notOnForm(bundle, field, L)
      const stored = c.width === 12 ? null : c.width
      const ops: LayoutOp[] = rows
        .filter((p) => (p.col_span ?? null) !== stored)
        .map((p) => ({
          op: 'update_placement',
          at: { field, group_key: p.group_key },
          patch: { col_span: stored }
        }))
      if (ops.length === 0) return nothing(`Already ${WIDTH_NAMES[c.width]}`)
      return {
        status: 'change',
        reason: null,
        changes: [`Makes ${L(field)} ${WIDTH_NAMES[c.width]}`],
        notes: [],
        ops
      }
    }
    case 'set_flag': {
      const rows = bodyPlacements(b, field)
      if (rows.length === 0) return notOnForm(bundle, field, L)
      const ops: LayoutOp[] = []
      for (const p of rows) {
        const ov = readOverrides(p)
        if ((ov[c.flag] === true) === c.on) continue
        if (c.on) ov[c.flag] = true
        else delete ov[c.flag]
        ops.push({
          op: 'update_placement',
          at: { field, group_key: p.group_key },
          patch: { overrides: Object.keys(ov).length ? ov : null }
        })
      }
      const word = FLAG_WORDS[c.flag][c.on ? 0 : 1]
      if (ops.length === 0) return nothing(`Already ${word}`)
      return {
        status: 'change',
        reason: null,
        changes: [`Makes ${L(field)} ${word}`],
        notes: [],
        ops
      }
    }
    case 'remove': {
      const rows = pageOrder(b).filter((p) => p.field === field)
      if (rows.length === 0) return notOnForm(bundle, field, L)
      return {
        status: 'change',
        reason: null,
        changes: [
          `Removes ${L(field)} from ${rows.map((p) => zoneName(b, p.group_key)).join(', ')}`
        ],
        notes: [],
        ops: rows.map((p) => ({ op: 'remove', at: { field, group_key: p.group_key } }))
      }
    }
  }
}

function planRetire(bundle: LayoutBundle, field: string, L: LabelOf): FormPlan {
  const b = normalized(bundle)
  const ops: LayoutOp[] = []
  const changes: string[] = []
  const notes: string[] = []

  const rows = pageOrder(b).filter((p) => p.field === field)
  if (rows.length) {
    changes.push(`Removes ${L(field)} from ${rows.map((p) => zoneName(b, p.group_key)).join(', ')}`)
    for (const p of rows) ops.push({ op: 'remove', at: { field, group_key: p.group_key } })
  }

  // Section summaries that show it.
  for (const g of b.groups) {
    const list = parseList(g.summary_fields)
    const kept = list.filter(
      (e) =>
        !(e === field || (e && typeof e === 'object' && (e as { field?: unknown }).field === field))
    )
    if (kept.length === list.length) continue
    ops.push({
      op: 'group_update',
      key: g.key,
      patch: { summary_fields: kept.length ? JSON.stringify(kept) : null }
    })
    changes.push(`Takes it out of the ${zoneName(b, g.key)} summary`)
  }

  // Form settings that name it.
  const layout = b.layout as Record<string, unknown>
  const patch: LayoutPatch = {}
  for (const key of ['header_fields', 'quick_picker'] as const) {
    const list = parseList(layout[key])
    if (!list.includes(field)) continue
    const kept = list.filter((x) => x !== field) as string[]
    patch[key] = kept.length ? kept : null
    changes.push(
      key === 'header_fields'
        ? 'Takes it out of the header fields'
        : 'Takes it out of the quick picker steps'
    )
  }
  const defaults = parseObject(layout.default_values)
  if (defaults && field in defaults) {
    const { [field]: _gone, ...rest } = defaults
    patch.default_values = Object.keys(rest).length ? rest : null
    changes.push('Drops its default value on this form')
  }
  if (layout.row_order_field === field) {
    patch.row_order_field = null
    changes.push('Stops ordering rows by it')
  }
  if (layout.pdf_cover_title_field === field) {
    patch.pdf_cover_title_field = null
    changes.push('Stops using it as the PDF cover title')
  }
  if (Object.keys(patch).length) ops.push({ op: 'layout_update', patch })

  // What stays: rules are not rewritten, only named.
  const conds = parseList(layout.record_conditions)
  if (conds.some((r) => (r as { field?: unknown })?.field === field))
    notes.push(`Which records get this form still depends on ${L(field)}`)
  for (const g of b.groups) {
    const when = parseList(g.visible_when)
    if (when.some((r) => (r as { field?: unknown })?.field === field))
      notes.push(`${zoneName(b, g.key)} still shows or hides by ${L(field)}`)
  }

  if (ops.length === 0) return { ...notOnForm(bundle, field, L), notes }
  return { status: 'change', reason: null, changes, notes, ops }
}

// ─── Macro replay ───────────────────────────────────────────────────────────

const norm = (s: string) => s.trim().toLowerCase()

/** A recorded section on this form: label first (keys differ per form), then key. */
function resolveRef(
  b: LayoutBundle,
  ref: GroupRef | null,
  keyMap: Map<string, string>
): string | null | undefined {
  if (ref === null) return null
  if (ref.key.startsWith('__')) return ref.key
  const mapped = keyMap.get(ref.key)
  if (mapped) return mapped
  const groups = b.groups.filter((g) => g.key !== UNGROUPED_KEY)
  const byLabel = ref.label ? groups.filter((g) => norm(g.label) === norm(ref.label)) : []
  if (byLabel.length) return (byLabel.find((g) => g.key === ref.key) ?? byLabel[0]).key
  if (groups.some((g) => g.key === ref.key)) return ref.key
  return undefined
}

const refName = (ref: GroupRef | null) =>
  ref === null ? 'Ungrouped' : ref.label ? `"${ref.label}"` : `"${ref.key}"`

/** Insert index after `after` in `keys` (null = first). Missing anchor = the end. */
function indexAfter(keys: string[], after: string | null): { index: number; missing: boolean } {
  if (after === null) return { index: 0, missing: false }
  const i = keys.indexOf(after)
  return i < 0 ? { index: keys.length, missing: true } : { index: i + 1, missing: false }
}

type StepResult = { op: LayoutOp; text: string; note?: string } | { skip: string }

function stepOp(
  b: LayoutBundle,
  s: MacroStep,
  keyMap: Map<string, string>,
  L: LabelOf
): StepResult {
  const resolve = (ref: GroupRef | null) => resolveRef(b, ref, keyMap)
  const missingGroup = (ref: GroupRef | null) => ({ skip: `no section ${refName(ref)}` })
  const find = (field: string, gk: string | null) =>
    b.placements.find((p) => p.field === field && p.group_key === gk) ?? null

  switch (s.op) {
    case 'place':
    case 'move': {
      const toRef = s.op === 'place' ? s.group : s.to
      const to = resolve(toRef)
      if (to === undefined) return missingGroup(toRef)
      let own: PlacementRow | null = find(s.field, to)
      if (!own && s.op === 'move') {
        const from = resolve(s.from)
        own = (from !== undefined ? find(s.field, from) : null) ?? bodyPlacements(b, s.field)[0]
        if (!own) return { skip: `${L(s.field)} is not on this form` }
      }
      const zone = zoneOf(b, to).filter((p) => p !== own)
      const { index, missing } = indexAfter(
        zone.map((p) => p.field),
        s.after
      )
      const note = missing && s.after ? `${L(s.after)} is not there: placed last` : undefined
      if (own)
        return {
          op: {
            op: 'move',
            from: { field: s.field, group_key: own.group_key },
            to_group_key: to,
            index
          },
          text: `Moves ${L(s.field)} to ${zoneName(b, to)}`,
          note
        }
      const patch = s.op === 'place' ? s.patch : undefined
      return {
        op: { op: 'place', field: s.field, group_key: to, index, ...(patch ? { patch } : {}) },
        text: `Adds ${L(s.field)} to ${zoneName(b, to)}`,
        note
      }
    }
    case 'update_placement':
    case 'remove': {
      const gk = resolve(s.group)
      if (gk === undefined) return missingGroup(s.group)
      const own =
        find(s.field, gk) ??
        (s.op === 'update_placement' && isBodyZone(gk) ? bodyPlacements(b, s.field)[0] : null)
      if (!own) return { skip: `${L(s.field)} is not in ${refName(s.group)}` }
      const at = { field: s.field, group_key: own.group_key }
      return s.op === 'remove'
        ? {
            op: { op: 'remove', at },
            text: `Removes ${L(s.field)} from ${zoneName(b, at.group_key)}`
          }
        : {
            op: { op: 'update_placement', at, patch: s.patch },
            text: `Changes ${L(s.field)} (${Object.keys(s.patch).join(', ')})`
          }
    }
    case 'group_create': {
      const parent = resolve(s.parent)
      if (parent === undefined) return missingGroup(s.parent)
      const existing = resolveRef(b, { key: '\u0000', label: s.group.label }, new Map())
      if (existing) {
        keyMap.set(s.group.key, existing)
        return { skip: `${refName(s.group)} is already on this form` }
      }
      let key = s.group.key
      for (let n = 2; b.groups.some((g) => g.key === key); n++) key = `${s.group.key}_${n}`
      keyMap.set(s.group.key, key)
      const afterKey = s.after ? resolve(s.after) : null
      const { index } = indexAfter(
        membersOf(b, parent).map((m) => m.key),
        afterKey ?? (s.after ? '\u0000' : null)
      )
      return {
        op: {
          op: 'group_create',
          key,
          label: s.group.label,
          group_type: s.group_type,
          parent_key: parent,
          index,
          ...(s.patch ? { patch: s.patch } : {})
        },
        text: `Adds the section ${refName(s.group)}`
      }
    }
    case 'group_update':
    case 'group_move':
    case 'group_remove': {
      const key = resolve(s.group)
      const present =
        key != null &&
        (b.groups.some((g) => g.key === key) ||
          b.placements.some((p) => p.field === key && p.group_key === null))
      if (!present) return missingGroup(s.group)
      if (s.op === 'group_update')
        return {
          op: { op: 'group_update', key: key as string, patch: s.patch },
          text: `Changes ${refName(s.group)} (${Object.keys(s.patch).join(', ')})`
        }
      if (s.op === 'group_remove')
        return {
          op: { op: 'group_remove', key: key as string, placements: s.placements },
          text: `Removes the section ${refName(s.group)}`
        }
      const parent = resolve(s.parent)
      if (parent === undefined) return missingGroup(s.parent)
      const afterKey = s.after ? resolve(s.after) : null
      const { index } = indexAfter(
        membersOf(b, parent)
          .filter((m) => m.key !== key)
          .map((m) => m.key),
        afterKey ?? (s.after ? '\u0000' : null)
      )
      return {
        op: { op: 'group_move', key: key as string, parent_key: parent, index },
        text: `Moves ${refName(s.group)}`
      }
    }
    case 'layout_update': {
      const patch: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(s.patch))
        if ((LAYOUT_PATCH_KEYS as readonly string[]).includes(k) && !PER_FORM_KEYS.has(k))
          patch[k] = v
      if (Object.keys(patch).length === 0)
        return { skip: 'form name, order and type are never replayed' }
      return {
        op: { op: 'layout_update', patch: patch as LayoutPatch },
        text: `Changes form settings (${Object.keys(patch).join(', ')})`
      }
    }
  }
}

function planMacro(bundle: LayoutBundle, steps: MacroStep[], L: LabelOf): FormPlan {
  let cur = normalized(bundle)
  const keyMap = new Map<string, string>()
  const ops: LayoutOp[] = []
  const changes: string[] = []
  const notes: string[] = []
  steps.forEach((s, i) => {
    const r = stepOp(cur, s, keyMap, L)
    if ('skip' in r) {
      notes.push(`Step ${i + 1} skipped: ${r.skip}`)
      return
    }
    try {
      cur = applyLayoutOps(cur, [r.op])
    } catch (err) {
      if (!(err instanceof LayoutOpError)) throw err
      notes.push(`Step ${i + 1} skipped: ${err.message}`)
      return
    }
    ops.push(r.op)
    changes.push(r.text)
    if (r.note) notes.push(`Step ${i + 1}: ${r.note}`)
  })
  if (ops.length === 0)
    return notes.length ? cannot('No step applies to this form', notes) : nothing('Nothing to do')
  return { status: 'change', reason: null, changes, notes, ops }
}
