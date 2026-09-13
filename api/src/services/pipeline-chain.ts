import { db } from '../db/index.js'
import { type ResolvedOwner, resolveStateOwners } from './pipeline-engine.js'
import { fetchPipelineRecord } from './pipeline-subject.js'
import {
  evalConditionRule,
  fetchRecordForConditions,
  parseConditionRules
} from './workflow-conditions.js'
import {
  evaluateSkipCriteriaDetailed,
  type WorkflowInstance,
  type WorkflowState,
  type WorkflowTransition
} from './workflow-transitions.js'

/**
 * The record's approval chain, the way the PipelinePanel shows it: every
 * template state with owners, a skip prediction, and PATH RELEVANCE — a
 * condition-aware BFS over the forward transition graph from the initial
 * state (Beeline vs Oracle branches, CAR vs REQ endings) so states the record
 * will never visit are dropped. Shared by GET /pipelines/instance/:c/:i/
 * owners/all and the transition emails (approval-chain.ts).
 *
 * `asOf` replays the chain at a PAST moment (mail harness): current = that
 * state, history truncated to that time.
 */

export interface ChainEntry {
  owners: ResolvedOwner[]
  skipped: boolean
  skip_reasons: string[]
  on_path: boolean
}

export interface StateChain {
  templateId: string
  instance: WorkflowInstance | undefined
  currentStateId: string | null
  states: WorkflowState[]
  history: Array<{
    from_state: string | null
    to_state: string
    timestamp: Date
    user: string | null
  }>
  entries: Record<string, ChainEntry>
}

const coerceBool = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

export async function computeStateChain(
  collection: string,
  item: string,
  opts: { asOf?: { stateId: string; time: Date } | null } = {}
): Promise<StateChain | null> {
  const binding = (await db('nivaro_workflow_bindings').where({ collection }).first()) as
    | { template: string }
    | undefined
  const instance = (await db<WorkflowInstance>('nivaro_workflow_instances')
    .where({ collection, item })
    .orderBy('started_at', 'desc')
    .first()) as WorkflowInstance | undefined
  const templateId = binding?.template ?? instance?.template
  if (!templateId) return null

  const states = (await db<WorkflowState>('nivaro_workflow_states')
    .where({ template: templateId })
    .orderBy('sort')) as WorkflowState[]
  const currentStateId = opts.asOf?.stateId ?? instance?.current_state ?? null

  const record = await fetchPipelineRecord(collection, item)

  let history: StateChain['history'] = instance
    ? ((await db('nivaro_workflow_history')
        .where({ instance: instance.id })
        .orderBy('timestamp', 'asc')
        .select('from_state', 'to_state', 'timestamp', 'user')) as StateChain['history'])
    : []
  if (opts.asOf) {
    const t = opts.asOf.time.getTime()
    history = history.filter((h) => new Date(h.timestamp).getTime() <= t)
  }

  const onPath = new Set<string>()
  try {
    const transitions = (await db<WorkflowTransition>('nivaro_workflow_transitions')
      .where({ template: templateId })
      .whereNotNull('from_state')
      .select('from_state', 'to_state', 'condition_rules')) as Array<{
      from_state: string
      to_state: string
      condition_rules: string | null
    }>
    const takenEdges = new Set(
      history.filter((h) => h.from_state).map((h) => `${h.from_state}:${h.to_state}`)
    )
    const conditioned = transitions.filter((t) => t.condition_rules)
    const conditionRecord =
      conditioned.length > 0
        ? await fetchRecordForConditions(
            collection,
            item,
            conditioned.map((t) => t.condition_rules)
          )
        : record
    const DISCRIMINATOR_OPS = new Set(['eq', 'neq', 'in', 'notin'])
    const passes = (t: { condition_rules: string | null }) => {
      const rules = parseConditionRules(t.condition_rules)
      if (!rules) return true
      return rules.every((r) => {
        if (!r || typeof r !== 'object' || typeof r.field !== 'string' || !r.field) return true
        if (!DISCRIMINATOR_OPS.has(String(r.op))) return true
        return evalConditionRule(r, conditionRecord)
      })
    }
    const sortOf = new Map(states.map((s) => [s.id, s.sort ?? 0]))
    const fwd = new Map<string, string[]>()
    for (const t of transitions) {
      if ((sortOf.get(t.to_state) ?? 0) < (sortOf.get(t.from_state) ?? 0)) continue
      if (!passes(t) && !takenEdges.has(`${t.from_state}:${t.to_state}`)) continue
      const arr = fwd.get(t.from_state) ?? []
      arr.push(t.to_state)
      fwd.set(t.from_state, arr)
    }
    for (const key of takenEdges) {
      const [fromId, toId] = key.split(':')
      if ((sortOf.get(toId) ?? 0) < (sortOf.get(fromId) ?? 0)) continue
      const arr = fwd.get(fromId) ?? []
      if (!arr.includes(toId)) {
        arr.push(toId)
        fwd.set(fromId, arr)
      }
    }
    const queue = states.filter((s) => coerceBool(s.is_initial)).map((s) => s.id)
    while (queue.length) {
      const id = queue.shift() as string
      if (onPath.has(id)) continue
      onPath.add(id)
      for (const next of fwd.get(id) ?? []) if (!onPath.has(next)) queue.push(next)
    }
    for (const h of history) onPath.add(h.to_state)
    if (currentStateId) onPath.add(currentStateId)
    if (onPath.size === 0) for (const s of states) onPath.add(s.id)
  } catch {
    for (const s of states) onPath.add(s.id)
  }

  const entries: Record<string, ChainEntry> = {}
  await Promise.all(
    states.map(async (s) => {
      const [owners, skip] = await Promise.all([
        resolveStateOwners(s.id, instance?.id ?? null, collection, item, db).catch(
          () => [] as ResolvedOwner[]
        ),
        s.id === currentStateId
          ? Promise.resolve({ skipped: false, reasons: [] as string[] })
          : evaluateSkipCriteriaDetailed(
              s.id,
              record,
              instance?.id ?? null,
              collection,
              item,
              db
            ).catch(() => ({ skipped: false, reasons: [] as string[] }))
      ])
      entries[s.id] = {
        owners,
        skipped: skip.skipped,
        skip_reasons: skip.reasons,
        on_path: onPath.has(s.id)
      }
    })
  )
  return { templateId, instance, currentStateId, states, history, entries }
}
