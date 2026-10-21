import { db } from '../../db/index.js'
import { getAiClient, getAiModelSettings } from '../ai-client.js'
import { cachedLintContext } from '../layout-analysis.js'
import {
  type GroupRow,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutRow,
  newGroup,
  newPlacement,
  type PlacementRow,
  UNGROUPED_KEY
} from '../layout-ops-apply.js'
import { type AiComplete, cleanText, titleCase } from './model.js'

/**
 * What the layout editor's AI assists (#2684 #2686 #2687 #2688 #2689) know
 * about a collection and a layout — config only, never record values: field
 * flags and help text, who may edit what (the lint's real-policy role list),
 * member counts per role, and the bound pipelines' states and transition
 * requirements. `fieldFacts` turns one layout into plain sentences per field
 * ("required on this form", "must be filled before Approve (from Finance
 * Review), run by Finance") that the prompts carry and the tests read.
 */

type Row = Record<string, unknown>

export interface AssistField {
  field: string
  label: string
  type: string
  interface: string | null
  required: boolean
  readonly: boolean
  hidden: boolean
  note: string | null
  /** Fields this field's picker filters by or its show/hide conditions read. */
  drivers: string[]
  choices: string[]
}

export interface AssistRole {
  id: string
  name: string
  admin: boolean
  can_write: boolean
  /** null = every field. */
  writable_fields: string[] | null
  members: number
}

export interface AssistTransition {
  label: string
  from: string | null
  to: string | null
  role_ids: string[]
  /** Fields the transition needs filled (record_fields requirements). */
  fields: string[]
}

export interface AssistState {
  pipeline: string
  key: string
  label: string
}

export interface AssistContext {
  collection: string
  fields: Map<string, AssistField>
  roles: AssistRole[]
  transitions: AssistTransition[]
  states: AssistState[]
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

export function parseLoose(raw: unknown): unknown {
  let cur = raw
  for (let i = 0; i < 4 && typeof cur === 'string'; i++) {
    try {
      cur = JSON.parse(cur)
    } catch {
      return null
    }
  }
  return cur
}

const asObj = (v: unknown): Record<string, unknown> => {
  const p = parseLoose(v)
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {}
}

export const idList = (v: unknown): string[] => {
  const p = parseLoose(v)
  return Array.isArray(p) ? p.map(String).filter(Boolean) : []
}

/** Field names a JSON condition reads: object keys and `field` / `parent_field` values. */
export function fieldsReferenced(json: unknown, known: Set<string>): string[] {
  const out = new Set<string>()
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || v == null) return
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
      return
    }
    if (typeof v !== 'object') return
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (known.has(k)) out.add(k)
      if ((k === 'field' || k === 'parent_field') && typeof x === 'string' && known.has(x))
        out.add(x)
      walk(x, depth + 1)
    }
  }
  walk(parseLoose(json), 0)
  return [...out]
}

function choicesOf(options: Record<string, unknown>): string[] {
  const list = Array.isArray(options.choices) ? options.choices : []
  const out: string[] = []
  for (const c of list.slice(0, 8)) {
    const t =
      c && typeof c === 'object' ? ((c as Row).text ?? (c as Row).value) : (c as unknown) || null
    if (t != null) out.push(String(t).replace(/^\$t:/, '').slice(0, 40))
  }
  return out
}

export function assistFieldsFromRows(rows: Row[]): Map<string, AssistField> {
  const known = new Set(rows.map((r) => String(r.field)))
  const out = new Map<string, AssistField>()
  for (const r of rows) {
    const field = String(r.field)
    const options = asObj(r.options)
    const dep = asObj(r.dependency_config)
    const drivers = new Set([
      ...fieldsReferenced(dep.cascade_filters, known),
      ...fieldsReferenced(r.conditions, known)
    ])
    drivers.delete(field)
    out.set(field, {
      field,
      label: cleanText(r.label, 80) ?? titleCase(field),
      type: String(r.type ?? 'string'),
      interface: typeof r.interface === 'string' ? r.interface : null,
      required: truthy(r.required),
      readonly: truthy(r.readonly),
      hidden: truthy(r.hidden),
      note: cleanText(r.note, 300),
      drivers: [...drivers],
      choices: choicesOf(options)
    })
  }
  return out
}

