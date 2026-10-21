import { db } from '../../db/index.js'
import { snapshotLayoutVersion } from '../layout-versions.js'
import { type AiComplete, asArray, cleanText, parseJsonLoose, titleCase } from './model.js'

/**
 * Layout review (#1920) + applying a finding (#1964).
 *
 * A review is two passes over one layout:
 *   1. Rules — counted, never guessed: a step or section holding too many
 *      fields, a required field inside a collapsed section, a required field
 *      the layout hides, required/rule-bound fields with no help text, two
 *      fields showing the same label, empty sections.
 *   2. The model (optional) — reads the same field list and answers only:
 *      which labels are confusing (with a better one) and help
 *      text for the fields pass 1 flagged — plus, for a crowded step or
 *      section, how to divide it (#2587, checked in layout-split.ts). Its
 *      answer is data: every field it names must be on the layout, every
 *      text is capped, the rest is dropped.
 *
 * Each finding names its field and carries a `fix` the admin can apply. A fix
 * only ever touches THIS layout's rows (its groups and field assignments —
 * label and help text go into the assignment's per-layout overrides), so the
 * layout version captured before the write undoes it from Version history.
 */

export const STEP_FIELD_LIMIT = 15
export const SECTION_FIELD_LIMIT = 12
const MAX_FINDINGS = 60
const HELP_CANDIDATES = 25
const LABEL_MAX = 80
const HELP_MAX = 300

export interface LayoutGroupInfo {
  id: number
  key: string
  label: string
  type: string
  is_collapsed: boolean
  container_id: number | null
  sort: number
  has_content: boolean
}

export interface LayoutFieldInfo {
  field: string
  group_key: string | null
  sort: number
  label: string
  type: string
  interface: string | null
  required: boolean
  hidden: boolean
  readonly: boolean
  has_help: boolean
  has_rules: boolean
  choices: string[]
  /** relation-path (dotted) assignments are display-only — counted, never checked. */
  derived: boolean
}

export interface LayoutModel {
  layout: { id: number; name: string; collection: string; layout_type: string }
  groups: LayoutGroupInfo[]
  fields: LayoutFieldInfo[]
}

export type LayoutFix =
  | { type: 'expand_section'; group_id: number }
  | { type: 'move_field'; field: string; to_group_key: string }
  | { type: 'help_text'; field: string; text: string }
  | { type: 'label'; field: string; text: string }
  | { type: 'show_field'; field: string }

export type FindingKind =
  | 'too_many_fields'
  | 'required_in_collapsed'
  | 'required_hidden'
  | 'missing_help'
  | 'duplicate_label'
  | 'confusing_label'
  | 'empty_section'

export interface LayoutFinding {
  id: string
  kind: FindingKind
  severity: 'warn' | 'info'
  source: 'rules' | 'ai'
  field: string | null
  field_label: string | null
  group: { id: number | null; key: string | null; label: string } | null
  message: string
  suggestion: string
  fix: LayoutFix | null
}

// ── Loading ───────────────────────────────────────────────────────────────────

