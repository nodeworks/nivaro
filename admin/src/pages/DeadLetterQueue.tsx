import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type DeadLetter = {
  id: string
  function: string
  event: string
  error: string
  payload: Record<string, unknown> | null
  failed_at: string | null
  retry_count: number
  source: 'flow-run' | 'inngest'
}

const ERROR_TRUNCATE_AT = 100

// ─── Row ──────────────────────────────────────────────────────────────────────

function DeadLetterRow({ letter }: { letter: DeadLetter }) {
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)

  const retryMut = useMutation({
    mutationFn: () => api.post(`/dead-letters/${letter.id}/retry`),
    onSuccess: () => {
      toast.success(`Retry queued for ${letter.function}`)
      queryClient.invalidateQueries({ queryKey: ['dead-letters'] })
    },
    onError: (err) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Retry failed')
    }
  })

  const isLongError = letter.error.length > ERROR_TRUNCATE_AT

  return (
    <>
      <tr
        className={cn(
          'cursor-pointer bg-white transition-colors hover:bg-slate-50 dark:bg-card dark:hover:bg-muted/40',
          expanded && 'bg-slate-50 dark:bg-muted/40'
        )}
        onClick={() => setExpanded((e) => !e)}
      >
        <td className='px-4 py-3'>
          <div className='flex items-center gap-2'>
            {expanded ? (
              <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
            ) : (
              <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' />
            )}
            <span className='truncate text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
              {letter.function}
            </span>
          </div>
        </td>
        <td className='px-4 py-3'>
          <code className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
            {letter.event}
          </code>
        </td>
        <td className='max-w-[320px] px-4 py-3'>
          <span className='line-clamp-1 break-all font-mono text-[11px] text-red-500'>
            {isLongError && !expanded
              ? `${letter.error.slice(0, ERROR_TRUNCATE_AT)}…`
              : letter.error}
          </span>
        </td>
        <td className='whitespace-nowrap px-4 py-3 text-[11.5px] text-slate-400'>
          {letter.failed_at ? formatRelative(letter.failed_at) : '—'}
        </td>
        <td className='px-4 py-3 text-center'>
          <span className='font-mono text-[11.5px] tabular-nums text-slate-500'>
            {letter.retry_count}
          </span>
        </td>
        <td className='px-4 py-3 text-right'>
          <Button
            size='sm'
            variant='outline'
            className='h-6 gap-1.5 text-[11px]'
            disabled={retryMut.isPending}
            onClick={(e) => {
              e.stopPropagation()
              retryMut.mutate()
            }}
          >
            <RotateCcw className={cn('h-3 w-3', retryMut.isPending && 'animate-spin')} />
            {retryMut.isPending ? 'Retrying…' : 'Retry'}
          </Button>
        </td>
      </tr>
      {expanded && (
        <tr className='bg-slate-50/70 dark:bg-muted/30'>
          <td colSpan={6} className='px-6 pb-4 pt-1'>
            <div className='space-y-2.5'>
              <div>
                <p className='mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
                  Error
                </p>
                <pre className='max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-red-50 p-3 font-mono text-[11px] text-red-700 dark:bg-red-950/30 dark:text-red-400'>
                  {letter.error}
                </pre>
              </div>
              {letter.payload && (
                <div>
                  <p className='mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
                    Payload
                  </p>
                  <pre className='max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] text-slate-100'>
                    {JSON.stringify(letter.payload, null, 2)}
                  </pre>
                </div>
              )}
              <div className='flex items-center gap-3 text-[11px] text-slate-400'>
                <span>
                  Run ID: <code className='font-mono'>{letter.id}</code>
                </span>
                <Badge variant='secondary' className='text-[10px]'>
                  {letter.source === 'flow-run' ? 'flow run' : 'inngest'}
                </Badge>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function DeadLetterQueuePage() {
  const queryClient = useQueryClient()

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['dead-letters'],
    queryFn: () =>
      api.get<{ data: DeadLetter[]; error?: string }>('/dead-letters').then((r) => r.data),
    refetchInterval: 30_000
  })

  const letters = data?.data ?? []

  const retryAllMut = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(
        letters.map((l) => api.post(`/dead-letters/${l.id}/retry`))
      )
      return results.filter((r) => r.status === 'fulfilled').length
    },
    onSuccess: (count) => {
      toast.success(
        `Retried ${count} of ${letters.length} failed job${letters.length !== 1 ? 's' : ''}`
      )
      queryClient.invalidateQueries({ queryKey: ['dead-letters'] })
    },
    onError: () => toast.error('Retry all failed')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Dead Letter Queue
            </h1>
            {data && (
              <span
                className={cn(
                  'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold',
                  letters.length > 0
                    ? 'bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-400'
                    : 'bg-slate-100 text-slate-500 dark:bg-muted dark:text-muted-foreground'
                )}
              >
                {letters.length}
              </span>
            )}
            {isFetching && !isLoading && (
              <span className='text-[11px] text-slate-400'>refreshing…</span>
            )}
          </div>
          {letters.length > 0 && (
            <Button
              size='sm'
              variant='outline'
              className='gap-1.5'
              disabled={retryAllMut.isPending}
              onClick={() => retryAllMut.mutate()}
            >
              <RotateCcw className={cn('h-3.5 w-3.5', retryAllMut.isPending && 'animate-spin')} />
              {retryAllMut.isPending ? 'Retrying…' : 'Retry all'}
            </Button>
          )}
        </div>
      </div>

      <div className='flex-1 overflow-y-auto p-6'>
        {data?.error && (
          <div className='mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400'>
            <AlertCircle className='h-3.5 w-3.5 shrink-0' />
            Inngest API unreachable — showing flow-run failures only.
          </div>
        )}

        {isLoading ? (
          <div className='space-y-px overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
            {[1, 2, 3].map((k) => (
              <div key={k} className='flex items-center gap-4 bg-white px-4 py-3.5 dark:bg-card'>
                <Skeleton className='h-4 w-40' />
                <Skeleton className='h-4 w-24' />
                <Skeleton className='ml-auto h-4 w-32' />
              </div>
            ))}
          </div>
        ) : letters.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-24 text-center'>
            <CheckCircle2 className='mb-3 h-10 w-10 text-emerald-400' />
            <p className='text-[14px] font-medium text-slate-700 dark:text-foreground'>
              No failed jobs
            </p>
            <p className='mt-1 text-[12px] text-slate-400 dark:text-muted-foreground'>
              All background jobs and flow runs completed successfully.
            </p>
          </div>
        ) : (
          <div className='overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
            <table className='w-full text-[13px]'>
              <thead>
                <tr className='border-b border-slate-100 bg-slate-50 dark:border-border dark:bg-muted/30'>
                  <th className='px-4 py-2.5 text-left text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
                    Function
                  </th>
                  <th className='px-4 py-2.5 text-left text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
                    Event
                  </th>
                  <th className='px-4 py-2.5 text-left text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
                    Error
                  </th>
                  <th className='px-4 py-2.5 text-left text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
                    Failed
                  </th>
                  <th className='px-4 py-2.5 text-center text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
                    Retries
                  </th>
                  <th className='px-4 py-2.5 text-right text-[11px] font-medium text-slate-400 dark:text-muted-foreground' />
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100 dark:divide-border'>
                {letters.map((letter) => (
                  <DeadLetterRow key={`${letter.source}-${letter.id}`} letter={letter} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
