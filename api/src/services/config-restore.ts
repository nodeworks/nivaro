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
 *   columns are dropped from snapshots (not masked), so a restore never overwrites a live secret
 *   with a stripped value; redacted and credential column names are refused even when an
 *   uploaded file carries them.
 * - An update writes only the columns that differ. A row that differs only in columns the
 *   snapshot never had (a migration added them since) is "unchanged" — there is nothing to
 *   write back.
 *
 * Apply is bound to the preview the person saw: the preview's plan hash covers every planned
 * operation and the live row hash it would overwrite, the apply recomputes the plan and answers
 * stale (409 + the fresh preview) when it moved. A 'pre-restore' snapshot of the touched tables
 * is stored before the write, so a restore can itself be undone.
 *
 * ATOMICITY: the whole restore is one transaction (SQL Server, XACT_ABORT off so a constraint
 * error ends only its statement). Operations run deletes child-first, then inserts and updates
 * parent-first (foreign keys among the touched tables, self-references row by row); a statement
 * that fails on a foreign key or unique key is retried after the rest of the pass — a re-created
 * row frees its unique key, a re-pointed child frees its parent. Anything still failing (or any
 * other error, or a doomed transaction) rolls the whole restore back and names the row.
 */
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { config } from '../config.js'
import { db, isMssql } from '../db/index.js'
import { NIVARO_VERSION } from '../version.js'
import {
  buildConfigSnapshot,
  type ConfigSnapshot,
  classifyTables,
  isRedactedColumn,
  type SnapshotRow
} from './config-inventory.js'
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

/** Most operations one restore may run — past it, restore fewer tables at a time. */
export const RESTORE_CAP = 10_000
/** Rows per table returned with a preview (the counts are always exact). */
const ROWS_PER_TABLE = 50
const VALUE_CAP = 300

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

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
  /** Snapshot columns the live table no longer has (never written). */
  dropped_columns: string[]
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
  opts: { deletes: boolean; keys?: Set<string> | null }
): TablePlan {
  const scope = opts.keys && opts.keys.size > 0 ? opts.keys : null
  const ops: PlanOp[] = []
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
    if (current.hash === row.hash) {
      unchanged++
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
    dropped_columns: [...dropped].sort()
  }
}

