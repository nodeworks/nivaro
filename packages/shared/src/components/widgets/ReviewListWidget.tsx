import { useQuery } from '@tanstack/react-query'
import { AlertCircle, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useItemEditAuth, useNivaroClient } from '../../context'
import { useBackCloses } from '../../lib/back-closes'
import { patch, post } from '../../lib/commands'
import { cn, formatDate, formatDateTime } from '../../lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'

// ─── Types ──────────────────────────────────────────────────────────────────
// Duplicated locally from api/src/services/review-list.ts (ReviewListConfig /
// ReviewListResult) per the plan's "no api import" rule — the shared package
// never depends on the api workspace.

export interface ReviewListStatusOption {
  value: string
  label: string
  color: string
  /** The confirm asks for a note and will not send without one. Every option
   *  is confirmed first either way; without this the note is optional. */
  require_note?: boolean
  /** The state a badge shows once decided ("Approved"); `label` is the button
   *  verb ("Approve"). Unset = the label. */
  status_label?: string | null
  /** The confirm's last line for this decision — who is told, whether it can
   *  be taken back. Unset = the generic "Nothing changes until you confirm". */
  confirm_notice?: string | null
}

export type ReviewListColumnFormat = 'currency' | 'number' | 'date' | 'datetime' | 'flag'

export interface ReviewListColumnSpec {
  field: string
  label?: string
  format?: ReviewListColumnFormat
  color?: string
  /** group_meta only: `title` names the group in its header and the confirm
   *  (instead of the raw group key), `subtitle` follows it. */
  role?: 'title' | 'subtitle'
  /** Put before the value where it names the group ("#" → "#INV-1"). */
  prefix?: string
}

export interface ReviewListEnrichRow {
  chips?: Array<{ label: string; tone?: 'ok' | 'warn' | 'danger' | 'neutral'; title?: string }>
  can_act?: boolean
  /** Why the row can't be decided (e.g. an approval is final) — the View only hint. */
  reason?: string | null
  /** The note the row's current decision carried (a rejection's reason) —
   *  shown under the group header so the person acting on it sees why. */
  note?: string | null
}

