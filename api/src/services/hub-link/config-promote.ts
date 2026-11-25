import { createHash } from 'node:crypto'
import { config } from '../../config.js'
import { NIVARO_VERSION } from '../../version.js'
import { appEnvironment } from '../app-info-environment.js'
import {
  buildConfigSnapshot,
  type ConfigSnapshot,
  hashRow,
  isRedactedColumn,
  redactFlowOptions,
  redactSnapshot,
  type SnapshotRow
} from '../config-inventory.js'
import { promotableTables } from '../config-promote-groups.js'
import {
  applyGivenSnapshot,
  applyRestore,
  previewGivenSnapshot,
  previewRestore,
  RestoreError,
  type RestorePreview,
  type RestoreResult,
  restoreEngineSupported
} from '../config-restore.js'
import type { EnvKeepEntry } from '../env-refresh/registry.js'

/**
 * Hub config promotion (idea 30), APP side: what a Nivaro Hub asks of an app to move its
 * configuration from one environment to another. The Hub reads a snapshot from the SOURCE app and
 * hands it to the TARGET app, which plans and applies it with the config restore engine
 * (services/config-restore.ts — the same plan, hash binding, lock, pre-apply restore point and
 * secret rules as Environments → Config). Nothing here copies config by itself.
 *
 *   source  readPromotionSnapshot   the promotable tables as a redacted snapshot, minus every
 *                                   column this app's keep registry calls a secret
 *   target  planPromotion           field diff + plan hash, what this environment keeps, the
 *                                   changes made here a write would overwrite (Changed here)
 *           applyPromotion          bound to the plan hash; stores the pre-apply restore point;
 *                                   deploys changed managed procedures; moves the Changed-here
 *                                   baseline for the promoted tables
 *           undoPromotion           restore that pre-apply point (preview / apply, bound)
 *
 * Never carried: secrets (redacted by name and by list at export, again on arrival, and every
 * `secret_columns` of the keep registry stripped on BOTH sides), tables this environment keeps
 * whole, kept columns (its endpoints, switches, sign-in), people, the schema registry.
 * A row the source has and this environment does not, in a table whose columns are kept here,
 * arrives only when every kept column is a switch (it arrives switched off; a flow step arrives
 * without its outbound options) — otherwise it is held back and named on the plan.
 */

export const HUB_PROMOTE_NOTE = 'Before a Nivaro Hub config promotion'
const FLOW_OPS = 'nivaro_flow_operations'
const FLOW_OPS_KEEP = 'core:flow-op-endpoints'

export class PromoteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

// ── pure: what travels and what this environment keeps ──────────────────────

/** A switch column and the value a row new to this environment gets (off). */
export function switchOff(table: string, column: string): { value: unknown } | null {
  if (/^(enabled|is_active|active)$/.test(column)) return { value: false }
  if (column === 'status' && table === 'nivaro_flows') return { value: 'inactive' }
  return null
}

function withRows(
  snap: ConfigSnapshot,
  tables: Record<string, Record<string, SnapshotRow>>
): ConfigSnapshot {
  return { ...snap, tables }
}

function rehash(data: Record<string, unknown>): SnapshotRow {
  return { hash: hashRow(data), data }
}

/** Every column the keep registry marks secret, per table (both sides strip them). */
export function secretColumnsByTable(keeps: readonly EnvKeepEntry[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const k of keeps) {
    if (!k.secret_columns?.length) continue
    const set = out.get(k.table) ?? new Set<string>()
    for (const c of k.secret_columns) set.add(c)
    out.set(k.table, set)
  }
  return out
}

/**
 * Keep-registry columns that are not table columns but a part of one (a "pseudo-column"), with
 * how each is taken off a row. `nivaro_flow_operations.outbound` = the outbound options inside a
 * step's `options` (env-refresh/flow-ops); `.fields` names those options (no value to strip).
 * A keep entry naming a column neither real nor listed here is a gap: the guard test
 * (hub-config-promote-secrets.guard.test.ts) fails on it, and stripKeepSecrets throws when such
 * a name meets rows that do not carry it (it could not tell whether it applied).
 */
