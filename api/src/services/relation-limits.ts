/**
 * Relation limits enforced on write.
 *
 * Two grid / picker options were judged in the browser only:
 *   unique_by    rows of one parent may not repeat the same values
 *   max_values   a record may hold at most N links of one kind
 * so a write through the API, an import or a second browser tab could store
 * what the form refuses. A limit is enforced on every write once its options
 * carry `enforce_on_write: true`, on the field itself or on its assignment in
 * the collection's ACTIVE grouped layout.
 *
 * It is opt-in on purpose: a limit is often true for one layout only (a form
 * that takes one region, beside another that takes several), and a rule
 * enforced on the relation binds every writer.
 *
 * This module must not import the items service (the items service calls it).
 */
import { db } from '../db/index.js'

interface UniqueRule {
  kind: 'unique'
  parentCollection: string
  alias: string
  /** The collection the rows live in, and its link to the parent. */
  collection: string
  fk: string
  fields: string[]
}

interface LimitRule {
  kind: 'limit'
  parentCollection: string
  alias: string
  /** The junction the links live in, and its link to the parent. */
  collection: string
  fk: string
  max: number
}

type Rule = UniqueRule | LimitRule

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const TTL = 60_000
let cache: { at: number; byCollection: Map<string, Rule[]> } | null = null

export function clearRelationLimitCache(): void {
  cache = null
  maxCache.clear()
}

const maxCache = new Map<string, { at: number; max: Map<string, number> }>()

/**
 * The link limit each many-to-many field of a collection declares (the field's
 * own options, overridden by the active grouped layout), enforced or not. A
 * default that fills links reads it, as the form does.
 */
export async function declaredLinkLimits(collection: string): Promise<Map<string, number>> {
  const hit = maxCache.get(collection)
  if (hit && Date.now() - hit.at < TTL) return hit.max
  const max = new Map<string, number>()
  const take = (field: string, o: Record<string, unknown> | null | undefined) => {
    const n = Number(o?.max_values)
    if (Number.isInteger(n) && n > 0) max.set(field, n)
  }
  try {
    const fields = (await db('nivaro_fields')
      .where({ collection })
      .whereRaw("options LIKE '%max_values%'")
      .select('field', 'options')) as Array<{ field: string; options: string | null }>
    for (const f of fields) take(f.field, parseJson<Record<string, unknown>>(f.options))
    const rows = (await db('nivaro_layout_field_assignments as a')
      .join('nivaro_collection_layouts as l', 'l.id', 'a.layout_id')
      .where('l.collection', collection)
      .where('l.is_active', true)
      .where('l.layout_type', 'grouped')
      .whereRaw("a.overrides LIKE '%max_values%'")
      .select('a.field', 'a.overrides')) as Array<{ field: string; overrides: string | null }>
    for (const r of rows)
      take(r.field, parseJson<{ options?: Record<string, unknown> }>(r.overrides)?.options)
  } catch {
    // no limits known
  }
  maxCache.set(collection, { at: Date.now(), max })
  return max
}

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return null
  }
}

