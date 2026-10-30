import { useQuery } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { useNavigate } from 'react-router'
import type { DashboardWidget } from '@/lib/api'
import { api } from '@/lib/api'
import { overviewKeys, usePinToOverview } from './api'
import { Bone, EmptyNote, Section, SectionLink } from './parts'

/**
 * Pinned widgets — dashboard widgets this person pinned to their Overview (the pin on any
 * widget of a dashboard). Drawn by the dashboard's own widget card, so each figure is computed
 * AS THE VIEWER by the same route; a widget whose dashboard they can no longer see drops out.
 */

const WidgetCard = lazy(() =>
  import('@/pages/DashboardEdit').then((m) => ({ default: m.WidgetCard }))
)

type PinnedWidget = DashboardWidget & { dashboard: string; dashboard_name?: string }

function CardBone() {
  return (
    <div
      className='h-[200px] rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
      aria-hidden
    >
      <Bone className='h-3.5 w-32' />
      <Bone className='mt-1.5 h-2.5 w-20' />
      <Bone className='mx-auto mt-10 h-9 w-20' />
    </div>
  )
}

export function PinnedWidgetsSection() {
  const navigate = useNavigate()
  const pin = usePinToOverview()
  const { data, isLoading } = useQuery({
    queryKey: overviewKeys.pinnedWidgets,
    queryFn: () =>
      api.get<{ data: PinnedWidget[] }>('/overview/pinned-widgets').then((r) => r.data.data),
    staleTime: 60_000
  })
  const widgets = data ?? []
  return (
    <Section
      id='pinned-widgets'
      title='Pinned widgets'
      plain
      action={<SectionLink to='/dashboards'>Dashboards</SectionLink>}
    >
      {isLoading ? (
        <div className='grid gap-3 sm:grid-cols-2'>
          <CardBone />
          <CardBone />
        </div>
      ) : widgets.length === 0 ? (
        <div className='rounded-lg border border-dashed border-slate-300 dark:border-border'>
          <EmptyNote action={{ label: 'Open your dashboards', to: '/dashboards' }}>
            Keep a dashboard figure here: open a dashboard and use the pin on any widget.
          </EmptyNote>
        </div>
      ) : (
        <div className='grid gap-3 sm:grid-cols-2'>
          <Suspense fallback={widgets.map((w) => <CardBone key={w.id} />)}>
            {widgets.map((w) => (
              <WidgetCard
                key={w.id}
                widget={w}
                globalFilters={[]}
                fill
                pin={{ pinned: true, onToggle: () => pin.toggle(w.id) }}
                onDrill={() => navigate(`/dashboards/${w.dashboard}`)}
              />
            ))}
          </Suspense>
        </div>
      )}
    </Section>
  )
}
