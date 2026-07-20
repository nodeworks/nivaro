import { AlertCircle, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useItemEditAuth, useNivaroClient } from '../../context'
import { patch } from '../../lib/commands'
import { formatDate, formatDateTime } from '../../lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'

// ─── Types ──────────────────────────────────────────────────────────────────
// Duplicated locally from api/src/services/review-list.ts (ReviewListConfig /
// ReviewListResult) per the plan's "no api import" rule — the shared package
// never depends on the api workspace.

export interface ReviewListStatusOption {
  value: string
  label: string
  color: string
}

export type ReviewListColumnFormat = 'currency' | 'number' | 'date' | 'datetime' | 'flag'

export interface ReviewListColumnSpec {
  field: string
  label?: string
  format?: ReviewListColumnFormat
  color?: string
}

export interface ReviewListConfig {
  host_collection: string
  collection: string
  path: Array<{ kind: 'm2o' | 'm2m'; field: string }>
  static_filter?: Array<{ field: string; op: 'eq' | 'neq' | 'nnull'; value?: unknown }>
  group_by: string
  aggregate_sum?: string | null
  aggregate_sum_format?: ReviewListColumnFormat | null
  group_meta?: Array<string | ReviewListColumnSpec>
  line_columns?: Array<string | ReviewListColumnSpec>
  status: {
    field: string
    options: ReviewListStatusOption[]
    empty_label?: string | null
    empty_color?: string | null
    stamp_user_field?: string | null
    stamp_date_field?: string | null
  }
}

export interface ReviewListRow {
  id: string | number
  group: unknown
  values: Record<string, unknown>
  status: unknown
  stamp_user: { id: string; label: string } | null
  stamp_date: string | null
}

export interface ReviewListResult {
  rows: ReviewListRow[]
  columns: {
    group_meta: Array<{
      field: string
      label: string
      format?: ReviewListColumnFormat | null
      color?: string | null
    }>
    line_columns: Array<{
      field: string
      label: string
      format?: ReviewListColumnFormat | null
      color?: string | null
    }>
  }
  truncated: boolean
}

// Bit/boolean columns arrive as true/1/'1'/'true' depending on driver and
// dialect — normalize for flag rendering.
function isTruthyFlag(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true'
}

// ─── Value formatting ───────────────────────────────────────────────────────
// Display-only; non-numeric values under currency/number (and unparseable
// dates) fall back to the raw string rather than rendering NaN.

function formatValue(v: unknown, format: ReviewListColumnFormat | null | undefined): string {
  if (v == null || v === '') return '—'
  if (format === 'currency' || format === 'number') {
    const n = Number(v)
    if (Number.isNaN(n)) return String(v)
    return format === 'currency'
      ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(n)
      : new Intl.NumberFormat().format(n)
  }
  if (format === 'date' || format === 'datetime') {
    const d = new Date(v as string)
    if (Number.isNaN(d.getTime())) return String(v)
    return format === 'date' ? formatDate(d) : formatDateTime(d)
  }
  return String(v)
}

// ─── Color mapping ──────────────────────────────────────────────────────────
// Same hex + alpha idiom as PipelinePanel's StateBadge, generalized from the
// named palette the config's status.options[].color is restricted to.

const STATUS_COLOR_HEX: Record<string, string> = {
  green: '#16a34a',
  red: '#dc2626',
  amber: '#d97706',
  blue: '#2563eb',
  purple: '#9333ea',
  slate: '#64748b'
}

function badgeStyle(hex: string | null): React.CSSProperties {
  return {
    backgroundColor: hex ? `${hex}22` : '#f1f5f9',
    color: hex ?? '#475569',
    border: `1px solid ${hex ? `${hex}44` : '#e2e8f0'}`
  }
}

function StatusBadge({ label, color }: { label: string; color: string | null }) {
  const hex = color ? (STATUS_COLOR_HEX[color] ?? null) : null
  return (
    <span
      className='inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium'
      style={badgeStyle(hex)}
    >
      {label}
    </span>
  )
}

