import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

export type ErpStatus = 'submitted' | 'pending' | 'accepted' | 'rejected' | 'failed'

export interface ErpSubmission {
  id: number
  collection: string
  item: string
  external_api: number
  external_ref: string | null
  status: ErpStatus
  attempts: number
  last_error: string | null
  endpoint_path: string | null
  payload: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

const STATUS_STYLES: Record<ErpStatus, string> = {
  submitted: 'bg-slate-500/10 text-slate-600 border-slate-500/20 dark:text-slate-400',
  pending: 'bg-amber-500/10 text-amber-700 border-amber-500/20 dark:text-amber-400',
  accepted: 'bg-green-500/10 text-green-700 border-green-500/20 dark:text-green-400',
  rejected: 'bg-red-500/10 text-red-700 border-red-500/20 dark:text-red-400',
  failed: 'bg-red-500/10 text-red-700 border-red-500/20 dark:text-red-400'
}

const STATUS_LABELS: Record<ErpStatus, string> = {
  submitted: 'ERP: Submitted',
  pending: 'ERP: Pending',
  accepted: 'ERP: Accepted',
  rejected: 'ERP: Rejected',
  failed: 'ERP: Failed'
}

/**
 * Shows the latest ERP submission status for an item as a colored badge.
 * Renders nothing when the item has never been submitted.
 * On failure/rejection, an inline retry icon-button re-sends the same payload.
 */
export function ErpStatusBadge({ collection, item }: { collection: string; item: string }) {
  const queryClient = useQueryClient()
  const queryKey = ['erp-submissions', collection, item]

  const { data } = useQuery<ErpSubmission[]>({
    queryKey,
    queryFn: () =>
      api
        .get<{ data: ErpSubmission[] }>(
          `/erp-submissions/${encodeURIComponent(collection)}/${encodeURIComponent(item)}`
        )
        .then((r) => r.data.data),
    enabled: !!collection && !!item,
    staleTime: 15_000
  })

  const retry = useMutation({
    mutationFn: (id: number) =>
      api.post<{ data: ErpSubmission }>(`/erp-submissions/${id}/retry`).then((r) => r.data.data),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey })
      if (updated.status === 'failed') {
        toast.error(`Retry failed${updated.last_error ? `: ${updated.last_error}` : ''}`)
      } else {
        toast.success(`Resubmitted — status: ${updated.status}`)
      }
    },
    onError: () => toast.error('Retry failed')
  })

  const latest = data?.[0]
  if (!latest) return null

  const canRetry = latest.status === 'failed' || latest.status === 'rejected'

  return (
    <span className='inline-flex items-center gap-1'>
      <Badge
        variant='outline'
        className={cn('text-[11px]', STATUS_STYLES[latest.status])}
        title={
          latest.last_error ??
          (latest.external_ref ? `Ref: ${latest.external_ref}` : `Attempts: ${latest.attempts}`)
        }
      >
        {STATUS_LABELS[latest.status]}
      </Badge>
      {canRetry && (
        <button
          type='button'
          onClick={() => retry.mutate(latest.id)}
          disabled={retry.isPending}
          className='rounded p-0.5 text-slate-400 transition-colors hover:text-nvr-cyan disabled:opacity-50'
          aria-label='Retry ERP submission'
          title='Retry ERP submission'
        >
          <RotateCw className={cn('h-3.5 w-3.5', retry.isPending && 'animate-spin')} />
        </button>
      )}
    </span>
  )
}
