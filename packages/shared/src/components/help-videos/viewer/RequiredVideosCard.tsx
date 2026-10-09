import { Clock, PlayCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import { useRequiredVideos } from '../api'
import { isGettingReady, listMeta } from './format'
import { HelpVideoSheet } from './HelpVideoSheet'

export function RequiredVideosCard({ className }: { className?: string }) {
  const q = useRequiredVideos()
  const [watching, setWatching] = useState<string | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const due = (q.data ?? []).filter((v) => !v.my_progress?.completed)
  // A video that is still getting ready cannot be watched yet; it is listed
  // but not counted as something the person owes.
  // The sheet below stays mounted when `required` comes back empty: the last
  // video reaches 18 of 20 while it is still playing.
  const watchable = due.filter((v) => !isGettingReady(v)).length
  const heading =
    watchable === 0
      ? due.length === 1
        ? 'A required video is getting ready'
        : 'Required videos are getting ready'
      : watchable === 1
        ? '1 video you need to watch'
        : `${watchable} videos you need to watch`
  const card = due.length > 0
  return (
    <>
      {card && (
        <section
          aria-label='Required videos'
          className={`rounded-lg border p-3 ${watchable === 0 ? 'border-border bg-muted/40' : 'border-rose-200 bg-rose-50/60 dark:border-rose-500/30 dark:bg-rose-500/10'} ${className ?? ''}`}
          data-hv-required-card={due.length}
        >
          <h2 className='mb-2 text-[13px] font-semibold'>{heading}</h2>
          <ul className='space-y-1'>
            {due.map((v) => {
              const meta = listMeta(v)
              return (
                <li key={v.id}>
                  <button
                    type='button'
                    className='flex w-full flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-md bg-white px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none dark:bg-card'
                    onClick={(e) => {
                      opener.current = e.currentTarget
                      setWatching(v.id)
                    }}
                    data-hv-required={v.id}
                  >
                    {isGettingReady(v) ? (
                      <Clock className='h-4 w-4 shrink-0 text-muted-foreground' />
                    ) : (
                      <PlayCircle className='h-4 w-4 shrink-0 text-rose-700 dark:text-rose-300' />
                    )}
                    <span className='min-w-[10rem] flex-1 truncate font-medium'>{v.title}</span>
                    <span className='ml-[26px] shrink-0 text-[12px] text-muted-foreground sm:ml-0'>
                      {meta.text}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      <HelpVideoSheet
        videoId={watching}
        open={!!watching}
        onOpenChange={(o) => !o && setWatching(null)}
        upNext={due}
        onPick={setWatching}
        returnFocusRef={opener}
      />
    </>
  )
}