/** `record_fields` transition requirements, with the states they run between. */
export function transitionsFromRows(rows: Row[], stateLabel: Map<string, string>) {
  const out: AssistTransition[] = []
  for (const t of rows) {
    const fields: string[] = []
    const reqs = parseLoose(t.requirements)
    for (const e of Array.isArray(reqs) ? reqs : []) {
      const entry = e as { type?: unknown; optional?: unknown; fields?: unknown }
      if (entry?.type !== 'record_fields' || entry.optional === true) continue
      for (const f of Array.isArray(entry.fields) ? entry.fields : [])
        if (typeof f === 'string') fields.push(f)
    }
    out.push({
      label: cleanText(t.label, 60) ?? 'Move on',
      from: t.from_state == null ? null : (stateLabel.get(String(t.from_state)) ?? null),
      to: t.to_state == null ? null : (stateLabel.get(String(t.to_state)) ?? null),
      role_ids: idList(t.required_roles),
      fields
    })
  }
  return out
}

export async function loadAssistContext(collection: string): Promise<AssistContext> {
  const [fieldRows, lint, bindings, counts] = await Promise.all([
    db('nivaro_fields').where({ collection }) as Promise<Row[]>,
    cachedLintContext(collection),
    db('nivaro_workflow_bindings').where({ collection }).select('template') as Promise<Row[]>,
    db('nivaro_users')
      .where((w) => w.where('status', 'active').orWhereNull('status'))
      .whereNotNull('role')
      .groupBy('role')
      .select('role')
      .count({ n: '*' }) as Promise<Array<{ role: string; n: number | string }>>
  ])
  const templates = [...new Set(bindings.map((b) => String(b.template)).filter(Boolean))]
  const [stateRows, transitionRows] = templates.length
    ? await Promise.all([
        db('nivaro_workflow_states')
          .whereIn('template', templates)
          .select('id', 'key', 'label', 'template') as Promise<Row[]>,
        db('nivaro_workflow_transitions')
          .whereIn('template', templates)
          .select('label', 'from_state', 'to_state', 'required_roles', 'requirements') as Promise<
          Row[]
        >
      ])
    : [[], []]
  const stateLabel = new Map(
    stateRows.map((s) => [String(s.id), cleanText(s.label, 60) ?? String(s.key)])
  )
  const members = new Map(counts.map((c) => [String(c.role).toUpperCase(), Number(c.n)]))
  return {
    collection,
    fields: assistFieldsFromRows(fieldRows),
    roles: lint.roles.map((r) => ({
      id: r.id,
      name: r.name,
      admin: !!r.admin,
      can_write: r.can_write,
      writable_fields: r.writable_fields,
      members: members.get(r.id.toUpperCase()) ?? 0
    })),
    transitions: transitionsFromRows(transitionRows, stateLabel),
    states: stateRows.map((s) => ({
      pipeline: String(s.template),
      key: String(s.key),
      label: stateLabel.get(String(s.id)) ?? String(s.key)
    }))
  }
}

/** The configured model for one of the per-feature slots ('chat' reasons, 'generate' writes). */
export async function completeFor(kind: 'chat' | 'generate'): Promise<AiComplete | null> {
  const settings = await getAiModelSettings()
  const model = kind === 'chat' ? settings.chatModel : settings.generateModel
  const client = await getAiClient({ model })
  if (!client) return null
  return async ({ system, user, maxTokens }) => {
    const msg = await client.messages.create({
      model,
      max_tokens: maxTokens ?? 2000,
      system,
      messages: [{ role: 'user', content: user }]
    })
    return msg.content
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('\n')
      .trim()
  }
}

// ── Bundles ──────────────────────────────────────────────────────────────────

const str = (v: unknown, max = 4000): string | null =>
  typeof v === 'string' ? v.slice(0, max) : v == null ? null : null

/**
 * A layout bundle the editor sent (its unsaved draft), reduced to the columns
 * the assists read and checked for shape. Never written anywhere: it only
 * describes what the admin is looking at. Null when it does not look like a
 * bundle of `layout`.
 */
