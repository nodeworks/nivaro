import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Redo2, RotateCw, Scissors, Trash2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { Skeleton } from '../../ui/skeleton'
import { Switch } from '../../ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs'
import { helpVideoApi, helpVideoKeys, useHelpVideo } from '../api'
import { ALLOWED_SPEEDS, removeSegment, segmentIndexAt, setSpeed, splitAt } from '../edits'
import { HelpVideoPlayer, type PlayerHandle } from '../HelpVideoPlayer'
import type { HelpVideoDto, VersionDto, VideoEdits } from '../types'
import { historyReducer, initHistory } from './history'
import { SaveState } from './SaveState'
import { SilenceSuggestions } from './SilenceSuggestions'
import { suggestCuts } from './suggestCuts'
import { type Selection, Timeline } from './Timeline'
import { useAutosave } from './useAutosave'
import { useEditorShortcuts } from './useEditorShortcuts'

/** The stream path without its media ticket (`?st=`, new on every fetch). */
const streamPath = (v: HelpVideoDto) => (v.draft_stream_url ?? v.stream_url ?? '').split('?')[0]

/** Every fetch of the video carries fresh media tickets, and a new src makes
 *  the <video> reload. The editor refetches after each save, so the player
 *  keeps the copy it started with until the video or its stream really
 *  changes (an expired ticket is the player's own retry). */
function usePinnedVideo(video: HelpVideoDto, draft: VersionDto): HelpVideoDto {
  const pinned = useRef<{ key: string; dto: HelpVideoDto } | null>(null)
  const key = `${video.id}|${draft.id}|${streamPath(video)}`
  if (!pinned.current || pinned.current.key !== key)
    pinned.current = { key, dto: { ...video, draft } }
  return pinned.current.dto
}

