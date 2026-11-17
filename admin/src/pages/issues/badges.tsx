import { cn } from '@/lib/utils'
import { SOURCE_LABEL, statusLabel } from './types'

// Severity reads by shape as well as colour: filled for critical/high, a ring for medium,
// hollow for low (WCAG 1.4.1 — orange and amber are close).
const SEVERITY_DOT: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'border-2 border-amber-500 bg-transparent',
  low: 'border border-slate-400 bg-transparent'
}

const SEVERITY_TEXT: Record<string, string> = {
  critical: 'text-red-700 dark:text-red-400',
  high: 'text-orange-700 dark:text-orange-400',
  medium: 'text-amber-700 dark:text-amber-300',
  low: 'text-slate-600 dark:text-slate-400'
}

export function SeverityDot({ severity, className }: { severity: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block h-2 w-2 shrink-0 rounded-full',
        SEVERITY_DOT[severity] ?? SEVERITY_DOT.medium,
        className
      )}
    />
  )
}

export function SeverityLabel({ severity }: { severity: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] font-medium capitalize',
        SEVERITY_TEXT[severity] ?? SEVERITY_TEXT.medium
      )}
    >
      <SeverityDot severity={severity} />
      {severity}
    </span>
  )
}

const STATUS_BADGE: Record<string, string> = {
  open: 'border-nvr-cyan/30 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan',
  in_progress: 'border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  resolved: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  closed: 'border-slate-400/30 bg-slate-500/10 text-slate-600 dark:text-slate-400'
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded border px-1.5 py-px text-[10.5px] font-medium',
        STATUS_BADGE[status] ?? STATUS_BADGE.open
      )}
    >
      {statusLabel(status)}
    </span>
  )
}

export function SourceTag({ source }: { source?: string | null }) {
  if (!source) return null
  return (
    <span className='whitespace-nowrap rounded bg-slate-100 px-1.5 py-px text-[10.5px] font-medium text-slate-600 dark:bg-muted dark:text-muted-foreground'>
      {SOURCE_LABEL[source] ?? source}
    </span>
  )
}
