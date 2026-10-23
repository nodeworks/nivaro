/**
 * Config restore (#2803) — put the configuration layer back to a stored snapshot.
 *
 * A bad layout, pipeline or permission change needs an undo that a full database restore is
 * far too blunt for. Every stored snapshot (services/config-snapshots.ts) is a restore point;
 * this module plans and applies "make the config tables look like that again".
 *
 * One engine, two callers:
 * - `/config-diff/apply` pulls ONE table from an uploaded snapshot (another instance): upsert
 *   only, never delete — a row present here but absent there is a human decision.
 * - `/config-diff/history/:id/restore` restores EVERY config table a stored snapshot of THIS
 *   instance carries: inserts, updates AND deletes, all in one transaction.
 *
 * Rules shared by both, all deliberate:
 * - CONFIG tables only, by this instance's classification (config-inventory). RESTORE_EXCLUDED
 *   tables (people accounts, credentials, per-person choices) are refused and reported.
 * - Rows keyed `#<hash>` (no id column) cannot be matched by identity: skipped and reported.
 * - Ids are preserved (IDENTITY_INSERT for identity tables).
 * - Only columns the snapshot row CARRIES and the live table still has are written. Secret
 *   columns are dropped from snapshots (by list and by name), so a restore never overwrites a
 *   live secret; redacted and credential column names are refused even when a file carries them.
 *   Columns redacted BY VALUE (external API instance_overrides: credentials inside a JSON value)
 *   are written as the snapshot's plain parts merged with the credential parts of the live row's
 *   current value, read under lock in the same transaction.
 * - An update writes only the columns that differ. A row that differs only in columns the
 *   snapshot never had (a migration added them since) is "unchanged".
 * - Per-person GRANTS (GRANT_TABLES: User Scopes, owner-group and team memberships) come back
 *   only for people who are active now; the rest are skipped and counted.
 * - A delete whose foreign keys CASCADE (or SET NULL) into rows the plan does not delete is
 *   listed in the preview and refused unless the plan opts in (`allow_cascade`).
 *
 * BINDING: the preview's plan hash covers every operation, the live row it overwrites, the
 * skipped grants and the cascade effects. Apply recomputes the plan (409 STALE + fresh preview
 * when it moved), then inside ONE transaction takes an application lock, re-reads the touched
 * tables WITH (UPDLOCK, HOLDLOCK), recomputes and compares again, stores the 'pre-restore'
 * snapshot from those locked rows (so it rolls back with a failed restore) and writes.
 *
 * ATOMICITY: XACT_ABORT stays off (tedious' default) so a constraint error ends only its
 * statement; deletes run child-first, inserts and updates parent-first; a statement failing on a
 * foreign or unique key is retried after the rest of the pass. Anything still failing rolls
 * everything back.
 *
 * SESSION STATE: knex.raw runs every statement through sp_executesql, so a SET in one raw call
 * is gone by the next (proved on dev: SET LOCK_TIMEOUT in one call, @@LOCK_TIMEOUT -1 in the
 * next). Each write and locked read therefore carries its own `SET LOCK_TIMEOUT` in the same
 * batch, and nothing is ever left set on a connection.
 *
 * CONNECTIONS: plan reads and the transaction run on a short-lived pool of their own
 * (withRestoreDb, 2-minute request timeout, destroyed afterwards) — never the request pool, no
 * 15 s statement cap. Not withLongConnection: its batches cannot bind parameters, and snapshot
 * values (an uploaded file is untrusted) must never be inlined in SQL.
 */
import { createHash } from 'node:crypto'
import knexFactory, { type Knex } from 'knex'
import { config } from '../config.js'
import { buildConnection, isMssql, writePort } from '../db/index.js'
import { NIVARO_VERSION } from '../version.js'
import {
  buildConfigSnapshot,
  type ConfigSnapshot,
  classifyTables,
  isRedactedColumn,
  isValueRedactedColumn,
  restoreRedactedValue,
  type SnapshotRow
} from './config-inventory.js'
import { chunkArray } from './db-batch.js'
import { isSecretColumn } from './system-collections.js'

/** Config tables a restore never writes, with the reason the preview shows. */
export const RESTORE_EXCLUDED: Record<string, string> = {
  nivaro_users:
    'People accounts — sign-in state, roles and status are never rewritten from a snapshot',
  nivaro_sso_providers: 'Sign-in providers carry credentials',
  nivaro_pinned_items: 'Each person’s own pins',
  nivaro_queue_column_prefs: 'Each person’s own column choices',
  nivaro_notification_subscriptions: 'Each person’s own subscriptions',
  nivaro_field_watch_subscribers: 'Each person’s own subscriptions',
  nivaro_alert_subscriptions: 'Each person’s own subscriptions',
  nivaro_metric_alert_subscriptions: 'Each person’s own subscriptions',
  nivaro_report_subscriptions: 'Each person’s own subscriptions',
  nivaro_monitor_subscribers: 'Each person’s own subscriptions',
  nivaro_chat_memberships: 'Who is in which chat channel',
  nivaro_ai_playbooks: 'Learned from answers, not authored'
}

/**
 * Per-person grants and the column naming the person. A row comes back (insert or update) only
 * when that person is active now — a snapshot must not re-grant someone suspended, redacted or
 * a placeholder since. (nivaro_team_scopes grants a TEAM, not a person: restored as is.)
 */
export const GRANT_TABLES: Record<string, string> = {
  nivaro_user_scopes: 'user',
  nivaro_pipeline_owner_group_users: 'user',
  nivaro_user_group_members: 'user'
}

/** Most operations one restore may run — past it, restore fewer tables at a time. */
export const RESTORE_CAP = 2_000
/** How long a restore statement waits for a lock before the whole restore gives up. */
const LOCK_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 120_000
/** Rows per table returned with a preview (the counts are always exact). */
const ROWS_PER_TABLE = 50
const VALUE_CAP = 300
const MASK = '••••••'

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ColumnInfo {
  type: string
  identity: boolean
  /** False for computed and rowversion columns. */
  writable: boolean
}
export type TableColumns = Map<string, ColumnInfo>

export interface ForeignKey {
  child: string
  childCol: string
  parent: string
  parentCol: string
  /** sys.foreign_keys.delete_referential_action_desc: NO_ACTION | CASCADE | SET_NULL | SET_DEFAULT */
  onDelete?: string
}

export type OpKind = 'insert' | 'update' | 'delete'

export interface PlanOp {
  op: OpKind
  key: string
  /** The live row's hash an update/delete overwrites (null for an insert). */
  live_hash: string | null
  /** The snapshot row's hash an insert/update writes (null for a delete). */
  target_hash: string | null
  /** Columns written: every carried column for an insert, the differing ones for an update. */
  fields: string[]
}

