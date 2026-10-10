import { Clock, ListVideo, PlayCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import { useRequiredList } from '../api'
import type { HelpVideoDto, MyLearningPathDto } from '../types'
import { isGettingReady, listMeta } from './format'
import { HelpVideoSheet } from './HelpVideoSheet'
import { continueVideo, pathProgressLabel } from './paths'

export function RequiredVideosCard({ className }: { className?: string }) {
  const q = useRequiredList()
  const [watching, setWatching] = useState<{ videoId: string; upNext: HelpVideoDto[] } | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const due = (q.data?.data ?? []).filter((v) => !v.my_progress?.completed)
  // Required learning paths (#1508) that are not finished: one row per path,
  // opening at its next video. The server has already left the videos of
  // such a path out of `data`, so nothing is counted twice.
  const paths = (q.data?.paths ?? []).filter((p) => !p.progress.finished)
  // A video that is still getting ready cannot be watched yet; it is listed
  // but not counted as something the person owes.
  // The sheet below stays mounted when `required` comes back empty: the last
  // video reaches 18 of 20 while it is still playing.
  const watchable = due.filter((v) => !isGettingReady(v)).length + paths.length
  const total = due.length + paths.length
  const heading =
    watchable === 0
      ? due.length === 1
        ? 'A required video is getting ready'
        : 'Required videos are getting ready'
      : watchable === 1
        ? paths.length === 1 && due.length === 0
          ? '1 learning path you need to finish'
          : '1 video you need to watch'
        : `${watchable} ${paths.length ? 'things' : 'videos'} you need to watch`
  const card = total > 0
  const openPath = (p: MyLearningPathDto, e: React.MouseEvent<HTMLElement>) => {
    const v = continueVideo(p)
    if (!v) return
    opener.current = e.currentTarget
    setWatching({ videoId: v.id, upNext: p.videos })
  }
  return (
    <>
      {card && (
        <section
          aria-label='Required videos'
          className={`rounded-lg border p-3 ${watchable === 0 ? 'border-border bg-muted/40' : 'border-rose-200 bg-rose-50/60 dark:border-rose-500/30 dark:bg-rose-500/10'} ${className ?? ''}`}
          data-hv-required-card={total}
        >
          <h2 className='mb-2 text-[13px] font-semibold'>{heading}</h2>
          <ul className='space-y-1'>
            {paths.map((p) => {
              const next = continueVideo(p)
              return (
                <li key={`path-${p.id}`}>
                  <button
                    type='button'
                    className='flex w-full flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-md bg-white px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none dark:bg-card'
                    onClick={(e) => openPath(p, e)}
                    disabled={!next}
                    data-hv-required-path={p.id}
                  >
                    <ListVideo className='h-4 w-4 shrink-0 text-rose-700 dark:text-rose-300' />
                    <span className='min-w-[10rem] flex-1 truncate font-medium'>{p.title}</span>
                    <span className='ml-[26px] shrink-0 text-[12px] text-muted-foreground sm:ml-0'>
                      {pathProgressLabel(p)}
                      {next ? ` · next: ${next.title}` : ''}
                    </span>
                  </button>
                </li>
              )
            })}
            {due.map((v) => {
              const meta = listMeta(v)
              return (
                <li key={v.id}>
                  <button
                    type='button'
                    className='flex w-full flex-wrap items-center gap-x-2.5 gap-y-0.5 rounded-md bg-white px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none dark:bg-card'
                    onClick={(e) => {
                      opener.current = e.currentTarget
                      setWatching({ videoId: v.id, upNext: due })
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
                    {v.whats_new && (
                      <span
                        className='ml-[26px] basis-full truncate text-[12px] text-sky-800 dark:text-sky-300'
                        data-hv-required-news={v.whats_new.kind}
                      >
                        {v.whats_new.note
                          ? `What changed: ${v.whats_new.note}`
                          : v.whats_new.kind === 'again'
                            ? 'Asked to watch again'
                            : 'Updated since you watched it'}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      <HelpVideoSheet
        videoId={watching?.videoId ?? null}
        open={!!watching}
        onOpenChange={(o) => !o && setWatching(null)}
        upNext={watching?.upNext ?? due}
        onPick={(id) => setWatching((w) => ({ videoId: id, upNext: w?.upNext ?? due }))}
        returnFocusRef={opener}
      />
    </>
  )
}
