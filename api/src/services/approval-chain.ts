import { db } from '../db/index.js'
import type { GapStateRow } from './owner-gap-notice.js'
import { activeOwnersOnly, resolveStateOwnersBatch } from './pipeline-engine.js'

/**
 * The approval chain as an email shows it — built on the SAME path-aware
 * computation the PipelinePanel uses (pipeline-chain.ts): only states on this
 * record's path, done / current / upcoming / skipped, who acted (history),
 * who is waiting (owners). Escape states (cancel / reject) only appear while
 * the record is actually there.
 *
 * Army 5 (2026-11-06): the mail names only the people who can ACT — the
 * assigned owners (no queue-only creator fallback), active people only — the
 * same set the header line of the mail uses ("It is now waiting on …"); a
 * canceled record marks the step it was canceled FROM as canceled (by whom)
 * and the steps after it as not reached, never "✓ by the canceller" and
 * "skipped". `pipeline-chain.ts` is shared with the PipelinePanel and stays
 * as it is; these rules are the mail's own.
 */

export interface ChainStep {
  key: string
  label: string
  status: 'done' | 'current' | 'upcoming' | 'skipped' | 'canceled' | 'not_reached'
  by: string | null
  at: string | null
  owners: string[]
  skip_reason: string | null
  /** The current step waits on nobody who can act and nobody else can move it
   *  (owner-gap-notice.ts) — the mail says no approver is set yet. */
  no_approver?: boolean
}

export interface StepStatusInput {
  isCurrent: boolean
  sort: number
  currentSort: number
  /** Entered at some point, acted on, or the initial state. */
  reached: boolean
  /** The skip prediction for a state still ahead. */
  predictedSkip: boolean
  /** The record sits in a cancel / reject state: where it was canceled from. */
  cancel: { fromId: string | null; fromSort: number } | null
  id: string
}

/** Pure: one step's status in the mail chain. */
export function chainStepStatus(i: StepStatusInput): ChainStep['status'] {
  if (i.isCurrent) return 'current'
  if (i.cancel) {
    if (i.cancel.fromId && sameId(i.id, i.cancel.fromId)) return 'canceled'
    // Nothing after the step it was canceled from happened, or will.
    if (i.sort > i.cancel.fromSort) return 'not_reached'
    return i.reached ? 'done' : 'skipped'
  }
  if (i.sort < i.currentSort) return i.reached ? 'done' : 'skipped'
  return i.predictedSkip ? 'skipped' : 'upcoming'
}

const sameId = (a: unknown, b: unknown) =>
  String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase()

const isEscape = (k: string) => /cancel|reject|abandon/i.test(k)
const nameOf = (u: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
}) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || null

