import { NivaroProvider, SlaRulesView } from '@nivaro/shared'
import { createNivaro } from '@nivaro/sdk'
import { Clock } from 'lucide-react'

// SLA rules — shared view (packages/shared SlaRulesView) hosted here; efp-new
// can mount the same component. Routes are requireAdmin.
const client = createNivaro(window.location.origin)

export function SlaRulesPage() {
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3'>
          <div className='flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-nvr-navy dark:text-nvr-cyan'>
            <Clock className='h-[18px] w-[18px]' />
          </div>
          <div>
            <h1 className='text-[16px] font-semibold text-slate-800 dark:text-slate-100'>
              SLA Rules
            </h1>
            <p className='text-[12px] text-slate-500 dark:text-slate-400'>
              Time limits per workflow state, with warnings before records go late
            </p>
          </div>
        </div>
      </header>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        <NivaroProvider client={client}>
          <SlaRulesView />
        </NivaroProvider>
      </div>
    </div>
  )
}