export const KEEP_PSEUDO_COLUMNS: Record<
  string,
  Record<string, (data: Record<string, unknown>) => Record<string, unknown>>
> = {
  nivaro_flow_operations: {
    outbound: (d) => ('options' in d ? { ...d, options: redactFlowOptions(d.options) } : d),
    fields: (d) => d
  }
}

/**
 * Both sides: the snapshot without any column (or pseudo-column) the keep registry calls a
 * secret. Pure. `strict` (the SOURCE, reading its own rows: every column is there, null or not,
 * unless the snapshot redaction already dropped it) throws when a secret name is neither a column
 * of the rows, a column the redaction drops, nor a known pseudo-column — never silently does
 * nothing. The target is lenient: rows from an older source may simply not have a newer column.
 */
export function stripKeepSecrets(
  snap: ConfigSnapshot,
  keeps: readonly EnvKeepEntry[],
  opts: { strict?: boolean } = {}
): ConfigSnapshot {
  const secrets = secretColumnsByTable(keeps)
  const tables: ConfigSnapshot['tables'] = {}
  for (const [table, rows] of Object.entries(snap.tables)) {
    const drop = secrets.get(table)
    if (!drop?.size) {
      tables[table] = rows
      continue
    }
    const pseudo = KEEP_PSEUDO_COLUMNS[table] ?? {}
    const list = Object.values(rows)
    if (opts.strict && list.length)
      for (const c of drop) {
        if (pseudo[c] || isRedactedColumn(table, c)) continue
        if (!list.some((r) => c in r.data))
          throw new Error(
            `The keep rule for ${table} names ${c}, which is neither a column of its rows nor a part this promotion knows how to strip`
          )
      }
    const out: Record<string, SnapshotRow> = {}
    for (const [key, row] of Object.entries(rows)) {
      let data: Record<string, unknown> = {}
      for (const [c, v] of Object.entries(row.data)) if (!drop.has(c) || pseudo[c]) data[c] = v
      for (const c of drop) if (pseudo[c]) data = pseudo[c](data)
      out[key] = rehash(data)
    }
    tables[table] = out
  }
  return withRows(snap, tables)
}

export interface KeptNote {
  table: string
  label: string
  columns: string[]
}
export interface HeldRow {
  table: string
  key: string
  label: string | null
  reason: string
}
export interface Prepared {
  snapshot: ConfigSnapshot
  refused: Array<{ table: string; reason: string }>
  kept: KeptNote[]
  held: HeldRow[]
  switched_off: Array<{ table: string; key: string; label: string | null }>
}

function rowLabel(data: Record<string, unknown> | undefined): string | null {
  for (const k of ['name', 'label', 'title', 'key', 'collection']) {
    const v = data?.[k]
    if (typeof v === 'string' && v.trim()) return v.slice(0, 120)
  }
  return null
}

/**
 * Target side, pure: the incoming snapshot as THIS environment's keep registry allows it.
 *  - `table` / `rows` / `delegate` entries: the table (and a delegate's further tables) is not
 *    promoted at all (refused, with the entry's reason);
 *  - `columns` entries: those columns are taken off every incoming row (this environment's
 *    values stay). A row new here: switches arrive off; any other kept column holds it back;
 *  - flow steps (core:flow-op-endpoints): a step's options arrive WITHOUT any outbound part (URL,
 *    headers, secrets, path override — stripped on both sides); the restore engine writes this
 *    environment's own outbound part back from the live row (config-inventory VALUE_REDACTED),
 *    so a new step arrives without one.
 * `live` = this environment's current rows of the tables with `columns` entries.
 */
