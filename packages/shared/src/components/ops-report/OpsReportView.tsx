import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import type { OpsReportListRow } from '../../lib/ops-report-types'
import { cn } from '../../lib/utils'
import { QueryErrorState } from '../QueryErrorState'
import { Skeleton } from '../ui/skeleton'
import { CompareTab } from './CompareTab'
import { OPS_TABS, type OpsTab } from './format'
import { ReportTab } from './ReportTab'
import { OpsSettingsPopover } from './SettingsPanel'
import { TrendsTab } from './TrendsTab'

export interface OpsReportViewProps {
  /** Controlled tab; absent = the view keeps it. */
  tab?: OpsTab
  onTabChange?: (tab: OpsTab) => void
  /** Map an app path from a drill-down ("Open") onto the host's own routes; null = hide the action. */
  linkTo?: (path: string) => string | null
  className?: string
}

/**
 * Daily operations report (administrators): the night's report with every number drillable,
 * trends over 30/90 days, and a side-by-side compare. Needs the host's NivaroProvider; the
 * record drawer inside a drill-down also needs NavigationContext + ItemEditAuthContext.
 */
export function OpsReportView({
  tab: tabProp,
  onTabChange,
  linkTo,
  className
}: OpsReportViewProps) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [ownTab, setOwnTab] = useState<OpsTab>('report')
  const tab = tabProp ?? ownTab
  const setTab = (t: OpsTab) => {
    setOwnTab(t)
    onTabChange?.(t)
  }
  const [selected, setSelected] = useState<number | null>(null)

  const list = useQuery({
    queryKey: ['ops-reports'],
    queryFn: () =>
      client
        .request<{ data: OpsReportListRow[] }>(get('/ops-reports', { limit: 60 }))
        .then((r) => r.data),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 4000 : false)
  })
  const rows = list.data ?? []

  const run = useMutation({
    mutationFn: (day?: string) =>
      client
        .request<{ data: { id: number } }>(post('/ops-reports/run', day ? { day } : {}))
        .then((r) => r.data),
    onSuccess: (r) => {
      setSelected(r.id)
      setTab('report')
      void qc.invalidateQueries({ queryKey: ['ops-reports'] })
      void qc.invalidateQueries({ queryKey: ['ops-report', r.id] })
    },
    onError: (err) =>
      toastError(err, 'Could not start the report', { retry: () => run.mutate(undefined) })
  })

  return (
    <div className={cn('flex flex-1 min-h-0 flex-col', className)} data-ops-report-view=''>
      <header className='flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-2 dark:border-border dark:bg-card'>
        <div role='tablist' aria-label='Daily report' className='flex items-center gap-1'>
          {OPS_TABS.map((t) => (
            <button
              key={t.key}
              type='button'
              role='tab'
              aria-selected={tab === t.key}
              data-ops-tab={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                tab === t.key
                  ? 'bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
                  : 'text-slate-600 hover:bg-muted dark:text-muted-foreground'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className='ml-auto'>
          <OpsSettingsPopover />
        </div>
      </header>

      {list.isLoading ? (
        <div className='space-y-3 p-4' aria-busy='true'>
          <Skeleton className='h-16 w-full' />
          <Skeleton className='h-64 w-full' />
        </div>
      ) : list.error ? (
        <div className='p-4'>
          <QueryErrorState
            error={list.error}
            what='the daily reports'
            onRetry={() => void list.refetch()}
          />
        </div>
      ) : tab === 'report' ? (
        <ReportTab
          rows={rows}
          selected={selected}
          onSelect={setSelected}
          onRunDay={(day) => run.mutate(day)}
          linkTo={linkTo}
        />
      ) : tab === 'trends' ? (
        <TrendsTab
          onOpenDay={(id) => {
            setSelected(id)
            setTab('report')
          }}
        />
      ) : (
        <CompareTab rows={rows} />
      )}
    </div>
  )
}
