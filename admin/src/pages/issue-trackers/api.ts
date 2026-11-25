import { api } from '@/lib/api'

export { cleanLabel, isNewLabel } from '@nivaro/shared'

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
  /** Hub shared deployment: the env `off` is its operator's, for every app on it. */
  deployment?: boolean
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
  /** Issues opened directly in GitLab become issue-log entries (off by default). */
  import_new_issues: boolean
  /** Only GitLab issues with this label are brought in; '' = any. */
  import_label: string
  /** When bringing in was switched on (set by the server on save; read-only here). */
  import_since: string | null
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
  /** The address GitLab's webhook calls (the server's admin URL; GET / and create/rotate). */
  webhook_url?: string
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

import type { GitlabLabel } from '@nivaro/shared'

export type { GitlabLabel }

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
  labels: (id: number, project: number | null) => ['trackers', 'labels', id, project] as const,
  rules: () => ['trackers', 'rules'] as const,
  preview: (body: string, days: 7 | 30) => ['trackers', 'rules', 'preview', body, days] as const,
  explain: (issue: number) => ['trackers', 'rules', 'explain', issue] as const,
  templateVars: (kind: RuleAppliesTo) => ['trackers', 'rules', 'template-vars', kind] as const,
  users: (id: number, project: number, search: string) =>
    ['trackers', 'users', id, project, search] as const,
  samples: (kind: RuleAppliesTo, search: string) =>
    ['trackers', 'rules', 'samples', kind, search] as const,
  sample: (body: string) => ['trackers', 'rules', 'sample', body] as const
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

export const fetchRules = () =>
  api.get<{ data: TrackerRule[] }>('/trackers/rules').then((r) => r.data.data)

export const fetchTemplateVars = (kind: RuleAppliesTo) =>
  api
    .get<{ data: TemplateVar[] }>('/trackers/rules/template-vars', {
      params: kind === 'ticket' ? { kind } : undefined
    })
    .then((r) => r.data.data)

export const fetchExplain = (issue: number) =>
  api
    .get<{ data: Explanation[] }>('/trackers/rules/explain', { params: { issue } })
    .then((r) => r.data.data)

export const fetchGitlabUsers = (id: number, project: number, search: string) =>
  api
    .get<{ data: GitlabUser[] }>(`/trackers/${id}/users`, { params: { search, project } })
    .then((r) => r.data.data)

export const fetchPreview = (rule: Record<string, unknown>, days: 7 | 30) =>
  api
    .post<{ data: PreviewResult }>('/trackers/rules/preview', { rule, days })
    .then((r) => r.data.data)

// ── Pure rules ─────────────────────────────────────────────────────────────