function parseDeep(v: unknown): Record<string, unknown> | null {
  let cur: unknown = v
  for (let i = 0; i < 12 && typeof cur === 'string'; i++) {
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

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

function jsonValue(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

function hasRules(row: Record<string, unknown>, lockConditions: unknown): boolean {
  const vr = jsonValue(row.validation_rules)
  if (Array.isArray(vr) ? vr.length > 0 : vr && typeof vr === 'object' && Object.keys(vr).length)
    return true
  const dep = parseDeep(row.dependency_config)
  if (dep && Array.isArray(dep.cascade_filters) && dep.cascade_filters.length > 0) return true
  return !!lockConditions && String(lockConditions).trim() !== '' && String(lockConditions) !== '[]'
}

function choicesOf(options: Record<string, unknown> | null): string[] {
  const list = asArray(options?.choices)
  const out: string[] = []
  for (const c of list) {
    if (c && typeof c === 'object') {
      const t = (c as { text?: unknown; value?: unknown }).text ?? (c as { value?: unknown }).value
      if (t != null) out.push(String(t).replace(/^\$t:/, ''))
    } else if (c != null) out.push(String(c))
    if (out.length >= 8) break
  }
  return out
}

/** One layout as the review sees it. Null when the layout does not exist. */
export async function loadLayoutModel(layoutId: number): Promise<LayoutModel | null> {
  const layout = (await db('nivaro_collection_layouts').where({ id: layoutId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!layout) return null
  const collection = String(layout.collection)
  const [groups, assignments, fieldRows] = await Promise.all([
    db('nivaro_field_groups').where({ layout_id: layoutId }).orderBy('sort') as Promise<
      Array<Record<string, unknown>>
    >,
    db('nivaro_layout_field_assignments').where({ layout_id: layoutId }).orderBy('sort') as Promise<
      Array<Record<string, unknown>>
    >,
    db('nivaro_fields').where({ collection }) as Promise<Array<Record<string, unknown>>>
  ])
  const byField = new Map(fieldRows.map((r) => [String(r.field), r]))

  const fields: LayoutFieldInfo[] = []
  for (const a of assignments) {
    const name = String(a.field ?? '')
    if (!name || /^__.*__$/.test(name) || a.widget_id != null) continue
    const derived = name.includes('.')
    const row = byField.get(name) ?? {}
    const ov = parseDeep(a.overrides) ?? {}
    const options = parseDeep(row.options)
    const label =
      (cleanText(ov.label, LABEL_MAX) ??
        cleanText(a.label_override, LABEL_MAX) ??
        cleanText(row.label, LABEL_MAX) ??
        titleCase(derived ? name.split('.').pop() || name : name)) ||
      name
    const required = 'required' in ov ? truthy(ov.required) : truthy(row.required)
    const hidden =
      a.is_visible === 0 ||
      a.is_visible === false ||
      ('hidden' in ov ? truthy(ov.hidden) : truthy(row.hidden))
    fields.push({
      field: name,
      group_key: a.group_key == null ? null : String(a.group_key),
      sort: Number(a.sort ?? 0),
      label,
      type: String(row.type ?? (derived ? 'relation-path' : 'string')),
      interface: (ov.interface as string) ?? (row.interface as string) ?? null,
      required,
      hidden,
      readonly: derived || ('readonly' in ov ? truthy(ov.readonly) : truthy(row.readonly)),
      has_help: !!(cleanText(ov.note, 2000) ?? cleanText(row.note, 2000)),
      has_rules: hasRules(row, a.lock_conditions),
      choices: choicesOf(options),
      derived
    })
  }

  return {
    layout: {
      id: layoutId,
      name: String(layout.name ?? ''),
      collection,
      layout_type: String(layout.layout_type ?? 'grouped')
    },
    groups: groups.map((g) => ({
      id: Number(g.id),
      key: String(g.key),
      label: cleanText(g.label, LABEL_MAX) ?? titleCase(String(g.key)),
      type: String(g.type ?? 'section'),
      is_collapsed: truthy(g.is_collapsed),
      container_id: g.container_id == null ? null : Number(g.container_id),
      sort: Number(g.sort ?? 0),
      has_content: !!cleanText(g.content, 10)
    })),
    fields
  }
}

// ── Pass 1: rules ─────────────────────────────────────────────────────────────

const FIELD_GROUP_TYPES = new Set(['section', 'tab'])

function groupRef(g: LayoutGroupInfo | null) {
  return g ? { id: g.id, key: g.key, label: g.label } : null
}

/** Fields that render (visible, real), grouped by group key ('' = ungrouped). */
function visibleByGroup(model: LayoutModel): Map<string, LayoutFieldInfo[]> {
  const out = new Map<string, LayoutFieldInfo[]>()
  for (const f of model.fields) {
    if (f.hidden) continue
    const k = f.group_key ?? ''
    const list = out.get(k) ?? []
    list.push(f)
    out.set(k, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.sort - b.sort)
  return out
}

/** Candidates for help text: fields a person must get right with no hint. */
export function helpCandidates(model: LayoutModel): LayoutFieldInfo[] {
  return model.fields
    .filter((f) => !f.hidden && !f.readonly && !f.derived && !f.has_help)
    .filter((f) => f.required || f.has_rules)
    .slice(0, HELP_CANDIDATES)
}

export function reviewLayoutRules(model: LayoutModel): LayoutFinding[] {
  const findings: LayoutFinding[] = []
  const groupsByKey = new Map(model.groups.map((g) => [g.key, g]))
  const byGroup = visibleByGroup(model)
  const hasTabs = model.groups.some((g) => g.type === 'tab')

  // Too many fields on one step / section.
  for (const [key, list] of byGroup) {
    const g = key ? (groupsByKey.get(key) ?? null) : null
    if (key && (!g || !FIELD_GROUP_TYPES.has(g.type))) continue
    const isStep = g?.type === 'tab'
    if (!g && !hasTabs) continue // a plain form with no sections has nowhere to move to
    const limit = isStep ? STEP_FIELD_LIMIT : SECTION_FIELD_LIMIT
    if (list.length <= limit) continue
    const overflow = list[limit]
    // The sibling with the most room: same kind of group, same container.
    const siblings = model.groups
      .filter((s) => g && s.id !== g.id && s.type === g.type && s.container_id === g.container_id)
      .map((s) => ({ s, n: (byGroup.get(s.key) ?? []).length }))
      .filter((x) => x.n < (isStep ? STEP_FIELD_LIMIT : SECTION_FIELD_LIMIT))
      .sort((a, b) => a.n - b.n || a.s.sort - b.s.sort)
    const target = siblings[0]?.s ?? null
    const where = g ? `${isStep ? 'Step' : 'Section'} "${g.label}"` : 'The ungrouped area'
    findings.push({
      id: `too_many_fields:${key || '_'}`,
      kind: 'too_many_fields',
      severity: 'warn',
      source: 'rules',
      field: overflow.field,
      field_label: overflow.label,
      group: groupRef(g),
      message: `${where} holds ${list.length} fields — more than ${limit} is hard to scan.`,
      suggestion: target
        ? `Move "${overflow.label}" to "${target.label}" (${(byGroup.get(target.key) ?? []).length} fields), or split the ${isStep ? 'step' : 'section'}.`
        : `Split the ${isStep ? 'step' : 'section'} into two, starting at "${overflow.label}".`,
      fix: target ? { type: 'move_field', field: overflow.field, to_group_key: target.key } : null
    })
  }

  for (const f of model.fields) {
    if (f.derived || f.readonly || !f.required) continue
    const g = f.group_key ? (groupsByKey.get(f.group_key) ?? null) : null
    if (f.hidden) {
      findings.push({
        id: `required_hidden:${f.field}`,
        kind: 'required_hidden',
        severity: 'warn',
        source: 'rules',
        field: f.field,
        field_label: f.label,
        group: groupRef(g),
        message: `"${f.label}" is required but this layout hides it — nobody can fill it in here.`,
        suggestion: `Show "${f.label}" on this layout.`,
        fix: { type: 'show_field', field: f.field }
      })
      continue
    }
    if (g?.is_collapsed) {
      findings.push({
        id: `required_in_collapsed:${f.field}`,
        kind: 'required_in_collapsed',
        severity: 'warn',
        source: 'rules',
        field: f.field,
        field_label: f.label,
        group: groupRef(g),
        message: `"${f.label}" is required but sits in "${g.label}", which starts collapsed.`,
        suggestion: `Open "${g.label}" by default so the field is seen.`,
        fix: { type: 'expand_section', group_id: g.id }
      })
    }
  }

  for (const f of helpCandidates(model)) {
    const g = f.group_key ? (groupsByKey.get(f.group_key) ?? null) : null
    findings.push({
      id: `missing_help:${f.field}`,
      kind: 'missing_help',
      severity: 'info',
      source: 'rules',
      field: f.field,
      field_label: f.label,
      group: groupRef(g),
      message: `"${f.label}" is ${f.required ? 'required' : 'checked by rules'} and has no help text.`,
      suggestion: 'Add a one-line hint saying what belongs here.',
      fix: null
    })
  }

  // Two visible fields showing the same label.
  const seen = new Map<string, LayoutFieldInfo>()
  for (const f of model.fields) {
    if (f.hidden) continue
    const k = f.label.trim().toLowerCase()
    const first = seen.get(k)
    if (!first) {
      seen.set(k, f)
      continue
    }
    const g = f.group_key ? (groupsByKey.get(f.group_key) ?? null) : null
    findings.push({
      id: `duplicate_label:${f.field}`,
      kind: 'duplicate_label',
      severity: 'warn',
      source: 'rules',
      field: f.field,
      field_label: f.label,
      group: groupRef(g),
      message: `"${f.label}" is also the label of ${first.field} — people cannot tell them apart.`,
      suggestion: 'Give one of them a more specific label.',
      fix: null
    })
  }

  for (const g of model.groups) {
    if (!FIELD_GROUP_TYPES.has(g.type) || g.has_content) continue
    const hasAny = model.fields.some((f) => f.group_key === g.key)
    const hasChild = model.groups.some((c) => c.container_id === g.id)
    if (hasAny || hasChild) continue
    findings.push({
      id: `empty_section:${g.key}`,
      kind: 'empty_section',
      severity: 'info',
      source: 'rules',
      field: null,
      field_label: null,
      group: groupRef(g),
      message: `"${g.label}" has no fields.`,
      suggestion: 'Remove the section or move fields into it.',
      fix: null
    })
  }

  return findings.slice(0, MAX_FINDINGS)
}

// ── Pass 2: the model ─────────────────────────────────────────────────────────

export interface AiLayoutAnswer {
  help: Map<string, string>
  labels: Array<{ field: string; problem: string; suggested_label: string }>
  /** group key → the model's raw parts for a crowded group (#2587); layout-split validates them. */
  splits: Map<string, unknown>
}

/** A crowded step or section the model is asked to divide (#2587). */
export interface SplitWanted {
  group: string
  label: string
  parts: number
  fields: string[]
}

const LAYOUT_SYSTEM = `You review a data-entry form for usability. You get the form's fields as JSON.
Answer with ONE JSON object and nothing else:
{"labels":[{"field":"<field key>","problem":"<why the label confuses>","suggested_label":"<better label, <=40 chars>"}],
 "help":[{"field":"<field key>","text":"<one sentence of help text, <=160 chars>"}]}
When the input has split_wanted, also answer "splits":[{"group":"<group key>","parts":[{"label":"<short name, <=40 chars>","fields":["<field key>",...]}]}] — divide each listed group's fields into about the given number of parts of related fields, every listed field exactly once, keeping the form's order where it makes sense.
Rules: only use field keys from the input. "labels" lists at most 8 labels that are genuinely unclear (jargon, abbreviations, machine names, ambiguous pairs); an empty list is fine. "help" covers ONLY the fields listed under help_wanted. Help text tells a person what to enter and why, in plain words, never repeating the label.`

export function buildLayoutPrompt(
  model: LayoutModel,
  wanted: LayoutFieldInfo[],
  splitWanted: SplitWanted[] = []
): string {
  const groupLabel = new Map(model.groups.map((g) => [g.key, g.label]))
  const fields = model.fields
    .filter((f) => !f.hidden)
    .slice(0, 150)
    .map((f) => ({
      field: f.field,
      label: f.label,
      type: f.type,
      section: f.group_key ? (groupLabel.get(f.group_key) ?? f.group_key) : null,
      required: f.required || undefined,
      choices: f.choices.length ? f.choices : undefined
    }))
  return JSON.stringify({
    collection: model.layout.collection,
    layout: model.layout.name,
    fields,
    help_wanted: wanted.map((f) => f.field),
    ...(splitWanted.length
      ? {
          split_wanted: splitWanted.map((s) => ({
            group: s.group,
            label: s.label,
            parts: s.parts,
            fields: s.fields
          }))
        }
      : {})
  })
}

/** Parse + validate the model's answer against the layout. */
export function parseLayoutAnswer(
  text: string,
  model: LayoutModel,
  wanted: LayoutFieldInfo[]
): AiLayoutAnswer {
  const parsed = parseJsonLoose(text) ?? {}
  const onLayout = new Set(model.fields.filter((f) => !f.hidden).map((f) => f.field))
  const wantSet = new Set(wanted.map((f) => f.field))
  const help = new Map<string, string>()
  for (const h of asArray(parsed.help)) {
    const o = h as { field?: unknown; text?: unknown }
    const field = typeof o?.field === 'string' ? o.field : ''
    const t = cleanText(o?.text, HELP_MAX)
    if (field && t && wantSet.has(field)) help.set(field, t)
  }
  const labels: AiLayoutAnswer['labels'] = []
  const seen = new Set<string>()
  for (const l of asArray(parsed.labels)) {
    const o = l as { field?: unknown; problem?: unknown; suggested_label?: unknown }
    const field = typeof o?.field === 'string' ? o.field : ''
    const suggested = cleanText(o?.suggested_label, LABEL_MAX)
    if (!field || !suggested || !onLayout.has(field) || seen.has(field)) continue
    const current = model.fields.find((f) => f.field === field)
    if (current && current.label.trim().toLowerCase() === suggested.toLowerCase()) continue
    seen.add(field)
    labels.push({
      field,
      problem: cleanText(o?.problem, 200) ?? 'The label is unclear.',
      suggested_label: suggested
    })
    if (labels.length >= 8) break
  }
  // Splits stay raw here: layout-split checks each against the group's fields.
  const splits = new Map<string, unknown>()
  for (const sp of asArray(parsed.splits)) {
    const o = sp as { group?: unknown; parts?: unknown }
    if (typeof o?.group === 'string' && Array.isArray(o.parts)) splits.set(o.group, o.parts)
  }
  return { help, labels, splits }
}

/** Fold the model's answer into the rule findings. */
export function mergeAiFindings(
  findings: LayoutFinding[],
  model: LayoutModel,
  answer: AiLayoutAnswer
): LayoutFinding[] {
  const out = findings.map((f) => {
    if (f.kind === 'missing_help' && f.field && answer.help.has(f.field)) {
      const text = answer.help.get(f.field) as string
      return {
        ...f,
        suggestion: `Help text: "${text}"`,
        fix: { type: 'help_text', field: f.field, text } as LayoutFix
      }
    }
    return f
  })
  const groupsByKey = new Map(model.groups.map((g) => [g.key, g]))
  for (const l of answer.labels) {
    const dup = out.find((f) => f.kind === 'duplicate_label' && f.field === l.field)
    const fix: LayoutFix = { type: 'label', field: l.field, text: l.suggested_label }
    if (dup) {
      dup.suggestion = `Rename to "${l.suggested_label}".`
      dup.fix = fix
      continue
    }
    const f = model.fields.find((x) => x.field === l.field)
    if (!f) continue
    const g = f.group_key ? (groupsByKey.get(f.group_key) ?? null) : null
    out.push({
      id: `confusing_label:${l.field}`,
      kind: 'confusing_label',
      severity: 'info',
      source: 'ai',
      field: l.field,
      field_label: f.label,
      group: groupRef(g),
      message: `"${f.label}": ${l.problem}`,
      suggestion: `Rename to "${l.suggested_label}".`,
      fix
    })
  }
  return out
}

export async function reviewLayout(
  model: LayoutModel,
  complete: AiComplete | null,
  /** Crowded groups to ask the model to divide, given the rule findings (#2587). */
  splitWanted: (findings: LayoutFinding[]) => SplitWanted[] = () => []
): Promise<{
  findings: LayoutFinding[]
  ai_used: boolean
  ai_error: string | null
  splits: Map<string, unknown>
}> {
  const findings = reviewLayoutRules(model)
  const none = new Map<string, unknown>()
  if (!complete) return { findings, ai_used: false, ai_error: null, splits: none }
  const wanted = helpCandidates(model)
  const splitAsk = splitWanted(findings)
  try {
    const text = await complete({
      system: LAYOUT_SYSTEM,
      user: buildLayoutPrompt(model, wanted, splitAsk),
      maxTokens: splitAsk.length ? 4000 : 2500
    })
    const answer = parseLayoutAnswer(text, model, wanted)
    return {
      findings: mergeAiFindings(findings, model, answer),
      ai_used: true,
      ai_error: null,
      splits: answer.splits
    }
  } catch (err) {
    return {
      findings,
      ai_used: false,
      ai_error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      splits: none
    }
  }
}

// ── Applying a fix (#1964) ────────────────────────────────────────────────────

export type LayoutFixPlan =
  | { ok: false; error: string }
  | {
      ok: true
      description: string
      op:
        | { kind: 'group'; group_id: number; patch: Record<string, unknown> }
        | {
            kind: 'assignment'
            field: string
            patch: Record<string, unknown>
            overrides?: Record<string, unknown | undefined>
          }
    }

/**
 * Check a fix against the layout as it is NOW (the review may be stale) and
 * say exactly what it writes. Pure — the route executes the plan.
 */
export function planLayoutFix(
  model: LayoutModel,
  fix: unknown,
  assignmentSorts: Map<string, number> = new Map()
): LayoutFixPlan {
  const f = fix as Record<string, unknown> | null
  if (!f || typeof f.type !== 'string') return { ok: false, error: 'fix is required' }
  const fieldOf = (name: unknown) =>
    typeof name === 'string' ? model.fields.find((x) => x.field === name) : undefined
  switch (f.type) {
    case 'expand_section': {
      const g = model.groups.find((x) => x.id === Number(f.group_id))
      if (!g) return { ok: false, error: 'That section is not on this layout any more' }
      if (!g.is_collapsed) return { ok: false, error: `"${g.label}" already starts open` }
      return {
        ok: true,
        description: `open "${g.label}" by default`,
        op: { kind: 'group', group_id: g.id, patch: { is_collapsed: 0 } }
      }
    }
    case 'move_field': {
      const field = fieldOf(f.field)
      if (!field) return { ok: false, error: 'That field is not on this layout any more' }
      const g = model.groups.find((x) => x.key === f.to_group_key)
      if (!g || !FIELD_GROUP_TYPES.has(g.type))
        return { ok: false, error: 'The target section is not on this layout' }
      if (field.group_key === g.key)
        return { ok: false, error: `"${field.label}" is already there` }
      const maxSort = Math.max(
        0,
        ...model.fields.filter((x) => x.group_key === g.key).map((x) => x.sort),
        assignmentSorts.get(g.key) ?? 0
      )
      return {
        ok: true,
        description: `move "${field.label}" to "${g.label}"`,
        op: {
          kind: 'assignment',
          field: field.field,
          patch: { group_key: g.key, sort: maxSort + 1 }
        }
      }
    }
    case 'help_text': {
      const field = fieldOf(f.field)
      if (!field) return { ok: false, error: 'That field is not on this layout any more' }
      const text = cleanText(f.text, HELP_MAX)
      if (!text) return { ok: false, error: 'Help text is empty' }
      return {
        ok: true,
        description: `add help text to "${field.label}"`,
        op: { kind: 'assignment', field: field.field, patch: {}, overrides: { note: text } }
      }
    }
    case 'label': {
      const field = fieldOf(f.field)
      if (!field) return { ok: false, error: 'That field is not on this layout any more' }
      const text = cleanText(f.text, LABEL_MAX)
      if (!text) return { ok: false, error: 'Label is empty' }
      return {
        ok: true,
        description: `rename "${field.label}" to "${text}" on this layout`,
        op: { kind: 'assignment', field: field.field, patch: {}, overrides: { label: text } }
      }
    }
    case 'show_field': {
      const field = fieldOf(f.field)
      if (!field) return { ok: false, error: 'That field is not on this layout any more' }
      if (!field.hidden) return { ok: false, error: `"${field.label}" is already shown` }
      return {
        ok: true,
        description: `show "${field.label}" on this layout`,
        op: {
          kind: 'assignment',
          field: field.field,
          patch: { is_visible: 1 },
          overrides: { hidden: false }
        }
      }
    }
    default:
      return { ok: false, error: `Unknown fix type "${String(f.type)}"` }
  }
}

/**
 * Snapshot the layout, then write the plan. Returns the id of the version a
 * restore goes back to (the state just before this change).
 */
export async function executeLayoutFix(
  layoutId: number,
  plan: Extract<LayoutFixPlan, { ok: true }>,
  userId: string | null
): Promise<{ undo_version_id: number | null }> {
  await snapshotLayoutVersion(layoutId, `before AI suggestion: ${plan.description}`, userId)
  const latest = (await db('nivaro_layout_versions')
    .where({ layout_id: layoutId })
    .orderBy('version', 'desc')
    .first('id')) as { id: number } | undefined

  const op = plan.op
  if (op.kind === 'group') {
    await db('nivaro_field_groups').where({ id: op.group_id, layout_id: layoutId }).update(op.patch)
  } else {
    const row = (await db('nivaro_layout_field_assignments')
      .where({ layout_id: layoutId, field: op.field })
      .first('id', 'overrides')) as { id: number; overrides: unknown } | undefined
    if (!row) throw new Error('The field is not on this layout any more')
    const patch: Record<string, unknown> = { ...op.patch }
    if (op.overrides) {
      const merged = { ...(parseDeep(row.overrides) ?? {}) }
      for (const [k, v] of Object.entries(op.overrides)) {
        if (v === undefined) delete merged[k]
        else merged[k] = v
      }
      patch.overrides = JSON.stringify(merged)
    }
    await db('nivaro_layout_field_assignments').where({ id: row.id }).update(patch)
  }
  return { undo_version_id: latest?.id ?? null }
}
