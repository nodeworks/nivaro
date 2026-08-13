import {
  type ReportColumnFormat,
  type ReportDateRange,
  type ReportDef,
  type ReportEntityFilter,
  type ReportQueryColumn,
  type ReportQueryWidgetConfig,
  type ReportWidget,
  type ReportWidgetData,
  type ReportAlert,
  type ReportAlertLogEntry,
  type ReportFilterPreset,
  aiReportFilters,
  deleteReportFilterPreset,
  createReportAlert,
  deleteReportAlert,
  executeCustomQuery,
  listReportAlerts,
  readItems,
  readReport,
  readReportAlertLog,
  listReportFilterPresets,
  readReportFilterOptions,
  readReportWidgetData,
  resolveReportAlert,
  saveReportFilterPreset,
  toggleReportAlert
} from '@nivaro/sdk'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Check, ChevronsUpDown, Plus, RefreshCw, Trash2, TrendingDown, TrendingUp, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'

// Compact axis ticks — 8-digit dollar values overflow the tight chart margins.
const compactTick = (v: number) =>
  Math.abs(v) >= 1e9 ? `${(v / 1e9).toFixed(1).replace(/\.0$/, '')}B`
  : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`
  : String(v)

// Category-axis ticks for date-heavy charts: '2026-07' → "Jul '26", full dates
// → 'Jul 4'; long plain labels ellipsize. Tooltips keep the raw value.
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const compactCatTick = (v: unknown): string => {
  const raw = String(v ?? '')
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(raw)
  if (m) {
    const mon = MONTH_ABBR[Number(m[2]) - 1] ?? m[2]
    return m[3] ? `${mon} ${Number(m[3])}` : `${mon} '${m[1].slice(2)}`
  }
  return raw.length > 16 ? `${raw.slice(0, 15)}…` : raw
}
// Thin ticks so dense category axes stay legible (~12 labels max) instead of
// smearing every label into an unreadable strip.
const catAxisProps = (count: number) => ({
  interval: count > 12 ? Math.ceil(count / 12) - 1 : 0,
  tickFormatter: compactCatTick,
  minTickGap: 4
})
import {
  type DrilldownTarget,
  useDrilldown,
  useNivaroClient,
  useOverlayState
} from '../context'
import { effectiveScopeSeedIds, matchScopeDimension, translateScopeValues, useMyScopes } from '../lib/use-my-scopes'
import { cn } from '../lib/utils'
import { RecordDrilldownSheet } from './RecordDrilldownSheet'
import { Button } from './ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './ui/command'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { SimpleSelect } from './ui/SimpleSelect'

/**
 * ReportView — the full, styled, interactive Report Studio renderer for
 * headless frontends, matching how QueueWorklist / ItemEditForm ship.
 *
 * Fully Tailwind-styled (bring the styles via `@nivaro/react/full.css` or the
 * Tailwind preset, exactly like the other shared components) and interactive:
 * a global filter bar (date-range switcher + live entity-filter chips), and
 * per-widget freshness + one-click refresh. Every widget resolves as the
 * client identity — collection read permissions apply server-side. Charts use
 * recharts (bundled into the react package). Read-only: no drag/resize edit
 * surface (that lives in the admin builder).
 */

export interface ReportViewProps {
  reportId: string
  /** Show the global filter bar (date range + entity chips). Default true. */
  showFilterBar?: boolean
  /** Override the report's saved date range at view time. */
  dateRange?: ReportDateRange | null
  /** Initial report-level entity filters. */
  initialEntityFilters?: ReportEntityFilter[]
  /** Poll interval (ms) for live refresh; omit for one-shot. */
  refetchInterval?: number
  className?: string
  emptyState?: React.ReactNode
}

type WidgetFormat = { prefix?: string; suffix?: string; decimals?: number }

const CHART_COLORS = ['#00ceff', '#172940', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#64748b']
const DATE_PRESETS: Array<{ id: string; label: string }> = [
  { id: '', label: 'All time' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_30_days', label: 'Last 30 days' },
  { id: 'last_3_months', label: 'Last 3 months' },
  { id: 'last_6_months', label: 'Last 6 months' },
  { id: 'last_12_months', label: 'Last 12 months' },
  { id: 'ytd', label: 'Year to date' }
]

function fmt(v: number | null | undefined, f?: WidgetFormat): string {
  if (v == null) return '—'
  const n =
    f?.decimals != null
      ? v.toLocaleString(undefined, {
          minimumFractionDigits: f.decimals,
          maximumFractionDigits: f.decimals
        })
      : v.toLocaleString()
  return `${f?.prefix ?? ''}${n}${f?.suffix ?? ''}`
}

function Delta({ pct }: { pct?: number | null }) {
  if (pct == null) return null
  const up = pct >= 0
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded px-1 py-px text-[10.5px] font-medium',
        up
          ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
          : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'
      )}
    >
      {up ? <TrendingUp className='h-2.5 w-2.5' /> : <TrendingDown className='h-2.5 w-2.5' />}
      {Math.abs(pct)}%
    </span>
  )
}

// ── Entity filter chip (live multi-select over distinct values) ───────────────

type FilterOptionSource = {
  collection: string
  value_field?: string
  label_field?: string
  sort?: string
}