async function build(): Promise<Map<string, Rule[]>> {
  const out = new Map<string, Rule[]>()
  const sources: Array<{ parent: string; field: string; options: Record<string, unknown> }> = []

  const fieldRows = (await db('nivaro_fields')
    .whereRaw("options LIKE '%enforce_on_write%'")
    .select('collection', 'field', 'options')) as Array<{
    collection: string
    field: string
    options: string | null
  }>
  for (const r of fieldRows) {
    const o = parseJson<Record<string, unknown>>(r.options)
    if (o?.enforce_on_write === true)
      sources.push({ parent: r.collection, field: r.field, options: o })
  }

  const layoutRows = (await db('nivaro_layout_field_assignments as a')
    .join('nivaro_collection_layouts as l', 'l.id', 'a.layout_id')
    .where('l.is_active', true)
    .where('l.layout_type', 'grouped')
    .whereRaw("a.overrides LIKE '%enforce_on_write%'")
    .select('l.collection as parent', 'a.field', 'a.overrides')) as Array<{
    parent: string
    field: string
    overrides: string | null
  }>
  for (const r of layoutRows) {
    const o = parseJson<{ options?: Record<string, unknown> }>(r.overrides)?.options
    if (o?.enforce_on_write === true) sources.push({ parent: r.parent, field: r.field, options: o })
  }
  if (sources.length === 0) return out

  const parents = [...new Set(sources.map((s) => s.parent))]
  const rels = (await db('nivaro_relations')
    .whereIn('one_collection', parents)
    .select(
      'one_collection',
      'one_field',
      'many_collection',
      'many_field',
      'junction_field'
    )) as Array<{
    one_collection: string
    one_field: string | null
    many_collection: string
    many_field: string
    junction_field: string | null
  }>

  const seen = new Set<string>()
  for (const s of sources) {
    const rel = rels.find(
      (r) =>
        r.one_collection === s.parent && (r.one_field === s.field || r.many_collection === s.field)
    )
    if (!rel || !IDENT.test(rel.many_collection) || !IDENT.test(rel.many_field)) continue
    if (/^nivaro_|^directus_/i.test(rel.many_collection)) continue
    const push = (rule: Rule, key: string) => {
      if (seen.has(key)) return
      seen.add(key)
      const list = out.get(rule.collection) ?? []
      list.push(rule)
      out.set(rule.collection, list)
    }
    const unique = Array.isArray(s.options.unique_by)
      ? (s.options.unique_by as unknown[]).map(String).filter((f) => IDENT.test(f))
      : []
    if (!rel.junction_field && unique.length > 0) {
      push(
        {
          kind: 'unique',
          parentCollection: s.parent,
          alias: s.field,
          collection: rel.many_collection,
          fk: rel.many_field,
          fields: unique
        },
        `u:${rel.many_collection}:${rel.many_field}:${unique.join(',')}`
      )
    }
    const max = Number(s.options.max_values)
    if (rel.junction_field && Number.isInteger(max) && max > 0) {
      push(
        {
          kind: 'limit',
          parentCollection: s.parent,
          alias: s.field,
          collection: rel.many_collection,
          fk: rel.many_field,
          max
        },
        `l:${rel.many_collection}:${rel.many_field}`
      )
    }
  }
  return out
}

async function rulesFor(collection: string): Promise<Rule[]> {
  if (!cache || Date.now() - cache.at > TTL) {
    cache = { at: Date.now(), byCollection: await build() }
  }
  return cache.byCollection.get(collection) ?? []
}

const empty = (v: unknown) => v === null || v === undefined || v === ''

function refuse(code: string, message: string, extra: Record<string, unknown>) {
  return Object.assign(new Error(message), { statusCode: 409, code, ...extra })
}

/**
 * Refuse a write that would break a limit of the relation it belongs to.
 * `row` is the row as it would be stored (an update: stored values with the
 * write on top). `id` is the row's own id on an update.
 *
 * A failure to READ the rules never stops a write; a broken limit does.
 */
export async function enforceRelationLimits(
  collection: string,
  row: Record<string, unknown>,
  id?: string | number | null,
  changed?: Set<string>
): Promise<void> {
  let rules: Rule[]
  try {
    rules = await rulesFor(collection)
  } catch {
    return
  }
  for (const rule of rules) {
    const parent = row[rule.fk]
    if (empty(parent) || typeof parent === 'object') continue
    if (rule.kind === 'unique') {
      // An update that touches none of the fields cannot create a duplicate.
      if (changed && !changed.has(rule.fk) && !rule.fields.some((f) => changed.has(f))) continue
      const q = db(rule.collection).where({ [rule.fk]: parent as string | number })
      for (const f of rule.fields) {
        const v = row[f]
        if (empty(v)) q.where((w) => w.whereNull(f).orWhere(f, ''))
        else q.where(f, v as string | number | boolean | Date)
      }
      if (id != null) q.whereNot({ id })
      const hit = (await q.first('id')) as { id: string | number } | undefined
      if (hit) {
        throw refuse(
          'DUPLICATE_ROW',
          `A row with the same ${rule.fields.join(' + ')} already exists on this ${rule.parentCollection} record`,
          {
            rule: { kind: 'unique_by', collection: rule.parentCollection, field: rule.alias },
            fields: rule.fields,
            existing_id: hit.id
          }
        )
      }
    } else {
      if (changed && !changed.has(rule.fk)) continue
      const q = db(rule.collection).where({ [rule.fk]: parent as string | number })
      if (id != null) q.whereNot({ id })
      const counted = (await q.count({ n: '*' }).first()) as { n?: number | string } | undefined
      const n = Number(counted?.n ?? 0)
      if (n >= rule.max) {
        throw refuse(
          'LINK_LIMIT_REACHED',
          `"${rule.alias}" on ${rule.parentCollection} holds ${rule.max} at most, and this record has ${n}`,
          {
            rule: { kind: 'max_values', collection: rule.parentCollection, field: rule.alias },
            max: rule.max,
            current: n
          }
        )
      }
    }
  }
}
