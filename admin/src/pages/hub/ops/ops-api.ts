import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Hub operations (enhancements 10, 19, 20): the client side of routes/hub-ops.ts — cross-app
 * issues, the secret rotation helper and storage health. Query keys live here, under ['hub-ops'].
 */

export type IssueKind = 'crash' | 'server'

export interface IssueGroupSummary {
  sig: string
  kind: IssueKind
  title: string
  severity: string | null
  open: boolean
  apps: number
  environments: number
  occurrences: number
  people: number
  releases: string[]
  app_keys: string[]
  first_seen: string | null
  last_seen: string | null
}

export interface IssueGroupEnvRow {
  environment_id: number
  app_id: number
  app_key: string
  app_name: string
  environment_key: string
  title: string
  severity: string | null
  status: string | null
  occurrences: number
  people: number
  release: string | null
  screen: string | null
  first_seen: string | null
  last_seen: string | null
  link: string | null
}

export interface IssueReadState {
  environment_id: number
  app_key: string
  environment_key: string
  state: string | null
  at: string | null
  truncated: boolean
}

export interface IssueFilters {
  app_id?: string
  kind?: string
  severity?: string
  status?: string
  multi?: boolean
  q?: string
}

export interface OpsHealth {
  state?: string
  level?: string
  kind?: string | null
  total_bytes?: number | null
  free_bytes?: number | null
  used_bytes?: number | null
  files?: number | null
  files_complete?: boolean | null
  prev_used_bytes?: number | null
  prev_checked_at?: string | null
  error?: string | null
  checked_at?: string | null
}

export interface StorageOverview {
  drivers: Array<{ id: number; name: string } & OpsHealth>
  environments: Array<{
    environment_id: number
    app_id: number
    app_key: string
    environment_key: string
    driver_id: number | null
    on_shared: boolean
    state: string | null
    files: number | null
    bytes: number | null
    prev_bytes: number | null
    prev_checked_at: string | null
    checked_at: string | null
  }>
  warn_pct: number
  critical_pct: number
}

export type RotateMode = 'helper' | 'route' | 'manual' | 'never'
export type DueState = 'ok' | 'due_soon' | 'overdue' | 'no_schedule' | 'never'

export interface SecretItem {
  ref: string
  kind: string
  kind_label: string
  label: string
  fingerprint: string
  /** False for a value stored unsealed (no fingerprint shown). */
  sealed: boolean
  path: string
  rotate: RotateMode
  helper_ready: boolean
  first_seen_at: string | null
  rotated_at: string | null
  rotated_via: string | null
  age_days: number | null
  due_at: string | null
  due: DueState
  check_state: string | null
  check_detail: string | null
  check_due_at: string | null
  env_id: number | null
  env_key: string | null
  shared_id: number | null
}

export interface SecretPolicy {
  kind: string
  every_days: number | null
  remind_days: number
  saved: boolean
}

export interface KindInfo {
  label: string
  every_days: number | null
  remind_days: number
  rotate: RotateMode
  how: string
}

export interface SecretsAnswer {
  items: SecretItem[]
  policies: Record<string, SecretPolicy>
  kinds: Record<string, KindInfo>
}

export const opsKeys = {
  issues: (f: IssueFilters) => ['hub-ops', 'issues', f] as const,
  issue: (sig: string) => ['hub-ops', 'issue', sig] as const,
  reads: ['hub-ops', 'issue-reads'] as const,
  storage: ['hub-ops', 'storage'] as const,
  driverStorage: (id: number) => ['hub-ops', 'driver-storage', id] as const,
  secrets: ['hub-ops', 'secrets'] as const
}

const unwrap = <T>(r: { data: { data: T } }) => r.data.data

export function useIssueGroups(f: IssueFilters) {
  return useQuery({
    queryKey: opsKeys.issues(f),
    queryFn: () =>
      api
        .get('/hub/ops/issues', {
          params: {
            ...(f.app_id ? { app_id: f.app_id } : {}),
            ...(f.kind ? { kind: f.kind } : {}),
            ...(f.severity ? { severity: f.severity } : {}),
            ...(f.status ? { status: f.status } : {}),
            ...(f.multi ? { multi: '1' } : {}),
            ...(f.q ? { q: f.q } : {})
          }
        })
        .then(unwrap<{ groups: IssueGroupSummary[]; truncated: boolean }>)
  })
}

