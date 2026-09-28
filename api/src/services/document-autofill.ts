import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { db } from '../db/index.js'
import type { CMSField, CMSRelation, User } from '../types.js'
import { getAiClient, getAiModelSettings } from './ai-client.js'
import { getCollection, getFields, getRelations } from './collections.js'
import { applyCrossRecordDefaults } from './cross-record-defaults.js'
import { extractTemplateFields, resolveDisplayValue } from './display-value.js'
import { MAX_TEXT_CHARS } from './document-extract.js'
import { evaluateRulesForTrigger } from './field-rules.js'
import { applyFilterToQuery, readItems } from './items.js'
import { can } from './permissions.js'
import { currentTraceMeta } from './request-trace.js'
import { listUsers } from './users.js'

/**
 * Fill a NEW record from a document — a statement of work, a quote, a
 * purchase order PDF, a spreadsheet. The model never writes anything: it
 * reads the document, looks related records up through the same
 * permission-checked read the caller could do by hand, and hands back a
 * PROPOSAL (value + confidence + the sentence it came from). The form stages
 * the proposal like an import prefill; nothing lands until Create.
 *
 * Three rules keep it honest regardless of which model runs it:
 *  - Every relation id in the proposal must have come back from a
 *    `search_records` call in THIS request (code checks the ids, the model
 *    cannot invent one). Anything else becomes an "ask".
 *  - Choices must be one of the field's configured choices; dates ISO;
 *    numbers numeric — coerced or dropped, never passed through raw.
 *  - Line amounts are summed and compared with any total the model set on
 *    the parent; a mismatch is reported, not silently accepted.
 */

export type ProposedField = {
  field: string
  label: string
  value: unknown
  /** What the form shows for the value (a related record's label, a choice text). */
  display: string | null
  confidence: number
  source: string | null
  /** Set when the value was NOT read from the document but derived from one
   *  that was: a field rule or a cross-record default the form would run. */
  derived?: { by: 'field_rule' | 'cross_record_defaults'; from: string } | null
}

export type ProposedLine = {
  values: Record<string, unknown>
  display: Record<string, string>
  confidence: number
  source: string | null
}

/** How the review dialog lets a person answer an ask without leaving it. */
export type AskInput =
  | {
      type: 'relation'
      collection: string
      template: string | null
      /** The field's own picker narrowing, so the review dialog's picker
       *  offers what the form's would under the proposal's values. */
      cascades?: CascadeRule[]
      option_filter?: Record<string, unknown> | null
    }
  | { type: 'choices'; choices: Array<{ value: string; text: string }> }
  | { type: 'boolean' }
  | { type: 'number' }
  | { type: 'date' }
  | { type: 'text' }

export type ProposedAsk = {
  field: string
  label: string
  reason: string
  /** What the model read, when it read something but the value was refused
   *  (under the confidence threshold, outside a cascade) — offered as one click. */
  candidate?: {
    value: unknown
    display: string | null
    confidence: number
    source: string | null
  } | null
  input?: AskInput | null
}

export type DocumentProposal = {
  /** Stable id for the stored proposal (24h) — the form opens it by `?autofill=<id>`. */
  id: string
  request_id: string | null
  collection: string
  layout_id: number | null
  summary: string
  fields: ProposedField[]
  children: Array<{
    alias: string
    label: string
    collection: string
    lines: ProposedLine[]
  }>
  m2m: Array<{
    alias: string
    label: string
    items: Array<{ id: string | number; label: string; confidence: number }>
  }>
  asks: ProposedAsk[]
  warnings: string[]
  /** Stage-ready payload in the import-prefill shape. */
  prefill: {
    values: Record<string, unknown>
    lines_by_alias: Record<string, Array<{ values: Record<string, unknown> }>>
    m2m: Record<string, Array<string | number>>
    file_id: string | null
    /** Every stored document, in the order given (the first is `file_id`). */
    file_ids: string[]
    attach_alias: string | null
  }
  document: {
    name: string
    method: string
    pages: number | null
    truncated: boolean
    chars: number
    /** One entry per document when several were read together. */
    documents?: Array<{
      name: string
      method: string
      pages: number | null
      truncated: boolean
      chars: number
      file_id: string | null
    }>
  }
  model: string
  rounds: number
  latency_ms: number
  /** A document past the prompt cap was condensed: how many extra chunks were read. */
  condensed: { chunks: number; excerpt_chars: number } | null
  /** Which configured hints rode the prompt (collection hints + keyed hints that fired). */
  hints_used: string[]
}

// ─── Spec: what the model may fill ───────────────────────────────────────────

/** A picker cascade (dependency_config.cascade_filters) — the same shape the
 *  form's buildCascadeFilter and services/picker-rules.ts read. */
export type CascadeRule = {
  parent_field: string
  filter_column: string
  filter_is_m2m?: boolean
  filter_via_many?: boolean
  value_map?: Record<string, unknown>
  value_map_default?: unknown
  show_all_if_no_parent?: boolean
}

type SpecField = {
  field: string
  label: string
  type: string
  interface: string | null
  note: string | null
  required: boolean
  choices?: Array<{ value: string; text: string }>
  lookup?: { collection: string; label: string }
  /** The picker narrows by these parent fields — the model fills parents
   *  first and passes them to search_records; the proposal is judged against them. */
  cascades?: CascadeRule[]
  /** The field's option_filter (may hold `$parent.<field>` tokens). */
  optionFilter?: Record<string, unknown> | null
}

type SpecChild = {
  alias: string
  label: string
  collection: string
  fk: string
  fields: SpecField[]
}

type SpecM2M = { alias: string; label: string; collection: string }

type Spec = {
  collection: string
  label: string
  fields: SpecField[]
  children: SpecChild[]
  m2m: SpecM2M[]
  /** Collections search_records may be called on (every lookup target). */
  lookups: Map<string, { label: string; template: string | null }>
  /** Small lookup tables listed whole in the prompt (id → label), so a type,
   *  region or year is picked from the real list instead of searched for. */
  lookupOptions: Map<string, Array<{ id: string | number; label: string }>>
  attachAlias: string | null
  layoutId: number | null
}

/** Per-collection autofill configuration (migration 364). */
export type AutofillConfig = {
  hints: string | null
  keyedHints: Array<{ field: string; match: string; hints: string }>
  thresholds: Record<string, number>
}

export const DEFAULT_ASK_THRESHOLD = 0.4

export async function autofillConfig(collection: string): Promise<AutofillConfig> {
  const row = (await db('nivaro_ai_collection_settings')
    .where({ collection })
    .first('autofill_hints', 'autofill_keyed_hints', 'autofill_thresholds')
    .catch(() => null)) as Record<string, unknown> | null | undefined
  const parse = (v: unknown): unknown => {
    if (typeof v !== 'string' || !v.trim()) return null
    try {
      return JSON.parse(v)
    } catch {
      return null
    }
  }
  const keyed = parse(row?.autofill_keyed_hints)
  const thresholds = parse(row?.autofill_thresholds)
  return {
    hints:
      typeof row?.autofill_hints === 'string' && row.autofill_hints.trim()
        ? row.autofill_hints.trim()
        : null,
    keyedHints: Array.isArray(keyed)
      ? keyed
          .filter(
            (k): k is { field: string; match: string; hints: string } =>
              !!k &&
              typeof k === 'object' &&
              typeof (k as Record<string, unknown>).field === 'string' &&
              typeof (k as Record<string, unknown>).match === 'string' &&
              typeof (k as Record<string, unknown>).hints === 'string'
          )
          .slice(0, 40)
      : [],
    thresholds:
      thresholds && typeof thresholds === 'object' && !Array.isArray(thresholds)
        ? Object.fromEntries(
            Object.entries(thresholds as Record<string, unknown>)
              .map(([k, v]) => [k, Number(v)] as const)
              .filter(([, v]) => Number.isFinite(v) && v >= 0 && v <= 1)
          )
        : {}
  }
}

export function thresholdFor(cfg: AutofillConfig, field: string): number {
  return cfg.thresholds[field] ?? cfg.thresholds._default ?? DEFAULT_ASK_THRESHOLD
}

