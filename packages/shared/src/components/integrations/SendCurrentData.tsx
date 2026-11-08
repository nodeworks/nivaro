import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Loader2, Send } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/** What the server says "Send current data" would send (GET …/fresh-preview). */
interface FreshPreview {
  available: boolean
  api?: string
  summary?: string
  detail?: string
}

/** The confirm's warning, in plain words (army 11, Rob: "just warn"). Pure, so
 *  the sentence is testable without a DOM. */
export function sendCurrentWarning(api: string, summary: string | null | undefined): string {
  const what = summary?.trim() ? ` (${summary.trim()})` : ''
  return `This sends the record's current data${what} to ${api} now — not the original request.`
}

/**
 * "Send current data" on an integration line: for a partner that was never
 * told, or whose stored request could be out of date, send what is true NOW.
 * The server rebuilds the request with the kind's own template and sends it
 * through the normal path (a new request in the log, the line moves with it).
 * Opens an anchored confirm that names exactly what will be sent before
 * anything goes out — the automatic sweep never does this, only this click.
 */
export function SendCurrentDataButton({
  obligationId,
  api,
  enabled = true,
  onSent,
  className
}: {
  obligationId: number
  api: string
  /** Remediation switch off → disabled with the reason in its tip. */
  enabled?: boolean
  onSent?: () => void
  className?: string
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)

  const preview = useQuery({
    queryKey: ['integration-obligations', 'fresh-preview', obligationId],
    queryFn: () =>
      client.request<{ data: FreshPreview }>(
        get(`/integration-obligations/${obligationId}/fresh-preview`)
      ),
    enabled: open,
    // Always rebuilt when the confirm opens: the point is the CURRENT data.
    staleTime: 0,
    gcTime: 0,
    retry: false
  })
  const p = preview.data?.data

  const send = useMutation({
    mutationFn: () =>
      client.request<{ data: { detail: string } }>(
        post(`/integration-obligations/${obligationId}/send`, { fresh: true })
      ),
    onSuccess: (res) => {
      toast.message(res?.data?.detail ?? `Sent to ${api}`)
      setOpen(false)
      onSent?.()
    },
    onError: (err) => {
      const resp = (err as { response?: { error?: string } })?.response
      toast.error(resp?.error ?? `Could not send to ${api}`, { duration: 8000 })
    }
  })

  return (
    <Popover open={open} onOpenChange={(o) => !send.isPending && setOpen(o)}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-obligation-send-current
          disabled={!enabled}
          data-tip={
            enabled
              ? `Send ${api} what the record says now`
              : 'Remediation is off for this deployment — an admin turns it on under Integrations › Remediation'
          }
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[10.5px] font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 disabled:opacity-60 dark:border-border dark:text-muted-foreground dark:hover:bg-muted',
            open &&
              'border-nvr-cyan bg-nvr-cyan/10 text-nvr-cyan dark:border-nvr-cyan dark:bg-nvr-cyan/15',
            className
          )}
        >
          <Send className='h-3 w-3' />
          Send current data
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-[320px] max-w-[calc(100vw-32px)] p-3 text-[12px]'
        onClick={(e) => e.stopPropagation()}
      >
        {preview.isLoading ? (
          <p className='flex items-center gap-2 text-slate-500 dark:text-muted-foreground'>
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
            Building the message from the current data…
          </p>
        ) : !p?.available ? (
          <p className='text-slate-600 dark:text-slate-300' data-send-current-refused>
            {p?.detail ?? (preview.isError ? 'Could not build the message.' : 'Nothing to send.')}
          </p>
        ) : (
          <div className='space-y-3'>
            <p
              className='flex gap-2 leading-5 text-slate-700 dark:text-slate-200'
              data-send-current-warning
            >
              <AlertTriangle
                aria-hidden
                className='mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400'
              />
              <span>{sendCurrentWarning(p.api ?? api, p.summary)}</span>
            </p>
            <div className='flex justify-end gap-2'>
              <button
                type='button'
                onClick={() => setOpen(false)}
                disabled={send.isPending}
                className='rounded-md px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-muted-foreground dark:hover:bg-muted'
              >
                Cancel
              </button>
              <button
                type='button'
                data-send-current-confirm
                onClick={() => send.mutate()}
                disabled={send.isPending}
                className='inline-flex items-center gap-1.5 rounded-md bg-nvr-cyan px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 focus-visible:ring-offset-1 disabled:opacity-60'
              >
                {send.isPending ? (
                  <Loader2 className='h-3 w-3 animate-spin' />
                ) : (
                  <Send className='h-3 w-3' />
                )}
                Send to {p.api ?? api}
              </button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
