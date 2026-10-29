/**
 * drill_widget (#3208): from a dashboard or report widget, what its number
 * is (the definition: type, collection, metric, filters, date range, the
 * clicked part, or the custom query) and the records behind it. The API reads
 * the rows through the items service AS THE CALLER — read permission, row
 * filters, User Scopes and field lists bind — so the rows may be fewer than
 * the figure counted (the figure itself is computed as the caller too, but
 * an aggregate never shows a row). Capped; nothing is changed.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type DashboardFilter,
  drillDashboardWidgetRows,
  drillReportWidgetRows,
  type NivaroClient
} from '@nivaro/sdk'
import { z } from 'zod'
import { READ } from '../annotations.js'
import { clipRow } from '../compact.js'
import { fail, ok, refuse } from '../result.js'
import { clampTo, stringList, toList, uuid } from '../schema.js'
import { toFilters } from './dashboards.js'

const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'] as const

export function registerDrillTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'drill_widget',
    {
      title: 'Rows behind a widget',
      description:
        "From a dashboard or Report Studio widget: what its number is (definition — type, collection, metric, filters, date range, the custom query) and the records behind it, read as the key's user (their permissions, row filters and User Scopes bind, so the rows may be fewer than the figure counted). Give widget_id with report_id for a report widget, alone for a dashboard widget (ids from read_dashboard / run_report). segment narrows to one part of the figure: a chart bar ({value} — the dimension value, or a day 'YYYY-MM' / 'YYYY-MM-DD' on a dated chart), or {field, value}. Custom-query widgets answer the rows they computed.",
      inputSchema: {
        widget_id: uuid.describe('The widget id from read_dashboard or run_report.'),
        report_id: uuid
          .optional()
          .describe('The report the widget is on (a Report Studio widget). Omitted = dashboard.'),
        segment: z
          .object({
            field: z
              .string()
              .regex(/^[A-Za-z0-9_]{1,128}$/)
              .optional(),
            value: z.union([z.string(), z.number(), z.boolean(), z.null()])
          })
          .optional()
          .describe(
            'One part of the figure: {value} on the widget dimension, or {field, value}. Dashboard daily charts: {field: "date", value: "YYYY-MM-DD"}.'
          ),
        filters: z
          .union([
            z.array(
              z.object({
                field: z.string().regex(/^[A-Za-z0-9_]{1,128}$/),
                value: z.unknown(),
                op: z.enum(FILTER_OPS).optional()
              })
            ),
            z.string()
          ])
          .optional()
          .describe('Dashboards: the filter bar to apply, [{ field, value, op? }].'),
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
          .describe("Reports: the period (default: the report's saved range)."),
        fields: stringList
          .optional()
          .describe('Columns to return (default: the widget’s own fields and the record label).'),
        limit: z.number().int().optional().describe('Rows (1–100, default 25).')
      },
      annotations: READ
    },
    async ({ widget_id, report_id, segment, filters, date_range, fields, limit }) => {
      let bar: DashboardFilter[] | undefined
      try {
        bar = toFilters(filters)
      } catch (err) {
        return refuse((err as Error).message, 'BAD_FILTERS')
      }
      if (date_range?.preset === 'custom' && (!date_range.start || !date_range.end))
        return refuse('A custom date_range needs start and end (YYYY-MM-DD).', 'BAD_DATE_RANGE')
      if (bar?.length && report_id)
        return refuse('filters is for dashboard widgets; reports take date_range.', 'BAD_INPUT')
      const cols = toList(fields)
      const n = clampTo(limit, 25, 100)
      try {
        const res = report_id
          ? await client.request(
              drillReportWidgetRows(report_id, widget_id, {
                ...(segment ? { segment } : {}),
                ...(date_range ? { date_range } : {}),
                ...(cols ? { fields: cols } : {}),
                limit: n
              })
            )
          : await client.request(
              drillDashboardWidgetRows(widget_id, {
                ...(segment ? { segment } : {}),
                ...(bar ? { extra_filters: bar } : {}),
                ...(cols ? { fields: cols } : {}),
                limit: n
              })
            )
        const d = res.data
        const rows = (d.rows ?? []).map((r) => clipRow(r, 200))
        return ok({
          ...(d.dashboard ? { dashboard: d.dashboard } : {}),
          ...(d.report ? { report: d.report } : {}),
          definition: d.definition,
          collection: d.collection,
          total: d.total,
          shown: rows.length,
          ...(d.capped ? { capped: true } : {}),
          columns: d.columns,
          rows,
          ...(d.filter ? { filter: d.filter } : {}),
          ...(d.note ? { note: d.note } : {}),
          ...(d.capped
            ? {
                next: d.collection
                  ? `More rows: read_items on ${d.collection} with this filter, or a larger limit (max 100).`
                  : 'More rows: a larger limit (max 100).'
              }
            : {})
        })
      } catch (err) {
        return fail(err)
      }
    }
  )
}
