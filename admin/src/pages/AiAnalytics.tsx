import { createNivaro } from '@nivaro/sdk'
import { AiAnalyticsView, NivaroProvider } from '@nivaro/shared'
import { HubToolbar } from '@/components/hub-page'

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '', {
  timeoutMs: 90_000
})

/** AI Analytics — every model call with tokens, spend and latency, the /api-analytics twin. */
export function AiAnalyticsPage() {
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <HubToolbar description='Questions, model calls, tokens and spend across Ask AI, the chat bot and every one-shot AI feature.' />
      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        <NivaroProvider client={sharedClient}>
          <AiAnalyticsView />
        </NivaroProvider>
      </div>
    </div>
  )
}
