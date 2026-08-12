import { AlertManagerView, NivaroProvider } from '@nivaro/shared'
import { createNivaro } from '@nivaro/sdk'
import { Siren } from 'lucide-react'
import { useNavigate } from 'react-router'

// Metric alert engine (EFP Alert Manager parity) — catalog, user rules,
// subscriptions, firing history, report-widget alerts, anomaly detection.
// Distinct from /alerts (per-record threshold engine on collection writes).
const client = createNivaro(window.location.origin)

export function AlertManager() {
  const navigate = useNavigate()
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3'>
          <div className='flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-nvr-navy dark:text-nvr-cyan'>
            <Siren className='h-[18px] w-[18px]' />
          </div>
          <div>
            <h1 className='text-[16px] font-semibold text-slate-800 dark:text-slate-100'>
              Alert Manager
            </h1>
            <p className='text-[12px] text-slate-500 dark:text-slate-400'>
              Monitor key metrics and get notified when thresholds are breached
            </p>
          </div>
        </div>
      </header>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        <NivaroProvider client={client}>
          <AlertManagerView onOpenReport={(id) => navigate(`/report-studio/${id}`)} />
        </NivaroProvider>
      </div>
    </div>
  )
}
