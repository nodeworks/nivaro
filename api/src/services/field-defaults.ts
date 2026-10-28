/**
 * Personal field defaults (spec docs/superpowers/specs/2026-10-28-personal-field-defaults-design.md).
 *
 * One row of nivaro_user_field_defaults = the value a person wants a new record of
 * `collection` prefilled with for `field`, optionally only under certain parent values
 * (`context`, e.g. { zone: 5 }). context_key hashes the canonical context so the unique
 * index (user, collection, field, context_key) treats "no context" as one slot.
 *
 * Saving is judged AS the person the default belongs to (`target`), never as the admin
 * saving it for them: create permission on the collection, the field in their create
 * field list, a layout they can get that turns the field's personal_default toggle on,
 * and every id in the value readable by them (readOne as the target). A default must
 * never become a way to set a field, or pick a value, the person couldn't themselves.
 * Picker filters / cascades stay client-side (curation, not security); the form re-checks
 * on apply.
 */
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { selectInChunks } from './db-batch.js'
import { readOne } from './items.js'
import { roleAllows } from './layout-patch.js'
import { todayInInstance, windowOpen } from './layout-resolve-rules.js'
import { can, getAllowedFields, isAdminRole } from './permissions.js'

const TABLE = 'nivaro_user_field_defaults'
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Contexts one person may keep for one field (spec call 10). */
export const MAX_CONTEXTS = 20
const MAX_CONTEXT_KEYS = 10
const MAX_JSON_CHARS = 4000
const MAX_IDS = 50
/** readOne calls one save runs at once: each is several permission queries on the request pool. */
export const READ_CONCURRENCY = 4

export type FieldDefault = {
  id: number
  collection: string
  field: string
  value: unknown
  context: Record<string, unknown>
  updated_at: string
  updated_by: string | null
}

export type FieldDefaultInput = {
  collection: string
  field: string
  value: unknown
  context: Record<string, unknown>
}

export class FieldDefaultRefusal extends Error {
  constructor(
    public status: 400 | 403 | 409,
    public code: string,
    message: string
  ) {
    super(message)
    this.name = 'FieldDefaultRefusal'
  }
}

// ── Context ──────────────────────────────────────────────────────────────────

function isEmpty(v: unknown): boolean {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0)
}

/** The context as stored: empty parents left out (they constrain nothing). */
function cleanContext(
  context: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!context || typeof context !== 'object' || Array.isArray(context)) return out
  for (const [k, v] of Object.entries(context)) if (!isEmpty(v)) out[k] = v
  return out
}

/** Key-sorted, scalars as strings (5 and '5' are the same parent), id lists order-free. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical).sort((a, b) => (String(a) < String(b) ? -1 : 1))
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, canonical(o[k])])
    )
  }
  return v == null ? null : String(v)
}

/** sha1 hex of the canonical context; an empty context hashes as `{}`. */
export function contextKey(context: Record<string, unknown>): string {
  const json = JSON.stringify(canonical(cleanContext(context)))
  return createHash('sha1').update(json).digest('hex')
}

// ── Reads ────────────────────────────────────────────────────────────────────

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  return v == null ? '' : String(v)
}

function toDefault(row: Record<string, unknown>): FieldDefault {
  const ctx = parseJson(row.context)
  return {
    id: Number(row.id),
    collection: String(row.collection),
    field: String(row.field),
    value: parseJson(row.value),
    context:
      ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? (ctx as Record<string, unknown>) : {},
    updated_at: toIso(row.updated_at),
    updated_by: row.updated_by == null ? null : String(row.updated_by)
  }
}

const COLUMNS = ['id', 'collection', 'field', 'value', 'context', 'updated_at', 'updated_by']

/** A person's defaults, every collection or one. */
export async function listDefaults(userId: string, collection?: string): Promise<FieldDefault[]> {
  let q = db(TABLE).where({ user: userId })
  if (collection) q = q.where({ collection })
  const rows = (await q
    .select(...COLUMNS)
    .orderBy([{ column: 'collection' }, { column: 'field' }, { column: 'id' }])) as Record<
    string,
    unknown
  >[]
  return rows.map(toDefault)
}

// ── Layout toggle ────────────────────────────────────────────────────────────

