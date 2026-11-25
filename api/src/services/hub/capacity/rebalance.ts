import { db } from '../../../db/index.js'
import { readApp } from '../apps.js'
import { DEFAULT_POOL_MAX } from '../drivers.js'
import { OPEN_MOVE_STATUSES, readMove } from '../move/rows.js'
import { MoveError, planFor, startMove } from '../move/run.js'
import type { MovePlan } from '../move/types.js'
import { openMoveFor } from '../move-open.js'
import { getShared, type SharedDeployment } from '../shared/store.js'
import { type SharedTenantRow, tenantsOf } from '../shared/tenants.js'
import { DAY_MS } from './overview.js'
import { type CapacitySample, REBALANCES, samplesSince } from './store.js'

/**
 * Nivaro Hub rebalance (idea 16): across two or more shared deployments, plan the moves that even
 * out their load (from the capacity samples of the last 7 days), then run them ONE AT A TIME, each
 * a normal move through the move engine (services/hub/move/run.ts startMove: its plan hash, its
 * locks, its checklist and every safety rule unchanged), starting a move only inside the chosen
 * quiet window, and stopping at the first move that does not end in success.
 *
 * Load of an app = its mean answering time per minute (busy ms/min) over 7 days, else its mean
 * requests/min; a deployment's load = the sum of its apps'. Deployments are weighed as equals
 * (the Hub does not know their hardware). The planner moves, while it helps, the app from the
 * busiest deployment to the quietest whose load is nearest half the gap between them, never an
 * app with an open move, never one that is not active, never past the target's connection budget,
 * each app at most once, at most MAX_MOVES moves, and stops when the gap is under 10% of the mean.
 *
 * Each planned move is then planned by the move planner itself. A move with blockers, or whose
 * names change by hand (manual routing needs a person in the middle), cannot run in a rebalance:
 * it is shown and left out. The person ticks each move's required checklist items and confirms;
 * a move whose plan changed by its turn (409 PLAN_CHANGED) stops the rebalance like any failure.
 *
 * Runs: `hub-rebalance-tick` (every minute, the cron leader) advances each open run — waits while
 * its move is open, moves on after a success, stops after any other end, starts the next move
 * when the window is open. Cancel stops before the next move; a move already running is never
 * cancelled by the rebalance (cancel it on its own panel).
 */

export const MAX_MOVES = 10
const ENVS = 'nivaro_hub_environments'

export interface BalanceApp {
  env_id: number
  label: string
  load: number
  pool: number
  movable: boolean
  why_not?: string
}

export interface BalanceDeployment {
  id: number
  key: string
  pool_budget: number
  apps: BalanceApp[]
}

export interface PlannedMove {
  env_id: number
  label: string
  from_shared_id: number
  to_shared_id: number
  load: number
  pool: number
}

/** The moves that even out the deployments' load (pure). */
export function balanceMoves(
  deployments: BalanceDeployment[],
  maxMoves = 5
): { moves: PlannedMove[]; before: Record<number, number>; after: Record<number, number> } {
  const load = new Map(deployments.map((d) => [d.id, d.apps.reduce((a, x) => a + x.load, 0)]))
  const pool = new Map(deployments.map((d) => [d.id, d.apps.reduce((a, x) => a + x.pool, 0)]))
  const before = Object.fromEntries(load)
  const where = new Map<number, number>()
  const apps = new Map<number, BalanceApp>()
  for (const d of deployments)
    for (const a of d.apps) {
      where.set(a.env_id, d.id)
      apps.set(a.env_id, a)
    }
  const moved = new Set<number>()
  const moves: PlannedMove[] = []
  const byId = new Map(deployments.map((d) => [d.id, d]))
  while (moves.length < Math.min(maxMoves, MAX_MOVES) && deployments.length >= 2) {
    const sorted = [...deployments].sort((a, b) => (load.get(b.id) ?? 0) - (load.get(a.id) ?? 0))
    const hi = sorted[0]
    const total = [...load.values()].reduce((a, b) => a + b, 0)
    const mean = total / deployments.length
    const gapOf = (lo: BalanceDeployment) => (load.get(hi.id) ?? 0) - (load.get(lo.id) ?? 0)
    if (mean <= 0 || gapOf(sorted[sorted.length - 1]) < mean * 0.1) break
    let best: { app: BalanceApp; lo: BalanceDeployment; score: number } | null = null
    // The quietest deployment first; another quiet one when the quietest has no room.
    for (const lo of [...sorted].reverse()) {
      if (lo.id === hi.id) continue
      const gap = gapOf(lo)
      if (gap < mean * 0.1) continue
      for (const [envId, depId] of where) {
        if (depId !== hi.id || moved.has(envId)) continue
        const a = apps.get(envId) as BalanceApp
        if (!a.movable || a.load <= 0 || a.load >= gap) continue
        if ((pool.get(lo.id) ?? 0) + a.pool > (byId.get(lo.id)?.pool_budget ?? 0)) continue
        const score = Math.abs(a.load - gap / 2)
        if (!best || score < best.score) best = { app: a, lo, score }
      }
      if (best) break
    }
    if (!best) break
    const { app, lo } = best
    load.set(hi.id, (load.get(hi.id) ?? 0) - app.load)
    load.set(lo.id, (load.get(lo.id) ?? 0) + app.load)
    pool.set(hi.id, (pool.get(hi.id) ?? 0) - app.pool)
    pool.set(lo.id, (pool.get(lo.id) ?? 0) + app.pool)
    where.set(app.env_id, lo.id)
    moved.add(app.env_id)
    moves.push({
      env_id: app.env_id,
      label: app.label,
      from_shared_id: hi.id,
      to_shared_id: lo.id,
      load: app.load,
      pool: app.pool
    })
  }
  return { moves, before, after: Object.fromEntries(load) }
}

