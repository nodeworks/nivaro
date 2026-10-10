import { useSearchParams } from 'react-router'
import { cn } from '@/lib/utils'

/**
 * Tabs of the Session Replays page, kept in ?tab= so a view can be linked.
 * 'list' (the default) is the people rail and their recordings; the others
 * are views over many recordings at once. Add a tab here and render its
 * body in SessionReplays.tsx.
 */
export const REPLAY_TABS = [
  { id: 'list', label: 'Recordings' },
  { id: 'heat', label: 'Heat' }
] as const

export type ReplayTab = (typeof REPLAY_TABS)[number]['id']

export function useReplayTab(): [ReplayTab, (t: ReplayTab) => void] {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab = (REPLAY_TABS.find((t) => t.id === raw)?.id ?? 'list') as ReplayTab
  const setTab = (t: ReplayTab) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (t === 'list') next.delete('tab')
        else next.set('tab', t)
        return next
      },
      { replace: true }
    )
  return [tab, setTab]
}

export function ReplayTabBar({
  tab,
  onChange
}: {
  tab: ReplayTab
  onChange: (t: ReplayTab) => void
}) {
  return (
    <div
      role='tablist'
      aria-label='Session replay views'
      className='flex shrink-0 gap-1 border-b border-slate-200 bg-white px-8 dark:border-border dark:bg-card'
    >
      {REPLAY_TABS.map((t) => (
        <button
          key={t.id}
          type='button'
          role='tab'
          aria-selected={tab === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-[12.5px]',
            tab === t.id
              ? 'border-nvr-cyan font-semibold text-nvr-navy dark:text-nvr-cyan'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-foreground'
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
