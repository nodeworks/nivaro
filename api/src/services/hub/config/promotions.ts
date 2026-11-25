import { randomBytes } from 'node:crypto'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import {
  CONFIG_PROMOTION_GROUPS,
  groupOfTable,
  isConfigGroupKey,
  tablesForGroups
} from '../../config-promote-groups.js'
import type { ChecklistClaim } from '../changes/checklist.js'
import { type HubEvent, notifyHubEvent } from '../notify-events.js'
import {
  defaultPromoteLock,
  LOCK_RENEW_MS,
  lockHolderRefusal,
  type PromoteLock
} from '../promote-lock.js'
import { type ConfigChannel, configChannelFor } from './channel.js'
import {
  type ConfigAction,
  changeWindowRefusal,
  claimChecklist,
  type GateRefusal,
  isProductionTarget,
  moveOpenGate
} from './gates.js'
import {
  type ConfigPromotion,
  ConfigPromotionError,
  type ConfigPromotionStatus,
  type PlanView,
  PROMOTIONS,
  type RowChange,
  type TableChange
} from './types.js'

/**
 * Hub config promotion (idea 30): move an app's configuration from one of its environments to
 * another over the hub link / deployment link, the TARGET app doing the work
 * (services/hub-link/config-promote.ts). The Hub holds no snapshot: it reads one from the source
 * at plan time and again at apply time; the target's hash covers the source rows AND its own live
 * rows, so anything that moved on either side answers STALE.
 *
 *   plan   source snapshot → target plan (natural-key match, references remapped, field diff,
 *          kept / held rows, steps that need setup, Changed-here hits) → a `planned` row with a
 *          run key; an older planned row for the same target is `superseded`
 *   apply  admin; plan younger than 24 h; typed confirm (= the environment key) on production;
 *          under the environment lock (holder `config`, renewed every minute): no open move,
 *          freezes + deploy windows (action config_promote; an administrator's emergency start
 *          skips the windows only), the production pre-deploy checklist (claimed, linked as
 *          `config`). The target applies idempotently by run key and records what it wrote. A lost
 *          answer is `interrupted`, never "nothing written": the Hub asks the target by run key
 *          (reconcile) and reports what IT says.
 *   undo   only the newest applied promotion of an environment; puts back exactly the rows it
 *          wrote (the target refuses STALE when any changed since); freezes and windows never
 *          stop it, a move does; admin on own session with a typed confirm (the route).
 */

export const PLAN_TTL_MS = 24 * 60 * 60_000
/** An `applying` / `undoing` row whose server stopped reads as interrupted after this. */
export const STUCK_MS = 10 * 60_000
const PLAN_JSON_CAP = 3_000_000
/** Codes that mean the Hub has no answer from the target (it may have written). */
const NO_ANSWER = new Set([
  'APP_UNREACHABLE',
  'ANSWER_TOO_LARGE',
  'CONFIG_PROMOTE_FAILED',
  'HTTP_500',
  'HTTP_502',
  'HTTP_503',
  'HTTP_504'
])

export interface ConfigDeps {
  channel?: (envId: number) => Promise<ConfigChannel>
  lock?: PromoteLock
  /** Freezes + deploy windows (null for an undo). */
  window?: (
    envId: number,
    action: ConfigAction,
    o: { skipWindows?: boolean }
  ) => Promise<GateRefusal | null>
  moveOpen?: (envId: number) => Promise<GateRefusal | null>
  checklist?: (envId: number, promotionId: number, runId: unknown) => Promise<ChecklistClaim | null>
  production?: (envId: number) => Promise<boolean>
  /** An emergency start that really skipped a closed window: log + tell the owners. */
  outsideWindow?: (o: {
    appId: number
    envId: number
    promotionId: number
    where: string
    reason: string
    userId: string | null
  }) => Promise<void>
  notify?: (e: HubEvent) => void
  now?: () => number
}

function d(deps: ConfigDeps) {
  return {
    channel: deps.channel ?? configChannelFor,
    lock: deps.lock ?? defaultPromoteLock(),
    window: deps.window ?? changeWindowRefusal,
    moveOpen: deps.moveOpen ?? moveOpenGate,
    checklist: deps.checklist ?? claimChecklist,
    production: deps.production ?? isProductionTarget,
    outsideWindow: deps.outsideWindow ?? defaultOutsideWindow,
    notify: deps.notify ?? notifyHubEvent,
    now: deps.now ?? Date.now
  }
}

async function defaultOutsideWindow(o: {
  appId: number
  envId: number
  promotionId: number
  where: string
  reason: string
  userId: string | null
}) {
  const { recordOutsideWindow, windowWasClosed } = await import('../changes/emergency.js')
  if (!(await windowWasClosed({ appIds: [o.appId], action: 'config_promote', envId: o.envId })))
    return
  await recordOutsideWindow({
    userId: o.userId ?? '',
    action: 'config_promote',
    appIds: [o.appId],
    where: o.where,
    reason: o.reason,
    collection: PROMOTIONS,
    item: String(o.promotionId)
  })
}

