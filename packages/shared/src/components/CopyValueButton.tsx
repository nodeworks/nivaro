import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '../lib/utils'

/**
 * An icon button that copies a value and SAYS it did: the icon turns into a green check and
 * "Copied" shows beside it for two seconds (a toast alone was easy to miss, and some hosts
 * show none). A refused clipboard (no permission, not a secure page) says so instead of
 * pretending. Used for one-time secrets such as a freshly generated API token.
 */
export function CopyValueButton({
  value,
  label = 'Copy',
  className,
  testId
}: {
  value: string
  /** What is being copied, for the accessible name ("Copy token"). */
  label?: string
  className?: string
  testId?: string
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const show = (s: 'copied' | 'failed') => {
    setState(s)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 2000)
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      show('copied')
    } catch {
      show('failed')
      toast.error('Could not copy — select the text and copy it instead')
    }
  }
  return (
    <span className='inline-flex shrink-0 items-center gap-1.5'>
      <button
        type='button'
        onClick={() => void copy()}
        aria-label={label}
        data-copy-state={state}
        data-testid={testId}
        className={cn(
          'rounded-md border p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
          state === 'copied'
            ? 'border-emerald-300 bg-emerald-50 text-emerald-600 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-400'
            : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-border dark:hover:bg-muted',
          className
        )}
      >
        {state === 'copied' ? <Check className='h-4 w-4' /> : <Copy className='h-4 w-4' />}
      </button>
      <span
        role='status'
        aria-live='polite'
        className={cn(
          'min-w-[3.25rem] text-[11.5px] font-medium',
          state === 'copied'
            ? 'text-emerald-600 dark:text-emerald-400'
            : state === 'failed'
              ? 'text-red-600 dark:text-red-400'
              : 'invisible'
        )}
      >
        {state === 'failed' ? 'Not copied' : 'Copied'}
      </span>
    </span>
  )
}