export function useIssueGroup(sig: string | null) {
  return useQuery({
    queryKey: opsKeys.issue(sig ?? ''),
    enabled: !!sig,
    queryFn: () => api.get(`/hub/ops/issues/${sig}`).then(unwrap<IssueGroupEnvRow[]>)
  })
}

export function useIssueReads() {
  return useQuery({
    queryKey: opsKeys.reads,
    queryFn: () => api.get('/hub/ops/issues/reads').then(unwrap<IssueReadState[]>)
  })
}

export function useStorageOverview() {
  return useQuery({
    queryKey: opsKeys.storage,
    queryFn: () => api.get('/hub/ops/storage').then(unwrap<StorageOverview>)
  })
}

export function useDriverStorage(id: number) {
  return useQuery({
    queryKey: opsKeys.driverStorage(id),
    queryFn: () => api.get(`/hub/drivers/${id}/storage`).then(unwrap<OpsHealth | null>)
  })
}

export function useSecrets() {
  return useQuery({
    queryKey: opsKeys.secrets,
    queryFn: () => api.get('/hub/secrets').then(unwrap<SecretsAnswer>)
  })
}

export const collectNow = () => api.post('/hub/ops/collect', {})
export const checkDriverNow = (id: number) =>
  api.post(`/hub/drivers/${id}/storage/check`, {}).then(unwrap<OpsHealth>)
export const savePolicy = (kind: string, every_days: number | null, remind_days: number) =>
  api.put(`/hub/secrets/policies/${kind}`, { every_days, remind_days }).then(unwrap<SecretPolicy>)
export const rotateHere = (ref: string, confirm: string) =>
  api.post('/hub/secrets/rotate', { ref, confirm })
export const markRotated = (ref: string) => api.post('/hub/secrets/rotated', { ref })
export const checkSecretNow = (ref: string) =>
  api.post('/hub/secrets/check', { ref }).then(unwrap<{ state: string; detail: string }>)

/**
 * The existing rotate route for a `route` kind; answers the value to show once, when the route
 * shows one (a deployment token, a sign-in client secret), else null.
 */
export async function rotateThroughRoute(item: SecretItem): Promise<string | null> {
  // A shared deployment's token is rotated on its own page (it shows the settings block and the
  // grace deadline with the new token), so it never comes here.
  if (item.kind === 'oidc_client_secret' && item.env_id != null) {
    const r = await api.post(`/hub/signin/environments/${item.env_id}/client/rotate`, {})
    return (r.data?.data?.client_secret as string | undefined) ?? null
  }
  if (item.kind === 'oidc_signing_key') {
    await api.post('/hub/signin/keys/rotate', {})
    return null
  }
  throw new Error('This secret is not rotated through a Hub route')
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function usedPct(h: Pick<OpsHealth, 'used_bytes' | 'free_bytes'>): number | null {
  const u = h.used_bytes
  const f = h.free_bytes
  if (u == null || f == null || u + f <= 0) return null
  return Math.round((u / (u + f)) * 1000) / 10
}

export const STORAGE_STATE_COPY: Record<string, string> = {
  ok: 'Read',
  pending: 'The agent is reading it now',
  not_configured:
    'Not set up on the agent (HUB_AGENT_VOLUME_EXPORT_MOUNT for NFS, HUB_AGENT_STORAGE_PATH for local volumes)',
  unreadable: 'The agent cannot read its storage path',
  timeout: 'The storage did not answer (a hung NFS mount?)',
  agent_too_old: 'The agent is too old to report storage: update the Hub agent',
  agent_unreachable: 'The agent did not answer',
  no_link: 'No hub link (no hub token on this environment)',
  refused: 'The app refused the Hub’s token',
  too_old: 'The app is older than 0.3.215',
  unreachable: 'The app did not answer',
  failed: 'The app could not read it'
}

export const stateWords = (s: string | null | undefined): string =>
  s ? (STORAGE_STATE_COPY[s] ?? s) : 'Not read yet'
