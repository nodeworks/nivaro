import type { DataTag } from '@tanstack/react-query'
import { api } from '@/lib/api'

/**
 * Hub providers, Wave 2 framework (Task 13): what the admin reads and sends for a resource's
 * outputs and bindings, and for notify routes (routes/hub-provider-outputs.ts). An output never
 * comes back as a value: the key, a fingerprint, when it changed, and whether it is lost.
 */

export type BindingTarget = 'stack_setting' | 'stack_secret' | 'app_setting'

export const TARGET_LABEL: Record<BindingTarget, string> = {
  stack_setting: 'Stack setting',
  stack_secret: 'Stack secret',
  app_setting: 'App setting'
}

export interface OutputView {
  key: string
  label: string
  secret: boolean
  once_only: boolean
  set: boolean
  fingerprint: string | null
  updated_at: string | null
  lost: boolean
  rotate: boolean
}

export interface BindingView {
  id: number
  resource_id: number
  output_key: string
  environment_id: number
  environment_key: string | null
  target: BindingTarget
  target_key: string
  last_pushed_at: string | null
  last_fingerprint: string | null
  last_error: string | null
  stale: boolean
  needs_apply: boolean
}

export interface ResourceBindings {
  outputs: OutputView[]
  bindings: BindingView[]
  targets?: BindingTarget[]
  app_settings?: string[]
}

export interface BindingInput {
  output_key: string
  environment_id: number
  target: BindingTarget
  target_key: string
}

export type NotifyEventKey =
  | 'deploy.started'
  | 'deploy.finished'
  | 'deploy.failed'
  | 'incident.opened'
  | 'incident.updated'
  | 'incident.resolved'
  | 'approval.needed'
  | 'drift.found'
  | 'backup.failed'
  | 'cert.expiring'
  | 'domain.expiring'
  | 'cost.over_budget'

export interface NotifyRoute {
  id: number
  name: string | null
  scope: 'hub' | 'app'
  app_id: number | null
  events: NotifyEventKey[]
  resource_id: number
  enabled: boolean
  last_sent_at: string | null
  last_error_at: string | null
  last_error: string | null
}

export interface NotifyRoutes {
  routes: NotifyRoute[]
  events: Array<{ key: NotifyEventKey; label: string }>
}

export interface NotifyRouteBody {
  name?: string | null
  scope?: 'hub' | 'app'
  app_id?: number | null
  events?: NotifyEventKey[]
  resource_id?: number
  enabled?: boolean
}

type Tagged<K extends readonly unknown[], T> = DataTag<K, T>
const tag = <T, K extends readonly unknown[]>(k: K) => k as unknown as Tagged<K, T>

export const outputKeys: {
  bindings: (
    resourceId: number
  ) => Tagged<readonly ['hub-providers', 'bindings', number], ResourceBindings>
  notifyRoutes: () => Tagged<readonly ['hub-providers', 'notify-routes'], NotifyRoutes>
} = {
  bindings: (resourceId) =>
    tag<ResourceBindings, readonly ['hub-providers', 'bindings', number]>([
      'hub-providers',
      'bindings',
      resourceId
    ]),
  notifyRoutes: () =>
    tag<NotifyRoutes, readonly ['hub-providers', 'notify-routes']>([
      'hub-providers',
      'notify-routes'
    ])
}

const data = <T>(r: { data: { data: T } }) => r.data.data

export const fetchBindings = (resourceId: number) =>
  api.get<{ data: ResourceBindings }>(`/hub/resources/${resourceId}/bindings`).then(data)

export const saveBindings = (resourceId: number, bindings: BindingInput[]) =>
  api
    .put<{ data: ResourceBindings }>(`/hub/resources/${resourceId}/bindings`, { bindings })
    .then(data)

export const fetchNotifyRoutes = () =>
  api.get<{ data: NotifyRoutes }>('/hub/notify-routes').then(data)

export const createNotifyRoute = (body: NotifyRouteBody) =>
  api.post<{ data: NotifyRoute }>('/hub/notify-routes', body).then(data)

export const updateNotifyRoute = (id: number, body: NotifyRouteBody) =>
  api.patch<{ data: NotifyRoute }>(`/hub/notify-routes/${id}`, body).then(data)

export const deleteNotifyRoute = (id: number) => api.delete(`/hub/notify-routes/${id}`)

export const testNotifyRoute = (id: number) =>
  api
    .post<{ data: { ok: boolean; code?: string; error?: string } }>(`/hub/notify-routes/${id}/test`)
    .then(data)

/** The short form of a fingerprint people compare by eye. */
export const shortPrint = (fp: string | null) => (fp ? fp.slice(0, 8) : null)
