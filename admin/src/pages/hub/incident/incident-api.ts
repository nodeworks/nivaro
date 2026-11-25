import { api } from '@/lib/api'

/**
 * Hub incidents, on-call and status pages (routes/hub-incidents.ts). Times travel as UTC ISO
 * strings and are shown in the viewer's own zone.
 */

export type Severity = 'sev1' | 'sev2' | 'sev3'
export type StepKind = 'on_call' | 'next' | 'owners' | 'admins'

export interface IncidentRow {
  id: number
  app_id: number
  app_name: string | null
  environment_id: number | null
  environment_key: string | null
  title: string
  severity: Severity
  status: 'open' | 'resolved'
  opened_at: string
  opened_by_name: string | null
  acknowledged_at: string | null
  acknowledged_by_name: string | null
  resolved_at: string | null
  banner: boolean
  frozen: boolean
  postmortem: boolean
}

export interface TimelineItem {
  at: string
  kind: 'incident' | 'deploy' | 'move' | 'alert' | 'page' | 'error' | 'uptime' | 'note'
  text: string
}

export interface PostMortem {
  version: 1
  title: string
  summary: string
  impact: string
  root_cause: string
  actions: Array<{ text: string; owner: string | null; done: boolean }>
  timeline: TimelineItem[]
  window: { from: string; to: string }
  drafted_at: string
}

export interface IncidentDetail extends Omit<IncidentRow, 'postmortem'> {
  summary: string | null
  banner_text: string | null
  banner_tone: string | null
  freeze_id: number | null
  resolved_by_name: string | null
  postmortem: PostMortem | null
  postmortem_at: string | null
  postmortem_by_name: string | null
  banner_envs: Array<{
    environment_id: number
    environment_key: string | null
    state: string
    at: string
    tries?: number
  }>
  events: Array<{
    id: number
    at: string
    kind: string
    text: string | null
    user_name: string | null
  }>
  page: {
    id: number
    status: 'open' | 'acked' | 'closed'
    level: number
    next_at: string | null
    acknowledged_at: string | null
    acknowledged_by_name: string | null
    sent_to: Array<{ level: number; step: StepKind; users: string[]; names: string[]; at: string }>
  } | null
  can_write: boolean
}

export interface Rota {
  id: number
  app_id: number
  enabled: boolean
  people: string[]
  time_zone: string
  handover_weekday: number
  handover_time: string
  starts_on: string
  escalate_minutes: number
  steps: StepKind[]
}

export interface Override {
  id: number
  app_id: number
  user_id: string
  starts_at: string
  ends_at: string
  note: string | null
}

export interface Page {
  id: number
  app_id: number
  app_name: string | null
  environment_id: number | null
  incident_id: number | null
  kind: string
  subject: string
  message: string
  status: 'open' | 'acked' | 'closed'
  level: number
  sent_to: Array<{ level: number; step: StepKind; users: string[]; at: string }>
  next_at: string | null
  acknowledged_by: string | null
  acknowledged_at: string | null
  created_at: string
}

export interface OnCallView {
  apps: Array<{ id: number; key: string; name: string }>
  rotas: Array<{
    rota: Rota
    on_call: {
      user_id: string | null
      next_user_id: string | null
      until: string | null
      override: Override | null
    }
    overrides: Override[]
    shifts: Array<{ user_id: string; from: string; to: string; override?: boolean }>
    can_write: boolean
  }>
  pages: Page[]
  recent: Page[]
  names: Record<string, string>
  me: string
  now: string
}

export type AppState = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'unknown'

export interface StatusAnswer {
  name: string
  overall: AppState
  overall_word: string
  apps: Array<{
    name: string
    state: AppState
    state_word: string
    uptime_30d: number | null
    days: Array<{ date: string; uptime: number | null }>
    incident: { state: AppState; text: string; since: string } | null
  }>
  planned: Array<{
    app: string | null
    title: string
    starts_at: string
    ends_at: string | null
    kind: string
  }>
  updated_at: string
}

export interface StatusPageRow {
  id: number
  name: string
  audience: 'public' | 'internal'
  token_hint: string | null
  app_ids: number[] | null
  expires_at: string | null
  revoked_at: string | null
  last_viewed_at: string | null
  created_at: string | null
  live: boolean
}

export const incidentKeys = {
  list: () => ['hub-incidents', 'list'] as const,
  one: (id: number) => ['hub-incidents', 'one', id] as const,
  onCall: () => ['hub-oncall'] as const,
  people: () => ['hub-oncall', 'people'] as const,
  statusPages: () => ['hub-status-pages'] as const,
  statusView: (id: number) => ['hub-status-pages', 'view', id] as const,
  apps: () => ['hub-incidents', 'apps'] as const
}

const data = <T>(p: Promise<{ data: { data: T } }>) => p.then((r) => r.data.data)

