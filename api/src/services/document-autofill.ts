import type Anthropic from '@anthropic-ai/sdk'
import { db } from '../db/index.js'
import type { CMSField, CMSRelation, User } from '../types.js'
import { getAiClient, getAiModelSettings } from './ai-client.js'
import { getCollection, getFields, getRelations } from './collections.js'
import { extractTemplateFields, resolveDisplayValue } from './display-value.js'
import { readItems } from './items.js'
import { can } from './permissions.js'
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
}

export type ProposedLine = {
  values: Record<string, unknown>
  display: Record<string, string>
  confidence: number
  source: string | null
}

export type ProposedAsk = { field: string; label: string; reason: string }

export type DocumentProposal = {
  collection: string
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
    attach_alias: string | null
  }
  document: {
    name: string
    method: string
    pages: number | null
    truncated: boolean
    chars: number
  }
  model: string
  rounds: number
}

// ─── Spec: what the model may fill ───────────────────────────────────────────

type SpecField = {
  field: string
  label: string
  type: string
  interface: string | null
  note: string | null
  required: boolean
  choices?: Array<{ value: string; text: string }>
  lookup?: { collection: string; label: string }
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

async function layoutFieldSet(collection: string): Promise<Set<string> | null> {
  const layout = (await db('nivaro_collection_layouts')
    .where({ collection, layout_type: 'grouped', is_active: 1 })
    .first('id')
    .catch(() => null)) as { id: number } | null
  if (!layout) return null
  const rows = (await db('nivaro_layout_field_assignments')
    .where({ layout_id: layout.id })
    .select('field', 'is_visible')) as Array<{ field: string; is_visible: boolean | number | null }>
  const set = new Set<string>()
  for (const r of rows) {
    if (r.is_visible === false || r.is_visible === 0) continue
    set.add(r.field)
  }
  return set.size ? set : null
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

export async function buildSpec(user: User, collection: string): Promise<Spec> {
  const meta = await getCollection(collection)
  if (!meta) throw new Error(`Collection "${collection}" not found`)
  const rels = await getRelations(collection)
  const lookups: Spec['lookups'] = new Map()
  const assigned = await layoutFieldSet(collection)
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
    attachAlias
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
        limit: { type: 'integer', minimum: 1, maximum: 8 }
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

function buildSystemPrompt(spec: Spec, today: string): string {
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
    '- Rich text or long text fields (objective, scope, notes) take a concise plain-text paragraph or bullet lines from the document, not the whole document. Short text fields (a description, name or title) take one line under 120 characters — a title, not a summary.',
    '- Relation fields on child rows (a category, a line type, an item) need a lookup or a listed id too; leave one out rather than guess.',
    '- A number in the document that IS an id (a year, a code) matches a listed option by id directly.',
    '- Do not fill audit, status, state or approval fields. Do not fill a field the document says nothing about.',
    '- A child collection whose fields are months or periods is a schedule: when the document states a total and a term but no month-by-month breakdown, propose one row per calendar year with the total spread evenly across the months inside the term (and its total field set), and say so in the source. Never spread across months outside the term.',
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
  return lines.join('\n')
}

// ─── Lookup execution (permission-checked, ids remembered) ───────────────────

type Seen = Map<string, Map<string, string>> // collection → id → label

async function searchRecords(
  user: User,
  spec: Spec,
  seen: Seen,
  input: Record<string, unknown>
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
  let data: Array<Record<string, unknown>> = []
  try {
    const res = (await readItems(user, collection, {
      search: query,
      limit,
      ...(fields ? { fields } : {})
    })) as {
      data?: Array<Record<string, unknown>>
    }
    data = res.data ?? []
  } catch {
    const res = (await readItems(user, collection, { search: query, limit })) as {
      data?: Array<Record<string, unknown>>
    }
    data = res.data ?? []
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
  return { result: { candidates: rows }, summary: `${rows.length} ${collection} for "${query}"` }
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
  if (!oneLine || value.length <= 160) return value
  const head = value.slice(0, 160)
  const cut = Math.max(
    head.lastIndexOf(' – '),
    head.lastIndexOf(' — '),
    head.lastIndexOf('. '),
    head.lastIndexOf('; ')
  )
  return (cut > 40 ? head.slice(0, cut) : head).trim()
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

export async function proposeFromDocument(
  user: User,
  collection: string,
  doc: { name: string; text: string; method: string; pages: number | null; truncated: boolean },
  fileId: string | null
): Promise<DocumentProposal> {
  const { extractModel } = await getAiModelSettings()
  const client = await getAiClient({ model: extractModel })
  if (!client) throw Object.assign(new Error('AI is not configured'), { statusCode: 503 })
  const spec = await buildSpec(user, collection)
  const today = new Date().toISOString().slice(0, 10)
  const system = buildSystemPrompt(spec, today)
  const seen: Seen = new Map()
  for (const [c, opts] of spec.lookupOptions) {
    seen.set(c, new Map(opts.map((o) => [String(o.id), o.label])))
  }

  const convo: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Document "${doc.name}"${doc.pages ? ` (${doc.pages} pages)` : ''}${doc.truncated ? ', truncated' : ''}:\n\n${doc.text}`
    }
  ]

  let raw: Record<string, unknown> | null = null
  let rounds = 0
  let nudged = false
  for (; rounds < EXTRACT_MAX_ROUNDS && !raw; rounds++) {
    const response = await client.messages.create({
      model: extractModel,
      max_tokens: 4000,
      system,
      tools: TOOLS,
      messages: convo
    })
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
          const r = await searchRecords(user, spec, seen, input)
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
  const warnings: string[] = []
  const asks: ProposedAsk[] = []
  const specByField = new Map(spec.fields.map((f) => [f.field, f]))
  const fields: ProposedField[] = []
  const values: Record<string, unknown> = {}
  const seenFields = new Set<string>()
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
        asks.push({
          field: name,
          label: f.label,
          reason: `Proposed "${String(entry.value)}" — ${c.why}`
        })
      continue
    }
    if (conf < 0.4) {
      asks.push({
        field: name,
        label: f.label,
        reason: `Low confidence (${Math.round(conf * 100)}%): ${c.display ?? String(c.value)}`
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
  if (fileId && spec.attachAlias) m2mPrefill[spec.attachAlias] = [fileId]

  for (const a of Array.isArray(raw.asks) ? (raw.asks as Array<Record<string, unknown>>) : []) {
    const name = String(a?.field ?? '')
    if (!name || (seenFields.has(name) && values[name] != null)) continue
    if (asks.some((x) => x.field === name)) continue
    const f = specByField.get(name)
    asks.push({
      field: name,
      label: f?.label ?? titleCase(name),
      reason: String(a?.reason ?? '').slice(0, 300)
    })
  }
  // Required fields the document never covered are asks too.
  for (const f of spec.fields) {
    if (!f.required || values[f.field] != null) continue
    if (asks.some((x) => x.field === f.field)) continue
    asks.push({ field: f.field, label: f.label, reason: 'Required, and the document does not say' })
  }

  return {
    collection,
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
      attach_alias: spec.attachAlias
    },
    document: {
      name: doc.name,
      method: doc.method,
      pages: doc.pages,
      truncated: doc.truncated,
      chars: doc.text.length
    },
    model: extractModel,
    rounds
  }
}
