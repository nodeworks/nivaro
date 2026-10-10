import { useQueryClient } from '@tanstack/react-query'
import { Film, MousePointerClick, Sparkles } from 'lucide-react'
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigation } from '../../../context'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../ui/sheet'
import { helpVideoKeys, useHelpVideo, useHelpVideoClips, useHelpVideoWalk } from '../api'
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
import { formatDuration, isGettingReady, visibleChapters } from './format'
import { resolveMomentStart } from './moments'

export function useHelpVideosPath(): (query?: string) => string {
  const nav = useNavigation()
  return (query = '') => `${nav.helpVideosPath ?? '/help-videos'}${query}`
}

const rowButton =
  'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan motion-reduce:transition-none'

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
  /** Other videos for the same screen, offered under the player. */
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
  const next = upNext.filter((v) => v.id !== videoId && v.published)
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

  // Runs before the dialog's focus scope moves focus into the sheet.
  const opener = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement)
      opener.current = document.activeElement
  }, [open])

  return (
    <>
      <HelpVideoWalkHost />
      <Sheet open={open} onOpenChange={onOpenChange}>
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
          {video?.published && (
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
              <HelpVideoPlayer
                key={video.published.id}
                video={video}
                mode='viewer'
                handleRef={player}
                startAtMs={startMs}
                autoPlay
              />
              {showMe && firstHere >= 0 && video && (
                <div className='flex flex-wrap items-center gap-x-3 gap-y-1' data-hv-show-me-row>
                  <button
                    type='button'
                    className='inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[12.5px] font-medium transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none'
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
                    Highlights what to click, {stepsHere === 1 ? 'one step' : `${stepsHere} steps`}{' '}
                    on this screen.
                  </span>
                </div>
              )}
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
          {next.length > 0 && onPick && (
            <section aria-label='Up next' data-hv-up-next>
              <h3 className='mb-1 text-[12px] font-medium text-muted-foreground'>Up next</h3>
              <ul className='divide-y divide-border overflow-hidden rounded-md border border-border text-[13px]'>
                {next.map((v) => (
                  <li key={v.id}>
                    <button
                      type='button'
                      className={rowButton}
                      onClick={() => onPick(v.id)}
                      data-hv-up-next-item={v.id}
                    >
                      <span className='min-w-0 flex-1 truncate'>{v.title}</span>
                      <span className='shrink-0 text-[12px] tabular-nums text-muted-foreground'>
                        {isGettingReady(v) ? 'Getting ready' : formatDuration(v.duration_ms)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
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
