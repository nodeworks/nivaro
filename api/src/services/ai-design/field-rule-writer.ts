import { VALID_OPS, VALID_TARGET_TYPES, validateDynamicConfig } from '../field-rules.js'
import { cleanText, parseJsonLoose } from './model.js'
import type { FieldMeta } from './rule-context.js'

/**
 * AI default / field-rule writer (#2675): "Default Zone from the project's
 * zone" becomes a DRAFT nivaro_field_rules row (trigger → target, set / clear /
 * set_lookup / set_from_trigger, routes/field-rules.ts). The draft is checked
 * against both collections' fields and the rule validator, dry-run on a few
 * records with the same engine stored rules use (evaluateRuleRows), and saved
 * only when the admin confirms — through the existing POST /field-rules.
 */

export interface DraftFieldRule {
  collection: string
  trigger_field: string
  trigger_op: string
  trigger_value: string | null
  target_field: string
  target_type: string
  target_value: string | null
  only_when_empty: boolean
  dynamic_config: Record<string, unknown> | null
}

export interface FieldRuleContext {
  collection: string
  fields: FieldMeta[]
  /** M2O fields of this collection → target collection. */
  m2o: Map<string, string>
  /** Fields of each M2O target collection (what set_from_trigger / set_lookup may read). */
  targets: Map<string, FieldMeta[]>
}

export interface ParsedFieldRule {
  rule: DraftFieldRule | null
  explanation: string | null
  error: string | null
}

export const FIELD_RULE_SYSTEM = `You turn an admin's description of an automatic value into ONE field rule as JSON.
A rule watches a trigger field of the record; when the trigger matches, it sets a target field.
{"rule":{"trigger_field":"<field>","trigger_op":"eq|neq|null|nnull|in|contains","trigger_value":"<text or null>","target_field":"<field>","target_type":"set|clear|set_from_trigger|set_lookup","target_value":"<text or null>","only_when_empty":true|false,"dynamic_config":{...} or null},"explanation":"<one short sentence>"}
- set: target becomes target_value. clear: target is emptied.
- set_from_trigger: the trigger is a picker; the target becomes a field of the picked record. dynamic_config {"field":"<field of the trigger's record>"}. Use trigger_op "nnull".
- set_lookup: the target becomes values looked up in a collection: dynamic_config {"collection":"<collection>","filter_field":"<its field matched against the trigger value>","filter_op":"eq" or "in","select":"<its field to take>"}.
- only_when_empty true = fill the target only while it is empty (a default); false = always overwrite.
- "in" takes a comma-separated list; null/nnull take no value. Yes/no fields use "true"/"false"; choice fields use the choice VALUE.
Answer with ONE JSON object and nothing else, or {"error":"<why this cannot be done>"}. Use only field and collection keys from the input.`

export function buildFieldRulePrompt(
  ctx: FieldRuleContext,
  text: string,
  targetField?: string | null
): string {
  const value = (f: FieldMeta) => f.type !== 'alias' && !f.field.startsWith('__')
  return JSON.stringify({
    instruction: text,
    ...(targetField ? { target_field: targetField } : {}),
    collection: ctx.collection,
    fields: ctx.fields
      .filter(value)
      .slice(0, 250)
      .map((f) => ({
        field: f.field,
        label: f.label,
        type: f.type,
        picks_from: ctx.m2o.get(f.field),
        choices: f.choices.length ? f.choices : undefined
      })),
    picked_records: Object.fromEntries(
      [...ctx.targets].slice(0, 20).map(([collection, fields]) => [
        collection,
        fields
          .filter(value)
          .slice(0, 80)
          .map((f) => ({ field: f.field, label: f.label, type: f.type }))
      ])
    )
  })
}

const YES = new Set(['true', 'yes', '1', 'on'])
const NO = new Set(['false', 'no', '0', 'off'])

function normalizeValue(f: FieldMeta, raw: unknown): string | null {
  if (raw == null || raw === '' || typeof raw === 'object') return null
  const s = String(raw).trim().slice(0, 500)
  if (f.type === 'boolean') {
    const low = s.toLowerCase()
    return YES.has(low) ? 'true' : NO.has(low) ? 'false' : null
  }
  if (f.choices.length) {
    const c =
      f.choices.find((x) => x.value === s) ??
      f.choices.find((x) => x.label.toLowerCase() === s.toLowerCase())
    return c ? c.value : null
  }
  return s
}

