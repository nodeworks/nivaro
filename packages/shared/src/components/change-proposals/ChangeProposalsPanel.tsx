import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronRight,
  GitPullRequestArrow,
  Loader2
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { describeError } from '../../lib/error-message'
import { toastError } from '../../lib/error-toast'
import { noteOwnWrite } from '../../lib/own-writes'
import { invalidateRecordRow } from '../../lib/record-loader'
import { cn, formatRelative } from '../../lib/utils'
import { ProposalValue } from './ProposalValue'
import { type ProposalView, proposalsQueryKey, type RecordProposals } from './types'

/** The record's proposals (one read shared by the panel and the Propose button). */
export function useRecordProposals(collection: string, item: string | null, enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<RecordProposals | null>({
    queryKey: proposalsQueryKey(collection, item ?? ''),
    queryFn: () =>
      client
        .request<{ data: RecordProposals }>(
          get(`/change-proposals/record/${collection}/${encodeURIComponent(String(item))}`)
        )
        .then((r) => r.data)
        .catch(() => null),
    enabled: enabled && !!item,
    staleTime: 15_000
  })
}

const STATUS_WORD: Record<string, { text: string; cls: string }> = {
  accepted: {
    text: 'Accepted',
    cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
  },
  declined: { text: 'Declined', cls: 'bg-rose-500/10 text-rose-700 dark:text-rose-300' },
  withdrawn: { text: 'Withdrawn', cls: 'bg-slate-500/10 text-slate-600 dark:text-slate-400' }
}

