import { db } from '../db/index.js'
import { auditLevelOf } from '../hooks/activity.js'
import { describeDbRefusal } from '../lib/db-refusal.js'
import type { User } from '../types.js'
import { autoIdFieldsFor } from './auto-ids.js'
import { chainFields } from './chain-columns.js'
import { getEncryptedFields } from './encryption.js'
import { applyWriteComputedFields } from './items.js'
import { originFields, originForWrite } from './note-authorship.js'
import { can, getAllowedFields, getRowFilter } from './permissions.js'
import { computeDelta } from './revisions.js'
import { getRollupContributors, recalcRollupsForParent } from './rollups.js'
import { enforceValidationRules } from './validation-rules.js'

/**
 * Batch writes — many rows of ONE collection written set-based, with the
 * history a person expects from an edit.
 *
 * The items service writes one record at a time and runs everything an edit
 * in the form runs. That is right for tens or hundreds of records and far too
 * slow for tens of thousands. A batch write keeps what matters for data and
 * drops what only matters for a person editing:
 *
 *   kept      permission to write the collection · stored computed fields ·
 *             validation rules · created / updated stamps · one activity row
 *             and one revision (snapshot + changed fields) per record ·
 *             stored rollups on the parents, recalculated once each
 *   dropped   before / after hooks: field rules, automation rules,
 *             notifications, webhooks, auto transitions, integrity checks,
 *             realtime events per record
 *
 * A collection a batch cannot serve correctly is refused by `batchRefusal`
 * and the caller writes through the items service instead: a role with a row
 * filter or a field list, encrypted fields, generated ids on create.
 */

export interface BatchUpdateRow {
  id: string | number
  patch: Record<string, unknown>
  /** Names the row in a failure message. */
  label?: string
}

export interface BatchCreateRow {
  body: Record<string, unknown>
  label?: string
}

export interface BatchRowOutcome {
  ok: boolean
  id: string | number | null
  error?: string
  /** What changed, stored fields that follow from the change included. */
  changes: Array<{ field: string; from: unknown; to: unknown }>
  /** The row as written (creates: the stored row). */
  values?: Record<string, unknown>
}

export interface BatchOutcome {
  done: number
  failed: number
  failures: string[]
  ms: number
  /** One per input row, in input order. */
  rows: BatchRowOutcome[]
  /** Parent records whose stored rollups were recalculated. */
  rollups: number
}

