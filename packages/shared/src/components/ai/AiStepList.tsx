import { Check, ChevronRight, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import type { AiStreamStep } from '../../lib/ai-steps'
import { cn } from '../../lib/utils'

/**
 * The tool steps of an answer being built (#1839), one plain line each —
 * "Reading workflows… 42 found". While the answer has not started they are
 * listed in full; once `folded` (the answer's text is arriving) they collapse
 * to one quiet "N steps" line a person can open again.
 */
export function AiStepList({
  steps,
  folded,
  className
}: {
  steps: AiStreamStep[]
  folded?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  if (steps.length === 0) return null
  const failed = steps.filter((s) => s.state === 'failed').length
  if (folded && !open) {
    return (
      <button
        type='button'
        onClick={() => setOpen(true)}
        className={cn(
          'mb-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground',
          className
        )}
        data-ai-steps-folded
      >
        <ChevronRight className='h-3 w-3' />
        {steps.length} step{steps.length === 1 ? '' : 's'}
        {failed > 0 ? ` · ${failed} failed` : ''}
      </button>
    )
  }
  return (
    <ul className={cn('mb-1.5 space-y-0.5', className)} data-ai-steps>
      {steps.map((s) => (
        <li
          key={s.key}
          className='flex items-center gap-1.5 text-[12px] text-muted-foreground'
          data-ai-step={s.state}
        >
          {s.state === 'running' ? (
            <Loader2 className='h-3 w-3 shrink-0 animate-spin' />
          ) : s.state === 'failed' ? (
            <X className='h-3 w-3 shrink-0 text-rose-600 dark:text-rose-400' />
          ) : (
            <Check className='h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400' />
          )}
          <span className='min-w-0 truncate'>
            {s.text}
            {s.result ? <span className='text-foreground/80'> {s.result}</span> : null}
            {s.state === 'failed' ? (
              <span className='text-rose-600 dark:text-rose-400'> did not work</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}