const mean = (xs: Array<number | null>): number | null => {
  const real = xs.filter((x): x is number => typeof x === 'number')
  return real.length ? real.reduce((a, b) => a + b, 0) / real.length : null
}

/** An app's load from its samples: mean busy ms/min, else mean requests/min. */
export function loadOf(rows: CapacitySample[]): number {
  const busy = mean(rows.map((r) => r.busy_ms_per_min))
  if (busy !== null && busy > 0) return Math.round(busy)
  return Math.round(mean(rows.map((r) => r.requests_per_min)) ?? 0)
}

// ─── planning with the move planner ──────────────────────────────────────────

export interface RebalanceMovePlan extends PlannedMove {
  plan_hash: string | null
  checklist: MovePlan['checklist']
  blockers: MovePlan['blockers']
  routing: MovePlan['routing'] | null
  /** Why it cannot run in a rebalance (blockers, manual routing, a planner refusal); null = it can. */
  cannot_run: string | null
}

export interface RebalanceProposal {
  shared: { id: number; key: string; load_before: number; load_after: number }[]
  moves: RebalanceMovePlan[]
  /** Apps left where they are, and why (an open move, not active …). */
  held: { env_id: number; label: string; why: string }[]
}

export class RebalanceError extends Error {
  code: string
  statusCode: number
  constructor(code: string, message: string, statusCode = 400) {
    super(message)
    this.name = 'RebalanceError'
    this.code = code
    this.statusCode = statusCode
  }
}

export interface RebalanceDeps {
  getShared?: (id: number) => Promise<SharedDeployment | null>
  tenantsOf?: (s: SharedDeployment) => Promise<SharedTenantRow[]>
  samples?: (since: Date, sharedIds: number[]) => Promise<CapacitySample[]>
  planFor?: (envId: number, to: unknown) => Promise<MovePlan>
  openMove?: (envId: number) => Promise<boolean>
  now?: () => Date
}

