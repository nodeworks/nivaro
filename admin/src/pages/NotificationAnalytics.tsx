import { createNivaro } from '@nivaro/sdk'
import { NivaroProvider, NotificationAnalyticsView } from '@nivaro/shared'

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

/** Notification analytics (admin) — hosts the shared sender-analytics view. */
export default function NotificationAnalytics() {
  return (
    <NivaroProvider client={sharedClient}>
      <NotificationAnalyticsView />
    </NivaroProvider>
  )
}
