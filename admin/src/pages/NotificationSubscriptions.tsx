import { createNivaro } from '@nivaro/sdk'
import { NavigationContext, NivaroProvider, NotificationSubscriptionsView } from '@nivaro/shared'
import { useMemo } from 'react'
import { useNavigate } from 'react-router'

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

/** My Subscriptions — hosts the shared view (the same rows and editor the
 *  profile's Notifications & alerts card renders), so the two never drift. */
export function NotificationSubscriptionsPage() {
  const navigate = useNavigate()
  const nav = useMemo(() => ({ navigate: (path: string) => navigate(path) }), [navigate])
  return (
    <NivaroProvider client={sharedClient}>
      <NavigationContext.Provider value={nav}>
        <NotificationSubscriptionsView />
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}