// ── rows ────────────────────────────────────────────────────────────────────

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const t = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v))
  return Number.isNaN(t.getTime()) ? null : t.toISOString()
}
const truthy = (v: unknown) => v === true || v === 1 || v === '1'
function json<T>(v: unknown, fallback: T): T {
  if (v == null || v === '') return fallback
  if (typeof v !== 'string') return v as T
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

export function promotionFromRow(r: Record<string, unknown>): ConfigPromotion {
  const status = String(r.status) as ConfigPromotionStatus
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    source_environment_id: Number(r.source_environment_id),
    target_environment_id: Number(r.target_environment_id),
    status,
    groups: json<string[]>(r.group_keys, []),
    tables: json<string[]>(r.table_list, []),
    deletes: truthy(r.deletes),
    allow_cascade: truthy(r.allow_cascade),
    production: truthy(r.production),
    plan_hash: (r.plan_hash as string | null) ?? null,
    plan: json<PlanView | null>(r.plan, null),
    result: json<Record<string, unknown> | null>(r.result, null),
    pre_restore_id: r.pre_restore_id == null ? null : Number(r.pre_restore_id),
    run_key: (r.run_key as string | null) ?? null,
    undo_ready: false,
    undo_result: json<Record<string, unknown> | null>(r.undo_result, null),
    source_version: (r.source_version as string | null) ?? null,
    target_version: (r.target_version as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    planned_by: r.planned_by == null ? null : String(r.planned_by),
    applied_by: r.applied_by == null ? null : String(r.applied_by),
    undone_by: r.undone_by == null ? null : String(r.undone_by),
    planned_at: iso(r.planned_at),
    started_at: iso(r.started_at),
    applied_at: iso(r.applied_at),
    undone_at: iso(r.undone_at)
  }
}

/** Statuses after which a promotion may have written to its target. */
const WROTE = ['applied', 'applying', 'interrupted', 'undoing']

/**
 * Pure: a row left `applying` / `undoing` by a server that stopped. An interrupted apply is
 * `interrupted` (the target may have written; reconcile asks it); an interrupted undo leaves the
 * promotion `applied` (the target's own record says whether it was undone: reconcile).
 */
export function healedStatus(
  p: Pick<ConfigPromotion, 'status' | 'started_at'>,
  now: number
): ConfigPromotionStatus | null {
  if (p.status !== 'applying' && p.status !== 'undoing') return null
  const at = p.started_at ? Date.parse(p.started_at) : 0
  if (now - at < STUCK_MS) return null
  return p.status === 'applying' ? 'interrupted' : 'applied'
}

const LOST =
  'The Hub lost the target’s answer: it may have written. Use “Check the target” to read what it says before planning again.'

async function heal(rows: ConfigPromotion[], now: number): Promise<ConfigPromotion[]> {
  const out: ConfigPromotion[] = []
  for (const p of rows) {
    const next = healedStatus(p, now)
    if (!next) {
      out.push(p)
      continue
    }
    const error =
      next === 'interrupted'
        ? LOST
        : 'The Hub stopped while undoing this. Use “Check the target” to read whether it was undone.'
    await db(PROMOTIONS).where({ id: p.id, status: p.status }).update({ status: next, error })
    out.push({ ...p, status: next, error })
  }
  return out
}

/** undo_ready = applied and nothing newer may have written to the same target. */
function markUndo(rows: ConfigPromotion[], newerByTarget: Map<number, number>): ConfigPromotion[] {
  return rows.map((p) => ({
    ...p,
    undo_ready:
      p.status === 'applied' &&
      !!p.run_key &&
      (newerByTarget.get(p.target_environment_id) ?? 0) <= p.id
  }))
}

async function newestWrote(targets: number[]): Promise<Map<number, number>> {
  if (!targets.length) return new Map()
  const rows = (await db(PROMOTIONS)
    .whereIn('target_environment_id', targets)
    .whereIn('status', WROTE)
    .groupBy('target_environment_id')
    .select('target_environment_id')
    .max('id as id')) as Array<{ target_environment_id: unknown; id: unknown }>
  return new Map(rows.map((r) => [Number(r.target_environment_id), Number(r.id)]))
}

export async function listPromotions(appId: number, now = Date.now()): Promise<ConfigPromotion[]> {
  const rows = (await db(PROMOTIONS)
    .where({ app_id: appId })
    .orderBy('id', 'desc')
    .limit(50)
    .select('*')) as Array<Record<string, unknown>>
  const healed = await heal(rows.map(promotionFromRow), now)
  return markUndo(
    healed,
    await newestWrote([...new Set(healed.map((p) => p.target_environment_id))])
  )
}

export async function getPromotion(id: number, now = Date.now()): Promise<ConfigPromotion | null> {
  const r = (await db(PROMOTIONS).where({ id }).first()) as Record<string, unknown> | undefined
  if (!r) return null
  const [p] = await heal([promotionFromRow(r)], now)
  return markUndo([p], await newestWrote([p.target_environment_id]))[0]
}

// ── the app's plan → the Hub's view ─────────────────────────────────────────

interface AppPreview {
  plan_hash?: unknown
  tables?: unknown
  totals?: Record<string, unknown>
  cascade?: unknown
  over_cap?: unknown
  cap?: unknown
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const txt = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '')
const hex64 = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : '')

