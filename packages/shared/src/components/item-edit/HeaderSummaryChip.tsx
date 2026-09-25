import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import {
  HEADER_LABEL,
  HEADER_SUB,
  HEADER_TILE,
  HEADER_VALUE_HERO,
  HEADER_VALUE_LINE
} from '../../lib/header-strip'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

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
  /** How a contributing row is named in the list: "Line {{line_number}} · {{item_description}}". */
  row_label?: string
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
  items?: Array<{ id: string; value: number; label: string }>
  child_collection: string
  fk_field: string
}

export function HeaderSummaryChip({ collection, itemId, field, config, onOpen }: Props) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  // A grid WRITE on this record refreshes the figure: a rows query of this
  // record REFETCHING (dataUpdateCount > 1 — its first load is not a write,
  // and another record's tab landing rows is not this record). The old tick
  // rode the query key and minted a fresh cache entry per grid load.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = qc.getQueryCache().subscribe((ev) => {
      if (ev.type !== 'updated' || ev.action?.type !== 'success') return
      const key = ev.query.queryKey
      const head = key?.[0]
      if (typeof head !== 'string' || (!head.startsWith('o2m-rows') && !head.startsWith('nested')))
        return
      if (ev.query.state.dataUpdateCount <= 1) return
      if (head.startsWith('o2m-rows') && String(key[3]) !== String(itemId)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(
        () => void qc.invalidateQueries({ queryKey: ['child-summary', collection, itemId] }),
        400
      )
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [qc, collection, itemId])

  const { data, isLoading } = useQuery<Summary>({
    queryKey: ['child-summary', collection, itemId, field, config.formula, config.positive_only],
    queryFn: () =>
      client
        .request<{ data: Summary }>(
          post(`/items/${collection}/${itemId}/child-summary`, {
            field,
            formula: config.formula,
            positive_only: config.positive_only !== false,
            row_label: config.row_label
          })
        )
        .then((r) => r.data),
    enabled: !!itemId && itemId !== 'new',
    staleTime: 30_000,
    placeholderData: (prev) => prev
  })

  // Hooks stay ABOVE the early returns — a chip that flips from "nothing to
  // show" to "has rows" (a line lands, the summary refetches) would otherwise
  // render one more hook than the previous pass ('Rendered fewer hooks').
  const [open, setOpen] = useState(false)
  if (!data && !isLoading) return null
  if (data && data.count === 0 && config.hide_when_zero !== false) return null
  const value = data
    ? config.format === 'number'
      ? data.total.toLocaleString('en-US', { maximumFractionDigits: 2 })
      : data.total.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    : '—'
  const countLabel = config.count_label ?? 'rows'
  const canOpen = !!data?.first_id
  const fmt = (n: number) =>
    config.format === 'number'
      ? n.toLocaleString('en-US', { maximumFractionDigits: 2 })
      : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  const openRow = (rowId: string) => {
    if (!data) return
    setOpen(false)
    onOpen({ childCollection: data.child_collection, fkField: data.fk_field, rowId, field })
  }
  const items = data?.items ?? []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={!canOpen}
          className={cn(
            HEADER_TILE,
            'text-left',
            canOpen
              ? 'cursor-pointer'
              : 'cursor-default hover:bg-transparent dark:hover:bg-transparent'
          )}
          data-tip={canOpen ? `Which ${countLabel} contribute` : undefined}
          data-header-summary={field}
          data-header-money=''
        >
          <span className={HEADER_LABEL} data-header-label>
            {config.label}
          </span>
          <span className={`${HEADER_VALUE_LINE} items-baseline`} data-header-value>
            <span className={cn(HEADER_VALUE_HERO, isLoading && !data && 'text-slate-300')}>
              {value}
            </span>
            {data && (
              <span className={HEADER_SUB}>
                across {data.count} {data.count === 1 ? countLabel.replace(/s$/, '') : countLabel}
              </span>
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[360px] p-2 text-[11.5px]'>
        <p className='mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
          {config.label} — {data?.count ?? 0} {countLabel}
        </p>
        <div className='max-h-[260px] space-y-px overflow-y-auto'>
          {items.map((it) => (
            <button
              key={it.id}
              type='button'
              onClick={() => openRow(it.id)}
              className='flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-slate-50 dark:hover:bg-muted'
              data-tip='Open this line'
            >
              <span className='min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200'>
                {it.label}
              </span>
              <span className='shrink-0 font-mono tabular-nums text-slate-900 dark:text-slate-100'>
                {fmt(it.value)}
              </span>
            </button>
          ))}
          {data && data.count > items.length && (
            <p className='px-1.5 py-1 text-[10.5px] text-slate-400'>
              +{data.count - items.length} more
            </p>
          )}
        </div>
        {data && (
          <p className='border-t border-slate-100 px-1.5 pt-1.5 text-right font-medium text-slate-700 dark:border-border dark:text-slate-200'>
            {fmt(data.total)}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
