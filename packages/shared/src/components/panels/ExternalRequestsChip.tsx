import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Satellite } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn, formatRelative } from '../../lib/utils'
import { type ErpSubmission, SubmissionRow } from '../integrations/console/SubmissionRow'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'

/**
 * Item-header chip summarizing every external (ERP) request this record has
 * sent — badge counts by outcome, click for the full request/response log
 * (each request drills into every attempt). Always renders: a skeleton while
 * loading, a quiet 'No external requests' when nothing was sent. Shares the
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
  const { data, isLoading } = useQuery({
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
      void qc.invalidateQueries({ queryKey: ['erp-submission-attempts'] })
      // Same server-side sync as ErpFailureBanner's retry — the submission's
      // linked obligation moves right away (propagateSubmissionStatus), so
      // IntegrationStatusBanner needs to hear about it too.
      void qc.invalidateQueries({
        queryKey: ['integration-obligations', 'record', collection, String(itemId)]
      })
    },
    onError: () => toast.error('Retry failed')
  })

  const subs = data ?? []
  if (isLoading) {
    return (
      <span
        className='flex shrink-0 items-center gap-1.5 self-center rounded-md border border-slate-200 px-2 py-1 text-[11px] text-slate-400 dark:border-border'
        data-nvr-external-requests='loading'
      >
        <Satellite className='h-3.5 w-3.5 opacity-60' />
        <span className='h-2.5 w-16 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
      </span>
    )
  }
  if (subs.length === 0) {
    return (
      <span
        className='flex shrink-0 items-center gap-1.5 self-center rounded-md border border-dashed border-slate-200 px-2 py-1 text-[11px] text-slate-500 dark:border-border dark:text-slate-400'
        data-nvr-external-requests='none'
        data-tip='Nothing from this record has been sent to an outside system yet. Every push to a connected system will be listed here.'
      >
        <Satellite className='h-3.5 w-3.5 opacity-60' />
        No external requests
      </span>
    )
  }
  const ok = subs.filter((s) => s.status === 'accepted').length
  const failed = subs.filter((s) => s.status === 'failed').length
  const pending = subs.length - ok - failed
  // #30 — one pill per integration: the LATEST push's status for this record
  // (rows arrive newest first), so a header reads "MWF ✓ · Fusion ✕" at a glance.
  const perIntegration = new Map<string, ErpSubmission>()
  for (const s of subs) {
    const key = s.external_api_name ?? (s.external_api != null ? `#${s.external_api}` : 'External')
    if (!perIntegration.has(key)) perIntegration.set(key, s)
  }
  const tone = (status: string) =>
    status === 'accepted'
      ? 'bg-emerald-500'
      : status === 'failed' || status === 'rejected'
        ? 'bg-red-500'
        : 'bg-sky-500'

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
        {perIntegration.size <= 3 ? (
          [...perIntegration.entries()].map(([name, s]) => (
            <span
              key={name}
              className='inline-flex items-center gap-1'
              data-integration-chip={name}
              data-integration-status={s.status}
              data-tip={`${name} · ${s.status} · ${formatRelative(s.updated_at ?? s.created_at)}${s.last_error ? ` — ${s.last_error.slice(0, 120)}` : ''}`}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', tone(s.status))} />
              {name}
            </span>
          ))
        ) : (
          <>
            External requests
            {ok > 0 && (
              <span className='rounded bg-emerald-50 px-1 text-[10.5px] font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'>
                {ok}
              </span>
            )}
            {pending > 0 && (
              <span className='rounded bg-sky-50 px-1 text-[10.5px] font-semibold text-sky-700 dark:bg-sky-500/10 dark:text-sky-400'>
                {pending}
              </span>
            )}
            {failed > 0 && (
              <span className='rounded bg-red-50 px-1 text-[10.5px] font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-400'>
                {failed}
              </span>
            )}
          </>
        )}
      </button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent className='p-5' style={{ width: '75%', maxWidth: '75%' }}>
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
                <SubmissionRow
                  key={s.id}
                  sub={s}
                  onRetry={(id) => retry.mutate(id)}
                  retrying={retry.isPending}
                />
              ))}
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