function statusDisplay(
  value: unknown,
  status: ReviewListConfig['status']
): { label: string; color: string | null } {
  if (value == null || value === '') {
    return status.empty_label
      ? { label: status.empty_label, color: status.empty_color ?? 'blue' }
      : { label: '—', color: null }
  }
  const match = status.options.find((o) => o.value === String(value))
  if (match) return { label: match.label, color: match.color }
  return { label: String(value), color: null }
}

// ─── Grouping ───────────────────────────────────────────────────────────────

interface ReviewGroup {
  key: string
  rows: ReviewListRow[]
  count: number
  sum: number | null
  uniformStatus: unknown
  mixedStatus: boolean
}

function buildGroups(
  data: ReviewListResult,
  aggregateSum: string | null | undefined
): ReviewGroup[] {
  const map = new Map<string, ReviewListRow[]>()
  for (const row of data.rows) {
    const key = String(row.group ?? '')
    const existing = map.get(key)
    if (existing) existing.push(row)
    else map.set(key, [row])
  }
  const groups: ReviewGroup[] = Array.from(map.entries()).map(([key, rows]) => {
    const statusSet = new Set(rows.map((r) => String(r.status ?? '')))
    const mixedStatus = statusSet.size > 1
    const uniformStatus = mixedStatus ? null : rows[0].status

    let sum: number | null = null
    if (aggregateSum) {
      const allPresent = rows.every((r) => aggregateSum in r.values)
      if (allPresent) {
        sum = rows.reduce((acc, r) => acc + (Number(r.values[aggregateSum]) || 0), 0)
      }
    }

    return { key, rows, count: rows.length, sum, uniformStatus, mixedStatus }
  })
  groups.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }))
  return groups
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface ReviewListWidgetProps {
  data: ReviewListResult | null
  config: ReviewListConfig
  loading?: boolean
  error?: string | null
  onRefetch: () => void
}

