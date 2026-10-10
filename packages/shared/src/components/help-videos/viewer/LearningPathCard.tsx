import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ListVideo, PlayCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from '../../ui/button'
import { helpVideoKeys, useMyLearningPaths } from '../api'
import type { MyLearningPathDto } from '../types'
import { HelpVideoSheet } from './HelpVideoSheet'
import { continueVideo, pathProgressLabel, pathsHeading } from './paths'

/**
 * "Your learning path" (#1508): the paths for this person's role (and the
 * New User paths while their account is new), each with its progress and a
 * Continue button into the next unfinished video. Sits beside the Required
 * videos card on My Work. Nothing is shown when there is no path.
 */
export function LearningPathCard({ className }: { className?: string }) {
  const q = useMyLearningPaths()
  const qc = useQueryClient()
  const [watching, setWatching] = useState<{ path: MyLearningPathDto; videoId: string } | null>(
    null
  )
  const opener = useRef<HTMLElement | null>(null)
  const paths = q.data ?? []
  const open = (path: MyLearningPathDto, e: React.MouseEvent<HTMLElement>) => {
    const v = continueVideo(path)
    if (!v) return
    opener.current = e.currentTarget
    setWatching({ path, videoId: v.id })
  }
  return (
    <>
      {paths.length > 0 && (
        <section
          aria-label='Your learning path'
          className={`rounded-lg border border-border bg-card p-3 ${className ?? ''}`}
          data-hv-path-card={paths.length}
        >
          <h2 className='mb-2 flex items-center gap-1.5 text-[13px] font-semibold'>
            <ListVideo className='h-4 w-4 text-muted-foreground' aria-hidden />
            {pathsHeading(paths)}
          </h2>
          <ul className='space-y-2'>
            {paths.map((p) => {
              const next = continueVideo(p)
              const done = p.progress.finished
              return (
                <li
                  key={p.id}
                  className='rounded-md border border-border bg-background px-2.5 py-2'
                  data-hv-path={p.id}
                  data-hv-path-finished={done ? '1' : undefined}
                >
                  <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
                    <span className='min-w-[10rem] flex-1 truncate text-[13px] font-medium'>
                      {p.title}
                    </span>
                    {p.required && !done && (
                      <span className='rounded-full border border-rose-200 bg-rose-50 px-1.5 py-px text-[10.5px] font-medium text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300'>
                        Required
                      </span>
                    )}
                    {p.new_user && (
                      <span className='rounded-full border border-border px-1.5 py-px text-[10.5px] text-muted-foreground'>
                        For new users
                      </span>
                    )}
                    <span
                      className='text-[12px] text-muted-foreground'
                      data-hv-path-progress={p.progress.percent}
                    >
                      {pathProgressLabel(p)}
                    </span>
                  </div>
                  {p.description && (
                    <p className='mt-0.5 line-clamp-2 text-[12px] text-muted-foreground'>
                      {p.description}
                    </p>
                  )}
                  {p.progress.total > 0 && (
                    <div
                      className='mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted'
                      role='progressbar'
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={p.progress.percent}
                      aria-label={`${p.title}: ${pathProgressLabel(p)}`}
                    >
                      <div
                        className={`h-full ${done ? 'bg-emerald-500' : 'bg-[#2563eb]'}`}
                        style={{ width: `${p.progress.percent}%` }}
                      />
                    </div>
                  )}
                  <div className='mt-1.5 flex flex-wrap items-center gap-2'>
                    {done ? (
                      <span className='inline-flex items-center gap-1 text-[12px] text-emerald-700 dark:text-emerald-300'>
                        <CheckCircle2 className='h-3.5 w-3.5' aria-hidden /> All watched
                      </span>
                    ) : next ? (
                      <>
                        <Button
                          size='sm'
                          onClick={(e) => open(p, e)}
                          data-hv-path-continue={p.id}
                          aria-label={`Continue ${p.title}: ${next.title}`}
                        >
                          <PlayCircle className='h-3.5 w-3.5' />{' '}
                          {p.progress.completed > 0 ? 'Continue' : 'Start'}
                        </Button>
                        <span className='truncate text-[12px] text-muted-foreground'>
                          Next: {next.title}
                        </span>
                      </>
                    ) : null}
                    {done && next && (
                      <Button
                        size='sm'
                        variant='ghost'
                        onClick={(e) => open(p, e)}
                        data-hv-path-again={p.id}
                      >
                        Watch again
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      <HelpVideoSheet
        videoId={watching?.videoId ?? null}
        open={!!watching}
        onOpenChange={(o) => {
          if (o) return
          setWatching(null)
          // Progress is derived on the server: refetch the paths and the required list.
          void qc.invalidateQueries({ queryKey: helpVideoKeys.myPaths })
          void qc.invalidateQueries({ queryKey: helpVideoKeys.required })
        }}
        upNext={watching?.path.videos ?? []}
        onPick={(id) => setWatching((w) => (w ? { ...w, videoId: id } : w))}
        returnFocusRef={opener}
      />
    </>
  )
}
