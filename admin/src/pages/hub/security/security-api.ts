import { errorToastOptions } from '@nivaro/shared'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { hubError } from '../hub-api'

/**
 * Nivaro Hub security (routes/hub-security.ts): access reviews and break-glass (the Access tab),
 * certificates, image vulnerabilities, the compliance pack and settings (the Security tab).
 */

export interface EnvLabel {
  environment_id: number
  env_key: string
  app_id: number
  app_key: string
  app_name: string
  position: number
}

export type BreakGlassStatus =
  | 'pending'
  | 'granting'
  | 'active'
  | 'revoking'
  | 'revoked'
  | 'expired'
  | 'denied'
  | 'cancelled'
  | 'failed'
  | 'not_needed'

export interface BreakGlass {
  id: number
  app_id: number
  environment_id: number
  requester_id: string
  reason: string
  hours: number
  status: BreakGlassStatus
  decided_by: string | null
  decided_at: string | null
  approval_kind: 'admin' | 'incident' | null
  incident_id: number | null
  decision_note: string | null
  app_user_id: string | null
  granted_at: string | null
  expires_at: string | null
  revoked_at: string | null
  revoked_by: string | null
  revoke_reason: string | null
  app_state: string | null
  attempts: number
  last_error: string | null
  created_at: string | null
}

export interface BreakGlassPage {
  requests: BreakGlass[]
  people: Record<string, string>
  environments: EnvLabel[]
  requestable: number[]
  max_hours: number
}

export type ReviewStatus = 'reading' | 'open' | 'completing' | 'completed' | 'cancelled' | 'failed'

export interface ReviewCounts {
  total: number
  pending: number
  keep: number
  remove: number
  admins: number
  removed: number
  open: number
}

export interface EnvRead {
  environment_id: number
  environment_key: string
  production: boolean
  state: 'read' | 'no_link' | 'error'
  code?: string
  count: number
  truncated?: boolean
}

export interface Review {
  id: number
  app_id: number
  status: ReviewStatus
  started_via: string
  started_by: string | null
  started_at: string | null
  due_at: string | null
  completed_by: string | null
  completed_at: string | null
  note: string | null
  environments: EnvRead[]
  counts?: ReviewCounts
}

export interface ReviewItem {
  id: number
  environment_id: number
  app_user_id: string
  email: string | null
  name: string | null
  role: string | null
  admin: boolean
  account_status: string | null
  account_kind: string | null
  last_access: string | null
  break_glass: boolean
  decision: 'pending' | 'keep' | 'remove'
  decided_by: string | null
  decided_at: string | null
  note: string | null
  removal_state: string | null
  removal_code: string | null
}

export interface ReviewDetail extends Review {
  items: ReviewItem[]
  counts: ReviewCounts
  people: Record<string, string>
  app_name: string | null
}

export interface AppSecurity {
  app_id: number
  review_every_months: number
  review_due_days: number
  next_review_at: string | null
}

export type CertState = 'ok' | 'warning' | 'expired' | 'error'

export interface CertRow {
  id: number
  environment_id: number
  hostname: string
  port: number
  state: CertState
  expires_at: string | null
  days_left: number | null
  issuer: string | null
  authorized: boolean | null
  dns_ok: boolean | null
  addresses: string | null
  error_code: string | null
  checked_at: string | null
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown'
export type SeverityCounts = Record<Severity, number>

export interface PinnedImage {
  image: string
  digest: string
  role: string
  environment_ids: number[]
  counts: SeverityCounts
}

export interface Finding {
  id: number
  image: string
  digest: string
  vuln_id: string
  package: string
  severity: Severity
  installed: string | null
  fixed_in: string | null
  url: string | null
  summary: string | null
  first_seen: string | null
}

export interface LastScan {
  id: number
  status: 'running' | 'done' | 'failed'
  started_at: string | null
  finished_at: string | null
  images: number
  findings: number
  error: string | null
}

export interface SecuritySettings {
  scanner_url: string | null
  scanner_token: string | null
  break_glass_max_hours: number
  tls_watch: boolean
}

export const securityKeys = {
  breakGlass: () => ['hub-break-glass'] as const,
  reviews: () => ['hub-access-reviews'] as const,
  review: (id: number) => ['hub-access-review', id] as const,
  appSecurity: (id: number) => ['hub-app-security', id] as const,
  certs: () => ['hub-security-certs'] as const,
  vulns: () => ['hub-security-vulns'] as const,
  settings: () => ['hub-security-settings'] as const
}

const data = <T>(p: Promise<{ data: { data: T } }>) => p.then((r) => r.data.data)

export const fetchBreakGlass = () => data<BreakGlassPage>(api.get('/hub/break-glass'))
export const requestBreakGlass = (envId: number, hours: number, reason: string) =>
  data<BreakGlass>(api.post(`/hub/environments/${envId}/break-glass`, { hours, reason }))
export const decideBreakGlass = (
  id: number,
  action: 'approve' | 'deny' | 'cancel' | 'revoke',
  note?: string
) => data<BreakGlass>(api.post(`/hub/break-glass/${id}/${action}`, note ? { note } : {}))

export const fetchReviews = () =>
  api
    .get('/hub/access-reviews')
    .then(
      (r) => r.data as { data: Review[]; apps: Array<{ id: number; key: string; name: string }> }
    )
export const fetchReview = (id: number) => data<ReviewDetail>(api.get(`/hub/access-reviews/${id}`))
export const startReview = (appId: number, note?: string) =>
  data<Review>(api.post(`/hub/apps/${appId}/access-reviews`, note ? { note } : {}))
export const decide = (
  id: number,
  items: Array<{ id: number; decision: 'keep' | 'remove' | 'pending' }>
) =>
  data<{ changed: number; counts: ReviewCounts }>(
    api.post(`/hub/access-reviews/${id}/decisions`, { items })
  )
export const reviewAction = (id: number, action: 'complete' | 'retry' | 'cancel') =>
  data<Review>(api.post(`/hub/access-reviews/${id}/${action}`, {}))
export const fetchAppSecurity = (id: number) =>
  data<AppSecurity>(api.get(`/hub/apps/${id}/security`))
export const saveAppSecurity = (id: number, every: number, dueDays: number) =>
  data<AppSecurity>(
    api.put(`/hub/apps/${id}/security`, { review_every_months: every, review_due_days: dueDays })
  )

export const fetchCerts = () =>
  data<{ certificates: CertRow[]; environments: EnvLabel[]; running: boolean }>(
    api.get('/hub/security/certificates')
  )
export const checkCerts = () => api.post('/hub/security/certificates/check', {})
export const fetchVulns = () =>
  data<{
    scanner: boolean
    environments: EnvLabel[]
    last_scan: LastScan | null
    images: PinnedImage[]
    findings: Finding[]
  }>(api.get('/hub/security/vulnerabilities'))
export const scanNow = () => api.post('/hub/security/vulnerabilities/scan', {})
export const fetchSettings = () => data<SecuritySettings>(api.get('/hub/security/settings'))
export const saveSettings = (s: Partial<SecuritySettings>) =>
  data<SecuritySettings>(api.put('/hub/security/settings', s))

/** Saves a file the API answers (blob) under `name`. */
export async function download(path: string, name: string, params?: Record<string, unknown>) {
  const res = await api.get<Blob>(path, { params, responseType: 'blob' })
  const url = URL.createObjectURL(res.data)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A blob error answer carries JSON: read it so describeError sees the code. */
export async function blobError(err: unknown): Promise<unknown> {
  const data = (err as { response?: { data?: unknown } })?.response?.data
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text())
      return {
        ...(err as object),
        response: { ...(err as { response: object }).response, data: parsed }
      }
    } catch {
      return err
    }
  }
  return err
}

