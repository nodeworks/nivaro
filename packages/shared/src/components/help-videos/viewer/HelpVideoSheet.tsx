import { useQueryClient } from '@tanstack/react-query'
import { Film, History, MousePointerClick, PictureInPicture2, Sparkles } from 'lucide-react'
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigation } from '../../../context'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../ui/sheet'
import {
  helpVideoKeys,
  useHelpVideo,
  useHelpVideoClips,
  useHelpVideoNext,
  useHelpVideoWalk
} from '../api'
import { ClipDialog, type ClipPreset } from '../editor/ClipDialog'
import { ClipRows } from '../editor/ClipsPanel'
import { type ClipRange, clipRangeForChapter } from '../editor/clips'
import { HelpVideoPlayer, type PlayerHandle } from '../HelpVideoPlayer'
import type { ClipDto, HelpVideoDto } from '../types'
import { HelpVideoWalkHost } from '../walk/HelpVideoWalk'
import { startHelpVideoWalk, useCurrentHelpVideoPage } from '../walk/store'
import { stepMatchesHere } from '../walk/target'
import { CopyMomentLink } from './CopyMomentLink'
import { DownloadMenu } from './DownloadMenu'
import { FeedbackPanel } from './FeedbackPanel'
import { feedbackDue } from './feedback'
import { formatDuration, visibleChapters } from './format'
import { MiniPanel, PipContents, preparePipDocument, StageSlot } from './MiniPlayerHost'
import { handOver, hasDocumentPip, MINI_INITIAL, MINI_PANEL, miniReducer } from './miniPlayer'
import { resolveMomentStart } from './moments'
import { UpNextList } from './UpNext'

export function useHelpVideosPath(): (query?: string) => string {
  const nav = useNavigation()
  return (query = '') => `${nav.helpVideosPath ?? '/help-videos'}${query}`
}

const rowButton =
  'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan motion-reduce:transition-none'
const smallButton =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[12.5px] font-medium transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none'

type PipWindow = Window & { close(): void }
type DocPip = { requestWindow(o?: { width?: number; height?: number }): Promise<PipWindow> }

/** A detached element that is never shown: the stage is parked here between
 *  two homes so the <video> never leaves the document (which would pause it). */
function makeHolder(): HTMLDivElement {
  const d = document.createElement('div')
  d.setAttribute('data-hv-stage-holder', '')
  d.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden'
  return d
}