export function HelpVideoEditor({ videoId, onClose }: { videoId: string; onClose?: () => void }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data: video, error: videoError, refetch } = useHelpVideo(videoId)
  // Bumped by Reload (after a conflict) and Try again: a new key loads the
  // draft afresh and remounts the editor body on it.
  const [loads, setLoads] = useState(0)
  // A query, not an effect: GET /draft/edits creates the draft when there is
  // none, and two calls at once (StrictMode mounts twice) could create two.
  const draftQuery = useQuery({
    queryKey: ['help-videos', 'draft-edits', videoId, loads],
    queryFn: async () => {
      const d = await helpVideoApi(client).draft(videoId)
      // The draft may be new; refetch the video so it carries draft_stream_url.
      void qc.invalidateQueries({ queryKey: helpVideoKeys.one(videoId) })
      return d
    },
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false
  })
  const draft = draftQuery.data ?? null
  const draftError = draftQuery.error
    ? (draftQuery.error as Error).message || 'The draft could not load.'
    : null
  const reload = useCallback(() => setLoads((n) => n + 1), [])

  const failed = draftError ?? (videoError ? (videoError as Error).message : null)
  if (failed && !(video && draft))
    return (
      <div className='flex h-full flex-col items-start gap-3 p-6' role='alert' data-hv-editor-error>
        <p className='flex items-center gap-2 text-[13px] text-foreground'>
          <AlertCircle className='h-4 w-4 text-rose-600 dark:text-rose-400' aria-hidden />
          The editor couldn't load this video. {failed}
        </p>
        <div className='flex gap-2'>
          <Button
            size='sm'
            variant='outline'
            onClick={() => {
              void refetch()
              reload()
            }}
          >
            <RotateCw /> Try again
          </Button>
          {onClose && (
            <Button size='sm' variant='ghost' onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>
    )
  if (!video || !draft) return <EditorSkeleton />
  return (
    <EditorBody
      key={`${draft.id}:${loads}`}
      video={video}
      draft={draft}
      onReload={reload}
      onClose={onClose}
    />
  )
}

function EditorSkeleton() {
  return (
    <section
      className='flex h-full min-h-0 flex-col bg-background'
      aria-busy='true'
      aria-label='Loading the editor'
    >
      <div className='flex items-center gap-3 border-b border-border px-4 py-3'>
        <Skeleton className='h-5 w-48' />
        <Skeleton className='ml-auto h-8 w-24' />
      </div>
      <div className='flex gap-2 px-4 py-3'>
        <Skeleton className='h-8 w-20' />
        <Skeleton className='h-8 w-24' />
        <Skeleton className='h-8 w-40' />
      </div>
      <Skeleton className='mx-3 min-h-[160px] flex-1' />
      <Skeleton className='m-3 h-52' />
    </section>
  )
}

function EditorBody({
  video,
  draft,
  onReload,
  onClose
}: {
  video: HelpVideoDto
  draft: VersionDto
  onReload: () => void
  onClose?: () => void
}) {
  const [h, dispatch] = useReducer(historyReducer, draft.edits, initHistory)
  const edits = h.present
  const set = useCallback(
    (e: VideoEdits, key?: string) => dispatch({ type: 'set', edits: e, key, now: Date.now() }),
    []
  )
  const save = useAutosave(video.id, edits, draft.edits_hash, {
    onAdopt: (from, stored) => dispatch({ type: 'adopt', from, edits: stored })
  })
  const playerVideo = usePinnedVideo(video, draft)
  const player = useRef<PlayerHandle | null>(null)
  const [src, setSrc] = useState(0)
  const [selection, setSelection] = useState<Selection>(null)
  const [viewerPreview, setViewerPreview] = useState(false)
  const [tab, setTab] = useState('edit')
  const sourceMs = draft.source_duration_ms ?? 0
  const segIndex = segmentIndexAt(edits, src)
  const silent = useMemo(() => suggestCuts(draft.levels ?? null, edits), [draft.levels, edits])
  // The piece the speed and cut tools act on: the selected one, else the one
  // under the playhead.
  const pieceIndex = selection?.lane === 'cuts' ? selection.index : segIndex
  const piece = pieceIndex >= 0 ? edits.segments[pieceIndex] : undefined

  const split = () => set(splitAt(edits, src))
  const deletePiece = () => {
    if (pieceIndex < 0) return
    const r = removeSegment(edits, pieceIndex)
    if (r.refused) toast.error(r.refused)
    else {
      set(r.edits)
      setSelection(null)
    }
  }

  useEditorShortcuts(tab === 'edit', {
    undo: () => dispatch({ type: 'undo' }),
    redo: () => dispatch({ type: 'redo' }),
    split,
    deletePiece,
    pieceSelected: selection?.lane === 'cuts'
  })

  // Close saves what's waiting first. If that save fails, the first Close
  // stays open (the status says why); a second Close leaves anyway.
  const [closeArmed, setCloseArmed] = useState(false)
  useEffect(() => {
    if (save.status === 'saved') setCloseArmed(false)
  }, [save.status])
  const close = async () => {
    if (!onClose) return
    const ok = await save.flush()
    if (ok || closeArmed) onClose()
    else setCloseArmed(true)
  }

  return (
    <div className='flex h-full min-h-0 flex-col bg-background' data-hv-editor={video.id}>
      <header className='flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5'>
        <h2 className='min-w-0 max-w-full truncate text-[15px] font-semibold text-foreground'>
          {video.title || 'Untitled video'}
        </h2>
        <SaveState save={save} onReload={onReload} />
        <div className='ml-auto flex items-center gap-3'>
          <div className='flex items-center gap-2'>
            <Switch
              id={`hv-viewer-preview-${video.id}`}
              checked={viewerPreview}
              onCheckedChange={setViewerPreview}
              className='h-5 w-9 [&>span]:h-4 [&>span]:w-4 [&>span]:data-[state=checked]:translate-x-4'
              data-hv-viewer-preview
            />
            <Label htmlFor={`hv-viewer-preview-${video.id}`} className='text-[12px] font-medium'>
              Viewer preview
            </Label>
          </div>
          {/* Publish button arrives in Task 16 (PublishButton). */}
          {onClose && (
            <Button
              size='sm'
              variant={closeArmed ? 'outline' : 'ghost'}
              className='h-8'
              onClick={() => void close()}
              data-hv-close
            >
              {closeArmed ? 'Close without saving' : 'Close'}
            </Button>
          )}
        </div>
      </header>
      <Tabs value={tab} onValueChange={setTab} className='flex min-h-0 flex-1 flex-col'>
        <TabsList className='mx-4 mt-2 h-9 self-start'>
          <TabsTrigger value='edit' className='text-[13px]'>
            Edit
          </TabsTrigger>
          <TabsTrigger value='details' className='text-[13px]'>
            Details
          </TabsTrigger>
          <TabsTrigger value='versions' className='text-[13px]'>
            Versions
          </TabsTrigger>
          <TabsTrigger value='stats' className='text-[13px]'>
            Stats
          </TabsTrigger>
        </TabsList>
        {/* Kept mounted so the player keeps its place while another tab is open. */}
        <TabsContent
          value='edit'
          forceMount
          className='mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden'
        >
          <div
            className='flex shrink-0 flex-wrap items-center gap-x-2 gap-y-2 px-4 py-2'
            role='toolbar'
            aria-label='Edit tools'
          >
            <Button
              size='sm'
              variant='outline'
              className='h-8 px-2.5 text-[12.5px]'
              onClick={split}
              disabled={segIndex < 0}
              data-hv-split
              title='Split at the playhead (S)'
            >
              <Scissors className='!size-3.5' /> Split
            </Button>
            <Button
              size='sm'
              variant='outline'
              className='h-8 px-2.5 text-[12.5px]'
              onClick={deletePiece}
              disabled={pieceIndex < 0}
              data-hv-delete-piece
              title='Cut out this piece (Delete)'
            >
              <Trash2 className='!size-3.5' /> Cut piece
            </Button>
            <div className='flex items-center gap-1.5'>
              <span className='pl-1 text-[12px] text-muted-foreground' aria-hidden>
                Speed
              </span>
              <div className='flex overflow-hidden rounded-md border border-input'>
                {ALLOWED_SPEEDS.map((sp) => {
                  const active = piece?.speed === sp
                  return (
                    <button
                      key={sp}
                      type='button'
                      disabled={!piece}
                      aria-pressed={active}
                      aria-label={`Play this piece at ${sp}× speed`}
                      onClick={() => set(setSpeed(edits, pieceIndex, sp))}
                      className={`h-8 min-w-[40px] border-l border-input px-2 text-[12.5px] tabular-nums transition-colors duration-150 first:border-l-0 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan disabled:opacity-40 motion-reduce:transition-none ${active ? 'bg-nvr-cyan/15 font-semibold text-foreground' : 'bg-background text-foreground hover:bg-muted'}`}
                      data-hv-speed-chip={sp}
                    >
                      {sp}×
                    </button>
                  )
                })}
              </div>
            </div>
            <SilenceSuggestions
              silent={silent}
              edits={edits}
              onChange={set}
              onSeek={(ms) => player.current?.seekSource(ms)}
            />
            <div className='ml-auto flex items-center gap-0.5'>
              <Button
                size='sm'
                variant='ghost'
                className='h-8 w-8 px-0'
                onClick={() => dispatch({ type: 'undo' })}
                disabled={!h.past.length}
                aria-label='Undo'
                title='Undo (Ctrl+Z)'
                data-hv-undo
              >
                <Undo2 />
              </Button>
              <Button
                size='sm'
                variant='ghost'
                className='h-8 w-8 px-0'
                onClick={() => dispatch({ type: 'redo' })}
                disabled={!h.future.length}
                aria-label='Redo'
                title='Redo (Shift+Ctrl+Z)'
                data-hv-redo
              >
                <Redo2 />
              </Button>
            </div>
          </div>
          <div className='flex min-h-[180px] flex-1'>
            <div className='min-w-0 flex-1 px-3 pb-3'>
              <HelpVideoPlayer
                video={playerVideo}
                mode='live'
                useDraft
                edits={edits}
                trackProgress={false}
                handleRef={player}
                onTime={(s) => setSrc(s)}
                className='h-full'
              />
            </div>
            {/* Inspector + preview drawing tools: Task 15 */}
          </div>
          <Timeline
            edits={edits}
            sourceMs={sourceMs}
            playheadSrcMs={src}
            levels={draft.levels ?? null}
            silences={silent}
            selection={selection}
            onSelect={setSelection}
            onSeek={(ms) => player.current?.seekSource(ms)}
            onChange={set}
          />
        </TabsContent>
        <TabsContent value='details' />
        <TabsContent value='versions' />
        <TabsContent value='stats' />
      </Tabs>
    </div>
  )
}