const PRELIST_MAX_ROWS = 200

const AUDIT_SPECIALS = new Set([
  'user-created',
  'date-created',
  'user-updated',
  'date-updated',
  'uuid'
])
const AUDIT_FIELDS = new Set([
  'id',
  'sort',
  'created_at',
  'updated_at',
  'date_created',
  'date_updated',
  'user_created',
  'user_updated',
  'created_by',
  'updated_by',
  'workspace_id'
])
const SCALAR_TYPES = new Set([
  'string',
  'text',
  'integer',
  'bigInteger',
  'decimal',
  'float',
  'boolean',
  'date',
  'dateTime',
  'datetime',
  'timestamp',
  'json'
])

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

function fieldLabel(f: CMSField): string {
  const opts = (f.options ?? {}) as Record<string, unknown>
  const l = (f as unknown as { label?: string | null }).label
  return (
    (typeof l === 'string' && l.trim()) ||
    (typeof opts.label === 'string' && opts.label) ||
    titleCase(f.field)
  )
}

function choicesOf(f: CMSField): Array<{ value: string; text: string }> | undefined {
  const opts = (f.options ?? {}) as Record<string, unknown>
  const raw = opts.choices
  if (!Array.isArray(raw)) return undefined
  const out: Array<{ value: string; text: string }> = []
  for (const c of raw) {
    if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>
      if (o.value != null)
        out.push({ value: String(o.value), text: String(o.text ?? o.label ?? o.value) })
    } else if (typeof c === 'string') out.push({ value: c, text: c })
  }
  return out.length ? out : undefined
}

function isFillable(f: CMSField, aliases: Set<string>): boolean {
  if (f.hidden || f.readonly) return false
  if (aliases.has(f.field)) return false
  if (f.computed_type) return false
  if (AUDIT_FIELDS.has(f.field)) return false
  if (f.field.startsWith('__') || f.field.includes('.')) return false
  const opts = (f.options ?? {}) as Record<string, unknown>
  if (opts.auto_id) return false
  const special = Array.isArray(f.special) ? f.special : []
  if (special.some((s) => AUDIT_SPECIALS.has(String(s)))) return false
  const iface = f.interface ?? ''
  if (
    /m2m|o2m|m2a|list-|file|files|alias|slot|widget|inline-table|inline-grid|catalog|relation-path|repeater|tags/.test(
      iface
    ) &&
    !/m2o/.test(iface)
  )
    return false
  return true
}

async function layoutFieldSet(
  collection: string,
  layoutId: number | null
): Promise<{ set: Set<string> | null; layoutId: number | null }> {
  const layout = (await (layoutId
    ? db('nivaro_collection_layouts').where({ collection, id: layoutId }).first('id')
    : db('nivaro_collection_layouts')
        .where({ collection, layout_type: 'grouped', is_active: 1 })
        .first('id')
  ).catch(() => null)) as { id: number } | null
  if (!layout) return { set: null, layoutId: null }
  const rows = (await db('nivaro_layout_field_assignments')
    .where({ layout_id: layout.id })
    .select('field', 'is_visible')) as Array<{ field: string; is_visible: boolean | number | null }>
  const set = new Set<string>()
  for (const r of rows) {
    if (r.is_visible === false || r.is_visible === 0) continue
    set.add(r.field)
  }
  return { set: set.size ? set : null, layoutId: layout.id }
}

function parseJsonLoose<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return null
  }
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

function cascadesOf(f: CMSField): CascadeRule[] {
  const dep = parseJsonLoose<{ cascade_filters?: CascadeRule[] }>(
    (f as unknown as { dependency_config?: unknown }).dependency_config
  )
  return (dep?.cascade_filters ?? []).filter(
    (c) =>
      !!c &&
      typeof c.parent_field === 'string' &&
      typeof c.filter_column === 'string' &&
      IDENT.test(c.parent_field) &&
      c.filter_column.split('.').every((seg) => IDENT.test(seg))
  )
}

async function scalarSpec(
  collection: string,
  rels: CMSRelation[],
  lookups: Spec['lookups'],
  onlyFields: Set<string> | null,
  exclude: Set<string>
): Promise<SpecField[]> {
  const fields = await getFields(collection)
  const aliases = new Set<string>()
  for (const r of rels) {
    if (r.one_collection === collection && r.one_field) aliases.add(r.one_field)
    if (r.one_collection === collection && r.junction_field != null) aliases.add(r.many_collection)
  }
  const out: SpecField[] = []
  for (const f of fields) {
    if (!isFillable(f, aliases)) continue
    if (exclude.has(f.field)) continue
    if (onlyFields && !onlyFields.has(f.field)) continue
    const m2o = rels.find(
      (r) =>
        r.many_collection === collection &&
        r.many_field === f.field &&
        r.junction_field == null &&
        r.one_collection
    )
    const entry: SpecField = {
      field: f.field,
      label: fieldLabel(f),
      type: f.type,
      interface: f.interface,
      note: f.note,
      required: !!f.required
    }
    if (m2o?.one_collection) {
      const target = m2o.one_collection === 'directus_users' ? 'nivaro_users' : m2o.one_collection
      if (target.startsWith('nivaro_') && target !== 'nivaro_users') continue
      let label = titleCase(target)
      let template: string | null = null
      if (target === 'nivaro_users') label = 'People'
      else {
        const meta = await getCollection(target)
        if (!meta) continue
        label = meta.display_name || meta.singular || titleCase(target)
        template = meta.display_template ?? null
      }
      lookups.set(target, { label, template })
      entry.lookup = { collection: target, label }
      const cascades = cascadesOf(f)
      if (cascades.length) entry.cascades = cascades
      const opts = (f.options ?? {}) as Record<string, unknown>
      const of = opts.option_filter
      if (of && typeof of === 'object' && !Array.isArray(of) && Object.keys(of).length)
        entry.optionFilter = of as Record<string, unknown>
    } else {
      if (
        !SCALAR_TYPES.has(f.type) &&
        !/select|dropdown|radio|input|textarea|rich|date|toggle|boolean|number/.test(
          f.interface ?? ''
        )
      )
        continue
      entry.choices = choicesOf(f)
    }
    out.push(entry)
    if (out.length >= 60) break
  }
  return out
}

export async function buildSpec(
  user: User,
  collection: string,
  opts: { layoutId?: number | null } = {}
): Promise<Spec> {
  const meta = await getCollection(collection)
  if (!meta) throw new Error(`Collection "${collection}" not found`)
  const rels = await getRelations(collection)
  const lookups: Spec['lookups'] = new Map()
  const { set: assigned, layoutId } = await layoutFieldSet(collection, opts.layoutId ?? null)
  const fields = await scalarSpec(collection, rels, lookups, assigned, new Set())

  const children: SpecChild[] = []
  const m2m: SpecM2M[] = []
  let attachAlias: string | null = null
  for (const r of rels) {
    if (r.one_collection !== collection || !r.one_field) continue
    // A layout may assign the alias by its field name OR by the junction
    // table's name (the legacy `workflows_files` form).
    if (assigned && !assigned.has(r.one_field) && !assigned.has(r.many_collection)) continue
    if (r.junction_field == null) {
      // O2M child set — lines, forecasts, materials.
      if (!r.many_collection || r.many_collection.startsWith('nivaro_')) continue
      if (!(await can(user, 'create', r.many_collection))) continue
      if (children.length >= 3) continue
      const childMeta = await getCollection(r.many_collection)
      const childRels = await getRelations(r.many_collection)
      const childFields = await scalarSpec(
        r.many_collection,
        childRels,
        lookups,
        null,
        new Set([r.many_field])
      )
      if (childFields.length === 0) continue
      children.push({
        alias: r.one_field,
        label: childMeta?.display_name || titleCase(r.one_field),
        collection: r.many_collection,
        fk: r.many_field,
        fields: childFields.slice(0, 25)
      })
    } else {
      // M2M — the companion leg names the target.
      const companion = rels.find(
        (x) =>
          x.many_collection === r.many_collection &&
          x.many_field === r.junction_field &&
          x.one_collection &&
          x.one_collection !== collection
      )
      const target = companion?.one_collection ?? null
      if (!target) continue
      if (target === 'nivaro_files' || target === 'directus_files') {
        if (!attachAlias) attachAlias = r.one_field
        continue
      }
      if (target.startsWith('nivaro_') || target.startsWith('directus_')) continue
      const tm = await getCollection(target)
      if (!tm) continue
      lookups.set(target, {
        label: tm.display_name || titleCase(target),
        template: tm.display_template ?? null
      })
      m2m.push({
        alias: r.one_field,
        label: fieldLabel({ field: r.one_field, options: null } as CMSField),
        collection: target
      })
    }
  }

  const lookupOptions = await preloadSmallLookups(user, lookups)
  return {
    collection,
    label: meta.singular || meta.display_name || titleCase(collection),
    fields,
    children,
    m2m,
    lookups,
    lookupOptions,
    attachAlias,
    layoutId
  }
}

