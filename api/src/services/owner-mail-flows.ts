import { db } from '../db/index.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * "Does a flow already EMAIL the owners of the state this record just entered?"
 *
 * Owners hear about a transition through a flow (trigger `workflow-transition`,
 * a mail op whose `to` names `{{owner_emails}}`). A person who owns the new
 * state AND subscribes to it got two emails for one move (army 4, 2026-11-05:
 * Beth, owner of Waiting on Fusion Submission + its subscriber). The state
 * subscription keeps its in-app row and leaves the email to the owner flow —
 * but only when such a flow would run for this record: its simple conditions
 * on `collection` / `subject_collection` / `to_state.key` are judged here;
 * any other condition counts as passing (the same "each flow's own condition
 * decides" stance the notification bench takes).
 *
 * Cached per tenant for 60 s (flow config changes rarely; a stale answer only
 * means one extra or one fewer email for a minute).
 */

export interface OwnerMailFlow {
  /** `[field, operator, value]` conditions this module can judge. */
  conditions: Array<{ field: string; operator: string; value: unknown }>
  /** The owner mail op leaves the person who acted out (`exclude` names the actor). */
  excludesActor?: boolean
  /** The flow also pings the owners in-app (a notification op over `{{owner_emails}}`). */
  pingsOwners?: boolean
}

const CACHE_MS = 60_000
const cache = new Map<string, { at: number; flows: OwnerMailFlow[] }>()

const JUDGED_FIELDS = new Set(['collection', 'subject_collection', 'to_state.key'])
const OWNER_LIST = /\{\{\s*owner_emails\s*\}\}/

function parse(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  try {
    return JSON.parse(String(raw ?? '{}')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Active workflow-transition flows with a mail op addressed to the owners. */
export async function loadOwnerMailFlows(): Promise<OwnerMailFlow[]> {
  const key = currentTenantKey() || '_'
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.flows
  let flows: OwnerMailFlow[] = []
  try {
    const rows = (await db('nivaro_flows as f')
      .join('nivaro_flow_operations as o', 'o.flow', 'f.id')
      .where({ 'f.status': 'active', 'f.trigger': 'workflow-transition' })
      .whereIn('o.type', ['mail', 'condition', 'notification'])
      .select('f.id as flow', 'o.type', 'o.options')) as Array<{
      flow: string
      type: string
      options: unknown
    }>
    const byFlow = new Map<
      string,
      {
        mailsOwners: boolean
        excludesActor: boolean
        pingsOwners: boolean
        conditions: OwnerMailFlow['conditions']
      }
    >()
    for (const r of rows) {
      const k = String(r.flow).toUpperCase()
      const entry = byFlow.get(k) ?? {
        mailsOwners: false,
        excludesActor: false,
        pingsOwners: false,
        conditions: []
      }
      const opts = parse(r.options)
      if (r.type === 'notification' && OWNER_LIST.test(String(opts.recipient ?? '')))
        entry.pingsOwners = true
      if (r.type === 'mail' && OWNER_LIST.test(String(opts.to ?? ''))) {
        entry.mailsOwners = true
        if (/\{\{\s*actor_(email|id)\s*\}\}|\{\{\s*user_id\s*\}\}/.test(String(opts.exclude ?? '')))
          entry.excludesActor = true
      }
      if (r.type === 'condition' && JUDGED_FIELDS.has(String(opts.field ?? '')))
        entry.conditions.push({
          field: String(opts.field),
          operator: String(opts.operator ?? 'eq'),
          value: opts.value
        })
      byFlow.set(k, entry)
    }
    flows = [...byFlow.values()]
      .filter((f) => f.mailsOwners)
      .map((f) => ({
        conditions: f.conditions,
        excludesActor: f.excludesActor,
        pingsOwners: f.pingsOwners
      }))
  } catch {
    flows = []
  }
  cache.set(key, { at: Date.now(), flows })
  return flows
}

/** Pure: would one of these flows email the owners for this move? */
export function ownerMailFlowCovers(
  flows: OwnerMailFlow[],
  move: { collection: string; subjectCollection: string; toStateKey: string }
): boolean {
  return coveringFlows(flows, move).length > 0
}

/** Pure: the flows that would email the owners for this move. */
export function coveringFlows(
  flows: OwnerMailFlow[],
  move: { collection: string; subjectCollection: string; toStateKey: string }
): OwnerMailFlow[] {
  const fieldOf = (field: string) =>
    field === 'collection'
      ? move.collection
      : field === 'subject_collection'
        ? move.subjectCollection
        : move.toStateKey
  return flows.filter((f) =>
    f.conditions.every((c) => {
      const actual = fieldOf(c.field)
      const list = String(c.value ?? '')
        .split(',')
        .map((s) => s.trim())
      switch (c.operator) {
        case 'eq':
          return actual === String(c.value ?? '')
        case 'neq':
          return actual !== String(c.value ?? '')
        case 'in':
          return list.includes(actual)
        case 'notIn':
          return !list.includes(actual)
        default:
          return true
      }
    })
  )
}

/** The owners (lower-cased emails + upper-cased ids) a flow emails for this move, and
 *  whether that flow pings them in-app too. */
export async function ownersEmailedByFlow(move: {
  collection: string
  item: string
  subjectCollection: string
  toStateKey: string
}): Promise<{ ids: Set<string>; emails: Set<string>; inapp: boolean }> {
  const out = { ids: new Set<string>(), emails: new Set<string>(), inapp: false }
  const covering = coveringFlows(await loadOwnerMailFlows(), move)
  if (covering.length === 0) return out
  out.inapp = covering.some((f) => f.pingsOwners)
  try {
    const inst = (await db('nivaro_workflow_instances as i')
      .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
      .where({ 'i.collection': move.collection, 'i.item': move.item, 's.key': move.toStateKey })
      .first('i.id', 'i.current_state')) as { id: string; current_state: string } | undefined
    if (!inst) return out
    const { resolveStateOwners } = await import('./pipeline-engine.js')
    for (const o of await resolveStateOwners(
      inst.current_state,
      inst.id,
      move.collection,
      move.item
    )) {
      if (o.id) out.ids.add(String(o.id).toUpperCase())
      if (o.email) out.emails.add(String(o.email).toLowerCase())
    }
  } catch {
    /* no owner answer → nobody is skipped */
  }
  return out
}

/** Tests only. */
export function clearOwnerMailFlowCache(): void {
  cache.clear()
}
