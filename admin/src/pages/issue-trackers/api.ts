import { api } from '@/lib/api'

/**
 * Issue trackers (GitLab sync) — the admin tab's types, query keys, reads and
 * the pure rules the screens lean on. Shapes mirror api/src/routes/trackers.ts
 * and api/src/services/trackers/connections.ts (normalizeSync is the source of
 * truth for the sync options).
 */

export const TOKEN_MASK = '••••••••'

export type FeatureSource = 'env' | 'setting' | 'default' | 'cloud'
export interface FeatureState {
  enabled: boolean
  source: FeatureSource
}

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export type Severity = (typeof SEVERITIES)[number]
export const LANE_KEYS = ['open', 'in_progress', 'resolved', 'closed'] as const
export type LaneKey = (typeof LANE_KEYS)[number]
export const TICKET_PRIORITIES = ['low', 'normal', 'urgent'] as const
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]
export const TICKET_LANE_KEYS = ['open', 'in_progress', 'done'] as const
export type TicketLane = (typeof TICKET_LANE_KEYS)[number]

export interface LabelOptions {
  always: string[]
  by_severity: Record<string, string[]>
  by_source: Record<string, string[]>
  on_example: string[]
}

export interface SimilarOptions {
  enabled: boolean
  join_at: number
  suggest_at: number
}

export interface SourceSwitches {
  issue: boolean
  ticket: boolean
  record: boolean
}

export interface SyncOptions {
  status_map: { closed: 'resolved' | 'closed' }
  close_on_resolve: boolean
  reopen_on_recur: boolean
  recur_when_closed: 'reopen' | 'new'
  comments: boolean
  seen_note: boolean
  seen_note_min_minutes: number
  labels: LabelOptions
  similar: SimilarOptions
  priority_map: Partial<Record<Severity, string>>
  lane_map: Partial<Record<LaneKey, string>>
  priority_two_way: boolean
  lanes_two_way: boolean
  push_to_linked: boolean
  ticket_priority_map: Partial<Record<TicketPriority, string>>
  ticket_lane_map: Partial<Record<TicketLane, string>>
  create_roles: string[]
  sources: SourceSwitches
}

export interface TrackerConnection {
  id: number
  name: string
  provider: 'gitlab'
  base_url: string
  default_project_id: number | null
  default_project_path: string | null
  is_active: boolean
  sync: SyncOptions
  status: 'ok' | 'broken'
  last_ok_at: string | null
  last_error: string | null
  last_webhook_at: string | null
  last_reconcile_at: string | null
  token_set: boolean
}

/** POST / answers the new connection plus its webhook secret (shown once) and URL. */
export interface CreatedConnection extends TrackerConnection {
  webhook_secret: string
  webhook_url: string
}

export interface TrackerHealth {
  outbox: { pending: number; dead: number }
  last_webhook_at: string | null
  last_reconcile_at: string | null
  status: 'ok' | 'broken'
}

export interface OutboxRow {
  id: number
  connection: number
  link: number | null
  source_kind: string
  source_id: string
  op: string
  status: string
  attempts: number
  next_attempt_at: string | null
  last_error: string | null
  created_at: string | null
  done_at: string | null
}

export type TestResult =
  | {
      ok: true
      user: { username: string; name: string }
      project: { id: number; path_with_namespace: string } | null
      access_level: number | null
      webhook: { last_seen_at: string | null }
    }
  | { ok: false; error: string; hint: string }

export interface GitlabProject {
  id: number
  path_with_namespace: string
}

export interface GitlabLabel {
  name: string
  color: string
  description: string | null
}

export interface Role {
  id: string
  name: string
}

// ── Query keys: every tracker read lives under ['trackers', …] ─────────────

export const trackerKeys = {
  all: ['trackers'] as const,
  feature: () => ['trackers', 'feature'] as const,
  connections: () => ['trackers', 'connections'] as const,
  health: (id: number) => ['trackers', 'health', id] as const,
  outbox: (id: number, status: 'pending' | 'dead') => ['trackers', 'outbox', id, status] as const,
  projects: (id: number, search: string) => ['trackers', 'projects', id, search] as const,
  labels: (id: number, project: number | null) => ['trackers', 'labels', id, project] as const
}

// ── Reads ──────────────────────────────────────────────────────────────────

/**
 * The master switch. In cloud mode every /api/trackers route is unmounted, so a
 * 404 on this read means "not available here", never an error to show.
 */
export async function fetchFeature(): Promise<FeatureState> {
  try {
    return (await api.get<{ data: FeatureState }>('/trackers/feature')).data.data
  } catch (err) {
    if ((err as { response?: { status?: number } })?.response?.status === 404)
      return { enabled: false, source: 'cloud' }
    throw err
  }
}

export const fetchConnections = () =>
  api.get<{ data: TrackerConnection[] }>('/trackers').then((r) => r.data.data)

export const fetchHealth = (id: number) =>
  api.get<{ data: TrackerHealth }>(`/trackers/${id}/health`).then((r) => r.data.data)

export const fetchOutbox = (id: number, status: 'pending' | 'dead') =>
  api
    .get<{ data: OutboxRow[] }>('/trackers/outbox', { params: { connection: id, status } })
    .then((r) => r.data.data)

export const fetchProjects = (id: number, search: string) =>
  api
    .get<{ data: GitlabProject[] }>(`/trackers/${id}/projects`, { params: { search } })
    .then((r) => r.data.data)

export const fetchLabels = (id: number) =>
  api.get<{ data: GitlabLabel[] }>(`/trackers/${id}/labels`).then((r) => r.data.data)

// ── Pure rules ─────────────────────────────────────────────────────────────

