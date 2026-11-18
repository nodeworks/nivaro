import { createNivaro } from '@nivaro/sdk'
import { DeliveryAnalyticsView, NivaroProvider } from '@nivaro/shared'
import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '', {
  timeoutMs: 90_000
})

/**
 * Delivery → Analytics (admin): hosts the shared delivery-analytics view. The
 * view's window, filters, drill and leaf live in this tab's query string, so a
 * drilled view is a link and Back steps out of it.
 */
export default function NotificationAnalytics() {
  const [search, setSearch] = useSearchParams()
  const onSearchChange = useCallback(
    (next: URLSearchParams, opts: { replace?: boolean }) =>
      setSearch(next, { replace: !!opts.replace }),
    [setSearch]
  )
  return (
    <NivaroProvider client={sharedClient}>
      <DeliveryAnalyticsView compactHeader search={search} onSearchChange={onSearchChange} />
    </NivaroProvider>
  )
}
