/**
 * Dashboard commands: the Dashboards builder's boards and their widget figures.
 * Every figure computes AS THE CALLER — read permission, the role's row filter,
 * User Scopes and the role's field list bind it, exactly as for the person in
 * the app. Report Studio reports are in commands/admin (`listReports`).
 */
import { type Command, cmd } from '../command.js'
import type { ISODate, UUID } from '../index.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type DashboardWidgetType =
  | 'count'
  | 'sum'
  | 'avg'
  | 'latest'
  | 'bar_chart'
  | 'line_chart'
  | 'saved_view'
  | (string & {})

/** A dashboard filter: binds only widgets whose collection has the field. */
export interface DashboardFilter {
  field: string
  value: unknown
  op?: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in'
}

export interface DashboardWidget {
  id: UUID
  dashboard: UUID
  type: DashboardWidgetType
  title: string
  collection: string | null
  /** The summed/averaged field, the `latest` column list, or a saved view id. */
  field: string | null
  filters: unknown
  col: number
  row: number
  width: number
  height: number
  refresh_seconds?: number | null
}

export interface Dashboard {
  id: UUID
  name: string
  user: UUID | null
  is_shared: boolean
  role_id: UUID | null
  /** The saved filter bar the board opens with. */
  global_filters: DashboardFilter[] | null
  widgets: DashboardWidget[]
  created_at: ISODate
  updated_at: ISODate
}

/** count / sum / avg / saved_view → value; latest → rows; bar/line charts → daily rows. */
export interface DashboardWidgetData {
  value?: number | null
  rows?: Array<Record<string, unknown>>
  sum_field?: string | null
  view?: { id: number; name: string; collection: string }
  reason?: string
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/** The caller's own dashboards plus those shared with everyone or with their role. */
export function listDashboards(): Command<{ data: Dashboard[] }> {
  return cmd('GET', '/dashboards')
}

/** One dashboard with its widgets (403 when it is neither the caller's nor shared with them). */
export function readDashboard(id: UUID): Command<{ data: Dashboard }> {
  return cmd('GET', `/dashboards/${id}`)
}

/** One widget's figure, computed as the caller; `filters` = the dashboard filter bar. */
export function readDashboardWidgetData(
  widgetId: UUID,
  filters?: DashboardFilter[] | null
): Command<{ data: DashboardWidgetData | null }> {
  return cmd(
    'GET',
    `/dashboards/widgets/${widgetId}/data`,
    filters?.length ? { extra_filters: JSON.stringify(filters) } : undefined
  )
}

// ─── Building dashboards ──────────────────────────────────────────────────────

/**
 * Create a dashboard owned by the caller. A `role_id` shares it with that role (and forces
 * `is_shared`).
 */
export function createDashboard(body: {
  name: string
  is_shared?: boolean
  role_id?: UUID | null
}): Command<{ data: Dashboard }> {
  return cmd('POST', '/dashboards', undefined, body)
}

/** Rename, share or set the saved filter bar of a dashboard (its owner or an admin). */
export function updateDashboard(
  id: UUID,
  body: {
    name?: string
    is_shared?: boolean
    role_id?: UUID | null
    /** Up to 20 filters; an empty list clears the bar. */
    global_filters?: DashboardFilter[] | null
  }
): Command<{ data: Dashboard }> {
  return cmd('PATCH', `/dashboards/${id}`, undefined, body)
}

/** Delete a dashboard and its widgets (its owner or an admin). */
export function deleteDashboard(id: UUID): Command<void> {
  return cmd('DELETE', `/dashboards/${id}`)
}

/** A widget's settings on create / update. Grid units: `col`/`row` position, `width`/`height`. */
export interface DashboardWidgetInput {
  /**
   * count | sum | avg | latest | bar_chart | line_chart | report_preset | saved_view |
   * cumulative_flow | ai_query.
   */
  type: DashboardWidgetType
  title: string
  collection?: string | null
  /** The summed/averaged field, the `latest` column list, a saved view or preset id. */
  field?: string | null
  filters?: unknown
  col?: number
  row?: number
  width?: number
  height?: number
  /** Refetch interval in seconds (10–86400); null = the page default. */
  refresh_seconds?: number | null
}

/** Add a widget to a dashboard (its owner or an admin). */
export function createDashboardWidget(
  dashboardId: UUID,
  body: DashboardWidgetInput
): Command<{ data: DashboardWidget }> {
  return cmd('POST', `/dashboards/${dashboardId}/widgets`, undefined, body)
}

/** Change a widget (its dashboard's owner or an admin). */
export function updateDashboardWidget(
  widgetId: UUID,
  body: Partial<DashboardWidgetInput>
): Command<{ data: DashboardWidget }> {
  return cmd('PATCH', `/dashboards/widgets/${widgetId}`, undefined, body)
}

/** Remove a widget (its dashboard's owner or an admin). */
export function deleteDashboardWidget(widgetId: UUID): Command<void> {
  return cmd('DELETE', `/dashboards/widgets/${widgetId}`)
}
