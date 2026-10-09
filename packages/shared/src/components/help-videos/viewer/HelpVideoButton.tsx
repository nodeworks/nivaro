import { CheckCircle2, Clock, PlayCircle, Video } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useNavigation, useNivaroClient } from '../../../context'
import { modalHostOf, Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { helpVideoApi, useHelpVideosFor } from '../api'
import { canRecord, RECORD_UNSUPPORTED } from '../recorder/HelpVideoRecorder'
import { RECORDING_BUSY, useHelpVideoRecording } from '../recorder/HelpVideoRecordingProvider'
import type { HelpVideoContext } from '../types'
import { useHelpVideoUpload } from '../upload/HelpVideoUpload'
import { registerHelpVideoPage } from '../walk/store'
import { isGettingReady, listMeta, progressLabel, showButton } from './format'
import { HelpVideoSheet, useHelpVideosPath } from './HelpVideoSheet'

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none'

export function HelpVideoButton({
  collection,
  item,
  page,
  pageLabel,
  compact
}: {
  collection?: string
  item?: string | number
  page?: string
  /** Name authors see when choosing where a video shows (registered once per 10 min). */
  pageLabel?: string
  compact?: boolean
}) {
  const client = useNivaroClient()
  const nav = useNavigation()
  const path = useHelpVideosPath()
  const q = useHelpVideosFor({ collection, item, page })
  const [open, setOpen] = useState(false)
  const [watching, setWatching] = useState<string | null>(null)
  const recorder = useHelpVideoRecording()
  const [busyNote, setBusyNote] = useState(false)
  const recordable = canRecord()
  const trigger = useRef<HTMLButtonElement | null>(null)
  const reasonId = useId()
  const clientRef = useRef(client)
  clientRef.current = client

  const videos = q.data?.data ?? []
  const canAuthor = !!q.data?.can_author

  // The screen's page key, for click labels and "Show me on this page".
  useEffect(() => (page ? registerHelpVideoPage(page) : undefined), [page])

  // Page keys become pickable in the editor once a page has rendered a button.
  // Only authors may register one (the route answers 403 to everyone else).
  useEffect(() => {
    if (page && canAuthor) {
      void helpVideoApi(clientRef.current)
        .registerPage(page, pageLabel ?? page)
        .catch(() => null)
    }
  }, [page, pageLabel, canAuthor])

  // The sheet and the recorder live outside the button's own early exit: a
  // refetch that empties the list must not unmount a video someone is watching.
  const visible = !!q.data && showButton(videos.length, canAuthor)
  // A video that is still getting ready cannot be watched, so it is not counted as owed.
  const unwatchedRequired = videos.filter(
    (v) => v.required && !v.my_progress?.completed && !isGettingReady(v)
  ).length

  const contexts: HelpVideoContext[] = collection
    ? [{ kind: 'collection', key: collection, state_key: q.data?.state ?? null }]
    : page
      ? [{ kind: 'page', key: page, state_key: null }]
      : []

  // Same hand-over as a recording started here: the editor opens on the draft.
  const upload = useHelpVideoUpload({
    contexts,
    host: modalHostOf(trigger.current) ?? null,
    onDone: (video) => nav.navigate(path(`?edit=${video.id}`))
  })

  return (
    <>
      {visible && (
        <Popover
          open={open}
          onOpenChange={(o) => {
            setOpen(o)
            if (!o) setBusyNote(false)
          }}
        >
          <PopoverTrigger asChild>
            <button
              ref={trigger}
              type='button'
              aria-label={
                videos.length
                  ? `Videos for this screen (${videos.length}${unwatchedRequired ? `, ${unwatchedRequired} required` : ''})`
                  : 'Record a video for this screen'
              }
              title={videos.length ? 'Videos about this screen' : 'Record a video for this screen'}
              className={
                compact
                  ? `relative inline-flex h-8 w-8 items-center justify-center transition-colors hover:bg-accent hover:text-accent-foreground ${focusRing}`
                  : `relative inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12.5px] transition-colors hover:bg-muted ${focusRing}`
              }
              data-hv-button={videos.length}
            >
              <Video className='h-4 w-4' />
              {!compact && <span>Videos</span>}
              {unwatchedRequired > 0 && (
                <span
                  aria-hidden='true'
                  className='absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold text-white'
                  data-hv-required-badge
                >
                  {unwatchedRequired}
                </span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align='end' className='w-[340px] p-1.5 text-[13px]'>
            {videos.length === 0 && (
              <p className='px-2 py-1.5 text-muted-foreground'>
                No videos for this screen yet. Record one to show people how it works.
              </p>
            )}
            <ul>
              {videos.map((v) => {
                const p = progressLabel(v)
                const meta = listMeta(v)
                const waiting = isGettingReady(v)
                return (
                  <li key={v.id}>
                    <button
                      type='button'
                      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted ${focusRing}`}
                      onClick={() => {
                        setOpen(false)
                        setWatching(v.id)
                      }}
                      data-hv-pick={v.id}
                    >
                      {waiting ? (
                        <Clock className='h-4 w-4 shrink-0 text-muted-foreground' />
                      ) : p.done ? (
                        <CheckCircle2 className='h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400' />
                      ) : (
                        <PlayCircle className='h-4 w-4 shrink-0 text-[#2563eb] dark:text-sky-300' />
                      )}
                      <span className='min-w-0 flex-1'>
                        <span className='block truncate font-medium'>{v.title}</span>
                        <span
                          className={`block text-[12px] ${meta.overdue ? 'text-rose-700 dark:text-rose-300' : 'text-muted-foreground'}`}
                        >
                          {meta.text}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
            <div className='mt-1 flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-border px-2 pt-1.5'>
              <button
                type='button'
                className={`rounded text-[12px] text-muted-foreground hover:underline ${focusRing}`}
                onClick={() => {
                  setOpen(false)
                  nav.navigate(path())
                }}
              >
                All videos
              </button>
              {canAuthor && (
                <div className='ml-auto flex flex-col items-end'>
                  <button
                    type='button'
                    disabled={!recordable}
                    aria-describedby={recordable ? undefined : reasonId}
                    className={`rounded text-[12px] font-medium text-[#2563eb] hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline dark:text-sky-300 ${focusRing}`}
                    onClick={() => {
                      if (recorder.start({ contexts, from: trigger.current })) {
                        setBusyNote(false)
                        setOpen(false)
                      } else {
                        setBusyNote(true)
                      }
                    }}
                    data-hv-record-here
                  >
                    Record one for this screen
                  </button>
                  <button
                    type='button'
                    disabled={upload.busy}
                    className={`mt-0.5 rounded text-[12px] font-medium text-[#2563eb] hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline dark:text-sky-300 ${focusRing}`}
                    onClick={() => {
                      upload.pick()
                      setOpen(false)
                    }}
                    data-hv-upload-here
                  >
                    Upload a video
                  </button>
                  {!recordable && (
                    <p
                      id={reasonId}
                      className='mt-0.5 max-w-[220px] text-right text-[12px] text-muted-foreground'
                    >
                      {RECORD_UNSUPPORTED}
                    </p>
                  )}
                  {busyNote && recorder.active && (
                    <p
                      role='status'
                      className='mt-0.5 max-w-[220px] text-right text-[12px] text-rose-700 dark:text-rose-300'
                    >
                      {RECORDING_BUSY}
                    </p>
                  )}
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}
      <HelpVideoSheet
        videoId={watching}
        open={!!watching}
        onOpenChange={(o) => !o && setWatching(null)}
        upNext={videos}
        onPick={setWatching}
        returnFocusRef={trigger}
      />
      {recorder.fallback}
      {upload.ui}
    </>
  )
}