function checkSharedIds(raw: unknown): number[] {
  const ids = Array.isArray(raw)
    ? [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : []
  if (ids.length < 2 || ids.length > 10)
    throw new RebalanceError('BAD_SHARED', 'Pick two to ten shared deployments to rebalance.')
  return ids
}

/** The proposal: which moves even out the deployments, each planned by the move planner. */
export async function planRebalance(
  rawSharedIds: unknown,
  rawMaxMoves: unknown,
  deps: RebalanceDeps = {}
): Promise<RebalanceProposal> {
  const ids = checkSharedIds(rawSharedIds)
  const maxMoves =
    typeof rawMaxMoves === 'number' && Number.isInteger(rawMaxMoves)
      ? Math.min(MAX_MOVES, Math.max(1, rawMaxMoves))
      : 5
  const now = (deps.now ?? (() => new Date()))()
  const shareds: SharedDeployment[] = []
  for (const id of ids) {
    const s = await (deps.getShared ?? getShared)(id)
    if (!s) throw new RebalanceError('NOT_FOUND', `No shared deployment ${id}.`, 404)
    if (s.status !== 'active')
      throw new RebalanceError(
        'SHARED_NOT_ACTIVE',
        `${s.key} is ${s.status}: only active shared deployments are rebalanced.`,
        409
      )
    shareds.push(s)
  }
  const samples = await (
    deps.samples ?? ((since, sids) => samplesSince(since, { sharedIds: sids }))
  )(new Date(now.getTime() - 7 * DAY_MS), ids)
  const held: RebalanceProposal['held'] = []
  const deployments: BalanceDeployment[] = []
  for (const s of shareds) {
    const tenants = await (deps.tenantsOf ?? tenantsOf)(s)
    const apps: BalanceApp[] = []
    for (const t of tenants) {
      const label = `${t.app.key}/${t.env.key}`
      const rows = samples.filter(
        (r) =>
          r.scope === 'environment' &&
          r.environment_id === t.env.id &&
          r.shared_deployment_id === s.id
      )
      const poolMax = (t.placement.target as { pool_max?: unknown } | null)?.pool_max
      const pool = typeof poolMax === 'number' ? poolMax : DEFAULT_POOL_MAX
      let why: string | null = null
      if (!t.placedHere) why = 'A move into or out of this deployment is under way.'
      else if (t.env.status !== 'active') why = `The environment is ${t.env.status}.`
      else if (await (deps.openMove ?? defaultOpenMove)(t.env.id))
        why = 'The environment has an open move.'
      if (why) held.push({ env_id: t.env.id, label, why })
      apps.push({ env_id: t.env.id, label, load: loadOf(rows), pool, movable: !why })
    }
    deployments.push({ id: s.id, key: s.key, pool_budget: s.pool_budget, apps })
  }
  const { moves, before, after } = balanceMoves(deployments, maxMoves)
  const planned: RebalanceMovePlan[] = []
  for (const m of moves) {
    try {
      const plan = await (deps.planFor ?? ((e, to) => planFor(e, to)))(m.env_id, {
        kind: 'shared',
        shared_id: m.to_shared_id,
        pool_max: m.pool
      })
      planned.push({
        ...m,
        plan_hash: plan.plan_hash,
        checklist: plan.checklist,
        blockers: plan.blockers,
        routing: plan.routing,
        cannot_run: plan.blockers.length
          ? `The move planner refuses it: ${plan.blockers.map((b) => b.code).join(', ')}.`
          : plan.routing === 'manual'
            ? 'Its names change by hand (manual routing): move it on its own.'
            : null
      })
    } catch (err) {
      planned.push({
        ...m,
        plan_hash: null,
        checklist: [],
        blockers: [],
        routing: null,
        cannot_run:
          err instanceof MoveError
            ? `The move planner refused: ${err.message}`
            : 'The move could not be planned.'
      })
    }
  }
  return {
    shared: shareds.map((s) => ({
      id: s.id,
      key: s.key,
      load_before: before[s.id] ?? 0,
      load_after: after[s.id] ?? 0
    })),
    moves: planned,
    held
  }
}

async function defaultOpenMove(envId: number): Promise<boolean> {
  return !!(await openMoveFor({ envIds: [envId] }))
}

// ─── the stored run ──────────────────────────────────────────────────────────

export type RebalanceStatus = 'running' | 'cancelling' | 'success' | 'failed' | 'cancelled'

export interface RebalanceMove {
  env_id: number
  label: string
  from_shared_id: number
  to_shared_id: number
  pool_max: number
  plan_hash: string
  checklist: Record<string, boolean>
  /** Filled as it runs. */
  move_id: number | null
  result: 'pending' | 'running' | 'success' | 'failed' | 'skipped'
}

export interface RebalanceRow {
  id: number
  status: RebalanceStatus
  shared_ids: number[]
  moves: RebalanceMove[]
  window_start: string
  window_end: string
  window_tz: string
  current_index: number
  current_move_id: number | null
  note: string | null
  error: string | null
  created_by: string | null
  created_at: string | null
  started_at: string | null
  finished_at: string | null
  heartbeat_at: string | null
}

const parseJson = <T>(v: unknown, dflt: T): T => {
  try {
    return typeof v === 'string' ? (JSON.parse(v) as T) : ((v as T) ?? dflt)
  } catch {
    return dflt
  }
}
const iso = (v: unknown) =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString()

export function rebalanceFromRow(r: Record<string, unknown>): RebalanceRow {
  return {
    id: Number(r.id),
    status: String(r.status) as RebalanceStatus,
    shared_ids: parseJson<number[]>(r.shared_ids, []),
    moves: parseJson<RebalanceMove[]>(r.moves, []),
    window_start: String(r.window_start),
    window_end: String(r.window_end),
    window_tz: String(r.window_tz),
    current_index: Number(r.current_index ?? 0),
    current_move_id: r.current_move_id == null ? null : Number(r.current_move_id),
    note: r.note == null ? null : String(r.note),
    error: r.error == null ? null : String(r.error),
    created_by: r.created_by == null ? null : String(r.created_by),
    created_at: iso(r.created_at),
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    heartbeat_at: iso(r.heartbeat_at)
  }
}

export async function listRebalances(limit = 20): Promise<RebalanceRow[]> {
  const rows = (await db(REBALANCES).orderBy('id', 'desc').limit(limit)) as Record<
    string,
    unknown
  >[]
  return rows.map(rebalanceFromRow)
}

export async function readRebalance(id: number): Promise<RebalanceRow | null> {
  const r = (await db(REBALANCES).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? rebalanceFromRow(r) : null
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** A usable IANA zone name, or null. */
export function validZone(z: unknown): string | null {
  const v = typeof z === 'string' ? z.trim() : ''
  if (!v || v.length > 64) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v })
    return v
  } catch {
    return null
  }
}

