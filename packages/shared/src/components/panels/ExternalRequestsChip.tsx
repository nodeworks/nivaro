import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Satellite } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { integrationChipSummary } from '../../lib/integration-chip'
import { cn, formatRelative } from '../../lib/utils'
import { type ErpSubmission, SubmissionRow } from '../integrations/console/SubmissionRow'
import {
  IntegrationStatusLines,
  useRecordObligations
} from '../integrations/IntegrationStatusBanner'
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { RecordEventPathSheet } from './IntegrationActivitySection'

/**
 * Item-header "Integrations" chip: one dot per partner (was it told —
 * obligations — else the newest request's outcome), a green badge for
 * partners told OK and a red badge for what a person must act on (a partner
 * not told, a failed send). Click for the popup: the partner-status lines
 * (told / never told / send now — the rows the record body used to carry
 * as a banner; Rob 2026-09-24: "move the integration slot into the
 * Integrations button popup") above the full request/response log (each
 * request drills into every attempt). Always renders: a skeleton while
 * loading, a quiet 'No external requests' when there is nothing to say.
 * Shares the ['erp-submissions', …] and ['integration-obligations','record',…]
 * caches, so transition writebacks and retries refresh it.
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
  // The push whose full path is showing. The sheet opens only after the
  // dialog closes, so two modals never stack.
  const [pathId, setPathId] = useState<number | null>(null)
  // The request a partner line asked to see: that row mounts open and
  // scrolls into view.
  const [focusId, setFocusId] = useState<number | null>(null)
  useEffect(() => {
    if (!open || focusId == null) return
    const el = document.querySelector(`[data-submission-id="${focusId}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [open, focusId])
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

  const {
    lines,
    remediationEnabled,
    isLoading: linesLoading
  } = useRecordObligations(collection, itemId)

  const subs = data ?? []
  if (isLoading || linesLoading) {
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
  const summary = integrationChipSummary(lines, subs, (iso) => (iso ? formatRelative(iso) : ''))
  // Newest request per partner (rows arrive newest first) — what a partner
  // line's Retry / View act on when the obligation has no submission of its own.
  const newestSubmissionByApi = new Map<string, { id: number; status: string }>()
  for (const s of subs) {
    const name = (
      s.external_api_name ?? (s.external_api != null ? `#${s.external_api}` : 'External')
    ).toLowerCase()
    if (!newestSubmissionByApi.has(name))
      newestSubmissionByApi.set(name, { id: s.id, status: s.status })
  }
  if (subs.length === 0 && summary.partners.length === 0) {
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
  const DOT: Record<(typeof summary.partners)[number]['status'], string> = {
    ok: 'bg-emerald-500',
    attention: 'bg-red-500',
    pending: 'bg-sky-500',
    neutral: 'bg-slate-400 dark:bg-slate-500'
  }
  const needs = summary.attention

  return (
    <>
      <button
        type='button'
        onClick={() => setOpen(true)}
        data-nvr-external-requests
        data-integrations-ok={summary.ok}
        data-integrations-attention={needs}
        className={cn(
          'flex shrink-0 items-center gap-1.5 self-center rounded-md border px-2 py-1 text-[11px] font-medium transition-colors',
          needs > 0
            ? 'border-red-200 text-slate-700 hover:bg-red-50/60 dark:border-red-500/40 dark:text-slate-200 dark:hover:bg-red-500/10'
            : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-white/5'
        )}
        title={
          needs > 0
            ? `${needs} integration ${needs === 1 ? 'issue needs' : 'issues need'} attention — click for details`
            : 'Integrations for this record — partner status and every request sent'
        }
      >
        <Satellite className={cn('h-3.5 w-3.5', needs > 0 ? 'text-red-500' : 'text-nvr-cyan')} />
        {summary.partners.length <= 3 ? (
          summary.partners.map((p) => (
            <span
              key={p.name}
              className='inline-flex items-center gap-1'
              data-integration-chip={p.name}
              data-integration-status={p.status}
              data-tip={p.tip}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', DOT[p.status])} />
              {p.name}
            </span>
          ))
        ) : (
          <span>Integrations</span>
        )}
        {/* The badges: told OK (green) · needs attention (red) · awaiting ack (blue). */}
        {summary.ok > 0 && (
          <span
            data-integrations-badge='ok'
            className='rounded bg-emerald-50 px-1 text-[10.5px] font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
          >
            {summary.ok}
          </span>
        )}
        {summary.pending > 0 && (
          <span
            data-integrations-badge='pending'
            className='rounded bg-sky-50 px-1 text-[10.5px] font-semibold text-sky-700 dark:bg-sky-500/10 dark:text-sky-400'
          >
            {summary.pending}
          </span>
        )}
        {needs > 0 && (
          <span
            data-integrations-badge='attention'
            className='rounded bg-red-50 px-1 text-[10.5px] font-semibold text-red-700 dark:bg-red-500/10 dark:text-red-400'
          >
            {needs}
          </span>
        )}
      </button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent className='p-5' style={{ width: '75%', maxWidth: '75%' }}>
            <DialogHeader>
              <DialogTitle className='flex items-center gap-2 text-[15px]'>
                <Satellite className='h-4 w-4 text-nvr-cyan' />
                Integrations
                <span className='text-[12px] font-normal text-slate-400'>
                  {summary.partners.length} partner{summary.partners.length !== 1 ? 's' : ''} ·{' '}
                  {subs.length} request{subs.length !== 1 ? 's' : ''}
                  {needs > 0 && (
                    <span className='ml-1 text-red-600 dark:text-red-400'>
                      · {needs} need{needs === 1 ? 's' : ''} attention
                    </span>
                  )}
                </span>
              </DialogTitle>
            </DialogHeader>
            <DialogBody className='max-h-[65vh] space-y-2 overflow-y-auto'>
              {lines.length > 0 && (
                <div className='space-y-1.5 pb-2' data-integrations-partner-status>
                  <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                    Partner status
                  </p>
                  <IntegrationStatusLines
                    collection={collection}
                    itemId={itemId}
                    lines={lines}
                    remediationEnabled={remediationEnabled}
                    actions={{
                      newestSubmissionByApi,
                      onRetry: (id) => retry.mutate(id),
                      onView: (id) => setFocusId(id),
                      onCheck: () => {
                        void qc.invalidateQueries({
                          queryKey: [
                            'integration-obligations',
                            'record',
                            collection,
                            String(itemId)
                          ]
                        })
                        void qc.invalidateQueries({
                          queryKey: ['erp-submissions', collection, String(itemId)]
                        })
                        toast.message('Checking with the partner status…')
                      },
                      // The pipeline panel takes over (save, requirements
                      // dialog, run) — this dialog gets out of its way.
                      onRanTransition: () => setOpen(false)
                    }}
                  />
                </div>
              )}
              {subs.length > 0 && (
                <p className='pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
                  Requests sent
                </p>
              )}
              {subs.length === 0 && (
                <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                  No request has been sent from this record yet.
                </p>
              )}
              {subs.map((s) => (
                <SubmissionRow
                  key={`${s.id}:${focusId === s.id ? 'focus' : ''}`}
                  sub={s}
                  initialOpen={focusId === s.id}
                  onRetry={(id) => retry.mutate(id)}
                  retrying={retry.isPending}
                  onShowPath={(id) => {
                    setOpen(false)
                    setPathId(id)
                  }}
                />
              ))}
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
      <RecordEventPathSheet
        target={
          pathId != null
            ? {
                source: 'core:outbound',
                id: String(pathId),
                record: { collection, item: String(itemId) }
              }
            : null
        }
        onClose={() => setPathId(null)}
      />
    </>
  )
}
