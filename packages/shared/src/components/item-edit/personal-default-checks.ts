import type { Command } from '@nivaro/sdk'
import { get } from '../../lib/commands'
import { resolveOptionFilterTokens } from '../../lib/option-filter-tokens'
import { isEmptyValue } from '../../lib/personal-defaults'
import { choiceLabel } from '../../lib/utils'
import { renderDisplayTemplate, USER_SYSTEM_COLS, userDisplayLabel } from '../pipeline/relations'
import { buildCascadeFilter, getCascadeFilters, parseJson } from './helpers'
import type { CMSField, CMSRelation } from './types'

// Re-validation of a saved personal default before the form applies it (spec call 6):
// relations through the same query the pickers make (option filter + cascade, `picker=1`, so
// picker exclusions and read access apply as the person), choices against the field's current
// list, scalars by type. Labels are for the hints only.

type Requester = { request: <T>(cmd: Command<T>) => Promise<T> }

export type PersonalDefaultChecksInput = {
  client: Requester
  collection: string
  fields: CMSField[]
  relations: CMSRelation[]
  /** The field's current value: the draft, or an M2M alias's effective ids. */
  readValue: (field: string) => unknown
}

function plain(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'id' in (v as object))
    return (v as { id: unknown }).id
  return v
}
function ids(v: unknown): string[] {
  const list = Array.isArray(v) ? v : isEmptyValue(v) ? [] : [v]
  return list.map((x) => String(plain(x)))
}

/** The collection a relation field picks from (M2O target, or an M2M alias's far end). */
export function pickedCollection(
  relations: CMSRelation[],
  collection: string,
  field: string
): { target: string; kind: 'm2o' | 'm2m' } | null {
  const m2o = relations.find(
    (r) => r.many_collection === collection && r.many_field === field && !r.junction_field
  )
  if (m2o?.one_collection) return { target: m2o.one_collection, kind: 'm2o' }
  const alias = relations.find((r) => r.one_collection === collection && r.one_field === field)
  if (!alias?.many_collection || alias.many_field == null) return null
  // The junction's other leg (junction_field is the pairing marker; FieldRenderer's fallback
  // takes any other relation on the junction).
  const far =
    relations.find(
      (c) =>
        c.many_collection === alias.many_collection &&
        alias.junction_field != null &&
        c.many_field === alias.junction_field
    ) ?? relations.find((c) => c.many_collection === alias.many_collection && c.id !== alias.id)
  if (!far?.one_collection) return null
  return { target: far.one_collection, kind: 'm2m' }
}

type Choice = { value: unknown; text?: string }
function choicesOf(fc: CMSField): Choice[] | null {
  if ((fc.interface ?? '') === 'tags') return null
  const raw = parseJson<{ choices?: unknown }>(fc.options)?.choices
  if (!Array.isArray(raw) || raw.length === 0) return null
  return raw.map((c) =>
    c && typeof c === 'object' ? (c as Choice) : { value: c, text: String(c) }
  )
}

function scalarOk(fc: CMSField, v: unknown): boolean {
  const t = (fc.type ?? '').toLowerCase()
  if (typeof v === 'object') return t === 'json' || t === 'csv'
  if (t === 'integer' || t === 'biginteger')
    return typeof v !== 'boolean' && v !== '' && Number.isInteger(Number(v))
  if (t === 'float' || t === 'decimal')
    return typeof v !== 'boolean' && v !== '' && Number.isFinite(Number(v))
  if (t === 'boolean') return typeof v === 'boolean'
  if (t === 'date' || t === 'datetime' || t === 'timestamp')
    return !Number.isNaN(Date.parse(String(v)))
  if (t === 'time') return /^\d{1,2}:\d{2}/.test(String(v))
  if (typeof v === 'boolean') return false
  if (fc.max_length != null && String(v).length > fc.max_length) return false
  return true
}

