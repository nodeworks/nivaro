import { useDeadlineNow } from '../lib/deadline-ticker'
import { forStepText, inStepSpan } from '../lib/in-step'
import { formatDateTime } from '../lib/utils'

/**
 * Time in the current step, ticking on the page's one shared clock (lib/in-step.ts). Nothing
 * fades or moves when a minute passes — the text simply reads the new span; a move resets it
 * when the row / panel refetches with the new step.
 */

/** The list cell: "3 d 4 h · Finance" — the span leads (it is what you scan a column for), the
 *  step follows muted, so a STATE column beside it does not make the cell read as a repeat. */
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
      className='flex min-w-0 max-w-full items-baseline gap-1.5 overflow-hidden whitespace-nowrap'
    >
      <span className='shrink-0 font-medium tabular-nums text-slate-800 dark:text-slate-100'>
        {span}
      </span>
      {label && (
        // min-w-0: a flex item never shrinks below its text without it, so the name was cut
        // mid-word by the cell ("Submissio") instead of ending in an ellipsis.
        <span className='min-w-0 truncate text-[0.92em] text-slate-500 dark:text-slate-400'>
          {label}
        </span>
      )}
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