export const BG_STATUS_WORDS: Record<BreakGlassStatus, string> = {
  pending: 'Waiting for approval',
  granting: 'Granting',
  active: 'Active',
  revoking: 'Ending',
  revoked: 'Ended',
  expired: 'Expired',
  denied: 'Denied',
  cancelled: 'Withdrawn',
  failed: 'Not granted',
  not_needed: 'Not needed'
}

export const REVIEW_STATUS_WORDS: Record<ReviewStatus, string> = {
  reading: 'Reading the apps',
  open: 'Open',
  completing: 'Removing access',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Could not read'
}

export const REMOVAL_WORDS: Record<string, string> = {
  done: 'Suspended',
  already: 'Was suspended',
  none: 'No account any more',
  last_admin: 'Kept: last admin there',
  manual: 'Remove in the app',
  failed: 'Did not answer'
}

/** Plain words for the codes the security routes and the apps answer. */
export const SECURITY_COPY: Record<string, { title: string; hint?: string }> = {
  OWN_SESSION_ONLY: {
    title: 'Only on your own sign-in',
    hint: 'Break-glass requests and decisions are made in your own browser session, never while viewing as someone else.'
  },
  SELF_APPROVAL: {
    title: 'You cannot approve your own request',
    hint: 'Another Hub administrator approves it.'
  },
  BREAK_GLASS_OPEN: {
    title: 'You already have an open request there',
    hint: 'Withdraw it or wait for it to end first.'
  },
  BAD_HOURS: { title: 'Pick how many hours', hint: 'Within the longest grant this Hub allows.' },
  BAD_REASON: { title: 'Say why you need it', hint: 'At least 10 characters.' },
  NO_IDENTITY: {
    title: 'The app cannot recognise you',
    hint: 'Your Hub account has no email or Microsoft identity.'
  },
  NO_ACCOUNT: {
    title: 'You have no account in that app',
    hint: 'Break-glass raises an existing account; it never creates one.'
  },
  ACCOUNT_NOT_ACTIVE: {
    title: 'Your account there is not active',
    hint: 'Break-glass never reactivates an account.'
  },
  NOT_PENDING: {
    title: 'The request was already decided',
    hint: 'The list shows where it stands.'
  },
  NOT_ACTIVE: { title: 'That access already ended' },
  REVIEW_OPEN: {
    title: 'This app already has an open review',
    hint: 'Finish or cancel it first.'
  },
  DECISIONS_PENDING: {
    title: 'Some accounts have no decision yet',
    hint: 'Keep or remove every account, then complete the review.'
  },
  REVIEW_NOT_OPEN: { title: 'The review is no longer open' },
  RENDER_UNAVAILABLE: {
    title: 'This Hub cannot make PDFs',
    hint: 'Download the CSV instead (no Chromium and no render peer here).'
  },
  NO_SCANNER: {
    title: 'No scanner is set',
    hint: 'An administrator sets the scanner endpoint in Settings below.'
  },
  SCAN_RUNNING: { title: 'A scan is already running' },
  CHECK_RUNNING: { title: 'A certificate check is already running' },
  BAD_SCANNER_URL: {
    title: 'Use an https scanner address',
    hint: 'Plain http only to localhost; no user or password in it.'
  }
}

export function securityToast(err: unknown, fallback: string) {
  const d = hubError(err, fallback)
  const copy = d.code ? SECURITY_COPY[d.code] : undefined
  toast.error(copy?.title ?? d.title, errorToastOptions(copy?.hint ? { ...d, hint: copy.hint } : d))
}

export const envName = (envs: EnvLabel[], id: number) => {
  const e = envs.find((x) => x.environment_id === id)
  return e ? `${e.app_name} · ${e.env_key}` : `Environment ${id}`
}
