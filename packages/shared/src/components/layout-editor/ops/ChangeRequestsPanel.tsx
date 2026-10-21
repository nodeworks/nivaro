import { useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { cn, formatRelative } from '../../../lib/utils'
import { useLayoutEditorHost } from '../host'
import { apiFailure } from '../overview/overview-api'
import { type ChangeRequest, opsKeys, resolveChangeRequest, useChangeRequests } from './ops-api'

/**
 * Form change suggestions (#2609) for one layout, in the editor: what people
 * asked for from record pages, oldest work first. Accept or Decline closes the
 * request with an optional note, which the requester gets as a notification
 * and reads under My requests. Suggestions that name another form (or none)
 * are listed below, so nothing about this collection is hidden.
 */

const btn =
  'inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'

export function ChangeRequestsPanel({
  collection,
  layoutId,
  className
}: {
  collection: string
  layoutId: number
  className?: string
}) {
  const { data, isLoading, isError } = useChangeRequests(collection)
  const here = (data ?? []).filter((r) => r.layout_id === layoutId)
  const elsewhere = (data ?? []).filter((r) => r.layout_id !== layoutId)
  return (
    <div className={cn('space-y-2', className)} data-change-requests={layoutId}>
      {isLoading ? (
        <Loader2 className='h-3.5 w-3.5 animate-spin text-slate-400' />
      ) : isError ? (
        <p className='text-[12px] text-red-600 dark:text-red-400'>
          Could not read the suggestions.
        </p>
      ) : here.length === 0 && elsewhere.length === 0 ? (
        <p
          className='text-[12px] text-slate-500 dark:text-muted-foreground'
          data-change-requests-empty
        >
          No open suggestions. People send them from a record’s More menu → Suggest a form change.
        </p>
      ) : (
        <>
          {here.length === 0 && (
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              None about this form.
            </p>
          )}
          {here.map((r) => (
            <RequestCard key={r.id} r={r} collection={collection} />
          ))}
          {elsewhere.length > 0 && (
            <details className='group'>
              <summary className='cursor-pointer text-[12px] font-medium text-slate-600 dark:text-muted-foreground'>
                {elsewhere.length} about other forms of this collection
              </summary>
              <div className='mt-1.5 space-y-2'>
                {elsewhere.map((r) => (
                  <RequestCard key={r.id} r={r} collection={collection} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  )
}

function RequestCard({ r, collection }: { r: ChangeRequest; collection: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const host = useLayoutEditorHost()
  const [deciding, setDeciding] = useState<'accept' | 'decline' | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const resolve = async () => {
    if (!deciding) return
    setBusy(true)
    try {
      await resolveChangeRequest(client, r.id, deciding, note.trim())
      toast.success(
        deciding === 'accept' ? 'Marked done — they were told' : 'Declined — they were told'
      )
      void qc.invalidateQueries({ queryKey: opsKeys.requests(collection) })
      void qc.invalidateQueries({ queryKey: ['support-tickets'] })
    } catch (err) {
      toast.error(apiFailure(err, 'Could not close the suggestion').message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className='rounded-md border border-slate-200 bg-white p-2.5 text-[12.5px] dark:border-border dark:bg-card'
      data-change-request={r.id}
    >
      <p className='whitespace-pre-wrap break-words text-slate-800 dark:text-foreground'>
        {r.message || r.title}
      </p>
      <div className='mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        {r.field && (
          <span className='rounded bg-slate-100 px-1.5 py-px text-slate-700 dark:bg-white/10 dark:text-foreground'>
            {r.field_label ?? r.field}
          </span>
        )}
        {r.layout_name && r.layout_id != null && <span>on “{r.layout_name}”</span>}
        <span>{r.requester_name ?? 'Someone'}</span>
        {r.created_at && <span>{formatRelative(r.created_at)}</span>}
        <a
          href={host.recordLink(collection, r.item)}
          target='_blank'
          rel='noreferrer'
          className='inline-flex items-center gap-0.5 text-[#0089ad] hover:underline dark:text-nvr-cyan'
        >
          {r.record_label}
          <ExternalLink className='h-3 w-3' />
        </a>
      </div>
      {deciding ? (
        <div className='mt-2 space-y-1.5'>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder={deciding === 'accept' ? 'Optional: what changed' : 'Optional: why not'}
            aria-label='Note to the requester'
            className='w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12.5px] text-slate-900 outline-none focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-foreground'
          />
          <div className='flex gap-1.5'>
            <button
              type='button'
              className={cn(
                btn,
                deciding === 'accept'
                  ? 'border-nvr-cyan/60 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                  : 'border-red-200 text-red-700 dark:border-red-500/40 dark:text-red-300'
              )}
              disabled={busy}
              onClick={() => void resolve()}
              data-change-request-confirm={deciding}
            >
              {busy && <Loader2 className='h-3 w-3 animate-spin' />}
              {deciding === 'accept' ? 'Mark done and tell them' : 'Decline and tell them'}
            </button>
            <button type='button' className={btn} onClick={() => setDeciding(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className='mt-2 flex gap-1.5'>
          <button
            type='button'
            className={btn}
            onClick={() => setDeciding('accept')}
            data-change-request-accept={r.id}
          >
            Accept
          </button>
          <button
            type='button'
            className={btn}
            onClick={() => setDeciding('decline')}
            data-change-request-decline={r.id}
          >
            Decline
          </button>
        </div>
      )}
    </div>
  )
}
