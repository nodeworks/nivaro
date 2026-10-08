import { Check, Image as ImageIcon, MousePointerClick } from 'lucide-react'
import { memo, useId, useState } from 'react'
import { Button } from '../../ui/button'
import { sourceToEdited } from '../edits'
import type { VideoEdits } from '../types'
import { clicksToRipples } from './tools'

/** 0:09.5: to the tenth, as the frame is picked. */
const clock = (ms: number) => {
  const s = Math.max(0, ms) / 1000
  return `${Math.floor(s / 60)}:${(Math.floor((s % 60) * 10) / 10).toFixed(1).padStart(4, '0')}`
}

/**
 * The poster: the frame viewers see before they press play. "Use this
 * frame" takes the frame under the playhead. The render takes the poster
 * from the finished video, so a frame inside a cut can't be used.
 */
export const PosterPicker = memo(function PosterPicker({
  edits,
  onUse,
  onSeek
}: {
  edits: VideoEdits
  /** Sets the poster to the playhead's frame: its time, or null when refused. */
  onUse: () => number | null
  onSeek: (srcMs: number) => void
}) {
  const headingId = useId()
  const [justSet, setJustSet] = useState<number | null>(null)
  const at = sourceToEdited(edits, edits.poster_ms)
  return (
    <section className='space-y-2' aria-labelledby={headingId} data-hv-poster-picker>
      <h3 id={headingId} className='text-[13px] font-semibold text-foreground'>
        Poster
      </h3>
      <p className='text-[12px] leading-snug text-muted-foreground'>
        {at === null
          ? 'The poster frame is in a part that is cut out, so viewers see the first frame instead.'
          : `Viewers see the frame at ${clock(at)} before they press play.`}
      </p>
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          variant='outline'
          className='h-8 text-[12.5px]'
          onClick={() => setJustSet(onUse())}
          data-hv-poster
        >
          <ImageIcon className='!size-3.5' aria-hidden /> Use this frame
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className='h-8 text-[12.5px]'
          onClick={() => onSeek(edits.poster_ms)}
          data-hv-poster-show
        >
          Show it
        </Button>
      </div>
      <p role='status' className='min-h-[18px] text-[12px] text-foreground'>
        {/* Until the poster changes again (another frame, or undo). */}
        {justSet !== null && justSet === edits.poster_ms && (
          <span className='inline-flex items-center gap-1'>
            <Check className='h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400' aria-hidden />
            Poster set to this frame.
          </span>
        )}
      </p>
    </section>
  )
})

/**
 * Click ripples from the recorder's captured clicks: one per click, added
 * in one go. Says plainly when clicks weren't captured (null) or none were
 * made ([]).
 */
export const ClickRipples = memo(function ClickRipples({
  clicks,
  edits,
  sourceMs,
  onAdd
}: {
  clicks: Array<{ t_ms: number; x: number; y: number }> | null | undefined
  edits: VideoEdits
  sourceMs: number
  onAdd: () => void
}) {
  const headingId = useId()
  const fresh = clicks?.length ? clicksToRipples(clicks, edits.annotations, sourceMs).length : 0
  const text =
    clicks == null
      ? "Clicks weren't captured for this recording."
      : clicks.length === 0
        ? 'No clicks were recorded.'
        : fresh === 0
          ? `Every one of the ${clicks.length} recorded clicks has a ripple.`
          : `The recording caught ${clicks.length} ${clicks.length === 1 ? 'click' : 'clicks'}. Add a ripple where each one happened.`
  return (
    <section className='space-y-2' aria-labelledby={headingId} data-hv-clicks>
      <h3 id={headingId} className='text-[13px] font-semibold text-foreground'>
        Click ripples
      </h3>
      <p className='text-[12px] leading-snug text-muted-foreground' data-hv-clicks-state>
        {text}
      </p>
      {!!clicks?.length && fresh > 0 && (
        <Button
          size='sm'
          variant='outline'
          className='h-8 text-[12.5px]'
          onClick={onAdd}
          data-hv-add-ripples
        >
          <MousePointerClick className='!size-3.5' aria-hidden /> Add click ripples ({fresh})
        </Button>
      )}
    </section>
  )
})