export function ReviewListWidget({
  data,
  config,
  loading,
  error,
  onRefetch
}: ReviewListWidgetProps) {
  const client = useNivaroClient()
  const { userId } = useItemEditAuth()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [actingGroup, setActingGroup] = useState<string | null>(null)
  const [groupErrors, setGroupErrors] = useState<Record<string, string>>({})

  const groups = useMemo(
    () => (data ? buildGroups(data, config.aggregate_sum) : []),
    [data, config.aggregate_sum]
  )

  if (loading) {
    return (
      <div className='space-y-2'>
        {[0, 1].map((i) => (
          <div key={i} className='animate-pulse h-12 rounded-md bg-slate-100 dark:bg-slate-800' />
        ))}
      </div>
    )
  }

  if (error) {
    return <p className='text-[12px] text-red-500'>{error}</p>
  }

  if (!data || data.rows.length === 0) {
    return <p className='text-[12px] text-slate-400'>No rows</p>
  }

  const toggleGroup = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleAction = async (group: ReviewGroup, option: ReviewListStatusOption) => {
    setActingGroup(group.key)
    const stampDate = config.status.stamp_date_field ? new Date().toISOString() : undefined
    const results = await Promise.all(
      group.rows.map(async (row) => {
        const body: Record<string, unknown> = { [config.status.field]: option.value }
        if (config.status.stamp_user_field && userId) {
          body[config.status.stamp_user_field] = userId
        }
        if (config.status.stamp_date_field) {
          body[config.status.stamp_date_field] = stampDate
        }
        try {
          await client.request(patch(`/items/${config.collection}/${row.id}`, body))
          return { ok: true as const }
        } catch (err) {
          const resp = (err as { response?: { error?: string } })?.response
          return { ok: false as const, error: resp?.error ?? 'Failed to update' }
        }
      })
    )
    setActingGroup(null)
    const failures = results.filter((r) => !r.ok)
    setGroupErrors((prev) => {
      const next = { ...prev }
      if (failures.length > 0) {
        next[group.key] = `${failures.length} of ${group.rows.length} row(s) failed to update`
      } else {
        delete next[group.key]
      }
      return next
    })
    onRefetch()
  }

  const lineColumns = data.columns.line_columns
  const groupMetaCols = data.columns.group_meta

  return (
    <TooltipProvider delayDuration={200}>
      <div className='space-y-2'>
        {data.truncated && (
          <p className='text-[11px] text-amber-600 dark:text-amber-400'>
            Showing first 2000 rows — some rows may be missing.
          </p>
        )}
        {groups.map((group) => {
          const isOpen = expanded.has(group.key)
          const badge = group.mixedStatus
            ? { label: 'Mixed', color: null }
            : statusDisplay(group.uniformStatus, config.status)
          const firstRow = group.rows[0]
          const stampUser = firstRow.stamp_user
          const stampDate = firstRow.stamp_date

          return (
            <div key={group.key} className='rounded-md border border-slate-200 dark:border-border'>
              <div className='flex w-full flex-wrap items-center gap-2 px-3 py-2'>
                <button
                  type='button'
                  onClick={() => toggleGroup(group.key)}
                  className='flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left'
                >
                  <ChevronRight
                    className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                  />
                  <span className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                    {group.key || '—'}
                  </span>
                  <span className='text-[11px] text-slate-400'>
                    {group.count} row{group.count === 1 ? '' : 's'}
                    {group.sum != null
                      ? ` · ${formatValue(group.sum, config.aggregate_sum_format ?? 'number')}`
                      : ''}
                  </span>
                  {groupMetaCols.map((c) => {
                    const v = firstRow.values[c.field]
                    if (c.format === 'flag') {
                      if (!isTruthyFlag(v)) return null
                      return (
                        <StatusBadge key={c.field} label={c.label} color={c.color ?? 'amber'} />
                      )
                    }
                    if (v == null || v === '') return null
                    return (
                      <span
                        key={c.field}
                        className='rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                      >
                        {c.label}: {formatValue(v, c.format)}
                      </span>
                    )
                  })}
                  <StatusBadge label={badge.label} color={badge.color} />
                  {stampUser && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className='cursor-default text-[11px] text-slate-400 underline decoration-dotted'>
                          {stampUser.label}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side='top' className='text-[12px]'>
                        <p className='font-medium'>{stampUser.label}</p>
                        {stampDate && (
                          <p className='text-muted-foreground'>{formatDateTime(stampDate)}</p>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </button>
                <span className='flex flex-wrap items-center gap-1.5'>
                  {config.status.options.map((option) => {
                    const isCurrent =
                      !group.mixedStatus && String(group.uniformStatus) === option.value
                    const hex = STATUS_COLOR_HEX[option.color] ?? STATUS_COLOR_HEX.slate
                    const acting = actingGroup === group.key
                    return (
                      <button
                        key={option.value}
                        type='button'
                        disabled={acting || isCurrent}
                        onClick={() => handleAction(group, option)}
                        className='rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50'
                        style={{
                          backgroundColor: isCurrent ? `${hex}22` : 'transparent',
                          borderColor: `${hex}55`,
                          color: hex
                        }}
                      >
                        {acting ? '…' : option.label}
                      </button>
                    )
                  })}
                </span>
              </div>
              {groupErrors[group.key] && (
                <p className='flex items-center gap-1 px-3 pb-2 text-[11px] text-red-600'>
                  <AlertCircle className='h-3 w-3 shrink-0' />
                  {groupErrors[group.key]}
                </p>
              )}
              {isOpen && (
                <div className='overflow-x-auto border-t border-slate-100 dark:border-border/50'>
                  <table className='w-full border-collapse text-[12px]'>
                    <thead>
                      <tr className='border-b border-slate-200 bg-slate-50/60 text-left text-[11px] font-medium text-slate-400 dark:border-border dark:bg-white/[0.02]'>
                        {lineColumns.map((c) => (
                          <th key={c.field} className='px-2.5 py-1.5 font-medium'>
                            {c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row) => (
                        <tr
                          key={row.id}
                          className='border-b border-slate-100 last:border-b-0 dark:border-border/50'
                        >
                          {lineColumns.map((c) => (
                            <td
                              key={c.field}
                              className='px-2.5 py-1.5 text-slate-600 dark:text-slate-300'
                            >
                              {c.format === 'flag' ? (
                                isTruthyFlag(row.values[c.field]) ? (
                                  <StatusBadge label={c.label} color={c.color ?? 'amber'} />
                                ) : (
                                  '—'
                                )
                              ) : (
                                formatValue(row.values[c.field], c.format)
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </TooltipProvider>
  )
}
