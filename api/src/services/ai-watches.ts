import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { FieldAccessError } from './ai-aggregate-guard.js'
import { judgeAgainstHistory } from './anomaly.js'
import { type DigestSection, registerDigestSection } from './daily-digest.js'
import { evaluateOperator } from './metric-alerts.js'
import { notifyUser } from './notification-channels.js'

/**
 * Watched numbers (#1892, #1987): a figure from an Ask AI answer — an
 * aggregate over a collection and filter — that the person wants to be told
 * about. A watch is re-evaluated AS THE WATCHER on a schedule through the
 * chat's own `aggregate` tool (so RBAC, field checks and the row-filter
 * refusal are the ones the answer was given under), compared the way the
 * metric alert engine compares (operator + threshold, one open "firing" state
 * per watch) or, in trend mode, against the watch's own recent range using the
 * anomaly engine's statistics.
 *
 * Storage is `nivaro_users.preferences.ai_watches` (no table): a person's
 * watches are theirs alone, capped, and travel with the account. Each watch
 * keeps its last 60 values — the series trend mode judges and the digest's
 * "change since yesterday" reads.
 */

export type WatchOp = 'count' | 'sum' | 'avg' | 'min' | 'max'
export type WatchMode = 'threshold' | 'trend'
export type WatchOperator = 'gt' | 'gte' | 'lt' | 'lte'
export type WatchFrequency = 'hourly' | 'daily'

export interface WatchPoint {
  at: string
  v: number
}

export interface AiWatch {
  id: string
  label: string
  collection: string
  op: WatchOp
  field: string | null
  filter: Record<string, unknown> | null
  mode: WatchMode
  operator: WatchOperator
  threshold: number | null
  frequency: WatchFrequency
  /** Trend mode: how many standard deviations count as unusual. */
  sensitivity: number
  active: boolean
  created_at: string
  last_value: number | null
  last_checked_at: string | null
  last_error: string | null
  /** Open alert state: 'firing' until the number is back in range. */
  state: 'ok' | 'firing' | null
  last_alert_at: string | null
  last_alert_text: string | null
  history: WatchPoint[]
}

export const MAX_WATCHES = 20
export const MAX_HISTORY = 60
const OPS: WatchOp[] = ['count', 'sum', 'avg', 'min', 'max']
const OPERATORS: WatchOperator[] = ['gt', 'gte', 'lt', 'lte']
const OPERATOR_WORDS: Record<WatchOperator, string> = {
  gt: 'goes over',
  gte: 'reaches',
  lt: 'drops under',
  lte: 'falls to'
}

export class WatchError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message)
  }
}

// ── pure judgement ────────────────────────────────────────────────────────────

export interface TrendJudgement {
  unusual: boolean
  direction_change: 'up_to_down' | 'down_to_up' | null
  mean: number | null
  stddev: number | null
  zscore: number | null
  /** Fewer than 5 earlier values — the watch is still learning its range. */
  learning: boolean
}

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0)

/**
 * Trend verdict for `current` against the values that came before it: outside
 * the recent range (anomaly engine statistics) and/or a change of direction
 * (two moves one way, then a real move the other).
 */
export function judgeTrend(prior: number[], current: number, sensitivity = 2): TrendJudgement {
  const stat = judgeAgainstHistory(prior, current, sensitivity)
  let direction: TrendJudgement['direction_change'] = null
  if (stat && prior.length >= 4) {
    const s = [...prior, current]
    const n = s.length
    const m1 = s[n - 3] - s[n - 4]
    const m2 = s[n - 2] - s[n - 3]
    const m3 = s[n - 1] - s[n - 2]
    if (sign(m1) !== 0 && sign(m1) === sign(m2) && sign(m3) === -sign(m2)) {
      // A real move, not noise: at least half a standard deviation of the series.
      if (Math.abs(m3) >= Math.max(0.5 * stat.stddev, 1e-9))
        direction = sign(m2) > 0 ? 'up_to_down' : 'down_to_up'
    }
  }
  return {
    unusual: stat?.anomalous ?? false,
    direction_change: direction,
    mean: stat?.mean ?? null,
    stddev: stat?.stddev ?? null,
    zscore: stat?.zscore ?? null,
    learning: !stat
  }
}

