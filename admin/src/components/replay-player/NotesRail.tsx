/**
 * #1363 — the notes row under the scrubber: one violet flag per note (notes a
 * few pixels apart share one). Hover shows the text, click seeks to just
 * before the moment. Text is rendered as text, never as markup.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { fmtClock } from './logic'
import { noteMarkers, type ReplayNote } from './notes'

export const NotesRail = memo(function NotesRail({
  notes,
  total,
  onSeek
}: {
  notes: ReplayNote[]
  total: number
  onSeek: (ms: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth || 600)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 600))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const markers = useMemo(() => noteMarkers(notes, total, width), [notes, total, width])
  if (notes.length === 0) return <div ref={ref} />
  return (
    <div ref={ref} className='relative mt-0.5 h-2.5' data-replay-notes-rail=''>
      {markers.map((m) => {
        const tip = m.notes
          .slice(0, 4)
          .map((n) => `${fmtClock(n.at_ms)} · ${n.text.slice(0, 100)}`)
          .concat(m.notes.length > 4 ? [`+${m.notes.length - 4} more`] : [])
          .join('\n')
        return (
          <button
            key={`${m.offset}:${m.notes.length}`}
            type='button'
            onClick={() => onSeek(Math.max(0, m.offset - 500))}
            className='absolute top-0 h-2.5 w-[5px] -translate-x-1/2 rounded-[2px] bg-violet-500 hover:scale-y-125'
            style={{ left: `${m.left * 100}%` }}
            data-tip={tip}
            aria-label={`Note at ${fmtClock(m.offset)}: ${m.notes[0].text.slice(0, 60)}`}
          />
        )
      })}
    </div>
  )
})
