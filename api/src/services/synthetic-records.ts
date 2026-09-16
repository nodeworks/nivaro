/**
 * Synthetic records — realistic-enough test rows for a collection, derived
 * from its OWN field metadata (types, choices, relations, required flags,
 * validation rules), so a staging instance can be exercised without hand-
 * typing forms. Rows are created through the items service like any other
 * write (hooks, rules, auto-ids, revisions all apply) and every row of a run
 * carries the change reason `synthetic:<batch>` — that activity comment is
 * the only marker, and it is what lists and deletes a batch later.
 *
 * Deliberately generic: values come from field NAMES and TYPES, never from a
 * domain vocabulary. Anything the generator cannot fill is left out; a
 * required field it cannot fill makes the create fail, and that failure is
 * reported per row rather than papered over.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { CMSField, CMSRelation, User } from '../types.js'
import { getCollection, getFields, getRelations } from './collections.js'
import { createOne, deleteOne } from './items.js'
import type { ValidationRule } from './validation-rules.js'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_COUNT = 200

/** Audit stamps the items service fills itself; never generated. */
const STAMPS = new Set([
  'id',
  'created',
  'changed',
  'created_at',
  'updated_at',
  'date_created',
  'date_updated',
  'user_created',
  'user_updated',
  'creator',
  'created_by',
  'updated_by',
  'sort',
  'workspace_id'
])

const WORDS = [
  'north', 'south', 'east', 'west', 'harbor', 'ridge', 'summit', 'meadow', 'canyon', 'delta',
  'granite', 'copper', 'cedar', 'willow', 'maple', 'orchard', 'quarry', 'lantern', 'beacon', 'anchor',
  'compass', 'sextant', 'ledger', 'atlas', 'prism', 'vector', 'quartz', 'cobalt', 'amber', 'onyx'
]
const rnd = (n: number) => Math.floor(Math.random() * n)
const pick = <T>(arr: T[]): T => arr[rnd(arr.length)]
const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ')
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const dayOffset = (days: number) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d
}
const ymd = (d: Date) => d.toISOString().slice(0, 10)

function parseRules(v: unknown): ValidationRule[] {
  if (!v) return []
  if (Array.isArray(v)) return v as ValidationRule[]
  try {
    const p = JSON.parse(String(v))
    return Array.isArray(p) ? (p as ValidationRule[]) : []
  } catch {
    return []
  }
}

function choicesOf(f: CMSField): Array<{ value: unknown }> {
  const o = (f.options && typeof f.options === 'object' ? f.options : null) as { choices?: unknown } | null
  const c = o?.choices
  return Array.isArray(c) ? (c as Array<{ value: unknown }>).filter((x) => x && x.value != null) : []
}

function specialOf(f: CMSField): string[] {
  if (Array.isArray(f.special)) return f.special.map(String)
  if (typeof f.special === 'string') return (f.special as string).split(',').map((s) => s.trim())
  return []
}

export interface SyntheticPlan {
  collection: string
  batch: string
  /** Fields the generator will fill, with the strategy per field. */
  fields: Array<{ field: string; strategy: string }>
  /** Fields skipped and why (audit stamps, computed, aliases, no strategy). */
  skipped: Array<{ field: string; reason: string }>
}

interface Strategy {
  field: string
  strategy: string
  gen: (i: number) => unknown
}

async function relationTargetIds(target: string, n = 60): Promise<unknown[]> {
  if (!IDENT.test(target) || /^nivaro_|^directus_/i.test(target)) return []
  try {
    // ORDER BY NEWID() is the mssql random-sample idiom; fine on tables this
    // reads a handful of rows from.
    const rows = (await db(target)
      .select('id')
      .orderByRaw('NEWID()')
      .limit(n)) as Array<{ id: unknown }>
    return rows.map((r) => r.id)
  } catch {
    return []
  }
}

