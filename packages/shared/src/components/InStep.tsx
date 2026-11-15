import { useDeadlineNow } from '../lib/deadline-ticker'
import { forStepText, inStepSpan } from '../lib/in-step'
import { formatDateTime } from '../lib/utils'

/**
 * Time in the current step, ticking on the page's one shared clock (lib/in-step.ts). Nothing
 * fades or moves when a minute passes — the text simply reads the new span; a move resets it
 * when the row / panel refetches with the new step.
 */

/** The list cell: "Finance · 3 d 4 h" (step muted, span in figures). */
export function InStepCell({
  stepLabel,
  enteredAt,
  done
}: {
  stepLabel: string | null | undefined
  enteredAt: string | null | undefined
  /** The record's pipeline finished: it sits in no step. */
  done?: boolean
}) {
  const now = useDeadlineNow(!done && !!enteredAt)
  const span = done ? null : inStepSpan(enteredAt, now)
  if (span == null) return <span className='text-slate-300 dark:text-slate-600'>—</span>
  const label = String(stepLabel ?? '').trim()
  return (
    <span
      data-in-step=''
      data-tip={`In ${label || 'this step'} since ${formatDateTime(enteredAt as string)}`}
      className='inline-flex max-w-[220px] items-baseline gap-1 whitespace-nowrap'
    >
      {label && <span className='truncate text-slate-500 dark:text-slate-400'>{label}</span>}
      {label && (
        <span aria-hidden className='text-slate-300 dark:text-slate-600'>
          ·
        </span>
      )}
      <span className='tabular-nums text-slate-700 dark:text-slate-200'>{span}</span>
    </span>
  )
}

/** The record header's "for 3 d 4 h" beside the step chip. Renders nothing without a time. */
export function StepForLine({
  enteredAt,
  stepLabel,
  className
}: {
  enteredAt: string | null | undefined
  stepLabel?: string | null
  className?: string
}) {
  const now = useDeadlineNow(!!enteredAt)
  const text = forStepText(enteredAt, now)
  if (!text) return null
  return (
    <span
      data-step-for=''
      data-tip={`In ${stepLabel || 'this step'} since ${formatDateTime(enteredAt as string)}`}
      className={`whitespace-nowrap text-[11.5px] tabular-nums text-slate-500 dark:text-slate-400 ${className ?? ''}`}
    >
      {text}
    </span>
  )
}
