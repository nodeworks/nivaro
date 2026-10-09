import { AlertCircle, AlertTriangle, Check, RotateCw } from 'lucide-react'
import { Button } from '../../ui/button'
import type { useAutosave } from './useAutosave'

const PROBLEMS = new Set(['conflict', 'invalid', 'error'])

/**
 * The editor header's save line: routine states in muted text, problems
 * with what to do about them (Reload after a conflict, Try now).
 *
 * Only problems are announced. "Saving…" and "All changes saved" come and go
 * with every edit, so they stay out of the live region; a visually hidden
 * status carries the problem's message alone.
 */
export function SaveState({
  save,
  onReload
}: {
  save: ReturnType<typeof useAutosave>
  onReload: () => void
}) {
  const body = (() => {
    switch (save.status) {
      case 'idle':
        return <span className='text-muted-foreground'>Changes save as you go</span>
      case 'saving':
        return (
          <span className='flex items-center gap-1.5 text-muted-foreground'>
            <span
              className='h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground motion-reduce:animate-none'
              aria-hidden
            />
            Saving…
          </span>
        )
      case 'saved':
        return (
          <span className='flex items-center gap-1 text-muted-foreground'>
            <Check className='h-3.5 w-3.5' aria-hidden />
            All changes saved
          </span>
        )
      case 'conflict':
        return (
          <span className='flex flex-wrap items-center gap-x-2 gap-y-1'>
            <span className='flex items-start gap-1.5 text-amber-800 dark:text-amber-200'>
              <AlertTriangle className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
              <span>{save.message}</span>
            </span>
            <Button
              size='sm'
              variant='outline'
              className='h-7 px-2 text-[12px]'
              onClick={onReload}
              data-hv-reload
            >
              <RotateCw className='!size-3.5' /> Reload
            </Button>
          </span>
        )
      case 'invalid':
        return (
          <span className='flex items-start gap-1.5 text-rose-700 dark:text-rose-300'>
            <AlertCircle className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
            <span>{save.message}</span>
          </span>
        )
      case 'error':
        return (
          <span className='flex items-start gap-1.5 text-rose-700 dark:text-rose-300'>
            <AlertCircle className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
            <span>
              {save.message}{' '}
              <button
                type='button'
                className='ml-1 rounded-sm font-medium text-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                onClick={() => void save.flush()}
                data-hv-save-retry
              >
                Try now
              </button>
            </span>
          </span>
        )
    }
  })()
  const problem = PROBLEMS.has(save.status)
  return (
    <div className='min-w-0 text-[12px]' data-hv-save-status={save.status}>
      {/* The visible line is not a live region: routine states stay quiet. */}
      {body}
      <span className='sr-only' role='status' data-hv-save-announce>
        {problem ? save.message : ''}
      </span>
    </div>
  )
}
