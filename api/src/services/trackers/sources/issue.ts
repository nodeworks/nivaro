import {
  type IssueSeverity,
  type IssueStatus,
  setIssueSeverity,
  setIssueStatus
} from '../../issue-status.js'
import { issueVars, loadIssue } from '../issue-body.js'
import { addTrackerComment } from './comments.js'
import type { TrackerSource } from './types.js'

/**
 * Issue-log entries. Reads go through issue-body.ts (the same variables every issue template
 * gets), status / severity writes through services/issue-status.ts (the issue page's own write
 * path), comments land on `nivaro_issues` threads. Issue-log GitLab work is admin-only.
 */
export const issueSource: TrackerSource = {
  kind: 'issue',

  async load(id, opts = {}) {
    const issueId = Number(id)
    if (!Number.isSafeInteger(issueId)) return null
    const row = await loadIssue(issueId)
    if (!row) return null
    const vars = await issueVars(row, opts.includeDetails !== false)
    return {
      kind: 'issue',
      id: String(issueId),
      title: String(row.title ?? ''),
      body: row.details == null ? null : String(row.details),
      status: row.status == null ? null : String(row.status),
      priority: row.severity == null ? null : String(row.severity),
      url: String(vars.nivaro_url ?? ''),
      fingerprint: row.fingerprint ? String(row.fingerprint) : null,
      vars
    }
  },

  async canCreate(_user, id, isAdmin) {
    if (!isAdmin) return false
    return !!(await loadIssue(Number(id)))
  },

  async setStatus(id, status, actor) {
    await setIssueStatus(
      Number(id),
      status as IssueStatus,
      { userId: actor.userId, via: 'gitlab' },
      actor.note
    )
  },

  async setPriority(id, priority, actor) {
    await setIssueSeverity(
      Number(id),
      priority as IssueSeverity,
      { userId: actor.userId, via: 'gitlab' },
      actor.note
    )
  },

  async addComment(id, text, meta) {
    await addTrackerComment('nivaro_issues', Number(id), text, meta)
  },

  ref: (id) => ({ collection: 'nivaro_issues', item: String(id) }),
  readers: () => 'everyone-who-can-read'
}
