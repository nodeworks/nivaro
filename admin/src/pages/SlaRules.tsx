import { createNivaro } from '@nivaro/sdk'
import { NivaroProvider, SlaRulesView } from '@nivaro/shared'
import { HubToolbar } from '@/components/hub-page'

// SLA rules — shared view (packages/shared SlaRulesView) hosted here; a headless
// frontend can mount the same component. Routes are requireAdmin.
const client = createNivaro(window.location.origin, { timeoutMs: 90_000 })

export function SlaRulesPage() {
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar description='Time limits per workflow state, with warnings before records go late.' />
      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        <NivaroProvider client={client}>
          <SlaRulesView />
        </NivaroProvider>
      </div>
    </div>
  )
}
