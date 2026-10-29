/**
 * Form and widget drill-down reads for assistants (#3208 #3216 #3217 #3218).
 * Every one is computed AS THE CALLER — permissions, row filters, User Scopes
 * and field lists bind; a role preview is for administrators only.
 */
import { type Command, cmd } from '../command.js'
import type { DashboardFilter } from './dashboards.js'

type UUID = string

/** The rows behind a dashboard or report widget's number. */
export interface WidgetDrillRows {
  /** What the number is: type, collection, metric, filters, date range, segment, query. */
  definition: Record<string, unknown>
  collection: string | null
  total: number | null
  capped: boolean
  columns: string[]
  rows: Array<Record<string, unknown>>
  /** The record filter the rows came from (items filter syntax). */
  filter?: Record<string, unknown> | null
  note?: string
  dashboard?: { id: string; name?: string }
  report?: { id: string; name?: string }
}

export interface WidgetDrillBody {
  /** One part of the figure: a chart bar's value, a series dimension, a day ('date'). */
  segment?: { field?: string | null; value?: unknown } | null
  /** Columns to return (readable, registered fields only). Default: the widget's own. */
  fields?: string[]
  /** Rows (1–100, default 25). */
  limit?: number
}

/** The definition and rows behind a dashboard widget, as the caller. */
export function drillDashboardWidgetRows(
  widgetId: UUID,
  body: WidgetDrillBody & { extra_filters?: DashboardFilter[] } = {}
): Command<{ data: WidgetDrillRows }> {
  return cmd('POST', `/dashboards/widgets/${widgetId}/rows`, undefined, body)
}

/** The definition and rows behind a Report Studio widget, as the caller. */
export function drillReportWidgetRows(
  reportId: UUID,
  widgetId: UUID,
  body: WidgetDrillBody & {
    date_range?: { preset: string; start?: string; end?: string } | null
    entity_filters?: Array<{ field: string; values: Array<string | number> }>
  } = {}
): Command<{ data: WidgetDrillRows }> {
  return cmd('POST', `/report-studio/${reportId}/widgets/${widgetId}/rows`, undefined, body)
}

export interface FormFieldStateRow {
  field: string
  label: string
  group_key: string | null
  section: string | null
  visible: boolean
  required: boolean
  locked: boolean
  missing?: true
  hidden_by?: string
  locked_by?: string
  why?: string
}

export interface FormStateAnswer {
  collection: string
  record: string | null
  as: { role: string | null; admin: boolean; preview: boolean }
  layout: { id: number; name: string; why: string | null } | null
  can_update: boolean
  derived: Record<string, unknown>
  groups: Array<{
    key: string
    label: string
    type: string
    parent_key: string | null
    visible: boolean
    locked: boolean
    why?: string
  }>
  fields: FormFieldStateRow[]
  summary: {
    visible: number
    hidden: number
    required: string[]
    locked: string[]
    missing: string[]
  }
  note?: string
}

export interface FormStateQuery {
  collection: string
  item?: string | number
  layout_id?: number
  /** Field values laid over the record (or a new one) before the rules run. */
  values?: Record<string, unknown>
  /** Administrators only: judge as this role (name or id). */
  role?: string
  viewport?: 'phone'
}

/** Which fields the resolved form shows, requires and locks, and why. */
export function readFormState(query: FormStateQuery): Command<{ data: FormStateAnswer }> {
  return cmd('POST', '/collection-layouts/form-state', undefined, query)
}

export interface FormImageAnswer {
  mime: 'image/png'
  base64: string
  bytes: number
  width: number
  collection: string
  record: string | null
  as: FormStateAnswer['as']
  layout: FormStateAnswer['layout']
  can_update: boolean
  summary: FormStateAnswer['summary']
}

/** A PNG of how the form looks (base64), values only where the caller may read them. */
export function renderFormImage(
  query: FormStateQuery & { theme?: 'light' | 'dark'; show_hidden?: boolean }
): Command<{ data: FormImageAnswer }> {
  return cmd('POST', '/collection-layouts/render-form', undefined, query)
}

export interface LayoutLintAnswer {
  layout: { id: number; name: string; collection: string }
  score: number
  costs: Array<{ label: string; points: number }>
  counts: { error: number; warn: number; info: number }
  findings: Array<{
    id: string
    rule: string
    severity: 'error' | 'warn' | 'info'
    where: string
    target: Record<string, unknown>
    message: string
    fix?: { label: string; ops: Array<Record<string, unknown>> }
  }>
  truncated?: true
  total?: number
}

/** The layout editor's lint findings and health score for a saved form. Admin only. */
export function readLayoutLint(layoutId: number): Command<{ data: LayoutLintAnswer }> {
  return cmd('GET', `/collection-layouts/${layoutId}/lint`)
}