/** Pure: a restore preview (the app's words) as rows of field changes. */
export function tablesOf(preview: AppPreview): TableChange[] {
  return arr<Record<string, unknown>>(preview.tables).map((t) => {
    const table = txt(t.table, 128)
    return {
      table,
      group: groupOfTable(table)?.key ?? null,
      inserts: num(t.inserts),
      updates: num(t.updates),
      deletes: num(t.deletes),
      unchanged: num(t.unchanged),
      more: num(t.more),
      dropped_columns: arr<unknown>(t.dropped_columns)
        .map((c) => txt(c, 128))
        .slice(0, 100),
      rows: arr<Record<string, unknown>>(t.rows).map(
        (r): RowChange => ({
          key: txt(r.key, 200),
          op: r.op === 'insert' || r.op === 'delete' ? r.op : 'update',
          label: typeof r.label === 'string' ? r.label.slice(0, 120) : null,
          fields: arr<Record<string, unknown>>(r.fields).map((f) => ({
            field: txt(f.field, 128),
            current: f.now ?? null,
            incoming: f.was ?? null
          }))
        })
      )
    }
  })
}

/** Pure: the app's plan answer as the view the Hub stores and shows. */
export function planViewOf(answer: Record<string, unknown>): { view: PlanView; hash: string } {
  const preview = (answer.preview ?? {}) as AppPreview
  const hash = hex64(preview.plan_hash)
  if (!hash)
    throw new ConfigPromotionError(
      'BAD_PLAN',
      'The target app answered a plan without a hash.',
      502
    )
  const totals = preview.totals ?? {}
  const view: PlanView = {
    totals: {
      inserts: num(totals.inserts),
      updates: num(totals.updates),
      deletes: num(totals.deletes),
      tables: num(totals.tables)
    },
    skipped_inactive_user: num(totals.skipped_inactive_user),
    tables: tablesOf(preview),
    refused: arr<Record<string, unknown>>(answer.refused).map((r) => ({
      table: txt(r.table, 128),
      reason: txt(r.reason)
    })),
    kept: arr<Record<string, unknown>>(answer.kept).map((k) => ({
      table: txt(k.table, 128),
      label: txt(k.label),
      columns: arr<unknown>(k.columns).map((c) => txt(c, 128))
    })),
    held: arr<Record<string, unknown>>(answer.held)
      .slice(0, 200)
      .map((h) => ({
        table: txt(h.table, 128),
        key: txt(h.key, 200),
        label: typeof h.label === 'string' ? h.label.slice(0, 120) : null,
        reason: txt(h.reason)
      })),
    switched_off: arr<Record<string, unknown>>(answer.switched_off)
      .slice(0, 200)
      .map((h) => ({
        table: txt(h.table, 128),
        key: txt(h.key, 200),
        label: typeof h.label === 'string' ? h.label.slice(0, 120) : null
      })),
    needs_setup: arr<Record<string, unknown>>(answer.needs_setup)
      .slice(0, 200)
      .map((n) => ({
        flow: typeof n.flow === 'string' ? n.flow.slice(0, 200) : null,
        step: typeof n.step === 'string' ? n.step.slice(0, 200) : null,
        reason: txt(n.reason)
      })),
    cascade: arr<Record<string, unknown>>(preview.cascade).map((c) => ({
      table: txt(c.table, 128),
      child: txt(c.child, 128),
      column: txt(c.column, 128),
      action: txt(c.action, 32),
      rows: num(c.rows)
    })),
    over_cap: preview.over_cap === true,
    cap: num(preview.cap),
    warnings: arr<unknown>(answer.warnings)
      .map((w) => txt(w, 600))
      .slice(0, 30),
    prod_only: {
      count: arr(answer.prod_only_changes).length,
      lines: arr<unknown>(answer.prod_only_lines)
        .map((l) => txt(l, 300))
        .slice(0, 50),
      refuse: answer.prod_only_refuse === true
    },
    hashes: { engine: hex64(answer.engine_hash), procs: hex64(answer.procs_hash) }
  }
  return { view, hash }
}

/** Pure: a stored plan never past the cap (rows are trimmed table by table; counts stay exact). */
export function cappedPlan(view: PlanView, cap = PLAN_JSON_CAP): string {
  let s = JSON.stringify(view)
  if (s.length <= cap) return s
  const trimmed: PlanView = {
    ...view,
    tables: view.tables.map((t) => ({
      ...t,
      rows: t.rows.slice(0, 5),
      more: t.more + Math.max(0, t.rows.length - 5)
    }))
  }
  s = JSON.stringify(trimmed)
  if (s.length <= cap) return s
  return JSON.stringify({
    ...trimmed,
    tables: trimmed.tables.map((t) => ({ ...t, rows: [], more: t.more + t.rows.length }))
  })
}

// ── plan ────────────────────────────────────────────────────────────────────

interface EnvRow {
  id: number
  key: string
  app_id: number
  status: string | null
}

