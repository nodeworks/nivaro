/**
 * Config seeds (#828) — rows of a configuration collection an extension
 * checks in beside its code. A seed is NEVER applied at boot: registering
 * one registers an operational task `seed:<key>` whose dry run is the drift
 * report (every row where the database differs from the file, and who last
 * changed it) and whose real run applies the file through the items
 * service, as the admin who clicked, with `_change_reason` naming the seed.
 */
import { readFile } from 'node:fs/promises'
import type { ConfigSeedDef, OpsTaskRunContext } from '@nivaro/extension-kit'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { createOne, readItems, updateOne } from './items.js'
import { registerOpsTask } from './ops-tasks.js'
import { getUser } from './users.js'

type Row = Record<string, unknown>

export interface SeedRowDrift {
  /** The match_by values, as `a=1 · b=x`. */
  key: string
  status: 'missing' | 'differs' | 'same' | 'ambiguous'
  /** Columns that differ: seed value vs database value. */
  fields: Array<{ field: string; seed: unknown; db: unknown; empty_in_db: boolean }>
  db_id?: string | number | null
  /** Who last wrote the database row, when the seed and the row disagree. */
  changed_by?: string | null
  changed_at?: string | null
}

export interface SeedDrift {
  key: string
  collection: string
  mode: ConfigSeedDef['mode']
  rows: number
  missing: number
  differs: number
  same: number
  ambiguous: number
  /** In fill-only mode: differing columns that are EMPTY in the database (a real run fills them). */
  fillable: number
  details: SeedRowDrift[]
}

const AUDIT = new Set([
  'id',
  'created',
  'created_at',
  'updated_at',
  'date_created',
  'date_updated',
  'user_created',
  'user_updated',
  'changed',
  'modified_at'
])
const seeds = new Map<string, { def: ConfigSeedDef; owner: string }>()

function validate(def: ConfigSeedDef): void {
  if (!def || !/^[a-z0-9][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*$/i.test(def.key))
    throw new Error(`config seed key must be <extension>:<name>: ${def?.key}`)
  if (!/^[a-z][a-z0-9_]*$/i.test(def.collection) || /^(nivaro|directus)_/i.test(def.collection))
    throw new Error(`config seed ${def.key}: collection must be a business collection`)
  if (!Array.isArray(def.match_by) || def.match_by.length === 0 || def.match_by.includes('id'))
    throw new Error(`config seed ${def.key}: match_by names one or more columns, never id`)
  if (!def.rows && !def.file) throw new Error(`config seed ${def.key}: rows or file is required`)
  if (def.mode !== 'fill-only' && def.mode !== 'authoritative')
    throw new Error(`config seed ${def.key}: mode is fill-only or authoritative`)
}

export function registerConfigSeed(def: ConfigSeedDef, owner = 'core'): void {
  validate(def)
  registerOpsTask(
    {
      key: `seed:${def.key}`,
      label: def.label ?? `Seed ${def.collection}`,
      description:
        def.description ??
        `Applies the checked-in ${def.collection} rows (${def.mode}); the dry run is the drift report.`,
      group: 'Config seeds',
      leaves_behind: null,
      follow_up: null,
      dryRun: async (rc) => {
        const d = await seedDrift(def.key)
        for (const r of d.details) {
          if (r.status === 'same') continue
          rc.log(
            `${r.status.toUpperCase().padEnd(9)} ${r.key}${r.fields.length ? ` — ${r.fields.map((f) => `${f.field}: ${show(f.db)} → ${show(f.seed)}`).join(', ')}` : ''}${
              r.changed_by
                ? ` (last changed by ${r.changed_by}${r.changed_at ? ` ${r.changed_at.slice(0, 10)}` : ''})`
                : ''
            }`
          )
        }
        return {
          summary: summarize(d),
          counts: {
            rows: d.rows,
            missing: d.missing,
            differs: d.differs,
            same: d.same,
            ambiguous: d.ambiguous
          }
        }
      },
      execute: (rc) => applySeed(def.key, rc)
    },
    owner
  )
  seeds.set(def.key, { def, owner })
}

export function listConfigSeeds(): Array<ConfigSeedDef & { owner: string }> {
  return [...seeds.values()].map(({ def, owner }) => ({ ...def, owner }))
}

/** For tests and reloads. */
export function clearConfigSeeds(owner?: string): void {
  for (const [k, v] of seeds) if (!owner || v.owner === owner) seeds.delete(k)
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '∅'
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.length > 40 ? `${s.slice(0, 37)}…` : s
}

function summarize(d: SeedDrift): string {
  if (d.missing === 0 && d.differs === 0 && d.ambiguous === 0)
    return `${d.rows} row(s) match the seed`
  const parts: string[] = []
  if (d.missing) parts.push(`${d.missing} missing`)
  if (d.differs)
    parts.push(`${d.differs} differ${d.mode === 'fill-only' ? ` (${d.fillable} fillable)` : ''}`)
  if (d.ambiguous) parts.push(`${d.ambiguous} ambiguous`)
  return `${parts.join(', ')} of ${d.rows} row(s)`
}

export async function loadSeedRows(def: ConfigSeedDef): Promise<Row[]> {
  if (def.rows) return def.rows
  const raw = JSON.parse(await readFile(def.file as string, 'utf8')) as unknown
  const rows = Array.isArray(raw) ? raw : ((raw as { rows?: unknown }).rows ?? null)
  if (!Array.isArray(rows))
    throw new Error(`${def.file}: expected an array of rows (or {rows: [...]})`)
  return rows as Row[]
}

const same = (a: unknown, b: unknown): boolean => {
  const norm = (v: unknown) =>
    v === undefined || v === null || v === ''
      ? null
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v)
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const asBool = (v: unknown) =>
      v === true || v === 1 || v === '1' || v === 'true'
        ? true
        : v === false || v === 0 || v === '0' || v === 'false'
          ? false
          : null
    return asBool(a) === asBool(b)
  }
  return norm(a) === norm(b)
}