type LayoutRow = {
  id: unknown
  collection: unknown
  layout_type: unknown
  conditions: unknown
  parent_layout_id: unknown
}

/**
 * The fields, per collection, that some record form this person can be given turns the
 * personal_default toggle on for. Candidates = the grouped layouts the resolver would
 * consider for them (role-allowed and inside their active dates — record-rule, A/B and
 * phone versions included, since each can be served); a child layout's own placement wins,
 * else its parent's (layout inheritance, #424). `collections` / `fields` narrow the read.
 * Two reads whatever the size: the layouts, then their placements.
 */
export async function allowedFieldsByCollection(
  user: User,
  collections?: string[],
  fields?: string[]
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  if (collections?.length === 0 || fields?.length === 0) return out
  const isAdmin = await isAdminRole(user)
  const today = todayInInstance()
  let lq = db('nivaro_collection_layouts')
  if (collections) lq = lq.whereIn('collection', collections)
  const layouts = (
    (await lq.select(
      'id',
      'collection',
      'layout_type',
      'conditions',
      'parent_layout_id'
    )) as LayoutRow[]
  ).filter(
    (l) =>
      (l.layout_type == null || l.layout_type === 'grouped') &&
      roleAllows(l as Record<string, unknown>, user.role, isAdmin) &&
      windowOpen(l.conditions, today)
  )
  if (layouts.length === 0) return out
  const ids = [
    ...new Set(
      layouts.flatMap((l) => [
        Number(l.id),
        ...(l.parent_layout_id ? [Number(l.parent_layout_id)] : [])
      ])
    )
  ]
  // Layouts are configuration (hundreds at most), but chunk anyway: the parameter cap is hard.
  const placements = await selectInChunks(ids, 1000, async (chunk) => {
    let pq = db('nivaro_layout_field_assignments').whereIn('layout_id', chunk)
    if (fields) pq = pq.whereIn('field', fields)
    return (await pq.select('layout_id', 'field', 'overrides')) as Array<{
      layout_id: unknown
      field: unknown
      overrides: unknown
    }>
  })
  const own = new Map<number, Map<string, boolean>>()
  for (const p of placements) {
    const o = parseJson(p.overrides) as { personal_default?: unknown } | null
    const byField = own.get(Number(p.layout_id)) ?? new Map<string, boolean>()
    byField.set(String(p.field), o?.personal_default === true)
    own.set(Number(p.layout_id), byField)
  }
  for (const l of layouts) {
    const mine = own.get(Number(l.id))
    const parent = l.parent_layout_id ? own.get(Number(l.parent_layout_id)) : undefined
    const names = new Set([...(mine?.keys() ?? []), ...(parent?.keys() ?? [])])
    for (const f of names) {
      const on = mine?.has(f) ? mine.get(f) : parent?.get(f)
      if (!on) continue
      const c = String(l.collection)
      const set = out.get(c) ?? new Set<string>()
      set.add(f)
      out.set(c, set)
    }
  }
  return out
}

/** True when some record form of the collection this person can be given turns the
 *  field's personal_default toggle on (allowedFieldsByCollection for one field). */
export async function fieldAllowedOnSomeLayout(
  user: User,
  collection: string,
  field: string
): Promise<boolean> {
  const map = await allowedFieldsByCollection(user, [collection], [field])
  return map.get(collection)?.has(field) ?? false
}

/**
 * The person's defaults with `on_layout`: false when no form they can be given allows a
 * personal default for that field any more (the form ignores such a row; My defaults lists
 * it as "No longer on any form" with Clear — spec call 10).
 */
export async function withFormState(
  user: User,
  rows: FieldDefault[]
): Promise<Array<FieldDefault & { on_layout: boolean }>> {
  if (rows.length === 0) return []
  const map = await allowedFieldsByCollection(
    user,
    [...new Set(rows.map((r) => r.collection))],
    [...new Set(rows.map((r) => r.field))]
  )
  return rows.map((r) => ({ ...r, on_layout: map.get(r.collection)?.has(r.field) ?? false }))
}

export type AllowedCollection = { collection: string; label: string | null; fields: string[] }

/**
 * Where this person could keep a default (an administrator's "Add default"): per collection,
 * the toggled fields they may also set — create + read permission and the create field list,
 * judged as them, the same checks saveDefault runs. System collections never appear.
 */
