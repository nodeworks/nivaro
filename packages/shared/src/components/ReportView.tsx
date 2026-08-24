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
import { Bell, Camera, Check, ChevronsUpDown, Download, Info, Plus, RefreshCw, Sigma, Sparkles, StickyNote, Trash2, TrendingDown, TrendingUp, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
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
import { del, get, post, put } from '../lib/commands'
import { AddWidgetBar, WidgetConfigSheet, WidgetEditBar } from './ReportEditMode'
import { cn } from '../lib/utils'
import { RecordDrilldownSheet } from './RecordDrilldownSheet'
import { TipLayer } from './TipLayer'
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

/** Automatic drill for query rows — the server infers which record a row's
 *  identifier columns point at (permission-checked); a miss just doesn't drill. */
function useAutoDrill(onDrill?: (t: { collection: string; itemId: string }) => void) {
  const client = useNivaroClient()
  const busyRef = useRef(false)
  return async (row: Record<string, unknown>) => {
    if (!onDrill || busyRef.current) return
    busyRef.current = true
    try {
      const r = await client.request<{
        data: { collection?: string; item_id?: string; resolved?: boolean }
      }>(post('/report-studio/drill-row', { values: row }))
      const d = r.data
      if (d?.collection && d.item_id) onDrill({ collection: d.collection, itemId: d.item_id })
    } catch {
      /* silent — not every row identifies a record */
    } finally {
      busyRef.current = false
    }
  }
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
  const drillRow = useAutoDrill(onDrill)
  const [tableSearch, setTableSearch] = useState('')
  const [tablePage, setTablePage] = useState(0)
  const [segRows, setSegRows] = useState<{ label: string; rows: Array<Record<string, unknown>> } | null>(null)
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
    const q = tableSearch.trim().toLowerCase()
    const searched = q
      ? rows.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q)))
      : rows
    const PAGE = 12
    const pages = Math.max(1, Math.ceil(searched.length / PAGE))
    const page = Math.min(tablePage, pages - 1)
    const visible = searched.length > PAGE ? searched.slice(page * PAGE, page * PAGE + PAGE) : searched
    return (
      <div className='flex min-h-0 flex-1 flex-col'>
      {rows.length > PAGE && (
        <div className='mb-1 flex items-center gap-2'>
          <input
            value={tableSearch}
            onChange={(e) => {
              setTableSearch(e.target.value)
              setTablePage(0)
            }}
            placeholder='Search rows…'
            className='h-6 w-40 rounded border border-slate-200 bg-white px-1.5 text-[11px] dark:border-border dark:bg-card dark:text-slate-200'
          />
          {pages > 1 && (
            <span className='ml-auto flex items-center gap-1 text-[10.5px] text-slate-400'>
              <button type='button' disabled={page <= 0} onClick={() => setTablePage(page - 1)} className='rounded px-1 disabled:opacity-30'>←</button>
              {page + 1}/{pages}
              <button type='button' disabled={page >= pages - 1} onClick={() => setTablePage(page + 1)} className='rounded px-1 disabled:opacity-30'>→</button>
            </span>
          )}
        </div>
      )}
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
            {visible.map((r, i) => (
              <tr
                key={i}
                className={onDrill ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-muted/60' : undefined}
                onClick={() => void drillRow(r)}
                title={onDrill ? 'Open the record behind this row' : undefined}
              >
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

  // Segment click on a query chart: no collection to rebuild filters from, but
  // the PRE-aggregation rows are right here — show the matching rows and let
  // each one auto-drill.
  const openSegment = (dimValue: string) => {
    if (!onDrill) return
    const matching = (data ?? []).filter((r) => String(r[xField] ?? '') === dimValue)
    if (matching.length > 0) setSegRows({ label: dimValue, rows: matching })
  }
  const segModal = segRows ? (
    <div
      className='fixed inset-0 z-[126] flex items-center justify-center bg-black/30 p-6'
      onClick={() => setSegRows(null)}
    >
      <div
        className='flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-border dark:bg-card'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-border'>
          <p className='min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
            {segRows.label}
          </p>
          <span className='text-[11.5px] text-slate-400'>{segRows.rows.length} rows — click one to open its record</span>
          <button type='button' onClick={() => setSegRows(null)} className='rounded p-1 text-slate-400 hover:text-slate-600'>
            <X className='h-4 w-4' />
          </button>
        </div>
        <div className='min-h-0 flex-1 overflow-auto p-2'>
          <table className='w-full text-[11px]'>
            <thead>
              <tr>
                {Object.keys(segRows.rows[0] ?? {}).slice(0, 7).map((c) => (
                  <th key={c} className='border-b border-slate-100 px-1.5 py-1 text-left font-medium text-slate-400 dark:border-border'>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {segRows.rows.slice(0, 100).map((r, i) => (
                <tr
                  key={i}
                  className='cursor-pointer hover:bg-slate-50 dark:hover:bg-muted/60'
                  onClick={() => {
                    setSegRows(null)
                    void drillRow(r)
                  }}
                >
                  {Object.keys(segRows.rows[0] ?? {}).slice(0, 7).map((c) => (
                    <td key={c} className='max-w-[160px] truncate border-b border-slate-50 px-1.5 py-1 text-slate-600 dark:border-border/40 dark:text-slate-300'>
                      {String(r[c] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  ) : null

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
                className={onDrill ? 'cursor-pointer' : undefined}
                onClick={(entry: { payload?: { dim?: string } }) => {
                  const d = entry?.payload?.dim
                  if (d) openSegment(String(d))
                }}
              >
                {donutData.map((s, i) => (
                  <Cell key={s.dim} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ fontSize: 12, backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }} labelStyle={{ color: '#f1f5f9' }} itemStyle={{ color: '#e2e8f0' }} formatter={(v) => tipFmt(v as number)} />
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
        {segModal}
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
            <Tooltip contentStyle={{ fontSize: 12, backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }} labelStyle={{ color: '#f1f5f9' }} itemStyle={{ color: '#e2e8f0' }} formatter={(v) => tipFmt(v as number)} />
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
        {segModal}
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
          <Tooltip contentStyle={{ fontSize: 12, backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }} labelStyle={{ color: '#f1f5f9' }} itemStyle={{ color: '#e2e8f0' }} formatter={(v) => tipFmt(v as number)} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
          {series.map((s, i) => (
            <Bar
                className={onDrill ? 'cursor-pointer' : undefined}
                onClick={(entry: { payload?: Record<string, unknown> } | undefined) => {
                  const d = entry?.payload?.[xField]
                  if (d != null) openSegment(String(d))
                }}
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
      {segModal}
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

// ── Drill-through / explain / dictionary helpers ─────────────────────────────

const FILTER_OP_MAP: Record<string, string> = {
  eq: '_eq', neq: '_neq', gt: '_gt', gte: '_gte', lt: '_lt', lte: '_lte',
  in: '_in', contains: '_contains', null: '_null', nnull: '_nnull'
}

type DrillCond = { path: string[]; op: string; value: unknown }

/** Rebuild the record-level conditions a native widget's number came from. */
function widgetDrillConditions(
  widget: ReportWidget,
  entityFilters: ReportEntityFilter[],
  dateRange: ReportDateRange | null,
  dimRaw?: unknown
): DrillCond[] {
  const cfg = (widget.config ?? {}) as Record<string, unknown>
  const conds: DrillCond[] = []
  for (const f of (cfg.filters as Array<{ field: string; op: string; value?: unknown }>) ?? []) {
    const op = FILTER_OP_MAP[f.op]
    if (!op) continue
    let value: unknown = f.value
    if (f.op === 'in' && typeof value === 'string') value = value.split(',').map((v) => v.trim())
    conds.push({ path: [f.field], op, value })
  }
  for (const ef of entityFilters) {
    if (ef.values?.length) conds.push({ path: [ef.field], op: '_in', value: ef.values })
  }
  const dateField = (cfg.date_field as string) || ((cfg.dimension as { bucket?: string; field?: string })?.bucket ? (cfg.dimension as { field?: string }).field : null)
  const range = resolveRangeDates(dateRange)
  if (range && dateField) {
    conds.push({ path: [dateField], op: '_gte', value: range.start })
    conds.push({ path: [dateField], op: '_lte', value: `${range.end}T23:59:59` })
  }
  const dim = cfg.dimension as { field?: string; bucket?: string } | undefined
  if (dimRaw !== undefined && dim?.field) {
    if (dim.bucket) {
      // bucket key ("2026-03" / "2026-03-14") → date window on the dim field
      const key = String(dimRaw)
      if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
        conds.push({ path: [dim.field], op: '_gte', value: key })
        conds.push({ path: [dim.field], op: '_lte', value: `${key}T23:59:59` })
      } else if (/^\d{4}-\d{2}$/.test(key)) {
        const [y, m] = key.split('-').map(Number)
        const last = new Date(y, m, 0).getDate()
        conds.push({ path: [dim.field], op: '_gte', value: `${key}-01` })
        conds.push({ path: [dim.field], op: '_lte', value: `${key}-${String(last).padStart(2, '0')}T23:59:59` })
      }
    } else if (dimRaw === null) {
      conds.push({ path: [dim.field], op: '_null', value: true })
    } else {
      conds.push({ path: [dim.field], op: '_eq', value: dimRaw })
    }
  }
  return conds
}

/** Human summary of how a widget's number is computed — the metric dictionary. */
function describeWidgetConfig(widget: ReportWidget): string {
  const cfg = (widget.config ?? {}) as Record<string, unknown>
  const parts: string[] = []
  const q = cfg.query as { slug?: string } | undefined
  if (widget.type === 'query' && q?.slug) {
    parts.push(`Custom query: ${q.slug}`)
  } else if (widget.collection) {
    const metric = cfg.metric as { aggregate?: string; field?: string } | undefined
    const agg = metric?.aggregate ?? 'count'
    parts.push(
      `${agg === 'count' ? 'Count of' : `${agg.toUpperCase()} of ${metric?.field ?? '?'} on`} ${widget.collection.replace(/_/g, ' ')}`
    )
    const dim = cfg.dimension as { field?: string; bucket?: string } | undefined
    if (dim?.field) parts.push(`by ${dim.field}${dim.bucket ? ` (${dim.bucket})` : ''}`)
    const filters = (cfg.filters as Array<{ field: string; op: string; value?: unknown }>) ?? []
    for (const f of filters) parts.push(`${f.field} ${f.op} ${String(f.value ?? '')}`)
    if (cfg.date_field) parts.push(`dated by ${cfg.date_field}`)
    if (cfg.compare) parts.push(`compared to ${String(cfg.compare).replace(/_/g, ' ')}`)
  }
  return parts.length > 0 ? parts.join(' · ') : 'No configuration details'
}

/** Client-side mirror of the server's per-widget metric (for snapshot deltas). */
function clientWidgetMetric(data: ReportWidgetData | undefined): number | null {
  if (!data) return null
  if (data.value != null) return Number(data.value)
  if (data.series) return data.series.reduce((a, b) => a + (Number(b.value) || 0), 0)
  if (data.tiles?.length) return Number(data.tiles[0]?.value ?? 0)
  if (data.row_count != null) return Number(data.row_count)
  return null
}

/** Download a widget's underlying rows/series as CSV. */
function downloadWidgetCsv(widget: ReportWidget, data: ReportWidgetData | undefined, extraRows?: Array<Record<string, unknown>>) {
  const rows: Array<Record<string, unknown>> = extraRows ? [...extraRows] : []
  if (rows.length === 0 && data?.rows?.length) rows.push(...data.rows)
  if (rows.length === 0 && data?.series?.length) {
    for (const sv of data.series) {
      rows.push({ dim: sv.dim, value: sv.value, ...(sv.prev != null ? { previous: sv.prev } : {}), ...(sv.value2 != null ? { value2: sv.value2 } : {}) })
    }
  }
  if (rows.length === 0 && data?.tiles?.length) {
    for (const t of data.tiles) rows.push({ label: t.label, value: t.value })
  }
  if (rows.length === 0 && data?.value != null) rows.push({ value: data.value })
  if (rows.length === 0) return
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const escCsv = (v: unknown) => {
    const t = String(v ?? '')
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
  }
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => escCsv(r[c])).join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${(widget.title || 'widget').replace(/[^\w-]+/g, '_')}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

interface WidgetAnnotation {
  id: number
  widget: string
  note: string
  anchor_date: string | null
  created_at: string
  created_by: string | null
  created_by_name: string | null
}

/** The records behind a number — top 50, click-through to the record. */
function WidgetRecordsModal({
  collection,
  conditions,
  title,
  onClose,
  onOpen,
  crossFilter
}: {
  collection: string
  conditions: DrillCond[]
  title: string
  onClose: () => void
  onOpen: (t: { collection: string; itemId: string }) => void
  crossFilter?: () => void
}) {
  const client = useNivaroClient()
  const { data, isLoading } = useQuery({
    queryKey: ['nvr-report-drill', collection, JSON.stringify(conditions)],
    queryFn: () =>
      client.request<{ data: Array<Record<string, unknown>>; total: number }>(
        get(`/items/${collection}`, { limit: 50, conditions: JSON.stringify(conditions) })
      ),
    staleTime: 30_000,
    retry: false
  })
  const rows = data?.data ?? []
  const label = (r: Record<string, unknown>) => {
    for (const k of ['title', 'name', 'label', 'subject', 'workflow_id', 'project_id', 'description']) {
      const v = r[k]
      if (typeof v === 'string' && v.trim()) return v.slice(0, 90)
    }
    const firstStr = Object.entries(r).find(([k, v]) => k !== 'id' && typeof v === 'string' && v.trim())
    return firstStr ? String(firstStr[1]).slice(0, 90) : `#${r.id}`
  }
  return (
    <div
      className='fixed inset-0 z-[126] flex items-center justify-center bg-black/30 p-6'
      onClick={onClose}
    >
      <div
        className='flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-border dark:bg-card'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-border'>
          <p className='min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
            {title}
          </p>
          <span className='text-[11.5px] tabular-nums text-slate-400'>
            {data ? `${rows.length}${(data.total ?? 0) > rows.length ? ` of ${data.total.toLocaleString()}` : ''} records` : ''}
          </span>
          {crossFilter && (
            <button
              type='button'
              onClick={crossFilter}
              title='Apply this value as a filter across the whole report'
              className='shrink-0 rounded-md border border-[#00ceff66] bg-[#00ceff14] px-2 py-0.5 text-[11px] font-medium text-[#007a99] hover:brightness-105 dark:text-nvr-cyan'
            >
              Filter report
            </button>
          )}
          <button type='button' onClick={onClose} className='rounded p-1 text-slate-400 hover:text-slate-600'>
            <X className='h-4 w-4' />
          </button>
        </div>
        <div className='min-h-0 flex-1 overflow-y-auto p-1.5'>
          {isLoading && <p className='px-2.5 py-3 text-[12px] text-slate-400'>Loading…</p>}
          {!isLoading && rows.length === 0 && (
            <p className='px-2.5 py-3 text-[12px] text-slate-400'>No records match.</p>
          )}
          {rows.map((r) => (
            <button
              key={String(r.id)}
              type='button'
              onClick={() => onOpen({ collection, itemId: String(r.id) })}
              className='block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-muted'
            >
              {label(r)}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Table-widget conditional formatting: value rules → cell/row tints. */
type FormatRule = { field: string; op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'; value: number; color: string; scope?: 'cell' | 'row' }
const RULE_TINTS: Record<string, { cell: string; row: string }> = {
  red: { cell: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300', row: 'bg-red-50/70 dark:bg-red-500/10' },
  amber: { cell: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300', row: 'bg-amber-50/70 dark:bg-amber-500/10' },
  green: { cell: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300', row: 'bg-emerald-50/70 dark:bg-emerald-500/10' },
  blue: { cell: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300', row: 'bg-sky-50/70 dark:bg-sky-500/10' }
}
function ruleMatches(rule: FormatRule, v: unknown): boolean {
  const n = Number(v)
  if (!Number.isFinite(n)) return false
  if (rule.op === 'gt') return n > rule.value
  if (rule.op === 'gte') return n >= rule.value
  if (rule.op === 'lt') return n < rule.value
  if (rule.op === 'lte') return n <= rule.value
  return n === rule.value
}

const WidgetCard = memo(function WidgetCard({
  reportId,
  widget,
  dateRange,
  entityFilters,
  refetchInterval,
  filterBar = [],
  onDrill,
  snapshot,
  annotations,
  onAddAnnotation,
  onDeleteAnnotation,
  onCrossFilter,
  reportUrl,
  currentFilters
}: {
  reportId: string
  widget: ReportWidget
  dateRange: ReportDateRange | null
  entityFilters: ReportEntityFilter[]
  refetchInterval?: number
  filterBar?: Array<{ field: string; label: string; options?: FilterOptionSource }>
  onDrill?: (t: { collection: string; itemId: string; title?: string }) => void
  snapshot?: { name: string; value: number | null } | null
  annotations?: WidgetAnnotation[]
  onAddAnnotation?: (widgetId: string, note: string, anchorDate: string | null) => void
  onDeleteAnnotation?: (annId: number) => void
  onCrossFilter?: (field: string, value: unknown, label: string) => void
  reportUrl?: (id: string) => string
  currentFilters?: ReportEntityFilter[]
}) {
  const client = useNivaroClient()
  const [tableSearch, setTableSearch] = useState('')
  const [tablePage, setTablePage] = useState(0)
  const [recordsFor, setRecordsFor] = useState<{
    conditions: DrillCond[]
    title: string
    dimField?: string
    dimRaw?: unknown
    dimLabel?: string
  } | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [noteDate, setNoteDate] = useState('')
  const [cumulative, setCumulative] = useState(false)
  const [explainOpen, setExplainOpen] = useState(false)
  const [explainText, setExplainText] = useState<string | null>(null)
  const [explainBusy, setExplainBusy] = useState(false)
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
    // Query widgets resolve client-side in QueryWidgetBody — but when a
    // snapshot comparison is active, the server-resolved value (the same
    // number the snapshot stored) is fetched so the delta badge can render.
    enabled: widget.type !== 'divider' && (widget.type !== 'query' || !!snapshot),
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
    if (widget.type === 'queue') {
      // Queue stat widget (#380): current value + the daily snapshot series.
      const series = data.series ?? []
      const maxV = Math.max(...series.map((pt) => pt.value), 1)
      const minV = Math.min(...series.map((pt) => pt.value), 0)
      const span = Math.max(maxV - minV, 1)
      const pts = series
        .map(
          (pt, i) =>
            `${(i / Math.max(1, series.length - 1)) * 100},${28 - ((pt.value - minV) / span) * 26}`
        )
        .join(' ')
      body = (
        <div className='flex min-h-0 flex-1 flex-col justify-center'>
          <p className='text-[28px] font-semibold leading-none tracking-tight tabular-nums text-slate-900 dark:text-foreground'>
            {data.value == null ? '—' : Number(data.value).toLocaleString()}
          </p>
          {series.length >= 3 && (
            <svg viewBox='0 0 100 30' preserveAspectRatio='none' className='mt-1.5 h-7 w-full'>
              <polyline
                points={pts}
                fill='none'
                stroke='#00ceff'
                strokeWidth='2'
                vectorEffect='non-scaling-stroke'
              />
            </svg>
          )}
          <p className='mt-0.5 text-[10.5px] text-slate-400'>
            {(widget.config as { metric?: string })?.metric ?? 'total'} · daily snapshots
          </p>
        </div>
      )
    } else if (widget.type === 'kpi' || widget.type === 'calc') {
      body = (
        <div className='flex items-baseline gap-2'>
          <p
            className={cn(
              'text-[28px] font-semibold leading-none tracking-tight text-slate-900 dark:text-foreground',
              widget.collection && 'cursor-pointer decoration-dotted underline-offset-4 hover:underline'
            )}
            title={widget.collection ? 'See the records behind this number' : undefined}
            onClick={() => {
              if (!widget.collection) return
              setRecordsFor({
                conditions: widgetDrillConditions(widget, entityFilters, dateRange),
                title: widget.title || widget.collection
              })
            }}
          >
            {fmt(data.value, format)}
          </p>
          <Delta pct={data.change_pct} />
        </div>
      )
      if (data.spark && data.spark.length >= 3) {
        const sv = data.spark
        const maxV = Math.max(...sv.map((p) => p.value), 1)
        const minV = Math.min(...sv.map((p) => p.value), 0)
        const span = Math.max(maxV - minV, 1)
        const pts = sv
          .map((p, i) => `${(i / (sv.length - 1)) * 100},${28 - ((p.value - minV) / span) * 26}`)
          .join(' ')
        body = (
          <div className='flex min-h-0 flex-1 flex-col justify-center'>
            {body}
            <svg viewBox='0 0 100 30' preserveAspectRatio='none' className='mt-1.5 h-7 w-full'>
              <polyline points={pts} fill='none' stroke='#00ceff' strokeWidth='2' vectorEffect='non-scaling-stroke' />
            </svg>
          </div>
        )
      }
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
    } else if (widget.type === 'narrative') {
      body = (
        <div className='min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-relaxed text-slate-700 dark:text-slate-300'>
          {(data.narrative ?? '').split(/(\*\*[^*]+\*\*)/g).map((seg, i) =>
            seg.startsWith('**') && seg.endsWith('**') ? (
              <strong key={i} className='font-semibold text-slate-900 dark:text-foreground'>
                {seg.slice(2, -2)}
              </strong>
            ) : (
              <span key={i}>{seg}</span>
            )
          )}
        </div>
      )
    } else if (widget.type === 'heatmap') {
      const cells = data.cells ?? []
      const rowsD = [...new Set(cells.map((c) => c.dim))]
      const colsD = [...new Set(cells.map((c) => c.dim2))]
      const maxV = Math.max(1, ...cells.map((c) => c.value))
      const cellOf = (r: string, c: string) => cells.find((x) => x.dim === r && x.dim2 === c)
      body =
        cells.length === 0 ? (
          <p className='px-1 text-[12px] text-slate-400'>No data.</p>
        ) : (
          <div className='min-h-0 flex-1 overflow-auto'>
            <table className='w-full text-[10.5px]'>
              <thead>
                <tr>
                  <th />
                  {colsD.map((c) => (
                    <th key={c} className='max-w-[80px] truncate px-1 pb-1 text-left font-medium text-slate-400'>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rowsD.map((r) => (
                  <tr key={r}>
                    <td className='max-w-[110px] truncate pr-1.5 text-slate-500 dark:text-slate-400'>{r}</td>
                    {colsD.map((c) => {
                      const cell = cellOf(r, c)
                      const pct = cell ? cell.value / maxV : 0
                      return (
                        <td key={c} className='p-0.5'>
                          <div
                            data-tip={cell ? `${r} × ${c}: ${cell.value.toLocaleString()}` : undefined}
                            className='flex h-6 items-center justify-center rounded text-[9.5px] tabular-nums'
                            style={{
                              backgroundColor: cell ? `rgba(0, 165, 204, ${0.08 + pct * 0.85})` : 'transparent',
                              color: pct > 0.55 ? '#fff' : undefined,
                              border: cell ? undefined : '1px dashed rgba(148,163,184,0.25)'
                            }}
                          >
                            {cell ? compactTick(Math.round(cell.value)) : ''}
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
    } else if (widget.type === 'waterfall') {
      const wf = data.waterfall
      body = !wf ? (
        <p className='px-1 text-[12px] text-slate-400'>No data.</p>
      ) : (
        (() => {
          const points: Array<{ label: string; from: number; to: number; kind: 'total' | 'up' | 'down' }> = []
          points.push({ label: 'Previous', from: 0, to: wf.start, kind: 'total' })
          let run = wf.start
          for (const st of wf.steps) {
            points.push({ label: st.dim, from: run, to: run + st.delta, kind: st.delta >= 0 ? 'up' : 'down' })
            run += st.delta
          }
          points.push({ label: 'Current', from: 0, to: wf.end, kind: 'total' })
          const maxTop = Math.max(1, ...points.map((pt) => Math.max(pt.from, pt.to)))
          return (
            <div className='flex min-h-0 flex-1 items-end gap-1 overflow-x-auto px-1 pb-4'>
              {points.map((pt, i) => {
                const top = (Math.max(pt.from, pt.to) / maxTop) * 100
                const height = (Math.abs(pt.to - pt.from) / maxTop) * 100
                return (
                  <div key={i} className='relative flex h-full min-w-[46px] flex-1 flex-col justify-end'>
                    <div style={{ height: `${Math.max(top, 0.5)}%` }} className='relative w-full'>
                      <div
                        data-tip={`${pt.label}: ${(pt.to - pt.from).toLocaleString()}`}
                        className='absolute inset-x-0 top-0 rounded-sm'
                        style={{
                          height: `${Math.max((height / Math.max(top, 0.001)) * 100, 2)}%`,
                          backgroundColor:
                            pt.kind === 'total' ? '#172940' : pt.kind === 'up' ? '#10b981' : '#ef4444'
                        }}
                      />
                    </div>
                    <p className='absolute -bottom-4 left-0 right-0 truncate text-center text-[9px] text-slate-400'>
                      {pt.label}
                    </p>
                  </div>
                )
              })}
            </div>
          )
        })()
      )
    } else if (widget.type === 'movers') {
      const rows = (data.rows ?? []) as Array<{
        dim: string
        current: number
        previous: number
        delta: number
        delta_pct: number | null
      }>
      body =
        rows.length === 0 ? (
          <p className='px-1 text-[12px] text-slate-400'>No movement in this window.</p>
        ) : (
          <div className='min-h-0 flex-1 space-y-0.5 overflow-y-auto'>
            {rows.map((r) => (
              <div key={r.dim} className='flex items-center gap-2 text-[11.5px]'>
                <span className='min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300'>
                  {r.dim}
                </span>
                <span className='tabular-nums text-slate-400'>
                  {r.previous.toLocaleString()} → {r.current.toLocaleString()}
                </span>
                <span
                  className={cn(
                    'w-[74px] shrink-0 text-right font-semibold tabular-nums',
                    r.delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'
                  )}
                >
                  {r.delta > 0 ? '+' : ''}
                  {r.delta.toLocaleString()}
                  {r.delta_pct != null && (
                    <span className='ml-1 text-[10px] font-normal text-slate-400'>
                      {r.delta_pct > 0 ? '+' : ''}
                      {r.delta_pct.toFixed(0)}%
                    </span>
                  )}
                </span>
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
      const rules = ((widget.config as Record<string, unknown> | null)?.format_rules ?? []) as FormatRule[]
      const rowTint = (r: Record<string, unknown>) => {
        for (const rule of rules) {
          if ((rule.scope ?? 'cell') === 'row' && ruleMatches(rule, r[rule.field])) {
            return RULE_TINTS[rule.color]?.row ?? null
          }
        }
        return null
      }
      const cellTint = (r: Record<string, unknown>, c: string) => {
        for (const rule of rules) {
          if ((rule.scope ?? 'cell') === 'cell' && rule.field === c && ruleMatches(rule, r[c])) {
            return RULE_TINTS[rule.color]?.cell ?? null
          }
        }
        return null
      }
      const q = tableSearch.trim().toLowerCase()
      const searched = q
        ? rows.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(q)))
        : rows
      const PAGE = 12
      const pages = Math.max(1, Math.ceil(searched.length / PAGE))
      const page = Math.min(tablePage, pages - 1)
      const visibleRows = searched.length > PAGE ? searched.slice(page * PAGE, page * PAGE + PAGE) : searched
      body =
        rows.length === 0 ? (
          <p className='px-1 text-[12px] text-slate-400'>No rows.</p>
        ) : (
          <div className='flex min-h-0 flex-1 flex-col'>
          {rows.length > PAGE && (
            <div className='mb-1 flex items-center gap-2'>
              <input
                value={tableSearch}
                onChange={(e) => {
                  setTableSearch(e.target.value)
                  setTablePage(0)
                }}
                placeholder='Search rows…'
                className='h-6 w-40 rounded border border-slate-200 bg-white px-1.5 text-[11px] dark:border-border dark:bg-card dark:text-slate-200'
              />
              {pages > 1 && (
                <span className='ml-auto flex items-center gap-1 text-[10.5px] text-slate-400'>
                  <button type='button' disabled={page <= 0} onClick={() => setTablePage(page - 1)} className='rounded px-1 disabled:opacity-30'>←</button>
                  {page + 1}/{pages}
                  <button type='button' disabled={page >= pages - 1} onClick={() => setTablePage(page + 1)} className='rounded px-1 disabled:opacity-30'>→</button>
                </span>
              )}
            </div>
          )}
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
                {visibleRows.map((r) => (
                  <tr
                    key={String(r.id)}
                    className={cn(
                      rowTint(r),
                      widget.collection && r.id != null && 'cursor-pointer hover:bg-slate-50 dark:hover:bg-muted/60'
                    )}
                    onClick={() => {
                      if (widget.collection && r.id != null)
                        onDrill?.({ collection: widget.collection, itemId: String(r.id) })
                    }}
                  >
                    {cols.map((c) => (
                      <td
                        key={c}
                        className={cn(
                          'max-w-[180px] truncate border-b border-slate-50 px-1.5 py-1 text-slate-700 dark:border-border/40 dark:text-slate-300',
                          (typeof r[c] === 'number' || NUMERIC_FORMATS.has(defFor(c)?.format ?? '')) &&
                            'text-right tabular-nums',
                          cellTint(r, c)
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
          </div>
        )
    } else {
      let series = data.series ?? []
      const bucketed = !!(widget.config?.dimension as { bucket?: string } | undefined)?.bucket
      if (cumulative && bucketed) {
        let acc = 0
        let accPrev = 0
        let acc2 = 0
        series = series.map((sv) => {
          acc += sv.value
          accPrev += sv.prev ?? 0
          acc2 += sv.value2 ?? 0
          return {
            ...sv,
            value: acc,
            ...(sv.prev != null ? { prev: accPrev } : {}),
            ...(sv.value2 != null ? { value2: acc2 } : {})
          }
        })
      }
      const hasValue2 = series.some((sv) => sv.value2 != null)
      const metric2Label =
        (widget.config?.metric2 as { label?: string } | undefined)?.label ?? 'secondary'
      const hasBand = series.some((sv) => sv.band != null)
      // Anomaly flags: bucketed series of 8+ points mark values beyond 2σ.
      const anomalySet = (() => {
        if (!bucketed || cumulative || series.length < 8) return new Set<string>()
        const vals = series.map((sv) => sv.value)
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length
        const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length)
        if (std === 0) return new Set<string>()
        return new Set(series.filter((sv) => Math.abs(sv.value - mean) > 2 * std).map((sv) => sv.dim))
      })()
      const anchorNotes = (annotations ?? []).filter(
        (a) => a.anchor_date && series.some((sv) => sv.dim === a.anchor_date)
      )
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
                    className={widget.collection ? 'cursor-pointer' : undefined}
                    onClick={(entry: { payload?: { dim?: string; raw?: unknown; other?: boolean } }) => {
                      if (!widget.collection) return
                      const seg = entry?.payload
                      if (seg?.other) return
                      const dimField = (widget.config?.dimension as { field?: string } | undefined)?.field
                      setRecordsFor({
                        conditions: widgetDrillConditions(widget, entityFilters, dateRange, seg?.raw ?? seg?.dim),
                        title: `${widget.title || widget.collection} — ${seg?.dim ?? ''}`,
                        dimField,
                        dimRaw: seg?.raw ?? seg?.dim,
                        dimLabel: seg?.dim
                      })
                    }}
                  >
                    {series.map((s, i) => (
                      <Cell
                        key={s.dim}
                        fill={s.other ? '#94a3b8' : CHART_COLORS[i % CHART_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 12, backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }} labelStyle={{ color: '#f1f5f9' }} itemStyle={{ color: '#e2e8f0' }} />
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
              <ComposedChart data={series} margin={{ top: 6, right: hasValue2 ? 4 : 8, left: -10, bottom: 0 }}>
                <XAxis
                  dataKey='dim'
                  tick={{ fontSize: 10 }}
                  stroke='#94a3b8'
                  {...catAxisProps(series.length)}
                />
                <YAxis tick={{ fontSize: 10 }} stroke='#94a3b8' tickFormatter={compactTick} width={44} />
                {hasValue2 && (
                  <YAxis
                    yAxisId='right'
                    orientation='right'
                    tick={{ fontSize: 10 }}
                    stroke='#94a3b8'
                    tickFormatter={compactTick}
                    width={44}
                  />
                )}
                {anchorNotes.map((a) => (
                  <ReferenceLine
                    key={a.id}
                    x={a.anchor_date as string}
                    stroke='#f59e0b'
                    strokeDasharray='4 3'
                    label={{ value: '✎', position: 'top', fontSize: 11, fill: '#f59e0b' }}
                  />
                ))}
                <Tooltip contentStyle={{ fontSize: 12, backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }} labelStyle={{ color: '#f1f5f9' }} itemStyle={{ color: '#e2e8f0' }} />
                {hasBand && (
                  <Area
                    type='monotone'
                    dataKey='band'
                    stroke='none'
                    fill='#94a3b8'
                    fillOpacity={0.15}
                    name='typical range'
                    activeDot={false}
                  />
                )}
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
                  dot={(props: { cx?: number; cy?: number; payload?: { dim?: string } }) =>
                    anomalySet.has(props.payload?.dim ?? '') ? (
                      <circle
                        key={props.payload?.dim}
                        cx={props.cx}
                        cy={props.cy}
                        r={3.5}
                        fill='#ef4444'
                        stroke='#fff'
                        strokeWidth={1}
                      />
                    ) : (
                      <g key={props.payload?.dim} />
                    )
                  }
                />
                {hasValue2 && (
                  <Line
                    yAxisId='right'
                    type='monotone'
                    dataKey='value2'
                    stroke='#8b5cf6'
                    strokeWidth={1.5}
                    dot={false}
                    name={metric2Label}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )
      } else {
        const horizontal = widget.config?.orientation === 'horizontal'
        body = (
          <div className='min-h-[110px] flex-1'>
            <ResponsiveContainer width='100%' height='100%'>
              <ComposedChart
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
                    {hasValue2 && (
                      <YAxis
                        yAxisId='right'
                        orientation='right'
                        tick={{ fontSize: 10 }}
                        stroke='#94a3b8'
                        tickFormatter={compactTick}
                        width={44}
                      />
                    )}
                  </>
                )}
                {!horizontal &&
                  anchorNotes.map((a) => (
                    <ReferenceLine
                      key={a.id}
                      x={a.anchor_date as string}
                      stroke='#f59e0b'
                      strokeDasharray='4 3'
                      label={{ value: '✎', position: 'top', fontSize: 11, fill: '#f59e0b' }}
                    />
                  ))}
                <Tooltip contentStyle={{ fontSize: 12, backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#f1f5f9' }} labelStyle={{ color: '#f1f5f9' }} itemStyle={{ color: '#e2e8f0' }} />
                {widget.config?.compare && (
                  <Bar dataKey='prev' fill='#cbd5e1' radius={[3, 3, 0, 0]} name='previous' />
                )}
                <Bar
                  dataKey='value'
                  fill='#00ceff'
                  radius={[3, 3, 0, 0]}
                  className={widget.collection ? 'cursor-pointer' : undefined}
                  onClick={(entry: { payload?: { dim?: string; raw?: unknown; other?: boolean } } | undefined) => {
                    if (!widget.collection) return
                    const seg = entry?.payload
                    if (seg?.other) return
                    const dimField = (widget.config?.dimension as { field?: string; bucket?: string } | undefined)
                    setRecordsFor({
                      conditions: widgetDrillConditions(widget, entityFilters, dateRange, seg?.raw ?? seg?.dim),
                      title: `${widget.title || widget.collection} — ${seg?.dim ?? ''}`,
                      dimField: dimField?.bucket ? undefined : dimField?.field,
                      dimRaw: seg?.raw ?? seg?.dim,
                      dimLabel: seg?.dim
                    })
                  }}
                >
                  {series.map((sv) => (
                    <Cell key={sv.dim} fill={sv.other ? '#94a3b8' : '#00ceff'} />
                  ))}
                </Bar>
                {hasValue2 && (
                  <Line
                    yAxisId={horizontal ? undefined : 'right'}
                    type='monotone'
                    dataKey='value2'
                    stroke='#8b5cf6'
                    strokeWidth={1.5}
                    dot={false}
                    name={metric2Label}
                  />
                )}
              </ComposedChart>
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
        {(() => {
          const link = (widget.config as { link_report?: { report_id?: string } } | null)?.link_report
          if (link?.report_id && reportUrl) {
            return (
              <a
                href={reportUrl(link.report_id)}
                onClick={() => {
                  try {
                    sessionStorage.setItem(
                      `nvr-report-xf:${link.report_id}`,
                      JSON.stringify(currentFilters ?? [])
                    )
                  } catch {
                    /* handoff is best-effort */
                  }
                }}
                title='Open the linked report (carries your current filters)'
                className='truncate text-[11.5px] font-medium uppercase tracking-wide text-[#00a5cc] underline decoration-dotted underline-offset-2 hover:text-[#007a99]'
              >
                {widget.title} ↗
              </a>
            )
          }
          return (
            <p className='truncate text-[11.5px] font-medium uppercase tracking-wide text-slate-400'>
              {widget.title}
            </p>
          )
        })()}
        <span
          data-tip={describeWidgetConfig(widget)}
          className='shrink-0 cursor-help text-slate-300 hover:text-slate-500'
        >
          <Info className='h-3 w-3' />
        </span>
        <span className='ml-auto flex items-center gap-0.5'>
          {(
            <button
              type='button'
              title='Explain this number'
              className='rounded p-0.5 text-slate-300 hover:text-[#00a5cc]'
              onClick={() => {
                if (explainOpen) {
                  setExplainOpen(false)
                  return
                }
                setExplainOpen(true)
                if (explainText || explainBusy) return
                setExplainBusy(true)
                // Query widgets resolve their data inside QueryWidgetBody — fetch
                // the server-resolved equivalent so the AI has real numbers.
                const dataP: Promise<ReportWidgetData | undefined> = data
                  ? Promise.resolve(data)
                  : client
                      .request(
                        readReportWidgetData(reportId, widget.id, {
                          date_range: dateRange,
                          entity_filters: entityFilters
                        })
                      )
                      .then((r) => (r as { data: ReportWidgetData }).data)
                      .catch(() => undefined)
                dataP
                  .then((d) => {
                    const context = {
                      widget: widget.title,
                      how_computed: describeWidgetConfig(widget),
                      value: d?.value ?? null,
                      previous_value: d?.prev_value ?? null,
                      change_pct: d?.change_pct ?? null,
                      row_count: d?.row_count ?? null,
                      series: (d?.series ?? []).slice(0, 15),
                      rows: (d?.rows ?? []).slice(0, 10),
                      tiles: d?.tiles ?? null
                    }
                    return client.request<{ data?: { text?: string }; text?: string }>(
                      post('/ai/brief', {
                        context: JSON.stringify(context),
                        instructions:
                          'In 2-3 plain sentences, explain what this report metric shows and what stands out (biggest contributor, direction of change). No preamble.'
                      })
                    )
                  })
                  .then((r) => {
                    const t =
                      (r as { data?: { brief?: string; text?: string } }).data?.brief ??
                      (r as { data?: { text?: string } }).data?.text ??
                      null
                    setExplainText(t || 'No explanation available.')
                  })
                  .catch(() => setExplainText('AI is not configured or unavailable.'))
                  .finally(() => setExplainBusy(false))
              }}
            >
              <Sparkles className='h-3 w-3' />
            </button>
          )}
          {(widget.config?.dimension as { bucket?: string } | undefined)?.bucket && (
            <button
              type='button'
              title={cumulative ? 'Show per-period values' : 'Show running total'}
              className={cn(
                'rounded p-0.5',
                cumulative ? 'text-[#00a5cc]' : 'text-slate-300 hover:text-slate-500'
              )}
              onClick={() => setCumulative((v) => !v)}
            >
              <Sigma className='h-3 w-3' />
            </button>
          )}
          {onAddAnnotation && (
            <button
              type='button'
              title='Notes on this widget'
              className={cn(
                'relative rounded p-0.5',
                (annotations?.length ?? 0) > 0 ? 'text-amber-500' : 'text-slate-300 hover:text-slate-500'
              )}
              onClick={() => setNotesOpen((v) => !v)}
            >
              <StickyNote className='h-3 w-3' />
            </button>
          )}
          <button
            type='button'
            title='Download as CSV'
            className='rounded p-0.5 text-slate-300 hover:text-slate-500'
            onClick={() => downloadWidgetCsv(widget, data)}
          >
            <Download className='h-3 w-3' />
          </button>
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
      {notesOpen && (
        <div className='mb-1.5 space-y-1 rounded-md border border-amber-200 bg-amber-50/60 p-2 dark:border-amber-500/30 dark:bg-amber-500/10'>
          {(annotations ?? []).map((a) => (
            <div key={a.id} className='group/note flex items-start gap-1.5 text-[11px] text-slate-600 dark:text-slate-300'>
              <span className='min-w-0 flex-1'>
                {a.anchor_date && <span className='font-semibold text-amber-600 dark:text-amber-400'>{a.anchor_date} — </span>}
                {a.note}
                <span className='ml-1 text-[10px] text-slate-400'>{a.created_by_name ?? ''}</span>
              </span>
              {onDeleteAnnotation && (
                <button
                  type='button'
                  onClick={() => onDeleteAnnotation(a.id)}
                  className='shrink-0 rounded p-0.5 text-slate-300 opacity-0 hover:text-red-500 group-hover/note:opacity-100'
                >
                  <X className='h-2.5 w-2.5' />
                </button>
              )}
            </div>
          ))}
          {(annotations ?? []).length === 0 && (
            <p className='text-[11px] text-slate-400'>No notes yet — record why a number moved.</p>
          )}
          {onAddAnnotation && (
            <div className='flex items-center gap-1 pt-0.5'>
              <input
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder='Add a note…'
                className='h-6 min-w-0 flex-1 rounded border border-amber-200 bg-white px-1.5 text-[11px] dark:border-amber-500/30 dark:bg-card dark:text-slate-200'
              />
              <input
                value={noteDate}
                onChange={(e) => setNoteDate(e.target.value)}
                placeholder='2026-03'
                title='Optional chart anchor (YYYY-MM or YYYY-MM-DD bucket key)'
                className='h-6 w-[76px] rounded border border-amber-200 bg-white px-1.5 text-[10.5px] dark:border-amber-500/30 dark:bg-card dark:text-slate-200'
              />
              <button
                type='button'
                disabled={!noteText.trim()}
                onClick={() => {
                  onAddAnnotation(widget.id, noteText.trim(), noteDate.trim() || null)
                  setNoteText('')
                  setNoteDate('')
                }}
                className='h-6 rounded bg-amber-500 px-2 text-[11px] font-medium text-white hover:brightness-105 disabled:opacity-40'
              >
                Add
              </button>
            </div>
          )}
        </div>
      )}
      {snapshot && (
        (() => {
          const cur = clientWidgetMetric(data)
          const prev = snapshot.value
          if (cur == null || prev == null) return null
          const delta = prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100
          return (
            <p className='mb-1 flex items-center gap-1 text-[10.5px] text-slate-400'>
              <Camera className='h-2.5 w-2.5' />
              vs {snapshot.name}: {prev.toLocaleString()} →{' '}
              <span
                className={cn(
                  'font-semibold',
                  delta != null && delta > 0 && 'text-emerald-600 dark:text-emerald-400',
                  delta != null && delta < 0 && 'text-red-500'
                )}
              >
                {delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`}
              </span>
            </p>
          )
        })()
      )}
      {explainOpen && (
        <div className='mb-1.5 rounded-md border border-[#00ceff40] bg-[#00ceff0d] px-2.5 py-1.5 text-[11.5px] leading-snug text-slate-600 dark:text-slate-300'>
          {explainBusy ? 'Thinking…' : explainText}
        </div>
      )}
      <div className='flex min-h-0 flex-1 flex-col'>{body}</div>
      {recordsFor && (
        <WidgetRecordsModal
          collection={widget.collection ?? ''}
          conditions={recordsFor.conditions}
          title={recordsFor.title}
          onClose={() => setRecordsFor(null)}
          onOpen={(t) => {
            setRecordsFor(null)
            onDrill?.(t)
          }}
          crossFilter={
            onCrossFilter && recordsFor.dimField && recordsFor.dimRaw != null
              ? () => {
                  onCrossFilter(
                    recordsFor.dimField as string,
                    recordsFor.dimRaw,
                    recordsFor.dimLabel ?? String(recordsFor.dimRaw)
                  )
                  setRecordsFor(null)
                }
              : undefined
          }
        />
      )}
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
  emptyState,
  reportUrl
}: ReportViewProps & { reportUrl?: (id: string) => string }) {
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
  // Point-in-time snapshots — pick one and every widget shows a delta badge.
  const [snapId, setSnapId] = useState<number | null>(null)
  const { data: snapshots = [] } = useQuery({
    queryKey: ['nvr-report-snaps', reportId],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: number; name: string; taken_at: string }> }>(
          get(`/report-studio/${reportId}/snapshots`)
        )
        .then((r) => r.data ?? []),
    staleTime: 60_000,
    retry: false
  })
  const { data: snapDetail } = useQuery({
    queryKey: ['nvr-report-snap', reportId, snapId],
    queryFn: () =>
      client
        .request<{ data: { name: string; data: Record<string, { value: number | null }> } }>(
          get(`/report-studio/${reportId}/snapshots/${snapId}`)
        )
        .then((r) => r.data),
    enabled: snapId != null,
    staleTime: 5 * 60_000,
    retry: false
  })
  const takeSnapshot = useMutation({
    mutationFn: () => client.request(post(`/report-studio/${reportId}/snapshots`, {})),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nvr-report-snaps', reportId] })
  })
  // Widget annotations — "why did this number move".
  const { data: allAnnotations = [] } = useQuery<WidgetAnnotation[]>({
    queryKey: ['nvr-report-notes', reportId],
    queryFn: () =>
      client
        .request<{ data: WidgetAnnotation[] }>(get(`/report-studio/${reportId}/annotations`))
        .then((r) => r.data ?? []),
    staleTime: 60_000,
    retry: false
  })
  const invalidateNotes = () =>
    void qc.invalidateQueries({ queryKey: ['nvr-report-notes', reportId] })
  const addNote = useMutation({
    mutationFn: (v: { widget: string; note: string; anchor_date: string | null }) =>
      client.request(post(`/report-studio/${reportId}/annotations`, v)),
    onSuccess: invalidateNotes
  })
  const deleteNote = useMutation({
    mutationFn: (annId: number) =>
      client.request(del(`/report-studio/${reportId}/annotations/${annId}`)),
    onSuccess: invalidateNotes
  })
  // Cross-filter: a clicked segment's value applied report-wide as an entity
  // filter — widgets without the column are simply unaffected (EFP semantics).
  const applyCrossFilter = useCallback((field: string, value: unknown, label: string) => {
    const entry: ReportEntityFilter = {
      field,
      values: [value as string | number],
      labels: [label]
    }
    setEntityFilters((prev) => [...prev.filter((f) => f.field !== field), entry])
    setDraftFilters((prev) => [...prev.filter((f) => f.field !== field), entry])
  }, [])
  // ── Edit mode (headless builder) — server decides editability ─────────────
  const [editMode, setEditMode] = useState(false)
  const [draftWidgets, setDraftWidgets] = useState<ReportWidget[] | null>(null)
  const [configuring, setConfiguring] = useState<string | null>(null)
  const saveWidgets = useMutation({
    mutationFn: (ws: ReportWidget[]) =>
      client.request(
        put(`/report-studio/${reportId}/widgets`, {
          widgets: ws.map((w, i) => ({ ...w, sort: i }))
        })
      ),
    onSuccess: () => {
      setEditMode(false)
      setDraftWidgets(null)
      setConfiguring(null)
      void qc.invalidateQueries({ queryKey: ['nivaro-report', reportId] })
      void qc.invalidateQueries({ queryKey: ['nivaro-report-widget'] })
    }
  })
  const orderedForEdit = (ws: ReportWidget[]) =>
    [...ws].sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0))
  // Freshness: stamped at mount and on Refresh-all.
  const [dataAsOf, setDataAsOf] = useState(() => new Date())
  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['nivaro-report-widget', reportId] })
    void qc.invalidateQueries({ queryKey: ['nivaro-report-query'] })
    setDataAsOf(new Date())
  }
  // Currently-firing alerts — the report wears its own red strip.
  const { data: firing = [] } = useQuery({
    queryKey: ['nvr-report-firing', reportId],
    queryFn: () =>
      client
        .request<{ data: Array<{ alert_id: string; name: string; widget: string; since: string }> }>(
          get(`/report-studio/${reportId}/firing`)
        )
        .then((r) => r.data ?? [])
        .catch(() => []),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false
  })
  // Side-by-side comparison: one filter field, two values, every widget twice.
  const [compare, setCompare] = useState<{ field: string; a: string; b: string } | null>(null)
  const [compareOpen, setCompareOpen] = useState(false)
  const [cmpField, setCmpField] = useState('')
  const [cmpA, setCmpA] = useState('')
  const [cmpB, setCmpB] = useState('')
  // Drill-to-report handoff: a linking widget stored filters for us to adopt.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`nvr-report-xf:${reportId}`)
      if (raw) {
        sessionStorage.removeItem(`nvr-report-xf:${reportId}`)
        const fs = JSON.parse(raw) as ReportEntityFilter[]
        if (Array.isArray(fs) && fs.length > 0) {
          setEntityFilters(fs)
          setDraftFilters(fs)
        }
      }
    } catch {
      /* a bad handoff just opens the report unfiltered */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId])
  const startEdit = () => {
    setDraftWidgets(orderedForEdit(report?.widgets ?? []))
    setEditMode(true)
    // The config sheet's copy-to-report needs the source report id.
    ;(window as unknown as { __nvrReportId?: string }).__nvrReportId = reportId
  }
  const patchWidget = (next: ReportWidget) =>
    setDraftWidgets((prev) => (prev ?? []).map((w) => (w.id === next.id ? next : w)))
  const moveWidget = (id: string, dir: -1 | 1) =>
    setDraftWidgets((prev) => {
      const ws = [...(prev ?? [])]
      const i = ws.findIndex((w) => w.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= ws.length) return ws
      // Swap positions so the grid reflows — steppers, not drag.
      const a = ws[i]
      const b = ws[j]
      ws[i] = { ...b, x: a.x, y: a.y }
      ws[j] = { ...a, x: b.x, y: b.y }
      return ws
    })
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
            <button
              type='button'
              title='Save the current numbers as a snapshot to compare against later'
              disabled={takeSnapshot.isPending}
              onClick={() => takeSnapshot.mutate()}
              className='inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-slate-200 px-2 text-[11px] text-slate-400 hover:border-slate-300 hover:text-slate-600 disabled:opacity-40 dark:border-border'
            >
              <Camera className='h-2.5 w-2.5' /> {takeSnapshot.isPending ? 'Saving…' : 'Snapshot'}
            </button>
            {snapshots.map((sn) => (
              <button
                key={sn.id}
                type='button'
                title={`Compare against ${sn.name} (${new Date(sn.taken_at).toLocaleDateString()})`}
                onClick={() => setSnapId((cur) => (cur === sn.id ? null : sn.id))}
                className={cn(
                  'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px]',
                  snapId === sn.id
                    ? 'border-[#00ceff66] bg-[#00ceff14] font-medium text-[#007a99] dark:text-nvr-cyan'
                    : 'border-slate-200 text-slate-400 hover:text-slate-600 dark:border-border'
                )}
              >
                <Camera className='h-2.5 w-2.5' /> {sn.name}
                {snapId === sn.id && <X className='h-2.5 w-2.5' />}
              </button>
            ))}

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

      {firing.length > 0 && (
        <div className='mb-2 flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 dark:border-red-500/40 dark:bg-red-500/10'>
          <Bell className='h-3.5 w-3.5 shrink-0 text-red-500' />
          <p className='min-w-0 flex-1 truncate text-[12px] text-red-700 dark:text-red-300'>
            {firing.length === 1
              ? `Alert firing: ${firing[0].name}`
              : `${firing.length} alerts firing: ${firing.map((f) => f.name).join(' · ')}`}
          </p>
        </div>
      )}
      <div className='mb-2 flex flex-wrap items-center gap-2'>
        <span className='text-[10.5px] text-slate-400'>
          Data as of {dataAsOf.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
        <button
          type='button'
          onClick={refreshAll}
          className='inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:text-slate-700 dark:border-border dark:text-slate-400'
        >
          <RefreshCw className='h-2.5 w-2.5' /> Refresh all
        </button>
        <span className='relative'>
          <button
            type='button'
            onClick={() => setCompareOpen((o) => !o)}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]',
              compare
                ? 'border-[#00ceff66] bg-[#00ceff14] font-medium text-[#007a99] dark:text-nvr-cyan'
                : 'border-slate-200 text-slate-500 hover:text-slate-700 dark:border-border dark:text-slate-400'
            )}
          >
            {compare ? `Comparing ${compare.a} vs ${compare.b}` : 'Compare A/B'}
            {compare && (
              <X
                className='h-2.5 w-2.5'
                onClick={(e) => {
                  e.stopPropagation()
                  setCompare(null)
                }}
              />
            )}
          </button>
          {compareOpen && (
            <span className='absolute left-0 top-full z-50 mt-1 flex w-72 flex-col gap-1.5 rounded-xl border border-slate-200 bg-white p-2.5 shadow-lg dark:border-border dark:bg-card'>
              <input
                value={cmpField}
                onChange={(e) => setCmpField(e.target.value)}
                placeholder='Filter field (e.g. division)'
                className='h-7 rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card dark:text-slate-200'
              />
              <span className='flex gap-1.5'>
                <input
                  value={cmpA}
                  onChange={(e) => setCmpA(e.target.value)}
                  placeholder='Value A'
                  className='h-7 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card dark:text-slate-200'
                />
                <input
                  value={cmpB}
                  onChange={(e) => setCmpB(e.target.value)}
                  placeholder='Value B'
                  className='h-7 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card dark:text-slate-200'
                />
              </span>
              <button
                type='button'
                disabled={!cmpField.trim() || !cmpA.trim() || !cmpB.trim()}
                onClick={() => {
                  setCompare({ field: cmpField.trim(), a: cmpA.trim(), b: cmpB.trim() })
                  setCompareOpen(false)
                }}
                className='h-7 rounded-md bg-nvr-cyan text-[11.5px] font-semibold text-white hover:brightness-110 disabled:opacity-40'
              >
                Compare
              </button>
            </span>
          )}
        </span>
      </div>
      {entityFilters.filter((f) => !filterBar.some((b) => b.field === f.field)).length > 0 && (
        <div className='flex flex-wrap items-center gap-1.5 px-1 pb-2'>
          {entityFilters
            .filter((f) => !filterBar.some((b) => b.field === f.field))
            .map((f) => (
              <span
                key={f.field}
                className='inline-flex items-center gap-1.5 rounded-full border border-[#00ceff66] bg-[#00ceff14] py-0.5 pl-2.5 pr-1 text-[11.5px] text-[#007a99] dark:text-nvr-cyan'
              >
                {f.field.replace(/_/g, ' ')}: {(f.labels ?? f.values.map(String)).join(', ')}
                <button
                  type='button'
                  aria-label='Remove filter'
                  onClick={() => {
                    setEntityFilters((prev) => prev.filter((x) => x.field !== f.field))
                    setDraftFilters((prev) => prev.filter((x) => x.field !== f.field))
                  }}
                  className='rounded-full p-0.5 hover:bg-[#00ceff29]'
                >
                  <X className='h-2.5 w-2.5' />
                </button>
              </span>
            ))}
        </div>
      )}
      {report?.editable && (
        <div className='mb-2 flex items-center gap-1.5'>
          {editMode ? (
            <>
              <button
                type='button'
                disabled={saveWidgets.isPending}
                onClick={() => draftWidgets && saveWidgets.mutate(draftWidgets)}
                className='rounded-md bg-nvr-cyan px-3 py-1 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-40'
              >
                {saveWidgets.isPending ? 'Saving…' : 'Save layout'}
              </button>
              <button
                type='button'
                onClick={() => {
                  setEditMode(false)
                  setDraftWidgets(null)
                  setConfiguring(null)
                }}
                className='rounded-md border border-slate-200 px-3 py-1 text-[12px] text-slate-500 dark:border-border'
              >
                Cancel
              </button>
              <span className='text-[11px] text-slate-400'>
                Changes apply when you save — a version is captured automatically.
              </span>
            </>
          ) : (
            <button
              type='button'
              onClick={startEdit}
              className='rounded-md border border-slate-200 px-3 py-1 text-[12px] font-medium text-slate-500 hover:text-slate-700 dark:border-border dark:text-slate-400'
            >
              Edit report
            </button>
          )}
        </div>
      )}
      {editMode && draftWidgets && (
        <div className='mb-3'>
          <AddWidgetBar
            maxY={Math.max(0, ...draftWidgets.map((w) => (w.y ?? 0) + (w.h ?? 1)))}
            onAdd={(w) => setDraftWidgets((prev) => [...(prev ?? []), w])}
          />
        </div>
      )}
      {widgets.length === 0 && !editMode ? (
        <div className='p-6 text-[13px] text-slate-400'>
          {emptyState ?? 'This report has no widgets yet.'}
        </div>
      ) : (
        <div
          className='grid gap-3'
          style={{ gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gridAutoRows: editMode ? undefined : '72px' }}
        >
          {orderedForEdit(editMode && draftWidgets ? draftWidgets : widgets)
            .map((w) => (
              <div
                key={w.id}
                style={{
                  gridColumn: compare
                    ? `1 / -1`
                    : `${Math.max(1, (w.x ?? 0) + 1)} / span ${Math.min(12, Math.max(2, w.w || 4))}`,
                  gridRow: editMode ? undefined : undefined
                }}
                className={editMode || compare ? '' : 'contents'}
              >
              {compare && !editMode && w.type !== 'divider' ? (
                <div className='grid grid-cols-2 gap-3'>
                  {[compare.a, compare.b].map((val, side) => (
                    <div key={side} className='flex min-h-[160px] flex-col'>
                      <p className='mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[#007a99] dark:text-nvr-cyan'>
                        {compare.field.replace(/_/g, ' ')}: {val}
                      </p>
                      <WidgetCard
                        reportId={reportId}
                        widget={w}
                        dateRange={effectiveRange}
                        entityFilters={[
                          ...entityFilters.filter((f) => f.field !== compare.field),
                          { field: compare.field, values: [val], labels: [val] }
                        ]}
                        refetchInterval={refetchInterval}
                        filterBar={filterBar}
                        onDrill={openDrill}
                      />
                    </div>
                  ))}
                </div>
              ) : (
              <>
              {editMode && (
                <WidgetEditBar
                  widget={w}
                  onConfigure={() => setConfiguring(w.id)}
                  onDelete={() => setDraftWidgets((prev) => (prev ?? []).filter((x) => x.id !== w.id))}
                  onResize={(dw, dh) =>
                    patchWidget({
                      ...w,
                      w: Math.min(12, Math.max(2, (w.w || 4) + dw)),
                      h: Math.min(8, Math.max(1, (w.h || 2) + dh))
                    })
                  }
                  onMove={(dir) => moveWidget(w.id, dir)}
                />
              )}
              <WidgetCard
                reportId={reportId}
                widget={w}
                dateRange={effectiveRange}
                entityFilters={entityFilters}
                refetchInterval={refetchInterval}
                filterBar={filterBar}
                onDrill={openDrill}
                snapshot={
                  snapDetail && snapDetail.data[w.id] !== undefined
                    ? { name: snapDetail.name, value: snapDetail.data[w.id]?.value ?? null }
                    : null
                }
                annotations={allAnnotations.filter((a) => a.widget === w.id)}
                onAddAnnotation={(widgetId, note, anchorDate) =>
                  addNote.mutate({ widget: widgetId, note, anchor_date: anchorDate })
                }
                onDeleteAnnotation={(annId) => deleteNote.mutate(annId)}
                onCrossFilter={applyCrossFilter}
                reportUrl={reportUrl}
                currentFilters={entityFilters}
              />
              </>
              )}
              </div>
            ))}
        </div>
      )}
      {editMode && configuring && draftWidgets?.some((w) => w.id === configuring) && (
        <WidgetConfigSheet
          widget={draftWidgets.find((w) => w.id === configuring) as ReportWidget}
          allWidgets={draftWidgets}
          onChange={patchWidget}
          onClose={() => setConfiguring(null)}
        />
      )}
      <TipLayer />
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