function keyOf(def: ConfigSeedDef, row: Row): string {
  return def.match_by.map((c) => `${c}=${show(row[c])}`).join(' · ')
}

async function actingUser(userId: string | null | undefined): Promise<User> {
  const u = userId ? await getUser(userId) : undefined
  if (!u) throw new Error('A seed is applied by a signed-in admin — no acting user for this run')
  return u
}

async function findMatch(
  user: User,
  def: ConfigSeedDef,
  row: Row
): Promise<{ status: 'missing' | 'ambiguous' | 'found'; db?: Row }> {
  const filter: Record<string, unknown> = {}
  for (const c of def.match_by)
    filter[c] =
      row[c] === undefined || row[c] === null || row[c] === '' ? { _null: true } : { _eq: row[c] }
  const res = (await readItems(user, def.collection, { filter, limit: 2 } as never)) as unknown as {
    data?: Row[]
  }
  const rows = res.data ?? []
  if (rows.length === 0) return { status: 'missing' }
  if (rows.length > 1) return { status: 'ambiguous' }
  return { status: 'found', db: rows[0] }
}

async function lastWriter(
  collection: string,
  id: unknown
): Promise<{ by: string | null; at: string | null }> {
  try {
    const row = (await db('nivaro_activity as a')
      .leftJoin('nivaro_users as u', 'u.id', 'a.user')
      .where({ 'a.collection': collection, 'a.item': String(id) })
      .whereIn('a.action', ['create', 'update'])
      .orderBy('a.id', 'desc')
      .first('a.timestamp', 'u.first_name', 'u.last_name', 'u.email')) as
      | {
          timestamp?: Date | string
          first_name?: string | null
          last_name?: string | null
          email?: string | null
        }
      | undefined
    if (!row) return { by: null, at: null }
    const name =
      [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.email || null
    return { by: name, at: row.timestamp ? new Date(row.timestamp).toISOString() : null }
  } catch {
    return { by: null, at: null }
  }
}

function comparable(def: ConfigSeedDef, row: Row): string[] {
  const ignore = new Set([...AUDIT, ...(def.ignore ?? [])])
  return Object.keys(row).filter((k) => !ignore.has(k) && !k.startsWith('_'))
}

/** Every row of the seed against the database, as the given admin reads it. */
export async function seedDrift(key: string, userId?: string | null): Promise<SeedDrift> {
  const reg = seeds.get(key)
  if (!reg) throw Object.assign(new Error(`No seed '${key}'`), { statusCode: 404 })
  const { def } = reg
  const user = userId ? await actingUser(userId) : await firstAdmin()
  const rows = await loadSeedRows(def)
  const drift: SeedDrift = {
    key,
    collection: def.collection,
    mode: def.mode,
    rows: rows.length,
    missing: 0,
    differs: 0,
    same: 0,
    ambiguous: 0,
    fillable: 0,
    details: []
  }
  for (const row of rows) {
    const m = await findMatch(user, def, row)
    const entry: SeedRowDrift = { key: keyOf(def, row), status: 'same', fields: [] }
    if (m.status !== 'found') {
      entry.status = m.status
      drift[m.status]++
      drift.details.push(entry)
      continue
    }
    entry.db_id = (m.db as { id?: string | number }).id ?? null
    for (const f of comparable(def, row)) {
      if (def.match_by.includes(f)) continue
      const dbv = (m.db as Row)[f]
      if (!same(row[f], dbv)) {
        const emptyInDb = dbv === null || dbv === undefined || dbv === ''
        entry.fields.push({ field: f, seed: row[f], db: dbv, empty_in_db: emptyInDb })
        if (emptyInDb) drift.fillable++
      }
    }
    if (entry.fields.length > 0) {
      entry.status = 'differs'
      drift.differs++
      const w = await lastWriter(def.collection, entry.db_id)
      entry.changed_by = w.by
      entry.changed_at = w.at
    } else drift.same++
    drift.details.push(entry)
  }
  return drift
}

async function firstAdmin(): Promise<User> {
  const row = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where({ 'r.admin_access': true, 'u.status': 'active' })
    .orderBy('u.created_at', 'asc')
    .first('u.id')) as { id: string } | undefined
  if (!row) throw new Error('No active administrator to read the seed as')
  return actingUser(row.id)
}

