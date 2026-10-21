import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Loader2,
  Timer,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigation, useOptionalNivaroClient } from '../context'
import { clock } from '../lib/background-runs'
import { get } from '../lib/commands'
import {
  applyJobUpdate,
  dismissFinishedJobs,
  dismissJob,
  seedJobs,
  type TrayJob,
  useTrayJobs
} from '../lib/jobs-tray'
import { useLiveEvent } from '../lib/live'
import { cn } from '../lib/utils'
import { queueStanding } from './imports/run-parts'

/**
 * The Jobs tray (#1724) — long things the signed-in person started (bulk runs, backfills,
 * imports, exports, PDFs) at the bottom of EVERY page, with live progress, then a result with a
 * link to the details or the finished file. Entries follow the person across pages and tabs until
 * they dismiss them. Mount once in the app shell, inside a client + navigation provider; the
 * host forwards the socket's `job:progress` (see `relayLiveEvent`).
 *
 * Portals to <body>: a `fixed` element under an animated page wrapper anchors to the wrapper.
 */
export function JobsTray() {
  const client = useOptionalNivaroClient()
  const nav = useNavigation()
  const jobs = useTrayJobs()
  const [open, setOpen] = useState(true)

  useLiveEvent('job:progress', (p) => applyJobUpdate(p), { includeOwn: true })

  const active = jobs.some((j) => j.status === 'running' || j.status === 'queued')
  // A fresh page starts from the server's list; while something is in flight the read repeats
  // slowly as the net under the socket.
  const { data } = useQuery({
    queryKey: ['jobs-tray-seed'],
    enabled: !!client,
    staleTime: 0,
    refetchInterval: active ? 20_000 : false,
    queryFn: () =>
      client!
        .request<{ data: Array<Record<string, unknown>> }>(get('/my-jobs'))
        .then((r) => r.data ?? [])
        .catch(() => [])
  })
  useEffect(() => {
    if (data) seedJobs(data as never)
  }, [data])

  if (jobs.length === 0 || typeof document === 'undefined') return null
  const running = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length
  const finished = jobs.length - running
  const openHref = (href: string) =>
    nav.navigate ? nav.navigate(href) : window.location.assign(href)

  return createPortal(
    <div
      data-jobs-tray={jobs.length}
      data-nvr-dock-aware
      data-nvr-recording-hide
      className='fixed bottom-4 left-1/2 z-[110] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-700 shadow-xl dark:border-[#334155] dark:bg-[#1e293b] dark:text-slate-200'
    >
      <div className='flex items-center gap-2 px-3 py-2'>
        {running > 0 ? (
          <Loader2 className='h-3.5 w-3.5 shrink-0 animate-spin text-nvr-cyan' />
        ) : (
          <Check className='h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400' />
        )}
        <button
          type='button'
          onClick={() => setOpen((o) => !o)}
          className='min-w-0 flex-1 text-left text-[12.5px] font-medium'
          aria-expanded={open}
        >
          {running > 0
            ? `${running} job${running === 1 ? '' : 's'} running`
            : `${finished} job${finished === 1 ? '' : 's'} finished`}
        </button>
        {finished > 0 && (
          <button
            type='button'
            onClick={dismissFinishedJobs}
            data-jobs-tray-clear
            className='text-[11px] text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
          >
            Clear finished
          </button>
        )}
        <button
          type='button'
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? 'Collapse' : 'Expand'}
          className='flex h-6 w-6 items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10'
        >
          {open ? <ChevronDown className='h-3.5 w-3.5' /> : <ChevronUp className='h-3.5 w-3.5' />}
        </button>
      </div>
      {open && (
        <ul className='max-h-[40vh] divide-y divide-slate-100 overflow-y-auto border-t border-slate-100 dark:divide-[#334155] dark:border-[#334155]'>
          {jobs.map((j) => (
            <JobRow key={j.key} job={j} onOpen={openHref} />
          ))}
        </ul>
      )}
    </div>,
    document.body
  )
}

function JobRow({ job, onOpen }: { job: TrayJob; onOpen: (href: string) => void }) {
  const done = job.status === 'completed'
  const failed = job.status === 'error'
  const waiting = job.status === 'queued'
  const prog = job.progress ?? {}
  const total = Number(prog.total)
  const count = Number(prog.done)
  const pct =
    Number.isFinite(total) && total > 0 && Number.isFinite(count)
      ? Math.max(0, Math.min(100, Math.round((count / total) * 100)))
      : null
  const phase = typeof prog.phase === 'string' ? prog.phase : null
  const detail = waiting
    ? queueStanding(
        job.position != null
          ? { position: job.position, eta_seconds: job.eta_seconds ?? null }
          : undefined
      )
    : failed
      ? job.error
      : done
        ? job.outcome
        : job.kind === 'background-run'
          ? // #2759 — a slow read the server is finishing: say how long it usually takes.
            Number(prog.expected_ms) >= 1000
            ? `Usually takes about ${clock(Number(prog.expected_ms))}`
            : 'Running on the server'
          : [phase, pct != null ? `${count} of ${total}` : null].filter(Boolean).join(' · ') || null
  return (
    <li
      data-job={job.key}
      data-job-status={job.status}
      className='flex items-start gap-2.5 px-3 py-2'
    >
      <span className='mt-0.5 shrink-0'>
        {failed ? (
          <AlertCircle className='h-3.5 w-3.5 text-rose-500' />
        ) : done ? (
          <Check className='h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400' />
        ) : waiting ? (
          <Timer className='h-3.5 w-3.5 text-slate-400' />
        ) : (
          <Loader2 className='h-3.5 w-3.5 animate-spin text-nvr-cyan' />
        )}
      </span>
      <div className='min-w-0 flex-1'>
        <p className='truncate text-[12.5px] font-medium'>{job.label}</p>
        {detail && (
          <p
            className={cn(
              'line-clamp-2 text-[11px]',
              failed ? 'text-rose-600 dark:text-rose-300' : 'text-slate-500 dark:text-slate-400'
            )}
          >
            {detail}
          </p>
        )}
        {job.status === 'running' && pct != null && (
          <div className='mt-1 h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-[#334155]'>
            <div
              className='h-full rounded-full bg-nvr-cyan transition-all'
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
        {(job.file_id || job.href) && (job.status === 'completed' || job.status === 'error') && (
          <div className='mt-1 flex items-center gap-2'>
            {job.file_id && done && (
              <a
                href={`/api/files/${job.file_id}?download=1`}
                data-job-download
                className='inline-flex items-center gap-1 rounded-full border border-nvr-cyan/50 bg-nvr-cyan/10 px-2 py-0.5 text-[11px] font-medium text-[#0e7490] hover:bg-nvr-cyan/20 dark:text-[#67e8f9]'
              >
                <Download className='h-3 w-3' />
                Download
              </a>
            )}
            {job.href && (
              <button
                type='button'
                onClick={() => onOpen(job.href as string)}
                className='text-[11px] text-slate-500 underline-offset-2 hover:underline dark:text-slate-400'
              >
                Details
              </button>
            )}
          </div>
        )}
        {waiting && job.href && (
          <button
            type='button'
            onClick={() => onOpen(job.href as string)}
            className='mt-0.5 text-[11px] text-slate-500 underline-offset-2 hover:underline dark:text-slate-400'
          >
            Details
          </button>
        )}
      </div>
      {job.status !== 'running' && (
        <button
          type='button'
          onClick={() => dismissJob(job.key)}
          aria-label='Dismiss'
          data-job-dismiss
          className='flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/10'
        >
          <X className='h-3 w-3' />
        </button>
      )}
    </li>
  )
}
