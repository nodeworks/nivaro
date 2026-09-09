import { Sigma } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { lineageSummary, useFieldLineage } from './FieldRow'

/**
 * "= 5 lines · 1 excluded (line type is not 4)" under a rollup header chip.
 * The summary is fetched once the chip is on screen (cheap: one lineage
 * read); the popover lists contributors, the excluded rows and per-source
 * subtotals so a total is never a mystery.
 */
export function HeaderRollupExplainer({
  collection,
  itemId,
  field,
  noun = 'lines'
}: {
  collection: string
  itemId: string
  field: string
  noun?: string
}) {
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useFieldLineage(collection, itemId, field, true)
  const summary = lineageSummary(data, noun)
  const num = (v: unknown): string =>
    v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (!summary && !isLoading) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-copy-skip
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'mt-0.5 inline-flex max-w-full items-center gap-1 truncate text-left text-[10.5px] leading-none text-slate-500 hover:text-nvr-cyan dark:text-slate-400',
            open && 'text-nvr-cyan'
          )}
          data-tip='Where this number comes from'
        >
          <Sigma className='h-2.5 w-2.5 shrink-0' aria-hidden='true' />
          <span className='truncate'>{summary ?? '…'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[380px] p-2 text-[11.5px]'
        onClick={(e) => e.stopPropagation()}
      >
        <p className='mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
          Where this number comes from
        </p>
        {(data?.sources ?? []).map((src, i) => (
          <div key={i} className='mb-1.5'>
            <p className='px-1 text-[10.5px] text-slate-400'>
              {(src.aggregate ?? 'sum').toUpperCase()}
              {src.value_field ? ` of ${src.value_field.replace(/_/g, ' ')}` : ''} across{' '}
              {src.collection.replace(/_/g, ' ')}
            </p>
            {src.note && <p className='px-1 py-1 text-slate-400'>{src.note}</p>}
            {src.error && <p className='px-1 py-1 text-amber-600'>{src.error}</p>}
            <div className='mt-0.5 max-h-[220px] space-y-px overflow-y-auto'>
              {src.rows.map((r) => (
                <div
                  key={r.id}
                  className='flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-slate-50 dark:hover:bg-muted'
                >
                  <span className='min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300'>
                    {r.label}
                  </span>
                  <span className='shrink-0 font-mono tabular-nums text-slate-800 dark:text-slate-100'>
                    {num(r.value)}
                  </span>
                </div>
              ))}
            </div>
            {src.subtotal != null && (
              <p className='border-t border-slate-100 px-1 pt-1 text-right font-medium text-slate-700 dark:border-border dark:text-slate-200'>
                subtotal {num(src.subtotal)}
              </p>
            )}
            {(src.excluded?.length ?? 0) > 0 && (
              <div className='mt-1 rounded bg-slate-50 px-1 py-1 dark:bg-muted/40'>
                <p className='text-[10.5px] text-slate-500 dark:text-muted-foreground'>
                  {src.excluded!.length} excluded —{' '}
                  {src.excluded![0].reason.replace(/^does not match: /, '')}
                </p>
                {src.excluded!.slice(0, 8).map((r) => (
                  <div
                    key={r.id}
                    className='flex items-baseline gap-2 px-0.5 text-[11px] text-slate-400'
                  >
                    <span className='min-w-0 flex-1 truncate line-through decoration-slate-300'>
                      {r.label}
                    </span>
                    <span className='shrink-0 font-mono tabular-nums'>{num(r.value)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {data?.stored_value != null && (
          <p className='px-1 pt-1 text-right text-[11px] text-slate-500'>
            stored {num(data.stored_value)}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
