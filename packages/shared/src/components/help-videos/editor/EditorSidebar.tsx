import { CornerUpLeft, X } from 'lucide-react'
import { memo, useCallback, useRef } from 'react'
import { Button } from '../../ui/button'
import { setPoster, sourceToEdited, upsertItemChecked } from '../edits'
import type { RecordedClick, VideoEdits } from '../types'
import { CaptionsPanel } from './CaptionsPanel'
import { CardsPanel } from './CardsPanel'
import { ChaptersPanel } from './ChaptersPanel'
import { HouseStyleSection } from './HouseStylePanel'
import { Inspector } from './Inspector'
import { SideSection, useOpenSections } from './layout'
import { MusicPanel } from './MusicPanel'
import { NarrationPanel } from './NarrationPanel'
import { ClickRipples, PosterPicker } from './PosterAndClicks'
import type { Selection } from './Timeline'
import { sentence } from './timeline/useBarDrag'
import { clicksToRipples } from './tools'

const clockShort = (ms: number) =>
  `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`

/** A source moment as the viewer's clock (the edited time), or the source
 *  clock with "cut" when that moment is cut out. */
function spotLabel(e: VideoEdits, srcMs: number): string {
  const at = sourceToEdited(e, srcMs)
  return at === null ? `${clockShort(srcMs)} (cut)` : clockShort(at)
}

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
  uploaded,
  playhead,
  playheadPart,
  onChange,
  onSelect,
  onSeek,
  returnTo,
  onReturn,
  onForgetReturn,
  onNote,
  onAddChapter,
  videoTitle,
  videoDescription,
  onShowCard,
  videoId,
  hasLevels
}: {
  edits: VideoEdits
  selection: Selection
  sourceMs: number
  /** The recorder's captured clicks: null when click capture was off. */
  clicks: RecordedClick[] | null | undefined
  /** The source is an uploaded file (it never has captured clicks). */
  uploaded?: boolean
  /** The playhead now (read when an action needs it, not every frame). */
  playhead: () => number
  /** Which part the preview shows now: the intro card, the recording or the end card. */
  playheadPart: () => 'intro' | 'body' | 'outro'
  onChange: (e: VideoEdits, key?: string) => void
  onSelect: (s: Selection) => void
  onSeek: (srcMs: number) => void
  /** Where the playhead was before a jump made from this panel (source ms),
   *  or null: shown as a Back button until used or forgotten. */
  returnTo: number | null
  onReturn: () => void
  onForgetReturn: () => void
  /** The editor's note, for every change that can't be made. */
  onNote: (n: string | null) => void
  /** Adds a chapter at the playhead (the editor's M). */
  onAddChapter: () => void
  /** The video's title and description: what a blank intro card shows. */
  videoTitle: string
  videoDescription: string | null
  /** Moves the preview to the start of the intro or outro card. */
  onShowCard: (card: 'intro' | 'outro', how?: 'play' | 'poster') => void
  /** For the music panel: the video's own files and track links. */
  videoId: string
  /** The recording has microphone levels (the preview can duck the music). */
  hasLevels: boolean
}) {
  const editsRef = useRef(edits)
  editsRef.current = edits

  /** Sets the poster from the preview: the card it shows, else the frame.
   *  Returns what was set ('intro' / 'outro' / the frame's ms), or null. */
  const takePoster = useCallback((): string | null => {
    const e = editsRef.current
    const part = playheadPart()
    if (part !== 'body') {
      onChange(setPoster(e, { card: part }))
      return part
    }
    const at = Math.round(playhead())
    // The render takes the poster from the finished video.
    if (sourceToEdited(e, at) === null) {
      onNote(
        'That frame is cut out of the video. Move the playhead to a part viewers see, then try again'
      )
      return null
    }
    onChange(setPoster(e, { srcMs: at }))
    return String(at)
  }, [playhead, playheadPart, onNote, onChange])
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

  const [open, toggle] = useOpenSections()
  const plural = (n: number, one: string, many: string) =>
    n === 0 ? 'None' : `${n} ${n === 1 ? one : many}`
  const cards = [edits.intro && 'Intro', edits.outro && 'End', edits.chapter_banners && 'Banners']
    .filter(Boolean)
    .join(' · ')
  const posterAt = sourceToEdited(edits, edits.poster_ms)
  const ripples = edits.annotations.filter((a) => a.type === 'ripple').length

  return (
    <aside
      aria-label='Selected item, chapters, captions, cards, music and narration'
      data-hvx-side
      data-hv-sidebar
    >
      {returnTo !== null && (
        <div
          className='flex items-center gap-1 border-b border-border px-3 py-1.5'
          data-hv-side-return
        >
          <Button
            size='sm'
            variant='ghost'
            className='h-7 min-w-0 flex-1 justify-start px-2 text-[12.5px]'
            onClick={onReturn}
            data-hv-side-return-go
          >
            <CornerUpLeft className='!size-3.5' aria-hidden />
            <span className='truncate'>
              Back to {spotLabel(edits, returnTo)}
              <span className='text-muted-foreground'>, where you were</span>
            </span>
          </Button>
          <Button
            size='sm'
            variant='ghost'
            className='h-7 w-7 shrink-0 px-0 text-muted-foreground'
            onClick={onForgetReturn}
            aria-label='Stay here'
            title='Stay here'
            data-hv-side-return-forget
          >
            <X className='!size-3.5' aria-hidden />
          </Button>
        </div>
      )}
      <div
        className={`border-b border-border px-4 py-3 ${selection ? 'bg-muted/40' : ''}`}
        data-hv-side-inspector
      >
        <Inspector
          edits={edits}
          selection={selection}
          sourceMs={sourceMs}
          onChange={onChange}
          onSelect={onSelect}
          onSeek={onSeek}
          onError={onNote}
          clicks={clicks}
        />
      </div>
      <SideSection
        id='chapters'
        title='Chapters'
        summary={plural(edits.chapters.length, 'chapter', 'chapters')}
        open={open.has('chapters')}
        onToggle={toggle}
      >
        <ChaptersPanel
          headless
          edits={edits}
          selectedId={selection?.lane === 'chapters' ? selection.id : null}
          onAdd={onAddChapter}
          onSeek={onSeek}
          onSelect={selectChapter}
        />
      </SideSection>
      <SideSection
        id='captions'
        title='Captions'
        summary={plural(edits.captions.length, 'caption', 'captions')}
        open={open.has('captions')}
        onToggle={toggle}
      >
        <CaptionsPanel
          headless
          videoId={videoId}
          edits={edits}
          sourceMs={sourceMs}
          selectedId={selection?.lane === 'captions' ? selection.id : null}
          getSrcMs={playhead}
          onChange={onChange}
          onRefused={onNote}
          onSeek={onSeek}
          onSelect={selectCaption}
        />
      </SideSection>
      <SideSection
        id='cards'
        title='Intro, end card and banners'
        summary={cards || 'Off'}
        open={open.has('cards')}
        onToggle={toggle}
      >
        <CardsPanel
          headless
          edits={edits}
          videoTitle={videoTitle}
          videoDescription={videoDescription}
          onChange={onChange}
          onShow={onShowCard}
        />
      </SideSection>
      <SideSection
        id='music'
        title='Background music'
        summary={edits.music ? edits.music.name || 'On' : 'Off'}
        open={open.has('music')}
        onToggle={toggle}
      >
        <MusicPanel
          headless
          videoId={videoId}
          edits={edits}
          uploaded={uploaded}
          hasLevels={hasLevels}
          onChange={onChange}
          onNote={onNote}
        />
      </SideSection>
      <SideSection
        id='narration'
        title='Narration'
        summary={edits.audio?.improve ? 'Improved' : 'As recorded'}
        open={open.has('narration')}
        onToggle={toggle}
      >
        <NarrationPanel edits={edits} onChange={onChange} />
      </SideSection>
      <SideSection
        id='poster'
        title='Poster'
        summary={
          edits.poster_card === 'intro'
            ? 'Title card'
            : edits.poster_card === 'outro'
              ? 'End card'
              : posterAt === null
                ? 'First frame'
                : clockShort(posterAt)
        }
        open={open.has('poster')}
        onToggle={toggle}
      >
        <PosterPicker
          headless
          edits={edits}
          onUse={takePoster}
          onSeek={onSeek}
          onShowCard={onShowCard}
        />
      </SideSection>
      <HouseStyleSection
        edits={edits}
        open={open.has('house')}
        onToggle={toggle}
        onChange={onChange}
      />
      <SideSection
        id='clicks'
        title='Click ripples'
        summary={
          clicks?.length
            ? `${ripples} of ${clicks.length} clicks`
            : ripples
              ? `${ripples} added`
              : 'None'
        }
        open={open.has('clicks')}
        onToggle={toggle}
      >
        <ClickRipples
          headless
          clicks={clicks}
          uploaded={uploaded}
          edits={edits}
          sourceMs={sourceMs}
          onAdd={addRipples}
        />
      </SideSection>
    </aside>
  )
})
