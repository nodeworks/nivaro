import { type RenderQueueDto, type RenderQueueItem, TipLayer } from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Clapperboard } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// Help-video renders on Background Jobs (#1532): what renders now, what waits
// and in which order, progress, and an estimate from the median of past
// renders per source minute. Cancel takes a version off the queue (or stops
// it mid-render) and leaves it on live playback; an author queues it again
// with Render again in the editor. Renders nothing while the queue is empty.

function dur(ms: number | null): string {
  if (ms === null) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function HelpVideoRenderQueue() {
  const qc = useQueryClient()
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const queue = useQuery({
    queryKey: ['help-video-render-queue'],
    queryFn: () => api.get('/help-videos/render-queue').then((r) => r.data.data as RenderQueueDto),
    refetchInterval: 5_000
  })
  const items = queue.data?.items ?? []
  if (!items.length) return null

  const cancel = async (it: RenderQueueItem) => {
    setCancelling(it.version_id)
    try {
      await api.post(`/help-videos/render-queue/${it.version_id}/cancel`)
      toast.success(
        `${it.title} v${it.version}: render cancelled. It plays with live edits until it is rendered again.`
      )
    } catch (e) {
      const msg =
        (e as { response?: { data?: { error?: string } } }).response?.data?.error ??
        (e as Error).message
      toast.error(`Not cancelled: ${msg}`)
    } finally {
      setCancelling(null)
      setConfirm(null)
      void qc.invalidateQueries({ queryKey: ['help-video-render-queue'] })
      void qc.invalidateQueries({ queryKey: ['job-registry'] })
    }
  }
  const pace = queue.data?.ms_per_source_minute ?? null

  return (
    <div
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-hv-render-queue
    >
      <TipLayer />
      <div className='flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-4 py-2.5 dark:border-border'>
        <p className='flex items-center gap-1.5 text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
          <Clapperboard className='h-4 w-4 text-muted-foreground' aria-hidden />
          Help-video renders
        </p>
        <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {pace === null
            ? 'No finished renders yet to estimate from'
            : `Estimates: ${dur(pace)} per minute of recording (median of ${queue.data?.sample} renders)`}
        </p>
      </div>
      <table className='w-full text-[12px]'>
        <thead>
          <tr className='text-left text-[10.5px] uppercase tracking-wide text-slate-400'>
            <th className='px-4 py-1.5 font-semibold'>Place</th>
            <th className='py-1.5 pr-3 font-semibold'>Video</th>
            <th className='py-1.5 pr-3 font-semibold'>Progress</th>
            <th className='py-1.5 pr-3 font-semibold'>Recording</th>
            <th className='py-1.5 pr-3 font-semibold'>Done in</th>
            <th className='py-1.5 pr-4' />
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr
              key={it.version_id}
              className='border-t border-slate-100 dark:border-border'
              data-hv-render-queue-row={it.status}
            >
              <td className='px-4 py-2 tabular-nums text-slate-600 dark:text-muted-foreground'>
                {it.status === 'rendering' ? (
                  <span className='rounded bg-sky-500/10 px-1.5 py-px text-[10.5px] font-medium uppercase text-sky-700 dark:text-sky-300'>
                    Rendering
                  </span>
                ) : (
                  `#${it.position}`
                )}
              </td>
              <td className='py-2 pr-3'>
                <span className='font-medium text-slate-800 dark:text-foreground'>{it.title}</span>
                <span className='ml-1.5 text-slate-500 dark:text-muted-foreground'>
                  v{it.version}
                </span>
                {it.encoder && (
                  <span className='ml-1.5 font-mono text-[11px] text-slate-400'>{it.encoder}</span>
                )}
              </td>
              <td className='py-2 pr-3'>
                {it.status === 'rendering' ? (
                  <span className='flex items-center gap-2'>
                    <span className='h-1.5 w-24 overflow-hidden rounded-full bg-slate-200 dark:bg-muted'>
                      <span
                        className='block h-full rounded-full bg-nvr-cyan transition-[width] duration-500'
                        style={{ width: `${Math.max(2, it.progress ?? 0)}%` }}
                      />
                    </span>
                    <span className='tabular-nums text-slate-600 dark:text-muted-foreground'>
                      {it.progress ?? 0}%
                    </span>
                  </span>
                ) : (
                  <span className='text-slate-500 dark:text-muted-foreground'>Waiting</span>
                )}
              </td>
              <td className='py-2 pr-3 tabular-nums text-slate-600 dark:text-muted-foreground'>
                {dur(it.source_ms)}
              </td>
              <td
                className='py-2 pr-3 tabular-nums text-slate-600 dark:text-muted-foreground'
                data-tip={
                  it.estimate_ms === null
                    ? 'No estimate yet'
                    : `About ${dur(it.estimate_ms)} to render${it.status === 'queued' ? ', after the renders ahead of it' : ''}`
                }
              >
                {it.remaining_ms === null ? '—' : `~${dur(it.remaining_ms)}`}
              </td>
              <td className='py-2 pr-4 text-right'>
                {confirm === it.version_id ? (
                  <span className='inline-flex items-center gap-1'>
                    <button
                      type='button'
                      disabled={cancelling === it.version_id}
                      onClick={() => void cancel(it)}
                      className='rounded bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-60'
                      data-hv-render-cancel-confirm
                    >
                      {cancelling === it.version_id ? 'Cancelling…' : 'Cancel render'}
                    </button>
                    <button
                      type='button'
                      onClick={() => setConfirm(null)}
                      className='rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
                    >
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    type='button'
                    onClick={() => setConfirm(it.version_id)}
                    className={cn(
                      'rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:border-red-300 hover:text-red-700',
                      'dark:border-border dark:text-muted-foreground dark:hover:border-red-500/50 dark:hover:text-red-300'
                    )}
                    data-tip='Stops it and leaves the version on live playback. Render again in the editor queues it again.'
                    data-hv-render-cancel
                  >
                    Cancel
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
