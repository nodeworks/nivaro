import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { evaluateNumeric } from '../lib/expression'

// Generic tabular renderer for custom-query rows (widget slots + page builder).
// Config-driven: column labels/formats, computed formula columns, optional
// client-side group_by aggregation (numeric columns summed per group), and a
// totals footer. Formulas are sanitized arithmetic over {{col}} refs.

export interface QueryTableColumn {
  /** Row key. Omit for pure formula columns. */
  field?: string
  label?: string
  format?: 'currency' | 'number' | 'percent' | 'text'
  /** Arithmetic over {{col}} refs, e.g. '{{carAmount}} - {{allocated}}' or
   *  '{{allocated}} / {{carAmount}} * 100'. Evaluated per row (and over the
   *  totals row for the footer). */
  formula?: string
  /** Include in the totals footer (plain fields sum; formula columns re-run
   *  the formula over the summed values — weighted, not averaged). */
  sum?: boolean
  /** 'progress' renders the value with a bar underneath, filled to
   *  value / progress_max (EFP PUB'd-vs-budget style). Over 100% turns red. */
  display?: 'progress'
  /** Denominator for display 'progress': a row field name or a {{col}} formula. */
  progress_max?: string
  /** Column group label. When any column has one, the header renders two
   *  rows — group cells spanning their children ('Jan' over Fcst/Act) — and
   *  alternating groups get a faint band so wide grids stay scannable. */
  group?: string
  /** Cell text color (any CSS color) — EFP forecast/actual column tinting.
   *  color_dark overrides in dark mode (defaults to color). */
  color?: string
  color_dark?: string
  /** Second field rendered as a stacked line under the main value in the SAME
   *  cell (EFP month cells: Fcst over Act — halves the column count). Toggles
   *  hide individual lines; the column collapses when both lines hide. */
  stack?: string
  stack_color?: string
  stack_color_dark?: string
  /** Sparkline column (#248): mini trend from these row fields, in order
   *  (e.g. the twelve month columns). Renders instead of a value. */
  sparkline_fields?: string[]
  /** Percent-of-total (#249): append this row's share of the column sum. */
  percent_of_total?: boolean
}

export interface QueryTableConfig {
  columns?: QueryTableColumn[]
  /** Group rows by this field, summing every numeric column per group. */
  group_by?: string
  /** Render the totals footer row. */
  totals?: boolean
  /** Collapsible section rows: one header row per distinct value of this
   *  field (per-column sums on the header), child rows listed under it.
   *  Unlike group_by (which REPLACES rows with aggregates), children stay. */
  tree_group_by?: string
  /** Sections start collapsed (default false = expanded). */
  tree_collapsed?: boolean
  /** SECOND tree level inside each section, derived by splitting `field` on
   *  its LAST `separator` (default ' - '): left side = collapsible summed
   *  sub-section (category), right side = the leaf's label (Labor/Materials).
   *  Rows without the separator stay directly under the section. */
  tree_sub_split?: { field: string; separator?: string }
  /** Sub-sections start collapsed (default true). */
  tree_sub_collapsed?: boolean
  /** Leaf rows strip a leading '<section name> - ' from the first column —
   *  de-duplicates labels when the section field is the label's prefix. */
  tree_strip_section_prefix?: boolean
  /** Per-row numeric format override: name of a row field holding
   *  'currency' | 'number' — lets unit-count rows sit alongside dollar rows
   *  (EFP forecasting grid). Falls back to the column format. */
  row_format_field?: string
  /** Pin the first column and the header row while the grid scrolls — wide
   *  month grids keep their row labels in view. */
  sticky?: boolean
  /** Render zeroes as an em dash — de-noises mostly-empty month grids. */
  zero_dash?: boolean
  /** Column show/hide toggle pills above the table (EFP Actuals / Forecasts /
   *  Calendar Year). A toggle turned OFF hides columns matched by exact
   *  `fields` or a field-name `suffix` — unless `hide_when_on` inverts it
   *  (Calendar Year ON hides the Prior/Carryover columns). */
  toggles?: Array<{
    label: string
    fields?: string[]
    suffix?: string
    default_on?: boolean
    hide_when_on?: boolean
  }>
  /** Tint every column of this group (header + cells + totals). The sentinel
   *  '$current_month' resolves to the current month's short label (Jan…Dec).
   *  Pair with highlight_year_param so it only applies on the current year. */
  highlight_group?: string
  /** Widget-layer guard: name of the effective param holding the selected
   *  year — highlight_group is dropped unless it equals the current year. */
  highlight_year_param?: string
  /** Tiny colored line-name legend under stacked-column headers, e.g.
   *  ['Fcst', 'Act'] (EFP listHeaderSubLabel). */
  stack_legend?: [string, string]
  /** Pivot long rows into month columns BEFORE rendering. Rows sharing the
   *  same key fields merge into one row with Jan…Dec (+ optional
   *  prior/later-year buckets and a total) from `value_field`, driven by a
   *  'yyyy-MM' `date_field` and the `year` param/prop. */
  pivot?: {
    date_field: string
    value_field: string
    /** Fields that identify a row (everything else is dropped). */
    key_fields: string[]
    /** Which year's months to expand; other years fold into per-year columns.
     *  Resolved from the widget's effective params when `year_param` set. */
    year?: number
    year_param?: string
    /** Add a Total column summing every pivoted cell. */
    total?: boolean
    /** Render a Months/Quarters toggle above the table (EFP quarterly view).
     *  Quarter columns sum their three months — same drill/total math. */
    quarter_toggle?: boolean
  }
}