export interface BatchOptions {
  user: User
  /** Written as the activity comment of every record. */
  stamp?: string | null
  /** Rows read, written and recorded together. */
  slice?: number
  onProgress?: (done: number, total: number) => void
  cancelled?: () => boolean
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const PARAM_BUDGET = 1900
const DEFAULT_SLICE = 1000
const READ_CHUNK = 900
const STAMP_NAMES = new Set(['changed', 'updated_at', 'date_updated', 'user_updated'])

interface ColumnType {
  name: string
  sql: string
  writable: boolean
  /** Characters a text column holds; null when unbounded or not text. */
  max_chars: number | null
}

const typeCache = new Map<string, { at: number; cols: Promise<Map<string, ColumnType>> }>()
const TYPE_TTL_MS = 60_000

/** Physical columns of a table with the SQL type a bound value is cast to. */
export async function columnTypes(collection: string): Promise<Map<string, ColumnType>> {
  if (!IDENT.test(collection)) throw new Error(`Unsafe collection name: ${collection}`)
  const hit = typeCache.get(collection)
  if (hit && Date.now() - hit.at < TYPE_TTL_MS) return hit.cols
  const cols = (async () => {
    const rows = (await db.raw(
      `SELECT c.name, t.name AS type_name, c.max_length, c.precision, c.scale,
              c.is_identity, c.is_computed
         FROM sys.columns c
         JOIN sys.types t ON t.user_type_id = c.user_type_id
        WHERE c.object_id = OBJECT_ID(?)`,
      [collection]
    )) as Array<{
      name: string
      type_name: string
      max_length: number
      precision: number
      scale: number
      is_identity: boolean | number
      is_computed: boolean | number
    }>
    const map = new Map<string, ColumnType>()
    for (const r of rows) {
      const t = r.type_name.toLowerCase()
      let sql = t
      let max_chars: number | null = null
      if (t === 'nvarchar' || t === 'nchar') {
        sql = r.max_length === -1 ? `${t}(max)` : `${t}(${r.max_length / 2})`
        if (r.max_length !== -1) max_chars = r.max_length / 2
      } else if (t === 'varchar' || t === 'char') {
        sql = r.max_length === -1 ? `${t}(max)` : `${t}(${r.max_length})`
        if (r.max_length !== -1) max_chars = r.max_length
      } else if (t === 'varbinary' || t === 'binary') {
        sql = r.max_length === -1 ? `${t}(max)` : `${t}(${r.max_length})`
      } else if (t === 'decimal' || t === 'numeric') {
        sql = `${t}(${r.precision}, ${r.scale})`
      } else if (t === 'datetime2' || t === 'time' || t === 'datetimeoffset') {
        sql = `${t}(${r.scale})`
      } else if (t === 'text') {
        sql = 'varchar(max)'
      } else if (t === 'ntext') {
        sql = 'nvarchar(max)'
      }
      map.set(r.name, {
        name: r.name,
        sql,
        writable: !r.is_identity && !r.is_computed && t !== 'timestamp',
        max_chars
      })
    }
    return map
  })()
  typeCache.set(collection, { at: Date.now(), cols })
  cols.catch(() => typeCache.delete(collection))
  return cols
}

/**
 * Why a batch may not write this collection for this person, or null when it
 * may. A refusal is not an error: the caller writes through the items
 * service, which serves every case.
 */
export async function batchRefusal(
  user: User,
  action: 'create' | 'update' | 'delete',
  collection: string,
  fields: string[]
): Promise<string | null> {
  if (!IDENT.test(collection) || /^nivaro_/i.test(collection)) {
    return `"${collection}" is not a collection a batch may write`
  }
  if (!(await can(user, action, collection))) {
    return `the role may not ${action} ${collection}`
  }
  const filter = await getRowFilter(user, action, collection)
  if (filter && filter.length > 0) return 'the role reaches only some rows of the collection'
  const allowed = await getAllowedFields(user, action, collection)
  if (allowed && fields.some((f) => !allowed.includes(f))) {
    return 'the role may write only some fields of the collection'
  }
  const encrypted = await getEncryptedFields(collection)
  if (encrypted.some((f) => fields.includes(f))) return 'the collection stores encrypted fields'
  if (action === 'create') {
    const generated = await autoIdFieldsFor(db, collection)
    if (generated.length > 0) return 'new records of the collection get a generated id'
  }
  return null
}

function bindable(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (value === '') return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

/** A CAST shortens a value that is too long without a word. Say so instead. */
function tooLong(values: Record<string, unknown>, types: Map<string, ColumnType>): string | null {
  for (const [field, v] of Object.entries(values)) {
    const max = types.get(field)?.max_chars
    if (max == null || typeof v !== 'string') continue
    if (v.length > max) {
      return `${field} holds ${max} characters and the value has ${v.length}`
    }
  }
  return null
}

function messageOf(err: unknown): string {
  const known = describeDbRefusal(err)
  if (known) return known.message
  const e = err as { errors?: Array<{ message?: string }>; message?: string }
  const inner = e?.errors?.map((x) => x?.message).filter(Boolean)
  let msg: string
  if (inner && inner.length > 0) msg = inner.slice(0, 2).join(' · ')
  else {
    // knex prefixes the statement; the reason follows the last ' - '
    const raw = String(e?.message ?? err)
    const cut = raw.lastIndexOf(' - ')
    msg = cut >= 0 ? raw.slice(cut + 3) : raw
  }
  // the reason, without the name of the database it happened in
  return msg
    .replace(/,? table '[^']*'/gi, '')
    .replace(/\s*INSERT fails\.|\s*UPDATE fails\./gi, '')
    .replace(/\s+;/g, ';')
    .trim()
    .slice(0, 300)
}

/**
 * Write a chunk in one statement; when the statement is refused, halve the
 * chunk and try each half, so one bad row costs a handful of statements and
 * only that row is lost.
 */
async function writeHalving<T>(
  chunk: T[],
  write: (rows: T[]) => Promise<void>,
  landed: (rows: T[]) => void,
  lost: (row: T, err: unknown) => void
): Promise<void> {
  if (chunk.length === 0) return
  try {
    await write(chunk)
    landed(chunk)
  } catch (err) {
    if (chunk.length === 1) {
      lost(chunk[0], err)
      return
    }
    const mid = Math.ceil(chunk.length / 2)
    await writeHalving(chunk.slice(0, mid), write, landed, lost)
    await writeHalving(chunk.slice(mid), write, landed, lost)
  }
}

async function readRows(
  collection: string,
  ids: Array<string | number>
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const rows = (await db(collection)
      .whereIn('id', ids.slice(i, i + READ_CHUNK))
      .select('*')) as Array<Record<string, unknown>>
    for (const r of rows) out.set(String(r.id), r)
  }
  return out
}

interface AuditEntry {
  action: 'create' | 'update' | 'delete'
  item: string
  data: Record<string, unknown>
  delta: Record<string, unknown> | null
}

/** One activity row and one revision per record, written in bulk. */
async function writeAudit(
  collection: string,
  entries: AuditEntry[],
  user: User,
  stamp: string | null
): Promise<void> {
  if (entries.length === 0) return
  const level = await auditLevelOf(collection)
  if (level === 'none') return
  const origin = await originFields('nivaro_activity', originForWrite(user, stamp))
  const chain = await chainFields('nivaro_activity')
  const now = new Date()
  const PER = 150
  for (let i = 0; i < entries.length; i += PER) {
    const part = entries.slice(i, i + PER)
    try {
      const made = (await db('nivaro_activity')
        .insert(
          part.map((e) => ({
            action: e.action,
            user: user.id ?? null,
            collection,
            item: e.item,
            comment: stamp ?? null,
            ...origin,
            ...chain,
            timestamp: now
          }))
        )
        .returning(['id', 'item'])) as Array<{ id: number; item: string }>
      if (level !== 'all') continue
      const idOf = new Map(made.map((m) => [String(m.item), m.id]))
      await db('nivaro_revisions').insert(
        part.map((e) => ({
          activity: idOf.get(e.item) ?? null,
          collection,
          item: e.item,
          data: JSON.stringify(e.data),
          delta: e.delta ? JSON.stringify(e.delta) : null
        }))
      )
    } catch (err) {
      // history must never undo a write that has landed
      console.error({ err: messageOf(err), collection }, 'Batch write: history not recorded')
    }
  }
}

async function recalcParents(
  collection: string,
  touched: Array<Record<string, unknown>>
): Promise<number> {
  const entries = await getRollupContributors(collection)
  if (entries.length === 0 || touched.length === 0) return 0
  const jobs: Array<() => Promise<void>> = []
  const seen = new Set<string>()
  const parents = new Set<string>()
  for (const entry of entries) {
    for (const row of touched) {
      const parent = row[entry.parentFk]
      if (parent == null || parent === '') continue
      const key = `${entry.parentCollection}|${entry.rollupField}|${String(parent)}`
      if (seen.has(key)) continue
      seen.add(key)
      parents.add(`${entry.parentCollection}|${String(parent)}`)
      jobs.push(() => recalcRollupsForParent(entry, parent))
    }
  }
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(8, jobs.length || 1) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++]
        await job().catch(() => undefined)
      }
    })
  )
  return parents.size
}

