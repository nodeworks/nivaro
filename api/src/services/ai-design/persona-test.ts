import type { GroupRow, LayoutBundle, PlacementRow } from '../layout-ops-apply.js'
import { HEADER_GROUP_KEY, UNGROUPED_KEY } from '../layout-ops-apply.js'
import { asArray, cleanText, parseJsonLoose, titleCase } from './model.js'

/**
 * Role persona test (#2685): the model plays a person in a role and fills a
 * NEW record through the form step by step, then says which steps, labels
 * and fields would confuse that person. Nothing is written.
 *
 * The walkthrough is built here from the layout bundle (the new-record order:
 * steps of a steps container, else sections top to bottom, then Ungrouped),
 * filtered by what the role may see and edit — the same field permissions
 * Preview as role uses. Rule checks that need no model (a required field the
 * role cannot see or edit, an empty step, a machine-like label, two fields
 * with one label) run first and always; the model adds its reading on top.
 * Only metadata goes to the model: labels, types, help text, choice labels,
 * layout structure — never stored values.
 *
 * SEAM: the new-record walkthrough (#2648) may later provide the step order;
 * `buildWalkthrough` is the minimal iterator until then.
 */

export interface PersonaField {
  field: string
  label: string
  type: string
  interface: string | null
  note: string | null
  required: boolean
  readonly: boolean
  hidden: boolean
  has_default: boolean
  choices: string[]
  /** "shown only when …" — the section or field has conditions. */
  conditional: boolean
}

export interface PersonaStep {
  key: string
  label: string
  kind: 'step' | 'section' | 'ungrouped'
  /** Text blocks shown on this step (instructions). */
  text: string[]
  fields: PersonaField[]
  /** Sections the role never sees on this step (hidden_for_roles). */
  hidden_sections: string[]
}

export interface FieldMeta {
  field: string
  label: string | null
  type: string | null
  interface: string | null
  note: string | null
  required: boolean
  readonly: boolean
  options: unknown
}

export interface RoleAccess {
  name: string
  /** null = every field */
  hidden: Set<string>
  readonly: Set<string>
  can_create: boolean
}

export type PersonaSeverity = 'blocking' | 'confusing' | 'minor'

export interface PersonaFinding {
  id: string
  /** `field:<key>` or `group:<key>` (the canvas target the mark pins to). */
  target: string
  step: string | null
  severity: PersonaSeverity
  problem: string
  suggestion: string | null
  /** A clearer label the editor may apply (field findings only). */
  better_label: string | null
  source: 'rules' | 'ai'
}

export interface PersonaStepNote {
  step: string
  feeling: 'clear' | 'unsure' | 'stuck'
  note: string
}

const MAX_FIELDS_PER_STEP = 60
const MAX_FINDINGS = 30

function overridesOf(p: PlacementRow): Record<string, unknown> {
  let v: unknown = p.overrides
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    try {
      v = JSON.parse(v)
    } catch {
      return {}
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function jsonList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v !== 'string' || !v.trim()) return []
  try {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return v.split(',').map((s) => s.trim())
  }
}

function choiceLabels(options: unknown): string[] {
  let o: unknown = options
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o)
    } catch {
      return []
    }
  }
  const choices = asArray((o as { choices?: unknown } | null)?.choices)
  return choices
    .map((c) =>
      typeof c === 'string'
        ? c
        : cleanText((c as { text?: unknown })?.text ?? (c as { value?: unknown })?.value, 60)
    )
    .filter((t): t is string => !!t)
    .map((t) => t.replace(/^\$t:/, ''))
    .slice(0, 15)
}

const isFieldPlacement = (p: PlacementRow) =>
  !p.field.startsWith('__') && p.widget_id == null && p.group_key !== HEADER_GROUP_KEY

