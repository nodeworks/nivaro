import { AgentBadge } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Inbox, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Schema change proposals (#3209) on the Data Model page: what assistants (the MCP
 * `propose_schema_change` tool) or people drafted, in plain words, with Apply and Reject.
 * Applying runs the Data Model's own routes as you, step by step; nothing an assistant proposes
 * changes the schema until an administrator applies it here.
 */

export interface SchemaProposalRow {
  id: string
  status: 'proposed' | 'applied' | 'rejected' | 'expired'
  collections: string[]
  sentences: string[]
  note: string | null
  proposed_by: { id: string; name: string }
  via: string
  client: string | null
  created_at: string
  resolved_at: string | null
  result: {
    steps?: Array<{ label: string; status: string }>
    last_error?: string
    note?: string
  } | null
}

export const schemaProposalsKey = (status: 'open' | 'all') => ['schema-proposals', status] as const

export function useOpenSchemaProposals() {
  return useQuery({
    queryKey: schemaProposalsKey('open'),
    queryFn: () =>
      api
        .get<{ data: SchemaProposalRow[] }>('/schema-proposals', { params: { status: 'open' } })
        .then((r) => r.data.data),
    staleTime: 30_000
  })
}

const errorText = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback

const STATUS_TONE: Record<SchemaProposalRow['status'], string> = {
  proposed: 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan',
  applied: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-slate-300',
  expired: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
}

function ProposalCard({ p }: { p: SchemaProposalRow }) {
  const qc = useQueryClient()
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [confirmApply, setConfirmApply] = useState(false)
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['schema-proposals'] })
    void qc.invalidateQueries({ queryKey: ['data-model-tables'] })
    void qc.invalidateQueries({ queryKey: ['collections'] })
  }
  const apply = useMutation({
    mutationFn: () => api.post(`/schema-proposals/${p.id}/apply`),
    onSuccess: () => {
      toast.success('Schema proposal applied')
      done()
    },
    onError: (err) => {
      toast.error(errorText(err, 'Could not apply the proposal'))
      done()
    }
  })
  const reject = useMutation({
    mutationFn: () => api.post(`/schema-proposals/${p.id}/reject`, { note: note.trim() || null }),
    onSuccess: () => {
      toast.success('Proposal rejected')
      done()
    },
    onError: (err) => toast.error(errorText(err, 'Could not reject the proposal'))
  })
  const via = p.client ? `via ${p.client}` : null
  const open = p.status === 'proposed'
  return (
    <li className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
          {p.proposed_by.name}
        </span>
        <AgentBadge label={via} />
        <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {formatRelative(p.created_at)}
        </span>
        <span
          className={cn(
            'ml-auto rounded-full px-2 py-px text-[10.5px] font-semibold',
            STATUS_TONE[p.status]
          )}
        >
          {p.status === 'proposed' ? 'Waiting' : p.status[0].toUpperCase() + p.status.slice(1)}
        </span>
      </div>
      {p.note && (
        <p className='mt-2 max-w-[72ch] text-[12.5px] text-slate-700 dark:text-slate-200'>
          “{p.note}”
        </p>
      )}
      <ul className='mt-2.5 space-y-1'>
        {p.sentences.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sentences are positional
          <li key={i} className='flex gap-2 text-[12.5px] text-slate-700 dark:text-slate-200'>
            <span className='mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-400' aria-hidden />
            {s}
          </li>
        ))}
      </ul>
      {p.result?.last_error && open && (
        <p className='mt-2 text-[12px] text-red-600 dark:text-red-400'>
          Last try stopped: {p.result.last_error}
        </p>
      )}
      {p.status === 'rejected' && p.result?.note && (
        <p className='mt-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
          Rejected: {p.result.note}
        </p>
      )}
      {open && (
        <div className='mt-3 flex flex-wrap items-center gap-2'>
          {confirmApply ? (
            <>
              <Button size='sm' disabled={apply.isPending} onClick={() => apply.mutate()}>
                {apply.isPending ? (
                  <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                ) : (
                  <Check className='mr-1.5 h-3.5 w-3.5' />
                )}
                Apply {p.sentences.length} change{p.sentences.length === 1 ? '' : 's'} now
              </Button>
              <Button size='sm' variant='ghost' onClick={() => setConfirmApply(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size='sm' onClick={() => setConfirmApply(true)}>
              <Check className='mr-1.5 h-3.5 w-3.5' /> Apply…
            </Button>
          )}
          {rejecting ? (
            <span className='flex flex-wrap items-center gap-2'>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                placeholder='Why (optional)'
                aria-label='Why the proposal is rejected'
                className='h-8 w-64 rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-100'
              />
              <Button
                size='sm'
                variant='outline'
                disabled={reject.isPending}
                onClick={() => reject.mutate()}
              >
                Reject
              </Button>
              <Button size='sm' variant='ghost' onClick={() => setRejecting(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button size='sm' variant='ghost' onClick={() => setRejecting(true)}>
              <X className='mr-1.5 h-3.5 w-3.5' /> Reject…
            </Button>
          )}
        </div>
      )}
    </li>
  )
}

export function SchemaProposalsPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<'open' | 'all'>('open')
  const q = useQuery({
    queryKey: schemaProposalsKey(status),
    queryFn: () =>
      api
        .get<{ data: SchemaProposalRow[] }>('/schema-proposals', { params: { status } })
        .then((r) => r.data.data)
  })
  const rows = q.data ?? []
  return (
    <div className='flex-1 overflow-y-auto p-6' data-schema-proposals>
      <div className='flex flex-wrap items-center gap-3'>
        <h2 className='text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
          Schema proposals
        </h2>
        <div role='tablist' className='flex gap-1 rounded-md bg-slate-100 p-0.5 dark:bg-muted'>
          {(
            [
              ['open', 'Waiting'],
              ['all', 'All']
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type='button'
              role='tab'
              aria-selected={status === key}
              onClick={() => setStatus(key)}
              className={cn(
                'h-7 rounded px-3 text-[12.5px] font-medium transition-colors',
                status === key
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-card dark:text-white'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <Button size='sm' variant='ghost' className='ml-auto' onClick={onClose}>
          Close
        </Button>
      </div>
      <p className='mt-1 max-w-[80ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
        Field and collection changes drafted by assistants and people. Nothing here has changed the
        data model yet — applying one runs the same steps as doing it by hand, as you.
      </p>
      {q.isLoading ? (
        <div className='mt-4 flex items-center gap-2 text-[12.5px] text-slate-500'>
          <Loader2 className='h-3.5 w-3.5 animate-spin' /> Loading…
        </div>
      ) : q.isError ? (
        <p className='mt-4 text-[12.5px] text-red-600 dark:text-red-400'>
          {errorText(q.error, 'Proposals could not be loaded')}
        </p>
      ) : rows.length === 0 ? (
        <div className='mt-6 flex items-start gap-3'>
          <Inbox className='mt-0.5 h-5 w-5 text-slate-400' />
          <p className='max-w-[70ch] text-[12.5px] text-slate-600 dark:text-slate-300'>
            {status === 'open'
              ? 'No proposals are waiting. When an assistant suggests a new field or collection, it appears here for you to apply or reject.'
              : 'No schema proposals yet.'}
          </p>
        </div>
      ) : (
        <ul className='mt-4 space-y-3'>
          {rows.map((p) => (
            <ProposalCard key={p.id} p={p} />
          ))}
        </ul>
      )}
    </div>
  )
}
