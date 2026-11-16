/**
 * Environment refresh — the keep set: what the target keeps, saved to a JSON file on the host
 * BEFORE its database is replaced, and put back AFTER the source's copy (and the target's newer
 * migrations) landed.
 *
 *   - `table`  entries: the whole table is put back (DELETE, then the saved rows, ids preserved).
 *   - `columns` entries: rows come from the source; the saved columns are written onto the rows
 *     matched by the natural key (external APIs by name …). A saved row the source has no match
 *     for is reported, never inserted; a source row the target never had is "new from the source"
 *     and the safety pass handles it.
 *   - `rows` entries: the saved rows are put back by key — updated when the source has the key,
 *     inserted (ids preserved) when it does not.
 *
 * Everything here works through a `SqlRunner` (one dedicated connection in the host runner, a
 * fake in tests) and cross-database names (`[DB].dbo.[table]`), so nothing depends on which
 * database the connection opened.
 */
import type { EnvKeepEntry } from './registry.js'

export interface SqlRunner {
  raw(sql: string, bindings?: unknown[]): Promise<Array<Record<string, unknown>>>
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const DBNAME = /^[A-Za-z0-9_]{1,128}$/

/** `[DB]` — the database itself (its sys.* views). */
export function qcat(db: string): string {
  if (!DBNAME.test(db)) throw new Error(`bad database name ${db}`)
  return `[${db}]`
}
/** `[DB].dbo` — the schema holding the app's tables. */
export function qdb(db: string): string {
  return `${qcat(db)}.dbo`
}
export function qcol(c: string): string {
  if (!IDENT.test(c)) throw new Error(`bad column name ${c}`)
  return `[${c}]`
}
export function qtable(db: string, t: string): string {
  return `${qdb(db)}.${qcol(t)}`
}
/** A rows entry's predicate with `{{db}}` pointing at the database it runs in. */
export function wherePredicate(where: string, db: string): string {
  return where.split('{{db}}').join(qdb(db))
}

// ─── Encoding (JSON file) ───────────────────────────────────────────────────

/** Dates → ISO strings, Buffers → {"$b64": …}: the file round-trips every column type we keep. */
export function encodeValue(v: unknown): unknown {
  if (v instanceof Date) return { $date: v.toISOString() }
  if (Buffer.isBuffer(v)) return { $b64: v.toString('base64') }
  return v
}
export function decodeValue(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    if (typeof o.$date === 'string' && Object.keys(o).length === 1) return new Date(o.$date)
    if (typeof o.$b64 === 'string' && Object.keys(o).length === 1)
      return Buffer.from(o.$b64, 'base64')
  }
  return v
}
const encodeRow = (r: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, encodeValue(v)]))

// ─── Saved set ──────────────────────────────────────────────────────────────

export interface SavedEntry {
  id: string
  label: string
  table: string
  kind: EnvKeepEntry['kind']
  key: string[]
  /** columns entries: the kept columns that existed on the target. */
  columns: string[]
  /** Why nothing was saved (table or columns missing on the target). */
  missing?: string
  identity: string | null
  rows: Array<Record<string, unknown>>
  /** Rows the target holds — more than `rows.length` only in a plan's sampled capture. */
  total: number
}

export interface SavedKeepSet {
  format: 1
  captured_at: string
  direction: string
  source_database: string
  target_database: string
  /** The target's migration ledger before the refresh (its app's own migrations). */
  target_ledger: string[]
  entries: SavedEntry[]
}

async function tableColumns(sql: SqlRunner, db: string, table: string): Promise<string[]> {
  const rows = await sql.raw(
    `SELECT c.name AS name FROM ${qcat(db)}.sys.columns c
       JOIN ${qcat(db)}.sys.tables t ON t.object_id = c.object_id
      WHERE t.name = ? ORDER BY c.column_id`,
    [table]
  )
  return rows.map((r) => String(r.name))
}

async function identityColumn(sql: SqlRunner, db: string, table: string): Promise<string | null> {
  const rows = await sql.raw(
    `SELECT c.name AS name FROM ${qcat(db)}.sys.identity_columns c
       JOIN ${qcat(db)}.sys.tables t ON t.object_id = c.object_id
      WHERE t.name = ?`,
    [table]
  )
  return rows.length ? String(rows[0].name) : null
}