/** Decide, per field, how a value is made. Pure apart from relation samples. */
export async function planSynthetic(collection: string): Promise<{ strategies: Strategy[]; skipped: SyntheticPlan['skipped'] }> {
  const [fields, rels] = await Promise.all([getFields(collection), getRelations(collection)])
  const m2o = new Map<string, CMSRelation>()
  const aliases = new Set<string>()
  for (const r of rels) {
    if (r.many_collection === collection && r.many_field && r.one_collection) m2o.set(r.many_field, r)
    if (r.one_collection === collection && r.one_field) aliases.add(r.one_field)
  }
  const strategies: Strategy[] = []
  const skipped: SyntheticPlan['skipped'] = []
  const skip = (field: string, reason: string) => skipped.push({ field, reason })

  for (const f of fields) {
    const name = f.field
    if (STAMPS.has(name)) {
      skip(name, 'audit stamp')
      continue
    }
    const special = specialOf(f)
    if (special.some((s) => /^(user|date)-(created|updated)$/.test(s))) {
      skip(name, 'audit stamp')
      continue
    }
    if (f.computed_type) {
      skip(name, 'computed')
      continue
    }
    if (aliases.has(name) || f.type === 'alias' || /^(list-|files|m2m|m2a|o2m)/.test(f.interface ?? '')) {
      skip(name, 'relation alias')
      continue
    }
    const opts = (f.options && typeof f.options === 'object' ? f.options : {}) as Record<string, unknown>
    if (opts.auto_id) {
      skip(name, 'auto id')
      continue
    }
    if (f.readonly) {
      skip(name, 'read-only')
      continue
    }
    const rules = parseRules(f.validation)
    const num = (t: string) => {
      const r = rules.find((x) => x.type === t)
      const v = r?.value
      return v == null || v === '' ? null : Number(v)
    }

    // ── relations ──────────────────────────────────────────────────────────
    const rel = m2o.get(name)
    if (rel?.one_collection) {
      const target = rel.one_collection === 'directus_users' ? 'nivaro_users' : rel.one_collection
      if (target === 'nivaro_users') {
        const ids = (await db('nivaro_users').where('status', 'active').whereNotNull('email').limit(40).pluck('id')) as unknown[]
        if (ids.length) strategies.push({ field: name, strategy: 'an active user', gen: () => pick(ids) })
        else skip(name, 'no active users to link')
        continue
      }
      const ids = await relationTargetIds(target)
      if (ids.length) strategies.push({ field: name, strategy: `an existing ${target} row`, gen: () => pick(ids) })
      else skip(name, `no ${target} rows to link`)
      continue
    }

    // ── choices ────────────────────────────────────────────────────────────
    const choices = choicesOf(f)
    if (choices.length) {
      strategies.push({ field: name, strategy: 'one of the field choices', gen: () => pick(choices).value })
      continue
    }

    const t = (f.type ?? '').toLowerCase()
    const iface = (f.interface ?? '').toLowerCase()
    const lname = name.toLowerCase()

    // ── scalars by type, then by name ──────────────────────────────────────
    if (t === 'boolean' || iface === 'boolean' || iface === 'toggle') {
      strategies.push({ field: name, strategy: 'random yes/no', gen: () => Math.random() < 0.5 })
      continue
    }
    if (t === 'uuid') {
      strategies.push({ field: name, strategy: 'random uuid', gen: () => randomUUID() })
      continue
    }
    if (['integer', 'biginteger', 'bigint', 'int', 'smallint'].includes(t)) {
      const pct = /percent|pct|_rate$/.test(lname)
      const days = /days?$|_days_/.test(lname)
      const lo = num('min') ?? (pct || days ? 0 : 1)
      const hi = num('max') ?? (pct ? 100 : days ? 90 : Math.max(lo + 1, 1000))
      strategies.push({ field: name, strategy: `integer ${lo}–${hi}`, gen: () => lo + rnd(hi - lo + 1) })
      continue
    }
    if (['decimal', 'float', 'double', 'numeric', 'money', 'real'].includes(t)) {
      const pct = /percent|pct|_rate$|ratio/.test(lname)
      const lo = num('min') ?? (pct ? 0 : 10)
      const hi = num('max') ?? (pct ? 100 : Math.max(lo + 1, 50_000))
      strategies.push({
        field: name,
        strategy: `amount ${lo}–${hi}`,
        gen: () => Math.round((lo + Math.random() * (hi - lo)) * 100) / 100
      })
      continue
    }
    if (t === 'date' || iface === 'date') {
      const minD = num('min_days_from_today')
      const maxD = num('max_days_from_today')
      const lo = minD ?? -60
      const hi = maxD ?? Math.max(lo + 1, 60)
      strategies.push({ field: name, strategy: `date ${lo}…${hi} days from today`, gen: () => ymd(dayOffset(lo + rnd(hi - lo + 1))) })
      continue
    }
    if (['datetime', 'timestamp', 'datetime2', 'datetimeoffset'].includes(t) || iface === 'datetime') {
      strategies.push({ field: name, strategy: 'a recent timestamp', gen: () => dayOffset(-rnd(45)).toISOString() })
      continue
    }
    if (t === 'json' || iface === 'json' || iface === 'repeater' || iface === 'tags') {
      if (f.required) strategies.push({ field: name, strategy: 'empty list', gen: () => [] })
      else skip(name, 'json — left empty')
      continue
    }
    if (['string', 'text', 'varchar', 'nvarchar', 'char', 'ntext'].includes(t) || iface.includes('text') || iface === 'input') {
      const rx = rules.find((x) => x.type === 'regex')
      if (rx) {
        skip(name, 'regex rule — no safe value')
        continue
      }
      if (/email/.test(lname) || rules.some((x) => x.type === 'email')) {
        strategies.push({ field: name, strategy: 'example.com address', gen: (i) => `synthetic.${randomBytes(2).toString('hex')}.${i}@example.com` })
      } else if (/url|website|link/.test(lname) || rules.some((x) => x.type === 'url')) {
        strategies.push({ field: name, strategy: 'example.com url', gen: () => `https://example.com/${pick(WORDS)}-${rnd(1000)}` })
      } else if (/phone|mobile|tel/.test(lname)) {
        strategies.push({ field: name, strategy: '555 number', gen: () => `555-01${String(rnd(100)).padStart(2, '0')}` })
      } else if (/zip|postal/.test(lname)) {
        strategies.push({ field: name, strategy: 'zip', gen: () => String(10000 + rnd(89999)) })
      } else if (/state|province/.test(lname) && !/statement|status/.test(lname)) {
        strategies.push({ field: name, strategy: 'two-letter state', gen: () => pick(['CA', 'CO', 'GA', 'IL', 'MA', 'NY', 'PA', 'TX', 'WA']) })
      } else if (/city|town/.test(lname)) {
        strategies.push({ field: name, strategy: 'made-up city', gen: () => `${cap(pick(WORDS))} ${pick(['Falls', 'Springs', 'Junction', 'Heights', 'Park'])}` })
      } else if (/address|street/.test(lname)) {
        strategies.push({ field: name, strategy: 'made-up street address', gen: () => `${100 + rnd(9900)} ${cap(pick(WORDS))} ${pick(['St', 'Ave', 'Rd', 'Blvd'])}` })
      } else if (/rich|html|body|description|notes?$|comment|overview|objective/.test(lname) || iface.includes('rich')) {
        strategies.push({ field: name, strategy: 'a short paragraph', gen: () => `<p>Synthetic ${cap(words(4))}. ${cap(words(6))}.</p>` })
      } else if (/code|sku|number|ref|identifier|_no$/.test(lname)) {
        strategies.push({ field: name, strategy: 'SYN- code', gen: (i) => `SYN-${randomBytes(2).toString('hex').toUpperCase()}${i}` })
      } else {
        const max = num('max') ?? 80
        strategies.push({ field: name, strategy: 'made-up words', gen: () => `Synthetic ${cap(words(2))}`.slice(0, Math.max(8, max)) })
      }
      continue
    }
    skip(name, `no strategy for type ${t || 'unknown'}${f.required ? ' (required — the create may fail)' : ''}`)
  }
  return { strategies, skipped }
}