export function applyTargetKeeps(
  snap: ConfigSnapshot,
  keeps: readonly EnvKeepEntry[],
  live: Record<string, Record<string, SnapshotRow>>
): Prepared {
  const refused: Prepared['refused'] = []
  const kept: KeptNote[] = []
  const held: HeldRow[] = []
  const switched: Prepared['switched_off'] = []
  const wholeTables = new Map<string, EnvKeepEntry>()
  const columnKeeps = new Map<string, EnvKeepEntry[]>()
  for (const k of keeps) {
    if (k.kind === 'table' || k.kind === 'rows' || k.kind === 'delegate') {
      for (const t of [k.table, ...(k.kind === 'delegate' ? (k.tables ?? []) : [])])
        if (!wholeTables.has(t)) wholeTables.set(t, k)
    } else if (k.kind === 'columns') {
      columnKeeps.set(k.table, [...(columnKeeps.get(k.table) ?? []), k])
    }
  }
  const tables: ConfigSnapshot['tables'] = {}
  for (const [table, rows] of Object.entries(snap.tables)) {
    const whole = wholeTables.get(table)
    if (whole) {
      refused.push({ table, reason: `This environment keeps its own: ${whole.label}` })
      continue
    }
    const entries = columnKeeps.get(table) ?? []
    if (!entries.length) {
      tables[table] = rows
      continue
    }
    const flowSteps = table === FLOW_OPS && entries.some((e) => e.id === FLOW_OPS_KEEP)
    const keptCols = new Set<string>()
    for (const e of entries) {
      if (e.id === FLOW_OPS_KEEP) continue
      for (const c of e.columns ?? []) keptCols.add(c)
    }
    if (keptCols.size || flowSteps)
      kept.push({
        table,
        label: entries.map((e) => e.label).join('; '),
        columns: [...keptCols, ...(flowSteps ? ['options (outbound part)'] : [])]
      })
    const here = live[table] ?? {}
    const out: Record<string, SnapshotRow> = {}
    for (const [key, row] of Object.entries(rows)) {
      const isNew = !here[key]
      const data: Record<string, unknown> = {}
      for (const [c, v] of Object.entries(row.data)) if (!keptCols.has(c)) data[c] = v
      if (isNew && keptCols.size) {
        const blocking = [...keptCols].filter(
          (c) => row.data[c] !== undefined && !switchOff(table, c)
        )
        if (blocking.length) {
          held.push({
            table,
            key,
            label: rowLabel(row.data),
            reason: `New here; set ${blocking.join(', ')} on this environment first (they are not copied)`
          })
          continue
        }
        let off = false
        for (const c of keptCols) {
          const sw = switchOff(table, c)
          if (sw && row.data[c] !== undefined) {
            data[c] = sw.value
            off = true
          }
        }
        if (off) switched.push({ table, key, label: rowLabel(row.data) })
      }
      if (flowSteps && 'options' in data) data.options = redactFlowOptions(data.options)
      out[key] = rehash(data)
    }
    tables[table] = out
  }
  return { snapshot: withRows(snap, tables), refused, kept, held, switched_off: switched }
}

/** The plan-hash reference of a prepared snapshot + its scope: changes when any row does. */
export function preparedRef(prepared: ConfigSnapshot, deletes: boolean): string {
  const body = Object.keys(prepared.tables)
    .sort()
    .map((t) => [
      t,
      Object.entries(prepared.tables[t])
        .map(([k, r]) => `${k}:${r.hash}`)
        .sort()
    ])
  return `hub:${createHash('sha256')
    .update(JSON.stringify([body, deletes]))
    .digest('hex')}`
}

// ── request validation ──────────────────────────────────────────────────────

export interface PromoteRequest {
  snapshot: ConfigSnapshot
  tables: string[]
  deletes: boolean
  allow_cascade: boolean
  /** Shown in notes and the activity log only ("staging", "Hub promotion #12"). */
  source_label: string
  promotion_id: number | null
  actor: string | null
}

const label = (v: unknown, max: number): string =>
  typeof v === 'string'
    ? v
        .replace(/[\r\n\t]+/g, ' ')
        .trim()
        .slice(0, max)
    : ''

