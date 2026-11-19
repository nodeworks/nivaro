import { createNivaro } from '@nivaro/sdk'
import { AiAnalyticsView, NivaroProvider } from '@nivaro/shared'
import { useCallback } from 'react'
import { useSearchParams } from 'react-router'
import { HubToolbar } from '@/components/hub-page'

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '', {
  timeoutMs: 90_000
})

/**
 * AI Analytics — every model call with tokens, spend and latency, filterable
 * to the last leaf. The view's filters, sort, page, open call and open
 * conversation live in this tab's query string, so each is a link and Back
 * steps out of it.
 */
export function AiAnalyticsPage() {
  const [search, setSearch] = useSearchParams()
  const onSearchChange = useCallback(
    (next: URLSearchParams, opts: { replace?: boolean }) =>
      setSearch(next, { replace: !!opts.replace }),
    [setSearch]
  )
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <HubToolbar description='Questions, model calls, tokens and spend across Ask AI, the chat bot and every one-shot AI feature. Click any figure to filter, any call to read it.' />
      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        <NivaroProvider client={sharedClient}>
          <AiAnalyticsView search={search} onSearchChange={onSearchChange} />
        </NivaroProvider>
      </div>
    </div>
  )
}
