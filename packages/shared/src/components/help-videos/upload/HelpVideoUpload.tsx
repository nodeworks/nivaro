import { useQueryClient } from '@tanstack/react-query'
import { FileVideo, Loader2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useApiFetchConfig, useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import { helpVideoApi, helpVideoKeys } from '../api'
import { plainFailure } from '../recorder/failure'
import { ErrorNote, ghostBtn, primaryBtn, secondaryBtn } from '../recorder/RecorderStatus'
import { partSender } from '../recorder/sendPart'
import type { HelpVideoContext, HelpVideoDto } from '../types'
import {
  FileUploadError,
  type FileUploadProgress,
  isCancelled,
  phaseText,
  titleFromFile,
  uploadVideoFile,
  VIDEO_FILE_ACCEPT
} from './fileUpload'

type Stage = 'working' | 'creating' | 'error'

const mb = (n: number) =>
  n >= 1024 * 1024 * 1024
    ? `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
    : n >= 1024 * 1024 || n === 0
      ? `${(n / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(n / 1024))} KB`

/**
 * "Upload a video": pick an MP4, WebM or MOV made elsewhere. It goes through
 * the recorder's upload path (parts, finalize), the server checks it and, if
 * a browser could not play it, converts it; then a draft is created exactly
 * as for a recording and `onDone` opens the editor.
 *
 * Returns the hidden file input and the dialog to render OUTSIDE any popover
 * (a popover closing on the click must not take them with it), and `pick` for
 * the button that opens the file chooser.
 */
export function useHelpVideoUpload(opts: {
  contexts?: HelpVideoContext[]
  onDone: (video: HelpVideoDto) => void
  /** Mount the dialog inside this modal (a sheet makes outside unclickable). */
  host?: HTMLElement | null
}): { pick: () => void; busy: boolean; ui: ReactNode } {
  const input = useRef<HTMLInputElement | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const pick = useCallback(() => {
    if (input.current) {
      input.current.value = ''
      input.current.click()
    }
  }, [])
  const ui = (
    <>
      <input
        ref={input}
        type='file'
        accept={VIDEO_FILE_ACCEPT}
        className='hidden'
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) setFile(f)
        }}
        data-hv-upload-input
      />
      {file && (
        <HelpVideoUploadDialog
          key={`${file.name}:${file.size}:${file.lastModified}`}
          file={file}
          contexts={opts.contexts}
          host={opts.host}
          onPickAnother={() => {
            setFile(null)
            pick()
          }}
          onClose={() => setFile(null)}
          onDone={(video) => {
            setFile(null)
            opts.onDone(video)
          }}
        />
      )}
    </>
  )
  return { pick, busy: !!file, ui }
}

function HelpVideoUploadDialog({
  file,
  contexts,
  host,
  onClose,
  onDone,
  onPickAnother
}: {
  file: File
  contexts?: HelpVideoContext[]
  host?: HTMLElement | null
  onClose: () => void
  onDone: (video: HelpVideoDto) => void
  onPickAnother: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const send = partSender(useApiFetchConfig())
  const [stage, setStage] = useState<Stage>('working')
  const [progress, setProgress] = useState<FileUploadProgress>({
    stage: 'uploading',
    sent: 0,
    total: file.size
  })
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null)
  const uploadId = useRef<string | null>(null)
  const finalized = useRef<string | null>(null)
  const ctl = useRef<AbortController | null>(null)
  const done = useRef(false)

  const latest = useRef({ contexts, onDone })
  latest.current = { contexts, onDone }

  // `send` is a fresh function every render; a run keeps the one it started with.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const run = useCallback(async () => {
    const api = helpVideoApi(client)
    const c = new AbortController()
    ctl.current = c
    setError(null)
    setStage('working')
    try {
      if (!finalized.current) {
        finalized.current = await uploadVideoFile({ api, send }, file, {
          signal: c.signal,
          onProgress: (p) => !c.signal.aborted && setProgress(p),
          onUploadId: (id) => {
            uploadId.current = id
          }
        })
      }
      if (c.signal.aborted) return
      setStage('creating')
      const video = await api.create({
        upload_id: finalized.current,
        title: titleFromFile(file.name),
        contexts: latest.current.contexts
      })
      done.current = true
      void qc.invalidateQueries({ queryKey: helpVideoKeys.all })
      latest.current.onDone(video)
    } catch (err) {
      if (c.signal.aborted || isCancelled(err)) return
      setError(
        err instanceof FileUploadError
          ? { message: err.message, retryable: err.retryable }
          : plainFailure(err)
      )
      setStage('error')
    }
  }, [client, file, qc])

  // Starts once per picked file (the hook keys this dialog by the file).
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    void run()
    return () => ctl.current?.abort()
  }, [])

  /** Stops whatever is running and discards the upload (open, converting or
   *  kept-but-not-yet-a-video). */
  const cancel = () => {
    ctl.current?.abort()
    const id = uploadId.current
    if (id && !done.current) {
      void helpVideoApi(client)
        .abandonUpload(id)
        .catch(() => null)
    }
    onClose()
  }

  const pct =
    progress.stage === 'uploading'
      ? Math.floor((progress.sent / Math.max(1, progress.total)) * 100)
      : progress.progress
  const status =
    stage === 'creating'
      ? 'Opening the editor'
      : progress.stage === 'uploading'
        ? `Uploading · ${pct}%`
        : phaseText(progress.phase, progress.progress)
  const detail =
    stage === 'creating'
      ? 'The draft is ready to edit.'
      : progress.stage === 'uploading'
        ? `${mb(progress.sent)} of ${mb(progress.total)} sent. Keep this page open until it finishes.`
        : progress.phase === 'converting'
          ? 'This video uses a format some browsers cannot play, so it is being converted. A long video takes a few minutes.'
          : 'Making sure the file is a video this page can play.'

  return (
    <Dialog open onOpenChange={(o) => !o && cancel()}>
      <DialogContent
        className='w-[calc(100vw-2rem)] max-w-[520px] font-sans dark:bg-card'
        container={host}
        data-hv-upload-dialog
        data-hv-upload-stage={stage === 'working' ? progress.stage : stage}
      >
        <DialogHeader className='pr-12'>
          <DialogTitle className='text-[16px] text-foreground'>Upload a video</DialogTitle>
          <DialogDescription className='text-[13px] text-muted-foreground'>
            An MP4, WebM or MOV up to 30 minutes and 1.2 GB.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className='space-y-3 text-[13px]'>
          <div className='flex items-center gap-2.5 rounded-lg border border-border px-3 py-2'>
            <FileVideo className='h-4 w-4 shrink-0 text-muted-foreground' aria-hidden />
            <span className='min-w-0 flex-1 truncate font-medium text-foreground'>{file.name}</span>
            <span className='shrink-0 tabular-nums text-muted-foreground'>{mb(file.size)}</span>
          </div>
          {stage === 'error' && error ? (
            <ErrorNote data-hv-upload-error>{error.message}</ErrorNote>
          ) : (
            <div role='status' className='space-y-2' data-hv-upload-status>
              <div className='flex items-center gap-2'>
                <Loader2 className='h-4 w-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none' />
                <p className='font-medium text-foreground'>{status}</p>
              </div>
              <div
                role='progressbar'
                aria-label='Upload progress'
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct ?? undefined}
                className='h-1.5 overflow-hidden rounded-full bg-muted'
                data-hv-upload-progress={pct ?? ''}
              >
                <div
                  className={`h-full rounded-full bg-nvr-cyan transition-[width] duration-300 motion-reduce:transition-none ${pct == null ? 'w-1/3 animate-pulse' : ''}`}
                  style={pct == null ? undefined : { width: `${pct}%` }}
                />
              </div>
              <p className='text-muted-foreground'>{detail}</p>
            </div>
          )}
        </DialogBody>
        <DialogFooter className='border-border'>
          {stage === 'error' ? (
            <>
              <Button variant='ghost' className={ghostBtn} onClick={cancel} data-hv-upload-close>
                Close
              </Button>
              <Button
                variant='outline'
                className={secondaryBtn}
                onClick={() => {
                  cancel()
                  onPickAnother()
                }}
                data-hv-upload-another
              >
                Choose another file
              </Button>
              {error?.retryable && (
                <Button className={primaryBtn} onClick={() => void run()} data-hv-upload-retry>
                  Try again
                </Button>
              )}
            </>
          ) : (
            <Button
              variant='outline'
              className={secondaryBtn}
              onClick={cancel}
              disabled={stage === 'creating'}
              data-hv-upload-cancel
            >
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
