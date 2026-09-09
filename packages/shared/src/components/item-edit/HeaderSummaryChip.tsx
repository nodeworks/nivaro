import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { post } from '../../lib/commands'
import { useNivaroClient } from '../../context'
import { cn } from '../../lib/utils'

/**
 * A number over a record's child rows, shown in the item header: "Unallocated
 * $1,240 · across 3 lines". Config lives on the inline-table field as
 * `options.header_summary` (layout-local): a formula evaluated per child row
 * on the server (`item.amount - item.allocated_total`), summed over rows where
 * it is positive (or all rows with `positive_only: false`). Clicking opens the
 * first contributing row in its grid.
 */
export interface HeaderSummaryConfig {
  label: string
  formula: string
  format?: 'currency' | 'number'
  positive_only?: boolean
  /** "lines" → "across 3 lines" */
  count_label?: string
  /** Hide the chip when nothing contributes (default true). */
  hide_when_zero?: boolean
}

interface Props {
  collection: string
  itemId: string
  field: string
  config: HeaderSummaryConfig
  onOpen: (target: {
    childCollection: string
    fkField: string
    rowId: string
    field: string
  }) => void
}

interface Summary {
  total: number
  count: number
  rows: number
  first_id: string | null
  child_collection: string
  fk_field: string
}

export function HeaderSummaryChip({ collection, itemId, field, config, onOpen }: Props) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  // Any grid write on this record (rows query success) refreshes the figure.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = qc.getQueryCache().subscribe((ev) => {
      if (ev.type !== 'updated' || ev.action?.type !== 'success') return
      const head = ev.query.queryKey?.[0]
      if (typeof head !== 'string' || (!head.startsWith('o2m-rows') && !head.startsWith('nested')))
        return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setTick((n) => n + 1), 400)
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [qc])

  const { data, isLoading } = useQuery<Summary>({
    queryKey: [
      'child-summary',
      collection,
      itemId,
      field,
      config.formula,
      config.positive_only,
      tick
    ],
    queryFn: () =>
      client
        .request<{ data: Summary }>(
          post(`/items/${collection}/${itemId}/child-summary`, {
            field,
            formula: config.formula,
            positive_only: config.positive_only !== false
          })
        )
        .then((r) => r.data),
    enabled: !!itemId && itemId !== 'new',
    staleTime: 30_000,
    placeholderData: (prev) => prev
  })

  if (!data && !isLoading) return null
  if (data && data.count === 0 && config.hide_when_zero !== false) return null
  const value = data
    ? config.format === 'number'
      ? data.total.toLocaleString('en-US', { maximumFractionDigits: 2 })
      : data.total.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    : '—'
  const countLabel = config.count_label ?? 'rows'
  const canOpen = !!data?.first_id
  return (
    <button
      type='button'
      disabled={!canOpen}
      onClick={() =>
        data?.first_id &&
        onOpen({
          childCollection: data.child_collection,
          fkField: data.fk_field,
          rowId: data.first_id,
          field
        })
      }
      className={cn(
        'group relative flex flex-col justify-start border-r border-slate-200 px-4 py-2 text-left min-w-0 transition-colors dark:border-border',
        canOpen ? 'cursor-pointer hover:bg-white/60 dark:hover:bg-white/[0.025]' : 'cursor-default'
      )}
      data-tip={
        canOpen ? `Open the first ${countLabel.replace(/s$/, '')} that contributes` : undefined
      }
      data-header-summary={field}
    >
      <span className='flex h-4 items-end truncate text-[10px] font-medium leading-none text-slate-400 dark:text-slate-500'>
        {config.label}
      </span>
      <span
        className={cn(
          'mt-1 text-[13px] font-semibold tabular-nums leading-none',
          isLoading && !data && 'text-slate-300'
        )}
      >
        {value}
      </span>
      {data && (
        <span className='mt-1 text-[10.5px] leading-none text-slate-500 dark:text-slate-400'>
          across {data.count} {data.count === 1 ? countLabel.replace(/s$/, '') : countLabel}
        </span>
      )}
    </button>
  )
}
