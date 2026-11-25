import type { DataTag } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Hub change operations — what the Changes tab and the Promote / Move / Upgrade panels read and
 * send (routes/hub-changes.ts): the change calendar, deploy windows and pre-deploy checklists.
 * Times travel as UTC ISO strings and are shown in the viewer's own zone; a deploy window's
 * weekly ranges are wall-clock times in the window's own zone.
 */

export type CalendarKind =
  | 'promote'
  | 'rollback'
  | 'scheduled'
  | 'train'
  | 'move'
  | 'upgrade'
  | 'freeze'
  | 'window'
  | 'maintenance'
  | 'note'
  | 'tls'
  | 'other'

export type EventStatus = 'planned' | 'waiting' | 'running' | 'done' | 'failed' | 'cancelled' | 'on'

export interface CalendarEvent {
  id: string
  kind: CalendarKind
  title: string
  app_id: number | null
  app_key: string | null
  environment_id: number | null
  env_key: string | null
  start: string
  end: string | null
  status: EventStatus
  detail: string | null
}

export interface CalendarAnswer {
  from: string
  to: string
  events: CalendarEvent[]
  now: string
}

export interface WeeklyRange {
  days: number[]
  from: string
  to: string
}

export interface DeployWindow {
  id: number
  app_id: number | null
  name: string
  env_scope: 'all' | 'production'
  recurrence: 'weekly' | 'none'
  ranges: WeeklyRange[]
  starts_at: string | null
  ends_at: string | null
  time_zone: string
  enabled: boolean
  words?: string
  /** Why the stored window cannot be read (it refuses until fixed); null = fine. */
  invalid?: string | null
}

export interface ChangeEnv {
  id: number
  app_id: number
  key: string
  position: number
  on_shared: boolean
  production: boolean
  window: {
    governed: boolean
    open: boolean
    closes_at: string | null
    opens_at: string | null
    name: string | null
    invalid?: boolean
  }
}

export type TickBy = 'admin' | 'owner' | 'people'
export type ChecklistAction =
  | 'promote'
  | 'move'
  | 'upgrade'
  | 'config_promote'
  | 'extension_promote'
  /** Hub enhancement 47: an app's retirement (items opt in). */
  | 'retire'

export interface ChecklistItem {
  id: number
  app_id: number
  environment_id: number | null
  text: string
  help: string | null
  required: boolean
  tick_by: TickBy
  tick_people: string[]
  tick_people_names?: Array<string | null>
  actions: ChecklistAction[]
  position: number
  archived: boolean
}

export interface WaitingChecklist {
  id: number
  action: ChecklistAction
  version: string | null
  source: 'schedule' | 'train' | 'person'
  source_id: number | null
  target_kind: 'environment' | 'shared'
  target_id: number
  env_key: string | null
  app_id: number | null
  created_at: string | null
}

export interface ChangesOverview {
  apps: Array<{ id: number; key: string; name: string }>
  environments: ChangeEnv[]
  windows: DeployWindow[]
  items: ChecklistItem[]
  waiting: WaitingChecklist[]
  now: string
}

export interface ChecklistTick {
  by: string
  by_name: string | null
  at: string
  note: string | null
}

export interface ChecklistEntry {
  key: string
  item_id: number
  app_id: number
  app_key: string
  environment_id: number
  env_key: string
  text: string
  help: string | null
  required: boolean
  tick_by: TickBy
  tick_people: string[]
  tick_people_names: Array<string | null>
  may_tick: boolean
  tick: ChecklistTick | null
}

export interface ChecklistView {
  production: boolean
  required: boolean
  /** A real rollback (to an older version than runs): no checklist. */
  exempt?: boolean
  /** Required items still open, all of them (a non-admin sees only their app's entries). */
  left?: number
  entries: ChecklistEntry[]
  run: {
    id: number
    status: 'open' | 'used' | 'void'
    version: string | null
    action: ChecklistAction
    source: 'person' | 'schedule' | 'train'
    source_id: number | null
    source_step: number | null
    run_kind: string | null
    run_id: number | null
    created_at: string | null
    used_at: string | null
  } | null
  missing: string[]
  ready: boolean
}

