/**
 * Dashboard and report tools (#2491): the boards and Report Studio reports the
 * key's user can open, and their widget figures. Every figure comes from the
 * same widget endpoints the app renders, so it is computed AS THE CALLER — read
 * permission, row filters, User Scopes and field lists bind it exactly as they
 * bind the person looking at the board. Nothing here rebuilds a query.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type Dashboard,
  type DashboardFilter,
  type DashboardWidget,
  listDashboards,
  listReports,
  type NivaroClient,
  type ReportDateRange,
  type ReportDef,
  type ReportWidget,
  readDashboard,
  readDashboardWidgetData,
  readReport,
  readReportWidgetData
} from '@nivaro/sdk'
import { z } from 'zod'
import { READ } from '../annotations.js'
import { clip, clipRow, pageOf } from '../compact.js'
import { describeFailure, fail, ok, refuse } from '../result.js'
import { clampTo, uuid } from '../schema.js'

type Row = Record<string, unknown>

/** Widget reads in flight at once — a board answers quickly without a burst. */
const CONCURRENCY = 4

/** Map with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const LIST_CAPS: Record<string, number> = {
  rows: 20,
  series: 50,
  cells: 100,
  tiles: 20,
  spark: 0,
  steps: 50
}

/**
 * A widget's figure, small enough for a model: lists cut (and counted), long text
 * clipped, chart sparklines dropped (the series already carries the numbers).
 */
export function compactFigure(data: unknown): unknown {
  if (data === null || data === undefined) return null
  if (typeof data !== 'object' || Array.isArray(data)) return data
  const out: Row = {}
  for (const [key, value] of Object.entries(data as Row)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      const cap = LIST_CAPS[key] ?? 20
      if (cap === 0) continue
      out[key] = value
        .slice(0, cap)
        .map((v) => (v && typeof v === 'object' && !Array.isArray(v) ? clipRow(v as Row, 160) : v))
      if (value.length > cap) {
        out[`${key}_total`] = value.length
        out[`${key}_truncated`] = true
      }
    } else if (typeof value === 'string') {
      out[key] = clip(value, key === 'narrative' ? 1500 : 500)
    } else if (value && typeof value === 'object') {
      const nested = compactFigure(value)
      const json = JSON.stringify(nested)
      out[key] = json.length > 4000 ? `${clip(json, 4000)} (truncated)` : nested
    } else out[key] = value
  }
  return out
}

/** A failed widget read as a model should see it: message and status, never a stack. */
function widgetError(err: unknown): Row {
  const f = describeFailure(err)
  return { error: f.error, ...(f.status ? { status: f.status } : {}) }
}

const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'] as const

const dashboardFilter = z.object({
  field: z.string().regex(/^[A-Za-z0-9_]{1,128}$/, 'A field name'),
  value: z.unknown(),
  op: z.enum(FILTER_OPS).optional()
})

/** The filter bar: an array, or the same as a JSON string (some clients send that). */
export function toFilters(value: unknown): DashboardFilter[] | undefined {
  if (value === undefined || value === null) return undefined
  let parsed = value
  if (typeof value === 'string') {
    if (!value.trim()) return undefined
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error('filters must be a JSON array of { field, value, op? }')
    }
  }
  const res = z.array(dashboardFilter).safeParse(parsed)
  if (!res.success) throw new Error('filters must be an array of { field, value, op? }')
  return res.data as DashboardFilter[]
}

const byPosition = (a: DashboardWidget, b: DashboardWidget) => a.row - b.row || a.col - b.col

/** Pick the named widgets (in the board's order) or the first `limit`. */
function pick<W extends { id: string }>(widgets: W[], ids: string[] | undefined, limit: number) {
  if (ids?.length) {
    const wanted = new Set(ids)
    const chosen = widgets.filter((w) => wanted.has(String(w.id)))
    return {
      chosen,
      missing: ids.filter((id) => !chosen.some((w) => String(w.id) === id)),
      truncated: false
    }
  }
  return { chosen: widgets.slice(0, limit), missing: [], truncated: widgets.length > limit }
}

