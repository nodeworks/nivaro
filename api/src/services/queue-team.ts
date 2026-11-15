import { db } from '../db/index.js'
import { selectInChunks, whereInList } from './db-batch.js'

/**
 * Team availability strip on a queue page (rt7 #17).
 *
 * "The queue's team" = the people seated in the owner groups of the workflows bound to the
 * collections the queue draws from — the same seats that decide who owns the queue's records.
 * The route trims that list to who the VIEWER may see in presence (visibleToViewer) and never
 * lists machine accounts, suspended or redacted people. Whether someone is online or away is
 * NOT decided here: the screen layers the shared, already viewer-filtered `/presence/online`
 * read on top, so this answer changes only when seats, out-of-office or delegation change.
 */

export interface QueueTeamMember {
  id: string
  name: string
  /** Out of office right now; the end date and a delegate who can act are named when known. */
  out_of_office: boolean
  ooo_end: string | null
  covered_by: { id: string; name: string } | null
}

export interface QueueTeamAnswer {
  members: QueueTeamMember[]
  /** People the strip does not list because of the cap (still counted by status client-side
   *  only for those listed, so the number is "and N more"). */
  more: number
}

/** The most people one strip lists; a large owner group reads as "and N more". */
export const QUEUE_TEAM_MAX = 40

interface UserRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  status: string | null
  is_redacted: boolean | number | null
  account_kind: string | null
  is_out_of_office: boolean | number | null
  ooo_end: Date | string | null
  delegate_id: string | null
  delegate_expires_at: Date | string | null
}

export function nameOf(u: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
}): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Someone'
}

/** Can this person be listed as a human teammate? (pure) */
export function isListablePerson(u: {
  status?: string | null
  is_redacted?: boolean | number | null
  account_kind?: string | null
}): boolean {
  if (u.account_kind) return false
  if (u.is_redacted) return false
  return String(u.status ?? 'active').toLowerCase() !== 'suspended'
}

/** Collections a queue draws records from (its collection-type sources). */
export async function queueCollections(queueId: string): Promise<string[]> {
  const rows = (await db('nivaro_queue_sources')
    .where({ queue_id: queueId, type: 'collection' })
    .whereNotNull('collection')
    .select('collection')) as Array<{ collection: string }>
  return [...new Set(rows.map((r) => r.collection))]
}

/** Upper-cased ids seated in the owner groups of the workflows bound to these collections. */
export async function seatedUserIds(collections: string[]): Promise<string[]> {
  if (collections.length === 0) return []
  const rows = (await db('nivaro_pipeline_owner_group_users as gu')
    .join('nivaro_pipeline_owner_groups as g', 'g.id', 'gu.group')
    .join('nivaro_workflow_bindings as b', 'b.template', 'g.template')
    .whereIn('b.collection', collections)
    .distinct('gu.user')) as Array<{ user: string }>
  return [...new Set(rows.map((r) => String(r.user).toUpperCase()))]
}

/**
 * Turn user rows into strip members (pure apart from `now`). Order: out-of-office last, then by
 * name — presence order is applied by the screen, which owns the live state.
 */
export function buildTeam(
  users: UserRow[],
  delegates: Map<string, string>,
  visible: Set<string>,
  now: number = Date.now(),
  visibleDelegates: Set<string> = new Set()
): QueueTeamAnswer {
  const listed = users
    .filter((u) => isListablePerson(u) && visible.has(String(u.id).toUpperCase()))
    .map((u): QueueTeamMember => {
      const out = !!u.is_out_of_office
      const live =
        out &&
        !!u.delegate_id &&
        (!u.delegate_expires_at || new Date(u.delegate_expires_at).getTime() > now)
      const dKey = String(u.delegate_id).toUpperCase()
      // A delegate is named only when the viewer may see them in presence too.
      const dName = live && visibleDelegates.has(dKey) ? delegates.get(dKey) : undefined
      return {
        id: String(u.id),
        name: nameOf(u),
        out_of_office: out,
        ooo_end: out && u.ooo_end ? new Date(u.ooo_end).toISOString() : null,
        covered_by: dName && u.delegate_id ? { id: String(u.delegate_id), name: dName } : null
      }
    })
    .sort(
      (a, b) => Number(a.out_of_office) - Number(b.out_of_office) || a.name.localeCompare(b.name)
    )
  return {
    members: listed.slice(0, QUEUE_TEAM_MAX),
    more: Math.max(0, listed.length - QUEUE_TEAM_MAX)
  }
}

/** Load users + live delegates for these ids. */
export async function loadTeamUsers(
  ids: string[]
): Promise<{ users: UserRow[]; delegates: Map<string, string> }> {
  if (ids.length === 0) return { users: [], delegates: new Map() }
  // Every seated person can be thousands of ids: chunked under the bound-parameter cap, one
  // OPENJSON list per chunk (services/db-batch.ts).
  const users = (await selectInChunks(ids, 1000, (chunk) =>
    whereInList(db('nivaro_users'), 'id', chunk).select(
      'id',
      'first_name',
      'last_name',
      'email',
      'status',
      'is_redacted',
      'account_kind',
      'is_out_of_office',
      'ooo_end',
      'delegate_id',
      'delegate_expires_at'
    )
  )) as UserRow[]
  const delegateIds = [
    ...new Set(
      users.filter((u) => !!u.is_out_of_office && u.delegate_id).map((u) => String(u.delegate_id))
    )
  ]
  const delegates = new Map<string, string>()
  if (delegateIds.length) {
    const rows = (await selectInChunks(delegateIds, 1000, (chunk) =>
      whereInList(db('nivaro_users'), 'id', chunk)
        .where((q) => q.whereNull('status').orWhereNot('status', 'suspended'))
        .where((q) => q.whereNull('is_redacted').orWhere('is_redacted', false))
        .whereNull('account_kind')
        .select('id', 'first_name', 'last_name', 'email')
    )) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      email: string | null
    }>
    for (const d of rows) delegates.set(String(d.id).toUpperCase(), nameOf(d))
  }
  return { users, delegates }
}