export async function allowedForPerson(user: User): Promise<AllowedCollection[]> {
  const map = await allowedFieldsByCollection(user)
  const out: AllowedCollection[] = []
  for (const [collection, set] of map) {
    if (!IDENT.test(collection) || /^(nivaro|directus)_/i.test(collection)) continue
    if (!(await can(user, 'create', collection)) || !(await can(user, 'read', collection))) continue
    const allowed = await getAllowedFields(user, 'create', collection)
    const fields = [...set]
      .filter((f) => allowed === null || allowed.includes('*') || allowed.includes(f))
      .sort()
    if (fields.length) out.push({ collection, label: null, fields })
  }
  if (out.length === 0) return out
  const names = (await db('nivaro_collections')
    .whereIn(
      'collection',
      out.map((c) => c.collection)
    )
    .select('collection', 'display_name')) as Array<{ collection: string; display_name: unknown }>
  const label = new Map(names.map((n) => [n.collection, n.display_name]))
  for (const c of out) {
    const l = label.get(c.collection)
    c.label = typeof l === 'string' && l.trim() ? l : null
  }
  return out.sort((a, b) => (a.label ?? a.collection).localeCompare(b.label ?? b.collection))
}

// ── Value check ──────────────────────────────────────────────────────────────

type FieldShape =
  | { kind: 'plain' }
  | { kind: 'm2o' | 'm2m'; related: string }
  | { kind: 'unsupported' }

/** What the field holds: a plain column, an id of / ids from a related collection, or a shape
 *  personal defaults don't cover (one-to-many child rows, many-to-any). */
async function fieldShape(collection: string, field: string): Promise<FieldShape> {
  // A column with no nivaro_relations row is plain on purpose: the person could send that
  // value in a create anyway, and the form re-validates every default on apply.
  const m2o = (await db('nivaro_relations')
    .where({ many_collection: collection, many_field: field })
    .first('one_collection')) as { one_collection: string | null } | undefined
  if (m2o) {
    return m2o.one_collection && IDENT.test(m2o.one_collection)
      ? { kind: 'm2o', related: m2o.one_collection }
      : { kind: 'unsupported' }
  }
  const alias = (await db('nivaro_relations')
    .where({ one_collection: collection, one_field: field })
    .first('many_collection', 'junction_field')) as
    | { many_collection: string; junction_field: string | null }
    | undefined
  if (!alias) return { kind: 'plain' }
  if (!alias.junction_field) return { kind: 'unsupported' } // one-to-many child rows
  const leg = (await db('nivaro_relations')
    .where({ many_collection: alias.many_collection, many_field: alias.junction_field })
    .first('one_collection')) as { one_collection: string | null } | undefined
  return leg?.one_collection && IDENT.test(leg.one_collection)
    ? { kind: 'm2m', related: leg.one_collection }
    : { kind: 'unsupported' }
}

function idOf(v: unknown): string | number | null {
  if (typeof v === 'number' || typeof v === 'string') return v
  if (v && typeof v === 'object' && 'id' in v) {
    const id = (v as { id: unknown }).id
    if (typeof id === 'number' || typeof id === 'string') return id
  }
  return null
}

/** What readOne throws for a collection or row the person can't see (judged by name and
 *  status: the items service's own error classes), plus SQL Server's conversion errors for an
 *  id of the wrong shape. Anything else (a timeout, a lost connection) is not an answer. */
const NOT_VISIBLE_ERRORS = new Set([
  'ForbiddenError',
  'CollectionNotFoundError',
  'CollectionTableMissingError',
  'RouteOnlyCollectionError',
  'ItemNotFoundError'
])
const SQL_CONVERSION_ERRORS = new Set([245, 8114, 8169])

function meansNotVisible(err: unknown): boolean {
  const e = err as { name?: unknown; statusCode?: unknown; number?: unknown } | null
  if (!e) return false
  if (typeof e.name === 'string' && NOT_VISIBLE_ERRORS.has(e.name)) return true
  if (e.statusCode === 403 || e.statusCode === 404) return true
  return typeof e.number === 'number' && SQL_CONVERSION_ERRORS.has(e.number)
}

