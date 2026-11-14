import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, FileUp, TriangleAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useItemEditAuth, useNivaroClient } from '../context'
import {
  type CollectionImportRun,
  formatElapsed,
  importBannerState,
  rowsText,
  runningTitle
} from '../lib/collection-import-banner'
import { get } from '../lib/commands'
import { useLiveEvent } from '../lib/live'

/**
 * #1826 — a PROCEDURE-mode staged import writing this collection: started, running (with the
 * time since it started), then finished with the rows the run reported, or failed. Items-service
 * imports say so per record ("An import is updating this record"); a procedure writes everything
 * in one go at the end and has no row-level progress, so this banner sits on the collection's
 * list and record pages instead, with indeterminate progress.
 *
 * Reads GET /staged-imports/collection-runs (collection readers only; others get an empty
 * list) once on open, again on each `import:collection` event for this collection, and every
 * 30 s while a run is running (a missed event must not leave it spinning forever).
 */
export function CollectionImportBanner({
  collection,
  scope = 'list',
  className
}: {
  collection: string
  /** Wording: a record page says "this record", a list "records here". */
  scope?: 'list' | 'record'
  className?: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { isAdmin } = useItemEditAuth()
  const key = ['collection-import-runs', collection]
  const { data: runs } = useQuery({
    queryKey: key,
    enabled: !!collection,
    staleTime: 15_000,
    queryFn: async () =>
      (
        await client.request<{ data: CollectionImportRun[] }>(
          get('/staged-imports/collection-runs', { collection })
        )
      ).data ?? [],
    refetchInterval: (q) =>
      (q.state.data as CollectionImportRun[] | undefined)?.some((r) => r.status === 'running')
        ? 30_000
        : false,
    retry: false
  })
  useLiveEvent(
    'import:collection',
    () => void qc.invalidateQueries({ queryKey: ['collection-import-runs', collection] }),
    { match: (p) => p?.collection === collection, enabled: !!collection }
  )

  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const [now, setNow] = useState(() => Date.now())
  const state = importBannerState(runs, now, dismissed)
  const running = state?.kind === 'running'
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])

  if (!state) return null
  const where = scope === 'record' ? 'this record' : 'the list'

  if (state.kind === 'running') {
    return (
      <div
        data-collection-importing
        role='status'
        className={`rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5 dark:border-amber-500/40 dark:bg-amber-500/10 ${className ?? ''}`}
      >
        <style>{`
          @keyframes nvr-import-indeterminate {
            0% { left: -35%; width: 35%; }
            60% { left: 55%; width: 45%; }
            100% { left: 105%; width: 30%; }
          }
          [data-collection-importing] .nvr-import-bar::after {
            content: ''; position: absolute; top: 0; bottom: 0; border-radius: 9999px;
            background: rgb(245 158 11);
            animation: nvr-import-indeterminate 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
          }
          @media (prefers-reduced-motion: reduce) {
            [data-collection-importing] .nvr-import-bar::after { animation: none; left: 0; width: 100%; opacity: 0.45; }
          }
        `}</style>
        <div className='flex items-center gap-3'>
          <FileUp className='h-4 w-4 shrink-0 animate-pulse text-amber-500' />
          <p className='min-w-0 flex-1 text-[12px] text-amber-800 dark:text-amber-300'>
            <span className='font-semibold'>{runningTitle(state.runs)}</span> — it writes{' '}
            {scope === 'record' ? "this collection's records" : 'these records'} all at once when it
            finishes, so {where} may change then.
          </p>
          {state.elapsedSeconds != null && (
            <span
              className='shrink-0 font-mono text-[11.5px] tabular-nums text-amber-700 dark:text-amber-300'
              data-tip='Time since the import started'
            >
              {formatElapsed(state.elapsedSeconds)}
            </span>
          )}
        </div>
        <div
          className='nvr-import-bar relative mt-2 h-1 overflow-hidden rounded-full bg-amber-200/70 dark:bg-amber-500/20'
          role='progressbar'
          aria-label='Import progress'
          aria-busy='true'
        />
      </div>
    )
  }

  const run = state.run
  const at = run.finished_at
    ? new Date(run.finished_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null
  const ok = state.kind === 'completed'
  const rows = ok ? rowsText(run.rows) : null
  return (
    <div
      data-collection-import-ended={state.kind}
      role='status'
      className={`flex items-center gap-3 rounded-lg border px-3.5 py-2.5 ${
        ok
          ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10'
          : 'border-rose-300 bg-rose-50 dark:border-rose-500/40 dark:bg-rose-500/10'
      } ${className ?? ''}`}
    >
      {ok ? (
        <CheckCircle2 className='h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400' />
      ) : (
        <TriangleAlert className='h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400' />
      )}
      <p
        className={`min-w-0 flex-1 text-[12px] ${
          ok ? 'text-emerald-800 dark:text-emerald-300' : 'text-rose-800 dark:text-rose-300'
        }`}
      >
        <span className='font-semibold'>
          {run.label} import {ok ? 'finished' : 'failed'}
        </span>
        {at ? ` at ${at}` : ''}
        {ok
          ? ` — ${rows ? `${rows}. ` : ''}Its changes are showing here.`
          : ` — what it would have changed may be missing here. ${
              isAdmin
                ? 'The reason is in the Import Console.'
                : 'An administrator can see the reason.'
            }`}
      </p>
      <button
        type='button'
        onClick={() => setDismissed((s) => new Set(s).add(run.run_id))}
        aria-label='Dismiss'
        className={`shrink-0 rounded p-1 ${
          ok
            ? 'text-emerald-700 hover:bg-emerald-100 dark:text-emerald-300 dark:hover:bg-emerald-500/10'
            : 'text-rose-700 hover:bg-rose-100 dark:text-rose-300 dark:hover:bg-rose-500/10'
        }`}
      >
        <X className='h-3.5 w-3.5' />
      </button>
    </div>
  )
}