async function envOf(envId: number): Promise<EnvRow | null> {
  const r = (await db('nivaro_hub_environments')
    .where({ id: envId })
    .first('id', 'key', 'app_id', 'status')) as Record<string, unknown> | undefined
  return r
    ? {
        id: Number(r.id),
        key: String(r.key),
        app_id: Number(r.app_id),
        status: (r.status as string) ?? null
      }
    : null
}

async function appKeyOf(appId: number): Promise<string | null> {
  const r = (await db('nivaro_hub_apps').where({ id: appId }).first('key')) as
    | { key: string }
    | undefined
  return r ? String(r.key) : null
}

export interface PlanInput {
  appId: number
  sourceEnvId: number
  targetEnvId: number
  groups: unknown
  deletes: boolean
  allowCascade: boolean
  userId: string | null
}

/** Validates the plan request against the app. Throws ConfigPromotionError. */
export async function checkPlanInput(i: PlanInput): Promise<{
  source: EnvRow
  target: EnvRow
  appKey: string
  groups: string[]
  tables: string[]
}> {
  const appKey = await appKeyOf(i.appId)
  if (!appKey) throw new ConfigPromotionError('NOT_FOUND', 'No such app.', 404)
  if (i.sourceEnvId === i.targetEnvId)
    throw new ConfigPromotionError('SAME_ENVIRONMENT', 'Pick two different environments.', 400)
  const [source, target] = await Promise.all([envOf(i.sourceEnvId), envOf(i.targetEnvId)])
  for (const e of [source, target])
    if (!e || e.app_id !== i.appId)
      throw new ConfigPromotionError('NOT_FOUND', 'Both environments must belong to this app.', 404)
  for (const e of [source, target] as EnvRow[])
    if (String(e.status ?? '').toLowerCase() === 'archived')
      throw new ConfigPromotionError('ARCHIVED', `${e.key} is archived.`, 409)
  const raw = Array.isArray(i.groups) ? i.groups : []
  const groups = CONFIG_PROMOTION_GROUPS.map((g) => g.key).filter((k) => raw.includes(k))
  if (!groups.length || raw.some((g) => !isConfigGroupKey(g)))
    throw new ConfigPromotionError(
      'BAD_GROUPS',
      `groups must name one or more of: ${CONFIG_PROMOTION_GROUPS.map((g) => g.key).join(', ')}`,
      400
    )
  return {
    source: source as EnvRow,
    target: target as EnvRow,
    appKey,
    groups,
    tables: tablesForGroups(groups)
  }
}

function versionOf(a: unknown): string | null {
  const v = (a as { version?: unknown } | null)?.version
  return typeof v === 'string' && v ? v.slice(0, 40) : null
}

/** What the source answered, checked for shape (snapshot, refs, stripped). */
function snapshotBody(snap: Record<string, unknown> | null) {
  if (!snap?.snapshot || typeof snap.snapshot !== 'object')
    throw new ConfigPromotionError('BAD_SNAPSHOT', 'The source app answered no snapshot.', 502)
  return {
    snapshot: snap.snapshot,
    refs: snap.refs && typeof snap.refs === 'object' ? snap.refs : {},
    stripped: snap.stripped && typeof snap.stripped === 'object' ? snap.stripped : {}
  }
}

export const newRunKey = () => randomBytes(18).toString('base64url')

export async function planPromotion(i: PlanInput, deps: ConfigDeps = {}): Promise<ConfigPromotion> {
  const x = d(deps)
  const { source, target, appKey, groups, tables } = await checkPlanInput(i)
  const moving = await x.moveOpen(target.id)
  if (moving) throw new ConfigPromotionError(moving.code, moving.message, moving.status)
  const [src, dst] = await Promise.all([x.channel(source.id), x.channel(target.id)])
  const runKey = newRunKey()
  const snap = snapshotBody(
    (await src.call('snapshot', { tables })) as Record<string, unknown> | null
  )
  const answer = (await dst.call('plan', {
    ...snap,
    tables,
    deletes: i.deletes,
    allow_cascade: i.allowCascade,
    run_key: runKey,
    source_label: `${appKey}/${source.key}`
  })) as Record<string, unknown> | null
  const { view, hash } = planViewOf(answer ?? {})
  if (!view.hashes.engine || !view.hashes.procs)
    throw new ConfigPromotionError(
      'BAD_PLAN',
      'The target app answered an older plan shape — update it to 0.3.215 or later.',
      502
    )
  const production = await x.production(target.id)
  const now = new Date(x.now())
  await db(PROMOTIONS)
    .where({ target_environment_id: target.id, status: 'planned' })
    .update({ status: 'superseded' })
  const id = Number(
    await insertReturningId(db, PROMOTIONS, {
      app_id: i.appId,
      source_environment_id: source.id,
      target_environment_id: target.id,
      status: 'planned',
      group_keys: JSON.stringify(groups),
      table_list: JSON.stringify(tables),
      deletes: i.deletes,
      allow_cascade: i.allowCascade,
      production,
      plan_hash: hash,
      plan: cappedPlan(view),
      run_key: runKey,
      source_version: versionOf(snap),
      target_version: versionOf(answer),
      planned_by: i.userId,
      planned_at: now
    })
  )
  const p = await getPromotion(id, x.now())
  if (!p) throw new ConfigPromotionError('NOT_FOUND', 'The plan could not be read back.', 500)
  return p
}

