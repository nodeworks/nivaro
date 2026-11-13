import { cn } from '../../../../lib/utils'
import { TONE_SOFT, TONE_TEXT } from '../tone'

const STATUS_TONE: Record<string, string> = {
  accepted: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  failed: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  rejected: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  pending: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400',
  submitted: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400',
  // Written before the partner call, still in flight (api erp-unanswered.ts).
  sending: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400',
  // …and past its time: the partner may already have it (the ERP tab's "no answer").
  'no answer': 'bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-300'
}

/**
 * A submission / attempt status, as a small tinted chip. `stale` = a `sending` send past its
 * time, named "no answer" as on every other screen.
 */
export function StatusPill({ status, stale }: { status: string; stale?: boolean }) {
  const shown = status === 'sending' && stale ? 'no answer' : status
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide',
        STATUS_TONE[shown] ?? 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-slate-300'
      )}
    >
      {shown}
    </span>
  )
}

/** An HTTP status from a Recent-calls row — 2xx reads positive, anything
 *  else (including no response at all) negative. Distinct from `StatusPill`,
 *  whose tones are submission LIFECYCLE words, not response codes. */
export function HttpStatusChip({ status, ok }: { status: number | null; ok: boolean }) {
  const tone = ok ? 'positive' : 'negative'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
        TONE_SOFT[tone],
        TONE_TEXT[tone]
      )}
    >
      {status ?? 'No response'}
    </span>
  )
}