function ChangesTable({ p }: { p: ProposalView }) {
  return (
    <div className='overflow-hidden rounded-md border border-slate-200 dark:border-border'>
      <table className='w-full table-fixed text-[12.5px]'>
        <thead className='bg-slate-50 text-left text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:bg-muted/40 dark:text-muted-foreground'>
          <tr>
            <th className='w-[30%] px-3 py-1.5 font-medium'>Field</th>
            <th className='w-[30%] px-3 py-1.5 font-medium'>Before</th>
            <th className='w-5' aria-hidden />
            <th className='px-3 py-1.5 font-medium'>Proposed</th>
          </tr>
        </thead>
        <tbody className='divide-y divide-slate-100 dark:divide-border'>
          {p.changes.map((c) => (
            <tr key={c.field} data-proposal-change={c.field} className='align-top'>
              <td className='px-3 py-2 font-medium text-slate-700 dark:text-slate-200'>
                <span className='break-words'>{c.label}</span>
                {c.stale && (
                  <span
                    className='mt-0.5 flex items-center gap-1 text-[11px] font-normal text-amber-700 dark:text-amber-400'
                    data-tip='Someone changed this field after the proposal was made'
                  >
                    <AlertTriangle className='h-3 w-3' /> Changed since
                  </span>
                )}
              </td>
              <td className='px-3 py-2 text-slate-500 line-through decoration-slate-300 dark:text-slate-400 dark:decoration-slate-600'>
                <ProposalValue
                  value={c.from}
                  kind={c.kind}
                  relation={c.relation}
                  choices={c.choices}
                />
              </td>
              <td className='py-2 text-slate-400' aria-hidden>
                <ArrowRight className='mt-0.5 h-3.5 w-3.5' />
              </td>
              <td className='px-3 py-2 font-medium text-slate-900 dark:text-slate-50'>
                <ProposalValue
                  value={c.to}
                  kind={c.kind}
                  relation={c.relation}
                  choices={c.choices}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.hidden_fields > 0 && (
        <p className='border-t border-slate-100 px-3 py-1.5 text-[11.5px] text-slate-500 dark:border-border dark:text-muted-foreground'>
          {p.hidden_fields === 1 ? 'One more field' : `${p.hidden_fields} more fields`} you can’t
          see.
        </p>
      )}
    </div>
  )
}

function PendingProposal({
  p,
  collection,
  item
}: {
  p: ProposalView
  collection: string
  item: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [declining, setDeclining] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: proposalsQueryKey(collection, item) })
    qc.invalidateQueries({ queryKey: ['my-work'] })
  }
  const act = useMutation({
    onMutate: (a) => {
      // The accept writes the record from this tab: its live echo is ours, not a mid-air change.
      if (a.kind === 'accept')
        noteOwnWrite(
          collection,
          item,
          undefined,
          p.changes.map((c) => c.field)
        )
    },
    mutationFn: (a: { kind: 'accept' | 'decline' | 'withdraw'; note?: string }) =>
      client.request(
        post(`/change-proposals/${p.id}/${a.kind}`, a.kind === 'decline' ? { note: a.note } : {})
      ),
    onSuccess: (_r, a) => {
      refresh()
      if (a.kind === 'accept') {
        // The record itself changed: the form, its history and Notes re-read.
        qc.invalidateQueries({ queryKey: ['item', collection] })
        qc.invalidateQueries({ queryKey: ['comments-related', collection] })
        invalidateRecordRow(qc, collection, item)
        toast.success('Accepted — the new values are on the record.')
      } else if (a.kind === 'decline') toast.success('Declined — the proposer has been told.')
      else toast.success('Proposal withdrawn.')
    },
    onError: (err, a) => {
      const d = describeError(err, 'Could not do that')
      if (a.kind === 'decline') setError(d.title)
      else toastError(err, 'Could not do that')
      refresh()
    }
  })
  const busy = act.isPending
  // A field that moved since the proposal makes Accept refuse on the server: say so up front.
  const stale = p.changes.some((c) => c.stale)
  return (
    <div
      data-change-proposal={p.id}
      className='rounded-lg border border-nvr-cyan/30 bg-white p-4 shadow-sm dark:border-nvr-cyan/25 dark:bg-card'
    >
      <div className='mb-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-1'>
        <div className='flex min-w-0 items-center gap-2'>
          <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/10 text-[#0e7490] dark:text-[#67e8f9]'>
            <GitPullRequestArrow className='h-3.5 w-3.5' />
          </span>
          <div className='min-w-0'>
            <p className='text-[13px] font-semibold text-slate-900 dark:text-slate-50'>
              Proposed change
            </p>
            <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              {p.created_by_name ?? 'Someone'} · {formatRelative(p.created_at)}
            </p>
          </div>
        </div>
        <span className='rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300'>
          Waiting for a decision
        </span>
      </div>
      <p className='mb-3 max-w-[75ch] text-[12.5px] leading-relaxed text-slate-700 dark:text-slate-300'>
        <span className='mr-1.5 font-medium text-slate-500 dark:text-slate-400'>Why:</span>
        {p.reason}
      </p>
      <ChangesTable p={p} />
      {(p.can_decide || p.can_withdraw) && (
        <div className='mt-3 space-y-2'>
          {declining ? (
            <form
              className='space-y-2'
              onSubmit={(e) => {
                e.preventDefault()
                if (note.trim().length < 3 || busy) return
                setError(null)
                act.mutate({ kind: 'decline', note: note.trim() })
              }}
            >
              <label className='block'>
                <span className='mb-1 block text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                  Why are you declining it? The proposer sees this.
                </span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  data-proposal-decline-note
                  className='w-full rounded-md border border-input bg-background px-2.5 py-2 text-[13px] leading-snug text-foreground shadow-sm outline-none focus-visible:border-nvr-cyan focus-visible:ring-2 focus-visible:ring-nvr-cyan/25'
                />
              </label>
              {error && (
                <p role='alert' className='text-[12px] text-rose-700 dark:text-rose-300'>
                  {error}
                </p>
              )}
              <div className='flex flex-wrap items-center gap-2'>
                <button
                  type='submit'
                  disabled={note.trim().length < 3 || busy}
                  data-proposal-decline-confirm
                  className='inline-flex h-8 items-center gap-1.5 rounded-md bg-rose-600 px-3 text-[12.5px] font-semibold text-white shadow-sm transition-opacity hover:bg-rose-700 disabled:opacity-50'
                >
                  {busy && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
                  Decline proposal
                </button>
                <button
                  type='button'
                  onClick={() => {
                    setDeclining(false)
                    setError(null)
                  }}
                  className='h-8 rounded-md px-3 text-[12.5px] font-medium text-slate-600 hover:bg-muted dark:text-slate-300'
                >
                  Keep it
                </button>
              </div>
            </form>
          ) : (
            <div className='flex flex-wrap items-center gap-2'>
              {p.can_decide && (
                <>
                  <button
                    type='button'
                    disabled={busy || stale}
                    data-tip={
                      stale
                        ? 'A field changed since this was proposed — decline it and ask for a new one'
                        : undefined
                    }
                    onClick={() => act.mutate({ kind: 'accept' })}
                    data-proposal-accept
                    className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-white shadow-sm transition-opacity disabled:opacity-50'
                  >
                    {busy ? (
                      <Loader2 className='h-3.5 w-3.5 animate-spin' />
                    ) : (
                      <Check className='h-3.5 w-3.5' />
                    )}
                    Accept and apply
                  </button>
                  <button
                    type='button'
                    disabled={busy}
                    onClick={() => setDeclining(true)}
                    data-proposal-decline
                    className='inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-[12.5px] font-medium text-slate-700 shadow-sm transition-colors hover:bg-muted disabled:opacity-50 dark:text-slate-200'
                  >
                    Decline
                  </button>
                </>
              )}
              {p.can_withdraw && (
                <button
                  type='button'
                  disabled={busy}
                  onClick={() => act.mutate({ kind: 'withdraw' })}
                  data-proposal-withdraw
                  className='inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-[12.5px] font-medium text-slate-700 shadow-sm transition-colors hover:bg-muted disabled:opacity-50 dark:text-slate-200'
                >
                  Withdraw
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {p.can_decide && stale && !declining && (
        <p
          className='mt-2 text-[11.5px] text-amber-700 dark:text-amber-400'
          data-proposal-stale-note
        >
          A field changed after this was proposed, so it can’t be applied as it stands. Decline it
          and ask for a new proposal.
        </p>
      )}
      {!p.can_decide && !p.can_withdraw && p.decide_reason && (
        <p className='mt-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {p.decide_reason}
        </p>
      )}
      {p.can_withdraw && p.decide_reason && (
        <p className='mt-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          The owners of this step will accept or decline it — you’ll get a notification.
        </p>
      )}
    </div>
  )
}

/**
 * Proposed changes on a record (idea 6): each waiting proposal as old → new
 * per field with Accept / Decline for the step's owners and administrators,
 * Withdraw for the proposer; earlier ones folded below. Renders nothing when
 * the collection has proposals off or the record has none.
 */
export function ChangeProposalsPanel({
  collection,
  itemId,
  enabled
}: {
  collection: string
  itemId: string | null
  enabled: boolean
}) {
  const { data } = useRecordProposals(collection, itemId, enabled)
  const [showEarlier, setShowEarlier] = useState(false)
  if (!data?.enabled || !itemId) return null
  const pending = data.proposals.filter((p) => p.status === 'pending' || p.status === 'accepting')
  const earlier = data.proposals.filter((p) => !pending.includes(p))
  if (pending.length === 0 && earlier.length === 0) return null
  return (
    <section
      className='nvr-expand-in space-y-2'
      data-change-proposals
      aria-label='Proposed changes'
    >
      {pending.map((p) => (
        <PendingProposal key={p.id} p={p} collection={collection} item={itemId} />
      ))}
      {earlier.length > 0 && (
        <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <button
            type='button'
            onClick={() => setShowEarlier((v) => !v)}
            aria-expanded={showEarlier}
            className='flex w-full items-center gap-1.5 px-4 py-2 text-left text-[12.5px] font-medium text-slate-600 hover:bg-muted dark:text-slate-300'
          >
            <ChevronRight
              className={cn('h-3.5 w-3.5 transition-transform', showEarlier && 'rotate-90')}
            />
            Earlier proposals ({earlier.length})
          </button>
          {showEarlier && (
            <ul className='divide-y divide-slate-100 border-t border-slate-100 dark:divide-border dark:border-border'>
              {earlier.map((p) => {
                const word = STATUS_WORD[p.status] ?? STATUS_WORD.withdrawn
                return (
                  <li key={p.id} className='space-y-2 px-4 py-3' data-change-proposal={p.id}>
                    <div className='flex flex-wrap items-center gap-2 text-[12px]'>
                      <span
                        className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', word.cls)}
                      >
                        {word.text}
                      </span>
                      <span className='text-slate-600 dark:text-slate-300'>
                        {p.created_by_name ?? 'Someone'} proposed · {formatRelative(p.created_at)}
                      </span>
                      {p.decided_by_name && p.status !== 'withdrawn' && (
                        <span className='text-slate-500 dark:text-muted-foreground'>
                          · {word.text.toLowerCase()} by {p.decided_by_name}
                        </span>
                      )}
                    </div>
                    <p className='text-[12px] text-slate-600 dark:text-slate-400'>{p.reason}</p>
                    {p.decision_note && (
                      <p className='text-[12px] text-slate-600 dark:text-slate-400'>
                        <span className='font-medium'>Note:</span> {p.decision_note}
                      </p>
                    )}
                    <ChangesTable p={p} />
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
