import { Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'
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
import { ErrorNote } from '../recorder/RecorderStatus'

export type PurgeOutcome = { ok: true } | { ok: false; message: string }

const REMOVED = [
  'Every version of the video, drafts included',
  'The recording and the finished video files',
  'The record of who watched it',
  'Any required viewing people were given'
]

/**
 * The one confirmation before an administrator deletes an archived video for good.
 * Cancel holds the focus on open; a failure stays here as an inline note and the
 * button is off while the request runs, so it cannot be sent twice.
 */
export function PurgeVideoDialog({
  title,
  onConfirm,
  onClose,
  container,
  restoreFocus
}: {
  title: string
  /** Resolves when the request has finished; the parent decides what "gone" means. */
  onConfirm: () => Promise<PurgeOutcome>
  onClose: () => void
  container?: HTMLElement | null
  /** Where focus goes on a plain cancel. */
  restoreFocus: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const inflight = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    if (inflight.current) return
    inflight.current = true
    setPending(true)
    setError(null)
    const out = await onConfirm()
    inflight.current = false
    setPending(false)
    if (!out.ok) setError(out.message)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent
        role='alertdialog'
        container={container}
        hideClose={pending}
        className='w-[calc(100vw-2rem)] max-w-[480px] dark:bg-card'
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          cancelRef.current?.focus()
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          restoreFocus()
        }}
        data-hv-purge-dialog
      >
        <DialogHeader>
          <DialogTitle className='break-words pr-6 text-[16px] dark:text-foreground'>
            Delete “{title}” permanently?
          </DialogTitle>
          <DialogDescription className='text-[13px] text-muted-foreground'>
            This takes the video out of Nivaro for good and cannot be undone. It removes:
          </DialogDescription>
        </DialogHeader>
        <DialogBody className='space-y-3'>
          <ul className='list-disc space-y-1 pl-5 text-[13px] marker:text-muted-foreground'>
            {REMOVED.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className='text-[13px] text-muted-foreground'>
            To keep it but out of the way, leave it in the archive.
          </p>
          {error && <ErrorNote data-hv-purge-error>{error}</ErrorNote>}
        </DialogBody>
        <DialogFooter className='flex-wrap border-border'>
          <Button
            ref={cancelRef}
            variant='outline'
            onClick={onClose}
            disabled={pending}
            data-hv-purge-cancel
          >
            Cancel
          </Button>
          <Button
            variant='destructive'
            // The light destructive token is 3.8:1 under white text; red-700 clears 4.5:1.
            className='bg-red-700 hover:bg-red-800 dark:bg-destructive dark:hover:bg-destructive/90'
            onClick={() => void confirm()}
            disabled={pending}
            aria-busy={pending}
            data-hv-purge-confirm
          >
            {pending ? (
              <Loader2 className='h-4 w-4 animate-spin motion-reduce:animate-none' />
            ) : null}
            Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
