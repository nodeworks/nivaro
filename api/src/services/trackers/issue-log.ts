import type { Knex } from 'knex'
import { db } from '../../db/index.js'
import { selectInChunks, whereInList } from '../db-batch.js'
import { listConnections } from './connections.js'
import { trackersEnabled } from './feature.js'
import { chipOf, type LinkView, linksForIssues } from './links.js'
import { sourceOn } from './source-switch.js'

/**
 * GitLab on the issue log (GET /issues, GET /issues/:id). Everything here answers "nothing" while
 * the feature is off or no connection syncs the issue log, so the issue routes then carry no
 * tracker field at all. Admins get the whole link; everyone else the chip (number, link, state,
 * title) of an issue they can already read — never labels, people or the link's other members.
 */

export interface IssueTrackerScope {
  /** Connections whose `sync.sources.issue` is on. */
  connections: number[]
}

/** The connections that sync the issue log, or null (feature off / none / tables missing). */
export async function issueTrackerScope(): Promise<IssueTrackerScope | null> {
  try {
    if (!(await trackersEnabled())) return null
    const connections = (await listConnections())
      .filter((c) => sourceOn(c, 'issue'))
      .map((c) => Number(c.id))
    return connections.length ? { connections } : null
  } catch {
    return null
  }
}

export const TRACKER_FILTERS = ['linked', 'unlinked', 'suggested'] as const
export type TrackerFilter = (typeof TRACKER_FILTERS)[number]

export function trackerFilterOf(raw: unknown): TrackerFilter | null {
  return (TRACKER_FILTERS as readonly unknown[]).includes(raw) ? (raw as TrackerFilter) : null
}

/**
 * ?tracker=linked | unlinked | suggested on a query over `nivaro_issues as i`. A per-row seek into
 * the members' unique index (connection, source_kind, source_id): the int id is cast to the text
 * key, never the other way round. Suggested = a rule suggested it and it is not linked yet.
 */
export function applyTrackerFilter<Q extends Knex.QueryBuilder>(
  q: Q,
  mode: TrackerFilter | null,
  scope: IssueTrackerScope | null
): Q {
  if (!mode || !scope) return q
  const linked = function (this: Knex.QueryBuilder) {
    this.select(db.raw('1'))
      .from('nivaro_tracker_link_members as tm')
      .where('tm.source_kind', 'issue')
      .whereIn('tm.connection', scope.connections)
      .whereRaw('[tm].[source_id] = CAST([i].[id] AS NVARCHAR(100))')
  }
  if (mode === 'linked') q.whereExists(linked)
  else if (mode === 'unlinked') q.whereNotExists(linked)
  else q.whereNotNull('i.tracker_suggested_rule').whereNotExists(linked)
  return q
}

export type IssueChip = ReturnType<typeof chipOf>

/**
 * Rows with `tracker` (link view for admins, chip for others, null when unlinked) while `scope` is
 * set; `tracker_suggested_rule` kept for admins only (and only while unlinked). Without a scope
 * both fields are removed.
 */
export async function withTrackers<T extends Record<string, unknown>>(
  rows: T[],
  isAdmin: boolean,
  scope: IssueTrackerScope | null
): Promise<Array<T & { tracker?: LinkView | IssueChip | null }>> {
  const strip = (r: T) => {
    const { tracker_suggested_rule: _drop, ...rest } = r
    return rest as T
  }
  if (!scope) return rows.map(strip)
  let links = new Map<number, LinkView>()
  try {
    links = await linksForIssues(
      rows.map((r) => Number(r.id)),
      { connections: new Set(scope.connections) }
    )
  } catch {
    links = new Map()
  }
  return rows.map((r) => {
    const view = links.get(Number(r.id)) ?? null
    const tracker = view ? (isAdmin ? view : chipOf(view)) : null
    if (!isAdmin) return { ...strip(r), tracker }
    const suggested = r.tracker_suggested_rule == null ? null : Number(r.tracker_suggested_rule)
    return { ...r, tracker, tracker_suggested_rule: view ? null : suggested }
  })
}

export interface TrackerMember {
  kind: 'issue' | 'ticket' | 'record'
  id: string
  title: string | null
  status: string | null
  joined_via: string
  joined_at: string | null
}

export interface TrackerPending {
  id: number
  op: string
  status: string
  attempts: number
  last_error: string | null
  next_attempt_at: string | null
}

const MEMBERS_SHOWN = 200

const iso = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * Admin detail: the examples on the issue's GitLab issue (newest first, at most 200, how each
 * joined) and the changes still waiting to be sent for this issue or its link (pending, sending,
 * dead).
 */
export async function trackerDetail(
  issueId: number,
  link: LinkView | null
): Promise<{ members: TrackerMember[]; members_total: number; pending: TrackerPending[] }> {
  let members: TrackerMember[] = []
  let total = 0
  try {
    if (link) {
      const rows = (await db('nivaro_tracker_link_members')
        .where({ link: link.id })
        .orderBy([
          { column: 'joined_at', order: 'desc' },
          { column: 'id', order: 'desc' }
        ])
        .limit(MEMBERS_SHOWN)
        .select('source_kind', 'source_id', 'joined_via', 'joined_at')) as Array<
        Record<string, unknown>
      >
      total = Math.max(rows.length, link.sources.length)
      const issueIds = rows
        .filter((r) => r.source_kind === 'issue')
        .map((r) => Number(r.source_id))
        .filter((n) => Number.isSafeInteger(n) && n > 0)
      const titles = new Map<number, { title: string; status: string; source: string }>()
      if (issueIds.length) {
        const found = await selectInChunks(
          issueIds,
          500,
          async (chunk) =>
            (await whereInList(db('nivaro_issues'), 'id', chunk).select(
              'id',
              'title',
              'status',
              'source'
            )) as Array<Record<string, unknown>>
        )
        for (const f of found)
          titles.set(Number(f.id), {
            title: String(f.title ?? ''),
            status: String(f.status ?? ''),
            source: String(f.source ?? '')
          })
      }
      members = rows.map((r) => {
        const kind = String(r.source_kind) as TrackerMember['kind']
        const t = kind === 'issue' ? titles.get(Number(r.source_id)) : undefined
        return {
          kind,
          id: String(r.source_id),
          title: t?.title ?? null,
          status: t?.status ?? null,
          joined_via: String(r.joined_via ?? ''),
          joined_at: iso(r.joined_at)
        }
      })
    }
  } catch {
    members = []
  }
  let pending: TrackerPending[] = []
  try {
    const rows = (await db('nivaro_tracker_outbox')
      .whereIn('status', ['pending', 'sending', 'dead'])
      .where((w) => {
        w.where({ source_kind: 'issue', source_id: String(issueId) })
        if (link) w.orWhere({ link: link.id })
      })
      .orderBy('id', 'desc')
      .limit(50)
      .select('id', 'op', 'status', 'attempts', 'last_error', 'next_attempt_at')) as Array<
      Record<string, unknown>
    >
    pending = rows.map((r) => ({
      id: Number(r.id),
      op: String(r.op),
      status: String(r.status),
      attempts: Number(r.attempts) || 0,
      last_error: r.last_error == null ? null : String(r.last_error).slice(0, 500),
      next_attempt_at: iso(r.next_attempt_at)
    }))
  } catch {
    pending = []
  }
  return { members, members_total: total, pending }
}