export function parseFieldRuleAnswer(
  text: string,
  ctx: FieldRuleContext,
  targetField?: string | null
): ParsedFieldRule {
  const none = (error: string): ParsedFieldRule => ({ rule: null, explanation: null, error })
  const parsed = parseJsonLoose(text)
  if (!parsed) return none('The AI answer was not readable')
  const refusal = cleanText(parsed.error, 300)
  const r = parsed.rule as Record<string, unknown> | undefined
  if (!r || typeof r !== 'object') return none(refusal ?? 'The AI did not answer with a rule')

  const byField = new Map(
    ctx.fields
      .filter((f) => f.type !== 'alias' && !f.field.startsWith('__'))
      .map((f) => [f.field, f])
  )
  const trigger = byField.get(String(r.trigger_field ?? ''))
  const target = byField.get(String(r.target_field ?? ''))
  if (!trigger) return none(`"${cleanText(String(r.trigger_field ?? ''), 60)}" is not a field here`)
  if (!target) return none(`"${cleanText(String(r.target_field ?? ''), 60)}" is not a field here`)
  if (targetField && target.field !== targetField)
    return none(`The AI wrote a rule for ${target.label}, not for the field you asked about`)
  if (trigger.field === target.field) return none('A rule cannot set the field that triggers it')

  const type = String(r.target_type ?? 'set')
  // A rule that reads the picked record fires whenever something is picked.
  const op = String(
    r.trigger_op ?? (type === 'set_from_trigger' || type === 'set_lookup' ? 'nnull' : 'eq')
  )
  if (!VALID_OPS.has(op)) return none(`"${cleanText(op, 20)}" is not a trigger a rule can use`)
  let triggerValue: string | null = null
  if (op === 'in') {
    const list = (
      Array.isArray(r.trigger_value) ? r.trigger_value : String(r.trigger_value ?? '').split(',')
    )
      .map((v) => normalizeValue(trigger, v))
      .filter((v): v is string => v != null)
    if (!list.length) return none(`The trigger on ${trigger.label} has no usable values`)
    triggerValue = list.join(',')
  } else if (op !== 'null' && op !== 'nnull') {
    triggerValue = normalizeValue(trigger, r.trigger_value)
    if (triggerValue == null) return none(`The trigger on ${trigger.label} has no usable value`)
  }

  if (!VALID_TARGET_TYPES.has(type)) return none(`"${cleanText(type, 30)}" is not a rule action`)
  let targetValue: string | null = null
  let dynamic: Record<string, unknown> | null = null
  if (type === 'set') {
    targetValue = normalizeValue(target, r.target_value)
    if (targetValue == null) return none(`The value for ${target.label} cannot be stored there`)
  } else if (type === 'set_from_trigger') {
    const picked = ctx.m2o.get(trigger.field)
    if (!picked) return none(`${trigger.label} is not a picker, so its record cannot be read`)
    const cfg = (r.dynamic_config ?? {}) as Record<string, unknown>
    const from = (ctx.targets.get(picked) ?? []).find((f) => f.field === cfg.field)
    if (!from || from.type === 'alias')
      return none(`"${cleanText(String(cfg.field ?? ''), 60)}" is not a field of the picked record`)
    dynamic = { field: from.field }
  } else if (type === 'set_lookup') {
    const cfg = (r.dynamic_config ?? {}) as Record<string, unknown>
    const collection = String(cfg.collection ?? '')
    const fields = collection === ctx.collection ? ctx.fields : ctx.targets.get(collection)
    if (!fields)
      return none(`"${cleanText(collection, 60)}" is not a collection the rule can look in`)
    const names = new Set(fields.filter((f) => f.type !== 'alias').map((f) => f.field))
    if (!names.has(String(cfg.filter_field)) || !names.has(String(cfg.select)))
      return none('The lookup names fields that collection does not have')
    dynamic = {
      collection,
      filter_field: String(cfg.filter_field),
      filter_op: cfg.filter_op === 'in' ? 'in' : 'eq',
      select: String(cfg.select)
    }
  }
  const dynErr = validateDynamicConfig(type, dynamic)
  if (dynErr) return none(dynErr)

  return {
    rule: {
      collection: ctx.collection,
      trigger_field: trigger.field,
      trigger_op: op,
      trigger_value: triggerValue,
      target_field: target.field,
      target_type: type,
      target_value: targetValue,
      only_when_empty: typeof r.only_when_empty === 'boolean' ? r.only_when_empty : true,
      dynamic_config: dynamic
    },
    explanation: cleanText(parsed.explanation, 300),
    error: null
  }
}

const TRIGGER_WORDS: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is one of',
  contains: 'contains'
}

export function fieldRuleSentence(rule: DraftFieldRule, ctx: FieldRuleContext): string {
  const label = (f: string, list: FieldMeta[] = ctx.fields) =>
    list.find((x) => x.field === f)?.label ?? f
  const trigger = label(rule.trigger_field)
  const target = label(rule.target_field)
  const when =
    rule.trigger_op === 'nnull'
      ? `${trigger} is picked`
      : rule.trigger_op === 'null'
        ? `${trigger} is empty`
        : `${trigger} ${TRIGGER_WORDS[rule.trigger_op] ?? rule.trigger_op} ${rule.trigger_value ?? ''}`
  const cfg = rule.dynamic_config ?? {}
  const what =
    rule.target_type === 'clear'
      ? `empty ${target}`
      : rule.target_type === 'set_from_trigger'
        ? `set ${target} from the ${trigger}'s ${label(String(cfg.field), ctx.targets.get(ctx.m2o.get(rule.trigger_field) ?? '') ?? [])}`
        : rule.target_type === 'set_lookup'
          ? `set ${target} to the ${cfg.select} of ${cfg.collection} rows whose ${cfg.filter_field} matches ${trigger}`
          : `set ${target} to ${rule.target_value}`
  return `When ${when}, ${what}${rule.only_when_empty ? ` (only while ${target} is empty)` : ''}`
}
