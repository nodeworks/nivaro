import { cn } from '../../../../lib/utils'

const STATUS_TONE: Record<string, string> = {
  accepted: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  failed: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  rejected: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  pending: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400',
  submitted: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400'
}

/** A submission / attempt status, as a small tinted chip. */
export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide',
        STATUS_TONE[status] ?? 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-slate-300'
      )}
    >
      {status}
    </span>
  )
}
