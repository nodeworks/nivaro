import {
  mergeLabels,
  type TrackerAny,
  type TrackerLink,
  type TrackerMember,
  type TrackerPending,
  trackerQueryKeys,
  useTrackerFeature
} from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/lib/auth'
import {
  fetchConnections,
  type LabelOptions,
  type SyncOptions,
  type TrackerConnection
} from '../issue-trackers/api'

/**
 * GitLab on the issue log: the shapes GET /issues and GET /issues/:id add while GitLab sync is on
 * (api/src/services/trackers/issue-log.ts), the gate every GitLab bit on the page asks, and the
 * pure rules the pieces share.
 */

export type { TrackerAny as IssueTracker, TrackerLink, TrackerMember, TrackerPending }

/** The fields GitLab sync adds to an issue row (all absent while it is off). */
export interface IssueTrackerFields {
  tracker?: TrackerAny | null
  tracker_suggested_rule?: number | null
  tracker_members?: TrackerMember[]
  tracker_members_total?: number
  tracker_pending?: TrackerPending[]
}

export interface BulkResult {
  issue: number
  ok: boolean
  outbox_id?: number
  error?: string
  code?: string
}

export const BULK_MAX = 50

/** The connections a person may send issue-log entries to: active, with the issue log on. */
export function issueConnections(all: TrackerConnection[] | undefined): TrackerConnection[] {
  return (all ?? []).filter((c) => c.is_active && c.sync?.sources?.issue !== false)
}

/**
 * The gate for every GitLab bit on the issue log. `on` = the feature is on (the server's public
 * switch). Admins also get the connections that take issue-log entries; the admin tools render
 * only when there is at least one. Non-admins never read the connection list — they see what
 * the issue rows carry (the chip), which the server leaves out while sync is off.
 */
export function useIssueGitlab(): {
  on: boolean
  isAdmin: boolean
  connections: TrackerConnection[]
  /** Admin tools (filter, bulk create, the GitLab section) may render. */
  adminTools: boolean
} {
  const { user } = useAuth()
  const isAdmin = !!user?.is_admin
  const { on } = useTrackerFeature()
  const conns = useQuery({
    queryKey: trackerQueryKeys.connections(),
    queryFn: fetchConnections,
    enabled: on && isAdmin,
    staleTime: 60_000,
    retry: false
  })
  const connections = on && isAdmin ? issueConnections(conns.data) : []
  return { on, isAdmin, connections, adminTools: on && isAdmin && connections.length > 0 }
}

// ── Pure rules ──────────────────────────────────────────────────────────────

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined =>
  rec && Object.keys(rec).includes(key) ? rec[key] : undefined

const SEVERITY_ALIAS: Record<string, string> = { info: 'low', warning: 'medium', error: 'high' }

/**
 * The labels the connection puts on every new GitLab issue for this one — always + by severity +
 * by source + the mapped priority and lane (mirrors labels.ts labelsFor + mappedLabelsFor). The
 * create form shows them as fixed: the server adds them whatever the form sends.
 */
export function connectionLabelsFor(
  issue: { severity: string; status: string; source?: string | null },
  sync: Partial<Pick<SyncOptions, 'labels' | 'priority_map' | 'lane_map'>> | undefined
): string[] {
  const labels: Partial<LabelOptions> = sync?.labels ?? {}
  const sev = SEVERITY_ALIAS[issue.severity] ?? issue.severity
  const source = String(issue.source ?? '')
    .trim()
    .toLowerCase()
  return mergeLabels(labels.always, own(labels.by_severity, sev), own(labels.by_source, source), [
    own(sync?.priority_map as Record<string, string | undefined>, sev),
    own(sync?.lane_map as Record<string, string | undefined>, issue.status)
  ])
}

export interface BulkSummary {
  queued: number[]
  alreadyLinked: number[]
  refused: Array<{ issue: number; reason: string }>
}

/** Per-id outcomes of POST /trackers/links/bulk, grouped for the bulk bar. */
export function summarizeBulk(results: BulkResult[]): BulkSummary {
  const out: BulkSummary = { queued: [], alreadyLinked: [], refused: [] }
  for (const r of results) {
    if (r.ok) out.queued.push(r.issue)
    else if (r.code === 'ALREADY_LINKED') out.alreadyLinked.push(r.issue)
    else out.refused.push({ issue: r.issue, reason: r.error || 'Could not queue it' })
  }
  return out
}

export function bulkSentence(s: BulkSummary): string {
  const parts: string[] = []
  if (s.queued.length) parts.push(`${s.queued.length} sent to GitLab`)
  if (s.alreadyLinked.length) parts.push(`${s.alreadyLinked.length} already linked`)
  if (s.refused.length) parts.push(`${s.refused.length} refused`)
  return parts.join(' · ') || 'Nothing was sent'
}