const fmt = (n: number) =>
  Number.isInteger(n)
    ? n.toLocaleString('en-US')
    : n.toLocaleString('en-US', { maximumFractionDigits: 2 })

/** True when the number sits within 10% of its threshold without crossing it. */
export function nearThreshold(w: AiWatch, value: number): boolean {
  if (w.mode !== 'threshold' || w.threshold == null || w.threshold === 0) return false
  if (evaluateOperator(w.operator, value, w.threshold)) return false
  return Math.abs(value - w.threshold) <= 0.1 * Math.abs(w.threshold)
}

/** Value now minus the value about a day ago (the latest point at least 20h old). */
export function changeSinceYesterday(w: AiWatch, now: Date): number | null {
  if (w.last_value == null) return null
  const cutoff = now.getTime() - 20 * 3_600_000
  let base: WatchPoint | null = null
  for (const p of w.history) if (new Date(p.at).getTime() <= cutoff) base = p
  return base ? w.last_value - base.v : null
}

export function describeWatch(w: Pick<AiWatch, 'op' | 'field' | 'collection'>): string {
  return `${w.op}${w.field ? ` of ${w.field}` : ''} in ${w.collection}`
}

export function describeRule(w: AiWatch): string {
  if (w.mode === 'trend') return 'tells you when it changes direction or moves unusually'
  return `tells you when it ${OPERATOR_WORDS[w.operator]} ${w.threshold == null ? '…' : fmt(w.threshold)}`
}

/**
 * One check of one watch: record the value, move the firing state, and say
 * whether this check should alert (only on the step INTO firing — a number
 * that stays over its threshold does not re-alert every hour).
 */
export function applyCheck(
  w: AiWatch,
  value: number,
  now: Date
): { watch: AiWatch; alert: string | null } {
  const prior = w.history.map((p) => p.v)
  let breach = false
  let reason = ''
  if (w.mode === 'threshold') {
    breach = w.threshold != null && evaluateOperator(w.operator, value, w.threshold)
    if (breach) reason = `${OPERATOR_WORDS[w.operator]} ${fmt(w.threshold as number)}`
  } else {
    const t = judgeTrend(prior, value, w.sensitivity)
    if (t.direction_change) {
      breach = true
      reason =
        t.direction_change === 'up_to_down'
          ? 'turned downward after rising'
          : 'turned upward after falling'
    } else if (t.unusual && t.mean != null) {
      breach = true
      reason = `is outside its recent range (usually about ${fmt(t.mean)})`
    }
  }
  const stamp = now.toISOString()
  const next: AiWatch = {
    ...w,
    last_value: value,
    last_checked_at: stamp,
    last_error: null,
    history: [...w.history, { at: stamp, v: value }].slice(-MAX_HISTORY),
    state: breach ? 'firing' : 'ok'
  }
  let alert: string | null = null
  if (breach && w.state !== 'firing') {
    alert = `${w.label} is ${fmt(value)} — it ${reason}.`
    next.last_alert_at = stamp
    next.last_alert_text = alert
  }
  return { watch: next, alert }
}

export function isDue(w: AiWatch, now: Date): boolean {
  if (!w.active) return false
  if (!w.last_checked_at) return true
  const gap = now.getTime() - new Date(w.last_checked_at).getTime()
  return gap >= (w.frequency === 'hourly' ? 55 * 60_000 : 23 * 3_600_000)
}

// ── storage ───────────────────────────────────────────────────────────────────

function parsePrefs(raw: unknown): Record<string, unknown> {
  if (raw == null) return {}
  if (typeof raw === 'object') return { ...(raw as Record<string, unknown>) }
  try {
    const p = JSON.parse(String(raw))
    return p && typeof p === 'object' ? p : {}
  } catch {
    return {}
  }
}

async function readPrefs(userId: string): Promise<Record<string, unknown>> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences?: unknown }
    | undefined
  return parsePrefs(row?.preferences)
}

