import { Film, Plus } from 'lucide-react'
import { memo, useId } from 'react'
import { Button } from '../../ui/button'
import { newId, sourceToEdited, upsertItemChecked } from '../edits'
import type { VideoEdits } from '../types'

/** Two chapters this close together are one chapter. */
const SAME_PLACE_MS = 500

/** A chapter at the playhead, named "Chapter N". Refused (edits unchanged,
 *  with the reason) when one already starts within half a second; `id` is
 *  the new chapter, or the one already there. */
export function addChapterAt(
  edits: VideoEdits,
  srcMs: number
): { edits: VideoEdits; id?: string; refused?: string } {
  const at = Math.round(Math.max(0, srcMs))
  const near = edits.chapters.find((c) => Math.abs(c.at_ms - at) < SAME_PLACE_MS)
  if (near) return { edits, id: near.id, refused: 'A chapter already starts here' }
  const id = newId()
  const r = upsertItemChecked(edits, 'chapters', {
    id,
    at_ms: at,
    title: `Chapter ${edits.chapters.length + 1}`
  })
  return r.refused ? r : { edits: r.edits, id }
}

/** Where a chapter starts for a viewer (edited time), or why it doesn't. */
const viewerClock = (ms: number | null) =>
  ms === null
    ? 'Cut'
    : `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`

/**
 * The chapter list. Adding happens at the playhead (here or with M);
 * choosing one jumps there and opens it in the Inspector to rename.
 */
export const ChaptersPanel = memo(function ChaptersPanel({
  headless,
  edits,
  selectedId,
  onAdd,
  onSeek,
  onSelect,
  onClip
}: {
  /** The side panel shows the title itself (the heading stays for screen readers). */
  headless?: boolean
  edits: VideoEdits
  selectedId: string | null
  /** Adds a chapter at the playhead (the editor's M). */
  onAdd: () => void
  onSeek: (srcMs: number) => void
  onSelect: (id: string) => void
  /** "Make a clip" of this chapter (#1562); absent = no clip button. */
  onClip?: (id: string) => void
}) {
  const headingId = useId()
  return (
    <section className='space-y-2' aria-labelledby={headingId} data-hv-chapters>
      <div className='flex items-center justify-between gap-2'>
        <h3
          id={headingId}
          className={headless ? 'sr-only' : 'text-[13px] font-semibold text-foreground'}
        >
          Chapters
        </h3>
        <Button
          size='sm'
          variant='outline'
          className='h-8 text-[12.5px]'
          onClick={onAdd}
          title='Add a chapter at the playhead (M)'
          aria-keyshortcuts='M'
          data-hv-add-chapter
        >
          <Plus className='!size-3.5' aria-hidden /> Add at playhead
        </Button>
      </div>
      {edits.chapters.length === 0 ? (
        <p className='text-[12px] leading-snug text-muted-foreground'>
          Chapters let viewers jump to a step. Play to the start of one and press M, or use Add at
          playhead.
        </p>
      ) : (
        <ul className='-mx-1.5 space-y-px'>
          {edits.chapters.map((c) => {
            const at = sourceToEdited(edits, c.at_ms)
            const current = c.id === selectedId
            return (
              <li key={c.id} className='flex items-center gap-0.5'>
                <button
                  type='button'
                  aria-current={current || undefined}
                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[13px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none ${current ? 'bg-nvr-cyan/15 font-medium text-foreground' : 'text-foreground hover:bg-muted'}`}
                  onClick={() => {
                    onSeek(c.at_ms)
                    onSelect(c.id)
                  }}
                  data-hv-chapter-row={c.id}
                >
                  <span className='w-9 shrink-0 font-mono text-[12px] text-muted-foreground'>
                    {viewerClock(at)}
                    {at === null && (
                      <span className='sr-only'>
                        : this chapter starts in a part that is cut out
                      </span>
                    )}
                  </span>
                  <span className='min-w-0 truncate'>{c.title || 'Chapter'}</span>
                </button>
                {onClip && at !== null && (
                  <button
                    type='button'
                    className='inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none'
                    onClick={() => onClip(c.id)}
                    aria-label={`Make a clip of ${c.title || 'this chapter'}`}
                    title='Make a clip of this chapter'
                    data-hv-chapter-clip={c.id}
                  >
                    <Film className='h-3.5 w-3.5' aria-hidden />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
})
