import { Container } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { InfraTabNav, PANEL_ID, tabDomId } from './infrastructure/TabNav'
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
      <header className='flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6 sm:py-4 dark:border-border dark:bg-card'>
        <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-nvr-cyan/15'>
          <Container className='h-4.5 w-4.5 text-nvr-navy dark:text-nvr-cyan' />
        </div>
        <div className='min-w-0'>
          <h1 className='text-base font-semibold'>Infrastructure</h1>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Docker hosts, stacks and containers, the proxy, and host health — read only.
          </p>
        </div>
      </header>
      <InfraTabNav active={tab} onSelect={setTab} />
      <div
        id={PANEL_ID}
        role='tabpanel'
        aria-labelledby={tabDomId(tab.id)}
        className='flex-1 overflow-y-auto bg-slate-50 px-4 py-5 sm:p-6 dark:bg-background'
      >
        <Body key={tab.id} />
      </div>
    </div>
  )
}