/** Why the switch can't be changed here, or null when it can. */
export function featureLockReason(state: FeatureState | undefined): string | null {
  if (!state) return null
  if (state.source === 'cloud') return 'GitLab sync is not available in cloud mode.'
  if (state.source === 'env')
    return 'Set by the ISSUE_TRACKERS setting on the server. Change it there and restart.'
  return null
}

export interface ConnectionForm {
  name: string
  base_url: string
  /** What the token box holds: the mask while a saved token is untouched. */
  token: string
  default_project_id: number | null
  default_project_path: string | null
  is_active: boolean
}

export function formOf(conn: TrackerConnection | null): ConnectionForm {
  return {
    name: conn?.name ?? 'GitLab',
    base_url: conn?.base_url ?? '',
    token: conn?.token_set ? TOKEN_MASK : '',
    default_project_id: conn?.default_project_id ?? null,
    default_project_path: conn?.default_project_path ?? null,
    is_active: conn?.is_active ?? true
  }
}

/**
 * The body for POST / PATCH. Only changed fields go on a PATCH, and the token
 * only when a new one was typed: the mask (or an empty box) is never sent, so
 * the saved token is kept as it is.
 */
export function connectionBody(
  form: ConnectionForm,
  original: TrackerConnection | null
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const name = form.name.trim()
  const url = form.base_url.trim()
  const token = form.token.trim()
  const newToken = token !== '' && token !== TOKEN_MASK
  if (!original) {
    body.name = name
    body.base_url = url
    if (newToken) body.token = token
    if (form.default_project_id != null) {
      body.default_project_id = form.default_project_id
      body.default_project_path = form.default_project_path
    }
    body.is_active = form.is_active
    return body
  }
  if (name !== original.name) body.name = name
  if (url.replace(/\/+$/, '') !== original.base_url) body.base_url = url
  if (newToken) body.token = token
  if (form.default_project_id !== original.default_project_id) {
    body.default_project_id = form.default_project_id
    body.default_project_path = form.default_project_path
  }
  if (form.is_active !== original.is_active) body.is_active = form.is_active
  return body
}

/** True when a changed address needs a token typed again (the server refuses otherwise). */
export function needsTokenForNewUrl(form: ConnectionForm, original: TrackerConnection | null) {
  if (!original) return false
  const origin = (u: string) => {
    try {
      return new URL(u.trim()).origin.toLowerCase()
    } catch {
      return ''
    }
  }
  const token = form.token.trim()
  return (
    origin(form.base_url) !== origin(original.base_url) && (token === '' || token === TOKEN_MASK)
  )
}

/**
 * Labels that appear under more than one key of a map set (case-insensitive,
 * first spelling kept). A GitLab label coming back can only mean one priority
 * or one lane, so each must be distinct.
 */
export function duplicateLabels(...maps: Array<Record<string, string | undefined>>): string[] {
  const seen = new Map<string, string>()
  const dupes = new Map<string, string>()
  for (const map of maps) {
    for (const raw of Object.values(map)) {
      const v = (raw ?? '').trim()
      if (!v) continue
      const key = v.toLowerCase()
      if (seen.has(key)) dupes.set(key, seen.get(key) as string)
      else seen.set(key, v)
    }
  }
  return [...dupes.values()]
}

/** A label GitLab does not have yet (it is created on first use). */
export function isNewLabel(name: string, known: GitlabLabel[] | undefined): boolean {
  if (!known) return false
  const k = name.trim().toLowerCase()
  return !known.some((l) => l.name.toLowerCase() === k)
}

/** Label-safe the way the server stores it: no commas or line breaks, 255 chars max. */
export function cleanLabel(raw: string): string {
  return raw
    .replace(/<!--/g, '')
    .replace(/[\r\n,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255)
    .trim()
}

export const WEBHOOK_CHECK_MS = 30_000
export const WEBHOOK_POLL_MS = 3_000

/**
 * "Check it arrived": arrived once a webhook landed AFTER the click; timed out
 * when 30 s passed without one; waiting otherwise. An older delivery never
 * counts — it says nothing about the hook just set up.
 */
export function webhookCheckVerdict(
  lastWebhookAt: string | null | undefined,
  clickedAt: number,
  now: number
): 'arrived' | 'waiting' | 'timeout' {
  const seen = lastWebhookAt ? new Date(lastWebhookAt).getTime() : Number.NaN
  if (Number.isFinite(seen) && seen > clickedAt) return 'arrived'
  return now - clickedAt >= WEBHOOK_CHECK_MS ? 'timeout' : 'waiting'
}

export const WEBHOOK_SILENT_MS = 24 * 60 * 60 * 1000

/** No webhook for 24 h (or never): the poller is doing the work. */
export function webhookSilent(lastWebhookAt: string | null | undefined, now = Date.now()) {
  if (!lastWebhookAt) return true
  const t = new Date(lastWebhookAt).getTime()
  return !Number.isFinite(t) || now - t > WEBHOOK_SILENT_MS
}

const ACCESS_LEVELS: Record<number, string> = {
  5: 'Minimal access',
  10: 'Guest',
  15: 'Planner',
  20: 'Reporter',
  30: 'Developer',
  40: 'Maintainer',
  50: 'Owner'
}

export function accessLevelName(level: number | null): string {
  if (level == null) return 'No project access'
  return ACCESS_LEVELS[level] ?? `Level ${level}`
}

export const OP_LABELS: Record<string, string> = {
  create: 'Create issue',
  comment: 'Comment',
  state: 'Close / reopen',
  note_seen: 'Seen-again note',
  upload: 'File upload',
  labels: 'Labels'
}

export const SOURCE_LABELS: Record<string, string> = {
  issue: 'Issue',
  ticket: 'Ticket',
  record: 'Record'
}