/**
 * Lookup tables small enough to print whole (types, regions, years, line
 * types…) go into the prompt as `id=label` so the model picks from the real
 * list. Big tables (vendors, locations, people) stay behind search_records.
 * Read as the caller — a row they cannot see is not an option.
 */
async function preloadSmallLookups(
  user: User,
  lookups: Spec['lookups']
): Promise<Spec['lookupOptions']> {
  const out: Spec['lookupOptions'] = new Map()
  for (const [collection, meta] of lookups) {
    if (collection === 'nivaro_users') continue
    try {
      const tokens = extractTemplateFields(meta.template).filter((t) => !t.includes('.'))
      const fields = tokens.length ? ['id', ...tokens] : undefined
      const res = (await readItems(user, collection, {
        limit: PRELIST_MAX_ROWS + 1,
        ...(fields ? { fields } : {})
      })) as { data?: Array<Record<string, unknown>>; total?: number }
      const rows = res.data ?? []
      const total = typeof res.total === 'number' ? res.total : rows.length
      if (total > PRELIST_MAX_ROWS) continue
      const opts = rows
        .map((r) => ({
          id: r.id as string | number,
          label: resolveDisplayValue(r, meta.template) || String(r.id)
        }))
        .filter((o) => o.id != null)
      if (opts.length) out.set(collection, opts)
    } catch {
      // unreadable or odd table — stays searchable
    }
  }
  return out
}

// ─── Tools ──────────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_records',
    description:
      'Find an existing record to reference by id. Use it for EVERY relation field (vendor, contact, project, category, region…) — the id you set must come from a result of this tool. Search by the name as written in the document; try a shorter or alternative spelling when nothing matches. Returns up to 8 candidates as {id, label}.',
    input_schema: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description: 'One of the lookup collections listed in the spec'
        },
        query: { type: 'string', description: 'Name or number to search for' },
        limit: { type: 'integer', minimum: 1, maximum: 8 },
        field: {
          type: 'string',
          description:
            'The field you are filling (so the search honours its dependencies). Required for a field listed under Dependencies.'
        },
        parents: {
          type: 'object',
          description:
            'Ids you already settled for the parent fields of `field`, e.g. {"division": 2, "project_type": 12}. The search is narrowed the way the form narrows the picker.',
          additionalProperties: { type: ['string', 'number', 'null'] }
        }
      },
      required: ['collection', 'query']
    }
  },
  {
    name: 'submit_proposal',
    description:
      'Hand back the final proposal. Call it exactly once, after every lookup you need. Values for relation fields are ids returned by search_records; choices are the value key; dates are YYYY-MM-DD; numbers are plain numbers. Anything you could not determine goes in asks, never guessed.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'One sentence: what this document is and what the record would be'
        },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              value: {
                type: ['string', 'number', 'boolean', 'null'],
                description:
                  'The value: text, a number, true/false, an id from search_records or a listed option'
              },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              source: {
                type: 'string',
                description: 'The sentence or table cell the value came from, ≤160 chars'
              }
            },
            required: ['field', 'value', 'confidence']
          }
        },
        children: {
          type: 'object',
          description:
            'Keyed by child alias; each value is an array of rows {values, confidence, source}',
          additionalProperties: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                values: { type: 'object' },
                confidence: { type: 'number' },
                source: { type: 'string' }
              },
              required: ['values', 'confidence']
            }
          }
        },
        m2m: {
          type: 'object',
          description: 'Keyed by alias; each value is an array of {id, confidence}',
          additionalProperties: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: ['string', 'number'] }, confidence: { type: 'number' } },
              required: ['id']
            }
          }
        },
        asks: {
          type: 'array',
          items: {
            type: 'object',
            properties: { field: { type: 'string' }, reason: { type: 'string' } },
            required: ['field', 'reason']
          }
        }
      },
      required: ['summary', 'fields']
    }
  }
]

function describeField(f: SpecField): string {
  const bits: string[] = [
    `- ${f.field} (${f.label}; ${f.lookup ? `relation → search_records collection "${f.lookup.collection}"` : f.type}${f.required ? '; required' : ''})`
  ]
  if (f.choices)
    bits.push(`  choices: ${f.choices.map((c) => `${c.value}="${c.text}"`).join(', ')}`)
  if (f.note) bits.push(`  note: ${f.note}`)
  return bits.join('\n')
}

function describeDeps(spec: Spec): string[] {
  const out: string[] = []
  for (const f of spec.fields) {
    if (!f.cascades?.length) continue
    const parents = [...new Set(f.cascades.map((c) => c.parent_field))].map(
      (p) => spec.fields.find((x) => x.field === p)?.label ?? p
    )
    out.push(
      `- ${f.field} (${f.label}) is narrowed by ${parents.join(', ')}: settle those first, then pass their ids as "parents" when you search_records for ${f.field}. A value outside them is refused.`
    )
  }
  return out
}

export type CorrectionMemory = Array<{
  field: string
  label: string
  from: string
  to: string
  times: number
}>

function buildSystemPrompt(
  spec: Spec,
  today: string,
  extras: { hints?: string | null; corrections?: CorrectionMemory; documents?: number } = {}
): string {
  const lines: string[] = []
  lines.push(
    `You fill in a NEW "${spec.label}" record from a document a person uploaded. You propose values; a person reviews every one before it is saved. Today is ${today}.`,
    '',
    'Rules:',
    '- Only use what the document says. Never invent a value, an id, a date or an amount.',
    '- For every relation field call search_records on its collection with the name as the document writes it; set the returned id, or add the field to asks when nothing plausible matches. Never set an id you did not receive from search_records.',
    '- Prefer the exact figure over a rounded one. Money as plain numbers (62568, not "$62,568.00").',
    '- Dates as YYYY-MM-DD. Booleans true/false. Choice fields take the choice VALUE, not its text.',
    '- Confidence: 0.9+ when the document states it outright, 0.6–0.8 when inferred (a category from a description), below 0.6 when it is a guess — put guesses in asks instead.',
    '- A fee table, line items, materials or a schedule become child rows. One row per table line. Quantities and unit prices as numbers.',
    '- Rich text or long text fields (objective, scope, notes) take a concise plain-text paragraph or bullet lines from the document, not the whole document. Short text fields (a description, name or title) take a COMPACT TITLE of at most eight words, what a person would type into a list column ("NNO Power Engineering SOW – Insight Global") — never dates, amounts, locations or a summary; those belong in their own fields.',
    '- Relation fields on child rows (a category, a line type, an item) need a lookup or a listed id too; leave one out rather than guess.',
    '- A number in the document that IS an id (a year, a code) matches a listed option by id directly.',
    '- Do not fill audit, status, state or approval fields. Do not fill a field the document says nothing about.',
    '- A child collection whose fields are months or periods is a schedule: when the document states a total and a term but no month-by-month breakdown, propose one row per calendar year with the total spread evenly across the months inside the term (and its total field set), and say so in the source. Never spread across months outside the term.',
    ...((extras.documents ?? 1) > 1
      ? [
          `- ${extras.documents} documents were uploaded together and describe ONE record (a statement of work and its quote, a request and its attachments). Read them all; when they disagree, prefer the more specific or more recent one and say so; name the document in every source ("quote.pdf: …").`
        ]
      : []),
    '- Finish with exactly one submit_proposal call.',
    '',
    `Fields on ${spec.label}:`,
    ...spec.fields.map(describeField)
  )
  if (spec.children.length) {
    for (const c of spec.children) {
      lines.push(
        '',
        `Child rows "${c.alias}" (${c.label}, collection ${c.collection}) — fields per row:`,
        ...c.fields.map(describeField)
      )
    }
  }
  if (spec.m2m.length) {
    lines.push(
      '',
      'Multi-select relations (m2m): ' +
        spec.m2m.map((m) => `${m.alias} → search_records collection "${m.collection}"`).join('; ')
    )
  }
  const searchable = [...spec.lookups.entries()].filter(([c]) => !spec.lookupOptions.has(c))
  lines.push(
    '',
    'Lookup collections you may search: ' +
      searchable.map(([c, v]) => `${c} (${v.label})`).join(', ')
  )
  for (const [c, opts] of spec.lookupOptions) {
    const label = spec.lookups.get(c)?.label ?? c
    lines.push(
      '',
      `All ${label} (${c}) — pick the id, no search needed: ` +
        opts.map((o) => `${o.id}=${o.label}`).join('; ')
    )
  }
  const deps = describeDeps(spec)
  if (deps.length) {
    lines.push('', 'Dependencies between fields (the form narrows one picker by another):', ...deps)
  }
  if (extras.hints) {
    lines.push('', `Hints for ${spec.label} documents (written by an administrator):`, extras.hints)
  }
  if (extras.corrections?.length) {
    lines.push(
      '',
      'People corrected earlier proposals on this collection — prefer what they chose:',
      ...extras.corrections.map(
        (c) =>
          `- ${c.label}: "${c.from}" was changed to "${c.to}"${c.times > 1 ? ` (${c.times} times)` : ''}`
      )
    )
  }
  return lines.join('\n')
}

