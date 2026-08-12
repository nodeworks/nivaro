import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Loader2, RefreshCw, Satellite } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn, formatRelative } from '../../lib/utils'
import { Button } from '../ui/button'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'

interface ErpSubmission {
  id: number
  external_api: number | null
  external_ref: string | null
  status: string
  attempts: number
  last_error: string | null
  endpoint_path: string | null
  payload: unknown
  response: unknown
  created_at: string
  updated_at: string
}

function pretty(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    try {
      return JSON.stringify(JSON.parse(v), null, 2)
    } catch {
      return v
    }
  }
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

const STATUS_TONE: Record<string, string> = {
  accepted: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  failed: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  pending: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400',
  submitted: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400'
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide',
        STATUS_TONE[status] ?? 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-slate-300'
      )}
    >
      {status}
    </span>
  )
}

function RequestRow({
  sub,
  onRetry,
  retrying
}: {
  sub: ErpSubmission
  onRetry: (id: number) => void
  retrying: boolean
}) {
  const [open, setOpen] = useState(false)
  const payload = pretty(sub.payload)
  const response = pretty(sub.response)
  return (
    <div className='rounded-lg border border-slate-200 dark:border-border'>
      <button
        type='button'
        onClick={() => setOpen(!open)}
        className='flex w-full items-center gap-3 px-3 py-2 text-left'
      >
        <StatusPill status={sub.status} />
        <span className='min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate-600 dark:text-slate-300'>
          {sub.endpoint_path ?? '—'}
        </span>
        {sub.external_ref && (
          <span className='shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-600 dark:bg-muted dark:text-slate-300'>
            {sub.external_ref}
          </span>
        )}
        <span className='shrink-0 text-[11px] text-slate-400' title={new Date(sub.updated_at).toLocaleString()}>
          {formatRelative(sub.updated_at)}
        </span>
        {sub.attempts > 1 && (
          <span className='shrink-0 text-[10.5px] text-slate-400'>×{sub.attempts}</span>
        )}
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div className='space-y-2 border-t border-slate-100 px-3 py-2.5 dark:border-border'>
          <div className='grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] text-slate-500 dark:text-slate-400'>
            <span>Sent: {new Date(sub.created_at).toLocaleString()}</span>
            <span>Last update: {new Date(sub.updated_at).toLocaleString()}</span>
            <span>Attempts: {sub.attempts}</span>
            {sub.external_api != null && <span>External API #{sub.external_api}</span>}
          </div>
          {sub.last_error && (
            <p className='rounded bg-red-50 px-2 py-1.5 text-[11.5px] text-red-700 dark:bg-red-500/10 dark:text-red-400'>
              {sub.last_error}
            </p>
          )}
          {payload && (
            <div>
              <p className='mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>Request payload</p>
              <pre className='max-h-48 overflow-auto rounded bg-slate-50 p-2 font-mono text-[10.5px] leading-relaxed text-slate-700 dark:bg-black/20 dark:text-slate-300'>{payload}</pre>
            </div>
          )}
          <div>
            <p className='mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>Response</p>
            {response ? (
              <pre className='max-h-48 overflow-auto rounded bg-slate-50 p-2 font-mono text-[10.5px] leading-relaxed text-slate-700 dark:bg-black/20 dark:text-slate-300'>{response}</pre>
            ) : (
              <p className='text-[11.5px] italic text-slate-400'>No response body stored</p>
            )}
          </div>
          {sub.status === 'failed' && (
            <Button size='sm' variant='outline' disabled={retrying} onClick={() => onRetry(sub.id)}>
              {retrying ? <Loader2 className='h-3 w-3 animate-spin' /> : <RefreshCw className='h-3 w-3' />}
              <span className='ml-1.5'>Retry</span>
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Item-header chip summarizing every external (ERP) request this record has
 * sent — badge counts by outcome, click for the full request/response log.
 * Renders nothing when the record has no submissions. Shares the
 * ['erp-submissions', collection, item] cache with ErpFailureBanner, so
 * transition writebacks refresh both.
 */
export function ExternalRequestsChip({
  collection,
  itemId
}: {
  collection: string
  itemId: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const { data } = useQuery({
    queryKey: ['erp-submissions', collection, String(itemId)],
    queryFn: () =>
      client
        .request<{ data: ErpSubmission[] }>(
          get(`/erp-submissions/${collection}/${encodeURIComponent(itemId)}`)
        )
        .then((r) => r.data ?? []),
    enabled: !!collection && !!itemId,
    staleTime: 15_000,
    refetchInterval: 60_000
  })
  const retry = useMutation({
    mutationFn: (id: number) =>
      client.request<{ data: ErpSubmission }>(post(`/erp-submissions/${id}/retry`)),
    onSuccess: (res) => {
      const status = (res as { data?: ErpSubmission })?.data?.status
      if (status && status !== 'failed') toast.success('Submission retried successfully')
      else toast.error('Retry failed — expand the request for the error')
      void qc.invalidateQueries({ queryKey: ['erp-submissions', collection, String(itemId)] })
    },
    onError: () => toast.error('Retry failed')
  })

  const subs = data ?? []
  if (subs.length === 0) return null
  const ok = subs.filter((s) => s.status === 'accepted').length
  const failed = subs.filter((s) => s.status === 'failed').length
  const pending = subs.length - ok - failed

  return (
    <>
      <button
        type='button'
        onClick={() => setOpen(true)}
        data-nvr-external-requests
        className='flex shrink-0 items-center gap-1.5 self-center rounded-md border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-white/5'
        title='External requests sent for this record'
      >
        <Satellite className='h-3.5 w-3.5 text-nvr-cyan' />
        External requests
        {ok > 0 && (
          <span className='rounded bg-emerald-50 px-1 text-[10.5px] font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'>{ok}</span>
        )}
        {pending > 0 && (
          <span className='rounded bg-sky-50 px-1 text-[10.5px] font-semibold text-sky-700 dark:bg-sky-500/10 dark:text-sky-400'>{pending}</span>
        )}
        {failed > 0 && (
          <span className='rounded bg-red-50 px-1 text-[10.5px] font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-400'>{failed}</span>
        )}
      </button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent className='max-w-3xl p-5'>
            <DialogHeader>
              <DialogTitle className='flex items-center gap-2 text-[15px]'>
                <Satellite className='h-4 w-4 text-nvr-cyan' />
                External requests
                <span className='text-[12px] font-normal text-slate-400'>
                  {subs.length} request{subs.length !== 1 ? 's' : ''}
                </span>
              </DialogTitle>
            </DialogHeader>
            <DialogBody className='max-h-[65vh] space-y-2 overflow-y-auto'>
              {subs.map((s) => (
                <RequestRow key={s.id} sub={s} onRetry={(id) => retry.mutate(id)} retrying={retry.isPending} />
              ))}
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