// ── apply ───────────────────────────────────────────────────────────────────

export interface ApplyInput {
  id: number
  planHash: unknown
  confirm: unknown
  overwriteProdChanges: boolean
  userId: string | null
  /** For the target's notes only. */
  actor: string | null
  checklistRunId?: unknown
  /** An administrator's emergency start outside the deploy window (outsideWindowOf). */
  outsideWindow?: { reason: string } | null
}

function refusal(r: GateRefusal): ConfigPromotionError {
  return new ConfigPromotionError(r.code, r.message, r.status, r.extra ?? {})
}

async function names(p: ConfigPromotion) {
  const [app, src, dst] = await Promise.all([
    appKeyOf(p.app_id),
    envOf(p.source_environment_id),
    envOf(p.target_environment_id)
  ])
  return { app: app ?? `app ${p.app_id}`, source: src?.key ?? '?', target: dst ?? null }
}

/** The typed confirm: the target environment's key. */
function checkConfirm(needed: boolean, confirm: unknown, key: string) {
  if (!needed) return
  if (typeof confirm !== 'string' || confirm.trim() !== key)
    throw new ConfigPromotionError('CONFIRM_REQUIRED', `Type ${key} to confirm`, 400)
}

/** The environment lock (holder `config`), renewed every minute while `fn` runs. */
async function withEnvLock<T>(lock: PromoteLock, envId: number, fn: () => Promise<T>): Promise<T> {
  const token = await lock.take(envId, 'config')
  if (!token) {
    let holder = null
    try {
      holder = lock.holder ? await lock.holder(envId) : null
    } catch {
      holder = null
    }
    const r = lockHolderRefusal(holder, {
      code: 'ENVIRONMENT_BUSY',
      message: 'Something else is running on this environment — wait for it to end.'
    })
    throw new ConfigPromotionError(r.code, r.message, 409)
  }
  const timer = setInterval(() => {
    void Promise.resolve(lock.renew(envId, token)).catch(() => undefined)
  }, LOCK_RENEW_MS)
  try {
    return await fn()
  } finally {
    clearInterval(timer)
    await lock.release(envId, token)
  }
}

function summaryOf(out: Record<string, unknown> | null) {
  const result = (out?.result ?? {}) as Record<string, unknown>
  const totals = (result.totals ?? {}) as Record<string, unknown>
  const procs = arr<Record<string, unknown>>(out?.procedures)
  return {
    totals: {
      inserted: num(totals.inserted),
      updated: num(totals.updated),
      deleted: num(totals.deleted)
    },
    tables: arr<Record<string, unknown>>(result.tables).map((t) => ({
      table: txt(t.table, 128),
      inserted: num(t.inserted),
      updated: num(t.updated),
      deleted: num(t.deleted)
    })),
    procedures: {
      written: procs.filter((p) => p.ok === true).length,
      failed: procs.filter((p) => p.ok !== true).map((p) => txt(p.name, 128))
    },
    needs_setup: arr<Record<string, unknown>>(out?.needs_setup)
      .slice(0, 50)
      .map((n) => ({
        flow: typeof n.flow === 'string' ? n.flow.slice(0, 200) : null,
        step: typeof n.step === 'string' ? n.step.slice(0, 200) : null,
        reason: txt(n.reason)
      })),
    baseline: out?.baseline === 'moved' ? 'moved' : 'unchanged',
    pre_restore_id: Number.isSafeInteger(Number(result.pre_restore_id))
      ? Number(result.pre_restore_id) || null
      : null
  }
}

type Summary = ReturnType<typeof summaryOf>

function doneText(s: Summary, from: string, to: string) {
  const t = s.totals
  const parts = [
    `Configuration from ${from} is on ${to}: ${t.inserted} added, ${t.updated} changed, ${t.deleted} removed.`
  ]
  if (s.procedures.failed.length)
    parts.push(`Procedures that did not deploy: ${s.procedures.failed.slice(0, 5).join(', ')}.`)
  if (s.needs_setup.length)
    parts.push(
      `Switched off until set up here: ${s.needs_setup
        .slice(0, 5)
        .map((n) => [n.flow, n.step].filter(Boolean).join(' → '))
        .join('; ')}.`
    )
  return parts.join(' ')
}

async function markApplied(p: ConfigPromotion, s: Summary, now: number) {
  await db(PROMOTIONS)
    .where({ id: p.id })
    .update({
      status: 'applied',
      applied_at: new Date(now),
      error: null,
      pre_restore_id: s.pre_restore_id,
      result: JSON.stringify(s)
    })
}