/** Validates the tables a request names: promotable ones only. Throws PromoteError 400. */
export function parseTables(raw: unknown): string[] {
  const ok = promotableTables()
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100)
    throw new PromoteError(400, 'BAD_TABLES', 'tables must name 1–100 promotable config tables')
  const out: string[] = []
  for (const t of raw) {
    if (typeof t !== 'string' || !ok.has(t))
      throw new PromoteError(400, 'BAD_TABLES', `${String(t).slice(0, 80)} is not promotable`)
    if (!out.includes(t)) out.push(t)
  }
  return out
}

export function parsePromoteRequest(body: unknown): PromoteRequest {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const snap = b.snapshot as ConfigSnapshot | undefined
  if (!snap || typeof snap !== 'object' || snap.format !== 1 || !snap.tables)
    throw new PromoteError(400, 'BAD_SNAPSHOT', 'Body must carry a format-1 config snapshot')
  if (typeof snap.tables !== 'object' || Array.isArray(snap.tables))
    throw new PromoteError(400, 'BAD_SNAPSHOT', 'The snapshot has no tables')
  const tables = parseTables(b.tables)
  const id = Number(b.promotion_id)
  return {
    snapshot: snap,
    tables,
    deletes: b.deletes === true,
    allow_cascade: b.allow_cascade === true,
    source_label: label(b.source_label, 80) || 'another environment',
    promotion_id: Number.isSafeInteger(id) && id > 0 ? id : null,
    actor: label(b.actor, 120) || null
  }
}

// ── source ──────────────────────────────────────────────────────────────────

async function keeps(): Promise<EnvKeepEntry[]> {
  const { allKeeps } = await import('../env-refresh/registry.js')
  return allKeeps()
}

export interface PromotionSnapshotAnswer {
  version: string
  environment: string
  snapshot: ConfigSnapshot
}

/** The promotable tables `tables` as this app has them now (redacted, keep secrets stripped). */
export async function readPromotionSnapshot(tablesRaw: unknown): Promise<PromotionSnapshotAnswer> {
  const tables = parseTables(tablesRaw)
  const snap = await buildConfigSnapshot({
    tables,
    version: NIVARO_VERSION,
    environment: config.NODE_ENV,
    concurrency: 4
  })
  // The database name is this app's business, never the Hub's or the target's.
  const out = stripKeepSecrets(redactSnapshot(snap), await keeps(), { strict: true })
  return {
    version: NIVARO_VERSION,
    environment: appEnvironment(),
    snapshot: { ...out, instance: { ...out.instance, database: '' } }
  }
}

// ── target ──────────────────────────────────────────────────────────────────

async function prepare(req: PromoteRequest): Promise<{
  prepared: Prepared
  missing: string[]
  ref: string
  warnings: string[]
}> {
  if (!restoreEngineSupported())
    throw new PromoteError(
      501,
      'NOT_SUPPORTED_ON_DATABASE',
      'Config promotion needs a SQL Server database on this environment.'
    )
  const theirs = redactSnapshot(req.snapshot)
  const scoped: ConfigSnapshot['tables'] = {}
  const missing: string[] = []
  for (const t of req.tables) {
    if (theirs.tables[t]) scoped[t] = theirs.tables[t]
    else missing.push(t)
  }
  const reg = await keeps()
  const columnTables = [
    ...new Set(reg.filter((k) => k.kind === 'columns' && scoped[k.table]).map((k) => k.table))
  ]
  const live = columnTables.length
    ? (
        await buildConfigSnapshot({
          tables: columnTables,
          version: NIVARO_VERSION,
          environment: config.NODE_ENV
        })
      ).tables
    : {}
  // Stripped again here (whatever the source sent): the target's own secrets are merged back by
  // the restore engine on write, never taken from the snapshot.
  const prepared = applyTargetKeeps(stripKeepSecrets({ ...theirs, tables: scoped }, reg), reg, live)
  const warnings: string[] = []
  const v = String(theirs.instance?.version ?? '')
  if (v && v !== NIVARO_VERSION)
    warnings.push(
      `The source runs Nivaro ${v.slice(0, 40)}; this environment runs ${NIVARO_VERSION}. Columns only one side has are left as they are.`
    )
  return { prepared, missing, ref: preparedRef(prepared.snapshot, req.deletes), warnings }
}

