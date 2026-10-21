import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { readItems } from '../items.js'
import { withReadGate } from '../read-gate.js'
import { cleanText, titleCase } from './model.js'

/**
 * What the AI rule writers (#2673 #2674 #2675 #2680) know about a collection:
 * field metadata, choice labels and relations — configuration only. Record
 * VALUES never reach the model; when a writer tests a proposal against stored
 * records it reads them here, as the admin, through the items service and the
 * read gate, and only counts leave the server.
 */

export interface FieldMeta {
  field: string
  label: string
  type: string
  interface: string | null
  /** Choice value → label (dropdowns, radios), capped. */
  choices: Array<{ value: string; label: string }>
}

export interface RelationMeta {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

const MAX_CHOICES = 40
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/

function parseObj(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A Directus `$t:` key reads as words; any other label as stored. */
function choiceText(v: unknown): string {
  const s = String(v ?? '')
  return s.startsWith('$t:') ? titleCase(s.slice(3)) : s
}

export function choicesOf(options: unknown): Array<{ value: string; label: string }> {
  const list = parseObj(options)?.choices
  if (!Array.isArray(list)) return []
  const out: Array<{ value: string; label: string }> = []
  for (const c of list.slice(0, MAX_CHOICES)) {
    if (!c || typeof c !== 'object') continue
    const { value, text } = c as { value?: unknown; text?: unknown }
    if (value == null) continue
    out.push({ value: String(value), label: cleanText(choiceText(text ?? value), 60) ?? '' })
  }
  return out
}

export async function loadFieldMeta(collection: string): Promise<FieldMeta[]> {
  const rows = (await db('nivaro_fields')
    .where({ collection })
    .select('field', 'label', 'type', 'interface', 'options')) as Array<Record<string, unknown>>
  return rows
    .filter((r) => typeof r.field === 'string' && IDENT.test(r.field as string))
    .map((r) => ({
      field: String(r.field),
      label: cleanText(r.label, 80) ?? titleCase(String(r.field)),
      type: String(r.type ?? 'string'),
      interface: typeof r.interface === 'string' ? r.interface : null,
      choices: choicesOf(r.options)
    }))
}

export async function loadRelations(collection: string): Promise<RelationMeta[]> {
  const rows = (await db('nivaro_relations')
    .where({ many_collection: collection })
    .orWhere({ one_collection: collection })
    .select(
      'many_collection',
      'many_field',
      'one_collection',
      'one_field',
      'junction_field'
    )) as RelationMeta[]
  return rows.filter((r) => r.many_collection && r.many_field)
}

/** M2O fields of `collection`: field → the collection it points at. */
export function m2oTargets(collection: string, rels: RelationMeta[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of rels) {
    if (r.many_collection !== collection || !r.one_collection || r.junction_field) continue
    out.set(r.many_field, r.one_collection)
  }
  return out
}

/**
 * M2M aliases of `collection`: alias → the far collection. The alias is the
 * `one_field` of the junction leg pointing back at `collection`; the far end is
 * the junction's other leg (its `junction_field` names the pairing column).
 */
export function m2mTargets(collection: string, rels: RelationMeta[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of rels) {
    if (r.one_collection !== collection || !r.one_field || !r.junction_field) continue
    const far = rels.find(
      (x) => x.many_collection === r.many_collection && x.many_field === r.junction_field
    )
    if (far?.one_collection) out.set(r.one_field, far.one_collection)
  }
  return out
}

/** Real (stored) columns: not aliases, not system placeholders. */
export function isValueField(f: FieldMeta): boolean {
  return f.type !== 'alias' && !f.field.startsWith('__')
}

/** The newest-first sort for samples: a created stamp when the collection has one, else id. */
export function newestSort(fields: FieldMeta[]): string {
  const names = new Set(fields.map((f) => f.field))
  for (const f of ['date_created', 'created_at', 'created_on']) if (names.has(f)) return `-${f}`
  return '-id'
}

/**
 * Up to `limit` newest records of `collection`, only `fields` (+ id), read as
 * `user` (an admin: policies, row filters and User Scopes still apply) through
 * the heavy-read gate. Pages of 500 so a large sample never asks for one huge page.
 */
export async function sampleRows(
  user: User,
  collection: string,
  fields: string[],
  limit: number,
  opts: { sort?: string; filter?: Record<string, unknown> } = {}
): Promise<Array<Record<string, unknown>>> {
  const meta = opts.sort ? null : await loadFieldMeta(collection)
  const sort = opts.sort ?? newestSort(meta ?? [])
  const wanted = [...new Set(['id', ...fields.filter((f) => IDENT.test(f))])]
  return withReadGate(
    user.id,
    async () => {
      const out: Array<Record<string, unknown>> = []
      for (let offset = 0; out.length < limit; offset += 500) {
        const page = Math.min(500, limit - out.length)
        const res = (await readItems(user, collection, {
          fields: wanted,
          sort: [sort],
          limit: page,
          offset,
          count: false,
          ...(opts.filter ? { filter: opts.filter } : {})
        })) as { data?: Array<Record<string, unknown>> }
        const rows = Array.isArray(res?.data) ? res.data : []
        out.push(...rows)
        if (rows.length < page) break
      }
      return out
    },
    { label: `ai-rules:${collection}` }
  )
}
