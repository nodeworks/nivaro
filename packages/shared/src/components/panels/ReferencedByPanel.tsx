import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Network } from 'lucide-react'
import { useState } from 'react'
import { useDrilldown, useItemNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'

/**
 * Referenced by (#644) — which records point AT this one, per M2O relation:
 * "12 workflows · via project" with up to 5 sample links. Server:
 * GET /referenced-by/:collection/:id (junctions + nivaro_* excluded, count
 * desc, non-zero only). Renders nothing while there is nothing to show.
 */

interface ReferencedByEntry {
  collection: string
  display_name: string | null
  field: string
  count: number
  samples: Array<{ id: string; label: string }>
}

export function ReferencedByPanel({
  collection,
  itemId,
  title,
  defaultExpanded = true
}: {
  collection: string
  itemId: string
  /** Layout-slot label override (#644 slot). */
  title?: string
  defaultExpanded?: boolean
}) {
  const client = useNivaroClient()
  const { open: openItem } = useItemNavigation()
  // Inside a record page a drill-down sheet host is present — open samples in
  // the detail sheet (record stays put) instead of navigating away. Hosts
  // without one keep the navigation fallback.
  const drill = useDrilldown()
  const [expanded, setExpanded] = useState(defaultExpanded)

  const { data: refs = [] } = useQuery({
    queryKey: ['referenced-by', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: ReferencedByEntry[] }>(
          get(`/referenced-by/${collection}/${encodeURIComponent(itemId)}`)
        )
        .then((r) => r.data ?? [])
        .catch(() => [] as ReferencedByEntry[]),
    enabled: !!itemId,
    staleTime: 60_000
  })

  if (refs.length === 0) return null

  const totalRefs = refs.reduce((sum, r) => sum + r.count, 0)

  return (
    <div
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-referenced-by-panel
    >
      <button
        type='button'
        onClick={() => setExpanded((e) => !e)}
        className='flex w-full items-center gap-2 px-3 py-2 text-left'
      >
        {expanded ? (
          <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        ) : (
          <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        )}
        <Network className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        <span className='text-[12.5px] font-semibold text-slate-700 dark:text-slate-200'>
          {title ?? 'Referenced by'}
        </span>
        <span className='ml-auto rounded-full bg-nvr-cyan/10 px-1.5 py-px text-[10.5px] font-semibold text-nvr-navy tabular-nums dark:text-nvr-cyan'>
          {totalRefs}
        </span>
      </button>
      {expanded && (
        <div className='border-t border-slate-100 px-3 pb-2.5 pt-1.5 dark:border-border/60'>
          {refs.map((r) => (
            <div
              key={`${r.collection}.${r.field}`}
              className='border-b border-slate-100 py-1.5 last:border-0 dark:border-border/60'
            >
              <p className='text-[12px] text-slate-700 dark:text-slate-300'>
                <span className='font-semibold tabular-nums'>{r.count}</span>{' '}
                {r.display_name ?? r.collection}
                <span className='text-slate-400'> · via {r.field}</span>
              </p>
              {r.samples.length > 0 && (
                <div className='mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5'>
                  {r.samples.map((s) => (
                    <button
                      key={s.id}
                      type='button'
                      onClick={() =>
                        drill
                          ? drill.open({ collection: r.collection, itemId: s.id })
                          : openItem({ collection: r.collection, itemId: s.id })
                      }
                      className='max-w-[220px] truncate text-[11.5px] text-nvr-navy underline decoration-nvr-cyan/50 underline-offset-2 hover:decoration-nvr-cyan dark:text-nvr-cyan'
                      title={s.label}
                    >
                      {s.label.trim() || `#${s.id}`}
                    </button>
                  ))}
                  {r.count > r.samples.length && (
                    <span className='text-[11px] text-slate-400'>
                      +{r.count - r.samples.length} more
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