async function prodOnlyCheck(tables: ConfigSnapshot['tables'], deletes: boolean) {
  const { checkOverwrite, driftTrackingHere } = await import('../config-drift/store.js')
  if (!(await driftTrackingHere())) return null
  return checkOverwrite(tables, { tables: Object.keys(tables), deletes })
}

export interface PromotionPlanAnswer {
  version: string
  environment: string
  preview: RestorePreview
  refused: Array<{ table: string; reason: string }>
  kept: KeptNote[]
  held: HeldRow[]
  switched_off: Prepared['switched_off']
  prod_only_changes: unknown[]
  prod_only_lines: string[]
  /** This environment refuses overwriting them (Changed here → Refuse promotions). */
  prod_only_refuse: boolean
  warnings: string[]
}

function refusedOf(p: Prepared, missing: string[]): PromotionPlanAnswer['refused'] {
  return [
    ...p.refused,
    ...missing.map((table) => ({
      table,
      reason: 'The source did not send this table (an older version, or it could not be read)'
    }))
  ]
}

function rethrow(err: unknown): never {
  if (err instanceof RestoreError)
    throw new PromoteError(err.status, err.code, err.message, err.extra)
  throw err
}

const IDENTITY_FIELDS = new Set(['name', 'key', 'slug', 'collection', 'field'])

/** Pure: updates (in the listed rows) that change what a row is called — ids may not match. */
export function identityChanges(preview: Pick<RestorePreview, 'tables'>): number {
  let n = 0
  for (const t of preview.tables)
    for (const r of t.rows)
      if (r.op === 'update' && r.fields.some((f) => IDENTITY_FIELDS.has(f.field))) n++
  return n
}

export async function planPromotion(body: unknown): Promise<PromotionPlanAnswer> {
  const req = parsePromoteRequest(body)
  const { prepared, missing, ref, warnings } = await prepare(req)
  let preview: RestorePreview
  try {
    preview = await previewGivenSnapshot(prepared.snapshot, {
      ref,
      deletes: req.deletes,
      allowCascade: req.allow_cascade
    })
  } catch (err) {
    rethrow(err)
  }
  const renamed = identityChanges(preview)
  if (renamed > 0)
    warnings.push(
      `${renamed} row${renamed === 1 ? '' : 's'} would change ${renamed === 1 ? 'its' : 'their'} name or key. Rows are matched by id: if these environments were not set up from one another, the same id can be a different thing here — check those rows before applying.`
    )
  const check = await prodOnlyCheck(prepared.snapshot.tables, req.deletes)
  if (check?.error) warnings.push(`Could not check for changes made here: ${check.error}`)
  return {
    version: NIVARO_VERSION,
    environment: appEnvironment(),
    preview: { ...preview, refused: [...preview.refused, ...refusedOf(prepared, missing)] },
    refused: refusedOf(prepared, missing),
    kept: prepared.kept,
    held: prepared.held,
    switched_off: prepared.switched_off,
    prod_only_changes: check?.items ?? [],
    prod_only_lines: check?.lines ?? [],
    prod_only_refuse: !!check?.refuse && (check.items?.length ?? 0) > 0,
    warnings: [...warnings, ...preview.warnings]
  }
}

export interface PromotionApplyAnswer {
  result: RestoreResult
  procedures: { deployed: number; failed: number; names: string[] } | null
  baseline: 'moved' | 'unchanged'
}