/** Reads the keep set from the target (SELECTs only). */
export async function captureKeepSet(
  sql: SqlRunner,
  o: {
    entries: EnvKeepEntry[]
    direction: string
    sourceDb: string
    targetDb: string
    /** Plan only: whole tables / rows over this many are counted and sampled, not read whole. */
    sampleOver?: number
  }
): Promise<SavedKeepSet> {
  const out: SavedEntry[] = []
  for (const e of o.entries) {
    if (e.kind === 'delegate') continue
    const base: SavedEntry = {
      id: e.id,
      label: e.label,
      table: e.table,
      kind: e.kind,
      key: e.key ?? [],
      columns: [],
      identity: null,
      rows: [],
      total: 0
    }
    const cols = await tableColumns(sql, o.targetDb, e.table)
    if (!cols.length) {
      out.push({ ...base, missing: `${e.table} does not exist on ${o.targetDb}` })
      continue
    }
    base.identity = await identityColumn(sql, o.targetDb, e.table)
    const T = qtable(o.targetDb, e.table)
    // rows: the predicate picks the rows; table: an optional predicate narrows what the target
    // keeps (the rest of the table goes — e.g. only the newest quality baseline).
    const whereSql =
      e.kind === 'rows' || (e.kind === 'table' && e.where)
        ? ` WHERE ${wherePredicate(e.where ?? '1=0', o.targetDb)}`
        : ''
    if (o.sampleOver != null && e.kind !== 'columns') {
      const n = Number((await sql.raw(`SELECT COUNT(*) AS n FROM ${T}${whereSql}`))[0]?.n ?? 0)
      // The target's own ops tables are only ever sampled for a plan (they can be large blobs).
      if (n > o.sampleOver || (e.only_when && n > 5)) {
        base.total = n
        base.rows = (await sql.raw(`SELECT TOP 5 * FROM ${T}${whereSql}`)).map(encodeRow)
        out.push(base)
        continue
      }
    }
    if (e.kind === 'table') {
      base.rows = (await sql.raw(`SELECT * FROM ${T}${whereSql}`)).map(encodeRow)
    } else if (e.kind === 'columns') {
      const key = e.key ?? []
      const missingKey = key.filter((k) => !cols.includes(k))
      if (missingKey.length) {
        out.push({
          ...base,
          missing: `${e.table} has no ${missingKey.join(', ')} on ${o.targetDb}`
        })
        continue
      }
      base.columns = (e.columns ?? []).filter((c) => cols.includes(c))
      const list = [...key, ...base.columns].map(qcol).join(', ')
      base.rows = (await sql.raw(`SELECT ${list} FROM ${T}`)).map(encodeRow)
    } else {
      base.rows = (await sql.raw(`SELECT * FROM ${T}${whereSql}`)).map(encodeRow)
    }
    base.total = base.rows.length
    out.push(base)
  }
  const ledger = await sql
    .raw(`SELECT name FROM ${qtable(o.targetDb, 'nivaro_migrations')} ORDER BY name`)
    .catch(() => [])
  return {
    format: 1,
    captured_at: new Date().toISOString(),
    direction: o.direction,
    source_database: o.sourceDb,
    target_database: o.targetDb,
    target_ledger: ledger.map((r) => String(r.name)),
    entries: out
  }
}

// ─── Natural-key matching ───────────────────────────────────────────────────

/** A stable string for a row's key (case-insensitive for text, like SQL Server's collation). */
export function keyOf(row: Record<string, unknown>, key: string[]): string {
  return JSON.stringify(
    key.map((k) => {
      const v = decodeValue(row[k])
      if (v instanceof Date) return v.toISOString()
      return typeof v === 'string' ? v.trim().toLowerCase() : (v ?? null)
    })
  )
}

export interface KeyMatch {
  /** Saved rows the source has (by key) — their kept columns are written back. */
  matched: Array<Record<string, unknown>>
  /** Saved rows the source does not have. */
  onlyTarget: Array<Record<string, unknown>>
  /** Source rows the target never had ("new from the source"). */
  onlySource: Array<Record<string, unknown>>
  /** Keys that appear more than once on one side — never written (ambiguous). */
  ambiguous: string[]
}