/** Why the switch can't be changed here, or null when it can. */
export function featureLockReason(state: FeatureState | undefined): string | null {
  if (!state) return null
  if (state.source === 'cloud') return 'GitLab sync is not available in cloud mode.'
  if (state.source === 'env' && state.deployment)
    return 'Turned off for every app on this shared deployment by its operator.'
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

export const WEBHOOK_CHECK_MS = 30_000
export const WEBHOOK_POLL_MS = 3_000

/**
 * "Check it arrived": arrived once `last_webhook_at` moves past the value read
 * when the button was pressed (`baseline`); timed out when 30 s passed without
 * that; waiting otherwise. An older delivery never counts — it says nothing
 * about the hook just set up. Only server timestamps are compared.
 */
export function webhookCheckVerdict(
  lastWebhookAt: string | null | undefined,
  baseline: string | null | undefined,
  startedAt: number,
  now: number
): 'arrived' | 'waiting' | 'timeout' {
  const seen = lastWebhookAt ? new Date(lastWebhookAt).getTime() : Number.NaN
  const before = baseline ? new Date(baseline).getTime() : Number.NaN
  // Server time against server time: the browser clock may be off by minutes.
  if (Number.isFinite(seen) && (!Number.isFinite(before) || seen > before)) return 'arrived'
  return now - startedAt >= WEBHOOK_CHECK_MS ? 'timeout' : 'waiting'
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

// ── Rules (api/src/services/trackers/rules.ts is the source of truth) ───────

export type RuleAppliesTo = 'issue' | 'ticket'
export type RuleMode = 'create' | 'suggest'
export type ListOp = 'any' | 'all' | 'none'
export interface CountWindow {
  n: number
  window_minutes: number
}

export interface RuleMatch {
  sources?: string[]
  severity_min?: Severity
  severities?: string[]
  statuses?: string[]
  /** Words; `*` is a wildcard. `regex` only ever comes back on an old stored rule (invalid). */
  text?: { op: ListOp; terms: string[]; regex?: boolean; in: Array<'title' | 'details'> }
  routes?: string[]
  collections?: string[]
  items?: string[]
  environments?: string[]
  release?: { equals?: string; new_in_current?: boolean }
  fingerprints?: string[]
  group_lead_ids?: number[]
  raised_by_roles?: string[]
  raised_by_users?: string[]
  assigned?: 'any' | 'assigned' | 'unassigned'
  has_screenshot?: boolean
  has_replay?: boolean
  min_age_minutes?: number
  max_age_minutes?: number
  categories?: number[]
  priorities?: string[]
}

export interface RuleThreshold {
  hits?: CountWindow
  people?: CountWindow
  open_minutes?: number
  recurrences?: number
  total_hits?: number
}

export interface QuietHours {
  from: string
  to: string
  days: number[]
  tz: string
}

export interface RuleGuards {
  per_hour: number
  per_day: number
  group: boolean
  quiet?: QuietHours
  skip_linked?: boolean
  skip_statuses: string[]
}

export interface RuleAction {
  connection: number
  project_id?: number
  issue_type: 'issue' | 'incident'
  labels: string[]
  assignee_ids: number[]
  map_assignee_by_email: boolean
  milestone_id?: number
  due_in_days?: number
  weight?: number
  confidential: boolean
  title_template: string
  body_template: string
  attach_screenshot: boolean
  attach_replay_link: boolean
  include_details: boolean
  assign_nivaro_to?: string
}

/** What the builder edits and sends (POST / PATCH body). */
export interface RuleDraft {
  applies_to: RuleAppliesTo
  name: string
  description?: string | null
  enabled: boolean
  mode: RuleMode
  continue_after: boolean
  match: RuleMatch
  threshold: RuleThreshold
  guards: RuleGuards
  action: RuleAction
}

export interface RuleError {
  path: string
  message: string
}

/** GET /trackers/rules row (engine.ts RuleView). */
export interface TrackerRule extends RuleDraft {
  id: number
  sort: number
  connection: number
  last_fired_at: string | null
  fired_count: number
  suppressed_count: number
  paused_reason: string | null
  created_at: string | null
  updated_at: string | null
  /** False when the stored rule no longer validates (it never runs then). */
  valid: boolean
  errors?: RuleError[]
}

export interface PreviewResult {
  would_open: Array<{ issue: number; at: string; title: string }>
  held: Array<{ issue: number; reason: string }>
  considered: number
  truncated: boolean
}

export interface Explanation {
  rule: number
  name: string
  outcome: string
  detail: string
  at: string
  live?: boolean
}

export interface TemplateVar {
  name: string
  description: string
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

/** The validation errors of a 400 INVALID_RULE answer, or null for any other failure. */
export function ruleErrorsOf(err: unknown): RuleError[] | null {
  const data = (err as { response?: { status?: number; data?: { errors?: unknown } } })?.response
  if (data?.status !== 400 || !Array.isArray(data.data?.errors)) return null
  return (data.data.errors as RuleError[]).filter(
    (e) => e && typeof e.path === 'string' && typeof e.message === 'string'
  )
}
