/**
 * GitLab issue sync (issue trackers) on the shared surfaces: the shapes the API answers
 * (api/src/routes/trackers.ts, services/trackers/link-store.ts LinkView, links.ts chipOf) and the
 * pure rules every GitLab piece shares — the issue log in admin, support tickets and record pages
 * in admin and every portal.
 */

export type TrackerSourceKind = 'issue' | 'ticket' | 'record'

/** What a GitLab issue is made from: an issue-log entry, a support ticket, or a record. */
export interface TrackerSourceRef {
  kind: TrackerSourceKind
  /** Issue / ticket id, or `<collection>:<id>` for a record. */
  id: string
}

/** Administrators: the whole link (LinkView). */
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
  sources: Array<{ kind: TrackerSourceKind; id: string }>
}

/**
 * Everyone else: the chip only. Its title is never GitLab's for a non-admin — it is the title of
 * the ticket / record / issue they asked about, as they read it (or empty).
 */
export interface TrackerChipData {
  iid: number
  web_url: string
  state: string
  title: string
  /** GET /trackers/links/for answers it to administrators. */
  connection?: number
}

export type TrackerAny = TrackerLink | TrackerChipData

export interface TrackerMember {
  kind: TrackerSourceKind
  id: string
  title: string | null
  status: string | null
  joined_via: string
  joined_at: string | null
  /** Similarity 0..1 when it joined as a look-alike; absent / null otherwise. */
  score?: number | null
}

export interface TrackerPending {
  id: number
  op: string
  status: string
  attempts: number
  last_error: string | null
  next_attempt_at: string | null
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

export interface GitlabLabel {
  name: string
  color: string
  description: string | null
}

export interface GitlabProject {
  id: number
  path_with_namespace: string
}

export interface GitlabUser {
  id: number
  username: string
  name: string
}

export interface TemplateSample {
  title: string
  body: string
  labels: string[]
}

/** The parts of a connection's sync options the shared screens read (admins only). */
export interface TrackerSyncLike {
  labels?: {
    always?: string[]
    by_severity?: Record<string, string[]>
    by_source?: Record<string, string[]>
    on_example?: string[]
  }
  priority_map?: Record<string, string | undefined>
  lane_map?: Record<string, string | undefined>
  ticket_priority_map?: Record<string, string | undefined>
  ticket_lane_map?: Record<string, string | undefined>
  sources?: Partial<Record<TrackerSourceKind, boolean>>
}

/**
 * A connection someone may create on. Non-admins get id, name and default project only (GET
 * /trackers/creatable); administrators also the address, default project id, token state and
 * sync options (GET /trackers).
 */
export interface TrackerConnectionInfo {
  id: number
  name: string
  default_project_path: string | null
  base_url?: string
  default_project_id?: number | null
  token_set?: boolean
  is_active?: boolean
  sync?: TrackerSyncLike
}

// ── Pure rules ──────────────────────────────────────────────────────────────

export function isLink(t: TrackerAny | null | undefined): t is TrackerLink {
  return !!t && typeof (t as TrackerLink).remote_state === 'string'
}

/** The chip of either shape. */
export function chipOf(t: TrackerAny): TrackerChipData {
  return isLink(t)
    ? { iid: t.iid, web_url: t.web_url, state: t.remote_state, title: t.remote_title }
    : t
}

/** GitLab's `opened` / `closed` in the app's words. */
export function stateWord(state: string): string {
  if (state === 'opened') return 'open'
  if (state === 'closed') return 'closed'
  return state || 'unknown'
}

/** How a chip reads: a sync error (administrators only) wins over the state. */
export function chipTone(t: TrackerAny): 'open' | 'closed' | 'error' {
  if (isLink(t) && t.sync_error) return 'error'
  return chipOf(t).state === 'closed' ? 'closed' : 'open'
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

/** "91%" for a similarity score 0..1. */
export function percent(score: number): string {
  return `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`
}

/** A label as the server stores it (labels.ts safeLabel): one line, no comment opener. */
export function cleanLabel(raw: string): string {
  return raw
    .replace(/<!--/g, '')
    .replace(/[\r\n,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255)
    .trim()
}

/** A label GitLab does not have yet (it is created on first use). */
export function isNewLabel(name: string, known: GitlabLabel[] | undefined): boolean {
  if (!known) return false
  const k = name.trim().toLowerCase()
  return !known.some((l) => l.name.toLowerCase() === k)
}

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined =>
  rec && Object.keys(rec).includes(key) ? rec[key] : undefined

/** Labels merged case-insensitively, first spelling kept, blanks dropped. */
export function mergeLabels(...lists: Array<Array<string | undefined> | undefined>): string[] {
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

/** The labels a connection puts on every new GitLab issue whatever it is made from. */
export function alwaysLabels(sync: TrackerSyncLike | undefined): string[] {
  return mergeLabels(sync?.labels?.always)
}

/**
 * The labels the connection puts on a GitLab issue made from a support ticket: always + the
 * mapped priority + the mapped lane (mirrors source-body.ts ticketMappedLabels; cancelled rides
 * the done lane).
 */
export function ticketLabelsFor(
  ticket: { priority?: string | null; status?: string | null },
  sync: TrackerSyncLike | undefined
): string[] {
  const lane = ticket.status === 'cancelled' ? 'done' : String(ticket.status ?? '')
  return mergeLabels(sync?.labels?.always, [
    own(sync?.ticket_priority_map, String(ticket.priority ?? '')),
    own(sync?.ticket_lane_map, lane)
  ])
}

/** The body naming a source on the links routes (`{issue}` for the issue log, as before). */
export function sourceBody(source: TrackerSourceRef): Record<string, unknown> {
  return source.kind === 'issue'
    ? { issue: Number(source.id) }
    : { source_kind: source.kind, source_id: source.id }
}

/** The connection a pasted GitLab URL belongs to (same host), if any. */
export function connectionForUrl(
  url: string,
  connections: TrackerConnectionInfo[]
): TrackerConnectionInfo | undefined {
  let host: string
  try {
    host = new URL(url.trim()).host.toLowerCase()
  } catch {
    return undefined
  }
  return connections.find((c) => {
    if (!c.base_url) return false
    try {
      return new URL(c.base_url).host.toLowerCase() === host
    } catch {
      return false
    }
  })
}

/** Words for a queued outbox change. */
export const OP_WORDS: Record<string, string> = {
  create: 'Create the GitLab issue',
  note: 'Post a note',
  state: 'Change its state',
  labels: 'Change its labels',
  comment: 'Send a comment'
}

/** How a member of a GitLab issue is named in the examples list. */
export function memberName(m: TrackerMember): string {
  if (m.kind === 'issue') return m.title || `Issue #${m.id}`
  if (m.kind === 'ticket') return m.title || `Support request #${m.id}`
  return m.title || `Record ${m.id}`
}
