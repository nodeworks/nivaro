import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import {
  CONFIG_PROMOTION_GROUPS,
  groupOfTable,
  isConfigGroupKey,
  tablesForGroups
} from '../../config-promote-groups.js'
import { type HubEvent, notifyHubEvent } from '../notify-events.js'
import { defaultPromoteLock, lockHolderRefusal, type PromoteLock } from '../promote-lock.js'
import { type ConfigChannel, configChannelFor } from './channel.js'
import {
  type ConfigAction,
  changeWindowRefusal,
  freezeGate,
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
 * another over the hub link / deployment link, with the config restore engine doing the work on
 * the TARGET app (services/hub-link/config-promote.ts). The Hub holds no snapshot: it reads one
 * from the source at plan time and again at apply time; the target's plan hash covers the source
 * rows AND its own live rows, so anything that moved on either side since the plan answers STALE.
 *
 *   plan   source snapshot → target plan (field diff, hash, kept / held rows, Changed-here hits)
 *          → a `planned` row; an older planned row for the same target is `superseded`
 *   apply  admin; plan younger than 24 h; typed confirm (= the environment key) on production;
 *          no open move, no freeze, the change-window seam; the environment lock (holder
 *          `config`); re-read the source, apply bound to the hash → `applied` with the target's
 *          pre-apply restore point (undo), or `stale` / `failed`
 *   undo   preview of that restore point (its own hash) → apply bound to it; exempt from freezes
 *          and change windows (it puts back exactly what was there), never during a move
 *
 * Notices go through notifyHubEvent (promote_done / promote_failed with their own words).
 */

export const PLAN_TTL_MS = 24 * 60 * 60_000
/** An `applying` / `undoing` row whose server stopped reads as interrupted after this. */
export const STUCK_MS = 10 * 60_000
const PLAN_JSON_CAP = 3_000_000

export interface ConfigDeps {
  channel?: (envId: number) => Promise<ConfigChannel>
  lock?: PromoteLock
  freeze?: (envId: number, action: ConfigAction) => Promise<GateRefusal | null>
  window?: (envId: number, action: ConfigAction) => Promise<GateRefusal | null>
  moveOpen?: (envId: number) => Promise<GateRefusal | null>
  production?: (envId: number) => Promise<boolean>
  notify?: (e: HubEvent) => void
  now?: () => number
}

function d(deps: ConfigDeps) {
  return {
    channel: deps.channel ?? configChannelFor,
    lock: deps.lock ?? defaultPromoteLock(),
    freeze: deps.freeze ?? freezeGate,
    window: deps.window ?? changeWindowRefusal,
    moveOpen: deps.moveOpen ?? moveOpenGate,
    production: deps.production ?? isProductionTarget,
    notify: deps.notify ?? notifyHubEvent,
    now: deps.now ?? Date.now
  }
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
    undo_ready: status === 'applied' && r.pre_restore_id != null,
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

/**
 * Pure: a row left `applying` / `undoing` by a server that stopped. An interrupted apply is
 * `interrupted` (the target's own transaction either wrote all of it or none: its restore points
 * say which); an interrupted undo leaves the promotion `applied`.
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
        ? 'The Hub stopped while the target applied this. The target writes all of it or none — look at its restore points (Environments → Config) before planning again.'
        : 'The Hub stopped while undoing this; nothing is known to have changed. Try the undo again.'
    await db(PROMOTIONS)
      .where({ id: p.id, status: p.status })
      .update({ status: next, error, ...(next === 'interrupted' ? { pre_restore_id: null } : {}) })
    out.push({
      ...p,
      status: next,
      error,
      undo_ready: next === 'applied' && p.pre_restore_id != null
    })
  }
  return out
}

export async function listPromotions(appId: number, now = Date.now()): Promise<ConfigPromotion[]> {
  const rows = (await db(PROMOTIONS)
    .where({ app_id: appId })
    .orderBy('id', 'desc')
    .limit(50)
    .select('*')) as Array<Record<string, unknown>>
  return heal(rows.map(promotionFromRow), now)
}

export async function getPromotion(id: number, now = Date.now()): Promise<ConfigPromotion | null> {
  const r = (await db(PROMOTIONS).where({ id }).first()) as Record<string, unknown> | undefined
  if (!r) return null
  return (await heal([promotionFromRow(r)], now))[0]
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
  const hash = txt(preview.plan_hash, 64)
  if (!/^[0-9a-f]{64}$/.test(hash))
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
    }
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

export async function planPromotion(i: PlanInput, deps: ConfigDeps = {}): Promise<ConfigPromotion> {
  const x = d(deps)
  const { source, target, appKey, groups, tables } = await checkPlanInput(i)
  const moving = await x.moveOpen(target.id)
  if (moving) throw new ConfigPromotionError(moving.code, moving.message, moving.status)
  const [src, dst] = await Promise.all([x.channel(source.id), x.channel(target.id)])
  const snap = (await src.call('snapshot', { tables })) as Record<string, unknown> | null
  if (!snap?.snapshot || typeof snap.snapshot !== 'object')
    throw new ConfigPromotionError('BAD_SNAPSHOT', 'The source app answered no snapshot.', 502)
  const answer = (await dst.call('plan', {
    snapshot: snap.snapshot,
    tables,
    deletes: i.deletes,
    allow_cascade: i.allowCascade,
    source_label: `${appKey}/${source.key}`
  })) as Record<string, unknown> | null
  const { view, hash } = planViewOf(answer ?? {})
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

/** The production confirm: the target environment's key, typed. */
function checkConfirm(production: boolean, confirm: unknown, key: string) {
  if (!production) return
  if (typeof confirm !== 'string' || confirm.trim() !== key)
    throw new ConfigPromotionError('CONFIRM_REQUIRED', `Type ${key} to confirm`, 400)
}

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
  try {
    return await fn()
  } finally {
    await lock.release(envId, token)
  }
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
  if (p.plan?.over_cap)
    throw new ConfigPromotionError(
      'OVER_CAP',
      'Too many rows would change at once — promote fewer groups at a time.',
      400
    )
  if (p.plan?.cascade.length && !p.allow_cascade)
    throw new ConfigPromotionError(
      'CASCADE',
      'Removing these rows would also remove or clear rows in other tables — plan again with that allowed.',
      409
    )
  const n = await names(p)
  if (!n.target) throw new ConfigPromotionError('NOT_FOUND', 'The target environment is gone.', 404)
  const targetKey = n.target.key
  const production = await x.production(p.target_environment_id)
  checkConfirm(production, i.confirm, targetKey)
  for (const gate of [
    () => x.moveOpen(p.target_environment_id),
    () => x.freeze(p.target_environment_id, 'config_apply'),
    () => x.window(p.target_environment_id, 'config_apply')
  ]) {
    const r = await gate()
    if (r) throw refusal(r)
  }
  if (p.plan?.prod_only.refuse && !i.overwriteProdChanges)
    throw new ConfigPromotionError(
      'PROD_ONLY_CHANGES',
      `${p.plan.prod_only.count} change(s) made on ${targetKey}, not from promotion, would be overwritten. Mark them as intended there (Environments → Changed here), or confirm overwriting them.`,
      409,
      { lines: p.plan.prod_only.lines }
    )
  const where = `${n.app} · ${targetKey}`
  return withEnvLock(x.lock, p.target_environment_id, async () => {
    const claimed = await db(PROMOTIONS)
      .where({ id: p.id, status: 'planned' })
      .update({
        status: 'applying',
        started_at: new Date(x.now()),
        applied_by: i.userId,
        error: null
      })
    if (Number(claimed) !== 1)
      throw new ConfigPromotionError('NOT_PLANNED', 'Someone else started this promotion.', 409)
    try {
      const [src, dst] = await Promise.all([
        x.channel(p.source_environment_id),
        x.channel(p.target_environment_id)
      ])
      const snap = (await src.call('snapshot', { tables: p.tables })) as Record<
        string,
        unknown
      > | null
      if (!snap?.snapshot || typeof snap.snapshot !== 'object')
        throw new ConfigPromotionError('BAD_SNAPSHOT', 'The source app answered no snapshot.', 502)
      const out = (await dst.call('apply', {
        snapshot: snap.snapshot,
        tables: p.tables,
        deletes: p.deletes,
        allow_cascade: p.allow_cascade,
        plan_hash: p.plan_hash,
        overwrite_prod_changes: i.overwriteProdChanges,
        source_label: `${n.app}/${n.source}`,
        promotion_id: p.id,
        actor: i.actor
      })) as Record<string, unknown> | null
      const result = (out?.result ?? {}) as Record<string, unknown>
      const pre = Number(result.pre_restore_id)
      const totals = (result.totals ?? {}) as Record<string, unknown>
      const summary = {
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
        procedures: out?.procedures ?? null,
        baseline: out?.baseline === 'moved' ? 'moved' : 'unchanged'
      }
      await db(PROMOTIONS)
        .where({ id: p.id })
        .update({
          status: 'applied',
          applied_at: new Date(x.now()),
          pre_restore_id: Number.isSafeInteger(pre) && pre > 0 ? pre : null,
          result: JSON.stringify(summary)
        })
      const t = summary.totals
      x.notify({
        kind: 'promote_done',
        appId: p.app_id,
        envId: p.target_environment_id,
        path: `/hub/config?promotion=${p.id}`,
        text: {
          subject: `Config promoted: ${where}`,
          message: `Configuration from ${n.source} is on ${targetKey}: ${t.inserted} added, ${t.updated} changed, ${t.deleted} removed.`
        }
      })
    } catch (err) {
      const e =
        err instanceof ConfigPromotionError
          ? err
          : new ConfigPromotionError('APPLY_FAILED', 'The config promotion failed.', 502)
      // The plan no longer matches what either side has: a new plan is needed.
      const stale = e.code === 'STALE' || e.code === 'PLAN_HASH_REQUIRED'
      // Refused before anything was written (marks to make, a busy target): the plan still holds.
      const back = e.code === 'PROD_ONLY_CHANGES' || e.code === 'BUSY' || e.code === 'LOCKED'
      await db(PROMOTIONS)
        .where({ id: p.id })
        .update({
          status: back ? 'planned' : stale ? 'stale' : 'failed',
          error: e.message.slice(0, 1000),
          ...(back ? { started_at: null, applied_by: null } : {})
        })
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
              : `Config promotion failed: ${where}`,
            message: stale
              ? `Configuration on ${n.source} or ${targetKey} changed since the plan; nothing was written. Plan it again.`
              : `Nothing was written to ${targetKey}: ${e.message.slice(0, 300)}`
          }
        })
      throw e
    }
    const done = await getPromotion(p.id, x.now())
    if (!done)
      throw new ConfigPromotionError('NOT_FOUND', 'The promotion could not be read back.', 500)
    return done
  })
}