async function stampsFor(
  collection: string,
  phase: 'create' | 'update',
  types: Map<string, ColumnType>
): Promise<{ user: string[]; date: string[] }> {
  const rows = (await db('nivaro_fields')
    .where({ collection })
    .whereNotNull('special')
    .select('field', 'special')) as Array<{ field: string; special: string | null }>
  const wantUser = phase === 'create' ? 'user-created' : 'user-updated'
  const wantDate = phase === 'create' ? 'date-created' : 'date-updated'
  const out = { user: [] as string[], date: [] as string[] }
  for (const r of rows) {
    if (!types.get(r.field)?.writable) continue
    const special = String(r.special ?? '')
    if (special.includes(wantUser)) out.user.push(r.field)
    else if (special.includes(wantDate)) out.date.push(r.field)
  }
  return out
}

/**
 * Update many records of one collection. Each row's patch holds the fields
 * that differ; fields that follow from them (stored computed fields, the
 * updated stamps) are added here. A row that cannot be written is reported
 * and never stops the others.
 */
export async function batchUpdate(
  collection: string,
  rows: BatchUpdateRow[],
  opts: BatchOptions
): Promise<BatchOutcome> {
  const began = performance.now()
  const types = await columnTypes(collection)
  const idType = types.get('id')
  if (!idType) throw new Error(`${collection} has no id column`)
  const stamps = await stampsFor(collection, 'update', types)
  const stamp = opts.stamp ?? null
  const slice = Math.max(50, Math.min(opts.slice ?? DEFAULT_SLICE, 5000))
  const out: BatchOutcome = {
    done: 0,
    failed: 0,
    failures: [],
    ms: 0,
    rows: rows.map((r) => ({ ok: false, id: r.id, changes: [] })),
    rollups: 0
  }
  const fail = (index: number, label: string, error: string) => {
    out.failed++
    out.rows[index] = { ok: false, id: rows[index].id, error, changes: [] }
    if (out.failures.length < 10) out.failures.push(`${label}: ${error}`.slice(0, 300))
  }
  const touched: Array<Record<string, unknown>> = []

  for (let s = 0; s < rows.length; s += slice) {
    if (opts.cancelled?.()) break
    const part = rows.slice(s, s + slice)
    const before = await readRows(
      collection,
      part.map((r) => r.id)
    )
    const now = new Date()
    interface Ready {
      index: number
      id: string | number
      label: string
      patch: Record<string, unknown>
      before: Record<string, unknown>
      after: Record<string, unknown>
    }
    const ready: Ready[] = []
    for (const [offset, row] of part.entries()) {
      const index = s + offset
      const label = row.label ?? `${collection} ${row.id}`
      const was = before.get(String(row.id))
      if (!was) {
        fail(index, label, 'the record no longer exists')
        continue
      }
      const patch: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row.patch)) {
        if (k.startsWith('_')) continue
        const t = types.get(k)
        if (!t?.writable || k === 'id') continue
        patch[k] = v === undefined || v === '' ? null : v
      }
      if (Object.keys(patch).length === 0) {
        out.rows[index] = { ok: true, id: row.id, changes: [] }
        out.done++
        continue
      }
      try {
        const caller = new Set(Object.keys(patch))
        await enforceValidationRules(collection, { ...was, ...patch }, caller)
        await applyWriteComputedFields(collection, patch, { ...was, ...patch }, { previous: was })
      } catch (err) {
        fail(index, label, messageOf(err))
        continue
      }
      for (const k of Object.keys(patch)) {
        if (!types.get(k)?.writable) delete patch[k]
      }
      const long = tooLong(patch, types)
      if (long) {
        fail(index, label, long)
        continue
      }
      for (const f of stamps.user) if (!(f in patch)) patch[f] = opts.user.id
      for (const f of stamps.date) if (!(f in patch)) patch[f] = now
      ready.push({ index, id: row.id, label, patch, before: was, after: { ...was, ...patch } })
    }

    // one statement per set of columns, as many rows as the parameter limit allows
    const groups = new Map<string, Ready[]>()
    for (const r of ready) {
      const key = Object.keys(r.patch).sort().join(',')
      groups.set(key, [...(groups.get(key) ?? []), r])
    }
    const landed: Ready[] = []
    for (const [key, list] of groups) {
      const cols = key.split(',')
      const per = Math.max(1, Math.floor(PARAM_BUDGET / (cols.length + 1)))
      const tuple = `(CAST(? AS ${idType.sql}), ${cols
        .map((c) => `CAST(? AS ${(types.get(c) as ColumnType).sql})`)
        .join(', ')})`
      const setSql = cols.map((c) => `t.[${c}] = v.[${c}]`).join(', ')
      const names = ['id', ...cols].map((c) => `[${c}]`).join(', ')
      const write = (chunk: Ready[]) =>
        db.raw(
          `UPDATE t SET ${setSql}
             FROM [${collection}] t
             JOIN (VALUES ${chunk.map(() => tuple).join(', ')}) AS v(${names}) ON v.[id] = t.[id]`,
          chunk.flatMap((r) => [r.id, ...cols.map((c) => bindable(r.patch[c]))]) as never[]
        )
      for (let i = 0; i < list.length; i += per) {
        await writeHalving(
          list.slice(i, i + per),
          async (chunk) => {
            await write(chunk)
          },
          (chunk) => landed.push(...chunk),
          (r, err) => fail(r.index, r.label, messageOf(err))
        )
      }
    }

    const audit: AuditEntry[] = []
    for (const r of landed) {
      const delta = computeDelta(r.before, r.after)
      out.rows[r.index] = {
        ok: true,
        id: r.id,
        changes: Object.keys(delta)
          .filter(
            (f) => !STAMP_NAMES.has(f) && !stamps.user.includes(f) && !stamps.date.includes(f)
          )
          .map((f) => ({ field: f, from: r.before[f] ?? null, to: r.after[f] ?? null })),
        values: r.after
      }
      out.done++
      audit.push({ action: 'update', item: String(r.id), data: r.after, delta })
      touched.push(r.before, r.after)
    }
    await writeAudit(collection, audit, opts.user, stamp)
    opts.onProgress?.(Math.min(s + slice, rows.length), rows.length)
  }

  out.rollups = await recalcParents(collection, touched)
  out.ms = Math.round(performance.now() - began)
  return out
}

