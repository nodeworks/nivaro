import { createNivaro } from '@nivaro/sdk'
import { AiAnalyticsView, NivaroProvider } from '@nivaro/shared'
import { Sparkles } from 'lucide-react'

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

/** AI Analytics — every model call with tokens, spend and latency, the /api-analytics twin. */
export function AiAnalyticsPage() {
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <header className='flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex h-9 w-9 items-center justify-center rounded-lg bg-nvr-cyan/15'>
          <Sparkles className='h-4.5 w-4.5 text-nvr-navy dark:text-nvr-cyan' />
        </div>
        <div>
          <h1 className='text-base font-semibold'>AI Analytics</h1>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Questions, model calls, tokens and spend across Ask AI, the chat bot and every one-shot
            AI feature.
          </p>
        </div>
      </header>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        <NivaroProvider client={sharedClient}>
          <AiAnalyticsView />
        </NivaroProvider>
      </div>
    </div>
  )
}
