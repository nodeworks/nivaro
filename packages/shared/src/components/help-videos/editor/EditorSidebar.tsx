import { memo, useCallback, useRef } from 'react'
import { sourceToEdited, upsertItemChecked } from '../edits'
import type { VideoEdits } from '../types'
import { CaptionsPanel } from './CaptionsPanel'
import { ChaptersPanel } from './ChaptersPanel'
import { Inspector } from './Inspector'
import { ClickRipples, PosterPicker } from './PosterAndClicks'
import type { Selection } from './Timeline'
import { sentence } from './timeline/useBarDrag'
import { clicksToRipples } from './tools'

/**
 * The editor's right-hand column: the Inspector for the selection, then
 * chapters, captions, the poster and click ripples.
 *
 * Memoised, and every callback it hands down keeps one identity (they read
 * the latest edits through a ref), so playback frames skip the whole column.
 */
export const EditorSidebar = memo(function EditorSidebar({
  edits,
  selection,
  sourceMs,
  clicks,
  playhead,
  onChange,
  onSelect,
  onSeek,
  onNote,
  onAddChapter
}: {
  edits: VideoEdits
  selection: Selection
  sourceMs: number
  /** The recorder's captured clicks: null when click capture was off. */
  clicks: Array<{ t_ms: number; x: number; y: number }> | null | undefined
  /** The playhead now (read when an action needs it, not every frame). */
  playhead: () => number
  onChange: (e: VideoEdits, key?: string) => void
  onSelect: (s: Selection) => void
  onSeek: (srcMs: number) => void
  /** The editor's note, for every change that can't be made. */
  onNote: (n: string | null) => void
  /** Adds a chapter at the playhead (the editor's M). */
  onAddChapter: () => void
}) {
  const editsRef = useRef(edits)
  editsRef.current = edits

  const takePoster = useCallback((): number | null => {
    const e = editsRef.current
    const at = Math.round(playhead())
    // The render takes the poster from the finished video.
    if (sourceToEdited(e, at) === null) {
      onNote(
        'That frame is cut out of the video. Move the playhead to a part viewers see, then try again'
      )
      return null
    }
    onChange({ ...e, poster_ms: at })
    return at
  }, [playhead, onNote, onChange])
  const addRipples = useCallback(() => {
    const start = editsRef.current
    const ripples = clicksToRipples(clicks ?? null, start.annotations, sourceMs)
    let e = start
    let added = 0
    let refused: string | undefined
    for (const a of ripples) {
      const r = upsertItemChecked(e, 'annotations', a)
      if (r.refused) {
        refused = r.refused
        break
      }
      e = r.edits
      added++
    }
    if (e !== start) onChange(e)
    if (refused) onNote(`Added ${added} of ${ripples.length} ripples. ${sentence(refused)}`)
  }, [clicks, sourceMs, onChange, onNote])
  const selectChapter = useCallback((id: string) => onSelect({ lane: 'chapters', id }), [onSelect])
  const selectCaption = useCallback((id: string) => onSelect({ lane: 'captions', id }), [onSelect])

  return (
    <aside
      aria-label='Selected item, chapters and captions'
      className='divide-y divide-border border-t border-border px-3 lg:w-[300px] lg:shrink-0 lg:overflow-y-auto lg:border-t-0 lg:border-l'
      data-hv-sidebar
    >
      <div className='py-3'>
        <Inspector
          edits={edits}
          selection={selection}
          sourceMs={sourceMs}
          onChange={onChange}
          onSelect={onSelect}
          onSeek={onSeek}
          onError={onNote}
        />
      </div>
      <div className='py-3'>
        <ChaptersPanel
          edits={edits}
          selectedId={selection?.lane === 'chapters' ? selection.id : null}
          onAdd={onAddChapter}
          onSeek={onSeek}
          onSelect={selectChapter}
        />
      </div>
      <div className='py-3'>
        <CaptionsPanel
          edits={edits}
          sourceMs={sourceMs}
          selectedId={selection?.lane === 'captions' ? selection.id : null}
          getSrcMs={playhead}
          onChange={onChange}
          onRefused={onNote}
          onSeek={onSeek}
          onSelect={selectCaption}
        />
      </div>
      <div className='py-3'>
        <PosterPicker edits={edits} onUse={takePoster} onSeek={onSeek} />
      </div>
      <div className='py-3'>
        <ClickRipples clicks={clicks} edits={edits} sourceMs={sourceMs} onAdd={addRipples} />
      </div>
    </aside>
  )
})
