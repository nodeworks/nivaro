import { type ReactNode, useState } from 'react'
import { cn } from '../../../lib/utils'
import { TipLayer } from '../../TipLayer'
import { useSignals } from './api'
import { FirefightView } from './FirefightView'
import { InboundView } from './InboundView'
import { PartnersView } from './PartnersView'
import { TONE_SOFT, TONE_TEXT } from './tone'

export interface ConsoleTab {
  key: string
  label: string
  render: () => ReactNode
}

export interface IntegrationsConsoleProps {
  /** Host tabs, inserted after Partners (e.g. a deployment's own integrations). */
  extraTabs?: ConsoleTab[]
  /** Controlled tab — pair with onTabChange to keep it in the URL. */
  tab?: string
  onTabChange?: (key: string) => void
  onOpenRecord?: (collection: string, id: string) => void
  /** Expand this Firefight signal on first load. */
  focusSignal?: string
  /** Host content rendered at the end of the Inbound tab (a deployment's own queues). */
  inboundExtra?: ReactNode
  className?: string
}

function NextPhase({ what }: { what: string }) {
  return (
    <div className='rounded-lg border border-dashed border-border bg-card px-5 py-6'>
      <p className='text-[14px] font-semibold text-foreground'>Coming in the next phase</p>
      <p className='mt-1 max-w-[70ch] text-[12.5px] text-muted-foreground'>{what}</p>
    </div>
  )
}

/**
 * The Integrations console: everything that talks to an outside system on one
 * page — live problems first (Firefight), then per-partner health. Hosts add
 * their own tabs through `extraTabs`.
 */
export function IntegrationsConsole({
  extraTabs = [],
  tab,
  onTabChange,
  onOpenRecord,
  focusSignal,
  inboundExtra,
  className
}: IntegrationsConsoleProps) {
  const [localTab, setLocalTab] = useState('firefight')
  const active = tab ?? localTab
  const [partnerId, setPartnerId] = useState<number | null>(null)
  const signals = useSignals()

  const go = (key: string) => {
    if (tab == null) setLocalTab(key)
    onTabChange?.(key)
  }

  const problems = (signals.data?.signals ?? []).filter((s) => !s.error)
  const openCount = problems.reduce((n, s) => n + s.count, 0)
  const critical = problems.some((s) => s.severity === 'critical' && s.count > 0)

  const tabs: ConsoleTab[] = [
    {
      key: 'firefight',
      label: 'Firefight',
      render: () => (
        <FirefightView
          onOpenRecord={onOpenRecord}
          focusSignal={focusSignal}
          onJumpTab={(key, ctx) => {
            if (key === 'partners' && ctx?.apiId != null) setPartnerId(Number(ctx.apiId))
            go(key)
          }}
        />
      )
    },
    {
      key: 'partners',
      label: 'Partners',
      render: () => <PartnersView openId={partnerId} onOpenChange={setPartnerId} />
    },
    ...extraTabs,
    {
      key: 'inbound',
      label: 'Inbound',
      render: () => <InboundView extra={inboundExtra} />
    },
    {
      key: 'alerts',
      label: 'Alerts',
      render: () => (
        <NextPhase what='Choose which problems to be told about — right away or in your daily summary — and tune when each one counts as a problem.' />
      )
    }
  ]
  const current = tabs.find((t) => t.key === active) ?? tabs[0]

  return (
    <div className={cn('flex flex-col gap-5', className)} data-ic-console>
      <TipLayer />
      <div role='tablist' aria-label='Integrations' className='flex gap-6 border-b border-border'>
        {tabs.map((t) => {
          const on = t.key === current.key
          return (
            <button
              key={t.key}
              type='button'
              role='tab'
              aria-selected={on}
              data-ic-tab={t.key}
              onClick={() => go(t.key)}
              className={cn(
                '-mb-px inline-flex items-center gap-2 border-b-2 pb-2.5 pt-1 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                on
                  ? 'border-nvr-cyan text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {t.label}
              {t.key === 'firefight' && openCount > 0 && (
                <span
                  className={cn(
                    'rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums',
                    critical
                      ? cn(TONE_SOFT.negative, TONE_TEXT.negative)
                      : cn(TONE_SOFT.warning, TONE_TEXT.warning)
                  )}
                >
                  {openCount}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div role='tabpanel' className='min-w-0'>
        {current.render()}
      </div>
    </div>
  )
}
