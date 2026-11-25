import type { DataTag } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Hub release operations — what the Releases tab and the Promote panel read and send:
 * release trains, scheduled promotions, freeze windows, automatic rollback rules and release
 * notes (routes/hub-releases.ts). Times travel as UTC ISO strings and are shown in the viewer's
 * own zone.
 */

export type TrainStepStatus =
  | 'pending'
  | 'starting'
  | 'promoting'
  | 'soaking'
  | 'held'
  | 'passed'
  | 'skipped'
  | 'failed'

export interface TrainStep {
  environment_id: number
  key: string
  soak_minutes: number
  min_readiness: number | null
  max_hold_minutes: number
  status: TrainStepStatus
  deploy_id: number | null
  started_at: string | null
  deployed_at: string | null
  passed_at: string | null
  note: string | null
  readiness: number | null
  attempts: number
  /** Held before its promotion (an earlier environment changed, or the person is gone). */
  blocked?: boolean
}

export interface HubTrain {
  id: number
  app_id: number
  version: string
  status: 'running' | 'done' | 'failed' | 'aborted'
  steps: TrainStep[]
  step_index: number
  error: string | null
  schedule_id: number | null
  started_by: string | null
  started_by_name?: string | null
  started_at: string | null
  finished_at: string | null
}

export interface TrainStepInput {
  environment_id: number
  soak_minutes: number
  min_readiness: number | null
  max_hold_minutes: number
}

export interface HubSchedule {
  id: number
  app_id: number
  environment_id: number | null
  kind: 'promote' | 'train'
  version: string
  run_at: string
  on_freeze: 'wait' | 'fail'
  status: 'scheduled' | 'starting' | 'waiting' | 'started' | 'failed' | 'cancelled'
  note: string | null
  deploy_id: number | null
  train_id: number | null
  error: string | null
  train: { keys: string[] } | null
  /** Who the run acts for (it is checked again when it starts). */
  created_by_name?: string | null
}

export interface HubFreeze {
  id: number
  app_id: number | null
  name: string
  recurrence: 'none' | 'month_end'
  starts_at: string | null
  ends_at: string | null
  days_before: number | null
  days_after: number | null
  time_zone: string | null
  active?: { start: string; end: string } | null
  next?: { start: string; end: string } | null
}

export interface RollbackRule {
  environment_id: number
  enabled: boolean
  window_minutes: number
  max_error_pct: number | null
  min_requests: number
  max_crashes: number | null
  min_readiness: number | null
}

export interface RollbackWatch {
  id: number
  deploy_id: number
  app_id: number
  environment_id: number
  version: string
  from_version: string | null
  status: 'watching' | 'rolling' | 'passed' | 'rolled_back' | 'failed' | 'superseded'
  reason: string | null
  until_at: string | null
  rollback_deploy_id: number | null
  finished_at: string | null
}

export interface ReleaseEnv {
  id: number
  app_id: number
  key: string
  position: number
  on_shared: boolean
  linked: boolean
  placed: boolean
}

export interface ReleasesOverview {
  apps: Array<{ id: number; key: string; name: string }>
  environments: ReleaseEnv[]
  trains: HubTrain[]
  schedules: HubSchedule[]
  freezes: HubFreeze[]
  rules: RollbackRule[]
  watches: RollbackWatch[]
  now: string
}

export interface FreezeRefusal {
  /** OUTSIDE_WINDOW: a deploy window governs and none is open (ends_at = the next opening). */
  code: 'FROZEN' | 'FREEZE_UNKNOWN' | 'OUTSIDE_WINDOW' | 'WINDOW_INVALID'
  message: string
  freeze: { id: number; name: string; app_id: number | null; ends_at: string }
  /** OUTSIDE_WINDOW: the next opening, or null when none opens within 14 days. */
  next_opening?: string | null
}

export interface NoteCommit {
  sha: string
  title: string
  author: string | null
  at: string | null
}

export interface ComponentNotes {
  position: number
  component: string
  kind: string
  from_sha: string | null
  to_sha: string | null
  direction: 'added' | 'removed'
  commits: NoteCommit[]
  total_commits: number
  migrations: string[]
  env_keys: string[]
  error?: string
}

export interface ReleaseNotes {
  kind: 'promote' | 'rollback'
  from_version: string | null
  to_version: string
  components: ComponentNotes[]
  nivaro: { migrations: string[] | null; env_keys: string[] | null; note: string | null }
  computed_at: string
}

type Tagged<K extends readonly unknown[], T> = DataTag<K, T>
const tag = <K extends readonly unknown[], T>(k: K) => k as Tagged<K, T>

