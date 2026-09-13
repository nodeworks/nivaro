import { db } from '../db/index.js'
import { type OwnerResolutionRequest, resolveStateOwnersBatch } from './pipeline-engine.js'

/**
 * The approval chain as an email can show it: every state on the template in
 * order, marked done / current / upcoming, with who acted on the done ones
 * (from history) and who owns the current + next one. Branch states the
 * record will never visit are pruned the cheap way — hidden-stage states and
 * states with sort below the current one that history never touched are
 * dropped; the full condition-aware BFS lives in routes/pipelines.ts
 * (owners/all) and is deliberately not duplicated here.
 */

export interface ChainStep {
  key: string
  label: string
  status: 'done' | 'current' | 'upcoming'
  by: string | null
  at: string | null
  owners: string[]
}

export async function buildApprovalChain(
  instanceId: string,
  opts: { asOfStateId?: string | null; asOfTime?: Date | null } = {}
): Promise<ChainStep[]> {
  const instance = (await db('nivaro_workflow_instances').where({ id: instanceId }).first()) as
    | {
        id: string
        template: string
        collection: string
        item: string
        current_state: string | null
      }
    | undefined
  if (!instance) return []
  const states = (await db('nivaro_workflow_states')
    .where({ template: instance.template })
    .orderBy('sort')
    .select('id', 'key', 'label', 'sort', 'stage_visibility')) as Array<{
    id: string
    key: string
    label: string
    sort: number
    stage_visibility: string | null
  }>
  const history = (await db('nivaro_workflow_history as h')
    .leftJoin('nivaro_users as u', 'u.id', 'h.user')
    .where('h.instance', instanceId)
    .orderBy('h.timestamp', 'asc')
    .select(
      'h.from_state',
      'h.to_state',
      'h.timestamp',
      'u.first_name',
      'u.last_name',
      'u.email'
    )) as Array<{
    from_state: string | null
    to_state: string
    timestamp: Date
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  // A replayed history row (mail harness) reads the chain AS OF that move:
  // current = the state it entered, history truncated to that moment.
  const currentStateId = opts.asOfStateId ?? instance.current_state
  const historyAsOf = opts.asOfTime
    ? history.filter((h) => new Date(h.timestamp).getTime() <= (opts.asOfTime as Date).getTime())
    : history
  const currentSort = states.find((s) => s.id === currentStateId)?.sort ?? 0
  // The LAST departure from each state = who acted there.
  const actedAt = new Map<string, { by: string | null; at: string }>()
  for (const h of historyAsOf) {
    if (!h.from_state) continue
    const by = [h.first_name, h.last_name].filter(Boolean).join(' ') || h.email || null
    actedAt.set(h.from_state, { by, at: new Date(h.timestamp).toISOString() })
  }
  const visited = new Set<string>(historyAsOf.map((h) => h.to_state))
  // A cancel / rejected branch is never "upcoming" — it only shows once
  // the record actually lands there.
  const isEscape = (k: string) => /cancel|reject|abandon/i.test(k)
  const steps = states.filter(
    (s) =>
      s.stage_visibility !== 'hide' &&
      (s.id === currentStateId || visited.has(s.id) || (s.sort > currentSort && !isEscape(s.key)))
  )
  const upcoming = steps.filter((s) => s.sort > currentSort && s.id !== currentStateId)
  const next = upcoming[0]
  const ownerRequests: OwnerResolutionRequest[] = [currentStateId, next?.id]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((sid) => ({
      key: sid,
      stateId: sid,
      instanceId,
      collection: instance.collection,
      itemId: String(instance.item)
    }))
  const ownersByState = ownerRequests.length
    ? await resolveStateOwnersBatch(ownerRequests).catch(() => new Map())
    : new Map()
  const names = (sid: string) =>
    (
      (ownersByState.get(sid) ?? []) as Array<{
        first_name?: string | null
        last_name?: string | null
        email?: string
      }>
    )
      .map((o) => [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email || '')
      .filter(Boolean)
      .slice(0, 6)
  return steps.map((s) => {
    const status: ChainStep['status'] =
      s.id === currentStateId ? 'current' : s.sort > currentSort ? 'upcoming' : 'done'
    const acted = actedAt.get(s.id)
    return {
      key: s.key,
      label: s.label,
      status,
      by: status === 'done' ? (acted?.by ?? null) : null,
      at: status === 'done' ? (acted?.at ?? null) : null,
      owners: status === 'current' || s.id === next?.id ? names(s.id) : []
    }
  })
}
