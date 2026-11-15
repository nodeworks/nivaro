import { useMutation } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useItemEditAuth, useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import type { SendViewInput } from '../../lib/send-view'
import { cn } from '../../lib/utils'
import { AsyncUserPicker } from '../panels/AsyncUserPicker'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * "Send my view" — hand a colleague the screen you are on (this record, or this list / queue
 * with its filters, sort and columns). They open it as themselves: what they may read decides
 * what they see. Nothing of the records travels, only where to go and how the view is set up.
 */
export function SendViewButton({
  getView,
  describe,
  compact,
  className
}: {
  /** Read at send time, so the latest filters go. */
  getView: () => SendViewInput
  /** What the person is about to send, in words ("Workflows — 2 filters"). */
  describe?: () => string
  /** Icon-only, borderless — the record header's tool group. */
  compact?: boolean
  className?: string
}) {
  const client = useNivaroClient()
  const { userId } = useItemEditAuth()
  const [open, setOpen] = useState(false)
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')
  const [what, setWhat] = useState('')

  const send = useMutation({
    mutationFn: () =>
      client.request<{ data: { id: string; mode: 'live' | 'notification' } }>(
        post('/send-view', { to, view: getView(), note: note.trim() || undefined })
      ),
    onSuccess: (r) => {
      toast.success(
        r.data?.mode === 'live' ? 'Sent' : 'Sent — it is waiting in their notifications'
      )
      setOpen(false)
      setTo('')
      setNote('')
    },
    onError: (err) => toastError(err, 'Could not send your view')
  })

  const self = !!to && !!userId && to.toUpperCase() === userId.toUpperCase()

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (v) setWhat(describe?.() ?? '')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label='Send my view to someone'
          data-tip='Send my view to someone'
          data-send-view=''
          className={cn(
            compact
              ? 'inline-flex h-8 w-8 items-center justify-center transition-colors hover:bg-accent hover:text-accent-foreground'
              : 'flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200',
            className
          )}
        >
          <Send className='h-4 w-4' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        sideOffset={6}
        className='w-[min(20rem,calc(100vw-2rem))] p-3'
        data-send-view-panel=''
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (to && !self && !send.isPending) send.mutate()
          }}
          className='space-y-2.5'
        >
          <div>
            <p className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
              Send my view
            </p>
            {what && (
              <p
                className='mt-0.5 truncate text-[12px] text-slate-500 dark:text-slate-400'
                title={what}
              >
                {what}
              </p>
            )}
          </div>
          <AsyncUserPicker value={to} onChange={setTo} />
          {self && (
            <p className='text-[11.5px] text-amber-700 dark:text-amber-300'>
              Choose someone other than yourself.
            </p>
          )}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 280))}
            rows={2}
            placeholder='Add a note (optional)'
            aria-label='Note'
            className='block w-full resize-none rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12.5px] text-slate-700 placeholder-slate-400 focus:border-nvr-cyan/60 focus:outline-none focus:ring-1 focus:ring-nvr-cyan/40 dark:border-border dark:bg-background dark:text-slate-200'
          />
          <p className='text-[11px] leading-snug text-slate-500 dark:text-slate-400'>
            They’ll see this screen with their own access. Nothing they can’t already see is shared.
          </p>
          <div className='flex justify-end gap-2'>
            <button
              type='button'
              onClick={() => setOpen(false)}
              className='h-8 rounded-md px-3 text-[12.5px] font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-muted'
            >
              Cancel
            </button>
            <button
              type='submit'
              disabled={!to || self || send.isPending}
              data-send-view-submit=''
              className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-white hover:bg-nvr-cyan/90 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 dark:disabled:bg-slate-700 dark:disabled:text-slate-400'
            >
              <Send className='h-3.5 w-3.5' />
              {send.isPending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
