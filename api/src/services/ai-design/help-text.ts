import { db } from '../../db/index.js'
import { type AiComplete, asArray, cleanText, parseJsonLoose, titleCase } from './model.js'

/**
 * Field help text drafts (#1912).
 *
 * Fields with no help text get a draft built from what the system already
 * knows about them — type, choices, validation rules, the field rules that
 * read or write them, cascade parents, the relation they point at, a
 * computed formula — plus the collection's own note and the instance's data
 * guide (Settings → AI Features) as "the docs". An admin accepts, edits or
 * skips each draft; accepting writes `nivaro_fields.note` and logs the old and
 * new text so the change can be put back.
 */

const SYSTEM_FIELDS = new Set([
  'id',
  'created',
  'created_at',
  'updated',
  'updated_at',
  'date_created',
  'date_updated',
  'user_created',
  'user_updated',
  'creator',
  'sort'
])
const AUDIT_SPECIALS = ['user-created', 'user-updated', 'date-created', 'date-updated']
export const HELP_MAX = 300
const BATCH = 30
const MAX_FIELDS = 90

export interface HelpTextCandidate {
  field: string
  label: string
  type: string
  interface: string | null
  required: boolean
  choices: string[]
  validation: string[]
  relation: string | null
  field_rules: string[]
  cascade_parents: string[]
  formula: string | null
}

export interface HelpTextDraft {
  field: string
  label: string
  text: string
  basis: string | null
}