// ─── Lookup execution (permission-checked, ids remembered) ───────────────────

type Seen = Map<string, Map<string, string>> // collection → id → label

/** The cascade clauses for the parent values in hand — the form's
 *  buildCascadeFilter (same shape services/picker-rules.ts compiles). */
export function cascadeFilterFor(
  rules: CascadeRule[],
  parentValue: (f: string) => unknown
): { filter: Record<string, unknown> | null; used: string[]; missingRequired: string[] } {
  let filter: Record<string, unknown> | null = null
  const used: string[] = []
  const missingRequired: string[] = []
  const empty = (v: unknown) =>
    v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
  for (const rule of rules) {
    const pv = parentValue(rule.parent_field)
    if (empty(pv)) {
      if (rule.show_all_if_no_parent === false) missingRequired.push(rule.parent_field)
      continue
    }
    let fv: unknown = pv
    if (rule.value_map && typeof rule.value_map === 'object') {
      const vm = rule.value_map
      const one = (v: unknown) => vm[String(v)] ?? rule.value_map_default ?? v
      fv = Array.isArray(pv)
        ? [
            ...new Set(
              (pv as unknown[]).flatMap((v) => (Array.isArray(one(v)) ? one(v) : [one(v)]))
            )
          ]
        : one(pv)
    }
    const clause = Array.isArray(fv) ? { _in: fv } : { _eq: fv }
    if (!filter) filter = {}
    if (rule.filter_is_m2m) {
      filter[rule.filter_column] = { _some: { id: clause } }
    } else if (rule.filter_column.includes('.')) {
      const segs = rule.filter_column.split('.')
      let nested: Record<string, unknown> = clause
      for (let i = segs.length - 1; i >= 1; i--) nested = { [segs[i]]: nested }
      filter[segs[0]] = rule.filter_via_many ? { _some: nested } : nested
    } else {
      filter[rule.filter_column] = clause
    }
    used.push(rule.parent_field)
  }
  return { filter, used, missingRequired }
}

/** `$parent.<field>` tokens off the values in hand; an `_and` entry that
 *  cannot resolve is dropped, a bare filter that cannot resolve is skipped. */
function resolveOptionFilterTokens(
  filter: Record<string, unknown>,
  parentValue: (f: string) => unknown
): Record<string, unknown> | null {
  const empty = (v: unknown) =>
    v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
  const walk = (node: unknown): { v: unknown; ok: boolean } => {
    if (typeof node === 'string' && node.startsWith('$parent.')) {
      const val = parentValue(node.slice('$parent.'.length))
      return { v: val, ok: !empty(val) }
    }
    if (Array.isArray(node)) {
      const out: unknown[] = []
      for (const item of node) {
        const r = walk(item)
        if (!r.ok) return { v: out, ok: false }
        out.push(r.v)
      }
      return { v: out, ok: true }
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const r = walk(v)
        if (!r.ok) return { v: out, ok: false }
        out[k] = r.v
      }
      return { v: out, ok: true }
    }
    return { v: node, ok: true }
  }
  if (Array.isArray(filter._and)) {
    const kept: unknown[] = []
    for (const entry of filter._and) {
      const r = walk(entry)
      if (r.ok) kept.push(r.v)
    }
    return kept.length ? { _and: kept } : null
  }
  const r = walk(filter)
  return r.ok ? (r.v as Record<string, unknown>) : null
}

/** Every narrowing the form's picker would apply for `field` given the
 *  parent values in hand: cascades ∧ option_filter. */
export function pickerFilterFor(
  f: SpecField,
  parentValue: (name: string) => unknown
): { filter: Record<string, unknown> | null; parents: string[] } {
  const parts: Record<string, unknown>[] = []
  const parents: string[] = []
  if (f.cascades?.length) {
    const c = cascadeFilterFor(f.cascades, parentValue)
    if (c.filter) parts.push(c.filter)
    parents.push(...c.used)
  }
  if (f.optionFilter) {
    const resolved = resolveOptionFilterTokens(f.optionFilter, parentValue)
    if (resolved) parts.push(resolved)
  }
  if (!parts.length) return { filter: null, parents }
  return { filter: parts.length === 1 ? parts[0] : { _and: parts }, parents }
}

/** Does the target hold `value` inside `filter`? The items service's own
 *  compiler, so the check reads exactly as the picker's option query does. */
async function offered(
  target: string,
  value: unknown,
  filter: Record<string, unknown>
): Promise<boolean | null> {
  try {
    const q = db(target).where(`${target}.id`, value as string | number)
    await applyFilterToQuery(q, filter, target)
    const hit = await q.first(`${target}.id as id`)
    return !!hit
  } catch {
    return null
  }
}