export async function applyPromotion(
  i: ApplyInput,
  deps: ConfigDeps = {}
): Promise<ConfigPromotion> {
  const x = d(deps)
  const p = await getPromotion(i.id, x.now())
  if (!p) throw new ConfigPromotionError('NOT_FOUND', 'No such config promotion.', 404)
  if (p.status !== 'planned')
    throw new ConfigPromotionError(
      'NOT_PLANNED',
      `This promotion is ${p.status}; plan it again.`,
      409
    )
  if (typeof i.planHash !== 'string' || i.planHash !== p.plan_hash)
    throw new ConfigPromotionError(
      'PLAN_CHANGED',
      'This is not the plan you reviewed — reload it.',
      409
    )
  if (!p.planned_at || x.now() - Date.parse(p.planned_at) > PLAN_TTL_MS)
    throw new ConfigPromotionError(
      'PLAN_EXPIRED',
      'This plan is more than a day old — plan it again.',
      409
    )
  if (!p.run_key || !p.plan?.hashes?.engine)
    throw new ConfigPromotionError(
      'PLAN_CHANGED',
      'This plan is from an older Hub — plan it again.',
      409
    )
  if (p.plan.over_cap)
    throw new ConfigPromotionError(
      'OVER_CAP',
      'Too many rows would change at once — promote fewer groups at a time.',
      400
    )
  if (p.plan.cascade.length && !p.allow_cascade)
    throw new ConfigPromotionError(
      'CASCADE',
      'Removing these rows would also remove or clear rows in other tables — plan again with that allowed.',
      409
    )
  const n = await names(p)
  if (!n.target) throw new ConfigPromotionError('NOT_FOUND', 'The target environment is gone.', 404)
  const targetKey = n.target.key
  checkConfirm(await x.production(p.target_environment_id), i.confirm, targetKey)
  if (p.plan.prod_only.refuse && !i.overwriteProdChanges)
    throw new ConfigPromotionError(
      'PROD_ONLY_CHANGES',
      `${p.plan.prod_only.count} change(s) made on ${targetKey}, not from promotion, would be overwritten. Mark them as intended there (Environments → Changed here), or confirm overwriting them.`,
      409,
      { lines: p.plan.prod_only.lines }
    )
  const where = `${n.app} · ${targetKey}`
  const plan = p.plan
  return withEnvLock(x.lock, p.target_environment_id, async () => {
    // Under the lock: a move or a freeze created a moment ago is seen.
    for (const gate of [
      () => x.moveOpen(p.target_environment_id),
      () => x.window(p.target_environment_id, 'config_apply', { skipWindows: !!i.outsideWindow })
    ]) {
      const r = await gate()
      if (r) throw refusal(r)
    }
    let claim: ChecklistClaim | null
    try {
      claim = await x.checklist(p.target_environment_id, p.id, i.checklistRunId)
    } catch (e) {
      const ce = e as {
        code?: string
        message?: string
        status?: number
        extra?: Record<string, unknown>
      }
      throw new ConfigPromotionError(
        ce.code ?? 'CHECKLIST_UNKNOWN',
        ce.message ?? 'Checklist',
        ce.status ?? 409,
        ce.extra ?? {}
      )
    }
    const claimed = await db(PROMOTIONS)
      .where({ id: p.id, status: 'planned' })
      .update({
        status: 'applying',
        started_at: new Date(x.now()),
        applied_by: i.userId,
        error: null
      })
    if (Number(claimed) !== 1) {
      await claim?.release().catch(() => undefined)
      throw new ConfigPromotionError('NOT_PLANNED', 'Someone else started this promotion.', 409)
    }
    if (i.outsideWindow)
      await x
        .outsideWindow({
          appId: p.app_id,
          envId: p.target_environment_id,
          promotionId: p.id,
          where,
          reason: i.outsideWindow.reason,
          userId: i.userId
        })
        .catch(() => undefined)
    const [src, dst] = await Promise.all([
      x.channel(p.source_environment_id),
      x.channel(p.target_environment_id)
    ])
    let out: Record<string, unknown> | null
    try {
      const snap = snapshotBody(
        (await src.call('snapshot', { tables: p.tables })) as Record<string, unknown> | null
      )
      out = (await dst.call('apply', {
        ...snap,
        tables: p.tables,
        deletes: p.deletes,
        allow_cascade: p.allow_cascade,
        plan_hash: p.plan_hash,
        engine_hash: plan.hashes.engine,
        procs_hash: plan.hashes.procs,
        run_key: p.run_key,
        overwrite_prod_changes: i.overwriteProdChanges,
        source_label: `${n.app}/${n.source}`,
        promotion_id: p.id,
        actor: i.actor
      })) as Record<string, unknown> | null
    } catch (err) {
      const e =
        err instanceof ConfigPromotionError
          ? err
          : new ConfigPromotionError('APP_UNREACHABLE', 'The target did not answer.', 502)
      if (NO_ANSWER.has(e.code)) {
        // No answer: the target may have written. Never "nothing written" without its word.
        await db(PROMOTIONS).where({ id: p.id }).update({ status: 'interrupted', error: LOST })
        await claim?.link('config', p.id).catch(() => undefined)
        const settled = await reconcileWith(p, dst, x).catch(() => null)
        if (!settled || settled.status === 'interrupted')
          x.notify({
            kind: 'promote_failed',
            appId: p.app_id,
            envId: p.target_environment_id,
            path: `/hub/config?promotion=${p.id}`,
            urgent: true,
            text: {
              subject: `Config promotion lost its answer: ${where}`,
              message: `The Hub could not read ${targetKey}’s answer; it may have written. Open the promotion and check the target.`
            }
          })
        if (settled) return settled
        throw new ConfigPromotionError('INTERRUPTED', LOST, 502)
      }
      // An answer that refused: nothing was written (the target's own word).
      const stale = e.code === 'STALE'
      const back = e.code === 'PROD_ONLY_CHANGES' || e.code === 'BUSY' || e.code === 'LOCKED'
      await db(PROMOTIONS)
        .where({ id: p.id })
        .update({
          status: back ? 'planned' : stale ? 'stale' : 'failed',
          error: e.message.slice(0, 1000),
          ...(back ? { started_at: null, applied_by: null } : {})
        })
      if (back || !claim) await claim?.release().catch(() => undefined)
      else await claim.link('config', p.id).catch(() => undefined)
      if (!back)
        x.notify({
          kind: 'promote_failed',
          appId: p.app_id,
          envId: p.target_environment_id,
          path: `/hub/config?promotion=${p.id}`,
          urgent: !stale,
          text: {
            subject: stale
              ? `Config promotion needs a new plan: ${where}`
              : `Config promotion refused: ${where}`,
            message: stale
              ? `Configuration on ${n.source} or ${targetKey} changed since the plan; ${targetKey} wrote nothing. Plan it again.`
              : `${targetKey} refused it and wrote nothing: ${e.message.slice(0, 300)}`
          }
        })
      throw e
    }
    await claim?.link('config', p.id).catch(() => undefined)
    const s = summaryOf(out)
    await markApplied(p, s, x.now())
    x.notify({
      kind: s.procedures.failed.length ? 'promote_failed' : 'promote_done',
      appId: p.app_id,
      envId: p.target_environment_id,
      path: `/hub/config?promotion=${p.id}`,
      ...(s.procedures.failed.length || s.needs_setup.length ? { urgent: true } : {}),
      text: {
        subject: `${s.procedures.failed.length ? 'Config promoted with failures' : 'Config promoted'}: ${where}`,
        message: doneText(s, n.source, targetKey)
      }
    })
    const done = await getPromotion(p.id, x.now())
    if (!done)
      throw new ConfigPromotionError('NOT_FOUND', 'The promotion could not be read back.', 500)
    return done
  })
}

