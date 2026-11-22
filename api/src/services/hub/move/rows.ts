import { db } from '../../../db/index.js'
import type { PullStatus } from '../shared/deployment-client.js'
import type { MovePlan, MoveStepKey, RouteAction } from './types.js'

export type MoveChecklistItem = MovePlan['checklist'][number]

/**
 * Nivaro Hub phase 6, Task 16: a move as stored in nivaro_hub_moves (migration 553) and the few
 * writes every part of the run shares. No secret is ever stored here: the plan, the steps, the
 * file counts and the checklist are names, counts and sentences.
 *
 * Status (`status`):
 *   running       a runner works on it (forward, or undoing — `steps.phase`)
 *   waiting       a manual route is awaited (the runner lives and heartbeats)
 *   interrupted   its runner stopped (heartbeat > 2 min old): Resume or Roll back
 *   success | rolled_back | cancelled | failed   ended
 * Open = running | waiting | interrupted (the set tenants.ts and place.ts read).
 */

export const MOVES = 'nivaro_hub_moves'

export type MoveStatus =
  | 'planned'
  | 'running'
  | 'waiting'
  | 'interrupted'
  | 'success'
  | 'rolled_back'
  | 'cancelled'
  | 'failed'

export const OPEN_MOVE_STATUSES: readonly MoveStatus[] = ['running', 'waiting', 'interrupted']
export const ENDED_MOVE_STATUSES: readonly MoveStatus[] = [
  'success',
  'rolled_back',
  'cancelled',
  'failed'
]

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'undone' | 'undo_failed'

export interface MoveStepEntry {
  key: MoveStepKey
  state: StepState
  started_at?: string | null
  finished_at?: string | null
  /** A plain sentence (never a value). */
  note?: string | null
}

/** The `steps` column: the list, which way the run goes, and the run's own bookkeeping. */
export interface MoveSteps {
  list: MoveStepEntry[]
  phase: 'forward' | 'rollback'
  /** Why the run turned back: a failure (→ rolled_back) or a cancel (→ cancelled). */
  undo_reason?: 'failed' | 'cancelled' | null
  /**
   * Route actions recorded as intents (indexes into plan.route), written BEFORE each apply: a
   * rollback undoes every one of them, idempotently, applied, half applied or not converged.
   */
  routed?: number[]
  /** Route actions whose apply returned (a resume skips them). */
  route_done?: number[]
  /** The move made the target placement (to a shared deployment) and removes it on rollback. */
  created_placement?: boolean
  /** A person confirmed the manual route (confirmRoute saw the name serve the target). */
  route_confirmed_at?: string | null
  /** When the run started waiting for the manual route (24 h budget). */
  waiting_since?: string | null
  /** sha256 of the source's database identity, read at `check` (R2; never the identity). */
  source_db?: string | null
}

export interface MoveFilesSummary {
  mode: 'full' | 'delta'
  state: PullStatus['state']
  total: number
  copied: number
  skipped: number
  failed: number
  missing: number
  size_mismatch: number
  bytes: number
  at: string
}

export interface MoveFiles {
  warm?: MoveFilesSummary
  delta?: MoveFilesSummary
  full?: MoveFilesSummary
}

export interface MoveChecklistState extends MoveChecklistItem {
  done: boolean
}

export interface HubMoveRow {
  id: number
  app_id: number
  environment_id: number
  from_placement_id: number
  to_placement_id: number
  kind: MovePlan['kind']
  routing: MovePlan['routing']
  status: MoveStatus
  step: MoveStepKey | null
  steps: MoveSteps
  plan: MovePlan | null
  plan_hash: string | null
  files: MoveFiles
  checklist: MoveChecklistState[]
  error: string | null
  placed_at: string | null
  prior_status: string | null
  job_run_id: number | null
  started_by: string | null
  started_at: string | null
  finished_at: string | null
  heartbeat_at: string | null
}

function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback
  if (typeof v !== 'string') return v as T
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null
  const t = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(String(v))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