export function makePersonalDefaultChecks(input: PersonalDefaultChecksInput) {
  const { client, collection, fields, relations, readValue } = input
  const byName = new Map(fields.map((f) => [f.field, f]))
  const view = () => {
    const out: Record<string, unknown> = {}
    for (const f of fields) {
      const v = readValue(f.field)
      if (v !== undefined) out[f.field] = v
    }
    return out
  }

  /** true = pickable, false = checked and refused, null = the check could not run. */
  async function revalidate(field: string, value: unknown): Promise<boolean | null> {
    const fc = byName.get(field)
    if (!fc || isEmptyValue(value)) return false
    if ((fc.interface ?? '').startsWith('file')) return false
    const rel = pickedCollection(relations, collection, field)
    if (rel) {
      const want = ids(value)
      if (want.length === 0) return false
      if (rel.kind === 'm2o' && want.length > 1) return false
      const opts = parseJson<{ option_filter?: Record<string, unknown>; max_values?: number }>(
        fc.options
      )
      if (rel.kind === 'm2m' && opts?.max_values != null && want.length > opts.max_values)
        return false
      const draft = view()
      // Twin of FieldRow's cascade build (FieldRow.tsx `cascadeCompiled`), parents read the same
      // way. Not mirrored: FieldRow's `skipParent` (a parent THIS field's own pick derived) —
      // there is no pick yet when a default is checked. Change both together.
      const cascade = buildCascadeFilter({
        rules: getCascadeFilters(fc.dependency_config),
        parentValue: (p) => {
          const v = readValue(p)
          if (isEmptyValue(v)) return null
          if (!Array.isArray(v)) return plain(v)
          const list = ids(v)
          return list.length === 1 ? list[0] : list
        },
        parentOptionFilter: (p) => {
          const raw = parseJson<{ option_filter?: Record<string, unknown> }>(
            byName.get(p)?.options ?? null
          )?.option_filter
          return raw && typeof raw === 'object'
            ? resolveOptionFilterTokens(raw, draft, 'new')
            : undefined
        }
      }).filter
      // FieldRenderer applies the field's own option_filter to M2O pickers only.
      const own =
        rel.kind === 'm2o' && opts?.option_filter && typeof opts.option_filter === 'object'
          ? resolveOptionFilterTokens(opts.option_filter, draft, 'new')
          : undefined
      const filter = { _and: [{ id: { _in: want } }, own, cascade].filter(Boolean) }
      try {
        const res = await client.request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${rel.target}`, {
            filter: JSON.stringify(filter),
            picker: '1',
            fields: 'id',
            limit: want.length
          })
        )
        const found = new Set((res?.data ?? []).map((r) => String(r.id)))
        return want.every((id) => found.has(id))
      } catch {
        // Network / server trouble is not "no longer available": the form skips quietly.
        return null
      }
    }
    const choices = choicesOf(fc)
    if (choices) {
      const allowed = new Set(choices.map((c) => String(c.value)))
      const list = Array.isArray(value) ? value : [value]
      return list.every((v) => allowed.has(String(v)))
    }
    if (Array.isArray(value)) return (fc.type ?? '').toLowerCase() === 'json' || fc.type === 'csv'
    return scalarOk(fc, value)
  }

  // The label the picker shows: the target's display template (the users picker's own
  // template for nivaro_users), read as the caller; null when nothing but an id is known.
  const labels = new Map<string, Promise<string | null>>()
  function valueLabel(field: string, value: unknown): Promise<string | null> {
    const fc = byName.get(field)
    const v = plain(value)
    const text = String(v ?? '')
    if (!fc) return Promise.resolve(null)
    const choices = choicesOf(fc)
    if (choices) {
      const hit = choices.find((c) => String(c.value) === text)
      return Promise.resolve(hit?.text ? choiceLabel(hit.text) : null)
    }
    if (typeof v === 'boolean') return Promise.resolve(v ? 'Yes' : 'No')
    const rel = pickedCollection(relations, collection, field)
    // A plain value is its own label (a number, a date, a word).
    if (!rel) return Promise.resolve(text || null)
    const key = `${rel.target}:${text}`
    const cached = labels.get(key)
    if (cached) return cached
    const p = (async () => {
      const meta = await client
        .request<{ data: { display_template?: string | null } }>(get(`/collections/${rel.target}`))
        .catch(() => null)
      const template =
        meta?.data?.display_template ??
        (USER_SYSTEM_COLS.has(rel.target) ? '{{first_name}} {{last_name}} ({{email}})' : null)
      const tokens = template ? [...template.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]) : []
      const rows = await client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${rel.target}`, {
            filter: JSON.stringify({ id: { _eq: text } }),
            limit: 1,
            ...(tokens.length ? { fields: ['id', ...tokens].join(',') } : {})
          })
        )
        .catch(() => null)
      const row = rows?.data?.[0]
      if (!row) return null
      const shown = (
        USER_SYSTEM_COLS.has(rel.target) && !meta?.data?.display_template
          ? userDisplayLabel(row)
          : renderDisplayTemplate(template, row)
      ).trim()
      // Nothing readable, or only the id again: no label.
      if (!/[\p{L}\p{N}]/u.test(shown) || shown === String(row.id) || shown === text) return null
      return shown
    })()
    labels.set(key, p)
    return p
  }

  return { revalidate, valueLabel }
}