// ── reconcile (a lost answer) ───────────────────────────────────────────────

async function reconcileWith(
  p: ConfigPromotion,
  ch: ConfigChannel,
  x: ReturnType<typeof d>
): Promise<ConfigPromotion | null> {
  if (!p.run_key) return null
  const st = (await ch.call('status', { run_key: p.run_key })) as {
    state?: unknown
    answer?: unknown
  } | null
  const state = st?.state
  if (state === 'applied' || state === 'undone') {
    const s = summaryOf((st?.answer ?? null) as Record<string, unknown> | null)
    await markApplied(p, s, x.now())
    if (state === 'undone')
      await db(PROMOTIONS)
        .where({ id: p.id })
        .update({ status: 'undone', undone_at: new Date(x.now()) })
  } else if (state === 'not_applied') {
    await db(PROMOTIONS).where({ id: p.id }).update({
      status: 'failed',
      error: 'The target confirms it wrote nothing for this promotion. Plan it again.'
    })
  } else return null
  return getPromotion(p.id, x.now())
}

/** Asks the target what it did with this promotion (interrupted / undoing rows). */
export async function reconcilePromotion(
  id: number,
  deps: ConfigDeps = {}
): Promise<ConfigPromotion> {
  const x = d(deps)
  const p = await getPromotion(id, x.now())
  if (!p) throw new ConfigPromotionError('NOT_FOUND', 'No such config promotion.', 404)
  if (!['interrupted', 'applied', 'failed'].includes(p.status) || !p.run_key)
    throw new ConfigPromotionError(
      'NOTHING_TO_CHECK',
      'There is nothing to check on this promotion.',
      409
    )
  const out = await reconcileWith(p, await x.channel(p.target_environment_id), x)
  if (!out)
    throw new ConfigPromotionError(
      'APP_UNREACHABLE',
      'The target did not say what it did — try again.',
      502
    )
  return out
}

// ── undo ────────────────────────────────────────────────────────────────────

export interface UndoPreview {
  promotion: ConfigPromotion
  plan: PlanView
  plan_hash: string
}

function undoable(p: ConfigPromotion | null): ConfigPromotion {
  if (!p) throw new ConfigPromotionError('NOT_FOUND', 'No such config promotion.', 404)
  if (p.status === 'undone')
    throw new ConfigPromotionError('NOT_UNDOABLE', 'This promotion was undone already.', 409)
  if (p.status !== 'applied' || !p.run_key)
    throw new ConfigPromotionError('NOT_UNDOABLE', 'Only an applied promotion can be undone.', 409)
  if (!p.undo_ready)
    throw new ConfigPromotionError(
      'NOT_NEWEST',
      'A newer promotion has written to this environment since; only the newest one can be undone.',
      409
    )
  return p
}