const MONTH_KEYS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
]
const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
]

/** Pivot long (key…, 'yyyy-MM', value) rows into one row per key tuple with
 *  month columns for `year`, one folded column per other year, and a total. */
export function pivotQueryRows(
  rows: Array<Record<string, unknown>>,
  pivot: NonNullable<QueryTableConfig['pivot']>,
  resolvedYear: number,
  granularity: 'month' | 'quarter' = 'month'
): { rows: Array<Record<string, unknown>>; columns: QueryTableColumn[] } {
  const byKey = new Map<string, Record<string, unknown>>()
  const otherYears = new Set<string>()
  for (const r of rows) {
    const key = pivot.key_fields.map((f) => String(r[f] ?? '')).join('|')
    let out = byKey.get(key)
    if (!out) {
      out = {}
      for (const f of pivot.key_fields) out[f] = r[f]
      byKey.set(key, out)
    }
    const date = String(r[pivot.date_field] ?? '')
    const m = /^(\d{4})-(\d{2})/.exec(date)
    if (!m) continue
    const val = Number(r[pivot.value_field]) || 0
    if (Number(m[1]) === resolvedYear) {
      const monthIdx = Number(m[2]) - 1
      const mk =
        granularity === 'quarter' ? `q${Math.floor(monthIdx / 3) + 1}` : MONTH_KEYS[monthIdx]
      if (mk) out[mk] = (Number(out[mk]) || 0) + val
    } else {
      otherYears.add(m[1])
      out[`y${m[1]}`] = (Number(out[`y${m[1]}`]) || 0) + val
    }
    if (pivot.total !== false) out.total = (Number(out.total) || 0) + val
  }
  const yearsBefore = [...otherYears].filter((y) => Number(y) < resolvedYear).sort()
  const yearsAfter = [...otherYears].filter((y) => Number(y) > resolvedYear).sort()
  const periodCols: QueryTableColumn[] =
    granularity === 'quarter'
      ? [1, 2, 3, 4].map((q) => ({
          field: `q${q}`,
          label: `Q${q}`,
          format: 'currency' as const,
          sum: true
        }))
      : MONTH_KEYS.map((mk, i) => ({
          field: mk,
          label: MONTH_LABELS[i],
          format: 'currency' as const,
          sum: true
        }))
  const columns: QueryTableColumn[] = [
    ...yearsBefore.map((y) => ({ field: `y${y}`, label: y, format: 'currency' as const, sum: true })),
    ...periodCols,
    ...yearsAfter.map((y) => ({ field: `y${y}`, label: y, format: 'currency' as const, sum: true })),
    ...(pivot.total !== false
      ? [{ field: 'total', label: 'Total', format: 'currency' as const, sum: true }]
      : [])
  ]
  return { rows: [...byKey.values()], columns }
}

/**
 * Column formulas delegate to the shared expression engine (lib/expression.ts).
 *
 * This file used to carry its own recursive-descent arithmetic parser, one of
 * five separate dialects in the codebase. Worse, it still substituted token
 * VALUES into the expression string before parsing, so a value that was not a
 * bare number could change the expression's shape rather than just its inputs.
 * `missing: 'zero'` keeps the behaviour every configured report formula relies
 * on — a column with no value in a row still reads as 0.
 */
function evalRowFormula(formula: string, row: Record<string, unknown>): number | null {
  return evaluateNumeric(formula, row)
}

function fmt(v: unknown, format?: QueryTableColumn['format']): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  switch (format) {
    case 'currency': {
      // EFP's numeral '$0,0[.]00': whole dollars stay whole, cents show as a
      // full pair (never '$128,308.6').
      const whole = Number.isInteger(n)
      return n.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: whole ? 0 : 2,
        maximumFractionDigits: 2
      })
    }
    case 'percent':
      return `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`
    case 'number':
      return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
    default:
      return String(v)
  }
}