/**
 * Create many records of one collection. `keyFields` are returned by the
 * insert so each new id is matched to its input row by value; without them
 * the rows are matched by position.
 */
export async function batchCreate(
  collection: string,
  rows: BatchCreateRow[],
  opts: BatchOptions & { keyFields?: string[] }
): Promise<BatchOutcome> {
  const began = performance.now()
  const types = await columnTypes(collection)
  if (!types.has('id')) throw new Error(`${collection} has no id column`)
  const stamps = await stampsFor(collection, 'create', types)
  const stamp = opts.stamp ?? null
  const keyFields = (opts.keyFields ?? []).filter((f) => types.has(f))
  const out: BatchOutcome = {
    done: 0,
    failed: 0,
    failures: [],
    ms: 0,
    rows: rows.map(() => ({ ok: false, id: null, changes: [] })),
    rollups: 0
  }
  const fail = (index: number, label: string, error: string) => {
    out.failed++
    out.rows[index] = { ok: false, id: null, error, changes: [] }
    if (out.failures.length < 10) out.failures.push(`${label}: ${error}`.slice(0, 300))
  }
  const keyOf = (row: Record<string, unknown>) =>
    keyFields
      .map((f) => {
        const v = row[f]
        if (v == null) return ''
        if (v instanceof Date) return v.toISOString()
        return String(typeof v === 'boolean' ? Number(v) : v)
          .trim()
          .toLowerCase()
      })
      .join('|')
  const touched: Array<Record<string, unknown>> = []
  const slice = Math.max(50, Math.min(opts.slice ?? DEFAULT_SLICE, 5000))

  for (let s = 0; s < rows.length; s += slice) {
    if (opts.cancelled?.()) break
    const part = rows.slice(s, s + slice)
    const now = new Date()
    interface Ready {
      index: number
      label: string
      body: Record<string, unknown>
      id?: string | number
    }
    const ready: Ready[] = []
    for (const [offset, row] of part.entries()) {
      const index = s + offset
      const label = row.label ?? `${collection} row ${index + 1}`
      const body: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row.body)) {
        if (k.startsWith('_') || k === 'id') continue
        if (!types.get(k)?.writable) continue
        if (v === undefined) continue
        body[k] = v === '' ? null : v
      }
      try {
        await enforceValidationRules(collection, body, new Set(Object.keys(body)))
        await applyWriteComputedFields(collection, body, body)
      } catch (err) {
        fail(index, label, messageOf(err))
        continue
      }
      for (const k of Object.keys(body)) if (!types.get(k)?.writable) delete body[k]
      const long = tooLong(body, types)
      if (long) {
        fail(index, label, long)
        continue
      }
      for (const f of stamps.user) if (body[f] == null) body[f] = opts.user.id
      for (const f of stamps.date) if (body[f] == null) body[f] = now
      for (const k of Object.keys(body)) body[k] = bindable(body[k])
      ready.push({ index, label, body })
    }

    const groups = new Map<string, Ready[]>()
    for (const r of ready) {
      const key = Object.keys(r.body).sort().join(',')
      groups.set(key, [...(groups.get(key) ?? []), r])
    }
    const landed: Ready[] = []
    const returning = ['id', ...keyFields]
    const insert = async (chunk: Ready[]) => {
      const made = (await db(collection)
        .insert(chunk.map((r) => r.body))
        .returning(returning, { includeTriggerModifications: true })) as Array<
        Record<string, unknown>
      >
      if (keyFields.length > 0) {
        const byKey = new Map<string, Array<string | number>>()
        for (const m of made) {
          const k = keyOf(m)
          byKey.set(k, [...(byKey.get(k) ?? []), m.id as string | number])
        }
        for (const r of chunk) r.id = byKey.get(keyOf(r.body))?.shift()
      } else {
        chunk.forEach((r, i) => {
          r.id = made[i]?.id as string | number | undefined
        })
      }
    }
    for (const [key, list] of groups) {
      const width = Math.max(1, key.split(',').length)
      const per = Math.max(1, Math.min(500, Math.floor(PARAM_BUDGET / width)))
      for (let i = 0; i < list.length; i += per) {
        await writeHalving(
          list.slice(i, i + per),
          insert,
          (chunk) => landed.push(...chunk),
          (r, err) => fail(r.index, r.label, messageOf(err))
        )
      }
    }

    const ids = landed.map((r) => r.id).filter((v): v is string | number => v != null)
    const stored = await readRows(collection, ids)
    const audit: AuditEntry[] = []
    for (const r of landed) {
      const row = r.id != null ? stored.get(String(r.id)) : undefined
      out.rows[r.index] = { ok: true, id: r.id ?? null, changes: [], values: row ?? r.body }
      out.done++
      if (r.id != null) {
        audit.push({ action: 'create', item: String(r.id), data: row ?? r.body, delta: null })
      }
      touched.push(row ?? r.body)
    }
    await writeAudit(collection, audit, opts.user, stamp)
    opts.onProgress?.(Math.min(s + slice, rows.length), rows.length)
  }

  out.rollups = await recalcParents(collection, touched)
  out.ms = Math.round(performance.now() - began)
  return out
}

