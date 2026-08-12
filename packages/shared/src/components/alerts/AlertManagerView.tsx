import { deleteNotificationSubscription, listNotificationSubscriptions } from '@nivaro/sdk'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  Bell,
  BellRing,
  ChartColumn,
  Clock,
  FlaskConical,
  Gauge,
  History,
  LayoutGrid,
  Lock,
  Pencil,
  Plus,
  Siren,
  Trash2,
  Users
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import {
  effectiveScopeSeedIds,
  matchScopeDimension,
  translateScopeValues,
  useMyScopes
} from '../../lib/use-my-scopes'
import { cn } from '../../lib/utils'
import {
  AlertRuleDrawer,
  AnomalyRuleDrawer,
  NotifSubEditDrawer,
  SelectInput,
  ToggleSwitch
} from './drawers'
import type {
  AnomalyDefinition,
  AnomalyLogEntry,
  AnomalyRule,
  MetricAlertLogEntry,
  MetricAlertRule,
  MetricAlertSubscription,
  MetricDefinition,
  ReportAlertLogRow,
  ReportAlertRow
} from './types'
import { fmtDateTime, fmtMetric, OPERATOR_LABELS } from './types'

/**
 * AlertManagerView — the full EFP /alerts surface as a headless shared
 * component over the nivaro metric-alert engine:
 *
 *   Catalog · Rules · My Subscriptions · Alert History ·
 *   Widget Alerts · Widget Alert History · Anomaly Rules · Anomaly History
 *
 * Host requirements: NivaroProvider + QueryClientProvider.
 */

const CATEGORY_COLORS: Record<string, string> = {
  budget: 'bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400',
  workflows: 'bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-400',
  inventory: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
  sla: 'bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-400',
  compliance: 'bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400',
  spend: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400'
}
const categoryChip = (category: string) =>
  cn(
    'inline-flex rounded-full px-2 py-px text-[10.5px] font-semibold capitalize',
    CATEGORY_COLORS[category] ?? 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-slate-300'
  )

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
    resolved: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
    paused: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
    acknowledged: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
    firing: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
    new: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
    archived: 'bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-400'
  }
  return (
    <span
      className={cn(
        'inline-flex rounded-full px-2 py-px text-[10.5px] font-semibold capitalize',
        map[status] ?? 'bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-400'
      )}
    >
      {status}
    </span>
  )
}

function CountBadge({ n, tone }: { n: number; tone?: 'red' | 'cyan' | 'violet' | 'teal' }) {
  if (!n) return null
  const tones: Record<string, string> = {
    red: 'bg-red-500 text-white',
    cyan: 'bg-nvr-cyan text-white',
    violet: 'bg-violet-500 text-white',
    teal: 'bg-teal-500 text-white'
  }
  return (
    <span
      className={cn(
        'ml-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 py-px text-[10px] font-bold',
        tones[tone ?? 'cyan']
      )}
    >
      {n}
    </span>
  )
}

const thCls =
  'px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500'
const tdCls = 'px-3 py-2.5 align-middle text-[12px] text-slate-600 dark:text-slate-300'
// Machine values (thresholds, metrics, multipliers) go mono and near-ink: they
// are what an operator actually reads a row for, so they outrank the prose.
const tdNum = cn(tdCls, 'font-mono tabular-nums text-slate-800 dark:text-slate-100')
const iconBtn =
  'inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 text-slate-400 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-700 dark:border-border dark:hover:bg-muted/50 dark:hover:text-slate-200'

/** Relative distance, but only while it still adds information. The shared
 *  formatRelative() falls back to a formatted date past a week, which would
 *  just restate the absolute line above it — return null instead. */
function fmtRelative(value: string): string | null {
  const diff = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(diff)) return null
  const mins = Math.floor(diff / 60000)
  if (mins < 0) return null
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return null
}

/** How long an episode stayed bad. A fired-at and a resolved-at in separate
 *  columns make the reader subtract; the duration is the actual finding. */
function fmtDuration(from: string, to: string): string | null {
  const ms = new Date(to).getTime() - new Date(from).getTime()
  if (!Number.isFinite(ms) || ms <= 0) return null
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 48) return `${hrs}h`
  return `${Math.round(hrs / 24)}d`
}

/** Absolute timestamp with the relative distance underneath — "when" is the
 *  question, but "how long ago" is the one being asked. */
function TimeCell({ value, className }: { value?: string | null; className?: string }) {
  if (!value) return <span className='text-slate-300 dark:text-slate-600'>—</span>
  const rel = fmtRelative(value)
  return (
    <span className={cn('block leading-tight', className)}>
      <span className='block whitespace-nowrap text-[11.5px] text-slate-600 dark:text-slate-300'>
        {fmtDateTime(value)}
      </span>
      {rel && <span className='block text-[10.5px] text-slate-500 dark:text-slate-400'>{rel}</span>}
    </span>
  )
}

/** A measured value against the bar it had to clear. Reading them as one unit
 *  is the point — a bare "6" in one column and "≥3" three columns away makes
 *  the reader do the comparison themselves. */
function MetricVsThreshold({
  value,
  threshold,
  unit,
  operator,
  breaching
}: {
  value: number
  threshold: number
  unit?: string | null
  operator?: string
  breaching?: boolean
}) {
  return (
    <span className='flex items-baseline gap-1.5 font-mono tabular-nums'>
      <span
        className={cn(
          'text-[12.5px] font-semibold',
          breaching ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-slate-100'
        )}
      >
        {fmtMetric(value, unit ?? undefined)}
      </span>
      <span className='text-[10.5px] text-slate-400 dark:text-slate-500'>
        {operator ? `${OPERATOR_LABELS[operator] ?? operator} ` : '/ '}
        {fmtMetric(threshold, unit ?? undefined)}
      </span>
    </span>
  )
}

/** Threshold as a condition chip — the rule's whole definition in one token. */
function ConditionChip({
  operator,
  threshold,
  unit
}: {
  operator: string
  threshold: number
  unit?: string | null
}) {
  return (
    <span className='inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11.5px] tabular-nums text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-200'>
      <span className='text-slate-400 dark:text-slate-500'>
        {OPERATOR_LABELS[operator] ?? operator}
      </span>
      {fmtMetric(threshold, unit ?? undefined)}
    </span>
  )
}

/** Two lines by default, full text on demand. Long-form reasoning inside a
 *  table row is otherwise either a wall or a lie (truncated mid-sentence). */
