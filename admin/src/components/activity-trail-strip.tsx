import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn, formatDateTime, formatNumber, formatRelative } from '@/lib/utils'

/**
 * Tamper-evident activity trail strip (#16): "Trail intact through <time>" or the first broken
 * entry, the sealing backlog, and Check now / Full check. With `full`, also the acknowledge
 * form for a break and the evidence export. Security & privacy (compact) and Log retention.
 */

interface CheckpointSummary {
  id: number
  kind: string
  verified_at: string
  verified_ok: boolean
  partial: boolean
  last_seq: number
  row_count: number
  mismatch_count: number
  mismatch_first_id: number | null
  mismatch_reason: string | null
  acknowledged_at: string | null
}

export interface TrailStatus {
  state: 'not_migrated' | 'not_verified' | 'intact' | 'broken' | 'acknowledged'
  intact_through: string | null
  last_verified_at: string | null
  head: { seq: number; id: number | null; at: string | null }
  unsealed: number | null
  oldest_unsealed_at: string | null
  last_check: CheckpointSummary | null
  broken: CheckpointSummary | null
  verified_share: number | null
  verify_running: boolean
}

export const TRAIL_STATUS_KEY = ['activity-trail', 'status'] as const

export function useTrailStatus() {
  return useQuery<TrailStatus>({
    queryKey: TRAIL_STATUS_KEY,
    queryFn: () => api.get('/activity-trail/status').then((r) => r.data.data),
    refetchInterval: (q) => (q.state.data?.verify_running ? 4000 : 60_000)
  })
}

