import { db } from '../db/index.js'

/**
 * The approval chain as an email shows it — built on the SAME path-aware
 * computation the PipelinePanel uses (pipeline-chain.ts): only states on this
 * record's path, done / current / upcoming / skipped, who acted (history),
 * who is waiting (owners). Escape states (cancel / reject) only appear while
 * the record is actually there.
 */

export interface ChainStep {
  key: string
  label: string
  status: 'done' | 'current' | 'upcoming' | 'skipped'
  by: string | null
  at: string | null
  owners: string[]
  skip_reason: string | null
}

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

  const steps: ChainStep[] = []
  for (const s of chain.states) {
    const e = chain.entries[s.id]
    if (!e?.on_path) continue
    if (s.stage_visibility === 'hide') continue
    const isCurrent = s.id === currentId
    // A cancel / reject branch is never "upcoming"; it shows only while the
    // record sits there (an uncanceled record's Canceled stay is history).
    if (isEscape(s.key) && !isCurrent) continue
    const sort = s.sort ?? 0
    let status: ChainStep['status']
    if (isCurrent) status = 'current'
    else if (sort < currentSort)
      status =
        visited.has(s.id) || actedAt.has(s.id) || s.is_initial === true || s.is_initial === 1
          ? 'done'
          : 'skipped'
    else status = e.skipped ? 'skipped' : 'upcoming'
    const acted = actedAt.get(s.id)
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
    steps.push({
      key: s.key,
      label: s.label,
      status,
      by: status === 'done' ? (acted?.by ?? null) : null,
      at: status === 'done' ? (acted?.at ?? null) : null,
      owners,
      skip_reason: status === 'skipped' ? (e.skip_reasons[0] ?? null) : null
    })
  }
  // Only the NEXT upcoming state carries owners — a long tail of names is noise.
  let seenUpcoming = false
  for (const st of steps) {
    if (st.status === 'upcoming') {
      if (seenUpcoming) st.owners = []
      seenUpcoming = true
    }
  }
  return steps
}
