import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { config } from '../../config.js'
import { db } from '../../db/index.js'
import { isUniqueViolation } from '../../lib/unique-violation.js'
import { NIVARO_VERSION } from '../../version.js'
import { appEnvironment } from '../app-info-environment.js'
import {
  buildConfigSnapshot,
  type ConfigSnapshot,
  hashRow,
  isRedactedColumn,
  redactSnapshot,
  type SnapshotRow
} from '../config-inventory.js'
import { promotableTables } from '../config-promote-groups.js'
import {
  applyGivenSnapshot,
  type GivenWriteContext,
  previewGivenSnapshot,
  RestoreError,
  type RestorePreview,
  type RestoreResult,
  restoreEngineSupported
} from '../config-restore.js'
import type { EnvKeepEntry } from '../env-refresh/registry.js'
import { exportTable } from './config-promote-export.js'
import {
  applyFlowKeeps,
  applyTargetKeeps,
  type HeldRow,
  type KeptNote,
  type Prepared,
  type SetupNote,
  stripKeepSecrets
} from './config-promote-keeps.js'
import {
  DICT_KINDS,
  type Dict,
  DUPLICATE,
  mapToTarget,
  type RefKind,
  type Refusal,
  referencedIds,
  UNUSABLE
} from './config-promote-map.js'
import {
  applyProcs,
  managedWriter,
  type ProcCurrent,
  type ProcDone,
  type ProcPlanItem,
  planProcs,
  procPreviewTable,
  procsRef,
  staleProcs,
  undoProcs
} from './config-promote-procs.js'
import {
  exportStepOptions,
  exportTriggerOptions,
  stripJsonColumn
} from './config-promote-secrets.js'

/**
 * Hub config promotion (idea 30), APP side. The Hub reads a snapshot from the SOURCE app and
 * hands it to the TARGET app, which plans and applies it with the config restore engine
 * (services/config-restore.ts: field diff, plan-hash binding, locked transaction). Nothing here
 * touches the stored restore points, Config download / diff, restore or Changed here — their
 * behaviour is as it was; the promotion path has its own export filter.
 *
 *   source  readPromotionSnapshot   promotable tables through the export filter (secrets, the
 *                                   step outbound part, webhook inbound auth, audit / deploy /
 *                                   history columns off), plus a dictionary naming every id the
 *                                   rows reference (external API names, people's emails, roles,
 *                                   workspaces) — SQL Server only
 *   target  planPromotion           export filter again → natural-key match + reference remap
 *                                   (config-promote-map: ROW_UNMATCHED / REF_UNMAPPED refuse) →
 *                                   this environment's keeps (config-promote-keeps) → field diff
 *           applyPromotion          idempotent by `run_key` (the Hub's promotion): bound to the
 *                                   plan; the record (nivaro_hub_config_applied, status applying,
 *                                   heartbeat) is written in its OWN short write BEFORE any work;
 *                                   the commit marker (nivaro_hub_config_writes: rows written, their
 *                                   values before, hashes after) INSIDE the write's transaction;
 *                                   then deploying (managed procedures through their own writer,
 *                                   one by one, recorded) → applied. The Changed-here baseline moves
 *                                   after the commit, for the written rows only
 *           promotionStatus         what this app knows of a run_key (the Hub's lost answer);
 *                                   `resume` finishes a stalled run's procedures
 *           undoPromotion           puts back exactly the rows that run wrote (scoped to them,
 *                                   STALE when any changed since, never rows created after, only
 *                                   the newest applied run of this environment)
 */

export const APPLIED = 'nivaro_hub_config_applied'
export const HUB_PROMOTE_NOTE = 'Before a Nivaro Hub config promotion'
const PROCS = 'nivaro_managed_procedures'

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

// ── request ─────────────────────────────────────────────────────────────────