export async function buildApprovalChain(
  instanceId: string,
  opts: { asOfStateId?: string | null; asOfTime?: Date | null } = {}
): Promise<ChainStep[]> {
  const instance = (await db('nivaro_workflow_instances').where({ id: instanceId }).first()) as
    | { id: string; collection: string; item: string; current_state: string | null }
    | undefined
  if (!instance) return []
  const { computeStateChain } = await import('./pipeline-chain.js')
  const chain = await computeStateChain(instance.collection, String(instance.item), {
    asOf:
      opts.asOfStateId && opts.asOfTime ? { stateId: opts.asOfStateId, time: opts.asOfTime } : null
  })
  if (!chain) return []
  const currentId = chain.currentStateId
  const currentSort = chain.states.find((s) => s.id === currentId)?.sort ?? 0

  // Who acted where: the LAST departure from each state, by name.
  const userIds = [...new Set(chain.history.map((h) => h.user).filter((u): u is string => !!u))]
  const users = userIds.length
    ? ((await db('nivaro_users')
        .whereIn('id', userIds)
        .select('id', 'first_name', 'last_name', 'email')) as Array<{
        id: string
        first_name: string | null
        last_name: string | null
        email: string
      }>)
    : []
  const byId = new Map(users.map((u) => [u.id.toUpperCase(), u]))
  const actedAt = new Map<string, { by: string | null; at: string }>()
  for (const h of chain.history) {
    if (!h.from_state) continue
    const u = h.user ? byId.get(h.user.toUpperCase()) : undefined
    actedAt.set(h.from_state, { by: u ? nameOf(u) : null, at: new Date(h.timestamp).toISOString() })
  }
  const visited = new Set(chain.history.map((h) => h.to_state))

  // A canceled (rejected…) record: the step it left for the escape state, and
  // who moved it there — the LAST entry into the current state.
  const currentState = chain.states.find((s) => s.id === currentId)
  let cancel: { fromId: string | null; fromSort: number; by: string | null; at: string } | null =
    null
  if (currentState && isEscape(currentState.key)) {
    const entry = [...chain.history].reverse().find((h) => sameId(h.to_state, currentId))
    const fromId = entry?.from_state ?? null
    const u = entry?.user ? byId.get(entry.user.toUpperCase()) : undefined
    cancel = {
      fromId,
      fromSort: chain.states.find((s) => sameId(s.id, fromId))?.sort ?? currentSort,
      by: u ? nameOf(u) : null,
      at: entry ? new Date(entry.timestamp).toISOString() : new Date().toISOString()
    }
  }

  const steps: ChainStep[] = []
  /** The state behind each step that may carry owners (current / upcoming). */
  const ownerStepState = new Map<ChainStep, string>()
  for (const s of chain.states) {
    const e = chain.entries[s.id]
    if (!e?.on_path) continue
    if (s.stage_visibility === 'hide') continue
    const isCurrent = s.id === currentId
    // A cancel / reject branch is never "upcoming"; it shows only while the
    // record sits there (an uncanceled record's Canceled stay is history).
    if (isEscape(s.key) && !isCurrent) continue
    const sort = s.sort ?? 0
    const status = chainStepStatus({
      isCurrent,
      sort,
      currentSort,
      reached:
        visited.has(s.id) || actedAt.has(s.id) || s.is_initial === true || s.is_initial === 1,
      predictedSkip: e.skipped,
      cancel,
      id: s.id
    })
    const acted =
      status === 'canceled' && cancel ? { by: cancel.by, at: cancel.at } : actedAt.get(s.id)
    // A finished record waits on nobody: a terminal state's owners are who
    // gets told, not who acts next — "Completed · waiting on Rob" reads wrong.
    const terminal = s.is_terminal === true || s.is_terminal === 1
    const owners =
      (status === 'current' || status === 'upcoming') && !terminal
        ? e.owners
            .map((o) => nameOf(o) ?? '')
            .filter(Boolean)
            .slice(0, 6)
        : []
    const named = status === 'done' || status === 'canceled'
    const step: ChainStep = {
      key: s.key,
      label: s.label,
      status,
      by: named ? (acted?.by ?? null) : null,
      at: named ? (acted?.at ?? null) : null,
      owners,
      skip_reason: status === 'skipped' ? (e.skip_reasons[0] ?? null) : null
    }
    if ((status === 'current' || status === 'upcoming') && !terminal) ownerStepState.set(step, s.id)
    steps.push(step)
  }
  // Only the NEXT upcoming state carries owners — a long tail of names is noise.
  let seenUpcoming = false
  for (const st of steps) {
    if (st.status === 'upcoming') {
      if (seenUpcoming) {
        st.owners = []
        ownerStepState.delete(st)
      }
      seenUpcoming = true
    }
  }
  await nameActingOwners(instance, ownerStepState, chain.states)
  return steps
}

/**
 * The owners a mail names: assigned owners only (the binding's creator
 * fallback keeps a record in a queue; it is no claim to approve) and active
 * people only (suspended / redacted left out) — the same set as the mail's
 * header line (buildTransitionEventPayload). The panel's chain keeps its own
 * owners. Best-effort: a failed lookup keeps the chain's names.
 */
async function nameActingOwners(
  instance: { id: string; collection: string; item: string },
  stepState: Map<ChainStep, string>,
  states: ReadonlyArray<{ id: string }>
): Promise<void> {
  if (stepState.size === 0) return
  try {
    const stateIds = [...new Set(stepState.values())]
    const resolved = await resolveStateOwnersBatch(
      stateIds.map((id) => ({
        key: id,
        stateId: id,
        instanceId: instance.id,
        collection: instance.collection,
        itemId: String(instance.item)
      })),
      db,
      { skipFallback: true }
    )
    const acting = new Map<string, string[]>()
    for (const id of stateIds) {
      const owners = await activeOwnersOnly(resolved.get(id) ?? [])
      acting.set(
        id,
        owners
          .map((o) => nameOf(o) ?? '')
          .filter(Boolean)
          .slice(0, 6)
      )
    }
    let stalled: Set<string> | null = null
    for (const [step, id] of stepState) {
      step.owners = acting.get(id) ?? []
      if (step.status === 'current' && step.owners.length === 0) {
        stalled ??= await import('./owner-gap-notice.js')
          .then((m) => m.stalledStates(states as unknown as GapStateRow[]))
          .catch(() => new Set<string>())
        if (stalled.has(String(id).toUpperCase())) step.no_approver = true
      }
    }
  } catch {
    /* the chain's own owner names stand */
  }
}
