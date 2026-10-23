import { createNivaro } from '@nivaro/sdk'
import { AlertManagerView, NivaroProvider } from '@nivaro/shared'
import { useNavigate } from 'react-router'
import { HubToolbar } from '@/components/hub-page'

// Metric alert engine — catalog, user rules,
// subscriptions, firing history, report-widget alerts, anomaly detection.
// Distinct from /alerts (per-record threshold engine on collection writes).
const client = createNivaro(window.location.origin, { timeoutMs: 90_000 })

export function AlertManager() {
  const navigate = useNavigate()
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar description='Watch key metrics and report widgets, and notify people when a threshold is crossed or a value looks unusual.' />
      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        <NivaroProvider client={client}>
          <AlertManagerView onOpenReport={(id) => navigate(`/report-studio/${id}`)} />
        </NivaroProvider>
      </div>
    </div>
  )
}
