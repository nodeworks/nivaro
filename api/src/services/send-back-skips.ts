/**
 * Send backs to steps this record SKIPS (army 9 b06 INFO, the server half of
 * b06-N6). A $5,000 request passes Levels 3 and 4 by threshold; at Level 5
 * the panel hid "Send Back → Level 3/4", but the instance read still offered
 * them, so an API or MCP caller could send the record back to a step nobody
 * works on — and the engine then walked it forward again to wherever the
 * skips led, never to the step that was asked for.
 *
 * One rule, three readers (gotchas "One evaluator, two sides"):
 *  - GET /pipelines/instance/:c/:i drops these moves from available_transitions,
 *  - applyTransition refuses one with a plain 409 (TARGET_SKIPPED),
 *  - the PipelinePanel's `withoutSkippedSendBacks` hides the same buttons from
 *    `/owners/all` (pipeline-chain.ts), which judges skips the same way.
 *
 * A send back = a move whose target sorts BEFORE the current state. A target
 * is skipped when its skip rules hold for this record right now — initial and
 * terminal states never skip (resolveTransitionTarget's own rule). A
 * return-to-previous move (`to_previous`, Uncancel) is never judged here: its
 * row target is only a fallback.
 */
import type { db as Db } from '../db/index.js'
import { fetchPipelineRecord } from './pipeline-subject.js'
import { evaluateSkipCriteriaDetailed } from './workflow-transitions.js'

export interface SendBackStateRow {
  id: string
  sort?: number | null
  is_initial?: unknown
  is_terminal?: unknown
}

export interface SendBackMove {
  to_state: string
  to_previous?: unknown
}

const up = (v: unknown) => String(v ?? '').toUpperCase()
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

/** Pure: does this move go to a step sorting before the current one? */
export function isSendBackMove(
  move: SendBackMove,
  states: SendBackStateRow[],
  currentStateId: string | null | undefined
): boolean {
  if (!currentStateId || truthy(move.to_previous)) return false
  const cur = states.find((s) => up(s.id) === up(currentStateId))
  const to = states.find((s) => up(s.id) === up(move.to_state))
  if (!cur || !to) return false
  const a = Number(to.sort)
  const b = Number(cur.sort)
  return Number.isFinite(a) && Number.isFinite(b) && a < b
}

/** Pure: may this state be skipped at all (initial and terminal never are)? */
export function canSkip(state: SendBackStateRow | undefined): boolean {
  return !!state && !truthy(state.is_initial) && !truthy(state.is_terminal)
}

/** Pure: the moves without the send backs whose target is in `skipped`. */
export function withoutSkippedSendBacks<T extends SendBackMove>(
  moves: T[],
  states: SendBackStateRow[],
  currentStateId: string | null | undefined,
  skipped: Map<string, string[]> | null | undefined
): T[] {
  if (!skipped || skipped.size === 0) return moves
  const skippedUp = new Set([...skipped.keys()].map(up))
  return moves.filter(
    (m) => !(skippedUp.has(up(m.to_state)) && isSendBackMove(m, states, currentStateId))
  )
}

/**
 * The send-back targets among `moves` that this record skips, with the
 * engine's reasons. Reads the record once and judges each distinct target
 * once; nothing when no send back is on offer. Never throws (a failed read
 * judges nothing skipped — the execute path still refuses).
 */
export async function skippedSendBackTargets(opts: {
  moves: SendBackMove[]
  states: SendBackStateRow[]
  currentStateId: string | null | undefined
  instanceId: string | null
  collection: string
  item: string
  database: typeof Db
}): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const byId = new Map(opts.states.map((s) => [up(s.id), s]))
  const targets = [
    ...new Set(
      opts.moves
        .filter((m) => isSendBackMove(m, opts.states, opts.currentStateId))
        .map((m) => up(m.to_state))
        .filter((id) => canSkip(byId.get(id)))
    )
  ]
  if (targets.length === 0) return out
  try {
    const record = await fetchPipelineRecord(opts.collection, opts.item, opts.database)
    for (const id of targets) {
      const state = byId.get(id)
      if (!state) continue
      const r = await evaluateSkipCriteriaDetailed(
        state.id,
        record,
        opts.instanceId,
        opts.collection,
        opts.item,
        opts.database
      ).catch(() => ({ skipped: false, reasons: [] as string[] }))
      if (r.skipped) out.set(state.id, r.reasons)
    }
  } catch {
    /* judged nothing skipped */
  }
  return out
}