function FilterChip({
  reportId,
  field,
  label,
  optionSource,
  selected,
  onChange,
  allowedValues
}: {
  reportId: string
  field: string
  label: string
  optionSource?: FilterOptionSource
  selected: Array<string | number>
  onChange: (v: Array<string | number>, labels: string[]) => void
  allowedValues?: Array<string | number>
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const { data: options = [] } = useQuery({
    queryKey: ['nivaro-report-filter-opts', reportId, field, optionSource ?? null],
    queryFn: async () => {
      if (optionSource) {
        const vf = optionSource.value_field ?? 'id'
        const lf = optionSource.label_field ?? vf
        const res = (await client.request(
          readItems(optionSource.collection, {
            fields: [...new Set(['id', vf, lf])],
            sort: optionSource.sort ? [optionSource.sort] : undefined,
            limit: 200
          })
        )) as { data: Array<Record<string, unknown>> }
        return (res.data ?? []).map((r) => ({
          value: String(r[vf] ?? r.id),
          label: String(r[lf] ?? r[vf] ?? r.id)
        }))
      }
      return client
        .request(readReportFilterOptions(reportId, field))
        .then((r) => (r as { data: Array<{ value: string; label: string }> }).data)
    },
    enabled: open,
    staleTime: 120_000
  })
  const visibleOptions = allowedValues?.length
    ? options.filter((o) => allowedValues.some((v) => String(v) === o.value))
    : options
  const active = selected.length > 0
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px]',
            active
              ? 'border-nvr-cyan bg-accent font-medium text-nvr-navy dark:text-nvr-cyan'
              : 'border-slate-200 text-slate-500 hover:border-slate-300 dark:border-border'
          )}
        >
          {label}
          {active && (
            <span className='rounded-full bg-white/60 px-1 text-[10px] dark:bg-black/20'>
              {selected.length}
            </span>
          )}
          <ChevronsUpDown className='h-3 w-3 opacity-50' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command>
          <CommandInput placeholder={`Filter ${label}…`} className='h-8 text-[12.5px]' />
          <CommandList className='max-h-52'>
            <CommandEmpty>No values.</CommandEmpty>
            {visibleOptions.map((o) => {
              const isOn = selected.some((v) => String(v) === o.value)
              return (
                <CommandItem
                  key={o.value}
                  value={o.label}
                  onSelect={() => {
                    const next = isOn
                      ? selected.filter((v) => String(v) !== o.value)
                      : [...selected, o.value]
                    const labelFor = (v: string | number) =>
                      options.find((x) => x.value === String(v))?.label ?? String(v)
                    onChange(next, next.map(labelFor))
                  }}
                  className='text-[12.5px]'
                >
                  <Check className={cn('mr-1.5 h-3 w-3', isOn ? 'opacity-100' : 'opacity-0')} />
                  {o.label}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ── Query widget (custom-query-backed) ───────────────────────────────────────

/** Client-side mirror of the server's date-range presets (query params need concrete dates). */
function resolveRangeDates(range: ReportDateRange | null): { start: string; end: string } | null {
  if (!range) return null
  const now = new Date()
  const iso = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const som = (y: number, m: number) => new Date(y, m, 1)
  const eom = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0)
  switch (range.preset) {
    case 'this_month':
      return { start: iso(som(now.getFullYear(), now.getMonth())), end: iso(eom(now)) }
    case 'last_30_days':
      return { start: iso(new Date(now.getTime() - 30 * 864e5)), end: iso(now) }
    case 'last_3_months':
      return { start: iso(som(now.getFullYear(), now.getMonth() - 3)), end: iso(eom(now)) }
    case 'last_6_months':
      return { start: iso(som(now.getFullYear(), now.getMonth() - 6)), end: iso(eom(now)) }
    case 'last_12_months':
      return { start: iso(som(now.getFullYear(), now.getMonth() - 12)), end: iso(eom(now)) }
    case 'ytd':
      return { start: `${now.getFullYear()}-01-01`, end: iso(now) }
    case 'custom':
      return range.start && range.end ? { start: range.start, end: range.end } : null
    default:
      return null
  }
}

function fmtCell(v: unknown, format?: ReportColumnFormat, decimals?: number): string {
  if (v == null || v === '') return '—'
  if (format === 'date' || format === 'datetime') {
    const d = new Date(String(v))
    if (Number.isNaN(d.getTime())) return String(v)
    const date = d.toLocaleDateString()
    if (format === 'date') return date
    return `${date} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }
  const n = Number(v)
  if (Number.isNaN(n)) return String(v)
  const dp = (min: number, max: number) =>
    n.toLocaleString(undefined, {
      minimumFractionDigits: decimals ?? min,
      maximumFractionDigits: decimals ?? max
    })
  if (format === 'currency') return `$${dp(0, 0)}`
  if (format === 'percent') return `${dp(0, 1)}%`
  if (format === 'days') return `${dp(0, 1)}d`
  if (format === 'integer') return Math.round(n).toLocaleString()
  if (format === 'number') return dp(0, 2)
  return String(v)
}

const NUMERIC_FORMATS: ReadonlySet<string> = new Set([
  'currency',
  'number',
  'integer',
  'percent',
  'days'
])

/**
 * Resolve a query widget's param map. Returns null when a `$filters.` token has
 * no selection AND the param is required to be dropped — unresolved tokens are
 * simply omitted (procs treat missing params as "no filter").
 */
function resolveQueryParams(
  cfg: ReportQueryWidgetConfig,
  dateRange: ReportDateRange | null,
  entityFilters: ReportEntityFilter[]
): Record<string, string> {
  const out: Record<string, string> = {}
  const dr = resolveRangeDates(dateRange)
  for (const [k, raw] of Object.entries(cfg.params ?? {})) {
    if (raw === '$date.start') {
      if (dr) out[k] = dr.start
      continue
    }
    if (raw === '$date.end') {
      if (dr) out[k] = dr.end
      continue
    }
    const m = /^\$filters\.([\w.]+?)(:values)?$/.exec(raw)
    if (m) {
      const f = entityFilters.find((e) => e.field === m[1])
      const vals = m[2] ? f?.values : f?.labels && f.labels.length > 0 ? f.labels : f?.values
      if (vals && vals.length > 0) out[k] = vals.join(',')
      continue
    }
    out[k] = raw
  }
  return out
}

const compactMoney = (v: number) => `$${compactTick(Math.round(v))}`
const DEFAULT_TREE_THRESHOLDS = [
  { gte: 90, color: '#ef4444' },
  { gte: 70, color: '#f59e0b' },
  { gte: -Infinity, color: '#10b981' }
]

interface TreeNode {
  key: string
  label: string
  depth: number
  sums: Record<string, number>
  pct: number
  children: TreeNode[]
  /** leaf only */
  badge?: string
  drillId?: string | number | null
}

function buildTree(
  rows: Array<Record<string, unknown>>,
  cfg: NonNullable<ReportQueryWidgetConfig['tree']>,
  seriesFields: string[]
): TreeNode[] {
  const pctOf = (sums: Record<string, number>) => {
    if (!cfg.pct) return 0
    const den = sums[cfg.pct.den] ?? 0
    return den > 0 ? Math.round(((sums[cfg.pct.num] ?? 0) / den) * 1000) / 10 : 0
  }
  const make = (
    slice: Array<Record<string, unknown>>,
    depth: number,
    prefix: string
  ): TreeNode[] => {
    const field = cfg.levels[depth]
    const last = depth === cfg.levels.length - 1
    const groups = new Map<string, Array<Record<string, unknown>>>()
    for (const r of slice) {
      const k = String(r[field] ?? 'Unknown')
      const g = groups.get(k) ?? []
      g.push(r)
      groups.set(k, g)
    }
    const nodes = [...groups.entries()].map(([label, g]) => {
      const sums: Record<string, number> = {}
      for (const f of seriesFields) sums[f] = g.reduce((a, r) => a + (Number(r[f]) || 0), 0)
      const node: TreeNode = {
        key: `${prefix}/${label}`,
        label,
        depth,
        sums,
        pct: pctOf(sums),
        children: last ? [] : make(g, depth + 1, `${prefix}/${label}`)
      }
      if (last) {
        const row = g[0]
        if (cfg.badge) node.badge = String(row[cfg.badge] ?? '')
        if (cfg.drill) node.drillId = row[cfg.drill.id_field] as string | number | null
      }
      return node
    })
    // EFP ordering: top level alphabetical, deeper levels by first value desc
    if (depth === 0) nodes.sort((a, b) => a.label.localeCompare(b.label))
    else nodes.sort((a, b) => (b.sums[seriesFields[0]] ?? 0) - (a.sums[seriesFields[0]] ?? 0))
    return nodes
  }
  return make(rows, 0, '')
}

function TreeWidget({
  rows,
  cfg,
  onDrill
}: {
  rows: Array<Record<string, unknown>>
  cfg: ReportQueryWidgetConfig
  onDrill: (t: { collection: string; itemId: string; title?: string }) => void
}) {
  const tc = cfg.tree
  const seriesDefs =
    cfg.series && cfg.series.length > 0
      ? cfg.series
      : Object.keys(rows[0] ?? {})
          .filter((k) => typeof rows[0]?.[k] === 'number')
          .slice(0, 3)
          .map((f) => ({ field: f, label: f }))
  const nodes = useMemo(
    () => (tc ? buildTree(rows, tc, seriesDefs.map((sd) => sd.field)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, tc]
  )
  // top-level collapsed by default (EFP), deeper levels expanded
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [seeded, setSeeded] = useState(false)
  useEffect(() => {
    if (seeded || nodes.length === 0) return
    // expand everything EXCEPT depth-0 when there are multiple zones; a single
    // zone auto-expands so the card isn't one lonely collapsed row
    const next = new Set<string>()
    const walk = (ns: TreeNode[]) => {
      for (const n of ns) {
        if (n.depth > 0 || nodes.length === 1) next.add(n.key)
        walk(n.children)
      }
    }
    walk(nodes)
    setExpanded(next)
    setSeeded(true)
  }, [nodes, seeded])

  const thresholds = tc?.thresholds ?? DEFAULT_TREE_THRESHOLDS
  const colorFor = (pct: number) =>
    thresholds.find((t) => pct >= t.gte)?.color ?? '#10b981'

  const renderNode = (n: TreeNode): React.ReactNode => {
    const isLeaf = n.children.length === 0
    const open = expanded.has(n.key)
    const color = colorFor(n.pct)
    const clickable = isLeaf && tc?.drill && n.drillId != null
    return (
      <div key={n.key} style={{ paddingLeft: n.depth === 0 ? 0 : 14 }}>
        <div
          role={clickable || !isLeaf ? 'button' : undefined}
          tabIndex={clickable || !isLeaf ? 0 : undefined}
          className={cn(
            'group/tn rounded-md px-1.5 py-1',
            (clickable || !isLeaf) && 'cursor-pointer hover:bg-slate-50 dark:hover:bg-muted/40'
          )}
          onClick={() => {
            if (!isLeaf) {
              setExpanded((prev) => {
                const next = new Set(prev)
                if (next.has(n.key)) next.delete(n.key)
                else next.add(n.key)
                return next
              })
            } else if (clickable && tc?.drill) {
              onDrill({
                collection: tc.drill.collection,
                itemId: String(n.drillId),
                title: n.label
              })
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') (e.currentTarget as HTMLElement).click()
          }}
        >
          <div className='flex items-center gap-1.5'>
            {!isLeaf ? (
              <ChevronsUpDown
                className={cn('h-3 w-3 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')}
              />
            ) : (
              <span className='w-3 shrink-0' />
            )}
            {isLeaf && n.badge && (
              <span className='shrink-0 rounded bg-slate-100 px-1 py-px text-[9.5px] tabular-nums text-slate-500 dark:bg-muted dark:text-slate-400'>
                {n.badge}
              </span>
            )}
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                n.depth === 0
                  ? 'text-[12px] font-semibold text-slate-800 dark:text-slate-100'
                  : n.depth === 1
                    ? 'text-[11.5px] font-medium text-slate-700 dark:text-slate-200'
                    : cn('text-[11px] text-slate-600 dark:text-slate-300', clickable && 'group-hover/tn:underline')
              )}
            >
              {n.label}
            </span>
            {tc?.pct && (
              <span className='shrink-0 text-[10.5px] font-semibold tabular-nums' style={{ color }}>
                {n.pct.toFixed(1)}%
              </span>
            )}
          </div>
          {tc?.pct && (
            <div
              className={cn(
                'ml-[18px] mt-0.5 overflow-hidden rounded-full bg-slate-100 dark:bg-muted',
                n.depth === 0 ? 'h-[5px]' : n.depth === 1 ? 'h-[3px]' : 'h-[2px]'
              )}
            >
              <div
                className='h-full rounded-full transition-[width] duration-300'
                style={{ width: `${Math.min(n.pct, 100)}%`, background: color }}
              />
            </div>
          )}
          <div className='ml-[18px] mt-0.5 flex flex-wrap gap-x-3 text-[10px] tabular-nums text-slate-400'>
            {seriesDefs.map((sd) => (
              <span key={sd.field}>
                {(sd.label ?? sd.field).slice(0, 14)}{' '}
                <span className='font-medium text-slate-500 dark:text-slate-300'>
                  {cfg.value_format === 'currency'
                    ? compactMoney(n.sums[sd.field] ?? 0)
                    : (n.sums[sd.field] ?? 0).toLocaleString()}
                </span>
              </span>
            ))}
          </div>
        </div>
        {open && n.children.map(renderNode)}
      </div>
    )
  }

  if (!tc || nodes.length === 0)
    return <p className='px-1 text-[12px] text-slate-400'>No data.</p>
  return <div className='min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1'>{nodes.map(renderNode)}</div>
}

export function QueryWidgetBody({
  cfg,
  dateRange,
  entityFilters,
  refetchInterval,
  onStatus,
  onDrill
}: {
  cfg: ReportQueryWidgetConfig
  dateRange: ReportDateRange | null
  entityFilters: ReportEntityFilter[]
  refetchInterval?: number
  onStatus?: (s: { isFetching: boolean; refetch: () => void }) => void
  onDrill?: (t: { collection: string; itemId: string; title?: string }) => void
}) {
  const client = useNivaroClient()
  const params = resolveQueryParams(cfg, dateRange, entityFilters)
  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ['nivaro-report-query', cfg.slug, params],
    queryFn: () =>
      client
        .request(executeCustomQuery(cfg.slug, params))
        .then((r) => ((r as { data: unknown[] }).data ?? []) as Array<Record<string, unknown>>),
    staleTime: 60_000,
    refetchInterval,
    retry: false
  })
  useEffect(() => {
    onStatus?.({ isFetching, refetch: () => void refetch() })
  }, [isFetching]) // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <p className='px-1 text-[12px] text-slate-300'>Loading…</p>
  if (error) {
    const msg =
      (error as { response?: { data?: { error?: string } } }).response?.data?.error ??
      'Query failed'
    return <p className='px-1 text-[12px] text-red-400'>{msg}</p>
  }

  let rows = data ?? []
  if (cfg.group_rows && cfg.x_field) {
    const acc = new Map<string, Record<string, unknown>>()
    const numFields = new Set(
      (cfg.series ?? []).map((s) => s.field).length > 0
        ? (cfg.series ?? []).map((s) => s.field)
        : Object.keys(rows[0] ?? {}).filter((k) => typeof rows[0]?.[k] === 'number')
    )
    for (const r of rows) {
      const key = String(r[cfg.x_field] ?? 'Unknown')
      const cur = acc.get(key) ?? { [cfg.x_field]: key }
      for (const f of numFields) cur[f] = (Number(cur[f]) || 0) + (Number(r[f]) || 0)
      acc.set(key, cur)
    }
    rows = [...acc.values()]
  }
  if (cfg.sort) {
    const desc = cfg.sort.startsWith('-')
    const f = desc ? cfg.sort.slice(1) : cfg.sort
    rows = [...rows].sort((a, b) => {
      const av = a[f]
      const bv = b[f]
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av ?? '').localeCompare(String(bv ?? ''))
      return desc ? -cmp : cmp
    })
  }
  if (cfg.limit && cfg.limit > 0) rows = rows.slice(0, cfg.limit)
  if (rows.length === 0) return <p className='px-1 text-[12px] text-slate-400'>No data.</p>

  const columns: ReportQueryColumn[] =
    cfg.columns && cfg.columns.length > 0
      ? cfg.columns
      : Object.keys(rows[0] ?? {}).map((f) => ({ field: f }))

  if (cfg.display === 'kpis') {
    // x_field set → one tile per row; else one tile per column off row 0.
    const tiles = cfg.x_field
      ? rows.map((r, i) => ({
          label: String(r[cfg.x_field as string] ?? ''),
          value: r[cfg.series?.[0]?.field ?? columns.find((c) => c.field !== cfg.x_field)?.field ?? ''],
          color: cfg.series?.[0]?.color ?? CHART_COLORS[i % CHART_COLORS.length],
          format: cfg.value_format
        }))
      : columns.map((c, i) => ({
          label: c.label ?? c.field,
          value: rows[0]?.[c.field],
          color: CHART_COLORS[i % CHART_COLORS.length],
          format: c.format ?? cfg.value_format
        }))
    return (
      <div
        className='grid gap-2'
        style={{ gridTemplateColumns: `repeat(${Math.min(6, Math.max(1, tiles.length))}, 1fr)` }}
      >
        {tiles.map((t) => (
          <div
            key={t.label}
            className='flex flex-col justify-center rounded-md border border-slate-100 px-3 py-2 dark:border-border/60'
            style={{ borderTopColor: t.color, borderTopWidth: 2 }}
          >
            <p className='truncate text-[10.5px] uppercase tracking-wide text-slate-400'>
              {t.label}
            </p>
            <p className='text-[19px] font-semibold leading-tight text-slate-900 dark:text-foreground'>
              {fmtCell(t.value, t.format ?? 'integer')}
            </p>
          </div>
        ))}
      </div>
    )
  }

  if (cfg.display === 'tree') {
    return <TreeWidget rows={rows} cfg={cfg} onDrill={(t) => onDrill?.(t)} />
  }

  if (cfg.display === 'table') {
    const numericCols = columns.filter((c) => NUMERIC_FORMATS.has(c.format ?? ''))
    return (
      <div className='min-h-0 flex-1 overflow-auto'>
        <table className='w-full text-[11.5px]'>
          <thead className='sticky top-0 z-[1] bg-white dark:bg-card'>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.field}
                  className={cn(
                    'whitespace-nowrap border-b border-slate-100 px-1.5 py-1 text-left font-medium text-slate-400 dark:border-border',
                    NUMERIC_FORMATS.has(c.format ?? '') && 'text-right'
                  )}
                >
                  {c.label ?? c.field}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td
                    key={c.field}
                    className={cn(
                      'max-w-[220px] truncate border-b border-slate-50 px-1.5 py-1 text-slate-700 dark:border-border/40 dark:text-slate-300',
                      NUMERIC_FORMATS.has(c.format ?? '') && 'text-right tabular-nums'
                    )}
                  >
                    {fmtCell(r[c.field], c.format, c.decimals)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {cfg.totals && numericCols.length > 0 && (
            <tfoot className='sticky bottom-0 bg-white dark:bg-card'>
              <tr>
                {columns.map((c, i) => (
                  <td
                    key={c.field}
                    className={cn(
                      'border-t border-slate-200 px-1.5 py-1 font-semibold text-slate-800 dark:border-border dark:text-slate-200',
                      NUMERIC_FORMATS.has(c.format ?? '') && 'text-right tabular-nums'
                    )}
                  >
                    {i === 0 && !NUMERIC_FORMATS.has(c.format ?? '')
                      ? 'Total'
                      : NUMERIC_FORMATS.has(c.format ?? '')
                        ? fmtCell(
                            rows.reduce((a, r) => a + (Number(r[c.field]) || 0), 0),
                            c.format,
                            c.decimals
                          )
                        : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    )
  }

  // Charts — series defs default to every numeric column beyond x_field.
  const xField = cfg.x_field ?? columns[0]?.field ?? ''
  type SeriesDef = { field: string; label?: string; color?: string; dash?: boolean }
  const series: SeriesDef[] =
    cfg.series && cfg.series.length > 0
      ? cfg.series
      : columns
          .filter((c) => c.field !== xField && typeof rows[0]?.[c.field] === 'number')
          .slice(0, 3)
          .map((c) => ({ field: c.field, label: c.label ?? c.field }))
  const chartRows = rows.map((r) => {
    const o: Record<string, unknown> = { [xField]: r[xField] }
    for (const s of series) o[s.field] = Number(r[s.field]) || 0
    return o
  })
  const vFmt = (v: number) =>
    cfg.value_format === 'currency' ? `$${compactTick(v)}` : compactTick(v)
  const tipFmt = (v: number | string) => fmtCell(v, cfg.value_format ?? 'number')
  const horizontal = cfg.display === 'hbar' || (cfg.display === 'stacked_bar' && cfg.horizontal)

  if (cfg.display === 'donut') {
    const s0 = series[0]?.field ?? ''
    const donutData = chartRows.map((r) => ({ dim: String(r[xField]), value: Number(r[s0]) || 0 }))
    const total = donutData.reduce((a, s) => a + s.value, 0)
    return (
      <div className='flex min-h-0 flex-1 items-stretch gap-3'>
        <div className='relative min-h-[110px] min-w-0 flex-1'>
          <ResponsiveContainer width='100%' height='100%'>
            <PieChart>
              <Pie
                data={donutData}
                dataKey='value'
                nameKey='dim'
                innerRadius='58%'
                outerRadius='88%'
                paddingAngle={2}
                strokeWidth={0}
              >
                {donutData.map((s, i) => (
                  <Cell key={s.dim} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v) => tipFmt(v as number)} />
            </PieChart>
          </ResponsiveContainer>
          <div className='pointer-events-none absolute inset-0 flex flex-col items-center justify-center'>
            <span className='text-[17px] font-semibold leading-none text-slate-900 dark:text-foreground'>
              {fmtCell(total, cfg.value_format ?? 'integer')}
            </span>
            <span className='text-[9.5px] text-slate-400'>total</span>
          </div>
        </div>
        <div className='max-h-full w-[40%] shrink-0 space-y-0.5 self-center overflow-y-auto pr-1'>
          {donutData.slice(0, 12).map((s, i) => (
            <div key={s.dim} className='flex items-center gap-1.5 text-[10.5px]'>
              <span
                className='h-2 w-2 shrink-0 rounded-sm'
                style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
              />
              <span className='truncate text-slate-600 dark:text-slate-300'>{s.dim}</span>
              <span className='ml-auto tabular-nums text-slate-400'>{tipFmt(s.value)}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (cfg.display === 'line' || cfg.display === 'area') {
    return (
      <div className='min-h-[110px] min-w-0 flex-1'>
        <ResponsiveContainer width='100%' height='100%'>
          <AreaChart data={chartRows} margin={{ top: 6, right: 8, left: -6, bottom: 0 }}>
            <XAxis
              dataKey={xField}
              tick={{ fontSize: 10 }}
              stroke='#94a3b8'
              {...catAxisProps(chartRows.length)}
            />
            <YAxis tick={{ fontSize: 10 }} stroke='#94a3b8' tickFormatter={vFmt} width={48} />
            <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v) => tipFmt(v as number)} />
            {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
            {series.map((s, i) => (
              <Area
                key={s.field}
                type='monotone'
                dataKey={s.field}
                name={s.label ?? s.field}
                stroke={s.color ?? CHART_COLORS[i % CHART_COLORS.length]}
                strokeWidth={2}
                strokeDasharray={s.dash ? '4 3' : undefined}
                fill={s.color ?? CHART_COLORS[i % CHART_COLORS.length]}
                fillOpacity={cfg.display === 'area' && !s.dash ? 0.12 : 0}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    )
  }

  // bar | hbar | stacked_bar
  const stacked = cfg.display === 'stacked_bar'
  return (
    <div className='min-h-[110px] min-w-0 flex-1'>
      <ResponsiveContainer width='100%' height='100%'>
        <BarChart
          data={chartRows}
          layout={horizontal ? 'vertical' : 'horizontal'}
          margin={{ top: 6, right: 8, left: horizontal ? 30 : -6, bottom: 0 }}
        >
          {horizontal ? (
            <>
              <XAxis
                type='number'
                tick={{ fontSize: 10 }}
                stroke='#94a3b8'
                tickFormatter={vFmt}
              />
              <YAxis
                type='category'
                dataKey={xField}
                tick={{ fontSize: 10 }}
                stroke='#94a3b8'
                width={120}
              />
            </>
          ) : (
            <>
              <XAxis
                dataKey={xField}
                tick={{ fontSize: 10 }}
                stroke='#94a3b8'
                {...catAxisProps(chartRows.length)}
              />
              <YAxis tick={{ fontSize: 10 }} stroke='#94a3b8' tickFormatter={vFmt} width={48} />
            </>
          )}
          <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v) => tipFmt(v as number)} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
          {series.map((s, i) => (
            <Bar
              key={s.field}
              dataKey={s.field}
              name={s.label ?? s.field}
              stackId={stacked ? 'stack' : undefined}
              fill={s.color ?? CHART_COLORS[i % CHART_COLORS.length]}
              radius={stacked ? 0 : horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]}
            >
              {series.length === 1 &&
                !s.color &&
                chartRows.map((_, ci) => (
                  <Cell key={ci} fill={CHART_COLORS[ci % CHART_COLORS.length]} />
                ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Per-widget alert bell (create + manage alerts on this widget) ────────────

const ALERT_OPS = ['gt', 'gte', 'lt', 'lte', 'eq'] as const
const OP_GLYPH: Record<string, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' }
const AGGS = ['sum', 'avg', 'max', 'min'] as const

export interface AlertFieldOption {
  value: string
  label: string
  /** Column fields support an aggregation picker; value/row_count/tile don't. */
  aggregatable?: boolean
}

/** Derive the alertable metric fields for a widget from its config. */
function alertFieldOptions(widget: ReportWidget): AlertFieldOption[] {
  const base: AlertFieldOption[] = [
    { value: 'value', label: 'Value (widget metric)' },
    { value: 'row_count', label: 'Row count' }
  ]
  const qc = widget.config?.query
  if (widget.type === 'query' && qc) {
    const cols =
      qc.columns && qc.columns.length > 0
        ? qc.columns.map((c) => ({ value: c.field, label: c.label ?? c.field, aggregatable: true }))
        : (qc.series ?? []).map((sd) => ({
            value: sd.field,
            label: sd.label ?? sd.field,
            aggregatable: true
          }))
    return [...base, ...cols]
  }
  if (widget.type === 'kpi_group') {
    return [
      ...base,
      ...(widget.config?.metrics ?? []).map((m) => ({
        value: `tile:${m.label}`,
        label: `Tile: ${m.label}`
      }))
    ]
  }
  if (widget.type === 'table') {
    const cols = (widget.config?.columns ?? [])
      .map((c) => (typeof c === 'string' ? { field: c } : c))
      .map((c) => ({ value: c.field, label: c.label ?? c.field, aggregatable: true }))
    return [...base, ...cols]
  }
  return base
}

function condSummary(c: { field: string; op: string; value: number }, opts: AlertFieldOption[]) {
  const m = /^(sum|avg|max|min|tile):(.+)$/.exec(c.field)
  const bare = m ? m[2] : c.field
  const label = opts.find((o) => o.value === c.field || o.value === bare)?.label ?? bare
  const agg = m && m[1] !== 'sum' && m[1] !== 'tile' ? `${m[1]} ` : ''
  return `${agg}${label} ${OP_GLYPH[c.op] ?? c.op} ${c.value.toLocaleString()}`
}

type DraftCond = { field: string; agg: (typeof AGGS)[number]; op: (typeof ALERT_OPS)[number]; value: string }

function AlertLogList({ reportId, alert }: { reportId: string; alert: ReportAlert }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data: log = [] } = useQuery({
    queryKey: ['nivaro-report-alert-log', reportId, alert.id],
    queryFn: () =>
      client
        .request(readReportAlertLog(reportId, alert.id))
        .then((r) => (r as { data: ReportAlertLogEntry[] }).data),
    staleTime: 30_000
  })
  const resolve = useMutation({
    mutationFn: () => client.request(resolveReportAlert(reportId, alert.id)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nivaro-report-alert-log', reportId, alert.id] })
      void qc.invalidateQueries({ queryKey: ['nivaro-report-alerts', reportId] })
    }
  })
  if (log.length === 0)
    return <p className='px-1 py-1 text-[10.5px] text-slate-400'>Never fired.</p>
  return (
    <div className='max-h-36 space-y-1 overflow-y-auto py-1'>
      {log.slice(0, 20).map((e) => (
        <div key={e.id} className='flex items-center gap-1.5 text-[10.5px]'>
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              e.status === 'firing' ? 'bg-amber-500' : 'bg-emerald-500'
            )}
          />
          <span className={cn(e.status === 'firing' ? 'text-amber-600' : 'text-slate-500')}>
            {e.status === 'firing' ? 'Firing' : 'Resolved'}
          </span>
          <span className='min-w-0 flex-1 truncate text-slate-400'>
            {new Date(e.fired_at).toLocaleString()}
            {e.resolved_at ? ` → ${new Date(e.resolved_at).toLocaleString()}` : ''}
          </span>
          {e.status === 'firing' && (
            <button
              type='button'
              className='shrink-0 text-[10px] text-slate-400 underline hover:text-emerald-600'
              onClick={() => resolve.mutate()}
            >
              Mark resolved
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export function AlertBell({
  reportId,
  widget,
  filterBar
}: {
  reportId: string
  widget: ReportWidget
  filterBar: Array<{ field: string; label: string; options?: FilterOptionSource }>
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [conds, setConds] = useState<DraftCond[]>([
    { field: 'value', agg: 'sum', op: 'gt', value: '' }
  ])
  const [scope, setScope] = useState<ReportEntityFilter[]>([])
  const [email, setEmail] = useState(false)
  const [historyFor, setHistoryFor] = useState<string | null>(null)

  const fieldOpts = alertFieldOptions(widget)

  const { data: alerts = [] } = useQuery({
    queryKey: ['nivaro-report-alerts', reportId],
    queryFn: () =>
      client.request(listReportAlerts(reportId)).then((r) => (r as { data: ReportAlert[] }).data),
    enabled: open,
    staleTime: 30_000
  })
  const mine = alerts.filter((a) => a.widget === widget.id)
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['nivaro-report-alerts', reportId] })

  const toConditions = () =>
    conds
      .filter((c) => c.value.trim() !== '' && !Number.isNaN(Number(c.value)))
      .map((c) => {
        const opt = fieldOpts.find((o) => o.value === c.field)
        const field = opt?.aggregatable && c.agg !== 'sum' ? `${c.agg}:${c.field}` : c.field
        return { field, op: c.op, value: Number(c.value) }
      })

  const create = useMutation({
    mutationFn: () => {
      const conditions = toConditions()
      const summary = conditions.map((c) => condSummary(c, fieldOpts)).join(' & ')
      return client.request(
        createReportAlert(reportId, {
          widget: widget.id,
          name: name.trim() || summary.slice(0, 120),
          conditions,
          filters: scope.filter((f) => f.values.length > 0),
          delivery_email: email,
          delivery_inapp: true
        })
      )
    },
    onSuccess: () => {
      setName('')
      setConds([{ field: 'value', agg: 'sum', op: 'gt', value: '' }])
      setScope([])
      invalidate()
    }
  })
  const toggle = useMutation({
    mutationFn: (a: ReportAlert) => client.request(toggleReportAlert(reportId, a.id, !a.is_active)),
    onSuccess: invalidate
  })
  const remove = useMutation({
    mutationFn: (a: ReportAlert) => client.request(deleteReportAlert(reportId, a.id)),
    onSuccess: invalidate
  })

  const valid = toConditions().length > 0
  const anyFiring = mine.some((a) => a.firing)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          title='Alerts on this widget'
          className={cn(
            'rounded p-0.5',
            anyFiring
              ? 'text-amber-500'
              : 'text-slate-300 hover:text-amber-500 dark:text-slate-600'
          )}
        >
          <Bell className='h-3 w-3' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[380px] p-3' align='end'>
        <p className='mb-2 text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
          Alerts · {widget.title}
        </p>

        {mine.length > 0 && (
          <div className='mb-2 space-y-1.5'>
            {mine.map((a) => (
              <div key={a.id} className='rounded-md border border-slate-100 px-2 py-1.5 dark:border-border/60'>
                <div className='flex items-center gap-1.5 text-[11.5px]'>
                  <span
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      a.firing ? 'bg-amber-500' : a.is_active ? 'bg-emerald-500' : 'bg-slate-300'
                    )}
                  />
                  <span className='min-w-0 flex-1 truncate font-medium text-slate-700 dark:text-slate-200'>
                    {a.name}
                  </span>
                  <button
                    type='button'
                    className='text-[10.5px] text-slate-400 hover:text-slate-600'
                    onClick={() => setHistoryFor(historyFor === a.id ? null : a.id)}
                  >
                    History
                  </button>
                  <button
                    type='button'
                    className='text-[10.5px] text-slate-400 hover:text-slate-600'
                    onClick={() => toggle.mutate(a)}
                  >
                    {a.is_active ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    type='button'
                    className='text-slate-300 hover:text-red-500'
                    onClick={() => remove.mutate(a)}
                  >
                    <Trash2 className='h-3 w-3' />
                  </button>
                </div>
                <p className='mt-0.5 truncate pl-3 text-[10.5px] text-slate-400'>
                  {(a.conditions ?? []).map((c) => condSummary(c, fieldOpts)).join(' & ')}
                  {a.filters && a.filters.length > 0 &&
                    ` · scoped: ${a.filters.map((f) => (f.labels ?? f.values).join('/')).join(', ')}`}
                  {' · '}
                  {a.delivery_email ? 'In-app + Email' : 'In-app'}
                  {' · Last fired: '}
                  {a.last_fired ? new Date(a.last_fired).toLocaleString() : 'Never'}
                </p>
                {historyFor === a.id && <AlertLogList reportId={reportId} alert={a} />}
              </div>
            ))}
          </div>
        )}

        <div className='space-y-1.5 border-t border-slate-100 pt-2 dark:border-border'>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='Alert name (optional)'
            className='h-7 w-full rounded-md border border-slate-200 bg-white px-2 text-[11.5px] dark:border-border dark:bg-card'
          />
          {conds.map((c, i) => {
            const opt = fieldOpts.find((o) => o.value === c.field)
            return (
              <div key={i} className='flex items-center gap-1'>
                <SimpleSelect
                  value={c.field}
                  onChange={(v) =>
                    setConds((p) => p.map((x, j) => (j === i ? { ...x, field: v } : x)))
                  }
                  options={fieldOpts.map((o) => ({ value: o.value, label: o.label }))}
                  ariaLabel='Alert metric field'
                  className='h-7 min-w-0 flex-1 rounded-md px-1.5 py-0 text-[11.5px] dark:border-border dark:bg-card'
                />
                {opt?.aggregatable && (
                  <SimpleSelect
                    value={c.agg}
                    onChange={(v) =>
                      setConds((p) =>
                        p.map((x, j) => (j === i ? { ...x, agg: v as DraftCond['agg'] } : x))
                      )
                    }
                    options={AGGS.map((g) => ({ value: g, label: g }))}
                    ariaLabel='Aggregate'
                    className='h-7 w-[62px] rounded-md px-1.5 py-0 text-[11.5px] dark:border-border dark:bg-card'
                  />
                )}
                <SimpleSelect
                  value={c.op}
                  onChange={(v) =>
                    setConds((p) =>
                      p.map((x, j) => (j === i ? { ...x, op: v as DraftCond['op'] } : x))
                    )
                  }
                  options={ALERT_OPS.map((o) => ({ value: o, label: OP_GLYPH[o] }))}
                  ariaLabel='Operator'
                  className='h-7 w-[52px] rounded-md px-1.5 py-0 text-[11.5px] dark:border-border dark:bg-card'
                />
                <input
                  value={c.value}
                  onChange={(e) =>
                    setConds((p) => p.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                  }
                  placeholder='0'
                  inputMode='decimal'
                  className='h-7 w-[64px] rounded-md border border-slate-200 bg-white px-2 text-right text-[11.5px] tabular-nums dark:border-border dark:bg-card'
                />
                {conds.length > 1 && (
                  <button
                    type='button'
                    className='text-slate-300 hover:text-red-500'
                    onClick={() => setConds((p) => p.filter((_, j) => j !== i))}
                  >
                    <X className='h-3 w-3' />
                  </button>
                )}
              </div>
            )
          })}
          <button
            type='button'
            className='text-[10.5px] text-slate-400 hover:text-nvr-navy dark:hover:text-nvr-cyan'
            onClick={() => setConds((p) => [...p, { field: 'value', agg: 'sum', op: 'gt', value: '' }])}
          >
            + condition (all must match)
          </button>

          {filterBar.length > 0 && (
            <div>
              <p className='mb-1 text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
                Alert scope (optional)
              </p>
              <div className='flex flex-wrap gap-1'>
                {filterBar.map((f) => (
                  <FilterChip
                    key={f.field}
                    reportId={reportId}
                    field={f.field}
                    label={f.label}
                    optionSource={f.options}
                    selected={scope.find((e) => e.field === f.field)?.values ?? []}
                    onChange={(values, labels) =>
                      setScope((prev) => [
                        ...prev.filter((e) => e.field !== f.field),
                        ...(values.length > 0 ? [{ field: f.field, values, labels }] : [])
                      ])
                    }
                  />
                ))}
              </div>
            </div>
          )}

          <div className='flex items-center justify-between'>
            <label className='flex items-center gap-1.5 text-[11px] text-slate-500'>
              <input
                type='checkbox'
                checked={email}
                onChange={(e) => setEmail(e.target.checked)}
                className='h-3 w-3 accent-[#00ceff]'
              />
              Also email me
            </label>
            <button
              type='button'
              disabled={!valid || create.isPending}
              onClick={() => create.mutate()}
              className='inline-flex h-7 items-center gap-1 rounded-md bg-nvr-cyan px-2 text-[11.5px] font-semibold text-white disabled:opacity-50'
            >
              <Plus className='h-3 w-3' /> Add alert
            </button>
          </div>
          <p className='text-[10px] leading-snug text-slate-400'>
            Checked hourly in your alert scope (unscoped = whole report data). Fires once, then
            resolves when back in range.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ── Widget card ───────────────────────────────────────────────────────────────

const WidgetCard = memo(function WidgetCard({
  reportId,
  widget,
  dateRange,
  entityFilters,
  refetchInterval,
  filterBar = [],
  onDrill
}: {
  reportId: string
  widget: ReportWidget
  dateRange: ReportDateRange | null
  entityFilters: ReportEntityFilter[]
  refetchInterval?: number
  filterBar?: Array<{ field: string; label: string; options?: FilterOptionSource }>
  onDrill?: (t: { collection: string; itemId: string; title?: string }) => void
}) {
  const client = useNivaroClient()
  const { data, isLoading, error, refetch, isFetching } = useQuery<ReportWidgetData>({
    queryKey: ['nivaro-report-widget', reportId, widget.id, dateRange, entityFilters],
    queryFn: () =>
      client
        .request(
          readReportWidgetData(reportId, widget.id, {
            date_range: dateRange,
            entity_filters: entityFilters
          })
        )
        .then((r) => (r as { data: ReportWidgetData }).data),
    enabled: widget.type !== 'divider' && widget.type !== 'query',
    staleTime: 60_000,
    refetchInterval,
    retry: false
  })

  const format = widget.config?.format as WidgetFormat | undefined
  // Reproduce the builder's 12-col × 72px-row placement exactly.
  const gridStyle: React.CSSProperties = {
    gridColumn: `${Math.max(1, (widget.x ?? 0) + 1)} / span ${Math.min(12, Math.max(2, widget.w || 4))}`,
    gridRow: `span ${Math.max(1, widget.h || 3)}`
  }

  if (widget.type === 'divider') {
    return (
      <div style={gridStyle} className='self-end border-b border-slate-200 pb-1 dark:border-border'>
        <h3 className='text-[13px] font-semibold text-slate-700 dark:text-slate-200'>
          {widget.title}
        </h3>
      </div>
    )
  }

  const queryCfg = widget.type === 'query' ? widget.config?.query : null

  let body: React.ReactNode = null
  if (queryCfg?.slug) {
    body = (
      <QueryWidgetBody
        cfg={queryCfg}
        dateRange={dateRange}
        entityFilters={entityFilters}
        refetchInterval={refetchInterval}
        onDrill={onDrill}
      />
    )
  } else if (widget.type === 'query') {
    body = <p className='px-1 text-[12px] text-slate-400'>No query configured.</p>
  } else if (isLoading) body = <p className='px-1 text-[12px] text-slate-300'>Loading…</p>
  else if (error) {
    const msg =
      (error as { response?: { data?: { error?: string } } }).response?.data?.error ??
      'Failed to load'
    body = <p className='px-1 text-[12px] text-red-400'>{msg}</p>
  } else if (data) {
    if (widget.type === 'kpi') {
      body = (
        <div className='flex items-baseline gap-2'>
          <p className='text-[28px] font-semibold leading-none tracking-tight text-slate-900 dark:text-foreground'>
            {fmt(data.value, format)}
          </p>
          <Delta pct={data.change_pct} />
        </div>
      )
    } else if (widget.type === 'kpi_group') {
      const tiles = data.tiles ?? []
      body = (
        <div
          className='grid gap-2'
          style={{ gridTemplateColumns: `repeat(${Math.max(1, tiles.length)}, 1fr)` }}
        >
          {tiles.map((t, i) => (
            <div
              key={t.label}
              className='flex flex-col justify-center rounded-md border border-slate-100 px-3 py-2 dark:border-border/60'
              style={{ borderTopColor: t.color ?? CHART_COLORS[i % CHART_COLORS.length], borderTopWidth: 2 }}
            >
              <p className='truncate text-[10.5px] uppercase tracking-wide text-slate-400'>
                {t.label}
              </p>
              <div className='flex items-baseline gap-1.5'>
                <p className='text-[19px] font-semibold leading-tight text-slate-900 dark:text-foreground'>
                  {fmt(t.value, t.format)}
                </p>
                <Delta pct={t.change_pct} />
              </div>
            </div>
          ))}
        </div>
      )
    } else if (widget.type === 'table') {
      const rows = data.rows ?? []
      const colDefs: ReportQueryColumn[] =
        widget.config?.columns && widget.config.columns.length > 0
          ? widget.config.columns.map((c) => (typeof c === 'string' ? { field: c } : c))
          : rows[0]
            ? Object.keys(rows[0])
                .filter((c) => c !== 'id')
                .map((f) => ({ field: f }))
            : []
      const cols = colDefs.map((c) => c.field)
      const defFor = (f: string) => colDefs.find((c) => c.field === f)
      body =
        rows.length === 0 ? (
          <p className='px-1 text-[12px] text-slate-400'>No rows.</p>
        ) : (
          <div className='min-h-0 flex-1 overflow-auto'>
            <table className='w-full text-[11.5px]'>
              <thead className='sticky top-0 bg-white dark:bg-card'>
                <tr>
                  {cols.map((c) => (
                    <th
                      key={c}
                      className='border-b border-slate-100 px-1.5 py-1 text-left font-medium text-slate-400 dark:border-border'
                    >
                      {defFor(c)?.label ?? c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.id)}>
                    {cols.map((c) => (
                      <td
                        key={c}
                        className={cn(
                          'max-w-[180px] truncate border-b border-slate-50 px-1.5 py-1 text-slate-700 dark:border-border/40 dark:text-slate-300',
                          (typeof r[c] === 'number' || NUMERIC_FORMATS.has(defFor(c)?.format ?? '')) &&
                            'text-right tabular-nums'
                        )}
                      >
                        {defFor(c)?.format ? fmtCell(r[c], defFor(c)?.format, defFor(c)?.decimals) : String(r[c] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
    } else {
      const series = data.series ?? []
      if (series.length === 0) body = <p className='px-1 text-[12px] text-slate-400'>No data.</p>
      else if (widget.type === 'donut') {
        const total = series.reduce((a, s) => a + s.value, 0)
        body = (
          <div className='flex min-h-0 flex-1 items-stretch gap-3'>
            <div className='relative min-h-[110px] min-w-0 flex-1'>
              <ResponsiveContainer width='100%' height='100%'>
                <PieChart>
                  <Pie
                    data={series}
                    dataKey='value'
                    nameKey='dim'
                    innerRadius='58%'
                    outerRadius='88%'
                    paddingAngle={2}
                    strokeWidth={0}
                  >
                    {series.map((s, i) => (
                      <Cell key={s.dim} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className='pointer-events-none absolute inset-0 flex flex-col items-center justify-center'>
                <span className='text-[17px] font-semibold leading-none text-slate-900 dark:text-foreground'>
                  {total.toLocaleString()}
                </span>
                <span className='text-[9.5px] text-slate-400'>total</span>
              </div>
            </div>
            <div className='max-h-full w-[40%] shrink-0 space-y-0.5 self-center overflow-y-auto pr-1'>
              {series.slice(0, 10).map((s, i) => (
                <div key={s.dim} className='flex items-center gap-1.5 text-[10.5px]'>
                  <span
                    className='h-2 w-2 shrink-0 rounded-sm'
                    style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
                  />
                  <span className='truncate text-slate-600 dark:text-slate-300'>{s.dim}</span>
                  <span className='ml-auto tabular-nums text-slate-400'>
                    {s.value.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )
      } else if (widget.type === 'line') {
        body = (
          <div className='min-h-[110px] flex-1'>
            <ResponsiveContainer width='100%' height='100%'>
              <LineChart data={series} margin={{ top: 6, right: 8, left: -10, bottom: 0 }}>
                <XAxis
                  dataKey='dim'
                  tick={{ fontSize: 10 }}
                  stroke='#94a3b8'
                  {...catAxisProps(series.length)}
                />
                <YAxis tick={{ fontSize: 10 }} stroke='#94a3b8' tickFormatter={compactTick} width={44} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                {widget.config?.compare && (
                  <Line
                    type='monotone'
                    dataKey='prev'
                    stroke='#94a3b8'
                    strokeWidth={1.5}
                    strokeDasharray='4 3'
                    dot={false}
                    name='previous'
                  />
                )}
                <Line
                  type='monotone'
                  dataKey='value'
                  stroke='#00ceff'
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )
      } else {
        const horizontal = widget.config?.orientation === 'horizontal'
        body = (
          <div className='min-h-[110px] flex-1'>
            <ResponsiveContainer width='100%' height='100%'>
              <BarChart
                data={series}
                layout={horizontal ? 'vertical' : 'horizontal'}
                margin={{ top: 6, right: 8, left: horizontal ? 30 : -10, bottom: 0 }}
              >
                {horizontal ? (
                  <>
                    <XAxis type='number' tick={{ fontSize: 10 }} stroke='#94a3b8' />
                    <YAxis
                      type='category'
                      dataKey='dim'
                      tick={{ fontSize: 10 }}
                      stroke='#94a3b8'
                      width={90}
                    />
                  </>
                ) : (
                  <>
                    <XAxis
                      dataKey='dim'
                      tick={{ fontSize: 10 }}
                      stroke='#94a3b8'
                      {...catAxisProps(series.length)}
                    />
                    <YAxis tick={{ fontSize: 10 }} stroke='#94a3b8' tickFormatter={compactTick} width={44} />
                  </>
                )}
                <Tooltip contentStyle={{ fontSize: 12 }} />
                {widget.config?.compare && (
                  <Bar dataKey='prev' fill='#cbd5e1' radius={[3, 3, 0, 0]} name='previous' />
                )}
                <Bar dataKey='value' fill='#00ceff' radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )
      }
    }
  }

  return (
    <div
      className='flex min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
      style={gridStyle}
    >
      <div className='mb-1.5 flex items-center gap-1.5'>
        <p className='truncate text-[11.5px] font-medium uppercase tracking-wide text-slate-400'>
          {widget.title}
        </p>
        <span className='ml-auto flex items-center gap-0.5'>
          <AlertBell reportId={reportId} widget={widget} filterBar={filterBar} />
          <button
            type='button'
            title='Refresh'
            className='rounded p-0.5 text-slate-300 hover:text-slate-500'
            onClick={() => refetch()}
          >
            <RefreshCw className={cn('h-3 w-3', isFetching && 'animate-spin')} />
          </button>
        </span>
      </div>
      <div className='flex min-h-0 flex-1 flex-col'>{body}</div>
    </div>
  )
})

// ── ReportView ────────────────────────────────────────────────────────────────

export function ReportView({
  reportId,
  showFilterBar = true,
  dateRange,
  initialEntityFilters = [],
  refetchInterval,
  className,
  emptyState
}: ReportViewProps) {
  const client = useNivaroClient()
  const outerDrill = useDrilldown()
  // The drill stack lives in the host's overlay history when one is provided,
  // so the browser's Back button steps down a level instead of abandoning the
  // report behind the sheet. Without a host adapter this is plain state and
  // behaves exactly as it did.
  const drill = useOverlayState<DrilldownTarget[]>('drill.report')
  const drillStack = drill.value
  const openDrill = useCallback(
    (t: { collection: string; itemId: string; title?: string }) =>
      outerDrill ? outerDrill.open(t) : drill.push([t]),
    [outerDrill, drill.push]
  )
  // Applied state drives the widget queries; draft state is what the bar edits
  // until Apply is pressed (EFP GlobalFilterBar model).
  const [localRange, setLocalRange] = useState<ReportDateRange | null | undefined>(undefined)
  const [entityFilters, setEntityFilters] = useState<ReportEntityFilter[]>(initialEntityFilters)
  const [draftRange, setDraftRange] = useState<ReportDateRange | null | undefined>(undefined)
  const [draftFilters, setDraftFilters] = useState<ReportEntityFilter[]>(initialEntityFilters)
  // User Scopes: defaults seed the chips once; restricted values narrow options
  const { scopes: myScopes, ready: scopesReady } = useMyScopes()
  // Widgets render behind this gate so their first fetch already carries the
  // seeded default filters (no unfiltered flash-load + refetch).
  const [scopeGateOpen, setScopeGateOpen] = useState(false)
  const [scopeAllowed, setScopeAllowed] = useState<Record<string, Array<string | number>>>({})
  const qc = useQueryClient()
  const { data: presets = [] } = useQuery({
    queryKey: ['nivaro-report-presets', reportId],
    queryFn: async () => {
      // one-time migration of pre-server localStorage presets
      try {
        const legacy = JSON.parse(localStorage.getItem(`nvr-report-presets:${reportId}`) ?? '[]')
        if (Array.isArray(legacy) && legacy.length > 0) {
          for (const lp of legacy) {
            if (lp?.name) {
              await client
                .request(
                  saveReportFilterPreset(reportId, {
                    name: String(lp.name),
                    date_range: lp.date_range ?? null,
                    entity_filters: lp.entity_filters ?? []
                  })
                )
                .catch(() => {})
            }
          }
          localStorage.removeItem(`nvr-report-presets:${reportId}`)
        }
      } catch {
        /* legacy migration is best-effort */
      }
      return client
        .request(listReportFilterPresets(reportId))
        .then((r) => (r as { data: ReportFilterPreset[] }).data)
    },
    staleTime: 60_000
  })
  const invalidatePresets = () =>
    void qc.invalidateQueries({ queryKey: ['nivaro-report-presets', reportId] })
  const savePreset = useMutation({
    mutationFn: (name: string) =>
      client.request(
        saveReportFilterPreset(reportId, {
          name,
          date_range: effectiveRangeRef.current ?? null,
          entity_filters: entityFiltersRef.current
        })
      ),
    onSuccess: invalidatePresets
  })
  const removePreset = useMutation({
    mutationFn: (presetId: number) => client.request(deleteReportFilterPreset(reportId, presetId)),
    onSuccess: invalidatePresets
  })
  const [presetName, setPresetName] = useState('')
  const [savingPreset, setSavingPreset] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  const { data: report, isLoading } = useQuery<ReportDef>({
    queryKey: ['nivaro-report', reportId],
    queryFn: () => client.request(readReport(reportId)).then((r) => (r as { data: ReportDef }).data),
    staleTime: 30_000
  })

  const effectiveRangeRef = useRef<ReportDateRange | null>(null)
  const entityFiltersRef = useRef<ReportEntityFilter[]>([])
  const savedRange = report?.global_filters?.date_range ?? null
  const effectiveRange = useMemo(() => {
    if (localRange !== undefined) return localRange
    if (dateRange !== undefined) return dateRange
    return savedRange
  }, [localRange, dateRange, savedRange])

  effectiveRangeRef.current = effectiveRange ?? null
  entityFiltersRef.current = entityFilters

  const filterBar = useMemo(
    () => report?.global_filters?.filter_bar ?? [],
    [report?.global_filters?.filter_bar]
  )

  useEffect(() => {
    if (scopeGateOpen) return
    if (!scopesReady || !report) return
    if (!myScopes || filterBar.length === 0) {
      setScopeGateOpen(true)
      return
    }
    void (async () => {
      const seeds: ReportEntityFilter[] = []
      const allowed: Record<string, Array<string | number>> = {}
      for (const f of filterBar) {
        const dim = matchScopeDimension(myScopes, {
          key: f.field,
          collection: f.options?.collection
        })
        if (!dim) continue
        const vf = f.options ? (f.options.value_field ?? 'id') : 'id'
        const restrictedIds = myScopes.restricted[dim.name] ?? []
        if (restrictedIds.length > 0) {
          const vals = await translateScopeValues(client as never, dim, restrictedIds, vf).catch(
            () => [] as Array<string | number>
          )
          if (vals.length > 0) allowed[f.field] = vals
        }
        const seedIds = effectiveScopeSeedIds(myScopes, dim.name)
        if (seedIds.length > 0) {
          const vals = await translateScopeValues(client as never, dim, seedIds, vf).catch(
            () => [] as Array<string | number>
          )
          if (vals.length > 0)
            seeds.push({ field: f.field, values: vals, labels: vals.map(String) })
        }
      }
      if (Object.keys(allowed).length > 0) setScopeAllowed(allowed)
      if (seeds.length > 0) {
        // only seed fields the caller/user hasn't already set
        const merge = (prev: ReportEntityFilter[]) => {
          const next = [...prev]
          for (const sd of seeds) if (!next.some((e) => e.field === sd.field)) next.push(sd)
          return next
        }
        setDraftFilters(merge)
        setEntityFilters(merge)
      }
      // batched with the seed setters — widgets mount already filtered
      setScopeGateOpen(true)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeGateOpen, scopesReady, report, myScopes, filterBar])
  const widgets = report?.widgets ?? []
  const draftEffectiveRange = draftRange !== undefined ? draftRange : effectiveRange
  const appliedCount =
    entityFilters.filter((f) => f.values.length > 0).length + (effectiveRange ? 1 : 0)
  const dirty =
    JSON.stringify(draftFilters) !== JSON.stringify(entityFilters) || draftRange !== undefined

  const applyDraft = () => {
    setEntityFilters(draftFilters)
    if (draftRange !== undefined) {
      setLocalRange(draftRange)
      setDraftRange(undefined)
    }
  }
  const clearAll = () => {
    setDraftFilters([])
    setEntityFilters([])
    setLocalRange(null)
    setDraftRange(undefined)
  }
  const applyPreset = (p: { date_range: ReportDateRange | null; entity_filters: ReportEntityFilter[] }) => {
    setDraftFilters(p.entity_filters)
    setEntityFilters(p.entity_filters)
    setLocalRange(p.date_range)
    setDraftRange(undefined)
  }
  const runAiFilters = async () => {
    const prompt = aiPrompt.trim()
    if (!prompt || aiBusy) return
    setAiBusy(true)
    setAiError(null)
    try {
      const res = await client.request(
        aiReportFilters(reportId, prompt, filterBar.map((f) => ({ field: f.field, label: f.label })))
      )
      const ef: ReportEntityFilter[] = (res.data.entity_filters ?? [])
        .filter((f) => filterBar.some((b) => b.field === f.field) && f.values?.length > 0)
        .map((f) => ({ field: f.field, values: f.values, labels: f.values.map(String) }))
      setDraftFilters(ef)
      setEntityFilters(ef)
      setLocalRange(res.data.date_range ?? null)
      setDraftRange(undefined)
      setAiPrompt('')
    } catch (err) {
      setAiError(
        (err as { response?: { data?: { error?: string } } }).response?.data?.error ??
          'Could not parse that'
      )
    } finally {
      setAiBusy(false)
    }
  }

  if (isLoading || !scopeGateOpen) {
    return (
      <div className={cn('p-6 text-[13px] text-slate-400', className)}>Loading report…</div>
    )
  }
  if (!report) {
    return <div className={cn('p-6 text-[13px] text-slate-400', className)}>Report not found.</div>
  }

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {showFilterBar && (widgets.length > 0 || filterBar.length > 0) && (
        <div className='space-y-1.5'>
          <div className='flex flex-wrap items-center gap-1.5'>
            <span className='flex items-center gap-1.5 text-[11.5px] font-semibold text-slate-500 dark:text-slate-300'>
              Filters
              {appliedCount > 0 && (
                <span className='rounded-full bg-emerald-50 px-1.5 py-px text-[10px] font-semibold text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'>
                  Active · {appliedCount}
                </span>
              )}
            </span>
            <SimpleSelect
              value={draftEffectiveRange?.preset ?? ''}
              onChange={(v) => setDraftRange(v ? { preset: v as never } : null)}
              options={DATE_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
              ariaLabel='Date range'
              className='h-7 w-auto rounded-md px-1.5 py-0 text-[12px] text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'
            />
            {filterBar.map((f) => (
              <FilterChip
                key={f.field}
                reportId={reportId}
                field={f.field}
                label={f.label}
                optionSource={f.options}
                allowedValues={scopeAllowed[f.field]}
                selected={draftFilters.find((e) => e.field === f.field)?.values ?? []}
                onChange={(values, labels) =>
                  setDraftFilters((prev) => [
                    ...prev.filter((e) => e.field !== f.field),
                    ...(values.length > 0 ? [{ field: f.field, values, labels }] : [])
                  ])
                }
              />
            ))}
            <button
              type='button'
              disabled={!dirty}
              onClick={applyDraft}
              className={cn(
                'inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[11.5px] font-semibold',
                dirty
                  ? 'bg-nvr-cyan text-white'
                  : 'bg-slate-100 text-slate-400 dark:bg-muted dark:text-slate-500'
              )}
            >
              <Check className='h-3 w-3' /> Apply
            </button>
            {(appliedCount > 0 || dirty) && (
              <button
                type='button'
                className='flex items-center gap-1 text-[11.5px] text-slate-400 hover:text-red-500'
                onClick={clearAll}
              >
                <X className='h-3 w-3' /> Clear
              </button>
            )}
          </div>

          <div className='flex flex-wrap items-center gap-1.5'>
            {presets.map((p) => (
              <span
                key={p.name}
                className='group/preset inline-flex h-6 items-center gap-1 rounded-full border border-slate-200 pl-2 pr-1 text-[11px] text-slate-500 hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:hover:text-nvr-cyan'
              >
                <button type='button' onClick={() => applyPreset(p)}>
                  {p.name}
                </button>
                <button
                  type='button'
                  title='Delete preset'
                  className='rounded-full p-0.5 text-slate-300 opacity-0 hover:text-red-500 group-hover/preset:opacity-100'
                  onClick={() => removePreset.mutate(p.id)}
                >
                  <X className='h-2.5 w-2.5' />
                </button>
              </span>
            ))}
            {savingPreset ? (
              <span className='inline-flex items-center gap-1'>
                <input
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder='Preset name'
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && presetName.trim()) {
                      savePreset.mutate(presetName.trim())
                      setPresetName('')
                      setSavingPreset(false)
                    }
                    if (e.key === 'Escape') setSavingPreset(false)
                  }}
                  className='h-6 w-[130px] rounded-md border border-slate-200 bg-white px-2 text-[11px] dark:border-border dark:bg-card'
                />
              </span>
            ) : (
              <button
                type='button'
                className='inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-slate-200 px-2 text-[11px] text-slate-400 hover:border-slate-300 hover:text-slate-600 dark:border-border'
                onClick={() => setSavingPreset(true)}
              >
                <Plus className='h-2.5 w-2.5' /> Save preset
              </button>
            )}

            <span className='mx-1 h-4 w-px bg-slate-200 dark:bg-border' />
            <span className='inline-flex h-7 min-w-[240px] flex-1 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 dark:border-border dark:bg-card sm:max-w-[420px]'>
              <span className='text-[11px] text-nvr-navy dark:text-nvr-cyan'>✦</span>
              <input
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runAiFilters()
                }}
                placeholder='Describe filters… e.g. "Zone 1 CRAN this year"'
                className='h-full min-w-0 flex-1 bg-transparent text-[11.5px] outline-none placeholder:text-slate-300 dark:text-slate-200'
              />
              <button
                type='button'
                disabled={aiBusy || !aiPrompt.trim()}
                onClick={() => void runAiFilters()}
                className='text-[11px] font-semibold text-nvr-navy disabled:opacity-40 dark:text-nvr-cyan'
              >
                {aiBusy ? '…' : 'Set'}
              </button>
            </span>
            {aiError && <span className='text-[10.5px] text-red-400'>{aiError}</span>}
          </div>
        </div>
      )}

      {widgets.length === 0 ? (
        <div className='p-6 text-[13px] text-slate-400'>
          {emptyState ?? 'This report has no widgets yet.'}
        </div>
      ) : (
        <div
          className='grid gap-3'
          style={{ gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gridAutoRows: '72px' }}
        >
          {[...widgets]
            .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0))
            .map((w) => (
              <WidgetCard
                key={w.id}
                reportId={reportId}
                widget={w}
                dateRange={effectiveRange}
                entityFilters={entityFilters}
                refetchInterval={refetchInterval}
                filterBar={filterBar}
                onDrill={openDrill}
              />
            ))}
        </div>
      )}
      {!outerDrill && drillStack?.length ? (
        <RecordDrilldownSheet
          collection={drillStack[0].collection}
          itemId={drillStack[0].itemId}
          title={drillStack[0].title}
          width='72%'
          stack={drillStack}
          onPush={(target) => drill.push([...drillStack, target])}
          onPop={() => drill.back()}
          // Explicit dismissal unwinds every level in one go.
          onClose={() => drill.back(drillStack.length)}
        />
      ) : null}
    </div>
  )
}
