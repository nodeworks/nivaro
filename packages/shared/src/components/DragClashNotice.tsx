import { ArrowLeftRight } from 'lucide-react'
import { useEffect, useRef } from 'react'

/**
 * The calm question a calendar / Gantt asks when a drop met someone else's newer move
 * (realtime round 9, item 17, lib/live-drag.ts): "Beth just moved Pump check to Dec 4 · You
 * dropped it on Dec 6 — Keep Beth's / Use yours". Inline above the view, not a modal; the
 * view already shows the newer position. Escape keeps theirs.
 */
export function DragClashNotice({
  sentence,
  mine,
  theirsLabel,
  busy,
  onKeepTheirs,
  onUseMine
}: {
  /** "Beth just moved Pump check to Dec 4". */
  sentence: string
  /** "You dropped it on Dec 6". */
  mine: string
  /** "Keep Beth's" / "Keep theirs". */
  theirsLabel: string
  busy?: boolean
  onKeepTheirs: () => void
  onUseMine: () => void
}) {
  const mineBtnRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    mineBtnRef.current?.focus({ preventScroll: true })
  }, [])
  return (
    <div
      role='alertdialog'
      aria-live='polite'
      aria-label='Someone else moved this first'
      data-drag-clash
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onKeepTheirs()
        }
      }}
      className='nvr-fade-in flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-950 shadow-[0_2px_8px_-2px_rgba(120,80,0,0.18)] dark:border-amber-400/30 dark:bg-[#2a2112] dark:text-amber-50 dark:shadow-[0_4px_14px_-4px_rgba(0,0,0,0.6)]'
    >
      <ArrowLeftRight
        className='h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300'
        aria-hidden='true'
      />
      {/* The sentence keeps a readable width: on a narrow screen the buttons wrap below it
          instead of squeezing it to one word a line (rt9 round 2). */}
      <p className='min-w-[min(15rem,calc(100%-2rem))] flex-1'>
        <span className='font-medium'>{sentence}.</span>{' '}
        <span className='text-amber-800 dark:text-amber-200/80'>{mine}.</span>
      </p>
      <div className='ml-auto flex shrink-0 items-center gap-2'>
        <button
          type='button'
          disabled={busy}
          onClick={onKeepTheirs}
          className='h-7 rounded-md border border-amber-300 bg-white px-2.5 text-[12px] font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-50 dark:border-amber-400/40 dark:bg-transparent dark:text-amber-100 dark:hover:bg-amber-400/10'
        >
          {theirsLabel}
        </button>
        <button
          ref={mineBtnRef}
          type='button'
          disabled={busy}
          onClick={onUseMine}
          className='h-7 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-semibold text-white transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 focus-visible:ring-offset-1 disabled:opacity-50 dark:focus-visible:ring-offset-[#2a2112]'
        >
          {busy ? 'Saving…' : 'Use yours'}
        </button>
      </div>
    </div>
  )
}