const errText = (e: unknown, dflt: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? dflt

export function ActivityTrailStrip({ full = false }: { full?: boolean }) {
  const qc = useQueryClient()
  const { data, isLoading } = useTrailStatus()
  const [note, setNote] = useState('')
  const [ackOpen, setAckOpen] = useState(false)

  const verify = useMutation({
    mutationFn: (fullCheck: boolean) => api.post('/activity-trail/verify', { full: fullCheck }),
    onSuccess: () => {
      toast.success('Check started — this page updates when it finishes')
      void qc.invalidateQueries({ queryKey: TRAIL_STATUS_KEY })
    },
    onError: (e) => toast.error(errText(e, 'Could not start the check'))
  })
  const ack = useMutation({
    mutationFn: (id: number) =>
      api.post(`/activity-trail/checkpoints/${id}/acknowledge`, { note: note.trim() }),
    onSuccess: () => {
      toast.success('Break acknowledged — checks continue from here')
      setAckOpen(false)
      setNote('')
      void qc.invalidateQueries({ queryKey: ['activity-trail'] })
    },
    onError: (e) => toast.error(errText(e, 'Could not acknowledge'))
  })

  if (isLoading || !data) {
    return <div className='h-[58px] animate-pulse rounded-lg bg-[var(--nvr-skeleton)]' />
  }
  if (data.state === 'not_migrated') {
    return (
      <div className='rounded-lg border border-slate-200 bg-white px-4 py-3 text-[12.5px] text-slate-500 dark:border-border dark:bg-card dark:text-slate-400'>
        Activity trail sealing is not set up on this database yet (migration 518).
      </div>
    )
  }

  const tone =
    data.state === 'broken'
      ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'
      : data.state === 'intact' || data.state === 'acknowledged'
        ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200'
        : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100'
  const Icon =
    data.state === 'broken'
      ? ShieldAlert
      : data.state === 'not_verified'
        ? ShieldQuestion
        : ShieldCheck
  const backlogOld =
    data.oldest_unsealed_at && Date.now() - Date.parse(data.oldest_unsealed_at) > 10 * 60_000

  const headline =
    data.state === 'broken' && data.broken
      ? `Trail broken at entry #${data.broken.mismatch_first_id ?? '?'}`
      : data.state === 'not_verified'
        ? 'Activity trail sealed, not checked yet'
        : data.intact_through
          ? `Trail intact through ${formatDateTime(data.intact_through)}`
          : 'Trail intact'

  return (
    <div
      data-activity-trail-strip
      role='status'
      className={cn('rounded-lg border px-4 py-3', tone)}
    >
      <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
        <Icon className='size-4 shrink-0' aria-hidden />
        <div className='min-w-0 flex-1'>
          <p className='text-[13px] font-semibold'>{headline}</p>
          <p className='text-[11.5px] opacity-80'>
            {data.state === 'broken' && data.broken ? (
              <>
                {data.broken.mismatch_reason ?? 'An entry does not match its seal'}
                {data.broken.mismatch_count > 1 &&
                  ` · ${formatNumber(data.broken.mismatch_count)} entries affected`}
                {' · '}
                {data.broken.mismatch_first_id != null && (
                  <Link
                    to={`/activity/${data.broken.mismatch_first_id}`}
                    className='underline underline-offset-2'
                  >
                    Open the entry
                  </Link>
                )}
              </>
            ) : (
              <>
                {data.last_verified_at
                  ? `Checked ${formatRelative(data.last_verified_at)}`
                  : 'The daily check runs at 02:40 UTC'}
                {data.state === 'acknowledged' && ' · an earlier break was acknowledged'}
                {data.last_check?.partial &&
                  ' · the last check stopped on its time budget and continues next run'}
              </>
            )}
            {data.unsealed != null && data.unsealed > 0 && (
              <span className={cn(backlogOld && 'font-medium')}>
                {' · '}
                {formatNumber(data.unsealed)} entr{data.unsealed === 1 ? 'y' : 'ies'} waiting to be
                sealed
              </span>
            )}
          </p>
        </div>
        {data.verify_running ? (
          <span className='text-[12px] font-medium'>Checking…</span>
        ) : (
          <div className='flex items-center gap-1.5'>
            <button
              type='button'
              onClick={() => verify.mutate(false)}
              disabled={verify.isPending}
              className='h-7 rounded-md border border-black/10 bg-white/70 dark:border-white/15 px-2.5 text-[12px] font-medium hover:bg-white dark:bg-black/20 dark:hover:bg-black/30'
            >
              Check now
            </button>
            {full && (
              <button
                type='button'
                onClick={() => verify.mutate(true)}
                disabled={verify.isPending}
                data-tip='Recompute the whole chain from its first entry (slow on a large log)'
                className='h-7 rounded-md border border-black/10 bg-white/70 dark:border-white/15 px-2.5 text-[12px] font-medium hover:bg-white dark:bg-black/20 dark:hover:bg-black/30'
              >
                Full check
              </button>
            )}
            {full && data.state === 'broken' && data.broken && (
              <button
                type='button'
                onClick={() => setAckOpen((o) => !o)}
                className='h-7 rounded-md border border-black/10 bg-white/70 dark:border-white/15 px-2.5 text-[12px] font-medium hover:bg-white dark:bg-black/20 dark:hover:bg-black/30'
              >
                Acknowledge…
              </button>
            )}
          </div>
        )}
      </div>
      {full && ackOpen && data.broken && (
        <div className='mt-3 flex flex-wrap items-center gap-2'>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder='What you found and why the break is accepted (audited)'
            className='h-8 min-w-[280px] flex-1 rounded-md border border-red-200 bg-white px-2.5 text-[12.5px] text-slate-800 dark:border-red-500/30 dark:bg-card dark:text-foreground'
          />
          <button
            type='button'
            disabled={!note.trim() || ack.isPending}
            onClick={() => data.broken && ack.mutate(data.broken.id)}
            className='h-8 rounded-md bg-red-600 px-3 text-[12px] font-medium text-white disabled:opacity-50'
          >
            Acknowledge break
          </button>
          <p className='w-full text-[11.5px] opacity-80'>
            Checks then continue from this point. The break stays in the check history and in every
            evidence export that covers it.
          </p>
        </div>
      )}
    </div>
  )
}