/** Every field a role meets, in the order a new record walks through them. */
export function buildWalkthrough(
  bundle: LayoutBundle,
  fields: Map<string, FieldMeta>,
  role: RoleAccess,
  roleId: string | null
): PersonaStep[] {
  const groups = bundle.groups
  const bySort = (a: { sort: number }, b: { sort: number }) => a.sort - b.sort
  const childrenOf = (key: string | null) =>
    groups.filter((g) => (g.parent_key ?? null) === key).sort(bySort)
  const defaults = (() => {
    let v: unknown = bundle.layout.default_values
    if (typeof v === 'string') {
      try {
        v = JSON.parse(v)
      } catch {
        v = null
      }
    }
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  })()
  const hiddenFor = (g: GroupRow) =>
    roleId != null && jsonList(g.hidden_for_roles).map(String).includes(roleId)

  const fieldsIn = (groupKey: string | null, conditional: boolean): PersonaField[] =>
    bundle.placements
      .filter((p) => (p.group_key ?? null) === groupKey && isFieldPlacement(p))
      .sort(bySort)
      .flatMap((p) => {
        const ov = overridesOf(p)
        const meta = fields.get(p.field)
        const hiddenOnForm = p.is_visible === false || ov.hidden === true
        const label =
          (typeof ov.label === 'string' && ov.label.trim()) ||
          p.label_override ||
          meta?.label ||
          titleCase(p.field)
        const required = ov.required !== undefined ? ov.required === true : !!meta?.required
        return [
          {
            field: p.field,
            label: String(label),
            type: meta?.type ?? 'unknown',
            interface:
              (typeof ov.interface === 'string' && ov.interface) || meta?.interface || null,
            note:
              cleanText(typeof ov.note === 'string' ? ov.note : meta?.note, 240) ??
              cleanText(meta?.note, 240),
            required,
            readonly: role.readonly.has(p.field) || ov.readonly === true || meta?.readonly === true,
            hidden: hiddenOnForm || role.hidden.has(p.field),
            has_default: defaults[p.field] !== undefined && defaults[p.field] !== null,
            choices: choiceLabels(meta?.options),
            conditional: conditional || !!(p.lock_conditions && String(p.lock_conditions).trim())
          }
        ]
      })

  /** One step: the group's own fields, then its child sections' (one level down). */
  const stepOf = (g: GroupRow, kind: PersonaStep['kind']): PersonaStep => {
    const step: PersonaStep = {
      key: g.key,
      label: g.label || titleCase(g.key),
      kind,
      text: [],
      fields: [],
      hidden_sections: []
    }
    const visit = (grp: GroupRow, depth: number) => {
      if (hiddenFor(grp)) {
        step.hidden_sections.push(grp.label || grp.key)
        return
      }
      if (grp.type === 'content' || (grp.content && !fieldsIn(grp.key, false).length)) {
        const t = cleanText(String(grp.content ?? '').replace(/<[^>]+>/g, ' '), 300)
        if (t) step.text.push(t)
      }
      step.fields.push(...fieldsIn(grp.key, !!grp.visible_when))
      if (depth < 3) for (const c of childrenOf(grp.key)) visit(c, depth + 1)
    }
    visit(g, 0)
    step.fields = step.fields.slice(0, MAX_FIELDS_PER_STEP)
    return step
  }

  const steps: PersonaStep[] = []
  for (const g of childrenOf(null)) {
    if (g.key === HEADER_GROUP_KEY) continue
    if (g.key === UNGROUPED_KEY) {
      const loose = fieldsIn(null, false)
      if (loose.length)
        steps.push({
          key: UNGROUPED_KEY,
          label: 'Fields outside any section',
          kind: 'ungrouped',
          text: [],
          fields: loose,
          hidden_sections: []
        })
      continue
    }
    if (g.type === 'container') {
      for (const tab of childrenOf(g.key)) if (!hiddenFor(tab)) steps.push(stepOf(tab, 'step'))
      continue
    }
    if (hiddenFor(g)) continue
    steps.push(stepOf(g, g.type === 'tab' ? 'step' : 'section'))
  }
  // A bundle without the Ungrouped position row still shows its loose fields last.
  if (!groups.some((g) => g.key === UNGROUPED_KEY)) {
    const loose = fieldsIn(null, false)
    if (loose.length)
      steps.push({
        key: UNGROUPED_KEY,
        label: 'Fields outside any section',
        kind: 'ungrouped',
        text: [],
        fields: loose,
        hidden_sections: []
      })
  }
  return steps
}

const MACHINE_LABEL = /^[a-z0-9]+(_[a-z0-9]+)+$|^[a-z]+[A-Z][A-Za-z]*$/

/** Checks that need no model — the shared validation a walkthrough runs. */
export function walkthroughRuleFindings(steps: PersonaStep[], role: RoleAccess): PersonaFinding[] {
  const out: PersonaFinding[] = []
  const add = (
    f: Omit<PersonaFinding, 'id' | 'source' | 'better_label'> & { better_label?: string | null }
  ) =>
    out.push({
      ...f,
      better_label: f.better_label ?? null,
      id: `${f.target}:${out.length}`,
      source: 'rules'
    })
  if (!role.can_create)
    out.push({
      id: 'role:create',
      target: 'form',
      step: null,
      severity: 'blocking',
      problem: `${role.name} may not create records here at all.`,
      suggestion: 'Give the role create permission on this collection, or test another role.',
      better_label: null,
      source: 'rules'
    })
  for (const s of steps) {
    const visible = s.fields.filter((f) => !f.hidden)
    if (s.fields.length > 0 && visible.length === 0)
      add({
        target: `group:${s.key}`,
        step: s.key,
        severity: 'confusing',
        problem: `"${s.label}" shows ${role.name} nothing to fill in.`,
        suggestion: 'Hide this step for the role, or move fields they can use into it.'
      })
    const seen = new Map<string, string>()
    for (const f of s.fields) {
      if (f.required && !f.has_default && (f.hidden || f.readonly))
        add({
          target: `field:${f.field}`,
          step: s.key,
          severity: 'blocking',
          problem: `"${f.label}" is required, but ${role.name} ${
            f.hidden ? 'cannot see it' : 'cannot change it'
          } — a new record cannot be saved.`,
          suggestion: 'Give it a default value for new records, or make it optional for this role.'
        })
      if (f.hidden) continue
      if (MACHINE_LABEL.test(f.label))
        add({
          target: `field:${f.field}`,
          step: s.key,
          severity: 'minor',
          problem: `"${f.label}" reads like a database name.`,
          suggestion: 'Give it a label in plain words.',
          better_label: titleCase(f.label)
        })
      const k = f.label.trim().toLowerCase()
      const other = seen.get(k)
      if (other)
        add({
          target: `field:${f.field}`,
          step: s.key,
          severity: 'confusing',
          problem: `Two fields on "${s.label}" are both called "${f.label}".`,
          suggestion: `Rename one of them so ${role.name} can tell them apart.`
        })
      else seen.set(k, f.field)
    }
  }
  return out
}