export type ChecklistTarget =
  | { kind: 'environment'; envId: number }
  | { kind: 'shared'; sharedId: number }

function tag<K extends readonly unknown[], T>(k: K) {
  return k as unknown as DataTag<K, T>
}

type Tagged<K extends readonly unknown[], T> = DataTag<K, T>

export const changeKeys: {
  all: readonly ['hub-changes']
  overview: () => Tagged<readonly ['hub-changes', 'overview'], ChangesOverview>
  calendar: (
    from: string,
    to: string,
    appId: number | null
  ) => Tagged<readonly ['hub-changes', 'calendar', string, string, number | null], CalendarAnswer>
  window: (envId: number) => Tagged<readonly ['hub-changes', 'window', number], EnvWindow>
  checklist: (
    target: ChecklistTarget,
    action: ChecklistAction,
    version: string | null,
    kind?: 'rollback' | null
  ) => Tagged<
    readonly ['hub-changes', 'checklist', string, string, string | null, string],
    ChecklistView
  >
  run: (id: number) => Tagged<readonly ['hub-changes', 'run', number], ChecklistView>
  sharedWindow: (
    sharedId: number
  ) => Tagged<readonly ['hub-changes', 'shared-window', number], SharedWindow>
} = {
  all: ['hub-changes'] as const,
  overview: () =>
    tag<readonly ['hub-changes', 'overview'], ChangesOverview>([
      'hub-changes',
      'overview'
    ] as const),
  calendar: (from: string, to: string, appId: number | null) =>
    tag<readonly ['hub-changes', 'calendar', string, string, number | null], CalendarAnswer>([
      'hub-changes',
      'calendar',
      from,
      to,
      appId
    ] as const),
  window: (envId: number) =>
    tag<readonly ['hub-changes', 'window', number], EnvWindow>([
      'hub-changes',
      'window',
      envId
    ] as const),
  checklist: (target, action, version, kind) =>
    tag<
      readonly ['hub-changes', 'checklist', string, string, string | null, string],
      ChecklistView
    >([
      'hub-changes',
      'checklist',
      target.kind === 'shared' ? `shared:${target.sharedId}` : `env:${target.envId}`,
      action,
      version,
      kind ?? 'forward'
    ] as const),
  run: (id: number) =>
    tag<readonly ['hub-changes', 'run', number], ChecklistView>([
      'hub-changes',
      'run',
      id
    ] as const),
  sharedWindow: (sharedId: number) =>
    tag<readonly ['hub-changes', 'shared-window', number], SharedWindow>([
      'hub-changes',
      'shared-window',
      sharedId
    ] as const)
}

export interface EnvWindow {
  governed: boolean
  open: boolean
  production: boolean
  closes_at: string | null
  opens_at: string | null
  windows: Array<{ id: number; name: string; words: string }>
  invalid?: Array<{ id: number; name: string; why: string }>
}

export interface SharedWindow {
  open: boolean
  code: string | null
  message: string | null
  opens_at: string | null
}

const data = <T>(p: Promise<{ data: { data: T } }>) => p.then((r) => r.data.data)

export const fetchChanges = () => data<ChangesOverview>(api.get('/hub/changes/overview'))
export const fetchCalendar = (from: string, to: string, appId: number | null) =>
  data<CalendarAnswer>(
    api.get('/hub/calendar', { params: { from, to, ...(appId ? { app_id: appId } : {}) } })
  )
export const fetchEnvWindow = (envId: number) =>
  data<EnvWindow>(api.get(`/hub/environments/${envId}/deploy-window`))