function prodOnlyRefusal(
  check: Awaited<ReturnType<typeof prodOnlyCheck>>,
  override: unknown
): PromoteError | null {
  if (!check?.refuse || check.items.length === 0 || override === true) return null
  const n = check.items.length
  return new PromoteError(
    409,
    'PROD_ONLY_CHANGES',
    `${n} change${n === 1 ? '' : 's'} made here, not from promotion, would be overwritten. Mark ${n === 1 ? 'it' : 'them'} as intended or copy ${n === 1 ? 'it' : 'them'} to dev first (Environments → Changed here).`,
    { items: check.items, lines: check.lines }
  )
}

/** Managed procedure definitions the write touched → deploy them here (their ONE writer). */
async function deployTouchedProcedures(
  touched: string[],
  names: string[]
): Promise<PromotionApplyAnswer['procedures']> {
  if (!touched.includes('nivaro_managed_procedures') || names.length === 0) return null
  const { deployAllAppManaged } = await import('../managed-procedures/deploy.js')
  const out = await deployAllAppManaged({
    execute: true,
    only: names,
    by: 'Nivaro Hub config promotion'
  })
  return {
    deployed: out.results.filter((r) => r.action !== 'skipped' && r.action !== 'failed').length,
    failed: out.failed,
    names: out.results.filter((r) => r.action === 'failed').map((r) => r.name)
  }
}

