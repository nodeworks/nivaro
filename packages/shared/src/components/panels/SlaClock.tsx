import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock3 } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, post } from '../../lib/commands'
import { formatRelative, humanHours } from '../../lib/utils'
import { invalidateRecordNotes } from '../item-edit/RecordInsights'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * Per-record SLA clock (#1239). The status read the breach banner and the
 * pipeline panel share, plus the "Adjust clock" popover: the current step's
 * owner (or an admin) extends or shortens THIS record's clock in its current
 * state, with a required reason. The rule itself is untouched and the
 * override ends when the record leaves the state.
 */

export interface SlaOverrideInfo {
  id: number
  duration_hours: number
  rule_duration_hours: number
  reason: string
  set_by: string | null
  set_by_name: string | null
  set_at: string
}

export interface SlaStatusData {
  status?: 'none' | 'on_track' | 'warning' | 'breached'
  elapsed_hours?: number
  total_hours?: number
  pct_used?: number
  sla_rule?: { name?: string; duration_hours?: number } | null
  acknowledged?: { at: string; by: string } | null
  has_ladder?: boolean
  can_adjust?: boolean
  override?: SlaOverrideInfo | null
}

function errorText(e: unknown): string | null {
  const err = e as { response?: { error?: string }; message?: string } | null
  return err?.response?.error ?? err?.message ?? null
}

export function slaStatusKey(collection: string, itemId: string) {
  return ['sla-breach', collection, itemId] as const
}

export function useSlaStatus(collection: string, itemId: string | null | undefined) {
  const client = useNivaroClient()
  return useQuery<SlaStatusData | null>({
    queryKey: slaStatusKey(collection, String(itemId ?? '')),
    queryFn: () =>
      client
        .request<Record<string, unknown>>(get(`/sla/status/${collection}/${itemId}`))
        .then((r) => r as never)
        .catch(() => null),
    enabled: !!itemId,
    staleTime: 60_000
  })
}

/** "Adjusted to 48h (rule: 24h) by Rob Lee, 2h ago — waiting on vendor" */
export function overrideSentence(o: SlaOverrideInfo): string {
  const who = o.set_by_name ? ` by ${o.set_by_name}` : ''
  return `Clock adjusted to ${humanHours(o.duration_hours)} (rule: ${humanHours(o.rule_duration_hours)})${who}, ${formatRelative(o.set_at)}`
}

export function AdjustClockPopover({
  collection,
  itemId,
  data,
  tone = 'neutral'
}: {
  collection: string
  itemId: string
  data: SlaStatusData
  tone?: 'neutral' | 'danger'
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [hours, setHours] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const ruleHours = data.sla_rule?.duration_hours ?? null
  const elapsed = data.elapsed_hours ?? 0

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: slaStatusKey(collection, itemId) })
    // The adjustment is written as a note on the record.
    invalidateRecordNotes(qc as never, collection, itemId)
  }

  const save = useMutation({
    mutationFn: () =>
      client.request(
        post(`/sla/override/${collection}/${itemId}`, {
          duration_hours: Number(hours),
          reason: reason.trim()
        })
      ),
    onSuccess: () => {
      setOpen(false)
      setReason('')
      setError(null)
      invalidate()
    },
    onError: (e: unknown) => setError(errorText(e) ?? 'Could not adjust the clock')
  })

  const reset = useMutation({
    mutationFn: () =>
      client.request(
        del(
          `/sla/override/${collection}/${itemId}${reason.trim() ? `?reason=${encodeURIComponent(reason.trim())}` : ''}`
        )
      ),
    onSuccess: () => {
      setOpen(false)
      setReason('')
      setError(null)
      invalidate()
    },
    onError: (e: unknown) => setError(errorText(e) ?? 'Could not reset the clock')
  })

  const n = Number(hours)
  const valid = Number.isFinite(n) && n > 0 && n <= 8760 && reason.trim().length > 0
  const preview = Number.isFinite(n) && n > 0 ? n - elapsed : null

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setHours(String(data.override?.duration_hours ?? data.total_hours ?? ruleHours ?? ''))
          setError(null)
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          data-sla-adjust
          className={
            tone === 'danger'
              ? 'shrink-0 rounded-md border border-red-300 px-2.5 py-1 text-[12px] font-medium text-red-700 hover:bg-red-100 dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-500/15'
              : 'shrink-0 rounded-md border border-slate-200 px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:bg-muted dark:border-border dark:text-slate-200'
          }
        >
          Adjust clock
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[320px] space-y-3 p-3' data-sla-adjust-panel>
        <div>
          <p className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
            Adjust this record's SLA clock
          </p>
          <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-slate-400'>
            {ruleHours != null ? `The rule allows ${humanHours(ruleHours)}. ` : ''}
            {humanHours(elapsed)} used so far. Applies only while the record stays in this step.
          </p>
        </div>
        <label className='block space-y-1'>
          <span className='text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
            Allowed hours
          </span>
          <input
            type='number'
            min={0.5}
            step={0.5}
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            data-sla-adjust-hours
            className='h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[12.5px] text-slate-800 dark:border-border dark:bg-card dark:text-slate-100'
          />
          {preview != null && (
            <span className='block text-[11px] text-slate-500 dark:text-slate-400'>
              {preview >= 0
                ? `${humanHours(preview)} left after the change`
                : `Breached by ${humanHours(-preview)} after the change`}
            </span>
          )}
        </label>
        <label className='block space-y-1'>
          <span className='text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
            Reason
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder='Why this record needs a different clock'
            data-sla-adjust-reason
            className='w-full resize-none rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12.5px] text-slate-800 dark:border-border dark:bg-card dark:text-slate-100'
          />
        </label>
        {error && <p className='text-[11.5px] text-red-600 dark:text-red-400'>{error}</p>}
        <div className='flex items-center gap-2'>
          {data.override && (
            <button
              type='button'
              disabled={reset.isPending}
              onClick={() => reset.mutate()}
              data-sla-adjust-reset
              className='rounded-md px-2 py-1 text-[12px] text-slate-600 hover:bg-muted disabled:opacity-50 dark:text-slate-300'
            >
              {reset.isPending ? 'Resetting…' : 'Back to the rule'}
            </button>
          )}
          <button
            type='button'
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
            data-sla-adjust-save
            className='ml-auto rounded-md bg-nvr-cyan px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50'
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * The pipeline panel's SLA line: time left on this step's clock, who adjusted
 * it and why, and the Adjust clock action for people allowed to move it.
 * Renders nothing for records with no SLA rule in their current state.
 */