/**
 * Remove many records of one collection. Each removed record keeps an
 * activity row and a revision holding what it was. Records are NOT placed in
 * the trash: a batch removes link rows and other rows a run made itself.
 */
export async function batchDelete(
  collection: string,
  ids: Array<string | number>,
  opts: BatchOptions
): Promise<BatchOutcome> {
  const began = performance.now()
  const types = await columnTypes(collection)
  if (!types.has('id')) throw new Error(`${collection} has no id column`)
  const out: BatchOutcome = {
    done: 0,
    failed: 0,
    failures: [],
    ms: 0,
    rows: ids.map((id) => ({ ok: false, id, changes: [] })),
    rollups: 0
  }
  const indexOf = new Map(ids.map((id, i) => [String(id), i]))
  const touched: Array<Record<string, unknown>> = []
  for (let s = 0; s < ids.length; s += READ_CHUNK) {
    if (opts.cancelled?.()) break
    const part = ids.slice(s, s + READ_CHUNK)
    const before = await readRows(collection, part)
    const present = part.filter((id) => before.has(String(id)))
    await writeHalving(
      present,
      async (chunk) => {
        await db(collection).whereIn('id', chunk).del()
      },
      (chunk) => {
        for (const id of chunk) {
          const i = indexOf.get(String(id))
          const row = before.get(String(id)) as Record<string, unknown>
          if (i != null) out.rows[i] = { ok: true, id, changes: [], values: row }
          out.done++
          touched.push(row)
        }
      },
      (id, err) => {
        out.failed++
        const i = indexOf.get(String(id))
        if (i != null) out.rows[i] = { ok: false, id, error: messageOf(err), changes: [] }
        if (out.failures.length < 10) out.failures.push(`${collection} ${id}: ${messageOf(err)}`)
      }
    )
    await writeAudit(
      collection,
      present
        .filter((id) => out.rows[indexOf.get(String(id)) as number]?.ok)
        .map((id) => ({
          action: 'delete' as const,
          item: String(id),
          data: before.get(String(id)) as Record<string, unknown>,
          delta: null
        })),
      opts.user,
      opts.stamp ?? null
    )
    opts.onProgress?.(Math.min(s + READ_CHUNK, ids.length), ids.length)
  }
  out.rollups = await recalcParents(collection, touched)
  out.ms = Math.round(performance.now() - began)
  return out
}