export function matchByKey(
  saved: Array<Record<string, unknown>>,
  sourceRows: Array<Record<string, unknown>>,
  key: string[]
): KeyMatch {
  const count = (rows: Array<Record<string, unknown>>) => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(keyOf(r, key), (m.get(keyOf(r, key)) ?? 0) + 1)
    return m
  }
  const sc = count(saved)
  const oc = count(sourceRows)
  const ambiguous = [...new Set([...sc, ...oc].filter(([, n]) => n > 1).map(([k]) => k))]
  const amb = new Set(ambiguous)
  const matched: Array<Record<string, unknown>> = []
  const onlyTarget: Array<Record<string, unknown>> = []
  for (const r of saved) {
    const k = keyOf(r, key)
    if (amb.has(k)) continue
    if (oc.has(k)) matched.push(r)
    else onlyTarget.push(r)
  }
  const onlySource = sourceRows.filter((r) => {
    const k = keyOf(r, key)
    return !amb.has(k) && !sc.has(k)
  })
  return { matched, onlyTarget, onlySource, ambiguous }
}

// ─── Apply ──────────────────────────────────────────────────────────────────

export interface ApplyResult {
  id: string
  table: string
  kind: SavedEntry['kind']
  /** table: rows put back; columns: rows updated; rows: updated + inserted. */
  written: number
  inserted: number
  /** columns: saved rows the source does not have; rows: rows that could not be written. */
  skipped: number
  /** Saved columns the target no longer has (after its migrations) — left out. */
  dropped_columns: string[]
  /** Source rows the target never had (columns entries) — keys, for the safety pass. */
  new_from_source: string[]
  errors: string[]
}

const MAX_PARAMS = 2000

function insertChunkSql(T: string, cols: string[], n: number, identity: boolean): string {
  const tuple = `(${cols.map(() => '?').join(', ')})`
  const ins = `INSERT INTO ${T} (${cols.map(qcol).join(', ')}) VALUES ${Array(n).fill(tuple).join(', ')};`
  return identity ? `SET IDENTITY_INSERT ${T} ON; ${ins} SET IDENTITY_INSERT ${T} OFF;` : ins
}

async function insertRows(
  sql: SqlRunner,
  T: string,
  cols: string[],
  rows: Array<Record<string, unknown>>,
  identity: boolean,
  errors: string[]
): Promise<number> {
  if (!rows.length || !cols.length) return 0
  const per = Math.max(1, Math.floor(MAX_PARAMS / cols.length))
  let done = 0
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per)
    const bindings = chunk.flatMap((r) => cols.map((c) => decodeValue(r[c]) ?? null))
    try {
      await sql.raw(insertChunkSql(T, cols, chunk.length, identity), bindings)
      done += chunk.length
    } catch {
      // One bad row (a link to a row the source lacks) must not lose the rest: row by row.
      for (const r of chunk) {
        try {
          await sql.raw(
            insertChunkSql(T, cols, 1, identity),
            cols.map((c) => decodeValue(r[c]) ?? null)
          )
          done++
        } catch (e) {
          if (errors.length < 20) errors.push(sqlError(e))
        }
      }
    }
  }
  return done
}

export function sqlError(e: unknown): string {
  const inner = Array.isArray((e as any)?.errors) ? (e as any).errors : []
  const msg = inner.length
    ? inner.map((x: any) => `${x.number ? `[${x.number}] ` : ''}${x.message}`).join(' | ')
    : String((e as any)?.message ?? e)
  return msg.slice(0, 400)
}

/**
 * Puts the saved set back. Whole tables are cleared in REVERSE entry order first (children before
 * parents), then every entry is written in entry order. Never throws for one entry: its errors are
 * in its result.
 */
