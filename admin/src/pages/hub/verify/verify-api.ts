import { api } from '@/lib/api'

/**
 * Hub verification — what the Smoke checks and Extensions tabs read and send
 * (routes/hub-verify.ts). Query keys live here, under ['hub-verify'].
 */

export type CheckKind = 'http' | 'read' | 'query'
export type OnFail = 'notify' | 'rollback'

export interface SmokeCheck {
  id?: string
  name: string
  kind: CheckKind
  path?: string
  slug?: string
  params?: Record<string, string | number | boolean | null>
  expect_status?: number
  contains?: string
  min_rows?: number
  max_rows?: number
  max_ms?: number
}

export interface SmokeSuite {
  environment_id: number
  enabled: boolean
  on_fail: OnFail
  settle_seconds: number
  checks: SmokeCheck[]
  updated_by: string | null
  updated_at: string | null
}

export interface CheckResult {
  id: string
  name: string
  kind: CheckKind
  ok: boolean
  status: number | null
  ms: number | null
  rows: number | null
  code: string | null
  reason: string | null
}

export type RunTrigger = 'promote' | 'rollback' | 'apply' | 'move' | 'upgrade' | 'manual'
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed'

export interface SmokeRun {
  id: number
  app_id: number
  environment_id: number
  trigger: RunTrigger
  deploy_id: number | null
  version: string | null
  status: RunStatus
  on_fail: OnFail | null
  results: CheckResult[]
  passed: number | null
  failed: number | null
  reason: string | null
  due_at: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string | null
}

export interface VerifyEnv {
  id: number
  app_id: number
  key: string
  position: number
  production: boolean
  on_shared: boolean
  linked: boolean
}

export interface SmokeOverview {
  apps: Array<{ id: number; key: string; name: string }>
  environments: VerifyEnv[]
  suites: SmokeSuite[]
  last_runs: SmokeRun[]
}

export const TRIGGER_WORDS: Record<RunTrigger, string> = {
  promote: 'After a promotion',
  rollback: 'After a rollback',
  apply: 'After Apply now',
  move: 'After a move',
  upgrade: 'After a shared upgrade',
  manual: 'Run by hand'
}

export const KIND_WORDS: Record<CheckKind, string> = {
  http: 'Page answers',
  read: 'Signed-in read',
  query: 'Saved query'
}

export const verifyKeys = {
  all: ['hub-verify'] as const,
  smoke: () => ['hub-verify', 'smoke'] as const,
  env: (envId: number) => ['hub-verify', 'smoke', envId] as const,
  extensions: () => ['hub-verify', 'extensions'] as const
}

export const fetchSmokeOverview = () =>
  api.get<{ data: SmokeOverview }>('/hub/verify/smoke').then((r) => r.data.data)

export const fetchEnvSmoke = (envId: number) =>
  api
    .get<{ data: { suite: SmokeSuite | null; runs: SmokeRun[] } }>(
      `/hub/environments/${envId}/smoke`
    )
    .then((r) => r.data.data)

export const saveSuite = (
  envId: number,
  body: Pick<SmokeSuite, 'enabled' | 'on_fail' | 'settle_seconds' | 'checks'>
) =>
  api.put<{ data: SmokeSuite }>(`/hub/environments/${envId}/smoke`, body).then((r) => r.data.data)

export const deleteSuite = (envId: number) => api.delete(`/hub/environments/${envId}/smoke`)

export const runSuiteNow = (envId: number) =>
  api
    .post<{ data: { run_id: number } }>(`/hub/environments/${envId}/smoke/run`)
    .then((r) => r.data.data)

// ─── Extensions ────────────────────────────────────────────────────────────────

export type CellState = 'first' | 'same' | 'behind' | 'ahead' | 'missing' | 'unknown'
export type PinSource = 'docker' | 'gitlab' | 'shared'

export interface ExtensionCell {
  environment_id: number
  extension_id: string
  version: string | null
  build: string | null
  status: string | null
  enabled: boolean | null
  pin: string | null
  pin_source: PinSource | null
  seen_at: string | null
  state: CellState
}

export interface MatrixEnv {
  id: number
  key: string
  position: number
  production: boolean
  on_shared: boolean
}

export interface AppMatrix {
  app: { id: number; key: string; name: string }
  environments: MatrixEnv[]
  extensions: Array<{ id: string; cells: Array<ExtensionCell | null>; behind: number }>
}

export interface ExtensionPromotion {
  id: number
  app_id: number
  environment_id: number
  extension_id: string
  from_environment_id: number | null
  from_pin: string | null
  to_pin: string
  via: string
  status: string
  deploy_id: number | null
  commit_sha: string | null
  error: string | null
  created_at: string | null
}

export interface ExtensionPlan {
  environment: { id: number; key: string; app_id: number; production: boolean }
  extension_id: string
  via: PinSource | null
  from_env: { id: number; key: string } | null
  current_pin: string | null
  to_pin: string | null
  blockers: Array<{ code: string; text: string }>
}

export const fetchExtensions = () =>
  api
    .get<{ data: { apps: AppMatrix[]; promotions: ExtensionPromotion[] } }>(
      '/hub/verify/extensions'
    )
    .then((r) => r.data.data)

export const refreshExtensions = (appId?: number) =>
  api
    .post<{ data: { read: number } }>(
      '/hub/verify/extensions/refresh',
      appId ? { app_id: appId } : {}
    )
    .then((r) => r.data.data)

export const planExtension = (
  envId: number,
  extId: string,
  body: { from_env_id?: number | null; pin?: string | null }
) =>
  api
    .post<{ data: ExtensionPlan }>(
      `/hub/environments/${envId}/extensions/${encodeURIComponent(extId)}/plan`,
      body
    )
    .then((r) => r.data.data)

export const promoteExtension = (
  envId: number,
  extId: string,
  body: { from_env_id?: number | null; pin?: string | null; confirm: string }
) =>
  api
    .post<{
      data: { id: number; via: PinSource; deploy_id: number | null; commit_sha: string | null }
    }>(`/hub/environments/${envId}/extensions/${encodeURIComponent(extId)}/promote`, body)
    .then((r) => r.data.data)

/** `repo@sha256:abcdef…` → `repo · abcdef123456` (the full pin stays in the tooltip). */
export function shortPin(pin: string | null): string | null {
  if (!pin) return null
  const at = pin.indexOf('@sha256:')
  if (at < 0) return pin
  const repo = pin.slice(0, at).split('/').pop() ?? ''
  return `${repo} · ${pin.slice(at + 8, at + 20)}`
}

export const STATE_WORDS: Record<CellState, string> = {
  first: 'Leads',
  same: 'Same',
  behind: 'Behind',
  ahead: 'Ahead',
  missing: 'Missing',
  unknown: 'Not read'
}