async function readable(user: User, collection: string, id: string | number): Promise<boolean> {
  try {
    return (await readOne(user, collection, id, undefined, ['id'])) != null
  } catch (err) {
    if (meansNotVisible(err)) return false
    throw err
  }
}

/** True when every id reads for the person — readOne (tree permission included, which list
 *  reads skip) at most READ_CONCURRENCY at a time, stopping at the first that doesn't. */
async function allReadable(
  user: User,
  collection: string,
  ids: Array<string | number>
): Promise<boolean> {
  let next = 0
  let ok = true
  const worker = async () => {
    while (ok && next < ids.length) {
      const id = ids[next++]
      if (!(await readable(user, collection, id))) ok = false
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, ids.length) }, worker))
  return ok
}

async function assertValuePickable(target: User, input: FieldDefaultInput): Promise<void> {
  const shape = await fieldShape(input.collection, input.field)
  if (shape.kind === 'plain') return
  if (shape.kind === 'unsupported')
    throw new FieldDefaultRefusal(
      400,
      'UNSUPPORTED_FIELD',
      'This kind of field cannot have a personal default'
    )
  const list = shape.kind === 'm2m' ? input.value : [input.value]
  if (!Array.isArray(list))
    throw new FieldDefaultRefusal(400, 'BAD_VALUE', 'A many-to-many default is a list of ids')
  const ids = list.map(idOf)
  if (ids.some((id) => id == null))
    throw new FieldDefaultRefusal(400, 'BAD_VALUE', 'The default must be a record id')
  const unique = [...new Set(ids as Array<string | number>)]
  if (unique.length > MAX_IDS)
    throw new FieldDefaultRefusal(400, 'BAD_VALUE', `At most ${MAX_IDS} records`)
  if (!(await allReadable(target, shape.related, unique)))
    throw new FieldDefaultRefusal(
      400,
      'VALUE_NOT_AVAILABLE',
      'That value is not available to this person'
    )
}

// ── Save / delete ────────────────────────────────────────────────────────────

function assertShape(input: FieldDefaultInput): Record<string, unknown> {
  const { collection, field, value } = input
  if (
    typeof collection !== 'string' ||
    !IDENT.test(collection) ||
    /^(nivaro|directus)_/i.test(collection)
  )
    throw new FieldDefaultRefusal(400, 'BAD_COLLECTION', 'Unknown collection')
  if (typeof field !== 'string' || !IDENT.test(field))
    throw new FieldDefaultRefusal(400, 'BAD_FIELD', 'Unknown field')
  if (isEmpty(value)) throw new FieldDefaultRefusal(400, 'NO_VALUE', 'A default needs a value')
  if (JSON.stringify(value).length > MAX_JSON_CHARS)
    throw new FieldDefaultRefusal(400, 'VALUE_TOO_LARGE', 'That value is too large to keep')
  const raw = input.context ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new FieldDefaultRefusal(400, 'BAD_CONTEXT', 'context must be an object')
  const context = cleanContext(raw)
  const keys = Object.keys(context)
  if (keys.length > MAX_CONTEXT_KEYS || keys.some((k) => !IDENT.test(k)))
    throw new FieldDefaultRefusal(400, 'BAD_CONTEXT', 'context names unknown parent fields')
  for (const v of Object.values(context)) {
    const scalars = Array.isArray(v) ? v : [v]
    if (scalars.some((s) => typeof s === 'object' && s !== null))
      throw new FieldDefaultRefusal(400, 'BAD_CONTEXT', 'context values are ids or plain values')
  }
  if (JSON.stringify(context).length > MAX_JSON_CHARS)
    throw new FieldDefaultRefusal(400, 'BAD_CONTEXT', 'context is too large')
  return context
}

function isDuplicateKey(err: unknown): boolean {
  const n = (err as { number?: number } | null)?.number
  return (
    n === 2627 || n === 2601 || /duplicate key|UNIQUE KEY/i.test(String((err as Error)?.message))
  )
}

function sameUser(a: Pick<User, 'id'>, b: Pick<User, 'id'>): boolean {
  return String(a.id).toUpperCase() === String(b.id).toUpperCase()
}

/**
 * Save (upsert) `target`'s default, judged as `target`. `actor` is who is saving: an
 * administrator saving for someone else is logged in activity.
 */
