import { createNivaro } from '@nivaro/sdk'
import {
  CollectionBrowserView,
  defaultItemUrl,
  ItemEditAuthContext,
  NavigationContext,
  NivaroProvider
} from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { CalendarDays, GanttChart, Grid3x3 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { CollectionCalendar } from '@/components/collection-calendar'
import { CollectionGantt } from '@/components/collection-gantt'
import { SpreadsheetView } from '@/components/spreadsheet-view'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'

// Admin /collections/:collection runs on the SAME shared browser that powers
// headless frontends (CollectionBrowserView) — quick filters, column filters,
// saved views, drill sheets, row actions, tree view, hierarchy scope, Ask the
// table. The admin-only spreadsheet / calendar / Gantt views ride in as host
// views (#743 retired the classic browser).
const client = createNivaro(window.location.origin)

export function CollectionBrowserV2Page() {
  const { collection = '' } = useParams<{ collection: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  // Command palette hand-off: `?ai=<question>` asks once, then leaves the URL.
  // Kept per collection so moving to another collection never re-asks.
  const [ai, setAi] = useState<{ collection: string; prompt: string } | null>(() => {
    const q = searchParams.get('ai')
    return q ? { collection, prompt: q } : null
  })
  useEffect(() => {
    const q = searchParams.get('ai')
    if (!q) return
    setAi({ collection, prompt: q })
    const next = new URLSearchParams(searchParams)
    next.delete('ai')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams, collection])
  const aiPrompt = ai?.collection === collection ? ai.prompt : undefined
  const { data: meta } = useQuery({
    queryKey: ['admin-cbv-host-meta', collection],
    queryFn: () =>
      api
        .get<{
          data: {
            display_template?: string | null
            fields?: Array<{ field: string; label?: string | null; type?: string | null }>
          }
        }>(`/collections/${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 60_000
  })
  const extraViews = useMemo(() => {
    const dateFields = (meta?.fields ?? [])
      .filter((f) => ['date', 'datetime', 'timestamp'].includes(String(f.type)))
      .map((f) => ({ field: f.field, label: f.label || f.field }))
    const template = meta?.display_template ?? null
    const views = [
      {
        key: 'grid',
        label: 'Grid',
        icon: <Grid3x3 className='h-3.5 w-3.5' />,
        render: () => <SpreadsheetView collection={collection} />
      }
    ]
    if (dateFields.length > 0)
      views.push({
        key: 'calendar',
        label: 'Calendar',
        icon: <CalendarDays className='h-3.5 w-3.5' />,
        render: () => (
          <CollectionCalendar
            collection={collection}
            dateFields={dateFields}
            displayTemplate={template}
          />
        )
      })
    if (dateFields.length >= 2)
      views.push({
        key: 'gantt',
        label: 'Gantt',
        icon: <GanttChart className='h-3.5 w-3.5' />,
        render: () => (
          <CollectionGantt
            collection={collection}
            dateFields={dateFields}
            displayTemplate={template}
          />
        )
      })
    return views
  }, [meta, collection])

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <NivaroProvider client={client}>
        <NavigationContext.Provider
          value={{
            navigate: (path) => navigate(path),
            itemUrl: defaultItemUrl
          }}
        >
          <ItemEditAuthContext.Provider
            value={{ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }}
          >
            <CollectionBrowserView
              key={collection}
              collection={collection}
              initialSearch={searchParams.get('search') ?? ''}
              initialFilters={
                // Import batch view (#128): ?ids=1,2,3 opens the browser
                // filtered to exactly those records.
                searchParams.get('ids')
                  ? [
                      {
                        id: 'batch-ids',
                        path: ['id'],
                        pathLabels: ['ID'],
                        fieldType: 'integer',
                        op: '_in',
                        value: (searchParams.get('ids') ?? '')
                          .split(',')
                          .filter(Boolean)
                          .slice(0, 500)
                      }
                    ]
                  : undefined
              }
              initialAiPrompt={aiPrompt}
              extraViews={extraViews}
              onOpenItem={(id) => navigate(`/collections/${collection}/${id}`)}
            />
          </ItemEditAuthContext.Provider>
        </NavigationContext.Provider>
      </NivaroProvider>
    </div>
  )
}
