import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import {
  fetchConnections,
  type LabelOptions,
  type SyncOptions,
  type TrackerConnection,
  trackerKeys
} from '../issue-trackers/api'

/**
 * GitLab on the issue log: the shapes GET /issues and GET /issues/:id add while GitLab sync is on
 * (api/src/services/trackers/issue-log.ts), the gate every GitLab bit on the page asks, and the
 * pure rules the pieces share.
 */

/** Admins: the whole link (services/trackers/link-store.ts LinkView). */
export interface TrackerLink {
  id: number
  connection: number
  web_url: string
  project_path: string
  iid: number
  remote_state: string
  remote_title: string
  labels: string[]
  assignees: string[]
  milestone: string | null
  created_via: string
  sync_error: string | null
  members: number[]
  sources: Array<{ kind: 'issue' | 'ticket' | 'record'; id: string }>
}

/** Everyone else: the chip only (links.ts chipOf). */
export interface TrackerChip {
  iid: number
  web_url: string
  state: string
  title: string
}

export type IssueTracker = TrackerLink | TrackerChip

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

/** The fields GitLab sync adds to an issue row (all absent while it is off). */
export interface IssueTrackerFields {
  tracker?: IssueTracker | null
  tracker_suggested_rule?: number | null
  tracker_members?: TrackerMember[]
  tracker_members_total?: number
  tracker_pending?: TrackerPending[]
}

export interface SimilarCandidate {
  link_id: number | null
  project_id: number
  iid: number
  web_url: string
  title: string
  score: number
  linked: boolean
}

export interface BulkResult {
  issue: number
  ok: boolean
  outbox_id?: number
  error?: string
  code?: string
}

export const BULK_MAX = 50

export const issueGitlabKeys = {
  featurePublic: () => ['trackers', 'feature', 'public'] as const,
  similar: (issue: number, connection: number, project: number | null) =>
    ['trackers', 'issue-similar', issue, connection, project] as const,
  sample: (issue: number) => ['trackers', 'issue-sample', issue] as const
}

/** GET /trackers/feature/public; a 404 (cloud mode: the routes are not mounted) = off. */
export async function fetchFeaturePublic(): Promise<boolean> {
  try {
    const r = await api.get<{ data: { enabled: boolean } }>('/trackers/feature/public')
    return !!r.data.data?.enabled
  } catch (err) {
    if ((err as { response?: { status?: number } })?.response?.status === 404) return false
    throw err
  }
}

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
  const feature = useQuery({
    queryKey: issueGitlabKeys.featurePublic(),
    queryFn: fetchFeaturePublic,
    staleTime: 60_000,
    retry: false
  })
  const on = feature.data === true
  const conns = useQuery({
    queryKey: trackerKeys.connections(),
    queryFn: fetchConnections,
    enabled: on && isAdmin,
    staleTime: 60_000,
    retry: false
  })
  const connections = on && isAdmin ? issueConnections(conns.data) : []
  return { on, isAdmin, connections, adminTools: on && isAdmin && connections.length > 0 }
}

// ── Pure rules ──────────────────────────────────────────────────────────────

export function isLink(t: IssueTracker | null | undefined): t is TrackerLink {
  return !!t && typeof (t as TrackerLink).remote_state === 'string'
}

/** The chip of either shape. */
export function chipOf(t: IssueTracker): TrackerChip {
  return isLink(t)
    ? { iid: t.iid, web_url: t.web_url, state: t.remote_state, title: t.remote_title }
    : t
}

/** GitLab's `opened` / `closed` in the issue log's words. */
export function stateWord(state: string): string {
  if (state === 'opened') return 'open'
  if (state === 'closed') return 'closed'
  return state || 'unknown'
}

/** Only http(s) links leave the app (a stored URL is GitLab's, but never trust it blindly). */
export function safeHref(url: string): string | null {
  return /^https?:\/\/\S+$/i.test(url) ? url : null
}

const JOINED: Record<string, string> = {
  lead: 'Opened it',
  fingerprint: 'Same error',
  group: 'Grouped with it',
  similar: 'Looked similar',
  manual: 'Added by hand'
}
export function joinedViaLabel(via: string): string {
  return JOINED[via] ?? via
}

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined =>
  rec && Object.keys(rec).includes(key) ? rec[key] : undefined

function mergeLabels(...lists: Array<Array<string | undefined> | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists)
    for (const raw of list ?? []) {
      const v = (raw ?? '').trim()
      if (!v || seen.has(v.toLowerCase())) continue
      seen.add(v.toLowerCase())
      out.push(v)
    }
  return out
}

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

/** "91%" for a similarity score 0..1. */
export function percent(score: number): string {
  return `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`
}
