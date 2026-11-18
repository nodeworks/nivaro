import { ErrorNotice, toastError } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  RotateCw,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'
import {
  fetchHealth,
  fetchOutbox,
  OP_LABELS,
  type OutboxRow,
  SOURCE_LABELS,
  type TrackerConnection,
  trackerKeys,
  webhookSilent
} from './api'

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='min-w-0 bg-white px-3 py-2 dark:bg-card'>
      <dt className='text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</dt>
      <dd className='mt-0.5 truncate text-[12.5px] font-medium tabular-nums text-slate-900 dark:text-foreground'>
        {children}
      </dd>
    </div>
  )
}

function OutboxList({ connection }: { connection: number }) {
  const qc = useQueryClient()
  const dead = useQuery({
    queryKey: trackerKeys.outbox(connection, 'dead'),
    queryFn: () => fetchOutbox(connection, 'dead')
  })
  const pending = useQuery({
    queryKey: trackerKeys.outbox(connection, 'pending'),
    queryFn: () => fetchOutbox(connection, 'pending')
  })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['trackers', 'outbox', connection] })
    void qc.invalidateQueries({ queryKey: trackerKeys.health(connection) })
  }
  const retry = useMutation({
    mutationFn: (id: number) => api.post(`/trackers/outbox/${id}/retry`),
    onSuccess: refresh,
    onError: (err) => toastError(err, 'Could not retry')
  })
  const discard = useMutation({
    mutationFn: (id: number) => api.post(`/trackers/outbox/${id}/discard`),
    onSuccess: refresh,
    onError: (err) => toastError(err, 'Could not discard')
  })
  const [confirmDiscard, setConfirmDiscard] = useState<number | null>(null)

  if (dead.isError || pending.isError)
    return (
      <ErrorNotice
        error={dead.error ?? pending.error}
        what='the waiting changes'
        onRetry={() => {
          void dead.refetch()
          void pending.refetch()
        }}
        className='m-3'
      />
    )
  if (dead.isLoading || pending.isLoading)
    return (
      <div className='space-y-1.5 p-3'>
        {[1, 2].map((i) => (
          <Skeleton key={i} className='h-7' />
        ))}
      </div>
    )
  const rows: OutboxRow[] = [...(dead.data ?? []), ...(pending.data ?? [])]
  if (!rows.length)
    return (
      <p className='px-3 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
        Nothing is waiting to go to GitLab.
      </p>
    )
  return (
    <table className='w-full text-[12px]'>
      <thead>
        <tr className='border-b border-slate-100 text-left text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
          <th className='px-3 py-1.5 font-medium'>Change</th>
          <th className='px-3 py-1.5 font-medium'>From</th>
          <th className='px-3 py-1.5 font-medium'>Tries</th>
          <th className='px-3 py-1.5 font-medium'>Last error</th>
          <th className='px-3 py-1.5' />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className='border-b border-slate-100 last:border-0 dark:border-border'>
            <td className='whitespace-nowrap px-3 py-1.5'>
              <span
                className={cn(
                  'mr-1.5 inline-block rounded px-1 text-[10.5px] font-medium',
                  r.status === 'dead'
                    ? 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300'
                    : 'bg-slate-100 text-slate-700 dark:bg-muted dark:text-slate-200'
                )}
              >
                {r.status === 'dead' ? 'Gave up' : 'Waiting'}
              </span>
              {OP_LABELS[r.op] ?? r.op}
            </td>
            <td className='whitespace-nowrap px-3 py-1.5 text-slate-600 dark:text-slate-300'>
              {SOURCE_LABELS[r.source_kind] ?? r.source_kind} {r.source_id}
            </td>
            <td className='px-3 py-1.5 tabular-nums text-slate-600 dark:text-slate-300'>
              {r.attempts}
            </td>
            <td
              className='max-w-[360px] truncate px-3 py-1.5 text-slate-600 dark:text-slate-300'
              data-tip={r.last_error || undefined}
            >
              {r.last_error || '—'}
            </td>
            <td className='whitespace-nowrap px-3 py-1 text-right'>
              {confirmDiscard === r.id ? (
                <span className='inline-flex items-center gap-1'>
                  <Button
                    type='button'
                    variant='destructive'
                    size='sm'
                    className='h-6 px-2 text-[11px]'
                    disabled={discard.isPending}
                    onClick={() => discard.mutate(r.id)}
                  >
                    Discard change
                  </Button>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    className='h-6 px-2 text-[11px]'
                    onClick={() => setConfirmDiscard(null)}
                  >
                    Keep
                  </Button>
                </span>
              ) : (
                <span className='inline-flex items-center gap-1'>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    className='h-6 gap-1 px-2 text-[11px]'
                    disabled={retry.isPending}
                    onClick={() => retry.mutate(r.id)}
                  >
                    <RotateCw className='h-3 w-3' />
                    Retry
                  </Button>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    aria-label={`Discard change ${r.id}`}
                    className='h-6 px-1.5 text-slate-400 hover:text-red-600'
                    onClick={() => setConfirmDiscard(r.id)}
                  >
                    <Trash2 className='h-3 w-3' />
                  </Button>
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function HealthStrip({ connection }: { connection: TrackerConnection }) {
  const [open, setOpen] = useState(false)
  const health = useQuery({
    queryKey: trackerKeys.health(connection.id),
    queryFn: () => fetchHealth(connection.id),
    refetchInterval: 30_000
  })
  const h = health.data
  const status = h?.status ?? connection.status
  const lastHook = h?.last_webhook_at ?? connection.last_webhook_at
  const lastReconcile = h?.last_reconcile_at ?? connection.last_reconcile_at
  const silent = webhookSilent(lastHook)
  const waiting = (h?.outbox.pending ?? 0) + (h?.outbox.dead ?? 0)

  return (
    <section aria-label='Sync health' className='space-y-2'>
      <div className='overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
        <dl className='grid grid-cols-2 gap-px bg-slate-200 sm:grid-cols-5 dark:bg-border'>
          <Cell label='Status'>
            {!connection.is_active ? (
              <span className='text-slate-500 dark:text-muted-foreground'>Paused</span>
            ) : status === 'broken' ? (
              <span className='inline-flex items-center gap-1 text-red-700 dark:text-red-400'>
                <CircleAlert className='h-3.5 w-3.5' />
                Broken
              </span>
            ) : (
              <span className='inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400'>
                <CircleCheck className='h-3.5 w-3.5' />
                Working
              </span>
            )}
          </Cell>
          <Cell label='Waiting to send'>{h ? h.outbox.pending : '—'}</Cell>
          <Cell label='Gave up'>
            <span className={cn(h?.outbox.dead ? 'text-red-700 dark:text-red-400' : undefined)}>
              {h ? h.outbox.dead : '—'}
            </span>
          </Cell>
          <Cell label='Last webhook'>{lastHook ? formatRelative(lastHook) : 'Never'}</Cell>
          <Cell label='Last catch-up'>
            {lastReconcile ? formatRelative(lastReconcile) : 'Never'}
          </Cell>
        </dl>
        {waiting > 0 && (
          <div className='border-t border-slate-200 bg-white dark:border-border dark:bg-card'>
            <button
              type='button'
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className='flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11.5px] font-medium text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50 dark:text-slate-300 dark:hover:bg-muted/40'
            >
              <ChevronDown className={cn('h-3 w-3 transition-transform', !open && '-rotate-90')} />
              {open ? 'Hide' : 'Show'} the {waiting} change{waiting === 1 ? '' : 's'} not sent yet
            </button>
            {open && (
              <div className='border-t border-slate-100 dark:border-border'>
                <OutboxList connection={connection.id} />
              </div>
            )}
          </div>
        )}
      </div>
      {connection.status === 'broken' && connection.last_error && (
        <p className='flex items-start gap-1.5 text-[11.5px] text-red-700 dark:text-red-400'>
          <CircleAlert className='mt-px h-3.5 w-3.5 shrink-0' />
          <span>
            The last call to GitLab failed ({connection.last_error}). Fix the address or token
            below, then Test connection.
          </span>
        </p>
      )}
      {connection.is_active && silent && (
        <p className='flex items-start gap-1.5 text-[11.5px] text-amber-800 dark:text-amber-300'>
          <TriangleAlert className='mt-px h-3.5 w-3.5 shrink-0' />
          Webhook not seen in 24 h — syncing by polling. Set up the webhook below for changes to
          arrive right away.
        </p>
      )}
    </section>
  )
}