export async function describeSyntheticPlan(collection: string): Promise<SyntheticPlan> {
  const { strategies, skipped } = await planSynthetic(collection)
  return { collection, batch: '', fields: strategies.map((s) => ({ field: s.field, strategy: s.strategy })), skipped }
}

export interface SyntheticResult {
  batch: string
  requested: number
  created: number
  ids: unknown[]
  failed: Array<{ index: number; error: string }>
  plan: SyntheticPlan
}

export async function generateSynthetic(
  user: User,
  collection: string,
  count: number,
  req?: FastifyRequest
): Promise<SyntheticResult> {
  if (!IDENT.test(collection) || /^nivaro_|^directus_/i.test(collection)) throw new Error('Business collections only')
  const col = await getCollection(collection)
  if (!col) throw new Error(`Unknown collection ${collection}`)
  const n = Math.max(1, Math.min(MAX_COUNT, Math.floor(count)))
  const batch = randomBytes(4).toString('hex')
  const { strategies, skipped } = await planSynthetic(collection)
  const plan: SyntheticPlan = { collection, batch, fields: strategies.map((s) => ({ field: s.field, strategy: s.strategy })), skipped }
  const ids: unknown[] = []
  const failed: SyntheticResult['failed'] = []
  for (let i = 0; i < n; i++) {
    const payload: Record<string, unknown> = { _change_reason: `synthetic:${batch}` }
    for (const s of strategies) payload[s.field] = s.gen(i + 1)
    try {
      const created = (await createOne(user, collection, payload, req)) as { id?: unknown } | undefined
      if (created?.id != null) ids.push(created.id)
    } catch (err) {
      if (failed.length < 10) failed.push({ index: i + 1, error: (err as Error)?.message ?? String(err) })
      // Three straight failures at the top = the plan is wrong, not the luck.
      if (ids.length === 0 && failed.length >= 3) break
    }
  }
  return { batch, requested: n, created: ids.length, ids, failed, plan }
}