export async function saveDefault(
  target: User,
  actor: User,
  input: FieldDefaultInput
): Promise<FieldDefault> {
  const context = assertShape(input)
  const { collection, field } = input

  if (!(await can(target, 'create', collection)))
    throw new FieldDefaultRefusal(
      403,
      'NO_CREATE',
      `This person cannot create ${collection} records`
    )
  if (!(await can(target, 'read', collection)))
    throw new FieldDefaultRefusal(403, 'NO_READ', `This person cannot read ${collection} records`)
  const allowed = await getAllowedFields(target, 'create', collection)
  if (allowed !== null && !allowed.includes('*') && !allowed.includes(field))
    throw new FieldDefaultRefusal(403, 'FIELD_NOT_SETTABLE', 'This person cannot set that field')
  if (!(await fieldAllowedOnSomeLayout(target, collection, field)))
    throw new FieldDefaultRefusal(
      403,
      'FIELD_NOT_ALLOWED',
      'No form this person gets allows a personal default for that field'
    )
  await assertValuePickable(target, input)

  const key = contextKey(context)
  const now = new Date()
  const write = {
    value: JSON.stringify(input.value),
    context: JSON.stringify(context),
    updated_at: now,
    updated_by: sameUser(target, actor) ? null : actor.id
  }
  const slot = { user: target.id, collection, field }
  const others = (await db(TABLE).where(slot).select('id', 'context_key')) as Array<{
    id: unknown
    context_key: string
  }>
  const existing = others.find((r) => r.context_key === key)
  let id: number
  if (existing) {
    id = Number(existing.id)
    await db(TABLE).where({ id }).update(write)
  } else {
    if (others.length >= MAX_CONTEXTS)
      throw new FieldDefaultRefusal(
        409,
        'TOO_MANY_CONTEXTS',
        `At most ${MAX_CONTEXTS} defaults for one field; clear one first`
      )
    try {
      const rows = (await db(TABLE)
        .insert({ ...slot, context_key: key, created_at: now, ...write })
        .returning('id')) as unknown[]
      const r = rows[0] as { id: unknown } | number
      id = Number(typeof r === 'object' && r !== null ? r.id : r)
    } catch (err) {
      // Two saves of the same slot at once: the other one inserted first.
      if (!isDuplicateKey(err)) throw err
      const row = (await db(TABLE)
        .where({ ...slot, context_key: key })
        .first('id')) as { id: unknown } | undefined
      if (!row) throw err
      id = Number(row.id)
      await db(TABLE).where({ id }).update(write)
    }
  }

  if (!sameUser(target, actor)) {
    await logActivity({
      action: 'field_default_set',
      user: actor.id,
      collection: TABLE,
      item: String(id),
      comment: JSON.stringify({ target: target.id, collection, field, value: input.value })
    })
  }
  const row = (await db(TABLE)
    .where({ id })
    .first(...COLUMNS)) as Record<string, unknown> | undefined
  return row
    ? toDefault(row)
    : {
        id,
        collection,
        field,
        value: input.value,
        context,
        updated_at: now.toISOString(),
        updated_by: write.updated_by
      }
}

/**
 * Remove one of the person's defaults. False when no such row is theirs. `actor` (when an
 * administrator clears someone else's) is logged in activity.
 */
export async function deleteDefault(userId: string, id: number, actor?: User): Promise<boolean> {
  if (!Number.isInteger(id) || id <= 0) return false
  const row = (await db(TABLE).where({ id, user: userId }).first('collection', 'field')) as
    | { collection: string; field: string }
    | undefined
  if (!row) return false
  const n = Number(await db(TABLE).where({ id, user: userId }).delete())
  if (n > 0 && actor && !sameUser({ id: userId }, actor)) {
    await logActivity({
      action: 'field_default_clear',
      user: actor.id,
      collection: TABLE,
      item: String(id),
      comment: JSON.stringify({ target: userId, collection: row.collection, field: row.field })
    })
  }
  return n > 0
}

/** Every default a person holds — removed before their user row (the FK is NO ACTION). */
export async function deleteDefaultsForUser(
  userId: string,
  conn: Knex | Knex.Transaction = db as unknown as Knex
): Promise<void> {
  await conn(TABLE).where({ user: userId }).delete()
}