export function moveFromRow(r: Record<string, unknown>): HubMoveRow {
  const steps = json<MoveSteps | MoveStepEntry[]>(r.steps, { list: [], phase: 'forward' })
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    environment_id: Number(r.environment_id),
    from_placement_id: Number(r.from_placement_id),
    to_placement_id: Number(r.to_placement_id),
    kind: String(r.kind) as HubMoveRow['kind'],
    routing: r.routing === 'manual' ? 'manual' : 'automatic',
    status: String(r.status) as MoveStatus,
    step: (r.step == null ? null : String(r.step)) as MoveStepKey | null,
    steps: Array.isArray(steps) ? { list: steps, phase: 'forward' } : steps,
    plan: json<MovePlan | null>(r.plan, null),
    plan_hash: r.plan_hash == null ? null : String(r.plan_hash),
    files: json<MoveFiles>(r.files, {}),
    checklist: json<MoveChecklistState[]>(r.checklist, []),
    error: r.error == null ? null : String(r.error),
    placed_at: iso(r.placed_at),
    prior_status: r.prior_status == null ? null : String(r.prior_status),
    job_run_id: r.job_run_id == null ? null : Number(r.job_run_id),
    started_by: r.started_by == null ? null : String(r.started_by),
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    heartbeat_at: iso(r.heartbeat_at)
  }
}

export async function readMove(id: number): Promise<HubMoveRow | null> {
  const r = (await db(MOVES).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? moveFromRow(r) : null
}

/** The newest moves of an environment, newest first. */
export async function listMoves(envId: number, limit = 20): Promise<HubMoveRow[]> {
  const rows = (await db(MOVES)
    .where({ environment_id: envId })
    .orderBy('id', 'desc')
    .limit(limit)) as Record<string, unknown>[]
  return rows.map(moveFromRow)
}

/** The open move of an environment (running, waiting or interrupted), if any. */
export async function openMoveOf(envId: number): Promise<HubMoveRow | null> {
  const r = (await db(MOVES)
    .where({ environment_id: envId })
    .whereIn('status', OPEN_MOVE_STATUSES as string[])
    .orderBy('id', 'desc')
    .first()) as Record<string, unknown> | undefined
  return r ? moveFromRow(r) : null
}

/** Writes columns of a move (JSON columns serialized here). Answers the rows changed. */
export async function patchMove(
  id: number,
  patch: Partial<{
    status: MoveStatus
    step: MoveStepKey | null
    steps: MoveSteps
    files: MoveFiles
    checklist: MoveChecklistState[]
    error: string | null
    placed_at: Date | null
    finished_at: Date | null
    heartbeat_at: Date | null
    job_run_id: number | null
  }>,
  where: { status?: readonly MoveStatus[] } = {}
): Promise<number> {
  const row: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    row[k] =
      k === 'steps' || k === 'files' || k === 'checklist'
        ? JSON.stringify(v)
        : k === 'error' && typeof v === 'string'
          ? v.slice(0, 1000)
          : v
  }
  if (!Object.keys(row).length) return 0
  const q = db(MOVES).where({ id })
  if (where.status) q.whereIn('status', where.status as string[])
  return Number(await q.update(row))
}

/** The step list a plan's steps start as. */
export function freshSteps(keys: readonly MoveStepKey[]): MoveSteps {
  return { list: keys.map((key) => ({ key, state: 'pending' as const })), phase: 'forward' }
}

/** The first step of the list not done (the one a resume starts at); null = all done. */
export function nextStep(steps: MoveSteps): MoveStepEntry | null {
  return steps.list.find((s) => s.state !== 'done') ?? null
}

/** Has `key` finished (done) in this list? */
export function stepDone(steps: MoveSteps, key: MoveStepKey): boolean {
  return steps.list.some((s) => s.key === key && s.state === 'done')
}

/** The route actions of a plan, as stored with the move. */
export function routeOf(move: HubMoveRow): RouteAction[] {
  return Array.isArray(move.plan?.route) ? (move.plan?.route ?? []) : []
}

const ENVS = 'nivaro_hub_environments'

/** The environment's status on the Hub (B1: `maintenance` while a move holds it). */
export async function setEnvStatus(envId: number, status: string): Promise<void> {
  await db(ENVS).where({ id: envId }).update({ status, updated_at: new Date() })
}