/** Exported for tests: one hash over everything a plan would do and what it would overwrite. */
export function planHash(ref: string, plans: TablePlan[]): string {
  const body = plans
    .filter((p) => p.ops.length > 0)
    .map((p) => [
      p.table,
      p.ops.map(
        (o) => `${o.op}:${o.key}:${o.live_hash ?? ''}:${o.target_hash ?? ''}:${o.fields.join(',')}`
      )
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  return createHash('sha256')
    .update(JSON.stringify([ref, body]))
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

/** SQL Server errors a later pass can clear: FK conflict (547), unique key (2627 / 2601). */
export function isRetryableDbError(err: unknown): boolean {
  const e = err as { number?: number; originalError?: { info?: { number?: number } } }
  const n = e?.number ?? e?.originalError?.info?.number
  return n === 547 || n === 2627 || n === 2601
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
    for (const op of pending) {
      try {
        await op.run()
      } catch (err) {
        if (!opts.retryable(err) || !(await opts.alive())) {
          throw new RestoreOpError(op.table, op.key, op.op, err)
        }
        failed.push({ op, err })
      }
    }
    if (failed.length === 0) return
    if (failed.length === pending.length || pass >= maxPasses) {
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

export async function loadLiveColumns(
  tables: string[],
  database: Knex = db as unknown as Knex
): Promise<Map<string, TableColumns>> {
  const out = new Map<string, TableColumns>()
  if (tables.length === 0) return out
  const rows = (await database.raw(
    `SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS c, c.DATA_TYPE AS type,
            COLUMNPROPERTY(OBJECT_ID(c.TABLE_NAME), c.COLUMN_NAME, 'IsIdentity') AS is_identity,
            COLUMNPROPERTY(OBJECT_ID(c.TABLE_NAME), c.COLUMN_NAME, 'IsComputed') AS is_computed
       FROM information_schema.columns c
      WHERE c.TABLE_NAME LIKE 'nivaro[_]%'`
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

export async function loadForeignKeys(
  database: Knex = db as unknown as Knex
): Promise<ForeignKey[]> {
  return (await database.raw(
    `SELECT tp.name AS child, cp.name AS childCol, tr.name AS parent, cr.name AS parentCol
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.tables tp ON tp.object_id = fk.parent_object_id
       JOIN sys.tables tr ON tr.object_id = fk.referenced_object_id
       JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
       JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
      WHERE tp.name LIKE 'nivaro[_]%' AND tr.name LIKE 'nivaro[_]%'`
  )) as ForeignKey[]
}

export interface AppliedCounts {
  table: string
  inserted: number
  updated: number
  deleted: number
}

/**
 * Run the plans inside `trx`. Throws RestoreOpError (the caller's transaction rolls back).
 * `target` = the snapshot rows written; `live` = the live rows (delete ordering reads them).
 */
export async function applyTablePlans(
  trx: Knex.Transaction,
  plans: TablePlan[],
  target: ConfigSnapshot['tables'],
  live: ConfigSnapshot['tables'],
  columns: Map<string, TableColumns>,
  fks: ForeignKey[]
): Promise<AppliedCounts[]> {
  await trx.raw('SET XACT_ABORT OFF')
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
          await trx(table).where('id', o.key).del()
          c.deleted++
        }
      }
    }
    const data = target[table]?.[o.key]?.data ?? {}
    const values: Record<string, unknown> = {}
    for (const f of o.fields) values[f] = toDbValue(data[f], cols.get(f))
    if (o.op === 'update') {
      return {
        table,
        key: o.key,
        op: 'update',
        run: async () => {
          const n = Number(await trx(table).where('id', o.key).update(values))
          if (n === 0) throw new Error('the row is gone — preview again')
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
        if (identity) {
          // IDENTITY_INSERT must live inside ONE batch (trash-restore precedent).
          const names = Object.keys(values)
          try {
            await trx.raw(
              `SET IDENTITY_INSERT [${table}] ON;
               INSERT INTO [${table}] (${names.map((n) => `[${n}]`).join(', ')})
               VALUES (${names.map(() => '?').join(', ')});
               SET IDENTITY_INSERT [${table}] OFF;`,
              names.map((n) => values[n] as never)
            )
          } catch (err) {
            // The setting is per session: never leave it on for the next table (or the pool).
            await trx.raw(`SET IDENTITY_INSERT [${table}] OFF`).catch(() => {})
            throw err
          }
        } else {
          await trx(table).insert(values)
        }
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

/** Drop every cache a config write can stale and tell open forms + sockets (after a commit). */
export async function afterConfigWrite(tables: string[]): Promise<void> {
  const tasks: Array<() => unknown | Promise<unknown>> = [
    async () => (await import('./collections.js')).clearMetadataCache(),
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

export interface PublicTablePlan extends Omit<TablePlan, 'ops'> {
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
  totals: { inserts: number; updates: number; deletes: number; tables: number }
  warnings: string[]
  over_cap: boolean
}

export interface ComputedPlan {
  preview: RestorePreview
  plans: TablePlan[]
  target: ConfigSnapshot
  live: ConfigSnapshot
  columns: Map<string, TableColumns>
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

/** Exported for tests: the preview rows of one table plan (values capped, secrets never present). */
export function publicRows(
  plan: TablePlan,
  target: Record<string, SnapshotRow>,
  live: Record<string, SnapshotRow>
): PublicRowChange[] {
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
          .map(([field, v]) => ({ field, now: cap(v), was: null }))
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
          .map((field) => ({ field, now: null, was: cap(t?.[field]) }))
      }
    }
    return {
      key: o.key,
      op: o.op,
      label: labelOf(l) ?? labelOf(t),
      fields: o.fields.map((field) => ({ field, now: cap(l?.[field]), was: cap(t?.[field]) }))
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

export async function computeRestorePlan(
  id: number,
  scope?: string[] | null
): Promise<ComputedPlan> {
  if (!isMssql()) throw new RestoreError(501, 'Config restore needs SQL Server', 'UNSUPPORTED')
  const { loadConfigSnapshot } = await import('./config-snapshots.js')
  const target = await loadConfigSnapshot(id)
  if (!target) throw new RestoreError(404, 'Snapshot not found', 'NOT_FOUND')
  if (target.format !== 1)
    throw new RestoreError(400, `Unsupported snapshot format ${target.format}`, 'FORMAT')

  const present = (await db.raw(
    `SELECT name FROM sys.tables WHERE name LIKE 'nivaro[_]%'`
  )) as Array<{
    name: string
  }>
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

  const [live, columns] = await Promise.all([
    allowed.length
      ? buildConfigSnapshot({
          version: NIVARO_VERSION,
          environment: config.NODE_ENV,
          tables: allowed,
          concurrency: 6
        })
      : Promise.resolve(null),
    loadLiveColumns(allowed)
  ])
  const plans: TablePlan[] = []
  for (const table of allowed) {
    if (!live || live.errors[table] || !live.tables[table]) {
      refused.push({ table, reason: `Could not read the live rows: ${live?.errors[table] ?? '?'}` })
      continue
    }
    plans.push(
      planTable(table, target.tables[table], live.tables[table], columns.get(table) ?? new Map(), {
        deletes: true
      })
    )
  }

  const dbName = ((await db.raw('SELECT DB_NAME() AS n')) as Array<{ n: string }>)[0]?.n
  const warnings: string[] = []
  if (target.instance.database && dbName && target.instance.database !== dbName) {
    warnings.push(
      `This snapshot was taken on ${target.instance.database}; this instance is ${dbName} (a database restored from another one carries its snapshots).`
    )
  }
  const totals = { inserts: 0, updates: 0, deletes: 0, tables: 0 }
  for (const p of plans) {
    totals.inserts += p.inserts
    totals.updates += p.updates
    totals.deletes += p.deletes
    if (p.ops.length) totals.tables++
  }
  const planned = totals.inserts + totals.updates + totals.deletes
  const changed = plans.filter((p) => p.ops.length > 0)
  const preview: RestorePreview = {
    snapshot_id: id,
    snapshot: {
      taken_at: target.generated_at,
      version: target.instance.version,
      environment: target.instance.environment,
      database: target.instance.database,
      restore_point: target.restore_point ?? null
    },
    plan_hash: planHash(`snapshot:${id}`, plans),
    tables: changed.map((p) => {
      const { ops, ...rest } = p
      return {
        ...rest,
        rows: publicRows(p, target.tables[p.table], live?.tables[p.table] ?? {}),
        more: Math.max(0, ops.length - ROWS_PER_TABLE)
      }
    }),
    refused,
    totals,
    warnings,
    over_cap: planned > RESTORE_CAP
  }
  return { preview, plans: changed, target, live: live as ConfigSnapshot, columns }
}

export async function previewRestore(id: number, scope?: string[] | null): Promise<RestorePreview> {
  return (await computeRestorePlan(id, scope)).preview
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
 * fresh preview) when live config moved since, 409 BUSY when another restore runs, 422 FAILED
 * (nothing written) when an operation failed.
 */
export async function applyRestore(
  id: number,
  opts: {
    planHash: string
    tables?: string[] | null
    userId?: string | null
    req?: Parameters<typeof import('./activity.js').logActivity>[0]['req']
  }
): Promise<RestoreResult> {
  if (restoring) throw new RestoreError(409, 'Another config restore is running', 'BUSY')
  restoring = true
  try {
    const plan = await computeRestorePlan(id, opts.tables)
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
    if (plan.plans.length === 0) {
      return {
        snapshot_id: id,
        pre_restore_id: null,
        tables: [],
        totals: { inserted: 0, updated: 0, deleted: 0 }
      }
    }
    const touched = plan.plans.map((p) => p.table)
    const { takeConfigSnapshot } = await import('./config-snapshots.js')
    const when = new Date(plan.target.generated_at)
    const pre = await takeConfigSnapshot('pre-restore', {
      userId: opts.userId ?? null,
      tables: touched,
      restoreOf: id,
      note: `Before restoring ${touched.length} table${touched.length === 1 ? '' : 's'} to snapshot #${id} (${when.toISOString().slice(0, 16).replace('T', ' ')} UTC)`
    })
    const fks = await loadForeignKeys()
    let applied: AppliedCounts[]
    try {
      applied = await db.transaction(async (trx) => {
        const lock = (await trx.raw(
          `DECLARE @r int;
           EXEC @r = sp_getapplock @Resource = N'nivaro:config-restore', @LockMode = 'Exclusive',
                @LockOwner = 'Transaction', @LockTimeout = 0;
           SELECT @r AS r`
        )) as Array<{ r: number }>
        if (Number(lock[0]?.r) < 0)
          throw new RestoreError(409, 'Another config restore is running', 'BUSY')
        return applyTablePlans(
          trx,
          plan.plans,
          plan.target.tables,
          plan.live.tables,
          plan.columns,
          fks
        )
      })
    } catch (err) {
      if (err instanceof RestoreError) throw err
      throw new RestoreError(
        422,
        err instanceof Error ? err.message : 'Restore failed',
        'FAILED',
        err instanceof RestoreOpError
          ? { table: err.table, key: err.key, op: err.op, pre_restore_id: pre.id }
          : { pre_restore_id: pre.id }
      )
    }
    await afterConfigWrite(touched)
    const { logActivity } = await import('./activity.js')
    for (const a of applied) {
      await logActivity({
        action: 'config-restore',
        user: opts.userId ?? null,
        collection: a.table,
        item: String(id),
        comment: `restored to snapshot #${id}: ${a.inserted} inserted, ${a.updated} updated, ${a.deleted} deleted`,
        req: opts.req
      })
    }
    const totals = applied.reduce(
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
      comment: `${applied.length} tables restored to snapshot #${id} (${totals.inserted} inserted, ${totals.updated} updated, ${totals.deleted} deleted); undo = restore #${pre.id}`,
      req: opts.req
    })
    return { snapshot_id: id, pre_restore_id: pre.id, tables: applied, totals }
  } finally {
    restoring = false
  }
}
