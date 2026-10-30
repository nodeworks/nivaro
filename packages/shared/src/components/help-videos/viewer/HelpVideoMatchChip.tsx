import { PlayCircle, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useHelpVideosFor } from '../api'
import { LazyHelpVideoSheet } from './LazyHelpVideoSheet'
import { chipAllowedOn, chipLabel, chipVideo, readDismissed, rememberDismissed } from './matchChip'

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none'

/**
 * #18 — "Watch: How to submit an IR (2:10)": the screen's best help video,
 * when there is a strong match the person has not finished. Renders nothing
 * otherwise (no wrapper either), so a host can mount it in its header area
 * unconditionally. × hides that video's chip for good (this browser).
 *
 * Hosts pass the route (`path`) and, when they have one, their page key /
 * record context; the server ranks screen → screens like it → record type →
 * area → glossary terms (GET /help-videos/for).
 */
export function HelpVideoMatchChip({
  path,
  app,
  page,
  collection,
  item,
  terms,
  className
}: {
  path: string
  app?: string
  page?: string
  collection?: string
  item?: string | number
  /** Glossary terms the screen shows. */
  terms?: string[]
  /** Classes for the wrapper, which only renders when a chip shows. */
  className?: string
}) {
  const allowed = chipAllowedOn(path)
  const q = useHelpVideosFor(
    {
      path,
      ...(app ? { app } : {}),
      ...(page ? { page } : {}),
      ...(collection ? { collection } : {}),
      ...(item != null ? { item } : {}),
      ...(terms?.length ? { terms: terms.slice(0, 12).join(',') } : {})
    },
    allowed
  )
  const [dismissed, setDismissed] = useState(() => readDismissed())
  const [watching, setWatching] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const videos = q.data?.data ?? []
  const video = allowed ? chipVideo(videos, q.data?.best_id, dismissed) : null

  return (
    <>
      {video && (
        <div className={className} data-hv-match-chip data-nvr-recording-hide>
          <div className='inline-flex h-7 max-w-full items-center rounded-full border border-border bg-card text-[12px] text-foreground shadow-sm'>
            <button
              ref={trigger}
              type='button'
              onClick={() => setWatching(video.id)}
              title={video.match?.reason ? `${video.match.reason} — ${video.title}` : video.title}
              className={`flex min-w-0 items-center gap-1.5 rounded-l-full py-1 pl-2.5 pr-1.5 transition-colors hover:bg-muted ${focusRing}`}
              data-hv-match-play={video.id}
            >
              <PlayCircle
                className='h-3.5 w-3.5 shrink-0 text-[#2563eb] dark:text-sky-300'
                aria-hidden='true'
              />
              <span className='truncate'>{chipLabel(video)}</span>
            </button>
            <button
              type='button'
              aria-label={`Hide the suggestion "${video.title}"`}
              onClick={() => setDismissed(rememberDismissed(video.id))}
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-r-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${focusRing}`}
              data-hv-match-dismiss
            >
              <X className='h-3.5 w-3.5' aria-hidden='true' />
            </button>
          </div>
        </div>
      )}
      <LazyHelpVideoSheet
        videoId={watching}
        open={!!watching}
        onOpenChange={(o) => !o && setWatching(null)}
        upNext={videos}
        onPick={setWatching}
        returnFocusRef={trigger}
      />
    </>
  )
}