/** Whether `now` falls in the window [start, end) of the zone; a window past midnight wraps. */
export function inWindow(now: Date, start: string, end: string, tz: string): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  const at = h * 60 + m
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const s = sh * 60 + sm
  const e = eh * 60 + em
  if (s === e) return true // the whole day
  return s < e ? at >= s && at < e : at >= s || at < e
}

export interface StartRebalanceBody {
  shared_ids: unknown
  moves: unknown
  window: unknown
  confirm: unknown
}

export const REBALANCE_CONFIRM = 'rebalance'

/** Checks a start body and stores the run (status running). Answers its id. */
export async function createRebalance(
  body: StartRebalanceBody,
  by: string,
  deps: { openMove?: (envId: number) => Promise<boolean> } = {}
): Promise<number> {
  const ids = checkSharedIds(body.shared_ids)
  if (body.confirm !== REBALANCE_CONFIRM)
    throw new RebalanceError('CONFIRM_MISMATCH', `Type ${REBALANCE_CONFIRM} to start.`)
  const w = (body.window && typeof body.window === 'object' ? body.window : {}) as Record<
    string,
    unknown
  >
  const tz = validZone(w.tz)
  if (
    typeof w.start !== 'string' ||
    !HHMM.test(w.start) ||
    typeof w.end !== 'string' ||
    !HHMM.test(w.end) ||
    !tz
  )
    throw new RebalanceError(
      'BAD_WINDOW',
      'The quiet window needs a start and an end (HH:MM) and a time zone.'
    )
  const raw = Array.isArray(body.moves) ? body.moves : []
  if (!raw.length || raw.length > MAX_MOVES)
    throw new RebalanceError('BAD_MOVES', `A rebalance runs 1 to ${MAX_MOVES} moves.`)
  const moves: RebalanceMove[] = []
  const seen = new Set<number>()
  for (const m of raw as Record<string, unknown>[]) {
    const env = Number(m?.env_id)
    const to = Number(m?.to_shared_id)
    const pool = m?.pool_max == null ? DEFAULT_POOL_MAX : Number(m.pool_max)
    if (!Number.isInteger(env) || env < 1 || seen.has(env))
      throw new RebalanceError('BAD_MOVES', 'Each move names a different environment.')
    if (!ids.includes(to))
      throw new RebalanceError('BAD_MOVES', 'A move goes to one of the deployments rebalanced.')
    if (!Number.isInteger(pool) || pool < 2 || pool > 20)
      throw new RebalanceError('BAD_MOVES', 'pool_max must be 2 to 20 connections.')
    if (typeof m.plan_hash !== 'string' || !/^[0-9a-f]{16,128}$/i.test(m.plan_hash))
      throw new RebalanceError('BAD_MOVES', 'Each move carries the hash of the plan you checked.')
    const checklist: Record<string, boolean> = {}
    if (m.checklist && typeof m.checklist === 'object' && !Array.isArray(m.checklist))
      for (const [k, v] of Object.entries(m.checklist as Record<string, unknown>))
        if (/^[a-z][a-z0-9_]{0,63}$/.test(k) && typeof v === 'boolean') checklist[k] = v
    const envRow = (await db(ENVS)
      .where({ id: env })
      .first('id', 'key', 'app_id', 'placement_id')) as
      | { id: number; key: string; app_id: number; placement_id: number | null }
      | undefined
    if (!envRow) throw new RebalanceError('NOT_FOUND', `No environment ${env}.`, 404)
    const app = await readApp(Number(envRow.app_id))
    const from = envRow.placement_id
      ? ((await db('nivaro_hub_placements')
          .where({ id: envRow.placement_id })
          .first('shared_deployment_id')) as { shared_deployment_id: number | null } | undefined)
      : undefined
    const fromShared = from?.shared_deployment_id == null ? null : Number(from.shared_deployment_id)
    if (fromShared === null || !ids.includes(fromShared) || fromShared === to)
      throw new RebalanceError(
        'BAD_MOVES',
        `${app?.key ?? '?'}/${envRow.key} is not on one of the other deployments rebalanced.`
      )
    if (await (deps.openMove ?? defaultOpenMove)(env))
      throw new RebalanceError(
        'MOVE_OPEN',
        `${app?.key ?? '?'}/${envRow.key} has an open move.`,
        409
      )
    seen.add(env)
    moves.push({
      env_id: env,
      label: `${app?.key ?? '?'}/${envRow.key}`,
      from_shared_id: fromShared,
      to_shared_id: to,
      pool_max: pool,
      plan_hash: m.plan_hash,
      checklist,
      move_id: null,
      result: 'pending'
    })
  }
  // One open rebalance per deployment: two would plan against each other.
  const open = (await db(REBALANCES).whereIn('status', ['running', 'cancelling'])) as Record<
    string,
    unknown
  >[]
  for (const o of open.map(rebalanceFromRow))
    if (o.shared_ids.some((s) => ids.includes(s)))
      throw new RebalanceError(
        'REBALANCE_OPEN',
        `Rebalance ${o.id} already runs over one of these deployments.`,
        409
      )
  const now = new Date()
  const [row] = await db(REBALANCES)
    .insert({
      status: 'running',
      shared_ids: JSON.stringify(ids),
      moves: JSON.stringify(moves),
      window_start: w.start,
      window_end: w.end,
      window_tz: tz,
      current_index: 0,
      created_by: /^[0-9a-f-]{36}$/i.test(by) ? by : null,
      created_at: now,
      started_at: now,
      heartbeat_at: now,
      note: 'Waiting for the quiet window.'
    })
    .returning('id')
  const id =
    typeof row === 'object' && row !== null ? Number((row as { id: unknown }).id) : Number(row)
  if (Number.isFinite(id) && id > 0) return id
  const last = (await db(REBALANCES).orderBy('id', 'desc').first('id')) as { id: number }
  return Number(last.id)
}