export function SlaClockLine({ collection, itemId }: { collection: string; itemId: string }) {
  const { data } = useSlaStatus(collection, itemId)
  if (!data?.status || data.status === 'none' || data.total_hours == null) return null
  const left = data.total_hours - (data.elapsed_hours ?? 0)
  const tone =
    data.status === 'breached'
      ? 'text-red-700 dark:text-red-300'
      : data.status === 'warning'
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-slate-600 dark:text-slate-300'
  return (
    <div className='flex flex-wrap items-center gap-2' data-sla-clock-line={data.status}>
      <Clock3 className='h-3.5 w-3.5 shrink-0 text-slate-400' />
      <p className={`min-w-0 flex-1 text-[12px] ${tone}`}>
        <span className='font-medium'>SLA</span>
        {data.sla_rule?.name ? ` · ${data.sla_rule.name}` : ''} ·{' '}
        {left >= 0
          ? `${humanHours(left)} left of ${humanHours(data.total_hours)}`
          : `${humanHours(-left)} past the ${humanHours(data.total_hours)} limit`}
        {data.override && (
          <span
            className='ml-1 text-slate-500 dark:text-slate-400'
            data-tip={data.override.reason}
            data-sla-override
          >
            · {overrideSentence(data.override)}
          </span>
        )}
      </p>
      {data.can_adjust && (
        <AdjustClockPopover collection={collection} itemId={itemId} data={data} />
      )}
    </div>
  )
}
