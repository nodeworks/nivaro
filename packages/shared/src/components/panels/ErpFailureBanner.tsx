import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Code2,
  Loader2,
  RefreshCw
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'

/**
 * Persistent external-submission status banner. Backed by the record's
 * nivaro_erp_submissions rows (not client state), so it survives page loads.
 * Latest submission drives it: 'failed' → red banner with the full error and
 * a Retry button; 'pending' → quiet strip "submitted, awaiting
 * acknowledgement"; 'accepted' → green confirmation. A transient toast alone
 * left successful pushes invisible after the fact. Every state offers a
 * "Request & response" toggle exposing the stored payload/response pair for
 * debugging.
 */

interface ErpSubmission {
  id: number
  status: string
  attempts: number
  last_error: string | null
  endpoint_path: string | null
  payload: unknown
  response: unknown
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

function SubmissionDetail({ sub, tone }: { sub: ErpSubmission; tone: 'red' | 'neutral' }) {
  const payload = pretty(sub.payload)
  const response = pretty(sub.response)
  const preCls = cn(
    'mt-1 max-h-56 overflow-auto rounded-md border p-2 font-mono text-[10.5px] leading-4 whitespace-pre-wrap break-words',
    tone === 'red'
      ? 'border-red-200 bg-white/70 text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200'
      : 'border-slate-200 bg-white/70 text-slate-700 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300'
  )
  const labelCls = cn(
    'text-[10px] font-bold uppercase tracking-wide',
    tone === 'red' ? 'text-red-500/90 dark:text-red-400/80' : 'text-slate-400'
  )
  return (
    <div className='mt-2 space-y-2' data-erp-submission-detail>
      <div>
        <p className={labelCls}>Request payload{sub.endpoint_path ? ` · ${sub.endpoint_path}` : ''}</p>
        {payload ? (
          <pre className={preCls}>{payload}</pre>
        ) : (
          <p className='mt-0.5 text-[11px] italic opacity-70'>No payload stored</p>
        )}
      </div>
      <div>
        <p className={labelCls}>Response</p>
        {response ? (
          <pre className={preCls}>{response}</pre>
        ) : (
          <p className='mt-0.5 text-[11px] italic opacity-70'>
            No response body stored{sub.status === 'failed' ? ' — see the error above' : ''}
          </p>
        )}
      </div>
    </div>
  )
}

function DetailToggle({
  open,
  onToggle,
  tone
}: {
  open: boolean
  onToggle: () => void
  tone: 'red' | 'neutral'
}) {
  return (
    <button
      type='button'
      onClick={onToggle}
      className={cn(
        'mt-1 inline-flex items-center gap-1 text-[11px] font-semibold transition-colors',
        tone === 'red'
          ? 'text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300'
          : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
      )}
    >
      <Code2 className='h-3 w-3' />
      Request &amp; response
      <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
    </button>
  )
}

export function ErpFailureBanner({
  collection,
  itemId
}: {
  collection: string
  itemId: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [showDetail, setShowDetail] = useState(false)
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
      else toast.error('Retry failed — see the error below')
      void qc.invalidateQueries({ queryKey: ['erp-submissions', collection, String(itemId)] })
      void qc.invalidateQueries({ queryKey: ['item', collection, String(itemId)] })
    },
    onError: () => toast.error('Retry failed')
  })

  // Key off the LATEST submission only (route returns newest first): once a
  // newer attempt lands as pending/accepted, older failures are history and
  // must not keep the banner up.
  const latest = (data ?? [])[0]
  if (!latest) return null

  if (latest.status === 'pending' || latest.status === 'accepted') {
    const accepted = latest.status === 'accepted'
    return (
      <div
        className={cn(
          'rounded-lg border px-3.5 py-2 text-[12px]',
          accepted
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-900/15 dark:text-emerald-300'
            : 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900/40 dark:bg-sky-900/15 dark:text-sky-300'
        )}
        data-erp-status-banner={latest.status}
      >
        <div className='flex items-center gap-2.5'>
          {accepted ? (
            <CheckCircle2 className='h-4 w-4 shrink-0 text-emerald-500' strokeWidth={2} />
          ) : (
            <Clock3 className='h-4 w-4 shrink-0 text-sky-500' strokeWidth={2} />
          )}
          <span className='min-w-0 flex-1 truncate'>
            <span className='font-semibold'>
              {accepted
                ? 'External submission accepted'
                : 'Submitted to external system — awaiting acknowledgement'}
            </span>
            {latest.endpoint_path ? ` · ${latest.endpoint_path}` : ''}
          </span>
          <span className='shrink-0 opacity-75'>
            {new Date(latest.updated_at).toLocaleString()}
          </span>
        </div>
        <DetailToggle open={showDetail} onToggle={() => setShowDetail((v) => !v)} tone='neutral' />
        {showDetail && <SubmissionDetail sub={latest} tone='neutral' />}
      </div>
    )
  }

  if (latest.status !== 'failed') return null
  const failures = (data ?? []).filter((s) => s.status === 'failed')

  return (
    <div
      className='flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 dark:border-red-900/40 dark:bg-red-900/15'
      data-erp-failure-banner
    >
      <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0 text-red-500' strokeWidth={2} />
      <div className='min-w-0 flex-1'>
        <p className='text-[12.5px] font-semibold text-red-700 dark:text-red-300'>
          External submission failed
          {failures.length > 1 ? ` (${failures.length} failed submissions)` : ''} — the record was
          not advanced
        </p>
        <p
          className='mt-0.5 break-words text-[12px] leading-5 text-red-600 dark:text-red-400'
          title={latest.last_error ?? undefined}
        >
          {latest.last_error ?? 'No error detail recorded'}
        </p>
        <p className='mt-0.5 text-[11px] text-red-500/80 dark:text-red-400/70'>
          {latest.endpoint_path ? `${latest.endpoint_path} · ` : ''}
          {latest.attempts} attempt{latest.attempts === 1 ? '' : 's'} · last tried{' '}
          {new Date(latest.updated_at).toLocaleString()}
        </p>
        <DetailToggle open={showDetail} onToggle={() => setShowDetail((v) => !v)} tone='red' />
        {showDetail && <SubmissionDetail sub={latest} tone='red' />}
      </div>
      <button
        type='button'
        disabled={retry.isPending}
        onClick={() => retry.mutate(latest.id)}
        className={cn(
          'flex shrink-0 items-center gap-1.5 rounded-md border border-red-300 bg-white px-2.5 py-1.5 text-[12px] font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50',
          'dark:border-red-800 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-900/30'
        )}
      >
        {retry.isPending ? (
          <Loader2 className='h-3.5 w-3.5 animate-spin' />
        ) : (
          <RefreshCw className='h-3.5 w-3.5' />
        )}
        Retry
      </button>
    </div>
  )
}