/** Asks a run to stop before its next move. A move already running is left to finish. */
export async function cancelRebalance(id: number): Promise<RebalanceRow> {
  const r = await readRebalance(id)
  if (!r) throw new RebalanceError('NOT_FOUND', 'No such rebalance.', 404)
  if (r.status !== 'running' && r.status !== 'cancelling')
    throw new RebalanceError('ENDED', 'This rebalance has already ended.', 409)
  const busy = r.current_move_id !== null
  await db(REBALANCES)
    .where({ id, status: r.status })
    .update(
      busy
        ? { status: 'cancelling', note: 'Stopping after the move under way ends.' }
        : { status: 'cancelled', finished_at: new Date(), note: 'Cancelled.' }
    )
  return (await readRebalance(id)) as RebalanceRow
}

// ─── the tick ────────────────────────────────────────────────────────────────

export interface TickDeps {
  now?: () => Date
  moveStatus?: (moveId: number) => Promise<string | null>
  start?: (envId: number, body: unknown, by: string) => Promise<{ move_id: number }>
  confirmText?: (envId: number) => Promise<string | null>
}

async function defaultConfirm(envId: number): Promise<string | null> {
  const env = (await db(ENVS).where({ id: envId }).first('key', 'app_id')) as
    | { key: string; app_id: number }
    | undefined
  if (!env) return null
  const app = await readApp(Number(env.app_id))
  return app ? `${app.key}/${env.key}` : null
}

/** Writes the run's moves, index and status — only when nobody moved it on meanwhile. */
async function advance(
  r: RebalanceRow,
  patch: Partial<Record<string, unknown>>,
  moves: RebalanceMove[]
): Promise<boolean> {
  const n = await db(REBALANCES)
    .where({ id: r.id, status: r.status, current_index: r.current_index })
    .update({ ...patch, moves: JSON.stringify(moves), heartbeat_at: new Date() })
  return Number(n) > 0
}

