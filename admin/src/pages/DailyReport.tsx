import { createNivaro } from '@nivaro/sdk'
import {
  defaultItemUrl,
  ItemEditAuthContext,
  NavigationContext,
  NivaroProvider,
  OpsReportView,
  type OpsTab
} from '@nivaro/shared'
import { useNavigate, useSearchParams } from 'react-router'
import { useAuth } from '@/lib/auth'

// Daily report (Health hub tab): the night's operations report, trends and compare — the shared
// OpsReportView. Providers are what its drill-down record drawer needs; every drill stays in
// side drawers over this page.
const client = createNivaro(window.location.origin, { timeoutMs: 90_000 })

export function DailyReportPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: OpsTab = raw === 'trends' || raw === 'compare' ? raw : 'report'
  if (user && !user.is_admin) {
    return (
      <div className='p-8 text-center text-[13px] text-slate-500 dark:text-muted-foreground'>
        The daily report is for administrators.
      </div>
    )
  }
  return (
    <NivaroProvider client={client}>
      <NavigationContext.Provider
        value={{ navigate: (path) => navigate(path), itemUrl: defaultItemUrl }}
      >
        <ItemEditAuthContext.Provider
          value={{ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }}
        >
          <OpsReportView
            tab={tab}
            onTabChange={(t) => {
              const next = new URLSearchParams(params)
              if (t === 'report') next.delete('tab')
              else next.set('tab', t)
              setParams(next, { replace: true })
            }}
          />
        </ItemEditAuthContext.Provider>
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}
