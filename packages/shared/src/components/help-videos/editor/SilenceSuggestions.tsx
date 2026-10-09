import { AudioLines } from 'lucide-react'
import { memo, useLayoutEffect, useRef, useState } from 'react'
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

type Action = 'cut' | 'speed'

/**
 * The toolbar's "N silent stretches" popover: one click per pause to cut it
 * out or keep it at 4×, or split them all out to decide on the timeline.
 *
 * A handled pause leaves the list; focus moves to the same action on the row
 * that takes its place, and to the trigger once the list is empty. The
 * trigger stays for the session ("No long pauses left") so focus has
 * somewhere to land.
 */
export const SilenceSuggestions = memo(function SilenceSuggestions({
  uploaded,
  silent,
  edits,
  onChange,
  onSeek,
  onRefused
}: {
  /** The source is an uploaded file: pauses are found from the recorder's
   *  microphone levels, which a file does not have. */
  uploaded?: boolean
  silent: Stretch[]
  edits: VideoEdits
  onChange: (e: VideoEdits) => void
  onSeek: (srcMs: number) => void
  /** Why a pause could not be cut (shown as the timeline's note). */
  onRefused: (reason: string) => void
}) {
  const [open, setOpen] = useState(false)
  const everHad = useRef(false)
  if (silent.length) everHad.current = true
  const list = useRef<HTMLUListElement | null>(null)
  const refocus = useRef<{ row: number; action: Action } | null>(null)

  useLayoutEffect(() => {
    const want = refocus.current
    if (!want) return
    refocus.current = null
    if (!silent.length) {
      // Closing hands focus back to the trigger.
      setOpen(false)
      return
    }
    const rows = list.current?.querySelectorAll('li')
    const row = rows?.[Math.min(want.row, rows.length - 1)]
    row?.querySelector<HTMLElement>(`[data-hv-suggestion-${want.action}]`)?.focus()
  }, [silent])

  const handle = (row: number, action: Action, r: Stretch) => {
    const { edits: e, index } = isolate(edits, r)
    if (index < 0) return
    if (action === 'speed') {
      refocus.current = { row, action }
      onChange(setSpeed(e, index, 4))
      return
    }
    const res = removeSegment(e, index)
    if (res.refused) onRefused(res.refused)
    else {
      refocus.current = { row, action }
      onChange(res.edits)
    }
  }
  const splitAll = () =>
    onChange(silent.reduce((e, r) => splitAt(splitAt(e, r.start_ms), r.end_ms), edits))

  if (!everHad.current) {
    if (!uploaded) return null
    return (
      <span
        className='inline-flex h-8 items-center gap-1.5 px-1 text-[12px] text-muted-foreground'
        title="Pauses are found from a recording's microphone levels, which an uploaded file does not have"
        data-hv-suggestions-none='upload'
      >
        <AudioLines className='size-3.5' aria-hidden />
        No pause suggestions
      </span>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size='sm'
          variant='outline'
          className='h-8 px-2.5 text-[12.5px]'
          data-hv-suggestions
        >
          <AudioLines className='!size-3.5' />
          {silent.length
            ? `${silent.length} silent stretch${silent.length === 1 ? '' : 'es'}`
            : 'No long pauses left'}
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
            {silent.length
              ? 'Your narration goes quiet here for 3 seconds or more. Cut each pause out, or keep it and play it at 4× speed.'
              : 'Every long pause has been cut or sped up. Undo brings one back.'}
          </p>
        </div>
        {silent.length > 0 && (
          <>
            <ul ref={list} className='max-h-[280px] divide-y divide-border overflow-y-auto'>
              {silent.map((r, row) => (
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
                    onClick={() => handle(row, 'cut', r)}
                    aria-label={`Cut the pause at ${clock(r.start_ms)}`}
                    data-hv-suggestion-cut
                  >
                    Cut it
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-7 px-2 text-[12px]'
                    onClick={() => handle(row, 'speed', r)}
                    aria-label={`Speed up the pause at ${clock(r.start_ms)} to 4×`}
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
                onClick={splitAll}
                data-hv-suggestion-split-all
              >
                Split them all out and decide on the timeline
              </button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
})