async function searchRecords(
  user: User,
  spec: Spec,
  seen: Seen,
  input: Record<string, unknown>,
  cfg?: AutofillConfig,
  hintsUsed?: Set<string>
): Promise<{ result: unknown; summary: string }> {
  const collection = String(input.collection ?? '')
  const query = String(input.query ?? '')
    .trim()
    .slice(0, 200)
  const limit = Math.min(8, Math.max(1, Number(input.limit) || 6))
  const lookup = spec.lookups.get(collection)
  if (!lookup)
    return {
      result: { error: `"${collection}" is not a lookup collection for this record` },
      summary: `refused ${collection}`
    }
  if (!query) return { result: { candidates: [] }, summary: 'empty query' }
  const bucket = seen.get(collection) ?? new Map<string, string>()
  seen.set(collection, bucket)

  if (collection === 'nivaro_users') {
    const res = await listUsers({ search: query, limit, directory: true })
    const rows = (res.data as unknown as Array<Record<string, unknown>>).map((u) => ({
      id: String(u.id),
      label: `${[u.first_name, u.last_name].filter(Boolean).join(' ')} (${u.email})${u.title ? ` · ${u.title}` : ''}`
    }))
    for (const r of rows) bucket.set(r.id, r.label)
    return { result: { candidates: rows }, summary: `${rows.length} people for "${query}"` }
  }

  const tokens = extractTemplateFields(lookup.template).filter((t) => !t.includes('.'))
  const fields = tokens.length ? ['id', ...tokens] : undefined
  // The field being filled decides the narrowing: its cascades over the
  // parents the model already settled, plus its option_filter.
  const fieldName = typeof input.field === 'string' ? input.field : null
  const specField =
    (fieldName &&
      spec.fields.find((f) => f.field === fieldName && f.lookup?.collection === collection)) ||
    spec.fields.find(
      (f) => f.lookup?.collection === collection && (f.cascades?.length || f.optionFilter)
    )
  const parents =
    input.parents && typeof input.parents === 'object' && !Array.isArray(input.parents)
      ? (input.parents as Record<string, unknown>)
      : {}
  const narrowing = specField
    ? pickerFilterFor(specField, (name) => parents[name])
    : { filter: null, parents: [] as string[] }
  let data: Array<Record<string, unknown>> = []
  const run = async (withFilter: boolean, withFields: boolean) =>
    (
      (await readItems(user, collection, {
        search: query,
        limit,
        ...(withFields && fields ? { fields } : {}),
        ...(withFilter && narrowing.filter ? { filter: narrowing.filter } : {})
      })) as { data?: Array<Record<string, unknown>> }
    ).data ?? []
  try {
    data = await run(true, true)
  } catch {
    try {
      data = await run(true, false)
    } catch {
      data = await run(false, false)
    }
  }
  // A bare number may be the id itself (a year, a code) — search only walks
  // text columns, so read it by key too.
  if (/^\d+$/.test(query) && !data.some((r) => String(r.id) === query)) {
    try {
      const res = (await readItems(user, collection, {
        filter: { id: { _eq: Number(query) } },
        limit: 1,
        ...(fields ? { fields } : {})
      })) as { data?: Array<Record<string, unknown>> }
      data = [...(res.data ?? []), ...data]
    } catch {
      // not a numeric key — nothing to add
    }
  }
  const rows = data.map((r) => ({
    id: r.id as string | number,
    label: resolveDisplayValue(r, lookup.template) || String(r.id)
  }))
  for (const r of rows) bucket.set(String(r.id), r.label)
  const result: Record<string, unknown> = { candidates: rows }
  if (narrowing.parents.length) result.narrowed_by = narrowing.parents
  // Keyed hints (#839): once a candidate for this field matches a configured
  // key ("Insight Global"), that key's hints ride the tool result so the
  // model sees them before it submits.
  if (cfg?.keyedHints.length && specField) {
    const fired: string[] = []
    for (const k of cfg.keyedHints) {
      if (k.field !== specField.field) continue
      const needle = k.match.toLowerCase()
      if (rows.some((r) => r.label.toLowerCase().includes(needle))) {
        fired.push(k.hints)
        hintsUsed?.add(`${k.field}:${k.match}`)
      }
    }
    if (fired.length) result.hints = fired
  }
  return { result, summary: `${rows.length} ${collection} for "${query}"` }
}

// ─── Coercion + checks ───────────────────────────────────────────────────────

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.replace(/[$,\s]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}

function coerce(
  f: SpecField,
  raw: unknown,
  seen: Seen
): { value: unknown; display: string | null; ok: boolean; why?: string } {
  if (raw == null || raw === '') return { value: null, display: null, ok: false, why: 'empty' }
  if (f.lookup) {
    const id = typeof raw === 'object' && raw ? (raw as Record<string, unknown>).id : raw
    const key = String(id)
    const label = seen.get(f.lookup.collection)?.get(key)
    if (!label) return { value: null, display: null, ok: false, why: 'id not returned by a lookup' }
    return { value: /^\d+$/.test(key) ? Number(key) : key, display: label, ok: true }
  }
  if (f.choices) {
    const s = String(raw)
    const hit =
      f.choices.find((c) => c.value === s) ??
      f.choices.find((c) => c.text.toLowerCase() === s.toLowerCase())
    if (!hit) return { value: null, display: null, ok: false, why: `not one of the choices` }
    return { value: hit.value, display: hit.text, ok: true }
  }
  const t = f.type
  if (t === 'boolean') {
    if (typeof raw === 'boolean') return { value: raw, display: raw ? 'Yes' : 'No', ok: true }
    const s = String(raw).toLowerCase()
    if (['true', 'yes', '1'].includes(s)) return { value: true, display: 'Yes', ok: true }
    if (['false', 'no', '0'].includes(s)) return { value: false, display: 'No', ok: true }
    return { value: null, display: null, ok: false, why: 'not a boolean' }
  }
  if (['integer', 'bigInteger', 'decimal', 'float'].includes(t)) {
    const n = toNumber(raw)
    if (n == null) return { value: null, display: null, ok: false, why: 'not a number' }
    const v = t === 'integer' || t === 'bigInteger' ? Math.round(n) : n
    return { value: v, display: String(v), ok: true }
  }
  if (['date', 'dateTime', 'datetime', 'timestamp'].includes(t)) {
    const s = String(raw).trim()
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (m) {
      const iso = `${m[1]}-${m[2]}-${m[3]}`
      return { value: iso, display: iso, ok: true }
    }
    const d = new Date(s)
    if (Number.isNaN(d.getTime()))
      return { value: null, display: null, ok: false, why: 'not a date' }
    const iso = d.toISOString().slice(0, 10)
    return { value: iso, display: iso, ok: true }
  }
  if (typeof raw === 'object') return { value: JSON.stringify(raw), display: null, ok: true }
  const s = clampShortText(f, String(raw))
  return { value: s, display: null, ok: true }
}

/** The openai-format gateway hands nested tool arguments back as JSON
 *  STRINGS (`"fields": "[…]"`); the Anthropic SDK path gives real arrays. */
export function unwrap(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const t = v.trim()
  if (!(t.startsWith('[') || t.startsWith('{'))) return v
  try {
    return JSON.parse(t)
  } catch {
    try {
      return JSON.parse(repairQuotes(t))
    } catch {
      return v
    }
  }
}

/**
 * A model that writes JSON as prose leaves quotes inside string values
 * unescaped (`"source": "Insight Global ("Insight Global"), parent…"`). Walk
 * the text: a quote inside a string that is NOT followed by a structural
 * character (`,` `}` `]` `:`) cannot be the closing quote, so escape it.
 */
function repairQuotes(src: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inString) {
      if (ch === '\\') {
        out += ch + (src[i + 1] ?? '')
        i++
        continue
      }
      if (ch === '"') {
        let j = i + 1
        while (j < src.length && /\s/.test(src[j])) j++
        const next = src[j]
        if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
          inString = false
          out += ch
        } else {
          out += '\\"'
        }
        continue
      }
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') inString = true
    out += ch
  }
  return out
}

/** A one-line field (a title, a name) must not receive a paragraph. */
function clampShortText(f: SpecField, value: string): string {
  const oneLine = f.type === 'string' && !/textarea|rich|wysiwyg|editor/.test(f.interface ?? '')
  if (!oneLine || value.length <= 90) return value
  // Cut at the last clause boundary before ~90 chars: a title, not a summary.
  const head = value.slice(0, 90)
  const cut = Math.max(
    head.lastIndexOf(' – '),
    head.lastIndexOf(' — '),
    head.lastIndexOf(' - '),
    head.lastIndexOf('. '),
    head.lastIndexOf('; '),
    head.lastIndexOf(', ')
  )
  return (cut > 24 ? head.slice(0, cut) : head).replace(/[\s,;:–—-]+$/, '').trim()
}

function clampConf(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0.5
  return Math.max(0, Math.min(1, n))
}

function shortSource(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, 200) : null
}

// ─── The run ─────────────────────────────────────────────────────────────────

export const EXTRACT_MAX_ROUNDS = 14

/** The last corrections people made to proposals on this collection — a
 *  field whose proposed value was changed before Create, grouped by the
 *  (from → to) pair so a repeat reads as one memory with a count. */