/** Downloads the .ics through the signed-in API (a file, not a feed). */
export async function downloadIcs(o: { appId?: number | null; owner?: string | null }) {
  const r = await api.get<Blob>('/hub/calendar.ics', {
    params: { ...(o.appId ? { app_id: o.appId } : {}), ...(o.owner ? { owner: o.owner } : {}) },
    responseType: 'blob'
  })
  const url = URL.createObjectURL(r.data)
  const a = document.createElement('a')
  a.href = url
  a.download = 'hub-changes.ics'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export interface WindowBody {
  name: string
  app_id: number | null
  env_scope: 'all' | 'production'
  recurrence: 'weekly' | 'none'
  ranges?: WeeklyRange[]
  time_zone?: string
  starts_at?: string | null
  ends_at?: string | null
  enabled?: boolean
}

export const saveWindow = (id: number | null, body: WindowBody) =>
  data<DeployWindow>(
    id == null
      ? api.post('/hub/deploy-windows', body)
      : api.patch(`/hub/deploy-windows/${id}`, body)
  )
export const deleteWindow = (id: number) =>
  data<{ id: number }>(api.delete(`/hub/deploy-windows/${id}`))
export const queuePromotion = (envId: number, version: string, confirm: string) =>
  data<{ id: number; run_at: string }>(
    api.post(`/hub/environments/${envId}/promote/queue`, { version, confirm })
  )

export interface ItemBody {
  app_id: number
  environment_id: number | null
  text: string
  help?: string | null
  required: boolean
  tick_by: TickBy
  tick_people?: string[]
  actions: ChecklistAction[]
  position?: number
}

export const saveItem = (id: number | null, body: ItemBody) =>
  data<ChecklistItem>(
    id == null
      ? api.post('/hub/checklist-items', body)
      : api.patch(`/hub/checklist-items/${id}`, body)
  )
export const archiveItem = (id: number) =>
  data<{ id: number }>(api.delete(`/hub/checklist-items/${id}`))

export const fetchChecklist = (
  target: ChecklistTarget,
  action: ChecklistAction,
  version: string | null,
  kind?: 'rollback' | null
) =>
  data<ChecklistView>(
    target.kind === 'shared'
      ? api.get(`/hub/shared/${target.sharedId}/checklist`, {
          params: { version, ...(kind ? { kind } : {}) }
        })
      : api.get(`/hub/environments/${target.envId}/checklist`, {
          params: { action, ...(version ? { version } : {}), ...(kind ? { kind } : {}) }
        })
  )
export const fetchSharedWindow = (sharedId: number) =>
  data<SharedWindow>(api.get(`/hub/shared/${sharedId}/deploy-window`))
export const openChecklist = (
  target: ChecklistTarget,
  action: ChecklistAction,
  version: string | null
) =>
  data<ChecklistView>(
    target.kind === 'shared'
      ? api.post(`/hub/shared/${target.sharedId}/checklist-runs`, { version })
      : api.post(`/hub/environments/${target.envId}/checklist-runs`, { action, version })
  )
export const fetchRun = (id: number) => data<ChecklistView>(api.get(`/hub/checklist-runs/${id}`))
export const tickItem = (runId: number, key: string, ticked: boolean, note: string | null) =>
  data<ChecklistView>(api.post(`/hub/checklist-runs/${runId}/tick`, { key, ticked, note }))
export const voidChecklist = (runId: number) =>
  data<{ id: number }>(api.post(`/hub/checklist-runs/${runId}/void`, {}))

export const KIND_WORDS: Record<CalendarKind, string> = {
  promote: 'Promotion',
  rollback: 'Rollback',
  scheduled: 'Scheduled',
  train: 'Release train',
  move: 'Move',
  upgrade: 'Shared upgrade',
  freeze: 'Freeze',
  window: 'Deploy window',
  maintenance: 'Maintenance',
  note: 'Note',
  tls: 'Certificate',
  other: 'Other'
}

export const STATUS_WORDS: Record<EventStatus, string> = {
  planned: 'Planned',
  waiting: 'Waiting',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  on: 'On now'
}

export const TICK_BY_WORDS: Record<TickBy, string> = {
  admin: 'Hub administrators',
  owner: 'Administrators and app owners',
  people: 'Named people'
}

export const DAY_LETTERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