export function bundleFromBody(raw: unknown, layout: LayoutRow): LayoutBundle | null {
  const b = raw as { groups?: unknown; placements?: unknown; layout?: unknown; rev?: unknown }
  if (!b || typeof b !== 'object' || !Array.isArray(b.groups) || !Array.isArray(b.placements))
    return null
  if (b.groups.length > 600 || b.placements.length > 3000) return null
  const groups: GroupRow[] = []
  for (const g of b.groups as Row[]) {
    if (!g || typeof g.key !== 'string' || !g.key) return null
    groups.push({
      ...newGroup(
        g.key,
        typeof g.label === 'string' ? g.label : g.key,
        String(g.type ?? 'section'),
        null
      ),
      parent_key: typeof g.parent_key === 'string' ? g.parent_key : null,
      sort: Number(g.sort) || 0,
      is_collapsed: !!g.is_collapsed,
      visible_when: str(g.visible_when),
      hidden_for_roles: str(g.hidden_for_roles),
      locked_for_roles: str(g.locked_for_roles)
    })
  }
  const placements: PlacementRow[] = []
  for (const p of b.placements as Row[]) {
    if (!p || typeof p.field !== 'string' || !p.field) return null
    placements.push({
      ...newPlacement(p.field, typeof p.group_key === 'string' ? p.group_key : null),
      sort: Number(p.sort) || 0,
      label_override: str(p.label_override, 200),
      is_visible: p.is_visible !== false && p.is_visible !== 0,
      overrides: parseLoose(p.overrides) ?? null,
      lock_conditions: str(p.lock_conditions),
      widget_id: p.widget_id == null ? null : Number(p.widget_id)
    })
  }
  const l = (b.layout ?? {}) as Row
  const mergedLayout: LayoutRow = { ...layout }
  for (const k of ['conditions', 'record_conditions', 'default_values'] as const)
    if (k in l) mergedLayout[k] = l[k]
  return { layout: mergedLayout, groups, placements, rev: typeof b.rev === 'string' ? b.rev : '' }
}

// ── Facts per field ──────────────────────────────────────────────────────────

export const overridesOf = (p: PlacementRow) => asObj(p.overrides)

/** A placement of a real field the form renders as an input (no slots, widgets, paths). */
export function isFieldPlacement(p: PlacementRow): boolean {
  return (
    !p.field.startsWith('__') && p.widget_id == null && !p.field.includes('.') && !isCanvasSlot(p)
  )
}

export function isShown(p: PlacementRow): boolean {
  return p.is_visible !== false && overridesOf(p).hidden !== true
}

export function placementLabel(p: PlacementRow, ctx: AssistContext): string {
  const ov = overridesOf(p)
  return (
    cleanText(ov.label, 80) ??
    cleanText(p.label_override, 80) ??
    ctx.fields.get(p.field)?.label ??
    titleCase(p.field)
  )
}

export function helpTextOf(p: PlacementRow, ctx: AssistContext): string | null {
  return cleanText(overridesOf(p).note, 300) ?? ctx.fields.get(p.field)?.note ?? null
}

export function isRequired(p: PlacementRow, ctx: AssistContext): boolean {
  const ov = overridesOf(p)
  return 'required' in ov ? truthy(ov.required) : !!ctx.fields.get(p.field)?.required
}

/** The group and every group it sits in, innermost first. */
export function groupChain(bundle: LayoutBundle, key: string | null): GroupRow[] {
  const out: GroupRow[] = []
  const byKey = new Map(bundle.groups.map((g) => [g.key, g]))
  let cur = key ? byKey.get(key) : undefined
  for (let i = 0; cur && i < 8; i++) {
    out.push(cur)
    cur = cur.parent_key ? byKey.get(cur.parent_key) : undefined
  }
  return out
}

export function groupLabel(bundle: LayoutBundle, key: string | null): string {
  if (!key || key === UNGROUPED_KEY) return 'the ungrouped area'
  const g = bundle.groups.find((x) => x.key === key)
  return g ? cleanText(g.label, 80) || titleCase(g.key) : key
}

export function roleNames(ids: string[], ctx: AssistContext): string[] {
  const byId = new Map(ctx.roles.map((r) => [r.id.toUpperCase(), r.name]))
  return ids.map((id) => byId.get(id.toUpperCase()) ?? null).filter((n): n is string => !!n)
}

