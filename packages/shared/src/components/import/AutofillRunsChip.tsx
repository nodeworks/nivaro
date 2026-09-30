import { Loader2, Sparkles, X } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useApiFetchConfig } from '../../context'
import {
  type AutofillRun,
  dismissAutofillRun,
  hydrateAutofillRuns,
  useAutofillRuns
} from '../../lib/autofill-runs'
import { cn } from '../../lib/utils'

/**
 * The document-autofill runs the app is watching, as small chips in the
 * corner of EVERY page — mount once in the app shell. A reading run shows
 * its progress; a landed one becomes a Review button; a failed one says so.
 * Clicking hands the run to the host, which opens the new-record form on
 * `?autofill=<id>` (the form then shows the run's dialog and this chip
 * steps aside). Portals to <body>: a `fixed` element under an animated page
 * wrapper anchors to the wrapper, not the viewport.
 */
export function AutofillRunsChip({ onOpen }: { onOpen: (run: AutofillRun) => void }) {
  const cfg = useApiFetchConfig()
  // Runs a previous page load was watching come back after a reload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hydrate once per mount
  useEffect(() => hydrateAutofillRuns(cfg), [])
  const runs = useAutofillRuns().filter((r) => !r.presented)
  if (runs.length === 0 || typeof document === 'undefined') return null
  return createPortal(
    <div
      data-nvr-dock-aware
      className='fixed bottom-4 right-4 z-[110] flex flex-col items-end gap-2'
      data-autofill-chips={runs.length}
    >
      {runs.map((run) => (
        <div
          key={run.id}
          data-autofill-chip={run.status}
          className={cn(
            'flex max-w-[340px] items-center gap-2.5 rounded-full border py-2 pr-2 pl-3.5 text-left text-[12.5px] shadow-lg transition-colors',
            run.status === 'ready'
              ? 'border-nvr-cyan bg-nvr-cyan text-[#172940]'
              : run.status === 'failed'
                ? 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-[#3b1d1d] dark:text-rose-100'
                : 'border-slate-200 bg-white text-slate-700 dark:border-[#334155] dark:bg-[#1e293b] dark:text-slate-200'
          )}
        >
          <button
            type='button'
            onClick={() => onOpen(run)}
            className='flex min-w-0 items-center gap-2.5'
            title={
              run.status === 'ready'
                ? 'Open what the document says'
                : run.status === 'failed'
                  ? (run.error ?? 'Could not read the document')
                  : 'Show progress'
            }
          >
            {run.status === 'reading' ? (
              <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin text-nvr-navy dark:text-nvr-cyan' />
            ) : (
              <Sparkles className='h-3.5 w-3.5 shrink-0' />
            )}
            <span className='min-w-0'>
              <span className='block truncate font-medium'>
                {run.status === 'ready'
                  ? `${run.documentName} read — review it`
                  : run.status === 'failed'
                    ? `Could not read ${run.documentName}`
                    : `Reading ${run.documentName}`}
              </span>
              {run.status === 'reading' && (
                <span className='block truncate text-[11px] text-slate-500 dark:text-slate-400'>
                  Keeps going while you work
                </span>
              )}
            </span>
          </button>
          <button
            type='button'
            onClick={() => dismissAutofillRun(run.id)}
            aria-label='Dismiss'
            data-autofill-chip-dismiss
            className={cn(
              'ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
              run.status === 'ready'
                ? 'hover:bg-black/10'
                : 'hover:bg-black/5 dark:hover:bg-white/10'
            )}
          >
            <X className='h-3 w-3' />
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}
