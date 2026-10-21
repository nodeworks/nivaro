import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { selectInChunks } from './db-batch.js'
import { SUPPORT_KIND, userName } from './support-tickets.js'

/**
 * Support desk analytics (#1424) — how the desk is doing, from the tickets
 * themselves: volume by request type and team, first-response and resolution
 * times against the targets, how often a closed ticket is reopened, which
 * records generate tickets, how many arrive with a clip or screenshot, and who
 * asks most. Counts and timings only — no ticket text leaves this module.
 */

/** Targets the p50/p75 are judged against (hours); a caller may override them. */
export const DEFAULT_TARGETS = { first_response_hours: 4, resolution_hours: 72 }
const TICKET_CAP = 20_000

export interface TicketFact {
  id: number
  category: string | null
  team: string | null
  collection: string | null
  requester: string
  requester_name: string | null
  created_at: Date | string
  completed_at: Date | string | null
  status: string
  /** First reply by someone other than the requester. */
  first_reply_at: Date | string | null
  reopened: boolean
  has_clip: boolean
  has_screenshot: boolean
}

export interface Pctl {
  samples: number
  p50_hours: number | null
  p75_hours: number | null
  target_hours: number
  /** Share of samples at or under the target (0–1). */
  within_target: number | null
}

const hours = (from: Date | string, to: Date | string) =>
  (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

const round = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10)

export function timing(values: number[], target: number): Pctl {
  const s = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, z) => a - z)
  return {
    samples: s.length,
    p50_hours: round(percentile(s, 0.5)),
    p75_hours: round(percentile(s, 0.75)),
    target_hours: target,
    within_target: s.length ? s.filter((v) => v <= target).length / s.length : null
  }
}

function tally<K extends string>(
  facts: TicketFact[],
  key: (f: TicketFact) => K | null,
  label: string
) {
  const m = new Map<string, number>()
  for (const f of facts) {
    const k = key(f) ?? label
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()]
    .map(([name, tickets]) => ({ name, tickets }))
    .sort((a, z) => z.tickets - a.tickets)
}

export function summarizeSupport(facts: TicketFact[], targets = DEFAULT_TARGETS, topN = 10) {
  const closed = facts.filter((f) => f.completed_at && f.status === 'done')
  const answered = facts.filter((f) => f.first_reply_at)
  const everClosed = facts.filter(
    (f) => f.reopened || f.status === 'done' || f.status === 'cancelled'
  )
  const requesters = new Map<string, { name: string | null; tickets: number }>()
  for (const f of facts) {
    const r = requesters.get(f.requester) ?? { name: f.requester_name, tickets: 0 }
    r.tickets++
    requesters.set(f.requester, r)
  }
  const withMedia = facts.filter((f) => f.has_clip || f.has_screenshot).length
  return {
    totals: {
      tickets: facts.length,
      open: facts.filter((f) => f.status === 'open' || f.status === 'in_progress').length,
      done: facts.filter((f) => f.status === 'done').length,
      cancelled: facts.filter((f) => f.status === 'cancelled').length
    },
    by_type: tally(facts, (f) => f.category, 'No type'),
    by_team: tally(facts, (f) => f.team, 'Administrators'),
    first_response: timing(
      answered.map((f) => hours(f.created_at, f.first_reply_at as Date | string)),
      targets.first_response_hours
    ),
    resolution: timing(
      closed.map((f) => hours(f.created_at, f.completed_at as Date | string)),
      targets.resolution_hours
    ),
    reopen: {
      reopened: facts.filter((f) => f.reopened).length,
      closed_ever: everClosed.length,
      rate: everClosed.length ? facts.filter((f) => f.reopened).length / everClosed.length : null
    },
    by_collection: tally(facts, (f) => f.collection, 'General Support')
      .map((r) => ({ collection: r.name, tickets: r.tickets }))
      .slice(0, topN),
    evidence: {
      with_clip: facts.filter((f) => f.has_clip).length,
      with_screenshot: facts.filter((f) => f.has_screenshot).length,
      with_either: withMedia,
      share: facts.length ? withMedia / facts.length : null
    },
    busiest_requesters: [...requesters.entries()]
      .map(([id, r]) => ({ id, name: r.name, tickets: r.tickets }))
      .sort((a, z) => z.tickets - a.tickets)
      .slice(0, topN)
  }
}