export async function applyKeepSet(
  sql: SqlRunner,
  saved: SavedKeepSet,
  db: string = saved.target_database
): Promise<ApplyResult[]> {
  const sampled = saved.entries.find((e) => (e.total ?? e.rows.length) > e.rows.length)
  if (sampled) throw new Error(`${sampled.table} was only sampled (a plan) — never applied`)
  const results = new Map<string, ApplyResult>()
  const metaCols = new Map<string, string[]>()
  for (const e of saved.entries) {
    results.set(e.id, {
      id: e.id,
      table: e.table,
      kind: e.kind,
      written: 0,
      inserted: 0,
      skipped: 0,
      dropped_columns: [],
      new_from_source: [],
      errors: e.missing ? [e.missing] : []
    })
    if (!e.missing) metaCols.set(e.table, await tableColumns(sql, db, e.table))
  }
  const live = saved.entries.filter((e) => !e.missing && (metaCols.get(e.table) ?? []).length)
  for (const e of saved.entries)
    if (!e.missing && !(metaCols.get(e.table) ?? []).length)
      results.get(e.id)!.errors.push(`${e.table} does not exist on ${db} after the copy`)

  // 1. clear whole tables, children first
  const cleared = new Set<string>()
  for (const e of [...live].reverse()) {
    if (e.kind !== 'table') continue
    try {
      await sql.raw(`DELETE FROM ${qtable(db, e.table)}`)
      cleared.add(e.id)
    } catch (err) {
      results.get(e.id)!.errors.push(`could not clear ${e.table}: ${sqlError(err)}`)
    }
  }

  for (const e of live) {
    const r = results.get(e.id)!
    const now = metaCols.get(e.table) ?? []
    const T = qtable(db, e.table)
    const savedCols = e.kind === 'columns' ? e.columns : Object.keys(e.rows[0] ?? {})
    r.dropped_columns = savedCols.filter((c) => !now.includes(c))
    const cols = savedCols.filter((c) => now.includes(c))
    if (e.kind === 'table') {
      if (!cleared.has(e.id)) continue
      const ident = !!e.identity && cols.includes(e.identity)
      r.written = await insertRows(sql, T, cols, e.rows, ident, r.errors)
      r.inserted = r.written
      r.skipped = e.rows.length - r.written
      continue
    }
    const key = e.key
    const sourceRows = await sql.raw(`SELECT ${key.map(qcol).join(', ')} FROM ${T}`)
    const m = matchByKey(e.rows, sourceRows, key)
    // The WHERE binds the SOURCE row's own key value (matching trims and ignores case; the
    // database's `=` must find exactly the row matching chose).
    const bySource = new Map(sourceRows.map((s) => [keyOf(s, key), s]))
    const sourceKey = (row: Record<string, unknown>) => {
      const s = bySource.get(keyOf(row, key)) ?? row
      return key.map((k) => decodeValue(s[k]))
    }
    if (m.ambiguous.length)
      r.errors.push(
        `${m.ambiguous.length} key(s) appear more than once — left as the source has them`
      )
    if (e.kind === 'columns') {
      r.skipped = m.onlyTarget.length
      r.new_from_source = m.onlySource.map((s) => key.map((k) => String(s[k] ?? '')).join(' / '))
      if (!cols.length) continue
      for (const row of m.matched) {
        try {
          await sql.raw(
            `UPDATE ${T} SET ${cols.map((c) => `${qcol(c)} = ?`).join(', ')} WHERE ${key.map((k) => `${qcol(k)} = ?`).join(' AND ')}`,
            [...cols.map((c) => decodeValue(row[c]) ?? null), ...sourceKey(row)]
          )
          r.written++
        } catch (err) {
          if (r.errors.length < 20) r.errors.push(sqlError(err))
        }
      }
      continue
    }
    // rows: update the ones the source has, insert the rest
    const setCols = cols.filter((c) => !key.includes(c) && c !== e.identity)
    for (const row of m.matched) {
      if (!setCols.length) break
      try {
        await sql.raw(
          `UPDATE ${T} SET ${setCols.map((c) => `${qcol(c)} = ?`).join(', ')} WHERE ${key.map((k) => `${qcol(k)} = ?`).join(' AND ')}`,
          [...setCols.map((c) => decodeValue(row[c]) ?? null), ...sourceKey(row)]
        )
        r.written++
      } catch (err) {
        r.skipped++
        if (r.errors.length < 20) r.errors.push(sqlError(err))
      }
    }
    const ident = !!e.identity && cols.includes(e.identity)
    r.inserted = await insertRows(sql, T, cols, m.onlyTarget, ident, r.errors)
    r.written += r.inserted
    r.skipped += m.onlyTarget.length - r.inserted
  }
  return [...results.values()]
}