export const PERSONA_SYSTEM = `You play a person who works in a given role and has just opened a NEW record form for the first time. Walk through the steps in order as that person would: read each label, help text and choice, and decide what you would enter. You never see stored data; imagine plausible values.
Then report what would slow you down or make you guess. Answer with ONE JSON object and nothing else:
{"summary":"<two sentences, as the person>","steps":[{"step":"<step key>","feeling":"clear"|"unsure"|"stuck","note":"<one sentence>"}],"findings":[{"target":"field:<field key>"|"group:<step or section key>","severity":"blocking"|"confusing"|"minor","problem":"<one sentence in plain words>","suggestion":"<one sentence>","better_label":"<a clearer label, field findings only, optional>"}]}
Rules: use only step keys and field keys from the input. One entry in "steps" per step. At most ${MAX_FINDINGS} findings, most important first. Do not repeat the rule findings you are given. Speak in plain words, no jargon.`

export function buildPersonaPrompt(input: {
  collection: string
  layout: string
  role: string
  goal: string | null
  steps: PersonaStep[]
  ruleFindings: PersonaFinding[]
}): string {
  return JSON.stringify({
    role: input.role,
    goal: input.goal ?? `Create a new ${input.collection} record`,
    form: input.layout,
    steps: input.steps.map((s) => ({
      key: s.key,
      label: s.label,
      instructions: s.text.length ? s.text : undefined,
      fields: s.fields
        .filter((f) => !f.hidden)
        .map((f) => ({
          key: f.field,
          label: f.label,
          type: f.interface ?? f.type,
          required: f.required || undefined,
          read_only: f.readonly || undefined,
          prefilled: f.has_default || undefined,
          help: f.note ?? undefined,
          choices: f.choices.length ? f.choices : undefined,
          only_sometimes_shown: f.conditional || undefined
        }))
    })),
    rule_findings: input.ruleFindings.map((f) => f.problem)
  })
}

const SEVERITIES = new Set<PersonaSeverity>(['blocking', 'confusing', 'minor'])
const FEELINGS = new Set(['clear', 'unsure', 'stuck'])

/** The model's answer, every name checked against the walkthrough; unknown ones dropped. */
export function parsePersonaAnswer(
  text: string,
  steps: PersonaStep[]
): {
  summary: string | null
  steps: PersonaStepNote[]
  findings: PersonaFinding[]
  dropped: string[]
} {
  const json = parseJsonLoose(text)
  const dropped: string[] = []
  if (!json) return { summary: null, steps: [], findings: [], dropped }
  const stepKeys = new Set(steps.map((s) => s.key))
  const fieldStep = new Map<string, string>()
  for (const s of steps)
    for (const f of s.fields) if (!fieldStep.has(f.field)) fieldStep.set(f.field, s.key)
  const notes: PersonaStepNote[] = []
  for (const raw of asArray(json.steps)) {
    const o = raw as Record<string, unknown>
    const step = String(o?.step ?? '')
    if (!stepKeys.has(step)) {
      if (step) dropped.push(step)
      continue
    }
    if (notes.some((n) => n.step === step)) continue
    const note = cleanText(o.note, 240)
    if (!note) continue
    const feeling = FEELINGS.has(String(o.feeling))
      ? (String(o.feeling) as PersonaStepNote['feeling'])
      : 'unsure'
    notes.push({ step, feeling, note })
  }
  const findings: PersonaFinding[] = []
  for (const raw of asArray(json.findings)) {
    if (findings.length >= MAX_FINDINGS) break
    const o = raw as Record<string, unknown>
    const target = String(o?.target ?? '')
    const m = /^(field|group):(.+)$/.exec(target)
    const known = m && (m[1] === 'field' ? fieldStep.has(m[2]) : stepKeys.has(m[2]))
    if (!m || !known) {
      if (target) dropped.push(target.replace(/^(field|group):/, ''))
      continue
    }
    const problem = cleanText(o.problem, 300)
    if (!problem) continue
    findings.push({
      id: `ai:${findings.length}`,
      target,
      step: m[1] === 'field' ? (fieldStep.get(m[2]) ?? null) : m[2],
      severity: SEVERITIES.has(o.severity as PersonaSeverity)
        ? (o.severity as PersonaSeverity)
        : 'confusing',
      problem,
      suggestion: cleanText(o.suggestion, 300),
      better_label: m[1] === 'field' ? cleanText(o.better_label, 80) : null,
      source: 'ai'
    })
  }
  return {
    summary: cleanText(json.summary, 500),
    steps: notes,
    findings,
    dropped: [...new Set(dropped)]
  }
}