export const releaseKeys: {
  overview: () => Tagged<readonly ['hub-releases'], ReleasesOverview>
  freeze: (envId: number) => Tagged<readonly ['hub-env-freeze', number], FreezeRefusal | null>
  preview: (
    envId: number,
    kind: string,
    version: string
  ) => Tagged<readonly ['hub-release-notes-preview', number, string, string], ReleaseNotes>
  notes: (deployId: number) => Tagged<readonly ['hub-release-notes', number], ReleaseNotes | null>
} = {
  overview: () => tag<readonly ['hub-releases'], ReleasesOverview>(['hub-releases'] as const),
  freeze: (envId: number) =>
    tag<readonly ['hub-env-freeze', number], FreezeRefusal | null>([
      'hub-env-freeze',
      envId
    ] as const),
  preview: (envId: number, kind: string, version: string) =>
    tag<readonly ['hub-release-notes-preview', number, string, string], ReleaseNotes>([
      'hub-release-notes-preview',
      envId,
      kind,
      version
    ] as const),
  notes: (deployId: number) =>
    tag<readonly ['hub-release-notes', number], ReleaseNotes | null>([
      'hub-release-notes',
      deployId
    ] as const)
}

const data = <T>(p: Promise<{ data: { data: T } }>) => p.then((r) => r.data.data)

export const fetchReleases = () => data<ReleasesOverview>(api.get('/hub/releases/overview'))
export const fetchEnvFreeze = (envId: number) =>
  data<FreezeRefusal | null>(api.get(`/hub/environments/${envId}/freeze`))
export const previewNotes = (envId: number, kind: string, version: string) =>
  data<ReleaseNotes>(api.post(`/hub/environments/${envId}/release-notes`, { kind, version }))
export const fetchDeployNotes = (deployId: number) =>
  data<ReleaseNotes | null>(api.get(`/hub/deploys/${deployId}/release-notes`))
export const computeDeployNotes = (deployId: number) =>
  data<ReleaseNotes | null>(api.post(`/hub/deploys/${deployId}/release-notes`, {}))

export const startTrain = (
  appId: number,
  body: { version: string; steps: TrainStepInput[]; confirm: string }
) => data<HubTrain>(api.post(`/hub/apps/${appId}/trains`, body))
export const skipTrainStep = (id: number, step: number) =>
  data<HubTrain>(api.post(`/hub/trains/${id}/skip`, { step }))
export const abortTrain = (id: number) => data<HubTrain>(api.post(`/hub/trains/${id}/abort`, {}))

export const createSchedule = (body: Record<string, unknown>) =>
  data<HubSchedule>(api.post('/hub/schedules', body))
export const cancelSchedule = (id: number) =>
  data<HubSchedule>(api.post(`/hub/schedules/${id}/cancel`, {}))

export const saveFreeze = (id: number | null, body: Record<string, unknown>) =>
  data<HubFreeze>(id ? api.patch(`/hub/freezes/${id}`, body) : api.post('/hub/freezes', body))
export const deleteFreeze = (id: number) => data<{ id: number }>(api.delete(`/hub/freezes/${id}`))

export const saveRollbackRule = (envId: number, body: Record<string, unknown>) =>
  data<RollbackRule>(api.put(`/hub/environments/${envId}/rollback-rule`, body))
export const deleteRollbackRule = (envId: number) =>
  data<{ environment_id: number }>(api.delete(`/hub/environments/${envId}/rollback-rule`))

export const TRAIN_STEP_WORDS: Record<TrainStepStatus, string> = {
  pending: 'Waiting to start',
  starting: 'Starting',
  promoting: 'Promoting',
  soaking: 'Holding',
  held: 'Needs a person',
  passed: 'Passed',
  skipped: 'Skipped',
  failed: 'Failed'
}

export const TRAIN_STATUS_WORDS: Record<HubTrain['status'], string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Stopped',
  aborted: 'Aborted'
}

export const SCHEDULE_WORDS: Record<HubSchedule['status'], string> = {
  scheduled: 'Scheduled',
  starting: 'Starting',
  waiting: 'Waiting',
  started: 'Started',
  failed: 'Did not start',
  cancelled: 'Cancelled'
}

export const WATCH_WORDS: Record<RollbackWatch['status'], string> = {
  watching: 'Watching',
  rolling: 'Rolling back',
  passed: 'Passed',
  rolled_back: 'Rolled back',
  failed: 'Could not judge or roll back',
  superseded: 'Another deploy followed'
}

/** A datetime-local value (the viewer's zone) as a UTC ISO string, or null. */
export function localInputToIso(v: string): string | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** A UTC ISO string as a datetime-local value in the viewer's zone. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** The viewer's own IANA zone (the default for a month-end freeze). */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
