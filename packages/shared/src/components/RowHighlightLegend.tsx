import { useQueries } from '@tanstack/react-query'
import { useNivaroClient } from '../context'
import { get } from '../lib/commands'
import { ROW_HIGHLIGHT_TINTS } from '../lib/row-highlight'
import { cn } from '../lib/utils'

// Legend for at-risk row tinting — one swatch per active highlight rule so
// users know what each row background color means. Renders nothing when the
// collection(s) have no active rules. Shared by CollectionBrowserView and
// QueueWorklist (multi-collection queues pass every source collection).

interface ActiveRule {
  id: number
  name: string
  highlight_color: string
}

export interface LegendRule {
  /** Every rule id behind this swatch (same name on several source collections). */
  ids: number[]
  name: string
  highlight_color: string
}

export function RowHighlightLegend({
  collections,
  className,
  selectedIds,
  onToggle
}: {
  collections: string[]
  className?: string
  /** Rule ids currently used as a filter — those swatches render pressed. */
  selectedIds?: number[]
  /** When given, each swatch is a toggle: click = filter the list to rows that rule highlights. */
  onToggle?: (rule: LegendRule) => void
}) {
  const client = useNivaroClient()
  const results = useQueries({
    queries: collections.map((collection) => ({
      queryKey: ['row-highlight-rules', collection],
      queryFn: () =>
        client
          .request<{ data: ActiveRule[] }>(get('/at-risk/rules/active', { collection }))
          .then((r) => r.data ?? [])
          .catch(() => [] as ActiveRule[]),
      staleTime: 60_000,
      retry: false,
      enabled: !!collection
    }))
  })

  // Dedupe by name+color — a multi-collection queue may carry the same rule
  // name on several collections.
  const byKey = new Map<string, LegendRule>()
  for (const res of results) {
    for (const rule of res.data ?? []) {
      const key = `${rule.name}|${rule.highlight_color}`
      const entry = byKey.get(key)
      if (entry) entry.ids.push(rule.id)
      else
        byKey.set(key, { ids: [rule.id], name: rule.name, highlight_color: rule.highlight_color })
    }
  }
  const rules = [...byKey.values()]
  if (rules.length === 0) return null
  const selected = new Set(selectedIds ?? [])

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400',
        className
      )}
    >
      <span className='font-medium'>Row colors:</span>
      {rules.map((rule) => {
        const tint = ROW_HIGHLIGHT_TINTS[rule.highlight_color] ?? ROW_HIGHLIGHT_TINTS.red
        const swatch = (
          <span
            aria-hidden
            className={cn(
              'h-2.5 w-2.5 rounded-[3px] border border-slate-300 dark:border-slate-600',
              tint.row
            )}
          />
        )
        if (!onToggle)
          return (
            <span key={rule.name} className='inline-flex items-center gap-1.5'>
              {swatch}
              {rule.name}
            </span>
          )
        const on = rule.ids.some((id) => selected.has(id))
        return (
          <button
            key={rule.name}
            type='button'
            onClick={() => onToggle(rule)}
            aria-pressed={on}
            data-row-highlight-toggle={rule.ids.join(',')}
            title={
              on ? 'Showing only these rows — click to show all' : `Show only rows ${rule.name}`
            }
            className={cn(
              'inline-flex h-6 items-center gap-1.5 rounded-full border px-2 transition-colors',
              on
                ? 'border-slate-400 bg-slate-100 font-medium text-slate-900 dark:border-slate-500 dark:bg-slate-700 dark:text-slate-100'
                : 'border-transparent hover:border-slate-300 hover:bg-slate-50 dark:hover:border-slate-600 dark:hover:bg-slate-800'
            )}
          >
            {swatch}
            {rule.name}
          </button>
        )
      })}
    </div>
  )
}