interface TicketRowLite {
  id: number
  category_name: string | null
  team_name: string | null
  collection: string | null
  created_by: string
  r_first: string | null
  r_last: string | null
  created_at: Date | string
  completed_at: Date | string | null
  status: string
  attachments: string | null
  replay_recording_id?: string | null
  issue_id?: number | null
}

/** `teamIds` null = every team (administrators). */
export async function loadSupportAnalytics(opts: {
  days: number
  teamIds: number[] | null
  targets?: typeof DEFAULT_TARGETS
}) {
  const since = new Date(Date.now() - opts.days * 86_400_000)
  const hasReplay = await hasColumn('nivaro_tasks', 'replay_recording_id')
  const hasIssue = await hasColumn('nivaro_tasks', 'issue_id')
  const q = db('nivaro_tasks as t')
    .leftJoin('nivaro_users as r', 't.created_by', 'r.id')
    .leftJoin('nivaro_task_categories as c', 't.category_id', 'c.id')
    .leftJoin('nivaro_user_groups as g', 't.team_id', 'g.id')
    .where('t.kind', SUPPORT_KIND)
    .where('t.created_at', '>=', since)
    .orderBy('t.created_at', 'desc')
    .limit(TICKET_CAP)
    .select(
      't.id',
      't.collection',
      't.created_by',
      't.created_at',
      't.completed_at',
      't.status',
      't.attachments',
      'r.first_name as r_first',
      'r.last_name as r_last',
      'c.name as category_name',
      'g.name as team_name',
      ...(hasReplay ? ['t.replay_recording_id'] : []),
      ...(hasIssue ? ['t.issue_id'] : [])
    )
  if (opts.teamIds) q.whereIn('t.team_id', opts.teamIds.length ? opts.teamIds : [-1])
  const rows = (await q) as TicketRowLite[]
  const ids = rows.map((r) => String(r.id))

  const replies = await selectInChunks(ids, 900, (chunk) =>
    db('nivaro_comments')
      .where('collection', 'nivaro_tasks')
      .whereNull('deleted_at')
      .whereIn('item', chunk)
      .select('item', 'user', 'created_at')
      .catch(() => [])
  )
  const firstReply = new Map<string, Date | string>()
  const makers = new Map(rows.map((r) => [String(r.id), String(r.created_by).toUpperCase()]))
  for (const c of replies as Array<{
    item: string
    user: string | null
    created_at: Date | string
  }>) {
    if (!c.user || String(c.user).toUpperCase() === makers.get(String(c.item))) continue
    const prev = firstReply.get(String(c.item))
    if (!prev || new Date(c.created_at) < new Date(prev))
      firstReply.set(String(c.item), c.created_at)
  }

  const reopenRows = await selectInChunks(ids, 900, (chunk) =>
    db('nivaro_activity')
      .where('collection', 'nivaro_tasks')
      .whereIn('item', chunk)
      .where((w) =>
        w.where('comment', 'like', 'Done →%').orWhere('comment', 'like', 'Cancelled →%')
      )
      .select('item')
      .catch(() => [])
  )
  const reopened = new Set((reopenRows as Array<{ item: string }>).map((r) => String(r.item)))

  const facts: TicketFact[] = rows.map((r) => ({
    id: r.id,
    category: r.category_name,
    team: r.team_name,
    collection: r.collection,
    requester: String(r.created_by).toUpperCase(),
    requester_name: userName({ first_name: r.r_first, last_name: r.r_last }),
    created_at: r.created_at,
    completed_at: r.completed_at,
    status: r.status,
    first_reply_at: firstReply.get(String(r.id)) ?? null,
    reopened: reopened.has(String(r.id)),
    has_clip: !!r.replay_recording_id,
    has_screenshot: !!r.issue_id || !!r.attachments
  }))
  return {
    window: { days: opts.days, from: since.toISOString(), truncated: rows.length >= TICKET_CAP },
    ...summarizeSupport(facts, opts.targets ?? DEFAULT_TARGETS)
  }
}
