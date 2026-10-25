import { type ReactNode, useCallback, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

/** Whether a transition needs a note (Send Back, Cancel): the server refuses
 *  it without one (422 TRANSITION_COMMENT_REQUIRED). */
export function needsTransitionNote(t: { comment_mode?: string | null } | null | undefined) {
  return t?.comment_mode === 'required'
}

/**
 * Asks for the note a worklist move needs (board drag, bulk "Transition ▸"),
 * once per move: a bulk run over many rows shares one answer for each
 * transition label. `ask` resolves with the note, or null when cancelled.
 */
export function useTransitionNote(): {
  ask: (label: string) => Promise<string | null>
  /** Start / end a bulk run: within it, one note per transition label. */
  beginBatch: () => void
  endBatch: () => void
  dialog: ReactNode
} {
  const [pending, setPending] = useState<{
    label: string
    resolve: (v: string | null) => void
  } | null>(null)
  const [text, setText] = useState('')
  const batchRef = useRef<Map<string, Promise<string | null>> | null>(null)

  // One dialog at a time: asks made together (rows of a bulk run with
  // different transitions) wait their turn instead of replacing each other.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve())
  const askOnce = useCallback((label: string) => {
    const next = chainRef.current.then(
      () =>
        new Promise<string | null>((resolve) => {
          setText('')
          setPending({ label, resolve })
        })
    )
    chainRef.current = next.catch(() => null)
    return next
  }, [])
  const ask = useCallback(
    (label: string) => {
      const batch = batchRef.current
      if (!batch) return askOnce(label)
      const known = batch.get(label)
      if (known) return known
      const p = askOnce(label)
      batch.set(label, p)
      return p
    },
    [askOnce]
  )
  const finish = (value: string | null) => {
    pending?.resolve(value)
    setPending(null)
  }

  const dialog = (
    <Dialog open={!!pending} onOpenChange={(open) => !open && finish(null)}>
      <DialogContent className='max-w-md dark:bg-card' data-transition-note>
        <DialogHeader className='px-6 pt-5'>
          <DialogTitle className='text-[15px] font-semibold'>
            {pending?.label ?? 'Move'}
          </DialogTitle>
          <DialogDescription className='text-[12.5px]'>
            This move needs a note — it is kept on the record’s history.
          </DialogDescription>
        </DialogHeader>
        <form
          className='space-y-3 px-6 pb-5'
          onSubmit={(e) => {
            e.preventDefault()
            if (text.trim()) finish(text.trim())
          }}
        >
          <textarea
            autoFocus
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='Why is it moving?'
            aria-label='Note'
            className='w-full resize-none rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[13px] outline-none focus:border-nvr-cyan/60 dark:border-border dark:bg-background dark:text-slate-100'
          />
          <DialogFooter className='gap-2'>
            <button
              type='button'
              onClick={() => finish(null)}
              className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
            >
              Cancel
            </button>
            <button
              type='submit'
              disabled={!text.trim()}
              className='h-8 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-white disabled:opacity-50'
            >
              Move
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )

  return {
    ask,
    beginBatch: () => {
      batchRef.current = new Map()
    },
    endBatch: () => {
      batchRef.current = null
    },
    dialog
  }
}
