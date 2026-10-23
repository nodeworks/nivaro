import { createNivaro } from '@nivaro/sdk'
import { ChatAnalyticsView, NivaroProvider } from '@nivaro/shared'
import { HubToolbar } from '@/components/hub-page'

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '', {
  timeoutMs: 90_000
})

/** Chat Analytics — usage and reply times, plus the admin message log (#955). */
export function ChatAnalyticsPage() {
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <HubToolbar description='How much chat is used, how quickly people answer each other, and every message for review.' />
      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        <NivaroProvider client={sharedClient}>
          <ChatAnalyticsView />
        </NivaroProvider>
      </div>
    </div>
  )
}