export function registerDashboardTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'list_dashboards',
    {
      title: 'List dashboards and reports',
      description:
        "The dashboards and Report Studio reports the key's user can open — their own and those shared with everyone or their role — with how many widgets each has. read_dashboard shows a dashboard's figures, run_report a report's.",
      inputSchema: {
        search: z.string().optional().describe('Case-insensitive match on name or description.'),
        limit: z.number().int().optional().describe('Entries per list (1–100, default 25).')
      },
      annotations: READ
    },
    async ({ search, limit }) => {
      const n = clampTo(limit, 25, 100)
      const needle = search?.trim().toLowerCase()
      const matches = (...values: unknown[]) =>
        !needle || values.some((v) => typeof v === 'string' && v.toLowerCase().includes(needle))
      const [boards, reports] = await Promise.allSettled([
        client.request(listDashboards()),
        client.request(listReports())
      ])
      if (boards.status === 'rejected' && reports.status === 'rejected') return fail(boards.reason)
      const out: Row = {}
      if (boards.status === 'fulfilled') {
        const page = pageOf(
          boards.value.data.filter((d) => matches(d.name)),
          n
        )
        out.dashboards = page.items.map((d) => ({
          id: d.id,
          name: d.name,
          shared: !!d.is_shared,
          ...(d.role_id ? { shared_with_role: d.role_id } : {}),
          widgets: Array.isArray(d.widgets) ? d.widgets.length : 0,
          ...(d.global_filters?.length ? { filters: d.global_filters } : {})
        }))
        out.dashboards_total = page.total
        if (page.truncated) out.dashboards_truncated = true
      } else out.dashboards_error = widgetError(boards.reason)
      if (reports.status === 'fulfilled') {
        const page = pageOf(
          reports.value.data.filter((r) => matches(r.name, r.description)),
          n
        )
        out.reports = page.items.map((r) => ({
          id: r.id,
          name: r.name,
          description: clip(r.description, 200),
          shared: !!r.is_shared,
          ...(r.role_id ? { shared_with_role: r.role_id } : {}),
          widgets: r.widget_count ?? 0
        }))
        out.reports_total = page.total
        if (page.truncated) out.reports_truncated = true
      } else out.reports_error = widgetError(reports.reason)
      return ok(out)
    }
  )

  server.registerTool(
    'read_dashboard',
    {
      title: 'Read a dashboard',
      description:
        "A dashboard's widgets with their figures — counts, sums, averages, latest rows, daily chart points — computed as the key's user, exactly as the dashboard shows them to that person. The dashboard's saved filter bar applies unless filters is given.",
      inputSchema: {
        dashboard_id: uuid.describe('The dashboard id from list_dashboards.'),
        widget_ids: z
          .array(uuid)
          .max(50)
          .optional()
          .describe('Only these widgets (default: the first `limit`, top-left first).'),
        filters: z
          .union([z.array(dashboardFilter), z.string()])
          .optional()
          .describe(
            'Replace the saved filter bar: [{ field, value, op? }] (op eq, neq, gt, gte, lt, lte, contains, in). A filter binds only widgets whose collection has the field. [] = no filters.'
          ),
        limit: z.number().int().optional().describe('Widgets to compute (1–30, default 12).')
      },
      annotations: READ
    },
    async ({ dashboard_id, widget_ids, filters, limit }) => {
      let override: DashboardFilter[] | undefined
      try {
        override = toFilters(filters)
      } catch (err) {
        return refuse((err as Error).message, 'BAD_FILTERS')
      }
      let board: Dashboard
      try {
        board = (await client.request(readDashboard(dashboard_id))).data
      } catch (err) {
        return fail(err)
      }
      const applied = override ?? board.global_filters ?? []
      const widgets = [...(board.widgets ?? [])].sort(byPosition)
      const { chosen, missing, truncated } = pick(widgets, widget_ids, clampTo(limit, 12, 30))
      const figures = await mapLimit(chosen, CONCURRENCY, async (w) => {
        const head: Row = { id: w.id, title: w.title, type: w.type }
        if (w.collection) head.collection = w.collection
        if (w.field && w.type !== 'saved_view') head.field = w.field
        try {
          const res = await client.request(readDashboardWidgetData(w.id, applied))
          return { ...head, figure: compactFigure(res.data) }
        } catch (err) {
          return { ...head, ...widgetError(err) }
        }
      })
      const out: Row = {
        dashboard: { id: board.id, name: board.name, shared: !!board.is_shared },
        filters: applied,
        widgets: figures,
        widget_total: widgets.length
      }
      if (truncated) {
        out.truncated = true
        out.note = `Computed the first ${chosen.length} of ${widgets.length} widgets; pass widget_ids or a larger limit for the rest.`
      }
      if (missing.length) out.unknown_widget_ids = missing
      return ok(out)
    }
  )

  server.registerTool(
    'run_report',
    {
      title: 'Run a report',
      description:
        "A Report Studio report's widgets with their figures (KPIs with change from the previous period, series, tables, pivots, narratives), computed as the key's user — exactly what the report shows that person. The report's saved date range applies unless date_range is given.",
      inputSchema: {
        report_id: uuid.describe('The report id from list_dashboards.'),
        date_range: z
          .object({
            preset: z.enum([
              'this_month',
              'last_30_days',
              'last_3_months',
              'last_6_months',
              'last_12_months',
              'ytd',
              'custom'
            ]),
            start: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional(),
            end: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional()
          })
          .optional()
          .describe('Override the period, e.g. { preset: "last_3_months" } or custom start/end.'),
        widget_ids: z.array(uuid).max(50).optional().describe('Only these widgets.'),
        limit: z.number().int().optional().describe('Widgets to compute (1–30, default 12).')
      },
      annotations: READ
    },
    async ({ report_id, date_range, widget_ids, limit }) => {
      if (date_range?.preset === 'custom' && (!date_range.start || !date_range.end))
        return refuse('A custom date_range needs start and end (YYYY-MM-DD).', 'BAD_DATE_RANGE')
      let report: ReportDef
      try {
        report = (await client.request(readReport(report_id))).data
      } catch (err) {
        return fail(err)
      }
      // Dividers carry no figure.
      const widgets = [...(report.widgets ?? [])]
        .filter((w) => w.type !== 'divider')
        .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.y - b.y || a.x - b.x)
      const { chosen, missing, truncated } = pick(widgets, widget_ids, clampTo(limit, 12, 30))
      const range = (date_range as ReportDateRange | undefined) ?? undefined
      const figures = await mapLimit(chosen, CONCURRENCY, async (w: ReportWidget) => {
        const head: Row = { id: w.id, title: w.title, type: w.type }
        if (w.collection) head.collection = w.collection
        try {
          const res = await client.request(
            readReportWidgetData(report.id, w.id, range ? { date_range: range } : undefined)
          )
          return { ...head, figure: compactFigure(res.data) }
        } catch (err) {
          return { ...head, ...widgetError(err) }
        }
      })
      const out: Row = {
        report: {
          id: report.id,
          name: report.name,
          description: clip(report.description, 300)
        },
        date_range: range ?? report.global_filters?.date_range ?? null,
        widgets: figures,
        widget_total: widgets.length
      }
      if (truncated) {
        out.truncated = true
        out.note = `Computed the first ${chosen.length} of ${widgets.length} widgets; pass widget_ids or a larger limit for the rest.`
      }
      if (missing.length) out.unknown_widget_ids = missing
      return ok(out)
    }
  )
}
