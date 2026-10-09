import { CircleCheck, Loader2, MonitorX, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '../../ui/button'
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import type { Failure } from './failure'
import { sentence } from './failure'

// The recorder's dialog views other than setup: saving, done, limit, error
// and unsupported, plus the pieces setup shares with them.

export const LIMIT_SENTENCE =
  'Recordings can be up to 30 minutes, so recording stopped at 30:00 and everything you recorded was saved.'

/** Shown on Record buttons a browser cannot honour (phones, tablets, old browsers). */
export const RECORD_UNSUPPORTED = 'Recording needs a desktop browser that can share the screen'

/** When parts can only be kept in memory (no IndexedDB). */
export const NO_BACKUP_SENTENCE =
  "This browser can't keep a backup copy, so keep this tab open until saving finishes."

export const primaryBtn =
  'h-9 bg-nvr-cyan px-4 text-[13px] font-semibold text-nvr-navy hover:bg-nvr-cyan-dark focus-visible:ring-nvr-cyan dark:focus-visible:ring-offset-card'
// rose-600: white text clears 4.5:1 (the destructive token's red-500 does not).
export const dangerBtn =
  'h-9 bg-rose-600 px-4 text-[13px] text-white hover:bg-rose-700 dark:focus-visible:ring-offset-card'
export const secondaryBtn =
  'h-9 border-border bg-transparent px-4 text-[13px] text-foreground hover:bg-muted dark:focus-visible:ring-offset-card'
export const ghostBtn =
  'h-9 px-3 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground dark:focus-visible:ring-offset-card'

const titleCls = 'text-[16px] text-foreground'
const descCls = 'text-[13px] text-muted-foreground'

/** The one red notice used by every recorder view. */
export function ErrorNote({
  children,
  ...rest
}: { children: ReactNode } & Record<`data-${string}`, unknown>) {
  return (
    <p
      role='alert'
      className='flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[13px] text-rose-900 dark:border-rose-400/30 dark:bg-rose-400/10 dark:text-rose-100'
      {...rest}
    >
      <TriangleAlert className='mt-0.5 h-4 w-4 shrink-0' />
      <span>{children}</span>
    </p>
  )
}

/** "Discard …" that asks once, inline: "Discard it for good?  Keep it  Discard". */
export function ConfirmDiscard({
  confirming,
  busy,
  label,
  onAsk,
  onCancel,
  onConfirm,
  compact,
  askClassName
}: {
  confirming: boolean
  busy?: boolean
  label: string
  onAsk: () => void
  onCancel: () => void
  onConfirm: () => void
  /** Row size (h-8) for lists. */
  compact?: boolean
  askClassName?: string
}) {
  const size = compact ? 'h-8 px-2.5 text-[12.5px]' : ''
  if (!confirming) {
    return (
      <Button
        variant='ghost'
        className={`${ghostBtn} ${size} ${askClassName ?? ''}`}
        disabled={busy}
        onClick={onAsk}
        data-hv-discard
      >
        {label}
      </Button>
    )
  }
  return (
    <span className='flex flex-wrap items-center gap-2 text-[13px]'>
      <span className='text-foreground'>Discard it for good?</span>
      <Button variant='ghost' className={`${ghostBtn} ${size}`} onClick={onCancel}>
        Keep it
      </Button>
      <Button
        variant='destructive'
        className={`${dangerBtn} ${size}`}
        disabled={busy}
        onClick={onConfirm}
        data-hv-discard-confirm
      >
        Discard
      </Button>
    </span>
  )
}

export function UnsupportedView({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <>
      <DialogHeader className='pr-12'>
        <DialogTitle className={titleCls}>{title}</DialogTitle>
        <DialogDescription className='sr-only'>{RECORD_UNSUPPORTED}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className='flex items-start gap-3' data-hv-unsupported>
          <span className='flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground'>
            <MonitorX className='h-4 w-4' />
          </span>
          <div className='text-[13px] leading-relaxed'>
            <p className='font-medium text-foreground'>{sentence(RECORD_UNSUPPORTED)}</p>
            <p className='mt-1 text-muted-foreground'>
              Open this page on a computer in Chrome, Edge, Firefox or Safari to record a tutorial.
            </p>
          </div>
        </div>
      </DialogBody>
      <DialogFooter className='border-border'>
        <Button variant='outline' className={secondaryBtn} onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  )
}

export function SavingView({
  autoStopped,
  phase,
  pending,
  retrying,
  durable
}: {
  autoStopped: boolean
  phase: 'upload' | 'finish'
  pending: number
  retrying: boolean
  /** False when parts live only in memory. */
  durable: boolean
}) {
  return (
    <>
      <DialogHeader className='pr-12'>
        <DialogTitle className={titleCls}>Saving your recording</DialogTitle>
        <DialogDescription className={descCls}>
          Keep this page open until it finishes.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className='space-y-3 text-[13px]'>
        {autoStopped && (
          <p
            className='rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-amber-950 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100'
            data-hv-limit-note
          >
            {LIMIT_SENTENCE}
          </p>
        )}
        <div
          role='status'
          className='flex items-start gap-3 rounded-lg bg-muted/70 px-3.5 py-3'
          data-hv-saving
        >
          <Loader2 className='mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none' />
          <div>
            <p className='font-medium text-foreground'>
              {phase === 'finish'
                ? 'Preparing the video'
                : pending > 1
                  ? `Uploading the last ${pending} parts of your recording`
                  : 'Uploading the end of your recording'}
            </p>
            <p className='mt-0.5 text-muted-foreground' data-hv-saving-note>
              {phase === 'finish'
                ? 'This takes a few seconds for a long recording.'
                : !durable
                  ? retrying
                    ? `The connection dropped, so it is trying again. ${NO_BACKUP_SENTENCE}`
                    : NO_BACKUP_SENTENCE
                  : retrying
                    ? 'The connection dropped, so it is trying again. Your recording is safe in this browser.'
                    : 'Every part is kept in this browser until the server has it.'}
            </p>
          </div>
        </div>
      </DialogBody>
    </>
  )
}

/** Saved: the video exists and has been handed to the page. */
export function DoneView({ onClose }: { onClose: () => void }) {
  return (
    <>
      <DialogHeader className='pr-12'>
        <DialogTitle className={titleCls}>Your recording is saved</DialogTitle>
        <DialogDescription className='sr-only'>
          Your recording is saved and ready to edit.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className='flex items-start gap-3 text-[13px]' data-hv-done>
          <CircleCheck className='mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400' />
          <p className='leading-relaxed text-foreground'>
            It is ready to edit. You can trim it, add notes and captions, then publish it.
          </p>
        </div>
      </DialogBody>
      <DialogFooter className='border-border'>
        <Button variant='outline' className={secondaryBtn} onClick={onClose} data-hv-close>
          Close
        </Button>
      </DialogFooter>
    </>
  )
}

export function LimitView({ onOpen }: { onOpen: () => void }) {
  return (
    <>
      <DialogHeader className='pr-12'>
        <DialogTitle className={titleCls}>Your recording is saved</DialogTitle>
        <DialogDescription className='sr-only'>{LIMIT_SENTENCE}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className='flex items-start gap-3 text-[13px]' data-hv-limit>
          <CircleCheck className='mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400' />
          <p className='leading-relaxed text-foreground'>{LIMIT_SENTENCE}</p>
        </div>
      </DialogBody>
      <DialogFooter className='border-border'>
        <Button className={primaryBtn} onClick={onOpen} data-hv-open-video>
          Open the video
        </Button>
      </DialogFooter>
    </>
  )
}

/** What the error view says after the server's own sentence, by case. */
function errorCopy(
  failure: Failure,
  durable: boolean
): { title: string; desc: string; next: string } {
  const kept = durable
    ? 'Everything you recorded is kept in this browser until you discard it.'
    : 'What you recorded is kept only while this tab stays open.'
  if (failure.partial) {
    return {
      title: 'The end of your recording was lost',
      desc: 'The server has the start of it, but the rest never reached it.',
      next: 'Keep the part the server has, or discard the recording.'
    }
  }
  if (failure.closed) {
    return {
      title: 'This recording can no longer be saved',
      desc: 'The server no longer accepts parts for it.',
      next: 'Discard removes the copy kept in this browser.'
    }
  }
  if (failure.retryable) {
    return {
      title: 'Your recording was not saved',
      desc: kept,
      next: 'Try again now, or close this and use Record later to keep it.'
    }
  }
  return {
    title: 'Your recording was not saved',
    desc: kept,
    next: 'Use Record later to keep what was saved so far, or discard it.'
  }
}

export function ErrorView({
  failure,
  durable,
  confirming,
  onAskDiscard,
  onCancelDiscard,
  onDiscard,
  onClose,
  onRetry,
  onKeepPartial
}: {
  failure: Failure
  durable: boolean
  confirming: boolean
  onAskDiscard: () => void
  onCancelDiscard: () => void
  onDiscard: () => void
  onClose: () => void
  onRetry: () => void
  onKeepPartial: () => void
}) {
  const copy = errorCopy(failure, durable)
  return (
    <>
      <DialogHeader className='pr-12'>
        <DialogTitle className={titleCls}>{copy.title}</DialogTitle>
        <DialogDescription className={descCls}>{copy.desc}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <ErrorNote data-hv-error>{failure.message}</ErrorNote>
        <p className='mt-3 text-[13px] text-muted-foreground' data-hv-error-next>
          {copy.next}
        </p>
      </DialogBody>
      <DialogFooter className='flex-wrap border-border'>
        <span className='mr-auto'>
          <ConfirmDiscard
            confirming={confirming}
            label='Discard recording'
            askClassName='text-rose-700 hover:text-rose-800 dark:text-rose-300 dark:hover:text-rose-200'
            onAsk={onAskDiscard}
            onCancel={onCancelDiscard}
            onConfirm={onDiscard}
          />
        </span>
        {!confirming && (
          <>
            <Button variant='outline' className={secondaryBtn} onClick={onClose}>
              Close
            </Button>
            {failure.partial ? (
              <Button className={primaryBtn} onClick={onKeepPartial} data-hv-keep-partial>
                Keep what was saved
              </Button>
            ) : (
              failure.retryable &&
              !failure.closed && (
                <Button className={primaryBtn} onClick={onRetry} data-hv-retry>
                  Try again
                </Button>
              )
            )}
          </>
        )}
      </DialogFooter>
    </>
  )
}