export interface SyntheticBatch {
  batch: string
  count: number
  first_at: Date | string | null
  by: string | null
}

/** Batches still traceable through the activity log for a collection. */
export async function listSyntheticBatches(collection: string): Promise<SyntheticBatch[]> {
  if (!IDENT.test(collection)) return []
  const rows = (await db('nivaro_activity as a')
    .leftJoin('nivaro_users as u', 'u.id', 'a.user')
    .where('a.collection', collection)
    .where('a.action', 'create')
    .where('a.comment', 'like', 'synthetic:%')
    .groupBy('a.comment')
    .select('a.comment', db.raw('COUNT(*) as n'), db.raw('MIN(a.timestamp) as first_at'), db.raw('MIN(u.email) as first_by'))
    .orderBy('first_at', 'desc')) as Array<{ comment: string; n: unknown; first_at: unknown; first_by: unknown }>
  // ('by' is a reserved word on mssql — hence first_by.)
  const out: SyntheticBatch[] = []
  for (const r of rows) {
    const batch = String(r.comment).slice('synthetic:'.length)
    // A batch whose rows are all gone (deleted, or trashed by this page) is
    // history, not something to offer a delete button for.
    const items = (await db('nivaro_activity').where({ collection, action: 'create', comment: String(r.comment) }).pluck('item')) as string[]
    let remaining = 0
    for (let i = 0; i < items.length; i += 500) {
      const c = (await db(collection).whereIn('id', items.slice(i, i + 500) as never[]).count('* as n').first()) as { n: unknown } | undefined
      remaining += Number(c?.n) || 0
    }
    if (remaining === 0) continue
    out.push({ batch, count: remaining, first_at: (r.first_at as Date) ?? null, by: r.first_by ? String(r.first_by) : null })
  }
  return out
}

/** Delete every row a batch created (through deleteOne — trash applies). */
export async function deleteSyntheticBatch(
  user: User,
  collection: string,
  batch: string,
  req?: FastifyRequest
): Promise<{ deleted: number; failed: number; missing: number }> {
  if (!IDENT.test(collection) || !/^[a-f0-9]{8}$/.test(batch)) throw new Error('Bad batch')
  const items = (await db('nivaro_activity')
    .where({ collection, action: 'create', comment: `synthetic:${batch}` })
    .pluck('item')) as string[]
  let deleted = 0
  let failed = 0
  let missing = 0
  for (const id of items) {
    const exists = await db(collection).where('id', id as never).first('id')
    if (!exists) {
      missing++
      continue
    }
    try {
      await deleteOne(user, collection, id, req)
      deleted++
    } catch {
      failed++
    }
  }
  return { deleted, failed, missing }
}
