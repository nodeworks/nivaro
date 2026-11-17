import type { FastifyRequest } from 'fastify'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { noteIssueWrite } from './issue-raise.js'

/**
 * The one write path for issue-log changes: PATCH /issues/:id, POST /issues/bulk-status and the
 * GitLab inbound side all write the row here, tell the issue-write funnel (`noteIssueWrite`
 * 'changed' — the GitLab rule engine and hit counters listen to it) and write the activity row.
 */

export const ISSUE_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const
export type IssueStatus = (typeof ISSUE_STATUSES)[number]
export const ISSUE_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number]

export interface IssueActor {
  userId: string
  /** 'gitlab' = a change read from GitLab, written as the GitLab machine user. */
  via: 'user' | 'gitlab'
  /** The request the change arrived on (caller columns on the activity row). */
  req?: FastifyRequest
}

async function commit(
  q: Knex.QueryBuilder,
  ids: number[],
  patch: Record<string, unknown>,
  activity: (updated: number) => Parameters<typeof logActivity>[0]
): Promise<number> {
  const n = Number(await q.update({ ...patch, updated_at: new Date() })) || 0
  for (const id of ids) noteIssueWrite(id, 'changed')
  await logActivity(activity(n))
  return n
}

/** One issue: write `patch`, tell the funnel, one 'update' activity row (comment = `note`). */
export async function writeIssuePatch(
  issueId: number,
  patch: Record<string, unknown>,
  actor: IssueActor,
  note?: string
): Promise<void> {
  await commit(db('nivaro_issues').where({ id: issueId }), [issueId], patch, () => ({
    action: 'update',
    user: actor.userId,
    collection: 'nivaro_issues',
    item: String(issueId),
    ...(note ? { comment: note } : {}),
    ...(actor.via === 'gitlab' ? { origin: 'integration' } : {}),
    req: actor.req
  }))
}

export async function setIssueStatus(
  issueId: number,
  status: IssueStatus,
  actor: IssueActor,
  note?: string
): Promise<void> {
  await writeIssuePatch(issueId, { status }, actor, note)
}

export async function setIssueSeverity(
  issueId: number,
  severity: IssueSeverity,
  actor: IssueActor,
  note?: string
): Promise<void> {
  await writeIssuePatch(issueId, { severity }, actor, note)
}

/**
 * Several issues at once (bulk status): `scope` is the caller's already-gated update query over
 * `ids`; one 'issue-bulk-status' activity row. Returns the number of rows changed.
 */
export async function setIssuesStatus(
  scope: Knex.QueryBuilder,
  ids: number[],
  status: IssueStatus,
  actor: IssueActor
): Promise<number> {
  return commit(scope, ids, { status }, (updated) => ({
    action: 'issue-bulk-status',
    user: actor.userId,
    collection: 'nivaro_issues',
    comment: `${updated} issue(s) -> ${status}`,
    req: actor.req
  }))
}