export function HelpVideoSheet({
  videoId,
  open,
  onOpenChange,
  upNext = [],
  onPick,
  returnFocusRef,
  startAtMs = null,
  startChapterId = null,
  showMe = true
}: {
  videoId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Other videos for the same screen, offered under the player when the
   *  server has nothing better (#1530). */
  upNext?: HelpVideoDto[]
  onPick?: (id: string) => void
  /** Where focus goes on close when the opener unmounts while the sheet is
   *  open (a popover row). Absent = whatever had focus when the sheet opened. */
  returnFocusRef?: RefObject<HTMLElement | null>
  /** Start the player here (edited time), e.g. a walk's "Watch this step". */
  startAtMs?: number | null
  /** Start at this chapter (a moment link's `c`); wins over startAtMs when it exists. */
  startChapterId?: string | null
  /** Offer "Show me on this page" when the video has steps for this screen. */
  showMe?: boolean
}) {
  const { data: video, error } = useHelpVideo(open ? videoId : null)
  const player = useRef<PlayerHandle | null>(null)
  const nav = useNavigation()
  const path = useHelpVideosPath()
  const chapters = video?.published ? visibleChapters(video.published.edits) : []
  const startMs = resolveMomentStart(chapters, video?.duration_ms, startAtMs, startChapterId)
  // The note stays up while the sheet is open: the first progress beat on the
  // new version (or a render poll) refetches the video without it.
  const [kept, setKept] = useState<{ id: string; news: HelpVideoDto['whats_new'] } | null>(null)
  const live = video?.whats_new ?? null
  useEffect(() => {
    if (!open) setKept(null)
    else if (video && live && kept?.id !== video.id) setKept({ id: video.id, news: live })
  }, [open, video, live, kept?.id])
  const news = live ?? (kept && kept.id === videoId ? kept.news : null) ?? null
  const walk = useHelpVideoWalk(showMe && open && video?.published ? videoId : null)
  // Clips (#1562): everyone who can watch sees the ready ones; an author can
  // make one of a chapter from here (the published version).
  const qc = useQueryClient()
  const author = !!video?.visibility
  const clips = useHelpVideoClips(open && video?.published ? videoId : null)
  const shownClips = (clips.data ?? []).filter((c) =>
    author ? c.status !== 'failed' : c.status === 'ready'
  )
  const [clipDialog, setClipDialog] = useState<{
    initial: ClipRange
    presets: ClipPreset[]
  } | null>(null)
  const clipChapter = (id: string) => {
    if (!video?.published) return
    const e = video.published.edits
    const r = clipRangeForChapter(e, id)
    if (!r) return
    const presets: ClipPreset[] = []
    for (const c of e.chapters) {
      const cr = clipRangeForChapter(e, c.id)
      if (cr)
        presets.push({
          key: `chapter:${c.id}`,
          label: `Chapter: ${c.title || 'Chapter'}`,
          range: cr
        })
    }
    setClipDialog({ initial: r, presets })
  }
  const pageKey = useCurrentHelpVideoPage()
  const steps = walk.data?.steps ?? []
  const here = { pageKey, path: typeof window === 'undefined' ? '' : window.location.pathname }
  const firstHere = steps.findIndex((s) => stepMatchesHere(s, here))
  const stepsHere = steps.filter((s) => stepMatchesHere(s, here)).length

  // ── The one player, and where it lives (#1500) ───────────────────────────
  // The player renders through a portal into `stage`; the stage is moved
  // between the sheet, a Document Picture-in-Picture window and the floating
  // panel, so the React tree and the <video> survive every move.
  const [stage] = useState(() =>
    typeof document === 'undefined' ? null : document.createElement('div')
  )
  const [holder] = useState(() => (typeof document === 'undefined' ? null : makeHolder()))
  const [mini, dispatch] = useReducer(miniReducer, MINI_INITIAL)
  const miniRef = useRef(mini)
  miniRef.current = mini
  const openRef = useRef(open)
  openRef.current = open
  const pip = useRef<{ win: PipWindow; onHide: () => void; onResize: () => void } | null>(null)
  const [pipBody, setPipBody] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!holder) return
    document.body.appendChild(holder)
    return () => holder.remove()
  }, [holder])
  useEffect(() => {
    if (open) dispatch({ type: 'open' })
    else dispatch({ type: 'close' })
  }, [open])
  const snapshot = () => ({
    at: player.current?.editedMs() ?? 0,
    playing: player.current?.isPlaying() ?? false
  })
  /** The clock after a move: normally untouched; restored when the browser reset it. */
  const afterMove = (before: { at: number; playing: boolean }) => {
    player.current?.remeasure()
    window.setTimeout(() => {
      const h = player.current
      if (!h) return
      h.remeasure()
      const r = handOver(before, { at: h.editedMs(), playing: h.isPlaying() })
      if (r.seekTo !== null) h.seekEdited(r.seekTo)
      if (r.resume) h.play()
    }, 80)
  }
  const park = () => {
    if (stage && holder && stage.parentElement !== holder) holder.appendChild(stage)
  }
  const closePip = () => {
    const p = pip.current
    if (!p) return
    pip.current = null
    p.win.removeEventListener('pagehide', p.onHide)
    p.win.removeEventListener('resize', p.onResize)
    park()
    setPipBody(null)
    try {
      p.win.close()
    } catch {
      /* already gone */
    }
  }
  const popOut = async () => {
    if (!stage || mini.place !== 'sheet') return
    const before = snapshot()
    if (hasDocumentPip(window)) {
      try {
        const api = (window as unknown as { documentPictureInPicture: DocPip })
          .documentPictureInPicture
        const win = await api.requestWindow({ width: MINI_PANEL.width, height: MINI_PANEL.height })
        // The sheet closed (or moved on) while the browser asked permission:
        // nothing to show in the new window, so it goes away again.
        if (!openRef.current || miniRef.current.place !== 'sheet') {
          win.close()
          return
        }
        preparePipDocument(win, document)
        // The window was closed from the OS side: the sheet comes back at
        // the same moment (the stage is rescued before the document goes).
        const onHide = () => {
          if (pip.current?.win !== win) return
          const at = snapshot()
          pip.current = null
          park()
          setPipBody(null)
          dispatch({ type: 'mini-closed', ...at })
          afterMove(at)
        }
        const onResize = () => player.current?.remeasure()
        win.addEventListener('pagehide', onHide)
        win.addEventListener('resize', onResize)
        pip.current = { win, onHide, onResize }
        // Move the stage now, in this task, so the video never pauses.
        win.document.body.appendChild(stage)
        setPipBody(win.document.body)
        dispatch({ type: 'pop-out', kind: 'pip', ...before })
        afterMove(before)
        return
      } catch {
        // Refused (no user gesture, policy): the floating panel instead.
      }
    }
    park()
    dispatch({ type: 'pop-out', kind: 'panel', ...before })
    afterMove(before)
  }
  const popIn = () => {
    if (mini.place !== 'mini') return
    const at = snapshot()
    closePip()
    park()
    dispatch({ type: 'pop-in', ...at })
    afterMove(at)
  }
  const closeAll = () => {
    closePip()
    onOpenChange(false)
  }
  // The host closed while the video was popped out (and on unmount).
  const closePipRef = useRef(closePip)
  closePipRef.current = closePip
  useEffect(() => {
    if (!open) closePipRef.current()
  }, [open])
  useEffect(() => () => closePipRef.current(), [])
  const sheetOpen = open && mini.place !== 'mini'

  // ── The end of the video: feedback (#1505) and Up next (#1530) ──────────
  const [ended, setEnded] = useState(false)
  const [due, setDue] = useState(false)
  const dueRef = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new video starts over
  useEffect(() => {
    setEnded(false)
    setDue(false)
    dueRef.current = false
  }, [videoId, open])
  const completed = !!video?.my_progress?.completed
  const onTime = useCallback((_src: number, editedMs: number) => {
    if (dueRef.current) return
    const total = player.current?.totalMs() ?? 0
    if (feedbackDue({ editedMs, totalMs: total, ended: false, completed: false })) {
      dueRef.current = true
      setDue(true)
    }
  }, [])
  const onEnded = useCallback(() => {
    setEnded(true)
    dueRef.current = true
    setDue(true)
  }, [])
  const nextQ = useHelpVideoNext(videoId, open && !!video?.published)
  const fallbackNext = upNext.filter(
    (v) => v.id !== videoId && v.published && !v.my_progress?.completed
  )
  const next = (nextQ.data?.length ? nextQ.data : fallbackNext).filter((v) => v.id !== videoId)

  // Runs before the dialog's focus scope moves focus into the sheet.
  const opener = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (sheetOpen && document.activeElement instanceof HTMLElement)
      opener.current = document.activeElement
  }, [sheetOpen])

  const title = video?.title || 'Video'
  const showPlayer = open && !!video?.published && !!stage

  return (
    <>
      <HelpVideoWalkHost />
      {showPlayer &&
        stage &&
        createPortal(
          <HelpVideoPlayer
            key={video.published?.id}
            video={video}
            mode='viewer'
            handleRef={player}
            startAtMs={startMs}
            onTime={onTime}
            onEnded={onEnded}
            autoPlay
          />,
          stage
        )}
      {open && stage && mini.place === 'mini' && mini.kind === 'panel' && (
        <MiniPanel stage={stage} title={title} onPopIn={popIn} onClose={closeAll} />
      )}
      {open && stage && mini.place === 'mini' && mini.kind === 'pip' && pipBody && (
        <PipContents
          body={pipBody}
          stage={stage}
          title={title}
          onPopIn={popIn}
          onClose={closeAll}
        />
      )}
      <Sheet open={sheetOpen} onOpenChange={onOpenChange}>
        <SheetContent
          className='flex w-[min(960px,96vw)] flex-col gap-3 overflow-y-auto sm:max-w-none'
          data-hv-sheet={videoId ?? ''}
          onCloseAutoFocus={(e) => {
            // Radix would send focus to a trigger we do not render.
            e.preventDefault()
            const back = returnFocusRef?.current ?? opener.current
            if (back?.isConnected) back.focus()
          }}
        >
          <SheetHeader className='pr-8 text-left'>
            <SheetTitle>{video?.title ?? 'Video'}</SheetTitle>
            <SheetDescription className={video?.description ? 'whitespace-pre-line' : 'sr-only'}>
              {video?.description ?? 'Help video'}
            </SheetDescription>
          </SheetHeader>
          {error && (
            <p role='alert' className='text-[13px] text-rose-700 dark:text-rose-300'>
              This video is not available to you.
            </p>
          )}
          {video && !video.published && (
            <p className='text-[13px] text-muted-foreground'>
              This video has not been published yet.
            </p>
          )}
          {video?.published && stage && (
            <>
              {news && (
                <WhatsNewNote
                  news={news}
                  onJump={(ms) => {
                    player.current?.seekEdited(ms)
                    player.current?.play()
                  }}
                />
              )}
              <StageSlot stage={stage} />
              {video.stale && (
                <p
                  className='flex items-start gap-1.5 text-[12px] text-muted-foreground'
                  data-hv-stale={video.stale.kind}
                >
                  <History className='mt-px h-3.5 w-3.5 shrink-0' aria-hidden />
                  <span>
                    Recorded before a change to this screen
                    {video.visibility ? ` — ${video.stale.detail}` : ''}.
                  </span>
                </p>
              )}
              {ended && next.length > 0 && onPick && (
                <UpNextList videos={next} onPick={onPick} prominent />
              )}
              <div className='flex flex-wrap items-center gap-x-3 gap-y-1' data-hv-player-row>
                <button
                  type='button'
                  className={smallButton}
                  onClick={() => void popOut()}
                  title='Keep playing in a small window while you work'
                  data-hv-pop-out
                >
                  <PictureInPicture2 className='h-3.5 w-3.5' aria-hidden /> Keep playing while I
                  work
                </button>
                {showMe && firstHere >= 0 && (
                  <>
                    <button
                      type='button'
                      className={smallButton}
                      onClick={() => {
                        player.current?.pause()
                        onOpenChange(false)
                        startHelpVideoWalk({
                          videoId: video.id,
                          title: video.title || 'Video',
                          steps,
                          index: firstHere
                        })
                      }}
                      data-hv-show-me
                    >
                      <MousePointerClick className='h-3.5 w-3.5' aria-hidden /> Show me on this page
                    </button>
                    <span className='text-[12px] text-muted-foreground'>
                      Highlights what to click,{' '}
                      {stepsHere === 1 ? 'one step' : `${stepsHere} steps`} on this screen.
                    </span>
                  </>
                )}
              </div>
              <FeedbackPanel
                video={video}
                due={due || completed}
                currentMs={() => player.current?.editedMs() ?? 0}
                totalMs={player.current?.totalMs() ?? video.duration_ms ?? 0}
              />
              {chapters.length > 1 && (
                <nav aria-label='Chapters' data-hv-chapters>
                  <h3 className='mb-1 text-[12px] font-medium text-muted-foreground'>Chapters</h3>
                  <ol className='divide-y divide-border overflow-hidden rounded-md border border-border text-[13px]'>
                    {chapters.map((c) => (
                      <li key={c.id} className='flex items-center'>
                        <button
                          type='button'
                          className={`${rowButton} min-w-0 flex-1`}
                          onClick={() => {
                            player.current?.seekSource(c.source_ms)
                            player.current?.play()
                          }}
                          data-hv-chapter={c.id}
                        >
                          <span className='w-14 shrink-0 tabular-nums text-muted-foreground'>
                            {formatDuration(c.edited_ms)}
                          </span>
                          <span className='truncate'>{c.title}</span>
                        </button>
                        {author && (
                          <button
                            type='button'
                            className='mr-1.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none'
                            onClick={() => clipChapter(c.id)}
                            aria-label={`Make a clip of ${c.title || 'this chapter'}`}
                            title='Make a clip of this chapter'
                            data-hv-chapter-clip={c.id}
                          >
                            <Film className='h-3.5 w-3.5' aria-hidden />
                          </button>
                        )}
                      </li>
                    ))}
                  </ol>
                </nav>
              )}
            </>
          )}
          {!ended && next.length > 0 && onPick && <UpNextList videos={next} onPick={onPick} />}
          {video?.published && shownClips.length > 0 && (
            <section aria-label='Clips' data-hv-sheet-clips>
              <h3 className='mb-1 text-[12px] font-medium text-muted-foreground'>Clips</h3>
              <div className='rounded-md border border-border px-1.5 py-1'>
                <ClipRows clips={shownClips} />
              </div>
            </section>
          )}
          {clipDialog && video?.published && (
            <ClipDialog
              videoId={video.id}
              edits={video.published.edits}
              draft={false}
              initial={clipDialog.initial}
              presets={clipDialog.presets}
              onQueued={(clip) => {
                qc.setQueryData<ClipDto[]>(helpVideoKeys.clips(video.id), (cur) => [
                  clip,
                  ...(cur ?? []).filter((x) => x.id !== clip.id)
                ])
                void qc.invalidateQueries({ queryKey: helpVideoKeys.clips(video.id) })
              }}
              onClose={() => setClipDialog(null)}
            />
          )}
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <button
              type='button'
              className='rounded text-[12px] text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
              onClick={() => {
                onOpenChange(false)
                nav.navigate(path())
              }}
            >
              All videos
            </button>
            <div className='flex flex-wrap items-center gap-2'>
              {video?.published && (
                <CopyMomentLink
                  videoId={video.id}
                  chapters={chapters}
                  currentMs={() => player.current?.editedMs() ?? 0}
                />
              )}
              {video?.published && (video.download_urls || video.transcript_url) && (
                <DownloadMenu
                  urls={video.download_urls}
                  transcript={video.transcript_url}
                  ready={!!video.visibility || video.published.playable !== false}
                  where='sheet'
                />
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

/** What changed since this person last watched (#1497). */
function WhatsNewNote({
  news,
  onJump
}: {
  news: NonNullable<HelpVideoDto['whats_new']>
  onJump: (ms: number) => void
}) {
  const heading =
    news.kind === 'again'
      ? 'You are asked to watch this again'
      : news.whole
        ? 'This video was re-recorded since you watched it'
        : 'Updated since you watched it'
  return (
    <section
      aria-label='What changed'
      className='flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-[13px] dark:border-sky-400/30 dark:bg-sky-400/10'
      data-hv-whats-new={news.kind}
    >
      <Sparkles className='mt-0.5 h-4 w-4 shrink-0 text-sky-700 dark:text-sky-300' aria-hidden />
      <div className='min-w-0 flex-1 space-y-0.5'>
        <p className='font-medium text-sky-950 dark:text-sky-100'>{heading}</p>
        {news.note && (
          <p className='whitespace-pre-line text-sky-900 dark:text-sky-200' data-hv-whats-new-note>
            {news.note}
          </p>
        )}
      </div>
      {news.jump_ms != null && (
        <button
          type='button'
          className='inline-flex h-8 shrink-0 items-center rounded-md border border-sky-300 bg-white px-2.5 text-[12.5px] font-medium text-sky-900 transition-colors duration-150 hover:bg-sky-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none dark:border-sky-400/40 dark:bg-transparent dark:text-sky-100 dark:hover:bg-sky-400/15'
          onClick={() => onJump(news.jump_ms as number)}
          data-hv-whats-new-jump={news.jump_ms}
        >
          {news.chapter
            ? `Jump to what changed: ${news.chapter.title}`
            : `Jump to what changed (${formatDuration(news.jump_ms)})`}
        </button>
      )}
    </section>
  )
}