export async function readWatches(userId: string): Promise<AiWatch[]> {
  const prefs = await readPrefs(userId)
  return Array.isArray(prefs.ai_watches) ? (prefs.ai_watches as AiWatch[]) : []
}

/** Fresh read, change, write — a cron tick and an edit never overwrite each other's watch. */
async function mutateWatches(
  userId: string,
  fn: (list: AiWatch[]) => AiWatch[]
): Promise<AiWatch[]> {
  const prefs = await readPrefs(userId)
  const list = Array.isArray(prefs.ai_watches) ? (prefs.ai_watches as AiWatch[]) : []
  const next = fn(list)
  prefs.ai_watches = next
  await db('nivaro_users')
    .where({ id: userId })
    .update({ preferences: JSON.stringify(prefs) })
  return next
}

// ── evaluation ────────────────────────────────────────────────────────────────

export type WatchEvaluator = (user: User, w: AiWatch) => Promise<number>

/** The default evaluator: the chat's aggregate tool, as the watcher. */
export const evaluateWatchValue: WatchEvaluator = async (user, w) => {
  const { executeChatTool } = await import('./ai-chat.js')
  const { result } = await executeChatTool(user, 'aggregate', {
    collection: w.collection,
    op: w.op,
    ...(w.field ? { field: w.field } : {}),
    ...(w.filter ? { filter: w.filter } : {})
  })
  const raw = (result as { value?: unknown } | null)?.value
  const n = raw == null ? (w.op === 'count' ? 0 : Number.NaN) : Number(raw)
  if (!Number.isFinite(n))
    throw new WatchError('That figure has no value yet, so there is nothing to watch.')
  return n
}

let evaluator: WatchEvaluator = evaluateWatchValue
/** Tests swap the data source here. */
export function setWatchEvaluator(fn: WatchEvaluator | null): void {
  evaluator = fn ?? evaluateWatchValue
}

export interface WatchInput {
  label?: unknown
  collection?: unknown
  op?: unknown
  field?: unknown
  filter?: unknown
  mode?: unknown
  operator?: unknown
  threshold?: unknown
  frequency?: unknown
  sensitivity?: unknown
  active?: unknown
}

function cleanThreshold(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) throw new WatchError('The threshold must be a number.')
  return n
}

export async function createWatch(user: User, input: WatchInput): Promise<AiWatch> {
  const collection = typeof input.collection === 'string' ? input.collection : ''
  const op = input.op as WatchOp
  if (!collection) throw new WatchError('collection is required')
  if (!OPS.includes(op)) throw new WatchError('op must be count, sum, avg, min or max')
  const mode: WatchMode = input.mode === 'trend' ? 'trend' : 'threshold'
  const operator = (
    OPERATORS.includes(input.operator as WatchOperator) ? input.operator : 'gt'
  ) as WatchOperator
  const threshold = cleanThreshold(input.threshold)
  if (mode === 'threshold' && threshold == null) throw new WatchError('A threshold is required.')
  const filter =
    input.filter && typeof input.filter === 'object' && !Array.isArray(input.filter)
      ? (input.filter as Record<string, unknown>)
      : null
  const w: AiWatch = {
    id: randomUUID(),
    label: '',
    collection,
    op,
    field: typeof input.field === 'string' && input.field ? input.field : null,
    filter,
    mode,
    operator,
    threshold: mode === 'threshold' ? threshold : null,
    frequency: input.frequency === 'hourly' ? 'hourly' : 'daily',
    sensitivity: Math.min(6, Math.max(1, Number(input.sensitivity) || 2)),
    active: true,
    created_at: new Date().toISOString(),
    last_value: null,
    last_checked_at: null,
    last_error: null,
    state: null,
    last_alert_at: null,
    last_alert_text: null,
    history: []
  }
  w.label =
    (typeof input.label === 'string' && input.label.trim().slice(0, 120)) ||
    describeWatch(w).replace(/^./, (c) => c.toUpperCase())
  // Evaluating IS the validation: unknown collection, field, filter or a
  // row-filtered role all throw here, exactly as the answer's own query would.
  let value: number
  try {
    value = await evaluator(user, w)
  } catch (err) {
    if (err instanceof WatchError) throw err
    throw new WatchError((err as Error).message || 'That figure could not be read.')
  }
  const now = new Date()
  // The first reading never alerts, but it sets the state: already over its
  // threshold reads as firing, so the person is told when it comes back and
  // forth rather than at once for something they just looked at.
  const first = applyCheck({ ...w, state: 'firing' }, value, now).watch
  first.last_alert_at = null
  first.last_alert_text = null
  await mutateWatches(user.id, (list) => {
    if (list.length >= MAX_WATCHES)
      throw new WatchError(`You can watch up to ${MAX_WATCHES} numbers. Stop watching one first.`)
    return [...list, first]
  })
  return first
}

