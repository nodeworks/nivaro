import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCw, Satellite } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

type Provider = {
  id: string
  collection: string
  label: string
  can_list: boolean
  can_replay: boolean
}
type Entry = {
  id: string | number
  label: string
  text: string
  user?: string | null
  created_at: string
  context?: string | null
  collection: string
  item_id: string
  item_label?: string | null
  provider: string
  replayable?: boolean
  status?: 'ok' | 'error' | 'info' | null
}

const STATUS_DOT: Record<string, string> = {
  ok: 'bg-emerald-500',
  error: 'bg-red-500',
  info: 'bg-slate-400'
}

// #20 — every integration event the notes sources know about, newest first,
// with the replay each provider offers.
export function IntegrationEventsPage() {
  const queryClient = useQueryClient()
  const [provider, setProvider] = useState<string>('')
  const [status, setStatus] = useState<string>('')
  const [armed, setArmed] = useState<string | null>(null)
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['integration-events', provider, status],
    queryFn: () =>
      api
        .get<{ data: { providers: Provider[]; entries: Entry[] } }>('/integration-events', {
          params: { provider: provider || undefined, status: status || undefined, limit: 200 }
        })
        .then((r) => r.data.data),
    refetchInterval: 60_000
  })
  const replay = useMutation({
    mutationFn: (e: Entry) =>
      api
        .post<{ data: { detail: string } }>(
          `/integration-events/${encodeURIComponent(e.provider)}/replay`,
          {
            entry_id: String(e.id)
          }
        )
        .then((r) => r.data.data),
    onSuccess: (d) => {
      setArmed(null)
      toast.success('Event replayed', { description: d.detail })
      queryClient.invalidateQueries({ queryKey: ['integration-events'] })
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      setArmed(null)
      toast.error(err.response?.data?.error ?? 'Replay failed', { duration: 8000 })
    }
  })
  const providers = data?.providers ?? []
  const entries = data?.entries ?? []

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-center gap-3'>
          <div>
            <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Integration Events
            </h1>
            <p className='mt-0.5 text-[12px] text-slate-400 dark:text-muted-foreground'>
              What the integrations reported, across every record. Replay re-applies an event from
              its stored payload.
            </p>
          </div>
          <div className='ml-auto flex items-center gap-2'>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className='h-8 rounded-md border border-slate-200 bg-white px-2 text-[12.5px] dark:border-border dark:bg-background'
              aria-label='Source'
              data-integration-events-provider
            >
              <option value=''>All sources</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className='h-8 rounded-md border border-slate-200 bg-white px-2 text-[12.5px] dark:border-border dark:bg-background'
              aria-label='Status'
            >
              <option value=''>Any status</option>
              <option value='ok'>OK</option>
              <option value='error'>Errors</option>
              <option value='info'>Info</option>
            </select>
            <Button
              size='sm'
              variant='outline'
              className='h-8'
              onClick={() => queryClient.invalidateQueries({ queryKey: ['integration-events'] })}
            >
              <RotateCw className={cn('mr-1.5 h-3.5 w-3.5', isFetching && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
      </header>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        {isLoading ? (
          <div className='space-y-2'>
            {[1, 2, 3, 4].map((k) => (
              <Skeleton key={k} className='h-10 rounded-lg' />
            ))}
          </div>
        ) : providers.length === 0 ? (
          <div className='rounded-lg border border-dashed border-slate-200 bg-white px-6 py-12 text-center dark:border-border dark:bg-card'>
            <Satellite className='mx-auto h-6 w-6 text-slate-300' />
            <p className='mt-2 text-[13px] text-slate-500'>
              No integration registers an event source.
            </p>
            <p className='mt-1 text-[11.5px] text-slate-400'>
              Extensions register one with{' '}
              <code className='font-mono'>ctx.notes.registerSource</code> and a{' '}
              <code className='font-mono'>list</code> function.
            </p>
          </div>
        ) : entries.length === 0 ? (
          <div className='rounded-lg border border-slate-200 bg-white px-6 py-10 text-center dark:border-border dark:bg-card'>
            <p className='text-[13px] text-slate-400'>No events match.</p>
          </div>
        ) : (
          <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
            <table className='w-full text-[12px]'>
              <thead className='bg-slate-50 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:bg-muted/40'>
                <tr>
                  <th className='px-3 py-2 font-medium'>When</th>
                  <th className='px-3 py-2 font-medium'>Source</th>
                  <th className='px-3 py-2 font-medium'>Record</th>
                  <th className='px-3 py-2 font-medium'>Event</th>
                  <th className='px-3 py-2 font-medium' />
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100 dark:divide-border'>
                {entries.map((e) => {
                  const key = `${e.provider}:${e.id}`
                  return (
                    <tr
                      key={key}
                      data-integration-event={key}
                      data-integration-event-status={e.status ?? ''}
                    >
                      <td
                        className='whitespace-nowrap px-3 py-2 text-slate-500'
                        data-tip={new Date(e.created_at).toLocaleString()}
                      >
                        {formatRelative(e.created_at)}
                      </td>
                      <td className='whitespace-nowrap px-3 py-2'>
                        <span className='inline-flex items-center gap-1.5'>
                          <span
                            className={cn(
                              'h-1.5 w-1.5 rounded-full',
                              STATUS_DOT[e.status ?? 'info']
                            )}
                          />
                          {e.label}
                        </span>
                      </td>
                      <td className='whitespace-nowrap px-3 py-2'>
                        {e.item_id ? (
                          <Link
                            to={`/collections/${e.collection}/${e.item_id}`}
                            className='font-mono text-sky-700 hover:underline dark:text-sky-300'
                          >
                            {e.item_label ?? `${e.collection}/${e.item_id}`}
                          </Link>
                        ) : (
                          <span className='text-slate-400'>—</span>
                        )}
                      </td>
                      <td className='px-3 py-2 text-slate-700 dark:text-foreground'>
                        {e.text}
                        {e.context && <span className='ml-1.5 text-slate-400'>· {e.context}</span>}
                      </td>
                      <td className='whitespace-nowrap px-3 py-2 text-right'>
                        {e.replayable && (
                          <button
                            type='button'
                            data-integration-event-replay={key}
                            disabled={replay.isPending}
                            onClick={() => (armed === key ? replay.mutate(e) : setArmed(key))}
                            onBlur={() => setArmed((a) => (a === key ? null : a))}
                            className={cn(
                              'rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-colors',
                              armed === key
                                ? 'bg-sky-600 text-white'
                                : 'text-sky-700 hover:bg-sky-50 dark:text-sky-300 dark:hover:bg-sky-900/20'
                            )}
                          >
                            {replay.isPending && armed === key
                              ? 'Replaying…'
                              : armed === key
                                ? 'Replay this event?'
                                : 'Replay'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
