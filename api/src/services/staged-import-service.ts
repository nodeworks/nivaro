import { db } from '../db/index.js'
import type { User } from '../types.js'
import { createOne, updateOne } from './items.js'

/**
 * Service-mode processor for staged imports.
 *
 * The stored-procedure path MERGEs staging rows straight into the target table
 * — raw SQL, so no revisions, no activity, no field rules, no hooks. This
 * processor takes the same parsed + header-mapped rows and instead:
 *
 *   1. batch-resolves lookup columns (warehouse name → id, cifa_number → id),
 *   2. builds one target payload per file row (derived month, type coercion),
 *   3. dedupes last-wins on the natural key,
 *   4. DIFFS against the existing rows and only writes real changes —
 *      `updateOne` for changed rows, `createOne` for new ones,
 *
 * so every write goes through the full items service (revisions, activity,
 * rules, validation, computed fields) and an unchanged re-import writes
 * nothing at all. Rows a procedure would have silently dropped (unresolvable
 * lookup) are counted and reported instead.
 *
 * Config lives on the definition row as `service_config` JSON.
 */

export interface ServiceColumnConfig {
  /** Target collection field this staging column maps to. */
  field: string
  /** Coercion applied before diff/write; default 'string'. Empty string → null. */
  type?: 'string' | 'number' | 'int' | 'date' | 'datetime' | 'boolean'
  /** Resolve the file value to a related row's id. Duplicate match values
   *  collapse to the LOWEST id (the procs' MIN(id) convention for cifa).
   *  on_missing 'create' inserts a stub row ({match_field: value}) through
   *  the items service for every unmatched value instead of dropping the
   *  file row. */
  lookup?: { collection: string; match_field: string; on_missing?: 'create' }
}

export interface ServiceImportConfig {
  collection: string
  /** Target fields forming the natural key rows are matched on. */
  match_by: string[]
  /** Staging column name → target mapping. */
  columns: Record<string, ServiceColumnConfig>
  /** Derived calendar-month date field built from two numeric file columns
   *  (year 2000–2100, month 1–12; out-of-range rows are skipped+counted). */
  month_from?: { field: string; year_column: string; month_column: string }
  /** Target fields that must be non-null after coercion or the row is
   *  skipped (the procs' `qty IS NOT NULL` filter). */
  require_value?: string[]
  /** Audit stamp columns on the target table (legacy Directus convention —
   *  the items service does not stamp these itself). */
  timestamps?: { create?: string; update?: string }
}

export interface ServiceImportSummary {
  created: number
  updated: number
  unchanged: number
  /** Rows dropped before writing, with per-reason counts. */
  skipped: Record<string, number>
  failed: number
  log: string
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const CHUNK = 500

export function parseServiceConfig(raw: unknown): ServiceImportConfig | null {
  if (!raw) return null
  try {
    const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!cfg || typeof cfg !== 'object') return null
    const c = cfg as ServiceImportConfig
    if (!c.collection || !IDENT.test(c.collection) || /^nivaro_/i.test(c.collection)) return null
    // match_by [] is valid — append-only: every file row creates.
    if (!Array.isArray(c.match_by)) return null
    if (!c.columns || typeof c.columns !== 'object') return null
    return c
  } catch {
    return null
  }
}

/** The worker has no request — writes run as the user who queued the file, so
 *  RBAC applies to them like any other write. */
async function loadUser(userId: string | null): Promise<User> {
  if (!userId) throw new Error('Service-mode import requires a queuing user (created_by missing)')
  const row = await db('nivaro_users').where('id', userId).first()
  if (!row) throw new Error(`Queuing user ${userId} not found`)
  return row as User
}

