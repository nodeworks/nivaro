import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ShieldAlert, X } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { cn, formatRelative } from '../../lib/utils'

/**
 * An ops assistant proposal (#2015) — pause a job, open a circuit breaker,
 * retry a push, incident mode — as an approval card in an admin-only
 * channel. The server builds the card only for administrators (anyone else
 * sees the plain link), and approval re-checks the approver and runs the
 * action through its own admin route.
 */

export interface OpsProposalCardData {
  kind: 'ops-proposal'
  id: string
  action: string
  summary: string
  reason: string
  status: 'pending' | 'approved' | 'failed' | 'dismissed'
  proposed_at: string
  decided_by_name: string | null
  decided_at: string | null
  result: { status: number; ok: boolean; message: string | null } | null
}

const STATUS_TEXT: Record<OpsProposalCardData['status'], string> = {
  pending: 'Waiting for an administrator',
  approved: 'Approved and done',
  failed: 'Approved — did not run',
  dismissed: 'Dismissed'
}

export function OpsProposalCard({ path, card }: { path: string; card: OpsProposalCardData }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'dismiss') =>
      client.request<{ data: OpsProposalCardData }>(
        post(`/ops-assistant/proposals/${encodeURIComponent(card.id)}/${decision}`)
      ),
    onSuccess: (res) => {
      setError(null)
      qc.setQueryData(['nvr-chat-app-card', path], res.data)
    },
    onError: (e) => {
      setError(
        (e as { response?: { error?: string } })?.response?.error ??
          (e as Error)?.message ??
          'That did not work'
      )
      void qc.invalidateQueries({ queryKey: ['nvr-chat-app-card', path] })
    }
  })
  const pending = card.status === 'pending'
  return (
    <div
      className='w-full max-w-[380px] rounded-lg border border-amber-300 bg-white px-3 py-2 text-slate-700 dark:border-amber-500/40 dark:bg-card dark:text-slate-200'
      data-chat-app-card='ops-proposal'
      data-ops-proposal={card.id}
      data-ops-proposal-status={card.status}
    >
      <div className='flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300'>
        <ShieldAlert className='h-3.5 w-3.5' /> Proposed action
      </div>
      <p className='mt-0.5 text-[12.5px] font-semibold'>{card.summary}</p>
      <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>{card.reason}</p>
      <p
        className={cn(
          'mt-1 text-[11px]',
          card.status === 'failed'
            ? 'text-red-600 dark:text-red-400'
            : card.status === 'approved'
              ? 'text-emerald-700 dark:text-emerald-300'
              : 'text-slate-500 dark:text-slate-400'
        )}
      >
        {STATUS_TEXT[card.status]}
        {card.decided_by_name ? ` · ${card.decided_by_name}` : ''}
        {card.decided_at ? ` · ${formatRelative(card.decided_at)}` : ''}
        {card.result && !card.result.ok && card.result.message ? ` — ${card.result.message}` : ''}
      </p>
      {error && <p className='mt-1 text-[11px] text-red-600 dark:text-red-400'>{error}</p>}
      {pending && (
        <div className='mt-2 flex gap-2'>
          <button
            type='button'
            disabled={decide.isPending}
            onClick={() => decide.mutate('approve')}
            className='inline-flex h-7 items-center gap-1 rounded-md bg-nvr-cyan px-2.5 text-[11.5px] font-semibold text-white disabled:opacity-50'
            data-ops-proposal-approve
          >
            <Check className='h-3.5 w-3.5' /> Approve
          </button>
          <button
            type='button'
            disabled={decide.isPending}
            onClick={() => decide.mutate('dismiss')}
            className='inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 px-2.5 text-[11.5px] font-medium text-slate-600 hover:bg-muted disabled:opacity-50 dark:border-border dark:text-slate-300'
            data-ops-proposal-dismiss
          >
            <X className='h-3.5 w-3.5' /> Dismiss
          </button>
        </div>
      )}
    </div>
  )
}
