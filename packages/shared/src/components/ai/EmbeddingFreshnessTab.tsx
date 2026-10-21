import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'

/**
 * How current the embeddings behind search by meaning are (#2482), per
 * collection: records changed since they were embedded, the oldest change still
 * waiting, and whether a provider switch still needs a reindex.
 */

interface Row {
  collection: string
  display_name: string | null
  fields: string[]
  records: number
  embedded_records: number
  embedded_rows: number
  lag_records: number
  oldest_lag_at: string | null
  last_embedded_at: string | null
  other_provider_rows: number
  untagged_rows: number
  status: 'empty' | 'fresh' | 'lagging' | 'needs_reindex'
  warn: boolean
  reason: string | null
}

const STATUS_LABEL: Record<Row['status'], string> = {
  empty: 'Nothing to embed',
  fresh: 'Up to date',
  lagging: 'Behind',
  needs_reindex: 'Needs a reindex'
}

const ago = (iso: string | null): string => {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return 'under an hour'
  if (h < 48) return `${h} h`
  return `${Math.floor(h / 24)} days`
}

const errMsg = (e: unknown, fallback: string) => (e as { message?: string })?.message || fallback

export function EmbeddingFreshnessTab() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['nvr-ai-embedding-freshness'],
    queryFn: () =>
      client.request<{ data: { provider: string; collections: Row[]; warnings: number } }>(
        get('/search/freshness')
      )
  })
  const reindex = useMutation({
    mutationFn: ({ collection, force }: { collection: string; force: boolean }) => {
      setBusy(collection)
      return client.request<{ indexed: number }>(
        post(`/search/reindex/${encodeURIComponent(collection)}${force ? '?force=1' : ''}`)
      )
    },
    onSuccess: (r, v) => {
      toast.success(`${v.collection}: ${r.indexed} embedding${r.indexed === 1 ? '' : 's'} written`)
      void qc.invalidateQueries({ queryKey: ['nvr-ai-embedding-freshness'] })
    },
    onError: (e) => toast.error(errMsg(e, 'Reindex failed')),
    onSettled: () => setBusy(null)
  })
  const d = q.data?.data
  return (
    <div className='flex flex-col gap-3' data-ai-embedding-freshness>
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          variant='outline'
          className='h-8 text-[12px]'
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
        >
          <RotateCw className={cn('h-3.5 w-3.5', q.isFetching && 'animate-spin')} />
          Refresh
        </Button>
        {d && (
          <span className='text-[11.5px] text-muted-foreground'>
            Embedding with <span className='font-mono'>{d.provider}</span>
            {d.warnings > 0 &&
              ` · ${d.warnings} collection${d.warnings === 1 ? '' : 's'} need attention`}
          </span>
        )}
      </div>
      <p className='max-w-[75ch] text-[11.5px] text-muted-foreground'>
        Search by meaning only finds records that have been embedded. A record counts as behind when
        it has no embedding yet or changed after its last one. Vectors from a different provider
        than the live one cannot be compared with new ones — switching provider needs a reindex.
      </p>
      {q.isLoading ? (
        <div className='h-24 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
      ) : q.isError ? (
        <div className='rounded-lg border border-red-200 p-4 text-[12.5px] text-red-700 dark:border-red-900 dark:text-red-300'>
          Could not read the index.{' '}
          <button type='button' className='underline' onClick={() => void q.refetch()}>
            Try again
          </button>
        </div>
      ) : !d?.collections.length ? (
        <div className='rounded-lg border border-dashed border-slate-300 p-8 text-center text-[12.5px] text-muted-foreground dark:border-border'>
          No collection has a text field that search by meaning can embed.
        </div>
      ) : (
        <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <table className='w-full min-w-[720px] text-[12px]'>
            <thead>
              <tr className='border-b border-slate-200 text-left text-muted-foreground dark:border-border'>
                <th className='px-3 py-2 font-medium'>Collection</th>
                <th className='px-3 py-2 text-right font-medium'>Records</th>
                <th className='px-3 py-2 text-right font-medium'>Embedded</th>
                <th className='px-3 py-2 text-right font-medium'>Behind</th>
                <th className='px-3 py-2 font-medium'>Oldest waiting</th>
                <th className='px-3 py-2 font-medium'>Status</th>
                <th className='px-3 py-2' />
              </tr>
            </thead>
            <tbody>
              {d.collections.map((r) => (
                <tr
                  key={r.collection}
                  className='border-b border-slate-100 last:border-0 dark:border-border/60'
                >
                  <td className='px-3 py-2'>
                    <div className='font-medium'>{r.display_name || r.collection}</div>
                    <div className='font-mono text-[11px] text-muted-foreground'>
                      {r.fields.join(', ') || 'no embeddable field'}
                    </div>
                  </td>
                  <td className='px-3 py-2 text-right tabular-nums'>
                    {r.records.toLocaleString()}
                  </td>
                  <td className='px-3 py-2 text-right tabular-nums'>
                    {r.embedded_records.toLocaleString()}
                  </td>
                  <td className='px-3 py-2 text-right tabular-nums'>
                    {r.lag_records.toLocaleString()}
                  </td>
                  <td className='px-3 py-2'>{r.lag_records ? ago(r.oldest_lag_at) : '—'}</td>
                  <td className='px-3 py-2'>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1',
                        r.warn && 'font-medium text-amber-700 dark:text-amber-300'
                      )}
                    >
                      {r.warn && <AlertTriangle className='h-3.5 w-3.5' />}
                      {STATUS_LABEL[r.status]}
                    </span>
                    {r.reason && (
                      <div className='text-[11px] text-muted-foreground'>{r.reason}</div>
                    )}
                    {r.untagged_rows > 0 && r.status !== 'needs_reindex' && (
                      <div className='text-[11px] text-muted-foreground'>
                        {r.untagged_rows} written before the provider was recorded
                      </div>
                    )}
                  </td>
                  <td className='px-3 py-2 text-right'>
                    <Button
                      size='sm'
                      variant={r.warn ? 'default' : 'outline'}
                      className='h-7 px-2 text-[11.5px]'
                      disabled={reindex.isPending || !r.fields.length}
                      data-tip={
                        r.status === 'needs_reindex'
                          ? 'Rebuilds every vector with the live provider'
                          : 'Embeds what is missing or changed'
                      }
                      onClick={() =>
                        reindex.mutate({
                          collection: r.collection,
                          force: r.status === 'needs_reindex'
                        })
                      }
                    >
                      {busy === r.collection ? 'Reindexing…' : 'Reindex'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
