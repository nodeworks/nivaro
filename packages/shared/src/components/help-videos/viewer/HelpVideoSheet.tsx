import { MousePointerClick } from 'lucide-react'
import { type RefObject, useLayoutEffect, useRef } from 'react'
import { useNavigation } from '../../../context'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../../ui/sheet'
import { useHelpVideo, useHelpVideoWalk } from '../api'
import { HelpVideoPlayer, type PlayerHandle } from '../HelpVideoPlayer'
import type { HelpVideoDto } from '../types'
import { HelpVideoWalkHost } from '../walk/HelpVideoWalk'
import { startHelpVideoWalk, useCurrentHelpVideoPage } from '../walk/store'
import { stepMatchesHere } from '../walk/target'
import { formatDuration, isGettingReady, visibleChapters } from './format'

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
  /** Offer "Show me on this page" when the video has steps for this screen. */
  showMe?: boolean
}) {
  const { data: video, error } = useHelpVideo(open ? videoId : null)
  const next = upNext.filter((v) => v.id !== videoId && v.published)
  const player = useRef<PlayerHandle | null>(null)
  const nav = useNavigation()
  const path = useHelpVideosPath()
  const chapters = video?.published ? visibleChapters(video.published.edits) : []
  const walk = useHelpVideoWalk(showMe && open && video?.published ? videoId : null)
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
              <HelpVideoPlayer
                key={video.published.id}
                video={video}
                mode='viewer'
                handleRef={player}
                startAtMs={startAtMs}
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
                      <li key={c.id}>
                        <button
                          type='button'
                          className={rowButton}
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
                      </li>
                    ))}
                  </ol>
                </nav>
              )}
            </>
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
          <button
            type='button'
            className='self-start rounded text-[12px] text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
            onClick={() => {
              onOpenChange(false)
              nav.navigate(path())
            }}
          >
            All videos
          </button>
        </SheetContent>
      </Sheet>
    </>
  )
}