export async function updateWatch(userId: string, id: string, patch: WatchInput): Promise<AiWatch> {
  let out: AiWatch | null = null
  await mutateWatches(userId, (list) =>
    list.map((w) => {
      if (w.id !== id) return w
      const next = { ...w }
      if (typeof patch.label === 'string' && patch.label.trim())
        next.label = patch.label.trim().slice(0, 120)
      if (patch.threshold !== undefined) next.threshold = cleanThreshold(patch.threshold)
      if (OPERATORS.includes(patch.operator as WatchOperator))
        next.operator = patch.operator as WatchOperator
      if (patch.mode === 'trend' || patch.mode === 'threshold') next.mode = patch.mode
      if (patch.frequency === 'hourly' || patch.frequency === 'daily')
        next.frequency = patch.frequency
      if (patch.sensitivity !== undefined)
        next.sensitivity = Math.min(6, Math.max(1, Number(patch.sensitivity) || 2))
      if (typeof patch.active === 'boolean') next.active = patch.active
      if (next.mode === 'threshold' && next.threshold == null)
        throw new WatchError('A threshold is required.')
      // A changed rule starts clean: re-judge the next check instead of
      // staying "firing" for a threshold that no longer exists.
      if (patch.threshold !== undefined || patch.operator !== undefined || patch.mode !== undefined)
        next.state = null
      out = next
      return next
    })
  )
  if (!out) throw new WatchError('Watch not found', 404)
  return out
}

export async function deleteWatch(userId: string, id: string): Promise<void> {
  let found = false
  await mutateWatches(userId, (list) => {
    const next = list.filter((w) => w.id !== id)
    found = next.length !== list.length
    return next
  })
  if (!found) throw new WatchError('Watch not found', 404)
}

async function loadUser(userId: string): Promise<User | null> {
  const row = (await db('nivaro_users').where({ id: userId }).first()) as
    | (User & { is_redacted?: unknown })
    | undefined
  if (!row || row.status !== 'active' || row.is_redacted) return null
  return { ...row, preferences: parsePrefs(row.preferences) } as User
}

export interface CheckOutcome {
  watch: AiWatch
  alert: string | null
}

/** Check one watch now (the "check now" button and the cron share this). */
export async function checkWatch(
  app: FastifyInstance | null,
  user: User,
  id: string,
  opts: { notify?: boolean; now?: Date } = {}
): Promise<CheckOutcome> {
  const current = (await readWatches(user.id)).find((w) => w.id === id)
  if (!current) throw new WatchError('Watch not found', 404)
  const now = opts.now ?? new Date()
  let outcome: CheckOutcome
  try {
    const value = await evaluator(user, current)
    outcome = applyCheck(current, value, now)
  } catch (err) {
    // A field the owner can no longer read fails closed: no value, no alert,
    // and the watch pauses with the reason instead of retrying every hour.
    const denied = err instanceof FieldAccessError
    outcome = {
      watch: {
        ...current,
        ...(denied ? { active: false } : {}),
        last_checked_at: now.toISOString(),
        last_error: ((err as Error).message || 'Could not be read').slice(0, 300)
      },
      alert: null
    }
  }
  await mutateWatches(user.id, (list) => list.map((w) => (w.id === id ? outcome.watch : w)))
  if (outcome.alert && opts.notify !== false && app) {
    await notifyUser(app, user.id, {
      subject: `Watched number: ${outcome.watch.label}`,
      message: outcome.alert,
      category: 'alerts',
      target: { kind: 'alerts' }
    }).catch(() => undefined)
  }
  return outcome
}