export async function previewUndo(id: number, deps: ConfigDeps = {}): Promise<UndoPreview> {
  const x = d(deps)
  const p = undoable(await getPromotion(id, x.now()))
  const moving = await x.moveOpen(p.target_environment_id)
  if (moving) throw refusal(moving)
  const ch = await x.channel(p.target_environment_id)
  const out = (await ch.call('undo', { mode: 'preview', run_key: p.run_key })) as Record<
    string,
    unknown
  > | null
  const { view, hash } = planViewOf(out ?? {})
  await db(PROMOTIONS)
    .where({ id: p.id })
    .update({ undo_plan_hash: hash, undo_result: JSON.stringify({ hashes: view.hashes }) })
  return { promotion: p, plan: view, plan_hash: hash }
}

export interface UndoInput {
  id: number
  planHash: unknown
  confirm: unknown
  overwriteProdChanges: boolean
  userId: string | null
}

export async function applyUndo(i: UndoInput, deps: ConfigDeps = {}): Promise<ConfigPromotion> {
  const x = d(deps)
  const p = undoable(await getPromotion(i.id, x.now()))
  const row = (await db(PROMOTIONS).where({ id: p.id }).first('undo_plan_hash', 'undo_result')) as
    | { undo_plan_hash: string | null; undo_result: unknown }
    | undefined
  if (typeof i.planHash !== 'string' || !row?.undo_plan_hash || i.planHash !== row.undo_plan_hash)
    throw new ConfigPromotionError('PLAN_CHANGED', 'Preview the undo first, then confirm it.', 409)
  const hashes =
    json<{ hashes?: { engine?: string; procs?: string } }>(row.undo_result, {}).hashes ?? {}
  const n = await names(p)
  if (!n.target) throw new ConfigPromotionError('NOT_FOUND', 'The target environment is gone.', 404)
  const targetKey = n.target.key
  // Every undo is typed (it writes to the target whatever its tier) — never only on production.
  checkConfirm(true, i.confirm, targetKey)
  const where = `${n.app} · ${targetKey}`
  return withEnvLock(x.lock, p.target_environment_id, async () => {
    // Freezes and deploy windows never stop an undo; an open move does (checked under the lock).
    const moving = await x.moveOpen(p.target_environment_id)
    if (moving) throw refusal(moving)
    const claimed = await db(PROMOTIONS)
      .where({ id: p.id, status: 'applied' })
      .update({ status: 'undoing', started_at: new Date(x.now()), undone_by: i.userId })
    if (Number(claimed) !== 1)
      throw new ConfigPromotionError('NOT_UNDOABLE', 'Someone else is undoing this promotion.', 409)
    try {
      const ch = await x.channel(p.target_environment_id)
      const out = (await ch.call('undo', {
        mode: 'apply',
        run_key: p.run_key,
        plan_hash: i.planHash,
        engine_hash: hashes.engine,
        procs_hash: hashes.procs,
        overwrite_prod_changes: i.overwriteProdChanges
      })) as Record<string, unknown> | null
      const result = (out?.result ?? {}) as Record<string, unknown>
      const totals = (result.totals ?? {}) as Record<string, unknown>
      await db(PROMOTIONS)
        .where({ id: p.id })
        .update({
          status: 'undone',
          undone_at: new Date(x.now()),
          undo_result: JSON.stringify({
            totals: {
              inserted: num(totals.inserted),
              updated: num(totals.updated),
              deleted: num(totals.deleted)
            },
            procedures: arr<Record<string, unknown>>(out?.procedures).map((pr) => ({
              name: txt(pr.name, 128),
              ok: pr.ok === true
            }))
          })
        })
      x.notify({
        kind: 'promote_done',
        appId: p.app_id,
        envId: p.target_environment_id,
        path: `/hub/config?promotion=${p.id}`,
        text: {
          subject: `Config promotion undone: ${where}`,
          message: `${targetKey} has the rows promotion #${p.id} wrote put back as they were.`
        }
      })
    } catch (err) {
      const e =
        err instanceof ConfigPromotionError
          ? err
          : new ConfigPromotionError('UNDO_FAILED', 'The undo failed.', 502)
      await db(PROMOTIONS)
        .where({ id: p.id })
        .update({
          status: 'applied',
          error: NO_ANSWER.has(e.code)
            ? 'The Hub lost the target’s answer to the undo: use “Check the target”.'
            : `Undo refused: ${e.message}`.slice(0, 1000),
          undo_plan_hash: null
        })
      throw e
    }
    const done = await getPromotion(p.id, x.now())
    if (!done)
      throw new ConfigPromotionError('NOT_FOUND', 'The promotion could not be read back.', 500)
    return done
  })
}

/** Groups as the plan form offers them. */
export function promotionGroups() {
  return CONFIG_PROMOTION_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    hint: g.hint,
    tables: [...g.tables]
  }))
}