export interface TablePlan {
  table: string
  ops: PlanOp[]
  inserts: number
  updates: number
  deletes: number
  unchanged: number
  skipped_keyless: number
  /** Rows that differ only in columns the snapshot does not carry. */
  untracked_only: number
  /** Grant rows not restored because the person is not active now. */
  skipped_inactive_user: number
  /** Their keys (hashed into the plan, not returned). */
  inactive_keys: string[]
  /** Snapshot columns the live table no longer has (never written). */
  dropped_columns: string[]
}

/** Rows a planned delete would take with it (or null out) through a foreign key. */
export interface CascadeEffect {
  /** The table rows are deleted from. */
  table: string
  /** The table holding the rows that follow. */
  child: string
  column: string
  action: string
  rows: number
}

function norm(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  return JSON.stringify(v instanceof Date ? v.toISOString() : v)
}

/** Whether a snapshot column may be written to the live table. */
export function writableColumn(table: string, column: string, cols: TableColumns): boolean {
  if (!IDENT_RE.test(column)) return false
  if (isRedactedColumn(table, column) || isSecretColumn(column)) return false
  const info = cols.get(column)
  return !!info && info.writable
}

/**
 * Exported for tests: the operations that make `live` look like `target` for one table.
 * Pure — no database. `deletes` off = upsert only (the uploaded-snapshot apply).
 */
export function planTable(
  table: string,
  target: Record<string, SnapshotRow>,
  live: Record<string, SnapshotRow>,
  cols: TableColumns,
  opts: {
    deletes: boolean
    keys?: Set<string> | null
    /** For GRANT_TABLES: whether the person a row grants to is active now (absent = all are). */
    isActiveUser?: (id: string) => boolean
  }
): TablePlan {
  const scope = opts.keys && opts.keys.size > 0 ? opts.keys : null
  const grantCol = GRANT_TABLES[table]
  const ops: PlanOp[] = []
  const inactive: string[] = []
  let unchanged = 0
  let skippedKeyless = 0
  let untrackedOnly = 0
  const dropped = new Set<string>()
  for (const [key, row] of Object.entries(target)) {
    if (scope && !scope.has(key)) continue
    if (key.startsWith('#')) {
      skippedKeyless++
      continue
    }
    for (const c of Object.keys(row.data)) {
      if (!cols.has(c) && !isRedactedColumn(table, c)) dropped.add(c)
    }
    const current = live[key]
    if (current && current.hash === row.hash) {
      unchanged++
      continue
    }
    if (grantCol && opts.isActiveUser) {
      const who = row.data[grantCol]
      if (who === null || who === undefined || !opts.isActiveUser(String(who))) {
        inactive.push(key)
        continue
      }
    }
    if (!current) {
      ops.push({
        op: 'insert',
        key,
        live_hash: null,
        target_hash: row.hash,
        fields: Object.keys(row.data).filter((c) => writableColumn(table, c, cols))
      })
      continue
    }
    const fields = Object.keys(row.data).filter(
      (c) =>
        c !== 'id' && writableColumn(table, c, cols) && norm(current.data[c]) !== norm(row.data[c])
    )
    if (fields.length === 0) {
      untrackedOnly++
      continue
    }
    ops.push({ op: 'update', key, live_hash: current.hash, target_hash: row.hash, fields })
  }
  if (opts.deletes) {
    for (const [key, row] of Object.entries(live)) {
      if (target[key]) continue
      if (scope && !scope.has(key)) continue
      if (key.startsWith('#')) {
        skippedKeyless++
        continue
      }
      ops.push({ op: 'delete', key, live_hash: row.hash, target_hash: null, fields: [] })
    }
  }
  const order: Record<OpKind, number> = { delete: 0, insert: 1, update: 2 }
  ops.sort((a, b) => order[a.op] - order[b.op] || a.key.localeCompare(b.key))
  return {
    table,
    ops,
    inserts: ops.filter((o) => o.op === 'insert').length,
    updates: ops.filter((o) => o.op === 'update').length,
    deletes: ops.filter((o) => o.op === 'delete').length,
    unchanged: unchanged + untrackedOnly,
    skipped_keyless: skippedKeyless,
    untracked_only: untrackedOnly,
    skipped_inactive_user: inactive.length,
    inactive_keys: inactive.sort(),
    dropped_columns: [...dropped].sort()
  }
}

/**
 * Exported for tests: one hash over everything a plan would do, what it would overwrite, the
 * grants it skips and the rows its deletes would take with them.
 */