function titleize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function QueryTable({
  rows,
  config,
  onRowClick,
  pivotYear,
  rowActions,
  emptyLabel
}: {
  rows: Array<Record<string, unknown>>
  config?: QueryTableConfig
  /** Makes rows clickable (hover highlight); receives the (post-grouping) row. */
  onRowClick?: (row: Record<string, unknown>) => void
  /** Resolved pivot year (from the widget's params) — overrides config.pivot.year. */
  pivotYear?: number
  /** Names the empty state ("No deployments yet") instead of a bare "No data". */
  emptyLabel?: string
  /** Trailing action buttons per row (and on the totals row, receiving null). */
  rowActions?: Array<{ label: string; onClick: (row: Record<string, unknown> | null) => void }>
}) {
  // Sections whose open/closed state the user flipped away from the default.
  const [toggled, setToggled] = useState<Set<string>>(() => new Set())
  const [granularity, setGranularity] = useState<'month' | 'quarter'>('month')
  // Column-visibility toggles the user turned OFF (default_on: false starts off).
  const [togglesOff, setTogglesOff] = useState<Set<string>>(
    () =>
      new Set((config?.toggles ?? []).filter((t) => t.default_on === false).map((t) => t.label))
  )
  if (!rows || rows.length === 0) {
    return (
      <p className='px-1 py-2 text-[12px] italic text-slate-400'>
        {emptyLabel ? `No ${emptyLabel.toLowerCase()} yet` : 'No data'}
      </p>
    )
  }

  // Pivot long month rows into columns when configured.
  let pivotCols: QueryTableColumn[] | null = null
  if (config?.pivot) {
    const year = pivotYear ?? config.pivot.year ?? new Date().getFullYear()
    const res = pivotQueryRows(rows, config.pivot, year, granularity)
    rows = res.rows
    pivotCols = res.columns
  }

  // Group + sum numeric columns when configured.
  let effective = rows
  if (config?.group_by) {
    const key = config.group_by
    const groups = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      const k = String(row[key] ?? '—')
      const agg = groups.get(k)
      if (!agg) {
        groups.set(k, { ...row, [key]: k })
        continue
      }
      for (const [f, v] of Object.entries(row)) {
        if (f === key) continue
        const n = Number(v)
        if (Number.isFinite(n) && typeof v !== 'boolean') {
          agg[f] = (Number(agg[f]) || 0) + n
        }
      }
    }
    effective = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => v)
  }

  const allColumns: QueryTableColumn[] = pivotCols
    ? [
        // Key columns first (configured, else the pivot's key fields), then
        // the generated year/month/total columns.
        ...(config?.columns?.length
          ? config.columns
          : (config?.pivot?.key_fields ?? []).map((f) => ({ field: f }))),
        ...pivotCols
      ]
    : config?.columns && config.columns.length > 0
      ? config.columns
      : Object.keys(effective[0]).map((f) => ({ field: f }))

  // Apply column-visibility toggles: matched FIELDS hide everywhere (headers,
  // cells, totals, tree sums). A stacked column loses just the matched line
  // and only collapses when both of its lines are hidden.
  const hiddenFields = new Set<string>()
  {
    const names: string[] = []
    for (const c of allColumns) {
      if (c.field) names.push(c.field)
      if (c.stack) names.push(c.stack)
    }
    for (const t of config?.toggles ?? []) {
      const isOn = !togglesOff.has(t.label)
      const hiding = t.hide_when_on ? isOn : !isOn
      if (!hiding) continue
      for (const f of names) {
        if (t.fields?.includes(f) || (t.suffix && f.endsWith(t.suffix))) hiddenFields.add(f)
      }
    }
  }
  const columns = allColumns.filter((c) => {
    if (!c.field) return true
    const topHidden = hiddenFields.has(c.field)
    const stackHidden = c.stack ? hiddenFields.has(c.stack) : true
    return !(topHidden && stackHidden)
  })
  const showTop = (c: QueryTableColumn) => !!c.field && !hiddenFields.has(c.field)
  const showStack = (c: QueryTableColumn) => !!c.stack && !hiddenFields.has(c.stack)

  // Group highlight (EFP current-month column): tint + top accent on the
  // matched group's header and cells.
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const highlightGroup =
    config?.highlight_group === '$current_month'
      ? MONTH_SHORT[new Date().getMonth()]
      : (config?.highlight_group ?? null)
  // Match by group, or by label for ungrouped stacked columns (single-row
  // header month grids).
  const isHighlighted = (c: QueryTableColumn) =>
    !!highlightGroup && (c.group === highlightGroup || (!c.group && c.label === highlightGroup))
  const hlCls = (c: QueryTableColumn) =>
    isHighlighted(c) ? 'bg-[#6366f10f] dark:bg-[#a5b4fc12]' : ''

  // Per-column cell color (EFP forecast indigo / actual emerald). Runtime hex
  // rides CSS vars so the dark override stays a static Tailwind class.
  const colorStyle = (c: QueryTableColumn): Record<string, string> | undefined =>
    c.color
      ? ({ '--qtc': c.color, '--qtcd': c.color_dark ?? c.color } as unknown as Record<
          string,
          string
        >)
      : undefined
  const colorCls = (c: QueryTableColumn, fallback: string) =>
    c.color ? 'text-[color:var(--qtc)] dark:text-[color:var(--qtcd)]' : fallback

  const stackStyle = (c: QueryTableColumn): Record<string, string> | undefined =>
    c.stack_color
      ? ({ '--qts': c.stack_color, '--qtsd': c.stack_color_dark ?? c.stack_color } as unknown as Record<string, string>)
      : undefined

  const cellValue = (row: Record<string, unknown>, c: QueryTableColumn): unknown =>
    c.formula ? evalRowFormula(c.formula, row) : c.field ? row[c.field] : null

  // Percent-of-total (#249): per-column sums, computed once per data change.
  const colTotals = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of config?.columns ?? []) {
      if (!c.percent_of_total || !c.field) continue
      m.set(
        c.field,
        rows.reduce((a, r) => a + (Number(r[c.field as string]) || 0), 0)
      )
    }
    return m
  }, [rows, config])

  const progressCell = (row: Record<string, unknown>, c: QueryTableColumn) => {
    const value = Number(cellValue(row, c))
    const max = c.progress_max
      ? c.progress_max.includes('{{')
        ? evalRowFormula(c.progress_max, row)
        : Number(row[c.progress_max])
      : null
    const pct = max && Number.isFinite(max) && max > 0 && Number.isFinite(value)
      ? (value / max) * 100
      : null
    // Single-line: value, thin bar, pct — a stacked bar doubles the row height
    // and made every row ~48px (the "tall table" complaint on budget pages).
    return (
      <div
        className='flex min-w-[130px] items-center justify-end gap-1.5'
        title={
          pct === null
            ? undefined
            : `${pct.toLocaleString('en-US', { maximumFractionDigits: 1 })}% of ${fmt(max, c.format)}`
        }
      >
        <span>{fmt(cellValue(row, c), c.format)}</span>
        <div className='h-1 w-10 shrink-0 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'>
          <div
            className={`h-full rounded-full ${pct !== null && pct > 100 ? 'bg-red-500' : 'bg-[#00ceff]'}`}
            style={{ width: `${pct === null ? 0 : Math.min(pct, 100)}%` }}
          />
        </div>
        <span className='w-9 shrink-0 text-right text-[10px] tabular-nums text-slate-400'>
          {pct === null ? '—' : `${pct.toLocaleString('en-US', { maximumFractionDigits: 0 })}%`}
        </span>
      </div>
    )
  }

  // Totals: sum plain numeric columns, then run formulas over the sums.
  let totals: Record<string, unknown> | null = null
  if (config?.totals) {
    const t: Record<string, unknown> = {}
    const sumField = (f: string) => {
      t[f] = effective.reduce((acc, r) => {
        const n = Number(r[f])
        return Number.isFinite(n) ? acc + n : acc
      }, 0)
    }
    for (const c of columns) {
      if (c.field) sumField(c.field)
      if (c.stack) sumField(c.stack)
    }
    totals = t
  }

  const isNumeric = (c: QueryTableColumn) => c.format && c.format !== 'text'

  const rowFormat = (row: Record<string, unknown>, c: QueryTableColumn) => {
    if (!config?.row_format_field || !isNumeric(c)) return c.format
    const f = row[config.row_format_field]
    return f === 'currency' || f === 'number' ? f : c.format
  }

  // Zero-dash: mostly-empty month grids read far better with — than $0.00.
  const fmtCell = (v: unknown, format?: QueryTableColumn['format']): string =>
    config?.zero_dash && Number(v) === 0 ? '—' : fmt(v, format)

  /** Value-cell body: progress bar, stacked Fcst/Act pair, or plain value. */
  const cellBody = (src: Record<string, unknown>, c: QueryTableColumn): ReactNode => {
    if (c.sparkline_fields?.length) {
      // Sparkline column (#248): a 60×18 polyline over the named row fields.
      const vals = c.sparkline_fields.map((f) => Number(src[f]) || 0)
      const maxV = Math.max(...vals, 1)
      const minV = Math.min(...vals, 0)
      const span = Math.max(maxV - minV, 1)
      const pts = vals
        .map((v, i) => `${(i / Math.max(vals.length - 1, 1)) * 60},${17 - ((v - minV) / span) * 15}`)
        .join(' ')
      return (
        <svg
          viewBox='0 0 60 18'
          className='inline-block h-[18px] w-[60px]'
          data-tip={vals.map((v) => fmt(v, c.format)).join(' · ')}
        >
          <polyline points={pts} fill='none' stroke='#00a5cc' strokeWidth='1.5' vectorEffect='non-scaling-stroke' />
        </svg>
      )
    }
    if (c.percent_of_total && c.field) {
      const v = Number(cellValue(src, c))
      const total = colTotals.get(c.field) ?? 0
      const share = total > 0 && Number.isFinite(v) ? (v / total) * 100 : null
      return (
        <span className='inline-flex items-baseline gap-1'>
          {fmtCell(cellValue(src, c), c.format)}
          {share != null && (
            <span className='text-[9.5px] text-slate-400'>
              {share.toLocaleString('en-US', { maximumFractionDigits: 1 })}%
            </span>
          )}
        </span>
      )
    }
    if (c.display === 'progress') return progressCell(src, c)
    if (c.stack) {
      return (
        <span className='inline-flex flex-col items-end leading-[15px]' style={stackStyle(c)}>
          {showTop(c) && <span>{fmtCell(cellValue(src, c), rowFormat(src, c))}</span>}
          {showStack(c) && (
            <span
              className={`text-[10.5px] ${c.stack_color ? 'text-[color:var(--qts)] dark:text-[color:var(--qtsd)]' : 'text-slate-400'}`}
            >
              {fmtCell(src[c.stack as string], rowFormat(src, c))}
            </span>
          )}
        </span>
      )
    }
    return fmtCell(cellValue(src, c), rowFormat(src, c))
  }

  // Column-group banding: contiguous same-group runs alternate a faint tint so
  // 24-column month grids stay scannable. Ungrouped columns are never banded.
  const hasGroups = columns.some((c) => c.group)
  const bandIndex: number[] = []
  {
    let band = -1
    let prev: string | undefined
    for (const c of columns) {
      if (c.group && c.group !== prev) band++
      bandIndex.push(c.group ? band : -1)
      prev = c.group
    }
  }
  const bandCls = (j: number) =>
    hasGroups && bandIndex[j] >= 0 && bandIndex[j] % 2 === 1
      ? 'bg-slate-50/70 dark:bg-muted/20'
      : ''
  const sticky = !!config?.sticky
  // Right edge on the pinned column so half-scrolled cells don't merge into it.
  const STICKY_EDGE = 'border-r border-slate-200 dark:border-border'
  const stickyFirstCls = (j: number, bg: string) =>
    sticky && j === 0 ? `sticky left-0 z-[1] ${STICKY_EDGE} ${bg}` : ''
  /** Header cells: top-pinned; the first one pins both axes. The pinned
   *  column carries a faint tint so it reads as the row-label rail. */
  const stickyHeaderCls = (j: number) =>
    sticky
      ? j === 0
        ? `sticky left-0 top-0 z-[3] ${STICKY_EDGE} bg-slate-50 dark:bg-muted`
        : 'sticky top-0 z-[2] bg-white dark:bg-card'
      : ''
  /** Pinned-rail padding: the rail itself gets horizontal inset, and the
   *  column right after it stops sitting flush against the rail's border. */
  const afterRailPad = (j: number) => (sticky && (j === 0 || j === 1) ? 'pl-3' : '')

  const renderRow = (
    row: Record<string, unknown>,
    key: string,
    depth: number | boolean = 0,
    firstColOverride?: string
  ) => {
    const d = depth === true ? 1 : depth === false ? 0 : depth
    return (
    <tr
      key={key}
      onClick={onRowClick ? () => onRowClick(row) : undefined}
      // Depth-2 leaves (Labor/Materials under a category) get a faint wash so
      // the nesting reads at a glance: section > sub-section > leaf.
      className={`group/qtr border-b border-slate-100 dark:border-border/50 ${onRowClick ? 'cursor-pointer' : ''} ${
        d >= 2
          ? 'bg-sky-50/70 hover:bg-sky-100/60 dark:bg-sky-500/10 dark:hover:bg-sky-500/15'
          : 'hover:bg-slate-50 dark:hover:bg-muted/40'
      }`}
    >
      {columns.map((c, j) => (
        <td
          key={c.field ?? c.label ?? j}
          className={`whitespace-nowrap py-1.5 pr-3 ${afterRailPad(j)} ${colorCls(c, 'text-slate-700 dark:text-slate-200')} ${isNumeric(c) ? 'text-right tabular-nums' : ''} ${c.group ? 'min-w-[58px]' : ''} ${hlCls(c) || bandCls(j)} ${stickyFirstCls(j, 'bg-slate-50 group-hover/qtr:bg-slate-100 dark:bg-muted dark:group-hover/qtr:bg-muted')}`}
          style={{
            ...(d > 0 && j === 0 ? { paddingLeft: 2 + d * 16 } : {}),
            ...(colorStyle(c) ?? {})
          }}
        >
          {j === 0 && firstColOverride !== undefined ? firstColOverride : cellBody(row, c)}
        </td>
      ))}
      {rowActions && (
        <td className='py-1 pl-2 pr-3 text-right'>
          {/* flex-nowrap + nowrap buttons: wrapped action chips doubled every
              row's height when the actions column got squeezed. */}
          <span className='inline-flex flex-nowrap gap-1'>
            {rowActions.map((a) => (
              <button
                key={a.label}
                type='button'
                onClick={(e) => {
                  e.stopPropagation()
                  a.onClick(row)
                }}
                className='whitespace-nowrap rounded border border-[#00ceff66] bg-[#00ceff1a] px-1.5 py-0.5 text-[11px] text-slate-700 hover:brightness-105 dark:text-slate-200'
              >
                {a.label}
              </button>
            ))}
          </span>
        </td>
      )}
    </tr>
    )
  }

  // Tree sections: header row per distinct tree_group_by value with column
  // sums, child rows underneath, collapse toggling per section.
  let body: ReactNode
  if (config?.tree_group_by) {
    const field = config.tree_group_by
    // Rows with an EMPTY section value render flat, in data order, above the
    // sections (EFP forecasting: Production / Average Cost sit outside the
    // expandable Production Forecast / Workflow Forecast groups).
    const flatRows = effective.filter((row) => !String(row[field] ?? '').trim())
    const sections = new Map<string, Array<Record<string, unknown>>>()
    for (const row of effective) {
      const k = String(row[field] ?? '').trim()
      if (!k) continue
      const list = sections.get(k) ?? []
      list.push(row)
      sections.set(k, list)
    }
    const sectionRows = [...sections.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, children]) => {
        const isCollapsed = config.tree_collapsed ? !toggled.has(name) : toggled.has(name)
        const sums: Record<string, unknown> = { [field]: name }
        const sumInto = (f: string) => {
          sums[f] = children.reduce((s, r) => {
            const n = Number(r[f])
            return Number.isFinite(n) ? s + n : s
          }, 0)
        }
        for (const c of columns) {
          if (c.field && c.field !== field) sumInto(c.field)
          if (c.stack) sumInto(c.stack)
        }
        return (
          <FragmentRows
            key={name}
            header={
              <tr
                className='cursor-pointer border-b border-slate-200 bg-slate-100/80 dark:border-border dark:bg-muted'
                onClick={() =>
                  setToggled((p) => {
                    const n = new Set(p)
                    if (n.has(name)) n.delete(name)
                    else n.add(name)
                    return n
                  })
                }
              >
                {columns.map((c, j) => (
                  <td
                    key={c.field ?? c.label ?? j}
                    className={`whitespace-nowrap py-1.5 pr-3 ${afterRailPad(j)} text-[11.5px] font-semibold ${colorCls(c, 'text-slate-600 dark:text-slate-300')} ${isNumeric(c) ? 'text-right tabular-nums' : ''} ${hlCls(c)} ${sticky && j === 0 ? `sticky left-0 z-[1] ${STICKY_EDGE} bg-slate-100 dark:bg-muted` : ''}`}
                    style={colorStyle(c)}
                  >
                    {j === 0
                      ? `${isCollapsed ? '▸' : '▾'} ${name}`
                      : c.formula
                        ? fmtCell(evalRowFormula(c.formula, sums), c.format)
                        : c.field && c.field !== field && isNumeric(c)
                          ? cellBody(sums, c)
                          : ''}
                  </td>
                ))}
                {rowActions && <td />}
              </tr>
            }
          >
            {!isCollapsed &&
              (() => {
                const split = config.tree_sub_split
                if (!split) {
                  return children.map((row, i) => {
                    let override: string | undefined
                    if (config.tree_strip_section_prefix && columns[0]?.field) {
                      const v = String(row[columns[0].field] ?? '')
                      if (v.startsWith(`${name} - `)) override = v.slice(name.length + 3)
                    }
                    return renderRow(row, `${name}-${i}`, 1, override)
                  })
                }
                // Nested level: split the field on its LAST separator —
                // 'Power Cable - Removal - Labor' → sub 'Power Cable - Removal',
                // leaf 'Labor'. Rows without the separator stay at depth 1.
                const sep = split.separator ?? ' - '
                const flatKids: Array<Record<string, unknown>> = []
                const subs = new Map<string, Array<Record<string, unknown>>>()
                for (const row of children) {
                  const v = String(row[split.field] ?? '')
                  const idx = v.lastIndexOf(sep)
                  if (idx <= 0) {
                    flatKids.push(row)
                    continue
                  }
                  const parent = v.slice(0, idx)
                  const list = subs.get(parent) ?? []
                  list.push(row)
                  subs.set(parent, list)
                }
                return [
                  ...flatKids.map((row, i) => renderRow(row, `${name}-flat-${i}`, 1)),
                  ...[...subs.entries()]
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([sub, kids]) => {
                      const subKey = `s:${name}|${sub}`
                      const subCollapsed =
                        (config.tree_sub_collapsed ?? true)
                          ? !toggled.has(subKey)
                          : toggled.has(subKey)
                      const subSums: Record<string, unknown> = {}
                      const subSum = (f: string) => {
                        subSums[f] = kids.reduce((s, r) => {
                          const n = Number(r[f])
                          return Number.isFinite(n) ? s + n : s
                        }, 0)
                      }
                      for (const c of columns) {
                        if (c.field && c.field !== field) subSum(c.field)
                        if (c.stack) subSum(c.stack)
                      }
                      return (
                        <FragmentRows
                          key={subKey}
                          header={
                            <tr
                              className='cursor-pointer border-b border-slate-200/80 bg-slate-100/70 dark:border-border/60 dark:bg-muted/50'
                              onClick={() =>
                                setToggled((p) => {
                                  const n = new Set(p)
                                  if (n.has(subKey)) n.delete(subKey)
                                  else n.add(subKey)
                                  return n
                                })
                              }
                            >
                              {columns.map((c, j) => (
                                <td
                                  key={c.field ?? c.label ?? j}
                                  className={`whitespace-nowrap py-1.5 pr-3 ${afterRailPad(j)} text-[11.5px] font-medium text-slate-600 dark:text-slate-300 ${isNumeric(c) ? 'text-right tabular-nums' : ''} ${sticky && j === 0 ? `sticky left-0 z-[1] ${STICKY_EDGE} bg-slate-100/80 dark:bg-muted` : ''}`}
                                  style={j === 0 ? { paddingLeft: 18 } : undefined}
                                >
                                  {j === 0
                                    ? `${subCollapsed ? '▸' : '▾'} ${sub}`
                                    : c.formula
                                      ? fmtCell(evalRowFormula(c.formula, subSums), c.format)
                                      : c.field && c.field !== field && isNumeric(c)
                                        ? cellBody(subSums, c)
                                        : ''}
                                </td>
                              ))}
                              {rowActions && <td />}
                            </tr>
                          }
                        >
                          {!subCollapsed &&
                            kids.map((row, i) => {
                              const v = String(row[split.field] ?? '')
                              const leaf = v.slice(v.lastIndexOf(sep) + sep.length)
                              const override =
                                columns[0]?.field === split.field ? leaf : undefined
                              return renderRow(row, `${subKey}-${i}`, 2, override)
                            })}
                        </FragmentRows>
                      )
                    })
                ]
              })()}
          </FragmentRows>
        )
      })
    body = [...flatRows.map((row, i) => renderRow(row, `flat-${i}`)), ...sectionRows]
  } else {
    body = effective.map((row, i) => renderRow(row, String(i)))
  }

  return (
    <div className={sticky ? 'flex min-h-0 flex-1 flex-col' : undefined}>
      {(config?.pivot?.quarter_toggle || (config?.toggles?.length ?? 0) > 0) && (
        <div className='flex shrink-0 items-center justify-between gap-2 pb-2'>
          {(config?.toggles?.length ?? 0) > 0 ? (
            <div className='inline-flex gap-0.5 rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-border dark:bg-muted/40'>
              {config!.toggles!.map((t) => {
                const on = !togglesOff.has(t.label)
                return (
                  <button
                    key={t.label}
                    type='button'
                    aria-pressed={on}
                    onClick={() =>
                      setTogglesOff((p) => {
                        const n = new Set(p)
                        if (n.has(t.label)) n.delete(t.label)
                        else n.add(t.label)
                        return n
                      })
                    }
                    className={`rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                      on
                        ? 'bg-nvr-cyan text-white shadow-sm'
                        : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                    }`}
                  >
                    {t.label}
                  </button>
                )
              })}
            </div>
          ) : (
            <span />
          )}
          {config?.pivot?.quarter_toggle && (
            <div className='inline-flex gap-0.5 rounded-md border border-slate-200 p-0.5 dark:border-border'>
              {(['month', 'quarter'] as const).map((g) => (
                <button
                  key={g}
                  type='button'
                  onClick={() => setGranularity(g)}
                  className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                    granularity === g
                      ? 'bg-[#00ceff1a] text-slate-800 dark:text-slate-100'
                      : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                  }`}
                >
                  {g === 'month' ? 'Monthly' : 'Quarterly'}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className={sticky ? 'min-h-0 flex-1 overflow-auto' : 'overflow-x-auto'}>
      <table className='w-full text-[12px]'>
        <thead>
          {hasGroups ? (
            <>
              <tr>
                {(() => {
                  // Runs of consecutive same-group columns → one spanning cell;
                  // ungrouped columns span both header rows.
                  const cells: ReactNode[] = []
                  let i = 0
                  while (i < columns.length) {
                    const c = columns[i]
                    if (!c.group) {
                      cells.push(
                        <th
                          key={`u-${c.field ?? i}`}
                          rowSpan={2}
                          className={`whitespace-nowrap border-b border-slate-200 py-1.5 pr-3 align-bottom text-[10.5px] font-semibold uppercase tracking-wider text-slate-400 dark:border-border ${isNumeric(c) ? 'text-right' : 'text-left'} ${stickyHeaderCls(i)}`}
                        >
                          {c.label ?? titleize(c.field ?? '')}
                        </th>
                      )
                      i++
                      continue
                    }
                    let span = 1
                    while (i + span < columns.length && columns[i + span].group === c.group) span++
                    cells.push(
                      <th
                        key={`g-${c.group}-${i}`}
                        colSpan={span}
                        className={`whitespace-nowrap border-b border-slate-100 py-1 pr-3 text-center text-[11px] font-semibold dark:border-border/60 ${c.group === highlightGroup ? 'border-t-2 border-t-[#6366f1] bg-[#6366f10f] text-[#4f46e5] dark:border-t-[#a5b4fc] dark:bg-[#a5b4fc12] dark:text-[#a5b4fc]' : `text-slate-600 dark:text-slate-300 ${bandCls(i)}`} ${sticky ? 'sticky top-0 z-[2] bg-white dark:bg-card' : ''}`.trim()}
                      >
                        {c.group}
                      </th>
                    )
                    i += span
                  }
                  return cells
                })()}
                {rowActions && (
                  <th
                    rowSpan={2}
                    aria-label='Actions'
                    className={`border-b border-slate-200 dark:border-border ${sticky ? 'sticky top-0 z-[2] bg-white dark:bg-card' : ''}`}
                  />
                )}
              </tr>
              <tr>
                {columns.map((c, i) =>
                  c.group ? (
                    <th
                      key={c.field ?? c.label ?? i}
                      // min-w keeps dash-only month columns from collapsing to
                      // uneven slivers across the pivot grid
                      className={`min-w-[58px] whitespace-nowrap border-b border-slate-200 py-1 pr-3 ${afterRailPad(i)} text-[11px] font-medium text-slate-400 dark:border-border ${isNumeric(c) ? 'text-right' : 'text-left'} ${hlCls(c) || bandCls(i)} ${sticky ? 'sticky top-[26px] z-[2] bg-white dark:bg-card' : ''}`}
                    >
                      {c.label ?? titleize(c.field ?? '')}
                    </th>
                  ) : null
                )}
              </tr>
            </>
          ) : (
            <tr className='border-b border-slate-200 dark:border-border'>
              {columns.map((c, i) => (
                <th
                  key={c.field ?? c.label ?? i}
                  className={`whitespace-nowrap border-b border-slate-200 py-1.5 pr-3 ${afterRailPad(i)} text-[10.5px] font-semibold uppercase tracking-wider dark:border-border ${
                    isHighlighted(c)
                      ? 'border-t-2 border-t-[#6366f1] bg-[#6366f10f] text-[#4f46e5] dark:border-t-[#a5b4fc] dark:bg-[#a5b4fc12] dark:text-[#a5b4fc]'
                      : 'text-slate-400'
                  } ${c.stack ? 'min-w-[64px]' : ''} ${isNumeric(c) ? 'text-right' : 'text-left'} ${stickyHeaderCls(i)}`}
                >
                  {c.label ?? titleize(c.field ?? '')}
                  {c.stack && config?.stack_legend && (
                    <span
                      className='flex justify-end gap-1.5 text-[9px] font-medium normal-case tracking-normal'
                      style={stackStyle(c) ? { ...stackStyle(c), ...(colorStyle(c) ?? {}) } : colorStyle(c)}
                    >
                      {showTop(c) && (
                        <span className={c.color ? 'text-[color:var(--qtc)] dark:text-[color:var(--qtcd)]' : ''}>
                          {config.stack_legend[0]}
                        </span>
                      )}
                      {showStack(c) && (
                        <span
                          className={c.stack_color ? 'text-[color:var(--qts)] dark:text-[color:var(--qtsd)]' : ''}
                        >
                          {config.stack_legend[1]}
                        </span>
                      )}
                    </span>
                  )}
                </th>
              ))}
              {rowActions && (
                <th
                  aria-label='Actions'
                  className={sticky ? 'sticky top-0 z-[2] bg-white dark:bg-card' : undefined}
                />
              )}
            </tr>
          )}
        </thead>
        <tbody>{body}</tbody>
        {totals && (
          <tfoot>
            <tr className='border-t border-slate-300 font-semibold dark:border-border'>
              {columns.map((c, i) => (
                <td
                  key={c.field ?? c.label ?? i}
                  className={`whitespace-nowrap py-1.5 pr-3 ${afterRailPad(i)} ${colorCls(c, '')} ${isNumeric(c) ? 'text-right tabular-nums' : ''} ${hlCls(c)} ${sticky ? `sticky bottom-0 border-t border-slate-300 dark:border-border ${i === 0 ? `left-0 z-[3] ${STICKY_EDGE} bg-slate-50 dark:bg-muted` : 'z-[2] bg-white dark:bg-card'}` : ''}`}
                  style={colorStyle(c)}
                >
                  {i === 0 && !c.sum && !c.formula
                    ? 'Total'
                    : c.sum || c.formula
                      ? c.formula
                        ? fmtCell(evalRowFormula(c.formula, totals), c.format)
                        : cellBody(totals, c)
                      : ''}
                </td>
              ))}
              {rowActions && (
                <td
                  // Pins with the rest of the totals row — an unpinned actions
                  // cell scrolled away while its row stayed.
                  className={`py-1.5 pr-3 text-right ${sticky ? 'sticky bottom-0 z-[2] border-t border-slate-300 bg-white dark:border-border dark:bg-card' : ''}`}
                >
                  <span className='inline-flex flex-nowrap gap-1.5'>
                    {rowActions.map((a) => (
                      <button
                        key={a.label}
                        type='button'
                        onClick={() => a.onClick(null)}
                        className='whitespace-nowrap rounded border border-[#a13ffb66] bg-[#a13ffb1a] px-1.5 py-0.5 text-[11px] text-slate-700 hover:brightness-105 dark:text-slate-200'
                      >
                        {a.label}
                      </button>
                    ))}
                  </span>
                </td>
              )}
            </tr>
          </tfoot>
        )}
      </table>
      </div>
    </div>
  )
}

/** Key-stable wrapper letting a section render a header row + child rows. */
function FragmentRows({ header, children }: { header: ReactNode; children?: ReactNode }) {
  return (
    <>
      {header}
      {children}
    </>
  )
}
