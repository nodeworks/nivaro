import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Loader2, Sparkles } from 'lucide-react'
import { memo, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import { helpVideoApi, helpVideoError } from '../api'
import type { VideoEdits } from '../types'
import { applyGeneratedCaptions, captionJobLabel } from './captionsDraft'

export const captionJobKey = (videoId: string) => ['help-video-captions-job', videoId] as const

function reasonOf(err: unknown): string {
  const body = (err as { response?: { error?: unknown } } | null)?.response
  if (body && typeof body.error === 'string') return body.error
  return (err as Error)?.message || 'The request failed.'
}

const stamp = (ms: number) => {
  const s = Math.max(0, ms) / 1000
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

/**
 * "Generate captions" (#1520): the server transcribes the draft's sound in
 * the background; this shows the job's status (polled while it runs) and,
 * once done, the generated lines as a pending set with "Use these captions"
 * (replace) / "Merge with mine" and Discard. Using them goes through
 * onChange, so the normal autosave saves them like any other edit.
 */
export const GenerateCaptions = memo(function GenerateCaptions({
  videoId,
  edits,
  sourceMs,
  onChange,
  onNote,
  onSeek
}: {
  videoId: string
  edits: VideoEdits
  sourceMs: number
  onChange: (e: VideoEdits) => void
  /** The editor's note (shown when some lines were skipped). */
  onNote: (n: string) => void
  onSeek: (srcMs: number) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [starting, setStarting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const q = useQuery({
    queryKey: captionJobKey(videoId),
    queryFn: () => helpVideoApi(client).captionJob(videoId),
    staleTime: 5000,
    refetchInterval: (query) => {
      const s = query.state.data?.job?.status
      return s === 'queued' || s === 'running' ? 3000 : false
    }
  })
  const job = q.data?.job ?? null
  const provider = q.data?.provider
  const running = job?.status === 'queued' || job?.status === 'running'
  const refresh = () => qc.invalidateQueries({ queryKey: captionJobKey(videoId) })

  const start = async () => {
    setStarting(true)
    setProblem(null)
    try {
      await helpVideoApi(client).generateCaptions(videoId)
      await refresh()
    } catch (err) {
      const e = helpVideoError(err)
      setProblem(
        e?.code === 'HELP_VIDEO_CAPTIONS_NOT_CONFIGURED'
          ? reasonOf(err)
          : e?.code === 'HELP_VIDEO_CAPTIONS_BUSY'
            ? 'Captions are already being generated.'
            : `Captions could not be started: ${reasonOf(err)}`
      )
    } finally {
      setStarting(false)
    }
  }
  const discard = async () => {
    try {
      await helpVideoApi(client).discardCaptionJob(videoId)
    } catch {
      /* a set that is already gone */
    }
    await refresh()
  }
  const use = async (how: 'replace' | 'merge') => {
    if (!job?.captions) return
    const r = applyGeneratedCaptions(edits, job.captions, how, sourceMs)
    onChange(r.edits)
    if (r.skipped)
      onNote(
        `Added ${r.added} caption${r.added === 1 ? '' : 's'}; ${r.skipped} skipped (overlapping yours or too short)`
      )
    await discard()
  }

  const unavailable = provider?.kind === 'none'
  return (
    <div className='space-y-1.5 border-t border-border pt-2' data-hv-generate-captions>
      <div className='flex items-center gap-2'>
        <p className='text-[12px] font-medium text-foreground'>Automatic captions</p>
        {!running && job?.status !== 'done' && (
          <Button
            size='sm'
            variant='outline'
            className='ml-auto h-7 text-[12px]'
            onClick={() => void start()}
            disabled={starting || q.isLoading}
            data-hv-captions-generate
          >
            {starting ? (
              <Loader2 className='!size-3.5 animate-spin motion-reduce:animate-none' aria-hidden />
            ) : (
              <Sparkles className='!size-3.5' aria-hidden />
            )}
            Generate captions
          </Button>
        )}
      </div>
      {problem && (
        <p
          className='flex items-start gap-1.5 text-[12px] leading-snug text-rose-700 dark:text-rose-300'
          role='alert'
          data-hv-captions-problem
        >
          <AlertCircle className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
          <span>{problem}</span>
        </p>
      )}
      {!problem && unavailable && !job && (
        <p className='text-[12px] leading-snug text-muted-foreground' data-hv-captions-unavailable>
          {provider?.reason}
        </p>
      )}
      {!problem && !unavailable && !job && (
        <p className='text-[12px] leading-snug text-muted-foreground'>
          Transcribes the narration on the server
          {provider?.kind === 'gateway' ? ' with the AI gateway' : ' with the local Whisper model'}{' '}
          and offers the lines here for you to review before they are added.
        </p>
      )}
      {job && (
        <div className='space-y-1.5' data-hv-captions-job={job.status}>
          <p
            className={`flex items-center gap-1.5 text-[12px] leading-snug ${job.status === 'failed' ? 'text-rose-700 dark:text-rose-300' : 'text-muted-foreground'}`}
            role={job.status === 'failed' ? 'alert' : 'status'}
          >
            {running && (
              <Loader2
                className='!size-3.5 shrink-0 animate-spin motion-reduce:animate-none'
                aria-hidden
              />
            )}
            {job.status === 'failed' && (
              <AlertCircle className='h-3.5 w-3.5 shrink-0' aria-hidden />
            )}
            <span>{captionJobLabel(job)}</span>
          </p>
          {job.status === 'done' && !!job.captions?.length && (
            <>
              <ul className='-mx-1.5 max-h-40 space-y-px overflow-y-auto overscroll-contain rounded-md border border-dashed border-border px-1.5 py-1'>
                {job.captions.map((c) => (
                  <li key={c.id}>
                    <button
                      type='button'
                      className='flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan'
                      onClick={() => onSeek(c.start_ms)}
                      data-hv-captions-pending-row
                    >
                      <span className='w-12 shrink-0 font-mono text-[12px] text-muted-foreground'>
                        {stamp(c.start_ms)}
                      </span>
                      <span className='min-w-0 truncate'>{c.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className='flex flex-wrap items-center gap-1.5'>
                <Button
                  size='sm'
                  variant='default'
                  className='h-7 text-[12px]'
                  onClick={() => void use('replace')}
                  data-hv-captions-use
                >
                  {edits.captions.length ? 'Use these instead of mine' : 'Use these captions'}
                </Button>
                {edits.captions.length > 0 && (
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-7 text-[12px]'
                    onClick={() => void use('merge')}
                    data-hv-captions-merge
                  >
                    Merge with mine
                  </Button>
                )}
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-7 text-[12px] text-muted-foreground'
                  onClick={() => void discard()}
                  data-hv-captions-discard
                >
                  Discard
                </Button>
              </div>
            </>
          )}
          {(job.status === 'failed' || (job.status === 'done' && !job.captions?.length)) && (
            <div className='flex items-center gap-1.5'>
              <Button
                size='sm'
                variant='outline'
                className='h-7 text-[12px]'
                onClick={() => void discard().then(() => start())}
                disabled={starting}
                data-hv-captions-retry
              >
                Generate again
              </Button>
              <Button
                size='sm'
                variant='ghost'
                className='h-7 text-[12px] text-muted-foreground'
                onClick={() => void discard()}
                data-hv-captions-discard
              >
                Dismiss
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