function coerce(value: string, type: ServiceColumnConfig['type']): unknown {
  const v = value.trim()
  if (v === '') return null
  if (type === 'int') {
    const n = Number.parseInt(v.replace(/,/g, ''), 10)
    return Number.isFinite(n) ? n : null
  }
  if (type === 'number') {
    const n = Number(v.replace(/[,$%]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  if (type === 'boolean') {
    const low = v.toLowerCase()
    if (['true', 'yes', 'y', '1'].includes(low)) return true
    if (['false', 'no', 'n', '0'].includes(low)) return false
    return null
  }
  if (type === 'date' || type === 'datetime') {
    const d = new Date(v)
    if (Number.isNaN(d.getTime())) return null
    return type === 'date'
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      : d
  }
  return v
}

/** Normalize a value for diff comparison. Dates (JS Date or yyyy-mm-dd-ish
 *  string) reduce to their UTC calendar day — MSSQL `date` columns come back
 *  as JS Dates at UTC midnight, payloads carry 'yyyy-mm-01' strings, and the
 *  two must compare equal. */
function normForDiff(value: unknown): string {
  if (value == null) return ''
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
  }
  if (typeof value === 'number') return String(Math.round(value * 100) / 100)
  const s = String(value).trim()
  const dateish = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (dateish) return `${dateish[1]}-${dateish[2]}-${dateish[3]}`
  const n = Number(s)
  if (s !== '' && Number.isFinite(n)) return String(Math.round(n * 100) / 100)
  return s
}

async function resolveLookup(
  cfg: NonNullable<ServiceColumnConfig['lookup']>,
  values: Set<string>
): Promise<Map<string, unknown>> {
  if (!IDENT.test(cfg.collection) || !IDENT.test(cfg.match_field)) {
    throw new Error(`Unsafe lookup config: ${cfg.collection}.${cfg.match_field}`)
  }
  const map = new Map<string, unknown>()
  const list = [...values]
  for (let i = 0; i < list.length; i += CHUNK) {
    const rows = await db(cfg.collection)
      .whereIn(cfg.match_field, list.slice(i, i + CHUNK))
      .orderBy('id', 'asc')
      .select('id', cfg.match_field)
    for (const r of rows as Array<Record<string, unknown>>) {
      const key = String(r[cfg.match_field] ?? '')
        .trim()
        .toLowerCase()
      // first (lowest id) wins — MIN(id) convention for duplicate cifa_numbers
      if (!map.has(key)) map.set(key, r.id)
    }
  }
  return map
}

export interface RunServiceImportOptions {
  config: ServiceImportConfig
  /** Parsed + header-mapped rows (staging column names as keys). */
  rows: Array<Record<string, string>>
  createdBy: string | null
  onProgress?: (written: number, total: number) => void | Promise<void>
}

export async function runServiceImport({
  config,
  rows,
  createdBy,
  onProgress
}: RunServiceImportOptions): Promise<ServiceImportSummary> {
  const user = await loadUser(createdBy)
  const skipped: Record<string, number> = {}
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }

  // ── lookups, one batched resolve per configured lookup column ─────────────
  const lookupCreated: string[] = []
  const lookupMaps = new Map<string, Map<string, unknown>>()
  for (const [col, cc] of Object.entries(config.columns)) {
    if (!cc.lookup) continue
    const values = new Set<string>()
    for (const r of rows) {
      const v = (r[col] ?? '').trim()
      if (v) values.add(v)
    }
    const map = await resolveLookup(cc.lookup, values)
    if (cc.lookup.on_missing === 'create') {
      // Stub-create unmatched values through the items service so the rows
      // are revisioned/attributed like any other write.
      let stubbed = 0
      for (const v of values) {
        if (map.has(v.toLowerCase())) continue
        try {
          const created = await createOne(
            user,
            cc.lookup.collection,
            { [cc.lookup.match_field]: v },
            undefined,
            undefined,
            { skipRollupRecalc: true }
          )
          const id = (created as { id?: unknown })?.id
          if (id != null) {
            map.set(v.toLowerCase(), id)
            stubbed++
          }
        } catch {
          skip(`could not create ${cc.lookup.collection} for ${col}`)
        }
      }
      if (stubbed) lookupCreated.push(`${stubbed} new ${cc.lookup.collection} row(s) from ${col}`)
    }
    lookupMaps.set(col, map)
  }

  // ── transform file rows → target payloads ─────────────────────────────────
  const payloads: Array<Record<string, unknown>> = []
  for (const r of rows) {
    const out: Record<string, unknown> = {}
    let drop: string | null = null
    for (const [col, cc] of Object.entries(config.columns)) {
      const raw = (r[col] ?? '').trim()
      if (cc.lookup) {
        if (!raw) {
          drop = `empty ${col}`
          break
        }
        const id = lookupMaps.get(col)?.get(raw.toLowerCase())
        if (id == null) {
          drop = `no ${cc.lookup.collection} match for ${col}`
          break
        }
        out[cc.field] = id
      } else {
        out[cc.field] = coerce(raw, cc.type)
      }
    }
    if (!drop && config.month_from) {
      const y = Number.parseInt((r[config.month_from.year_column] ?? '').trim(), 10)
      const m = Number.parseInt((r[config.month_from.month_column] ?? '').trim(), 10)
      if (!Number.isInteger(y) || y < 2000 || y > 2100 || !Number.isInteger(m) || m < 1 || m > 12) {
        drop = 'invalid year/month'
      } else {
        out[config.month_from.field] = `${y}-${String(m).padStart(2, '0')}-01`
      }
    }
    if (!drop) {
      for (const f of config.require_value ?? []) {
        if (out[f] == null) {
          drop = `empty ${f}`
          break
        }
      }
    }
    if (drop) skip(drop)
    else payloads.push(out)
  }

  // ── dedupe: last file row per natural key wins (the procs' ROW_NUMBER) ────
  // Empty match_by = append-only: every payload is its own row, nothing
  // matches existing data, everything creates.
  const appendOnly = config.match_by.length === 0
  const keyOf = (row: Record<string, unknown>) =>
    config.match_by.map((f) => normForDiff(row[f])).join('|')
  const byKey = new Map<string, Record<string, unknown>>()
  if (appendOnly) {
    payloads.forEach((p, i) => byKey.set(`#${i}`, p))
  } else {
    for (const p of payloads) {
      const k = keyOf(p)
      if (byKey.has(k)) skip('duplicate key in file')
      byKey.set(k, p)
    }
  }

  // ── existing rows, chunked on the first key column's distinct values ──────
  const firstKey = config.match_by[0]
  if (!IDENT.test(config.collection) || config.match_by.some((f) => !IDENT.test(f))) {
    throw new Error('Unsafe service_config identifiers')
  }
  const compareFields = [
    ...new Set(Object.values(config.columns).map((c) => c.field))
  ]
  if (config.month_from) compareFields.push(config.month_from.field)
  const firstVals = appendOnly
    ? []
    : [...new Set([...byKey.values()].map((p) => p[firstKey]))].filter((v) => v != null)
  const existingByKey = new Map<string, Record<string, unknown>>()
  for (let i = 0; i < firstVals.length; i += CHUNK) {
    const rows2 = await db(config.collection)
      .whereIn(firstKey, firstVals.slice(i, i + CHUNK) as Array<string | number>)
      .select('id', ...new Set([...config.match_by, ...compareFields]))
    for (const er of rows2 as Array<Record<string, unknown>>) existingByKey.set(keyOf(er), er)
  }

  // ── diff + write through the items service ────────────────────────────────
  let created = 0
  let updated = 0
  let unchanged = 0
  let failed = 0
  const failures: string[] = []
  const total = byKey.size
  const now = new Date()
  for (const [k, payload] of byKey) {
    const existing = existingByKey.get(k)
    try {
      if (!existing) {
        const body = { ...payload }
        if (config.timestamps?.create) body[config.timestamps.create] = now
        await createOne(user, config.collection, body, undefined, undefined, {
          skipRollupRecalc: false
        })
        created++
      } else {
        const patch: Record<string, unknown> = {}
        for (const f of compareFields) {
          if (config.match_by.includes(f)) continue
          if (normForDiff(payload[f]) !== normForDiff(existing[f])) patch[f] = payload[f]
        }
        if (Object.keys(patch).length === 0) {
          unchanged++
        } else {
          if (config.timestamps?.update) patch[config.timestamps.update] = now
          await updateOne(user, config.collection, String(existing.id), patch)
          updated++
        }
      }
    } catch (err) {
      failed++
      if (failures.length < 5) {
        failures.push(`${k}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const written = created + updated + unchanged + failed
    if (written % 100 === 0) await onProgress?.(written, total)
  }

  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0)
  const parts = [
    `${created} created`,
    `${updated} updated`,
    `${unchanged} unchanged`,
    skippedTotal ? `${skippedTotal} skipped` : null,
    failed ? `${failed} FAILED` : null
  ].filter(Boolean)
  const detail: string[] = []
  for (const [reason, n] of Object.entries(skipped)) detail.push(`  skipped ${n}: ${reason}`)
  for (const f of failures) detail.push(`  failed ${f}`)
  return {
    created,
    updated,
    unchanged,
    skipped,
    failed,
    log: [parts.join(', '), ...detail].join('\n')
  }
}