// ── undo ────────────────────────────────────────────────────────────────────

export interface UndoPreview {
  promotion: ConfigPromotion
  plan: PlanView
  plan_hash: string
}

function undoable(p: ConfigPromotion | null): ConfigPromotion {
  if (!p) throw new ConfigPromotionError('NOT_FOUND', 'No such config promotion.', 404)
  if (p.status !== 'applied' || p.pre_restore_id == null)
    throw new ConfigPromotionError(
      'NOT_UNDOABLE',
      p.status === 'undone'
        ? 'This promotion was undone already.'
        : 'Only an applied promotion can be undone.',
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
  const out = (await ch.call('undo', { mode: 'preview', restore_id: p.pre_restore_id })) as Record<
    string,
    unknown
  > | null
  const { view, hash } = planViewOf(out ?? {})
  await db(PROMOTIONS).where({ id: p.id }).update({ undo_plan_hash: hash })
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
  const row = (await db(PROMOTIONS).where({ id: p.id }).first('undo_plan_hash')) as
    | { undo_plan_hash: string | null }
    | undefined
  if (typeof i.planHash !== 'string' || !row?.undo_plan_hash || i.planHash !== row.undo_plan_hash)
    throw new ConfigPromotionError('PLAN_CHANGED', 'Preview the undo first, then confirm it.', 409)
  const n = await names(p)
  if (!n.target) throw new ConfigPromotionError('NOT_FOUND', 'The target environment is gone.', 404)
  const targetKey = n.target.key
  checkConfirm(await x.production(p.target_environment_id), i.confirm, targetKey)
  // An undo puts back exactly what was there: freezes and change windows never stop it.
  const moving = await x.moveOpen(p.target_environment_id)
  if (moving) throw refusal(moving)
  const where = `${n.app} · ${targetKey}`
  return withEnvLock(x.lock, p.target_environment_id, async () => {
    const claimed = await db(PROMOTIONS)
      .where({ id: p.id, status: 'applied' })
      .update({ status: 'undoing', started_at: new Date(x.now()), undone_by: i.userId })
    if (Number(claimed) !== 1)
      throw new ConfigPromotionError('NOT_UNDOABLE', 'Someone else is undoing this promotion.', 409)
    try {
      const ch = await x.channel(p.target_environment_id)
      const out = (await ch.call('undo', {
        mode: 'apply',
        restore_id: p.pre_restore_id,
        plan_hash: i.planHash,
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
            restore_point: num(result.pre_restore_id) || null,
            procedures: out?.procedures ?? null
          })
        })
      x.notify({
        kind: 'promote_done',
        appId: p.app_id,
        envId: p.target_environment_id,
        path: `/hub/config?promotion=${p.id}`,
        text: {
          subject: `Config promotion undone: ${where}`,
          message: `${targetKey} has its configuration from before promotion #${p.id} back.`
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
          error: `Undo: ${e.message}`.slice(0, 1000),
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
