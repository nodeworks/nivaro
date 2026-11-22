import { db } from '../../../db/index.js'
import { getApp } from '../../io-holder.js'
import { resumeJobRun } from '../../job-runs.js'
import { MOVES, moveFromRow } from './rows.js'

/**
 * Nivaro Hub phase 6, Task 16: a move whose runner stopped (its process died, or lost its locks)
 * becomes `interrupted`, with Resume and Roll back (Review Focus #1).
 *
 * A run renews its heartbeat (nivaro_hub_moves.heartbeat_at) every 60 s while it works or waits
 * for a manual route. A `running` or `waiting` move whose heartbeat is older than 2 minutes, and
 * that no runner in THIS process owns, is interrupted: its mirror deploy row too (kind `move`,
 * closed here and never by the phase-2 heal, ruling R8) and its job run is failed. Nothing is
 * undone here: the person resumes (from the stored step) or rolls back.
 *
 * Run at boot (routes/hub-move.ts, beside the phase-2 promotion heal) and before a move is read
 * (a run on another replica that died shows `interrupted` on the next look).
 */

export const STALE_HEARTBEAT_MS = 2 * 60_000

const DEPLOYS = 'nivaro_hub_deploys'

/** Moves a runner in this process owns (run.ts marks them). */
const liveHere = new Set<number>()
export function markMoveLive(id: number): void {
  liveHere.add(id)
}
export function unmarkMoveLive(id: number): void {
  liveHere.delete(id)
}
export function isMoveLiveHere(id: number): boolean {
  return liveHere.has(id)
}

export interface HealDeps {
  now?: () => number
  /** Fails a job run (tests replace it). */
  failJobRun?: (jobRunId: number, moveId: number, message: string) => Promise<void>
}

async function failJobRunDefault(jobRunId: number, moveId: number, message: string) {
  try {
    await resumeJobRun(jobRunId, 'deploy', `hub-move-${moveId}`, { guardRunning: true }).fail(
      message
    )
  } catch {
    // bookkeeping never breaks healing
  }
}

const timeOf = (v: string | null): number | null => {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** Interrupts every stale open move (or only `onlyId`). Answers how many it interrupted. */
export async function healMoves(deps: HealDeps = {}, onlyId?: number): Promise<number> {
  const now = deps.now ?? Date.now
  const q = db(MOVES).whereIn('status', ['running', 'waiting'])
  if (onlyId !== undefined) q.where({ id: onlyId })
  const rows = ((await q) as Record<string, unknown>[]).map(moveFromRow)
  let healed = 0
  for (const m of rows) {
    if (liveHere.has(m.id)) continue
    const beat = timeOf(m.heartbeat_at) ?? timeOf(m.started_at)
    if (beat !== null && now() - beat <= STALE_HEARTBEAT_MS) continue
    const changed = await db(MOVES)
      .where({ id: m.id })
      .whereIn('status', ['running', 'waiting'])
      .update({ status: 'interrupted', heartbeat_at: null })
    if (!Number(changed)) continue
    healed++
    await db(DEPLOYS)
      .where({ move_id: m.id, status: 'running' })
      .update({ status: 'interrupted', heartbeat_at: null })
      .catch(() => null)
    if (m.job_run_id)
      await (deps.failJobRun ?? failJobRunDefault)(
        m.job_run_id,
        m.id,
        'Interrupted: the run stopped (the Hub restarted or lost its lock). Resume or roll back the move.'
      )
    getApp()?.log?.warn?.(
      { move_id: m.id, step: m.step },
      'hub move: the run stopped; marked interrupted'
    )
  }
  return healed
}
