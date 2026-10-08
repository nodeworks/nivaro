import { AudioLines } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { removeSegment, segmentIndexAt, setSpeed, splitAt } from '../edits'
import type { VideoEdits } from '../types'
import type { Stretch } from './suggestCuts'

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Split a silent stretch out as its own piece; returns that piece's index. */
function isolate(e: VideoEdits, r: Stretch): { edits: VideoEdits; index: number } {
  const out = splitAt(splitAt(e, r.start_ms), r.end_ms)
  return { edits: out, index: segmentIndexAt(out, Math.round((r.start_ms + r.end_ms) / 2)) }
}

/** The toolbar's "N silent stretches" popover: one click per pause to cut it
 *  out or keep it at 4×, or split them all out to decide on the timeline. */
export function SilenceSuggestions({
  silent,
  edits,
  onChange,
  onSeek
}: {
  silent: Stretch[]
  edits: VideoEdits
  onChange: (e: VideoEdits) => void
  onSeek: (srcMs: number) => void
}) {
  // One click per suggested silence: cut it out, or keep it at 4×.
  const cutSilence = (r: Stretch) => {
    const { edits: e, index } = isolate(edits, r)
    if (index < 0) return
    const res = removeSegment(e, index)
    if (res.refused) toast.error(res.refused)
    else onChange(res.edits)
  }
  const speedSilence = (r: Stretch) => {
    const { edits: e, index } = isolate(edits, r)
    if (index >= 0) onChange(setSpeed(e, index, 4))
  }
  const splitAllSilences = () =>
    onChange(silent.reduce((e, r) => splitAt(splitAt(e, r.start_ms), r.end_ms), edits))

  if (!silent.length) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size='sm'
          variant='outline'
          className='h-8 px-2.5 text-[12.5px]'
          data-hv-suggestions
        >
          <AudioLines className='!size-3.5' />
          {silent.length} silent stretch{silent.length === 1 ? '' : 'es'}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[380px] max-w-[calc(100vw-24px)] p-0'
        data-hv-suggestion-list
      >
        <div className='border-b border-border px-3 py-2.5'>
          <p className='text-[13px] font-semibold text-foreground'>Long pauses</p>
          <p className='mt-0.5 text-[12px] leading-snug text-muted-foreground'>
            Your narration goes quiet here for 3 seconds or more. Cut each pause out, or keep it and
            play it at 4× speed.
          </p>
        </div>
        <ul className='max-h-[280px] divide-y divide-border overflow-y-auto'>
          {silent.map((r) => (
            <li
              key={`${r.start_ms}-${r.end_ms}`}
              className='flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2'
            >
              <button
                type='button'
                className='mr-auto rounded-sm text-left text-[12.5px] text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                onClick={() => onSeek(r.start_ms)}
                aria-label={`Go to the pause at ${clock(r.start_ms)}`}
              >
                <span className='font-mono tabular-nums'>
                  {clock(r.start_ms)}–{clock(r.end_ms)}
                </span>
                <span className='text-muted-foreground'>
                  {' '}
                  · {Math.round((r.end_ms - r.start_ms) / 1000)} s
                </span>
              </button>
              <Button
                size='sm'
                variant='outline'
                className='h-7 px-2 text-[12px]'
                onClick={() => cutSilence(r)}
                data-hv-suggestion-cut
              >
                Cut it
              </Button>
              <Button
                size='sm'
                variant='outline'
                className='h-7 px-2 text-[12px]'
                onClick={() => speedSilence(r)}
                data-hv-suggestion-speed
              >
                Speed up 4×
              </Button>
            </li>
          ))}
        </ul>
        <div className='border-t border-border px-3 py-2'>
          <button
            type='button'
            className='rounded-sm text-[12px] text-foreground underline underline-offset-2 hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
            onClick={splitAllSilences}
            data-hv-suggestion-split-all
          >
            Split them all out and decide on the timeline
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
