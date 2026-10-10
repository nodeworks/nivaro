/**
 * Tabs of the Session Replays page. The page shows the person / session list
 * by default; every other view is a tab here, kept in ?tab= so it survives a
 * reload and can be linked. Add a view by adding an entry.
 */
import { useSearchParams } from 'react-router'
import { cn } from '@/lib/utils'
import { wantsSearchTab } from './search-logic'

export const REPLAY_TABS = [
  { key: 'list', label: 'Sessions' },
  { key: 'search', label: 'Search' },
  { key: 'library', label: 'Library' }
] as const

export type ReplayTab = (typeof REPLAY_TABS)[number]['key']

export function useReplayTab(): [ReplayTab, (t: ReplayTab) => void] {
  const [params, setParams] = useSearchParams()
  // A search link (?collection=&item=, ?field=…) opens Search without ?tab=.
  const raw = params.get('tab') ?? (wantsSearchTab(params) ? 'search' : null)
  const tab = (REPLAY_TABS.find((t) => t.key === raw)?.key ?? 'list') as ReplayTab
  const set = (t: ReplayTab) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('tab')
        // Leaving Search keeps its criteria in the URL, so say list outright.
        if (t !== 'list' || wantsSearchTab(next)) next.set('tab', t)
        return next
      },
      { replace: true }
    )
  return [tab, set]
}

export function ReplayTabs({
  tab,
  onChange
}: {
  tab: ReplayTab
  onChange: (t: ReplayTab) => void
}) {
  return (
    <div role='tablist' aria-label='Session replay views' className='-mb-4 mt-3 flex gap-4'>
      {REPLAY_TABS.map((t) => (
        <button
          key={t.key}
          type='button'
          role='tab'
          aria-selected={tab === t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            'border-b-2 pb-2 text-[12.5px]',
            tab === t.key
              ? 'border-nvr-cyan font-medium text-slate-900 dark:text-foreground'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