/** One step of one open run. Answers what it did (for the job's log and tests). */
export async function tickRebalance(r: RebalanceRow, deps: TickDeps = {}): Promise<string> {
  const now = (deps.now ?? (() => new Date()))()
  const moves = r.moves.map((m) => ({ ...m }))
  if (r.current_move_id !== null) {
    const status = await (
      deps.moveStatus ?? (async (id: number) => (await readMove(id))?.status ?? null)
    )(r.current_move_id)
    const cur = moves[r.current_index]
    if (status && (OPEN_MOVE_STATUSES as readonly string[]).includes(status)) {
      await db(REBALANCES).where({ id: r.id }).update({ heartbeat_at: new Date() })
      return 'waiting-move'
    }
    if (status === 'success') {
      if (cur) cur.result = 'success'
      const next = r.current_index + 1
      const done = next >= moves.length
      const ending = done || r.status === 'cancelling'
      await advance(
        r,
        {
          current_index: next,
          current_move_id: null,
          ...(ending
            ? {
                status: done ? 'success' : 'cancelled',
                finished_at: new Date(),
                note: done ? 'Every move ended in success.' : 'Cancelled after the move under way.'
              }
            : {
                note: `${cur?.label ?? 'A move'} moved. Next move at the next minute in the window.`
              })
        },
        moves
      )
      return done ? 'success' : ending ? 'cancelled' : 'moved'
    }
    if (cur) cur.result = 'failed'
    await advance(
      r,
      {
        status: 'failed',
        finished_at: new Date(),
        error: `Move ${r.current_move_id} of ${cur?.label ?? 'an environment'} ended ${status ?? 'unreadable'}; the rebalance stopped there.`
      },
      moves
    )
    return 'failed'
  }
  if (r.status === 'cancelling') {
    await advance(r, { status: 'cancelled', finished_at: new Date(), note: 'Cancelled.' }, moves)
    return 'cancelled'
  }
  if (r.current_index >= moves.length) {
    await advance(r, { status: 'success', finished_at: new Date() }, moves)
    return 'success'
  }
  if (!inWindow(now, r.window_start, r.window_end, r.window_tz)) {
    await db(REBALANCES)
      .where({ id: r.id })
      .update({ heartbeat_at: new Date(), note: 'Waiting for the quiet window.' })
    return 'outside-window'
  }
  const m = moves[r.current_index]
  const confirm = await (deps.confirmText ?? defaultConfirm)(m.env_id)
  if (!confirm) {
    m.result = 'failed'
    await advance(
      r,
      { status: 'failed', finished_at: new Date(), error: `${m.label}: the environment is gone.` },
      moves
    )
    return 'failed'
  }
  try {
    const out = await (
      deps.start ??
      ((env: number, body: unknown, by: string) =>
        startMove(env, body as Parameters<typeof startMove>[1], by))
    )(
      m.env_id,
      {
        to: { kind: 'shared', shared_id: m.to_shared_id, pool_max: m.pool_max },
        plan_hash: m.plan_hash,
        confirm,
        checklist: m.checklist,
        overrides: []
      },
      r.created_by ?? ''
    )
    m.move_id = out.move_id
    m.result = 'running'
    await advance(
      r,
      { current_move_id: out.move_id, note: `Moving ${m.label} (move ${out.move_id}).` },
      moves
    )
    return 'started'
  } catch (err) {
    m.result = 'failed'
    const text =
      err instanceof MoveError
        ? `${m.label}: ${err.code} — ${err.message}`
        : `${m.label}: the move could not start.`
    await advance(
      r,
      { status: 'failed', finished_at: new Date(), error: text.slice(0, 1000) },
      moves
    )
    return 'failed'
  }
}

/** Every open run, one step each (the `hub-rebalance-tick` job). */
export async function tickRebalances(deps: TickDeps = {}): Promise<string[]> {
  const rows = (await db(REBALANCES)
    .whereIn('status', ['running', 'cancelling'])
    .orderBy('id')) as Record<string, unknown>[]
  const out: string[] = []
  for (const r of rows.map(rebalanceFromRow)) {
    try {
      out.push(`${r.id}:${await tickRebalance(r, deps)}`)
    } catch {
      out.push(`${r.id}:error`)
    }
  }
  return out
}
