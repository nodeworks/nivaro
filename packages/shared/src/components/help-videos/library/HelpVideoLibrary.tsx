import { useQueryClient } from '@tanstack/react-query'
import { Archive, Pencil, Plus, Search } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useApiFetchConfig, useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { helpVideoApi, helpVideoKeys, useHelpVideoLibrary } from '../api'
import { HelpVideoEditor } from '../editor/HelpVideoEditor'
import { canRecord, RECORD_UNSUPPORTED } from '../recorder/HelpVideoRecorder'
import { RECORDING_BUSY, useHelpVideoRecording } from '../recorder/HelpVideoRecordingProvider'
import type { HelpVideoDto } from '../types'
import {
  emptyCopy,
  formatDuration,
  isGettingReady,
  progressLabel,
  showingLabel
} from '../viewer/format'
import { HelpVideoSheet } from '../viewer/HelpVideoSheet'

type Status = 'published' | 'draft' | 'archived'

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none'

export function HelpVideoLibrary({
  watchId,
  editId,
  onWatch,
  onEdit,
  headerExtra
}: {
  watchId: string | null
  editId: string | null
  onWatch: (id: string | null) => void
  onEdit: (id: string | null) => void
  /** Host slot beside the Record button (admin puts "Who can record" there). */
  headerExtra?: React.ReactNode
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  // DTO media URLs start with /api/…; on a cross-origin host (efp-new pointed at
  // another API) they must carry the API's origin, exactly as the player does.
  const { apiBase } = useApiFetchConfig()
  const mediaOrigin = apiBase.replace(/\/api$/, '')
  const recordable = canRecord()
  const reasonId = useId()
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [category, setCategory] = useState<string | undefined>()
  const [status, setStatus] = useState<Status>('published')
  const recorder = useHelpVideoRecording()
  const [busyNote, setBusyNote] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [archiving, setArchiving] = useState<Set<string>>(() => new Set())
  const opener = useRef<HTMLElement | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(search.trim()), 300)
    return () => window.clearTimeout(t)
  }, [search])
  const q = useHelpVideoLibrary({ search: debounced || undefined, category, status })
  const canAuthor = !!q.data?.can_author
  const shown = q.data?.data.length ?? 0
  const total = q.data?.total ?? 0

  // A note about one list does not belong to the next one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clears when the list changes
  useEffect(() => {
    setArchiveError(null)
  }, [debounced, category, status])

  if (editId) {
    return (
      <div className='flex min-h-0 flex-1 flex-col'>
        <HelpVideoEditor videoId={editId} onClose={() => onEdit(null)} />
      </div>
    )
  }

  const archive = async (v: HelpVideoDto) => {
    if (archiving.has(v.id)) return
    setArchiveError(null)
    setArchiving((cur) => new Set(cur).add(v.id))
    try {
      await helpVideoApi(client).archive(v.id)
      toast.success(`"${v.title}" archived`)
      void qc.invalidateQueries({ queryKey: helpVideoKeys.all })
    } catch (e) {
      setArchiveError(`"${v.title}" could not be archived. ${(e as Error).message}`)
    } finally {
      setArchiving((cur) => {
        const next = new Set(cur)
        next.delete(v.id)
        return next
      })
    }
  }

  return (
    <div ref={root} className='flex min-h-0 flex-1 flex-col' data-hv-library>
      <header className='flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-3'>
        <h1 className='text-[16px] font-semibold'>Videos</h1>
        <div className='relative min-w-[180px] flex-1 basis-full sm:basis-auto sm:max-w-[320px]'>
          <Search
            aria-hidden='true'
            className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground'
          />
          <Input
            type='search'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search videos'
            aria-label='Search videos'
            className='h-8 pl-8 text-[13px]'
            data-hv-search
          />
        </div>
        {canAuthor && (
          <fieldset className='m-0 flex min-w-0 gap-1 border-0 p-0'>
            <legend className='sr-only'>Show</legend>
            {(['published', 'draft', 'archived'] as const).map((s) => (
              <button
                key={s}
                type='button'
                aria-pressed={status === s}
                onClick={() => setStatus(s)}
                className={`rounded-md px-2.5 py-1 text-[12.5px] transition-colors ${focusRing} ${status === s ? 'bg-nvr-cyan/10 font-medium' : 'hover:bg-muted'}`}
                data-hv-status-tab={s}
              >
                {s === 'published' ? 'Published' : s === 'draft' ? 'Drafts' : 'Archived'}
              </button>
            ))}
          </fieldset>
        )}
        <div className='ml-auto flex items-center gap-2'>
          {headerExtra}
          {canAuthor && (
            <div className='flex items-center gap-2'>
              {!recordable && (
                <p id={reasonId} className='max-w-[260px] text-[12px] text-muted-foreground'>
                  {RECORD_UNSUPPORTED}
                </p>
              )}
              <Button
                size='sm'
                onClick={() =>
                  setBusyNote(
                    !recorder.start({ onDone: (video) => onEdit(video.id), from: root.current })
                  )
                }
                disabled={!recordable}
                aria-describedby={recordable ? undefined : reasonId}
                data-hv-record
              >
                <Plus className='h-4 w-4' /> Record a video
              </Button>
            </div>
          )}
        </div>
      </header>
      {!!q.data?.categories.length && (
        <div className='flex shrink-0 flex-wrap gap-1 px-5 pt-3'>
          {[undefined, ...q.data.categories].map((c) => (
            <button
              key={c ?? 'all'}
              type='button'
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              className={`rounded-full border px-2.5 py-0.5 text-[12px] transition-colors ${focusRing} ${category === c ? 'border-nvr-cyan bg-nvr-cyan/10' : 'border-border hover:bg-muted'}`}
            >
              {c ?? 'All'}
            </button>
          ))}
        </div>
      )}
      {busyNote && recorder.active && (
        <p role='status' className='mx-5 mt-3 text-[13px] text-rose-700 dark:text-rose-300'>
          {RECORDING_BUSY}
        </p>
      )}
      {archiveError && (
        <p
          role='alert'
          className='mx-5 mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200'
          data-hv-archive-error
        >
          {archiveError}
        </p>
      )}
      <div className='min-h-0 flex-1 overflow-y-auto p-5'>
        {q.isLoading && <p className='text-[13px] text-muted-foreground'>Loading…</p>}
        {q.isError && (
          <p role='alert' className='mb-3 text-[13px] text-rose-700 dark:text-rose-300'>
            Videos could not be loaded. Try again in a moment.
          </p>
        )}
        {q.data && !q.data.data.length && !q.isError && (
          <div className='space-y-2' data-hv-empty>
            <p className='text-[13px] text-muted-foreground'>
              {emptyCopy({ search: debounced, category, status, canAuthor }).text}
            </p>
            {emptyCopy({ search: debounced, category, status, canAuthor }).offerRecord &&
              recordable && (
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() =>
                    setBusyNote(
                      !recorder.start({ onDone: (video) => onEdit(video.id), from: root.current })
                    )
                  }
                >
                  <Plus className='h-4 w-4' /> Record one
                </Button>
              )}
          </div>
        )}
        <ul className='grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]'>
          {(q.data?.data ?? []).map((v) => {
            const p = progressLabel(v)
            const waiting = isGettingReady(v)
            const chapters = v.published?.edits.chapters.length ?? 0
            const overdue = !!v.published && v.required && !p.done && !waiting
            const meta = [
              v.category,
              chapters > 1 ? `${chapters} chapters` : null,
              !v.published ? 'Draft' : waiting ? 'Getting ready' : p.text
            ]
              .filter(Boolean)
              .join(' · ')
            return (
              <li
                key={v.id}
                className='group overflow-hidden rounded-lg border border-border bg-card'
                data-hv-card={v.id}
              >
                <button
                  type='button'
                  className={`block w-full text-left ${focusRing}`}
                  onClick={(e) => {
                    opener.current = e.currentTarget
                    if (v.published) onWatch(v.id)
                    else onEdit(v.id)
                  }}
                >
                  <div className='relative aspect-video bg-slate-100 dark:bg-slate-800'>
                    {v.poster_url && (
                      <img
                        src={`${mediaOrigin}${v.poster_url}`}
                        alt=''
                        className='h-full w-full object-cover'
                        loading='lazy'
                      />
                    )}
                    {!waiting && v.published && (
                      <span className='absolute bottom-1.5 right-1.5 rounded bg-[#0f172a]/80 px-1.5 py-0.5 text-[11px] tabular-nums text-white'>
                        {formatDuration(v.duration_ms)}
                      </span>
                    )}
                    {v.my_progress && !p.done && v.my_progress.percent > 0 && (
                      <span className='absolute inset-x-0 bottom-0 h-1 bg-black/20'>
                        <span
                          className='block h-full bg-[#2563eb]'
                          style={{ width: `${v.my_progress.percent}%` }}
                        />
                      </span>
                    )}
                  </div>
                  <div className='space-y-0.5 p-2.5'>
                    <p className='line-clamp-2 text-[13px] font-medium'>
                      {v.title || 'Untitled video'}
                    </p>
                    <p
                      className={`text-[12px] ${overdue ? 'text-rose-700 dark:text-rose-300' : 'text-muted-foreground'}`}
                    >
                      {meta}
                    </p>
                  </div>
                </button>
                {canAuthor && (
                  <div className='flex gap-1 border-t border-border px-1.5 py-1'>
                    <Button
                      size='sm'
                      variant='ghost'
                      onClick={() => onEdit(v.id)}
                      data-hv-edit={v.id}
                    >
                      <Pencil className='h-3.5 w-3.5' /> Edit
                    </Button>
                    {v.status !== 'archived' && (
                      <Button
                        size='sm'
                        variant='ghost'
                        onClick={() => void archive(v)}
                        disabled={archiving.has(v.id)}
                        data-hv-archive={v.id}
                      >
                        <Archive className='h-3.5 w-3.5' /> Archive
                      </Button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
        {q.data && q.data.data.length > 0 && (
          <div className='mt-5 flex items-center gap-3' data-hv-more>
            {q.hasNextPage && (
              <Button
                size='sm'
                variant='outline'
                onClick={() => void q.fetchNextPage()}
                disabled={q.isFetchingNextPage}
                data-hv-show-more
              >
                {q.isFetchingNextPage ? 'Loading…' : 'Show more'}
              </Button>
            )}
            {showingLabel(shown, total) && (
              <p className='text-[12px] text-muted-foreground' aria-live='polite'>
                {showingLabel(shown, total)}
              </p>
            )}
          </div>
        )}
      </div>
      <HelpVideoSheet
        videoId={watchId}
        open={!!watchId}
        onOpenChange={(o) => !o && onWatch(null)}
        returnFocusRef={opener}
      />
      {recorder.fallback}
    </div>
  )
}