function procNames(rows: Record<string, SnapshotRow> | undefined): string[] {
  return Object.values(rows ?? {})
    .map((r) => r.data.name)
    .filter((n): n is string => typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
}

/**
 * Changed here (config drift): the promoted tables join the promotion baseline, so what the Hub
 * just wrote is "from promotion" — every other table keeps its baseline (a fresh full snapshot
 * would swallow changes still open there). Only while tracking is on and the baseline is the
 * newest 'promote' snapshot (a pinned baseline is the operator's and stays).
 */
async function moveBaseline(touched: string[], note: string): Promise<'moved' | 'unchanged'> {
  if (!touched.length) return 'unchanged'
  try {
    const drift = await import('../config-drift/store.js')
    const settings = await drift.getDriftSettings()
    if (!drift.driftActive(settings)) return 'unchanged'
    const base = await drift.resolveBaseline(settings)
    if (!base || base.pinned) return 'unchanged'
    const snaps = await import('../config-snapshots.js')
    const old = await snaps.loadConfigSnapshot(base.snapshot_id)
    if (!old) return 'unchanged'
    const now = await buildConfigSnapshot({
      tables: touched,
      version: NIVARO_VERSION,
      environment: config.NODE_ENV
    })
    const composite: ConfigSnapshot = {
      ...old,
      generated_at: new Date().toISOString(),
      restore_point: undefined,
      tables: { ...old.tables, ...now.tables }
    }
    const meta = await snaps.storeConfigSnapshot(composite, 'promote', { note })
    await snaps.afterSnapshotStored(meta, { note })
    drift.forgetDriftReport()
    return 'moved'
  } catch {
    return 'unchanged'
  }
}

export async function applyPromotion(body: unknown): Promise<PromotionApplyAnswer> {
  const req = parsePromoteRequest(body)
  const b = (body ?? {}) as Record<string, unknown>
  const hash = String(b.plan_hash ?? '')
  if (!/^[0-9a-f]{64}$/.test(hash))
    throw new PromoteError(400, 'PLAN_HASH_REQUIRED', 'plan_hash from the plan is required')
  const { prepared, ref } = await prepare(req)
  const refusal = prodOnlyRefusal(
    await prodOnlyCheck(prepared.snapshot.tables, req.deletes),
    b.overwrite_prod_changes
  )
  if (refusal) throw refusal
  const tag = req.promotion_id ? ` #${req.promotion_id}` : ''
  const who = req.actor ? ` by ${req.actor}` : ''
  let result: RestoreResult
  try {
    result = await applyGivenSnapshot(prepared.snapshot, {
      ref,
      deletes: req.deletes,
      planHash: hash,
      allowCascade: req.allow_cascade,
      userId: null,
      note: `${HUB_PROMOTE_NOTE}${tag} from ${req.source_label}${who}`,
      activityNote: `Nivaro Hub config promotion${tag} from ${req.source_label}${who}`
    })
  } catch (err) {
    rethrow(err)
  }
  const touched = result.tables
    .filter((t) => t.inserted + t.updated + t.deleted > 0)
    .map((t) => t.table)
  const procedures = await deployTouchedProcedures(
    touched,
    procNames(prepared.snapshot.tables.nivaro_managed_procedures)
  ).catch(() => ({ deployed: 0, failed: -1, names: [] as string[] }))
  const baseline = await moveBaseline(
    touched,
    `After a Nivaro Hub config promotion${tag} from ${req.source_label}`
  )
  return { result, procedures, baseline }
}

/** The restore point must be one a Hub promotion stored here (never any restore point). */
async function promotionPoint(raw: unknown): Promise<{ id: number; snap: ConfigSnapshot }> {
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new PromoteError(400, 'BAD_RESTORE_POINT', 'restore_id must be a restore point id')
  const { loadConfigSnapshot } = await import('../config-snapshots.js')
  const snap = await loadConfigSnapshot(id)
  const rp = snap?.restore_point
  if (!snap || rp?.trigger !== 'pre-restore' || !String(rp.note ?? '').startsWith(HUB_PROMOTE_NOTE))
    throw new PromoteError(
      404,
      'NOT_A_PROMOTION_POINT',
      'No restore point a Hub config promotion stored here has that id'
    )
  return { id, snap }
}

export interface PromotionUndoAnswer {
  mode: 'preview' | 'apply'
  preview?: RestorePreview
  prod_only_changes?: unknown[]
  prod_only_lines?: string[]
  prod_only_refuse?: boolean
  result?: RestoreResult
  procedures?: PromotionApplyAnswer['procedures']
}

export async function undoPromotion(body: unknown): Promise<PromotionUndoAnswer> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const mode = b.mode === 'apply' ? 'apply' : b.mode === 'preview' ? 'preview' : null
  if (!mode) throw new PromoteError(400, 'BAD_MODE', "mode must be 'preview' or 'apply'")
  if (!restoreEngineSupported())
    throw new PromoteError(
      501,
      'NOT_SUPPORTED_ON_DATABASE',
      'Config promotion needs a SQL Server database on this environment.'
    )
  const { id, snap } = await promotionPoint(b.restore_id)
  const check = await prodOnlyCheck(snap.tables, true)
  try {
    if (mode === 'preview') {
      const preview = await previewRestore(id, null, b.allow_cascade === true)
      return {
        mode,
        preview,
        prod_only_changes: check?.items ?? [],
        prod_only_lines: check?.lines ?? [],
        prod_only_refuse: !!check?.refuse && (check.items?.length ?? 0) > 0
      }
    }
    const hash = String(b.plan_hash ?? '')
    if (!/^[0-9a-f]{64}$/.test(hash))
      throw new PromoteError(
        400,
        'PLAN_HASH_REQUIRED',
        'plan_hash from the undo preview is required'
      )
    const refusal = prodOnlyRefusal(check, b.overwrite_prod_changes)
    if (refusal) throw refusal
    const result = await applyRestore(id, {
      planHash: hash,
      allowCascade: b.allow_cascade === true,
      userId: null
    })
    const touched = result.tables
      .filter((t) => t.inserted + t.updated + t.deleted > 0)
      .map((t) => t.table)
    const procedures = await deployTouchedProcedures(
      touched,
      procNames(snap.tables.nivaro_managed_procedures)
    ).catch(() => ({ deployed: 0, failed: -1, names: [] as string[] }))
    await moveBaseline(touched, 'After undoing a Nivaro Hub config promotion')
    return { mode, result, procedures }
  } catch (err) {
    rethrow(err)
  }
}