export async function recentCorrections(collection: string, limit = 20): Promise<CorrectionMemory> {
  const rows = (await db('nivaro_ai_autofill_events')
    .where({ collection })
    .whereNotNull('overrides')
    .orderBy('id', 'desc')
    .limit(60)
    .select('overrides')
    .catch(() => [])) as Array<{ overrides: string | null }>
  const counts = new Map<string, { field: string; from: string; to: string; times: number }>()
  for (const r of rows) {
    let list: unknown
    try {
      list = JSON.parse(r.overrides ?? '[]')
    } catch {
      continue
    }
    if (!Array.isArray(list)) continue
    for (const o of list as Array<Record<string, unknown>>) {
      const field = String(o?.field ?? '')
      const from = String(o?.proposed_display ?? o?.proposed ?? '').slice(0, 80)
      const to = String(o?.final_display ?? o?.final ?? '').slice(0, 80)
      if (!field || !to || from === to) continue
      const key = `${field}\u0000${from}\u0000${to}`
      const hit = counts.get(key)
      if (hit) hit.times++
      else counts.set(key, { field, from, to, times: 1 })
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.times - a.times)
    .slice(0, limit)
    .map((c) => ({ ...c, label: c.field }))
}

/**
 * A document past the prompt cap is CONDENSED (#759): the head rides whole
 * and every later chunk is read once by the model for verbatim passages
 * that could fill the spec's fields, which are appended as excerpts. The
 * fee table on page 40 of a 60-page contract reaches the extraction this
 * way; before, everything past the cap was cut and reported as truncated.
 */
export async function condenseLongDocument(
  ask: (prompt: string) => Promise<string>,
  spec: Spec,
  fullText: string,
  opts: { headChars?: number; chunkChars?: number; maxChunks?: number; cap?: number } = {}
): Promise<{ text: string; chunks: number; excerptChars: number }> {
  const headChars = opts.headChars ?? 42_000
  const chunkChars = opts.chunkChars ?? 45_000
  const maxChunks = opts.maxChunks ?? 8
  const cap = opts.cap ?? MAX_TEXT_CHARS
  const head = fullText.slice(0, headChars)
  const rest = fullText.slice(headChars)
  const wanted = [
    ...spec.fields.map((f) => f.label),
    ...spec.children.flatMap((c) => [c.label, ...c.fields.map((f) => f.label)])
  ]
  const excerpts: string[] = []
  let chunks = 0
  for (let off = 0; off < rest.length && chunks < maxChunks; off += chunkChars) {
    const chunk = rest.slice(off, off + chunkChars)
    chunks++
    const prompt =
      `You are reading part ${chunks + 1} of a long document. Copy out VERBATIM every passage, table row or heading that could give a value for any of these fields: ${wanted.slice(0, 80).join(', ')}. Keep the wording exactly; keep table rows whole. Output only the passages, one per paragraph. Answer NONE when nothing here relates.\n\n` +
      chunk
    let out = ''
    try {
      out = (await ask(prompt)).trim()
    } catch {
      out = ''
    }
    if (out && !/^none\.?$/i.test(out)) excerpts.push(`[excerpt from part ${chunks + 1}]\n${out}`)
  }
  let text = head
  const excerptText = excerpts.join('\n\n')
  if (excerptText) {
    const room = Math.max(0, cap - head.length - 80)
    text += `\n\n[Excerpts from the rest of the document]\n${excerptText.slice(0, room)}`
  }
  return { text, chunks, excerptChars: excerptText.length }
}

function askInputFor(f: SpecField | undefined, spec: Spec): AskInput | null {
  if (!f) return null
  if (f.lookup)
    return {
      type: 'relation',
      collection: f.lookup.collection,
      template: spec.lookups.get(f.lookup.collection)?.template ?? null,
      cascades: f.cascades ?? [],
      option_filter: f.optionFilter ?? null
    }
  if (f.choices) return { type: 'choices', choices: f.choices }
  if (f.type === 'boolean') return { type: 'boolean' }
  if (['integer', 'bigInteger', 'decimal', 'float'].includes(f.type)) return { type: 'number' }
  if (['date', 'dateTime', 'datetime', 'timestamp'].includes(f.type)) return { type: 'date' }
  return { type: 'text' }
}

/** Display label for a relation value the document did not choose (a derived
 *  fill) — one read by id as the caller; empty when unreadable. */
async function labelFor(
  user: User,
  spec: Spec,
  f: SpecField | undefined,
  value: unknown
): Promise<string | null> {
  if (!f?.lookup || value == null) return null
  const known = spec.lookupOptions
    .get(f.lookup.collection)
    ?.find((o) => String(o.id) === String(value))
  if (known) return known.label
  if (f.lookup.collection === 'nivaro_users') {
    const res = await listUsers({
      filter: { id: { _eq: value } },
      limit: 1,
      directory: true
    }).catch(() => null)
    const u = (res?.data as unknown as Array<Record<string, unknown>> | undefined)?.[0]
    return u ? [u.first_name, u.last_name].filter(Boolean).join(' ') : null
  }
  const template = spec.lookups.get(f.lookup.collection)?.template ?? null
  const tokens = extractTemplateFields(template).filter((t) => !t.includes('.'))
  try {
    const res = (await readItems(user, f.lookup.collection, {
      filter: { id: { _eq: value } },
      limit: 1,
      ...(tokens.length ? { fields: ['id', ...tokens] } : {})
    })) as { data?: Array<Record<string, unknown>> }
    const row = res.data?.[0]
    return row ? resolveDisplayValue(row, template) || String(row.id) : null
  } catch {
    return null
  }
}

export type ProposeOptions = {
  layoutId?: number | null
  /** The whole document when it ran past the prompt cap (condensing, #759). */
  fullText?: string | null
  /** Warnings the caller already knows (a document that had no text). */
  extraWarnings?: string[]
}

/** One document handed to the extraction — its text, and its stored file. */
export type SourceDocument = {
  name: string
  text: string
  method: string
  pages: number | null
  truncated: boolean
  fullText?: string | null
  fileId: string | null
}

export async function proposeFromDocument(
  user: User,
  collection: string,
  doc: { name: string; text: string; method: string; pages: number | null; truncated: boolean },
  fileId: string | null,
  opts: ProposeOptions = {}
): Promise<DocumentProposal> {
  return proposeFromDocuments(
    user,
    collection,
    [{ ...doc, fullText: opts.fullText ?? null, fileId }],
    opts
  )
}

/** Several documents describe ONE record (a SOW and its quote): their texts
 *  are read together under per-document headers, every file is attached,
 *  and sources name the document they came from. */
export function combineDocuments(docs: SourceDocument[]): {
  name: string
  text: string
  method: string
  pages: number | null
  truncated: boolean
  fullText: string | null
} {
  if (docs.length === 1) {
    const d = docs[0]
    return {
      name: d.name,
      text: d.text,
      method: d.method,
      pages: d.pages,
      truncated: d.truncated,
      fullText: d.fullText ?? null
    }
  }
  const header = (d: SourceDocument, i: number) =>
    `===== Document ${i + 1} of ${docs.length}: "${d.name}"${d.pages ? ` (${d.pages} pages)` : ''}${d.truncated ? ', truncated' : ''} =====`
  const pages = docs.reduce<number | null>(
    (n, d) => (d.pages == null ? n : (n ?? 0) + d.pages),
    null
  )
  const anyFull = docs.some((d) => d.truncated && d.fullText)
  return {
    name: docs.map((d) => d.name).join(' + '),
    text: docs.map((d, i) => `${header(d, i)}\n\n${d.text}`).join('\n\n'),
    method: docs[0].method,
    pages,
    truncated: docs.some((d) => d.truncated),
    fullText: anyFull
      ? docs.map((d, i) => `${header(d, i)}\n\n${d.fullText ?? d.text}`).join('\n\n')
      : null
  }
}

export async function proposeFromDocuments(
  user: User,
  collection: string,
  docs: SourceDocument[],
  opts: ProposeOptions = {}
): Promise<DocumentProposal> {
  if (!docs.length) throw Object.assign(new Error('No document to read'), { statusCode: 400 })
  const doc = combineDocuments(docs)
  const fileIds = docs.map((d) => d.fileId).filter((id): id is string => !!id)
  const fileId = fileIds[0] ?? null
  opts = { ...opts, fullText: doc.fullText }
  const started = Date.now()
  const { extractModel } = await getAiModelSettings()
  const client = await getAiClient({ model: extractModel })
  if (!client) throw Object.assign(new Error('AI is not configured'), { statusCode: 503 })
  const spec = await buildSpec(user, collection, { layoutId: opts.layoutId ?? null })
  const cfg = await autofillConfig(collection)
  const corrections = await recentCorrections(collection).catch(() => [] as CorrectionMemory)
  for (const c of corrections)
    c.label = spec.fields.find((f) => f.field === c.field)?.label ?? c.field
  const today = new Date().toISOString().slice(0, 10)
  const hintsUsed = new Set<string>()
  if (cfg.hints) hintsUsed.add('collection')
  const system = buildSystemPrompt(spec, today, {
    hints: cfg.hints,
    corrections,
    documents: docs.length
  })
  const seen: Seen = new Map()
  for (const [c, options] of spec.lookupOptions) {
    seen.set(c, new Map(options.map((o) => [String(o.id), o.label])))
  }

  // ── long documents: condense what the cap cut off ──
  let text = doc.text
  let condensed: DocumentProposal['condensed'] = null
  if (doc.truncated && opts.fullText && opts.fullText.length > doc.text.length) {
    const ask = async (prompt: string) => {
      const r = await client.messages.create({
        model: extractModel,
        max_tokens: 1800,
        messages: [{ role: 'user', content: prompt }]
      })
      return r.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
    }
    const c = await condenseLongDocument(ask, spec, opts.fullText)
    text = c.text
    condensed = { chunks: c.chunks, excerpt_chars: c.excerptChars }
  }

  const convo: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content:
        docs.length > 1
          ? `${docs.length} documents describing one record${doc.truncated && !condensed ? ' (some truncated)' : ''}:\n\n${text}`
          : `Document "${doc.name}"${doc.pages ? ` (${doc.pages} pages)` : ''}${doc.truncated && !condensed ? ', truncated' : ''}:\n\n${text}`
    }
  ]

  let raw: Record<string, unknown> | null = null
  let rounds = 0
  let nudged = false
  let modelUsed = extractModel
  for (; rounds < EXTRACT_MAX_ROUNDS && !raw; rounds++) {
    const response = await client.messages.create({
      model: extractModel,
      max_tokens: 4000,
      system,
      tools: TOOLS,
      messages: convo
    })
    if (response.model) modelUsed = response.model
    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    )
    if (toolUses.length === 0 || response.stop_reason !== 'tool_use') {
      if (nudged) break
      nudged = true
      convo.push({ role: 'assistant', content: response.content })
      convo.push({
        role: 'user',
        content: 'Call submit_proposal now with what you have; put anything undetermined in asks.'
      })
      continue
    }
    convo.push({ role: 'assistant', content: response.content })
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>
      if (tu.name === 'submit_proposal') {
        raw = input
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: 'received' })
        continue
      }
      if (tu.name === 'search_records') {
        try {
          const r = await searchRecords(user, spec, seen, input, cfg, hintsUsed)
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(r.result)
          })
        } catch (err) {
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify({ error: (err as Error).message }),
            is_error: true
          })
        }
        continue
      }
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: 'unknown tool',
        is_error: true
      })
    }
    convo.push({ role: 'user', content: results })
  }
  if (!raw)
    throw Object.assign(new Error('The model did not return a proposal'), { statusCode: 502 })
  for (const k of ['fields', 'children', 'm2m', 'asks'] as const) raw[k] = unwrap(raw[k])
  if (raw.children && typeof raw.children === 'object') {
    const ch = raw.children as Record<string, unknown>
    for (const k of Object.keys(ch)) ch[k] = unwrap(ch[k])
  }
  if (raw.m2m && typeof raw.m2m === 'object') {
    const mm = raw.m2m as Record<string, unknown>
    for (const k of Object.keys(mm)) mm[k] = unwrap(mm[k])
  }

  // ── validate + shape ──
  const warnings: string[] = [...(opts.extraWarnings ?? [])]
  const asks: ProposedAsk[] = []
  const specByField = new Map(spec.fields.map((f) => [f.field, f]))
  const fields: ProposedField[] = []
  const values: Record<string, unknown> = {}
  const seenFields = new Set<string>()
  const pushAsk = (a: ProposedAsk) => {
    if (asks.some((x) => x.field === a.field)) return
    asks.push({ ...a, input: a.input ?? askInputFor(specByField.get(a.field), spec) })
  }
  for (const entry of Array.isArray(raw.fields)
    ? (raw.fields as Array<Record<string, unknown>>)
    : []) {
    const name = String(entry?.field ?? '')
    const f = specByField.get(name)
    if (!f || seenFields.has(name)) continue
    seenFields.add(name)
    const c = coerce(f, entry.value, seen)
    const conf = clampConf(entry.confidence)
    if (!c.ok) {
      if (c.why !== 'empty')
        pushAsk({
          field: name,
          label: f.label,
          reason: `Proposed "${String(entry.value)}" — ${c.why}`
        })
      continue
    }
    // #785 — under the field's threshold the value is offered, not filled.
    const threshold = thresholdFor(cfg, name)
    if (conf < threshold) {
      pushAsk({
        field: name,
        label: f.label,
        reason: `Read with ${Math.round(conf * 100)}% confidence, below this field's ${Math.round(threshold * 100)}% bar`,
        candidate: {
          value: c.value,
          display: c.display,
          confidence: conf,
          source: shortSource(entry.source)
        }
      })
      continue
    }
    fields.push({
      field: name,
      label: f.label,
      value: c.value,
      display: c.display,
      confidence: conf,
      source: shortSource(entry.source)
    })
    values[name] = c.value
  }

  // ── cascades: a relation value must be one its picker would offer given
  //    the parents the proposal also carries (Rob: "aware of the layout
  //    cascades / upstreams"). A value outside them becomes an ask with the
  //    candidate kept, naming the parent that excludes it.
  for (const pf of [...fields]) {
    const f = specByField.get(pf.field)
    if (!f?.lookup || !(f.cascades?.length || f.optionFilter)) continue
    const { filter, parents } = pickerFilterFor(f, (name) => values[name])
    if (!filter) continue
    const ok = await offered(f.lookup.collection, pf.value, filter)
    if (ok !== false) continue
    const parentText = parents
      .map((p) => {
        const pl = fields.find((x) => x.field === p)
        return pl
          ? `${pl.label} = ${pl.display ?? String(pl.value)}`
          : (specByField.get(p)?.label ?? p)
      })
      .join(', ')
    fields.splice(fields.indexOf(pf), 1)
    delete values[pf.field]
    pushAsk({
      field: pf.field,
      label: pf.label,
      reason: parentText
        ? `"${pf.display ?? String(pf.value)}" is not offered under ${parentText}`
        : `"${pf.display ?? String(pf.value)}" is not one of this field's allowed options`,
      candidate: {
        value: pf.value,
        display: pf.display,
        confidence: pf.confidence,
        source: pf.source
      }
    })
  }

  // ── derived fills: what the form would do next — cross-record defaults
  //    from the picked links, then the collection's field rules — for
  //    fields the document did not cover. The proposal always wins.
  const derivedFields: ProposedField[] = []
  /** Links a cross-record default copied from a picked record (a project's
   *  zones, regions, funding years) — the "upstream" set the form would stage. */
  const derivedM2m: Array<{ alias: string; ids: Array<string | number>; from: string }> = []
  try {
    const payload: Record<string, unknown> = { ...values }
    const callerFields = new Set(Object.keys(values))
    const filled = await applyCrossRecordDefaults({ collection, payload, callerFields, user })
    for (const k of filled) {
      if (k in values || payload[k] == null) continue
      const sourceLink = Object.entries(values).find(([, v]) => v != null)?.[0]
      const alias = spec.m2m.find((m) => m.alias === k)
      if (alias && Array.isArray(payload[k])) {
        const ids = (payload[k] as unknown[]).filter((v) => v != null) as Array<string | number>
        if (ids.length) derivedM2m.push({ alias: k, ids, from: sourceLink ?? '' })
        continue
      }
      const f = specByField.get(k)
      if (!f) continue
      derivedFields.push({
        field: k,
        label: f.label,
        value: payload[k],
        display: await labelFor(user, spec, f, payload[k]),
        confidence: 1,
        source: null,
        derived: { by: 'cross_record_defaults', from: sourceLink ?? '' }
      })
      values[k] = payload[k]
    }
  } catch {
    // defaults are a courtesy
  }
  try {
    for (const [trigger, tv] of Object.entries({ ...values })) {
      const updates = await evaluateRulesForTrigger(db, collection, trigger, tv, { ...values })
      for (const [k, v] of Object.entries(updates)) {
        if (k in values || v == null || v === '') continue
        const f = specByField.get(k)
        if (!f) continue
        derivedFields.push({
          field: k,
          label: f.label,
          value: v,
          display: await labelFor(user, spec, f, v),
          confidence: 1,
          source: null,
          derived: { by: 'field_rule', from: trigger }
        })
        values[k] = v
      }
    }
  } catch {
    // rules are a courtesy
  }
  for (const d of derivedFields) {
    d.source =
      d.derived?.by === 'field_rule'
        ? `Set by a field rule from ${specByField.get(d.derived.from)?.label ?? d.derived.from}`
        : `Default from ${specByField.get(d.derived?.from ?? '')?.label ?? 'a linked record'}`
    fields.push(d)
  }

  const children: DocumentProposal['children'] = []
  const linesByAlias: Record<string, Array<{ values: Record<string, unknown> }>> = {}
  const rawChildren =
    raw.children && typeof raw.children === 'object'
      ? (raw.children as Record<string, unknown>)
      : {}
  for (const child of spec.children) {
    const rows = rawChildren[child.alias]
    if (!Array.isArray(rows) || rows.length === 0) continue
    const byField = new Map(child.fields.map((f) => [f.field, f]))
    const lines: ProposedLine[] = []
    for (const row of rows.slice(0, 200) as Array<Record<string, unknown>>) {
      const rv = unwrap(row?.values)
      const vals = rv && typeof rv === 'object' ? (rv as Record<string, unknown>) : {}
      const out: Record<string, unknown> = {}
      const display: Record<string, string> = {}
      for (const [k, v] of Object.entries(vals)) {
        const f = byField.get(k)
        if (!f) continue
        const c = coerce(f, v, seen)
        if (!c.ok) {
          if (c.why && c.why !== 'empty')
            warnings.push(`${child.label}: "${f.label}" value "${String(v)}" dropped — ${c.why}`)
          continue
        }
        out[k] = c.value
        if (c.display) display[k] = c.display
      }
      if (Object.keys(out).length === 0) continue
      lines.push({
        values: out,
        display,
        confidence: clampConf(row.confidence),
        source: shortSource(row.source)
      })
    }
    if (lines.length === 0) continue
    children.push({ alias: child.alias, label: child.label, collection: child.collection, lines })
    linesByAlias[child.alias] = lines.map((l) => ({ values: l.values }))

    // Sum check: a numeric column that looks like a money total vs a parent
    // figure the model also set. Reported, never auto-corrected.
    const moneyCol = child.fields.find(
      (f) =>
        /^(amount|total|line_total|extended|value)$/.test(f.field) &&
        ['decimal', 'float', 'integer'].includes(f.type)
    )
    if (moneyCol) {
      const sum = lines.reduce((acc, l) => acc + (toNumber(l.values[moneyCol.field]) ?? 0), 0)
      if (sum > 0) {
        for (const pf of fields) {
          const pv = toNumber(pf.value)
          const sf = specByField.get(pf.field)
          if (pv == null || !sf || !['decimal', 'float', 'integer'].includes(sf.type)) continue
          if (!/amount|total|value|budget|fee/.test(pf.field)) continue
          if (Math.abs(pv - sum) > 0.02) {
            warnings.push(
              `${child.label} ${moneyCol.label} sums to ${sum.toFixed(2)}, but ${pf.label} was proposed as ${pv.toFixed(2)}.`
            )
          }
        }
      }
    }
  }

  const m2mOut: DocumentProposal['m2m'] = []
  const m2mPrefill: Record<string, Array<string | number>> = {}
  const rawM2m = raw.m2m && typeof raw.m2m === 'object' ? (raw.m2m as Record<string, unknown>) : {}
  for (const m of spec.m2m) {
    const rows = rawM2m[m.alias]
    if (!Array.isArray(rows) || rows.length === 0) continue
    const bucket = seen.get(m.collection)
    const items: Array<{ id: string | number; label: string; confidence: number }> = []
    for (const r of rows as Array<Record<string, unknown>>) {
      const id = typeof r === 'object' && r ? r.id : r
      const key = String(id ?? '')
      const label = bucket?.get(key)
      if (!label) {
        warnings.push(`${m.label}: id ${key} was not returned by a lookup — skipped`)
        continue
      }
      items.push({
        id: /^\d+$/.test(key) ? Number(key) : key,
        label,
        confidence: clampConf(r.confidence)
      })
    }
    if (!items.length) continue
    m2mOut.push({ alias: m.alias, label: m.label, items })
    m2mPrefill[m.alias] = items.map((i) => i.id)
  }
  for (const d of derivedM2m) {
    if (m2mPrefill[d.alias]) continue
    const m = spec.m2m.find((x) => x.alias === d.alias)
    if (!m) continue
    const labels = new Map<string, string>()
    const known = spec.lookupOptions.get(m.collection)
    if (known) for (const o of known) labels.set(String(o.id), o.label)
    if (!known) {
      try {
        const template = spec.lookups.get(m.collection)?.template ?? null
        const tokens = extractTemplateFields(template).filter((t) => !t.includes('.'))
        const res = (await readItems(user, m.collection, {
          filter: { id: { _in: d.ids } },
          limit: d.ids.length,
          ...(tokens.length ? { fields: ['id', ...tokens] } : {})
        })) as { data?: Array<Record<string, unknown>> }
        for (const r of res.data ?? [])
          labels.set(String(r.id), resolveDisplayValue(r, template) || String(r.id))
      } catch {
        // unlabelled ids still link
      }
    }
    const items = d.ids.map((id) => ({
      id,
      label: labels.get(String(id)) ?? String(id),
      confidence: 1
    }))
    m2mOut.push({
      alias: d.alias,
      label: `${m.label} (from ${specByField.get(d.from)?.label ?? d.from})`,
      items
    })
    m2mPrefill[d.alias] = d.ids
  }
  if (fileIds.length && spec.attachAlias) m2mPrefill[spec.attachAlias] = fileIds

  for (const a of Array.isArray(raw.asks) ? (raw.asks as Array<Record<string, unknown>>) : []) {
    const name = String(a?.field ?? '')
    if (!name || (seenFields.has(name) && values[name] != null)) continue
    const f = specByField.get(name)
    pushAsk({
      field: name,
      label: f?.label ?? titleCase(name),
      reason: String(a?.reason ?? '').slice(0, 300)
    })
  }
  // Required fields the document never covered are asks too.
  for (const f of spec.fields) {
    if (!f.required || values[f.field] != null) continue
    pushAsk({ field: f.field, label: f.label, reason: 'Required, and the document does not say' })
  }

  return {
    id: randomUUID(),
    request_id: currentTraceMeta()?.id ?? null,
    collection,
    layout_id: spec.layoutId,
    summary: String(raw.summary ?? '').slice(0, 500),
    fields,
    children,
    m2m: m2mOut,
    asks,
    warnings,
    prefill: {
      values,
      lines_by_alias: linesByAlias,
      m2m: m2mPrefill,
      file_id: fileId,
      file_ids: fileIds,
      attach_alias: spec.attachAlias
    },
    document: {
      name: doc.name,
      method: doc.method,
      pages: doc.pages,
      truncated: doc.truncated && !condensed,
      chars: text.length,
      documents: docs.map((d) => ({
        name: d.name,
        method: d.method,
        pages: d.pages,
        truncated: d.truncated,
        chars: d.text.length,
        file_id: d.fileId
      }))
    },
    model: modelUsed,
    rounds,
    latency_ms: Date.now() - started,
    condensed,
    hints_used: [...hintsUsed]
  }
}