const list = (names: string[], max = 6) =>
  names.length <= max
    ? names.join(', ')
    : `${names.slice(0, max).join(', ')} and ${names.length - max} more`

/** "locked in Approved, Closed" / "locked for Viewer" from a placement's lock_conditions. */
export function lockSummary(p: PlacementRow, ctx: AssistContext): string[] {
  const conds = parseLoose(p.lock_conditions)
  if (!Array.isArray(conds)) return []
  const out: string[] = []
  for (const c of conds as Row[]) {
    if (c?.type === 'pipeline_state') {
      const keys = idList(c.state_keys)
      const labels = keys.map(
        (k) =>
          ctx.states.find(
            (s) => s.key === k && (c.pipeline_id == null || s.pipeline === String(c.pipeline_id))
          )?.label ?? k
      )
      out.push(labels.length ? `locked in ${list(labels)}` : 'locked in every state')
    } else if (c?.type === 'role') {
      const names = roleNames(idList(c.role_ids), ctx)
      out.push(names.length ? `locked for ${list(names)}` : 'locked for every role')
    }
  }
  return out
}

/** Plain sentences about one placed field: what the form and the rules actually do with it. */
export function factsForPlacement(
  bundle: LayoutBundle,
  p: PlacementRow,
  ctx: AssistContext
): string[] {
  const facts: string[] = []
  const f = ctx.fields.get(p.field)
  const ov = overridesOf(p)
  facts.push(isRequired(p, ctx) ? 'required on this form' : 'optional on this form')
  if (!isShown(p)) facts.push('hidden on this form')
  if (('readonly' in ov ? truthy(ov.readonly) : f?.readonly) === true) facts.push('read-only')
  facts.push(...lockSummary(p, ctx))
  for (const t of ctx.transitions) {
    if (!t.fields.includes(p.field)) continue
    const by = roleNames(t.role_ids, ctx)
    facts.push(
      `must be filled before "${t.label}"${t.from ? ` (from ${t.from})` : ''}${
        by.length ? `, run by ${list(by)}` : ''
      }`
    )
  }
  const chain = groupChain(bundle, p.group_key)
  for (const g of chain) {
    const hid = roleNames(idList(g.hidden_for_roles), ctx)
    if (hid.length) facts.push(`hidden from ${list(hid)} (section "${groupLabel(bundle, g.key)}")`)
    const locked = roleNames(idList(g.locked_for_roles), ctx)
    if (locked.length)
      facts.push(`read-only for ${list(locked)} (section "${groupLabel(bundle, g.key)}")`)
    if (g.visible_when && String(g.visible_when).trim() && String(g.visible_when) !== 'null')
      facts.push(
        `"${groupLabel(bundle, g.key)}" shows only when ${String(g.visible_when).slice(0, 160)}`
      )
  }
  const cannotWrite = ctx.roles
    .filter(
      (r) => !r.admin && r.can_write && r.writable_fields && !r.writable_fields.includes(p.field)
    )
    .map((r) => r.name)
  if (cannotWrite.length)
    facts.push(`roles that edit records but not this field: ${list(cannotWrite)}`)
  const defaults = asObj(bundle.layout.default_values)
  if (p.field in defaults) facts.push('new records get a preset value')
  return facts
}

/** Facts for every real field the layout places, keyed by field. */
export function fieldFacts(bundle: LayoutBundle, ctx: AssistContext): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const p of bundle.placements) {
    if (!isFieldPlacement(p) || out.has(p.field)) continue
    out.set(p.field, factsForPlacement(bundle, p, ctx))
  }
  return out
}

/** The roles in the prompt: who they are and what they may do, no people. */
export function rolesForPrompt(ctx: AssistContext) {
  return ctx.roles.slice(0, 60).map((r) => ({
    name: r.name,
    admin: r.admin || undefined,
    edits_records: r.can_write,
    members: r.members
  }))
}

export function workflowForPrompt(ctx: AssistContext) {
  return ctx.transitions.slice(0, 60).map((t) => ({
    move: t.label,
    from: t.from,
    to: t.to,
    run_by: roleNames(t.role_ids, ctx),
    needs: t.fields.slice(0, 20)
  }))
}
