/**
 * Share a recording with someone who can already watch replays: a link to this
 * page that opens the recording (?recording=), optionally at the moment you are
 * looking at (?t=, which the page opens a few seconds early). No token and no
 * new access — the link opens only for replay viewers. To show one window to
 * someone who cannot watch replays, use the range bar's Share instead.
 */
import { Link2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { ReplayControls } from './controls'
import { fmtClock } from './logic'

/** The replay page link for a recording, at `atMs` into it when given. Exported for tests. */
export function recordingShareLink(
  origin: string,
  recordingId: string,
  atMs?: number | null
): string {
  const params = new URLSearchParams({ recording: recordingId })
  if (atMs != null && Number.isFinite(atMs) && atMs > 0) params.set('t', String(Math.round(atMs)))
  return `${origin}/analytics/replays?${params.toString()}`
}

async function copyLink(link: string) {
  try {
    await navigator.clipboard.writeText(link)
    toast.success('Link copied')
  } catch {
    toast.error('Copy failed — select the link and copy it')
  }
}

export function ShareRecordingLink({
  recordingId,
  controlsRef,
  className
}: {
  recordingId: string
  /** The player's controls: the playhead is read when the menu opens, for "at m:ss". */
  controlsRef?: { current: ReplayControls | null }
  className?: string
}) {
  const [atMs, setAtMs] = useState<number | null>(null)
  const origin = window.location.origin
  const whole = recordingShareLink(origin, recordingId)
  const at = atMs != null && atMs > 0 ? recordingShareLink(origin, recordingId, atMs) : null
  return (
    <Popover onOpenChange={(open) => open && setAtMs(controlsRef?.current?.getTime() ?? null)}>
      <PopoverTrigger asChild>
        <Button variant='outline' size='sm' className={cn('h-7 gap-1.5 text-[12px]', className)}>
          <Link2 className='h-3.5 w-3.5' />
          Share
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-80 space-y-2 p-3'>
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Opens this recording for anyone who can watch session replays.
        </p>
        <div className='flex flex-col gap-1.5'>
          <Button
            size='sm'
            className='h-8 justify-start gap-1.5 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            onClick={() => void copyLink(whole)}
          >
            <Link2 className='h-3.5 w-3.5' />
            Copy link
          </Button>
          {at && atMs != null && (
            <Button
              variant='outline'
              size='sm'
              className='h-8 justify-start gap-1.5'
              onClick={() => void copyLink(at)}
            >
              <Link2 className='h-3.5 w-3.5' />
              Copy link at {fmtClock(atMs)}
            </Button>
          )}
        </div>
        <p className='text-[11px] text-slate-400 dark:text-slate-500'>
          For someone who can't watch replays, select a window on the range bar and share that.
        </p>
      </PopoverContent>
    </Popover>
  )
}
