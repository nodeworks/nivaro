import type { TrackerAny } from '@nivaro/shared'
import { parseIssueTitle } from '../issues/issue-title'
import { SOURCE_LABEL } from '../issues/types'
import type { OverviewColumn } from './sections-meta'

/**
 * The Overview "Issues" section as data (no React): which quick filter asks the issue log what,
 * where each filter's links land on /issues, and how a row of GET /api/issues reads on the card.
 */

export type IssuesFilter = 'open' | 'new-today' | 'linked' | 'unlinked' | 'suggested'

export interface IssuesFilterOption {
  value: IssuesFilter
  label: string
  /** Asks GitLab sync (offered only while sync is on with a connection that takes issues). */
  gitlab: boolean
}

export const ISSUES_FILTERS: IssuesFilterOption[] = [
  { value: 'open', label: 'Open', gitlab: false },
  { value: 'new-today', label: 'New today', gitlab: false },
  { value: 'linked', label: 'In GitLab', gitlab: true },
  { value: 'unlinked', label: 'Not in GitLab', gitlab: true },
  { value: 'suggested', label: 'Suggested', gitlab: true }
]

/** Rows a column shows before "N more". */
export const ROW_CAP: Record<OverviewColumn, number> = { side: 8, main: 15 }

export function filterOptions(gitlabTools: boolean): IssuesFilterOption[] {
  return ISSUES_FILTERS.filter((f) => gitlabTools || !f.gitlab)
}

/** The filter to use: the remembered one when it is still offered, else Open. */
export function effectiveFilter(stored: unknown, gitlabTools: boolean): IssuesFilter {
  const hit = filterOptions(gitlabTools).find((f) => f.value === stored)
  return hit ? hit.value : 'open'
}

/** Status + GitLab params shared by the API read and the /issues links. */
function filterParams(filter: IssuesFilter): URLSearchParams {
  const p = new URLSearchParams()
  // "Open" on the card = everything still being worked: open AND in progress.
  p.set('status', 'active')
  if (filter === 'linked' || filter === 'unlinked' || filter === 'suggested')
    p.set('tracker', filter)
  return p
}

/** GET /api/issues query for a filter: last seen first (New today: newest first), with people. */
export function listQuery(filter: IssuesFilter, opts: { limit: number; dayStart: string }): string {
  const p = filterParams(filter)
  if (filter === 'new-today') p.set('created_after', opts.dayStart)
  p.set('sort', filter === 'new-today' ? 'newest' : 'last_seen')
  p.set('limit', String(opts.limit))
  p.set('people', '1')
  return p.toString()
}

/** The issue log, filtered like the card (the page has no "raised today" filter: newest first). */
export function pageLink(filter: IssuesFilter): string {
  const p = filterParams(filter)
  if (filter === 'new-today') p.set('sort', 'newest')
  return `/issues?${p.toString()}`
}

/** One issue opened on /issues, its list filtered like the card. */
export function issueLink(id: number, filter: IssuesFilter): string {
  return pageLink(filter).replace('/issues?', `/issues/${id}?`)
}

// ── Rows ────────────────────────────────────────────────────────────────────

export interface IssueRowInput {
  id: number
  title: string
  severity: string
  status: string
  source?: string | null
  details?: string | null
  collection?: string | null
  item?: string | null
  occurrence_count?: number | null
  people?: number | null
  last_seen_at?: string | null
  created_at: string
  tracker?: TrackerAny | null
  tracker_suggested_rule?: number | null
}

export type IssueGitlab =
  | { kind: 'linked'; tracker: TrackerAny }
  | { kind: 'suggested' }
  | { kind: 'none' }

export interface IssueRowView {
  id: number
  severity: string
  status: string
  headline: string
  /** Route, job or screen (or collection/item) it came from. */
  where: string | null
  /** The full line for the tooltip: where + headline. */
  fullTitle: string
  /** server | client | manual (SourceTag words it). */
  source: string | null
  sourceLabel: string | null
  /** The front end a browser crash came from ("admin", "efp-new") and its build. */
  app: string | null
  release: string | null
  hits: number
  people: number
  countText: string
  lastSeen: string
  /** null while GitLab sync is off (no GitLab bits at all). */
  gitlab: IssueGitlab | null
}