export function planHash(
  ref: string,
  plans: TablePlan[],
  extra: { cascade?: CascadeEffect[]; allowCascade?: boolean } = {}
): string {
  const body = plans
    .filter((p) => p.ops.length > 0 || p.inactive_keys.length > 0)
    .map((p) => [
      p.table,
      p.ops.map(
        (o) => `${o.op}:${o.key}:${o.live_hash ?? ''}:${o.target_hash ?? ''}:${o.fields.join(',')}`
      ),
      p.inactive_keys.map((k) => `skip:${k}`)
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  const cascade = (extra.cascade ?? [])
    .map((c) => `${c.table}>${c.child}.${c.column}:${c.action}:${c.rows}`)
    .sort()
  return createHash('sha256')
    .update(JSON.stringify([ref, body, cascade, extra.allowCascade === true]))
    .digest('hex')
}

/** Exported for tests: tables parent-first by the foreign keys among them (cycles keep input order). */
export function orderTables(tables: string[], fks: ForeignKey[]): string[] {
  const set = new Set(tables)
  const parents = new Map<string, Set<string>>()
  for (const t of tables) parents.set(t, new Set())
  for (const fk of fks) {
    if (fk.child === fk.parent || !set.has(fk.child) || !set.has(fk.parent)) continue
    parents.get(fk.child)?.add(fk.parent)
  }
  const out: string[] = []
  const done = new Set<string>()
  let progress = true
  while (out.length < tables.length && progress) {
    progress = false
    for (const t of tables) {
      if (done.has(t)) continue
      if ([...(parents.get(t) ?? [])].every((p) => done.has(p))) {
        out.push(t)
        done.add(t)
        progress = true
      }
    }
  }
  for (const t of tables) if (!done.has(t)) out.push(t)
  return out
}

/**
 * Exported for tests: keys ordered so a row comes after the row it references through a
 * self-referencing column (parent first). Reverse it for deletes.
 */
export function orderBySelfRef(
  keys: string[],
  dataOf: (key: string) => Record<string, unknown> | undefined,
  refCols: string[]
): string[] {
  if (refCols.length === 0) return keys
  const inSet = new Set(keys)
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (k: string): number => {
    const known = depth.get(k)
    if (known !== undefined) return known
    if (visiting.has(k)) return 0
    visiting.add(k)
    let d = 0
    const data = dataOf(k)
    for (const c of refCols) {
      const v = data?.[c]
      if (v === null || v === undefined) continue
      const p = String(v)
      if (p !== k && inSet.has(p)) d = Math.max(d, depthOf(p) + 1)
    }
    visiting.delete(k)
    depth.set(k, d)
    return d
  }
  return [...keys].sort((a, b) => depthOf(a) - depthOf(b))
}

export class RestoreOpError extends Error {
  constructor(
    readonly table: string,
    readonly key: string,
    readonly op: OpKind,
    readonly cause: unknown
  ) {
    super(`${op} ${table} #${key}: ${driverMessage(cause)}`)
  }
}

/** The database's own words: knex prefixes the SQL text ("<sql> - <message>"). */
export function driverMessage(err: unknown): string {
  const e = err as { originalError?: { message?: string }; message?: string }
  const raw =
    e?.originalError?.message ??
    (typeof e?.message === 'string'
      ? e.message.includes(' - ')
        ? e.message.slice(e.message.lastIndexOf(' - ') + 3)
        : e.message
      : String(err))
  return raw.replace(/\s+/g, ' ').trim().slice(0, 400)
}

function errorNumber(err: unknown): number | undefined {
  const e = err as { number?: number; originalError?: { info?: { number?: number } } }
  return e?.number ?? e?.originalError?.info?.number
}

/** SQL Server errors a later pass can clear: FK conflict (547), unique key (2627 / 2601). */
export function isRetryableDbError(err: unknown): boolean {
  const n = errorNumber(err)
  return n === 547 || n === 2627 || n === 2601
}

/** Lock request timed out (1222) — LOCK_TIMEOUT expired waiting for someone else's write. */
export function isLockTimeout(err: unknown): boolean {
  if (errorNumber(err) === 1222) return true
  return /lock request time ?out period exceeded/i.test(
    err instanceof Error ? err.message : String(err)
  )
}

export interface RunnableOp {
  table: string
  key: string
  op: OpKind
  run: () => Promise<void>
}

/**
 * Exported for tests: run the operations in order; one that fails on a retryable constraint is
 * tried again after the rest of the pass. Throws RestoreOpError on the first non-retryable
 * failure, when the transaction is no longer alive, or when a pass makes no progress.
 */
export async function runOps(
  ops: RunnableOp[],
  opts: {
    retryable: (err: unknown) => boolean
    alive: () => Promise<boolean>
    maxPasses?: number
  }
): Promise<void> {
  let pending = ops
  const maxPasses = opts.maxPasses ?? 6
  for (let pass = 1; pending.length > 0; pass++) {
    const failed: Array<{ op: RunnableOp; err: unknown }> = []
    // The transaction is checked on a pass's first constraint failure and before a retry pass —
    // not after every failure (a round trip each: hundreds of blocked rows cost minutes).
    let checked = false
    for (const op of pending) {
      try {
        await op.run()
      } catch (err) {
        if (!opts.retryable(err)) throw new RestoreOpError(op.table, op.key, op.op, err)
        if (!checked) {
          if (!(await opts.alive())) throw new RestoreOpError(op.table, op.key, op.op, err)
          checked = true
        }
        failed.push({ op, err })
      }
    }
    if (failed.length === 0) return
    if (failed.length === pending.length || pass >= maxPasses) {
      const f = failed[0]
      throw new RestoreOpError(f.op.table, f.op.key, f.op.op, f.err)
    }
    if (!(await opts.alive())) {
      const f = failed[0]
      throw new RestoreOpError(f.op.table, f.op.key, f.op.op, f.err)
    }
    pending = failed.map((f) => f.op)
  }
}

/** Exported for tests: a snapshot value as the driver should bind it. */
export function toDbValue(v: unknown, info: ColumnInfo | undefined): unknown {
  if (v === null || v === undefined) return null
  const t = (info?.type ?? '').toLowerCase()
  if (typeof v === 'string' && /date|time/.test(t)) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? v : d
  }
  if (typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    const b = v as { type?: string; data?: unknown }
    if (/binary|image/.test(t) && b.type === 'Buffer' && Array.isArray(b.data)) {
      return Buffer.from(b.data as number[])
    }
    return JSON.stringify(v)
  }
  return v
}

// ── database side ────────────────────────────────────────────────────────────

/**
 * A short-lived pool for one restore or preview: its own 2-minute request timeout, never the
 * request pool, destroyed afterwards (so no session state outlives it). The driver-seam hooks
 * (config epoch, metadata cache invalidation) patch the driver prototype and still hear its
 * writes; afterConfigWrite does the rest explicitly.
 */
export async function withRestoreDb<T>(fn: (k: Knex) => Promise<T>): Promise<T> {
  const base = buildConnection(config.DB_HOST, writePort) as { options?: Record<string, unknown> }
  const k = knexFactory({
    client: config.DB_CLIENT,
    connection: {
      ...base,
      options: { ...(base.options ?? {}), requestTimeout: REQUEST_TIMEOUT_MS }
    } as Knex.StaticConnectionConfig,
    pool: { min: 0, max: 6 }
  })
  try {
    return await fn(k)
  } finally {
    await k.destroy().catch(() => {})
  }
}

export async function loadLiveColumns(
  tables: string[],
  database: Knex
): Promise<Map<string, TableColumns>> {
  const out = new Map<string, TableColumns>()
  if (tables.length === 0) return out
  // Trailing ';': never answered from the driver-seam metadata cache.
  const rows = (await database.raw(
    `SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS c, c.DATA_TYPE AS type,
            COLUMNPROPERTY(OBJECT_ID(c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') AS is_identity,
            COLUMNPROPERTY(OBJECT_ID(c.TABLE_NAME), c.COLUMN_NAME, 'IsComputed') AS is_computed
       FROM information_schema.columns c
      WHERE c.TABLE_NAME LIKE 'nivaro[_]%';`
  )) as Array<{ t: string; c: string; type: string; is_identity: number; is_computed: number }>
  const want = new Set(tables)
  for (const r of rows) {
    if (!want.has(r.t)) continue
    let m = out.get(r.t)
    if (!m) {
      m = new Map()
      out.set(r.t, m)
    }
    const type = String(r.type).toLowerCase()
    m.set(r.c, {
      type,
      identity: Number(r.is_identity) === 1,
      writable: Number(r.is_computed) !== 1 && type !== 'timestamp' && type !== 'rowversion'
    })
  }
  return out
}

export async function loadForeignKeys(database: Knex): Promise<ForeignKey[]> {
  return (await database.raw(
    `SELECT tp.name AS child, cp.name AS childCol, tr.name AS parent, cr.name AS parentCol,
            fk.delete_referential_action_desc AS onDelete
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.tables tp ON tp.object_id = fk.parent_object_id
       JOIN sys.tables tr ON tr.object_id = fk.referenced_object_id
       JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
       JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
      WHERE tp.name LIKE 'nivaro[_]%' AND tr.name LIKE 'nivaro[_]%';`
  )) as ForeignKey[]
}

/** The people GRANT_TABLES rows in `target` grant to (for one active-user read). */
export function grantUserIds(target: ConfigSnapshot['tables'], tables: string[]): string[] {
  const out = new Set<string>()
  for (const t of tables) {
    const col = GRANT_TABLES[t]
    if (!col) continue
    for (const row of Object.values(target[t] ?? {})) {
      const v = row.data[col]
      if (typeof v === 'string' && GUID_RE.test(v)) out.add(v.toUpperCase())
    }
  }
  return [...out]
}

/** Active people among `ids` (upper-case): status active, not redacted, not a placeholder. */
export async function loadActiveUsers(database: Knex, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (const chunk of chunkArray(
    ids.filter((i) => GUID_RE.test(i)),
    1000
  )) {
    const rows = (await database.raw(
      `SELECT CAST(id AS nvarchar(64)) AS id FROM nivaro_users
        WHERE status = 'active' AND ISNULL(is_redacted, 0) = 0
          AND ISNULL(account_kind, '') <> 'placeholder'
          AND id IN (${chunk.map(() => '?').join(', ')});`,
      chunk
    )) as Array<{ id: string }>
    for (const r of rows) out.add(String(r.id).toUpperCase())
  }
  return out
}

/**
 * Rows the planned deletes would take with them (CASCADE) or null out (SET NULL / DEFAULT)
 * through a foreign key, beyond the rows the plan deletes itself. One level: a deeper cascade
 * starts only from rows this already counts.
 */
export async function computeCascade(
  database: Knex,
  plans: TablePlan[],
  fks: ForeignKey[]
): Promise<CascadeEffect[]> {
  const plannedDeletes = new Map(
    plans.map((p) => [p.table, new Set(p.ops.filter((o) => o.op === 'delete').map((o) => o.key))])
  )
  const out: CascadeEffect[] = []
  for (const p of plans) {
    const keys = [...(plannedDeletes.get(p.table) ?? [])]
    if (keys.length === 0) continue
    for (const fk of fks) {
      if (fk.parent !== p.table || fk.parentCol !== 'id') continue
      const action = String(fk.onDelete ?? 'NO_ACTION').toUpperCase()
      if (action === 'NO_ACTION') continue
      if (!IDENT_RE.test(fk.child) || !IDENT_RE.test(fk.childCol)) continue
      const alsoDeleted = plannedDeletes.get(fk.child) ?? new Set<string>()
      let rows = 0
      for (const chunk of chunkArray(keys, 1000)) {
        const where = `[${fk.childCol}] IN (${chunk.map(() => '?').join(', ')})`
        try {
          const found = (await database.raw(
            `SELECT CAST([id] AS nvarchar(100)) AS id FROM [${fk.child}] WHERE ${where};`,
            chunk
          )) as Array<{ id: string }>
          rows += found.filter((r) => !alsoDeleted.has(String(r.id))).length
        } catch {
          // A child without an id column: every match counts.
          const n = (await database.raw(
            `SELECT COUNT(*) AS n FROM [${fk.child}] WHERE ${where};`,
            chunk
          )) as Array<{ n: number }>
          rows += Number(n[0]?.n ?? 0)
        }
      }
      if (rows > 0) out.push({ table: p.table, child: fk.child, column: fk.childCol, action, rows })
    }
  }
  return out.sort((a, b) => `${a.table}${a.child}`.localeCompare(`${b.table}${b.child}`))
}

export interface AppliedCounts {
  table: string
  inserted: number
  updated: number
  deleted: number
}

/**
 * Run the plans inside `trx`. Throws RestoreOpError — the caller's transaction rolls back.
 * `target` = the snapshot rows written; `live` = the live rows (delete ordering reads them).
 * Every statement is one parameterised batch led by `SET LOCK_TIMEOUT` (see SESSION STATE).
 */
export async function applyTablePlans(
  trx: Knex.Transaction,
  plans: TablePlan[],
  target: ConfigSnapshot['tables'],
  live: ConfigSnapshot['tables'],
  columns: Map<string, TableColumns>,
  fks: ForeignKey[],
  lockTimeoutMs = LOCK_TIMEOUT_MS
): Promise<AppliedCounts[]> {
  const lead = `SET LOCK_TIMEOUT ${Math.max(0, Math.floor(lockTimeoutMs))};`
  const active = plans.filter((p) => p.ops.length > 0)
  const order = orderTables(
    active.map((p) => p.table),
    fks
  )
  const byTable = new Map(active.map((p) => [p.table, p]))
  const counts = new Map<string, AppliedCounts>(
    active.map((p) => [p.table, { table: p.table, inserted: 0, updated: 0, deleted: 0 }])
  )
  const selfRefs = (table: string) =>
    fks.filter((f) => f.child === table && f.parent === table).map((f) => f.childCol)

  const runnable = (table: string, o: PlanOp): RunnableOp => {
    const cols = columns.get(table) ?? new Map()
    const c = counts.get(table) as AppliedCounts
    if (o.op === 'delete') {
      return {
        table,
        key: o.key,
        op: 'delete',
        run: async () => {
          await trx.raw(`${lead} DELETE FROM [${table}] WHERE [id] = ?;`, [o.key])
          c.deleted++
        }
      }
    }
    const data = target[table]?.[o.key]?.data ?? {}
    const values: Record<string, unknown> = {}
    const byValue = o.fields.filter((f) => isValueRedactedColumn(table, f))
    for (const f of o.fields) {
      values[f] = isValueRedactedColumn(table, f)
        ? toDbValue(restoreRedactedValue(table, f, data[f], null), cols.get(f))
        : toDbValue(data[f], cols.get(f))
    }
    if (o.op === 'update') {
      return {
        table,
        key: o.key,
        op: 'update',
        run: async () => {
          if (byValue.length > 0) {
            // The credential parts come back from the row being overwritten, never the snapshot.
            const cur = (await trx.raw(
              `${lead} SELECT ${byValue.map((c) => `[${c}]`).join(', ')} FROM [${table}] WITH (UPDLOCK, HOLDLOCK) WHERE [id] = ?;`,
              [o.key]
            )) as Array<Record<string, unknown>>
            for (const c of byValue) {
              values[c] = toDbValue(
                restoreRedactedValue(table, c, data[c], cur[0]?.[c] ?? null),
                cols.get(c)
              )
            }
          }
          const names = Object.keys(values)
          const res = (await trx.raw(
            `${lead} UPDATE [${table}] SET ${names.map((n) => `[${n}] = ?`).join(', ')} WHERE [id] = ?; SELECT @@ROWCOUNT AS n;`,
            [...names.map((n) => values[n] as never), o.key]
          )) as Array<{ n: number }>
          if (Number(res[res.length - 1]?.n ?? 0) === 0)
            throw new Error('the row is gone — preview again')
          c.updated++
        }
      }
    }
    const identity = cols.get('id')?.identity === true && values.id != null
    return {
      table,
      key: o.key,
      op: 'insert',
      run: async () => {
        const names = Object.keys(values)
        const insert = `INSERT INTO [${table}] (${names.map((n) => `[${n}]`).join(', ')}) VALUES (${names.map(() => '?').join(', ')});`
        // IDENTITY_INSERT lives inside the one batch (sp_executesql scope ends it either way).
        await trx.raw(
          identity
            ? `${lead} SET IDENTITY_INSERT [${table}] ON; ${insert} SET IDENTITY_INSERT [${table}] OFF;`
            : `${lead} ${insert}`,
          names.map((n) => values[n] as never)
        )
        c.inserted++
      }
    }
  }

  const ops: RunnableOp[] = []
  // Deletes child-first (and child rows of a self-referencing table before their parents).
  for (const table of [...order].reverse()) {
    const p = byTable.get(table) as TablePlan
    const keys = p.ops.filter((o) => o.op === 'delete').map((o) => o.key)
    const ordered = orderBySelfRef(keys, (k) => live[table]?.[k]?.data, selfRefs(table)).reverse()
    const opOf = new Map(p.ops.filter((o) => o.op === 'delete').map((o) => [o.key, o]))
    for (const k of ordered) ops.push(runnable(table, opOf.get(k) as PlanOp))
  }
  // Inserts then updates, parent-first.
  for (const table of order) {
    const p = byTable.get(table) as TablePlan
    const inserts = p.ops.filter((o) => o.op === 'insert')
    const opOf = new Map(inserts.map((o) => [o.key, o]))
    const ordered = orderBySelfRef(
      inserts.map((o) => o.key),
      (k) => target[table]?.[k]?.data,
      selfRefs(table)
    )
    for (const k of ordered) ops.push(runnable(table, opOf.get(k) as PlanOp))
    for (const o of p.ops) if (o.op === 'update') ops.push(runnable(table, o))
  }

  await runOps(ops, {
    retryable: isRetryableDbError,
    alive: async () => {
      try {
        const r = (await trx.raw('SELECT XACT_STATE() AS s')) as Array<{ s: number }>
        return Number(r[0]?.s) === 1
      } catch {
        return false
      }
    }
  })
  return order.map((t) => counts.get(t) as AppliedCounts)
}

export class StaleInsideTransaction extends Error {}

/**
 * The write transaction both callers share: the application lock (one config write at a time,
 * across replicas), the touched tables re-read WITH (UPDLOCK, HOLDLOCK) under LOCK_TIMEOUT and
 * re-planned, the hash compared, then `write`.
 * Throws StaleInsideTransaction when the plan moved, RestoreError BUSY / LOCKED, or whatever
 * `write` throws — the transaction rolls back on any of them.
 */
export async function lockedWrite<T>(
  k: Knex,
  tables: string[],
  replan: (
    trx: Knex.Transaction,
    locked: ConfigSnapshot
  ) => Promise<{ hash: string; plans: TablePlan[] }>,
  expectedHash: string,
  write: (trx: Knex.Transaction, locked: ConfigSnapshot, plans: TablePlan[]) => Promise<T>
): Promise<T> {
  try {
    return await k.transaction(async (trx) => {
      const lock = (await trx.raw(
        `DECLARE @r int;
         EXEC @r = sp_getapplock @Resource = N'nivaro:config-restore', @LockMode = 'Exclusive',
              @LockOwner = 'Transaction', @LockTimeout = 0;
         SELECT @r AS r;`
      )) as Array<{ r: number }>
      if (Number(lock[0]?.r) < 0)
        throw new RestoreError(409, 'Another config restore is running', 'BUSY')
      {
        const locked = await buildConfigSnapshot(
          {
            tables,
            lock: true,
            lockTimeoutMs: LOCK_TIMEOUT_MS,
            concurrency: 1,
            version: NIVARO_VERSION,
            environment: config.NODE_ENV
          },
          trx as unknown as Parameters<typeof buildConfigSnapshot>[1]
        )
        const failed = Object.entries(locked.errors)
        if (failed.length) {
          const [t, msg] = failed[0]
          throw isLockTimeout(new Error(msg))
            ? new RestoreError(
                409,
                `${t} is being written by someone else (waited ${LOCK_TIMEOUT_MS / 1000} s) — nothing was written; try again.`,
                'LOCKED'
              )
            : new Error(`Could not read ${t}: ${msg}`)
        }
        const again = await replan(trx, locked)
        if (again.hash !== expectedHash) throw new StaleInsideTransaction()
        return await write(trx, locked, again.plans)
      }
    })
  } catch (err) {
    if (err instanceof StaleInsideTransaction || err instanceof RestoreError) throw err
    if (isLockTimeout(err)) {
      throw new RestoreError(
        409,
        `A config table is being written by someone else (waited ${LOCK_TIMEOUT_MS / 1000} s) — nothing was written; try again.`,
        'LOCKED'
      )
    }
    throw err
  }
}

/** Drop every cache a config write can stale and tell open forms + sockets (after a commit). */
export async function afterConfigWrite(tables: string[]): Promise<void> {
  const tasks: Array<() => unknown | Promise<unknown>> = [
    async () => (await import('./collections.js')).clearMetadataCache(),
    async () => (await import('../db/metadata-query-cache.js')).clearMetadataQueryCache(),
    async () => (await import('./section-locks.js')).bustSectionLockCache(),
    async () => (await import('./config-conformance.js')).bustCompiledChecks(),
    async () => (await import('./app-links.js')).bustPortalLinkCache(),
    async () => (await import('./row-rules-autofill.js')).clearRowRuleCache(),
    async () => (await import('./relation-limits.js')).clearRelationLimitCache(),
    async () => (await import('./picker-rules.js')).clearPickerRuleCache(),
    async () => (await import('./layout-references.js')).bustLayoutReferences(),
    async () => (await import('./definition-cache.js')).bustDefinitionCache(),
    // Other replicas: the configuration number moves, their caches follow.
    async () => (await import('../db/config-epoch.js')).bumpConfigEpoch(),
    async () => (await import('./permission-cache.js')).bumpAccessVersion(),
    async () => (await import('./socket-access.js')).requestAccessRecheck({ all: true }),
    async () => (await import('./record-events.js')).announceAccessChanged(),
    async () => {
      const live = await import('./config-live.js')
      const surfaces = new Set(
        tables.map((t) => live.surfaceOfConfigTable(t)).filter((s): s is string => !!s)
      )
      for (const s of surfaces) live.announceConfigChanged(s)
    }
  ]
  for (const t of tasks) {
    try {
      await t()
    } catch {
      // Each is best-effort; the epoch's TTL covers a miss.
    }
  }
}

// ── stored-snapshot restore ─────────────────────────────────────────────────

export interface PublicRowChange {
  key: string
  op: OpKind
  label: string | null
  fields: Array<{ field: string; now: unknown; was: unknown }>
}

export interface PublicTablePlan extends Omit<TablePlan, 'ops' | 'inactive_keys'> {
  rows: PublicRowChange[]
  /** More rows planned than `rows` carries. */
  more: number
}

export interface RestorePreview {
  snapshot_id: number
  snapshot: {
    taken_at: string
    version: string
    environment: string
    database: string
    restore_point: ConfigSnapshot['restore_point'] | null
  }
  plan_hash: string
  tables: PublicTablePlan[]
  refused: Array<{ table: string; reason: string }>
  totals: {
    inserts: number
    updates: number
    deletes: number
    tables: number
    skipped_inactive_user: number
  }
  /** Rows deletes would take with them through CASCADE / SET NULL foreign keys. */
  cascade: CascadeEffect[]
  allow_cascade: boolean
  warnings: string[]
  over_cap: boolean
  cap: number
}

interface ComputedPlan {
  preview: RestorePreview
  plans: TablePlan[]
  target: ConfigSnapshot
  columns: Map<string, TableColumns>
  fks: ForeignKey[]
}

function cap(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v.length > VALUE_CAP ? `${v.slice(0, VALUE_CAP)}…` : v
  if (v instanceof Date) return v.toISOString()
  const s = JSON.stringify(v)
  return s.length > VALUE_CAP ? `${s.slice(0, VALUE_CAP)}…` : v
}

function labelOf(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null
  for (const k of ['name', 'label', 'title', 'key', 'slug', 'field', 'collection']) {
    const v = data[k]
    if (typeof v === 'string' && v.trim()) return v.slice(0, 120)
  }
  return null
}

/** A secret-named field's value never leaves the server, whatever a snapshot carried. */
function shown(table: string, field: string, v: unknown): unknown {
  if (v === null || v === undefined) return null
  return isRedactedColumn(table, field) || isSecretColumn(field) ? MASK : cap(v)
}

/** Exported for tests: the preview rows of one table plan (values capped, secrets masked). */
export function publicRows(
  plan: TablePlan,
  target: Record<string, SnapshotRow>,
  live: Record<string, SnapshotRow>
): PublicRowChange[] {
  const t0 = plan.table
  return plan.ops.slice(0, ROWS_PER_TABLE).map((o) => {
    const t = target[o.key]?.data
    const l = live[o.key]?.data
    if (o.op === 'delete') {
      return {
        key: o.key,
        op: o.op,
        label: labelOf(l),
        fields: Object.entries(l ?? {})
          .filter(([, v]) => v !== null && v !== undefined)
          .slice(0, 40)
          .map(([field, v]) => ({ field, now: shown(t0, field, v), was: null }))
      }
    }
    if (o.op === 'insert') {
      return {
        key: o.key,
        op: o.op,
        label: labelOf(t),
        fields: o.fields
          .filter((f) => t?.[f] !== null && t?.[f] !== undefined)
          .slice(0, 40)
          .map((field) => ({ field, now: null, was: shown(t0, field, t?.[field]) }))
      }
    }
    return {
      key: o.key,
      op: o.op,
      label: labelOf(l) ?? labelOf(t),
      fields: o.fields.map((field) => ({
        field,
        now: shown(t0, field, l?.[field]),
        was: shown(t0, field, t?.[field])
      }))
    }
  })
}

export class RestoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

async function computeWith(
  k: Knex,
  id: number,
  scope: string[] | null | undefined,
  allowCascade: boolean
): Promise<ComputedPlan> {
  const { loadConfigSnapshot } = await import('./config-snapshots.js')
  const target = await loadConfigSnapshot(id)
  if (!target) throw new RestoreError(404, 'Snapshot not found', 'NOT_FOUND')
  if (target.format !== 1)
    throw new RestoreError(400, `Unsupported snapshot format ${target.format}`, 'FORMAT')

  const present = (await k.raw(
    `SELECT name FROM sys.tables WHERE name LIKE 'nivaro[_]%';`
  )) as Array<{ name: string }>
  const presentSet = new Set(present.map((r) => r.name))
  const configSet = new Set(classifyTables([...presentSet]).config)
  const scopeSet = scope?.length ? new Set(scope) : null

  const refused: RestorePreview['refused'] = []
  const allowed: string[] = []
  for (const table of Object.keys(target.tables).sort()) {
    if (scopeSet && !scopeSet.has(table)) continue
    if (RESTORE_EXCLUDED[table]) refused.push({ table, reason: RESTORE_EXCLUDED[table] })
    else if (!presentSet.has(table))
      refused.push({ table, reason: 'The table no longer exists here' })
    else if (!configSet.has(table))
      refused.push({ table, reason: 'No longer a configuration table on this instance' })
    else allowed.push(table)
  }

  const [live, columns, fks, active] = await Promise.all([
    allowed.length
      ? buildConfigSnapshot(
          {
            version: NIVARO_VERSION,
            environment: config.NODE_ENV,
            tables: allowed,
            concurrency: 6
          },
          k as unknown as Parameters<typeof buildConfigSnapshot>[1]
        )
      : Promise.resolve(null),
    loadLiveColumns(allowed, k),
    loadForeignKeys(k),
    loadActiveUsers(k, grantUserIds(target.tables, allowed))
  ])
  const isActiveUser = (u: string) => active.has(u.toUpperCase())
  const plans: TablePlan[] = []
  for (const table of allowed) {
    if (!live || live.errors[table] || !live.tables[table]) {
      refused.push({ table, reason: `Could not read the live rows: ${live?.errors[table] ?? '?'}` })
      continue
    }
    plans.push(
      planTable(table, target.tables[table], live.tables[table], columns.get(table) ?? new Map(), {
        deletes: true,
        isActiveUser
      })
    )
  }
  const changed = plans.filter((p) => p.ops.length > 0 || p.inactive_keys.length > 0)
  const cascade = await computeCascade(k, changed, fks)

  const dbName = ((await k.raw('SELECT DB_NAME() AS n;')) as Array<{ n: string }>)[0]?.n
  const warnings: string[] = []
  if (target.instance.database && dbName && target.instance.database !== dbName) {
    warnings.push(
      `This snapshot was taken on ${target.instance.database}; this instance is ${dbName} (a database restored from another one carries its snapshots).`
    )
  }
  const totals = { inserts: 0, updates: 0, deletes: 0, tables: 0, skipped_inactive_user: 0 }
  for (const p of plans) {
    totals.inserts += p.inserts
    totals.updates += p.updates
    totals.deletes += p.deletes
    totals.skipped_inactive_user += p.skipped_inactive_user
    if (p.ops.length) totals.tables++
  }
  const planned = totals.inserts + totals.updates + totals.deletes
  const preview: RestorePreview = {
    snapshot_id: id,
    snapshot: {
      taken_at: target.generated_at,
      version: target.instance.version,
      environment: target.instance.environment,
      database: target.instance.database,
      restore_point: target.restore_point ?? null
    },
    plan_hash: planHash(`snapshot:${id}`, changed, { cascade, allowCascade }),
    tables: changed.map((p) => {
      const { ops, inactive_keys: _k, ...rest } = p
      return {
        ...rest,
        rows: publicRows(p, target.tables[p.table], live?.tables[p.table] ?? {}),
        more: Math.max(0, ops.length - ROWS_PER_TABLE)
      }
    }),
    refused,
    totals,
    cascade,
    allow_cascade: allowCascade,
    warnings,
    over_cap: planned > RESTORE_CAP,
    cap: RESTORE_CAP
  }
  return { preview, plans: changed, target, columns, fks }
}

export async function previewRestore(
  id: number,
  scope?: string[] | null,
  allowCascade = false
): Promise<RestorePreview> {
  if (!isMssql()) throw new RestoreError(501, 'Config restore needs SQL Server', 'UNSUPPORTED')
  return withRestoreDb(async (k) => (await computeWith(k, id, scope, allowCascade)).preview)
}

/** Probes only (rolled back): the computed plan on a caller's pool. */
export async function computeRestorePlan(
  k: Knex,
  id: number,
  scope?: string[] | null,
  allowCascade = false
): Promise<ComputedPlan> {
  return computeWith(k, id, scope, allowCascade)
}

export interface RestoreResult {
  snapshot_id: number
  /** The restore point stored just before the write — restore it to undo this. */
  pre_restore_id: number | null
  tables: AppliedCounts[]
  totals: { inserted: number; updated: number; deleted: number }
}

let restoring = false

/**
 * Apply a restore bound to the preview `planHash`. Throws RestoreError: 409 STALE (with the
 * fresh preview) when live config moved since, 409 BUSY / LOCKED, 409 CASCADE when deletes
 * would take rows with them and the plan did not opt in, 400 OVER_CAP, 422 FAILED (nothing
 * written) when an operation failed.
 */
export async function applyRestore(
  id: number,
  opts: {
    planHash: string
    tables?: string[] | null
    allowCascade?: boolean
    userId?: string | null
    req?: Parameters<typeof import('./activity.js').logActivity>[0]['req']
  }
): Promise<RestoreResult> {
  if (!isMssql()) throw new RestoreError(501, 'Config restore needs SQL Server', 'UNSUPPORTED')
  if (restoring) throw new RestoreError(409, 'Another config restore is running', 'BUSY')
  restoring = true
  const allowCascade = opts.allowCascade === true
  try {
    const out = await withRestoreDb(async (k) => {
      const plan = await computeWith(k, id, opts.tables, allowCascade)
      const stale = async () =>
        new RestoreError(
          409,
          'Configuration changed since the preview — review the new preview and apply again.',
          'STALE',
          { preview: (await computeWith(k, id, opts.tables, allowCascade)).preview }
        )
      if (plan.preview.plan_hash !== opts.planHash) {
        throw new RestoreError(
          409,
          'Configuration changed since the preview — review the new preview and apply again.',
          'STALE',
          { preview: plan.preview }
        )
      }
      if (plan.preview.over_cap) {
        throw new RestoreError(
          400,
          `More than ${RESTORE_CAP} rows would change — restore fewer tables at a time.`,
          'OVER_CAP'
        )
      }
      if (plan.preview.cascade.length > 0 && !allowCascade) {
        throw new RestoreError(
          409,
          'Deleting these rows would also delete or clear rows in other tables — review them and confirm.',
          'CASCADE',
          { cascade: plan.preview.cascade }
        )
      }
      const touched = plan.plans.filter((p) => p.ops.length > 0).map((p) => p.table)
      if (touched.length === 0) return { applied: [] as AppliedCounts[], pre: null, touched }
      const hashTables = plan.plans.map((p) => p.table)
      const when = new Date(plan.target.generated_at)
      const note = `Before restoring ${touched.length} table${touched.length === 1 ? '' : 's'} to snapshot #${id} (${when.toISOString().slice(0, 16).replace('T', ' ')} UTC)`
      try {
        return await lockedWrite(
          k,
          hashTables,
          async (trx, locked) => {
            const active = await loadActiveUsers(
              trx as unknown as Knex,
              grantUserIds(plan.target.tables, hashTables)
            )
            const plans = hashTables.map((t) =>
              planTable(
                t,
                plan.target.tables[t],
                locked.tables[t] ?? {},
                plan.columns.get(t) ?? new Map(),
                {
                  deletes: true,
                  isActiveUser: (u) => active.has(u.toUpperCase())
                }
              )
            )
            const changed = plans.filter((p) => p.ops.length > 0 || p.inactive_keys.length > 0)
            const cascade = await computeCascade(trx as unknown as Knex, changed, plan.fks)
            return {
              hash: planHash(`snapshot:${id}`, changed, { cascade, allowCascade }),
              plans: changed
            }
          },
          opts.planHash,
          async (trx, locked, plans) => {
            const { storeConfigSnapshot } = await import('./config-snapshots.js')
            // The undo point: exactly the rows this transaction locked, stored in it (a failed
            // restore leaves no orphan restore point behind).
            const preSnap: ConfigSnapshot = {
              ...locked,
              tables: Object.fromEntries(touched.map((t) => [t, locked.tables[t] ?? {}]))
            }
            const pre = await storeConfigSnapshot(
              preSnap,
              'pre-restore',
              { userId: opts.userId ?? null, restoreOf: id, note },
              trx as unknown as Knex
            )
            const applied = await applyTablePlans(
              trx,
              plans,
              plan.target.tables,
              locked.tables,
              plan.columns,
              plan.fks
            )
            return { applied, pre, touched }
          }
        )
      } catch (err) {
        if (err instanceof StaleInsideTransaction) throw await stale()
        if (err instanceof RestoreError) throw err
        throw new RestoreError(
          422,
          err instanceof Error ? err.message : 'Restore failed',
          'FAILED',
          err instanceof RestoreOpError ? { table: err.table, key: err.key, op: err.op } : {}
        )
      }
    })
    if (!out.pre) {
      return {
        snapshot_id: id,
        pre_restore_id: null,
        tables: [],
        totals: { inserted: 0, updated: 0, deleted: 0 }
      }
    }
    const { afterSnapshotStored } = await import('./config-snapshots.js')
    await afterSnapshotStored(out.pre, { userId: opts.userId ?? null, note: out.pre.note ?? null })
    await afterConfigWrite(out.touched)
    const { logActivity } = await import('./activity.js')
    for (const a of out.applied) {
      await logActivity({
        action: 'config-restore',
        user: opts.userId ?? null,
        collection: a.table,
        item: String(id),
        comment: `restored to snapshot #${id}: ${a.inserted} inserted, ${a.updated} updated, ${a.deleted} deleted`,
        req: opts.req
      })
    }
    const totals = out.applied.reduce(
      (s, a) => ({
        inserted: s.inserted + a.inserted,
        updated: s.updated + a.updated,
        deleted: s.deleted + a.deleted
      }),
      { inserted: 0, updated: 0, deleted: 0 }
    )
    await logActivity({
      action: 'config-restore',
      user: opts.userId ?? null,
      collection: 'nivaro_config_snapshots',
      item: String(id),
      comment: `${out.applied.length} tables restored to snapshot #${id} (${totals.inserted} inserted, ${totals.updated} updated, ${totals.deleted} deleted); undo = restore #${out.pre.id}`,
      req: opts.req
    })
    return { snapshot_id: id, pre_restore_id: out.pre.id, tables: out.applied, totals }
  } finally {
    restoring = false
  }
}

// ── one table from an uploaded snapshot ─────────────────────────────────────

/** Identity and credential tables an uploaded snapshot never writes, beyond RESTORE_EXCLUDED. */
export interface UploadApplyPreview {
  table: string
  inserts: number
  updates: number
  unchanged: number
  skipped_keyless: number
  skipped_inactive_user: number
  insert_keys: string[]
  update_keys: string[]
  plan_hash: string
}

const UPLOAD_CAP = 5000

/**
 * Pull one CONFIG table's rows from an uploaded snapshot (redacted by the caller): upsert only,
 * bound to the preview hash, written in one locked transaction. Throws RestoreError.
 */
export async function applyUploadedTable(
  theirs: ConfigSnapshot,
  table: string,
  opts: {
    mode: 'preview' | 'apply'
    planHash?: string | null
    keys?: string[] | null
    userId?: string | null
  }
): Promise<UploadApplyPreview | (AppliedCounts & { plan_hash: string })> {
  if (!isMssql()) throw new RestoreError(501, 'Config apply needs SQL Server', 'UNSUPPORTED')
  if (RESTORE_EXCLUDED[table]) {
    throw new RestoreError(400, `${table}: ${RESTORE_EXCLUDED[table]}`, 'EXCLUDED')
  }
  const theirRows = theirs.tables[table]
  if (!theirRows) throw new RestoreError(400, `The snapshot does not carry ${table}`, 'MISSING')
  const keySet = opts.keys?.length ? new Set(opts.keys.map(String)) : null
  const ref = `upload:${table}:${createHash('sha256')
    .update(JSON.stringify(Object.entries(theirRows).map(([k, r]) => [k, r.hash])))
    .digest('hex')}:${[...(keySet ?? [])].sort().join(',')}`
  return withRestoreDb(async (k) => {
    const present = (await k.raw(
      `SELECT name FROM sys.tables WHERE name LIKE 'nivaro[_]%';`
    )) as Array<{ name: string }>
    if (!classifyTables(present.map((r) => r.name)).config.includes(table)) {
      throw new RestoreError(
        400,
        `${table} is not a CONFIG table on this instance — only config applies`,
        'NOT_CONFIG'
      )
    }
    const columns = await loadLiveColumns([table], k)
    const cols = columns.get(table) ?? new Map()
    const plan = async (database: Knex, liveRows: Record<string, SnapshotRow>) => {
      const active = await loadActiveUsers(database, grantUserIds(theirs.tables, [table]))
      const p = planTable(table, theirRows, liveRows, cols, {
        deletes: false,
        keys: keySet,
        isActiveUser: (u) => active.has(u.toUpperCase())
      })
      return { p, hash: planHash(ref, [p]) }
    }
    const mine = await buildConfigSnapshot(
      { tables: [table], version: NIVARO_VERSION, environment: config.NODE_ENV },
      k as unknown as Parameters<typeof buildConfigSnapshot>[1]
    )
    const { p, hash } = await plan(k, mine.tables[table] ?? {})
    const inserts = p.ops.filter((o) => o.op === 'insert').map((o) => o.key)
    const updates = p.ops.filter((o) => o.op === 'update').map((o) => o.key)
    const preview: UploadApplyPreview = {
      table,
      inserts: inserts.length,
      updates: updates.length,
      unchanged: p.unchanged,
      skipped_keyless: p.skipped_keyless,
      skipped_inactive_user: p.skipped_inactive_user,
      insert_keys: inserts.slice(0, 50),
      update_keys: updates.slice(0, 50),
      plan_hash: hash
    }
    if (inserts.length + updates.length > UPLOAD_CAP) {
      throw new RestoreError(
        400,
        `${inserts.length + updates.length} rows planned — the per-apply cap is ${UPLOAD_CAP}. Scope with keys[].`,
        'OVER_CAP'
      )
    }
    if (opts.mode === 'preview') return preview
    const stale = new RestoreError(
      409,
      'This table changed since the preview — preview again.',
      'STALE',
      { preview }
    )
    if (opts.planHash !== hash) throw stale
    if (p.ops.length === 0) return { table, inserted: 0, updated: 0, deleted: 0, plan_hash: hash }
    let counts: AppliedCounts[]
    try {
      counts = await lockedWrite(
        k,
        [table],
        async (trx, locked) => {
          const again = await plan(trx as unknown as Knex, locked.tables[table] ?? {})
          return { hash: again.hash, plans: [again.p] }
        },
        hash,
        async (trx, locked, plans) => {
          const fks = await loadForeignKeys(trx as unknown as Knex)
          return applyTablePlans(trx, plans, theirs.tables, locked.tables, columns, fks)
        }
      )
    } catch (err) {
      if (err instanceof StaleInsideTransaction) throw stale
      if (err instanceof RestoreError) throw err
      throw new RestoreError(
        422,
        err instanceof Error ? err.message : 'Apply failed',
        'FAILED',
        err instanceof RestoreOpError ? { key: err.key, op: err.op } : {}
      )
    }
    await afterConfigWrite([table])
    return { ...(counts[0] ?? { table, inserted: 0, updated: 0, deleted: 0 }), plan_hash: hash }
  })
}
