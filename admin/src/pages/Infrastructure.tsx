import { Container } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { cn } from '@/lib/utils'
import { INFRA_TABS } from './infrastructure/tabs'

/**
 * Infrastructure — Docker hosts, stacks and containers, the proxy, host health and recovery, read
 * from a read-only Docker socket proxy (DOCKER_HOSTS) and the telemetry store. Administrators only.
 */
export function InfrastructurePage() {
  const [params, setParams] = useSearchParams()
  const tab = INFRA_TABS.find((t) => t.id === params.get('tab')) ?? INFRA_TABS[0]
  const setTab = (id: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p)
        if (id === INFRA_TABS[0].id) next.delete('tab')
        else next.set('tab', id)
        return next
      },
      { replace: true }
    )
  const Body = tab.component
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex h-9 w-9 items-center justify-center rounded-lg bg-nvr-cyan/15'>
          <Container className='h-4.5 w-4.5 text-nvr-navy dark:text-nvr-cyan' />
        </div>
        <div>
          <h1 className='text-base font-semibold'>Infrastructure</h1>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Docker hosts, stacks and containers, the proxy, and host health — read only.
          </p>
        </div>
      </header>
      <div
        role='tablist'
        aria-label='Infrastructure views'
        className='flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-white px-4 dark:border-border dark:bg-card'
      >
        {INFRA_TABS.map((t) => (
          <button
            key={t.id}
            type='button'
            role='tab'
            aria-selected={tab.id === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
              tab.id === t.id
                ? 'border-nvr-cyan text-slate-900 dark:text-foreground'
                : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        <Body />
      </div>
    </div>
  )
}