/** Apply the seed through the items service as the run's user. */
export async function applySeed(key: string, rc: OpsTaskRunContext) {
  const reg = seeds.get(key)
  if (!reg) throw Object.assign(new Error(`No seed '${key}'`), { statusCode: 404 })
  const { def } = reg
  const user = await actingUser(rc.userId)
  const rows = await loadSeedRows(def)
  const reason = `seed:${def.key}`
  let created = 0
  let updated = 0
  let skipped = 0
  let ambiguous = 0
  let done = 0
  for (const row of rows) {
    if (rc.cancelled()) {
      rc.log('[seed] cancelled — rows already written stay')
      break
    }
    const label = keyOf(def, row)
    const body: Row = {}
    for (const f of comparable(def, row)) body[f] = row[f]
    const m = await findMatch(user, def, row)
    if (m.status === 'ambiguous') {
      ambiguous++
      rc.log(`AMBIGUOUS ${label} — several rows match, nothing written`)
    } else if (m.status === 'missing') {
      await createOne(user, def.collection, { ...body, _change_reason: reason })
      created++
      rc.log(`CREATED   ${label}`)
    } else {
      const dbRow = m.db as Row
      const patch: Row = {}
      for (const f of Object.keys(body)) {
        if (def.match_by.includes(f)) continue
        const dbv = dbRow[f]
        if (same(body[f], dbv)) continue
        const emptyInDb = dbv === null || dbv === undefined || dbv === ''
        if (def.mode === 'authoritative' || emptyInDb) patch[f] = body[f]
      }
      if (Object.keys(patch).length === 0) skipped++
      else {
        await updateOne(user, def.collection, (dbRow as { id: string | number }).id, {
          ...patch,
          _change_reason: reason
        })
        updated++
        rc.log(`UPDATED   ${label} — ${Object.keys(patch).join(', ')}`)
      }
    }
    rc.progress(++done, rows.length)
  }
  return {
    summary: `${created} created, ${updated} updated, ${skipped} unchanged${ambiguous ? `, ${ambiguous} ambiguous` : ''}`,
    counts: { created, updated, unchanged: skipped, ambiguous }
  }
}