/** "app=… ; release=…" from a grouped crash's details header (services/crash-signature.ts). */
export function crashAppOf(details: string | null | undefined): {
  app: string | null
  release: string | null
} {
  const lines = String(details ?? '').split('\n')
  const at = /^Alerted: /.test(lines[0] ?? '') ? 1 : 0
  if (!/^Route: /.test(lines[at] ?? '')) return { app: null, release: null }
  const m = /^Crash: (.*)$/.exec(lines[at + 1] ?? '')
  if (!m) return { app: null, release: null }
  const f: Record<string, string> = {}
  for (const part of m[1].split(';')) {
    const i = part.indexOf('=')
    if (i > 0) f[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  const clean = (v: string | undefined) => (v && v !== 'unknown' ? v.slice(0, 40) : null)
  return { app: clean(f.app), release: clean(f.release) }
}

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

/** "12× · 4 people", "Once", "3× · 1 person". People only when the counters saw any. */
export function countText(hits: number, people: number): string {
  const h = hits > 1 ? `${hits.toLocaleString('en-US')}×` : 'Once'
  return people > 0 ? `${h} · ${plural(people, 'person', 'people')}` : h
}

export function issueRowView(issue: IssueRowInput, gitlabOn: boolean): IssueRowView {
  const t = parseIssueTitle(issue.title)
  const source = issue.source ?? t.source
  const where =
    t.where ??
    (issue.collection ? `${issue.collection}${issue.item ? `/${issue.item}` : ''}` : null)
  const crash = source === 'client' ? crashAppOf(issue.details) : { app: null, release: null }
  const hits = Math.max(1, Number(issue.occurrence_count) || 1)
  const people = Math.max(0, Number(issue.people) || 0)
  let gitlab: IssueGitlab | null = null
  if (issue.tracker) gitlab = { kind: 'linked', tracker: issue.tracker }
  else if (gitlabOn)
    gitlab = issue.tracker_suggested_rule != null ? { kind: 'suggested' } : { kind: 'none' }
  return {
    id: issue.id,
    severity: issue.severity,
    status: issue.status,
    headline: t.headline || 'Untitled issue',
    where,
    fullTitle: where ? `${where} — ${t.headline}` : t.headline,
    source: source ?? null,
    sourceLabel: source ? (SOURCE_LABEL[source] ?? source) : null,
    app: crash.app,
    release: crash.release,
    hits,
    people,
    countText: countText(hits, people),
    lastSeen: issue.last_seen_at ?? issue.created_at,
    gitlab
  }
}

// ── Header counts ───────────────────────────────────────────────────────────

export interface SeverityCount {
  severity: 'critical' | 'high' | 'medium' | 'low'
  n: number
}

/** Open (open + in progress) issues per severity, most severe first, zeros left out. */
export function severityCounts(summary: unknown): { counts: SeverityCount[]; total: number } {
  const raw = (summary as { active_by_severity?: Record<string, unknown> } | null | undefined)
    ?.active_by_severity
  const by = raw && typeof raw === 'object' ? raw : {}
  const order: SeverityCount['severity'][] = ['critical', 'high', 'medium', 'low']
  const counts = order
    .map((severity) => ({ severity, n: Math.max(0, Number(by[severity]) || 0) }))
    .filter((c) => c.n > 0)
  return { counts, total: counts.reduce((s, c) => s + c.n, 0) }
}

// ── Remembered filter (per person, this browser) ────────────────────────────

const storeKey = (userId: string) => `nvr:overview-issues-filter:${userId || '-'}`

export function readStoredFilter(userId: string): string | null {
  try {
    return localStorage.getItem(storeKey(userId))
  } catch {
    return null
  }
}

export function writeStoredFilter(userId: string, filter: IssuesFilter): void {
  try {
    if (filter === 'open') localStorage.removeItem(storeKey(userId))
    else localStorage.setItem(storeKey(userId), filter)
  } catch {
    // private window / blocked storage: the choice lasts this visit only
  }
}
