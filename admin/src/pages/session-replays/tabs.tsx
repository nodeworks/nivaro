/**
 * Tabs of the Session Replays page. The page shows the person / session list
 * by default; every other view is a tab here, kept in ?tab= so it survives a
 * reload and can be linked. Add a view by adding an entry.
 */
import { useSearchParams } from 'react-router'
import { wantsSearchTab } from './search-logic'

export const REPLAY_TABS = [
  { key: 'list', label: 'Sessions' },
  { key: 'search', label: 'Search' },
  { key: 'library', label: 'Library' },
  { key: 'heat', label: 'Heat' },
  { key: 'worst', label: 'Worst sessions' }
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