export interface PromoteRequest {
  snapshot: ConfigSnapshot
  refs: Dict
  stripped: Record<string, Record<string, string[]>>
  tables: string[]
  deletes: boolean
  allow_cascade: boolean
  run_key: string
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
const RUN_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/

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

function parseDict(v: unknown): Dict {
  const out: Dict = {}
  if (!v || typeof v !== 'object') return out
  for (const k of DICT_KINDS) {
    const m = (v as Record<string, unknown>)[k]
    if (!m || typeof m !== 'object') continue
    const o: Record<string, string> = {}
    for (const [id, name] of Object.entries(m as Record<string, unknown>))
      if (typeof name === 'string') o[id.slice(0, 64)] = name.slice(0, 320)
    out[k] = o
  }
  return out
}

export function runKeyOf(v: unknown): string {
  if (typeof v !== 'string' || !RUN_KEY_RE.test(v))
    throw new PromoteError(400, 'BAD_RUN_KEY', 'run_key must be the promotion’s key')
  return v
}

export function parsePromoteRequest(body: unknown): PromoteRequest {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const snap = b.snapshot as ConfigSnapshot | undefined
  if (!snap || typeof snap !== 'object' || snap.format !== 1 || !snap.tables)
    throw new PromoteError(400, 'BAD_SNAPSHOT', 'Body must carry a format-1 config snapshot')
  if (typeof snap.tables !== 'object' || Array.isArray(snap.tables))
    throw new PromoteError(400, 'BAD_SNAPSHOT', 'The snapshot has no tables')
  const id = Number(b.promotion_id)
  const stripped: PromoteRequest['stripped'] = {}
  if (b.stripped && typeof b.stripped === 'object')
    for (const [t, m] of Object.entries(b.stripped as Record<string, unknown>))
      if (m && typeof m === 'object') {
        const o: Record<string, string[]> = {}
        for (const [k, v] of Object.entries(m as Record<string, unknown>))
          if (Array.isArray(v))
            o[k] = v.filter((x): x is string => typeof x === 'string').slice(0, 50)
        stripped[t] = o
      }
  return {
    snapshot: snap,
    refs: parseDict(b.refs),
    stripped,
    tables: parseTables(b.tables),
    deletes: b.deletes === true,
    allow_cascade: b.allow_cascade === true,
    run_key: runKeyOf(b.run_key),
    source_label: label(b.source_label, 80) || 'another environment',
    promotion_id: Number.isSafeInteger(id) && id > 0 ? id : null,
    actor: label(b.actor, 120) || null
  }
}

function needEngine() {
  if (!restoreEngineSupported())
    throw new PromoteError(
      501,
      'NOT_SUPPORTED_ON_DATABASE',
      'Config promotion needs a SQL Server database on both environments.'
    )
}

async function keeps(): Promise<EnvKeepEntry[]> {
  const { allKeeps } = await import('../env-refresh/registry.js')
  return allKeeps()
}

function rethrow(err: unknown): never {
  if (err instanceof RestoreError)
    throw new PromoteError(err.status, err.code, err.message, err.extra)
  throw err
}

/** Yield to the event loop between tables (a large body is worked through in steps). */
const breathe = () => new Promise<void>((r) => setImmediate(r))

// ── dictionaries ────────────────────────────────────────────────────────────

const DICT_SQL: Record<
  Exclude<RefKind, 'flow' | 'flow_op'>,
  { table: string; name: string; id: string }
> = {
  external_api: { table: 'nivaro_external_apis', name: 'name', id: 'id' },
  user: { table: 'nivaro_users', name: 'email', id: 'id' },
  role: { table: 'nivaro_roles', name: 'name', id: 'id' },
  workspace: { table: 'nivaro_workspaces', name: 'name', id: 'id' }
}

/** Source: the names of the ids its rows reference. */
async function sourceDict(tables: ConfigSnapshot['tables']): Promise<Dict> {
  const out: Dict = {}
  for (const [kind, ids] of referencedIds(tables)) {
    const q = DICT_SQL[kind as keyof typeof DICT_SQL]
    if (!q || !ids.size) continue
    const list = [...ids].slice(0, 2000)
    const rows = (await db(q.table)
      .whereIn(q.id, list)
      .select(`${q.id} as id`, `${q.name} as name`)) as Array<{ id: unknown; name: unknown }>
    const m: Record<string, string> = {}
    for (const r of rows) if (typeof r.name === 'string') m[String(r.id)] = r.name
    out[kind] = m
  }
  return out
}

export interface DictRow {
  id: unknown
  name: unknown
  status?: unknown
  account_kind?: unknown
  is_redacted?: unknown
}

/**
 * Pure: one kind of the target dictionary (lower-case name → id). Two rows with one name answer
 * DUPLICATE (never a guess); a person who is not active, is redacted or is a machine / placeholder
 * account answers UNUSABLE (a step never runs as, or notifies, such an account).
 */
export function targetDictOf(kind: RefKind, rows: DictRow[]): Record<string, string> {
  const m: Record<string, string> = {}
  for (const r of rows) {
    if (typeof r.name !== 'string' || !r.name.trim()) continue
    const n = r.name.trim().toLowerCase()
    const usable =
      kind !== 'user' ||
      (String(r.status ?? '') === 'active' &&
        !(r.is_redacted === true || Number(r.is_redacted) === 1) &&
        (r.account_kind == null || r.account_kind === ''))
    m[n] = n in m ? DUPLICATE : usable ? String(r.id) : UNUSABLE
  }
  return m
}

/** Target: lower-case name → id, for the names the source sent. */
async function targetDict(src: Dict): Promise<Dict> {
  const out: Dict = {}
  for (const kind of DICT_KINDS) {
    const q = DICT_SQL[kind as keyof typeof DICT_SQL]
    const names = [...new Set(Object.values(src[kind] ?? {}))]
    if (!q || !names.length) continue
    const cols = [`${q.id} as id`, `${q.name} as name`]
    if (kind === 'user') cols.push('status', 'account_kind', 'is_redacted')
    const rows = (await db(q.table).whereIn(q.name, names.slice(0, 2000)).select(cols)) as DictRow[]
    out[kind] = targetDictOf(kind, rows)
  }
  return out
}

// ── flow steps the source no longer has, likely renames ─────────────────────

export interface OrphanStep {
  key: string
  flow: string
  label: string | null
}

const stepName = (d: Record<string, unknown>): string | null => {
  for (const k of ['key', 'name']) {
    const v = d[k]
    if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase()
  }
  return null
}
const nameOf = (d: Record<string, unknown> | undefined): string | null =>
  typeof d?.name === 'string' && d.name.trim() ? d.name.slice(0, 120) : null

/**
 * Pure: the target's steps of a PROMOTED flow that the source no longer has. They are removed
 * with the promotion whatever the removal setting (a step left behind would run in a flow it no
 * longer belongs to); the applied record keeps them, so an undo puts them back.
 */
export function orphanSteps(
  mapped: ConfigSnapshot['tables'],
  live: ConfigSnapshot['tables']
): OrphanStep[] {
  const flows = new Set(Object.keys(mapped.nivaro_flows ?? {}))
  const steps = mapped.nivaro_flow_operations
  if (!steps || !flows.size) return []
  const out: OrphanStep[] = []
  for (const [key, row] of Object.entries(live.nivaro_flow_operations ?? {})) {
    const flow = String(row.data.flow ?? '')
    if (!flows.has(flow) || steps[key]) continue
    out.push({ key, flow, label: nameOf(row.data) ?? stepName(row.data) })
  }
  return out
}

export interface PlanFlag {
  code: 'RENAME_SUSPECTED'
  table: string
  key: string
  label: string | null
  reason: string
}

/**
 * Pure: a flow new on the target whose steps are exactly those of a target flow the source did
 * not send — most likely the same flow under a new name. Flagged so a person sees it BEFORE any
 * removal (with removals on, the old one would be deleted and the new one created).
 */
export function renameSuspects(
  mapped: ConfigSnapshot['tables'],
  live: ConfigSnapshot['tables'],
  inserted: Set<string> | undefined
): PlanFlag[] {
  if (!inserted?.size) return []
  const stepsOf = (tables: ConfigSnapshot['tables'], flow: string) =>
    Object.values(tables.nivaro_flow_operations ?? {})
      .filter((r) => String(r.data.flow ?? '') === flow)
      .map((r) => stepName(r.data) ?? '')
      .sort()
      .join('\u0001')
  const promoted = new Set(Object.keys(mapped.nivaro_flows ?? {}))
  const others = Object.entries(live.nivaro_flows ?? {})
    .filter(([id]) => !promoted.has(id))
    .map(([id, r]) => ({ id, name: nameOf(r.data), steps: stepsOf(live, id) }))
    .filter((o) => o.steps)
  const out: PlanFlag[] = []
  for (const id of inserted) {
    const row = mapped.nivaro_flows?.[id]
    if (!row) continue
    const steps = stepsOf(mapped, id)
    if (!steps) continue
    const twin = others.find((o) => o.steps === steps)
    if (twin)
      out.push({
        code: 'RENAME_SUSPECTED',
        table: 'nivaro_flows',
        key: id,
        label: nameOf(row.data),
        reason: `Same steps as “${twin.name ?? twin.id}” on the target, under a new name. Promoting creates a second flow beside it; rename “${twin.name ?? twin.id}” on the target first to keep one.`
      })
  }
  return out
}

// ── source ──────────────────────────────────────────────────────────────────

export interface PromotionSnapshotAnswer {
  version: string
  environment: string
  snapshot: ConfigSnapshot
  refs: Dict
  stripped: Record<string, Record<string, string[]>>
}

/** Pure: the export filter over a snapshot (every promotable table), after the keep secrets. */
export function exportSnapshot(snap: ConfigSnapshot): {
  snapshot: ConfigSnapshot
  stripped: Record<string, Record<string, string[]>>
} {
  const tables: ConfigSnapshot['tables'] = {}
  const stripped: Record<string, Record<string, string[]>> = {}
  for (const [t, rows] of Object.entries(snap.tables)) {
    const e = exportTable(t, rows)
    tables[t] = e.rows
    if (Object.keys(e.stripped).length) stripped[t] = e.stripped
  }
  return { snapshot: { ...snap, tables }, stripped }
}

export async function readPromotionSnapshot(tablesRaw: unknown): Promise<PromotionSnapshotAnswer> {
  needEngine()
  const tables = parseTables(tablesRaw)
  const snap = await buildConfigSnapshot({
    tables,
    version: NIVARO_VERSION,
    environment: config.NODE_ENV,
    concurrency: 4
  })
  const reg = await keeps()
  const stripped0 = stripKeepSecrets(redactSnapshot(snap), reg, {
    strict: true,
    redacted: isRedactedColumn
  })
  const out = exportSnapshot(stripped0)
  return {
    version: NIVARO_VERSION,
    environment: appEnvironment(),
    snapshot: { ...out.snapshot, instance: { ...out.snapshot.instance, database: '' } },
    refs: await sourceDict(out.snapshot.tables),
    stripped: out.stripped
  }
}

// ── target: prepare ─────────────────────────────────────────────────────────

interface Ready {
  prepared: Prepared
  engineSnap: ConfigSnapshot
  live: ConfigSnapshot['tables']
  ref: string
  procs: ProcPlanItem[]
  warnings: string[]
  missing: string[]
  /** Rows removed whatever the removal setting (steps of a promoted flow the source dropped). */
  alsoDelete: Record<string, string[]> | null
  orphans: OrphanStep[]
  flags: PlanFlag[]
  /** Per step: the outbound / secret paths the source took off (they stay as set here). */
  stripped_steps: Array<{ key: string; label: string | null; paths: string[] }>
}

function refusalError(
  list: Array<
    Refusal | { code: string; table: string; key: string; label: string | null; reason: string }
  >
): PromoteError {
  const first = list[0]
  return new PromoteError(
    409,
    first.code,
    `${list.length} row${list.length === 1 ? '' : 's'} cannot be promoted: ${first.reason}${first.label ? ` (${first.label})` : ''}`,
    { items: list.slice(0, 200) }
  )
}

async function readProcs(): Promise<{ current: ProcCurrent[]; importOwned: Set<string> }> {
  const { listManagedProcedures } = await import('../managed-procedures/store.js')
  const { appManagedProcedures } = await import('../managed-procedures/owners.js')
  const rows = await listManagedProcedures()
  const owners = (await appManagedProcedures().catch(() => [])) as Array<{
    kind: string
    name: string
  }>
  return {
    current: rows.map((r) => ({
      name: r.name,
      body: r.body,
      body_hash: r.body_hash,
      version: r.version,
      description: r.description,
      dropped: r.dropped_at != null
    })),
    importOwned: new Set(owners.filter((o) => o.kind === 'import').map((o) => o.name.toLowerCase()))
  }
}

async function prepare(req: PromoteRequest): Promise<Ready> {
  needEngine()
  // The export filter again, whatever the source sent: secrets, outbound parts and inbound auth
  // never reach the diff or the write from the snapshot.
  const reg = await keeps()
  const scoped: ConfigSnapshot['tables'] = {}
  const missing: string[] = []
  const theirs = redactSnapshot(req.snapshot)
  for (const t of req.tables) {
    if (theirs.tables[t]) scoped[t] = theirs.tables[t]
    else missing.push(t)
  }
  const filtered = exportSnapshot(stripKeepSecrets({ ...theirs, tables: scoped }, reg))
  await breathe()
  const engineTables = Object.keys(filtered.snapshot.tables).filter((t) => t !== PROCS)
  const liveSnap = engineTables.length
    ? await buildConfigSnapshot({
        tables: engineTables,
        version: NIVARO_VERSION,
        environment: config.NODE_ENV,
        concurrency: 4
      })
    : null
  const live = liveSnap?.tables ?? {}
  await breathe()
  const engineSource: ConfigSnapshot['tables'] = {}
  for (const t of engineTables) engineSource[t] = filtered.snapshot.tables[t]
  const mapped = mapToTarget({
    source: engineSource,
    target: live,
    sourceDict: req.refs,
    targetDict: await targetDict(req.refs),
    runKey: req.run_key
  })
  // Steps the source stripped an outbound part from, by the TARGET's step id.
  const stepIds = mapped.ids.nivaro_flow_operations ?? new Map<string, string>()
  const stripped: Record<string, string[]> = {}
  for (const [srcId, keysOff] of Object.entries(req.stripped.nivaro_flow_operations ?? {})) {
    const id = stepIds.get(srcId)
    if (id) stripped[id] = keysOff
  }
  let procs: ProcPlanItem[] = []
  const refusals: Array<
    Refusal | { code: string; table: string; key: string; label: string | null; reason: string }
  > = [...mapped.refusals]
  if (filtered.snapshot.tables[PROCS]) {
    const { current, importOwned } = await readProcs()
    const p = planProcs(filtered.snapshot.tables[PROCS], current, importOwned, req.deletes)
    procs = p.items
    refusals.push(...p.refusals)
  }
  if (refusals.length) throw refusalError(refusals)
  await breathe()
  const kept = applyTargetKeeps(mapped.tables, reg, live)
  const prepared = applyFlowKeeps(kept, live, stripped, {
    sessionSecret: String(config.SESSION_SECRET ?? ''),
    runKey: req.run_key
  })
  const warnings: string[] = []
  const v = String(theirs.instance?.version ?? '')
  if (v && v !== NIVARO_VERSION)
    warnings.push(
      `The source runs Nivaro ${v.slice(0, 40)}; this environment runs ${NIVARO_VERSION}. Columns only one side has are left as they are.`
    )
  const engineSnap: ConfigSnapshot = { ...theirs, tables: prepared.tables }
  const orphans = orphanSteps(mapped.tables, live)
  const alsoDelete = orphans.length ? { nivaro_flow_operations: orphans.map((o) => o.key) } : null
  const flags = renameSuspects(mapped.tables, live, mapped.inserted.nivaro_flows)
  const stripped_steps = Object.entries(stripped).map(([key, paths]) => ({
    key,
    label:
      nameOf(prepared.tables.nivaro_flow_operations?.[key]?.data) ??
      nameOf(live.nivaro_flow_operations?.[key]?.data),
    paths: paths.slice(0, 50)
  }))
  const ref = `hub:${req.run_key}:${createHash('sha256')
    .update(
      JSON.stringify([
        Object.keys(prepared.tables)
          .sort()
          .map((t) => [
            t,
            Object.entries(prepared.tables[t])
              .map(([k, r]) => `${k}:${r.hash}`)
              .sort()
          ]),
        req.deletes,
        alsoDelete
      ])
    )
    .digest('hex')}`
  return {
    prepared,
    engineSnap,
    live,
    ref,
    procs,
    warnings,
    missing,
    alsoDelete,
    orphans,
    flags,
    stripped_steps
  }
}

async function prodOnlyCheck(
  tables: ConfigSnapshot['tables'],
  deletes: boolean,
  keys?: string[] | null
) {
  const { checkOverwrite, driftTrackingHere } = await import('../config-drift/store.js')
  if (!(await driftTrackingHere())) return null
  return checkOverwrite(tables, { tables: Object.keys(tables), deletes, keys: keys ?? null })
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

// ── plan view masking ───────────────────────────────────────────────────────

const CAP = 300
const capped = (v: unknown): unknown => {
  if (v === null || v === undefined) return null
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > CAP ? `${s.slice(0, CAP)}…` : s
}

/** A value as the plan may show it: never a step's outbound part, inbound auth or a secret. */
export function shownForPlan(table: string, field: string, v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (table === 'nivaro_flow_operations' && field === 'options')
    return capped(exportStepOptions(v).options)
  if (table === 'nivaro_flows' && field === 'trigger_options')
    return capped(exportTriggerOptions(v))
  if (typeof v === 'string' && /^\s*[[{]/.test(v)) return capped(stripJsonColumn(v))
  return capped(v)
}

/** The engine's preview rows re-shown from the full values, masked. */
function maskPreview(
  preview: RestorePreview,
  incoming: ConfigSnapshot['tables'],
  live: ConfigSnapshot['tables']
): RestorePreview {
  return {
    ...preview,
    tables: preview.tables.map((t) => ({
      ...t,
      rows: t.rows.map((r) => ({
        ...r,
        fields: r.fields.map((f) => ({
          field: f.field,
          now:
            r.op === 'insert'
              ? null
              : shownForPlan(t.table, f.field, live[t.table]?.[r.key]?.data[f.field]),
          was:
            r.op === 'delete'
              ? null
              : shownForPlan(t.table, f.field, incoming[t.table]?.[r.key]?.data[f.field])
        }))
      }))
    }))
  }
}

const combine = (engineHash: string, procHash: string) =>
  createHash('sha256').update(`${engineHash}:${procHash}`).digest('hex')

// ── target: plan ────────────────────────────────────────────────────────────

export interface PromotionPlanAnswer {
  version: string
  environment: string
  preview: RestorePreview
  engine_hash: string
  procs_hash: string
  refused: Array<{ table: string; reason: string }>
  kept: KeptNote[]
  held: HeldRow[]
  switched_off: Prepared['switched_off']
  needs_setup: SetupNote[]
  /** Steps of a promoted flow the source no longer has: removed with it (undo puts them back). */
  orphans: OrphanStep[]
  /** Listed before removals: likely renames (RENAME_SUSPECTED). */
  flags: PlanFlag[]
  stripped_steps: Array<{ key: string; label: string | null; paths: string[] }>
  prod_only_changes: unknown[]
  prod_only_lines: string[]
  prod_only_refuse: boolean
  warnings: string[]
}

function missingRefused(missing: string[]) {
  return missing.map((table) => ({
    table,
    reason: 'The source did not send this table (an older version, or it could not be read)'
  }))
}

export async function planPromotion(body: unknown): Promise<PromotionPlanAnswer> {
  const req = parsePromoteRequest(body)
  const r = await prepare(req)
  let preview: RestorePreview
  try {
    preview = await previewGivenSnapshot(r.engineSnap, {
      ref: r.ref,
      deletes: req.deletes,
      alsoDelete: r.alsoDelete,
      allowCascade: req.allow_cascade
    })
  } catch (err) {
    rethrow(err)
  }
  const check = await prodOnlyCheck(r.prepared.tables, req.deletes)
  const warnings = [...r.warnings, ...preview.warnings]
  if (r.orphans.length)
    warnings.push(
      `${r.orphans.length} step${r.orphans.length === 1 ? '' : 's'} of a promoted flow ${r.orphans.length === 1 ? 'is' : 'are'} not on the source and will be removed with it (undo puts ${r.orphans.length === 1 ? 'it' : 'them'} back).`
    )
  if (check?.error) warnings.push(`Could not check for changes made here: ${check.error}`)
  const shown = maskPreview(preview, r.prepared.tables, r.live)
  const procHash = procsRef(r.procs)
  if (r.procs.length) {
    const pt = procPreviewTable(r.procs)
    shown.tables = [...shown.tables, pt as unknown as RestorePreview['tables'][number]]
    shown.totals = {
      ...shown.totals,
      inserts: shown.totals.inserts + pt.inserts,
      updates: shown.totals.updates + pt.updates,
      deletes: shown.totals.deletes + pt.deletes,
      tables: shown.totals.tables + 1
    }
  }
  const refused = [...r.prepared.refused, ...missingRefused(r.missing)]
  return {
    version: NIVARO_VERSION,
    environment: appEnvironment(),
    preview: {
      ...shown,
      plan_hash: combine(preview.plan_hash, procHash),
      refused: [...shown.refused, ...refused]
    },
    engine_hash: preview.plan_hash,
    procs_hash: procHash,
    refused,
    kept: r.prepared.kept,
    held: r.prepared.held,
    switched_off: r.prepared.switched_off,
    needs_setup: r.prepared.needs_setup,
    orphans: r.orphans,
    flags: r.flags,
    stripped_steps: r.stripped_steps,
    prod_only_changes: check?.items ?? [],
    prod_only_lines: check?.lines ?? [],
    prod_only_refuse: !!check?.refuse && (check.items?.length ?? 0) > 0,
    warnings
  }
}

// ── the record of a run (nivaro_hub_config_applied + nivaro_hub_config_writes) ──

export const WRITES = 'nivaro_hub_config_writes'
/** How often a running apply / deploy / undo says it is alive. */
export const HEARTBEAT_MS = 10_000
/** A heartbeat older than this = the process that ran it is gone. */
export const STALE_MS = 60_000

export interface UndoRow {
  table: string
  key: string
  op: 'insert' | 'update' | 'delete'
  /** The row before the promotion (update / delete). */
  before: Record<string, unknown> | null
  /** The row's hash after the promotion wrote it (insert / update). */
  after_hash: string | null
}

export type RecordStatus = 'applying' | 'deploying' | 'applied' | 'failed' | 'undoing' | 'undone'

export interface AppliedRecord {
  id: number
  run_key: string
  promotion_id: number | null
  source_label: string
  status: RecordStatus
  heartbeat_at: string | null
  result: PromotionApplyAnswer | null
  procs_plan: ProcPlanItem[]
  procs_done: ProcDone[]
  error: string | null
  applied_at: string | null
  undone_at: string | null
}

const STATUSES: readonly RecordStatus[] = [
  'applying',
  'deploying',
  'applied',
  'failed',
  'undoing',
  'undone'
]

const parse = <T>(v: unknown, fallback: T): T => {
  if (v == null || v === '') return fallback
  if (typeof v !== 'string') return v as T
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}
const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null)
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1000)

async function readRecord(runKey: string): Promise<AppliedRecord | null> {
  if (!(await db.schema.hasTable(APPLIED))) return null
  const r = (await db(APPLIED).where({ run_key: runKey }).first()) as
    | Record<string, unknown>
    | undefined
  if (!r) return null
  const status = STATUSES.includes(r.status as RecordStatus) ? (r.status as RecordStatus) : 'failed'
  return {
    id: Number(r.id),
    run_key: String(r.run_key),
    promotion_id: r.promotion_id == null ? null : Number(r.promotion_id),
    source_label: String(r.source_label ?? 'another environment'),
    status,
    heartbeat_at: iso(r.heartbeat_at),
    result: parse(r.result, null),
    procs_plan: parse(r.procs_plan, []),
    procs_done: parse(r.procs_done, []),
    error: r.error == null ? null : String(r.error),
    applied_at: iso(r.applied_at),
    undone_at: iso(r.undone_at)
  }
}

/**
 * The commit marker: it exists exactly when the apply's write committed. A plain read — while the
 * apply's transaction is still open it waits on that row (never reads "not there" too early).
 */
async function readWrites(runKey: string): Promise<{ rows: UndoRow[]; undone: boolean } | null> {
  const r = (await db(WRITES).where({ run_key: runKey }).first()) as
    | Record<string, unknown>
    | undefined
  if (!r) return null
  return { rows: parse(r.undo_rows, []), undone: r.undone === true || Number(r.undone) === 1 }
}

/** Pure: whether a record's live run is still alive (heartbeat newer than STALE_MS). */
export function heartbeatFresh(heartbeatAt: string | null, now = Date.now()): boolean {
  return !!heartbeatAt && now - new Date(heartbeatAt).getTime() < STALE_MS
}

const setRecord = (runKey: string, patch: Record<string, unknown>, from?: RecordStatus[]) => {
  const q = db(APPLIED).where({ run_key: runKey })
  if (from?.length) q.whereIn('status', from)
  return q.update(patch) as unknown as Promise<number>
}

/** Keeps heartbeat_at fresh while this process works a run; the stop function ends it. */
function startHeartbeat(runKey: string): () => void {
  const timer = setInterval(() => {
    setRecord(runKey, { heartbeat_at: new Date() }, ['applying', 'deploying', 'undoing']).catch(
      () => {}
    )
  }, HEARTBEAT_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Pure: what an apply's transaction records (the rows written: before values, after hashes). */
export function undoRowsOf(ctx: GivenWriteContext): UndoRow[] {
  const out: UndoRow[] = []
  for (const p of ctx.plans)
    for (const o of p.ops)
      out.push({
        table: p.table,
        key: o.key,
        op: o.op,
        before: o.op === 'insert' ? null : (ctx.before[p.table]?.[o.key]?.data ?? null),
        after_hash: o.op === 'delete' ? null : (ctx.after[p.table]?.[o.key]?.hash ?? null)
      })
  return out
}

const totalsOf = (rows: UndoRow[]) => ({
  inserted: rows.filter((r) => r.op === 'insert').length,
  updated: rows.filter((r) => r.op === 'update').length,
  deleted: rows.filter((r) => r.op === 'delete').length
})

/**
 * A stale run settled from what committed: `applying` with the marker → `deploying` (rows are in,
 * procedures may be left); without it → `failed` (nothing was written). `undoing` → `undone` when
 * the undo's write committed, else back to `applied`. Fresh runs are left alone.
 */
async function settle(rec: AppliedRecord): Promise<AppliedRecord> {
  if (heartbeatFresh(rec.heartbeat_at)) return rec
  if (rec.status === 'applying') {
    const w = await readWrites(rec.run_key)
    if (w) await setRecord(rec.run_key, { status: 'deploying' }, ['applying'])
    else
      await setRecord(
        rec.run_key,
        {
          status: 'failed',
          error: 'The apply stopped before its write committed',
          heartbeat_at: null
        },
        ['applying']
      )
    return (await readRecord(rec.run_key)) ?? rec
  }
  if (rec.status === 'undoing') {
    const w = await readWrites(rec.run_key)
    await setRecord(
      rec.run_key,
      w?.undone
        ? { status: 'undone', undone_at: new Date(), heartbeat_at: null }
        : { status: 'applied', heartbeat_at: null },
      ['undoing']
    )
    return (await readRecord(rec.run_key)) ?? rec
  }
  return rec
}

/** Pure: the Changed-here baseline after a write — the old baseline with ONLY the written rows
 *  replaced (insert / update = the row as written, delete = gone). Other rows keep the baseline. */
export function baselineAfter(
  old: ConfigSnapshot['tables'],
  ctx: GivenWriteContext
): ConfigSnapshot['tables'] {
  const out: ConfigSnapshot['tables'] = { ...old }
  for (const p of ctx.plans) {
    if (!p.ops.length) continue
    const t = { ...(out[p.table] ?? {}) }
    for (const o of p.ops) {
      if (o.op === 'delete') delete t[o.key]
      else {
        const row = ctx.after[p.table]?.[o.key]
        if (row) t[o.key] = row
      }
    }
    out[p.table] = t
  }
  return out
}

/**
 * Changed here: the rows the write touched join the promotion baseline, as a record of its own
 * kind (`hub-baseline`, never a restore point). Runs AFTER the commit (afterCommit hook), never
 * inside the write. A failure is logged and answered ('not moved: …'), never swallowed.
 */
async function moveBaseline(k: Knex, ctx: GivenWriteContext, note: string): Promise<string> {
  try {
    const drift = await import('../config-drift/store.js')
    const settings = await drift.getDriftSettings()
    if (!drift.driftActive(settings)) return 'unchanged (Changed here is off)'
    const base = await drift.resolveBaseline(settings)
    if (!base) return 'unchanged (no baseline yet)'
    if (base.pinned) return 'unchanged (the baseline is pinned)'
    const snaps = await import('../config-snapshots.js')
    const old = await snaps.loadConfigSnapshot(base.snapshot_id)
    if (!old) return 'unchanged (no baseline yet)'
    const composite: ConfigSnapshot = {
      ...old,
      generated_at: new Date().toISOString(),
      restore_point: undefined,
      tables: baselineAfter(old.tables, ctx)
    }
    await snaps.storeConfigSnapshot(composite, 'hub-baseline', { note }, k)
    return 'moved'
  } catch (err) {
    const msg = errText(err).slice(0, 300)
    console.warn(`[hub-config] Changed-here baseline not moved: ${msg}`)
    return `not moved: ${msg}`
  }
}

// ── target: apply ───────────────────────────────────────────────────────────

export interface PromotionApplyAnswer {
  run_key: string
  /** True when this run_key was applied before (the answer is the recorded one). */
  replayed: boolean
  /** True when this call finished a run another call started (its procedures). */
  resumed?: boolean
  result: Pick<RestoreResult, 'tables' | 'totals' | 'pre_restore_id'>
  procedures: ProcDone[]
  needs_setup: SetupNote[]
  baseline: string
}

const EMPTY_RESULT: PromotionApplyAnswer['result'] = {
  tables: [],
  totals: { inserted: 0, updated: 0, deleted: 0 },
  pre_restore_id: null
}

function replayOf(rec: AppliedRecord): PromotionApplyAnswer {
  const res = rec.result
  return {
    run_key: rec.run_key,
    replayed: true,
    result: res?.result ?? EMPTY_RESULT,
    procedures: res?.procedures ?? rec.procs_done,
    needs_setup: res?.needs_setup ?? [],
    baseline: res?.baseline ?? 'unchanged'
  }
}

const running = () =>
  new PromoteError(
    409,
    'APPLY_RUNNING',
    'This promotion is being applied here right now — wait for it to finish.'
  )

type Claim =
  | { kind: 'fresh' }
  | { kind: 'replay'; rec: AppliedRecord }
  | { kind: 'resume'; rec: AppliedRecord }

/**
 * The record first, in its OWN short write, before any work: a status read can always tell a run
 * that started from one that never arrived. A resend of the run key replays a finished run,
 * resumes one whose rows committed but whose procedures were left, or re-runs one that failed
 * before writing anything. A run still alive answers APPLY_RUNNING.
 */
async function claim(req: PromoteRequest): Promise<Claim> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let rec = await readRecord(req.run_key)
    if (!rec) {
      try {
        await db(APPLIED).insert({
          run_key: req.run_key,
          promotion_id: req.promotion_id,
          source_label: req.source_label.slice(0, 200),
          status: 'applying',
          heartbeat_at: new Date(),
          applied_at: null
        })
        return { kind: 'fresh' }
      } catch (err) {
        if (isUniqueViolation(err)) continue
        throw err
      }
    }
    if (rec.status === 'applied' || rec.status === 'undone' || rec.status === 'undoing')
      return { kind: 'replay', rec }
    if (rec.status === 'applying' || rec.status === 'deploying') {
      if (heartbeatFresh(rec.heartbeat_at)) throw running()
      rec = await settle(rec)
      if (rec.status === 'deploying') {
        const took = await setRecord(req.run_key, { heartbeat_at: new Date() }, ['deploying'])
        if (took === 1) return { kind: 'resume', rec }
        continue
      }
    }
    if (rec.status === 'failed') {
      const took = await setRecord(
        req.run_key,
        { status: 'applying', heartbeat_at: new Date(), error: null },
        ['failed']
      )
      if (took === 1) return { kind: 'fresh' }
    }
  }
  throw running()
}

/** Deploys the procedures left in a run, recording each one as it lands. */
async function deployProcs(
  runKey: string,
  remaining: ProcPlanItem[],
  done: ProcDone[],
  note: string
): Promise<ProcDone[]> {
  if (!remaining.length) return done
  const writer = managedWriter('Nivaro Hub config promotion')
  const more = await applyProcs(remaining, writer, note, async (now) => {
    await setRecord(runKey, { procs_done: JSON.stringify([...done, ...now]) })
  })
  return [...done, ...more]
}

/** Finishes a run whose rows committed: the procedures left, then `applied`. */
async function finishRun(rec: AppliedRecord, resumed: boolean): Promise<PromotionApplyAnswer> {
  const stop = startHeartbeat(rec.run_key)
  try {
    const tag = rec.promotion_id ? ` #${rec.promotion_id}` : ''
    const done = rec.procs_done
    const remaining = rec.procs_plan.filter((p) => !done.some((d) => d.name === p.name))
    const procedures = await deployProcs(
      rec.run_key,
      remaining,
      done,
      `Nivaro Hub config promotion${tag} from ${rec.source_label}`
    )
    let partial = rec.result
    if (!partial) {
      const w = await readWrites(rec.run_key)
      partial = {
        run_key: rec.run_key,
        replayed: false,
        result: { ...EMPTY_RESULT, totals: totalsOf(w?.rows ?? []) },
        procedures: [],
        needs_setup: [],
        baseline: 'unknown (the run was resumed)'
      }
    }
    const answer: PromotionApplyAnswer = {
      ...partial,
      run_key: rec.run_key,
      replayed: false,
      ...(resumed ? { resumed: true } : {}),
      procedures
    }
    await setRecord(rec.run_key, {
      status: 'applied',
      result: JSON.stringify(answer),
      procs_done: JSON.stringify(procedures),
      heartbeat_at: null,
      applied_at: new Date()
    })
    return answer
  } finally {
    stop()
  }
}

export async function applyPromotion(body: unknown): Promise<PromotionApplyAnswer> {
  const req = parsePromoteRequest(body)
  const b = (body ?? {}) as Record<string, unknown>
  const hash = String(b.plan_hash ?? '')
  const engineHash = String(b.engine_hash ?? '')
  const procHashIn = String(b.procs_hash ?? '')
  if (
    ![hash, engineHash, procHashIn].every((h) => /^[0-9a-f]{64}$/.test(h)) ||
    combine(engineHash, procHashIn) !== hash
  )
    throw new PromoteError(
      400,
      'PLAN_HASH_REQUIRED',
      'plan_hash, engine_hash and procs_hash from the plan are required'
    )
  needEngine()
  const c = await claim(req)
  if (c.kind === 'replay') return replayOf(c.rec)
  if (c.kind === 'resume') return finishRun(c.rec, true)
  const stop = startHeartbeat(req.run_key)
  try {
    const r = await prepare(req)
    if (procsRef(r.procs) !== procHashIn)
      throw new PromoteError(
        409,
        'STALE',
        'Managed procedures changed since the plan — plan again.'
      )
    const refusal = prodOnlyRefusal(
      await prodOnlyCheck(r.prepared.tables, req.deletes),
      b.overwrite_prod_changes
    )
    if (refusal) throw refusal
    await setRecord(req.run_key, { procs_plan: JSON.stringify(r.procs) })
    const tag = req.promotion_id ? ` #${req.promotion_id}` : ''
    const who = req.actor ? ` by ${req.actor}` : ''
    let result: RestoreResult
    try {
      result = await applyGivenSnapshot(r.engineSnap, {
        ref: r.ref,
        deletes: req.deletes,
        alsoDelete: r.alsoDelete,
        planHash: engineHash,
        allowCascade: req.allow_cascade,
        userId: null,
        note: `${HUB_PROMOTE_NOTE}${tag} from ${req.source_label}${who}`,
        activityNote: `Nivaro Hub config promotion${tag} from ${req.source_label}${who}`,
        // The commit marker, in the write's own transaction: it exists exactly when the rows do.
        inTransaction: async (trx, ctx) => {
          await trx(WRITES).insert({
            run_key: req.run_key,
            undo_rows: JSON.stringify(undoRowsOf(ctx)),
            undone: false,
            written_at: new Date()
          })
          return true
        },
        afterCommit: (k, ctx) =>
          moveBaseline(k, ctx, `After a Nivaro Hub config promotion${tag} from ${req.source_label}`)
      })
    } catch (err) {
      rethrow(err)
    }
    // No engine write (only procedures, or nothing at all): the marker is written on its own,
    // before any procedure.
    if (result.extra !== true)
      await db(WRITES).insert({
        run_key: req.run_key,
        undo_rows: '[]',
        undone: false,
        written_at: new Date()
      })
    const partial: PromotionApplyAnswer = {
      run_key: req.run_key,
      replayed: false,
      result: {
        tables: result.tables,
        totals: result.totals,
        pre_restore_id: result.pre_restore_id
      },
      procedures: [],
      needs_setup: r.prepared.needs_setup,
      baseline:
        typeof result.after_commit === 'string'
          ? result.after_commit
          : result.extra === true
            ? `not moved: ${errText((result.after_commit as { error?: unknown } | undefined)?.error ?? 'unknown')}`
            : 'unchanged'
    }
    await setRecord(req.run_key, { status: 'deploying', result: JSON.stringify(partial) }, [
      'applying'
    ])
    stop()
    const rec = await readRecord(req.run_key)
    if (!rec) throw new PromoteError(500, 'RECORD_LOST', 'The record of this promotion is gone')
    return await finishRun(rec, false)
  } catch (err) {
    // Nothing committed (no marker) = failed, and a resend may run it again. With the marker the
    // rows are in: the record goes on to `deploying` and a resend / status check resumes it.
    const marker = await readWrites(req.run_key).catch(() => undefined)
    if (marker === null)
      await setRecord(req.run_key, { status: 'failed', error: errText(err), heartbeat_at: null }, [
        'applying'
      ]).catch(() => {})
    else if (marker)
      await setRecord(req.run_key, { status: 'deploying' }, ['applying']).catch(() => {})
    throw err
  } finally {
    stop()
  }
}

// ── target: status (the Hub's lost answer) ──────────────────────────────────

export interface PromotionStatusAnswer {
  state: RecordStatus | 'not_applied'
  /** A process here is working this run right now (its heartbeat is fresh). */
  running: boolean
  /** Rows committed, procedures left, and nothing is working on them (a resend resumes). */
  stalled: boolean
  answer: PromotionApplyAnswer | null
  error: string | null
  newest: boolean
}

/**
 * What this app knows of a run key. `not_applied` = no record at all: the apply never reached
 * this app (the record is written before any work, so a run in flight always has one). With
 * `resume: true` a stalled run (rows in, procedures left) is finished here and then answered.
 */
export async function promotionStatus(body: unknown): Promise<PromotionStatusAnswer> {
  const b = (body ?? {}) as { run_key?: unknown; resume?: unknown }
  const runKey = runKeyOf(b.run_key)
  let rec = await readRecord(runKey)
  if (!rec)
    return {
      state: 'not_applied',
      running: false,
      stalled: false,
      answer: null,
      error: null,
      newest: false
    }
  rec = await settle(rec)
  const fresh = heartbeatFresh(rec.heartbeat_at)
  if (rec.status === 'deploying' && !fresh && b.resume === true) {
    const took = await setRecord(runKey, { heartbeat_at: new Date() }, ['deploying'])
    if (took === 1) {
      await finishRun(rec, true)
      rec = (await readRecord(runKey)) ?? rec
    }
  }
  const live = ['applying', 'deploying', 'undoing'].includes(rec.status)
  return {
    state: rec.status,
    running: live && heartbeatFresh(rec.heartbeat_at),
    stalled: rec.status === 'deploying' && !heartbeatFresh(rec.heartbeat_at),
    answer: rec.status === 'applied' || rec.status === 'undone' ? replayOf(rec) : null,
    error: rec.error,
    newest: await isNewest(rec)
  }
}

/** Only the newest run of this environment may be undone: nothing applied, being applied or
 *  deploying after it. */
async function isNewest(rec: AppliedRecord): Promise<boolean> {
  if (rec.status !== 'applied') return false
  const top = (await db(APPLIED)
    .whereIn('status', ['applied', 'applying', 'deploying', 'undoing'])
    .max('id as id')
    .first()) as { id: unknown } | undefined
  return Number(top?.id) === rec.id
}

// ── target: undo ────────────────────────────────────────────────────────────

export interface PromotionUndoAnswer {
  mode: 'preview' | 'apply'
  preview?: RestorePreview
  engine_hash?: string
  procs_hash?: string
  prod_only_changes?: unknown[]
  prod_only_lines?: string[]
  prod_only_refuse?: boolean
  result?: Pick<RestoreResult, 'tables' | 'totals'>
  procedures?: ProcDone[]
  baseline?: string
}

/** Pure: the snapshot + scope an undo restores (the rows before, only the rows the run wrote). */
export function undoTarget(rows: UndoRow[]): {
  tables: ConfigSnapshot['tables']
  keys: Record<string, string[]>
} {
  const tables: ConfigSnapshot['tables'] = {}
  const keys: Record<string, string[]> = {}
  for (const r of rows) {
    tables[r.table] = tables[r.table] ?? {}
    keys[r.table] = [...(keys[r.table] ?? []), r.key]
    if (r.op !== 'insert' && r.before)
      tables[r.table][r.key] = { hash: hashRow(r.before), data: r.before }
  }
  return { tables, keys }
}

/** Pure: the rows that changed since the run wrote them (undo answers STALE naming them). */
export function staleRows(rows: UndoRow[], live: ConfigSnapshot['tables']): UndoRow[] {
  return rows.filter((r) => {
    const now = live[r.table]?.[r.key]
    if (r.op === 'delete') return !!now
    return !now || now.hash !== r.after_hash
  })
}

const NONE_HASH = createHash('sha256').update('none').digest('hex')

function emptyPreview(hash: string): RestorePreview {
  return {
    snapshot_id: 0,
    snapshot: { taken_at: '', version: '', environment: '', database: '', restore_point: null },
    plan_hash: hash,
    tables: [],
    refused: [],
    totals: { inserts: 0, updates: 0, deletes: 0, tables: 0, skipped_inactive_user: 0 },
    cascade: [],
    allow_cascade: false,
    warnings: [],
    over_cap: false,
    cap: 0
  } as RestorePreview
}

export async function undoPromotion(body: unknown): Promise<PromotionUndoAnswer> {
  needEngine()
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const mode = b.mode === 'apply' ? 'apply' : b.mode === 'preview' ? 'preview' : null
  if (!mode) throw new PromoteError(400, 'BAD_MODE', "mode must be 'preview' or 'apply'")
  const found = await readRecord(runKeyOf(b.run_key))
  if (!found)
    throw new PromoteError(
      404,
      'NOT_A_PROMOTION',
      'This environment has no record of that promotion'
    )
  const rec = await settle(found)
  if (rec.status === 'undone' || rec.status === 'undoing')
    throw new PromoteError(409, 'NOT_UNDOABLE', 'That promotion was undone already')
  if (rec.status !== 'applied')
    throw new PromoteError(
      409,
      'NOT_UNDOABLE',
      rec.status === 'failed'
        ? 'That promotion wrote nothing here — there is nothing to undo'
        : 'That promotion is still being applied here'
    )
  if (!(await isNewest(rec)))
    throw new PromoteError(
      409,
      'NOT_NEWEST',
      'A newer promotion was applied here since; only the newest one can be undone'
    )
  const writes = await readWrites(rec.run_key)
  const rows = writes?.rows ?? []
  const touched = [...new Set(rows.map((r) => r.table))]
  const live = touched.length
    ? (
        await buildConfigSnapshot({
          tables: touched,
          version: NIVARO_VERSION,
          environment: config.NODE_ENV
        })
      ).tables
    : {}
  const stale = staleRows(rows, live)
  const writer = managedWriter('Nivaro Hub config promotion undo')
  const staleP = await staleProcs(rec.procs_done, writer)
  if (stale.length || staleP.length)
    throw new PromoteError(
      409,
      'STALE',
      'Rows this promotion wrote have changed since — the undo would overwrite those changes. Change them back by hand.',
      {
        items: [
          ...stale.slice(0, 100).map((r) => ({
            code: 'STALE',
            table: r.table,
            key: r.key,
            label: null,
            reason: 'changed since the promotion'
          })),
          ...staleP.map((n) => ({
            code: 'STALE',
            table: PROCS,
            key: n,
            label: n,
            reason: 'changed since the promotion'
          }))
        ]
      }
    )
  const target = undoTarget(rows)
  const snap: ConfigSnapshot = {
    format: 1,
    generated_at: new Date().toISOString(),
    instance: { version: NIVARO_VERSION, environment: config.NODE_ENV, database: '' },
    classification: { config: [], derived: [], runtime: [], unclassified: [], absent: [] },
    tables: target.tables,
    errors: {}
  }
  for (const t of touched) snap.tables[t] = snap.tables[t] ?? {}
  const ref = `undo:${rec.run_key}`
  const procItems = rec.procs_done.filter((p) => p.ok)
  const procHash = createHash('sha256')
    .update(JSON.stringify(procItems.map((p) => [p.name, p.after_version])))
    .digest('hex')
  const check = await prodOnlyCheck(
    target.tables,
    true,
    rows.map((r) => r.key)
  )
  if (mode === 'preview') {
    let preview: RestorePreview | null = null
    let engineHash = NONE_HASH
    if (touched.length) {
      try {
        preview = await previewGivenSnapshot(snap, { ref, deletes: true, keys: target.keys })
      } catch (err) {
        rethrow(err)
      }
      engineHash = preview.plan_hash
    }
    const shown = preview ? maskPreview(preview, target.tables, live) : emptyPreview(engineHash)
    if (procItems.length)
      shown.tables = [
        ...shown.tables,
        {
          table: PROCS,
          inserts: procItems.filter((p) => p.op === 'drop').length,
          updates: procItems.filter((p) => p.op === 'change' && p.before).length,
          deletes: procItems.filter((p) => p.op === 'add').length,
          unchanged: 0,
          more: 0,
          dropped_columns: [],
          rows: procItems.map((p) => ({
            key: p.name,
            op: p.op === 'add' ? 'delete' : p.op === 'drop' ? 'insert' : 'update',
            label: p.name,
            fields: [
              {
                field: 'body',
                now: '(as the promotion left it)',
                was: p.before ? '(the body before the promotion)' : null
              }
            ]
          }))
        } as unknown as RestorePreview['tables'][number]
      ]
    return {
      mode,
      preview: { ...shown, plan_hash: combine(engineHash, procHash) },
      engine_hash: engineHash,
      procs_hash: procHash,
      prod_only_changes: check?.items ?? [],
      prod_only_lines: check?.lines ?? [],
      prod_only_refuse: !!check?.refuse && (check.items?.length ?? 0) > 0
    }
  }
  const hash = String(b.plan_hash ?? '')
  const engineHash = String(b.engine_hash ?? '')
  const procHashIn = String(b.procs_hash ?? '')
  if (combine(engineHash, procHashIn) !== hash || procHashIn !== procHash)
    throw new PromoteError(409, 'STALE', 'This is not the undo you previewed — preview it again.')
  const refusal = prodOnlyRefusal(check, b.overwrite_prod_changes)
  if (refusal) throw refusal
  const took = await setRecord(rec.run_key, { status: 'undoing', heartbeat_at: new Date() }, [
    'applied'
  ])
  if (took !== 1) throw new PromoteError(409, 'NOT_UNDOABLE', 'That promotion is being undone')
  const stop = startHeartbeat(rec.run_key)
  let committed = false
  try {
    let result: RestoreResult = {
      snapshot_id: 0,
      pre_restore_id: null,
      tables: [],
      totals: { inserted: 0, updated: 0, deleted: 0 }
    }
    const tag = rec.promotion_id ? ` #${rec.promotion_id}` : ''
    if (touched.length) {
      try {
        result = await applyGivenSnapshot(snap, {
          ref,
          deletes: true,
          keys: target.keys,
          planHash: engineHash,
          userId: null,
          note: `Before undoing Nivaro Hub config promotion${tag}`,
          activityNote: `Undo of Nivaro Hub config promotion${tag}`,
          inTransaction: async (trx) => {
            await trx(WRITES).where({ run_key: rec.run_key }).update({ undone: true })
            return true
          },
          afterCommit: (k, ctx) =>
            moveBaseline(k, ctx, `After undoing Nivaro Hub config promotion${tag}`)
        })
      } catch (err) {
        rethrow(err)
      }
    }
    if (result.extra !== true)
      await db(WRITES).where({ run_key: rec.run_key }).update({ undone: true })
    committed = true
    const procedures = procItems.length
      ? await undoProcs(procItems, writer, `Undo of Nivaro Hub config promotion${tag}`)
      : []
    const baseline =
      typeof result.after_commit === 'string'
        ? result.after_commit
        : result.after_commit
          ? `not moved: ${errText((result.after_commit as { error?: unknown }).error)}`
          : 'unchanged'
    await setRecord(rec.run_key, {
      status: 'undone',
      undone_at: new Date(),
      heartbeat_at: null,
      undo_result: JSON.stringify({ totals: result.totals, procedures, baseline })
    })
    return {
      mode,
      result: { tables: result.tables, totals: result.totals },
      procedures,
      baseline
    }
  } catch (err) {
    await setRecord(
      rec.run_key,
      committed
        ? { status: 'undone', undone_at: new Date(), heartbeat_at: null, error: errText(err) }
        : { status: 'applied', heartbeat_at: null },
      ['undoing']
    ).catch(() => {})
    throw err
  } finally {
    stop()
  }
}

/** Exported for tests: the export filter's rows for one table. */
export function _exportRows(table: string, rows: Record<string, SnapshotRow>) {
  return exportTable(table, rows)
}