function json(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

function describeRule(r: Record<string, unknown>): string | null {
  const type = String(r.type ?? r.rule ?? '')
  if (!type) return null
  const value = r.value ?? r.min ?? r.max ?? r.pattern
  return `${type}${value != null && value !== '' ? ` ${String(value).slice(0, 60)}` : ''}`
}

/** Fields of a collection that have no help text yet, with what is known about each. */
export async function helpTextCandidates(collection: string): Promise<HelpTextCandidate[]> {
  const [rows, relations, rules] = await Promise.all([
    db('nivaro_fields').where({ collection }).orderBy('sort') as Promise<
      Array<Record<string, unknown>>
    >,
    db('nivaro_relations').where((q) => {
      q.where({ many_collection: collection }).orWhere({ one_collection: collection })
    }) as Promise<Array<Record<string, unknown>>>,
    db('nivaro_field_rules')
      .where({ collection })
      .catch(() => []) as Promise<Array<Record<string, unknown>>>
  ])

  const out: HelpTextCandidate[] = []
  for (const r of rows) {
    const field = String(r.field)
    if (SYSTEM_FIELDS.has(field) || /^__/.test(field)) continue
    if (r.hidden === true || r.hidden === 1) continue
    if (cleanText(r.note, 10)) continue
    const special = String(r.special ?? '')
    if (AUDIT_SPECIALS.some((s) => special.includes(s))) continue

    const options = json(r.options) as Record<string, unknown> | null
    const choices = asArray(options?.choices)
      .map((c) =>
        c && typeof c === 'object'
          ? String(
              (c as { text?: unknown; value?: unknown }).text ?? (c as { value?: unknown }).value
            )
          : String(c)
      )
      .map((t) => t.replace(/^\$t:/, ''))
      .slice(0, 12)
    const validation = asArray(json(r.validation_rules))
      .map((x) => (x && typeof x === 'object' ? describeRule(x as Record<string, unknown>) : null))
      .filter((x): x is string => !!x)
      .slice(0, 6)
    const m2o = relations.find(
      (rel) => rel.many_collection === collection && rel.many_field === field
    )
    const alias = relations.find(
      (rel) => rel.one_collection === collection && rel.one_field === field
    )
    const relation = m2o?.one_collection
      ? `points at one ${String(m2o.one_collection)} record`
      : alias
        ? `lists related ${String(alias.many_collection)} records`
        : null
    const fieldRules = rules
      .filter((fr) => fr.trigger_field === field || fr.target_field === field)
      .slice(0, 5)
      .map((fr) =>
        fr.target_field === field
          ? `set by a rule when ${String(fr.trigger_field)} ${String(fr.trigger_op ?? '')} ${String(fr.trigger_value ?? '')}`.trim()
          : `when changed, a rule sets ${String(fr.target_field)}`
      )
    const dep = json(r.dependency_config) as Record<string, unknown> | null
    const cascadeParents = asArray(dep?.cascade_filters)
      .map((c) => (c as { parent_field?: unknown })?.parent_field)
      .filter((p): p is string => typeof p === 'string')

    out.push({
      field,
      label: cleanText(r.label, 80) ?? titleCase(field),
      type: String(r.type ?? 'string'),
      interface: (r.interface as string) ?? null,
      required: r.required === true || r.required === 1,
      choices,
      validation,
      relation,
      field_rules: fieldRules,
      cascade_parents: cascadeParents,
      formula: cleanText(r.computed_formula, 200)
    })
    if (out.length >= MAX_FIELDS) break
  }
  return out
}

const HELP_SYSTEM = `You write the one-line help text shown under form fields in a business application.
You get a collection, optional documentation, and a list of fields with what is known about each.
Answer with ONE JSON object and nothing else:
{"drafts":[{"field":"<field key>","text":"<help text, one or two short sentences, <=200 chars>","basis":"<what you based it on, <=80 chars>"}]}
Rules: only use field keys from the input; skip a field when there is nothing useful to say beyond its label. Say what belongs in the field and anything a person must know (allowed values, format, who fills it, what it drives). Plain words, no marketing, never invent business facts the input does not support.`

export function buildHelpPrompt(
  collection: { name: string; label: string | null; note: string | null },
  guide: string | null,
  fields: HelpTextCandidate[]
): string {
  const lines = fields.map((f) => {
    const parts = [`${f.field} — "${f.label}" (${f.type}${f.required ? ', required' : ''})`]
    if (f.choices.length) parts.push(`choices: ${f.choices.join(', ')}`)
    if (f.validation.length) parts.push(`rules: ${f.validation.join('; ')}`)
    if (f.relation) parts.push(f.relation)
    if (f.field_rules.length) parts.push(f.field_rules.join('; '))
    if (f.cascade_parents.length) parts.push(`options narrowed by ${f.cascade_parents.join(', ')}`)
    if (f.formula) parts.push(`computed: ${f.formula}`)
    return `- ${parts.join(' · ')}`
  })
  const docs = [
    collection.note ? `Collection note: ${collection.note}` : null,
    guide ? `Data guide:\n${guide.slice(0, 3000)}` : null
  ]
    .filter(Boolean)
    .join('\n\n')
  return `Collection: ${collection.name}${collection.label ? ` ("${collection.label}")` : ''}\n${docs ? `${docs}\n\n` : ''}Fields:\n${lines.join('\n')}`
}

export function parseHelpAnswer(text: string, fields: HelpTextCandidate[]): HelpTextDraft[] {
  const parsed = parseJsonLoose(text) ?? {}
  const byField = new Map(fields.map((f) => [f.field, f]))
  const out: HelpTextDraft[] = []
  const seen = new Set<string>()
  for (const d of asArray(parsed.drafts)) {
    const o = d as { field?: unknown; text?: unknown; basis?: unknown }
    const field = typeof o?.field === 'string' ? o.field : ''
    const f = byField.get(field)
    const t = cleanText(o?.text, HELP_MAX)
    if (!f || !t || seen.has(field)) continue
    if (t.toLowerCase() === f.label.toLowerCase()) continue
    seen.add(field)
    out.push({ field, label: f.label, text: t, basis: cleanText(o?.basis, 120) })
  }
  return out
}

export async function draftHelpText(
  collection: string,
  fields: HelpTextCandidate[],
  complete: AiComplete
): Promise<HelpTextDraft[]> {
  const [col, settings] = await Promise.all([
    db('nivaro_collections').where({ collection }).first('display_name', 'note') as Promise<
      { display_name: string | null; note: string | null } | undefined
    >,
    db('nivaro_settings')
      .where({ id: 1 })
      .first('ai_chat_guide')
      .catch(() => null) as Promise<{ ai_chat_guide?: string | null } | null>
  ])
  const meta = {
    name: collection,
    label: col?.display_name ?? null,
    note: cleanText(col?.note, 600)
  }
  const guide = cleanText(settings?.ai_chat_guide, 3000)
  const drafts: HelpTextDraft[] = []
  for (let i = 0; i < fields.length; i += BATCH) {
    const batch = fields.slice(i, i + BATCH)
    const text = await complete({
      system: HELP_SYSTEM,
      user: buildHelpPrompt(meta, guide, batch),
      maxTokens: 3000
    })
    drafts.push(...parseHelpAnswer(text, batch))
  }
  return drafts
}

/** Write one field's help text. Returns the text it replaced. */
export async function applyHelpText(
  collection: string,
  field: string,
  text: string | null
): Promise<{ previous: string | null; id: number } | null> {
  const row = (await db('nivaro_fields').where({ collection, field }).first('id', 'note')) as
    | { id: number; note: string | null }
    | undefined
  if (!row) return null
  await db('nivaro_fields').where({ id: row.id }).update({ note: text })
  return { previous: row.note ?? null, id: row.id }
}