export interface ReviewListConfig {
  /** Sibling mode — see the server config: rows share the host's value. */
  sibling_field?: string | null
  /** POST {ids} → {rows: {[id]: ReviewListEnrichRow}} — verdict chips + per-row act permission. */
  enrich_endpoint?: string | null
  host_collection: string
  collection: string
  path: Array<{ kind: 'm2o' | 'm2m'; field: string }>
  static_filter?: Array<{ field: string; op: 'eq' | 'neq' | 'nnull'; value?: unknown }>
  group_by: string
  aggregate_sum?: string | null
  aggregate_sum_format?: ReviewListColumnFormat | null
  group_meta?: Array<string | ReviewListColumnSpec>
  /** Order groups by a field instead of by key — the most pressing first
   *  (`{field: 'due_date', direction: 'asc'}` puts the soonest due on top).
   *  A group sorts on its EARLIEST value, since one late line makes the
   *  whole invoice late. Groups missing the field keep the key order, last. */
  group_sort?: { field: string; direction?: 'asc' | 'desc' }
  line_columns?: Array<string | ReviewListColumnSpec>
  /** What a group is ("invoice") and a row is ("line"); unset = none / "row". */
  group_noun?: string | null
  row_noun?: string | null
  status: {
    field: string
    options: ReviewListStatusOption[]
    empty_label?: string | null
    empty_color?: string | null
    stamp_user_field?: string | null
    stamp_date_field?: string | null
    /** POST this endpoint with {ids, status, note, workflow_id, expected}
     *  (`expected` = each row's status as the list showed it) instead of
     *  per-row PATCHes — lets a deployment route decisions through an
     *  endpoint that owns stamping, authorization, notes and notifications
     *  (e.g. an extension's /decide route). */
    action_endpoint?: string | null
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
      role?: 'title' | 'subtitle'
      prefix?: string
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

export function formatValue(v: unknown, format: ReviewListColumnFormat | null | undefined): string {
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
    // A calendar date goes to formatDate as the string it came in: a Date
    // made from '2026-11-04T00:00:00.000Z' reads as Nov 3 west of UTC
    // (army 6 M33: "Invoice date Nov 3" for 2026-11-04).
    if (format === 'date') return formatDate(typeof v === 'string' ? v : d)
    return formatDateTime(d)
  }
  return String(v)
}

// ─── Color mapping ──────────────────────────────────────────────────────────
// Same hex + alpha idiom as PipelinePanel's StateBadge, generalized from the
// named palette the config's status.options[].color is restricted to.

export const STATUS_COLOR_HEX: Record<string, string> = {
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
  // A badge shows the state ("Rejected"), not the button verb ("Reject").
  if (match) return { label: match.status_label || match.label, color: match.color }
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

/** A group's sort value: the earliest (or latest) of its rows' values. */
function groupSortValue(rows: ReviewListRow[], field: string, desc: boolean): number | null {
  let best: number | null = null
  for (const r of rows) {
    const raw = r.values[field]
    if (raw == null || raw === '') continue
    const n = typeof raw === 'number' ? raw : Date.parse(String(raw))
    const v = Number.isNaN(n) ? Number(raw) : n
    if (!Number.isFinite(v)) continue
    if (best == null || (desc ? v > best : v < best)) best = v
  }
  return best
}

/** How one group is named: the group_meta `title` value (with its prefix)
 *  and `subtitle` value, else the raw group key. */
export function groupName(
  group: { key: string; rows: ReviewListRow[] },
  groupMeta: ReviewListResult['columns']['group_meta']
): { title: string; subtitle: string | null } {
  const first = group.rows[0]
  const pick = (role: 'title' | 'subtitle') => {
    const c = groupMeta.find((m) => m.role === role)
    if (!c || !first) return null
    const v = first.values[c.field]
    if (v == null || v === '') return null
    return `${c.prefix ?? ''}${formatValue(v, c.format)}`
  }
  return { title: pick('title') ?? (group.key || '—'), subtitle: pick('subtitle') }
}

/** "25 lines", "1 row". */
export function countLabel(n: number, noun: string | null | undefined): string {
  const word = noun?.trim() || 'row'
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** The confirm's question: "Approve invoice #INV-1 · ACME?". */
export function confirmTitle(
  option: ReviewListStatusOption,
  name: { title: string; subtitle: string | null },
  groupNoun: string | null | undefined
): string {
  const noun = groupNoun?.trim() ? `${groupNoun.trim()} ` : ''
  return `${option.label} ${noun}${name.title}${name.subtitle ? ` · ${name.subtitle}` : ''}?`
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface ReviewListWidgetProps {
  data: ReviewListResult | null
  config: ReviewListConfig
  loading?: boolean
  error?: string | null
  onRefetch: () => void
  /** Host record id (the workflow the widget is slotted on) — forwarded to
   *  action_endpoint as workflow_id so a rejection note can anchor to it. */
  hostRecordId?: string | number | null
  /** Names the empty state instead of a bare 'No rows'. */
  emptyLabel?: string
}

export function ReviewListWidget({
  data,
  config,
  loading,
  error,
  onRefetch,
  hostRecordId,
  emptyLabel
}: ReviewListWidgetProps) {
  const client = useNivaroClient()
  const { userId } = useItemEditAuth()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [actingGroup, setActingGroup] = useState<string | null>(null)
  const [groupErrors, setGroupErrors] = useState<Record<string, string>>({})
  const [noteAsk, setNoteAsk] = useState<{
    group: ReviewGroup
    option: ReviewListStatusOption
  } | null>(null)
  const [noteText, setNoteText] = useState('')
  // Browser Back closes the confirm instead of leaving the record page
  // (army 8 b07-N5) — the same rule as the Invoice Approvals dialogs.
  useBackCloses(() => setNoteAsk(null), noteAsk != null)

  const groups = useMemo(() => {
    const built = data ? buildGroups(data, config.aggregate_sum) : []
    const gs = config.group_sort
    if (!gs?.field) return built
    const desc = gs.direction === 'desc'
    return [...built].sort((a, b) => {
      const av = groupSortValue(a.rows, gs.field, desc)
      const bv = groupSortValue(b.rows, gs.field, desc)
      if (av == null && bv == null) return 0
      if (av == null) return 1 // groups with no value keep to the end
      if (bv == null) return -1
      return desc ? bv - av : av - bv
    })
  }, [data, config.aggregate_sum, config.group_sort])
  // Row enrichment (verdict chips, per-row act permission) from an extension
  // endpoint — the widget stays domain-blind; the endpoint owns the rules.
  const rowIds = useMemo(() => (data?.rows ?? []).map((r) => String(r.id)), [data])
  const { data: enrich } = useQuery<Record<string, ReviewListEnrichRow>>({
    queryKey: ['review-list-enrich', config.enrich_endpoint ?? '', rowIds.join(',')],
    queryFn: () =>
      client
        .request<{ data?: { rows?: Record<string, ReviewListEnrichRow> } }>(
          post(config.enrich_endpoint as string, { ids: rowIds })
        )
        .then((r) => r?.data?.rows ?? {})
        .catch(() => ({})),
    enabled: !!config.enrich_endpoint && rowIds.length > 0,
    staleTime: 30_000
  })
  const enrichFor = (id: string | number): ReviewListEnrichRow | undefined => enrich?.[String(id)]
  const hasChips = !!enrich && Object.values(enrich).some((e) => (e.chips?.length ?? 0) > 0)
  // Sibling mode hosts ONE group (this record's siblings) — open it by default.
  const singleGroup = groups.length === 1

  if (loading) {
    return (
      <div className='space-y-2'>
        {[0, 1].map((i) => (
          <div
            key={i}
            className='animate-pulse h-12 rounded-md bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]'
          />
        ))}
      </div>
    )
  }

  if (error) {
    return <p className='text-[12px] text-red-500'>{error}</p>
  }

  if (!data || data.rows.length === 0) {
    return (
      <p className='text-[12px] italic text-slate-400'>
        {emptyLabel ? `No ${emptyLabel.toLowerCase()} yet` : 'Nothing here yet'}
      </p>
    )
  }

  const toggleGroup = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleAction = (group: ReviewGroup, option: ReviewListStatusOption) => {
    // Every decision is confirmed first (army 2026-11-05: Approve committed on
    // the first click and notified the requestor). A decision that requires a
    // reason (rejections) collects it in the same confirm — the status must
    // never land without the note that explains it.
    setNoteText('')
    setNoteAsk({ group, option })
  }

  const performAction = async (
    group: ReviewGroup,
    option: ReviewListStatusOption,
    note: string | null
  ) => {
    setActingGroup(group.key)
    let failureMsg: string | null = null
    if (config.status.action_endpoint) {
      // One call for the whole group — the endpoint owns stamping, per-invoice
      // authorization, the rejection note and any notifications.
      try {
        await client.request(
          post(config.status.action_endpoint, {
            ids: group.rows.map((r) => r.id),
            status: option.value,
            // The status each row showed: the endpoint may refuse (409) rows
            // someone changed since this list loaded instead of overwriting
            // them. The refetch below shows what they are now.
            expected: Object.fromEntries(
              group.rows.map((r) => [String(r.id), r.status == null ? null : String(r.status)])
            ),
            ...(note ? { note } : {}),
            ...(hostRecordId != null && hostRecordId !== ''
              ? { workflow_id: Number(hostRecordId) }
              : {})
          })
        )
      } catch (err) {
        const resp = (err as { response?: { error?: string } })?.response
        failureMsg = resp?.error ?? 'Failed to update'
      }
    } else {
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
          // No endpoint configured: the note still reaches the audit trail as
          // the write's change reason.
          if (note) body._change_reason = note
          try {
            await client.request(patch(`/items/${config.collection}/${row.id}`, body))
            return { ok: true as const }
          } catch (err) {
            const resp = (err as { response?: { error?: string } })?.response
            return { ok: false as const, error: resp?.error ?? 'Failed to update' }
          }
        })
      )
      const failures = results.filter((r) => !r.ok)
      if (failures.length > 0) {
        failureMsg = `${failures.length} of ${group.rows.length} row(s) failed to update`
      }
    }
    setActingGroup(null)
    setGroupErrors((prev) => {
      const next = { ...prev }
      if (failureMsg) next[group.key] = failureMsg
      else delete next[group.key]
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
          const isOpen = singleGroup ? !expanded.has(group.key) : expanded.has(group.key)
          // Every row must be decidable by the caller for the buttons to show;
          // unknown (no enrich endpoint) = allowed, the endpoint still enforces.
          const canAct = group.rows.every((r) => enrichFor(r.id)?.can_act !== false)
          const viewOnlyReason =
            group.rows.map((r) => enrichFor(r.id)?.reason).find((v) => !!v) ??
            'Only the workflow contact chain (or the PO requestor for invalid holds) can decide this'
          // The reason behind the group's decision (a rejection), when the
          // enrich endpoint carries one (army 8 b07-N14).
          const decisionNote = group.rows.map((r) => enrichFor(r.id)?.note?.trim()).find((v) => !!v) ?? null
          const name = groupName(group, groupMetaCols)
          const badge = group.mixedStatus
            ? { label: 'Mixed', color: null }
            : statusDisplay(group.uniformStatus, config.status)
          const firstRow = group.rows[0]
          const stampUser = firstRow.stamp_user
          const stampDate = firstRow.stamp_date
          // A group inherits the loudest tone its rows were enriched with, so
          // "overdue" is visible before anything is expanded.
          const tone = group.rows.reduce<'danger' | 'warn' | null>((worst, r) => {
            for (const chip of enrichFor(r.id)?.chips ?? []) {
              if (chip.tone === 'danger') return 'danger'
              if (chip.tone === 'warn' && worst == null) worst = 'warn'
            }
            return worst
          }, null)

          return (
            <div
              key={group.key}
              data-review-group={group.key}
              data-review-tone={tone ?? undefined}
              className={cn(
                'rounded-md border',
                tone === 'danger'
                  ? 'border-l-2 border-l-red-500 border-red-200 bg-red-50/40 dark:border-red-500/40 dark:bg-red-500/5'
                  : tone === 'warn'
                    ? 'border-l-2 border-l-amber-500 border-amber-200 bg-amber-50/40 dark:border-amber-500/40 dark:bg-amber-500/5'
                    : 'border-slate-200 dark:border-border'
              )}
            >
              <div className='flex w-full flex-wrap items-center gap-2 px-3 py-2'>
                <button
                  type='button'
                  onClick={() => toggleGroup(group.key)}
                  className='flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left'
                >
                  <ChevronRight
                    className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                  />
                  <span
                    className='text-[12px] font-medium text-slate-700 dark:text-slate-200'
                    data-review-group-title
                  >
                    {name.title}
                  </span>
                  {name.subtitle && (
                    <span className='text-[11.5px] text-slate-500 dark:text-slate-400'>
                      {name.subtitle}
                    </span>
                  )}
                  <span className='text-[11px] text-slate-400'>
                    {countLabel(group.count, config.row_noun)}
                    {group.sum != null
                      ? ` · ${formatValue(group.sum, config.aggregate_sum_format ?? 'number')}`
                      : ''}
                  </span>
                  {groupMetaCols.map((c) => {
                    // A title / subtitle names the group above; not a chip too.
                    if (c.role) return null
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
                  {!canAct && (
                    <span
                      className='text-[11px] text-slate-400'
                      title={viewOnlyReason}
                      data-review-view-only
                    >
                      View only
                    </span>
                  )}
                  {canAct &&
                    config.status.options.map((option) => {
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
              {decisionNote && (
                <p
                  data-review-decision-note
                  className='border-t border-slate-100 px-3 py-1.5 text-[11.5px] text-red-700 dark:border-border dark:text-red-300'
                >
                  <span className='font-medium'>Reason:</span>{' '}
                  <span className='whitespace-pre-line'>{decisionNote}</span>
                </p>
              )}
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
                        {hasChips && <th className='px-2.5 py-1.5 font-medium'>Match</th>}
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
                          {hasChips && (
                            <td className='px-2.5 py-1.5'>
                              <span className='flex flex-wrap gap-1'>
                                {(enrichFor(row.id)?.chips ?? []).map((chip) => (
                                  <span
                                    key={chip.label}
                                    title={chip.title}
                                    className={
                                      chip.tone === 'ok'
                                        ? 'rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                                        : chip.tone === 'danger'
                                          ? 'rounded-full bg-red-50 px-2 py-0.5 text-[10.5px] font-medium text-red-700 dark:bg-red-500/10 dark:text-red-400'
                                          : chip.tone === 'warn'
                                            ? 'rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
                                            : 'rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                                    }
                                  >
                                    {chip.label}
                                  </span>
                                ))}
                              </span>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })}
        {noteAsk && (
          <div
            className='fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-4'
            onClick={() => setNoteAsk(null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setNoteAsk(null)
              }
            }}
          >
            <div
              role='dialog'
              aria-modal='true'
              aria-labelledby='review-confirm-title'
              data-review-confirm={noteAsk.option.value}
              className='w-full max-w-md rounded-lg border border-slate-200 bg-white p-4 shadow-xl dark:border-border dark:bg-card'
              onClick={(e) => e.stopPropagation()}
            >
              <p
                id='review-confirm-title'
                className='text-[13px] font-medium text-slate-700 dark:text-slate-200'
              >
                {confirmTitle(
                  noteAsk.option,
                  groupName(noteAsk.group, groupMetaCols),
                  config.group_noun
                )}
              </p>
              <p className='mt-1 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[12px] tabular-nums text-slate-600 dark:border-border dark:bg-white/[0.03] dark:text-slate-300'>
                {countLabel(noteAsk.group.count, config.row_noun)}
                {noteAsk.group.sum != null
                  ? ` · ${formatValue(noteAsk.group.sum, config.aggregate_sum_format ?? 'number')}`
                  : ''}
              </p>
              <p
                className='mt-1.5 text-[11px] text-slate-500 dark:text-slate-400'
                data-review-confirm-notice
              >
                {noteAsk.option.confirm_notice
                  ? `${noteAsk.option.confirm_notice}${noteAsk.option.require_note ? ' A reason is required.' : ''}`
                  : noteAsk.option.require_note
                    ? 'A reason is required for this decision. It is recorded with the record.'
                    : 'Nothing changes until you confirm. A note is optional and is recorded with the decision.'}
              </p>
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                rows={3}
                autoFocus
                aria-label={noteAsk.option.require_note ? 'Reason' : 'Note (optional)'}
                data-review-confirm-note
                className='mt-2 w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-700 outline-none focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-200'
                placeholder={
                  noteAsk.option.require_note ? 'Why is this being rejected?' : 'Note (optional)'
                }
              />
              <div className='mt-3 flex items-center justify-end gap-1.5'>
                <button
                  type='button'
                  data-review-confirm-cancel
                  onClick={() => setNoteAsk(null)}
                  className='rounded px-2.5 py-1 text-[11px] text-slate-500 hover:bg-slate-100 dark:hover:bg-muted'
                >
                  Cancel
                </button>
                <button
                  type='button'
                  data-review-confirm-submit
                  disabled={!!noteAsk.option.require_note && !noteText.trim()}
                  onClick={() => {
                    const ask = noteAsk
                    setNoteAsk(null)
                    void performAction(ask.group, ask.option, noteText.trim() || null)
                  }}
                  className={cn(
                    'rounded px-3 py-1 text-[11px] font-medium hover:brightness-110 disabled:opacity-50',
                    noteAsk.option.require_note ? 'bg-red-600 text-white' : 'bg-nvr-cyan text-white'
                  )}
                >
                  {noteAsk.option.label}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
