import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, FileDiff } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { useLivePreference, useLiveRecordQueries } from '../../lib/live'
import { cn, formatDateTime, formatRelative, toLocalDateString } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * "Changed after approval" (round 7, item 21; api services/approval-changes.ts): a badge in the
 * record header when the record changed after it reached an approved step, with a compact diff —
 * the approved value → the value now, who changed it and when. Read as the viewer (their field
 * list applies on the server). Live: any change to the record refetches it, coalesced; under the
 * person's Off setting it waits for a refresh like every other live surface, and Calm drops the
 * fade.
 */

export interface ApprovalChangeRow {
  field: string
  label: string
  type: string | null
  before: unknown
  after: unknown
  before_known: boolean
  before_text?: string | null
  after_text?: string | null
  by: { id: string | null; name: string; via: string }
  at: string | null
}

export interface ApprovalChangesData {
  enabled: boolean
  approved: {
    at: string
    state: string
    state_label: string | null
    by: Array<{ id: string; name: string }>
  } | null
  changes: ApprovalChangeRow[]
  total: number
  lines: { count: number; at: string | null; by: string | null } | null
}

export const approvalChangesKey = (collection: string, itemId: string) => [
  'approval-changes',
  collection,
  itemId
]

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}(T00:00:00(\.0+)?Z)?$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/** A value as a reader sees it in the diff (never an id where a label exists). */
export function approvalValueText(
  value: unknown,
  text?: string | null,
  type?: string | null
): string {
  if (text) return text
  if (value == null || value === '') return 'Empty'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return value.toLocaleString('en-US', { maximumFractionDigits: 4 })
  if (typeof value === 'object') return Array.isArray(value) ? `${value.length} items` : 'Changed'
  const s = String(value)
  const t = String(type ?? '').toLowerCase()
  if (t === 'date' || DATE_ONLY.test(s)) return toLocalDateString(s)
  if (DATE_TIME.test(s)) return formatDateTime(s)
  if (t === 'boolean' && (s === '1' || s === '0')) return s === '1' ? 'Yes' : 'No'
  if (/^-?\d+(\.\d+)?$/.test(s) && (t === 'decimal' || t === 'float' || t === 'integer'))
    return Number(s).toLocaleString('en-US', { maximumFractionDigits: 4 })
  return s.length > 80 ? `${s.slice(0, 77)}…` : s
}

function whoText(c: ApprovalChangeRow): string {
  if (c.by.via === 'outside') return 'Changed outside the app'
  return c.at ? `${c.by.name} · ${formatRelative(c.at)}` : c.by.name
}

export function ChangedAfterApprovalBadge({
  collection,
  itemId,
  enabled
}: {
  collection: string
  itemId: string
  /** The collection has the badge on (client twin: approvalBadgeStates). */
  enabled: boolean
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const live = useLivePreference()
  const [open, setOpen] = useState(false)
  const key = approvalChangesKey(collection, itemId)
  const { data } = useQuery<ApprovalChangesData | null>({
    queryKey: key,
    queryFn: () =>
      client
        .request<{ data: ApprovalChangesData }>(
          get(`/approval-changes/record/${collection}/${encodeURIComponent(itemId)}`)
        )
        .then((r) => r.data ?? null)
        .catch(() => null),
    enabled: enabled && !!itemId && itemId !== 'new',
    staleTime: 30_000
  })
  // Any write to the record (fields, a move into or out of the approved step) may change the
  // answer. Coalesced to one refetch a second; the viewer's own saves count too (an admin
  // editing through the lock sees the badge appear).
  useLiveRecordQueries(collection, itemId, [key], {
    client: qc,
    debounceMs: 1000,
    includeOwn: true,
    enabled: enabled && !!data?.enabled
  })

  if (!enabled || !data?.approved) return null
  const count = data.total + (data.lines?.count ? 1 : 0)
  if (count === 0) return null
  const approvers = data.approved.by.map((p) => p.name)
  const stepLabel = data.approved.state_label || data.approved.state
  const more = data.total - data.changes.length
  const summary =
    data.total > 0
      ? `${data.total} field${data.total === 1 ? '' : 's'} changed after approval`
      : 'Lines changed after approval'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-approval-changes-badge
          aria-label={`${summary} — show what changed`}
          data-tip={summary}
          // key: the count changing re-runs the short fade in Normal (Calm / reduced motion: none)
          key={live.normal ? count : undefined}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-px text-[10.5px] font-semibold',
            'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100',
            'dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-200 dark:hover:bg-amber-400/20',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
            live.normal && 'nvr-fade-in'
          )}
        >
          <FileDiff className='h-3 w-3' aria-hidden />
          Changed after approval
          {data.total > 1 && (
            <span className='tabular-nums font-medium text-amber-700/80 dark:text-amber-200/70'>
              · {data.total}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[min(26rem,calc(100vw-2rem))] p-0'
        data-approval-changes-panel
      >
        <div className='border-b border-slate-200 px-3.5 pb-2.5 pt-3 dark:border-border'>
          <p className='text-[13px] font-semibold text-slate-900 dark:text-slate-50'>
            Changed after approval
          </p>
          <p className='mt-0.5 text-[11.5px] leading-snug text-slate-500 dark:text-slate-400'>
            Reached {stepLabel} on {formatDateTime(data.approved.at)}
            {approvers.length > 0 && <> · approved by {approvers.slice(0, 3).join(', ')}</>}
          </p>
        </div>
        <ul className='max-h-[min(22rem,60vh)] divide-y divide-slate-100 overflow-y-auto dark:divide-border'>
          {data.changes.map((c) => (
            <li key={c.field} className='px-3.5 py-2.5' data-approval-change={c.field}>
              <div className='flex items-baseline justify-between gap-3'>
                <span className='truncate text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                  {c.label}
                </span>
                <span
                  className={cn(
                    'shrink-0 text-[10.5px]',
                    c.by.via === 'outside'
                      ? 'text-amber-700 dark:text-amber-300'
                      : 'text-slate-400 dark:text-slate-500'
                  )}
                  data-tip={c.at ? formatDateTime(c.at) : undefined}
                >
                  {whoText(c)}
                </span>
              </div>
              <div className='mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px]'>
                {c.before_known ? (
                  <span
                    className='min-w-0 break-words text-slate-500 line-through decoration-slate-300 dark:text-slate-400 dark:decoration-slate-600'
                    data-tip='Value when it was approved'
                  >
                    {approvalValueText(c.before, c.before_text, c.type)}
                  </span>
                ) : (
                  <span className='italic text-slate-400 dark:text-slate-500'>
                    Approved value not recorded
                  </span>
                )}
                <ArrowRight
                  className='h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500'
                  aria-label='now'
                />
                <span className='min-w-0 break-words font-semibold text-slate-900 dark:text-slate-50'>
                  {approvalValueText(c.after, c.after_text, c.type)}
                </span>
              </div>
            </li>
          ))}
          {data.lines && (
            <li className='px-3.5 py-2.5 text-[12px] text-slate-600 dark:text-slate-300'>
              {data.lines.count} line change{data.lines.count === 1 ? '' : 's'}
              {data.lines.by && <> · last by {data.lines.by}</>}
              {data.lines.at && (
                <span className='text-slate-400 dark:text-slate-500'>
                  {' '}
                  · {formatRelative(data.lines.at)}
                </span>
              )}
            </li>
          )}
        </ul>
        {more > 0 && (
          <p className='border-t border-slate-200 px-3.5 py-2 text-[11px] text-slate-500 dark:border-border dark:text-slate-400'>
            {more} more field{more === 1 ? '' : 's'} changed — the record's history has every
            change.
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
