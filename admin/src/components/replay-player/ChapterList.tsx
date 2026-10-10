/**
 * Chapters (#1397) — the list under the scrubber (route label + duration,
 * the current one highlighted, click to jump) and the , / . keys. The
 * chapters themselves come from ./chapters.
 */
import { BookOpen } from 'lucide-react'
import { memo, useEffect, useRef } from 'react'
import { type Chapter, chapterJump } from './chapters'
import { fmtClock } from './logic'

function typingInto(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  // The scrubber is a range input — , and . still work while it has focus.
  if (el.tagName === 'INPUT') return (el as HTMLInputElement).type !== 'range'
  return false
}

/** `,` back a chapter (or to this one's start), `.` on to the next. */
export function useChapterKeys(
  chapters: Chapter[],
  getTime: () => number,
  seek: (ms: number) => void,
  enabled: boolean
) {
  const latest = useRef({ chapters, getTime, seek })
  latest.current = { chapters, getTime, seek }
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key !== ',' && e.key !== '.') return
      if (typingInto(e.target)) return
      const { chapters: list, getTime: now, seek: go } = latest.current
      const to = chapterJump(list, now(), e.key === '.' ? 'next' : 'prev')
      if (to == null) return
      e.preventDefault()
      go(to)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}

export const ChapterList = memo(function ChapterList({
  chapters,
  current,
  onSeek
}: {
  chapters: Chapter[]
  current: number
  onSeek: (ms: number) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  // Keep the current chapter in view as the replay moves through them.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-chapter-index="${current}"]`)
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [current])
  if (chapters.length < 2) return null
  return (
    <div className='mt-1.5 flex items-center gap-2' data-replay-chapters=''>
      <span
        className='flex shrink-0 items-center gap-1 text-[10.5px] font-medium uppercase tracking-wider text-slate-400'
        data-tip='Chapters — a new one at every page change. Press , and . to jump between them.'
      >
        <BookOpen className='h-3 w-3' />
        {chapters.length} chapters
      </span>
      <div ref={listRef} className='flex min-w-0 flex-1 gap-1 overflow-x-auto pb-0.5'>
        {chapters.map((c, i) => (
          <button
            key={`${c.start}:${c.label}`}
            type='button'
            onClick={() => onSeek(c.start)}
            aria-current={i === current ? 'step' : undefined}
            data-chapter-index={i}
            data-tip={`${fmtClock(c.start)} · ${c.label}`}
            className={
              i === current
                ? 'flex max-w-[240px] shrink-0 items-center gap-1.5 rounded-md border border-nvr-cyan/60 bg-accent px-2 py-0.5 text-[11px] text-nvr-navy dark:text-nvr-cyan'
                : 'flex max-w-[240px] shrink-0 items-center gap-1.5 rounded-md border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-50 dark:border-border dark:hover:bg-muted/40'
            }
          >
            <span className='font-mono text-[10px] tabular-nums text-slate-400'>{i + 1}</span>
            <span className='min-w-0 truncate'>{c.label}</span>
            <span className='shrink-0 font-mono text-[10px] tabular-nums text-slate-400'>
              {fmtClock(c.end - c.start)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
})

/** "3 chapters" on a list row; nothing for older recordings or a single page. */
export function ChapterCountChip({ count }: { count?: number | null }) {
  const n = Number(count)
  if (!Number.isFinite(n) || n < 2) return null
  return (
    <span
      className='flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-slate-400'
      title='Pages visited — the player splits the recording into a chapter per page'
    >
      <BookOpen className='h-3 w-3' />
      {n} chapters
    </span>
  )
}
