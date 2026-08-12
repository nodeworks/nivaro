import { useQueries } from '@tanstack/react-query'
import { useNivaroClient } from '../context'
import { get } from '../lib/commands'
import { cn } from '../lib/utils'
import { ROW_HIGHLIGHT_TINTS } from '../lib/row-highlight'

// Legend for at-risk row tinting — one swatch per active highlight rule so
// users know what each row background color means. Renders nothing when the
// collection(s) have no active rules. Shared by CollectionBrowserView and
// QueueWorklist (multi-collection queues pass every source collection).

interface ActiveRule {
  id: number
  name: string
  highlight_color: string
}

export function RowHighlightLegend({
  collections,
  className
}: {
  collections: string[]
  className?: string
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
  const seen = new Set<string>()
  const rules: ActiveRule[] = []
  for (const res of results) {
    for (const rule of res.data ?? []) {
      const key = `${rule.name}|${rule.highlight_color}`
      if (seen.has(key)) continue
      seen.add(key)
      rules.push(rule)
    }
  }
  if (rules.length === 0) return null

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
        return (
          <span key={`${rule.id}-${rule.name}`} className='inline-flex items-center gap-1.5'>
            <span
              aria-hidden
              className={cn(
                'h-2.5 w-2.5 rounded-[3px] border border-slate-300 dark:border-slate-600',
                tint.row
              )}
            />
            {rule.name}
          </span>
        )
      })}
    </div>
  )
}