/**
 * The scheduled pass: every active person's due watches, each evaluated as
 * that person. Errors stay on the watch (`last_error`) — one bad figure never
 * stops the others.
 */
export async function runWatchChecks(
  app: FastifyInstance,
  opts: { dryRun?: boolean; now?: Date } = {}
): Promise<{ users: number; due: number; checked: number; alerts: number }> {
  const now = opts.now ?? new Date()
  const rows = (await db('nivaro_users')
    .where('status', 'active')
    .where('preferences', 'like', '%ai_watches%')
    .select('id')) as Array<{ id: string }>
  let due = 0
  let checked = 0
  let alerts = 0
  for (const r of rows) {
    const watches = await readWatches(r.id)
    const mine = watches.filter((w) => isDue(w, now))
    if (!mine.length) continue
    due += mine.length
    if (opts.dryRun) continue
    const user = await loadUser(r.id)
    if (!user) continue
    for (const w of mine) {
      const o = await checkWatch(app, user, w.id, { now })
      checked += 1
      if (o.alert) alerts += 1
    }
  }
  return { users: rows.length, due, checked, alerts }
}

// ── read models ───────────────────────────────────────────────────────────────

export interface WatchSummary {
  id: string
  label: string
  what: string
  rule: string
  mode: WatchMode
  operator: WatchOperator
  threshold: number | null
  frequency: WatchFrequency
  active: boolean
  value: number | null
  change_since_yesterday: number | null
  near_threshold: boolean
  state: AiWatch['state']
  last_checked_at: string | null
  last_error: string | null
  last_alert_at: string | null
  last_alert_text: string | null
  history: number[]
}

export function summariseWatch(w: AiWatch, now = new Date()): WatchSummary {
  return {
    id: w.id,
    label: w.label,
    what: describeWatch(w),
    rule: describeRule(w),
    mode: w.mode,
    operator: w.operator,
    threshold: w.threshold,
    frequency: w.frequency,
    active: w.active,
    value: w.last_value,
    change_since_yesterday: changeSinceYesterday(w, now),
    near_threshold: w.last_value != null && nearThreshold(w, w.last_value),
    state: w.state,
    last_checked_at: w.last_checked_at,
    last_error: w.last_error,
    last_alert_at: w.last_alert_at,
    last_alert_text: w.last_alert_text,
    history: w.history.map((p) => p.v)
  }
}

export async function listWatchSummaries(userId: string): Promise<WatchSummary[]> {
  const now = new Date()
  return (await readWatches(userId)).map((w) => summariseWatch(w, now))
}

// ── daily digest ──────────────────────────────────────────────────────────────

const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmt(Math.abs(n))}`

/** One digest line for a watch: value, change since yesterday, and whether it is close. */
export function digestLine(w: AiWatch, now = new Date()): string {
  const s = summariseWatch(w, now)
  const parts: string[] = [s.value == null ? 'not read yet' : fmt(s.value)]
  if (s.change_since_yesterday != null)
    parts.push(`${signed(s.change_since_yesterday)} since yesterday`)
  if (s.state === 'firing') parts.push('alerting now')
  else if (s.near_threshold && s.threshold != null) parts.push(`close to ${fmt(s.threshold)}`)
  return `${w.label}: ${parts.join(' · ')}`
}

let digestRegistered = false
/** The daily summary lists each active watch. */
export function registerWatchDigest(): void {
  if (digestRegistered) return
  digestRegistered = true
  registerDigestSection(async (userId): Promise<DigestSection | null> => {
    const mine = (await readWatches(userId)).filter((w) => w.active)
    if (!mine.length) return null
    const now = new Date()
    return {
      title: `Numbers you watch (${mine.length})`,
      lines: mine.map((w) => ({ text: digestLine(w, now), sub: null, url: '/ask' }))
    }
  })
}