function ExpandableText({ text }: { text?: string | null }) {
  const [open, setOpen] = useState(false)
  if (!text) return <span className='text-slate-300 dark:text-slate-600'>—</span>
  const long = text.length > 120
  return (
    <span className='block'>
      <span
        className={cn(
          'block text-[11.5px] leading-relaxed text-slate-600 dark:text-slate-400',
          !open && 'line-clamp-2'
        )}
      >
        {text}
      </span>
      {long && (
        <button
          type='button'
          onClick={() => setOpen((o) => !o)}
          className='mt-0.5 text-[11px] font-medium text-slate-400 underline decoration-slate-300 underline-offset-2 transition-colors hover:text-slate-600 dark:hover:text-slate-200'
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </span>
  )
}

function TableFrame({
  title,
  hint,
  action,
  wide,
  children
}: {
  title: string
  hint?: string
  action?: React.ReactNode
  /** For tables carrying a prose column that genuinely wants the room. */
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    // Capped and LEFT-aligned, never centred: six columns of short data on a
    // 1700px viewport left the first column absorbing ~1100px of dead space,
    // which read as a broken layout rather than a spacious one.
    <section
      className={cn('flex min-h-0 flex-col gap-2', wide ? 'max-w-[1560px]' : 'max-w-[1180px]')}
    >
      <header className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1'>
        <div className='flex items-baseline gap-2.5'>
          <h2 className='text-[13.5px] font-semibold text-slate-800 dark:text-slate-100'>{title}</h2>
          {hint && <p className='text-[11.5px] text-slate-400 dark:text-slate-500'>{hint}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

function DataTable({
  headers,
  children,
  empty,
  emptyHint,
  emptyIcon,
  emptyAction,
  loading
}: {
  headers: Array<string | { label: string; width?: number; align?: 'right' }>
  children: React.ReactNode
  empty: string
  emptyHint?: string
  emptyIcon?: React.ReactNode
  emptyAction?: React.ReactNode
  loading?: boolean
}) {
  const isEmpty = !loading && (!children || (Array.isArray(children) && children.length === 0))
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='overflow-x-auto'>
        <table className='w-full border-collapse'>
          <thead className='border-b border-slate-200 bg-slate-50/80 dark:border-border dark:bg-muted/30'>
            <tr>
              {headers.map((h, i) => {
                const label = typeof h === 'string' ? h : h.label
                const width = typeof h === 'string' ? undefined : h.width
                const align = typeof h === 'string' ? undefined : h.align
                return (
                  <th
                    key={`${label}-${i}`}
                    className={cn(thCls, align === 'right' && 'text-right')}
                    style={width ? { width } : undefined}
                  >
                    {label}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-100 dark:divide-border/50'>
            {loading ? (
              Array.from({ length: 5 }, (_, i) => (
                <tr key={i}>
                  <td className='px-3 py-3' colSpan={headers.length}>
                    <span
                      className='block h-3 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]'
                      style={{ width: `${45 + ((i * 19) % 45)}%` }}
                    />
                  </td>
                </tr>
              ))
            ) : isEmpty ? (
              <tr>
                <td className='px-3 py-14' colSpan={headers.length}>
                  {/* Empty states teach the surface rather than announcing absence. */}
                  <div className='mx-auto flex max-w-sm flex-col items-center gap-2 text-center'>
                    {emptyIcon && (
                      <span className='text-slate-300 dark:text-slate-600'>{emptyIcon}</span>
                    )}
                    <p className='text-[13px] font-medium text-slate-600 dark:text-slate-300'>
                      {empty}
                    </p>
                    {emptyHint && (
                      <p className='text-[12px] leading-relaxed text-slate-400 dark:text-slate-500'>
                        {emptyHint}
                      </p>
                    )}
                    {emptyAction && <div className='mt-1'>{emptyAction}</div>}
                  </div>
                </td>
              </tr>
            ) : (
              children
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

type TabKey =
  | 'catalog'
  | 'rules'
  | 'subscriptions'
  | 'history'
  | 'widget_alerts'
  | 'widget_alert_history'
  | 'anomaly_rules'
  | 'anomaly_history'

export interface AlertManagerViewProps {
  /** Tab shown on first render. */
  defaultTab?: TabKey
  /** Hide specific tabs (e.g. widget tabs when Report Studio is unused). */
  hiddenTabs?: TabKey[]
  /** Called when a widget alert's report name is clicked (host navigation). */
  onOpenReport?: (reportId: string) => void
  className?: string
}

export function AlertManagerView({
  defaultTab = 'catalog',
  hiddenTabs = [],
  onOpenReport,
  className
}: AlertManagerViewProps) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { scopes } = useMyScopes()
  const [tab, setTab] = useState<TabKey>(defaultTab)
  const [flash, setFlash] = useState<string | null>(null)
  const note = (msg: string) => {
    setFlash(msg)
    window.setTimeout(() => setFlash(null), 2500)
  }

  const raw = <T,>(method: string, path: string, body?: unknown) =>
    client.request({ _method: method, _path: path, _body: body } as never) as Promise<T>

  // ── Data ────────────────────────────────────────────────────────────────────

  const { data: me } = useQuery({
    queryKey: ['nvr-ma-me'],
    queryFn: () =>
      raw<{ data: { id: string; is_admin?: boolean } }>('GET', '/auth/me').then((r) => r.data)
  })
  const uid = String(me?.id ?? '').toLowerCase()
  const isAdmin = !!me?.is_admin

  const invalidate = (...keys: string[]) => {
    for (const k of keys) void qc.invalidateQueries({ queryKey: [k] })
  }

  const { data: definitions = [], isLoading: loadingDefs } = useQuery({
    queryKey: ['nvr-ma-definitions'],
    queryFn: () =>
      raw<{ data: MetricDefinition[] }>('GET', '/metric-alerts/definitions').then((r) => r.data)
  })
  const { data: rules = [], isLoading: loadingRules } = useQuery({
    queryKey: ['nvr-ma-rules'],
    queryFn: () => raw<{ data: MetricAlertRule[] }>('GET', '/metric-alerts/rules').then((r) => r.data)
  })
  const { data: subscriptions = [], isLoading: loadingSubs } = useQuery({
    queryKey: ['nvr-ma-subs'],
    queryFn: () =>
      raw<{ data: MetricAlertSubscription[] }>('GET', '/metric-alerts/subscriptions').then(
        (r) => r.data
      )
  })
  const { data: logEntries = [], isLoading: loadingLog } = useQuery({
    queryKey: ['nvr-ma-log'],
    queryFn: () =>
      raw<{ data: MetricAlertLogEntry[] }>('GET', '/metric-alerts/log?limit=100').then((r) => r.data)
  })
  // Record/workflow event subscriptions (nivaro_notification_subscriptions) —
  // a SEPARATE system from metric-alert rule subscriptions; surfaced together
  // under My Subscriptions so all "what notifies me" lives in one tab.
  interface NotifSubRow {
    id: number
    label: string | null
    collection: string | null
    event_type: string
    digest_frequency: string | null
    is_active: boolean
    filter_field?: string | null
    filter_value?: string | null
    filters?: Array<{ field: string; op?: string; value?: unknown }> | null
    queue_id?: string | null
  }
  const { data: notifSubs = [], isLoading: loadingNotifSubs } = useQuery({
    queryKey: ['nvr-ma-notif-subs'],
    queryFn: () =>
      client
        .request(listNotificationSubscriptions())
        .then((r) => (r as { data: NotifSubRow[] }).data)
  })
  const patchNotifSub = useMutation({
    // Raw PATCH — the route accepts label/filter_field/filter_value/filters/
    // digest_frequency/is_active; the typed SDK command covers a subset.
    mutationFn: ({ id, patch: p }: { id: number; patch: Record<string, unknown> }) =>
      raw('PATCH', `/notification-subscriptions/${id}`, p),
    onSuccess: () => invalidate('nvr-ma-notif-subs')
  })
  const removeNotifSub = useMutation({
    mutationFn: (id: number) => client.request(deleteNotificationSubscription(id)),
    onSuccess: () => invalidate('nvr-ma-notif-subs')
  })
  const widgetTabsHidden = hiddenTabs.includes('widget_alerts')
  const { data: reportAlerts = [], isLoading: loadingReportAlerts } = useQuery({
    queryKey: ['nvr-ma-report-alerts'],
    enabled: !widgetTabsHidden,
    queryFn: () =>
      raw<{ data: ReportAlertRow[] }>('GET', '/metric-alerts/report-alerts').then((r) => r.data)
  })
  const { data: reportAlertLog = [], isLoading: loadingReportLog } = useQuery({
    queryKey: ['nvr-ma-report-alerts-log'],
    enabled: !hiddenTabs.includes('widget_alert_history'),
    queryFn: () =>
      raw<{ data: ReportAlertLogRow[] }>('GET', '/metric-alerts/report-alerts-log').then(
        (r) => r.data
      )
  })
  const { data: anomalyDefinitions = [] } = useQuery({
    queryKey: ['nvr-ma-anomaly-defs'],
    queryFn: () =>
      raw<{ data: AnomalyDefinition[] }>('GET', '/metric-alerts/anomaly-definitions').then(
        (r) => r.data
      )
  })
  const { data: anomalyRules = [], isLoading: loadingAnomalyRules } = useQuery({
    queryKey: ['nvr-ma-anomaly-rules'],
    queryFn: () =>
      raw<{ data: AnomalyRule[] }>('GET', '/metric-alerts/anomaly-rules').then((r) => r.data)
  })
  const { data: anomalyLog = [], isLoading: loadingAnomalyLog } = useQuery({
    queryKey: ['nvr-ma-anomaly-log'],
    queryFn: () =>
      raw<{ data: AnomalyLogEntry[] }>('GET', '/metric-alerts/anomaly-log').then((r) => r.data)
  })

  // ── Drawer state ────────────────────────────────────────────────────────────

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editRule, setEditRule] = useState<MetricAlertRule | null>(null)
  const [preselectedDefId, setPreselectedDefId] = useState<number | null>(null)
  const [anomalyDrawerOpen, setAnomalyDrawerOpen] = useState(false)
  const [editAnomalyRule, setEditAnomalyRule] = useState<AnomalyRule | null>(null)
  const [editNotifSub, setEditNotifSub] = useState<NotifSubRow | null>(null)
  const [saving, setSaving] = useState(false)

  // ── Subscription helpers ────────────────────────────────────────────────────

  const mySubByRule = useMemo(
    () => Object.fromEntries(subscriptions.map((s) => [s.rule_id, s])),
    [subscriptions]
  )

  /** The currently-open firing row per rule. The engine keeps at most one
   *  (that open row IS the cooldown), so this is the rule's live state. */
  const openLogByRule = useMemo(() => {
    const map: Record<number, MetricAlertLogEntry> = {}
    for (const e of logEntries) {
      if (e.status === 'firing' && !e.resolved_at) map[e.rule_id] = e
    }
    return map
  }, [logEntries])
  const openAnomalyCount = useMemo(
    () => anomalyLog.filter((a) => a.status !== 'resolved').length,
    [anomalyLog]
  )

  const toggleSubscription = async (rule: MetricAlertRule) => {
    const existing = mySubByRule[rule.id]
    try {
      if (existing) {
        await raw('DELETE', `/metric-alerts/subscriptions/${existing.id}`)
        note('Unsubscribed from alert')
      } else {
        await raw('POST', '/metric-alerts/subscriptions', { rule_id: rule.id })
        note('Subscribed to alert')
      }
      invalidate('nvr-ma-subs')
    } catch {
      note('Failed to update subscription')
    }
  }

  const updateSubscription = async (id: number, patch: Record<string, unknown>) => {
    try {
      await raw('PATCH', `/metric-alerts/subscriptions/${id}`, patch)
      invalidate('nvr-ma-subs')
    } catch {
      note('Failed to update subscription')
    }
  }

  // ── Rule CRUD ───────────────────────────────────────────────────────────────

  const saveRule = async (values: Record<string, unknown>) => {
    setSaving(true)
    try {
      if (editRule) {
        await raw('PATCH', `/metric-alerts/rules/${editRule.id}`, values)
        note('Alert rule updated')
      } else {
        // EFP parity: merge the user's restricted visibility into the rule's
        // scope for any supported filter left blank, so the backend evaluates
        // metrics only within what the user can see.
        const def = definitions.find((d) => d.id === values.definition_id)
        const filters = { ...((values.filters as Record<string, Array<string | number>>) ?? {}) }
        for (const spec of def?.supported_filters ?? []) {
          if (filters[spec.key]?.length) continue
          const dim = matchScopeDimension(scopes, { key: spec.key, collection: spec.collection })
          if (!dim) continue
          const restricted = scopes?.restricted?.[dim.name]
          if (!restricted?.length) continue
          const seeded = effectiveScopeSeedIds(scopes!, dim.name)
          const ids = seeded.length ? seeded : restricted
          filters[spec.key] = await translateScopeValues(
            client as unknown as { request: (c: unknown) => Promise<unknown> },
            dim,
            ids,
            spec.value_field
          )
        }
        await raw('POST', '/metric-alerts/rules', { ...values, filters })
        note('Alert rule created')
      }
      setDrawerOpen(false)
      invalidate('nvr-ma-rules', 'nvr-ma-subs')
    } catch {
      note('Failed to save rule')
    } finally {
      setSaving(false)
    }
  }

  const deleteRule = async (rule: MetricAlertRule) => {
    if (!window.confirm(`Delete rule "${rule.name}"? This removes the rule and all subscriptions.`))
      return
    try {
      await raw('DELETE', `/metric-alerts/rules/${rule.id}`)
      note('Alert rule deleted')
      invalidate('nvr-ma-rules', 'nvr-ma-subs', 'nvr-ma-log')
    } catch {
      note('Failed to delete rule')
    }
  }

  // ── Anomaly CRUD ────────────────────────────────────────────────────────────

  const saveAnomalyRule = async (values: Record<string, unknown>) => {
    setSaving(true)
    try {
      if (editAnomalyRule) {
        await raw('PATCH', `/metric-alerts/anomaly-rules/${editAnomalyRule.id}`, values)
        note('Anomaly rule updated')
      } else {
        await raw('POST', '/metric-alerts/anomaly-rules', values)
        note('Anomaly rule created')
      }
      setAnomalyDrawerOpen(false)
      setEditAnomalyRule(null)
      invalidate('nvr-ma-anomaly-rules')
    } catch {
      note('Failed to save anomaly rule')
    } finally {
      setSaving(false)
    }
  }

  const deleteAnomalyRule = async (rule: AnomalyRule) => {
    if (!window.confirm(`Delete anomaly rule "${rule.name}"? Its log entries are also removed.`))
      return
    try {
      await raw('DELETE', `/metric-alerts/anomaly-rules/${rule.id}`)
      note('Anomaly rule deleted')
      invalidate('nvr-ma-anomaly-rules', 'nvr-ma-anomaly-log')
    } catch {
      note('Failed to delete anomaly rule')
    }
  }

  const patchAnomalyRule = async (id: number, patch: Record<string, unknown>) => {
    try {
      await raw('PATCH', `/metric-alerts/anomaly-rules/${id}`, patch)
      invalidate('nvr-ma-anomaly-rules')
    } catch {
      note('Failed to update anomaly rule')
    }
  }

  const updateAnomalyLogStatus = async (id: number, status: 'acknowledged' | 'resolved') => {
    try {
      await raw('PATCH', `/metric-alerts/anomaly-log/${id}`, { status })
      invalidate('nvr-ma-anomaly-log')
    } catch {
      note('Failed to update anomaly')
    }
  }

  // ── Report (widget) alert handlers ──────────────────────────────────────────

  const patchReportAlert = async (row: ReportAlertRow, patch: Record<string, unknown>) => {
    try {
      await raw('PATCH', `/report-studio/${row.report}/alerts/${row.id}`, patch)
      invalidate('nvr-ma-report-alerts')
    } catch {
      note('Failed to update widget alert')
    }
  }

  const deleteReportAlert = async (row: ReportAlertRow) => {
    if (!window.confirm(`Delete widget alert "${row.name}"?`)) return
    try {
      await raw('DELETE', `/report-studio/${row.report}/alerts/${row.id}`)
      note('Widget alert deleted')
      invalidate('nvr-ma-report-alerts', 'nvr-ma-report-alerts-log')
    } catch {
      note('Failed to delete widget alert')
    }
  }

  const resolveReportAlertLog = useMutation({
    mutationFn: (row: ReportAlertLogRow) =>
      raw('POST', `/report-studio/${row.report_id}/alerts/${row.alert}/resolve`),
    onSuccess: () => invalidate('nvr-ma-report-alerts-log', 'nvr-ma-report-alerts')
  })

  // ── Derived ─────────────────────────────────────────────────────────────────

  const defsByCategory = useMemo(() => {
    const map = new Map<string, MetricDefinition[]>()
    for (const def of definitions) {
      if (!map.has(def.category)) map.set(def.category, [])
      map.get(def.category)!.push(def)
    }
    return map
  }, [definitions])

  const firingCount = logEntries.filter((e) => e.status === 'firing').length
  const widgetFiringCount = reportAlertLog.filter((e) => e.status === 'firing').length
  const activeAnomalyRules = anomalyRules.filter((r) => r.status === 'active').length
  const newAnomalies = anomalyLog.filter((e) => e.status === 'new').length

  const tabs: Array<{ key: TabKey; label: string; icon: React.ReactNode; badge?: React.ReactNode }> =
    [
      { key: 'catalog', label: 'Alert Catalog', icon: <LayoutGrid className='h-3.5 w-3.5' /> },
      { key: 'rules', label: 'Alert Rules', icon: <Bell className='h-3.5 w-3.5' /> },
      {
        key: 'subscriptions',
        label: 'My Subscriptions',
        icon: <BellRing className='h-3.5 w-3.5' />,
        badge: <CountBadge n={subscriptions.length + notifSubs.length} tone='cyan' />
      },
      {
        key: 'history',
        label: 'Alert History',
        icon: <Clock className='h-3.5 w-3.5' />,
        badge: <CountBadge n={firingCount} tone='red' />
      },
      {
        key: 'widget_alerts',
        label: 'Widget Alerts',
        icon: <ChartColumn className='h-3.5 w-3.5' />,
        badge: <CountBadge n={reportAlerts.length} tone='violet' />
      },
      {
        key: 'widget_alert_history',
        label: 'Widget Alert History',
        icon: <History className='h-3.5 w-3.5' />,
        badge: <CountBadge n={widgetFiringCount} tone='red' />
      },
      {
        key: 'anomaly_rules',
        label: 'Anomaly Rules',
        icon: <FlaskConical className='h-3.5 w-3.5' />,
        badge: <CountBadge n={activeAnomalyRules} tone='teal' />
      },
      {
        key: 'anomaly_history',
        label: 'Anomaly History',
        icon: <Activity className='h-3.5 w-3.5' />,
        badge: <CountBadge n={newAnomalies} tone='red' />
      }
    ]
  const visibleTabs = tabs.filter((t) => !hiddenTabs.includes(t.key))

  const openCreateDrawer = (defId?: number) => {
    setEditRule(null)
    setPreselectedDefId(defId ?? null)
    setDrawerOpen(true)
  }

  const canEditRule = (createdBy: string | null) =>
    isAdmin || (createdBy != null && String(createdBy).toLowerCase() === uid)

  const toolbarBtn =
    'inline-flex h-7 items-center gap-1.5 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-semibold text-white hover:opacity-90'

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className={cn('flex flex-col gap-3', className)} data-alert-manager=''>
      {flash && (
        <div className='fixed right-4 top-4 z-[60] rounded-md bg-slate-900 px-3 py-2 text-[12.5px] text-white shadow-lg dark:bg-slate-100 dark:text-slate-900'>
          {flash}
        </div>
      )}

      {/* Tab bar */}
      <div className='flex flex-wrap gap-1 border-b border-slate-200 pb-px dark:border-border' data-alert-tabs=''>
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            type='button'
            onClick={() => setTab(t.key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-[12.5px] transition-colors',
              tab === t.key
                ? 'border-nvr-cyan font-semibold text-nvr-navy dark:text-nvr-cyan'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
            )}
          >
            {t.icon}
            {t.label}
            {t.badge}
          </button>
        ))}
      </div>

      {/* ── Catalog ── */}
      {tab === 'catalog' && loadingDefs && (
        <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
            >
              <span className='block h-3.5 w-2/5 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
              <span className='mt-2 block h-3 w-4/5 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
              <span className='mt-2 block h-2.5 w-1/3 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
            </div>
          ))}
        </div>
      )}
      {tab === 'catalog' && !loadingDefs && definitions.length > 0 && (
        // One continuous list, not a card grid: the old layout repeated an
        // identical box (and an identical saturated button) fourteen times,
        // and its per-category grids left orphan holes on odd counts. Rows
        // also make room for the fact that actually matters here — whether
        // this metric is already being watched.
        <section className='max-w-[1180px] overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          {[...defsByCategory.entries()].map(([category, defs], gi) => (
            <div key={category}>
              <div
                className={cn(
                  'flex items-center gap-2 bg-slate-50/80 px-3 py-1.5 dark:bg-muted/30',
                  gi > 0 && 'border-t border-slate-200 dark:border-border'
                )}
              >
                <span className={categoryChip(category)}>{category}</span>
                <span className='text-[11px] text-slate-400 dark:text-slate-500'>
                  {defs.length} metric{defs.length !== 1 ? 's' : ''}
                </span>
              </div>
              <ul className='divide-y divide-slate-100 dark:divide-border/50'>
                {defs.map((def) => {
                  const watching = rules.filter((r) => r.definition_id === def.id).length
                  return (
                    <li
                      key={def.id}
                      className='group flex items-center gap-4 px-3 py-2.5 transition-colors hover:bg-slate-50/70 dark:hover:bg-muted/25'
                    >
                      <div className='min-w-0 flex-1'>
                        <div className='flex items-center gap-2'>
                          <p className='truncate text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                            {def.name}
                          </p>
                          {watching > 0 && (
                            <span className='inline-flex shrink-0 items-center gap-1 rounded-full bg-[#00ceff1a] px-1.5 py-px text-[10px] font-semibold text-nvr-navy dark:text-nvr-cyan'>
                              <BellRing className='h-2.5 w-2.5' />
                              {watching}
                            </span>
                          )}
                        </div>
                        {def.description && (
                          <p className='truncate text-[11.5px] text-slate-500 dark:text-slate-400'>
                            {def.description}
                          </p>
                        )}
                      </div>
                      <div className='hidden shrink-0 items-baseline gap-1.5 font-mono text-[11.5px] tabular-nums text-slate-500 dark:text-slate-400 sm:flex'>
                        <span className='text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500'>
                          {def.unit}
                        </span>
                        <span className='text-slate-300 dark:text-slate-600'>·</span>
                        <span>
                          {OPERATOR_LABELS[def.default_operator] ?? def.default_operator}{' '}
                          {def.default_threshold != null
                            ? fmtMetric(def.default_threshold, def.unit)
                            : '—'}
                        </span>
                      </div>
                      {/* Quiet until intent: fourteen saturated buttons made
                          none of them read as the primary action. */}
                      <button
                        type='button'
                        className='inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 text-[12px] font-medium text-slate-600 transition-colors hover:border-nvr-cyan hover:bg-[#00ceff14] hover:text-nvr-navy dark:border-border dark:text-slate-300 dark:hover:text-nvr-cyan'
                        onClick={() => {
                          openCreateDrawer(def.id)
                          setTab('rules')
                        }}
                      >
                        <Plus className='h-3 w-3' /> Rule
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </section>
      )}
      {tab === 'catalog' && !loadingDefs && definitions.length === 0 && (
        <div className='rounded-lg border border-slate-200 bg-white py-16 dark:border-border dark:bg-card'>
          <div className='mx-auto flex max-w-sm flex-col items-center gap-2 text-center'>
            <Gauge className='h-5 w-5 text-slate-300 dark:text-slate-600' />
            <p className='text-[13px] font-medium text-slate-600 dark:text-slate-300'>
              No metrics in the catalog yet
            </p>
            <p className='text-[12px] leading-relaxed text-slate-400 dark:text-slate-500'>
              Metric definitions describe what can be measured — once an admin adds them, you can
              build alert rules on top.
            </p>
          </div>
        </div>
      )}

      {/* ── Rules ── */}
      {tab === 'rules' && (
        <TableFrame
          title='Alert rules'
          hint={`${rules.length} rule${rules.length === 1 ? '' : 's'} · shared and personal`}
          action={
            <button type='button' className={toolbarBtn} onClick={() => openCreateDrawer()}>
              <Plus className='h-3 w-3' /> New rule
            </button>
          }
        >
          <DataTable
            headers={[
              'Rule',
              { label: 'Condition', width: 130 },
              { label: 'State', width: 150 },
              { label: 'Checks', width: 92 },
              { label: 'Visibility', width: 96 },
              { label: 'Actions', width: 116, align: 'right' }
            ]}
            empty='No alert rules yet'
            emptyHint='Pick a metric from the catalog and set the threshold that should page you.'
            emptyIcon={<Siren className='h-5 w-5' />}
            emptyAction={
              <button type='button' className={toolbarBtn} onClick={() => setTab('catalog')}>
                <LayoutGrid className='h-3 w-3' /> Browse catalog
              </button>
            }
            loading={loadingRules}
          >
            {rules.map((rule) => {
              const subscribed = !!mySubByRule[rule.id]
              const own = canEditRule(rule.created_by)
              // The open firing row IS the rule's live state — the data was
              // already loaded for the history tab, and a rules table that
              // can't say "this one is going off right now" is just a config
              // dump.
              const open = openLogByRule[rule.id]
              const paused = rule.status !== 'active'
              return (
                <tr
                  key={rule.id}
                  className={cn(
                    'transition-colors hover:bg-slate-50/70 dark:hover:bg-muted/25',
                    paused && 'opacity-60'
                  )}
                >
                  <td className={tdCls}>
                    <p className='font-medium text-slate-800 dark:text-slate-100'>{rule.name}</p>
                    {rule.definition && (
                      <p className='text-[11px] text-slate-500 dark:text-slate-400'>
                        {rule.definition.name}
                      </p>
                    )}
                  </td>
                  <td className={tdCls}>
                    <ConditionChip
                      operator={rule.operator}
                      threshold={rule.threshold_value}
                      unit={rule.definition?.unit}
                    />
                  </td>
                  <td className={tdCls}>
                    {paused ? (
                      <StatusBadge status={rule.status} />
                    ) : open ? (
                      <span className='flex flex-col gap-0.5'>
                        <span className='inline-flex w-fit items-center gap-1.5 rounded-full bg-red-50 px-2 py-px text-[10.5px] font-semibold text-red-600 dark:bg-red-500/10 dark:text-red-400'>
                          <span
                            aria-hidden
                            className='h-1.5 w-1.5 rounded-full bg-red-500 motion-safe:animate-pulse'
                          />
                          Firing
                        </span>
                        <span className='font-mono text-[10.5px] tabular-nums text-slate-500 dark:text-slate-400'>
                          {fmtMetric(open.metric_value, rule.definition?.unit)}
                          {fmtRelative(open.fired_at) ? ` · ${fmtRelative(open.fired_at)}` : ''}
                        </span>
                      </span>
                    ) : (
                      <span className='inline-flex items-center gap-1.5 text-[11.5px] text-slate-500 dark:text-slate-400'>
                        <span
                          aria-hidden
                          className='h-1.5 w-1.5 rounded-full bg-emerald-500/70'
                        />
                        Within threshold
                      </span>
                    )}
                  </td>
                  <td className={cn(tdCls, 'capitalize text-slate-500 dark:text-slate-400')}>
                    {rule.check_frequency}
                  </td>
                  <td className={tdCls}>
                    {rule.is_shared ? (
                      <span className='inline-flex items-center gap-1 text-[11.5px] text-slate-500 dark:text-slate-400'>
                        <Users className='h-3 w-3' /> Team
                      </span>
                    ) : (
                      <span className='inline-flex items-center gap-1 text-[11.5px] text-slate-400 dark:text-slate-500'>
                        <Lock className='h-3 w-3' /> Private
                      </span>
                    )}
                  </td>
                  <td className={tdCls}>
                    <div className='flex items-center justify-end gap-1'>
                      <button
                        type='button'
                        title={subscribed ? 'Unsubscribe from this rule' : 'Subscribe to this rule'}
                        aria-pressed={subscribed}
                        onClick={() => toggleSubscription(rule)}
                        className={cn(
                          iconBtn,
                          subscribed &&
                            'border-nvr-cyan bg-[#00ceff1a] text-nvr-navy hover:bg-[#00ceff26] dark:text-nvr-cyan'
                        )}
                      >
                        {subscribed ? (
                          <BellRing className='h-3.5 w-3.5' />
                        ) : (
                          <Bell className='h-3.5 w-3.5' />
                        )}
                      </button>
                      {own && (
                        <>
                          <button
                            type='button'
                            title='Edit rule'
                            className={iconBtn}
                            onClick={() => {
                              setEditRule(rule)
                              setPreselectedDefId(null)
                              setDrawerOpen(true)
                            }}
                          >
                            <Pencil className='h-3.5 w-3.5' />
                          </button>
                          <button
                            type='button'
                            title='Delete rule'
                            className={cn(
                              iconBtn,
                              'hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400'
                            )}
                            onClick={() => deleteRule(rule)}
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </DataTable>
        </TableFrame>
      )}

      {/* ── My Subscriptions ── */}
      {tab === 'subscriptions' && (
        <div className='space-y-2'>
          <p className='text-[12px] text-slate-400'>Manage how you receive alert notifications</p>
          <DataTable
            headers={[
              'Alert Rule',
              { label: 'In-App', width: 70 },
              { label: 'Email', width: 70 },
              { label: 'Digest', width: 120 },
              { label: 'Last Notified', width: 170 },
              { label: 'Status', width: 90 },
              { label: '', width: 40 }
            ]}
            empty='No subscriptions yet — browse the Alert Catalog or Rules tab to subscribe'
            loading={loadingSubs}
          >
            {subscriptions.map((sub) => (
              <tr key={sub.id} className='hover:bg-slate-50/60 dark:hover:bg-muted/30'>
                <td className={tdCls}>
                  <p className='font-medium text-slate-800 dark:text-slate-100'>
                    {sub.rule_name ?? `Rule #${sub.rule_id}`}
                  </p>
                  {sub.definition_name && (
                    <p className='text-[11px] text-slate-400'>{sub.definition_name}</p>
                  )}
                </td>
                <td className={tdCls}>
                  <ToggleSwitch
                    checked={!!sub.delivery_in_app}
                    onChange={(v) => updateSubscription(sub.id, { delivery_in_app: v })}
                  />
                </td>
                <td className={tdCls}>
                  <ToggleSwitch
                    checked={!!sub.delivery_email}
                    onChange={(v) => updateSubscription(sub.id, { delivery_email: v })}
                  />
                </td>
                <td className={tdCls}>
                  <SelectInput
                    value={String(sub.digest_frequency)}
                    onChange={(v) => updateSubscription(sub.id, { digest_frequency: v })}
                    options={[
                      { label: 'Immediate', value: 'immediate' },
                      { label: 'Daily', value: 'daily' },
                      { label: 'Weekly', value: 'weekly' }
                    ]}
                    className='h-7 w-[105px] text-[11.5px]'
                  />
                </td>
                <td className={cn(tdCls, 'text-[11.5px] text-slate-400')}>
                  {fmtDateTime(sub.last_notified)}
                </td>
                <td className={tdCls}>
                  <StatusBadge status={sub.status} />
                </td>
                <td className={tdCls}>
                  <button
                    type='button'
                    title='Unsubscribe'
                    className={cn(iconBtn, 'hover:border-red-300 hover:text-red-500')}
                    onClick={async () => {
                      if (!window.confirm('Unsubscribe from this alert?')) return
                      await raw('DELETE', `/metric-alerts/subscriptions/${sub.id}`)
                      invalidate('nvr-ma-subs')
                    }}
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </button>
                </td>
              </tr>
            ))}
          </DataTable>

          {/* Record/workflow event notifications — the OTHER subscription
              system (nivaro_notification_subscriptions), managed here too so
              everything that notifies you lives in one place. */}
          <p className='pt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
            Record &amp; workflow notifications
          </p>
          <p className='text-[12px] text-slate-400'>
            Subscriptions to record events and workflow state changes (created from records,
            queues, or notification settings)
          </p>
          <DataTable
            headers={[
              'Subscription',
              { label: 'Event', width: 150 },
              { label: 'Digest', width: 120 },
              { label: 'Active', width: 70 },
              { label: '', width: 80 }
            ]}
            empty='No record notifications yet — subscribe from a record, queue, or workflow'
            loading={loadingNotifSubs}
          >
            {notifSubs.map((s) => (
              <tr key={s.id} className='hover:bg-slate-50/60 dark:hover:bg-muted/30'>
                <td className={tdCls}>
                  <p className='font-medium text-slate-800 dark:text-slate-100'>
                    {s.label || (s.collection ? s.collection.replace(/_/g, ' ') : 'Queue digest')}
                  </p>
                  <div className='mt-0.5 flex flex-wrap items-center gap-1'>
                    {s.collection && (
                      <span className='inline-flex rounded bg-slate-100 px-1.5 py-px font-mono text-[10.5px] text-slate-500 dark:bg-muted dark:text-slate-400'>
                        {s.collection}
                      </span>
                    )}
                    {s.queue_id && (
                      <span className='inline-flex rounded bg-slate-100 px-1.5 py-px text-[10.5px] text-slate-500 dark:bg-muted dark:text-slate-400'>
                        queue digest
                      </span>
                    )}
                    {s.filter_field && (
                      <span className='inline-flex rounded bg-[#00ceff1a] px-1.5 py-px text-[10.5px] text-slate-600 dark:text-slate-300'>
                        {s.filter_field === 'to_state' ? 'state' : s.filter_field} ={' '}
                        {s.filter_value ?? 'any'}
                      </span>
                    )}
                    {(s.filters ?? []).map((f, i) => (
                      <span
                        key={`${f.field}-${i}`}
                        className='inline-flex rounded bg-[#00ceff1a] px-1.5 py-px text-[10.5px] text-slate-600 dark:text-slate-300'
                      >
                        {f.field} {f.op ?? 'eq'}{' '}
                        {Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '')}
                      </span>
                    ))}
                  </div>
                </td>
                <td className={cn(tdCls, 'capitalize')}>
                  {String(s.event_type).replace(/_/g, ' ')}
                </td>
                <td className={tdCls}>
                  <SelectInput
                    value={String(s.digest_frequency ?? 'instant')}
                    onChange={(v) =>
                      patchNotifSub.mutate({ id: s.id, patch: { digest_frequency: v } })
                    }
                    options={[
                      { label: 'Instant', value: 'instant' },
                      { label: 'Daily', value: 'daily' },
                      { label: 'Weekly', value: 'weekly' }
                    ]}
                    className='h-7 w-[105px] text-[11.5px]'
                  />
                </td>
                <td className={tdCls}>
                  <ToggleSwitch
                    checked={!!s.is_active}
                    onChange={(v) => patchNotifSub.mutate({ id: s.id, patch: { is_active: v } })}
                  />
                </td>
                <td className={tdCls}>
                  <div className='flex items-center gap-1'>
                    <button
                      type='button'
                      title='Edit'
                      className={iconBtn}
                      onClick={() => setEditNotifSub(s)}
                    >
                      <Pencil className='h-3.5 w-3.5' />
                    </button>
                    <button
                      type='button'
                      title='Remove subscription'
                      className={cn(iconBtn, 'hover:border-red-300 hover:text-red-500')}
                      onClick={() => {
                        if (!window.confirm('Remove this notification subscription?')) return
                        removeNotifSub.mutate(s.id)
                      }}
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}

      {/* ── Alert History ── */}
      {tab === 'history' && (
        <TableFrame
          title='Alert history'
          hint={
            firingCount > 0
              ? `${firingCount} open · last 100 events`
              : 'Last 100 events — none open'
          }
        >
          <DataTable
            headers={[
              'Alert rule',
              { label: 'Reading', width: 168 },
              { label: 'Fired', width: 150 },
              { label: 'Resolved', width: 150 },
              { label: 'Open for', width: 92, align: 'right' }
            ]}
            empty='No alerts have fired'
            emptyHint='Events appear here the first time a rule crosses its threshold.'
            emptyIcon={<History className='h-5 w-5' />}
            loading={loadingLog}
          >
            {logEntries.map((entry) => {
              const isOpen = entry.status === 'firing' && !entry.resolved_at
              const duration = entry.resolved_at
                ? fmtDuration(entry.fired_at, entry.resolved_at)
                : fmtDuration(entry.fired_at, new Date().toISOString())
              return (
                <tr
                  key={entry.id}
                  className='transition-colors hover:bg-slate-50/70 dark:hover:bg-muted/25'
                >
                  <td className={tdCls}>
                    <div className='flex items-center gap-2'>
                      {isOpen && (
                        <span
                          aria-hidden
                          className='h-1.5 w-1.5 shrink-0 rounded-full bg-red-500 motion-safe:animate-pulse'
                        />
                      )}
                      <span
                        className={cn(
                          'font-medium',
                          isOpen
                            ? 'text-slate-800 dark:text-slate-100'
                            : 'text-slate-600 dark:text-slate-300'
                        )}
                      >
                        {entry.rule_name ?? `Rule #${entry.rule_id}`}
                      </span>
                    </div>
                  </td>
                  <td className={tdCls}>
                    <MetricVsThreshold
                      value={entry.metric_value}
                      threshold={entry.threshold_value}
                      unit={entry.definition_unit}
                      breaching={isOpen}
                    />
                  </td>
                  <td className={tdCls}>
                    <TimeCell value={entry.fired_at} />
                  </td>
                  <td className={tdCls}>
                    {entry.resolved_at ? (
                      <TimeCell value={entry.resolved_at} />
                    ) : (
                      <span className='inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2 py-px text-[10.5px] font-semibold text-red-600 dark:bg-red-500/10 dark:text-red-400'>
                        Still open
                      </span>
                    )}
                  </td>
                  <td className={cn(tdNum, 'text-right')}>
                    <span className={cn(isOpen && 'text-red-600 dark:text-red-400')}>
                      {duration ?? '—'}
                    </span>
                  </td>
                </tr>
              )
            })}
          </DataTable>
        </TableFrame>
      )}

      {/* ── Widget Alerts ── */}
      {tab === 'widget_alerts' && (
        <div className='space-y-2'>
          <p className='text-[12px] text-slate-400'>Alerts set up directly on report widgets</p>
          <DataTable
            headers={[
              'Alert',
              'Scope',
              'Conditions',
              { label: 'In-App', width: 70 },
              { label: 'Email', width: 70 },
              { label: 'Last Fired', width: 160 },
              { label: 'Active', width: 70 },
              { label: '', width: 40 }
            ]}
            empty='No widget alerts yet — open any report widget and click the bell icon'
            loading={loadingReportAlerts}
          >
            {reportAlerts.map((a) => (
              <tr key={a.id} className='hover:bg-slate-50/60 dark:hover:bg-muted/30'>
                <td className={tdCls}>
                  <p className='font-medium text-slate-800 dark:text-slate-100'>{a.name}</p>
                  {a.report_name && (
                    <button
                      type='button'
                      onClick={() => onOpenReport?.(a.report)}
                      className={cn(
                        'text-[11px] text-slate-400',
                        onOpenReport && 'underline-offset-2 hover:text-nvr-navy hover:underline dark:hover:text-nvr-cyan'
                      )}
                    >
                      {a.report_name}
                    </button>
                  )}
                </td>
                <td className={cn(tdCls, 'text-[11.5px] text-slate-400')}>
                  {(a.filters ?? []).length
                    ? (a.filters ?? [])
                        .map((f) => `${f.field}: ${(f.labels ?? f.values).join(', ')}`)
                        .join(' · ')
                    : 'All data'}
                </td>
                <td className={tdCls}>
                  <div className='flex flex-wrap gap-1'>
                    {(a.conditions ?? []).map((c, i) => (
                      <span
                        key={`${c.field}-${i}`}
                        className='inline-flex rounded bg-slate-100 px-1.5 py-px text-[11px] text-slate-600 dark:bg-muted dark:text-slate-300'
                      >
                        {c.field} {OPERATOR_LABELS[c.op] ?? c.op} {c.value}
                      </span>
                    ))}
                  </div>
                </td>
                <td className={tdCls}>
                  <ToggleSwitch
                    checked={!!a.delivery_inapp}
                    onChange={(v) => patchReportAlert(a, { delivery_inapp: v })}
                  />
                </td>
                <td className={tdCls}>
                  <ToggleSwitch
                    checked={!!a.delivery_email}
                    onChange={(v) => patchReportAlert(a, { delivery_email: v })}
                  />
                </td>
                <td className={cn(tdCls, 'text-[11.5px] text-slate-400')}>
                  {fmtDateTime(a.last_fired)}
                </td>
                <td className={tdCls}>
                  <ToggleSwitch
                    checked={!!a.is_active}
                    onChange={(v) => patchReportAlert(a, { is_active: v })}
                  />
                </td>
                <td className={tdCls}>
                  <button
                    type='button'
                    title='Delete'
                    className={cn(iconBtn, 'hover:border-red-300 hover:text-red-500')}
                    onClick={() => deleteReportAlert(a)}
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </button>
                </td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}

      {/* ── Widget Alert History ── */}
      {tab === 'widget_alert_history' && (
        <div className='space-y-2'>
          <p className='text-[12px] text-slate-400'>Last 200 widget alert events</p>
          <DataTable
            headers={[
              'Alert',
              'Snapshot',
              { label: 'Fired At', width: 170 },
              { label: 'Resolved At', width: 170 },
              { label: 'Status', width: 90 },
              { label: '', width: 90 }
            ]}
            empty='No widget alert history yet'
            loading={loadingReportLog}
          >
            {reportAlertLog.map((entry) => (
              <tr key={entry.id} className='hover:bg-slate-50/60 dark:hover:bg-muted/30'>
                <td className={tdCls}>
                  <p className='font-medium text-slate-800 dark:text-slate-100'>
                    {entry.alert_name}
                  </p>
                  {entry.report_name && (
                    <p className='text-[11px] text-slate-400'>{entry.report_name}</p>
                  )}
                </td>
                <td className={tdCls}>
                  <div className='flex flex-wrap gap-1'>
                    {Object.entries(entry.metric_snapshot ?? {}).map(([k, v]) => (
                      <span
                        key={k}
                        className='inline-flex rounded bg-orange-50 px-1.5 py-px text-[11px] text-orange-600 dark:bg-orange-500/10 dark:text-orange-400'
                      >
                        {k}: {String(v)}
                      </span>
                    ))}
                  </div>
                </td>
                <td className={cn(tdCls, 'text-[11.5px]')}>{fmtDateTime(entry.fired_at)}</td>
                <td className={cn(tdCls, 'text-[11.5px] text-slate-400')}>
                  {fmtDateTime(entry.resolved_at)}
                </td>
                <td className={tdCls}>
                  <StatusBadge status={entry.status} />
                </td>
                <td className={tdCls}>
                  {entry.status === 'firing' && (
                    <button
                      type='button'
                      className='rounded border border-nvr-cyan px-2 py-0.5 text-[11.5px] font-medium text-nvr-navy hover:bg-[#00ceff1a] dark:text-nvr-cyan'
                      onClick={() => resolveReportAlertLog.mutate(entry)}
                    >
                      Resolve
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}

      {/* ── Anomaly Rules ── */}
      {tab === 'anomaly_rules' && (
        <div className='space-y-2'>
          <div className='flex items-center justify-between'>
            <p className='text-[12px] text-slate-400'>
              AI-powered statistical anomaly detection rules
            </p>
            <button
              type='button'
              className={toolbarBtn}
              onClick={() => {
                setEditAnomalyRule(null)
                setAnomalyDrawerOpen(true)
              }}
            >
              <Plus className='h-3 w-3' /> New Rule
            </button>
          </div>
          <DataTable
            headers={[
              'Rule',
              { label: 'Sensitivity', width: 100 },
              { label: 'Frequency', width: 90 },
              { label: 'In-App', width: 70 },
              { label: 'Email', width: 70 },
              { label: 'Status', width: 90 },
              { label: '', width: 80 }
            ]}
            empty='No anomaly rules yet — create one to start detecting unusual patterns'
            loading={loadingAnomalyRules}
          >
            {anomalyRules.map((rule) => {
              const own = canEditRule(rule.created_by)
              return (
                <tr key={rule.id} className='hover:bg-slate-50/60 dark:hover:bg-muted/30'>
                  <td className={tdCls}>
                    <p className='font-medium text-slate-800 dark:text-slate-100'>{rule.name}</p>
                    {rule.definition && (
                      <p className='text-[11px] text-slate-400'>{rule.definition.name}</p>
                    )}
                  </td>
                  <td className={tdCls}>
                    <span
                      className={cn(
                        'inline-flex rounded-full px-2 py-px text-[10.5px] font-semibold capitalize',
                        rule.sensitivity === 'high'
                          ? 'bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400'
                          : rule.sensitivity === 'low'
                            ? 'bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-400'
                            : 'bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-400'
                      )}
                    >
                      {rule.sensitivity ?? 'medium'}
                    </span>
                  </td>
                  <td className={cn(tdCls, 'capitalize')}>{rule.check_frequency}</td>
                  <td className={tdCls}>
                    <ToggleSwitch
                      checked={!!rule.delivery_in_app}
                      disabled={!own}
                      onChange={(v) => patchAnomalyRule(rule.id, { delivery_in_app: v })}
                    />
                  </td>
                  <td className={tdCls}>
                    <ToggleSwitch
                      checked={!!rule.delivery_email}
                      disabled={!own}
                      onChange={(v) => patchAnomalyRule(rule.id, { delivery_email: v })}
                    />
                  </td>
                  <td className={tdCls}>
                    <StatusBadge status={rule.status} />
                  </td>
                  <td className={tdCls}>
                    {own && (
                      <div className='flex items-center gap-1'>
                        <button
                          type='button'
                          title='Edit'
                          className={iconBtn}
                          onClick={() => {
                            setEditAnomalyRule(rule)
                            setAnomalyDrawerOpen(true)
                          }}
                        >
                          <Pencil className='h-3.5 w-3.5' />
                        </button>
                        <button
                          type='button'
                          title='Delete'
                          className={cn(iconBtn, 'hover:border-red-300 hover:text-red-500')}
                          onClick={() => deleteAnomalyRule(rule)}
                        >
                          <Trash2 className='h-3.5 w-3.5' />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </DataTable>
        </div>
      )}

      {/* ── Anomaly History ── */}
      {tab === 'anomaly_history' && (
        <TableFrame
          wide
          title='Detected anomalies'
          hint={`Last 200 detections${openAnomalyCount ? ` · ${openAnomalyCount} needing review` : ''}`}
        >
          <DataTable
            headers={[
              'Subject',
              { label: 'Deviation', width: 132 },
              'Why it was flagged',
              { label: 'Detected', width: 172 },
              { label: '', width: 150, align: 'right' }
            ]}
            empty='No anomalies detected'
            emptyHint='Detections appear here when a subject deviates from its own recent pattern.'
            emptyIcon={<FlaskConical className='h-5 w-5' />}
            loading={loadingAnomalyLog}
          >
            {anomalyLog.map((entry) => {
              const snap = entry.stats_snapshot ?? {}
              const groupVals = Object.values(
                (snap.group as Record<string, unknown> | undefined) ?? {}
              ).filter(Boolean)
              const mult = typeof snap.multiplier === 'number' ? snap.multiplier : null
              const value = typeof snap.value === 'number' ? snap.value : null
              const mean = typeof snap.mean === 'number' ? snap.mean : null
              const unresolved = entry.status !== 'resolved'
              return (
                <tr
                  key={entry.id}
                  className='align-top transition-colors hover:bg-slate-50/70 dark:hover:bg-muted/25'
                >
                  <td className={tdCls}>
                    <div className='flex items-start gap-2'>
                      {entry.status === 'new' && (
                        <span
                          aria-hidden
                          className='mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500'
                        />
                      )}
                      <div className='min-w-0'>
                        <p className='font-medium text-slate-800 dark:text-slate-100'>
                          {String(snap.subject_label ?? entry.subject_id)}
                        </p>
                        <p className='truncate text-[11px] text-slate-500 dark:text-slate-400'>
                          {[entry.rule_name ?? `Rule #${entry.rule_id}`, ...groupVals].join(' · ')}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className={tdCls}>
                    {/* The multiplier is the finding — it was buried in the
                        JSON snapshot while prose took the widest column. */}
                    {mult != null ? (
                      <span className='flex flex-col gap-0.5'>
                        <span
                          className={cn(
                            'font-mono text-[13px] font-semibold tabular-nums',
                            mult >= 3
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-amber-600 dark:text-amber-400'
                          )}
                        >
                          {mult.toFixed(1)}×
                        </span>
                        {value != null && mean != null && (
                          <span className='font-mono text-[10.5px] tabular-nums text-slate-400 dark:text-slate-500'>
                            {fmtMetric(value, 'dollar')} vs {fmtMetric(mean, 'dollar')}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className='text-slate-300 dark:text-slate-600'>—</span>
                    )}
                  </td>
                  <td className={cn(tdCls, 'max-w-0')}>
                    {/* Clamped, not truncated: the reasoning is the value of an
                        AI explanation, so it stays fully reachable in place. */}
                    <ExpandableText text={entry.ai_explanation} />
                  </td>
                  <td className={tdCls}>
                    <TimeCell value={entry.detected_at} />
                    {entry.status !== 'new' && (
                      <span className='mt-1 block'>
                        <StatusBadge status={entry.status} />
                      </span>
                    )}
                  </td>
                  <td className={tdCls}>
                    <div className='flex items-center justify-end gap-1'>
                      {entry.status === 'new' && (
                        <button
                          type='button'
                          className='inline-flex h-7 items-center rounded-md border border-slate-200 px-2.5 text-[11.5px] font-medium text-slate-600 transition-colors hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-muted'
                          onClick={() => updateAnomalyLogStatus(entry.id, 'acknowledged')}
                        >
                          Acknowledge
                        </button>
                      )}
                      {unresolved && (
                        <button
                          type='button'
                          className='inline-flex h-7 items-center rounded-md border border-nvr-cyan px-2.5 text-[11.5px] font-medium text-nvr-navy transition-colors hover:bg-[#00ceff1a] dark:text-nvr-cyan'
                          onClick={() => updateAnomalyLogStatus(entry.id, 'resolved')}
                        >
                          Resolve
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </DataTable>
        </TableFrame>
      )}

      {/* Header icon accent for the whole view */}
      <span className='hidden'>
        <Siren className='h-4 w-4' />
      </span>

      <AlertRuleDrawer
        open={drawerOpen}
        definitions={definitions}
        editRule={editRule}
        preselectedDefinitionId={preselectedDefId}
        onClose={() => setDrawerOpen(false)}
        onSave={saveRule}
        saving={saving}
      />
      <AnomalyRuleDrawer
        open={anomalyDrawerOpen}
        definitions={anomalyDefinitions}
        editRule={editAnomalyRule}
        onClose={() => {
          setAnomalyDrawerOpen(false)
          setEditAnomalyRule(null)
        }}
        onSave={saveAnomalyRule}
        saving={saving}
      />
      <NotifSubEditDrawer
        open={editNotifSub != null}
        sub={editNotifSub}
        onClose={() => setEditNotifSub(null)}
        saving={patchNotifSub.isPending}
        onSave={(p) => {
          if (!editNotifSub) return
          patchNotifSub.mutate(
            { id: editNotifSub.id, patch: p },
            { onSuccess: () => setEditNotifSub(null) }
          )
        }}
      />
    </div>
  )
}