export const fetchIncidents = () => data<IncidentRow[]>(api.get('/hub/incidents'))
export const fetchIncident = (id: number) => data<IncidentDetail>(api.get(`/hub/incidents/${id}`))
export const openIncident = (appId: number, body: Record<string, unknown>) =>
  data<IncidentDetail>(api.post(`/hub/apps/${appId}/incidents`, body))
export const patchIncident = (id: number, body: Record<string, unknown>) =>
  data<IncidentDetail>(api.patch(`/hub/incidents/${id}`, body))
export const addNote = (id: number, text: string) =>
  data<{ ok: true }>(api.post(`/hub/incidents/${id}/notes`, { text }))
export const setBanner = (id: number, text: string | null) =>
  data<IncidentDetail>(api.put(`/hub/incidents/${id}/banner`, { text }))
export const setFreeze = (id: number, on: boolean) =>
  data<IncidentDetail>(api.post(`/hub/incidents/${id}/freeze`, { on }))
export const ackIncident = (id: number) =>
  data<IncidentDetail>(api.post(`/hub/incidents/${id}/acknowledge`, {}))
export const resolveIncident = (id: number, note: string) =>
  data<IncidentDetail>(api.post(`/hub/incidents/${id}/resolve`, { note }))
export const draftPostMortem = (id: number, replace: boolean) =>
  data<PostMortem>(api.post(`/hub/incidents/${id}/postmortem/draft`, { replace }))
export const savePostMortem = (id: number, postmortem: PostMortem) =>
  data<PostMortem>(api.put(`/hub/incidents/${id}/postmortem`, { postmortem }))

export const fetchOnCall = () => data<OnCallView>(api.get('/hub/on-call'))
export const fetchOnCallPeople = () =>
  data<Array<{ id: string; name: string; email: string | null }>>(api.get('/hub/on-call/people'))
export const saveRota = (appId: number, body: Record<string, unknown>) =>
  data<Rota>(api.put(`/hub/apps/${appId}/on-call`, body))
export const addOverride = (appId: number, body: Record<string, unknown>) =>
  data<{ id: number }>(api.post(`/hub/apps/${appId}/on-call/overrides`, body))
export const removeOverride = (id: number) =>
  data<{ deleted: true }>(api.delete(`/hub/on-call/overrides/${id}`))
export const ackPage = (id: number) => data<Page>(api.post(`/hub/pages/${id}/acknowledge`, {}))

export const fetchStatusPages = () =>
  api.get('/hub/status-pages').then((r) => r.data as { data: StatusPageRow[]; can_write: boolean })
export const fetchStatusView = (id: number) =>
  data<StatusAnswer>(api.get(`/hub/status-pages/${id}/view`))
export const createStatusPage = (body: Record<string, unknown>) =>
  data<StatusPageRow & { token: string | null }>(api.post('/hub/status-pages', body))
export const patchStatusPage = (id: number, body: Record<string, unknown>) =>
  data<StatusPageRow>(api.patch(`/hub/status-pages/${id}`, body))
export const rotateStatusPage = (id: number, expiresInDays: number) =>
  data<StatusPageRow & { token: string }>(
    api.post(`/hub/status-pages/${id}/rotate`, { expires_in_days: expiresInDays })
  )
export const deleteStatusPage = (id: number) =>
  data<{ deleted: true }>(api.delete(`/hub/status-pages/${id}`))

/** The public link of a page token, on this Hub's own origin. */
export const statusPageUrl = (token: string) =>
  `${window.location.origin}/api/hub/status-page/${encodeURIComponent(token)}`

export const markdownUrl = (id: number) => `/api/hub/incidents/${id}/postmortem.md`
export const pdfUrl = (id: number) => `/api/hub/incidents/${id}/postmortem.pdf`

export const SEV_WORDS: Record<Severity, string> = { sev1: 'SEV 1', sev2: 'SEV 2', sev3: 'SEV 3' }
export const SEV_HINT: Record<Severity, string> = {
  sev1: 'The app is down or losing data for everyone',
  sev2: 'A major feature fails for many people',
  sev3: 'Degraded or a small group affected'
}
export const STEP_WORDS: Record<StepKind, string> = {
  on_call: 'Person on call',
  next: 'Next on the rota',
  owners: 'App owners',
  admins: 'Hub administrators'
}
export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
]
export const STATE_TONE: Record<AppState, 'ok' | 'warn' | 'down' | 'unknown'> = {
  operational: 'ok',
  degraded: 'warn',
  partial_outage: 'down',
  major_outage: 'down',
  unknown: 'unknown'
}

/** "in 4 min", "in 3 h", "in 2 days" for a future time. */
export function fromNow(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms)) return '—'
  if (ms <= 30_000) return 'any moment'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `in ${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `in ${h} h`
  return `in ${Math.round(h / 24)} days`
}
