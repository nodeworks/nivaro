import { AudioLines, X } from 'lucide-react'
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { removeSegment, segmentIndexAt, setSpeed, splitAt } from '../edits'
import type { VideoEdits } from '../types'
import type { Stretch, Suggestion, SuggestionKind } from './suggestCuts'

const KIND_LABEL: Record<SuggestionKind, string> = {
  silence: 'Pause',
  idle: 'Nothing happens',
  typing: 'Typing'
}
const keyOf = (r: Suggestion) => `${r.kind ?? 'silence'}:${r.start_ms}-${r.end_ms}`

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
 * The toolbar's suggestions popover: long pauses (microphone levels), and on a
 * recording of the author's own tab also stretches where nothing happened and
 * typing (#1518). One click per stretch to cut it out or keep it at 4× — the
 * suggested action comes first — or dismiss it for this session; or split
 * them all out to decide on the timeline.
 *
 * A handled stretch leaves the list; focus moves to the same action on the row
 * that takes its place, and to the trigger once the list is empty. The
 * trigger stays for the session ("Nothing left to suggest") so focus has
 * somewhere to land.
 */
export const SilenceSuggestions = memo(function SilenceSuggestions({
  silent: all,
  edits,
  onChange,
  onSeek,
  onRefused
}: {
  /** The source is an uploaded file: pauses are found from the recorder's
   *  microphone levels, which a file does not have. */
  uploaded?: boolean
  /** Silences, idle stretches and typing (suggestEdits), never overlapping. */
  silent: Suggestion[]
  edits: VideoEdits
  onChange: (e: VideoEdits) => void
  onSeek: (srcMs: number) => void
  /** Why a pause could not be cut (shown as the timeline's note). */
  onRefused: (reason: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const silent = useMemo(() => all.filter((r) => !dismissed.has(keyOf(r))), [all, dismissed])
  const everHad = useRef(false)
  if (silent.length) everHad.current = true
  const list = useRef<HTMLUListElement | null>(null)
  const refocus = useRef<{ row: number; action: Action | 'dismiss' } | null>(null)
  const onlyPauses = all.every((r) => (r.kind ?? 'silence') === 'silence')

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
  const dismiss = (row: number, r: Suggestion) => {
    refocus.current = { row, action: 'dismiss' }
    setDismissed((cur) => new Set(cur).add(keyOf(r)))
  }
  const splitAll = () =>
    onChange(silent.reduce((e, r) => splitAt(splitAt(e, r.start_ms), r.end_ms), edits))

  // Nothing to suggest: an uploaded file has no microphone levels or activity
  // (the timeline's Sound lane says so), and a recording never had a stretch.
  if (!everHad.current) return null
  const count = silent.length
  const label = count
    ? onlyPauses
      ? `${count} silent stretch${count === 1 ? '' : 'es'}`
      : `${count} suggestion${count === 1 ? '' : 's'}`
    : onlyPauses
      ? 'No long pauses left'
      : 'Nothing left to suggest'
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
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[400px] max-w-[calc(100vw-24px)] p-0'
        data-hv-suggestion-list
      >
        <div className='border-b border-border px-3 py-2.5'>
          <p className='text-[13px] font-semibold text-foreground'>
            {onlyPauses ? 'Long pauses' : 'Suggested edits'}
          </p>
          <p className='mt-0.5 text-[12px] leading-snug text-muted-foreground'>
            {count
              ? onlyPauses
                ? 'Your narration goes quiet here for 3 seconds or more. Cut each pause out, or keep it and play it at 4× speed.'
                : 'Pauses and stretches where nothing happens are best cut out; typing plays well at 4× so viewers still see what was entered. Pick either, or dismiss one to keep it as it is.'
              : 'Every suggestion has been handled. Undo brings one back.'}
          </p>
        </div>
        {count > 0 && (
          <>
            <ul ref={list} className='max-h-[300px] divide-y divide-border overflow-y-auto'>
              {silent.map((r, row) => {
                const kind = r.kind ?? 'silence'
                const what = KIND_LABEL[kind].toLowerCase()
                const first: Action = r.action ?? 'cut'
                const buttons: Action[] = first === 'speed' ? ['speed', 'cut'] : ['cut', 'speed']
                return (
                  <li
                    key={keyOf(r)}
                    className='flex items-center gap-2 px-3 py-2'
                    data-hv-suggestion-kind={kind}
                  >
                    <button
                      type='button'
                      className='mr-auto min-w-0 rounded-sm text-left text-[12.5px] text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                      onClick={() => onSeek(r.start_ms)}
                      aria-label={`Go to the ${what} at ${clock(r.start_ms)}`}
                    >
                      {!onlyPauses && (
                        <span className='block text-[11px] font-medium text-muted-foreground'>
                          {KIND_LABEL[kind]}
                        </span>
                      )}
                      <span className='whitespace-nowrap'>
                        <span className='font-mono tabular-nums'>
                          {clock(r.start_ms)}–{clock(r.end_ms)}
                        </span>
                        <span className='text-muted-foreground'>
                          {' '}
                          · {Math.round((r.end_ms - r.start_ms) / 1000)} s
                        </span>
                      </span>
                    </button>
                    {buttons.map((a) => (
                      <Button
                        key={a}
                        size='sm'
                        variant={a === first && !onlyPauses ? 'default' : 'outline'}
                        className='h-7 shrink-0 px-2 text-[12px]'
                        onClick={() => handle(row, a, r)}
                        aria-label={
                          a === 'cut'
                            ? `Cut the ${what} at ${clock(r.start_ms)}`
                            : `Speed up the ${what} at ${clock(r.start_ms)} to 4×`
                        }
                        data-hv-suggestion-cut={a === 'cut' ? '' : undefined}
                        data-hv-suggestion-speed={a === 'speed' ? '' : undefined}
                      >
                        {a === 'cut' ? 'Cut it' : 'Speed up 4×'}
                      </Button>
                    ))}
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-7 w-7 shrink-0 px-0 text-muted-foreground'
                      onClick={() => dismiss(row, r)}
                      aria-label={`Dismiss the ${what} at ${clock(r.start_ms)}`}
                      data-tip='Dismiss — keep it as it is'
                      data-hv-suggestion-dismiss
                    >
                      <X className='!size-3.5' />
                    </Button>
                  </li>
                )
              })}
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
